// DEDICATED brand-inventory-ONLY release composition (blocker 3). The FBA reconciler's per-account executor uses THIS
// instead of buildPriorityDashboardsRelease (which derives/gates/publishes the WHOLE trio -- daily-reporting +
// brand-sales + brand-inventory -- and whose finalizeBucket hard-requires a product-catalog source job + accounts x 3
// report jobs). This composition RE-DERIVES ONLY brand-inventory for ONE account over ONE dedicated cycle and NEVER
// derives, saves, publishes, or mutates Daily Reporting or Brand Sales:
//   1. open the dedicated priority-partial cycle (permitted by migration 20260924);
//   2. read the EXACT durable FBA snapshot the revision selected (getSourceSnapshot + hydrate rows) -- zero export;
//   3. resolve ONE PUBLISHER-IDENTICAL Brand Sales candidate (resolveValidatedLiveCandidate): the canonical LIVE
//      brand-sales proven to be the promotion of the LATEST PROMOTABLE brand-sales job's shadow -- its dependsOn (the
//      OLI attribution provenance) AND its payload come from that SINGLE proven candidate. A newer unpromoted job can
//      NEVER lend its dependsOn to an older live payload; if the latest job is not demonstrably the source of canonical
//      live brand-sales, DEFER (LKG preserved, zero brand-inventory writes). Brand Sales is NEVER republished;
//   4. buildBrandInventorySnapshot (the EXISTING contract) over the durable FBA rows + that proven Brand Sales payload;
//   5. save ONE validated brand-inventory shadow with EXACT lineage -- depends_on = the proven Brand Sales OLI/Catalog
//      provenance (so the OLI reconciler still sees it covered) + durable_content_deps = the FBA content token
//      (fbaContentProvenanceToken) so a same-date correction is provable;
//   6. finalize ONLY this dedicated cycle via finalize_sync_cycle DIRECTLY (NOT the trio finalizeBucket);
//   7. preflight + publish + canonical read-back ONLY brand-inventory through the reviewed FENCED publisher + CAS +
//      buildLiveReadback.
//
// TERMINATION BOUNDARY (blocker 2): the caller's AbortSignal is threaded into EVERY supported Supabase read/write
// (including storage hydration), abort is rechecked AFTER every awaited phase AND immediately BEFORE every write, and
// the fenced live CAS is the final defense (an aborted op's getControlFence returns null -> the CAS writes zero rows).
// The invariant is: once abort is observed, NO additional write is started. An already-issued remote write is NEVER
// claimed undone; the reconciler core owns settlement + never-close-while-op-alive + lease retention on unconfirmed
// termination. This op is COOPERATIVE: on abort it settles promptly (returns a deadline-aborted deferral).
//
// Every side effect is an INJECTED collaborator (offline-testable); the production entrypoint wires the real readers +
// publisher + control fence. It imports no provider export transport -- brand-inventory reads only durable data. The
// returned per-account result is the SAME typed shape the release runner returns, so the shared reconciler's
// statusFromRelease classifies it unchanged. 7-bit ASCII, LF.

import { BRAND_INVENTORY_SNAPSHOT_KEY, BRAND_INVENTORY_REPORT_VERSION } from "../reports/brand-view.js";
import { fbaContentProvenanceToken } from "./fba-inventory-revision.js";
import { FBA_INVENTORY_SOURCE_KEY } from "./source-durable-model.js";
import { resolveValidatedLiveCandidate } from "./publication-binding.js";

const S = (v) => (v == null ? "" : String(v));
const nb = (v) => S(v).trim() !== "";
const SHADOW_KEY = "scheduler-v2/" + BRAND_INVENTORY_SNAPSHOT_KEY; // "scheduler-v2/brand-inventory"
const BRAND_INVENTORY_ROW_LIMIT = 5000;

const ok = () => ({ code: 0, ok: true, stage: "complete", status: null, leaseLost: false, reason: null, blockerCodes: [], problems: [] });
// A retryable DEFERRAL (source/attribution not yet available; LKG preserved). stage:'reconcile' is a RETRYABLE_STAGE in
// the shared statusFromRelease, so it classifies as DEFERRED_DEPENDENCY regardless of the (diagnostic) reason.
const defer = (reason, status = "SOURCE_UNAVAILABLE") => ({ code: 1, ok: false, stage: "reconcile", status, leaseLost: false, reason, blockerCodes: [], problems: [reason] });
const DEADLINE = () => defer("deadline-aborted", "DEADLINE_ABORTED");
const contention = (reason) => ({ code: 1, ok: false, stage: "contention", status: "CONTROL_LEASE_LOST", leaseLost: true, reason, blockerCodes: [], problems: [reason] });
// A HARD, non-retryable failure (integrity / publish / readback). stage NOT in RETRYABLE_STAGES -> FAILED_* + non-green.
const hardFail = (stage, reason) => ({ code: 1, ok: false, stage, status: null, leaseLost: false, reason, blockerCodes: stage.startsWith("derive") ? ["derive:" + reason] : [], problems: [reason] });

