// Dormant feature flags. Flip a flag ON only as part of its authorized go-live.
//
// CAMPAIGN_ADS_TAB: the "Ad Performance by Campaign" sidebar tab + its serving path. Turned ON 2026-09-02 at the
// Campaign Ads go-live -- the initial 56-day backfill is proven live in production (27 Ads-connected accounts across
// the 3 regions, campaign-performance-v1 durable rows). The tab reads only durable data (account+brand authz) and
// never calls DataDoe. ASIN Ads stays live in the existing reports until the atomic ASIN->Campaign cutover.
export const CAMPAIGN_ADS_TAB = true;
