// The ONE active advertising source, and the single rollback point for the ASIN -> Campaign cutover.
//
// Before the cutover the reports read the durable ASIN grain (asin-performance-v1); after it they read the durable
// Campaign grain (campaign-performance-v1). Everything that READS the active Ads grain for Daily Reporting / Brand View /
// the Dashboard consults this module so the switch lives in exactly one place. Flip ADS_ACTIVE_SOURCE back to "asin" to
// roll the read cutover back instantly -- a preserved rollback point. This module is a leaf (no imports) to avoid any
// import cycle.
//
// 2026-10-03: the ASIN/date grain is an ADDITIONAL, independently scheduled durable source again (its saved ASIN-by-date
// rows feed future reports). That is DECOUPLED from the read switch: ADS_ACTIVE_SOURCE stays "campaign", every report
// keeps reading Campaign, and nothing here changes a report calculation. What changed is only the EXPORT rule: an ASIN
// Ads export is no longer retired, it is RUNNER-ONLY -- the reviewed regional ASIN runner
// (lib/server/sync/scheduled-asin-ads-runner.js) is the ONE path that may create one, by passing
// ASIN_ADS_RUNNER_AUTHORIZATION to ads-sync.js; every other path (the legacy Scheduler-v1 cadence sync, a cron scope,
// the admin raw-sourceId discovery probe) still refuses an ASIN create before any I/O.

// "campaign" (live) | "asin" (rollback). The single READ switch.
export const ADS_ACTIVE_SOURCE = "campaign";

export const ASIN_ADS_SOURCE_KEY = "asin-performance-v1";
export const CAMPAIGN_ADS_SOURCE_KEY = "campaign-performance-v1";

// The DataDoe source ID (not the registry key) of the ASIN Ads grain -- so a raw-sourceId create path (e.g. an admin
// discovery probe that takes a browser-supplied sourceId) can be refused by the SAME single authority, before the
// create, without hardcoding the id at the call site.
export const ASIN_ADS_SOURCE_ID = "d0017e92fb089c2c8c3fe65f81d08666ecb4fe937ffbce9969ce2fc7d28c805c";

// The durable source_key the reports read for account/brand/Dashboard Ads.
export const ACTIVE_ADS_SOURCE_KEY = ADS_ACTIVE_SOURCE === "asin" ? ASIN_ADS_SOURCE_KEY : CAMPAIGN_ADS_SOURCE_KEY;

// The source-registry family key of the active grain (ads-campaign-date | ads-asin-date) -- used by readiness
// blockers + registry consumers so they name the active family.
export const ACTIVE_ADS_REGISTRY_KEY = ADS_ACTIVE_SOURCE === "asin" ? "ads-asin-date" : "ads-campaign-date";

// The source-registry family keys hidden from the active operator surfaces. NONE: both Ads grains are operable sources
// (Campaign = the active read grain; ASIN = an additional durable source with its own controls + status). Kept as the
// one authority so a future retirement is again a one-line change here.
export const RETIRED_ADS_REGISTRY_KEYS = Object.freeze([]);
// True if the source-registry family `registryKey` is a retired ads grain (hidden from the active UI).
export function isAdsRegistryKeyRetired(registryKey) {
  return RETIRED_ADS_REGISTRY_KEYS.includes(String(registryKey || ""));
}

// The Ads source keys whose EXPORT may be created ONLY by their reviewed runner (never by a generic cadence path). While
// Campaign is the active read grain, the ASIN grain is runner-only; on a read rollback to "asin" the ASIN grain is the
// active grain again and its legacy cadence path is restored exactly as before.
export const RUNNER_ONLY_ADS_EXPORT_SOURCE_KEYS = Object.freeze(
  ADS_ACTIVE_SOURCE === "campaign" ? [ASIN_ADS_SOURCE_KEY] : []
);
export const RUNNER_ONLY_ADS_EXPORT_SOURCE_IDS = Object.freeze(
  ADS_ACTIVE_SOURCE === "campaign" ? [ASIN_ADS_SOURCE_ID] : []
);

// True if creating an export for `sourceKey` is allowed ONLY through its reviewed runner (a durable read is NEVER
// affected). The legacy Scheduler-v1 registry wires such a key DISABLED, and ads-sync.js refuses it without the runner
// authorization below.
export function isAdsExportRunnerOnlyFor(sourceKey) {
  return RUNNER_ONLY_ADS_EXPORT_SOURCE_KEYS.includes(String(sourceKey || ""));
}

// True if a raw DataDoe `sourceId` is a runner-only Ads source (a browser-supplied sourceId create path must refuse it).
export function isAdsExportRunnerOnlyForSourceId(sourceId) {
  return RUNNER_ONLY_ADS_EXPORT_SOURCE_IDS.includes(String(sourceId || ""));
}

// The capability the reviewed ASIN runner passes to runAdsSyncWithDeps (options.adsRunnerAuthorization). An
// unforgeable module-scoped Symbol: only code that imports it from here can present it, and only the ASIN runner does.
export const ASIN_ADS_RUNNER_AUTHORIZATION = Symbol("asin-ads-runner-authorization");
