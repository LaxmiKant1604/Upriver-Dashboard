// Campaign-Ads publication RECONCILER -- the Ads FAMILY WRAPPER over the shared saved-data reconciler core
// (saved-data-reconciler.js). It re-derives + promotes an Ads-dependent canonical live dashboard for accounts whose
// durable Campaign Ads content advanced past (or was same-date corrected relative to) their live snapshot, using
// ALREADY-SAVED durable Ads rows. ZERO provider export.
//
// REPORT-SPECIFIC (Codex blocker 5): this builds ONE SINGLE-REPORT reconciler operation. daily-reporting and
// ppc-performance are reconciled by SEPARATE operations, each with its own required Ads grains + coverage window, so a
// missing PPC-only grain never blocks daily and a targeting/search-terms-only correction never marks daily changed.
// The shared OLI/FBA core is unchanged (it already applies one revision per account across its reportKeys; here
// reportKeys is a single report). No post-promotion hook (the Campaign Ads workspace is durably-direct + never
// republished; brand-view is materialized elsewhere).
//
// NEVER suppresses valid OLI sales: an unavailable Ads grain defers ONLY this Ads report for that account. When the
// report is daily-reporting (shared with OLI), the release re-derives it from the FULL durable union (OLI + Catalog +
// Ads) through the same fenced publisher + content-CAS as the OLI reconciler, so concurrent OLI/Ads reconciliation
// converges on the newest valid content (the CAS's source_refreshed_at fence makes an older derive a no-op).
//
// DEPENDENCY-SAFE: imports ONLY the Ads leaf registry + the Ads revision module + the shared core -- no export transport
// path. 7-bit ASCII, LF.

import { adsGrainsForReport, adsRequiredCoverageDays, isAdsDependentLiveReport } from "./ads-dependent-reports.js";
import { computeAdsReportRevision, subUtcDaysStr } from "./ads-publication-revision.js";
import { buildSavedDataReconciler, RECONCILE_STATUS } from "./saved-data-reconciler.js";

export const ADS_RECONCILE_STATUS = RECONCILE_STATUS;

const S = (v) => (v == null ? "" : String(v));

/**
 * Build a SINGLE-REPORT Campaign-Ads publication reconciler for `reportKey` (daily-reporting or ppc-performance).
 * Ads-specific collaborators:
 *   readAdsCoverageState({ organizationFingerprint, connectionId, accountId, sourceKey, requestedAsOf })
 *       -> { windows:[{from,to}], contentRev, latestMetricDate, read }   (durable ads_sync_coverage + ads_sync_state via
 *          getDailyAdsCoverage). `sourceKey` is the REGISTRY grain (ads-campaign-date, ...); the reader MUST translate it
 *          to the durable WORKER key (adsWorkerKeyForGrain: campaign-performance-v1, ...) that those tables are keyed by
 *          before the read -- reading under the registry grain filters to zero rows, silently deferring every account.
 *          content_rev degrades fail-soft when migration 20260923's column is absent.
 *   resolveMarketplace(accountId) -> "<marketplace>"   ("" -> the account defers, never a blank-market token).
 * Every other collaborator is passed straight through to the shared core (byte-identical pattern to the OLI/FBA wrappers).
 */
export function buildAdsReportReconciler({
  reportKey,
  resolveOrg, bucketAccounts, readAdsCoverageState, resolveMarketplace = () => "",
  readLatestReportJob, readShadowSnapshot, readLiveSnapshot, loadStoragePayload, verifyLiveReadback,
  liveContracts, computeHash, reportDerivations, shadowKeyFor = (rk) => "scheduler-v2/" + rk,
  runReleaseForAccount,
  openControls = async () => ({ ok: true }), closeControls = async () => ({ ok: true }),
  outOfTime = () => false, deadlineRace = (p) => p,
  makeAbortController = () => new AbortController(),
  awaitSettled = async (p) => { try { await p; } catch { /* settled */ } return { settled: true }; },
  withTimeout = (p) => p, clock = () => new Date(), log = () => {},
} = {}) {
  if (!isAdsDependentLiveReport(reportKey)) throw new Error(`buildAdsReportReconciler: ${S(reportKey)} is not an Ads-dependent live report (fail closed).`);
  if (typeof readAdsCoverageState !== "function") throw new Error("buildAdsReportReconciler requires readAdsCoverageState (fail closed).");
  if (typeof resolveMarketplace !== "function") throw new Error("buildAdsReportReconciler requires resolveMarketplace (fail closed).");
  const requiredGrains = adsGrainsForReport(reportKey); // daily -> [campaign]; ppc -> [campaign, search, targeting]
  const requiredCoverageDays = adsRequiredCoverageDays(reportKey);
  if (requiredGrains.length === 0) throw new Error(`buildAdsReportReconciler: ${S(reportKey)} declares no Ads grains (fail closed).`);

  const adapter = {
    async readScopeEvidence({ organizationFingerprint, connectionId, scope, requestedAsOf, withTimeout: wt }) {
      const timeout = typeof wt === "function" ? wt : withTimeout;
      const perAccount = new Map();
      for (const accountId of scope) {
        const grains = {};
        for (const sourceKey of requiredGrains) { // ONLY this report's required grains (daily never reads targeting/search)
          let st;
          try { st = await timeout(readAdsCoverageState({ organizationFingerprint, connectionId, accountId, sourceKey, requestedAsOf }), "ads-coverage-state:" + sourceKey); }
          catch (e) { return { ok: false, failCode: "DURABLE_ADS_UNREADABLE: coverage-state " + S(sourceKey) + " " + S(e && e.message) }; }
          if (st && S(st.read) === "read-failed") return { ok: false, failCode: "DURABLE_ADS_UNREADABLE: coverage-state read-failed " + S(sourceKey) };
          grains[sourceKey] = {
            contentRev: st ? st.contentRev : null,
            latestMetricDate: st ? st.latestMetricDate : null,
            windows: st && Array.isArray(st.windows) ? st.windows : [],
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
      const requiredFrom = subUtcDaysStr(requestedAsOf, requiredCoverageDays - 1);
      return computeAdsReportRevision({
        organizationFingerprint, connectionId, accountId,
        marketplace: (evidence && evidence.marketplace) || "",
        requestedAsOf, requiredFrom, requiredGrains,
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
    reportKeys: [reportKey],
    openControls, closeControls,
    outOfTime, deadlineRace, makeAbortController, awaitSettled,
    withTimeout, clock, log,
  });
}
