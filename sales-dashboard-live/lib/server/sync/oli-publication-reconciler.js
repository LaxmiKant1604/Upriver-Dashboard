// OLI publication RECONCILER core (WORK 4/5/8/9) -- the ONE zero-export engine shared by the immediate post-save path
// and the 30-minute periodic path. It re-derives + promotes the OLI-dependent canonical live dashboards for accounts
// whose durable OLI advanced past (or was never promoted to) their live snapshots, using ALREADY-SAVED durable OLI.
//
// DEPENDENCY-SAFE BY CONSTRUCTION: this module is PURE ORCHESTRATION. It imports ONLY the OLI dependency registry and
// the pure revision classifier (both leaf modules). Every side effect -- reading durable OLI, reading live snapshots,
// readback, and the per-account derive/finalize/publish/readback release execution -- is an INJECTED collaborator, so
// this module has NO import path to a DataDoe export transport or a token reservation. The production entrypoint wires
// those collaborators AND forces the release's inner adapter to refuse creates (zero export, structurally). A static
// test proves this module references no create/export/token-reservation symbol. 7-bit ASCII, LF.

import { oliDependentLiveReportKeys, BRAND_VIEW_MEMBERSHIP_SOURCE_REPORT, OLI_SOURCE_KEY } from "./oli-dependent-reports.js";
import { computeOliAccountRevision, evaluatePublicationBinding, jobIsPromotable, OLI_PUBLICATION_STATE } from "./oli-publication-revision.js";

// The full per-(account, report) status vocabulary (WORK 9). Selection states come from the pure classifier; execution
// states (DERIVED / PUBLISHED_LIVE / READBACK_VERIFIED / FAILED_* / LKG_PRESERVED / DEFERRED_DEPENDENCY) are added here.
export const OLI_RECONCILE_STATUS = Object.freeze({
  SOURCE_DURABLE: "SOURCE_DURABLE",
  PUBLICATION_NOT_REQUIRED: "PUBLICATION_NOT_REQUIRED",
  DERIVED: "DERIVED",
  PUBLISHED_LIVE: "PUBLISHED_LIVE",
  READBACK_VERIFIED: "READBACK_VERIFIED",
  LKG_PRESERVED: "LKG_PRESERVED",
  DEFERRED_PROVENANCE: "DEFERRED_PROVENANCE",
  DEFERRED_DEPENDENCY: "DEFERRED_DEPENDENCY",
  FAILED_DERIVE: "FAILED_DERIVE",
  FAILED_PUBLISH: "FAILED_PUBLISH",
  FAILED_READBACK: "FAILED_READBACK",
});

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const S = (v) => (v == null ? "" : String(v).trim());
const noop = () => {};

// TYPED classification (blocker 3) of a per-account release runner result -> the execution status for THIS report,
// using the runner's typed { stage, status, leaseLost, reason } -- NEVER free-text matching (a failure is never
// classified because its text contains "catalog"). LKG is always preserved on failure (the fenced CAS never corrupts
// the live last-known-good).
//   - Contention (leaseLost) + explicit readiness statuses -> retryable DEFERRED_DEPENDENCY.
//   - A derive stop is retryable ONLY for an explicit source/readiness CODE (RETRYABLE_DERIVE_CODES); every other derive
//     stop, and every finalize / token-ceiling / publish-gate / publish / scope integrity failure, is a hard FAILED_*.
const RETRYABLE_STATUS = new Set(["CONTROL_LEASE_LOST", "DATADOE_D1_NOT_READY"]);
const RETRYABLE_STAGES = new Set(["reconcile", "assert-no-cron", "assert-no-cron-final", "contention", "d1-not-ready"]);
const RETRYABLE_DERIVE_CODES = new Set(["SOURCE_UNAVAILABLE", "SOURCE_PAUSED", "DATADOE_INITIAL_LOAD_INCOMPLETE", "DATADOE_D1_NOT_READY", "SOURCE_D1_NOT_READY", "SOURCE_READINESS_PENDING"]);
function statusFromRelease(result) {
  if (result && result.ok === true && Number(result.code) === 0) return OLI_RECONCILE_STATUS.READBACK_VERIFIED;
  const stage = S(result && result.stage);
  const baseStage = stage.split(":")[0];
  const status = S(result && result.status);
  const reason = S(result && result.reason);
  if (result && result.leaseLost === true) return OLI_RECONCILE_STATUS.DEFERRED_DEPENDENCY;
  if (RETRYABLE_STATUS.has(status)) return OLI_RECONCILE_STATUS.DEFERRED_DEPENDENCY;
  if (RETRYABLE_STAGES.has(stage) || RETRYABLE_STAGES.has(baseStage)) return OLI_RECONCILE_STATUS.DEFERRED_DEPENDENCY;
  if (baseStage === "derive") return RETRYABLE_DERIVE_CODES.has(reason) ? OLI_RECONCILE_STATUS.DEFERRED_DEPENDENCY : OLI_RECONCILE_STATUS.FAILED_DERIVE;
  if (stage === "readback") return OLI_RECONCILE_STATUS.FAILED_READBACK;
  return OLI_RECONCILE_STATUS.FAILED_PUBLISH; // finalize / token-ceiling / publish-gates / publish / scope integrity
}

