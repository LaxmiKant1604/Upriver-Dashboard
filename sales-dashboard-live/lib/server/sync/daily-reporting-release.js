// DEDICATED daily-reporting-ONLY release composition. The Campaign-Ads reconciler's per-account executor uses THIS
// instead of buildPriorityDashboardsRelease (the TRIO -- daily-reporting + brand-sales + brand-inventory -- whose save
// loop writes/publishes all three). This composition RE-DERIVES + PUBLISHES ONLY daily-reporting for ONE account over
// ONE dedicated priority-partial cycle and NEVER derives, saves, publishes, or mutates Brand Sales or Brand Inventory.
// It is the exact daily analogue of fba-brand-inventory-release.js (which scopes the FBA reconciler to brand-inventory).
//
// BYTE-IDENTITY: it reproduces the hot path's daily derive EXACTLY (source-bucket-sync-runtime.js + durable-dashboards.js
//   deriveDurableDashboardSnapshots):
//   1. read durable OLI history over the WIDE OLI backfill window (provenance-complete), the org Product Catalog
//      snapshot + rows, the ACTIVE Campaign Ads metric rows + coverage/content_rev -- ALL zero-export;
//   2. prove EXACT D-1 (resolveEffectivePublishAsOf must land exactly on requestedAsOf; an unsettled tail/interior gap
//      DEFERS -- never publishes D-2 labelled D-1);
//   3. ENRICH the history with ordered-units + estimate-included Total Sales (enrichOrderedOliHistory, READ-ONLY: it
//      reads the ALREADY-MATERIALIZED estimates the scheduler/OLI path wrote -- this release NEVER recomputes/writes
//      estimates; that stays the OLI/scheduler's job) so daily's sales are byte-identical to the live snapshot;
//   4. derive via the ONE canonical REPORT_DERIVATIONS["daily-reporting"].derive over the 5-month daily window;
//   5. save ONE validated daily shadow with the EXACT hot-path lineage -- depends_on = catalog hash union the OLI
//      lineage provenance (resolveOliLineageProvenance, so the OLI reconciler still sees daily covered) +
//      durable_content_deps = the Campaign Ads content token (adsContentProvenanceToken, so the Ads reconciler converges
//      and a same-date Ads correction is provably NOT covered);
//   6. finalize ONLY this dedicated cycle (finalize_sync_cycle DIRECTLY, never the trio finalizeBucket);
//   7. preflight + publish + canonical read-back ONLY daily-reporting through the reviewed FENCED publisher + CAS +
//      buildLiveReadback.
//
// TERMINATION BOUNDARY: the caller's AbortSignal threads into every supported read/write, abort is rechecked after every
// awaited phase AND immediately before every write, and the fenced live CAS is the final defense (aborted -> null fence
// -> zero rows). Once abort is observed, NO additional write starts; an issued remote write is NEVER claimed undone.
//
// source_refreshed_at is the owning per-revision cycle's created_at (NOT evidence-derived) -- so a same-date Ads
// correction (new content_rev -> new revisionId -> new priority-partial cycle -> strictly-newer created_at) makes the
// fenced content-CAS REPLACE the older live daily, exactly like the OLI/FBA reconcilers.
//
// Every side effect is an INJECTED collaborator (offline-testable). Imports NO provider export transport -- daily reads
// only durable data + writes only the fenced daily-reporting CAS -> zero export, STRUCTURALLY. The returned per-account
// result is the SAME typed shape the release runner returns, so the shared reconciler's statusFromRelease classifies it
// unchanged. 7-bit ASCII, LF.

import { slicedOliSourceFromHistory } from "./durable-dashboards.js";
import { buildDailyAdsCoverage } from "./daily-ads-loader.js";
import { enrichOrderedOliHistory } from "./oli-enriched-history.js";
import { resolveUniqueMarketplaceByAccount, authoritativeMarketplace } from "./oli-sales-estimate.js";
import {
  resolveOliLineageProvenance, OLI_LINEAGE_STATUS, resolveEffectivePublishAsOf, oliBackfillWindow,
  OLI_SOURCE_KEY, CATALOG_SOURCE_KEY, ORGANIZATION_SCOPE_KEY,
} from "./source-durable-model.js";
import { adsContentProvenanceToken } from "./ads-publication-revision.js";
import { ADS_CAMPAIGN_SOURCE_KEY } from "./ads-dependent-reports.js";
import { ACTIVE_ADS_SOURCE_KEY, CAMPAIGN_ADS_SOURCE_KEY } from "../active-ads-source.js";
import { monthBackStr } from "../date-windows.js";

