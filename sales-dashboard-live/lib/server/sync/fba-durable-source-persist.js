// ZERO-EXPORT durable FBA source-snapshot persist for the FBA Shipment Plan go-live.
//
// THE GAP THIS CLOSES: the fba-plan go-live fetches FBA Inventory Health into the batched source-job cache and
// derives the fba-plan report (+ downstream brand-inventory), but it historically NEVER wrote the durable
// public.source_snapshots(source_key='fba-inventory-health') row that the ZERO-EXPORT FBA publication reconciler
// reads. With zero such rows the reconciler finds EVERY account ineligible and defers forever, so the FBA
// backstop could never converge after a scheduler failure. (The source-family persist in runBucketSourceSync is
// never reached on the FBA go-live's shadow/report-dispatch path, and the priority run pauses FBA entirely.)
//
// THE FIX (correct ownership boundary, FBA-owned, zero export): after the fba-plan cycle drains, persist -- per
// included account -- the SAME validated inventory rows the fba-plan derive consumed. Those rows already live in
// the shared batch payload in the source-job cache; we isolate this account's seller + marketplace rows with the
// CANONICAL derive-time isolation (isolateFragmentRowsForOwner, the exact function the report worker uses), then
// persist them under the per-seller identity resolvedFbaSnapshot(account).requestHash -- EXACTLY the store +
// identity the reconciler recomputes in resolveExpectedRequestHash. So:
//   - ZERO DataDoe export/token (reuses the already-fetched cache);
//   - the reconciler reads the durable snapshot it always expected (no second store, no weakened validation);
//   - the persisted rows are byte-identical to what the fba-plan derive used, so the reconciler's re-derived
//     brand-inventory matches the go-live's brand-inventory (no divergence, no double-count).
//
// SAFETY: per-account isolated (one account's failure never blocks the rest); idempotent (the record_source_snapshot
// CAS treats an identical re-persist as 'unchanged' and an older one as 'stale-save'); NEVER fabricates -- a cache
// miss, an isolation rejection, or a marketplace-validation failure SKIPS that account (its last-known-good durable
// snapshot, if any, is preserved). It writes ONLY source_snapshots(fba-inventory-health); it touches no OLI/Ads/
// Listings/Catalog source or any report.

import { isolateFragmentRowsForOwner, missingOwnerFields } from "./source-account-isolation.js";
import { FBA_INVENTORY_SOURCE_KEY } from "./source-durable-model.js";
import { resolvedFbaSnapshot, validateFbaSnapshotRows } from "./source-bucket-sync.js";

const S = (v) => (v == null ? "" : String(v));
const INVENTORY_REQUEST_KEY = "fba-plan:inventory-health";

// The fba-plan:inventory-health source fragment for one account's planned report request (or null).
function inventorySourceOf(request) {
  const sources = request && Array.isArray(request.sources) ? request.sources : [];
  return sources.find((s) => S(s.requestKey) === INVENTORY_REQUEST_KEY) || null;
}

/**
 * Persist the durable FBA source snapshots for the accounts this go-live fetched, reusing the source-job cache
 * (ZERO export). Pure orchestration over injected I/O so it is fully offline-testable.
 *
 * @param reportRequests   the batched plan's per-account report requests (cost.plan.reportRequests); each carries
 *                         `owner` (rawSellerId/org/connection/marketplace/...) + `sources[]` (the shared batch
 *                         fragment with requestHash / sellerOrVendorIds / sourceScope / org / connection).
 * @param includedIds      the accounts this pass actually fetched/published (blocked accounts are excluded).
 * @param inventoryAsOf    the single FBA snapshot day (D-1); the per-seller identity is bound to it.
 * @param bucket           the routing region (metadata for resolvedFbaSnapshot; not part of the hash).
 * @param apiKey           the primary connection's api key (folds into the per-seller request hash exactly as the
 *                         reconciler's resolveExpectedRequestHash does).
 * @param accountsById     Map accountId -> { country } (directory country, required by resolvedFbaSnapshot).
 * @param loadSourceExportCache (requestHash) => { rows } | null   -- the source-job cache reader.
 * @param saveSnapshotPayload   ({organizationFingerprint,connectionId,sourceKey,scopeKey,rows}) => {objectPath,payloadSha,payloadBytes}
 * @param recordSnapshot        ({...,objectPath,payloadSha,rowCount,payloadBytes,sourceRequestHash,validatedAt}) => {write,ack}
 * @returns { persisted:[], skipped:[], failed:[], error? }
 */
