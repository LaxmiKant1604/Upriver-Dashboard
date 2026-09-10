// Durable OLI revision identity + per-(account, report) reconciliation classification -- PURE (no I/O; the reconciler
// supplies the durable evidence + the live-snapshot lookup). This is WORK 3 of the OLI saved-data-to-dashboard system:
// a deterministic per-account OLI revision derived ONLY from durable evidence, and the decision of whether a canonical
// live report needs re-derivation.
//
// The revision identity includes the COMPLETE account boundary (organizationFingerprint + connectionId + accountId --
// never account_id alone) plus the requested as-of, the OLI start, and the SORTED proven OLI request hashes (positive-
// sales provenance OR the proven zero-row export chain), via the SAME resolveOliLineageProvenance the derive runtime
// and the partial preflight use. It NEVER fabricates a hash: MISSING / malformed / capped / ambiguous provenance is
// ineligible (revisionId:null) and must be deferred, never published. Coverage alone is never sufficient (the resolver
// requires a real request hash). 7-bit ASCII, LF.

import { createHash } from "node:crypto";
import { resolveOliLineageProvenance, OLI_LINEAGE_STATUS } from "./source-durable-model.js";

const S = (v) => (v == null ? "" : String(v));
const nb = (v) => S(v).trim() !== ""; // nonblank

// The per-(account, report) reconciliation states (a subset of the WORK 9 status vocabulary that this pure classifier
// can decide; the reconciler adds DERIVED / PUBLISHED_LIVE / READBACK_VERIFIED / FAILED_* from execution).
export const OLI_PUBLICATION_STATE = Object.freeze({
  PUBLICATION_NOT_REQUIRED: "PUBLICATION_NOT_REQUIRED", // exact-identity live snapshot exists AND verified -> nothing to do
  STALE: "STALE",                                       // missing / older-as-of / unverified live -> derive + promote
  DEFERRED_PROVENANCE: "DEFERRED_PROVENANCE",           // durable OLI not provable -> never publish (LKG preserved)
});

/**
 * Deterministic durable OLI revision for ONE account. Returns:
 *   { eligible:true,  status, revisionId:<32 hex>, deps:[...sorted hashes], reason:null }  when durable OLI is provable
 *   { eligible:false, status, revisionId:null, deps:[], reason:<token> }                   otherwise (defer, never publish)
 * `status` is one of OLI_LINEAGE_STATUS. A blank account boundary (missing orgFp/accountId/oliStart/asOf) is ineligible.
 */
export function computeOliAccountRevision({ organizationFingerprint, connectionId = "primary", accountId, oliStart, requestedAsOf, positiveHashes = [], zeroRowExports = [] } = {}) {
  if (!organizationFingerprint || !accountId || !oliStart || !requestedAsOf) {
    return { eligible: false, status: OLI_LINEAGE_STATUS.MISSING, revisionId: null, deps: [], reason: "incomplete-account-boundary" };
  }
  const res = resolveOliLineageProvenance({ historyProvenanceHashes: positiveHashes, zeroRowExports, oliStart, requestedAsOf });
  const eligible = res.status === OLI_LINEAGE_STATUS.NONEMPTY || res.status === OLI_LINEAGE_STATUS.PROVEN_EMPTY;
  if (!eligible) return { eligible: false, status: res.status, revisionId: null, deps: [], reason: res.reason || "provenance-missing" };
  const deps = [...new Set(res.deps || [])].sort();
  if (deps.length === 0) return { eligible: false, status: OLI_LINEAGE_STATUS.MISSING, revisionId: null, deps: [], reason: "eligible-without-deps" };
  const revisionId = createHash("sha256")
    .update([S(organizationFingerprint), S(connectionId), S(accountId), S(oliStart), S(requestedAsOf), res.status, deps.join(",")].join("|"))
    .digest("hex").slice(0, 32);
  return { eligible: true, status: res.status, revisionId, deps, reason: null };
}

// The content as-of (YYYY-MM-DD) a live snapshot was built for -- the `to` date in its stored params. Never updated_at:
// this is the report window end the payload actually covers. Returns "" when unreadable (treated as stale).
export function liveSnapshotAsOf(liveSnapshot) {
  const p = liveSnapshot && (liveSnapshot.params || liveSnapshot.snapshot_params);
  const to = p && typeof p === "object" ? (p.to ?? p.asOf ?? p.through) : null;
  return typeof to === "string" && /^\d{4}-\d{2}-\d{2}$/.test(to) ? to : "";
}

