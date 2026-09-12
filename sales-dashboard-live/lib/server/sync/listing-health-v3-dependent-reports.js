// SINGLE authoritative registry of the durable-Listings/Listings-Raw -> dependent CANONICAL LIVE DASHBOARD reports.
//
// The listing-health-v3 analog of fba-dependent-reports.js / oli-dependent-reports.js. It declares which live dashboard
// reports depend on the DURABLE Listings + Listings-Raw snapshots (source_listings_snapshot / source_listings_raw_snapshot,
// source_key='listings'/'listings-raw') so the listing-health-v3 saved-data reconciler (immediate post-ingestion +
// the 30-minute zero-export backstop) knows exactly which reports to re-derive + promote when an account's durable
// Listings/Raw advances past -- or was never promoted to -- its live snapshot.
//
// WHY only listing-health-v3 (today):
//   - "listing-health-v3" (advanced Listing Health, SHADOW snapshotVersion listing-health/v3-oli-window) is derived
//     ZERO-export by the canonical REPORT_DERIVATIONS["listing-health-v3"].derive from the HYDRATED durable Listings +
//     Listings-Raw rows (WORK B) plus durable OLI + Product Catalog (derived deps) + the reuse-only durable FBA
//     inventory. Listings + durable OLI are its only HARD-required evidence, so it is re-derivable + provable from
//     ALREADY-SAVED durable data -- the exact zero-export contract the reconciler requires.
//   - No OTHER live report consumes the durable Listings/Raw snapshots (listing-health v1 stays on its own live route;
//     listing-optimizer owns SQP/catalog, not listings). If a future report becomes durable-Listings-dependent, add
//     ONE entry to LISTINGS_LINEAGE_DEPENDS_ON below (its families must include a listings source key).
//
// Pure + leaf: imports ONLY the source-key constants (no runtime / publisher / api import), so nothing here can reach a
// provider export transport and there is no import cycle. 7-bit ASCII, LF.

import { LISTINGS_SOURCE_KEY, LISTINGS_RAW_SOURCE_KEY } from "./source-durable-model.js";

export { LISTINGS_SOURCE_KEY, LISTINGS_RAW_SOURCE_KEY };

// The canonical (bare, live-served) report key of the advanced Listing Health dashboard. Identical to the shadow
// operation's report key and to the publisher's SCHEDULER_LIVE_SNAPSHOT_CONTRACTS key.
export const LISTING_HEALTH_V3_LIVE_REPORT = "listing-health-v3";

// Per-live-report Listings-inclusive lineage families. Keyed by the CANONICAL live report key. Frozen so no caller
// mutates the shared map. (Only the durably-reconcilable Listings-dependent live report is listed.)
export const LISTINGS_LINEAGE_DEPENDS_ON = Object.freeze({
  "listing-health-v3": Object.freeze([LISTINGS_SOURCE_KEY, LISTINGS_RAW_SOURCE_KEY]),
});

// The Listings-inclusive live report keys of ANY lineage-families map, sorted + deduped.
export function listingsReportKeysFrom(map) {
  return [...new Set(Object.keys(map || {}).filter((k) => Array.isArray(map[k]) && map[k].includes(LISTINGS_SOURCE_KEY)))].sort();
}

// The canonical live report keys the listing-health-v3 reconciler must (re)derive + promote when durable Listings/Raw
// advance.
export function listingsDependentLiveReportKeys() {
  return listingsReportKeysFrom(LISTINGS_LINEAGE_DEPENDS_ON);
}

// True iff `reportKey` is a registered Listings-dependent live report.
export function isListingsDependentLiveReport(reportKey) {
  const fams = LISTINGS_LINEAGE_DEPENDS_ON[reportKey];
  return Array.isArray(fams) && fams.includes(LISTINGS_SOURCE_KEY);
}

// Fail-closed self-consistency (run at import): every declared report must include the Listings source in its
// families and the set must be non-empty.
export function assertListingsDependentReportsConsistency(map = LISTINGS_LINEAGE_DEPENDS_ON) {
  const keys = Object.keys(map || {});
  if (keys.length === 0) throw new Error("listing-health-v3-dependent-reports: LISTINGS_LINEAGE_DEPENDS_ON is empty (fail closed).");
  for (const k of keys) {
    const fams = map[k];
    if (!Array.isArray(fams) || fams.length === 0) throw new Error(`listing-health-v3-dependent-reports: ${k} has no lineage families (fail closed).`);
    if (!fams.includes(LISTINGS_SOURCE_KEY)) throw new Error(`listing-health-v3-dependent-reports: ${k} is declared but does not include listings (fail closed).`);
  }
  if (listingsReportKeysFrom(map).length !== keys.length) throw new Error("listing-health-v3-dependent-reports: every declared report must be Listings-dependent (fail closed).");
}

assertListingsDependentReportsConsistency();
