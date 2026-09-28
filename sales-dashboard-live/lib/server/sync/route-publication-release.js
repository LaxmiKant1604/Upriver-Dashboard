// Publication recovery WP4 -- the GENERIC ROUTE RELEASE: ONE zero-export, two-phase (prepare / publish) release every
// recovery route (returns-v3, sku-movement, fba-plan, brand-view-brands, brand-view, brand-view-portfolio) runs through,
// plus the saved-data-reconciler ADAPTER and the pure CLI helpers of scripts/release/publication-route-reconcile.mjs.
//
// It writes ONLY through the EXISTING reviewed path: a dedicated priority-partial sync_cycle + ONE sync_report_jobs row
// (depends_on + durable_content_deps lineage) + ONE content-addressed scheduler-v2/<publisherKey> shadow (params carry
// route + rev + the evidence/manifest tokens) + finalize, then the fenced four-gate publisher (report-publisher.js ->
// publisher-composition.js fencedPublishLive -> the fenced live CAS) + the shared live read-back + the SERVED-ROW check.
// No second publisher, no new source store, no DataDoe export: the route's runtime reads only durable saved evidence.
//
// PREPARE (phase 1, NO control lease held) -- prepareForUnit({ unit, revision, epoch, region, signal }):
//   1. read the latest job (publisherKey, targetId) -- the resume candidate AND the cycle nonce.
//   2. b1 = runtime.resolveBundle(unit, { strict:true }): eligible AND b1.revisionId === revision.revisionId AND the same
//      evidence token, else DEFER ('bundle-<reason>' / 'revision-advanced-at-entry') -- zero writes.
//   1b. RESUME: the latest job promotable + covering the revision + its shadow valid (exact identity, hash provenance,
//      route/rev/evidence token, payload contract) AND the shadow's CONTENT tokens (manifest / dep fingerprint / serve
//      token) EQUAL b1's -> prepared { resumed } with ZERO writes. A proven manifest drift under an unchanged revision is
//      never resumed: it re-derives into a NEW content-addressed shadow (the tokens are in the params hash) in a new
//      nonce cycle and publishes through the fenced path.
//   3. derive(b1.bundle): notReady -> DEFER; the REAL REPORT_DERIVATIONS[publisherKey].validatePayload must pass (else
//      HARD 'payload-invalid'); a dataUnavailable payload is never promoted (DEFER 'data-unavailable'); bytes >
//      MAX_SNAPSHOT_BYTES is HARD 'payload-too-large'.
//   4. b2 = re-resolve immediately before the first write: the revision, evidence token AND manifest token must be
//      unchanged ('revision-advanced-before-write' / 'manifest-advanced-before-write'); the identity as-of must not
//      have rolled ('asof-rolled', also when the contract as-of no longer equals the scan's unit.targetAsOf).
//   PUBLISHER-IDENTICAL pre-checks (targetIdentity, live account === unit.liveAccountId, liveParamsExtra, semantic
//   identity) and the lineage-covers-revision pre-check run BEFORE any write (a shadow the publisher or the binding
//   would refuse is never written -- no publish loop).
//   STAMP: stampPolicy 'evidence' -> b2.evidenceInstant (a valid instant <= now); when the live row at the exact live
//   identity OR the SERVED row is already at least that fresh, the unit is proven already-current (content + lineage +
//   served read-back) or DEFERS NEWER_LIVE 'evidence-not-newer-than-live|served' -- ZERO writes either way (paid /
//   newer data is never overwritten) -- EXCEPT when nothing is strictly newer and the exact live row sits at EXACTLY
//   the evidence instant with DIFFERENT content tokens (a content input moved without the instant advancing): that is
//   the typed, alert-worthy deferral 'evidence-instant-not-advanced' (DEFERRED_DEPENDENCY, never NEWER_LIVE / superseded,
//   never published). 'cycle' -> the cycle's created_at.
//   GUARD: resolveBundle's optional `guard` (plain JSON) must be stableJson-equal at b1 and b2 (else DEFER
//   'revision-advanced-before-write') and rides every prepared result as prepared.guard (for publishGuard below).
//   5. CYCLE: bucket 'priority-partial-<region>-' + sha256([routeId, targetId, revisionId, nonce]).slice(0,16). A
//      crashed in-flight prepare of THIS derivation (latest job not promotable, its cycle still running/pending on this
//      epoch, its lineage covering this evidence) RESUMES that running cycle; otherwise nonce = the LATEST job id
//      WHETHER OR NOT it is promotable (another revision's job, a prepare killed after its job insert, a failed cycle's
//      job), and 'none' ONLY when the target has no job at all. Every job insert changes the latest job id, so a cycle
//      keyed on the current latest id has never held a job for this target: A -> B -> A and A -> B -> C(killed after its
//      job insert) -> A always reach a fresh cycle. The only terminal cycle a bucket can hit is one already holding THIS
//      derivation's validated job (a concurrent twin finished first) -- it resumes via the shared
//      resumableAtTerminalCycle -- or a job-less cycle closed externally (then DEFER 'cycle-not-running:<s>', bounded by
//      the epoch: cycle_date is part of the cycle key).
//      TOCTOU: the latest job is re-read immediately before the cycle open (the first write) AND immediately before
//      the job upsert; a different latest job id -> DEFER 'lineage-advanced-before-write' (no job / shadow write). A
//      cycle this prepare already CLAIMED is then finalized empty (finalize_sync_cycle: zero jobs -> 'succeeded',
//      report_total 0) so it never lingers 'running' as a phantom stall.
//   6-8. job upsert (REAL region bucket) -> derive lease (claimed / reclaimed / already-complete (hash equal) / held ->
//      DEFER) -> shadow CAS -> reconcile -> finalize. A REFUSED ('newer-live') shadow write is never counted current and
//      never trusted by stamp: the strictly-newer shadow at this exact content-addressed hash is ADOPTED only when its
//      content identity is proven (full shadow validation + equal payload digest) -- the job is reconciled to it and
//      the unit still goes through publish + read-back; different content is a typed integrity failure, an unreadable
//      one a deferral.
//   -> { ok:true, prepared:true, code:0, ... } (the typed two-phase contract of saved-data-reconciler.js).
//
// PUBLISH (phase 2, inside a control window) -- publishForUnit({ unit, prepared, signal }):
//   1. re-read the route's L1 evidence token: it must still equal prepared.evidenceToken, else DEFER 'evidence-advanced'
//      (zero CAS); 1b. the latest job must still BE this prepared derivation, else DEFER 'lineage-advanced';
//   a prepare that wrote nothing new (resumed / already-current) first re-proves the live row IS already this
//   derivation's promotion -> already-current with ZERO CAS -- ONLY when the live stamp EQUALS the latest promotable
//   shadow's stamp as well (exactly what the binding + verify require); a differing stamp falls through to the fenced
//   publish (the CAS replaces an OLDER live row; a NEWER one is NEWER_LIVE or refused-but-proven below);
//   2. publisher.preflight === 'ready' (identity cross-checked); 3. verifyLease; 3b. the route's OPTIONAL
//   publishGuard(unit, prepared, ctx) immediately before the publish, inside the lease (a non-null verdict -> its typed
//   result with ZERO CAS: NEWER_LIVE | a deferral; a throw -> 'publish-guard-threw:<msg>'); 4. publisher.publish: published |
//   already-current continue; 'newer-live' is already-current ONLY with content + lineage + served read-back, else
//   NEWER_LIVE (retryable); lease-lost is contention; anything else HARD; 5. the shared live read-back at the live
//   identity; 6. the route's served selector must return EXACTLY the canonical live row ({ report_key, account_id,
//   params_hash, source_refreshed_at }) -- fixable -> FAILED_READBACK 'served-row-differs', else DEFER
//   'served-row-preempted:<r>'; 7. postPublish + publishSnapshotUpdate (non-fatal); 8. optional shadow prune.
//   A result proven current with zero live writes carries alreadyCurrent:true (counted already-current, never
//   published). Deferrals / failures are the SAME typed shapes the shared statusFromRelease classifies unchanged.
//
// TERMINATION BOUNDARY: the AbortSignal threads into every supported read/write; abort is rechecked after every awaited
// phase and immediately before every write; the fenced CAS is the final defense. Every collaborator is INJECTED
// (offline-testable). Imports only pure modules (no REST client, no provider transport). 7-bit ASCII, LF.

import { createHash } from "node:crypto";
import {
  jobIsPromotable, revisionCoveredByJob, resumableAtTerminalCycle, stableJson, isCalendarDate, PUBLICATION_STATE,
  contractLiveParamsExtra, contractLiveAccountId, contractTargetIdentityOk, contractAsOfField, liveParamsExtraMatches,
  LIVE_PARAMS_EXTRA_MAX_CHARS,
} from "./publication-binding.js";
import { buildLivePromotedResolver } from "./live-promoted-resolver.js";
import { MAX_SNAPSHOT_BYTES, snapshotByteSize } from "../report-limits.js";
import { defaultServedVerdict, servedRowIdentity } from "../recovery/serve-selectors.js";
import { ROUTE_ID_RE, TARGET_KEY_RE, validateRouteRuntime } from "../recovery/route-contract.js";

const S = (v) => (v == null ? "" : String(v));
const nb = (v) => S(v).trim() !== "";
const sha256 = (v) => createHash("sha256").update(String(v)).digest("hex");
const errMsg = (e) => S(e && e.message).replace(/[^\x20-\x7e]/g, "").slice(0, 160);
// The stable machine code of a free-form reason (never a message).
const code = (r) => { const m = S(r).trim().match(/^[A-Za-z0-9_.:-]+/); return (m ? m[0].slice(0, 120) : "") || "unclassified"; };

export const ROUTE_REGIONS = Object.freeze(["india", "europe-au", "us-ca"]);
const PARTIAL_BUCKET_RE = /^priority-partial-(india|europe-au|us-ca)-[0-9a-f]{16}$/;
// Keys the release itself writes into the shadow params: a route's identityParams may never set / override them.
const RESERVED_PARAM_KEYS = Object.freeze(["reportVersion", "accountId", "route", "rev", "evidenceToken", "manifestToken", "depFingerprint", "serveToken"]);
const TOKEN_RE = /^[\x21-\x7e]+$/;
const validToken = (t) => typeof t === "string" && TOKEN_RE.test(t) && t.length <= LIVE_PARAMS_EXTRA_MAX_CHARS;
const SHADOW_PRUNE_GRACE_MS = 24 * 60 * 60 * 1000 + 60 * 1000; // the 24 h in-flight-safety window + 1 min margin

// ---- typed results (the SAME shapes the dedicated releases return; statusFromRelease classifies them unchanged) -----
const ok = (extra = {}) => ({ code: 0, ok: true, stage: "complete", status: null, leaseLost: false, reason: null, blockerCodes: [], problems: [], ...extra });
// A retryable DEFERRAL (stage 'reconcile' is a RETRYABLE_STAGE -> DEFERRED_DEPENDENCY; LKG preserved).
const defer = (reason, status = "SOURCE_UNAVAILABLE") => ({ code: 1, ok: false, stage: "reconcile", status, leaseLost: false, reason, blockerCodes: [], problems: [reason] });
const DEADLINE = () => defer("deadline-aborted", "DEADLINE_ABORTED");
const contention = (reason) => ({ code: 1, ok: false, stage: "contention", status: "CONTROL_LEASE_LOST", leaseLost: true, reason, blockerCodes: [], problems: [reason] });
// A HARD, non-retryable failure (stage NOT retryable -> FAILED_* + non-green).
const hardFail = (stage, reason) => ({ code: 1, ok: false, stage, status: null, leaseLost: false, reason, blockerCodes: stage.startsWith("derive") ? ["derive:" + reason] : [], problems: [reason] });
// A strictly-newer live / served row won (zero rows written): status NEWER_LIVE is RETRYABLE -> DEFERRED_DEPENDENCY.
const newerLive = (reason = "publish-newer-live", stage = "publish") => ({ code: 1, ok: false, stage, status: "NEWER_LIVE", leaseLost: false, reason, blockerCodes: [], problems: [reason] });
// stampPolicy 'evidence': the exact live row sits at EXACTLY the evidence instant with DIFFERENT content tokens (a content
// input moved without the evidence instant advancing). A typed, ALERT-WORTHY deferral -- never NEWER_LIVE (that would
// read as superseded and hide a real stale row), never published.
export const EVIDENCE_INSTANT_NOT_ADVANCED = "evidence-instant-not-advanced";