/**
 * Build the reconciler. All collaborators injected (production defaults supplied by the entrypoint):
 *   resolveOrg()                              -> { organizationFingerprint, connectionId }        (fail closed if null)
 *   bucketAccounts(bucket)                    -> [{ accountId }]   (region-scoped directory for the periodic scan)
 *   oliStart                                  -> "YYYY-MM-DD"      (order-line-items initialBackfill.start)
 *   readPositiveHistory({ organizationFingerprint, connectionId, accountIds, from, to }) -> rows[]  (positive OLI sales)
 *   readZeroRowProof({ organizationFingerprint, connectionId, accountIds })              -> { read, byAccount:Map }
 *   readLatestReportJob({ reportKey, accountId })  -> { deriveStatus, saveStatus, validated, cycleStatus, snapshotParamsHash, dependsOn } | null
 *   readShadowSnapshot({ reportKey, accountId, paramsHash })  -> shadow row | null      (scheduler-v2/<key> at the job hash)
 *   readLiveSnapshot({ reportKey, accountId, paramsHash })    -> bare live row | null    (exact canonical identity)
 *   loadStoragePayload(path) -> payload | null    liveContracts (SCHEDULER_LIVE_SNAPSHOT_CONTRACTS)   computeHash (paramsHashFor)
 *   runReleaseForAccount({ bucket, accountId, requestedAsOf, revisionId }) -> { code, ok, stage, status, leaseLost, reason, problems }
 *   openControls(staleIds) -> { ok, commitUnknown?, reason? }    closeControls() -> { ok, commitUnknown?, reason? }
 *   rebuildBrandViewMembership({ bucket, accountIds })  -> { ok, rebuilt, readbackVerified, mode }    outOfTime() -> bool (deadline)
 *   reportKeys = oliDependentLiveReportKeys()   withTimeout   clock   log
 * The reconciler NEVER creates a DataDoe export or reserves a token; dataDoeCreates/dataDoeTokens are always 0.
 */
