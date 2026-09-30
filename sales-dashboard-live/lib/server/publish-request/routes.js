// "Publish from saved data" -- the LEAF list of reports whose single-scope zero-export executor is IMPLEMENTED AND TESTED
// (no imports: the report-materialization registry and the browser-mirror pin test import it). A report appears here
// only together with its executor (lib/server/publish-request/<report>-executor.js) and its tests; the registry's
// `savedDataPublish` declaration must name exactly these (validateReportMaterializationRegistry, both directions).
// Brand View Portfolio is intentionally ABSENT until its own canary is measured. 7-bit ASCII, LF.

export const SAVED_DATA_PUBLISH_ROUTES = Object.freeze({
  "brand-view": Object.freeze({ routeId: "brand-view", scope: "account-brand", label: "Brand View" }),
});
