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
export function classifyOliReportTarget({ revision, liveSnapshot = null, readbackOk = false, requestedAsOf } = {}) {
  if (!revision || revision.eligible !== true) {
    return { state: OLI_PUBLICATION_STATE.DEFERRED_PROVENANCE, reason: (revision && revision.reason) || "not-eligible" };
  }
  if (!liveSnapshot) return { state: OLI_PUBLICATION_STATE.STALE, reason: "live-missing" };
  const liveTo = liveSnapshotAsOf(liveSnapshot);
  if (!liveTo || (typeof requestedAsOf === "string" && liveTo < requestedAsOf)) return { state: OLI_PUBLICATION_STATE.STALE, reason: "live-older-asof" };
  if (readbackOk !== true) return { state: OLI_PUBLICATION_STATE.STALE, reason: "live-unverified" };
  return { state: OLI_PUBLICATION_STATE.PUBLICATION_NOT_REQUIRED, reason: null };
}