const S = (v) => (v == null ? "" : String(v));
const nb = (v) => S(v).trim() !== "";
const DAILY_REPORT_KEY = "daily-reporting";
const DAILY_WINDOW_MONTHS = 5; // dailyWindow = [monthBackStr(asOf, 5) .. asOf], byte-identical to runtime :982

const ok = () => ({ code: 0, ok: true, stage: "complete", status: null, leaseLost: false, reason: null, blockerCodes: [], problems: [] });
// A retryable DEFERRAL (source/attribution not yet available; LKG preserved). stage:'reconcile' is a RETRYABLE_STAGE in
// the shared statusFromRelease, so it classifies as DEFERRED_DEPENDENCY regardless of the (diagnostic) reason.
const defer = (reason, status = "SOURCE_UNAVAILABLE") => ({ code: 1, ok: false, stage: "reconcile", status, leaseLost: false, reason, blockerCodes: [], problems: [reason] });
const DEADLINE = () => defer("deadline-aborted", "DEADLINE_ABORTED");
const contention = (reason) => ({ code: 1, ok: false, stage: "contention", status: "CONTROL_LEASE_LOST", leaseLost: true, reason, blockerCodes: [], problems: [reason] });
// A HARD, non-retryable failure (integrity / publish / readback). stage NOT in RETRYABLE_STAGES -> FAILED_* + non-green.
const hardFail = (stage, reason) => ({ code: 1, ok: false, stage, status: null, leaseLost: false, reason, blockerCodes: stage.startsWith("derive") ? ["derive:" + reason] : [], problems: [reason] });

/**
 * Build the dedicated daily-reporting release. Injected collaborators (production wired by the entrypoint); every
 * read/write that supports it receives { signal }.
 *   resolveOrg() -> { organizationFingerprint, connectionId }
 *   resolveAccountMeta(accountId) -> { rawSellerId, currency, marketplace }   (directory-authoritative; marketplace = the
 *       account's canonical country used for the Ads content token; blank rawSellerId -> defer)
 *   openCycle({ bucket, cycleDate, trigger }, { signal }) ; getCycleByBucketDate(bucket, cycleDate, { signal }) -> cycleRow
 *   finalizeCycle({ cycleId }, { signal })
 *   readOliHistory({ organizationFingerprint, connectionId, accountIds, from, to, signal }) -> [rows]  (carry source_request_hash)
 *   readOliCoverage({ organizationFingerprint, connectionId, accountId, sourceKey, signal }) -> { read, windows }
 *   readOliZeroProof({ organizationFingerprint, connectionId, accountIds, sourceKey, signal }) -> { read, byAccount:Map }
 *   readCatalogSnapshot({ organizationFingerprint, connectionId, sourceKey, scopeKey, signal }) -> { read, snapshot }
 *   loadCatalogPayload(objectPath, { signal }) -> { rows } | rows
 *   readActiveAdsRows(accountId, from, to, { signal }) -> [metricRows]  (throws w/ code ADS_ROW_LIMIT_EXCEEDED on cap)
 *   readAdsCoverage(accountId, workerKey, { signal }) -> { read, windows, status, latestMetricDate, contentRev }
 *   readOperationalUnits / readEstimates / readSkuAsinResolution  (enrichOrderedOliHistory READ collaborators; defaults ok)
 *   upsertReportJob(job, { signal }) / claimLease(cycleId, reportKey, accountId, { leaseSeconds, signal })
 *   saveShadow(args, { signal }) / reconcileSuccess(args, { signal })
 *   publisher { preflight(reportKey, accountId), publish(reportKey, accountId) }  (buildSchedulerV2Publisher, fenced)
 *   readbackLive({ reportKey, liveReportKey, accountId, paramsHash }) -> { ok, reason? }
 *   computeHash(reportVersion, params) ; liveContracts ; reportDerivations ; verifyLease() ; snapshotBytes(payload) ; leaseSeconds ; log
 */
