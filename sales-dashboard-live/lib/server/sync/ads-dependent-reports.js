// SINGLE authoritative registry of the durable-Campaign-Ads -> dependent CANONICAL LIVE DASHBOARD reports.
//
// The Ads analog of oli-dependent-reports.js / fba-dependent-reports.js. It declares which live dashboard reports
// depend on the DURABLE Campaign Ads rows (public.ads_daily_source_rows, source_key 'campaign-performance-v1', plus the
// per-account ads_sync_state.content_rev + ads_sync_coverage from migration 20260923) so the Ads saved-data reconciler
// (immediate post-persistence + the 30-minute zero-export path) knows exactly which reports to re-derive + promote when
// an account's durable Ads content advances or is same-date corrected.
//
// WHICH reports (and which grains):
//   - "daily-reporting" depends on the CAMPAIGN grain (ads-campaign-date) for its per-brand ad spend/ACOS columns. It
//     is ALSO OLI-primary (OLI + catalog): the OLI reconciler re-derives it when OLI advances; THIS Ads reconciler
//     covers the gap where Ads advances but OLI does not. Its Ads dependency is the campaign grain ONLY.
//   - "ppc-performance" is Ads-PRIMARY: it depends on the CAMPAIGN + TARGETING + SEARCH-TERMS grains (plus OLI + catalog
//     for attribution). Every Ads grain a report consumes must invalidate it on a same-date correction.
// NOT included: the Campaign Ads workspace ("Ad Performance by Campaign") is served DURABLY-DIRECT from
// ads_daily_source_rows (the client re-windows 7/14/30D with zero refetch); it has NO live-snapshot promotion, so it is
// NOT a reconciler target and must never be republished. brand-view consumes ads-campaign-date but is MATERIALIZED (a
// producer job, not a live-promoted report), so it is reconciled by the Brand View materializer, not here.
//
// Pure + leaf: imports ONLY the source-key constants (no runtime / publisher / api import), so nothing here can reach a
// provider export transport and there is no import cycle. 7-bit ASCII, LF.

// The durable Campaign Ads source keys (the ACTIVE post-cutover campaign grain + the targeting/search-terms grains).
// These match source-registry.js / source-contracts.js. The reconciler reads ONLY these durable grains, never an export.
export const ADS_CAMPAIGN_SOURCE_KEY = "ads-campaign-date";
export const ADS_TARGETING_SOURCE_KEY = "ads-targeting-date";
export const ADS_SEARCH_TERMS_SOURCE_KEY = "ads-search-terms-date";
// The campaign grain is REQUIRED for eligibility (both dependent reports consume it + it is the active durable dataset);
// targeting + search-terms are ADDITIONAL grains folded into the content revision when durably covered.
export const ADS_SOURCE_KEYS = Object.freeze([ADS_CAMPAIGN_SOURCE_KEY, ADS_TARGETING_SOURCE_KEY, ADS_SEARCH_TERMS_SOURCE_KEY]);
export const ADS_PRIMARY_SOURCE_KEY = ADS_CAMPAIGN_SOURCE_KEY;

// Per-live-report Campaign-Ads-inclusive lineage families, keyed by the CANONICAL live report key (the publisher's
// SCHEDULER_LIVE_SNAPSHOT_CONTRACTS key). Frozen so no caller mutates the shared map. Only the durably-reconcilable
// Ads-dependent LIVE reports are listed (the durably-direct Campaign Ads workspace + the materialized brand-view are
// deliberately excluded -- see the module header).
export const ADS_LINEAGE_DEPENDS_ON = Object.freeze({
  "daily-reporting": Object.freeze([ADS_CAMPAIGN_SOURCE_KEY]),
  "ppc-performance": Object.freeze([ADS_CAMPAIGN_SOURCE_KEY, ADS_TARGETING_SOURCE_KEY, ADS_SEARCH_TERMS_SOURCE_KEY]),
});