export function buildOliPublicationReconciler({
  resolveOrg, bucketAccounts, oliStart,
  readPositiveHistory, readZeroRowProof,
  readLatestReportJob, readShadowSnapshot, readLiveSnapshot, loadStoragePayload,
  liveContracts, computeHash, shadowKeyFor = (rk) => "scheduler-v2/" + rk,
  runReleaseForAccount, rebuildBrandViewMembership,
  openControls = async () => ({ ok: true }), closeControls = async () => ({ ok: true }),
  outOfTime = () => false,
  reportKeys = oliDependentLiveReportKeys(),
  withTimeout = (p) => p, clock = () => new Date(), log = noop,
} = {}) {
  for (const [name, fn] of [["resolveOrg", resolveOrg], ["bucketAccounts", bucketAccounts], ["readPositiveHistory", readPositiveHistory], ["readZeroRowProof", readZeroRowProof], ["readLatestReportJob", readLatestReportJob], ["readShadowSnapshot", readShadowSnapshot], ["readLiveSnapshot", readLiveSnapshot], ["loadStoragePayload", loadStoragePayload], ["runReleaseForAccount", runReleaseForAccount], ["rebuildBrandViewMembership", rebuildBrandViewMembership]]) {
    if (typeof fn !== "function") throw new Error(`buildOliPublicationReconciler requires ${name} (fail closed).`);
  }
  if (!liveContracts || typeof computeHash !== "function") throw new Error("buildOliPublicationReconciler requires liveContracts + computeHash (fail closed).");
  if (!S(oliStart) || !DATE_RE.test(S(oliStart))) throw new Error("buildOliPublicationReconciler requires a valid oliStart (fail closed).");

  // Storage-first payload hydration for a snapshot row (inline payload, else load the offloaded object). null on absence.
  async function hydrate(row) {
    if (!row) return null;
    const path = S(row.payload_storage_path);
    if (path) { try { return await loadStoragePayload(path); } catch { return null; } }
    return row.payload == null ? null : row.payload;
  }

  async function run({ bucket, requestedAsOf, accountIds = null, mode = "periodic", dryRun = false } = {}) {
    const startedAt = clock().toISOString();
    if (!S(bucket)) return fail("BUCKET_REQUIRED", bucket, requestedAsOf, mode);
    if (!DATE_RE.test(S(requestedAsOf))) return fail("AS_OF_REQUIRED_YYYY_MM_DD", bucket, requestedAsOf, mode);

    const org = await resolveOrg();
    if (!org || !S(org.organizationFingerprint)) return fail("ORG_FINGERPRINT_UNREADABLE", bucket, requestedAsOf, mode);
    const organizationFingerprint = S(org.organizationFingerprint);
    const connectionId = S(org.connectionId) || "primary";

    // Scope: immediate mode reconciles ONLY the accounts whose OLI just saved; periodic scans the region directory.
    let scope;
    if (Array.isArray(accountIds) && accountIds.length) scope = [...new Set(accountIds.map((a) => S(a)).filter(Boolean))].sort();
    else {
      const dir = await bucketAccounts(bucket);
      scope = [...new Set((Array.isArray(dir) ? dir : []).map((a) => S(a && (a.accountId ?? a))).filter(Boolean))].sort();
    }
    if (scope.length === 0) return summarize({ bucket, requestedAsOf, mode, dryRun, startedAt, perAccount: [] });

    // Read durable OLI evidence for the whole scope (positive-sales provenance + the proven zero-row export chain), each
    // timeout-bounded + fail-closed: an unreadable reader defers the WHOLE run (zero writes) rather than publishing blind.
    let history; let zero;
    try { history = await withTimeout(readPositiveHistory({ organizationFingerprint, connectionId, accountIds: scope, from: oliStart, to: requestedAsOf }), "positive-history"); }
    catch (e) { return fail("DURABLE_OLI_UNREADABLE: positive-history " + S(e && e.message), bucket, requestedAsOf, mode); }
    if (!Array.isArray(history)) return fail("DURABLE_OLI_UNREADABLE: positive-history non-array", bucket, requestedAsOf, mode);
    try { zero = await withTimeout(readZeroRowProof({ organizationFingerprint, connectionId, accountIds: scope, sourceKey: OLI_SOURCE_KEY }), "zero-row-proof"); }
    catch (e) { return fail("DURABLE_OLI_UNREADABLE: zero-row-proof " + S(e && e.message), bucket, requestedAsOf, mode); }
    if (!zero || zero.read !== "ok" || !(zero.byAccount instanceof Map)) return fail("DURABLE_OLI_UNREADABLE: zero-row-proof read=" + S(zero && zero.read), bucket, requestedAsOf, mode);

    const positiveHashesByAccount = new Map();
    for (const r of history) {
      const aid = S(r.account_id ?? r.accountId); if (!aid) continue;
      const h = r.source_request_hash ?? r.sourceRequestHash;
      if (!positiveHashesByAccount.has(aid)) positiveHashesByAccount.set(aid, []);
      positiveHashesByAccount.get(aid).push(typeof h === "string" && h.trim() !== "" ? h : null);
    }

    // Per account: durable revision + per-report staleness classification (read-only).
    const perAccount = [];
    const staleAccounts = [];
    for (const accountId of scope) {
      const revision = computeOliAccountRevision({
        organizationFingerprint, connectionId, accountId, oliStart, requestedAsOf,
        positiveHashes: positiveHashesByAccount.get(accountId) || [],
        zeroRowExports: zero.byAccount.get(accountId) || [],
      });
      const rec = { accountId, eligible: revision.eligible, revisionId: revision.revisionId, status: revision.status, reports: {} };
      if (!revision.eligible) {
        for (const rk of reportKeys) rec.reports[rk] = { state: OLI_RECONCILE_STATUS.DEFERRED_PROVENANCE, reason: revision.reason };
        perAccount.push(rec); continue;
      }
      let anyStale = false;
      for (const rk of reportKeys) {
        // EXACT PUBLICATION BINDING (blockers 1/2): load the latest report job, its scheduler-v2/<key> shadow (at the
        // job hash), and the live row at the CANONICAL identity derived from that shadow via the shared publisher
        // contract; the report is PUBLICATION_NOT_REQUIRED ONLY when the live row is proven equal to that exact shadow
        // candidate (identity + source_refreshed_at + params + hydrated payload). A newer validated job whose shadow was
        // never promoted -> the live's source_refreshed_at differs -> STALE.
        const contract = liveContracts[rk];
        let job = null, shadow = null, live = null, hydShadow = null, hydLive = null;
        try { job = await readLatestReportJob({ reportKey: rk, accountId }); } catch { job = null; }
        if (jobIsPromotable(job) && contract) {
          try { shadow = await readShadowSnapshot({ reportKey: shadowKeyFor(rk), accountId, paramsHash: S(job.snapshotParamsHash) }); } catch { shadow = null; }
          hydShadow = await hydrate(shadow);
          const shadowParams = shadow && shadow.params && typeof shadow.params === "object" ? shadow.params : null;
          if (shadowParams) {
            const liveParams = contract.liveParams(shadowParams);
            const candHash = liveParams ? computeHash(contract.liveReportVersion, liveParams) : null;
            if (candHash) { try { live = await readLiveSnapshot({ reportKey: contract.liveReportKey, accountId, paramsHash: candHash }); } catch { live = null; } }
            hydLive = await hydrate(live);
          }
        }
        const cls = evaluatePublicationBinding({ revision, accountId, job, shadow, hydratedShadowPayload: hydShadow, live, hydratedLivePayload: hydLive, contract, computeHash });
        rec.reports[rk] = { state: cls.state, reason: cls.reason || null };
        if (cls.state === OLI_PUBLICATION_STATE.STALE) anyStale = true;
      }
      if (anyStale) staleAccounts.push(accountId);
      perAccount.push(rec);
    }

    if (dryRun) {
      log(`OLI_RECONCILE_DRYRUN bucket=${bucket} asOf=${requestedAsOf} mode=${mode} examined=${scope.length} stale_accounts=${staleAccounts.length} (ZERO writes)`);
      return summarize({ bucket, requestedAsOf, mode, dryRun, startedAt, perAccount });
    }

    // Execute ONLY the stale accounts, EACH INDEPENDENTLY (per-ACCOUNT isolation): one account's failure never blocks
    // another; a failed account keeps its exact dated LKG. ACCOUNT-ATOMIC (blocker 4): the production runner preflights
    // + publishes an account's three OLI-dependent dashboards as ONE unit over its frozen cycle, so per-account the
    // three reports share the SAME outcome -- either all verified live, or all keep LKG. (Report-level isolation is NOT
    // claimed; the shared-cycle finalize is the required integrity contract.) Zero DataDoe export (the injected release
    // is wired with a create-refusing adapter). Healthy accounts are processed first (sorted), so an unresolved failure
    // never prevents a healthy account from publishing. Brand-sales promotion (account-atomic) triggers the membership
    // status. `revisionId` is threaded so the entrypoint can bind it into the deterministic partial-cycle identity.
    // CONTROL LIFECYCLE (blocker 2): open the publication controls + capture the fence BEFORE publishing the stale set,
    // and ALWAYS safe-close after (finally). Immediate mode reuses the scheduler's exact fence (a renew, no re-apply /
    // no safe-close -- the scheduler closes it); periodic mode runs the reviewed control-package apply -> publish ->
    // safe-close. A refused/deferred open (e.g. the scheduler holds the lease, or the control apply did not commit) is
    // NOT a hard failure: every stale account keeps its dated LKG (DEFERRED_DEPENDENCY) and retries next pass.
    const brandSalesPromoted = [];
    const control = { opened: false, applyCommitUnknown: false, closeOk: true, cleanupUnresolved: false, reason: null };
    const markStale = (accountId, state, reason, extra) => { const rec = perAccount.find((r) => r.accountId === accountId); for (const rk of reportKeys) if (rec.reports[rk] && rec.reports[rk].state === OLI_PUBLICATION_STATE.STALE) rec.reports[rk] = { state, reason, lkgPreserved: true, ...(extra || {}) }; };
    if (staleAccounts.length > 0) {
      let opened = { ok: false, reason: "not-opened" };
      try {
        opened = await openControls(staleAccounts);
        control.reason = S(opened && opened.reason);
        if (opened && opened.commitUnknown === true) {
          // APPLY COMMIT_UNKNOWN (blocker 4): the control-apply commit ack was lost. This is NOT a zero-write deferral,
          // and we NEVER blind-rollback/retry (which could close a lease we may in fact hold). Read-only reconciliation
          // is required out of band; every stale account is a hard FAILED_PUBLISH and the run reports it (exit nonzero).
          control.applyCommitUnknown = true;
          for (const accountId of staleAccounts) markStale(accountId, OLI_RECONCILE_STATUS.FAILED_PUBLISH, "control-apply-commit-unknown", { reconcileRequired: true });
          log("OLI_RECONCILE control-apply COMMIT_UNKNOWN -- NO rollback, NO retry; read-only control reconciliation required.");
        } else if (!opened || opened.ok !== true) {
          // controls not opened (scheduler holds the lease / migration pending) -> deferral, LKG preserved (not a failure).
          for (const accountId of staleAccounts) markStale(accountId, OLI_RECONCILE_STATUS.DEFERRED_DEPENDENCY, "controls-not-opened:" + control.reason);
          log(`OLI_RECONCILE controls not opened (${control.reason}) -- deferring ${staleAccounts.length} account(s), ZERO publication writes.`);
        } else {
          control.opened = true;
          let deadlineHit = false;
          for (const accountId of staleAccounts) {
            // COOPERATIVE DEADLINE (blocker 5): stop publishing new accounts once we are out of time (the entrypoint
            // reserves cleanup time before the hard region timeout), so the ALWAYS safe-close in `finally` can run.
            if (deadlineHit || outOfTime()) { deadlineHit = true; markStale(accountId, OLI_RECONCILE_STATUS.DEFERRED_DEPENDENCY, "deadline-cleanup-reserved"); continue; }
            const rec = perAccount.find((r) => r.accountId === accountId);
            let result;
            try { result = await runReleaseForAccount({ bucket, accountId, requestedAsOf, revisionId: rec.revisionId }); }
            catch (e) { result = { ok: false, code: 1, stage: "derive", reason: "release-threw", problems: ["release-threw: " + S(e && e.message)] }; }
            const execStatus = statusFromRelease(result);
            const staleReports = reportKeys.filter((rk) => rec.reports[rk] && rec.reports[rk].state === OLI_PUBLICATION_STATE.STALE);
            if (execStatus === OLI_RECONCILE_STATUS.READBACK_VERIFIED) {
              for (const rk of staleReports) rec.reports[rk] = { state: OLI_RECONCILE_STATUS.READBACK_VERIFIED, reason: null };
              if (staleReports.includes(BRAND_VIEW_MEMBERSHIP_SOURCE_REPORT)) brandSalesPromoted.push(accountId);
            } else {
              for (const rk of staleReports) rec.reports[rk] = { state: execStatus, reason: S(result && (result.reason || (result.problems && result.problems[0]))) || null, lkgPreserved: true, ...(result && (result.leaseLost || result.status === "CONTROL_LEASE_LOST") ? { leaseLost: true } : {}) };
            }
          }
        }
      } finally {
        // ALWAYS safe-close a CONFIRMED-open control plane. Its result is AUTHORITATIVE (blocker 4): a failed OR
        // COMMIT_UNKNOWN safe-close leaves controls possibly open -> control-cleanup-unresolved (outcome failed, exit
        // nonzero). Immediate mode's no-op close returns ok:true. An APPLY COMMIT_UNKNOWN is NOT safe-closed here (never
        // a blind rollback of a lease we may hold) -- it is already control-cleanup-unresolved and needs out-of-band
        // read-only reconciliation (the workflow's reclaim cleanup + the run's nonzero exit surface it).
        if (control.opened) {
          try {
            const closed = await closeControls();
            control.closeOk = !!(closed && closed.ok === true);
            if (closed && closed.commitUnknown === true) { control.cleanupUnresolved = true; control.reason = "safe-close-commit-unknown"; }
            else if (!control.closeOk) { control.cleanupUnresolved = true; control.reason = "safe-close-failed:" + S(closed && closed.reason); }
          } catch (e) { control.closeOk = false; control.cleanupUnresolved = true; control.reason = "safe-close-threw:" + S(e && e.message); }
        }
      }
    }

    // Brand View membership/directory status AFTER the brand-sales promotions (never before -- a stale brand-sales must
    // not seed the directory). The rebuild callback reports honestly: it may perform + VERIFY a real rebuild, or report
    // 'self_heal_pending' (the read-time serveSelfHealingBrandDirectory rebuilds from the now-current brand-sales on the
    // next serve). NEVER claim rebuilt without readback evidence. A callback error is non-fatal but reported.
    let brandView = { status: brandSalesPromoted.length ? "not-run" : "not-required", accounts: [...new Set(brandSalesPromoted)].sort() };
    if (brandSalesPromoted.length) {
      try {
        const rb = await rebuildBrandViewMembership({ bucket, accountIds: brandView.accounts });
        const verified = rb && rb.rebuilt === true && rb.readbackVerified === true;
        brandView.status = verified ? "rebuilt-verified" : (rb && S(rb.mode)) || "self_heal_pending";
      } catch (e) { log("brand-view membership rebuild callback failed (non-fatal): " + S(e && e.message)); brandView.status = "callback-error"; }
    }

    const summary = summarize({ bucket, requestedAsOf, mode, dryRun, startedAt, perAccount, brandView, control });
    log(`OLI_RECONCILE bucket=${bucket} asOf=${requestedAsOf} mode=${mode} outcome=${summary.outcome} examined=${scope.length} stale=${staleAccounts.length} published=${summary.counts.targetsPublished} failed=${summary.counts.targetsFailed} controlClean=${!summary.controlCleanupUnresolved} brandView=${brandView.status}`);
    return summary;
  }

  function fail(code, bucket, requestedAsOf, mode) {
    log("OLI_RECONCILE_FAILCLOSED " + code);
    return { ok: false, outcome: "failed", code, bucket: S(bucket), requestedAsOf: S(requestedAsOf), mode, dataDoeCreates: 0, dataDoeTokens: 0, perAccount: [], counts: emptyCounts(), brandView: { status: "not-run", accounts: [] }, controlCleanupUnresolved: false };
  }

  function summarize({ bucket, requestedAsOf, mode, dryRun, startedAt, perAccount, brandView = { status: "not-required", accounts: [] }, control = { cleanupUnresolved: false, applyCommitUnknown: false, reason: null } }) {
    const counts = emptyCounts();
    for (const rec of perAccount) for (const rk of Object.keys(rec.reports)) {
      const st = rec.reports[rk].state;
      counts.targetsExamined += 1;
      if (st === OLI_RECONCILE_STATUS.READBACK_VERIFIED || st === OLI_RECONCILE_STATUS.PUBLISHED_LIVE) counts.targetsPublished += 1;
      else if (st === OLI_PUBLICATION_STATE.PUBLICATION_NOT_REQUIRED) counts.targetsAlreadyCurrent += 1;
      else if (st === OLI_PUBLICATION_STATE.STALE) counts.targetsStale += 1; // only remains STALE in dryRun
      else if (st === OLI_RECONCILE_STATUS.DEFERRED_PROVENANCE || st === OLI_RECONCILE_STATUS.DEFERRED_DEPENDENCY) counts.targetsDeferred += 1;
      else if (st === OLI_RECONCILE_STATUS.FAILED_DERIVE || st === OLI_RECONCILE_STATUS.FAILED_PUBLISH || st === OLI_RECONCILE_STATUS.FAILED_READBACK) counts.targetsFailed += 1;
    }
    // HONEST OUTCOME (blocker 4/5): ok:true (exit 0) ONLY when there is no unresolved HARD failure AND controls are
    // proven closed (control cleanup resolved) AND the control-apply did not COMMIT_UNKNOWN. A hard failure or an
    // unresolved safe-close -> outcome 'failed', exit nonzero. Deferrals keep dated LKG and are honest -> 'partial'.
    const controlCleanupUnresolved = control.cleanupUnresolved === true || control.applyCommitUnknown === true;
    const hardFailures = counts.targetsFailed;
    const hardBlocked = hardFailures > 0 || controlCleanupUnresolved;
    const unpublished = counts.targetsStale + counts.targetsDeferred + counts.targetsFailed;
    const outcome = hardBlocked ? "failed" : (unpublished > 0 ? "partial" : "complete");
    return {
      ok: !hardBlocked, outcome,
      code: !hardBlocked ? "OK" : (controlCleanupUnresolved ? "CONTROL_CLEANUP_UNRESOLVED" : "HARD_FAILURES"),
      bucket, requestedAsOf, mode, dryRun: !!dryRun, startedAt,
      accountsExamined: perAccount.length,
      dataDoeCreates: 0, dataDoeTokens: 0, brandView,
      controlCleanupUnresolved, controlReason: control.reason || null,
      counts, perAccount,
    };
  }

  function emptyCounts() {
    return { targetsExamined: 0, targetsStale: 0, targetsPublished: 0, targetsAlreadyCurrent: 0, targetsDeferred: 0, targetsFailed: 0 };
  }

  return { run };
}