// Is the CURRENTLY-live report built from (at least) the current durable OLI revision? True iff the latest VALIDATED
// report job's lineage `depends_on` contains EVERY current durable OLI request hash (revision.deps). A hash that is
// present in the durable OLI but MISSING from the job's depends_on means the OLI advanced -- a same-as-of CORRECTED
// export (new/added request hash) whose live snapshot is stale even though its `to` date is unchanged. A missing /
// unvalidated job, or empty durable deps, is never "covered" (fail toward re-deriving). This is the request-hash
// revision comparison (not date, not updated_at); the fenced CAS (source_refreshed_at) still prevents an older
// derive from overwriting a newer live at write time.
export function oliRevisionCoveredByJob(revision, jobLineage) {
  if (!revision || revision.eligible !== true || !Array.isArray(revision.deps) || revision.deps.length === 0) return false;
  if (!jobLineage || jobLineage.validated !== true || !Array.isArray(jobLineage.dependsOn)) return false;
  const have = new Set(jobLineage.dependsOn.map((h) => String(h)));
  return revision.deps.every((h) => have.has(String(h)));
}

// Canonical JSON for exact content comparison (stable key order; used only to compare params/payload objects, never as
// an identity substitute for a hash). Recurses arrays + plain objects; primitives via JSON.stringify.
export function stableJson(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return "[" + v.map(stableJson).join(",") + "]";
  return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + stableJson(v[k])).join(",") + "}";
}