/**
 * Build the dedicated brand-inventory release. Injected collaborators (production wired by the entrypoint). Every
 * read/write that supports it receives { signal }; the publisher's live write is protected by the control fence.
 *   resolveOrg() -> { organizationFingerprint, connectionId }
 *   openCycle({ bucket, cycleDate, trigger }, { signal }) ; getCycleByBucketDate(bucket, cycleDate, { signal }) -> cycleRow
 *   readFbaSnapshot({ organizationFingerprint, connectionId, accountId, signal }) -> { read, snapshot }
 *   loadSnapshotPayload(objectPath, { signal }) -> { rows } | rows
 *   resolveExpectedRequestHash({ accountId, requestedAsOf }) -> "<request hash>" | ""   (D-1 proof; pure)
 *   resolveAccountCountry(accountId) -> "<marketplace country>"
 *   readReportJob(reportKey, accountId, { signal }) / readSnapshot({ reportKey, accountId, paramsHash }, { signal })
 *   loadStoragePayload(path, { signal })            (report_snapshots storage-first hydration, for the BS candidate)
 *   buildInventorySnapshot(args) -> { payload }      (default = buildBrandInventorySnapshot)
 *   computeHash(reportVersion, params) ; liveContracts ; reportDerivations ; shadowKeyFor
 *   upsertReportJob(job, { signal }) / claimLease(cycleId, reportKey, accountId, { leaseSeconds, signal })
 *   saveShadow(args, { signal }) / reconcileSuccess(args, { signal }) / finalizeCycle({ cycleId }, { signal })
 *   publisher { preflight(reportKey, accountId), publish(reportKey, accountId) }  (buildSchedulerV2Publisher, fenced)
 *   readbackLive({ reportKey, liveReportKey, accountId, paramsHash }) -> { ok, reason? }   (also the BS candidate readback)
 *   verifyLease() -> { ok, reason? } ; snapshotBytes(payload) ; leaseSeconds ; log
 */
