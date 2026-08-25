// Trusted ZERO-EXPORT backfill runner: publish daily-reporting-shared-v2 for all 30 primary accounts from durable
// evidence only. DRY-RUN by default (derives + validates + reports, writes NOTHING). Set BACKFILL_APPLY=1 to
// actually persist the snapshots. There is NO DataDoe adapter anywhere in this path, so a create-export is
// structurally impossible; it never touches sync_cycles, source controls, Brand Sales, or Brand Inventory.
//
//   node scripts/release/backfill-daily-v2.mjs                 # dry-run (no writes)
//   BACKFILL_APPLY=1 node scripts/release/backfill-daily-v2.mjs # apply
//
// Frozen window: from=2026-03-01 (monthBack(asOf,5)); each account is published ENDING at its OWN latest proven
// OLI date, capped at the reviewed ceiling asOfCeiling=2026-08-24. Override via argv only for explicit re-review.
import { readFileSync } from "node:fs";

const ENV_PATH = "C:/Users/laxmi/Documents/Codex/2026-07-01/can/Upriver-Dashboard/.env.local";
const txt = readFileSync(ENV_PATH, "utf8");
for (const l of txt.split(/\r?\n/)) {
  const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(l);
  if (m) { let v = m[2].trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); if (!process.env[m[1]]) process.env[m[1]] = v; }
}
if (!process.env.SUPABASE_URL && process.env.VITE_SUPABASE_URL) process.env.SUPABASE_URL = process.env.VITE_SUPABASE_URL;
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const APPLY = process.env.BACKFILL_APPLY === "1";
const argOf = (name, def) => { const hit = process.argv.find((a) => a.startsWith(`--${name}=`)); return hit ? hit.split("=")[1] : def; };
const FROM = argOf("from", "2026-03-01");
const ASOF_CEILING = argOf("asOfCeiling", "2026-08-24");

const sb = await import("../../lib/server/supabase.js");
const { backfillDailyV2, makeProvenanceGuardedSave } = await import("../../lib/server/reports/daily-v2-backfill.js");
const { paramsHashFor } = await import("../../lib/server/report-store.js");
const { REPORT_DERIVATIONS } = await import("../../lib/server/sync/report-derivation.js");
const { getDataDoeConnections } = await import("../../lib/server/datadoe-connections.js");
const { organizationFingerprint } = await import("../../lib/server/source-identity.js");

if (!sb.isSupabaseConfigured()) { console.error("Supabase is not configured (env)."); process.exit(1); }

const primary = getDataDoeConnections().find((c) => c && c.id === "primary" && String(c.apiKey || "").trim());
if (!primary) { console.error("No primary DataDoe connection with an API key."); process.exit(1); }
const orgFp = primary.organizationFingerprint || organizationFingerprint(primary.apiKey);

const dir = await sb.getLatestReportSnapshot({ reportKey: "account-directory", accountId: "__account-directory__" });
const accounts = (dir?.payload?.accounts || [])
  .filter((a) => a && String(a.id) && !String(a.id).includes(":") && a.active !== false)
  .map((a) => ({ accountId: String(a.id), rawSellerId: String(a.id), currency: a.currency ?? null, country: a.country }));
console.log(`accounts: ${accounts.length} | window from=${FROM} asOfCeiling=${ASOF_CEILING} | mode=${APPLY ? "APPLY (writes)" : "DRY-RUN (no writes)"}`);
if (accounts.length !== 30) console.warn(`WARNING: expected 30 primary accounts, found ${accounts.length}`);

const readers = {
  readOliHistory: sb.getSourceOliHistoryRows,
  readOliCoverage: sb.getSourceCoverageWindows,
  readAsinAds: sb.getAsinAdsDailyRows,
  readAdsCoverage: sb.getDailyAdsCoverage,
  readCatalogSnapshot: sb.getSourceSnapshot,
  loadCatalogPayload: sb.getSourceSnapshotPayload,
};

const guardedSave = makeProvenanceGuardedSave({
  paramsHashFor,
  saveSnapshot: async ({ reportKey, accountId, paramsHash, params, payload, sourceRefreshedAt }) => {
    const payloadBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
    if (!APPLY) return { id: null, dryRun: true, payload_bytes: payloadBytes }; // DRY: validated + provenance-checked, but NOT persisted
    const saved = await sb.saveReportSnapshot({ reportKey, accountId, paramsHash, params, payload, payloadBytes, sourceRefreshedAt: sourceRefreshedAt || new Date().toISOString() });
    if (saved?.id) await sb.publishSnapshotUpdate({ reportKey, accountId, paramsHash, snapshotId: saved.id }).catch(() => {});
    return { id: saved?.id || null, payload_bytes: payloadBytes };
  },
});

const store = {
  paramsHashFor,
  claimLock: sb.claimRefreshLock,
  releaseLock: sb.releaseRefreshLock,
  getExisting: sb.getReportSnapshot,
  save: guardedSave,
  validatePayload: (p) => REPORT_DERIVATIONS["daily-reporting"].validatePayload(p),
};

const { results, summary } = await backfillDailyV2({
  accounts, from: FROM, asOfCeiling: ASOF_CEILING, organizationFingerprint: orgFp, readers, store,
  onAccount: (r) => {
    const tag = r.status === "published" ? `${APPLY ? "PUBLISHED" : "would-publish"} to=${r.to} ads=${r.adsAvailability || "-"}`
      : r.status === "republished" ? `${APPLY ? "REPUBLISHED(ads-changed)" : "would-republish(ads-changed)"} to=${r.to} ads=${r.adsAvailability || "-"}`
      : r.status === "existing" ? `existing to=${r.to} ads=${r.adsAvailability || "-"}`
      : r.status === "newer-live" ? `newer-live (kept; not overwritten) to=${r.to}`
      : r.status === "failed" ? `FAILED ${r.reason}`
      : r.status;
    console.log(`  ${r.accountId.slice(0, 8)}  ${tag}`);
  },
});

console.log("\nSUMMARY " + JSON.stringify(summary));
console.log(`creates=${summary.creates} tokens=${summary.tokens} (structurally zero: no DataDoe adapter present)`);
if (summary.failed) console.log("FAILURES:\n" + JSON.stringify(results.filter((r) => r.status === "failed"), null, 0));
process.exit(summary.failed ? 2 : 0);
