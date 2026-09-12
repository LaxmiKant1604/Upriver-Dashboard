// listing-health-v3 publication RECONCILER -- the Listings/Listings-Raw FAMILY WRAPPER over the shared saved-data
// reconciler core (saved-data-reconciler.js). It re-derives + promotes the Listings-dependent canonical live dashboard
// -- today EXACTLY "listing-health-v3" -- for accounts whose durable Listings + Listings-Raw snapshots advanced past
// (or were never promoted to) their live snapshot, using ALREADY-SAVED durable Listings/Listings-Raw (WORK B) plus
// durable OLI + Product Catalog + reuse-only durable FBA inventory. ZERO provider export.
//
// The reconciliation ENGINE (scope iteration, exact publication binding, typed classification, control lifecycle,
// deadline/abort/confirmed-settlement, honest outcome, per-account isolation, zero-export) is the SHARED core. This
// wrapper supplies ONLY the Listings-specific ADAPTER: a per-account durable Listings + Listings-Raw read (per-account
// ISOLATED -- a single account's unreadable/absent/schema-missing pointer defers ONLY that account, never the healthy
// ones) + the deterministic Listings revision (listings-revision.js). No post-promotion hook: listing-health-v3 is not
// a Brand View membership source.
//
// DEPENDENCY-SAFE: imports ONLY the Listings leaf registry + the Listings revision module + the shared reconciler core.
// It has NO import path to a provider export transport or a token reservation; the production entrypoint's release reads
// only durable data (zero export, structurally). 7-bit ASCII, LF.

import { listingsDependentLiveReportKeys } from "./listing-health-v3-dependent-reports.js";
import { computeListingHealthV3AccountRevision } from "./listings-revision.js";
import { buildSavedDataReconciler, RECONCILE_STATUS } from "./saved-data-reconciler.js";

export const LISTING_HEALTH_V3_RECONCILE_STATUS = RECONCILE_STATUS;

/**
 * Build the listing-health-v3 publication reconciler. Listings-specific collaborators:
 *   readListingsSnapshot({ organizationFingerprint, connectionId, accountId }) -> { read, snapshot }
 *   readListingsRawSnapshot({ organizationFingerprint, connectionId, accountId }) -> { read, snapshot }
 *       -- the durable source_listings[_raw]_snapshot rows for (org, conn, account). read!='ok' or a throw is a
 *          PER-ACCOUNT defer (that account keeps its LKG); it NEVER fails the whole run (per-account isolation). D-1 is
 *          proven inside computeListingHealthV3AccountRevision by snapshot.as_of === requestedAsOf (no expected-hash
 *          recompute -- the Listings request hash is date-FREE, so the as-of column is the D-1 authority).
 * Every other collaborator is passed straight through to the shared core.
 */
export function buildListingHealthV3PublicationReconciler({
  resolveOrg, bucketAccounts,
  readListingsSnapshot, readListingsRawSnapshot,
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
  for (const [name, fn] of [["readListingsSnapshot", readListingsSnapshot], ["readListingsRawSnapshot", readListingsRawSnapshot]]) {
    if (typeof fn !== "function") throw new Error(`buildListingHealthV3PublicationReconciler requires ${name} (fail closed).`);
  }

  // The Listings ADAPTER. readScopeEvidence reads each account's durable Listings + Listings-Raw pointers with
  // PER-ACCOUNT isolation: a per-account read error/absence stores null evidence (that account defers), and never
  // aborts the scope. computeAccountRevision proves BOTH pointers are the requested-D-1 snapshot (listings-revision).
  const adapter = {
    async readScopeEvidence({ organizationFingerprint, connectionId, scope, withTimeout: wt }) {
      const timeout = typeof wt === "function" ? wt : withTimeout;
      const perAccount = new Map();
      for (const accountId of scope) {
        let listingsSnapshot = null;
        let listingsRawSnapshot = null;
        try {
          const res = await timeout(readListingsSnapshot({ organizationFingerprint, connectionId, accountId }), "listings-snapshot:" + accountId);
          listingsSnapshot = res && res.read === "ok" ? (res.snapshot || null) : null;
        } catch { listingsSnapshot = null; }
        try {
          const res = await timeout(readListingsRawSnapshot({ organizationFingerprint, connectionId, accountId }), "listings-raw-snapshot:" + accountId);
          listingsRawSnapshot = res && res.read === "ok" ? (res.snapshot || null) : null;
        } catch { listingsRawSnapshot = null; }
        perAccount.set(accountId, { listingsSnapshot, listingsRawSnapshot });
      }
      return { ok: true, perAccount };
    },
    computeAccountRevision({ organizationFingerprint, connectionId, accountId, requestedAsOf, evidence }) {
      return computeListingHealthV3AccountRevision({
        organizationFingerprint, connectionId, accountId, requestedAsOf,
        listingsSnapshot: evidence && evidence.listingsSnapshot,
        listingsRawSnapshot: evidence && evidence.listingsRawSnapshot,
      });
    },
  };

  return buildSavedDataReconciler({
    resolveOrg, bucketAccounts, adapter,
    readLatestReportJob, readShadowSnapshot, readLiveSnapshot, loadStoragePayload, verifyLiveReadback,
    liveContracts, computeHash, reportDerivations, shadowKeyFor,
    runReleaseForAccount,
    postPromotionHook: null, membershipSourceReport: null, postPromotionSummaryKey: "listingHealthV3",
    revisionChangedReason: "listings-revision-changed",
    reportKeys,
    openControls, closeControls,
    outOfTime, deadlineRace, makeAbortController, awaitSettled,
    withTimeout, clock, log,
  });
}
