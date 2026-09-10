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
import { computeOliAccountRevision, classifyOliReportTarget, OLI_PUBLICATION_STATE } from "./oli-publication-revision.js";

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

// Map a per-account release runner result -> the execution status for THIS report. LKG is always preserved on failure
// (the fenced CAS never corrupts the live last-known-good). A derive failure whose cause is a missing/unready durable
// dependency (catalog / provenance / source-unavailable / paused) is a retryable DEFERRED_DEPENDENCY, not a hard failure.
function statusFromRelease(result) {
  if (result && result.ok === true && Number(result.code) === 0) return OLI_RECONCILE_STATUS.READBACK_VERIFIED;
  const stage = S(result && result.stage);
  const problems = Array.isArray(result && result.problems) ? result.problems.map((p) => S(p)).join(" ").toLowerCase() : "";
  const dependencyDeferred = /provenance|source-unavailable|source_unavailable|catalog|paused|not-ready|d1_not_ready|datadoe_d1/.test(problems);
  if (stage.startsWith("derive")) return dependencyDeferred ? OLI_RECONCILE_STATUS.DEFERRED_DEPENDENCY : OLI_RECONCILE_STATUS.FAILED_DERIVE;
  if (stage === "readback") return OLI_RECONCILE_STATUS.FAILED_READBACK;
  if (dependencyDeferred) return OLI_RECONCILE_STATUS.DEFERRED_DEPENDENCY;
  return OLI_RECONCILE_STATUS.FAILED_PUBLISH;
}

/**
 * Build the reconciler. All collaborators injected (production defaults supplied by the entrypoint):
 *   resolveOrg()                              -> { organizationFingerprint, connectionId }        (fail closed if null)
 *   bucketAccounts(bucket)                    -> [{ accountId }]   (region-scoped directory for the periodic scan)
 *   oliStart                                  -> "YYYY-MM-DD"      (order-line-items initialBackfill.start)
 *   readPositiveHistory({ organizationFingerprint, connectionId, accountIds, from, to }) -> rows[]  (positive OLI sales)
 *   readZeroRowProof({ organizationFingerprint, connectionId, accountIds })              -> { read, byAccount:Map }
 *   readLatestLiveSnapshot({ reportKey, accountId })  -> snapshot|null   (latest bare live snapshot for the report)
 *   readbackLive({ reportKey, liveReportKey, accountId, paramsHash })    -> { ok }   (exact-identity live readback)
 *   runReleaseForAccount({ bucket, accountId, requestedAsOf })           -> { code, ok, stage, problems, published:[{reportKey,disposition,...}] }
 *   rebuildBrandViewMembership({ bucket, accountIds })                   -> { ok, rebuilt, reason }
 *   reportKeys = oliDependentLiveReportKeys()   withTimeout   clock   log
 * The reconciler NEVER creates a DataDoe export or reserves a token; dataDoeCreates/dataDoeTokens are always 0.
 */
