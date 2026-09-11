// SHARED, SOURCE-AGNOSTIC publication-binding primitives for the saved-data publication reconciler family.
//
// These are the pure decision functions the OLI reconciler proved out (extracted verbatim from
// oli-publication-revision.js, renamed generic). They contain NO source-specific logic: given a per-account durable
// REVISION ({ eligible, revisionId, deps:[sorted durable request/content hashes], status }) supplied by a per-source
// adapter, plus the report's live contract + derivation + the pre-loaded/hydrated job/shadow/live rows, they decide
// whether the canonical live report row IS the promotion of the exact, fully-validated report job's shadow.
//
// The ONE source-specific input is `revision.deps` (the family's proven durable request/content hashes) and how it is
// computed -- that lives in each adapter's computeAccountRevision. Everything here is byte-identical to the OLI
// original so oli-publication-revision.js can re-export it and the OLI suites stay behaviorally green. 7-bit ASCII, LF.

const S = (v) => (v == null ? "" : String(v));
const nb = (v) => S(v).trim() !== ""; // nonblank

// The per-(account, report) reconciliation states a pure classifier can decide (the reconciler core adds
// DERIVED / PUBLISHED_LIVE / READBACK_VERIFIED / FAILED_* from execution).
export const PUBLICATION_STATE = Object.freeze({
  PUBLICATION_NOT_REQUIRED: "PUBLICATION_NOT_REQUIRED", // exact-identity live snapshot exists AND verified -> nothing to do
  STALE: "STALE",                                       // missing / older-as-of / unverified live -> derive + promote
  DEFERRED_PROVENANCE: "DEFERRED_PROVENANCE",           // durable source not provable -> never publish (LKG preserved)
});

// The content as-of (YYYY-MM-DD) a live snapshot was built for -- the `to` date in its stored params. Never updated_at:
// this is the report window end the payload actually covers. Returns "" when unreadable (treated as stale).
export function liveSnapshotAsOf(liveSnapshot) {
  const p = liveSnapshot && (liveSnapshot.params || liveSnapshot.snapshot_params);
  const to = p && typeof p === "object" ? (p.to ?? p.asOf ?? p.through) : null;
  return typeof to === "string" && /^\d{4}-\d{2}-\d{2}$/.test(to) ? to : "";
}

