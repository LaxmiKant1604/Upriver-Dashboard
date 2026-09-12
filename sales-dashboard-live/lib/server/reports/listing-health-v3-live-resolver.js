// STRICT serve-side resolver for the promoted live listing-health-v3 snapshot (WORK D correction, blocker 4). It
// REPLACES the weak getLatestReportSnapshotHydrated shortcut in api/datadoe.js. It proves the promoted row is the
// genuine, exact-D-1, storage-hydrated, contract-valid promotion for THIS account before the serve returns it; any
// failure returns { ok:false } so the serve falls through to the existing always-fresh preview (never blank / partial /
// fabricated / stale / cross-account live data).
//
// The reconciler promotes the live row at requestedAsOf = the workflow's inventory_asof = `date -u -d yesterday` (UTC
// D-1), and the publisher keys it params.to = requestedAsOf with paramsHash = paramsHashFor("listing-health-v3-shared-v1",
// {to: D-1}). So the serve computes the SAME UTC-yesterday D-1 (expectedListingHealthV3LiveAsOf, identical to
// api/datadoe.js planInventoryDay) and looks the row up by that EXACT params_hash -- never the client's `to` (today,
// which would always miss) and never a latest-pointer (which could serve a D-2/stale/wrong-window row). The full proof
// chain (exact identity + version + params provenance + storage-first hydration + validatePayload + not dataUnavailable)
// is the SHARED buildLivePromotedResolver, the same body the reconciler read-back uses. ZERO writes, ZERO exports.

import { getReportSnapshot, getReportSnapshotStoragePayload } from "../supabase.js";
import { SCHEDULER_LIVE_SNAPSHOT_CONTRACTS } from "../sync/report-publisher.js";
import { REPORT_DERIVATIONS } from "../sync/report-derivation.js";
import { paramsHashFor } from "../report-store.js";
import { buildLivePromotedResolver } from "../sync/live-promoted-resolver.js";

const LIVE_REPORT_KEY = "listing-health-v3";

// The single canonical previous UTC day (D-1) -- IDENTICAL to api/datadoe.js planInventoryDay and to the reconcile
// workflow's `date -u -d yesterday` inventory_asof, so the serve looks up the exact date the reconciler promoted.
export function expectedListingHealthV3LiveAsOf(now = Date.now()) {
  return new Date(now - 86400000).toISOString().slice(0, 10);
}

// The strict resolver core, with every reader injected (production defaults below; tests pass doubles).
export function buildListingHealthV3LiveResolver({
  getReportSnapshot: getSnap = getReportSnapshot,
  loadStoragePayload = getReportSnapshotStoragePayload,
  liveContracts = SCHEDULER_LIVE_SNAPSHOT_CONTRACTS,
  reportDerivations = REPORT_DERIVATIONS,
  computeHash = paramsHashFor,
  now = () => Date.now(),
} = {}) {
  const resolve = buildLivePromotedResolver({ getReportSnapshot: getSnap, loadStoragePayload, liveContracts, reportDerivations, computeHash });
  const contract = liveContracts[LIVE_REPORT_KEY];
  return async ({ accountId, signal = null } = {}) => {
    if (!contract) return { ok: false, reason: "no-live-contract" };
    const acct = accountId == null ? "" : String(accountId);
    if (acct.trim() === "") return { ok: false, reason: "blank-account" };
    const expectedD1 = expectedListingHealthV3LiveAsOf(now());
    const liveParams = contract.liveParams({ to: expectedD1 }); // { to: expectedD1 } iff a real calendar date
    if (!liveParams) return { ok: false, reason: "bad-expected-d1" };
    const paramsHash = computeHash(contract.liveReportVersion, liveParams);
    // The shared proof body enforces exact-identity + version + params provenance (which proves params.to === the
    // expected D-1, since a different `to` yields a different paramsHash and fails identity-hash) + storage-first
    // hydration + validatePayload + not-dataUnavailable. Returns the hydrated payload on ok.
    return resolve({ reportKey: LIVE_REPORT_KEY, liveReportKey: contract.liveReportKey, accountId: acct, paramsHash, signal });
  };
}

// Production singleton (real Supabase readers).
const defaultResolver = buildListingHealthV3LiveResolver();

// Serve-facing entry: resolve the promoted live listing-health-v3 payload for `accountId`, or { ok:false } to fall
// through to the preview. `signal` threads through the row read + storage hydration.
export function resolveListingHealthV3LivePromoted({ accountId, signal = null } = {}) {
  return defaultResolver({ accountId, signal });
}
