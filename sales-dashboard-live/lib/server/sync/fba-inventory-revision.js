// Durable FBA-inventory revision identity -- PURE (no I/O; the reconciler supplies the durable snapshot). The FBA analog
// of computeOliAccountRevision.
//
// Since the Listings inventory cutover (2026-10) FBA inventory comes from the canonical DataDoe Listings export and its
// ONE saved inventory snapshot is the durable Listings pointer public.source_listings_snapshot (one latest-good row per
// org + connection + account): { as_of, source_request_hash, payload_sha, row_count, validated_at, object_path }. FBA
// Inventory Health (source_snapshots 'fba-inventory-health') is retired and never read as current evidence.
//
// Listings has NO date column and its request hash is date-free (the same <=5-seller batch request every day), so the
// requested-day proof is the pointer's as_of: the fba job (and the listing-health-v3 job) record as_of = the cycle's
// inventory as-of when they persist the account's validated rows. So:
//   - a NEW cycle day yields a pointer with a NEW as_of -> a live Brand View inventory built from an older day is STALE;
//   - a SAME-DAY re-fetch / correction changes payload_sha; that content change is folded into revisionId AND recorded as
//     a durable CONTENT-provenance token (fbaContentProvenanceToken) in the brand-inventory report job's
//     durable_content_deps, so revisionCoveredByJob detects it on the very next pass.
// A pointer for another day (or none) is INELIGIBLE (defer; never publish stale inventory as fresh). A row_count=0
// pointer for the requested day is a proven-empty (inventory unavailable), never a manufactured zero. Whether the rows
// carry the expanded inventory fields is proven at derive time (the compact builder marks a pre-cutover payload
// unavailable). 7-bit ASCII, LF.

import { createHash } from "node:crypto";

const S = (v) => (v == null ? "" : String(v));
const nb = (v) => S(v).trim() !== "";

// The durable inventory source key the content token names (the saved Listings snapshot family).
export const FBA_INVENTORY_DURABLE_SOURCE_KEY = "listings";

// FBA revision status vocabulary (parallels OLI_LINEAGE_STATUS). AVAILABLE = a non-empty pointer for the requested day;
// PROVEN_EMPTY = a row_count=0 pointer for the requested day (inventory unavailable); MISSING = no pointer / another day /
// blank content hash (defer).
export const FBA_REVISION_STATUS = Object.freeze({ AVAILABLE: "available", PROVEN_EMPTY: "proven-empty", MISSING: "missing" });

// The AUTHORITATIVE durable FBA CONTENT-provenance token: a deterministic, human-readable canonical string binding the
// EXACT durable inventory snapshot a brand-inventory report consumed -- source key, account, connection, request hash and
// payload_sha (content identity). Recorded in the brand-inventory report job's durable_content_deps by every producer
// (the reconciler release and the source-first runtime) with the SAME semantics, and it is the revision's contentDeps
// entry the shared revisionCoveredByJob checks against. A pipe-delimited provenance string (never a bare sha).
export function fbaContentProvenanceToken({ sourceKey, accountId, connectionId = "primary", requestHash, contentSha } = {}) {
  return [S(sourceKey), S(accountId), S(connectionId), S(requestHash), S(contentSha)].join("|");
}

const dayOf = (v) => {
  const d = S(v).trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : "";
};

/**
 * Deterministic durable FBA-inventory revision for ONE account. Inputs:
 *   snapshot -- the durable Listings pointer for the account: { as_of | asOf, source_request_hash | sourceRequestHash,
 *               payload_sha | payloadSha, row_count | rowCount, validated_at | validatedAt }, or null when absent.
 *   requestedAsOf -- the cycle day the reconciler is publishing for.
 * (`expectedRequestHash` is accepted for call-site compatibility and IGNORED: Listings has a date-free request hash.)
 * Returns { eligible, status, revisionId, deps:[], contentDeps:[token] | [], reason }.
 */
export function computeFbaAccountRevision({ organizationFingerprint, connectionId = "primary", accountId, requestedAsOf, snapshot } = {}) {
  const missing = (reason) => ({ eligible: false, status: FBA_REVISION_STATUS.MISSING, revisionId: null, deps: [], contentDeps: [], reason });
  if (!organizationFingerprint || !accountId || !requestedAsOf) return missing("incomplete-account-boundary");
  if (!snapshot || typeof snapshot !== "object") return missing("no-durable-listings-snapshot");
  const asOf = dayOf(snapshot.as_of ?? snapshot.asOf);
  const requestHash = S(snapshot.source_request_hash ?? snapshot.sourceRequestHash);
  const payloadSha = S(snapshot.payload_sha ?? snapshot.payloadSha);
  const rowCount = Number(snapshot.row_count ?? snapshot.rowCount);
  if (!nb(requestHash)) return missing("snapshot-request-hash-blank");
  if (!nb(payloadSha)) return missing("snapshot-content-hash-blank");
  if (!Number.isFinite(rowCount) || rowCount < 0) return missing("snapshot-row-count-invalid");
  // REQUESTED-DAY PROOF: the pointer must be the snapshot recorded for EXACTLY the requested cycle day. Another day's
  // pointer is STALE for this as-of -> defer, never publish it as fresh.
  if (asOf !== dayOf(requestedAsOf)) return missing("listings-snapshot-not-requested-day");
  const status = rowCount > 0 ? FBA_REVISION_STATUS.AVAILABLE : FBA_REVISION_STATUS.PROVEN_EMPTY;
  const revisionId = createHash("sha256")
    .update([S(organizationFingerprint), S(connectionId), S(accountId), S(requestedAsOf), status, requestHash, payloadSha].join("|"))
    .digest("hex").slice(0, 32);
  // deps is EMPTY (the inventory export is not a job in the reconcile cycle); all inventory provenance is carried by the
  // CONTENT token in contentDeps (recorded in the report job's durable_content_deps).
  const contentDeps = [fbaContentProvenanceToken({ sourceKey: FBA_INVENTORY_DURABLE_SOURCE_KEY, accountId, connectionId, requestHash, contentSha: payloadSha })];
  return { eligible: true, status, revisionId, deps: [], contentDeps, reason: null };
}