// Is the CURRENTLY-live report built from (at least) the current durable source revision? True iff the latest VALIDATED
// report job's lineage `depends_on` contains EVERY current durable request/content hash (revision.deps). A hash that is
// present in the durable source but MISSING from the job's depends_on means the source advanced -- a same-as-of
// CORRECTED export (new/added request hash) whose live snapshot is stale even though its `to` date is unchanged. A
// missing / unvalidated job, or empty durable deps, is never "covered" (fail toward re-deriving). This is the request-
// hash revision comparison (not date, not updated_at); the fenced CAS (source_refreshed_at) still prevents an older
// derive from overwriting a newer live at write time.
export function revisionCoveredByJob(revision, jobLineage) {
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

// A REAL calendar date (YYYY-MM-DD): the regex shape alone is NOT enough -- an impossible day (2026-02-30, 2026-13-01)
// must be rejected. Validated by round-tripping through UTC: Date silently rolls month/day overflow forward, so a value
// that does not reproduce itself after normalization is not a real calendar date.
export function isCalendarDate(v) {
  const s = S(v);
  if (!DATE_RE.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * EXACT PUBLICATION BINDING: prove the CURRENTLY-live report row IS the promotion of the exact, fully-validated report
 * job's shadow, with PUBLISHER-IDENTICAL validation AND the D-1 date gate. Never trust depends_on alone (an unpromoted
 * newer job left the live stale) and never trust hashes/content alone (an older `to` is stale even when hashes/content
 * are unchanged). PUBLICATION_NOT_REQUIRED ONLY when, for the latest promotable job:
 *   - its durable source provenance covers the current revision (revision.deps subset of job.dependsOn), AND
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
export function evaluatePublicationBinding({ revision, accountId, reportKey, requestedAsOf, expectedShadowKey, job, shadow, hydratedShadowPayload, live, hydratedLivePayload, liveReadback, contract, computeHash, reportDerivations, revisionChangedReason = "source-revision-changed" } = {}) {
  const stale = (reason) => ({ state: PUBLICATION_STATE.STALE, reason });
  if (!revision || revision.eligible !== true) return { state: PUBLICATION_STATE.DEFERRED_PROVENANCE, reason: (revision && revision.reason) || "not-eligible" };
  if (!jobIsPromotable(job)) return stale("job-not-promotable");
  if (!revisionCoveredByJob(revision, job)) return stale(revisionChangedReason);
  if (!contract || typeof contract.liveParams !== "function" || typeof computeHash !== "function") return stale("no-live-contract");
  const derivation = reportDerivations && reportDerivations[reportKey];
  if (!derivation || typeof derivation.validatePayload !== "function") return stale("no-report-derivation");
  // ---- SHADOW: publisher-identical validation ----
  const shadowParams = shadow && shadow.params && typeof shadow.params === "object" && !Array.isArray(shadow.params) ? shadow.params : null;
  if (!shadow || !shadowParams) return stale("shadow-missing");
  if (S(shadow.report_key) !== S(expectedShadowKey)) return stale("shadow-identity-report-key");
  if (S(shadow.account_id) !== S(accountId)) return stale("shadow-identity-account");
  // PUBLISHER-IDENTICAL account provenance (report-publisher.js `accountOk`): the shadow's STORED params.accountId must
  // ALSO equal the requested account -- the row column alone is insufficient (a row whose params were bound to another
  // account, even with internally-consistent recomputed/stored/job hashes, must be STALE, never PUBLICATION_NOT_REQUIRED).
  if (S(shadowParams.accountId) !== S(accountId)) return stale("shadow-params-account");
  if (S(shadowParams.reportVersion) !== S(derivation.snapshotVersion)) return stale("shadow-version");
  const shadowRecomputed = computeHash(shadowParams.reportVersion, shadowParams);
  if (S(shadowRecomputed) !== S(shadow.params_hash) || S(shadow.params_hash) !== S(job.snapshotParamsHash)) return stale("shadow-hash-mismatch");
  if (!nb(shadow.source_refreshed_at)) return stale("shadow-refresh-blank");
  if (hydratedShadowPayload == null) return stale("shadow-payload-unavailable");
  // The REAL report payload validator can THROW on a malformed payload; a throw must fail CLOSED as STALE for THIS
  // account (LKG preserved) -- never crash the whole regional scan.
  let shadowPayloadOk = false;
  try { shadowPayloadOk = derivation.validatePayload(hydratedShadowPayload) === true && !(hydratedShadowPayload && hydratedShadowPayload.dataUnavailable === true); }
  catch { return stale("shadow-payload-validator-threw"); }
  if (!shadowPayloadOk) return stale("shadow-payload-invalid");
  // ---- EXACT REQUESTED-AS-OF IDENTITY: the candidate window end MUST equal requestedAsOf EXACTLY, and both must be
  // REAL calendar dates. Missing / malformed / impossible-calendar / older / future(wrong-cycle) -> STALE, even when
  // the request hashes + payload content are unchanged. This SUPPLEMENTS the binding; it never replaces it.
  const liveParams = contract.liveParams(shadowParams);
  if (!liveParams || typeof liveParams !== "object") return stale("live-params-underivable");
  if (!isCalendarDate(requestedAsOf)) return stale("requested-asof-invalid");
  if (!isCalendarDate(liveParams.to)) return stale("candidate-asof-invalid");
  if (S(liveParams.to) !== S(requestedAsOf)) return stale("candidate-asof-not-exact");
  const candHash = computeHash(contract.liveReportVersion, liveParams);
  // ---- LIVE: canonical identity + the SHARED publisher readback (identity/version/params-provenance/payload) ----
  if (!live) return stale("live-unpromoted");
  if (S(live.report_key) !== S(contract.liveReportKey) || S(live.account_id) !== S(accountId) || S(live.params_hash) !== S(candHash)) return stale("live-identity-mismatch");
  if (!liveReadback || liveReadback.ok !== true) return stale("live-readback:" + S(liveReadback && liveReadback.reason));
  // ---- SHADOW <-> LIVE binding equality: the live IS this exact derivation's promotion ----
  if (S(live.source_refreshed_at) !== S(shadow.source_refreshed_at)) return stale("live-refresh-differs");
  if (hydratedLivePayload == null) return stale("live-payload-unavailable");
  if (stableJson(hydratedLivePayload) !== stableJson(hydratedShadowPayload)) return stale("live-payload-differs");
  return { state: PUBLICATION_STATE.PUBLICATION_NOT_REQUIRED, reason: null };
}

/**
 * Classify ONE (account, report) reconciliation target from the durable revision + the LATEST live snapshot for
 * (reportKey, accountId) + that snapshot's exact-identity readback result + the durable proven as-of (an eligible
 * account has proven source coverage through `requestedAsOf`, so that IS its durable as-of):
 *   - not eligible                          -> DEFERRED_PROVENANCE (never publish; keep dated LKG)
 *   - eligible, no live snapshot            -> STALE "live-missing"
 *   - eligible, live's as-of < requestedAsOf-> STALE "live-older-asof" (durable source advanced past the live snapshot)
 *   - eligible, live present, revision not covered by the job -> STALE "source-revision-changed"
 *   - eligible, live present, readback bad  -> STALE "live-unverified" (partial write / never verified)
 *   - eligible, live as-of >= requestedAsOf + covered + verified -> PUBLICATION_NOT_REQUIRED (already current)
 */
export function classifyReportTarget({ revision, liveSnapshot = null, readbackOk = false, requestedAsOf, jobLineage = null, revisionChangedReason = "source-revision-changed" } = {}) {
  if (!revision || revision.eligible !== true) {
    return { state: PUBLICATION_STATE.DEFERRED_PROVENANCE, reason: (revision && revision.reason) || "not-eligible" };
  }
  if (!liveSnapshot) return { state: PUBLICATION_STATE.STALE, reason: "live-missing" };
  const liveTo = liveSnapshotAsOf(liveSnapshot);
  if (!liveTo || (typeof requestedAsOf === "string" && liveTo < requestedAsOf)) return { state: PUBLICATION_STATE.STALE, reason: "live-older-asof" };
  // Request-hash revision comparison: even at the SAME as-of, if the durable source advanced (a corrected/added export
  // hash not in the latest validated job's depends_on), the live snapshot is stale and must be re-derived.
  if (!revisionCoveredByJob(revision, jobLineage)) return { state: PUBLICATION_STATE.STALE, reason: revisionChangedReason };
  if (readbackOk !== true) return { state: PUBLICATION_STATE.STALE, reason: "live-unverified" };
  return { state: PUBLICATION_STATE.PUBLICATION_NOT_REQUIRED, reason: null };
}
