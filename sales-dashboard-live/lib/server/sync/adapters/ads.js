// Ads adapter — a thin pass-through to the existing runAdsSync worker.
//
// runAdsSync already: owns its own 600s lock per country/source scope, batches
// seller/vendor ids <=5, upserts idempotently into ads_daily_source_rows on the
// natural key (rolling correction, no double-count), self-budgets ~45s and returns
// { status, deferred }. We just map the bucket to its country groups and let it run.

import { runAdsSync } from "../../ads-sync.js";
export async function runAdsAdapter({ entry, countries }) {
  const sourceKey = entry.sourceKey || String(entry.reportKey).replace(/^ads:/, "");
  const result = await runAdsSync(countries, [sourceKey]);
  return {
    deferred: result?.status === "partial" || Boolean(result?.deferred),
    skipped: result?.status === "skipped",
  };
}