// The OPTIONAL route runtime hook publishGuard(unit, prepared, { epoch, bucket, signal }) -> null (proceed) |
// { state, reason } -- run by publishForUnit INSIDE the control window, after verifyLease and immediately before the
// fenced publish; prepared.guard carries the route's resolveBundle `guard` data (equal at b1 and b2). A verdict maps to
// the typed release result with ZERO CAS: NEWER_LIVE EXACTLY like the publish 'newer-live' path (stage 'publish', status
// NEWER_LIVE -> DEFERRED_DEPENDENCY; the reason always matches /newer-live/ so the worker classifies it superseded);
// DEFERRED_DEPENDENCY / DEFERRED_PROVENANCE -> a retryable deferral (the release result vocabulary has no provenance
// state: stage 'reconcile' is DEFERRED_DEPENDENCY in statusFromRelease; the status field keeps the verdict state);
// any other verdict fails closed ('publish-guard-malformed'). Never 'published', never already-current.
export const PUBLISH_GUARD_STATES = Object.freeze(["NEWER_LIVE", "DEFERRED_DEPENDENCY", "DEFERRED_PROVENANCE"]);
export function publishGuardResult(verdict) {
  const state = S(verdict && verdict.state);
  const r = verdict && nb(verdict.reason) ? code(verdict.reason) : "";
  if (state === "NEWER_LIVE") return newerLive(/newer-live/i.test(r) ? r : "publish-newer-live" + (r ? ":" + r : ""), "publish");
  if (state === "DEFERRED_DEPENDENCY") return defer(r || "publish-guard-deferred");
  if (state === "DEFERRED_PROVENANCE") return defer(r || "publish-guard-deferred", "DEFERRED_PROVENANCE");
  return defer("publish-guard-malformed");
}

/** The deterministic priority-partial CYCLE bucket of one (route, target, revision, nonce). */
export function routeCycleBucket({ region, routeId, targetId, revisionId, nonce }) {
  return "priority-partial-" + S(region) + "-" + sha256(JSON.stringify([S(routeId), S(targetId), S(revisionId), S(nonce)])).slice(0, 16);
}

/**
 * The CURRENT L1 evidence token of ONE scope target, computed EXACTLY as the scan computes it (the route's
 * readScopeEvidence over [accountId] + computeRevision, normalized by normalizeRouteRevision), or the route's own
 * readEvidenceToken hook when it has one. `context` carries the SAME scan-level inputs the adapter passes (directory,
 * organizationFingerprint, connectionId). "" when unreadable / ineligible (the caller then defers -- never a guess).
 */
export async function readRouteEvidenceToken({ runtime, unit, accountId, epoch, bucket, signal = null, context = {} } = {}) {
  const ctx = context && typeof context === "object" ? context : {};
  if (typeof runtime.readEvidenceToken === "function") return S(await runtime.readEvidenceToken(unit, { accountId, epoch, bucket, signal, ...ctx }));
  const ev = await runtime.readScopeEvidence({ scope: [accountId], epoch, bucket, signal, ...ctx });
  if (!ev || ev.ok !== true || !(ev.perAccount instanceof Map)) return "";
  const rev = normalizeRouteRevision(runtime.computeRevision({ accountId, evidence: ev.perAccount.get(accountId) || {}, epoch, bucket, ...(ctx.directory !== undefined ? { directory: ctx.directory } : {}) }));
  return rev.eligible === true ? S(rev.evidenceToken) : "";
}

// The supabase.js exports a route RUNTIME may use: READERS only (get* / list*) plus the pure path/sha helpers. Every
// writer (save / publish / upsert / insert / delete / claim / record / reconcile / finalize / open / renew / replace /
// set / reserve / ...) is ABSENT from the facade, so a route module can never reach an unfenced report_snapshots write
// (or any durable write) through the deps it is built with -- the ONLY report write path is this release's fenced
// lineage. (The facade is a convention over the deps, not a sandbox: a route module's OWN imports are proven by the
// closure / writer-fence scans. The one known non-report durable write is the fba-plan route's OPTIONAL postPublish
// hook -- the existing zero-export FBA SKU-ownership backfill, scoped to the ONE published account, the same step the
// paid fba-plan release runs after a publish; it never touches report_snapshots.)
const ROUTE_READER_NAME_RE = /^(get|list)[A-Z][A-Za-z0-9]*$/;
export const ROUTE_PURE_SUPABASE_HELPERS = Object.freeze(["sourceSnapshotObjectPath", "sourceSnapshotPayloadSha", "inlinePayloadUsable", "isSchemaMissingError", "isSafeSnapshotRev"]);
/** A frozen READ-ONLY facade over a supabase.js namespace (readers + pure helpers only; fail closed on anything else). */
export function readOnlySupabase(ns) {
  const out = {};
  for (const [name, fn] of Object.entries(ns && typeof ns === "object" ? ns : {})) {
    if (typeof fn !== "function") continue;
    if (ROUTE_READER_NAME_RE.test(name) || ROUTE_PURE_SUPABASE_HELPERS.includes(name)) out[name] = fn;
  }
  return Object.freeze(out);
}

/**
 * The digest of a payload's STORED canonical JSON (content identity without ever carrying the payload). The payload is
 * first reduced to the form storage keeps -- a JSON round-trip: undefined-valued keys dropped, Dates / toJSON values
 * serialized, non-finite numbers null -- so an in-memory derive and its stored / hydrated copy (report_snapshots jsonb
 * or the storage object) digest IDENTICALLY. Every content comparison in this release goes through this ONE function.
 */
export function payloadDigest(payload) {
  const text = JSON.stringify(payload === undefined ? null : payload);
  return sha256(stableJson(text === undefined ? null : JSON.parse(text)));
}

/**
 * The shared publisher-grade live read-back (the SAME proof body as source-priority-release-runner.js buildLiveReadback,
 * built directly on the leaf live-promoted-resolver.js so the route CLI never imports the priority release graph):
 * { reportKey, liveReportKey, accountId, paramsHash, signal? } -> { ok } | { ok:false, reason }.
 */
export function buildRouteLiveReadback(deps = {}) {
  const resolve = buildLivePromotedResolver(deps);
  return async ({ reportKey, liveReportKey, accountId, paramsHash, signal = null }) => {
    const r = await resolve({ reportKey, liveReportKey, accountId, paramsHash, signal });
    return r && r.ok === true ? { ok: true } : { ok: false, reason: r ? r.reason : "resolver-null" };
  };
}

// The job lineage covers these deps + content deps REGARDLESS of `validated` (a crashed, not-yet-reconciled job still
// records the lineage it was inserted with) -- used ONLY to recognise this revision's own in-flight cycle.
function lineageCovers(job, dependsOn, durableContentDeps) {
  if (!job) return false;
  const have = new Set((Array.isArray(job.dependsOn) ? job.dependsOn : []).map(S));
  const haveC = new Set((Array.isArray(job.durableContentDeps) ? job.durableContentDeps : []).map(S));
  return dependsOn.every((h) => have.has(S(h))) && durableContentDeps.every((h) => haveC.has(S(h)));
}

// The shadow params' CONTENT tokens equal a resolved bundle's (manifest + the optional dep fingerprint / serve token;
// an absent optional token equals only an absent one). The resume gate: a shadow of the same revision whose content
// tokens drifted is a DIFFERENT derivation (its params hash differs) and is never resumed.
const optTok = (v) => (v == null ? "" : S(v));
function bundleTokensMatch(params, b) {
  return !!params && !!b && S(params.manifestToken) === S(b.manifestToken)
    && optTok(params.depFingerprint) === optTok(b.depFingerprint) && optTok(params.serveToken) === optTok(b.serveToken);
}

// A route's OPTIONAL publish-guard data (resolveBundle's `guard`: plain JSON, e.g. the inventory as-of + component
// validated_at stamps its "never go backwards" check compared) -> { ok, value, text }: `value` is the JSON round-trip
// (exactly what prepare carries to publish as prepared.guard), `text` its canonical form (the b1 / b2 equality). Absent
// -> { value: null } and NO prepared.guard key (a route without a guard is byte-identical).
function guardDataOf(b) {
  if (!b || b.guard == null) return { ok: true, value: null, text: "null" };
  let value;
  try { const s = JSON.stringify(b.guard); value = s === undefined ? null : JSON.parse(s); } catch { return { ok: false, value: null, text: "" }; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, value: null, text: "" };
  return { ok: true, value, text: stableJson(value) };
}

// A route's identityParams: a plain object of JSON-safe scalar / string-array values that never touches a reserved key.
function identityParamsOk(p) {
  if (!p || typeof p !== "object" || Array.isArray(p)) return false;
  const proto = Object.getPrototypeOf(p);
  if (proto !== Object.prototype && proto !== null) return false;
  return Object.entries(p).every(([k, v]) => !RESERVED_PARAM_KEYS.includes(k)
    && (typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))
      || (Array.isArray(v) && v.every((x) => typeof x === "string"))));
}

/**
 * Build the generic two-phase release of ONE route. `route` is the validated CLI-side declaration { id, publisherKey,
 * stampPolicy }; `runtime` is its build(deps) result (validated here); `deps` are the injected collaborators:
 *   openCycle / getCycleByBucketDate / claimCycle / readCycle(cycleId) / upsertReportJob / claimLease / saveShadow /
 *   reconcileSuccess / finalizeCycle        -- the SAME sync_cycles + sync_report_jobs + shadow CAS wrappers the
 *                                              dedicated releases use (supabase.js), all signal-threaded;
 *   readLatestJob(reportKey, targetId)      -- getLatestReportJobLineage (id / cycleId / createdAt mapped, WP2);
 *   readSnapshot({ reportKey, accountId, paramsHash }) / loadStoragePayload(path)  -- exact reads + storage hydration;
 *   publisherFor(signal) -> { preflight, publish }   (buildSchedulerV2Publisher, fenced on the window's lease);
 *   verifyLease({ signal }) -> { ok, reason? } ; readbackLive(args) -> { ok, reason? } (buildRouteLiveReadback);
 *   liveContracts / reportDerivations / computeHash (paramsHashFor);
 *   readTargetEvidenceToken(unit, { accountId, epoch, bucket, signal }) -> the CURRENT L1 token (default:
 *     readRouteEvidenceToken over `evidenceContext` -- the scan's own directory / organizationFingerprint /
 *     connectionId, so the publish-time token is computed EXACTLY as the scan's);
 *   publishSnapshotUpdate?(args) ; pruneShadows?(args, { signal }) (deleteRouteShadowSnapshots) + prune:boolean ;
 *   now() ; leaseSeconds ; maxSnapshotBytes ; snapshotBytes(payload) ; log.
 */
