// Publication recovery WP11 -- the 'fba' LEGACY-CLI route (worker side): the pre-existing zero-export FBA brand-inventory
// publication reconciler (scripts/release/fba-publication-reconcile.mjs) in the route shape. It awaits 'oli': the
// brand-inventory release requires a proven live brand-sales at requestedAsOf (fba-brand-inventory-release.js). EXACT
// pre-existing argv + 330 / 420 bounds. Evidence: the durable fba-inventory-health pointer (source_request_hash +
// payload_sha; the verbatim legacy statement + composeEvidenceTokens from oli.route.js). 7-bit ASCII, LF.

import { fbaDependentLiveReportKeys } from "../../sync/fba-dependent-reports.js";
import { LEGACY_EVIDENCE_SQL, composeLegacyTokens, legacyTargets, legacyLiveRowScope } from "./oli.route.js";

export const FBA_ROUTE_REPORT_KEYS = Object.freeze([...fbaDependentLiveReportKeys()]);

export default Object.freeze({
  id: "fba",
  kind: "legacy-cli",
  cli: Object.freeze({ script: "scripts/release/fba-publication-reconcile.mjs", fixedArgs: Object.freeze([]) }),
  publisherKeys: FBA_ROUTE_REPORT_KEYS,
  liveReportKeys: FBA_ROUTE_REPORT_KEYS,
  grain: "account",
  unit: "none",
  awaits: Object.freeze(["oli"]),
  deps: Object.freeze({ sources: Object.freeze(["fba-inventory-health"]), reports: Object.freeze(["brand-sales"]) }),
  evidence: Object.freeze({
    sql: Object.freeze([LEGACY_EVIDENCE_SQL.fba_pointers]),
    compose: (rowsByName, ctx = {}) => legacyTargets(composeLegacyTokens(rowsByName).fba, ctx),
    everySeconds: 60,
  }),
  identityAsOf: null,
  tier1: Object.freeze({ liveRowScope: legacyLiveRowScope(FBA_ROUTE_REPORT_KEYS) }),
  deadlineSeconds: 330,
  hardTimeoutSeconds: 420,
  childHeapMb: 512,
  minChildHeapMb: 192,
  priority: 4,
  scanGroup: "fba",
});
