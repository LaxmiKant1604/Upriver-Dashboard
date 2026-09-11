// Campaign-Ads publication RECONCILER -- the Ads FAMILY WRAPPER over the shared saved-data reconciler core
// (saved-data-reconciler.js). It re-derives + promotes the Ads-dependent canonical live dashboards (daily-reporting +
// ppc-performance) for accounts whose durable Campaign Ads content advanced past (or was same-date corrected relative
// to) their live snapshots, using ALREADY-SAVED durable Ads rows. ZERO provider export.
//
// The reconciliation ENGINE (scope iteration, exact publication binding, typed classification, control lifecycle,
// deadline/abort/confirmed-settlement, honest outcome, per-account isolation, zero-export) is the SHARED core. This
// wrapper supplies ONLY the Ads-specific ADAPTER: the durable Ads evidence read (per-account, per-grain coverage +
// content_rev, each fail-closed) and the deterministic Ads revision (computeAdsAccountRevision). No post-promotion hook
// (the Campaign Ads workspace is durably-direct and is NEVER republished; brand-view is materialized elsewhere).
//
// DEPENDENCY-SAFE: imports ONLY the Ads leaf registry + the Ads revision module + the shared reconciler core. It has NO
// import path to a DataDoe export transport or a token reservation; the production entrypoint forces the release's inner
// adapter to refuse creates (zero export, structurally). NEVER suppresses valid OLI sales: an unavailable Ads grain
// defers ONLY the Ads-dependent reports for THAT account and never touches OLI's own reconciliation. 7-bit ASCII, LF.

import { adsDependentLiveReportKeys, ADS_SOURCE_KEYS } from "./ads-dependent-reports.js";
import { computeAdsAccountRevision } from "./ads-publication-revision.js";
import { buildSavedDataReconciler, RECONCILE_STATUS } from "./saved-data-reconciler.js";

export const ADS_RECONCILE_STATUS = RECONCILE_STATUS;

const S = (v) => (v == null ? "" : String(v));

/**
 * Build the Campaign-Ads publication reconciler. Ads-specific collaborators:
 *   readAdsCoverageState({ organizationFingerprint, connectionId, accountId, sourceKey, requestedAsOf })
 *       -> { windows:[{from,to}], contentRev, latestMetricDate, read }   (durable ads_sync_coverage + ads_sync_state,
 *          exactly getAdsCoverageAndState; coveredThrough is derived here as the MAX covered_to. The reader degrades
 *          content_rev fail-soft when migration 20260923's column is absent. A reader may instead return coveredThrough
 *          directly.)
 *   resolveMarketplace(accountId) -> "<marketplace>"   (for cross-marketplace token isolation; "" when unknown)
 * Every other collaborator is passed straight through to the shared core (byte-identical pattern to the OLI/FBA wrappers).
 */
export function buildAdsPublicationReconciler({
  resolveOrg, bucketAccounts, readAdsCoverageState, resolveMarketplace = () => "",
  readLatestReportJob, readShadowSnapshot, readLiveSnapshot, loadStoragePayload, verifyLiveReadback,
  liveContracts, computeHash, reportDerivations, shadowKeyFor = (rk) => "scheduler-v2/" + rk,
  runReleaseForAccount,
  openControls = async () => ({ ok: true }), closeControls = async () => ({ ok: true }),
  outOfTime = () => false, deadlineRace = (p) => p,
  makeAbortController = () => new AbortController(),
  awaitSettled = async (p) => { try { await p; } catch { /* settled */ } return { settled: true }; },
  reportKeys = adsDependentLiveReportKeys(),
  withTimeout = (p) => p, clock = () => new Date(), log = () => {},
} = {}) {
  if (typeof readAdsCoverageState !== "function") throw new Error("buildAdsPublicationReconciler requires readAdsCoverageState (fail closed).");
  if (typeof resolveMarketplace !== "function") throw new Error("buildAdsPublicationReconciler requires resolveMarketplace (fail closed).");

  // The Ads ADAPTER: read the durable per-account, per-grain coverage + content_rev (timeout-bounded + fail-closed: a
  // durable read that THROWS defers the WHOLE run rather than publishing blind), then the deterministic Ads revision.
  const adapter = {
    async readScopeEvidence({ organizationFingerprint, connectionId, scope, requestedAsOf, withTimeout: wt }) {
      const timeout = typeof wt === "function" ? wt : withTimeout;
      const perAccount = new Map();
      for (const accountId of scope) {
        const grains = {};
        for (const sourceKey of ADS_SOURCE_KEYS) {
          let st;
          try { st = await timeout(readAdsCoverageState({ organizationFingerprint, connectionId, accountId, sourceKey, requestedAsOf }), "ads-coverage-state:" + sourceKey); }
          catch (e) { return { ok: false, failCode: "DURABLE_ADS_UNREADABLE: coverage-state " + S(sourceKey) + " " + S(e && e.message) }; }
          // A hard read failure (not schema-missing) fails the whole run closed; schema-missing/absent grain -> that grain
          // is simply not proven (the revision treats it as unavailable), never a fabricated zero.
          if (st && S(st.read) === "read-failed") return { ok: false, failCode: "DURABLE_ADS_UNREADABLE: coverage-state read-failed " + S(sourceKey) };
          grains[sourceKey] = {
            contentRev: st ? st.contentRev : null,
            latestMetricDate: st ? st.latestMetricDate : null,
            coveredThrough: st ? maxCoveredThrough(st) : null,
            read: st ? S(st.read) : "read-failed",
          };
        }
        let marketplace = "";
        try { marketplace = S(await resolveMarketplace(accountId)); } catch { marketplace = ""; }
        perAccount.set(accountId, { grains, marketplace });
      }
      return { ok: true, perAccount };
    },
    computeAccountRevision({ organizationFingerprint, connectionId, accountId, requestedAsOf, evidence }) {
      return computeAdsAccountRevision({
        organizationFingerprint, connectionId, accountId,
        marketplace: (evidence && evidence.marketplace) || "",
        requestedAsOf,
        grains: (evidence && evidence.grains) || {},
      });
    },
  };

  return buildSavedDataReconciler({
    resolveOrg, bucketAccounts, adapter,
    readLatestReportJob, readShadowSnapshot, readLiveSnapshot, loadStoragePayload, verifyLiveReadback,
    liveContracts, computeHash, reportDerivations, shadowKeyFor,
    runReleaseForAccount,
    revisionChangedReason: "ads-revision-changed",
    reportKeys,
    openControls, closeControls,
    outOfTime, deadlineRace, makeAbortController, awaitSettled,
    withTimeout, clock, log,
  });
}

// The MAX covered_to across the reader's coverage windows (the durable coverage the account proves through). Blank when
// there are no windows. getAdsCoverageAndState returns { windows:[{from,to}], ... }; a reader may instead pre-compute
// coveredThrough. NEVER falls back to latestMetricDate -- coverage must be PROVEN by a window, never inferred.
function maxCoveredThrough(st) {
  if (st && S(st.coveredThrough).trim() !== "") return S(st.coveredThrough).slice(0, 10);
  const windows = st && Array.isArray(st.windows) ? st.windows : [];
  let max = "";
  for (const w of windows) { const to = S(w && w.to).slice(0, 10); if (to && to > max) max = to; }
  return max;
}