export async function persistDurableFbaSnapshotsFromPlan({
  reportRequests = [], includedIds = [], inventoryAsOf, bucket, apiKey, connectionId = "primary",
  accountsById = new Map(),
  loadSourceExportCache, saveSnapshotPayload, recordSnapshot,
  now = () => new Date().toISOString(),
  outOfTime = () => false, log = () => {},
} = {}) {
  const result = { persisted: [], skipped: [], failed: [] };
  if (typeof loadSourceExportCache !== "function" || typeof saveSnapshotPayload !== "function" || typeof recordSnapshot !== "function") {
    return { ...result, error: "persistDurableFbaSnapshotsFromPlan requires loadSourceExportCache/saveSnapshotPayload/recordSnapshot" };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(S(inventoryAsOf))) {
    return { ...result, error: "persistDurableFbaSnapshotsFromPlan requires a YYYY-MM-DD inventoryAsOf" };
  }
  const included = new Set((includedIds || []).map(S).filter(Boolean));
  const byId = accountsById instanceof Map ? accountsById : new Map(Object.entries(accountsById || {}));

  for (const request of reportRequests || []) {
    const accountId = S(request && request.accountId);
    // Persist ONLY the accounts this pass actually fetched/published; an empty includedIds persists nothing.
    if (!accountId || !included.has(accountId)) continue;
    if (outOfTime()) { result.skipped.push({ accountId, reason: "out-of-time" }); continue; }
    try {
      const owner = request.owner || null;
      const missing = missingOwnerFields(owner);
      if (missing.length) { result.skipped.push({ accountId, reason: "owner-incomplete:" + missing.join(",") }); continue; }
      const invSource = inventorySourceOf(request);
      if (!invSource || !S(invSource.requestHash)) { result.skipped.push({ accountId, reason: "no-inventory-source" }); continue; }
      const meta = byId.get(accountId) || {};
      const country = S(meta.country);
      if (!country) { result.skipped.push({ accountId, reason: "no-directory-country" }); continue; }

      // Per-seller durable identity -- EXACTLY what the reconciler recomputes (resolveExpectedRequestHash). The
      // hash folds apiKey/sourceId/columns/ids([rawSellerId])/from=to=inventoryAsOf/limit/options -- NOT the
      // country -- so it equals the reconciler's expected hash whenever the as-of day matches.
      let identity;
      try {
        identity = resolvedFbaSnapshot({ apiKey, account: { rawSellerId: owner.rawSellerId, country }, asOf: inventoryAsOf, bucket });
      } catch { result.skipped.push({ accountId, reason: "identity-unresolved" }); continue; }
      const requestHash = S(identity && (identity.requestHash ?? identity.request_hash));
      if (!requestHash) { result.skipped.push({ accountId, reason: "identity-blank" }); continue; }

      // Load the ALREADY-FETCHED batch payload (ZERO export) and isolate this account's seller + marketplace rows
      // with the canonical derive-time isolation (rejects a cross-org/cross-connection owner; filters to exactly
      // this rawSellerId + its marketplace, so an EU batch never leaks another warehouse's / seller's rows).
      const cached = await loadSourceExportCache(S(invSource.requestHash));
      if (!cached || !Array.isArray(cached.rows)) { result.skipped.push({ accountId, reason: "source-cache-miss" }); continue; }
      const fragment = {
        rows: cached.rows,
        sourceScope: invSource.sourceScope || "seller",
        sellerOrVendorIds: invSource.sellerOrVendorIds || null,
        organizationFingerprint: invSource.organizationFingerprint ?? owner.organizationFingerprint,
        connectionId: invSource.connectionId ?? owner.connectionId,
      };
      const iso = isolateFragmentRowsForOwner(fragment, owner);
      if (iso.rejected || !Array.isArray(iso.rows)) { result.skipped.push({ accountId, reason: "isolation-rejected" }); continue; }
      const rows = iso.rows;

      // Persistence-side marketplace validation -- the SAME gate the single-seller source path uses. Validate
      // against the OWNER's Amazon marketplace code (the code the fetched rows actually carry). A zero-row payload
      // is VALID-EMPTY evidence (honest 'inventory unavailable'); it is never fabricated as available units.
      const v = validateFbaSnapshotRows(rows, owner.marketplace);
      if (!v.valid) { result.failed.push({ accountId, reason: "fba-rows-invalid:" + v.code }); continue; }

      const validatedAt = now();
      const saved = await saveSnapshotPayload({
        organizationFingerprint: owner.organizationFingerprint, connectionId,
        sourceKey: FBA_INVENTORY_SOURCE_KEY, scopeKey: accountId, rows,
      });
      const rec = await recordSnapshot({
        organizationFingerprint: owner.organizationFingerprint, connectionId,
        sourceKey: FBA_INVENTORY_SOURCE_KEY, scopeKey: accountId,
        objectPath: saved.objectPath, payloadSha: saved.payloadSha, rowCount: rows.length,
        payloadBytes: saved.payloadBytes, sourceRequestHash: requestHash, validatedAt,
      });
      const ack = rec ? S(rec.ack) : "";
      result.persisted.push({ accountId, requestHash, rowCount: rows.length, ack });
    } catch (e) {
      // Per-account isolation: one account's persist failure never blocks the others (LKG preserved).
      result.failed.push({ accountId, reason: "persist-threw:" + S(e && e.message ? e.message : e) });
    }
  }
  return result;
}
