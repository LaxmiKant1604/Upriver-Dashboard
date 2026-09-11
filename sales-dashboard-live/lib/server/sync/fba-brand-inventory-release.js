// DEDICATED brand-inventory-ONLY release composition (blocker 3). The FBA reconciler's per-account executor uses THIS
// instead of buildPriorityDashboardsRelease (which derives/gates/publishes the WHOLE trio -- daily-reporting +
// brand-sales + brand-inventory -- and whose finalizeBucket hard-requires a product-catalog source job + accounts x 3
// report jobs). This composition RE-DERIVES ONLY brand-inventory for ONE account over ONE dedicated cycle and NEVER
// derives, saves, publishes, or mutates Daily Reporting or Brand Sales:
//   1. open the dedicated priority-partial cycle (permitted by migration 20260924);
//   2. read the EXACT durable FBA snapshot the revision selected (getSourceSnapshot + hydrate rows) -- zero export;
//   3. read the account's AUTHORITATIVE VALIDATED Brand Sales snapshot + lineage (for asinBrand attribution) WITHOUT
//      republishing Brand Sales; a missing / non-terminal / unvalidated / empty-brand-map input DEFERS this account
//      (LKG preserved);
//   4. buildBrandInventorySnapshot (the EXISTING contract) over the durable FBA rows + that Brand Sales payload;
//   5. save ONE validated brand-inventory shadow with EXACT lineage -- depends_on = the Brand Sales OLI/Catalog
//      provenance (so the OLI reconciler still sees it covered) + durable_content_deps = the FBA content token
//      (fbaContentProvenanceToken) so a same-date correction is provable;
//   6. finalize ONLY this dedicated cycle via finalize_sync_cycle DIRECTLY (NOT the trio finalizeBucket);
//   7. preflight + publish + canonical read-back ONLY brand-inventory through the reviewed FENCED publisher + CAS +
//      buildLiveReadback.
// Every side effect is an INJECTED collaborator (offline-testable); the production entrypoint wires the real readers +
// publisher + control fence. It imports no DataDoe export transport -- brand-inventory reads only durable data. The
// returned per-account result is the SAME typed shape runPriorityDashboardsRelease returns, so the shared reconciler's
// statusFromRelease classifies it unchanged. 7-bit ASCII, LF.

import { BRAND_INVENTORY_SNAPSHOT_KEY, BRAND_INVENTORY_REPORT_VERSION } from "../reports/brand-view.js";
import { fbaContentProvenanceToken } from "./fba-inventory-revision.js";
import { FBA_INVENTORY_SOURCE_KEY } from "./source-durable-model.js";

const S = (v) => (v == null ? "" : String(v));
const nb = (v) => S(v).trim() !== "";
const SHADOW_KEY = "scheduler-v2/" + BRAND_INVENTORY_SNAPSHOT_KEY; // "scheduler-v2/brand-inventory"
const BRAND_INVENTORY_ROW_LIMIT = 5000;

// Typed results matching the release-runner contract statusFromRelease reads (saved-data-reconciler.js): a proven
// success is { ok:true, code:0, stage:'complete' }; a retryable deferral is code 1 on a retryable stage/status/derive-
// code; a hard failure is code 1 on finalize/publish/readback. LKG is preserved on every non-success (no live write
// unless the fenced publisher's CAS accepts it).
const ok = () => ({ code: 0, ok: true, stage: "complete", status: null, leaseLost: false, reason: null, blockerCodes: [], problems: [] });
// A retryable DEFERRAL (source/attribution not yet available; LKG preserved). stage:'reconcile' is a RETRYABLE_STAGE in
// the shared statusFromRelease, so it classifies as DEFERRED_DEPENDENCY regardless of the (diagnostic) reason.
const defer = (reason, status = "SOURCE_UNAVAILABLE") => ({ code: 1, ok: false, stage: "reconcile", status, leaseLost: false, reason, blockerCodes: [], problems: [reason] });
const contention = (reason) => ({ code: 1, ok: false, stage: "contention", status: "CONTROL_LEASE_LOST", leaseLost: true, reason, blockerCodes: [], problems: [reason] });
// A HARD, non-retryable failure (integrity / publish / readback). stage NOT in RETRYABLE_STAGES -> FAILED_* + non-green.
const hardFail = (stage, reason) => ({ code: 1, ok: false, stage, status: null, leaseLost: false, reason, blockerCodes: stage.startsWith("derive") ? ["derive:" + reason] : [], problems: [reason] });

