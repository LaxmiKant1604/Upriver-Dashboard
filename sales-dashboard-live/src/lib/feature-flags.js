// Dormant feature flags. Flip a flag ON only as part of its authorized go-live.
//
// CAMPAIGN_ADS_TAB: the "Ad Performance by Campaign" sidebar tab + its serving path. OFF until the authorized Campaign
// Ads go-live (real DataDoe exports proven + the ASIN->Campaign report cutover). While OFF the whole feature is built,
// tested and deployed but NOT shown to users, and no existing report is affected.
export const CAMPAIGN_ADS_TAB = false;