export function buildRoutePublicationRelease({ route, runtime, deps = {} } = {}) {
  if (!route || !ROUTE_ID_RE.test(S(route.id))) throw new Error("buildRoutePublicationRelease requires a route with a valid id (fail closed).");
  const routeId = route.id;
  const publisherKey = S(route.publisherKey);
  if (!nb(publisherKey)) throw new Error("buildRoutePublicationRelease requires route.publisherKey (fail closed).");
  if (route.stampPolicy !== "cycle" && route.stampPolicy !== "evidence") throw new Error("buildRoutePublicationRelease requires stampPolicy 'cycle' | 'evidence' (fail closed).");
  validateRouteRuntime(runtime, routeId);
  const {
    openCycle, getCycleByBucketDate, claimCycle, readCycle, upsertReportJob, claimLease, saveShadow, reconcileSuccess, finalizeCycle,
    readLatestJob, readSnapshot, loadStoragePayload, publisherFor, verifyLease, readbackLive,
    liveContracts, reportDerivations, computeHash,
    readTargetEvidenceToken = null, evidenceContext = {}, publishSnapshotUpdate = null, pruneShadows = null, prune = false,
    now = () => Date.now(), leaseSeconds = 300, maxSnapshotBytes = MAX_SNAPSHOT_BYTES, snapshotBytes = snapshotByteSize,
    log = () => {},
  } = deps;
  for (const [name, fn] of [["openCycle", openCycle], ["getCycleByBucketDate", getCycleByBucketDate], ["claimCycle", claimCycle], ["readCycle", readCycle], ["upsertReportJob", upsertReportJob], ["claimLease", claimLease], ["saveShadow", saveShadow], ["reconcileSuccess", reconcileSuccess], ["finalizeCycle", finalizeCycle], ["readLatestJob", readLatestJob], ["readSnapshot", readSnapshot], ["loadStoragePayload", loadStoragePayload], ["publisherFor", publisherFor], ["verifyLease", verifyLease], ["readbackLive", readbackLive], ["computeHash", computeHash]]) {
    if (typeof fn !== "function") throw new Error(`buildRoutePublicationRelease requires ${name} (fail closed).`);
  }
  const contract = liveContracts && liveContracts[publisherKey];
  const derivation = reportDerivations && reportDerivations[publisherKey];
  if (!contract || typeof contract.liveParams !== "function") throw new Error(`buildRoutePublicationRelease: no live contract for '${publisherKey}' (fail closed).`);
  if (!derivation || !nb(derivation.snapshotVersion) || typeof derivation.validatePayload !== "function") throw new Error(`buildRoutePublicationRelease: no report derivation for '${publisherKey}' (fail closed).`);
  if (prune && typeof pruneShadows !== "function") throw new Error("buildRoutePublicationRelease: prune requires pruneShadows (fail closed).");
  const SHADOW_KEY = "scheduler-v2/" + publisherKey;
  const SHADOW_VERSION = S(derivation.snapshotVersion);
  const servedVerdict = typeof runtime.servedVerdict === "function" ? runtime.servedVerdict : defaultServedVerdict;
  const asOfField = contractAsOfField(contract);
  if (asOfField === undefined) throw new Error(`buildRoutePublicationRelease: the '${publisherKey}' live contract has a malformed asOfField (fail closed).`);
  // The identity as-of a live identity binds (null for an asOfField:null contract, e.g. brand-view-brands).
  const identityAsOfOf = (liveParams) => (asOfField === null ? null : S(liveParams && liveParams[asOfField]));
  // A unit bound at unit.targetAsOf can only be served by a live identity at EXACTLY that as-of (dated contracts).
  const asOfBinds = (liveParams, unit) => asOfField === null || unit == null || unit.targetAsOf == null || identityAsOfOf(liveParams) === S(unit.targetAsOf);

  // The CURRENT L1 evidence token for a unit's scope target (computed exactly as the scan computes it).
  async function currentEvidenceToken(unit, { accountId, epoch, bucket, signal }) {
    if (typeof readTargetEvidenceToken === "function") return S(await readTargetEvidenceToken(unit, { accountId, epoch, bucket, signal }));
    return readRouteEvidenceToken({ runtime, unit, accountId, epoch, bucket, signal, context: evidenceContext });
  }

  async function hydrate(row, signal) {
    if (!row) return null;
    const path = S(row.payload_storage_path);
    if (path) { try { return await loadStoragePayload(path, { signal }); } catch { return null; } }
    return row.payload == null ? null : row.payload;
  }

  // The live identity a shadow's params promote to (the publisher's own derivation). null when underivable.
  function liveIdentityOf(params, targetId) {
    let liveParams;
    try { liveParams = contract.liveParams(params); } catch { liveParams = null; }
    if (!liveParams || typeof liveParams !== "object") return null;
    const extra = contractLiveParamsExtra(contract, params, liveParams);
    if (!extra.ok) return null;
    const liveAcct = contractLiveAccountId(contract, params, targetId);
    if (liveAcct == null) return null;
    return { liveParams, extra: extra.extra, liveAccountId: liveAcct, liveParamsHash: computeHash(contract.liveReportVersion, liveParams), liveReportKey: contract.liveReportKey };
  }

  // A shadow row at `paramsHash` that the publisher would accept AND that IS this route's derivation of `revisionId`
  // (route + rev + evidence token in its params). -> { ok, row, params, payload } | { ok:false, reason }
  async function validShadowAt(paramsHash, { targetId, revisionId, evidenceToken, signal }) {
    let row;
    try { row = await readSnapshot({ reportKey: SHADOW_KEY, accountId: targetId, paramsHash }, { signal }); } catch { row = null; }
    if (!row) return { ok: false, reason: "shadow-missing" };
    const params = row.params && typeof row.params === "object" && !Array.isArray(row.params) ? row.params : null;
    if (S(row.report_key) !== SHADOW_KEY || S(row.account_id) !== S(targetId) || !params) return { ok: false, reason: "shadow-identity" };
    if (S(params.accountId) !== S(targetId) || S(params.reportVersion) !== SHADOW_VERSION) return { ok: false, reason: "shadow-params-identity" };
    if (S(computeHash(params.reportVersion, params)) !== S(row.params_hash) || S(row.params_hash) !== S(paramsHash)) return { ok: false, reason: "shadow-hash-provenance" };
    if (!nb(row.source_refreshed_at)) return { ok: false, reason: "shadow-refresh-blank" };
    if (S(params.route) !== routeId || S(params.rev) !== S(revisionId) || S(params.evidenceToken) !== S(evidenceToken) || !validToken(params.manifestToken)) return { ok: false, reason: "shadow-not-this-revision" };
    if (!contractTargetIdentityOk(contract, params, targetId)) return { ok: false, reason: "shadow-target-identity" };
    const payload = await hydrate(row, signal);
    if (payload == null) return { ok: false, reason: "shadow-payload-unavailable" };
    let valid = false;
    try { valid = derivation.validatePayload(payload) === true && payload.dataUnavailable !== true; } catch { valid = false; }
    if (!valid) return { ok: false, reason: "shadow-payload-invalid" };
    return { ok: true, row, params, payload };
  }

  // The served selection + its verdict against an expected canonical row identity.
  async function servedCheckAgainst(unit, expected, { epoch, bucket, signal }) {
    let served;
    try { served = await runtime.servedSelector(unit, { epoch, bucket, signal }); } catch { served = { row: null, reason: "read-failed", via: null }; }
    if (!served || typeof served !== "object") served = { row: null, reason: "selector-malformed", via: null };
    let verdict;
    try { verdict = servedVerdict(served, expected, { unit, epoch, bucket }); } catch { verdict = { ok: false, fixable: false, reason: "verdict-threw" }; }
    if (!verdict || typeof verdict !== "object") verdict = { ok: false, fixable: false, reason: "verdict-malformed" };
    return { served, verdict };
  }

  /**
   * THE ALREADY-CURRENT PROOF (owner rule): a unit whose write was REFUSED (shadow newer-live, live newer-live), whose
   * evidence is not newer than the served row, or whose prepare wrote nothing new counts as already-current ONLY when
   * ALL THREE hold -- otherwise the caller returns a real typed deferral / failure, never 'published':
   *   (i)   CONTENT IDENTITY: the live row at the exact live identity carries EXACTLY this derivation's stored tokens
   *         (liveParamsExtraMatches: evidence / manifest / serve / dep tokens) AND its hydrated payload digest equals
   *         this derivation's payload digest (a contract with no stored tokens can never prove it);
   *   (ii)  LINEAGE: the LATEST job for (publisherKey, targetId) is promotable, carries THIS shadow params hash, and its
   *         lineage covers this evidence (deps + [evidenceToken, manifestToken]);
   *   (iii) READ-BACK: the shared publisher-grade live read-back passes AND the route's served selector returns EXACTLY
   *         that live row.
   * Timestamp equality alone never counts. With exactShadowStamp (the ZERO-CAS fast paths of a prepare that wrote
   * nothing new) the live stamp must ALSO equal the latest promotable shadow's stamp -- the exact binding + verify
   * compare them ('live-refresh-differs'), so a proof without it would call current what verify calls STALE forever;
   * such a unit instead goes through the fenced publish (check 'stamp').
   * -> { ok:true, live } | { ok:false, check: 'content'|'lineage'|'stamp'|'readback', reason }
   */
  async function proveAlreadyCurrent(p, unit, { epoch, bucket, signal }, { exactShadowStamp = false } = {}) {
    const fail = (check, reason) => ({ ok: false, check, reason });
    if (typeof contract.liveParamsExtra !== "function") return fail("content", "no-stored-tokens");
    let live;
    try { live = await readSnapshot({ reportKey: p.liveReportKey, accountId: p.liveAccountId, paramsHash: p.liveParamsHash }, { signal }); } catch { live = null; }
    if (!live) return fail("content", "live-missing");
    if (S(live.report_key) !== S(p.liveReportKey) || S(live.account_id) !== S(p.liveAccountId) || S(live.params_hash) !== S(p.liveParamsHash)) return fail("content", "live-identity");
    if (!liveParamsExtraMatches(contract, p.liveExtra, live)) return fail("content", "tokens-differ");
    const hydLive = await hydrate(live, signal);
    if (hydLive == null) return fail("content", "live-payload-unavailable");
    if (payloadDigest(hydLive) !== S(p.payloadDigest)) return fail("content", "payload-differs");
    let job = null;
    try { job = await readLatestJob(publisherKey, p.targetId, { signal }); } catch { job = null; }
    if (!jobIsPromotable(job) || S(job.snapshotParamsHash) !== S(p.shadowParamsHash) || !revisionCoveredByJob({ eligible: true, deps: p.dependsOn, contentDeps: p.durableContentDeps }, job)) return fail("lineage", "latest-job-not-this-evidence");
    if (exactShadowStamp) {
      // The latest promotable job's shadow (p.shadowParamsHash, proven just above) -- its stamp, read NOW.
      let sh = null;
      try { sh = await readSnapshot({ reportKey: SHADOW_KEY, accountId: p.targetId, paramsHash: p.shadowParamsHash }, { signal }); } catch { sh = null; }
      if (!sh || !nb(sh.source_refreshed_at)) return fail("stamp", "shadow-unreadable");
      if (S(live.source_refreshed_at) !== S(sh.source_refreshed_at)) return fail("stamp", "live-refresh-differs");
    }
    let rb;
    try { rb = await readbackLive({ reportKey: publisherKey, liveReportKey: p.liveReportKey, accountId: p.liveAccountId, paramsHash: p.liveParamsHash, signal }); } catch (e) { rb = { ok: false, reason: "readback-threw:" + errMsg(e) }; }
    if (!rb || rb.ok !== true) return fail("readback", "live-readback:" + code(rb && rb.reason));
    const liveIdentity = servedRowIdentity(live);
    const { verdict } = await servedCheckAgainst(unit, liveIdentity, { epoch, bucket, signal });
    if (verdict.ok !== true) return fail("readback", "served:" + code(verdict.reason));
    return { ok: true, live: liveIdentity };
  }

  // The prepared result (the two-phase contract: ok + prepared + code 0) carrying everything publish needs.
  const preparedResult = (fields) => ({ code: 0, ok: true, prepared: true, stage: "prepared", status: null, leaseLost: false, reason: null, blockerCodes: [], problems: [], routeId, publisherKey, ...fields });

  async function prepareForUnit({ unit, revision, epoch, region, bucket, signal } = {}) {
    const aborted = () => !!(signal && signal.aborted);
    const opt = { signal };
    if (aborted()) return DEADLINE();
    const reg = S(region || bucket);
    const targetId = unit && typeof unit.targetId === "string" ? unit.targetId : "";
    if (!ROUTE_REGIONS.includes(reg) || !isCalendarDate(epoch) || !nb(targetId) || targetId !== targetId.trim() || !unit || !nb(unit.liveAccountId)) return hardFail("derive", "bad-args");
    if (!revision || revision.eligible !== true || !nb(revision.revisionId) || !validToken(revision.evidenceToken)) return hardFail("derive", "bad-revision");
    const revisionId = S(revision.revisionId);
    const evidenceToken = S(revision.evidenceToken);
    const ctx = { strict: true, epoch, bucket: reg, revision, signal };

    // (1) the latest job for (publisherKey, targetId): the resume candidate AND the cycle nonce (step 5).
    let latest = null;
    try { latest = await readLatestJob(publisherKey, targetId, opt); }
    catch (e) { return defer("lineage-read-threw:" + errMsg(e)); }
    if (aborted()) return DEADLINE();

    // (2) resolve the unit's dependency bundle at entry (strict) -- the revision must be the one the scan classified.
    let b1;
    try { b1 = await runtime.resolveBundle(unit, ctx); }
    catch (e) { return defer("bundle-resolve-threw:" + errMsg(e)); }
    if (aborted()) return DEADLINE();
    if (!b1 || b1.eligible !== true) return defer("bundle-" + code(b1 && b1.reason));
    if (S(b1.revisionId) !== revisionId || S(b1.evidenceToken) !== evidenceToken) return defer("revision-advanced-at-entry");
    if (!validToken(b1.manifestToken)) return hardFail("derive", "manifest-token-invalid");
    const manifestToken = S(b1.manifestToken);
    // The route's optional publish-guard data rides EVERY prepared result (resumed / already-current / written) so the
    // publish phase's publishGuard can compare the CURRENT live row against what this prepare resolved.
    const g1 = guardDataOf(b1);
    if (!g1.ok) return hardFail("derive", "guard-invalid");
    const guardField = g1.value != null ? { guard: g1.value } : {};

    // (1b) RESUME: this exact revision's derivation already completed (terminal cycle, promotable job, valid shadow)
    // AND its shadow carries EXACTLY the freshly resolved bundle's content tokens (manifest / dep fingerprint / serve
    // token -- a manifest drift under an unchanged revision is never resumed: the fresh derive below writes a NEW
    // content-addressed shadow, the tokens being part of its params hash) AND its live identity still binds this unit
    // (same live account; for a dated contract the SAME identity as-of the scan bound the unit at: a shadow of an
    // earlier identity as-of is never resumed -- the fresh derive then derives the rolled identity or defers
    // 'asof-rolled').
    if (jobIsPromotable(latest) && revisionCoveredByJob(revision, latest)) {
      const sh = await validShadowAt(S(latest.snapshotParamsHash), { targetId, revisionId, evidenceToken, signal });
      if (aborted()) return DEADLINE();
      if (sh.ok && bundleTokensMatch(sh.params, b1)) {
        const id = liveIdentityOf(sh.params, targetId);
        if (!id || S(id.liveAccountId) !== S(unit.liveAccountId)) return hardFail("derive", "resume-live-identity-mismatch");
        if (asOfBinds(id.liveParams, unit)) {
          return preparedResult({
            targetId, resumed: true, alreadyCurrent: false, shadowOutcome: "resumed", cycleId: S(latest.cycleId), revisionId, evidenceToken,
            manifestToken: S(sh.params.manifestToken), shadowParamsHash: S(latest.snapshotParamsHash), sourceRefreshedAt: S(sh.row.source_refreshed_at),
            dependsOn: (latest.dependsOn || []).map(S), durableContentDeps: (latest.durableContentDeps || []).map(S),
            payloadDigest: payloadDigest(sh.payload), liveReportKey: id.liveReportKey, liveAccountId: id.liveAccountId, liveParamsHash: id.liveParamsHash, liveExtra: id.extra,
            ...guardField,
          });
        }
      }
    }
    let asOf1 = null;
    if (typeof runtime.identityAsOf === "function") {
      try { asOf1 = runtime.identityAsOf(unit, { bundle: b1.bundle, epoch, now: now() }); } catch (e) { return defer("identity-asof-threw:" + errMsg(e)); }
    }

    // (3) DERIVE from THAT exact bundle; the REAL payload contract gates it.
    if (aborted()) return DEADLINE();
    let derived;
    try { derived = await runtime.derive(b1.bundle, { unit, epoch, bucket: reg, strict: true, signal }); }
    catch (e) { return hardFail("derive", "derive-threw:" + errMsg(e)); }
    if (aborted()) return DEADLINE();
    if (!derived || typeof derived !== "object") return hardFail("derive", "derive-malformed");
    if (derived.notReady) return defer("derive-not-ready:" + code(derived.reason));
    const payload = derived.payload;
    if (!payload || typeof payload !== "object") return hardFail("derive", "payload-malformed");
    let valid = false;
    try { valid = derivation.validatePayload(payload) === true; } catch { valid = false; }
    if (!valid) return hardFail("derive", "payload-invalid");
    if (payload.dataUnavailable === true) return defer("data-unavailable"); // never promoted over the live LKG
    const payloadBytes = snapshotBytes(payload);
    if (!(Number(payloadBytes) <= Number(maxSnapshotBytes))) return hardFail("derive", "payload-too-large");

    // (4) TOCTOU re-resolve immediately before the first write.
    if (aborted()) return DEADLINE();
    let b2;
    try { b2 = await runtime.resolveBundle(unit, ctx); }
    catch (e) { return defer("bundle-recheck-threw:" + errMsg(e)); }
    if (aborted()) return DEADLINE();
    if (!b2 || b2.eligible !== true || S(b2.revisionId) !== revisionId || S(b2.evidenceToken) !== evidenceToken) return defer("revision-advanced-before-write");
    if (S(b2.manifestToken) !== manifestToken) return defer("manifest-advanced-before-write");
    // The publish-guard data must be the SAME at both reads (a guard component that moved mid-derive = a new revision).
    const g2 = guardDataOf(b2);
    if (!g2.ok || g2.text !== g1.text) return defer("revision-advanced-before-write");
    if (typeof runtime.identityAsOf === "function") {
      let asOf2;
      try { asOf2 = runtime.identityAsOf(unit, { bundle: b2.bundle, epoch, now: now() }); } catch (e) { return defer("identity-asof-threw:" + errMsg(e)); }
      if (S(asOf2) !== S(asOf1)) return defer("asof-rolled");
    }

    // Shadow params + PUBLISHER-IDENTICAL pre-checks (zero writes on any failure).
    let idp;
    try { idp = runtime.identityParams(unit, { bundle: b1.bundle, epoch }); } catch (e) { return hardFail("derive", "identity-params-threw:" + errMsg(e)); }
    if (!identityParamsOk(idp)) return hardFail("derive", "identity-params-invalid");
    for (const [k, v] of [["depFingerprint", b1.depFingerprint], ["serveToken", b1.serveToken]]) {
      if (v != null && !validToken(v)) return hardFail("derive", k + "-invalid");
      if (S(b2[k] == null ? "" : b2[k]) !== S(v == null ? "" : v)) return defer("manifest-advanced-before-write");
    }
    const params = {
      reportVersion: SHADOW_VERSION, accountId: targetId, ...idp, route: routeId, rev: revisionId, evidenceToken, manifestToken,
      ...(b1.depFingerprint != null ? { depFingerprint: S(b1.depFingerprint) } : {}),
      ...(b1.serveToken != null ? { serveToken: S(b1.serveToken) } : {}),
    };
    const shadowParamsHash = S(computeHash(SHADOW_VERSION, params));
    if (!contractTargetIdentityOk(contract, params, targetId)) return hardFail("derive", "target-identity-mismatch");
    const id = liveIdentityOf(params, targetId);
    if (!id) return hardFail("derive", "live-identity-underivable");
    if (S(id.liveAccountId) !== S(unit.liveAccountId)) return hardFail("derive", "live-account-mismatch");
    // The scan bound this unit at unit.targetAsOf: a different identity as-of can never bind -> the identity rolled.
    if (!asOfBinds(id.liveParams, unit)) return defer("asof-rolled");
    if (typeof contract.semanticIdentity === "function") {
      let sem;
      try { sem = contract.semanticIdentity(payload, { accountId: id.liveAccountId, to: id.liveParams.to, liveParams: id.liveParams }); } catch { sem = null; }
      if (!sem || sem.ok !== true) return hardFail("derive", "semantic-identity:" + code(sem && sem.reason));
    }
    const dependsOn = [...new Set((Array.isArray(b2.deps) ? b2.deps : []).map(S).filter(nb))].sort();
    const durableContentDeps = [...new Set([evidenceToken, manifestToken])];
    // The job this prepare writes MUST cover the scan's revision -- else the binding would call it stale forever.
    if (!revisionCoveredByJob(revision, { validated: true, dependsOn, durableContentDeps })) return hardFail("derive", "lineage-would-not-cover-revision");
    const digest = payloadDigest(payload);
    const base = {
      targetId, revisionId, evidenceToken, manifestToken, shadowParamsHash, dependsOn, durableContentDeps, payloadDigest: digest,
      liveReportKey: id.liveReportKey, liveAccountId: id.liveAccountId, liveParamsHash: id.liveParamsHash, liveExtra: id.extra,
      identityAsOf: identityAsOfOf(id.liveParams),
      ...guardField,
    };

    // STAMP. 'evidence': the evidence instant (never the wall clock), and never over an equal-or-fresher row: neither the
    // live row at this EXACT live identity (the CAS target) nor the SERVED row for this report + live account (what the
    // page shows -- e.g. a fresher paid row) may be as fresh as the evidence. Such a unit is already-current ONLY with
    // content identity + lineage + served read-back (proveAlreadyCurrent); otherwise a typed NEWER_LIVE deferral. Zero
    // writes either way (fresher data is never overwritten, and a timestamp alone never counts as current).
    let sourceRefreshedAt = null;
    if (route.stampPolicy === "evidence") {
      const ei = S(b2.evidenceInstant);
      if (S(b1.evidenceInstant) !== ei) return defer("manifest-advanced-before-write");
      const t = Date.parse(ei);
      if (!nb(ei) || !Number.isFinite(t)) return hardFail("derive", "evidence-instant-invalid");
      if (t > Number(now())) return hardFail("derive", "evidence-instant-future");
      sourceRefreshedAt = ei;
      let exactLive = null;
      try { exactLive = await readSnapshot({ reportKey: id.liveReportKey, accountId: id.liveAccountId, paramsHash: id.liveParamsHash }, { signal }); } catch { exactLive = null; }
      if (aborted()) return DEADLINE();
      let served = null;
      try { served = await runtime.servedSelector(unit, { epoch, bucket: reg, signal }); } catch { served = null; }
      if (aborted()) return DEADLINE();
      const servedRow = served && served.row && S(served.row.report_key) === S(id.liveReportKey) && S(served.row.account_id) === S(id.liveAccountId) ? served.row : null;
      const stampOf = (row) => (row ? Date.parse(S(row.source_refreshed_at)) : NaN);
      const liveStamp = stampOf(exactLive);
      const servedStamp = stampOf(servedRow);
      const liveNotOlder = Number.isFinite(liveStamp) && liveStamp >= t;
      const servedNotOlder = Number.isFinite(servedStamp) && servedStamp >= t;
      if (liveNotOlder || servedNotOlder) {
        const proof = await proveAlreadyCurrent({ ...base }, unit, { epoch, bucket: reg, signal });
        if (aborted()) return DEADLINE();
        if (proof.ok) return preparedResult({ ...base, resumed: false, alreadyCurrent: true, shadowOutcome: "not-written", cycleId: null, sourceRefreshedAt });
        // NOT NEWER: the exact live row sits at EXACTLY this evidence instant (nothing live / served is strictly newer)
        // but carries DIFFERENT content tokens than this derivation -- the same instant with different content, i.e. a
        // content input (e.g. a manifest drift under an unchanged revision) moved WITHOUT the route's evidenceInstant
        // advancing (the stampPolicy 'evidence' contract). That is not "newer live data won": reporting it NEWER_LIVE
        // would be classified superseded and hide a real stale row forever. A distinct typed, alert-worthy DEFERRAL
        // (DEFERRED_DEPENDENCY via stage 'reconcile'; zero writes, never published): the unit converges once the evidence
        // instant advances. A strictly-newer live / served row stays NEWER_LIVE (unchanged).
        const strictlyNewer = (Number.isFinite(liveStamp) && liveStamp > t) || (Number.isFinite(servedStamp) && servedStamp > t);
        if (!strictlyNewer && liveStamp === t && typeof contract.liveParamsExtra === "function" && !liveParamsExtraMatches(contract, base.liveExtra, exactLive)) {
          return defer(EVIDENCE_INSTANT_NOT_ADVANCED, "EVIDENCE_INSTANT_NOT_ADVANCED");
        }
        return newerLive(liveNotOlder ? "evidence-not-newer-than-live" : "evidence-not-newer-than-served", "reconcile");
      }
    }

    // (5) the dedicated cycle (FIRST WRITE). A crashed in-flight prepare of THIS derivation (the latest job not
    // promotable, its cycle still running/pending on this epoch, its lineage covering this evidence) resumes its own
    // running cycle (precedence). Otherwise the nonce is the LATEST job id whether or not that job is promotable, and
    // 'none' ONLY when the target has no job at all: a non-promotable latest job of ANOTHER revision (e.g. a prepare
    // killed after its job insert) must never send this revision back to its own old 'none' / earlier-nonce cycle,
    // which is TERMINAL and belongs to a job that is no longer the latest (resume would fail -> 'cycle-not-running'
    // forever while live keeps stale content). Every job insert changes the latest id, so this bucket is always fresh.
    let cycleBucket = null;
    if (latest && !jobIsPromotable(latest) && nb(latest.cycleId) && (S(latest.cycleStatus) === "running" || S(latest.cycleStatus) === "pending") && lineageCovers(latest, dependsOn, durableContentDeps)) {
      let cyc = null;
      try { cyc = await readCycle(S(latest.cycleId), opt); } catch { cyc = null; }
      if (aborted()) return DEADLINE();
      const cb = S(cyc && cyc.bucket);
      if (cyc && PARTIAL_BUCKET_RE.test(cb) && cb.startsWith("priority-partial-" + reg + "-") && S(cyc.cycle_date).slice(0, 10) === epoch && (S(cyc.status) === "running" || S(cyc.status) === "pending")) cycleBucket = cb;
    }
    if (!cycleBucket) {
      if (latest && !nb(latest.id)) return defer("lineage-id-missing");
      cycleBucket = routeCycleBucket({ region: reg, routeId, targetId, revisionId, nonce: latest ? S(latest.id) : "none" });
    }
    // TOCTOU: the latest job must still be the one step (1) read (the nonce / resume decision above rests on it) -- a
    // prepare of another revision (or a concurrent twin) that wrote lineage meanwhile makes this derivation's bucket
    // stale: DEFER with ZERO writes (the next pass nonces over the new latest job). Re-checked before the job upsert.
    const lineageMoved = async () => {
      let now2 = null;
      try { now2 = await readLatestJob(publisherKey, targetId, opt); } catch (e) { return defer("lineage-read-threw:" + errMsg(e)); }
      if (aborted()) return DEADLINE();
      if ((now2 == null) !== (latest == null) || S(now2 && now2.id) !== S(latest && latest.id)) return defer("lineage-advanced-before-write");
      return null;
    };
    if (aborted()) return DEADLINE();
    const movedBeforeOpen = await lineageMoved();
    if (movedBeforeOpen) return movedBeforeOpen;
    try { await openCycle({ bucket: cycleBucket, cycleDate: epoch, trigger: "manual" }, opt); }
    catch (e) { return defer("cycle-open-threw:" + errMsg(e)); }
    if (aborted()) return DEADLINE();
    let cycle;
    try { cycle = await getCycleByBucketDate(cycleBucket, epoch, opt); }
    catch (e) { return defer("cycle-read-threw:" + errMsg(e)); }
    if (aborted()) return DEADLINE();
    if (!cycle || !nb(S(cycle.id))) return defer("cycle-unresolved");
    const cycleId = S(cycle.id);
    if (route.stampPolicy === "cycle") {
      sourceRefreshedAt = S(cycle.created_at ?? cycle.createdAt);
      if (!nb(sourceRefreshedAt)) return defer("cycle-refresh-blank");
    }
    if (aborted()) return DEADLINE();
    let claimed;
    try { claimed = await claimCycle(cycleId, opt); }
    catch (e) { return defer("cycle-claim-threw:" + errMsg(e)); }
    let resumed = false;
    if (claimed !== true) {
      let recheck;
      try { recheck = await getCycleByBucketDate(cycleBucket, epoch, opt); }
      catch (e) { return defer("cycle-reclaim-read-threw:" + errMsg(e)); }
      const cycleStatus = S(recheck && recheck.status);
      if (cycleStatus !== "running") {
        if (cycleStatus !== "succeeded" && cycleStatus !== "partial") return defer("cycle-not-running:" + cycleStatus);
        if (aborted()) return DEADLINE();
        let latest2 = null;
        try { latest2 = await readLatestJob(publisherKey, targetId, opt); } catch { latest2 = null; }
        if (aborted()) return DEADLINE();
        if (!resumableAtTerminalCycle(latest2, { cycleId, paramsHash: shadowParamsHash, dependsOn, durableContentDeps })) return defer("cycle-not-running:" + cycleStatus);
        resumed = true; // the terminal cycle already holds this derivation's validated job: zero job/shadow/finalize writes
      }
    }

    let shadowOutcome = resumed ? "resumed" : null;
    if (!resumed) {
      if (aborted()) return DEADLINE();
      // TOCTOU re-check immediately BEFORE the job upsert (the first LINEAGE write): a latest job that changed since
      // step (1) defers with no job / shadow / reconcile write. The opened cycle holds no job and no later prepare can
      // ever key it again (its bucket nonces over the superseded latest id), so a cycle THIS prepare claimed would stay
      // 'running' forever -- a phantom stall on the status panel / reaper (and a 'busy' region). It is FINALIZED here
      // through the existing guarded finalize_sync_cycle (20260815): a running cycle with ZERO source + report jobs
      // finalizes 'succeeded' with report_total 0 (no work, nothing failed), after which the terminal-cycle trigger
      // refuses any late child row; a cycle a concurrent same-bucket twin already put its job into returns 'open-work'
      // and stays running for that twin (the RPC re-checks under FOR UPDATE -- it never closes work underneath anyone).
      // Best-effort: a failed / non-terminal finalize leaves the deferral unchanged (logged). Never after an abort.
      const movedBeforeJob = await lineageMoved();
      if (movedBeforeJob) {
        if (claimed === true && movedBeforeJob.reason === "lineage-advanced-before-write" && !aborted()) {
          let fin = null;
          try { fin = await finalizeCycle({ cycleId }, opt); } catch (e) { fin = { disposition: "threw:" + errMsg(e) }; }
          log(`route ${routeId}: empty cycle ${cycleId} finalize after 'lineage-advanced-before-write': ${code((fin && fin.disposition) || "malformed")}`);
        }
        return movedBeforeJob;
      }
      // The report JOB carries the REAL REGION bucket (sync_report_jobs_bucket_check), never the cycle bucket.
      try {
        await upsertReportJob({ cycleId, reportKey: publisherKey, reportVersion: SHADOW_VERSION, accountId: targetId, connectionId: "primary", bucket: reg, dependsOn, durableContentDeps }, opt);
      } catch (e) { return hardFail("derive", "lineage-upsert-threw:" + errMsg(e)); }
      if (aborted()) return DEADLINE();
      let lease;
      try { lease = await claimLease(cycleId, publisherKey, targetId, { leaseSeconds, signal }); }
      catch (e) { return defer("claim-threw:" + errMsg(e)); }
      if (aborted()) return DEADLINE();
      const disp = lease && lease.disposition;
      if (disp === "already-complete") {
        if (S(lease.snapshotParamsHash) !== shadowParamsHash) return hardFail("derive", "already-complete-hash-mismatch");
        shadowOutcome = "already-complete";
      } else if (disp === "held") {
        return defer("claim-held", "SOURCE_READINESS_PENDING");
      } else if ((disp !== "claimed" && disp !== "reclaimed") || !nb(lease.leaseToken)) {
        return hardFail("derive", "claim-" + code(disp || "malformed"));
      }
      if (disp === "claimed" || disp === "reclaimed") {
        if (aborted()) return DEADLINE();
        let cas;
        try { cas = await saveShadow({ reportKey: SHADOW_KEY, accountId: targetId, paramsHash: shadowParamsHash, params, payload, payloadBytes, sourceRefreshedAt }, opt); }
        catch (e) { return hardFail("derive", "shadow-cas-threw:" + errMsg(e)); }
        if (aborted()) return DEADLINE();
        const outcome = cas && cas.outcome;
        if (outcome === "newer-live") {
          // A REFUSED shadow write: a STRICTLY-NEWER shadow already sits at THIS exact params hash -- i.e. the same route,
          // revision, evidence + manifest tokens and identity (the hash is content-addressed over all of them), saved by
          // another cycle. It is never counted current here and never trusted by stamp. It is ADOPTED only when its
          // CONTENT IDENTITY is proven (it passes the full shadow validation AND its hydrated payload digest equals this
          // derivation's): this job's lineage is then reconciled to it + finalized, and the unit STILL goes through the
          // publish phase (preflight -> fenced publish -> live read-back -> served-row check; an identical live row is
          // proven already-current there with content + lineage + read-back). Without the adoption this job -- now the
          // LATEST job for the target -- would stay unfinished forever and block every publisher read of the target (the
          // lineage strand). A same-hash shadow with DIFFERENT content is an integrity failure (typed, never adopted); an
          // unreadable one defers (retryable).
          const ex = await validShadowAt(shadowParamsHash, { targetId, revisionId, evidenceToken, signal });
          if (aborted()) return DEADLINE();
          if (!ex.ok) return defer("shadow-newer-live:" + code(ex.reason));
          if (payloadDigest(ex.payload) !== digest) return hardFail("derive", "shadow-newer-live:content-differs");
          shadowOutcome = "adopted-newer";
          sourceRefreshedAt = S(ex.row.source_refreshed_at);
        } else if (outcome !== "inserted" && outcome !== "replaced" && outcome !== "already-current") {
          return hardFail("derive", "shadow-conflict:" + code(outcome));
        } else {
          shadowOutcome = outcome;
        }
        if (aborted()) return DEADLINE();
        let rec;
        try { rec = await reconcileSuccess({ cycleId, reportKey: publisherKey, accountId: targetId, snapshotParamsHash: shadowParamsHash, leaseToken: lease.leaseToken, latestDataDate: derived.latestDataDate || null }, opt); }
        catch (e) { return hardFail("derive", "reconcile-threw:" + errMsg(e)); }
        if (aborted()) return DEADLINE();
        const rdisp = rec && rec.disposition;
        if (rdisp !== "reconciled" && rdisp !== "already-complete") return hardFail("derive", "reconcile-" + code(rdisp || "malformed"));
      }
      if (aborted()) return DEADLINE();
      let fin;
      try { fin = await finalizeCycle({ cycleId }, opt); }
      catch (e) { return hardFail("finalize", "finalize-threw:" + errMsg(e)); }
      if (aborted()) return DEADLINE();
      const fdisp = fin && fin.disposition;
      if (fdisp !== "finalized" && fdisp !== "already-terminal") return hardFail("finalize", "finalize-" + code(fdisp || "malformed"));
    }
    return preparedResult({ ...base, resumed, alreadyCurrent: false, shadowOutcome, cycleId, sourceRefreshedAt });
  }

  async function publishForUnit({ unit, prepared, epoch, region, bucket, accountId, signal } = {}) {
    const aborted = () => !!(signal && signal.aborted);
    if (aborted()) return DEADLINE();
    const reg = S(region || bucket);
    const p = prepared && typeof prepared === "object" ? prepared : null;
    if (!p || p.prepared !== true || p.routeId !== routeId || p.publisherKey !== publisherKey || !unit || S(p.targetId) !== S(unit.targetId)) return hardFail("publish", "prepared-mismatch");
    const ctx = { epoch, bucket: reg, signal };

    // (1) the route's L1 evidence token must be unchanged since prepare (zero CAS otherwise).
    let tok = "";
    try { tok = await currentEvidenceToken(unit, { accountId: S(accountId || unit.targetId), epoch, bucket: reg, signal }); } catch { tok = ""; }
    if (aborted()) return DEADLINE();
    if (!nb(tok) || tok !== S(p.evidenceToken)) return defer("evidence-advanced");

    // A prepare that PROVED the unit current with zero writes: re-prove now (the live stamp must ALSO equal the latest
    // promotable shadow's -- the binding's exact equality), zero CAS. A proof lost ONLY on the stamp (same content,
    // lineage and tokens; the live row simply is not stamped as the latest shadow) falls through to the fenced publish
    // of that latest shadow: the CAS replaces an OLDER live row (converges verify); a NEWER one is refused and proven
    // below (refused-but-proven) or NEWER_LIVE. Any other lost proof is a retryable deferral.
    if (p.alreadyCurrent === true) {
      const proof = await proveAlreadyCurrent(p, unit, ctx, { exactShadowStamp: true });
      if (aborted()) return DEADLINE();
      if (proof.ok) return ok({ alreadyCurrent: true, disposition: "already-current", served: proof.live });
      if (proof.check !== "stamp") return defer("already-current-lost:" + proof.check);
    }

    // (1b) the publisher publishes the LATEST job's shadow: it must still BE this prepared derivation.
    let job = null;
    try { job = await readLatestJob(publisherKey, p.targetId, { signal }); } catch { job = null; }
    if (aborted()) return DEADLINE();
    if (!jobIsPromotable(job) || S(job.snapshotParamsHash) !== S(p.shadowParamsHash) || !revisionCoveredByJob({ eligible: true, deps: p.dependsOn, contentDeps: p.durableContentDeps }, job)) return defer("lineage-advanced");

    // A prepare that wrote nothing new (resumed / identical or adopted shadow): the live may already BE its promotion ->
    // proven already-current (content + lineage + read-back + the live stamp EQUAL to the latest promotable shadow's)
    // with zero CAS; otherwise the normal fenced publish (a stamp-only difference included: an older live row is then
    // replaced, so the exact binding + verify converge instead of 'live-refresh-differs' forever).
    if (p.resumed === true || p.shadowOutcome === "already-current" || p.shadowOutcome === "already-complete" || p.shadowOutcome === "adopted-newer") {
      const proof = await proveAlreadyCurrent(p, unit, ctx, { exactShadowStamp: true });
      if (aborted()) return DEADLINE();
      if (proof.ok) return ok({ alreadyCurrent: true, disposition: "already-current", served: proof.live });
    }

    // (2) preflight (the SAME gates as publish, no write) + the live identity cross-check.
    const publisher = publisherFor(signal);
    if (!publisher || typeof publisher.preflight !== "function" || typeof publisher.publish !== "function") return hardFail("publish-gates", "publisher-unavailable");
    const sameIdentity = (r) => S(r && r.liveReportKey) === S(p.liveReportKey) && S(r && r.paramsHash) === S(p.liveParamsHash) && S((r && r.liveAccountId) != null ? r.liveAccountId : p.targetId) === S(p.liveAccountId);
    let pf;
    try { pf = await publisher.preflight(publisherKey, p.targetId); }
    catch (e) { return hardFail("publish-gates", "preflight-threw:" + errMsg(e)); }
    if (aborted()) return DEADLINE();
    if (!pf || S(pf.disposition) !== "ready") {
      if (pf && S(pf.disposition) === "lease-lost") return contention("preflight-lease-lost");
      return hardFail("publish-gates", "preflight-" + code(pf && pf.disposition));
    }
    if (!sameIdentity(pf)) return hardFail("publish-gates", "preflight-identity-mismatch");
    // (3) the control lease still holds.
    let fence;
    try { fence = await verifyLease({ signal }); } catch (e) { fence = { ok: false, reason: "renew-threw:" + errMsg(e) }; }
    if (!fence || fence.ok !== true) return contention("lease-lost-before-publish:" + code(fence && fence.reason));
    // (3b) the route's OPTIONAL publishGuard, INSIDE the control window: after verifyLease and IMMEDIATELY before the
    // fenced publish (nothing else awaited in between). The route's "never go backwards" checks otherwise ran only in
    // resolveBundle during PREPARE, which holds no control lease -- a paid publish of NEWER content could land between
    // prepare and this CAS, and an 'evidence' stamp (a MAX over independent components) is no backstop. The paid
    // publisher needs the same lease, so a check here cannot race it. A non-null verdict returns its typed result with
    // ZERO CAS; a throw / malformed verdict defers (fail closed). Absent hook: byte-identical.
    if (typeof runtime.publishGuard === "function") {
      if (aborted()) return DEADLINE();
      let verdict;
      try { verdict = await runtime.publishGuard(unit, p, { epoch, bucket: reg, signal }); }
      catch (e) { return defer("publish-guard-threw:" + errMsg(e)); }
      if (verdict != null) return publishGuardResult(verdict);
    }
    // Immediately BEFORE the live write: an aborted op never starts it (the fenced CAS is the final defense).
    if (aborted()) return DEADLINE();
    // (4) the fenced publish.
    let res;
    try { res = await publisher.publish(publisherKey, p.targetId); }
    catch (e) { return hardFail("publish", "publish-threw:" + errMsg(e)); }
    const pdisp = S(res && res.disposition);
    if (pdisp === "lease-lost") return contention("publish-lease-lost");
    if (pdisp === "newer-live") {
      // A REFUSED live write: already-current ONLY with content + lineage + served read-back, else NEWER_LIVE.
      if (aborted()) return DEADLINE();
      const proof = await proveAlreadyCurrent(p, unit, ctx);
      if (aborted()) return DEADLINE();
      if (proof.ok) return ok({ alreadyCurrent: true, disposition: "refused-newer-live", served: proof.live });
      return newerLive();
    }
    // A writer-fence refusal is typed ':REPORT_WRITER_FENCED:<publisherKey>' (sanitizer-safe) so the worker classifies it
    // INTEGRITY + alert 'writer-fenced' and records the typed event (WP14 final review P2-1) -- never a silent transport retry.
    if (pdisp !== "published" && pdisp !== "already-current") return hardFail("publish", "publish-" + code(pdisp) + (res && res.writerFenced === true ? ":REPORT_WRITER_FENCED:" + publisherKey : ""));
    if (!sameIdentity(res)) return hardFail("publish", "publish-identity-mismatch");

    // (5) the publish LANDED (or was proven identical): the shared publisher-grade live read-back.
    if (aborted()) return DEADLINE();
    let rb;
    try { rb = await readbackLive({ reportKey: publisherKey, liveReportKey: p.liveReportKey, accountId: p.liveAccountId, paramsHash: p.liveParamsHash, signal }); }
    catch (e) { rb = { ok: false, reason: "readback-threw:" + errMsg(e) }; }
    if (aborted()) return DEADLINE();
    if (!rb || rb.ok !== true) return hardFail("readback", "live-readback-failed:" + code(rb && rb.reason));
    // (6) the SERVED row must be EXACTLY the canonical live row (this derivation's promotion).
    let live = null;
    try { live = await readSnapshot({ reportKey: p.liveReportKey, accountId: p.liveAccountId, paramsHash: p.liveParamsHash }, { signal }); } catch { live = null; }
    if (aborted()) return DEADLINE();
    if (!live) return hardFail("readback", "live-row-unreadable");
    if (!liveParamsExtraMatches(contract, p.liveExtra, live)) {
      // The live row carries ANOTHER derivation's tokens. If the latest job moved on meanwhile (a concurrent prepare of
      // another revision became the latest job and the publisher promoted ITS shadow), this unit simply lost the race --
      // a retryable deferral (the next pass re-binds against the new latest job). Otherwise it is a real read-back
      // mismatch (typed hard failure). Never counted published either way.
      let after = null;
      try { after = await readLatestJob(publisherKey, p.targetId, { signal }); } catch { after = null; }
      if (aborted()) return DEADLINE();
      if (!after || S(after.snapshotParamsHash) !== S(p.shadowParamsHash) || S(after.id) !== S(job && job.id)) return defer("lineage-advanced-during-publish");
      return hardFail("readback", "live-tokens-differ");
    }
    const expected = servedRowIdentity(live);
    const { served, verdict } = await servedCheckAgainst(unit, expected, ctx);
    if (aborted()) return DEADLINE();
    if (verdict.ok !== true) {
      if (verdict.fixable === true) return hardFail("readback", "served-row-differs");
      return defer("served-row-preempted:" + code(verdict.reason));
    }
    const servedId = servedRowIdentity(served.row);

    // (7) non-fatal follow-ups (only after a REAL write).
    if (pdisp === "published") {
      if (typeof runtime.postPublish === "function") {
        try { await runtime.postPublish({ unit, epoch, bucket: reg, published: { liveReportKey: p.liveReportKey, liveAccountId: p.liveAccountId, paramsHash: p.liveParamsHash }, signal }); }
        catch (e) { log(`route ${routeId}: postPublish failed (non-fatal): ${code(errMsg(e))}`); }
      }
      if (typeof publishSnapshotUpdate === "function" && nb(expected && expected.id)) {
        try { await publishSnapshotUpdate({ reportKey: p.liveReportKey, accountId: p.liveAccountId, paramsHash: p.liveParamsHash, snapshotId: expected.id }); } catch { /* non-fatal */ }
      }
    }
    // (8) optional prune of this target's older content-addressed shadows (keeps the latest job's + this one + < 24 h).
    // An aborted op never STARTS the DELETE (rechecked immediately before it; the verified publish above stands), and
    // the signal threads into the DELETE itself (deleteRouteShadowSnapshots(args, { signal })).
    if (prune === true && typeof pruneShadows === "function") {
      if (aborted()) log(`route ${routeId}: shadow prune skipped (deadline-aborted before the DELETE)`);
      else {
        try {
          const out = await pruneShadows({ routeId, publisherKey, targetId: p.targetId, keepParamsHashes: [...new Set([S(job && job.snapshotParamsHash), S(p.shadowParamsHash)].filter(nb))], olderThanIso: new Date(Number(now()) - SHADOW_PRUNE_GRACE_MS).toISOString() }, { signal });
          log(`route ${routeId}: pruned ${Number(out && out.deleted) || 0} superseded shadow(s)`);
        } catch (e) { log(`route ${routeId}: shadow prune skipped (non-fatal): ${code(errMsg(e))}`); }
      }
    }
    return ok({ alreadyCurrent: pdisp === "already-current", disposition: pdisp, served: servedId });
  }

  return Object.freeze({ routeId, publisherKey, prepareForUnit, publishForUnit, reportKeys: Object.freeze([publisherKey]) });
}