// Per-report REQUIRED continuous-coverage window (days, inclusive, ending at the requested D-1). The reconciler proves
// the report's Ads grains are durably + CONTINUOUSLY covered over [requestedAsOf-(days-1) .. requestedAsOf] (never a
// MAX(covered_to) span that hides a gap). ppc-performance uses the 30-day PPC window; daily-reporting uses its 7-day
// minimum (the derive re-validates the exact live window + degrades honestly, so this is a lower-bound eligibility
// gate, not the report's full window). Kept here beside the lineage so a new report declares both together.
export const ADS_REPORT_COVERAGE_DAYS = Object.freeze({
  "daily-reporting": 7,
  "ppc-performance": 30,
});

// The required continuous-coverage window (days) for a report, or 1 (D-1 itself) when undeclared (fail toward the
// strictest single-day proof rather than an unbounded span).
export function adsRequiredCoverageDays(reportKey) {
  const d = ADS_REPORT_COVERAGE_DAYS[reportKey];
  return Number.isInteger(d) && d > 0 ? d : 1;
}

const includesAnyAds = (fams) => Array.isArray(fams) && ADS_SOURCE_KEYS.some((k) => fams.includes(k));

// The Ads-inclusive live report keys of ANY lineage-families map, sorted + deduped.
export function adsReportKeysFrom(map) {
  return [...new Set(Object.keys(map || {}).filter((k) => includesAnyAds(map[k])))].sort();
}

// The canonical live report keys the Ads reconciler must (re)derive + promote when durable Ads advances/corrects.
export function adsDependentLiveReportKeys() {
  return adsReportKeysFrom(ADS_LINEAGE_DEPENDS_ON);
}

// True iff `reportKey` is a registered Ads-dependent live report.
export function isAdsDependentLiveReport(reportKey) {
  return includesAnyAds(ADS_LINEAGE_DEPENDS_ON[reportKey]);
}

// The exact Ads grains a given live report depends on (sorted), or [] if it is not Ads-dependent. The normal derive AND
// the reconciler derive fold these EXACT grains into the report job's durable content provenance.
export function adsGrainsForReport(reportKey) {
  const fams = ADS_LINEAGE_DEPENDS_ON[reportKey];
  return Array.isArray(fams) ? [...fams].filter((k) => ADS_SOURCE_KEYS.includes(k)).sort() : [];
}

// Fail-closed self-consistency (run at import, like oli/fba-dependent-reports): every declared report must include at
// least one Ads source in its families, the campaign grain must be present (the required/primary grain), and the set
// must be non-empty. A declaration that forgot Ads would silently drop the report from reconciliation.
export function assertAdsDependentReportsConsistency(map = ADS_LINEAGE_DEPENDS_ON) {
  const keys = Object.keys(map || {});
  if (keys.length === 0) throw new Error("ads-dependent-reports: ADS_LINEAGE_DEPENDS_ON is empty (fail closed).");
  for (const k of keys) {
    const fams = map[k];
    if (!Array.isArray(fams) || fams.length === 0) throw new Error(`ads-dependent-reports: ${k} has no lineage families (fail closed).`);
    if (!includesAnyAds(fams)) throw new Error(`ads-dependent-reports: ${k} is declared but includes no Ads source grain (fail closed).`);
    if (!fams.includes(ADS_PRIMARY_SOURCE_KEY)) throw new Error(`ads-dependent-reports: ${k} must include the required campaign grain ${ADS_PRIMARY_SOURCE_KEY} (fail closed).`);
    for (const f of fams) if (!ADS_SOURCE_KEYS.includes(f)) throw new Error(`ads-dependent-reports: ${k} declares unknown Ads grain ${f} (fail closed).`);
    if (!(Number.isInteger(ADS_REPORT_COVERAGE_DAYS[k]) && ADS_REPORT_COVERAGE_DAYS[k] > 0)) throw new Error(`ads-dependent-reports: ${k} has no positive ADS_REPORT_COVERAGE_DAYS (fail closed).`);
  }
  if (adsReportKeysFrom(map).length !== keys.length) throw new Error("ads-dependent-reports: every declared report must be Ads-dependent (fail closed).");
}

assertAdsDependentReportsConsistency();
