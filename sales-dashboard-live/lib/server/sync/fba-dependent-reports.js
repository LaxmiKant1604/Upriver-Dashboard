// SINGLE authoritative registry of the durable-FBA-inventory -> dependent CANONICAL LIVE DASHBOARD reports.
//
// The FBA analog of oli-dependent-reports.js. It declares which live dashboard reports depend on the DURABLE FBA
// inventory snapshot (public.source_snapshots, source_key='fba-inventory-health') so the FBA saved-data reconciler
// (immediate post-save + the 30-minute zero-export path) knows exactly which reports to re-derive + promote when an
// account's durable FBA inventory advances past -- or was never promoted to -- its live snapshot.
//
// WHY only brand-inventory (today):
//   - "brand-inventory" (BRAND_INVENTORY_SNAPSHOT_KEY) is the compact Brand View inventory. It is produced ZERO-export
//     by buildBrandInventorySnapshot reading the HYDRATED durable FBA rows (source-bucket-sync-runtime.js), and its
//     lineage depends_on records the account's own FBA source_request_hash (proven by source-production-hardening's
//     account-exact lineage assertion). So it is re-derivable + provable from ALREADY-SAVED durable data -- the exact
//     zero-export contract the reconciler requires. It is ALSO OLI-dependent (OLI_LINEAGE_DEPENDS_ON['brand-inventory']
//     includes OLI + CATALOG + FBA_INVENTORY); the OLI reconciler re-derives it when OLI advances, while THIS FBA
//     reconciler covers the gap where FBA advances but OLI does not. The GLOBAL control-plane lease serializes the two
//     reconcilers, and the publisher's content-addressed CAS makes a redundant re-publish an idempotent no-op.
//   - "fba-plan" (FBA Shipment Plan) is genuinely FBA-dependent BUT its derive reads inventory from the TTL cycle cache
//     (sources['fba-plan:inventory-health']), NOT from the durable source_snapshots, and a US account HARD-REQUIRES the
//     non-durable AWD ('listings') source. A zero-export fba-plan reconciler therefore needs a NEW durable-inventory
//     bridge (buildDurableFbaInventory) + a non-US-only scope; that is a distinct, larger increment and is DELIBERATELY
//     NOT registered here yet (documented in the delivery report as prepared future work).
//
// Pure + leaf: imports ONLY the source-key + snapshot-key constants (no runtime / publisher / api import), so nothing
// here can reach a provider export transport and there is no import cycle. 7-bit ASCII, LF.

import { FBA_INVENTORY_SOURCE_KEY } from "./source-durable-model.js";

export { FBA_INVENTORY_SOURCE_KEY };

// The canonical (bare, live-served) report key of the compact Brand View inventory dashboard. Identical to the
// runtime's BRAND_INVENTORY_SNAPSHOT_KEY and to the publisher's SCHEDULER_LIVE_SNAPSHOT_CONTRACTS key.
export const BRAND_INVENTORY_LIVE_REPORT = "brand-inventory";

// Per-live-report FBA-inclusive lineage families. Keyed by the CANONICAL live report key. Frozen so no caller mutates
// the shared map. (Only the durably-reconcilable FBA-dependent live report is listed; see the module header for why
// fba-plan is excluded until its durable-inventory bridge lands.)
export const FBA_LINEAGE_DEPENDS_ON = Object.freeze({
  "brand-inventory": Object.freeze([FBA_INVENTORY_SOURCE_KEY]),
});

// The FBA-inclusive live report keys of ANY lineage-families map, sorted + deduped.
export function fbaReportKeysFrom(map) {
  return [...new Set(Object.keys(map || {}).filter((k) => Array.isArray(map[k]) && map[k].includes(FBA_INVENTORY_SOURCE_KEY)))].sort();
}

// The canonical live report keys the FBA reconciler must (re)derive + promote when durable FBA inventory advances.
export function fbaDependentLiveReportKeys() {
  return fbaReportKeysFrom(FBA_LINEAGE_DEPENDS_ON);
}

// True iff `reportKey` is a registered FBA-dependent live report.
export function isFbaDependentLiveReport(reportKey) {
  const fams = FBA_LINEAGE_DEPENDS_ON[reportKey];
  return Array.isArray(fams) && fams.includes(FBA_INVENTORY_SOURCE_KEY);
}

// Fail-closed self-consistency (run at import): every declared report must include the FBA source in its families and
// the set must be non-empty.
export function assertFbaDependentReportsConsistency(map = FBA_LINEAGE_DEPENDS_ON) {
  const keys = Object.keys(map || {});
  if (keys.length === 0) throw new Error("fba-dependent-reports: FBA_LINEAGE_DEPENDS_ON is empty (fail closed).");
  for (const k of keys) {
    const fams = map[k];
    if (!Array.isArray(fams) || fams.length === 0) throw new Error(`fba-dependent-reports: ${k} has no lineage families (fail closed).`);
    if (!fams.includes(FBA_INVENTORY_SOURCE_KEY)) throw new Error(`fba-dependent-reports: ${k} is declared but does not include fba-inventory-health (fail closed).`);
  }
  if (fbaReportKeysFrom(map).length !== keys.length) throw new Error("fba-dependent-reports: every declared report must be FBA-dependent (fail closed).");
}

assertFbaDependentReportsConsistency();