// ---- the saved-data reconciler ADAPTER for a route ------------------------------------------------------------------

const REVISION_DEP_RE = /^[\x21-\x7e]{1,512}$/;

/**
 * Normalize a route's computeRevision result into the reconciler revision shape (PURE, fail closed): an eligible
 * revision needs a nonblank revisionId, a valid evidenceToken (the TARGETS v2 'tok' echo) and canonical deps;
 * contentDeps default to [evidenceToken]. Anything else is ineligible with a typed reason.
 */
export function normalizeRouteRevision(rev) {
  if (!rev || typeof rev !== "object") return { eligible: false, reason: "revision-missing", status: "ineligible" };
  if (rev.eligible !== true) return { eligible: false, reason: code(rev.reason || "not-eligible"), status: S(rev.status) || "ineligible" };
  const deps = Array.isArray(rev.deps) ? rev.deps.map(S) : null;
  const contentDeps = rev.contentDeps == null ? [S(rev.evidenceToken)] : (Array.isArray(rev.contentDeps) ? rev.contentDeps.map(S) : null);
  if (!nb(rev.revisionId) || !validToken(rev.evidenceToken) || !deps || !contentDeps || ![...deps, ...contentDeps].every((d) => REVISION_DEP_RE.test(d)) || deps.length + contentDeps.length === 0) {
    return { eligible: false, reason: "revision-malformed", status: "ineligible" };
  }
  return { eligible: true, revisionId: S(rev.revisionId), evidenceToken: S(rev.evidenceToken), deps: [...new Set(deps)].sort(), contentDeps: [...new Set(contentDeps)], status: S(rev.status) || "available", reason: null };
}

