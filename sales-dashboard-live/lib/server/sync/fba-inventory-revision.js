// Durable FBA-inventory revision identity -- PURE (no I/O; the reconciler supplies the durable snapshot + the
// entrypoint-recomputed expected D-1 request hash). The FBA analog of computeOliAccountRevision.
//
// FBA inventory is stored as ONE durable per-account latest-good pointer in public.source_snapshots
// (source_key='fba-inventory-health', scope_key=accountId): { source_request_hash, payload_sha, row_count,
// validated_at, object_path }. Unlike OLI (whose per-export request hash is CONTENT-addressed, so a corrected export
// gets a NEW hash), the FBA request hash is DATE-addressed (from === to === inventoryAsOf === D-1), so:
//   - a NEW DAY yields a NEW request hash -> the live dashboard built from an OLDER day is provably stale (the request
//     hash the reconciler binds is NOT in the live report job's depends_on), and
//   - a SAME-DATE correction keeps the SAME request hash but changes payload_sha; that content change is folded into
//     revisionId (the deterministic cycle-bucket identity) but is NOT, on its own, detectable through the report job's
//     depends_on (which records the date-addressed request hash, not payload_sha). Intra-day same-date corrections are
//     therefore repaired on the next date advance; see fba-dependent-reports.js for the durable-content-dep follow-up.
//
// The revision proves the durable snapshot is the requested D-1 snapshot by matching source_request_hash against the
// entrypoint-recomputed resolvedFbaSnapshot({asOf:requestedAsOf}).requestHash. A valid single-day EMPTY snapshot
// (row_count=0) proves D-1 by that hash match ALONE (there are no rows to carry the date) -- the FBA analog of the OLI
// proven-empty zero-row proof; it is eligible and represents inventory UNAVAILABLE, never a manufactured zero. A
// missing / mismatched-date / content-hash-blank snapshot is INELIGIBLE (defer; never publish stale inventory as
// fresh, never let an unproven placeholder shadow a proven-available last-known-good). 7-bit ASCII, LF.

import { createHash } from "node:crypto";
import { FBA_INVENTORY_SOURCE_KEY } from "./source-durable-model.js";

const S = (v) => (v == null ? "" : String(v));
const nb = (v) => S(v).trim() !== "";

// FBA revision status vocabulary (parallels OLI_LINEAGE_STATUS). AVAILABLE = a non-empty proven-D-1 snapshot;
// PROVEN_EMPTY = a bounded single-day row_count=0 snapshot that proves D-1 via its request hash (inventory
// unavailable); MISSING = no durable snapshot / unprovable date / blank content hash (defer).
export const FBA_REVISION_STATUS = Object.freeze({ AVAILABLE: "available", PROVEN_EMPTY: "proven-empty", MISSING: "missing" });

// The AUTHORITATIVE durable FBA CONTENT-provenance token: a deterministic, human-readable canonical string binding the
// EXACT durable FBA snapshot a brand-inventory report consumed -- source key, account, connection, request hash AND
// payload_sha (content identity). It is recorded in the brand-inventory report job's durable_content_deps (migration
// 20260925) by BOTH the regular scheduler derive and the reconciler derive (SAME semantics), and it is the revision's
// contentDeps entry the shared revisionCoveredByJob checks against. The FBA request hash is the D-1 request IDENTITY
// (resolvedFbaSnapshot({asOf}) pins from===to===inventoryAsOf AND the account's raw seller id), so it binds BOTH the
// requested D-1 and the account -- there is deliberately NO separate as-of field, which would otherwise let the regular
// derive's cycle as-of and the reconciler's requested as-of disagree and produce non-equal tokens for the SAME durable
// snapshot. Because it folds payload_sha, a SAME-DATE provider correction (same request hash, new payload_sha) yields a
// DIFFERENT token, so a live dashboard built from the old content is provably STALE. Never a bare sha (ambiguous with a
// request hash in depends_on) -- a pipe-delimited provenance string, self-describing + subset-checkable.
export function fbaContentProvenanceToken({ sourceKey, accountId, connectionId = "primary", requestHash, contentSha } = {}) {
  return [S(sourceKey), S(accountId), S(connectionId), S(requestHash), S(contentSha)].join("|");
}

