// Trusted ZERO-EXPORT bounded backfill: re-derive every EXISTING named-brand Daily Reporting snapshot
// (report_key=daily-reporting, params.brand != 'ALL') to the account's CURRENT latest proven date, so a stale
// named-brand snapshot (frozen at an earlier as-of because the read self-heal only fired on a total miss) is
// corrected IMMEDIATELY after deploy -- not only after a future page visit. There is NO DataDoe adapter in this
// path, so a create-export is structurally impossible: creates=0, tokens=0. It NEVER touches ALL-brand snapshots,
// sync_cycles, source controls, or any other report.
//
//   node scripts/release/backfill-daily-named-brands.mjs                 # dry-run (no writes)
//   BACKFILL_APPLY=1 node scripts/release/backfill-daily-named-brands.mjs # apply
//
// Each (account, brand) is re-derived through the SAME rederiveDailyV2 the serve self-heal uses (clampToProven ->
// the account's latest proven OLI date), and SAVED under the honest clamped identity. A stale snapshot NEVER
// overwrites a newer one (a CAS guard skips when an equal-or-newer snapshot already exists at the effective
// identity). Idempotent: a re-run writes nothing.
import { readFileSync } from "node:fs";

const ENV_PATH = "C:/Users/laxmi/Documents/Codex/2026-07-01/can/Upriver-Dashboard/.env.local";
function loadEnvFile(path) {
  try { for (const l of readFileSync(path, "utf8").split(/\r?\n/)) { const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(l); if (m) { let v = m[2].trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); if (!process.env[m[1]]) process.env[m[1]] = v; } } } catch { /* rely on process.env */ }
}
if (!process.env.POSTGRES_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  loadEnvFile("sales-dashboard-live/.vercel/.env.production.local");
  loadEnvFile(".vercel/.env.production.local");
  loadEnvFile(ENV_PATH);
}
if (!process.env.SUPABASE_URL && process.env.VITE_SUPABASE_URL) process.env.SUPABASE_URL = process.env.VITE_SUPABASE_URL;
process.env.PGSSLMODE = process.env.PGSSLMODE || "no-verify";
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const APPLY = process.env.BACKFILL_APPLY === "1";
const FROM = process.argv.find((a) => a.startsWith("--from="))?.split("=")[1] || "2026-03-01";
const CEILING = process.argv.find((a) => a.startsWith("--to="))?.split("=")[1] || new Date().toISOString().slice(0, 10);

const sb = await import("../../lib/server/supabase.js");
const { rederiveAndSaveDailyV2 } = await import("../../lib/server/reports/daily-durable-rederive.js");
const { getEnrichedOliHistoryRows } = await import("../../lib/server/sync/oli-enriched-history.js");
const { paramsHashFor } = await import("../../lib/server/report-store.js");
const { getDataDoeConnections } = await import("../../lib/server/datadoe-connections.js");
const { organizationFingerprint } = await import("../../lib/server/source-identity.js");
const pg = (await import("pg")).default;

if (!process.env.POSTGRES_URL) { console.error("POSTGRES_URL is required."); process.exit(1); }
const primary = getDataDoeConnections().find((c) => c && c.id === "primary" && String(c.apiKey || "").trim());
if (!primary) { console.error("No primary DataDoe connection with an API key."); process.exit(1); }
const orgFp = primary.organizationFingerprint || organizationFingerprint(primary.apiKey);

const REPORT_KEY = "daily-reporting";
const REPORT_VERSION = "daily-reporting-shared-v2";

// The complete account directory (rawSellerId + currency), from the authoritative snapshot.
const dirAccounts = await sb.getAccountDirectorySnapshotAccounts();
const metaByAccount = new Map(dirAccounts.map((a) => [String(a.accountId), a]));