// The explicit currentPredicate marker of a PROVEN content equivalence against the served row (see the adapter below).
export const ROUTE_PROOF_CONTENT_EQUIVALENT = "content-equivalent";

/**
 * The saved-data-reconciler adapter for ONE route (WP3 hooks): readScopeEvidence + computeAccountRevision (+ expandUnits
 * / currentPredicate when the runtime has them) + the GENERIC served-row check (the route's servedSelector vs the bound
 * canonical row, via its servedVerdict or defaultServedVerdict). With verifyExact the served check ALSO re-resolves the
 * unit's bundle (strict) and requires the latest job's durable_content_deps to carry its manifest token (the hydrated
 * content digest) -- else fixable 'manifest-differs' (the core keeps that typed reason on the STALE unit). In a LIVE
 * exact pass (--live --verify-exact) such a unit is then prepared: the release's resume gate refuses the drifted
 * shadow (content tokens differ from the fresh bundle's), re-derives a NEW content-addressed shadow and publishes it.
 * CONTENT-EQUIVALENCE PROOF (verifyExact only): a runtime currentPredicate verdict { state: PUBLICATION_NOT_REQUIRED,
 * proof: 'content-equivalent', h, sra } declares that the predicate PROVED the SERVED row (h / sra, read back through
 * the route's servedSelector) content-equivalent to a fresh derive of the CURRENT bundle -- e.g. fba-plan's row published
 * by the PAID job, which carries no route lineage. For exactly that (unit, report, h, sra) the verify-exact served check
 * honours the proof instead of demanding the manifest token in the latest job's lineage (the served-row verdict itself is
 * still required), so the unit stays current in both scans and a live exact pass never re-derives / overwrites that
 * row. Without the explicit marker nothing changes (verify-exact is never weakened for any other predicate / route).
 */
