// Dormant feature flags. Flip a flag ON only as part of its authorized go-live.
//
// CAMPAIGN_ADS_TAB: the "Ad Performance by Campaign" sidebar tab + its serving path. Turned ON 2026-09-02 at the
// Campaign Ads go-live -- the initial 56-day backfill is proven live in production (27 Ads-connected accounts across
// the 3 regions, campaign-performance-v1 durable rows). The tab reads only durable data (account+brand authz) and
// never calls DataDoe. ASIN Ads stays live in the existing reports until the atomic ASIN->Campaign cutover.
export const CAMPAIGN_ADS_TAB = true;

// LISTING_HEALTH_V3: the additive, READ-ONLY "Listing Health (v3 preview)" sidebar tab + its serving path
// (api action "listing-health-v3"). DEFAULT OFF -- the production default stays the v1 Listing Health page. When
// ON, the preview reads only durable OLI/catalog + latest saved source evidence (zero DataDoe exports, zero
// production writes); a date change only re-aggregates stored OLI. Enforces the listing-health-v3 capability
// (401/403, account+marketplace pinned server-side). Flip ON only as part of its authorized preview go-live.
export const LISTING_HEALTH_V3 = false;
