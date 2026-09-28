// Publication recovery WP11 -- the 'listings' LEGACY-CLI route (worker side): the pre-existing zero-export Listing Health
// v3 reconciler (scripts/release/listing-health-v3-reconcile.mjs) in the route shape. EXACT pre-existing argv under
// the LHv3 backstop bounds (--deadline-seconds=720 under `timeout 840`). Evidence: the durable Listings + Listings-Raw
// pointers folded with the FBA pointer, the org catalog and the OLI token (the LHv3 fingerprint's inputs -- any of
// them re-checks LHv3); the verbatim legacy statements + composeEvidenceTokens from oli.route.js. 7-bit ASCII, LF.

import { listingsDependentLiveReportKeys } from "../../sync/listing-health-v3-dependent-reports.js";
import { LEGACY_EVIDENCE_SQL, composeLegacyTokens, legacyTargets, legacyLiveRowScope } from "./oli.route.js";

export const LISTINGS_ROUTE_REPORT_KEYS = Object.freeze([...listingsDependentLiveReportKeys()]);

export default Object.freeze({
  id: "listings",
  kind: "legacy-cli",
  cli: Object.freeze({ script: "scripts/release/listing-health-v3-reconcile.mjs", fixedArgs: Object.freeze([]) }),
  publisherKeys: LISTINGS_ROUTE_REPORT_KEYS,
  liveReportKeys: LISTINGS_ROUTE_REPORT_KEYS,
  grain: "account",
  unit: "none",
  awaits: Object.freeze([]),
  deps: Object.freeze({ sources: Object.freeze(["listings", "listings-raw"]), reports: Object.freeze([]) }),
  evidence: Object.freeze({
    sql: Object.freeze([LEGACY_EVIDENCE_SQL.oli_coverage, LEGACY_EVIDENCE_SQL.oli_completeness, LEGACY_EVIDENCE_SQL.fba_pointers, LEGACY_EVIDENCE_SQL.listings_pointers, LEGACY_EVIDENCE_SQL.catalog_pointer]),
    compose: (rowsByName, ctx = {}) => legacyTargets(composeLegacyTokens(rowsByName).listings, ctx),
    everySeconds: 60,
  }),
  identityAsOf: null,
  tier1: Object.freeze({ liveRowScope: legacyLiveRowScope(LISTINGS_ROUTE_REPORT_KEYS) }),
  deadlineSeconds: 720,
  hardTimeoutSeconds: 840,
  childHeapMb: 512,
  minChildHeapMb: 192,
  // Second in PUBLICATION_ROUTES (after oli, tied with fba-plan): the LHv3 backstop runs before the Brand View family.
  priority: 2,
  scanGroup: "listings",
});
