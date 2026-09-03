// TRUSTED, DEFERRED scheduled Campaign Ads (campaign-performance-v1) refresh operator for ONE Scheduler-v2 bucket --
// a thin CLI over the shared region-aware runner (lib/server/sync/scheduled-campaign-ads-runner.js). It REPLACES the
// retired ASIN Ads step in scheduler-v2.yml: after the ASIN->Campaign cutover the scheduler keeps Daily Reporting +
// Brand View ad data fresh by refreshing the CAMPAIGN grain for the bucket's regions in coverage mode (21-day rolling
// window), <=5-seller batches, zero-token connection pre-flight + durable-coverage pre-filter (already-covered
// accounts create nothing -> replay adopts completed work), and a guarded create ceiling. Usage (from sales-dashboard-live/):
//   node scripts/release/scheduled-campaign-ads-refresh.mjs --bucket=india|europe-au|us-ca|us|non-us [--as-of=YYYY-MM-DD] [--max-creates=N]
// `--bucket` accepts a REGION (the regional coordinator passes exactly one region -> that one region refreshes) or a
// legacy bucket (fans out to its member regions, for the pre-cutover compat window). Never prints an api key or a
// seller/account/export id.

import { loadReleaseEnv } from "./env-bootstrap.mjs";
import { isRegionScope, isRoutingScope } from "../../lib/server/sync/scheduler-scope.js";

loadReleaseEnv();

const argOf = (name) => { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.split("=").slice(1).join("=") : null; };
const bucket = argOf("bucket");
const asOf = argOf("as-of") || (() => { const d = new Date(); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); })();
const maxCreatesArg = argOf("max-creates");
if (!isRoutingScope(bucket)) { console.error("STOP --bucket must be a routing scope (india|europe-au|us-ca|us|non-us; got: " + bucket + ")"); process.exit(2); }
if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) { console.error("STOP --as-of must be YYYY-MM-DD (got: " + asOf + ")"); process.exit(2); }

const { regionsForBucket, planCampaignAdsRegionRun, runCampaignAdsRegionSlice } = await import("../../lib/server/sync/scheduled-campaign-ads-runner.js");
const { REGION_SCHEDULE } = await import("../../lib/server/sync/campaign-region-routing.js");
const log = (m) => console.log("scheduled-campaign-ads[" + bucket + "@" + asOf + "]: " + m);

// A region scope refreshes EXACTLY that region (the regional coordinator's one-region path); a legacy bucket fans out
// to its member regions (compat). Either way Campaign Ads runs ONCE per region -- one automatic owner, no double-refresh.
const regions = isRegionScope(bucket) ? [bucket] : regionsForBucket(bucket);
if (!regions.length) { console.error("STOP no regions for scope " + bucket); process.exit(2); }

const MAX_PASSES = Number(process.env.SCHEDULED_CAMPAIGN_ADS_MAX_ITERS || 40);
const maxFallbackArg = argOf("max-fallback-creates");
const TOK_PER_CREATE = 2; // STANDARD Campaign export
let totalCreates = 0; let totalTokens = 0; let totalCovered = 0; let totalRejected = 0; let totalTransient = 0; let totalAmbiguous = 0;
for (const region of regions) {
  const label = REGION_SCHEDULE[region].label;
  let result = null;
  for (let pass = 1; pass <= MAX_PASSES; pass += 1) {
    // Daily rolling window (21-day) so only the still-missing recent dates are fetched; already-covered => zero creates.
    const plan = await planCampaignAdsRegionRun({ region, asOf, runKind: "daily" });
    if (pass === 1) {
      // Print the exact bounded plan BEFORE any create: normal exports/token ceiling, worst-case fallback exports/
      // tokens a create-time-4xx split could add, and whether this run is zero-create / normal-create / fallback.
      const normalBatches = Math.ceil(plan.pending.length / 5);
      const fallbackMax = maxFallbackArg != null ? Number(maxFallbackArg) : plan.pending.length;
      const mode = plan.pending.length === 0 ? "ZERO-CREATE" : "NORMAL-CREATE (fallback split only if DataDoe rejects a batch)";
      log(label + ": " + plan.compatible.length + " compatible, " + plan.incompatible.length + " missing-connection, " + plan.covered.length + " already covered, " + plan.pending.length + " pending; window [" + plan.window.from + ".." + plan.window.to + "]");
      log(label + " PLAN: normal<=" + normalBatches + " exports/" + (normalBatches * TOK_PER_CREATE) + " tokens; fallback<=" + fallbackMax + " exports/" + (fallbackMax * TOK_PER_CREATE) + " tokens; hard-ceiling=" + (normalBatches + fallbackMax) + " creates; mode=" + mode);
    }
    result = await runCampaignAdsRegionSlice({ region, asOf, runKind: "daily", plan, ...(maxCreatesArg != null ? { maxCreates: Number(maxCreatesArg) } : {}), ...(maxFallbackArg != null ? { maxFallbackCreates: Number(maxFallbackArg) } : {}), log });
    // COMPLETE (all fresh) or PARTIAL (some accounts isolated with LKG, honestly reported) are BOTH a successful
    // bounded pass -- the failure is bounded/classified/isolated, not suppressed. Only a SYSTEMIC failure exits 1.
    if (result.phase === "complete" || result.phase === "partial") break;
    if (result.continuationRequired === true) { log(label + " pass " + pass + " deferred (work-budget); resuming"); continue; }
    console.error("STOP scheduled Campaign Ads region " + label + " failed: " + JSON.stringify(result.problems || []));
    process.exit(1);
  }
  if (!result || (result.phase !== "complete" && result.phase !== "partial")) { console.error("STOP scheduled Campaign Ads region " + label + " exhausted " + MAX_PASSES + " passes"); process.exit(1); }
  totalCreates += result.creates; totalTokens += result.tokens; totalCovered += result.covered;
  const rej = (result.rejected || []).length, tr = (result.transient || []).length, amb = (result.ambiguous || []).length;
  totalRejected += rej; totalTransient += tr; totalAmbiguous += amb;
  // Isolated accounts are reported HONESTLY (never a silent zero): they retain their last-known-good Campaign data;
  // the next scheduled pass retries transient/ambiguous, a definitively-rejected seller stays isolated until fixed upstream.
  if (rej || tr || amb) log("region " + label + " ISOLATED (retain last-known-good): rejected=" + rej + " transient=" + tr + " ambiguous=" + amb + "; diagnostics=" + JSON.stringify((result.diagnostics || []).map((d) => ({ classification: d.classification, status: d.status, batchSize: d.batchSize }))));
  log("region " + label + " covered=" + result.covered + " creates=" + result.creates + " tokens=" + result.tokens + " (disconnected excluded=" + result.incompatible + ")");
}
log("bucket " + bucket + ": covered=" + totalCovered + " accounts across " + regions.length + " region(s); " + totalCreates + " creates / " + totalTokens + " tokens; isolated rejected=" + totalRejected + " transient=" + totalTransient + " ambiguous=" + totalAmbiguous + " (ASIN creates=0).");
process.exit(0);