export function buildFbaBrandInventoryRelease({
  resolveOrg,
  openCycle, getCycleByBucketDate,
  readFbaSnapshot, loadSnapshotPayload, resolveExpectedRequestHash, resolveAccountCountry,
  readReportJob, readSnapshot, loadStoragePayload,
  buildInventorySnapshot,
  computeHash, liveContracts, reportDerivations, shadowKeyFor = (rk) => "scheduler-v2/" + rk,
  upsertReportJob, claimLease, saveShadow, reconcileSuccess,
  finalizeCycle,
  publisher, readbackLive,
  verifyLease = async () => ({ ok: true }),
  snapshotBytes = (p) => Buffer.byteLength(JSON.stringify(p == null ? null : p), "utf8"),
  leaseSeconds = 300,
  log = () => {},
} = {}) {
  for (const [name, fn] of [["resolveOrg", resolveOrg], ["openCycle", openCycle], ["getCycleByBucketDate", getCycleByBucketDate], ["readFbaSnapshot", readFbaSnapshot], ["loadSnapshotPayload", loadSnapshotPayload], ["resolveExpectedRequestHash", resolveExpectedRequestHash], ["resolveAccountCountry", resolveAccountCountry], ["readReportJob", readReportJob], ["readSnapshot", readSnapshot], ["loadStoragePayload", loadStoragePayload], ["buildInventorySnapshot", buildInventorySnapshot], ["computeHash", computeHash], ["upsertReportJob", upsertReportJob], ["claimLease", claimLease], ["saveShadow", saveShadow], ["reconcileSuccess", reconcileSuccess], ["finalizeCycle", finalizeCycle], ["readbackLive", readbackLive]]) {
    if (typeof fn !== "function") throw new Error(`buildFbaBrandInventoryRelease requires ${name} (fail closed).`);
  }
  if (!liveContracts || !reportDerivations) throw new Error("buildFbaBrandInventoryRelease requires liveContracts + reportDerivations (fail closed).");
  if (!publisher || typeof publisher.preflight !== "function" || typeof publisher.publish !== "function") throw new Error("buildFbaBrandInventoryRelease requires a publisher with preflight + publish (fail closed).");

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

    // (2) durable FBA snapshot + D-1 proof (fresh read; the reconciler already gated, we independently re-prove).
    let snapRead;
    try { snapRead = await readFbaSnapshot({ organizationFingerprint, connectionId, accountId, signal }); }
    catch (e) { return defer("fba-snapshot-read-threw:" + S(e && e.message)); }
    if (aborted()) return DEADLINE();
    const snapshot = snapRead && snapRead.read === "ok" ? (snapRead.snapshot || null) : null;
    if (!snapshot) return defer("no-durable-fba-snapshot");
    const requestHash = S(snapshot.source_request_hash ?? snapshot.sourceRequestHash);
    const payloadSha = S(snapshot.payload_sha ?? snapshot.payloadSha);
    if (!nb(requestHash) || !nb(payloadSha)) return defer("fba-snapshot-incomplete");
    let expected = "";
    try { expected = S(await resolveExpectedRequestHash({ accountId, requestedAsOf })); } catch { expected = ""; }
    if (aborted()) return DEADLINE();
    if (!nb(expected)) return defer("expected-request-hash-unresolved");
    if (requestHash !== expected) return defer("fba-snapshot-not-d1"); // older/other day -> never publish stale as fresh
    let invRows = [];
    try { const p = await loadSnapshotPayload(S(snapshot.object_path ?? snapshot.objectPath), opt); invRows = Array.isArray(p) ? p : (p && Array.isArray(p.rows) ? p.rows : null); }
    catch (e) { return defer("fba-payload-unreadable:" + S(e && e.message)); }
    if (aborted()) return DEADLINE();
    if (!Array.isArray(invRows)) return defer("fba-payload-dangling");

    // (3) ONE PUBLISHER-IDENTICAL Brand Sales candidate (attribution) -- payload AND dependsOn from a SINGLE proven
    // candidate (the canonical live brand-sales that IS the promotion of the latest promotable brand-sales job's
    // shadow) AND built for the EXACT requestedAsOf D-1 window end (its live `to` must equal requestedAsOf -- an older
    // OR future Brand Sales window DEFERS, so Brand Inventory dated requestedAsOf can never be attributed from a
    // different report window). Never combine separate "latest" records. A non-proven candidate DEFERS -- and because
    // this runs BEFORE the Brand Inventory cycle opens (step 5), a mismatch produces ZERO Brand Inventory writes.
    let bs;
    try { bs = await resolveValidatedLiveCandidate({ reportKey: "brand-sales", accountId, signal, requestedAsOf, readReportJob, readSnapshot, loadStoragePayload, verifyLiveReadback: readbackLive, liveContracts, computeHash, reportDerivations, shadowKeyFor }); }
    catch (e) { return defer("brand-sales-candidate-threw:" + S(e && e.message)); }
    if (aborted()) return DEADLINE();
    if (!bs || bs.ok !== true) return defer("brand-sales-candidate-" + S(bs && bs.reason));
    const salesPayload = bs.payload;
    const bsDeps = Array.isArray(bs.dependsOn) ? bs.dependsOn : [];

    // (4) DERIVE brand-inventory ONLY (the existing contract) over the durable FBA rows + the PROVEN brand-sales
    // payload. An empty brand map THROWS -> defer (LKG preserved). Brand Sales is read here, NEVER republished.
    if (aborted()) return DEADLINE();
    let accountCountry = "";
    try { accountCountry = S(await resolveAccountCountry(accountId)); } catch { accountCountry = ""; }
    if (aborted()) return DEADLINE();
    let built;
    try {
      built = await buildInventorySnapshot({
        accountId, accountCountry, from: requestedAsOf, to: requestedAsOf, rowLimit: BRAND_INVENTORY_ROW_LIMIT,
        getSnapshot: async ({ reportKey }) => (S(reportKey) === "brand-sales" ? { payload: salesPayload } : null),
        fetchInventoryRows: async () => invRows,
      });
    } catch (e) { return defer("brand-inventory-derive-refused:" + S(e && e.message)); }
    if (aborted()) return DEADLINE();
    const payload = built && built.payload;
    if (!payload || typeof payload !== "object") return hardFail("derive", "brand-inventory-payload-malformed");

    const params = { reportVersion: BRAND_INVENTORY_REPORT_VERSION, accountId, to: requestedAsOf };
    const paramsHash = computeHash(BRAND_INVENTORY_REPORT_VERSION, params);
    const contentToken = fbaContentProvenanceToken({ sourceKey: FBA_INVENTORY_SOURCE_KEY, accountId, connectionId, requestHash, contentSha: payloadSha });

    // (5) open the dedicated cycle (WRITE) -- abort-check immediately before every write from here on.
    if (aborted()) return DEADLINE();
    let cycle;
    try { await openCycle({ bucket: cycleBucket, cycleDate: requestedAsOf, trigger: "manual" }, opt); }
    catch (e) { return defer("cycle-open-threw:" + S(e && e.message)); }
    if (aborted()) return DEADLINE();
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
        cycleId, reportKey: BRAND_INVENTORY_SNAPSHOT_KEY, reportVersion: BRAND_INVENTORY_REPORT_VERSION,
        accountId, connectionId: "primary", bucket: cycleBucket,
        dependsOn: bsDeps, durableContentDeps: [contentToken],
      }, opt);
    } catch (e) { return hardFail("derive", "lineage-upsert-threw:" + S(e && e.message)); }

    if (aborted()) return DEADLINE();
    let lease;
    try { lease = await claimLease(cycleId, BRAND_INVENTORY_SNAPSHOT_KEY, accountId, { leaseSeconds, signal }); }
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
      try { cas = await saveShadow({ reportKey: SHADOW_KEY, accountId, paramsHash, params, payload, payloadBytes: snapshotBytes(payload), sourceRefreshedAt }, opt); }
      catch (e) { return hardFail("derive", "shadow-cas-threw:" + S(e && e.message)); }
      if (aborted()) return DEADLINE();
      const outcome = cas && cas.outcome;
      if (outcome === "newer-live") return defer("shadow-newer-live"); // a newer durable exists -> resumable, LKG kept
      if (outcome !== "inserted" && outcome !== "replaced" && outcome !== "already-current") return hardFail("derive", "shadow-conflict:" + S(outcome));
      if (aborted()) return DEADLINE();
      let rec;
      try { rec = await reconcileSuccess({ cycleId, reportKey: BRAND_INVENTORY_SNAPSHOT_KEY, accountId, snapshotParamsHash: paramsHash, leaseToken: lease.leaseToken, latestDataDate: payload.inventoryDate || null }, opt); }
      catch (e) { return hardFail("derive", "reconcile-threw:" + S(e && e.message)); }
      if (aborted()) return DEADLINE();
      const rdisp = rec && rec.disposition;
      if (rdisp !== "reconciled" && rdisp !== "already-complete") return hardFail("derive", "reconcile-" + S(rdisp || "malformed"));
    }

    // (6) finalize ONLY this dedicated cycle (directly; never the trio finalizeBucket).
    if (aborted()) return DEADLINE();
    let fin;
    try { fin = await finalizeCycle({ cycleId }, opt); }
    catch (e) { return hardFail("finalize", "finalize-threw:" + S(e && e.message)); }
    if (aborted()) return DEADLINE();
    const fdisp = fin && fin.disposition;
    if (fdisp !== "finalized" && fdisp !== "already-terminal") return hardFail("finalize", "finalize-" + S(fdisp || "malformed"));

    // (7) preflight + publish + read back ONLY brand-inventory (reviewed fenced publisher + CAS + buildLiveReadback).
    if (aborted()) return DEADLINE();
    let pf;
    try { pf = await publisher.preflight(BRAND_INVENTORY_SNAPSHOT_KEY, accountId); }
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
    try { res = await publisher.publish(BRAND_INVENTORY_SNAPSHOT_KEY, accountId); }
    catch (e) { return hardFail("publish", "publish-threw:" + S(e && e.message)); }
    const pdisp = res && S(res.disposition);
    if (pdisp === "lease-lost") return contention("publish-lease-lost");
    if (pdisp !== "published" && pdisp !== "already-current") return hardFail("publish", "publish-" + S(pdisp));
    if (!nb(res.liveReportKey) || !nb(res.paramsHash)) return hardFail("publish", "publish-missing-live-identity");

    // The publish already LANDED (an issued remote write). The read-back is a READ-ONLY confirmation, threaded with the
    // signal. If aborted BEFORE it, do NOT start it and NEVER claim the published write was undone -- return the bounded
    // deadline result; the content-addressed CAS makes the next pass's re-publish an idempotent no-op that re-confirms.
    if (aborted()) return DEADLINE();
    let rb;
    try { rb = await readbackLive({ reportKey: BRAND_INVENTORY_SNAPSHOT_KEY, liveReportKey: res.liveReportKey, accountId, paramsHash: res.paramsHash, signal }); }
    catch (e) { rb = { ok: false, reason: "readback-threw:" + S(e && e.message) }; }
    if (aborted()) return DEADLINE();
    if (!rb || rb.ok !== true) return hardFail("readback", "live-readback-failed:" + S(rb && rb.reason));

    log("fba-brand-inventory: published + read back brand-inventory for " + accountId + " (" + pdisp + ")");
    return ok();
  }

  return Object.freeze({ runForAccount, reportKeys: [BRAND_INVENTORY_SNAPSHOT_KEY] });
}
