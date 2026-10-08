// ZERO-EXPORT durable FBA-inventory persist for the FBA Shipment Plan job -- since the Listings inventory cutover (2026-10)
// it lands the account's SAVED LISTINGS snapshot (public.source_listings_snapshot), the ONE saved inventory snapshot.
//
// WHY: FBA inventory now comes from the canonical DataDoe Listings export (FBA Inventory Health is retired). The fba job
// fetches that export (fba-plan:awd, shared with listing-health-v3:listings -- one paid export per <=5-seller batch) and
// derives the FBA Shipment Plan from it. The zero-export readers that need the inventory OUTSIDE the derive (the FBA
// publication reconciler / Brand View inventory release, Product Reporting, publish-from-saved-data) read the durable
// Listings pointer. Persisting it here, right after the fba job's own derive, makes it available in the SAME job (the
// listing-health-v3 job, which runs later, re-persists the identical rows -> "unchanged").
//
// HOW (correct ownership, zero export): per INCLUDED account, load the ALREADY-FETCHED batch from the source-job cache,
// isolate this account's seller + marketplace rows with the CANONICAL isolation (isolateFragmentRowsForOwner -- the exact
// function the report worker and the v3 materializer use), require the expanded Listings shape, then save the payload
// (content-addressed) and record the pointer through the existing record_source_listings_snapshot CAS:
//   as_of               = the cycle's inventory as-of (the requested day the readers prove freshness against);
//   validated_at        = the batch's fetched_at (the Listings fetch time -- what "Listings refreshed at" shows);
//   source_request_hash = the batch request hash (date-free; identical to the v3 materializer's).
// The v3 materializer writes the same rows with the same fetched_at, so the CAS answers "unchanged" (never a conflict).
//
// SAFETY: per-account isolated (one failure never blocks the rest); idempotent (CAS); NEVER fabricates -- a cache miss, an
// isolation rejection, a non-member empty, or a pre-cutover (not expanded) payload SKIPS the account (its last-known-good
// pointer stays). Writes ONLY source_listings_snapshot via the injected recorder; touches no report, no other source.

import { isolateFragmentRowsForOwner, missingOwnerFields } from "./source-account-isolation.js";
import { listingsRowsExpanded } from "../listings-inventory.js";

const S = (v) => (v == null ? "" : String(v));
const LISTINGS_REQUEST_KEY = "fba-plan:awd"; // the fba-plan owner of the canonical Listings export
export const DURABLE_LISTINGS_SOURCE_KEY = "listings";

function listingsSourceOf(request) {
  const sources = request && Array.isArray(request.sources) ? request.sources : [];
  return sources.find((s) => S(s.requestKey) === LISTINGS_REQUEST_KEY) || null;
}

/**
 * Persist the durable Listings snapshots for the accounts this fba pass fetched, reusing the source-job cache (ZERO
 * export). Pure orchestration over injected I/O (offline-testable).
 *
 * @param reportRequests   the batched plan's per-account fba-plan requests (each with `owner` + `sources[]`).
 * @param includedIds      the accounts this pass actually fetched/published (blocked accounts are excluded).
 * @param inventoryAsOf    the cycle's inventory as-of (YYYY-MM-DD) recorded as the pointer's as_of.
 * @param connectionId     the durable connection id (primary | dd-secondary).
 * @param loadSourceExportCache (requestHash) => { rows, fetched_at } | null   -- the source-job cache reader.
 * @param saveSnapshotPayload   ({organizationFingerprint,connectionId,sourceKey,scopeKey,rows}) => {objectPath,payloadSha,payloadBytes}
 * @param recordListingsSnapshot ({organizationFingerprint,connectionId,accountId,marketplace,asOf,objectPath,payloadSha,
 *                                rowCount,payloadBytes,sourceRequestHash,validatedAt}) => {write,ack}
 * @returns { persisted:[], skipped:[], failed:[], error? }
 */
