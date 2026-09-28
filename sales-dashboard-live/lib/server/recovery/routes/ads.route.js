// Publication recovery WP11 -- the 'ads' LEGACY-CLI route (worker side): the pre-existing zero-export Campaign-Ads
// publication reconciler (scripts/release/ads-publication-reconcile.mjs) in the route shape. The CLI runs ONLY its
// daily-reporting operation (buildOperation("daily-reporting"); ppc-performance is deliberately superseded there), so the
// route publishes exactly ADS_CLI_OPERATION_REPORT_KEYS -- pinned by a static test against the CLI source. It awaits
// 'oli' (the daily-reporting release requires the exact D-1 OLI first). EXACT pre-existing argv + 330 / 420 bounds.
// Evidence: the ads_sync_state content_rev of the worker keys feeding those reports (the verbatim legacy statement +
// composeEvidenceTokens from oli.route.js). 7-bit ASCII, LF.

import { adsDependentLiveReportKeys, adsGrainsForReport, adsWorkerKeyForGrain } from "../../sync/ads-dependent-reports.js";
import { LEGACY_EVIDENCE_SQL, composeLegacyTokens, legacyTargets, legacyLiveRowScope } from "./oli.route.js";

export const ADS_CLI_OPERATION_REPORT_KEYS = Object.freeze(["daily-reporting"]);
export const ADS_ROUTE_REPORT_KEYS = Object.freeze(adsDependentLiveReportKeys().filter((k) => ADS_CLI_OPERATION_REPORT_KEYS.includes(k)));

/** The ads_sync_state worker keys whose content_rev feeds the Ads route's live reports (the evidence token). */
export function adsEvidenceWorkerKeys() {
  const keys = new Set();
  for (const rk of ADS_ROUTE_REPORT_KEYS) for (const g of adsGrainsForReport(rk)) keys.add(adsWorkerKeyForGrain(g));
  return [...keys].sort();
}

export default Object.freeze({
  id: "ads",
  kind: "legacy-cli",
  cli: Object.freeze({ script: "scripts/release/ads-publication-reconcile.mjs", fixedArgs: Object.freeze([]) }),
  publisherKeys: ADS_ROUTE_REPORT_KEYS,
  liveReportKeys: ADS_ROUTE_REPORT_KEYS,
  grain: "account",
  unit: "none",
  awaits: Object.freeze(["oli"]),
  deps: Object.freeze({ sources: Object.freeze(["campaign-ads"]), reports: Object.freeze(["brand-sales"]) }),
  evidence: Object.freeze({
    sql: Object.freeze([Object.freeze({ ...LEGACY_EVIDENCE_SQL.ads_revs, params: () => [adsEvidenceWorkerKeys()] })]),
    compose: (rowsByName, ctx = {}) => legacyTargets(composeLegacyTokens(rowsByName).ads, ctx),
    everySeconds: 60,
  }),
  identityAsOf: null,
  tier1: Object.freeze({ liveRowScope: legacyLiveRowScope(ADS_ROUTE_REPORT_KEYS) }),
  deadlineSeconds: 330,
  hardTimeoutSeconds: 420,
  childHeapMb: 512,
  minChildHeapMb: 192,
  priority: 3,
  scanGroup: "ads",
});
