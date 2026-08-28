// Trusted ZERO-EXPORT backfill runner: publish sku-movement/v1 (All Brands) for all 30 primary accounts from durable
// evidence only. DRY-RUN by default (derives + validates + reports, writes NOTHING). Set BACKFILL_APPLY=1 to persist.
// There is NO DataDoe adapter anywhere in this path, so a create-export is structurally impossible; it never touches
// sync_cycles, source controls, Daily Reporting, Brand Sales, or Brand Inventory.
//
//   node scripts/release/backfill-sku-movement.mjs                  # dry-run (no writes)
//   BACKFILL_APPLY=1 node scripts/release/backfill-sku-movement.mjs # apply
//
// Each account is published AS OF its OWN latest proven OLI date, capped at the ceiling (default: today UTC, matching
// the serve). Override --asOfCeiling only for explicit re-review. Named-brand snapshots self-heal on first read.
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
const ASOF_CEILING = argOf("asOfCeiling", new Date().toISOString().slice(0, 10));
const BRAND = argOf("brand", "ALL");

const sb = await import("../../lib/server/supabase.js");
const { backfillSkuMovement, makeSkuMovementProvenanceGuardedSave, SKU_MOVEMENT_VERSION } = await import("../../lib/server/reports/sku-movement-backfill.js");
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
  .map((a) => ({ accountId: String(a.id), country: a.country }));
console.log(`accounts: ${accounts.length} | asOfCeiling=${ASOF_CEILING} brand=${BRAND} | mode=${APPLY ? "APPLY (writes)" : "DRY-RUN (no writes)"}`);
if (accounts.length !== 30) console.warn(`WARNING: expected 30 primary accounts, found ${accounts.length}`);

const readers = {
  readOliHistory: sb.getSourceOliHistoryRows,
  readOliCoverage: sb.getSourceCoverageWindows,
  readCatalogSnapshot: sb.getSourceSnapshot,
  loadCatalogPayload: sb.getSourceSnapshotPayload,
};

const guardedSave = makeSkuMovementProvenanceGuardedSave({
  paramsHashFor,
  saveSnapshot: async ({ reportKey, accountId, paramsHash, params, payload, sourceRefreshedAt }) => {
    const payloadBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
    if (!APPLY) return { id: null, dryRun: true, payload_bytes: payloadBytes }; // DRY: validated + provenance-checked, NOT persisted
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
  validatePayload: (p) => REPORT_DERIVATIONS["sku-movement"].validatePayload(p),
};

const { results, summary } = await backfillSkuMovement({
  accounts, asOfCeiling: ASOF_CEILING, organizationFingerprint: orgFp, brand: BRAND, readers, store,
  onAccount: (r) => {
    const tag = r.status === "published" ? `${APPLY ? "PUBLISHED" : "would-publish"} asOf=${r.asOf} rows=${r.rows}`
      : r.status === "republished" ? `${APPLY ? "REPUBLISHED(units-changed)" : "would-republish(units-changed)"} asOf=${r.asOf} rows=${r.rows}`
      : r.status === "existing" ? `existing asOf=${r.asOf} rows=${r.rows}`
      : r.status === "newer-live" ? `newer-live (kept; not overwritten) asOf=${r.asOf}`
      : r.status === "failed" ? `FAILED ${r.reason}`
      : r.status;
    console.log(`  ${r.accountId.slice(0, 8)}  ${tag}`);
  },
});

console.log("\nSUMMARY " + JSON.stringify(summary));
console.log(`creates=${summary.creates} tokens=${summary.tokens} (structurally zero: no DataDoe adapter present)`);
if (summary.failed) console.log("FAILURES:\n" + JSON.stringify(results.filter((r) => r.status === "failed"), null, 0));
process.exit(summary.failed ? 2 : 0);
