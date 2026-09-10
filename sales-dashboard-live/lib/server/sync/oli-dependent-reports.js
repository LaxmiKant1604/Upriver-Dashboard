// SINGLE authoritative registry of the OLI -> dependent CANONICAL LIVE DASHBOARD reports.
//
// This is the ONE place that declares which live dashboard reports depend on durable order-line-items (OLI), so that:
//   - the source-bucket-sync runtime binds each report's lineage `depends_on` from the SAME map (it imports
//     OLI_LINEAGE_DEPENDS_ON from here -- no second copy), and
//   - the OLI publication reconciler (immediate post-save + the 30-minute zero-export path) reads
//     oliDependentLiveReportKeys() to know exactly which reports to re-derive + promote when an account's durable OLI
//     advances, and rebuilds Brand View membership from the promoted `brand-sales` afterwards.
//
// A FUTURE OLI-dependent live report becomes eligible for reconciliation by ADDING ONE ENTRY to OLI_LINEAGE_DEPENDS_ON
// below (its lineage families must include OLI_SOURCE_KEY). A report whose payload does NOT depend on OLI must NOT be
// listed here. The drift guard (scripts/oli-dependent-reports.test.js) proves this set stays consistent with the
// runtime lineage binding, the live-snapshot publisher contracts, and the source registry's usedByReports/Dashboards.
//
// Pure + leaf: imports ONLY the source-key constants from source-durable-model.js (no runtime / publisher / api import),
// so nothing here can reach a DataDoe export transport and there is no import cycle. 7-bit ASCII, LF.

import { OLI_SOURCE_KEY, CATALOG_SOURCE_KEY, FBA_INVENTORY_SOURCE_KEY } from "./source-durable-model.js";

export { OLI_SOURCE_KEY };

// The report key of the live snapshot Brand View membership/directory is rebuilt from AFTER promotion. Brand View
// membership is a READ-TIME directory (not a scheduler-published snapshot), refreshed from the promoted bare
// `brand-sales` snapshots -- so the reconciler rebuilds it only once the relevant `brand-sales` promotions succeed.
export const BRAND_VIEW_MEMBERSHIP_SOURCE_REPORT = "brand-sales";

// Per-live-report OLI-inclusive lineage families. Keyed by the CANONICAL (bare, live-served) report key -- identical
// to the runtime's derive-time depends_on binding and to the publisher's SCHEDULER_LIVE_SNAPSHOT_CONTRACTS keys.
// "brand-inventory" is BRAND_INVENTORY_SNAPSHOT_KEY: its inventory numbers are FBA, but its brand attribution/sales
// velocity is bound to OLI, so an OLI advance must re-derive it. Frozen so no caller can mutate the shared map.
export const OLI_LINEAGE_DEPENDS_ON = Object.freeze({
  "daily-reporting": Object.freeze([OLI_SOURCE_KEY, CATALOG_SOURCE_KEY]),
  "brand-sales": Object.freeze([OLI_SOURCE_KEY, CATALOG_SOURCE_KEY]),
  "brand-inventory": Object.freeze([OLI_SOURCE_KEY, CATALOG_SOURCE_KEY, FBA_INVENTORY_SOURCE_KEY]),
});

// The OLI-inclusive live report keys of ANY lineage-families map, sorted + deduped. Generalized so the drift guard can
// prove that a FUTURE report added to the map (with OLI in its families) is discovered, and a report WITHOUT OLI is
// excluded, without mutating the frozen production map.
export function oliReportKeysFrom(map) {
  return [...new Set(Object.keys(map || {}).filter((k) => Array.isArray(map[k]) && map[k].includes(OLI_SOURCE_KEY)))].sort();
}

// The canonical live report keys the OLI reconciler must (re)derive + promote when durable OLI advances -- EXACTLY the
// declared reports whose lineage families include OLI. A report declared WITHOUT OLI in its families is excluded.
export function oliDependentLiveReportKeys() {
  return oliReportKeysFrom(OLI_LINEAGE_DEPENDS_ON);
}

// True iff `reportKey` is a registered OLI-dependent live report (single lookup for the reconciler + runtime).
export function isOliDependentLiveReport(reportKey) {
  const fams = OLI_LINEAGE_DEPENDS_ON[reportKey];
  return Array.isArray(fams) && fams.includes(OLI_SOURCE_KEY);
}

// Fail-closed self-consistency (run at import, like source-registry's assertSourceRegistryConsistency): every declared
// report must include OLI in its families and the set must be non-empty. A declaration that forgot OLI would silently
// drop the report from reconciliation -- refuse at load rather than strand it.
export function assertOliDependentReportsConsistency(map = OLI_LINEAGE_DEPENDS_ON) {
  const keys = Object.keys(map || {});
  if (keys.length === 0) throw new Error("oli-dependent-reports: OLI_LINEAGE_DEPENDS_ON is empty (fail closed).");
  for (const k of keys) {
    const fams = map[k];
    if (!Array.isArray(fams) || fams.length === 0) throw new Error(`oli-dependent-reports: ${k} has no lineage families (fail closed).`);
    if (!fams.includes(OLI_SOURCE_KEY)) throw new Error(`oli-dependent-reports: ${k} is declared but does not include order-line-items -- a non-OLI report must not live in the OLI registry (fail closed).`);
  }
  if (oliReportKeysFrom(map).length !== keys.length) throw new Error("oli-dependent-reports: every declared report must be OLI-dependent (fail closed).");
}

assertOliDependentReportsConsistency();