// The EXISTING named-brand daily snapshots (latest per account+brand) -- the bounded set to correct.
async function loadNamedBrandPairs() {
  const u = new URL(process.env.POSTGRES_URL); u.searchParams.set("sslmode", "no-verify");
  const c = new pg.Client({ connectionString: u.toString() }); await c.connect();
  try {
    const rows = (await c.query(
      "select account_id, params->>'brand' brand, params->>'from' pfrom, max(updated_at) upd " +
      "from public.report_snapshots where report_key='daily-reporting' and coalesce(params->>'brand','ALL') <> 'ALL' " +
      "group by account_id, params->>'brand', params->>'from' order by account_id, brand"
    )).rows;
    // dedupe latest per (account, brand)
    const seen = new Set(); const out = [];
    for (const r of rows) { const k = r.account_id + "|" + r.brand; if (seen.has(k)) continue; seen.add(k); out.push({ accountId: r.account_id, brand: r.brand, from: r.pfrom || FROM }); }
    return out;
  } finally { await c.end(); }
}

const readers = {
  readOliHistory: getEnrichedOliHistoryRows, // ordered units + actual-plus-estimated sales (the canonical seam)
  readOliCoverage: sb.getSourceCoverageWindows,
  readAsinAds: sb.getAsinAdsDailyRows,
  readAdsCoverage: sb.getDailyAdsCoverage,
  readCatalogSnapshot: sb.getSourceSnapshot,
  loadCatalogPayload: sb.getSourceSnapshotPayload,
};

const pairs = await loadNamedBrandPairs();
console.log(`named-brand daily snapshots to correct: ${pairs.length} | from=${FROM} ceiling=${CEILING} | mode=${APPLY ? "APPLY (writes)" : "DRY-RUN (no writes)"}`);

let rederived = 0, existing = 0, newerLive = 0, notReady = 0, failed = 0;
for (const { accountId, brand, from } of pairs) {
  const meta = metaByAccount.get(String(accountId)) || {};
  let statusTag = "";
  const save = async ({ payload, sourceRefreshedAt, effectiveParams }) => {
    const effHash = paramsHashFor(REPORT_VERSION, effectiveParams);
    const existingSnap = await sb.getReportSnapshot({ reportKey: REPORT_KEY, accountId, paramsHash: effHash });
    // CAS: never overwrite an equal-or-newer snapshot at the SAME effective identity (idempotent + safe).
    if (existingSnap && existingSnap.source_refreshed_at && sourceRefreshedAt && String(existingSnap.source_refreshed_at) >= String(sourceRefreshedAt)) {
      statusTag = `existing/newer-live to=${effectiveParams.to}`; newerLive += 1; return { skipped: true };
    }
    if (!APPLY) { statusTag = `would-rederive to=${effectiveParams.to}`; rederived += 1; return { dryRun: true }; }
    const payloadBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
    const saved = await sb.saveReportSnapshot({ reportKey: REPORT_KEY, accountId, paramsHash: effHash, params: { reportVersion: REPORT_VERSION, ...effectiveParams }, payload, payloadBytes, sourceRefreshedAt: sourceRefreshedAt || new Date().toISOString() });
    if (saved?.id) await sb.publishSnapshotUpdate({ reportKey: REPORT_KEY, accountId, paramsHash: effHash, snapshotId: saved.id }).catch(() => {});
    statusTag = `REDERIVED to=${effectiveParams.to}`; rederived += 1; return { id: saved?.id || null };
  };
  try {
    const r = await rederiveAndSaveDailyV2({
      accountId, rawSellerId: String(accountId), currency: meta.currency ?? null,
      from, to: CEILING, brand, organizationFingerprint: orgFp, connectionId: "primary", clampToProven: true,
    }, { readers, save });
    if (!r.published) { statusTag = `not-ready (${(r.blockedBy || []).map((b) => b.sourceKey).join(",") || r.notReady})`; notReady += 1; }
  } catch (e) { statusTag = `FAILED ${e && e.message ? e.message : e}`; failed += 1; }
  console.log(`  ${String(accountId).slice(0, 8)} ${JSON.stringify(brand).padEnd(18)} ${statusTag}`);
}

console.log(`\nSUMMARY ${JSON.stringify({ pairs: pairs.length, rederived, existing, newerLive, notReady, failed, creates: 0, tokens: 0 })}`);
console.log("creates=0 tokens=0 (structurally zero: no DataDoe adapter present)");
process.exit(failed ? 2 : 0);
