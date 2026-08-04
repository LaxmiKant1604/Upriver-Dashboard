// Ads adapter — a thin pass-through to the existing runAdsSync worker.
//
// runAdsSync already: owns its own 600s lock per country/source scope, batches
// seller/vendor ids <=5, upserts idempotently into ads_daily_source_rows on the
// natural key (rolling correction, no double-count), self-budgets ~45s and returns
// { status, deferred }. We just map the bucket to its country groups and let it run.

import { runAdsSync } from "../../ads-sync.js";
import { countriesForBucket } from "../registry.js";

export async function runAdsAdapter({ entry, bucket }) {
  const sourceKey = entry.sourceKey || String(entry.reportKey).replace(/^ads:/, "");
  const { groups } = countriesForBucket(bucket);
  let deferred = false;
  let skipped = false;
  for (const group of groups) {
    const result = await runAdsSync(group, [sourceKey]);
    if (result?.status === "partial" || result?.deferred) deferred = true;
    if (result?.status === "skipped") skipped = true;
  }
  return { deferred, skipped };
}
