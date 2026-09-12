// Durable Listings / Listings-Raw revision identity for listing-health-v3 -- PURE (no I/O; the reconciler supplies the
// two durable per-account pointers). The listing-health-v3 analog of computeFbaAccountRevision.
//
// listing-health-v3 is re-derivable ZERO-export from ALREADY-SAVED durable data: the per-account Listings snapshot
// (source_listings_snapshot, source_key='listings') + Listings-Raw snapshot (source_listings_raw_snapshot,
// source_key='listings-raw') persisted by the LHv3 materialization hook (WORK B), plus durable OLI + Product Catalog
// (derived deps loaded by the release). THIS module owns ONLY the Listings + Listings-Raw content-freshness identity.
//
// KEY DIVERGENCE from FBA: the per-account Listings/Raw read request hash is DATE-FREE (the listings export is a
// no-date "current listing state" snapshot; listing-health-v3-materialize.js DATE_FREE_WINDOWS). So the request hash
// CANNOT prove D-1 -- the D-1 date lives in the pointer's dedicated `as_of` column (recorded = plan.context.to at
// persist time). Therefore:
//   - D-1 PROOF is a DIRECT `snapshot.as_of === requestedAsOf` column compare (not a recomputed request-hash match);
//     an OLDER (stale) OR FUTURE (unexpected) as-of both DEFER (never publish a mismatched-date listing state as
//     fresh, never shadow a proven-available last-known-good), and there is no expectedRequestHash collaborator.
//   - The CONTENT-provenance token MUST FOLD `as_of` (the inverse of the FBA token's deliberate omission, whose hash
//     is itself date-addressed): a next-day advance changes `as_of` -> a NEW token -> the live report built from the
//     old day is provably STALE; a SAME-DAY provider correction keeps `as_of` but changes payload_sha -> also a new
//     token. Both are recorded in the report job's durable_content_deps (migration 20260925) and checked by the shared
//     revisionCoveredByJob (contentDeps subset of durable_content_deps).
//
// BOTH pointers are REQUIRED to be a proven-D-1 snapshot for eligibility: listing-health-v3 promotes to live ONLY when
// it has genuine same-day Listings AND Listings-Raw durable evidence (the exact set the LHv3 materialization persists
// together on a fully-successful ingestion). An account missing either pointer (or at an older/future as-of) DEFERS on
// its last-known-good -- the safe/preview path still serves it; a mismatched-date payload is never promoted.
//
// OLI-FRESHNESS SCOPE (deliberate; documented PRODUCTION-ACCEPTANCE limitation). listing-health-v3's sales/units come
// from DURABLE OLI (the release loads it via makeListingHealthV3DurableContextLoader) but the revision keys the
// re-derive decision ONLY on the two Listings pointers -- NOT on the OLI content. This is safe in NORMAL operation
// because the OLI rolling refresh and the LHv3 ingestion (which re-persists these Listings pointers at the new as_of)
// run in the SAME daily regional cycle: a new as_of advances the Listings pointers AND the OLI together, so the
// reconciler re-promotes with the freshest OLI, and the promoted live row + the always-fresh preview stay consistent.
// (Folding the OLI request hash would not help: it is DATE-addressed and stable across a same-slice re-export, so even
// computeOliAccountRevision does not detect a same-slice provisional->final correction via its deps.) Two residual
// windows exist, BOTH bounded + fail-safe (never a fabricated number; the durable loader fails closed to LKG):
//   (a) NORMAL same-slice itemization: after a cycle promotes live@X with that cycle's provisional OLI, Amazon
//       finalizes X's item-level OLI intra-day (the ~1-2 day D-1 itemization lag) while Listings next re-persist only
//       at the FOLLOWING cycle (targeting X+1). live@X's frozen OLI transiently lags the always-fresh preview -- but
//       this SELF-HEALS within one cycle: the report window is rolling 30D ([asOf-29..asOf]), so the next promotion
//       (report@X+1) re-includes day X derived from the finalized OLI. The lagging day is the most-recent day, already
//       labelled provisional via completenessRows.
//   (b) PARTIAL failure: OLI advances/corrects for X while the Listings/v3 ingestion for X does NOT run that cycle --
//       the reconciler then DEFERS (no D-1 Listings), so the prior dated promotion keeps serving its LKG until Listings
//       re-persist (never a mismatched-date publish).
// A completeness-fingerprint binding (fold the OLI coverage+completeness digest into contentDeps) is the recommended
// follow-on if even the sub-cycle (a) lag must be closed; it is NOT required for correctness (bounded + self-healing).
// 7-bit ASCII, LF.

import { createHash } from "node:crypto";
import { LISTINGS_SOURCE_KEY, LISTINGS_RAW_SOURCE_KEY } from "./source-durable-model.js";

const S = (v) => (v == null ? "" : String(v));
const nb = (v) => S(v).trim() !== "";

// Revision status vocabulary (parallels FBA_REVISION_STATUS). AVAILABLE = a non-empty proven-D-1 pair; PROVEN_EMPTY =
// both pointers are a valid row_count=0 snapshot (an account with no listings AND no raw rows -- a legitimate empty,
// never a manufactured zero); MISSING = a pointer absent / at an older-or-future as-of / with a blank content hash
// (defer).
export const LISTINGS_REVISION_STATUS = Object.freeze({ AVAILABLE: "available", PROVEN_EMPTY: "proven-empty", MISSING: "missing" });

