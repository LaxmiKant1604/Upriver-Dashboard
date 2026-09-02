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
let totalCreates = 0; let totalTokens = 0; let totalCovered = 0;
for (const region of regions) {
  const label = REGION_SCHEDULE[region].label;
  let result = null;
  for (let pass = 1; pass <= MAX_PASSES; pass += 1) {
    // Daily rolling window (21-day) so only the still-missing recent dates are fetched; already-covered => zero creates.
    const plan = await planCampaignAdsRegionRun({ region, asOf, runKind: "daily" });
    if (pass === 1) log(label + ": " + plan.compatible.length + " compatible, " + plan.incompatible.length + " missing-connection, " + plan.covered.length + " already covered, " + plan.pending.length + " pending; window [" + plan.window.from + ".." + plan.window.to + "]");
    result = await runCampaignAdsRegionSlice({ region, asOf, runKind: "daily", plan, ...(maxCreatesArg != null ? { maxCreates: Number(maxCreatesArg) } : {}), log });
    if (result.phase === "complete") break;
    if (result.continuationRequired === true) { log(label + " pass " + pass + " deferred (work-budget); resuming"); continue; }
    console.error("STOP scheduled Campaign Ads region " + label + " failed: " + JSON.stringify(result.problems || []));
    process.exit(1);
  }
  if (!result || result.phase !== "complete") { console.error("STOP scheduled Campaign Ads region " + label + " exhausted " + MAX_PASSES + " passes"); process.exit(1); }
  totalCreates += result.creates; totalTokens += result.tokens; totalCovered += result.covered;
  log("region " + label + " PROVEN: covered=" + result.covered + " creates=" + result.creates + " tokens=" + result.tokens + " (disconnected excluded=" + result.incompatible + ")");
}
log("PROVEN bucket " + bucket + ": covered=" + totalCovered + " accounts across " + regions.length + " region(s); " + totalCreates + " creates / " + totalTokens + " tokens.");
process.exit(0);
