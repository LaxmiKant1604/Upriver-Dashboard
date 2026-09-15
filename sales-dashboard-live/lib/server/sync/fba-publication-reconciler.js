// FBA-inventory publication RECONCILER -- the FBA FAMILY WRAPPER over the shared saved-data reconciler core
// (saved-data-reconciler.js). It re-derives + promotes the FBA-dependent canonical live dashboard(s) for accounts
// whose durable FBA inventory advanced past (or was never promoted to) their live snapshots, using ALREADY-SAVED
// durable FBA inventory (public.source_snapshots). ZERO provider export.
//
// The reconciliation ENGINE (scope iteration, exact publication binding, typed classification, control lifecycle,
// deadline/abort/confirmed-settlement, honest outcome, per-account isolation, zero-export) is the SHARED core. This
// wrapper supplies ONLY the FBA-specific ADAPTER: a per-account durable FBA snapshot read (per-account ISOLATED -- a
// single account's unreadable/absent snapshot defers ONLY that account, never the healthy ones) + the deterministic
// FBA revision (fba-inventory-revision.js). No post-promotion hook: brand-inventory is not the Brand View membership
// source (that is brand-sales, the OLI reconciler's concern).
//
// DEPENDENCY-SAFE: imports ONLY the FBA leaf registry + the FBA revision module + the shared reconciler core. It has NO
// import path to a provider export transport or a token reservation; the production entrypoint forces the release's
// inner adapter to refuse creates (zero export, structurally). 7-bit ASCII, LF.

import { fbaDependentLiveReportKeys } from "./fba-dependent-reports.js";
import { computeFbaAccountRevision } from "./fba-inventory-revision.js";
import { buildSavedDataReconciler, RECONCILE_STATUS } from "./saved-data-reconciler.js";

export const FBA_RECONCILE_STATUS = RECONCILE_STATUS;

const S = (v) => (v == null ? "" : String(v));

/**
 * Build the FBA-inventory publication reconciler. FBA-specific collaborators:
 *   readFbaSnapshot({ organizationFingerprint, connectionId, accountId }) -> { read, snapshot }
 *       -- the durable source_snapshots row for (account, fba-inventory-health). read!='ok' or a throw is a PER-ACCOUNT
 *          defer (that account keeps its LKG); it NEVER fails the whole run (per-account isolation).
 *   resolveExpectedRequestHash({ accountId, requestedAsOf }) -> "<request hash>" | ""
 *       -- the recomputed resolvedFbaSnapshot({asOf:requestedAsOf}).requestHash for EXACTLY the D-1 single-day export
 *          (proves the durable snapshot IS the requested-D-1 snapshot). "" => cannot prove D-1 for this account (defer).
 * Every other collaborator is passed straight through to the shared core.
 */
export function buildFbaPublicationReconciler({
  resolveOrg, bucketAccounts,
  readFbaSnapshot, resolveExpectedRequestHash,
  readLatestReportJob, readShadowSnapshot, readLiveSnapshot, loadStoragePayload, verifyLiveReadback,
  liveContracts, computeHash, reportDerivations, shadowKeyFor = (rk) => "scheduler-v2/" + rk,
  runReleaseForAccount,
  openControls = async () => ({ ok: true }), closeControls = async () => ({ ok: true }),
  outOfTime = () => false, deadlineRace = (p) => p,
  makeAbortController = () => new AbortController(),
  awaitSettled = async (p) => { try { await p; } catch { /* a rejection is a settlement -- the op stopped */ } return { settled: true }; },
  reportKeys = fbaDependentLiveReportKeys(),
  withTimeout = (p) => p, clock = () => new Date(), log = () => {},
} = {}) {
  for (const [name, fn] of [["readFbaSnapshot", readFbaSnapshot], ["resolveExpectedRequestHash", resolveExpectedRequestHash]]) {
    if (typeof fn !== "function") throw new Error(`buildFbaPublicationReconciler requires ${name} (fail closed).`);
  }

  // The FBA ADAPTER. readScopeEvidence reads each account's durable FBA snapshot + recomputed D-1 request hash with
  // PER-ACCOUNT isolation: a per-account read error/absence stores null evidence (that account defers), and never
  // aborts the scope. computeAccountRevision proves the snapshot is the requested-D-1 snapshot (fba-inventory-revision).
  const adapter = {
    async readScopeEvidence({ organizationFingerprint, connectionId, scope, requestedAsOf, withTimeout: wt }) {
      const timeout = typeof wt === "function" ? wt : withTimeout;
      const perAccount = new Map();
      for (const accountId of scope) {
        let snapshot = null;
        let expectedRequestHash = "";
        try {
          const res = await timeout(readFbaSnapshot({ organizationFingerprint, connectionId, accountId }), "fba-snapshot:" + accountId);
          // read!='ok' (schema-missing / read-failed) -> treat as no durable snapshot for THIS account (defer, LKG kept).
          snapshot = res && res.read === "ok" ? (res.snapshot || null) : null;
        } catch { snapshot = null; }
        try { expectedRequestHash = S(await resolveExpectedRequestHash({ accountId, requestedAsOf })); } catch { expectedRequestHash = ""; }
        perAccount.set(accountId, { snapshot, expectedRequestHash });
      }
      return { ok: true, perAccount };
    },
    computeAccountRevision({ organizationFingerprint, connectionId, accountId, requestedAsOf, evidence }) {
      return computeFbaAccountRevision({
        organizationFingerprint, connectionId, accountId, requestedAsOf,
        snapshot: evidence && evidence.snapshot,
        expectedRequestHash: evidence && evidence.expectedRequestHash,
      });
    },
  };

  return buildSavedDataReconciler({
    resolveOrg, bucketAccounts, adapter,
    readLatestReportJob, readShadowSnapshot, readLiveSnapshot, loadStoragePayload, verifyLiveReadback,
    liveContracts, computeHash, reportDerivations, shadowKeyFor,
    runReleaseForAccount,
    postPromotionHook: null, membershipSourceReport: null, postPromotionSummaryKey: "brandView",
    revisionChangedReason: "fba-revision-changed",
    family: "fba",
    reportKeys,
    openControls, closeControls,
    outOfTime, deadlineRace, makeAbortController, awaitSettled,
    withTimeout, clock, log,
  });
}
