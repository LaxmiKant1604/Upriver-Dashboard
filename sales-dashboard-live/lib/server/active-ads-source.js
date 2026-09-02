// The ONE active advertising source, and the single rollback point for the ASIN -> Campaign cutover.
//
// Before the cutover the reports read the durable ASIN grain (asin-performance-v1); after it they read the durable
// Campaign grain (campaign-performance-v1) and creating a NEW ASIN Ads export is disabled. Everything that (a) reads
// the active Ads grain for Daily Reporting / Brand View / the Dashboard, and (b) could CREATE an Ads export, consults
// this module so the switch lives in exactly one place. Flip ADS_ACTIVE_SOURCE back to "asin" to roll the whole
// cutover back instantly -- a preserved rollback point. This module is a leaf (no imports) to avoid any import cycle.

// "campaign" (live) | "asin" (rollback). The single switch.
export const ADS_ACTIVE_SOURCE = "campaign";

export const ASIN_ADS_SOURCE_KEY = "asin-performance-v1";
export const CAMPAIGN_ADS_SOURCE_KEY = "campaign-performance-v1";

// The DataDoe source ID (not the registry key) of the retired ASIN Ads grain -- so a raw-sourceId create path (e.g.
// an admin discovery probe that takes a browser-supplied sourceId) can be blocked by the SAME single authority,
// before the create, without hardcoding the id at the call site.
export const ASIN_ADS_SOURCE_ID = "d0017e92fb089c2c8c3fe65f81d08666ecb4fe937ffbce9969ce2fc7d28c805c";

// The durable source_key the reports read for account/brand/Dashboard Ads.
export const ACTIVE_ADS_SOURCE_KEY = ADS_ACTIVE_SOURCE === "asin" ? ASIN_ADS_SOURCE_KEY : CAMPAIGN_ADS_SOURCE_KEY;

// The source-registry family key of the active grain (ads-campaign-date | ads-asin-date) -- used by readiness
// blockers + registry consumers so they name the active family.
export const ACTIVE_ADS_REGISTRY_KEY = ADS_ACTIVE_SOURCE === "asin" ? "ads-asin-date" : "ads-campaign-date";

// When Campaign is active, the ASIN grain's EXPORT path is RETIRED (its durable history + all reader code are retained
// untouched -- only new exports are blocked). Rolling back to "asin" clears the retirement so ASIN can refresh again.
export const RETIRED_ADS_EXPORT_SOURCE_KEYS = Object.freeze(
  ADS_ACTIVE_SOURCE === "campaign" ? [ASIN_ADS_SOURCE_KEY] : []
);
export const isAdsExportRetired = RETIRED_ADS_EXPORT_SOURCE_KEYS.length > 0;

// True if creating an export for `sourceKey` is disabled by the retirement (a durable read is NEVER affected).
export function isAdsExportRetiredFor(sourceKey) {
  return RETIRED_ADS_EXPORT_SOURCE_KEYS.includes(String(sourceKey || ""));
}

// The DataDoe source ID(s) whose EXPORT is retired -- mirrors RETIRED_ADS_EXPORT_SOURCE_KEYS but keyed by the raw
// DataDoe sourceId, for any create path that speaks in source IDs instead of registry keys.
export const RETIRED_ADS_EXPORT_SOURCE_IDS = Object.freeze(
  ADS_ACTIVE_SOURCE === "campaign" ? [ASIN_ADS_SOURCE_ID] : []
);

// True if creating an export for a raw DataDoe `sourceId` is disabled by the retirement (a durable read is NEVER
// affected). Fail closed: an unknown/blank sourceId is treated as not-retired only for THIS id-based check; the
// key-based guard + the registry remain the primary gate for the known active/retired families.
export function isAdsExportRetiredForSourceId(sourceId) {
  return RETIRED_ADS_EXPORT_SOURCE_IDS.includes(String(sourceId || ""));
}
