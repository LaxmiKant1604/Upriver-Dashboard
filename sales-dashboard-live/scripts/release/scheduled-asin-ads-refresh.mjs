// TRUSTED, DEFERRED scheduled ASIN Ads (ads-asin-date) refresh operator for ONE bucket.
// Usage (run from sales-dashboard-live/, in the reviewed GitHub Actions scheduler):
//   node scripts/release/scheduled-asin-ads-refresh.mjs --bucket=us|non-us [--as-of=YYYY-MM-DD]
//
// It refreshes ONLY the ASIN grain ("asin-performance-v1") for one bucket, via the durable Ads architecture
// (runAdsSync in COVERAGE mode), and NOTHING else -- never Campaign Ads, FBA, OLI, Catalog, or any other family:
//   - discovers the bucket's PRIMARY accounts (US vs Non-US never mix), batches them into <=5-seller exports;
//   - for each batch runs an EXACT 21-day rolling window in coverage mode: already-proven coverage is skipped
//     (no refetch of historical Ads), only missing dates are exported, one create per batch (recursion split
//     budget <=3), and a per-BUCKET create ceiling (US 2 / Non-US 5 exports = 4 / 10 tokens) is enforced by a
//     guarded createExport that ABORTS before any create that would exceed it;
//   - re-invokes a work-budget-deferred batch (idempotent; the 600s lock prevents overlap), NEVER retries a
//     failed/ambiguous batch (LKG is already preserved by the durable worker);
//   - then PROVES (assessScheduledAsinAdsCycle) every batch completed with full coverage, only the ASIN source,
//     zero failed/coverage-failed accounts, the covered union == the discovered accounts, and creates/tokens
//     within the ceiling; exits NONZERO otherwise.
// Never prints a seller/account/export id (only counts + country codes).

import { loadReleaseEnv } from "./env-bootstrap.mjs";

loadReleaseEnv(); // portable: loads <repoRoot>/.env.local when present, maps SUPABASE_URL, never overrides CI env

const argOf = (name) => { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.split("=").slice(1).join("=") : null; };
const bucket = argOf("bucket");
const asOf = argOf("as-of");
if (bucket !== "us" && bucket !== "non-us") { console.error("STOP --bucket must be us|non-us (got: " + bucket + ")"); process.exit(2); }
if (asOf != null && !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) { console.error("STOP --as-of must be YYYY-MM-DD (got: " + asOf + ")"); process.exit(2); }

const { runAdsSyncWithDeps, PRODUCTION_ADS_SYNC_DEPS } = await import("../../lib/server/ads-sync.js");
const { bucketForCountry } = await import("../../lib/server/sync/registry.js");
const { assignAccountBatches, MAX_ACCOUNTS_PER_BATCH } = await import("../../lib/server/sync/source-batching.js");
const { asinAdsBucketPlan, asinAdsRefreshWindow, assessScheduledAsinAdsCycle, ASIN_ADS_GRAIN } = await import("../../lib/server/sync/source-scheduled-asin-ads.js");
const { getDataDoeConnections, classifyDirectoryAccounts } = await import("../../lib/server/datadoe-connections.js");
const { fetchAccounts } = await import("../../lib/server/datadoe.js");

const MAX_ITERS = Number(process.env.SCHEDULED_ASIN_ADS_MAX_ITERS || 40);
const asOfStr = asOf || (() => { const d = new Date(); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); })();
const log = (m) => console.log("scheduled-asin-ads[" + bucket + "@" + asOfStr + "]: " + m);

// (1) Discover the bucket's PRIMARY accounts + their marketplace country (US vs Non-US never mix).
const connections = getDataDoeConnections();
const primaryConn = connections.find((c) => c.id === "primary");
const rows = (await fetchAccounts(primaryConn.apiKey)) || [];
const { active } = classifyDirectoryAccounts(rows, connections);
const seen = new Set();
const bucketAccounts = [];
for (const a of active) {
  const accountId = String((a && (a.accountId ?? a.id)) || "").trim();
  const country = String((a && a.country) || "").toUpperCase();
  if (!accountId || accountId.includes(":") || seen.has(accountId)) continue;
  if (bucketForCountry(country) !== bucket) continue;
  seen.add(accountId);
  bucketAccounts.push({ accountId, country });
}
if (!bucketAccounts.length) { console.error("STOP no discovered primary accounts for bucket " + bucket); process.exit(1); }