export function buildRouteReconcileAdapter({ route, runtime, bucket, directory = null, liveContracts, readLatestJob = null, verifyExact = false } = {}) {
  validateRouteRuntime(runtime, S(route && route.id));
  const contract = liveContracts && liveContracts[S(route && route.publisherKey)];
  if (!contract) throw new Error("buildRouteReconcileAdapter: no live contract for the route publisher key (fail closed).");
  if (verifyExact && typeof readLatestJob !== "function") throw new Error("buildRouteReconcileAdapter: verifyExact requires readLatestJob (fail closed).");
  const servedVerdict = typeof runtime.servedVerdict === "function" ? runtime.servedVerdict : defaultServedVerdict;
  const revisions = new Map();
  // verifyExact: the content-equivalence proofs the route's currentPredicate returned in THIS scan, keyed by
  // (report, target, unit) -> the proven served identity { h, sra }.
  const contentProofs = new Map();
  const proofKey = (rk, unit) => JSON.stringify([S(rk), S(unit && unit.targetId), S(unit && unit.unitKey)]);
  const adapter = {
    readScopeEvidence: async ({ organizationFingerprint, connectionId, scope, requestedAsOf, withTimeout = (p) => p }) => {
      const out = await withTimeout(Promise.resolve().then(() => runtime.readScopeEvidence({ scope, epoch: requestedAsOf, bucket, directory, organizationFingerprint, connectionId })), "route readScopeEvidence");
      return out;
    },
    computeAccountRevision: ({ accountId, requestedAsOf, evidence }) => {
      let raw;
      try { raw = runtime.computeRevision({ accountId, evidence, epoch: requestedAsOf, bucket, directory }); } catch { raw = { eligible: false, reason: "revision-threw" }; }
      const rev = normalizeRouteRevision(raw);
      revisions.set(accountId, rev);
      return rev;
    },
    servedCheck: async ({ unit, rk, accountId, h, sra, epoch }) => {
      let served;
      try { served = await runtime.servedSelector(unit, { epoch, bucket }); } catch { served = { row: null, reason: "read-failed", via: null }; }
      if (!served || typeof served !== "object") served = { row: null, reason: "selector-malformed", via: null };
      const expected = { report_key: contract.liveReportKey, account_id: unit.liveAccountId, params_hash: h, source_refreshed_at: sra };
      let v;
      try { v = servedVerdict(served, expected, { unit, epoch, bucket }); } catch { v = { ok: false, fixable: false, reason: "verdict-threw" }; }
      const sv = served.row ? { id: served.row.id, h: served.row.params_hash, sra: served.row.source_refreshed_at } : null;
      if (!v || v.ok !== true) return { ok: false, fixable: !!(v && v.fixable === true), reason: S(v && v.reason) || "served-mismatch", served: sv };
      if (verifyExact) {
        const proven = contentProofs.get(proofKey(rk, unit));
        if (proven && nb(h) && nb(sra) && proven.h === S(h) && proven.sra === S(sra)) return { ok: true, fixable: false, reason: null, served: sv };
        const revision = revisions.get(accountId);
        let b = null;
        try { b = await runtime.resolveBundle(unit, { strict: true, epoch, bucket, revision }); } catch { b = null; }
        if (!b || b.eligible !== true || !revision || S(b.revisionId) !== S(revision.revisionId)) return { ok: false, fixable: false, reason: "verify-bundle-unresolved", served: sv };
        let job = null;
        try { job = await readLatestJob(rk, unit.targetId); } catch { job = null; }
        const have = new Set((job && Array.isArray(job.durableContentDeps) ? job.durableContentDeps : []).map(S));
        if (!validToken(b.manifestToken) || !have.has(S(b.manifestToken))) return { ok: false, fixable: true, reason: "manifest-differs", served: sv };
      }
      return { ok: true, fixable: false, reason: null, served: sv };
    },
  };
  if (typeof runtime.expandUnits === "function") adapter.expandUnits = (args) => runtime.expandUnits({ ...args, epoch: args.requestedAsOf, directory });
  if (typeof runtime.currentPredicate === "function") {
    const predicate = runtime.currentPredicate;
    adapter.currentPredicate = !verifyExact ? predicate : async (rk, unit, ctx) => {
      contentProofs.delete(proofKey(rk, unit));
      const p = await predicate(rk, unit, ctx);
      if (p && typeof p === "object" && p.state === PUBLICATION_STATE.PUBLICATION_NOT_REQUIRED && p.proof === ROUTE_PROOF_CONTENT_EQUIVALENT && nb(p.h) && nb(p.sra)) {
        contentProofs.set(proofKey(rk, unit), { h: S(p.h), sra: S(p.sra) });
      }
      return p;
    };
  }
  return adapter;
}

