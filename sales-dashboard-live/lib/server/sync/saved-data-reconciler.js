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
// refuses provider creates (zero export, structurally).
//
// OPT-IN ROUTE hooks (publication recovery WP3: units, per-target as-of, two-phase prepare/publish with chunked control
// windows, a served-row verdict, a per-route current predicate). Every hook is ABSENT on the four live families (oli /
// fba / ads / listings), and with all of them absent run() takes the ORIGINAL code path -- identical reads, calls,
// logs and summary (pinned by scripts/saved-data-reconciler-routes.test.js G0 against the pre-hook module). 7-bit
// ASCII, LF.

import { PUBLICATION_STATE, evaluatePublicationBinding, contractAsOfField, isCalendarDate } from "./publication-binding.js";

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
// NEWER_LIVE: the report_snapshots freshness CAS refused to overwrite a STRICTLY-NEWER live row with this (older)
// reconciler candidate (LKG preserved, zero write) -- e.g. a brand-inventory live kept fresh by the scheduler's
// materialize-inventory job. The account's report is already at least as fresh as what we derived, so this is a
// retryable benign defer (retain the newer live), NEVER a hard FAILED_PUBLISH. Mirrors the shadow-save "shadow-newer-
// live" defer across daily-reporting / fba-brand-inventory / listing-health-v3.
const RETRYABLE_STATUS = new Set(["CONTROL_LEASE_LOST", "DATADOE_D1_NOT_READY", "NEWER_LIVE"]);
const RETRYABLE_STAGES = new Set(["reconcile", "assert-no-cron", "assert-no-cron-final", "contention", "d1-not-ready"]);
// SOURCE-NOT-READY derive stops are RETRYABLE (defer + retain LKG), NOT integrity failures. "catalog-snapshot-missing"
// means the REQUIRED org catalog snapshot is absent, OR present but DROPPED by the daily-snapshot freshness policy
// because its validated_at is not on the current UTC EXECUTION DAY (the scheduler-v2 cycle that refreshes the org
// catalog has not yet run/succeeded today) -- so the catalog evidence is not available this pass. The pre-DR1 behavior
// already deferred this (a cold catalog refused the create -> NO_EXPORT_REQUIRED -> SOURCE_READINESS_PENDING ->
// DEFERRED); the zero-export catalog ADOPTION (DR1) shifted the same not-ready condition to a derive-stage stop, so it
// must classify identically -- retryable, LKG preserved, publishes once a fresh catalog lands. This matches
// daily-reporting-release.js, which defers on every catalog condition. A catalog INTEGRITY or hydration failure
// (dangling storage object, row_count mismatch, read error) is HARD-REFUSED upstream by preflightEvidence ->
// FAILED_DERIVE with a diagnostic, so it never reaches this retryable branch -- only a genuinely not-yet-available
// catalog does. INTEGRITY derive codes (derive:count-mismatch / :lineage-mismatch / :saved-zero) also stay HARD.
const RETRYABLE_DERIVE_CODES = new Set(["SOURCE_UNAVAILABLE", "SOURCE_PAUSED", "DATADOE_INITIAL_LOAD_INCOMPLETE", "DATADOE_D1_NOT_READY", "SOURCE_D1_NOT_READY", "SOURCE_READINESS_PENDING", "catalog-snapshot-missing"]);
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
export function statusFromRelease(result) {
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

// ---- OPT-IN ROUTE hook vocabulary (WP3) --------------------------------------------------------------------------------
// A UNIT is one publishable identity inside a scope target (a brand of an account, a brand of a region portfolio, or
// the single default unit "-" == the account itself). Units never appear in job keys or argv: the unit key is a safe
// short id (sha12(brand) / "ALL" / "-"); the unit's targetId (which MAY carry brand text) keys ONLY the job + shadow
// reads, and its liveAccountId ONLY the live read + readback (the contract's liveAccountId hook must agree -- the binding
// re-derives it and STALEs a mismatch).
export const DEFAULT_UNIT_KEY = "-";
export const DEFAULT_CHUNK_MAX_TARGETS = 20; // units per control window (two-phase)
export const DEFAULT_CHUNK_MAX_SECONDS = 90; // no new publish STARTS in a window older than this (lease held <= ~90 s)
const UNIT_KEY_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const MAX_TARGET_ID_CHARS = 512;
const MAX_OWNER_ID_CHARS = 200;
// The states a currentPredicate may return (the pure-classifier vocabulary + the retryable deferral). Anything else --
// including an execution state it could never have proven -- fails CLOSED as a deferral.
const PREDICATE_STATES = new Set([PUBLICATION_STATE.PUBLICATION_NOT_REQUIRED, PUBLICATION_STATE.STALE, RECONCILE_STATUS.DEFERRED_PROVENANCE, RECONCILE_STATUS.DEFERRED_DEPENDENCY]);
const UNIT_DEFER_STATES = new Set([RECONCILE_STATUS.DEFERRED_PROVENANCE, RECONCILE_STATUS.DEFERRED_DEPENDENCY]);
// A canonical id: a nonblank string that is its own trim (never trimmed INTO another id), bounded.
const canonicalId = (v, max) => typeof v === "string" && v.trim() !== "" && v === v.trim() && v.length <= max;
const boundedStr = (v, max) => (typeof v === "string" && v.trim() !== "" && v.length <= max ? v : null);
// The stable machine code of a free-form reason (the part before the first disallowed character) -- never a message.
const reasonCode = (r) => { const m = S(r).trim().match(/^[A-Za-z0-9_.:-]+/); return (m ? m[0].slice(0, 120) : "") || "unclassified"; };
const sortedUnion = (lists) => [...new Set(lists.flat().map(S).filter(Boolean))].sort();

/**
 * Validate + normalize an adapter.expandUnits result (PURE). FAIL CLOSED on the FIRST malformed unit: the whole scope
 * target then defers (never a partial, silently-shrunk unit set that the worker could read as "every unit current").
 * Defaults (per unit): targetId = the scope accountId; liveAccountId = targetId; ownerAccountIds = [accountId];
 * targetAsOf = requestedAsOf (null allowed ONLY for an asOfField:null contract -- checked per report); reportKeys = all.
 * Owners are rollout accounts: canonical, no ':' (a prefixed scope id can never own controls). Duplicate unit keys or
 * target ids are refused. An optional unit.deferred = { state: DEFERRED_PROVENANCE|DEFERRED_DEPENDENCY, reason } marks a
 * KNOWN-but-unpublishable unit (e.g. a named brand whose brand list is unavailable) -- typed, zero reads, zero writes.
 */
export function normalizeRouteUnits(raw, { accountId, requestedAsOf, reportKeys }) {
  if (!Array.isArray(raw)) return { ok: false, reason: "units-not-array", units: [] };
  const known = Array.isArray(reportKeys) ? reportKeys : [];
  const units = []; const unitKeys = new Set(); const targetIds = new Set();
  for (const u of raw) {
    if (!u || typeof u !== "object" || Array.isArray(u)) return { ok: false, reason: "unit-not-object", units: [] };
    const unitKey = S(u.unitKey);
    if (!UNIT_KEY_RE.test(unitKey)) return { ok: false, reason: "unit-key-invalid", units: [] };
    const targetId = u.targetId === undefined ? accountId : u.targetId;
    if (!canonicalId(targetId, MAX_TARGET_ID_CHARS)) return { ok: false, reason: "unit-target-invalid", units: [] };
    const liveAccountId = u.liveAccountId === undefined ? targetId : u.liveAccountId;
    if (!canonicalId(liveAccountId, MAX_TARGET_ID_CHARS)) return { ok: false, reason: "unit-live-account-invalid", units: [] };
    const owners = u.ownerAccountIds === undefined ? [accountId] : u.ownerAccountIds;
    if (!Array.isArray(owners) || owners.length === 0 || !owners.every((o) => canonicalId(o, MAX_OWNER_ID_CHARS) && !o.includes(":"))) return { ok: false, reason: "unit-owners-invalid", units: [] };
    const targetAsOf = u.targetAsOf === undefined ? requestedAsOf : u.targetAsOf;
    if (targetAsOf !== null && !isCalendarDate(targetAsOf)) return { ok: false, reason: "unit-asof-invalid", units: [] };
    const rks = u.reportKeys === undefined ? known : u.reportKeys;
    if (!Array.isArray(rks) || rks.length === 0 || !rks.every((rk) => known.includes(rk))) return { ok: false, reason: "unit-report-keys-invalid", units: [] };
    let deferred = null;
    if (u.deferred != null) {
      if (typeof u.deferred !== "object" || !UNIT_DEFER_STATES.has(u.deferred.state)) return { ok: false, reason: "unit-deferred-invalid", units: [] };
      deferred = { state: u.deferred.state, reason: reasonCode(u.deferred.reason) };
    }
    if (unitKeys.has(unitKey) || targetIds.has(targetId)) return { ok: false, reason: "unit-duplicate", units: [] };
    unitKeys.add(unitKey); targetIds.add(targetId);
    units.push({ unitKey, targetId, liveAccountId, ownerAccountIds: [...new Set(owners)].sort(), targetAsOf, reportKeys: known.filter((rk) => rks.includes(rk)), deferred, reports: {} });
  }
  return { ok: true, reason: null, units };
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
 *
 * OPT-IN ROUTE hooks (WP3; ALL absent on the four live families -> the original path, byte-identical):
 *   adapter.expandUnits({ accountId, revision, evidence, requestedAsOf, bucket })
 *       -> [{ unitKey, targetId, liveAccountId, ownerAccountIds, targetAsOf, reportKeys, deferred? }]
 *       (validated by normalizeRouteUnits; REQUIRES the two-phase runners -- per-unit isolation needs per-unit execution).
 *       Per unit: the job + shadow reads use targetId, the live read + verifyLiveReadback use liveAccountId, and
 *       evaluatePublicationBinding gets requestedAsOf = unit.targetAsOf (compared on the contract's asOfField) plus the
 *       unit's liveAccountId (the binding STALEs a disagreement with the contract-derived live account).
 *   adapter.currentPredicate(rk, unit, ctx) -> { state, reason, h?, sra? } | null
 *       replaces evaluatePublicationBinding for THIS reconciler's route (ctx carries the loaded job/shadow/live rows and
 *       a lazy ctx.binding()); null/undefined falls back to the exact binding; a throw / foreign state DEFERS.
 *   adapter.servedCheck({ unit, rk, ... }) -> { ok, fixable, reason, served: { id, h, sra } }
 *       consulted ONLY when the verdict is PUBLICATION_NOT_REQUIRED: not ok + fixable -> STALE "served-row-differs";
 *       not ok + not fixable -> DEFERRED_DEPENDENCY "served-row-preempted:<code>"; a throw DEFERS.
 *   runPrepareForUnit / runPublishForUnit (INSTEAD of runReleaseForAccount; both or neither) -> the TWO-PHASE release:
 *       phase 1 prepares every stale unit with NO controls open; phase 2 publishes the prepared units in control windows
 *       of <= chunkMaxTargets units / chunkMaxSeconds, each openControls({ owners, publisherKeys }) ... closeControls in
 *       a finally. Both runners return the SAME typed result statusFromRelease reads; a prepare succeeds ONLY with
 *       { ok:true, prepared:true }.
 * With any hook present the perAccount records ALSO carry units[] (and report entries h / sra / served); the outcome and
 * count semantics are unchanged (a count is one (unit, report)).
 */
export function buildSavedDataReconciler({
  resolveOrg, bucketAccounts, adapter,
  readLatestReportJob, readShadowSnapshot, readLiveSnapshot, loadStoragePayload, verifyLiveReadback,
  liveContracts, computeHash, reportDerivations, shadowKeyFor = (rk) => "scheduler-v2/" + rk,
  runReleaseForAccount,
  runPrepareForUnit = null, runPublishForUnit = null,
  chunkMaxTargets = DEFAULT_CHUNK_MAX_TARGETS, chunkMaxSeconds = DEFAULT_CHUNK_MAX_SECONDS,
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
  // TWO-PHASE is selected by providing BOTH unit runners (and then runReleaseForAccount must be absent -- one release
  // shape per reconciler, never an ambiguous mix). Without them the original single-phase contract is required as-is.
  const twoPhase = runPrepareForUnit != null || runPublishForUnit != null;
  if (twoPhase) {
    if (typeof runPrepareForUnit !== "function" || typeof runPublishForUnit !== "function") throw new Error("buildSavedDataReconciler two-phase requires BOTH runPrepareForUnit + runPublishForUnit (fail closed).");
    if (runReleaseForAccount != null) throw new Error("buildSavedDataReconciler takes EITHER runReleaseForAccount OR runPrepareForUnit + runPublishForUnit, never both (fail closed).");
    if (!Number.isInteger(chunkMaxTargets) || chunkMaxTargets < 1 || chunkMaxTargets > 1000) throw new Error("buildSavedDataReconciler chunkMaxTargets must be an integer in [1, 1000] (fail closed).");
    if (!Number.isFinite(chunkMaxSeconds) || chunkMaxSeconds <= 0) throw new Error("buildSavedDataReconciler chunkMaxSeconds must be a positive number (fail closed).");
  }
  for (const [name, fn] of [["resolveOrg", resolveOrg], ["bucketAccounts", bucketAccounts], ["readLatestReportJob", readLatestReportJob], ["readShadowSnapshot", readShadowSnapshot], ["readLiveSnapshot", readLiveSnapshot], ["loadStoragePayload", loadStoragePayload], ["verifyLiveReadback", verifyLiveReadback], ...(twoPhase ? [] : [["runReleaseForAccount", runReleaseForAccount]])]) {
    if (typeof fn !== "function") throw new Error(`buildSavedDataReconciler requires ${name} (fail closed).`);
  }
  if (!liveContracts || typeof computeHash !== "function" || !reportDerivations) throw new Error("buildSavedDataReconciler requires liveContracts + computeHash + reportDerivations (fail closed).");
  if (postPromotionHook != null && typeof postPromotionHook !== "function") throw new Error("buildSavedDataReconciler postPromotionHook must be a function when provided (fail closed).");
  for (const hook of ["expandUnits", "currentPredicate", "servedCheck"]) {
    if (adapter[hook] != null && typeof adapter[hook] !== "function") throw new Error(`buildSavedDataReconciler adapter.${hook} must be a function when provided (fail closed).`);
  }
  const unitsMode = typeof adapter.expandUnits === "function";
  if (unitsMode && !twoPhase) throw new Error("buildSavedDataReconciler adapter.expandUnits requires the two-phase runPrepareForUnit + runPublishForUnit (per-unit isolation; fail closed).");
  const predicateFn = typeof adapter.currentPredicate === "function" ? adapter.currentPredicate : null;
  const servedCheckFn = typeof adapter.servedCheck === "function" ? adapter.servedCheck : null;
  // EXTENDED = any route hook present. Only then do records carry units[] and entries h/sra/served; otherwise every
  // branch below is the pre-hook code path.
  const extended = unitsMode || twoPhase || predicateFn != null || servedCheckFn != null;

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
    const staleUnits = []; // EXTENDED mode only: { rec, unit, revision, staleRks } in scope order, then expansion order
    for (const accountId of scope) {
      const accountEvidence = perAccountEvidence.get(accountId) || {};
      const revision = adapter.computeAccountRevision({ organizationFingerprint, connectionId, accountId, requestedAsOf, evidence: accountEvidence });
      const rec = { accountId, eligible: !!(revision && revision.eligible), revisionId: revision && revision.revisionId, status: revision && revision.status, reports: {} };
      if (!revision || revision.eligible !== true) {
        for (const rk of reportKeys) rec.reports[rk] = { state: RECONCILE_STATUS.DEFERRED_PROVENANCE, reason: (revision && revision.reason) || "not-eligible" };
        if (extended) attachUnits(rec, [aliasDefaultUnit(accountId, requestedAsOf, rec.reports)], revision);
        perAccount.push(rec); continue;
      }
      if (!extended) {
        let anyStale = false;
        for (const rk of reportKeys) {
          // EXACT PUBLICATION BINDING: load the latest report job, its scheduler-v2/<key> shadow (at the job hash), and
          // the live row at the CANONICAL identity derived from that shadow via the shared publisher contract; the report
          // is PUBLICATION_NOT_REQUIRED ONLY when the live row is proven equal to that exact shadow candidate (identity +
          // source_refreshed_at + params + hydrated payload). A newer validated job whose shadow was never promoted -> the
          // live's source_refreshed_at differs -> STALE. (The account IS its own single target: job/shadow/live all keyed
          // by accountId, as-of = requestedAsOf.)
          const { cls } = await bindReport({ rk, revision, unit: { targetId: accountId, liveAccountId: accountId, targetAsOf: requestedAsOf }, routeHooks: false });
          rec.reports[rk] = { state: cls.state, reason: cls.reason || null };
          if (cls.state === PUBLICATION_STATE.STALE) anyStale = true;
        }
        if (anyStale) staleAccounts.push(accountId);
        perAccount.push(rec);
        continue;
      }
      // EXTENDED (route hooks): resolve the scope target's units, then classify EACH (unit, report) independently.
      const resolved = await resolveUnits({ accountId, revision, evidence: accountEvidence, requestedAsOf, bucket });
      let units;
      if (resolved.ok) units = resolved.units;
      else {
        // An unresolvable / malformed unit set defers the WHOLE target (typed; zero reads, zero writes) -- never a
        // silently-shrunk unit set.
        for (const rk of reportKeys) rec.reports[rk] = { state: resolved.state, reason: resolved.reason };
        units = [aliasDefaultUnit(accountId, requestedAsOf, rec.reports)];
      }
      attachUnits(rec, units, revision);
      let anyStale = false;
      if (resolved.ok) {
        for (const unit of units) {
          const staleRks = [];
          for (const rk of unit.reportKeys) {
            const entry = await classifyUnitReport({ rk, unit, revision, accountId, requestedAsOf, bucket });
            unit.reports[rk] = entry;
            if (entry.state === PUBLICATION_STATE.STALE) staleRks.push(rk);
          }
          if (staleRks.length) { anyStale = true; staleUnits.push({ rec, unit, revision, staleRks }); }
        }
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
    if (twoPhase) {
      await runTwoPhase({ bucket, requestedAsOf, staleUnits, control, promoted });
    } else if (staleAccounts.length > 0) {
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

  // ONE (target, report) exact-binding load + verdict. The pre-hook path calls it with the account as its own target
  // ({ targetId: accountId, liveAccountId: accountId, targetAsOf: requestedAsOf }, routeHooks:false) and gets the SAME
  // reads with the SAME arguments in the SAME order, and the SAME binding call, as before WP3. With routeHooks the job +
  // shadow are read at the unit's targetId, the live row + readback at its liveAccountId, the binding is evaluated at the
  // unit's targetAsOf with the unit's liveAccountId, and an adapter.currentPredicate may replace the verdict.
  //   -> { cls: { state, reason }, h, sra }   (h/sra = the canonical bound live identity; meaningful only when current)
  async function bindReport({ rk, revision, unit, routeHooks, accountId = null, requestedAsOf = null, bucket = null }) {
    const targetId = unit.targetId;
    const liveAcct = unit.liveAccountId;
    const contract = liveContracts[rk];
    const expectedShadowKey = shadowKeyFor(rk);
    let job = null, shadow = null, live = null, hydShadow = null, hydLive = null, liveReadback = null, candHash = null;
    try { job = await readLatestReportJob({ reportKey: rk, accountId: targetId }); } catch { job = null; }
    if (jobIsPromotableLocal(job) && contract) {
      try { shadow = await readShadowSnapshot({ reportKey: expectedShadowKey, accountId: targetId, paramsHash: S(job.snapshotParamsHash) }); } catch { shadow = null; }
      hydShadow = await hydrate(shadow);
      const shadowParams = shadow && shadow.params && typeof shadow.params === "object" ? shadow.params : null;
      if (shadowParams) {
        const liveParams = contract.liveParams(shadowParams);
        candHash = liveParams ? computeHash(contract.liveReportVersion, liveParams) : null;
        if (candHash) {
          try { live = await readLiveSnapshot({ reportKey: contract.liveReportKey, accountId: liveAcct, paramsHash: candHash }); } catch { live = null; }
          hydLive = await hydrate(live);
          try { liveReadback = await verifyLiveReadback({ reportKey: rk, liveReportKey: contract.liveReportKey, accountId: liveAcct, paramsHash: candHash }); } catch (e) { liveReadback = { ok: false, reason: "readback-threw:" + S(e && e.message) }; }
        }
      }
    }
    const bindingArgs = { revision, accountId: targetId, reportKey: rk, requestedAsOf: unit.targetAsOf, expectedShadowKey, job, shadow, hydratedShadowPayload: hydShadow, live, hydratedLivePayload: hydLive, liveReadback, contract, computeHash, reportDerivations, revisionChangedReason };
    // The unit's live account is handed to the binding, which re-derives it from the contract + shadow and STALEs any
    // disagreement ("live-account-mismatch") -- a caller can never re-point the live identity. Pre-hook: not passed.
    if (routeHooks) bindingArgs.liveAccountId = liveAcct;
    // FAIL CLOSED per (account, report): an unexpected throw here must STALE THIS report only (LKG preserved).
    const binding = () => {
      try { return evaluatePublicationBinding(bindingArgs); }
      catch (e) { return { state: PUBLICATION_STATE.STALE, reason: "binding-threw:" + S(e && e.message) }; }
    };
    // PER-ROUTE CURRENT PREDICATE (e.g. fba-plan's content-equivalence verdict over the served row): replaces the exact
    // binding for THIS reconciler's route only. null/undefined -> the exact binding (a predicate may scope itself by rk);
    // a throw or a state outside the classifier vocabulary DEFERS (it may encode never-regress guards, so a broken
    // predicate must never fall through to a publish). Its h/sra are ITS proven identity (never guessed from the binding).
    if (routeHooks && predicateFn) {
      let p;
      try {
        p = await predicateFn(rk, publicUnit(unit), {
          accountId, targetId, liveAccountId: liveAcct, requestedAsOf: unit.targetAsOf, epoch: requestedAsOf, bucket,
          revision, contract, expectedShadowKey, job, shadow, hydratedShadowPayload: hydShadow, live, hydratedLivePayload: hydLive,
          liveReadback, candHash, binding,
        });
      } catch { return { cls: { state: RECONCILE_STATUS.DEFERRED_DEPENDENCY, reason: "current-predicate-threw" }, h: null, sra: null }; }
      if (p != null) {
        if (typeof p !== "object" || !PREDICATE_STATES.has(p.state)) return { cls: { state: RECONCILE_STATUS.DEFERRED_DEPENDENCY, reason: "current-predicate-invalid" }, h: null, sra: null };
        return { cls: { state: p.state, reason: p.reason == null ? null : S(p.reason) }, h: boundedStr(p.h, 128), sra: boundedStr(p.sra, 64) };
      }
    }
    const cls = binding();
    return { cls, h: candHash ? S(candHash) : null, sra: live && S(live.source_refreshed_at).trim() !== "" ? S(live.source_refreshed_at) : null };
  }

  // A defensive, reports-free copy of a unit for hooks + runners (they can never mutate the summary's unit records).
  function publicUnit(unit) {
    return Object.freeze({ unitKey: unit.unitKey, targetId: unit.targetId, liveAccountId: unit.liveAccountId, ownerAccountIds: Object.freeze(unit.ownerAccountIds.slice()), targetAsOf: unit.targetAsOf, reportKeys: Object.freeze(unit.reportKeys.slice()) });
  }

  // The implicit single unit of an account-grain target: the account IS the target, the live account and the owner;
  // its as-of is the run's requestedAsOf. `reports` is ALIASED to the record's reports (one object, never two copies).
  function aliasDefaultUnit(accountId, requestedAsOf, reports) {
    return { unitKey: DEFAULT_UNIT_KEY, targetId: accountId, liveAccountId: accountId, ownerAccountIds: [accountId], targetAsOf: requestedAsOf, reportKeys: reportKeys.slice(), deferred: null, reports };
  }

  // EXTENDED records carry units[]; rec.reports stays the alias of the sole default unit's reports ({} for a multi-unit
  // target, whose truth is units[]). ownerAccountIds = the union of the unit owners; evidenceToken = the adapter
  // revision's evaluated evidence token when it supplies one (echoed as the TARGETS v2 `tok`).
  function attachUnits(rec, units, revision) {
    rec.reports = units.length === 1 && units[0].unitKey === DEFAULT_UNIT_KEY ? units[0].reports : {};
    rec.units = units;
    rec.ownerAccountIds = sortedUnion(units.map((u) => u.ownerAccountIds));
    rec.evidenceToken = (revision && boundedStr(revision.evidenceToken, 512)) || null;
  }

  // Resolve a scope target's units. No expandUnits: the single default unit (validated when two-phase, because its
  // owners then open controls). A throwing expansion DEFERS (retryable); a malformed one is DEFERRED_PROVENANCE
  // "units-invalid:<code>" (typed, alertable, never a partial set).
  async function resolveUnits({ accountId, revision, evidence, requestedAsOf, bucket }) {
    if (!unitsMode) {
      if (!twoPhase) return { ok: true, units: [aliasDefaultUnit(accountId, requestedAsOf, {})] };
      const n = normalizeRouteUnits([{ unitKey: DEFAULT_UNIT_KEY }], { accountId, requestedAsOf, reportKeys });
      return n.ok ? { ok: true, units: n.units } : { ok: false, state: RECONCILE_STATUS.DEFERRED_PROVENANCE, reason: "units-invalid:" + n.reason };
    }
    let raw;
    try { raw = await adapter.expandUnits({ accountId, revision, evidence, requestedAsOf, bucket }); }
    catch { return { ok: false, state: RECONCILE_STATUS.DEFERRED_DEPENDENCY, reason: "expand-units-threw" }; }
    const n = normalizeRouteUnits(raw, { accountId, requestedAsOf, reportKeys });
    return n.ok ? { ok: true, units: n.units } : { ok: false, state: RECONCILE_STATUS.DEFERRED_PROVENANCE, reason: "units-invalid:" + n.reason };
  }

  // ONE (unit, report) verdict in EXTENDED mode: a declared unit deferral, the per-target as-of guard, the exact binding
  // (or the route's current predicate), then the served-row verdict for a PUBLICATION_NOT_REQUIRED result.
  //   -> { state, reason, h, sra[, served] }   (h/sra kept ONLY for a final PUBLICATION_NOT_REQUIRED)
  async function classifyUnitReport({ rk, unit, revision, accountId, requestedAsOf, bucket }) {
    if (unit.deferred) return { state: unit.deferred.state, reason: unit.deferred.reason, h: null, sra: null };
    const contract = liveContracts[rk];
    // A unit without an as-of can only be bound by an asOfField:null contract (e.g. brand-view-brands); for any dated
    // contract it is unprovable (typed deferral), never a STALE that would loop publishing a candidate it cannot prove.
    if (unit.targetAsOf === null && contract && contractAsOfField(contract) !== null) return { state: RECONCILE_STATUS.DEFERRED_PROVENANCE, reason: "target-asof-unresolved", h: null, sra: null };
    let bound;
    try { bound = await bindReport({ rk, revision, unit, routeHooks: true, accountId, requestedAsOf, bucket }); }
    catch (e) { return { state: PUBLICATION_STATE.STALE, reason: "binding-threw:" + S(e && e.message), h: null, sra: null }; }
    const entry = { state: bound.cls.state, reason: bound.cls.reason || null, h: null, sra: null };
    if (entry.state === PUBLICATION_STATE.PUBLICATION_NOT_REQUIRED) { entry.h = bound.h; entry.sra = bound.sra; }
    // SERVED-ROW VERDICT (C3/C4): the canonical row being bound is not enough -- the row the SERVE actually selects must
    // BE it. Consulted only for a current verdict (a stale one is re-published + re-verified anyway).
    if (servedCheckFn && entry.state === PUBLICATION_STATE.PUBLICATION_NOT_REQUIRED) {
      let sc;
      try { sc = await servedCheckFn({ unit: publicUnit(unit), rk, accountId, targetId: unit.targetId, liveAccountId: unit.liveAccountId, requestedAsOf: unit.targetAsOf, epoch: requestedAsOf, bucket, h: entry.h, sra: entry.sra }); }
      catch { return { state: RECONCILE_STATUS.DEFERRED_DEPENDENCY, reason: "served-check-threw", h: null, sra: null }; }
      if (!sc || typeof sc !== "object") return { state: RECONCILE_STATUS.DEFERRED_DEPENDENCY, reason: "served-check-invalid", h: null, sra: null };
      const sv = sc.served && typeof sc.served === "object" ? sc.served : null;
      entry.served = sv ? { id: boundedStr(sv.id == null ? null : S(sv.id), 64), h: boundedStr(sv.h, 128), sra: boundedStr(sv.sra, 64) } : null;
      if (sc.ok !== true) {
        // fixable: the canonical row exists but the serve picks another row this route CAN supersede -> re-publish.
        // not fixable: a foreign/newer row holds the served slot -> typed deferral (alerted), never a publish loop.
        if (sc.fixable === true) { entry.state = PUBLICATION_STATE.STALE; entry.reason = "served-row-differs"; }
        else { entry.state = RECONCILE_STATUS.DEFERRED_DEPENDENCY; entry.reason = "served-row-preempted:" + reasonCode(sc.reason); }
        entry.h = null; entry.sra = null;
      }
    }
    return entry;
  }

  // TWO-PHASE execution (WP3 (4)). PHASE 1 prepares every stale unit (derive + lineage + shadow + finalize) with NO
  // controls open -- per-unit isolation + the existing deadline / abort / awaitSettled machinery. PHASE 2 publishes ONLY
  // the prepared units, in control windows of <= chunkMaxTargets units whose publishes START within chunkMaxSeconds:
  // openControls({ owners: the union of the window's unit owners, publisherKeys }) -> runPublishForUnit per unit ->
  // closeControls in a finally (so the global control lease is held only for the publish burst, and re-opened per
  // window). A prepare failure never reaches phase 2, so it never opens controls. Result mapping reuses statusFromRelease
  // unchanged; LKG is preserved on every non-verified path (the fenced CAS never corrupts the live row).
  async function runTwoPhase({ bucket, requestedAsOf, staleUnits, control, promoted }) {
    const markUnit = (su, state, reason, extra) => { for (const rk of su.unit.reportKeys) { const cur = su.unit.reports[rk]; if (cur && cur.state === PUBLICATION_STATE.STALE) su.unit.reports[rk] = { state, reason, lkgPreserved: true, ...(extra || {}) }; } };
    const applyResult = (su, result, phase) => {
      const execStatus = statusFromRelease(result);
      if (execStatus === RECONCILE_STATUS.READBACK_VERIFIED) {
        for (const rk of su.staleRks) su.unit.reports[rk] = { state: RECONCILE_STATUS.READBACK_VERIFIED, reason: null };
        if (membershipSourceReport && su.staleRks.includes(membershipSourceReport)) promoted.push(su.rec.accountId);
        return;
      }
      // SANITIZED diagnostic, the same boundary contract as the single-phase path plus the SAFE unit key + phase (never
      // the unit's targetId, which may carry brand text).
      if (execStatus === RECONCILE_STATUS.FAILED_DERIVE || execStatus === RECONCILE_STATUS.FAILED_PUBLISH || execStatus === RECONCILE_STATUS.FAILED_READBACK) {
        const d = diagStageFor(result);
        log("SAVED_DATA_RECONCILE_DIAG " + JSON.stringify({ family, region: S(bucket), accountId: su.rec.accountId, unit: su.unit.unitKey, phase, requestedAsOf: S(requestedAsOf), stage: d.stage, reasonCode: d.reasonCode, errClass: d.errClass }));
      }
      for (const rk of su.staleRks) su.unit.reports[rk] = { state: execStatus, reason: S(result && (result.reason || (result.problems && result.problems[0]))) || null, lkgPreserved: true, ...(result && (result.leaseLost || result.status === "CONTROL_LEASE_LOST") ? { leaseLost: true } : {}) };
    };
    const runnerArgs = (su, signal) => ({ bucket, region: bucket, accountId: su.rec.accountId, unit: publicUnit(su.unit), revision: su.revision, revisionId: su.rec.revisionId, requestedAsOf, epoch: requestedAsOf, reportKeys: su.staleRks.slice(), signal });
    // Run ONE op under the cooperative deadline. -> { deadline:true, confirmed } | { result }
    const runOp = async (fn, threwStage, threwReason) => {
      const ac = makeAbortController() || {};
      const signal = ac.signal;
      const opPromise = Promise.resolve().then(() => fn(signal));
      let result;
      try { result = await deadlineRace(opPromise, signal); }
      catch (e) { result = { ok: false, code: 1, stage: threwStage, reason: threwReason, problems: [threwReason + ": " + S(e && e.message)] }; }
      if (result && result.__deadline === true) {
        if (typeof ac.abort === "function") ac.abort(); // request termination
        let confirmed = false;
        try { const s = await awaitSettled(opPromise); confirmed = !!(s && s.settled === true); }
        catch { confirmed = false; }
        return { deadline: true, confirmed };
      }
      return { deadline: false, result };
    };

    // ---- PHASE 1: prepare (NO controls open) ----
    const prepared = [];
    let deadlineHit = false;
    for (const su of staleUnits) {
      if (deadlineHit || outOfTime()) { deadlineHit = true; markUnit(su, RECONCILE_STATUS.DEFERRED_DEPENDENCY, "deadline-cleanup-reserved"); continue; }
      const op = await runOp((signal) => runPrepareForUnit(runnerArgs(su, signal)), "derive", "prepare-threw");
      if (op.deadline) {
        // No controls are open in phase 1, so an unconfirmed stop strands no lease/fence (the prepare writes only
        // lineage/shadow, never the live row); the unit defers and the next pass resumes it.
        deadlineHit = true;
        markUnit(su, RECONCILE_STATUS.DEFERRED_DEPENDENCY, op.confirmed ? "deadline-in-flight" : "deadline-termination-unconfirmed", { terminationConfirmed: op.confirmed });
        continue;
      }
      let result = op.result;
      if (result && result.ok === true && result.prepared === true) { prepared.push({ ...su, prepared: result }); continue; }
      // FAIL CLOSED: an "ok" that does not affirm prepared:true is never published (it could be a no-op or a runner that
      // skipped the shadow); a hard derive failure, not a silent success. A missing result is likewise a derive failure.
      if (!result || typeof result !== "object") result = { ok: false, code: 1, stage: "derive", reason: "prepare-result-malformed", problems: [] };
      else if (result.ok === true) result = { ok: false, code: 1, stage: "derive", reason: "prepare-unconfirmed", problems: ["prepare-unconfirmed: ok without prepared:true"] };
      applyResult(su, result, "prepare");
    }

    // ---- PHASE 2: publish the prepared units in bounded control windows ----
    const nowMs = () => clock().getTime();
    let idx = 0;
    while (idx < prepared.length) {
      if (deadlineHit || outOfTime()) { deadlineHit = true; for (const p of prepared.slice(idx)) markUnit(p, RECONCILE_STATUS.DEFERRED_DEPENDENCY, "deadline-cleanup-reserved"); break; }
      const chunk = prepared.slice(idx, idx + chunkMaxTargets);
      const owners = sortedUnion(chunk.map((p) => p.unit.ownerAccountIds));
      const publisherKeys = sortedUnion(chunk.map((p) => p.staleRks));
      let windowOpened = false, halt = false, processed = 0;
      try {
        const opened = await openControls({ owners, publisherKeys });
        control.reason = S(opened && opened.reason);
        if (opened && opened.commitUnknown === true) {
          control.applyCommitUnknown = true;
          for (const p of prepared.slice(idx)) markUnit(p, RECONCILE_STATUS.FAILED_PUBLISH, "control-apply-commit-unknown", { reconcileRequired: true });
          log("SAVED_DATA_RECONCILE control-apply COMMIT_UNKNOWN -- NO rollback, NO retry; read-only control reconciliation required.");
          halt = true;
        } else if (!opened || opened.ok !== true) {
          for (const p of prepared.slice(idx)) markUnit(p, RECONCILE_STATUS.DEFERRED_DEPENDENCY, "controls-not-opened:" + control.reason);
          log(`SAVED_DATA_RECONCILE controls not opened (${control.reason}) -- deferring ${prepared.length - idx} prepared unit(s), ZERO publication writes.`);
          halt = true;
        } else {
          windowOpened = true;
          control.opened = true;
          const windowStart = nowMs();
          for (const p of chunk) {
            // The window is spent: close it (finally) and re-open for the rest -- no new publish STARTS in a window older
            // than chunkMaxSeconds (the first publish of a window always starts, so every window makes progress).
            if (processed > 0 && (nowMs() - windowStart) / 1000 >= chunkMaxSeconds) break;
            processed += 1;
            if (deadlineHit || outOfTime()) { deadlineHit = true; markUnit(p, RECONCILE_STATUS.DEFERRED_DEPENDENCY, "deadline-cleanup-reserved"); continue; }
            const op = await runOp((signal) => runPublishForUnit({ ...runnerArgs(p, signal), prepared: p.prepared, owners, publisherKeys }), "publish", "publish-threw");
            if (op.deadline) {
              deadlineHit = true;
              if (op.confirmed) markUnit(p, RECONCILE_STATUS.DEFERRED_DEPENDENCY, "deadline-in-flight", { terminationConfirmed: true });
              else { control.terminationUnconfirmed = true; markUnit(p, RECONCILE_STATUS.DEFERRED_DEPENDENCY, "deadline-termination-unconfirmed", { terminationConfirmed: false }); }
              continue;
            }
            applyResult(p, op.result && typeof op.result === "object" ? op.result : { ok: false, code: 1, stage: "publish", reason: "publish-result-malformed", problems: [] }, "publish");
          }
        }
      } finally {
        if (windowOpened && control.terminationUnconfirmed === true) {
          control.reason = "termination-unconfirmed-lease-held-for-cleanup";
          log("SAVED_DATA_RECONCILE termination UNCONFIRMED after deadline abort -- NOT safe-closing (the op may still hold the fence); LEAVING the exact lease + controls INTACT for the separate cleanup job to reclaim after TTL expiry; run is NON-GREEN.");
        } else if (windowOpened) {
          try {
            const closed = await closeControls({ owners, publisherKeys });
            control.closeOk = !!(closed && closed.ok === true);
            if (closed && closed.commitUnknown === true) { control.cleanupUnresolved = true; control.reason = "safe-close-commit-unknown"; }
            else if (!control.closeOk) { control.cleanupUnresolved = true; control.reason = "safe-close-failed:" + S(closed && closed.reason); }
          } catch (e) { control.closeOk = false; control.cleanupUnresolved = true; control.reason = "safe-close-threw:" + S(e && e.message); }
        }
      }
      idx += processed;
      if (halt) break;
      // A window that did not PROVABLY close must never be followed by another open (the control plane is not proven
      // closed): the rest defers, and the run is non-green via cleanupUnresolved.
      if (control.cleanupUnresolved === true && control.terminationUnconfirmed !== true) {
        for (const p of prepared.slice(idx)) markUnit(p, RECONCILE_STATUS.DEFERRED_DEPENDENCY, "controls-close-unresolved");
        break;
      }
    }
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
    // A count is one (unit, report): a record WITH units[] (route hooks) is counted over its units -- its `reports` is
    // only an alias of the sole default unit's -- and a record without units[] exactly as before.
    for (const rec of perAccount) for (const reports of (Array.isArray(rec.units) ? rec.units.map((u) => u.reports) : [rec.reports])) for (const rk of Object.keys(reports)) {
      const st = reports[rk].state;
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
