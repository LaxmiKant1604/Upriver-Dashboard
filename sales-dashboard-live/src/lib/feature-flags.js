// Dormant feature flags. Flip a flag ON only as part of its authorized go-live.
import { envFlagOn } from "./env-flag.js";

// CAMPAIGN_ADS_TAB: the "Ad Performance by Campaign" sidebar tab + its serving path. Turned ON 2026-09-02 at the
// Campaign Ads go-live -- the initial 56-day backfill is proven live in production (27 Ads-connected accounts across
// the 3 regions, campaign-performance-v1 durable rows). The tab reads only durable data (account+brand authz) and
// never calls DataDoe. ASIN Ads stays live in the existing reports until the atomic ASIN->Campaign cutover.
export const CAMPAIGN_ADS_TAB = true;

// LISTING_HEALTH_V3 -- FRONTEND navigation/view activation for the additive, READ-ONLY "Listing Health (v3 preview)"
// sidebar tab + its client view. This is a BUILD-TIME Vite gate compiled INTO the browser bundle from the
// VITE_LISTING_HEALTH_V3 variable; it is true ONLY for the exact string "true" (absent / blank / "false" / malformed
// => OFF, via envFlagOn). It is DISTINCT from -- and INDEPENDENT of -- the two SERVER gates. A server variable can
// never affect the compiled browser bundle, so WITHOUT this build-time flag the tab is hidden and the view is
// unreachable no matter what the server is configured to serve. The three gates that gate the v3 activation:
//   VITE_LISTING_HEALTH_V3 (this; BUILD-TIME, compiled into the bundle) -> frontend navigation / view activation.
//   LISTING_HEALTH_V3      (SERVER env)                                 -> the server route / live-serve AUTHORIZATION
//                                                                          gate (api action "listing-health-v3":
//                                                                          401/403, account + marketplace pinned).
//   LHV3_PUBLISH_LIVE      (SERVER env)                                 -> the server PROMOTED-snapshot serve gate
//                                                                          (serves the reconciler's promoted live row
//                                                                          only when this AND the authz gate are on).
// All three default OFF; flip each ON only as part of the authorized go-live. The v1 Listing Health page stays the
// production default. When ON, the preview reads only durable OLI/Catalog + latest saved source evidence (zero DataDoe
// exports, zero production writes); a date change only re-aggregates stored OLI.
// The `typeof import.meta.env` guard keeps this module import-safe in a NON-Vite (Node) context -- where import.meta.env
// is undefined -- so it evaluates to OFF instead of throwing (feature-flags.js is imported by Node unit tests). Vite
// statically replaces the plain `import.meta.env.VITE_LISTING_HEALTH_V3` member expression at build time.
export const LISTING_HEALTH_V3 = envFlagOn(typeof import.meta.env !== "undefined" ? import.meta.env.VITE_LISTING_HEALTH_V3 : undefined);