/**
 * Deterministic durable FBA-inventory revision for ONE account. Inputs:
 *   snapshot            -- the durable source_snapshots row for (account, fba-inventory-health): a plain object with
 *                          { source_request_hash | sourceRequestHash, payload_sha | payloadSha, row_count | rowCount,
 *                          validated_at | validatedAt }, or null when there is no durable snapshot.
 *   expectedRequestHash -- the entrypoint-recomputed resolvedFbaSnapshot({asOf:requestedAsOf}).requestHash (the request
 *                          identity for EXACTLY the D-1 single-day inventory export). Blank => cannot prove D-1 (defer).
 * Returns:
 *   { eligible:true,  status, revisionId:<32 hex>, deps:[], contentDeps:[<content token>], reason:null }  when provable
 *   { eligible:false, status, revisionId:null, deps:[], contentDeps:[], reason:<token> }                   otherwise (defer)
 * The revisionId folds BOTH the date-addressed request hash AND payload_sha (content), so two different FBA contents
 * for the same account/as-of get distinct deterministic cycle-bucket identities. `deps` is EMPTY (the FBA export is not
 * a cycle job in priority mode); the durable FBA provenance is carried by `contentDeps` -- ONE fbaContentProvenanceToken
 * binding source/account/connection/asOf/requestHash/payload_sha -- which the shared revisionCoveredByJob checks against
 * the report job's durable_content_deps. A DATE advance (new request hash) OR a SAME-DATE correction (new payload_sha)
 * both change the token, so the live dashboard built from the old FBA content is provably STALE.
 */
export function computeFbaAccountRevision({ organizationFingerprint, connectionId = "primary", accountId, requestedAsOf, snapshot, expectedRequestHash } = {}) {
  if (!organizationFingerprint || !accountId || !requestedAsOf) {
    return { eligible: false, status: FBA_REVISION_STATUS.MISSING, revisionId: null, deps: [], contentDeps: [], reason: "incomplete-account-boundary" };
  }
  if (!nb(expectedRequestHash)) {
    return { eligible: false, status: FBA_REVISION_STATUS.MISSING, revisionId: null, deps: [], contentDeps: [], reason: "expected-request-hash-unresolved" };
  }
  if (!snapshot || typeof snapshot !== "object") {
    return { eligible: false, status: FBA_REVISION_STATUS.MISSING, revisionId: null, deps: [], contentDeps: [], reason: "no-durable-fba-snapshot" };
  }
  const requestHash = S(snapshot.source_request_hash ?? snapshot.sourceRequestHash);
  const payloadSha = S(snapshot.payload_sha ?? snapshot.payloadSha);
  const rowCountRaw = snapshot.row_count ?? snapshot.rowCount;
  const rowCount = Number(rowCountRaw);
  if (!nb(requestHash)) return { eligible: false, status: FBA_REVISION_STATUS.MISSING, revisionId: null, deps: [], contentDeps: [], reason: "snapshot-request-hash-blank" };
  if (!nb(payloadSha)) return { eligible: false, status: FBA_REVISION_STATUS.MISSING, revisionId: null, deps: [], contentDeps: [], reason: "snapshot-content-hash-blank" };
  if (!Number.isFinite(rowCount) || rowCount < 0) return { eligible: false, status: FBA_REVISION_STATUS.MISSING, revisionId: null, deps: [], contentDeps: [], reason: "snapshot-row-count-invalid" };
  // EXACT D-1 PROOF: the durable snapshot's request hash MUST equal the recomputed D-1 request identity. An OLDER (or
  // any other) day's snapshot is STALE for the requested as-of -> defer, never publish it as fresh (never shadow a
  // proven-available LKG with an unproven-for-this-as-of snapshot).
  if (requestHash !== S(expectedRequestHash)) {
    return { eligible: false, status: FBA_REVISION_STATUS.MISSING, revisionId: null, deps: [], contentDeps: [], reason: "snapshot-not-d1" };
  }
  // A bounded single-day row_count=0 snapshot that proves D-1 by its request hash is a VALID empty (inventory
  // unavailable); the persist path only records such an empty for a bounded exact single-day request
  // (boundedSingleDayEmpty in fba-inventory-latest-snapshot.js), so an unbounded/multi-day empty never reaches here.
  const status = rowCount > 0 ? FBA_REVISION_STATUS.AVAILABLE : FBA_REVISION_STATUS.PROVEN_EMPTY;
  const revisionId = createHash("sha256")
    .update([S(organizationFingerprint), S(connectionId), S(accountId), S(requestedAsOf), status, requestHash, payloadSha].join("|"))
    .digest("hex").slice(0, 32);
  // deps is EMPTY: in priority mode every source except Catalog is PAUSED, so the durable FBA export is NOT a job in
  // the reconcile/derive cycle and its request hash is never bound into the brand-inventory job's depends_on. The FBA
  // request hash is DATE-addressed anyway, so it cannot represent a same-date content correction. All FBA provenance
  // (request hash + content payload_sha) is therefore carried by the CONTENT-provenance token in contentDeps, recorded
  // in the report job's durable_content_deps -- date advances AND same-date corrections both change the token. Both are
  // ALSO defended by the binding's exact requested-as-of gate (an older `to` is STALE regardless of the token).
  const contentDeps = [fbaContentProvenanceToken({ sourceKey: FBA_INVENTORY_SOURCE_KEY, accountId, connectionId, requestHash, contentSha: payloadSha })];
  return { eligible: true, status, revisionId, deps: [], contentDeps, reason: null };
}