// ---- pure CLI helpers (scripts/release/publication-route-reconcile.mjs) --------------------------------------------

export const ROUTE_CLI_MAX_TARGETS = 25;
export const ROUTE_CLI_MAX_ROUTES = 10;
export const ROUTE_CLI_MAX_LEASE_WAIT_SECONDS = 900;
// A run token is bounded to 150 chars so the audited control OPERATOR built from it ("publication-route-reconcile:" +
// region + ":" + token, <= 188 chars) always stays a canonical <= 200-char operator id (runControlPackageCli refuses
// anything longer -- a longer token could never open controls).
const RUN_TOKEN_RE = /^[A-Za-z0-9._:-]{8,150}$/;
export const ROUTE_CLI_OPERATOR_PREFIX = "publication-route-reconcile:";
/** The audited control operator id of one route CLI invocation (the SAME value for the run and its --cleanup). */
export function routeCliOperator({ bucket, runToken, asOf }) {
  return ROUTE_CLI_OPERATOR_PREFIX + S(bucket) + ":" + (S(runToken) || S(asOf));
}
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const KNOWN_FLAGS = Object.freeze(["route", "bucket", "as-of", "mode", "targets", "deadline-seconds", "run-token", "lease-wait-seconds"]);
const KNOWN_SWITCHES = Object.freeze(["live", "verify-exact", "emit-targets", "cleanup", "prune-shadows"]);

/**
 * Parse + validate the route CLI argv (PURE). -> { ok:true, args } | { ok:false, code, message }. Fail closed on any
 * unknown flag, malformed value, or unsafe combination:
 *   --route=<id>[,<id>...] (ROUTE_ID_RE, unique, <= 10)   --bucket=india|europe-au|us-ca   --as-of=YYYY-MM-DD (the epoch)
 *   --mode=periodic|scheduler (default periodic)           --targets=<ids> (^[A-Za-z0-9._:-]{1,160}$, unique, <= 25)
 *   --live (REQUIRES --run-token, and --targets unless --mode=scheduler)
 *   --verify-exact (alone: a read-only exact verify; with --live: a LIVE exact pass whose served check also compares the
 *                   manifest, so a 'manifest-differs' unit is re-derived + republished through the fenced path)
 *   --emit-targets   --deadline-seconds=N   --run-token=<token>   --cleanup (REQUIRES --run-token; nothing else runs)
 *   --lease-wait-seconds=N (--mode=scheduler ONLY, 0..900)   --prune-shadows (--live ONLY)
 * A LIVE run and ANY --mode=scheduler run REQUIRE a unique --run-token: the control lease OWNER is derived from it
 * (routeCliOperator), so two live invocations of one bucket/date can never share a lease-owner identity (the as-of
 * fallback is kept only for read-only runs, which never open controls).
 */
export function parseRouteCliArgs(argv) {
  const bad = (c, message) => ({ ok: false, code: c, message });
  const flags = {}; const switches = new Set();
  for (const a of Array.isArray(argv) ? argv : []) {
    const s = S(a);
    if (!s.startsWith("--")) return bad("ROUTE_CLI_ARG", "unexpected positional argument");
    const eq = s.indexOf("=");
    const name = eq < 0 ? s.slice(2) : s.slice(2, eq);
    if (eq < 0) { if (!KNOWN_SWITCHES.includes(name)) return bad("ROUTE_CLI_ARG", "unknown switch --" + name.slice(0, 40)); switches.add(name); continue; }
    if (!KNOWN_FLAGS.includes(name)) return bad("ROUTE_CLI_ARG", "unknown flag --" + name.slice(0, 40));
    if (Object.prototype.hasOwnProperty.call(flags, name)) return bad("ROUTE_CLI_ARG", "duplicate flag --" + name);
    flags[name] = s.slice(eq + 1);
  }
  const routes = S(flags.route).split(",").map((x) => x.trim()).filter(Boolean);
  if (!routes.length || routes.length > ROUTE_CLI_MAX_ROUTES || new Set(routes).size !== routes.length || !routes.every((r) => ROUTE_ID_RE.test(r))) return bad("ROUTE_CLI_ROUTE", "--route=<id>[,<id>...] is required (route ids ^[a-z][a-z0-9-]{1,39}$, unique, <= " + ROUTE_CLI_MAX_ROUTES + ")");
  const cleanup = switches.has("cleanup");
  const runToken = S(flags["run-token"]).trim();
  if (runToken && !RUN_TOKEN_RE.test(runToken)) return bad("ROUTE_CLI_RUN_TOKEN", "--run-token must match ^[A-Za-z0-9._:-]{8,150}$");
  if (cleanup && !runToken) return bad("ROUTE_CLI_CLEANUP", "--cleanup requires --run-token (the same token as the run it cleans up)");
  const bucket = S(flags.bucket);
  if (!ROUTE_REGIONS.includes(bucket)) return bad("ROUTE_CLI_BUCKET", "--bucket must be india|europe-au|us-ca");
  const asOf = S(flags["as-of"]);
  if (!DATE_RE.test(asOf) || !isCalendarDate(asOf)) return bad("ROUTE_CLI_AS_OF", "--as-of=YYYY-MM-DD (a real calendar date) is required");
  const mode = flags.mode == null ? "periodic" : S(flags.mode);
  if (mode !== "periodic" && mode !== "scheduler") return bad("ROUTE_CLI_MODE", "--mode must be periodic|scheduler");
  const live = switches.has("live");
  const verifyExact = switches.has("verify-exact");
  if ((live || mode === "scheduler") && !runToken) return bad("ROUTE_CLI_LIVE_RUN_TOKEN", "--live and --mode=scheduler require a unique --run-token (the control lease owner identity; never shared by two live runs)");
  let targets = null;
  if (flags.targets != null) {
    targets = S(flags.targets).split(",").map((x) => x.trim()).filter(Boolean);
    if (!targets.length || targets.length > ROUTE_CLI_MAX_TARGETS || new Set(targets).size !== targets.length || !targets.every((t) => TARGET_KEY_RE.test(t))) return bad("ROUTE_CLI_TARGETS", "--targets must be 1.." + ROUTE_CLI_MAX_TARGETS + " unique ids matching ^[A-Za-z0-9._:-]{1,160}$");
  }
  if (live && !targets && mode !== "scheduler") return bad("ROUTE_CLI_LIVE_TARGETS", "--live requires --targets unless --mode=scheduler (never an implicit full-region live pass)");
  let deadlineSeconds = 0;
  if (flags["deadline-seconds"] != null) {
    deadlineSeconds = Number(flags["deadline-seconds"]);
    if (!Number.isInteger(deadlineSeconds) || deadlineSeconds < 0 || deadlineSeconds > 7200) return bad("ROUTE_CLI_DEADLINE", "--deadline-seconds must be an integer in [0, 7200]");
  }
  let leaseWaitSeconds = 0;
  if (flags["lease-wait-seconds"] != null) {
    if (mode !== "scheduler") return bad("ROUTE_CLI_LEASE_WAIT", "--lease-wait-seconds is accepted ONLY with --mode=scheduler");
    leaseWaitSeconds = Number(flags["lease-wait-seconds"]);
    if (!Number.isInteger(leaseWaitSeconds) || leaseWaitSeconds < 0 || leaseWaitSeconds > ROUTE_CLI_MAX_LEASE_WAIT_SECONDS) return bad("ROUTE_CLI_LEASE_WAIT", "--lease-wait-seconds must be an integer in [0, " + ROUTE_CLI_MAX_LEASE_WAIT_SECONDS + "]");
  }
  const pruneShadows = switches.has("prune-shadows");
  if (pruneShadows && !live) return bad("ROUTE_CLI_PRUNE", "--prune-shadows is accepted ONLY with --live");
  return { ok: true, args: { routes, bucket, asOf, mode, targets, live, verifyExact, emitTargets: switches.has("emit-targets"), deadlineSeconds, runToken, cleanup, leaseWaitSeconds, pruneShadows, dryRun: !live } };
}

/**
 * The DURABLE account directory (PURE over already-read rows): getAccountDirectorySnapshotAccounts rows ->
 * Map(accountId -> { accountId, country, marketplace, rawSellerId, name, currency }). NO DataDoe discovery: the raw
 * seller id is the LOCAL resolveDataDoeAccountIds mapping. dd-secondary / ':' ids, blank ids or countries, unresolvable
 * raw sellers and DUPLICATE account ids (ambiguous -> excluded, fail closed) are dropped and reported in `excluded`.
 */
export function buildDurableDirectory({ rows, resolveRawSellerId, normalizeMarketplace = (c) => S(c).trim().toUpperCase() } = {}) {
  const directory = new Map();
  const excluded = [];
  const seen = new Map();
  for (const r of Array.isArray(rows) ? rows : []) seen.set(S(r && r.accountId).trim(), (seen.get(S(r && r.accountId).trim()) || 0) + 1);
  for (const r of Array.isArray(rows) ? rows : []) {
    const id = S(r && r.accountId).trim();
    const country = S(r && r.country).trim();
    if (!id || id.includes(":")) { excluded.push({ accountId: id.includes(":") ? "prefixed" : "", reason: "not-primary" }); continue; }
    if ((seen.get(id) || 0) > 1) { excluded.push({ accountId: id, reason: "duplicate-directory-row" }); continue; }
    if (!country) { excluded.push({ accountId: id, reason: "no-marketplace" }); continue; }
    let raw = "";
    try { raw = S(typeof resolveRawSellerId === "function" ? resolveRawSellerId(id) : ""); } catch { raw = ""; }
    if (!nb(raw)) { excluded.push({ accountId: id, reason: "raw-seller-unresolved" }); continue; }
    directory.set(id, { accountId: id, country, marketplace: normalizeMarketplace(country), rawSellerId: raw, name: r && r.name != null ? S(r.name) : null, currency: r && r.currency != null ? S(r.currency) : null });
  }
  return { directory, excluded };
}

/** The directory's account ids in `bucket` (accountInScope over the directory country), sorted. */
export function regionAccountIds(directory, bucket, accountInScope) {
  const out = [];
  for (const [id, m] of directory instanceof Map ? directory : new Map()) if (accountInScope(bucket, S(m.country).toUpperCase())) out.push(id);
  return out.sort();
}

// ---- the route CLI's control lifecycle + multi-route sequencing (PURE over injected collaborators) ------------------
// scripts/release/publication-route-reconcile.mjs wires the REAL collaborators (runControlPackageCli over
// connectPriorityControlStore, buildRouteControlPackage, its pg capability probe); the offline tests inject a fake
// control store through the SAME real runControlPackageCli. Cloned from listing-health-v3-reconcile.mjs.