const plan = asinAdsBucketPlan(bucketAccounts);
const { batches } = assignAccountBatches(bucketAccounts, new Map(), MAX_ACCOUNTS_PER_BATCH);
const win = asinAdsRefreshWindow(asOfStr);
log(bucketAccounts.length + " primary accounts -> " + batches.length + " batches; window [" + win.from + ".." + win.to + "] (21d); create ceiling " + plan.maxCreates + " / " + plan.maxTokens + " tokens");

// (2) A guarded, counting createExport: enforce the per-BUCKET create ceiling BEFORE any create; count real POSTs.
let creates = 0;
const guardedCreate = async (...args) => {
  if (creates >= plan.maxCreates) { const e = new Error("ASIN_ADS_CREATE_CEILING_EXCEEDED: refusing create " + (creates + 1) + " > ceiling " + plan.maxCreates); e.code = "ASIN_ADS_CEILING"; throw e; }
  creates += 1;
  return PRODUCTION_ADS_SYNC_DEPS.createExport(...args);
};
const deps = { ...PRODUCTION_ADS_SYNC_DEPS, createExport: guardedCreate };

// (3) Run each <=5-account batch in coverage mode; re-invoke a work-budget-deferred batch; never retry a failure.
const batchResults = [];
for (const batch of batches) {
  const batchIds = batch.accounts.map((a) => a.accountId);
  const batchCountries = [...new Set(batch.accounts.map((a) => a.country))].filter(Boolean);
  let summary = null;
  for (let iter = 0; iter < MAX_ITERS; iter += 1) {
    try {
      summary = await runAdsSyncWithDeps(deps, batchCountries, [ASIN_ADS_GRAIN], { accountIds: batchIds, requiredCoverage: { from: win.from, to: win.to } });
    } catch (e) {
      if (e && e.code === "ASIN_ADS_CEILING") { console.error("STOP " + e.message); process.exit(1); }
      console.error("STOP ASIN Ads batch failed: " + (e && e.message ? e.message : e)); process.exit(1);
    }
    if (summary.status === "skipped") { if (iter < 3) continue; console.error("STOP ASIN Ads lock persistently held (concurrent run?)"); process.exit(1); }
    if (summary.deferred === true) continue; // work-budget partial -> resume the SAME batch (idempotent)
    break; // completed / partial-terminal / failed
  }
  batchResults.push({ accountIds: batchIds, summary });
  log("batch [" + batchCountries.join(",") + "] " + batchIds.length + " accts: status=" + (summary && summary.status) + " coverageComplete=" + (summary && summary.coverageComplete) + " pairs=" + (summary && summary.successfulCoveragePairs) + "/" + (summary && summary.expectedCoveragePairs));
}

// (4) Prove the whole bucket refresh stayed in scope + inside the ceiling.
const a = assessScheduledAsinAdsCycle({ bucket, discoveredAccounts: bucketAccounts, batchResults, creates });
log("assessment: batches=" + a.batches + " creates=" + a.creates + "/" + a.ceilingCreates + " tokens=" + a.tokens + "/" + a.ceilingTokens + " ok=" + a.ok);
if (!a.ok) { console.error("STOP scheduled ASIN Ads assessment FAILED: " + a.problems.join(", ")); process.exit(1); }
log("PROVEN: " + bucketAccounts.length + " accounts across " + a.batches + " ASIN-Ads batches; " + a.creates + " creates / " + a.tokens + " tokens (ceiling " + a.ceilingCreates + "/" + a.ceilingTokens + "); already-covered dates were skipped.");
process.exit(0);