/**
 * Build the dedicated brand-inventory release. Injected collaborators (production wired by the entrypoint):
 *   resolveOrg() -> { organizationFingerprint, connectionId }
 *   openCycle({ bucket, cycleDate, trigger }) ; getCycleByBucketDate(bucket, cycleDate) -> cycleRow{ id, created_at }
 *   readFbaSnapshot({ organizationFingerprint, connectionId, accountId }) -> { read, snapshot }
 *   loadSnapshotPayload(objectPath) -> { rows } | rows
 *   resolveExpectedRequestHash({ accountId, requestedAsOf }) -> "<request hash>" | ""   (D-1 proof)
 *   resolveAccountCountry(accountId) -> "<marketplace country>"
 *   readBrandSalesSnapshot({ accountId }) -> { payload?, payload_storage_path?, params_hash? } | null
 *   loadReportPayload(objectPath) -> payload
 *   readBrandSalesLineage({ accountId }) -> { validated, cycleStatus, dependsOn, snapshotParamsHash } | null
 *   buildInventorySnapshot(args) -> { payload }            (default = buildBrandInventorySnapshot)
 *   computeHash(reportVersion, params) -> hash            (paramsHashFor)
 *   upsertReportJob / claimLease / saveShadow / reconcileSuccess   (the durable report-job lineage + shadow CAS)
 *   finalizeCycle({ cycleId }) -> { disposition, cycle }
 *   publisher { preflight(reportKey, accountId), publish(reportKey, accountId) }   (buildSchedulerV2Publisher, fenced)
 *   readbackLive({ reportKey, liveReportKey, accountId, paramsHash }) -> { ok, reason? }
 *   verifyLease() -> { ok, reason? }                       (heartbeat before publish; default no-op ok)
 *   snapshotBytes(payload) -> number ; leaseSeconds ; log
 */
