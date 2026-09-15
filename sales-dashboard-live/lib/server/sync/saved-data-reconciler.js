// SHARED saved-data publication RECONCILER core -- the ONE zero-export engine behind the immediate post-save path and
// the 30-minute periodic path, for EVERY source family (OLI, FBA inventory, ...). It re-derives + promotes the canonical
// live dashboards for accounts whose ALREADY-SAVED durable source advanced past (or was never promoted to) their live
// snapshots, using ONLY already-saved durable data.
//
// DEPENDENCY-SAFE BY CONSTRUCTION: PURE ORCHESTRATION. It imports ONLY the shared pure publication-binding primitives
// (a leaf module). Every side effect -- reading the durable source, computing the per-account revision, reading live
// snapshots, readback, and the per-account derive/finalize/publish/readback release execution -- is an INJECTED
// collaborator, so this module has NO import path to a provider export transport or a token reservation. The per-source
// ADAPTER supplies the durable-source read + revision; the family entrypoint wires the release with an adapter that
// refuses provider creates (zero export, structurally). 7-bit ASCII, LF.

import { PUBLICATION_STATE, evaluatePublicationBinding } from "./publication-binding.js";

// The full per-(account, report) status vocabulary. Selection states come from the pure classifier; execution states
// (DERIVED / PUBLISHED_LIVE / READBACK_VERIFIED / FAILED_* / LKG_PRESERVED / DEFERRED_DEPENDENCY) are added here.
export const RECONCILE_STATUS = Object.freeze({
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
const S = (v) => (v == null ? "" : String(v));
const noop = () => {};

// TYPED classification of a per-account release runner result -> the execution status for THIS report, using the
// runner's typed { stage, status, leaseLost, reason, blockerCodes } -- NEVER free-text matching. LKG is always
// preserved on failure (the fenced CAS never corrupts the live last-known-good).
//   - Contention (leaseLost) + explicit readiness statuses -> retryable DEFERRED_DEPENDENCY.
//   - A derive stop is retryable ONLY for an explicit source/readiness CODE (RETRYABLE_DERIVE_CODES); every other derive
//     stop, and every finalize / token-ceiling / publish-gate / publish / scope integrity failure, is a hard FAILED_*.
const RETRYABLE_STATUS = new Set(["CONTROL_LEASE_LOST", "DATADOE_D1_NOT_READY"]);
const RETRYABLE_STAGES = new Set(["reconcile", "assert-no-cron", "assert-no-cron-final", "contention", "d1-not-ready"]);
const RETRYABLE_DERIVE_CODES = new Set(["SOURCE_UNAVAILABLE", "SOURCE_PAUSED", "DATADOE_INITIAL_LOAD_INCOMPLETE", "DATADOE_D1_NOT_READY", "SOURCE_D1_NOT_READY", "SOURCE_READINESS_PENDING"]);
// The KNOWN-retryable ready=false blocker reasons (durable-dashboards readiness/coverage). A derive whose blockers are
// ALL in this set is retryable (source coverage not yet available); an integrity code (derive:count-mismatch /
// derive:lineage-mismatch / derive:saved-zero), an UNKNOWN code, or a MIX with any non-retryable code is a HARD failure.
const RETRYABLE_BLOCKER_REASONS = new Set(["ads-coverage-incomplete", "ads-coverage-no-accounts", "ads-coverage-read-not-ok", "ads-coverage-window-malformed", "ads-coverage-windows-not-array", "ads-evidence-missing", "backfill-start-not-reached", "coverage-incomplete", "no-accounts", "no-validated-snapshot", "source-unavailable"]);
const blockerReason = (code) => { const s = String(code); const i = s.indexOf(":"); return i < 0 ? s : s.slice(i + 1); };
// SANITIZED per-account failure diagnostic. Maps the typed release result into a STABLE, non-sensitive
// { stage, reasonCode } for the boundary log. reasonCode is the code BEFORE the first ':' -- NEVER the appended
// err.message / disposition / outcome detail, and NEVER a payload, credential, SQL string, or Amazon/customer data.
// The release's coarse "derive" stage actually spans derive + job-save + shadow-save, so the reason prefix disambiguates
// into the incident stage vocabulary.
export function diagStageFor(result) {
  const st = S(result && result.stage);
  const code = (S(result && result.reason).split(":")[0]) || st || "unknown"; // stable code, message stripped
  let stage;
  if (code.startsWith("catalog")) stage = "catalog-evidence";
  else if (code.startsWith("ads-revision") || code === "no-revision-id") stage = "revision";
  else if (code.startsWith("ads-") || code.startsWith("oli-history") || code.startsWith("oli-coverage") || code.startsWith("oli-") || code.startsWith("durable-")) stage = "source-evidence";
  else if (code.startsWith("cycle-") || code.startsWith("claim") || code.startsWith("lineage-upsert") || code === "already-complete-hash-mismatch") stage = "job-save";
  else if (code.startsWith("shadow") || code.startsWith("reconcile")) stage = "shadow-save";
  else if (code.startsWith("finalize")) stage = "closure";
  else if (code.startsWith("preflight") || code.startsWith("publish") || code.startsWith("lease-lost") || st === "publish-gates" || st === "publish") stage = "publish";
  else if (code.startsWith("live-readback") || st === "readback") stage = "readback";
  else if (code.startsWith("controls")) stage = "controls";
  else stage = "derive"; // bad-args, daily-window-unresolved, daily-payload-malformed, daily-derive-refused, ...
  return { stage, reasonCode: code, errClass: diagErrClass(S(result && (result.reason || (result.problems && result.problems[0])))) };
}
// A BOUNDED, SANITIZED classifier of an appended error tail (the part after the reasonCode ':'). Emits ONLY a DB
// error CLASS -- an HTTP status number + a keyword from a fixed whitelist of schema/state descriptors -- NEVER the raw
// message, a payload, a value, a UUID, a connection string, a token, or Amazon/customer data. "" when nothing matches.
function diagErrClass(reason) {
  const s = String(reason);
  const status = (s.match(/\((\d{3})\)/) || [])[1] || "";
  let kw = "";
  for (const [re, label] of [
    [/is terminal|terminal \(/i, "terminal-cycle"], [/not found|does not exist/i, "not-found"],
    [/schema cache|PGRST20[45]/i, "schema-cache"], [/\bcolumn\b/i, "column"], [/immutable/i, "immutable"],
    [/duplicate key|already exists/i, "duplicate"], [/violates|constraint/i, "constraint"],
    [/permission denied|not authorized/i, "denied"], [/timeout|timed out/i, "timeout"],
  ]) { if (re.test(s)) { kw = label; break; } }
  return [status, kw].filter(Boolean).join(":");
}
function statusFromRelease(result) {
  if (result && result.ok === true && Number(result.code) === 0) return RECONCILE_STATUS.READBACK_VERIFIED;
  const stage = S(result && result.stage);
  const baseStage = stage.split(":")[0];
  const status = S(result && result.status);
  const reason = S(result && result.reason);
  const blockerCodes = Array.isArray(result && result.blockerCodes) ? result.blockerCodes.map(S).filter(Boolean) : [];
  if (result && result.leaseLost === true) return RECONCILE_STATUS.DEFERRED_DEPENDENCY;
  if (RETRYABLE_STATUS.has(status)) return RECONCILE_STATUS.DEFERRED_DEPENDENCY;
  if (RETRYABLE_STAGES.has(stage) || RETRYABLE_STAGES.has(baseStage)) return RECONCILE_STATUS.DEFERRED_DEPENDENCY;
  if (baseStage === "derive") {
    if (blockerCodes.length) return blockerCodes.every((c) => RETRYABLE_BLOCKER_REASONS.has(blockerReason(c))) ? RECONCILE_STATUS.DEFERRED_DEPENDENCY : RECONCILE_STATUS.FAILED_DERIVE;
    return RETRYABLE_DERIVE_CODES.has(reason) ? RECONCILE_STATUS.DEFERRED_DEPENDENCY : RECONCILE_STATUS.FAILED_DERIVE;
  }
  if (stage === "readback") return RECONCILE_STATUS.FAILED_READBACK;
  return RECONCILE_STATUS.FAILED_PUBLISH; // finalize / token-ceiling / publish-gates / publish / scope integrity
}

/**
 * Build the generic saved-data reconciler. All collaborators injected. The per-source ADAPTER supplies the two
 * source-specific steps; everything else (scope iteration, staleness binding, control lifecycle, deadline/abort/
 * confirmed-settlement, honest outcome) is generic.
 *
 *   adapter.readScopeEvidence({ organizationFingerprint, connectionId, scope, requestedAsOf, withTimeout })
 *       -> { ok:true, perAccount: Map<accountId, evidence> }   (per-account durable evidence for computeAccountRevision)
 *        | { ok:false, failCode:<string> }                     (an unreadable durable read defers the WHOLE run, zero writes)
 *   adapter.computeAccountRevision({ organizationFingerprint, connectionId, accountId, requestedAsOf, evidence })
 *       -> { eligible, revisionId, deps:[sorted durable hashes], status, reason }   (PURE; ineligible -> deferred)
 *
 * Other injected collaborators (production defaults supplied by the family entrypoint):
 *   resolveOrg() -> { organizationFingerprint, connectionId }   bucketAccounts(bucket) -> [{ accountId }]
 *   readLatestReportJob / readShadowSnapshot / readLiveSnapshot / loadStoragePayload / verifyLiveReadback
 *   liveContracts / computeHash / reportDerivations / shadowKeyFor / reportKeys
 *   runReleaseForAccount({ bucket, accountId, requestedAsOf, revisionId, signal }) -> typed release result
 *   openControls(staleIds) / closeControls() / outOfTime() / deadlineRace(p, signal) / makeAbortController / awaitSettled
 *   postPromotionHook({ bucket, accountIds }) -> { ok, rebuilt, readbackVerified, mode }   (optional)
 *   membershipSourceReport   -- the report key whose promotion triggers the post-promotion hook (optional)
 *   postPromotionSummaryKey  -- the summary field name for the post-promotion result (default "postPromotion")
 *   revisionChangedReason    -- the STALE reason for a source-revision advance (default "source-revision-changed")
 * The reconciler NEVER creates a provider export or reserves a token; dataDoeCreates/dataDoeTokens are always 0.
 */
export function buildSavedDataReconciler({
  resolveOrg, bucketAccounts, adapter,
  readLatestReportJob, readShadowSnapshot, readLiveSnapshot, loadStoragePayload, verifyLiveReadback,
  liveContracts, computeHash, reportDerivations, shadowKeyFor = (rk) => "scheduler-v2/" + rk,
  runReleaseForAccount,
  postPromotionHook = null, membershipSourceReport = null, postPromotionSummaryKey = "postPromotion",
  revisionChangedReason = "source-revision-changed",
  reportKeys = [],
  openControls = async () => ({ ok: true }), closeControls = async () => ({ ok: true }),
  outOfTime = () => false, deadlineRace = (p) => p,
  makeAbortController = () => new AbortController(),
  awaitSettled = async (p) => { try { await p; } catch { /* a rejection is a settlement -- the op stopped */ } return { settled: true }; },
  withTimeout = (p) => p, clock = () => new Date(), log = noop, family = "saved-data",
} = {}) {
  if (!adapter || typeof adapter.readScopeEvidence !== "function" || typeof adapter.computeAccountRevision !== "function") {
    throw new Error("buildSavedDataReconciler requires an adapter with readScopeEvidence + computeAccountRevision (fail closed).");
  }
  for (const [name, fn] of [["resolveOrg", resolveOrg], ["bucketAccounts", bucketAccounts], ["readLatestReportJob", readLatestReportJob], ["readShadowSnapshot", readShadowSnapshot], ["readLiveSnapshot", readLiveSnapshot], ["loadStoragePayload", loadStoragePayload], ["verifyLiveReadback", verifyLiveReadback], ["runReleaseForAccount", runReleaseForAccount]]) {
    if (typeof fn !== "function") throw new Error(`buildSavedDataReconciler requires ${name} (fail closed).`);
  }
  if (!liveContracts || typeof computeHash !== "function" || !reportDerivations) throw new Error("buildSavedDataReconciler requires liveContracts + computeHash + reportDerivations (fail closed).");
  if (postPromotionHook != null && typeof postPromotionHook !== "function") throw new Error("buildSavedDataReconciler postPromotionHook must be a function when provided (fail closed).");

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

    // Scope: immediate mode reconciles ONLY the accounts whose source just saved; periodic scans the region directory.
    let scope;
    if (Array.isArray(accountIds) && accountIds.length) scope = [...new Set(accountIds.map((a) => S(a)).filter(Boolean))].sort();
    else {
      const dir = await bucketAccounts(bucket);
      scope = [...new Set((Array.isArray(dir) ? dir : []).map((a) => S(a && (a.accountId ?? a))).filter(Boolean))].sort();
    }
    if (scope.length === 0) return summarize({ bucket, requestedAsOf, mode, dryRun, startedAt, perAccount: [] });

    // Read durable source evidence for the whole scope via the adapter (timeout-bounded + fail-closed inside the adapter):
    // an unreadable reader defers the WHOLE run (zero writes) rather than publishing blind.
    let evidence;
    try { evidence = await adapter.readScopeEvidence({ organizationFingerprint, connectionId, scope, requestedAsOf, withTimeout }); }
    catch (e) { return fail("DURABLE_SOURCE_UNREADABLE: readScopeEvidence-threw " + S(e && e.message), bucket, requestedAsOf, mode); }
    if (!evidence || evidence.ok !== true || !(evidence.perAccount instanceof Map)) return fail(S(evidence && evidence.failCode) || "DURABLE_SOURCE_UNREADABLE: readScopeEvidence not-ok", bucket, requestedAsOf, mode);
    const perAccountEvidence = evidence.perAccount;

    // Per account: durable revision + per-report staleness classification (read-only).
    const perAccount = [];
    const staleAccounts = [];
    for (const accountId of scope) {
      const revision = adapter.computeAccountRevision({ organizationFingerprint, connectionId, accountId, requestedAsOf, evidence: perAccountEvidence.get(accountId) || {} });
      const rec = { accountId, eligible: !!(revision && revision.eligible), revisionId: revision && revision.revisionId, status: revision && revision.status, reports: {} };
      if (!revision || revision.eligible !== true) {
        for (const rk of reportKeys) rec.reports[rk] = { state: RECONCILE_STATUS.DEFERRED_PROVENANCE, reason: (revision && revision.reason) || "not-eligible" };
        perAccount.push(rec); continue;
      }
      let anyStale = false;
      for (const rk of reportKeys) {
        // EXACT PUBLICATION BINDING: load the latest report job, its scheduler-v2/<key> shadow (at the job hash), and the
        // live row at the CANONICAL identity derived from that shadow via the shared publisher contract; the report is
        // PUBLICATION_NOT_REQUIRED ONLY when the live row is proven equal to that exact shadow candidate (identity +
        // source_refreshed_at + params + hydrated payload). A newer validated job whose shadow was never promoted -> the
        // live's source_refreshed_at differs -> STALE.
        const contract = liveContracts[rk];
        const expectedShadowKey = shadowKeyFor(rk);
        let job = null, shadow = null, live = null, hydShadow = null, hydLive = null, liveReadback = null;
        try { job = await readLatestReportJob({ reportKey: rk, accountId }); } catch { job = null; }
        if (jobIsPromotableLocal(job) && contract) {
          try { shadow = await readShadowSnapshot({ reportKey: expectedShadowKey, accountId, paramsHash: S(job.snapshotParamsHash) }); } catch { shadow = null; }
          hydShadow = await hydrate(shadow);
          const shadowParams = shadow && shadow.params && typeof shadow.params === "object" ? shadow.params : null;
          if (shadowParams) {
            const liveParams = contract.liveParams(shadowParams);
            const candHash = liveParams ? computeHash(contract.liveReportVersion, liveParams) : null;
            if (candHash) {
              try { live = await readLiveSnapshot({ reportKey: contract.liveReportKey, accountId, paramsHash: candHash }); } catch { live = null; }
              hydLive = await hydrate(live);
              try { liveReadback = await verifyLiveReadback({ reportKey: rk, liveReportKey: contract.liveReportKey, accountId, paramsHash: candHash }); } catch (e) { liveReadback = { ok: false, reason: "readback-threw:" + S(e && e.message) }; }
            }
          }
        }
        // FAIL CLOSED per (account, report): an unexpected throw here must STALE THIS report only (LKG preserved).
        let cls;
        try { cls = evaluatePublicationBinding({ revision, accountId, reportKey: rk, requestedAsOf, expectedShadowKey, job, shadow, hydratedShadowPayload: hydShadow, live, hydratedLivePayload: hydLive, liveReadback, contract, computeHash, reportDerivations, revisionChangedReason }); }
        catch (e) { cls = { state: PUBLICATION_STATE.STALE, reason: "binding-threw:" + S(e && e.message) }; }
        rec.reports[rk] = { state: cls.state, reason: cls.reason || null };
        if (cls.state === PUBLICATION_STATE.STALE) anyStale = true;
      }
      if (anyStale) staleAccounts.push(accountId);
      perAccount.push(rec);
    }

    if (dryRun) {
      log(`SAVED_DATA_RECONCILE_DRYRUN bucket=${bucket} asOf=${requestedAsOf} mode=${mode} examined=${scope.length} stale_accounts=${staleAccounts.length} (ZERO writes)`);
      return summarize({ bucket, requestedAsOf, mode, dryRun, startedAt, perAccount });
    }

    // Execute ONLY the stale accounts, EACH INDEPENDENTLY (per-ACCOUNT isolation): one account's failure never blocks
    // another; a failed account keeps its exact dated LKG. Healthy accounts are processed first (sorted). Zero provider
    // export (the injected release is wired with a create-refusing adapter). CONTROL LIFECYCLE: open the publication
    // controls + capture the fence BEFORE publishing the stale set, and ALWAYS safe-close after (finally).
    const promoted = [];
    const control = { opened: false, applyCommitUnknown: false, closeOk: true, cleanupUnresolved: false, terminationUnconfirmed: false, reason: null };
    const markStale = (accountId, state, reason, extra) => { const rec = perAccount.find((r) => r.accountId === accountId); for (const rk of reportKeys) if (rec.reports[rk] && rec.reports[rk].state === PUBLICATION_STATE.STALE) rec.reports[rk] = { state, reason, lkgPreserved: true, ...(extra || {}) }; };
    if (staleAccounts.length > 0) {
      let opened = { ok: false, reason: "not-opened" };
      try {
        opened = await openControls(staleAccounts);
        control.reason = S(opened && opened.reason);
        if (opened && opened.commitUnknown === true) {
          control.applyCommitUnknown = true;
          for (const accountId of staleAccounts) markStale(accountId, RECONCILE_STATUS.FAILED_PUBLISH, "control-apply-commit-unknown", { reconcileRequired: true });
          log("SAVED_DATA_RECONCILE control-apply COMMIT_UNKNOWN -- NO rollback, NO retry; read-only control reconciliation required.");
        } else if (!opened || opened.ok !== true) {
          for (const accountId of staleAccounts) markStale(accountId, RECONCILE_STATUS.DEFERRED_DEPENDENCY, "controls-not-opened:" + control.reason);
          log(`SAVED_DATA_RECONCILE controls not opened (${control.reason}) -- deferring ${staleAccounts.length} account(s), ZERO publication writes.`);
        } else {
          control.opened = true;
          let deadlineHit = false;
          for (const accountId of staleAccounts) {
            if (deadlineHit || outOfTime()) { deadlineHit = true; markStale(accountId, RECONCILE_STATUS.DEFERRED_DEPENDENCY, "deadline-cleanup-reserved"); continue; }
            const rec = perAccount.find((r) => r.accountId === accountId);
            let result;
            const ac = makeAbortController() || {};
            const signal = ac.signal;
            const opPromise = Promise.resolve().then(() => runReleaseForAccount({ bucket, accountId, requestedAsOf, revisionId: rec.revisionId, signal }));
            try { result = await deadlineRace(opPromise, signal); }
            catch (e) { result = { ok: false, code: 1, stage: "derive", reason: "release-threw", problems: ["release-threw: " + S(e && e.message)] }; }
            if (result && result.__deadline === true) {
              deadlineHit = true;
              if (typeof ac.abort === "function") ac.abort(); // request termination
              let confirmedStopped = false;
              try { const s = await awaitSettled(opPromise); confirmedStopped = !!(s && s.settled === true); }
              catch { confirmedStopped = false; }
              if (confirmedStopped) {
                markStale(accountId, RECONCILE_STATUS.DEFERRED_DEPENDENCY, "deadline-in-flight", { terminationConfirmed: true });
              } else {
                control.terminationUnconfirmed = true;
                markStale(accountId, RECONCILE_STATUS.DEFERRED_DEPENDENCY, "deadline-termination-unconfirmed", { terminationConfirmed: false });
              }
              continue;
            }
            const execStatus = statusFromRelease(result);
            const staleReports = reportKeys.filter((rk) => rec.reports[rk] && rec.reports[rk].state === PUBLICATION_STATE.STALE);
            if (execStatus === RECONCILE_STATUS.READBACK_VERIFIED) {
              for (const rk of staleReports) rec.reports[rk] = { state: RECONCILE_STATUS.READBACK_VERIFIED, reason: null };
              if (membershipSourceReport && staleReports.includes(membershipSourceReport)) promoted.push(accountId);
            } else {
              // SANITIZED per-account failure diagnostic (incident visibility): ONLY {family, region, accountId,
              // requestedAsOf, stage, reasonCode}. No payload/credential/SQL/Amazon data (reasonCode is the stable code
              // before ':'). Emitted only for a hard FAILED_* (a DEFERRED_DEPENDENCY is expected/retryable, not logged).
              if (execStatus === RECONCILE_STATUS.FAILED_DERIVE || execStatus === RECONCILE_STATUS.FAILED_PUBLISH || execStatus === RECONCILE_STATUS.FAILED_READBACK) {
                const d = diagStageFor(result);
                log("SAVED_DATA_RECONCILE_DIAG " + JSON.stringify({ family, region: S(bucket), accountId, requestedAsOf: S(requestedAsOf), stage: d.stage, reasonCode: d.reasonCode, errClass: d.errClass }));
              }
              for (const rk of staleReports) rec.reports[rk] = { state: execStatus, reason: S(result && (result.reason || (result.problems && result.problems[0]))) || null, lkgPreserved: true, ...(result && (result.leaseLost || result.status === "CONTROL_LEASE_LOST") ? { leaseLost: true } : {}) };
            }
          }
        }
      } finally {
        if (control.opened && control.terminationUnconfirmed === true) {
          control.reason = "termination-unconfirmed-lease-held-for-cleanup";
          log("SAVED_DATA_RECONCILE termination UNCONFIRMED after deadline abort -- NOT safe-closing (the op may still hold the fence); LEAVING the exact lease + controls INTACT for the separate cleanup job to reclaim after TTL expiry; run is NON-GREEN.");
        } else if (control.opened) {
          try {
            const closed = await closeControls();
            control.closeOk = !!(closed && closed.ok === true);
            if (closed && closed.commitUnknown === true) { control.cleanupUnresolved = true; control.reason = "safe-close-commit-unknown"; }
            else if (!control.closeOk) { control.cleanupUnresolved = true; control.reason = "safe-close-failed:" + S(closed && closed.reason); }
          } catch (e) { control.closeOk = false; control.cleanupUnresolved = true; control.reason = "safe-close-threw:" + S(e && e.message); }
        }
      }
    }

    // Post-promotion hook (e.g. Brand View membership rebuild) AFTER the membership-source promotions, never before. The
    // callback reports honestly: it may perform + VERIFY a real rebuild, or report a self-heal mode. NEVER claim rebuilt
    // without readback evidence. A callback error is non-fatal but reported.
    const promotedAccounts = [...new Set(promoted)].sort();
    let postPromotion = { status: promotedAccounts.length ? "not-run" : "not-required", accounts: promotedAccounts };
    if (postPromotionHook && promotedAccounts.length) {
      try {
        const rb = await postPromotionHook({ bucket, accountIds: promotedAccounts });
        const verified = rb && rb.rebuilt === true && rb.readbackVerified === true;
        postPromotion.status = verified ? "rebuilt-verified" : (rb && S(rb.mode)) || "self_heal_pending";
      } catch (e) { log("post-promotion hook failed (non-fatal): " + S(e && e.message)); postPromotion.status = "callback-error"; }
    }

    const summary = summarize({ bucket, requestedAsOf, mode, dryRun, startedAt, perAccount, postPromotion, control });
    log(`SAVED_DATA_RECONCILE bucket=${bucket} asOf=${requestedAsOf} mode=${mode} outcome=${summary.outcome} examined=${scope.length} stale=${staleAccounts.length} published=${summary.counts.targetsPublished} failed=${summary.counts.targetsFailed} controlClean=${!summary.controlCleanupUnresolved} ${postPromotionSummaryKey}=${postPromotion.status}`);
    return summary;
  }

  // Local promotable check (same rule the shared binding uses) so the read loop can skip a non-promotable job cheaply.
  function jobIsPromotableLocal(job) {
    return !!job && S(job.deriveStatus) === "succeeded" && S(job.saveStatus) === "succeeded" && job.validated === true
      && (S(job.cycleStatus) === "succeeded" || S(job.cycleStatus) === "partial") && S(job.snapshotParamsHash).trim() !== "";
  }

  function fail(code, bucket, requestedAsOf, mode) {
    log("SAVED_DATA_RECONCILE_FAILCLOSED " + code);
    return { ok: false, outcome: "failed", code, bucket: S(bucket), requestedAsOf: S(requestedAsOf), mode, dataDoeCreates: 0, dataDoeTokens: 0, perAccount: [], counts: emptyCounts(), [postPromotionSummaryKey]: { status: "not-run", accounts: [] }, controlCleanupUnresolved: false };
  }

  function summarize({ bucket, requestedAsOf, mode, dryRun, startedAt, perAccount, postPromotion = { status: "not-required", accounts: [] }, control = { cleanupUnresolved: false, applyCommitUnknown: false, reason: null } }) {
    const counts = emptyCounts();
    for (const rec of perAccount) for (const rk of Object.keys(rec.reports)) {
      const st = rec.reports[rk].state;
      counts.targetsExamined += 1;
      if (st === RECONCILE_STATUS.READBACK_VERIFIED || st === RECONCILE_STATUS.PUBLISHED_LIVE) counts.targetsPublished += 1;
      else if (st === PUBLICATION_STATE.PUBLICATION_NOT_REQUIRED) counts.targetsAlreadyCurrent += 1;
      else if (st === PUBLICATION_STATE.STALE) counts.targetsStale += 1; // only remains STALE in dryRun
      else if (st === RECONCILE_STATUS.DEFERRED_PROVENANCE || st === RECONCILE_STATUS.DEFERRED_DEPENDENCY) counts.targetsDeferred += 1;
      else if (st === RECONCILE_STATUS.FAILED_DERIVE || st === RECONCILE_STATUS.FAILED_PUBLISH || st === RECONCILE_STATUS.FAILED_READBACK) counts.targetsFailed += 1;
    }
    // HONEST OUTCOME: ok:true (exit 0) ONLY when there is no unresolved HARD failure AND controls are proven closed AND
    // the control-apply did not COMMIT_UNKNOWN. Deferrals keep dated LKG and are honest -> 'partial'. A deadline whose
    // in-flight op could NOT be CONFIRMED stopped is also control-cleanup-unresolved (non-green).
    const controlCleanupUnresolved = control.cleanupUnresolved === true || control.applyCommitUnknown === true || control.terminationUnconfirmed === true;
    const hardFailures = counts.targetsFailed;
    const hardBlocked = hardFailures > 0 || controlCleanupUnresolved;
    const unpublished = counts.targetsStale + counts.targetsDeferred + counts.targetsFailed;
    const outcome = hardBlocked ? "failed" : (unpublished > 0 ? "partial" : "complete");
    return {
      ok: !hardBlocked, outcome,
      code: !hardBlocked ? "OK" : (controlCleanupUnresolved ? "CONTROL_CLEANUP_UNRESOLVED" : "HARD_FAILURES"),
      bucket, requestedAsOf, mode, dryRun: !!dryRun, startedAt,
      accountsExamined: perAccount.length,
      dataDoeCreates: 0, dataDoeTokens: 0, [postPromotionSummaryKey]: postPromotion,
      controlCleanupUnresolved, controlReason: control.reason || null,
      counts, perAccount,
    };
  }

  function emptyCounts() {
    return { targetsExamined: 0, targetsStale: 0, targetsPublished: 0, targetsAlreadyCurrent: 0, targetsDeferred: 0, targetsFailed: 0 };
  }

  return { run };
}