export function buildOliPublicationReconciler({
  resolveOrg, bucketAccounts, oliStart,
  readPositiveHistory, readZeroRowProof, readLatestLiveSnapshot, readLatestJobLineage, readbackLive,
  runReleaseForAccount, rebuildBrandViewMembership,
  openControls = async () => ({ ok: true }), closeControls = async () => ({ ok: true }),
  reportKeys = oliDependentLiveReportKeys(),
  withTimeout = (p) => p, clock = () => new Date(), log = noop,
} = {}) {
  for (const [name, fn] of [["resolveOrg", resolveOrg], ["bucketAccounts", bucketAccounts], ["readPositiveHistory", readPositiveHistory], ["readZeroRowProof", readZeroRowProof], ["readLatestLiveSnapshot", readLatestLiveSnapshot], ["readLatestJobLineage", readLatestJobLineage], ["readbackLive", readbackLive], ["runReleaseForAccount", runReleaseForAccount], ["rebuildBrandViewMembership", rebuildBrandViewMembership]]) {
    if (typeof fn !== "function") throw new Error(`buildOliPublicationReconciler requires ${name} (fail closed).`);
  }
  if (!S(oliStart) || !DATE_RE.test(S(oliStart))) throw new Error("buildOliPublicationReconciler requires a valid oliStart (fail closed).");

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
        let liveSnapshot = null; let readbackOk = false; let jobLineage = null;
        try { liveSnapshot = await readLatestLiveSnapshot({ reportKey: rk, accountId }); } catch { liveSnapshot = null; }
        if (liveSnapshot && S(liveSnapshot.params_hash)) {
          try { const rb = await readbackLive({ reportKey: rk, liveReportKey: rk, accountId, paramsHash: S(liveSnapshot.params_hash) }); readbackOk = !!(rb && rb.ok === true); }
          catch { readbackOk = false; }
        }
        // Request-hash revision comparison (blocker 3): the latest VALIDATED report job's depends_on is the lineage the
        // live snapshot was derived from; classifyOliReportTarget marks the report stale when the current durable OLI
        // provenance is NOT fully contained in it (a same-as-of corrected/added export).
        try { jobLineage = await readLatestJobLineage({ reportKey: rk, accountId }); } catch { jobLineage = null; }
        const cls = classifyOliReportTarget({ revision, liveSnapshot, readbackOk, requestedAsOf, jobLineage });
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
    if (staleAccounts.length > 0) try {
      const opened = await openControls(staleAccounts);
      if (!opened || opened.ok !== true) {
        for (const accountId of staleAccounts) {
          const rec = perAccount.find((r) => r.accountId === accountId);
          for (const rk of reportKeys) if (rec.reports[rk] && rec.reports[rk].state === OLI_PUBLICATION_STATE.STALE) rec.reports[rk] = { state: OLI_RECONCILE_STATUS.DEFERRED_DEPENDENCY, reason: "controls-not-opened:" + S(opened && opened.reason), lkgPreserved: true };
        }
        log(`OLI_RECONCILE controls not opened (${S(opened && opened.reason)}) -- deferring ${staleAccounts.length} account(s), ZERO publication writes.`);
      } else {
        for (const accountId of staleAccounts) {
          const rec = perAccount.find((r) => r.accountId === accountId);
          let result;
          try { result = await runReleaseForAccount({ bucket, accountId, requestedAsOf, revisionId: rec.revisionId }); }
          catch (e) { result = { ok: false, code: 1, stage: "derive", problems: ["release-threw: " + S(e && e.message)] }; }
          const execStatus = statusFromRelease(result);
          const staleReports = reportKeys.filter((rk) => rec.reports[rk] && rec.reports[rk].state === OLI_PUBLICATION_STATE.STALE);
          if (execStatus === OLI_RECONCILE_STATUS.READBACK_VERIFIED) {
            for (const rk of staleReports) rec.reports[rk] = { state: OLI_RECONCILE_STATUS.READBACK_VERIFIED, reason: null };
            if (staleReports.includes(BRAND_VIEW_MEMBERSHIP_SOURCE_REPORT)) brandSalesPromoted.push(accountId);
          } else {
            for (const rk of staleReports) rec.reports[rk] = { state: execStatus, reason: (result && result.problems && result.problems[0]) || null, lkgPreserved: true };
          }
        }
      }
    } finally {
      try { await closeControls(); } catch (e) { log("OLI_RECONCILE safe-close callback error (non-fatal): " + S(e && e.message)); }
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

    const summary = summarize({ bucket, requestedAsOf, mode, dryRun, startedAt, perAccount, brandView });
    log(`OLI_RECONCILE bucket=${bucket} asOf=${requestedAsOf} mode=${mode} outcome=${summary.outcome} examined=${scope.length} stale=${staleAccounts.length} published=${summary.counts.targetsPublished} failed=${summary.counts.targetsFailed} brandView=${brandView.status}`);
    return summary;
  }

  function fail(code, bucket, requestedAsOf, mode) {
    log("OLI_RECONCILE_FAILCLOSED " + code);
    return { ok: false, outcome: "failed", code, bucket: S(bucket), requestedAsOf: S(requestedAsOf), mode, dataDoeCreates: 0, dataDoeTokens: 0, perAccount: [], counts: emptyCounts(), brandView: { status: "not-run", accounts: [] } };
  }

  function summarize({ bucket, requestedAsOf, mode, dryRun, startedAt, perAccount, brandView = { status: "not-required", accounts: [] } }) {
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
    // HONEST OUTCOME (blocker 5): ok:true (exit 0) ONLY when there is no unresolved HARD failure. A hard failure
    // (FAILED_DERIVE/PUBLISH/READBACK) -> outcome 'failed', exit nonzero. Deferrals (provenance/dependency) keep dated
    // LKG and are honest, not failures, but they make the pass 'partial' (not everything reached live). A dry-run that
    // still sees stale targets is 'partial' (a plan, not a completed publication).
    const hardFailures = counts.targetsFailed;
    const unpublished = counts.targetsStale + counts.targetsDeferred + counts.targetsFailed;
    const outcome = hardFailures > 0 ? "failed" : (unpublished > 0 ? "partial" : "complete");
    return {
      ok: hardFailures === 0, outcome, code: hardFailures === 0 ? "OK" : "HARD_FAILURES",
      bucket, requestedAsOf, mode, dryRun: !!dryRun, startedAt,
      accountsExamined: perAccount.length,
      dataDoeCreates: 0, dataDoeTokens: 0, brandView,
      counts, perAccount,
    };
  }

  function emptyCounts() {
    return { targetsExamined: 0, targetsStale: 0, targetsPublished: 0, targetsAlreadyCurrent: 0, targetsDeferred: 0, targetsFailed: 0 };
  }

  return { run };
}