export const ROUTE_CLI_START_RESERVE_SECONDS = 120;
export const ROUTE_CLI_CONTROLS_UNRESOLVED = "controls-unresolved";
// LEASE FAIRNESS (WP13 verifier P2-1): a LIVE route run holds the GLOBAL control-plane lease in back-to-back windows of
// up to DEFAULT_CHUNK_MAX_SECONDS (90 s). Between two windows it leaves the lease free for this long -- TWICE the 15 s
// CONTROL_LEASE_HELD retry interval of runControlPackageCli -- so every bounded lease-waiter (another region's scheduler
// control apply, fba-plan-golive, the immediate Ads / Listing Health v3 reconcilers' lease-wait) gets at least one attempt
// while the lease is free, instead of losing every race to an immediate re-open. Dry-run holds no lease -> no pause.
export const ROUTE_CLI_INTER_WINDOW_PAUSE_MS = 30000;
const cliErr = (e) => S(e && e.message ? e.message : e).replace(/[^\x20-\x7e]/g, "").slice(0, 200);

/**
 * READ-ONLY control-plane state (EVIDENCE-BASED closure): prove the priority publication controls are closed from the
 * actual rows (rollout / controlled dispatch / promoted / approvals), never from a rollback disposition or a
 * lease-not-owner skip. -> { read:'ok', closed, detail } | { read:'read-failed', closed:false, error }.
 */
export async function readRouteControlPlaneClosed({ connectStore, controlledReportKeys } = {}) {
  let store = null;
  try {
    store = await connectStore();
    const [rollout, dispatch, promoted, approvals] = await Promise.all([store.rolloutRows(), store.dispatchRows(), store.promotedRows(), store.approvalRows()]);
    const controlled = new Set(controlledReportKeys);
    const enabledRollout = (rollout || []).filter((r) => r.enabled === true).length;
    const enabledDispatch = (dispatch || []).filter((r) => r.schedule_enabled === true && controlled.has(String(r.report_key))).length;
    const enabledPromoted = (promoted || []).filter((r) => r.publish_enabled === true).length;
    const approved = (approvals || []).filter((r) => r.approved === true).length;
    const detail = { enabledRollout, enabledDispatch, enabledPromoted, approved };
    return { read: "ok", closed: enabledRollout + enabledDispatch + enabledPromoted + approved === 0, detail };
  } catch (e) { return { read: "read-failed", closed: false, error: cliErr(e) }; }
  finally { if (store && typeof store.end === "function") { try { await store.end(); } catch { /* ignore */ } } }
}

/**
 * The lease-wait bound an openControls may use NOW: the requested --lease-wait-seconds (scheduler mode; 0 otherwise),
 * CAPPED at (the remaining run deadline - START_RESERVE) so a lease wait never runs past the deadline (the reserve keeps
 * room for the publish + safe-close). No deadline (0) -> uncapped. Always an integer >= 0.
 */
export function routeCliLeaseWaitSeconds({ leaseWaitSeconds = 0, deadlineSeconds = 0, runStartMs = 0, startReserveSeconds = ROUTE_CLI_START_RESERVE_SECONDS, nowMs = Date.now() } = {}) {
  const want = Math.max(0, Math.floor(Number(leaseWaitSeconds) || 0));
  const dl = Number(deadlineSeconds) || 0;
  if (!(dl > 0)) return want;
  const remaining = dl - (Number(nowMs) - Number(runStartMs)) / 1000;
  const cap = Math.floor(remaining - Number(startReserveSeconds));
  return Number.isFinite(cap) ? Math.max(0, Math.min(want, cap)) : 0;
}

/**
 * The route CLI's openControls / closeControls (the saved-data reconciler's control-window hooks) + the window's fence:
 *   openControls({ owners, publisherKeys }) -- partial-namespace capability, then runControlPackageCli 'apply' with the
 *     dedicated ROUTE package (EXACTLY the window's owner rollout + the publisher keys' promoted gates + approvals, every
 *     controlled dispatch paused), the bounded lease-wait (routeCliLeaseWaitSeconds), COMMIT_UNKNOWN surfaced (never
 *     retried), a valid fencing generation required;
 *   closeControls() -- runControlPackageCli 'rollback' under the window's fence, then the EVIDENCE-BASED closure proof
 *     (readControlPlaneClosed); COMMIT_UNKNOWN / unreadable / not-closed are surfaced (the reconciler marks the run
 *     control-cleanup-unresolved);
 *   fence() -- { ownerToken, generation } of the open window, else null (verifyLease + the publisher fence read it).
 */
export function buildRouteCliControls({
  runControlPackageCli, connectStore, buildRouteControlPackage, partialNamespacePermitted, readControlPlaneClosed,
  operator, operationKey, leaseWaitSeconds = 0, leaseTtlSeconds = 900,
  deadlineSeconds = 0, runStartMs = 0, startReserveSeconds = ROUTE_CLI_START_RESERVE_SECONDS, now = () => Date.now(),
  sleep = null, log = () => {}, closeLog = log,
} = {}) {
  for (const [name, fn] of [["runControlPackageCli", runControlPackageCli], ["connectStore", connectStore], ["buildRouteControlPackage", buildRouteControlPackage], ["partialNamespacePermitted", partialNamespacePermitted], ["readControlPlaneClosed", readControlPlaneClosed]]) {
    if (typeof fn !== "function") throw new Error(`buildRouteCliControls requires ${name} (fail closed).`);
  }
  if (!nb(operator) || !nb(operationKey)) throw new Error("buildRouteCliControls requires an operator + operationKey (fail closed).");
  let leaseFence = null;
  async function openControls({ owners = [], publisherKeys = [] } = {}) {
    const cap = await partialNamespacePermitted();
    if (!cap || cap.permitted !== true) return { ok: false, reason: "PRIORITY_PARTIAL_MIGRATION_PENDING (" + S(cap && cap.reason) + ")" };
    if (!Array.isArray(owners) || owners.length === 0) return { ok: false, reason: "no-owners" };
    try {
      const r = await runControlPackageCli({
        mode: "apply", operator,
        discoverAccounts: async () => [...owners],
        connectStore,
        // The dedicated ROUTE package: EXACTLY the window's owner rollout + the publisher keys' PROMOTED gates + approvals,
        // with EVERY controlled dispatch paused (asserted in the same transaction). The global safe-close closes it.
        buildApplyPackage: ({ accounts, operator: op, controlledReportKeys }) => buildRouteControlPackage({ accounts, operator: op, publisherKeys, controlledReportKeys }),
        ownerToken: operator, operationKey, leaseTtlSeconds,
        // Bounded lease-wait (0 == the single attempt), never past the run deadline minus START_RESERVE.
        leaseWaitSeconds: routeCliLeaseWaitSeconds({ leaseWaitSeconds, deadlineSeconds, runStartMs, startReserveSeconds, nowMs: now() }),
        // The lease-wait loop runs on the SAME clock the cap was computed on (+ an injectable sleep for tests).
        now, ...(typeof sleep === "function" ? { sleep } : {}),
        log,
      });
      if (r && Number(r.code) === 3) return { ok: false, commitUnknown: true, reason: "control-apply COMMIT_UNKNOWN (code 3) -- read-only reconciliation required (NO rollback/retry)" };
      if (!r || r.committed !== true) return { ok: false, reason: "controls apply did not commit (code " + S(r && r.code) + (r && r.problem ? "/" + cliErr(r.problem) : "") + ")" };
      const gen = Number(r.leaseGeneration);
      if (!(Number.isSafeInteger(gen) && gen > 0)) return { ok: false, reason: "controls apply returned no valid fencing generation" };
      leaseFence = { ownerToken: r.ownerToken || operator, generation: gen };
      return { ok: true };
    } catch (e) { return { ok: false, reason: "controls-apply-error:" + cliErr(e) }; }
  }
  async function closeControls() {
    if (!leaseFence) return { ok: true };
    const fence = leaseFence;
    try {
      const r = await runControlPackageCli({ mode: "rollback", operator, connectStore, ownerToken: fence.ownerToken, ownerGeneration: fence.generation, operationKey, log: closeLog });
      leaseFence = null;
      if (r && Number(r.code) === 3) return { ok: false, commitUnknown: true, reason: "safe-close COMMIT_UNKNOWN (code 3) -- read-only reconciliation required" };
      const state = await readControlPlaneClosed();
      if (!state || state.read !== "ok") return { ok: false, reason: "control state UNREADABLE after safe-close -- cleanup unverified" };
      if (!state.closed) return { ok: false, reason: "controls NOT proven closed after safe-close " + JSON.stringify(state.detail) };
      return { ok: true };
    } catch (e) { leaseFence = null; return { ok: false, reason: "safe-close-error:" + cliErr(e) }; }
  }
  return Object.freeze({ openControls, closeControls, fence: () => leaseFence });
}

/**
 * Run the routes IN ORDER and STOP at the first route that left the control plane UNPROVEN (its summary's
 * controlCleanupUnresolved: a safe-close COMMIT_UNKNOWN / failure / throw, an apply COMMIT_UNKNOWN / open throw, or an
 * unconfirmed deadline termination). No later route may open controls over an unproven control plane: the remaining
 * routes are never built or run -- each is recorded skipped with reason 'controls-unresolved' (the caller reports them
 * deferred in RESULT / TARGETS and exits non-zero, like the LHv3 CLI's CONTROL_CLEANUP_UNRESOLVED).
 * -> { runs: [{ id, skipped, reason, summary }], stoppedBy: <route id> | null }
 */
export async function runRouteCliSequence({ order, runRoute, log = () => {} } = {}) {
  if (typeof runRoute !== "function") throw new Error("runRouteCliSequence requires runRoute (fail closed).");
  const runs = [];
  let stoppedBy = null;
  for (const id of Array.isArray(order) ? order : []) {
    if (stoppedBy) { runs.push({ id, skipped: true, reason: ROUTE_CLI_CONTROLS_UNRESOLVED, summary: null }); continue; }
    const summary = await runRoute(id);
    runs.push({ id, skipped: false, reason: null, summary });
    if (summary && summary.controlCleanupUnresolved === true) {
      stoppedBy = id;
      log(`route ${id} left the control plane UNPROVEN (${code(summary.controlReason || "control-cleanup-unresolved")}) -- STOPPING: every remaining route defers '${ROUTE_CLI_CONTROLS_UNRESOLVED}' (no further control window opens).`);
    }
  }
  return { runs, stoppedBy };
}

const zeroRouteCounts = () => ({ targetsExamined: 0, targetsStale: 0, targetsPublished: 0, targetsAlreadyCurrent: 0, targetsDeferred: 0, targetsFailed: 0, targetsUnitsEmpty: 0 });
/** The RESULT.routes entry of a route SKIPPED after an unresolved control plane (deferred, never run, zero counts). */
export function routeCliSkippedRoute(id) {
  return { id: S(id), ok: false, outcome: "partial", code: "DEFERRED", reason: ROUTE_CLI_CONTROLS_UNRESOLVED, skipped: true, counts: zeroRouteCounts() };
}
/** The TARGETS v2 summary of a skipped route: NO targets (nothing proven), outcome partial, code 'controls-unresolved'. */
export function routeCliSkippedTargetsSummary({ bucket, asOf, dryRun } = {}) {
  return { bucket: S(bucket), requestedAsOf: S(asOf), dryRun: dryRun === true, outcome: "partial", code: ROUTE_CLI_CONTROLS_UNRESOLVED, dataDoeCreates: 0, dataDoeTokens: 0, controlCleanupUnresolved: false, perAccount: [] };
}

/**
 * The route CLI's final RESULT verdict over its per-route results: any zero-export block FAILS the run
 * (ZERO_EXPORT_VIOLATION); otherwise ok only when EVERY route (skipped ones included -- they are ok:false) is ok; a
 * non-ok run is CONTROL_CLEANUP_UNRESOLVED when any route left the control plane unproven, else HARD_FAILURES.
 * exitCode 0 only when ok. -> { ok, outcome, code, exitCode }
 */
export function routeCliOutcome({ routeResults = [], zeroExportViolation = false, anyControlUnresolved = false } = {}) {
  const rank = { complete: 0, partial: 1, failed: 2 };
  const worst = routeResults.reduce((w, r) => ((rank[r.outcome] ?? 2) > (rank[w] ?? 0) ? r.outcome : w), "complete");
  const ok = routeResults.every((r) => r.ok) && !zeroExportViolation;
  const outcome = zeroExportViolation ? "failed" : worst;
  const resultCode = zeroExportViolation ? "ZERO_EXPORT_VIOLATION" : (ok ? "OK" : (anyControlUnresolved ? "CONTROL_CLEANUP_UNRESOLVED" : "HARD_FAILURES"));
  return { ok, outcome, code: resultCode, exitCode: ok ? 0 : 1 };
}