export function buildFbaBrandInventoryRelease({
  resolveOrg,
  openCycle, getCycleByBucketDate,
  readFbaSnapshot, loadSnapshotPayload, resolveExpectedRequestHash, resolveAccountCountry,
  readBrandSalesSnapshot, loadReportPayload, readBrandSalesLineage,
  buildInventorySnapshot,
  computeHash,
  upsertReportJob, claimLease, saveShadow, reconcileSuccess,
  finalizeCycle,
  publisher, readbackLive,
  verifyLease = async () => ({ ok: true }),
  snapshotBytes = (p) => Buffer.byteLength(JSON.stringify(p == null ? null : p), "utf8"),
  leaseSeconds = 300,
  log = () => {},
} = {}) {
  for (const [name, fn] of [["resolveOrg", resolveOrg], ["openCycle", openCycle], ["getCycleByBucketDate", getCycleByBucketDate], ["readFbaSnapshot", readFbaSnapshot], ["loadSnapshotPayload", loadSnapshotPayload], ["resolveExpectedRequestHash", resolveExpectedRequestHash], ["resolveAccountCountry", resolveAccountCountry], ["readBrandSalesSnapshot", readBrandSalesSnapshot], ["readBrandSalesLineage", readBrandSalesLineage], ["buildInventorySnapshot", buildInventorySnapshot], ["computeHash", computeHash], ["upsertReportJob", upsertReportJob], ["claimLease", claimLease], ["saveShadow", saveShadow], ["reconcileSuccess", reconcileSuccess], ["finalizeCycle", finalizeCycle], ["readbackLive", readbackLive]]) {
    if (typeof fn !== "function") throw new Error(`buildFbaBrandInventoryRelease requires ${name} (fail closed).`);
  }
  if (!publisher || typeof publisher.preflight !== "function" || typeof publisher.publish !== "function") throw new Error("buildFbaBrandInventoryRelease requires a publisher with preflight + publish (fail closed).");

  // Re-derive + publish brand-inventory for ONE account over its dedicated cycle. `signal` (from the reconciler's
  // deadline AbortController) is honored at every write boundary: once aborted, NO further write is attempted (the
  // publisher fence is also revoked by the entrypoint's getControlFence, so a CAS write lands zero rows).
  async function runForAccount({ accountId, requestedAsOf, cycleBucket, signal }) {
    const aborted = () => !!(signal && signal.aborted);
    if (aborted()) return defer("deadline-aborted", "DEADLINE_ABORTED");
    if (!nb(accountId) || !/^\d{4}-\d{2}-\d{2}$/.test(S(requestedAsOf)) || !nb(cycleBucket)) return hardFail("derive", "bad-args");

    const org = await resolveOrg();
    const organizationFingerprint = S(org && org.organizationFingerprint);
    const connectionId = S(org && org.connectionId) || "primary";
    if (!organizationFingerprint) return defer("org-unreadable");

    // (2) durable FBA snapshot + D-1 proof (fresh read; the reconciler already gated, we independently re-prove).
    let snapRead;
    try { snapRead = await readFbaSnapshot({ organizationFingerprint, connectionId, accountId }); }
    catch (e) { return defer("fba-snapshot-read-threw:" + S(e && e.message)); }
    const snapshot = snapRead && snapRead.read === "ok" ? (snapRead.snapshot || null) : null;
    if (!snapshot) return defer("no-durable-fba-snapshot");
    const requestHash = S(snapshot.source_request_hash ?? snapshot.sourceRequestHash);
    const payloadSha = S(snapshot.payload_sha ?? snapshot.payloadSha);
    if (!nb(requestHash) || !nb(payloadSha)) return defer("fba-snapshot-incomplete");
    let expected = "";
    try { expected = S(await resolveExpectedRequestHash({ accountId, requestedAsOf })); } catch { expected = ""; }
    if (!nb(expected)) return defer("expected-request-hash-unresolved");
    if (requestHash !== expected) return defer("fba-snapshot-not-d1"); // older/other day -> never publish stale as fresh
    let invRows = [];
    try { const p = await loadSnapshotPayload(S(snapshot.object_path ?? snapshot.objectPath)); invRows = Array.isArray(p) ? p : (p && Array.isArray(p.rows) ? p.rows : null); }
    catch (e) { return defer("fba-payload-unreadable:" + S(e && e.message)); }
    if (!Array.isArray(invRows)) return defer("fba-payload-dangling");

    // (3) AUTHORITATIVE VALIDATED Brand Sales (attribution) -- never republished. Missing/non-terminal/unvalidated -> defer.
    let bsLineage;
    try { bsLineage = await readBrandSalesLineage({ accountId }); }
    catch (e) { return defer("brand-sales-lineage-threw:" + S(e && e.message)); }
    const bsTerminal = bsLineage && bsLineage.validated === true && (S(bsLineage.cycleStatus) === "succeeded" || S(bsLineage.cycleStatus) === "partial");
    if (!bsTerminal) return defer("brand-sales-not-validated");
    const bsDeps = Array.isArray(bsLineage.dependsOn) ? bsLineage.dependsOn : [];
    let salesSnap;
    try { salesSnap = await readBrandSalesSnapshot({ accountId }); }
    catch (e) { return defer("brand-sales-read-threw:" + S(e && e.message)); }
    if (!salesSnap) return defer("brand-sales-missing");
    let salesPayload = null;
    try {
      const path = S(salesSnap.payload_storage_path ?? salesSnap.payloadStoragePath);
      salesPayload = path ? await loadReportPayload(path) : (salesSnap.payload ?? null);
    } catch (e) { return defer("brand-sales-payload-unreadable:" + S(e && e.message)); }
    if (salesPayload == null) return defer("brand-sales-payload-unavailable");

    // (4) DERIVE brand-inventory ONLY (the existing contract). An empty brand map THROWS -> defer (LKG preserved).
    if (aborted()) return defer("deadline-aborted", "DEADLINE_ABORTED");
    let accountCountry = "";
    try { accountCountry = S(await resolveAccountCountry(accountId)); } catch { accountCountry = ""; }
    let built;
    try {
      built = await buildInventorySnapshot({
        accountId, accountCountry, from: requestedAsOf, to: requestedAsOf, rowLimit: BRAND_INVENTORY_ROW_LIMIT,
        getSnapshot: async ({ reportKey }) => (S(reportKey) === "brand-sales" ? { payload: salesPayload } : null),
        fetchInventoryRows: async () => invRows,
      });
    } catch (e) { return defer("brand-inventory-derive-refused:" + S(e && e.message)); }
    const payload = built && built.payload;
    if (!payload || typeof payload !== "object") return hardFail("derive", "brand-inventory-payload-malformed");

    // (5) open the dedicated cycle + save ONE brand-inventory shadow with exact lineage.
    if (aborted()) return defer("deadline-aborted", "DEADLINE_ABORTED");
    let cycle;
    try { await openCycle({ bucket: cycleBucket, cycleDate: requestedAsOf, trigger: "manual" }); cycle = await getCycleByBucketDate(cycleBucket, requestedAsOf); }
    catch (e) { return defer("cycle-open-threw:" + S(e && e.message)); }
    if (!cycle || !nb(S(cycle.id))) return defer("cycle-unresolved");
    const cycleId = S(cycle.id);
    const sourceRefreshedAt = nb(S(cycle.created_at ?? cycle.createdAt)) ? S(cycle.created_at ?? cycle.createdAt) : null;
    if (!nb(sourceRefreshedAt)) return defer("cycle-refresh-blank");

    const params = { reportVersion: BRAND_INVENTORY_REPORT_VERSION, accountId, to: requestedAsOf };
    const paramsHash = computeHash(BRAND_INVENTORY_REPORT_VERSION, params);
    const contentToken = fbaContentProvenanceToken({ sourceKey: FBA_INVENTORY_SOURCE_KEY, accountId, connectionId, requestHash, contentSha: payloadSha });

    try {
      await upsertReportJob({
        cycleId, reportKey: BRAND_INVENTORY_SNAPSHOT_KEY, reportVersion: BRAND_INVENTORY_REPORT_VERSION,
        accountId, connectionId: "primary", bucket: cycleBucket,
        dependsOn: bsDeps, durableContentDeps: [contentToken],
      });
    } catch (e) { return hardFail("derive", "lineage-upsert-threw:" + S(e && e.message)); }

    let lease;
    try { lease = await claimLease(cycleId, BRAND_INVENTORY_SNAPSHOT_KEY, accountId, { leaseSeconds }); }
    catch (e) { return defer("claim-threw:" + S(e && e.message)); }
    const disp = lease && lease.disposition;
    if (disp === "already-complete") {
      // A prior pass already completed THIS exact hash -> proceed to publish (idempotent); a different hash is integrity-bad.
      if (S(lease.snapshotParamsHash) !== S(paramsHash)) return hardFail("derive", "already-complete-hash-mismatch");
    } else if (disp === "held") {
      return defer("claim-held", "SOURCE_READINESS_PENDING");
    } else if ((disp !== "claimed" && disp !== "reclaimed") || !nb(lease.leaseToken)) {
      return hardFail("derive", "claim-" + S(disp || "malformed"));
    }
    if (disp === "claimed" || disp === "reclaimed") {
      if (aborted()) return defer("deadline-aborted", "DEADLINE_ABORTED");
      let cas;
      try { cas = await saveShadow({ reportKey: SHADOW_KEY, accountId, paramsHash, params, payload, payloadBytes: snapshotBytes(payload), sourceRefreshedAt }); }
      catch (e) { return hardFail("derive", "shadow-cas-threw:" + S(e && e.message)); }
      const outcome = cas && cas.outcome;
      if (outcome === "newer-live") return defer("shadow-newer-live"); // a newer durable exists -> resumable, LKG kept
      if (outcome !== "inserted" && outcome !== "replaced" && outcome !== "already-current") return hardFail("derive", "shadow-conflict:" + S(outcome));
      let rec;
      try { rec = await reconcileSuccess({ cycleId, reportKey: BRAND_INVENTORY_SNAPSHOT_KEY, accountId, snapshotParamsHash: paramsHash, leaseToken: lease.leaseToken, latestDataDate: payload.inventoryDate || null }); }
      catch (e) { return hardFail("derive", "reconcile-threw:" + S(e && e.message)); }
      const rdisp = rec && rec.disposition;
      if (rdisp !== "reconciled" && rdisp !== "already-complete") return hardFail("derive", "reconcile-" + S(rdisp || "malformed"));
    }

    // (6) finalize ONLY this dedicated cycle (directly; never the trio finalizeBucket).
    let fin;
    try { fin = await finalizeCycle({ cycleId }); }
    catch (e) { return hardFail("finalize", "finalize-threw:" + S(e && e.message)); }
    const fdisp = fin && fin.disposition;
    if (fdisp !== "finalized" && fdisp !== "already-terminal") return hardFail("finalize", "finalize-" + S(fdisp || "malformed"));

    // (7) preflight + publish + read back ONLY brand-inventory (reviewed fenced publisher + CAS + buildLiveReadback).
    if (aborted()) return defer("deadline-aborted", "DEADLINE_ABORTED");
    let pf;
    try { pf = await publisher.preflight(BRAND_INVENTORY_SNAPSHOT_KEY, accountId); }
    catch (e) { return hardFail("publish-gates", "preflight-threw:" + S(e && e.message)); }
    if (!pf || S(pf.disposition) !== "ready") {
      if (pf && S(pf.disposition) === "lease-lost") return contention("preflight-lease-lost");
      return hardFail("publish-gates", "preflight-" + S(pf && pf.disposition));
    }
    let fence;
    try { fence = await verifyLease(); } catch (e) { fence = { ok: false, reason: "renew-threw:" + S(e && e.message) }; }
    if (!fence || fence.ok !== true) return contention("lease-lost-before-publish:" + S(fence && fence.reason));
    if (aborted()) return defer("deadline-aborted", "DEADLINE_ABORTED");
    let res;
    try { res = await publisher.publish(BRAND_INVENTORY_SNAPSHOT_KEY, accountId); }
    catch (e) { return hardFail("publish", "publish-threw:" + S(e && e.message)); }
    const pdisp = res && S(res.disposition);
    if (pdisp === "lease-lost") return contention("publish-lease-lost");
    if (pdisp !== "published" && pdisp !== "already-current") return hardFail("publish", "publish-" + S(pdisp));
    if (!nb(res.liveReportKey) || !nb(res.paramsHash)) return hardFail("publish", "publish-missing-live-identity");

    let rb;
    try { rb = await readbackLive({ reportKey: BRAND_INVENTORY_SNAPSHOT_KEY, liveReportKey: res.liveReportKey, accountId, paramsHash: res.paramsHash }); }
    catch (e) { rb = { ok: false, reason: "readback-threw:" + S(e && e.message) }; }
    if (!rb || rb.ok !== true) return hardFail("readback", "live-readback-failed:" + S(rb && rb.reason));

    log("fba-brand-inventory: published + read back brand-inventory for " + accountId + " (" + pdisp + ")");
    return ok();
  }

  return Object.freeze({ runForAccount, reportKeys: [BRAND_INVENTORY_SNAPSHOT_KEY] });
}