// A report job is a PROMOTABLE publication candidate only when it is a fully-succeeded, validated derivation in a
// TERMINAL cycle with a nonblank shadow hash -- the exact preconditions the publisher's success gate requires. Anything
// weaker (unvalidated / not-succeeded / running cycle / blank hash) is NOT a candidate the live could have come from.
export function jobIsPromotable(job) {
  return !!job
    && S(job.deriveStatus) === "succeeded"
    && S(job.saveStatus) === "succeeded"
    && job.validated === true
    && (S(job.cycleStatus) === "succeeded" || S(job.cycleStatus) === "partial")
    && nb(job.snapshotParamsHash);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * EXACT PUBLICATION BINDING (blockers 1/2): prove the CURRENTLY-live report row IS the promotion of the exact,
 * fully-validated report job's shadow, with PUBLISHER-IDENTICAL validation AND the D-1 date gate. Never trust
 * depends_on alone (an unpromoted newer job left the live stale) and never trust hashes/content alone (an older `to`
 * is stale even when hashes/content are unchanged). PUBLICATION_NOT_REQUIRED ONLY when, for the latest promotable job:
 *   - its durable OLI provenance covers the current revision, AND
 *   - the D-1 candidate covers requestedAsOf (an older `to` -> STALE), AND
 *   - the scheduler-v2/<key> shadow is publisher-valid: exact report_key + account_id + expected snapshotVersion; the
 *     shadow hash RECOMPUTED from params.reportVersion+complete params equals BOTH row.params_hash AND
 *     job.snapshotParamsHash; storage-first payload passes the REAL report payload validator, AND
 *   - the live row at the CANONICAL identity (shared contract: liveReportKey + recomputed liveParams hash) is proven
 *     valid by the SHARED publisher readback (liveReadback.ok) -- identity, live version, params-provenance (no
 *     mutation/extra fields), and payload contract -- AND is PROVEN EQUAL to the shadow candidate (EXACT
 *     source_refreshed_at + equal hydrated payload).
 * Everything else is STALE with a typed reason. Never uses updated_at. Inputs are pre-loaded/hydrated + the shared
 * `liveReadback` result is supplied by the reconciler; this function is PURE. `reportDerivations[reportKey]` supplies
 * the expected shadow snapshotVersion + the real payload validator.
 */
export function evaluatePublicationBinding({ revision, accountId, reportKey, requestedAsOf, expectedShadowKey, job, shadow, hydratedShadowPayload, live, hydratedLivePayload, liveReadback, contract, computeHash, reportDerivations } = {}) {
  const stale = (reason) => ({ state: OLI_PUBLICATION_STATE.STALE, reason });
  if (!revision || revision.eligible !== true) return { state: OLI_PUBLICATION_STATE.DEFERRED_PROVENANCE, reason: (revision && revision.reason) || "not-eligible" };
  if (!jobIsPromotable(job)) return stale("job-not-promotable");
  if (!oliRevisionCoveredByJob(revision, job)) return stale("oli-revision-changed");
  if (!contract || typeof contract.liveParams !== "function" || typeof computeHash !== "function") return stale("no-live-contract");
  const derivation = reportDerivations && reportDerivations[reportKey];
  if (!derivation || typeof derivation.validatePayload !== "function") return stale("no-report-derivation");
  // ---- SHADOW: publisher-identical validation ----
  const shadowParams = shadow && shadow.params && typeof shadow.params === "object" && !Array.isArray(shadow.params) ? shadow.params : null;
  if (!shadow || !shadowParams) return stale("shadow-missing");
  if (S(shadow.report_key) !== S(expectedShadowKey)) return stale("shadow-identity-report-key");
  if (S(shadow.account_id) !== S(accountId)) return stale("shadow-identity-account");
  if (S(shadowParams.reportVersion) !== S(derivation.snapshotVersion)) return stale("shadow-version");
  const shadowRecomputed = computeHash(shadowParams.reportVersion, shadowParams);
  if (S(shadowRecomputed) !== S(shadow.params_hash) || S(shadow.params_hash) !== S(job.snapshotParamsHash)) return stale("shadow-hash-mismatch");
  if (!nb(shadow.source_refreshed_at)) return stale("shadow-refresh-blank");
  if (hydratedShadowPayload == null) return stale("shadow-payload-unavailable");
  if (derivation.validatePayload(hydratedShadowPayload) !== true || (hydratedShadowPayload && hydratedShadowPayload.dataUnavailable === true)) return stale("shadow-payload-invalid");
  // ---- D-1 DATE GATE (blocker 1): the candidate must cover requestedAsOf even when hashes/content are unchanged ----
  const liveParams = contract.liveParams(shadowParams);
  if (!liveParams || typeof liveParams !== "object") return stale("live-params-underivable");
  if (typeof requestedAsOf === "string" && DATE_RE.test(requestedAsOf) && (!nb(liveParams.to) || String(liveParams.to) < requestedAsOf)) return stale("candidate-older-than-requested-asof");
  const candHash = computeHash(contract.liveReportVersion, liveParams);
  // ---- LIVE: canonical identity + the SHARED publisher readback (identity/version/params-provenance/payload) ----
  if (!live) return stale("live-unpromoted");
  if (S(live.report_key) !== S(contract.liveReportKey) || S(live.account_id) !== S(accountId) || S(live.params_hash) !== S(candHash)) return stale("live-identity-mismatch");
  if (!liveReadback || liveReadback.ok !== true) return stale("live-readback:" + S(liveReadback && liveReadback.reason));
  // ---- SHADOW <-> LIVE binding equality: the live IS this exact derivation's promotion ----
  if (S(live.source_refreshed_at) !== S(shadow.source_refreshed_at)) return stale("live-refresh-differs");
  if (hydratedLivePayload == null) return stale("live-payload-unavailable");
  if (stableJson(hydratedLivePayload) !== stableJson(hydratedShadowPayload)) return stale("live-payload-differs");
  return { state: OLI_PUBLICATION_STATE.PUBLICATION_NOT_REQUIRED, reason: null };
}

/**
 * Classify ONE (account, report) reconciliation target. Migration-free staleness (no `updated_at` as identity): the
 * reconciler passes the account's durable revision, the LATEST live snapshot for (reportKey, accountId), that
 * snapshot's exact-identity readback result, and the durable proven as-of (an eligible account has proven OLI coverage
 * through `requestedAsOf`, so that IS its durable as-of):
 *   - not eligible                         -> DEFERRED_PROVENANCE (never publish; keep dated LKG)
 *   - eligible, no live snapshot           -> STALE "live-missing"
 *   - eligible, live's as-of < requestedAsOf-> STALE "live-older-asof" (durable OLI advanced past the live snapshot)
 *   - eligible, live present, readback bad  -> STALE "live-unverified" (partial write / never verified)
 *   - eligible, live as-of >= requestedAsOf + verified -> PUBLICATION_NOT_REQUIRED (already current)
 */
export function classifyOliReportTarget({ revision, liveSnapshot = null, readbackOk = false, requestedAsOf, jobLineage = null } = {}) {
  if (!revision || revision.eligible !== true) {
    return { state: OLI_PUBLICATION_STATE.DEFERRED_PROVENANCE, reason: (revision && revision.reason) || "not-eligible" };
  }
  if (!liveSnapshot) return { state: OLI_PUBLICATION_STATE.STALE, reason: "live-missing" };
  const liveTo = liveSnapshotAsOf(liveSnapshot);
  if (!liveTo || (typeof requestedAsOf === "string" && liveTo < requestedAsOf)) return { state: OLI_PUBLICATION_STATE.STALE, reason: "live-older-asof" };
  // Request-hash revision comparison: even at the SAME as-of, if the durable OLI advanced (a corrected/added export
  // hash not in the latest validated job's depends_on), the live snapshot is stale and must be re-derived.
  if (!oliRevisionCoveredByJob(revision, jobLineage)) return { state: OLI_PUBLICATION_STATE.STALE, reason: "oli-revision-changed" };
  if (readbackOk !== true) return { state: OLI_PUBLICATION_STATE.STALE, reason: "live-unverified" };
  return { state: OLI_PUBLICATION_STATE.PUBLICATION_NOT_REQUIRED, reason: null };
}
