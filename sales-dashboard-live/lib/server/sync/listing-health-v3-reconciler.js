// listing-health-v3 publication RECONCILER -- the Listings/Listings-Raw FAMILY WRAPPER over the shared saved-data
// reconciler core (saved-data-reconciler.js). It re-derives + promotes the Listings-dependent canonical live dashboard
// -- today EXACTLY "listing-health-v3" -- for accounts whose COMPLETE dependency manifest advanced past (or was never
// promoted to) their live snapshot, using ALREADY-SAVED durable Listings + Listings-Raw + OLI + Product Catalog +
// reuse-only FBA inventory. ZERO provider export.
//
// The reconciliation ENGINE (scope iteration, exact publication binding, typed classification, control lifecycle,
// deadline/abort/confirmed-settlement, honest outcome, per-account isolation, zero-export) is the SHARED core. This
// wrapper supplies ONLY the Listings-specific ADAPTER: a per-account COMPLETE dependency-bundle resolution
// (resolveBundle = resolveListingHealthV3DependencyBundle closure -- full pointer/payload integrity + the exact-evidence
// fingerprint) with PER-ACCOUNT isolation (a single account's unresolvable/unreadable bundle defers ONLY that account,
// never the healthy ones). The revision IS the bundle fingerprint, so the scan classifies staleness against the exact
// evidence the release re-derives from. No post-promotion hook: listing-health-v3 is not a Brand View membership source.
//
// DEPENDENCY-SAFE: imports ONLY the Listings leaf registry + the shared reconciler core. The bundle resolver (with its
// injected readers) is supplied by the entrypoint, which reaches no provider export transport. 7-bit ASCII, LF.

import { listingsDependentLiveReportKeys } from "./listing-health-v3-dependent-reports.js";
import { buildSavedDataReconciler, RECONCILE_STATUS } from "./saved-data-reconciler.js";

export const LISTING_HEALTH_V3_RECONCILE_STATUS = RECONCILE_STATUS;

/**
 * Build the listing-health-v3 publication reconciler. Listings-specific collaborator:
 *   resolveBundle({ accountId, requestedAsOf, signal }) -> { eligible, reason?, revisionId, deps, contentDeps, status }
 *       -- the SHARED resolveListingHealthV3DependencyBundle closure for this org/region. It reads + fully integrity-
 *          validates the two durable Listings pointers, resolves the reuse-only FBA inventory (proven-D-1 or a stable
 *          UNAVAILABLE identity), loads the durable OLI + Product Catalog, and returns the COMPLETE-manifest fingerprint
 *          as revisionId + the single manifest content-dep. A throw / not-eligible is a PER-ACCOUNT defer (LKG kept), it
 *          NEVER fails the whole run. The scan uses ONLY {eligible, revisionId, deps, contentDeps, status}; the release
 *          re-resolves the bundle itself (TOCTOU) to derive from the exact evidence.
 * Every other collaborator is passed straight through to the shared core.
 */
export function buildListingHealthV3PublicationReconciler({
  resolveOrg, bucketAccounts,
  resolveBundle,
  readLatestReportJob, readShadowSnapshot, readLiveSnapshot, loadStoragePayload, verifyLiveReadback,
  liveContracts, computeHash, reportDerivations, shadowKeyFor = (rk) => "scheduler-v2/" + rk,
  runReleaseForAccount,
  openControls = async () => ({ ok: true }), closeControls = async () => ({ ok: true }),
  outOfTime = () => false, deadlineRace = (p) => p,
  makeAbortController = () => new AbortController(),
  awaitSettled = async (p) => { try { await p; } catch { /* a rejection is a settlement -- the op stopped */ } return { settled: true }; },
  reportKeys = listingsDependentLiveReportKeys(),
  withTimeout = (p) => p, clock = () => new Date(), log = () => {},
} = {}) {
  if (typeof resolveBundle !== "function") throw new Error("buildListingHealthV3PublicationReconciler requires resolveBundle (fail closed).");
  const MISSING = (reason) => ({ eligible: false, status: "missing", revisionId: null, deps: [], contentDeps: [], reason });

  // The Listings ADAPTER. readScopeEvidence resolves the COMPLETE dependency bundle per account with PER-ACCOUNT
  // isolation: a per-account resolve error/timeout/not-eligible stores a MISSING revision (that account defers), and
  // never aborts the scope. computeAccountRevision returns the resolved revision unchanged (the fingerprint IS the
  // revisionId; the single manifest token is its contentDeps).
  const adapter = {
    async readScopeEvidence({ scope, requestedAsOf, withTimeout: wt }) {
      const timeout = typeof wt === "function" ? wt : withTimeout;
      const perAccount = new Map();
      for (const accountId of scope) {
        let revision;
        try {
          const res = await timeout(resolveBundle({ accountId, requestedAsOf }), "lhv3-bundle:" + accountId);
          revision = res && typeof res === "object"
            ? { eligible: res.eligible === true, status: res.status || "missing", revisionId: res.revisionId || null, deps: Array.isArray(res.deps) ? res.deps : [], contentDeps: Array.isArray(res.contentDeps) ? res.contentDeps : [], reason: res.reason || null }
            : MISSING("bundle-null");
        } catch (e) { revision = MISSING("bundle-resolve-threw:" + (e && e.message ? e.message : String(e))); }
        perAccount.set(accountId, { revision });
      }
      return { ok: true, perAccount };
    },
    computeAccountRevision({ evidence }) {
      return (evidence && evidence.revision) || MISSING("no-evidence");
    },
  };

  return buildSavedDataReconciler({
    resolveOrg, bucketAccounts, adapter,
    readLatestReportJob, readShadowSnapshot, readLiveSnapshot, loadStoragePayload, verifyLiveReadback,
    liveContracts, computeHash, reportDerivations, shadowKeyFor,
    runReleaseForAccount,
    postPromotionHook: null, membershipSourceReport: null, postPromotionSummaryKey: "listingHealthV3",
    revisionChangedReason: "listings-manifest-changed",
    reportKeys,
    openControls, closeControls,
    outOfTime, deadlineRace, makeAbortController, awaitSettled,
    withTimeout, clock, log,
  });
}