export async function persistDurableListingsSnapshotsFromPlan({
  reportRequests = [], includedIds = [], inventoryAsOf, connectionId = "primary",
  loadSourceExportCache, saveSnapshotPayload, recordListingsSnapshot,
  outOfTime = () => false, log = () => {},
} = {}) {
  const result = { persisted: [], skipped: [], failed: [] };
  if (typeof loadSourceExportCache !== "function" || typeof saveSnapshotPayload !== "function" || typeof recordListingsSnapshot !== "function") {
    return { ...result, error: "persistDurableListingsSnapshotsFromPlan requires loadSourceExportCache/saveSnapshotPayload/recordListingsSnapshot" };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(S(inventoryAsOf))) {
    return { ...result, error: "persistDurableListingsSnapshotsFromPlan requires a YYYY-MM-DD inventoryAsOf" };
  }
  const durableConn = S(connectionId) === "secondary" || S(connectionId) === "dd-secondary" ? "dd-secondary" : "primary";
  const included = new Set((includedIds || []).map(S).filter(Boolean));

  for (const request of reportRequests || []) {
    const accountId = S(request && request.accountId);
    if (!accountId || !included.has(accountId)) continue; // persist ONLY the accounts this pass fetched/published
    if (outOfTime()) { result.skipped.push({ accountId, reason: "out-of-time" }); continue; }
    try {
      const owner = request.owner || null;
      const missing = missingOwnerFields(owner);
      if (missing.length) { result.skipped.push({ accountId, reason: "owner-incomplete:" + missing.join(",") }); continue; }
      const marketplace = S(owner.marketplace).trim().toUpperCase();
      if (!/^[A-Z]{2}$/.test(marketplace)) { result.skipped.push({ accountId, reason: "no-marketplace" }); continue; }
      const src = listingsSourceOf(request);
      if (!src || !S(src.requestHash)) { result.skipped.push({ accountId, reason: "no-listings-source" }); continue; }

      const batch = await loadSourceExportCache(S(src.requestHash));
      if (!batch || !Array.isArray(batch.rows)) { result.skipped.push({ accountId, reason: "source-cache-miss" }); continue; }
      const fetchedAt = S(batch.fetched_at || batch.fetchedAt).trim();
      if (!fetchedAt) { result.skipped.push({ accountId, reason: "batch-fetched-at-missing" }); continue; }
      const iso = isolateFragmentRowsForOwner({
        rows: batch.rows,
        sourceScope: src.sourceScope || "seller",
        sellerOrVendorIds: src.sellerOrVendorIds || null,
        organizationFingerprint: src.organizationFingerprint ?? owner.organizationFingerprint,
        connectionId: src.connectionId ?? owner.connectionId,
      }, owner);
      if (iso.rejected || !Array.isArray(iso.rows)) { result.skipped.push({ accountId, reason: "isolation-rejected" }); continue; }
      const rows = iso.rows;
      // "missing membership != empty": a zero-row snapshot is recorded ONLY for a proven batch member.
      const isMember = Array.isArray(src.sellerOrVendorIds) && src.sellerOrVendorIds.map(S).includes(S(owner.rawSellerId));
      if (rows.length === 0 && !isMember) { result.skipped.push({ accountId, reason: "not-a-batch-member" }); continue; }
      // Only the expanded (post-cutover) Listings shape is persisted from here; an old 15-column payload never
      // replaces the pointer from the fba job.
      if (rows.length > 0 && !listingsRowsExpanded(rows)) { result.skipped.push({ accountId, reason: "listings-not-expanded" }); continue; }

      const saved = await saveSnapshotPayload({
        organizationFingerprint: owner.organizationFingerprint, connectionId: durableConn,
        sourceKey: DURABLE_LISTINGS_SOURCE_KEY, scopeKey: accountId, rows,
      });
      const rec = await recordListingsSnapshot({
        organizationFingerprint: owner.organizationFingerprint, connectionId: durableConn,
        accountId, marketplace, asOf: S(inventoryAsOf),
        objectPath: saved.objectPath, payloadSha: saved.payloadSha, rowCount: rows.length,
        payloadBytes: saved.payloadBytes, sourceRequestHash: S(src.requestHash), validatedAt: fetchedAt,
      });
      result.persisted.push({ accountId, requestHash: S(src.requestHash), rowCount: rows.length, ack: rec ? S(rec.ack) : "" });
    } catch (e) {
      // Per-account isolation: one account's persist failure never blocks the others (LKG preserved).
      result.failed.push({ accountId, reason: "persist-threw:" + S(e && e.message ? e.message : e) });
    }
  }
  return result;
}
