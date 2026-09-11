// OLI publication RECONCILER -- the OLI FAMILY WRAPPER over the shared saved-data reconciler core
// (saved-data-reconciler.js). It re-derives + promotes the OLI-dependent canonical live dashboards for accounts whose
// durable OLI advanced past (or was never promoted to) their live snapshots, using ALREADY-SAVED durable OLI.
//
// The reconciliation ENGINE (scope iteration, exact publication binding, typed classification, control lifecycle,
// deadline/abort/confirmed-settlement, honest outcome, per-account isolation, zero-export) is the SHARED core. This
// wrapper supplies ONLY the OLI-specific ADAPTER (durable OLI evidence read + the deterministic OLI revision) and the
// OLI post-promotion hook (Brand View membership), so OLI behavior is byte-identical to before the extraction.
//
// DEPENDENCY-SAFE: imports ONLY the OLI leaf registry + the OLI revision module + the shared reconciler core. It has NO
// import path to a DataDoe export transport or a token reservation; the production entrypoint forces the release's
// inner adapter to refuse creates (zero export, structurally). 7-bit ASCII, LF.

import { oliDependentLiveReportKeys, BRAND_VIEW_MEMBERSHIP_SOURCE_REPORT, OLI_SOURCE_KEY } from "./oli-dependent-reports.js";
import { computeOliAccountRevision } from "./oli-publication-revision.js";
import { buildSavedDataReconciler, RECONCILE_STATUS } from "./saved-data-reconciler.js";

// The OLI status vocabulary is the shared vocabulary (re-exported under its historical name so existing imports hold).
export const OLI_RECONCILE_STATUS = RECONCILE_STATUS;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const S = (v) => (v == null ? "" : String(v));

/**
 * Build the OLI publication reconciler. Signature + behavior are byte-identical to the pre-extraction version: the
 * OLI-specific readers (readPositiveHistory / readZeroRowProof / oliStart) + rebuildBrandViewMembership are the OLI
 * adapter + post-promotion hook; every other collaborator is passed straight through to the shared core.
 */
export function buildOliPublicationReconciler({
  resolveOrg, bucketAccounts, oliStart,
  readPositiveHistory, readZeroRowProof,
  readLatestReportJob, readShadowSnapshot, readLiveSnapshot, loadStoragePayload, verifyLiveReadback,
  liveContracts, computeHash, reportDerivations, shadowKeyFor = (rk) => "scheduler-v2/" + rk,
  runReleaseForAccount, rebuildBrandViewMembership,
  openControls = async () => ({ ok: true }), closeControls = async () => ({ ok: true }),
  outOfTime = () => false, deadlineRace = (p) => p,
  makeAbortController = () => new AbortController(),
  awaitSettled = async (p) => { try { await p; } catch { /* a rejection is a settlement -- the op stopped */ } return { settled: true }; },
  reportKeys = oliDependentLiveReportKeys(),
  withTimeout = (p) => p, clock = () => new Date(), log = () => {},
} = {}) {
  // OLI-specific fail-closed validation (the shared core validates the generic collaborators + the adapter).
  for (const [name, fn] of [["readPositiveHistory", readPositiveHistory], ["readZeroRowProof", readZeroRowProof], ["rebuildBrandViewMembership", rebuildBrandViewMembership]]) {
    if (typeof fn !== "function") throw new Error(`buildOliPublicationReconciler requires ${name} (fail closed).`);
  }
  if (!S(oliStart) || !DATE_RE.test(S(oliStart))) throw new Error("buildOliPublicationReconciler requires a valid oliStart (fail closed).");

  // The OLI ADAPTER: durable OLI evidence read (positive-sales provenance + the proven zero-row export chain), each
  // timeout-bounded + fail-closed (an unreadable reader defers the WHOLE run), and the deterministic OLI revision.
  const adapter = {
    async readScopeEvidence({ organizationFingerprint, connectionId, scope, requestedAsOf, withTimeout: wt }) {
      const timeout = typeof wt === "function" ? wt : withTimeout;
      let history;
      try { history = await timeout(readPositiveHistory({ organizationFingerprint, connectionId, accountIds: scope, from: oliStart, to: requestedAsOf }), "positive-history"); }
      catch (e) { return { ok: false, failCode: "DURABLE_OLI_UNREADABLE: positive-history " + S(e && e.message) }; }
      if (!Array.isArray(history)) return { ok: false, failCode: "DURABLE_OLI_UNREADABLE: positive-history non-array" };
      let zero;
      try { zero = await timeout(readZeroRowProof({ organizationFingerprint, connectionId, accountIds: scope, sourceKey: OLI_SOURCE_KEY }), "zero-row-proof"); }
      catch (e) { return { ok: false, failCode: "DURABLE_OLI_UNREADABLE: zero-row-proof " + S(e && e.message) }; }
      if (!zero || zero.read !== "ok" || !(zero.byAccount instanceof Map)) return { ok: false, failCode: "DURABLE_OLI_UNREADABLE: zero-row-proof read=" + S(zero && zero.read) };
      const positiveHashesByAccount = new Map();
      for (const r of history) {
        const aid = S(r.account_id ?? r.accountId); if (!aid) continue;
        const h = r.source_request_hash ?? r.sourceRequestHash;
        if (!positiveHashesByAccount.has(aid)) positiveHashesByAccount.set(aid, []);
        positiveHashesByAccount.get(aid).push(typeof h === "string" && h.trim() !== "" ? h : null);
      }
      const perAccount = new Map();
      for (const accountId of scope) {
        perAccount.set(accountId, { positiveHashes: positiveHashesByAccount.get(accountId) || [], zeroRowExports: zero.byAccount.get(accountId) || [] });
      }
      return { ok: true, perAccount };
    },
    computeAccountRevision({ organizationFingerprint, connectionId, accountId, requestedAsOf, evidence }) {
      return computeOliAccountRevision({
        organizationFingerprint, connectionId, accountId, oliStart, requestedAsOf,
        positiveHashes: (evidence && evidence.positiveHashes) || [],
        zeroRowExports: (evidence && evidence.zeroRowExports) || [],
      });
    },
  };

  return buildSavedDataReconciler({
    resolveOrg, bucketAccounts, adapter,
    readLatestReportJob, readShadowSnapshot, readLiveSnapshot, loadStoragePayload, verifyLiveReadback,
    liveContracts, computeHash, reportDerivations, shadowKeyFor,
    runReleaseForAccount,
    postPromotionHook: rebuildBrandViewMembership,
    membershipSourceReport: BRAND_VIEW_MEMBERSHIP_SOURCE_REPORT,
    postPromotionSummaryKey: "brandView",
    revisionChangedReason: "oli-revision-changed",
    reportKeys,
    openControls, closeControls,
    outOfTime, deadlineRace, makeAbortController, awaitSettled,
    withTimeout, clock, log,
  });
}