// The AUTHORITATIVE durable Listings/Listings-Raw CONTENT-provenance token: a deterministic, human-readable canonical
// string binding the EXACT durable snapshot a listing-health-v3 report consumed -- source key, account, connection,
// AS-OF, request hash AND payload_sha (content identity). Recorded in the report job's durable_content_deps by the
// reconciler derive, and the revision's contentDeps entry the shared revisionCoveredByJob checks against. The as-of is
// folded (the listings request hash is date-FREE), so a date advance OR a same-date correction both yield a DIFFERENT
// token. Never a bare sha (ambiguous with a request hash in depends_on) -- a pipe-delimited, self-describing,
// subset-checkable provenance string.
function listingsProvenanceToken({ sourceKey, accountId, connectionId = "primary", asOf, requestHash, contentSha } = {}) {
  return [S(sourceKey), S(accountId), S(connectionId), S(asOf), S(requestHash), S(contentSha)].join("|");
}
export function listingsContentProvenanceToken(args = {}) {
  return listingsProvenanceToken({ ...args, sourceKey: LISTINGS_SOURCE_KEY });
}
export function listingsRawContentProvenanceToken(args = {}) {
  return listingsProvenanceToken({ ...args, sourceKey: LISTINGS_RAW_SOURCE_KEY });
}

/**
 * Deterministic durable listing-health-v3 revision for ONE account. Inputs:
 *   listingsSnapshot     -- the durable source_listings_snapshot row for (org, conn, account): a plain object with
 *                           { source_request_hash|sourceRequestHash, payload_sha|payloadSha, row_count|rowCount,
 *                           as_of|asOf, validated_at|validatedAt }, or null when there is no durable snapshot.
 *   listingsRawSnapshot  -- the durable source_listings_raw_snapshot row (same shape), or null.
 * Returns:
 *   { eligible:true,  status, revisionId:<32 hex>, deps:[], contentDeps:[<listings token>, <raw token>], reason:null }  when provable
 *   { eligible:false, status:MISSING, revisionId:null, deps:[], contentDeps:[], reason:<token> }                          otherwise (defer)
 * The revisionId folds BOTH pointers' request hash AND payload_sha, so any content change on EITHER side yields a
 * distinct deterministic cycle-bucket identity. `deps` is EMPTY (Listings/Raw are per-account durable pointers, never
 * cycle jobs in priority mode -- identical to FBA priority mode); all durable content provenance is carried by
 * `contentDeps` (two tokens) which the shared revisionCoveredByJob checks against the report job's durable_content_deps.
 */
export function computeListingHealthV3AccountRevision({
  organizationFingerprint, connectionId = "primary", accountId, requestedAsOf,
  listingsSnapshot, listingsRawSnapshot,
} = {}) {
  const miss = (reason) => ({ eligible: false, status: LISTINGS_REVISION_STATUS.MISSING, revisionId: null, deps: [], contentDeps: [], reason });
  if (!organizationFingerprint || !accountId || !requestedAsOf) return miss("incomplete-account-boundary");
  if (!listingsSnapshot || typeof listingsSnapshot !== "object") return miss("no-durable-listings-snapshot");
  if (!listingsRawSnapshot || typeof listingsRawSnapshot !== "object") return miss("no-durable-listings-raw-snapshot");

  const lHash = S(listingsSnapshot.source_request_hash ?? listingsSnapshot.sourceRequestHash);
  const lSha = S(listingsSnapshot.payload_sha ?? listingsSnapshot.payloadSha);
  const lRows = Number(listingsSnapshot.row_count ?? listingsSnapshot.rowCount);
  const lAsOf = S(listingsSnapshot.as_of ?? listingsSnapshot.asOf);

  const rHash = S(listingsRawSnapshot.source_request_hash ?? listingsRawSnapshot.sourceRequestHash);
  const rSha = S(listingsRawSnapshot.payload_sha ?? listingsRawSnapshot.payloadSha);
  const rRows = Number(listingsRawSnapshot.row_count ?? listingsRawSnapshot.rowCount);
  const rAsOf = S(listingsRawSnapshot.as_of ?? listingsRawSnapshot.asOf);

  if (!nb(lHash)) return miss("listings-snapshot-request-hash-blank");
  if (!nb(lSha)) return miss("listings-snapshot-content-hash-blank");
  if (!Number.isFinite(lRows) || lRows < 0) return miss("listings-snapshot-row-count-invalid");
  if (!nb(rHash)) return miss("listings-raw-snapshot-request-hash-blank");
  if (!nb(rSha)) return miss("listings-raw-snapshot-content-hash-blank");
  if (!Number.isFinite(rRows) || rRows < 0) return miss("listings-raw-snapshot-row-count-invalid");
  // EXACT D-1 PROOF: BOTH pointers' as_of MUST equal the requested as-of. An OLDER (stale) or FUTURE (unexpected)
  // as-of DEFERS -- never publish a mismatched-date listing state as fresh, never shadow a proven-available LKG.
  if (lAsOf !== S(requestedAsOf)) return miss("listings-not-d1");
  if (rAsOf !== S(requestedAsOf)) return miss("listings-raw-not-d1");

  const status = lRows === 0 && rRows === 0 ? LISTINGS_REVISION_STATUS.PROVEN_EMPTY : LISTINGS_REVISION_STATUS.AVAILABLE;
  const revisionId = createHash("sha256")
    .update([S(organizationFingerprint), S(connectionId), S(accountId), S(requestedAsOf), status, lHash, lSha, rHash, rSha].join("|"))
    .digest("hex").slice(0, 32);
  const contentDeps = [
    listingsContentProvenanceToken({ accountId, connectionId, asOf: requestedAsOf, requestHash: lHash, contentSha: lSha }),
    listingsRawContentProvenanceToken({ accountId, connectionId, asOf: requestedAsOf, requestHash: rHash, contentSha: rSha }),
  ];
  return { eligible: true, status, revisionId, deps: [], contentDeps, reason: null };
}