export function buildDailyReportingRelease({
  resolveOrg, resolveAccountMeta,
  openCycle, getCycleByBucketDate, finalizeCycle,
  readOliHistory, readOliCoverage, readOliZeroProof, readCatalogSnapshot, loadCatalogPayload,
  readActiveAdsRows, readAdsCoverage,
  readOperationalUnits, readEstimates, readSkuAsinResolution,
  upsertReportJob, claimLease, saveShadow, reconcileSuccess,
  publisher, readbackLive,
  computeHash, liveContracts, reportDerivations, shadowKeyFor = (rk) => "scheduler-v2/" + rk,
  verifyLease = async () => ({ ok: true }),
  snapshotBytes = (p) => Buffer.byteLength(JSON.stringify(p == null ? null : p), "utf8"),
  leaseSeconds = 300,
  log = () => {},
} = {}) {
  for (const [name, fn] of [["resolveOrg", resolveOrg], ["resolveAccountMeta", resolveAccountMeta], ["openCycle", openCycle], ["getCycleByBucketDate", getCycleByBucketDate], ["finalizeCycle", finalizeCycle], ["readOliHistory", readOliHistory], ["readOliCoverage", readOliCoverage], ["readOliZeroProof", readOliZeroProof], ["readCatalogSnapshot", readCatalogSnapshot], ["loadCatalogPayload", loadCatalogPayload], ["readActiveAdsRows", readActiveAdsRows], ["readAdsCoverage", readAdsCoverage], ["upsertReportJob", upsertReportJob], ["claimLease", claimLease], ["saveShadow", saveShadow], ["reconcileSuccess", reconcileSuccess], ["computeHash", computeHash], ["readbackLive", readbackLive]]) {
    if (typeof fn !== "function") throw new Error(`buildDailyReportingRelease requires ${name} (fail closed).`);
  }
  if (!liveContracts || !reportDerivations) throw new Error("buildDailyReportingRelease requires liveContracts + reportDerivations (fail closed).");
  if (!publisher || typeof publisher.preflight !== "function" || typeof publisher.publish !== "function") throw new Error("buildDailyReportingRelease requires a publisher with preflight + publish (fail closed).");
  const dailyEntry = reportDerivations[DAILY_REPORT_KEY];
  if (!dailyEntry || typeof dailyEntry.derive !== "function" || typeof dailyEntry.validatePayload !== "function") throw new Error("buildDailyReportingRelease requires reportDerivations['daily-reporting'] with derive + validatePayload (fail closed).");
  const SHADOW = shadowKeyFor(DAILY_REPORT_KEY);

  async function runForAccount({ accountId, requestedAsOf, cycleBucket, signal }) {
    const aborted = () => !!(signal && signal.aborted);
    const opt = { signal };
    if (aborted()) return DEADLINE();
    if (!nb(accountId) || !/^\d{4}-\d{2}-\d{2}$/.test(S(requestedAsOf)) || !nb(cycleBucket)) return hardFail("derive", "bad-args");

    const org = await resolveOrg();
    if (aborted()) return DEADLINE();
    const organizationFingerprint = S(org && org.organizationFingerprint);
    const connectionId = S(org && org.connectionId) || "primary";
    if (!organizationFingerprint) return defer("org-unreadable");
    let meta;
    try { meta = await resolveAccountMeta(accountId); } catch (e) { return defer("account-meta-threw:" + S(e && e.message)); }
    if (aborted()) return DEADLINE();
    const rawSellerId = S(meta && meta.rawSellerId);
    const currency = meta && meta.currency != null ? meta.currency : null;
    const marketplace = S(meta && meta.marketplace);
    if (!nb(rawSellerId)) return defer("account-meta-unresolved");

    // Windows: OLI history/provenance over the WIDE backfill window; the daily payload window is the trailing 5 months.
    const brandViewWindow = oliBackfillWindow(requestedAsOf);
    if (!brandViewWindow || !nb(S(brandViewWindow.from))) return defer("oli-window-unresolved");
    const dailyFrom = monthBackStr(requestedAsOf, DAILY_WINDOW_MONTHS);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(S(dailyFrom))) return hardFail("derive", "daily-window-unresolved");

    // (1) Durable evidence -- ALL zero-export reads; abort-check after each.
    let historyRows;
    try { historyRows = await readOliHistory({ organizationFingerprint, connectionId, accountIds: [accountId], from: brandViewWindow.from, to: requestedAsOf, signal }); }
    catch (e) { return defer("oli-history-read-threw:" + S(e && e.message)); }
    if (aborted()) return DEADLINE();
    if (!Array.isArray(historyRows)) return defer("oli-history-unavailable");

    let oliWindows = [];
    try { const cov = await readOliCoverage({ organizationFingerprint, connectionId, accountId, sourceKey: OLI_SOURCE_KEY, signal }); oliWindows = cov && S(cov.read) === "ok" && Array.isArray(cov.windows) ? cov.windows : []; }
    catch (e) { return defer("oli-coverage-read-threw:" + S(e && e.message)); }
    if (aborted()) return DEADLINE();

    let catalogSnapshot = null;
    try { const cr = await readCatalogSnapshot({ organizationFingerprint, connectionId, sourceKey: CATALOG_SOURCE_KEY, scopeKey: ORGANIZATION_SCOPE_KEY, signal }); catalogSnapshot = cr && S(cr.read) === "ok" ? (cr.snapshot || null) : null; }
    catch (e) { return defer("catalog-snapshot-read-threw:" + S(e && e.message)); }
    if (aborted()) return DEADLINE();
    if (!catalogSnapshot || !nb(S(catalogSnapshot.object_path ?? catalogSnapshot.objectPath)) || !nb(S(catalogSnapshot.validated_at ?? catalogSnapshot.validatedAt))) return defer("no-catalog-snapshot");
    const catalogRequestHash = S(catalogSnapshot.source_request_hash ?? catalogSnapshot.sourceRequestHash);
    if (!nb(catalogRequestHash)) return defer("catalog-hash-unresolved");
    let catalogRows;
    try { const p = await loadCatalogPayload(S(catalogSnapshot.object_path ?? catalogSnapshot.objectPath), opt); catalogRows = Array.isArray(p) ? p : (p && Array.isArray(p.rows) ? p.rows : null); }
    catch (e) { return defer("catalog-payload-unreadable:" + S(e && e.message)); }
    if (aborted()) return DEADLINE();
    if (!Array.isArray(catalogRows)) return defer("catalog-rows-unavailable");

    // ONE Ads coverage read reused for BOTH the derive coverage AND the content token (worker key, not the registry grain).
    let adsCov = null;
    try { adsCov = await readAdsCoverage(accountId, CAMPAIGN_ADS_SOURCE_KEY, opt); }
    catch (e) { adsCov = { windows: [], status: "missing", latestMetricDate: null, contentRev: null, read: "read-failed", error: "COVERAGE_READ_FAILED" }; }
    if (aborted()) return DEADLINE();

    // Active Campaign Ads metric rows WITH their typed read state (byte-identical to runtime :949-958): a failed/limited
    // read is NEVER flattened to []+"ok" -- metricsRead travels into buildDailyAdsCoverage so Daily never reports a false
    // zero-Ads result. Ads never blocks the sales snapshot.
    let adRows = [];
    let metricsRead = "read-failed";
    try { const rows = await readActiveAdsRows(accountId, dailyFrom, requestedAsOf, opt); adRows = Array.isArray(rows) ? rows : []; metricsRead = Array.isArray(rows) ? "ok" : "read-failed"; }
    catch (e) { adRows = []; metricsRead = e && e.code === "ADS_ROW_LIMIT_EXCEEDED" ? "limit-exceeded" : "read-failed"; }
    if (aborted()) return DEADLINE();

    // (2) EXACT D-1 proof (byte-identical to runtime :972-982): the account must prove gapless durable OLI coverage
    // through EXACTLY requestedAsOf. A tail lag / interior gap clamps the effective as-of below requestedAsOf -> DEFER
    // (never publish a clamped D-2 window labelled D-1; do NOT reuse rederiveDailyV2's clampToProven).
    const eff = resolveEffectivePublishAsOf({ coverageByAccountId: { [accountId]: oliWindows }, accountIds: [accountId], from: brandViewWindow.from, refreshAsOf: requestedAsOf });
    if (S(eff && eff.effectiveAsOf) !== S(requestedAsOf)) return defer("daily-not-d1", "SOURCE_READINESS_PENDING");

    // (3) ENRICH history (READ-ONLY: ordered units + estimate-included Total Sales from the ALREADY-MATERIALIZED
    // estimates -- this release NEVER recomputes/writes estimates). Additive + non-fatal, byte-identical to runtime
    // :1000-1035 minus the recompute write: on ANY failure historyRows stays the priced rows (Total Sales never regressed).
    try {
      // marketplaceByAccount is Map<accountId, marketplaceString> (the UNIQUELY-proven canonical marketplace, or "" fail
      // closed) -- BYTE-IDENTICAL to runtime :1000-1024 (resolveUniqueMarketplaceByAccount + authoritativeMarketplace).
      // Passing the resolution map's OBJECT value instead would coerce to "[object Object]" and, for a blank/ambiguous
      // marketplace account, over-resolve the blank-ASIN overlay grains the hot path leaves unresolved (a divergence).
      const marketplaceResolution = resolveUniqueMarketplaceByAccount([{ accountId, country: marketplace }]);
      const marketplaceByAccount = new Map([[String(accountId), authoritativeMarketplace(marketplaceResolution, accountId)]]);
      const enriched = await enrichOrderedOliHistory({
        organizationFingerprint, connectionId, accountIds: [accountId], from: brandViewWindow.from, to: requestedAsOf,
        historyRows, marketplaceByAccount, signal,
        ...(typeof readOperationalUnits === "function" ? { readOperationalUnits } : {}),
        ...(typeof readEstimates === "function" ? { readEstimates } : {}),
        ...(typeof readSkuAsinResolution === "function" ? { readSkuAsinResolution } : {}),
      });
      if (Array.isArray(enriched)) historyRows = enriched;
    } catch { /* additive: keep the priced Total Sales + LKG */ }
    if (aborted()) return DEADLINE();

    // (4) DERIVE daily-reporting ONLY via the ONE canonical adapter (byte-identical to durable-dashboards.js :350-370).
    const source = slicedOliSourceFromHistory({ historyRows, accountId, rawSellerId, from: dailyFrom, to: requestedAsOf });
    const adsCoverage = buildDailyAdsCoverage({
      accountId, rawSellerId, currency, from: dailyFrom, to: requestedAsOf,
      metricRows: metricsRead === "ok" ? adRows : [], metricsRead,
      coverageState: adsCov || { windows: [], status: "missing", latestMetricDate: null, read: "read-failed", error: "COVERAGE_READ_FAILED" },
    });
    let payload;
    try {
      payload = dailyEntry.derive({
        sources: { "daily-reporting:oli-sales": source, "daily-reporting:catalog": { rows: catalogRows } },
        context: { from: dailyFrom, to: requestedAsOf, brand: "ALL", accountId, rawSellerId, currency: currency ?? null, adsCoverage },
      });
    } catch (e) { return defer("daily-derive-refused:" + S(e && (e.deriveStatus || e.message))); }
    if (aborted()) return DEADLINE();
    if (!dailyEntry.validatePayload(payload)) return hardFail("derive", "daily-payload-malformed");

    // (5) Identity + lineage. depends_on = catalog hash UNION the OLI lineage provenance (byte-identical to the runtime
    // dependsOnFor + computeOliAccountRevision, so the OLI reconciler still classifies daily covered). durable_content_deps
    // = the Campaign Ads content token (matches the hot-derive binding + the reconciler's revision.contentDeps).
    const shadowVersion = S(dailyEntry.snapshotVersion);
    const params = { reportVersion: shadowVersion, accountId, from: dailyFrom, to: requestedAsOf, brand: "ALL" };
    const paramsHash = computeHash(shadowVersion, params);

    const provHashes = new Set();
    for (const r of historyRows || []) { const h = r && (r.source_request_hash ?? r.sourceRequestHash); provHashes.add(typeof h === "string" && h.trim() !== "" ? h : null); }
    let zeroRowExports = [];
    if (![...provHashes].some((h) => h)) {
      try { const proof = await readOliZeroProof({ organizationFingerprint, connectionId, accountIds: [accountId], sourceKey: OLI_SOURCE_KEY, signal }); zeroRowExports = proof && S(proof.read) === "ok" && proof.byAccount instanceof Map ? (proof.byAccount.get(String(accountId)) || []) : []; }
      catch { zeroRowExports = []; }
      if (aborted()) return DEADLINE();
    }
    const oli = resolveOliLineageProvenance({ historyProvenanceHashes: [...provHashes], zeroRowExports, oliStart: brandViewWindow.from, requestedAsOf });
    if (!oli || oli.status === OLI_LINEAGE_STATUS.MISSING) return defer("durable-oli-provenance-missing", "SOURCE_READINESS_PENDING");
    const dependsOn = [...new Set([catalogRequestHash, ...(oli.deps || [])])].sort();

    let durableContentDeps = [];
    const contentRev = adsCov && S(adsCov.read) === "ok" ? adsCov.contentRev : null;
    if (ACTIVE_ADS_SOURCE_KEY === CAMPAIGN_ADS_SOURCE_KEY && nb(contentRev) && nb(marketplace)) {
      durableContentDeps = [adsContentProvenanceToken({ accountId, connectionId: "primary", marketplace, grainRevs: [{ sourceKey: ADS_CAMPAIGN_SOURCE_KEY, contentRev }] })];
    }

    // (6) open the dedicated cycle (WRITE) -- abort-check immediately before every write from here on.
    if (aborted()) return DEADLINE();
    try { await openCycle({ bucket: cycleBucket, cycleDate: requestedAsOf, trigger: "manual" }, opt); }
    catch (e) { return defer("cycle-open-threw:" + S(e && e.message)); }
    if (aborted()) return DEADLINE();
    let cycle;
    try { cycle = await getCycleByBucketDate(cycleBucket, requestedAsOf, opt); }
    catch (e) { return defer("cycle-read-threw:" + S(e && e.message)); }
    if (aborted()) return DEADLINE();
    if (!cycle || !nb(S(cycle.id))) return defer("cycle-unresolved");
    const cycleId = S(cycle.id);
    const sourceRefreshedAt = nb(S(cycle.created_at ?? cycle.createdAt)) ? S(cycle.created_at ?? cycle.createdAt) : null;
    if (!nb(sourceRefreshedAt)) return defer("cycle-refresh-blank");

    if (aborted()) return DEADLINE();
    try {
      await upsertReportJob({
        cycleId, reportKey: DAILY_REPORT_KEY, reportVersion: shadowVersion,
        accountId, connectionId: "primary", bucket: cycleBucket,
        dependsOn, durableContentDeps,
      }, opt);
    } catch (e) { return hardFail("derive", "lineage-upsert-threw:" + S(e && e.message)); }

    if (aborted()) return DEADLINE();
    let lease;
    try { lease = await claimLease(cycleId, DAILY_REPORT_KEY, accountId, { leaseSeconds, signal }); }
    catch (e) { return defer("claim-threw:" + S(e && e.message)); }
    if (aborted()) return DEADLINE();
    const disp = lease && lease.disposition;
    if (disp === "already-complete") {
      if (S(lease.snapshotParamsHash) !== S(paramsHash)) return hardFail("derive", "already-complete-hash-mismatch");
    } else if (disp === "held") {
      return defer("claim-held", "SOURCE_READINESS_PENDING");
    } else if ((disp !== "claimed" && disp !== "reclaimed") || !nb(lease.leaseToken)) {
      return hardFail("derive", "claim-" + S(disp || "malformed"));
    }
    if (disp === "claimed" || disp === "reclaimed") {
      if (aborted()) return DEADLINE();
      let cas;
      try { cas = await saveShadow({ reportKey: SHADOW, accountId, paramsHash, params, payload, payloadBytes: snapshotBytes(payload), sourceRefreshedAt }, opt); }
      catch (e) { return hardFail("derive", "shadow-cas-threw:" + S(e && e.message)); }
      if (aborted()) return DEADLINE();
      const outcome = cas && cas.outcome;
      if (outcome === "newer-live") return defer("shadow-newer-live");
      if (outcome !== "inserted" && outcome !== "replaced" && outcome !== "already-current") return hardFail("derive", "shadow-conflict:" + S(outcome));
      if (aborted()) return DEADLINE();
      let rec;
      try { rec = await reconcileSuccess({ cycleId, reportKey: DAILY_REPORT_KEY, accountId, snapshotParamsHash: paramsHash, leaseToken: lease.leaseToken, latestDataDate: dailyEntry.latestDataDate(payload) }, opt); }
      catch (e) { return hardFail("derive", "reconcile-threw:" + S(e && e.message)); }
      if (aborted()) return DEADLINE();
      const rdisp = rec && rec.disposition;
      if (rdisp !== "reconciled" && rdisp !== "already-complete") return hardFail("derive", "reconcile-" + S(rdisp || "malformed"));
    }

    // (6b) finalize ONLY this dedicated cycle (directly; never the trio finalizeBucket).
    if (aborted()) return DEADLINE();
    let fin;
    try { fin = await finalizeCycle({ cycleId }, opt); }
    catch (e) { return hardFail("finalize", "finalize-threw:" + S(e && e.message)); }
    if (aborted()) return DEADLINE();
    const fdisp = fin && fin.disposition;
    if (fdisp !== "finalized" && fdisp !== "already-terminal") return hardFail("finalize", "finalize-" + S(fdisp || "malformed"));

    // (7) preflight + publish + read back ONLY daily-reporting (reviewed fenced publisher + CAS + buildLiveReadback).
    if (aborted()) return DEADLINE();
    let pf;
    try { pf = await publisher.preflight(DAILY_REPORT_KEY, accountId); }
    catch (e) { return hardFail("publish-gates", "preflight-threw:" + S(e && e.message)); }
    if (aborted()) return DEADLINE();
    if (!pf || S(pf.disposition) !== "ready") {
      if (pf && S(pf.disposition) === "lease-lost") return contention("preflight-lease-lost");
      return hardFail("publish-gates", "preflight-" + S(pf && pf.disposition));
    }
    let fence;
    try { fence = await verifyLease(); } catch (e) { fence = { ok: false, reason: "renew-threw:" + S(e && e.message) }; }
    if (!fence || fence.ok !== true) return contention("lease-lost-before-publish:" + S(fence && fence.reason));
    // Immediately BEFORE the live write: if aborted, do NOT start the publish. The fenced CAS is the final defense --
    // an aborted op's getControlFence returns null, so even a publish that slipped through writes ZERO rows.
    if (aborted()) return DEADLINE();
    let res;
    try { res = await publisher.publish(DAILY_REPORT_KEY, accountId); }
    catch (e) { return hardFail("publish", "publish-threw:" + S(e && e.message)); }
    const pdisp = res && S(res.disposition);
    if (pdisp === "lease-lost") return contention("publish-lease-lost");
    if (pdisp !== "published" && pdisp !== "already-current") return hardFail("publish", "publish-" + S(pdisp));
    if (!nb(res.liveReportKey) || !nb(res.paramsHash)) return hardFail("publish", "publish-missing-live-identity");

    // The publish already LANDED (an issued remote write). The read-back is a READ-ONLY confirmation. If aborted BEFORE
    // it, do NOT start it and NEVER claim the published write was undone -- return the bounded deadline result; the
    // content-addressed CAS makes the next pass's re-publish an idempotent no-op that re-confirms.
    if (aborted()) return DEADLINE();
    let rb;
    try { rb = await readbackLive({ reportKey: DAILY_REPORT_KEY, liveReportKey: res.liveReportKey, accountId, paramsHash: res.paramsHash, signal }); }
    catch (e) { rb = { ok: false, reason: "readback-threw:" + S(e && e.message) }; }
    if (aborted()) return DEADLINE();
    if (!rb || rb.ok !== true) return hardFail("readback", "live-readback-failed:" + S(rb && rb.reason));

    log("daily-reporting release: published + read back daily-reporting for " + accountId + " (" + pdisp + ")");
    return ok();
  }

  return Object.freeze({ runForAccount, reportKeys: [DAILY_REPORT_KEY] });
}
