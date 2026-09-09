// Latest-snapshot normalization for the FBA Plan / Listing Health v3 inventory contract ONLY (Phase: zero-export
// overflow recovery + permanent contract). FBA Plan and Listing Health v3 consume ONLY the latest inventory snapshot
// date, so an oversized or cap-sized single-seller inventory payload can be safely reduced to its LATEST PROVABLY-
// COMPLETE date -- which fits under the row cap and the 8MB source-cache object limit -- WITHOUT summing across dates
// and WITHOUT a new export. The source worker applies this ONLY to a source job whose contract is EXPLICITLY marked
// `latestSnapshot: true` (fba-plan:inventory-health + listing-health-v3:inventory, which share one request_hash), with
// the fba-inventory-health source key as a defense-in-depth second gate. The insight reports' own inventory contract
// (buy-box-loss/sales-movers, INSIGHT_INVENTORY_COLUMNS => a different request_hash, NOT flagged), OLI, Ads, Catalog,
// and every other source keep the generic strict validator UNCHANGED. `isLatestSnapshotSource` below is that second
// gate; the PRIMARY gate is the per-contract flag threaded onto the job.
//
// A cap-sized (truncated) response's latest date is COMPLETE only when the DataDoe date-DESC ordering proves the whole
// latest-date block arrived before the truncation point: monotonic date-descending, the latest date is one contiguous
// LEADING block, at least one STRICTLY OLDER date appears after it (so the block was not cut off), no latest-date row
// appears after an older-date row, the block is under the row cap, every block row matches the trusted seller +
// marketplace, and the compacted block is under the cache-object byte limit. A non-cap-sized response is already
// complete, so the older-date-after proof is not required (but every other guard still holds). Genuine zero/null
// inventory values are preserved verbatim (rows are never mutated, only filtered to the latest date).

export const FBA_INVENTORY_ROW_CAP = 50000;
export const FBA_INVENTORY_MAX_OBJECT_BYTES = 8 * 1024 * 1024;
export const LATEST_SNAPSHOT_NORMALIZATION_VERSION = "fba-inv-latest-snapshot/v1";
// The ONLY source keys marked latest-snapshot. The normalization exception applies EXCLUSIVELY to these + only to a
// SINGLE-seller batch; every other source (OLI/Ads/Catalog/Listings/...) keeps the generic strict validator unchanged.
export const LATEST_SNAPSHOT_SOURCE_KEYS = Object.freeze(["fba-inventory-health"]);
export function isLatestSnapshotSource(sourceKey) { return LATEST_SNAPSHOT_SOURCE_KEYS.includes(S(sourceKey)); }

const S = (v) => (v == null ? "" : String(v));
const bytesOf = (rows) => { try { return Buffer.byteLength(JSON.stringify({ rows }), "utf8"); } catch { return Infinity; } };

/**
 * Reduce a SINGLE-SELLER FBA inventory payload to its latest provably-complete date. PURE (no I/O; rows never mutated).
 * `rows` are the downloaded inventory rows (DataDoe returns them ordered by date DESC). Returns:
 *   { complete:true, snapshotDate, rows:block, metadata:{...}, proof:{...} }  when the latest date is provably complete,
 *   { complete:true, empty:true, inventoryAvailable:false, snapshotDate:null, rows:[], metadata:{...} }
 *                                                                              when a BOUNDED exact single-day (D-1)
 *                                                                              export legitimately returned zero rows
 *                                                                              (typed inventory-unavailable, NOT zero
 *                                                                              stock, NOT a proven snapshot date),
 *   { complete:false, reason, proof:{...} }                                    otherwise (never infer completeness).
 * `metadata` carries the durable provenance the cache row should record (raw/compacted row counts + bytes, the snapshot
 * date, the completeness proof, and the caller-supplied source export reference).
 */
export function compactLatestInventorySnapshot({ rows, seller, marketplace, rowCap = FBA_INVENTORY_ROW_CAP, maxObjectBytes = FBA_INVENTORY_MAX_OBJECT_BYTES, exportRef = null, requestedFrom = null, requestedTo = null } = {}) {
  if (!Array.isArray(rows)) return { complete: false, reason: "MALFORMED_PAYLOAD", proof: {} };
  const sellerId = S(seller);
  const mkt = S(marketplace).trim().toUpperCase();
  const rawRowCount = rows.length;
  const capSized = rawRowCount >= rowCap;
  if (rawRowCount === 0) {
    // A SUCCESSFULLY-completed export that returned ZERO rows is honest inventory-UNAVAILABLE -- but ONLY when it was a
    // BOUNDED, exact single-day (D-1) request (requestedFrom === requestedTo, both a real calendar date). Such an empty
    // result is typed inventory-unavailable FOR THAT DAY: NOT measured zero stock, NOT a proven snapshot date, and NOT a
    // truncation. This makes a single-seller latest-snapshot empty response CONSISTENT with a multi-seller batch's
    // zero-row valid-empty (which the generic path already accepts) instead of a terminal hard stop -- so splitting a
    // seller can no longer flip a successful empty inventory export from valid-empty to blocked. An UNBOUNDED / multi-day
    // / missing-window empty proves NOTHING (an empty lookback could hide an incomplete or wrong window), so it stays
    // EMPTY_PAYLOAD (rejected -> the source worker records LATEST_SNAPSHOT_INCOMPLETE; previous data preserved). The
    // downstream derive reads the empty rows and resolves inventoryAvailable=false (no fabricated zero, no fresh date).
    const reqFrom = S(requestedFrom);
    const reqTo = S(requestedTo);
    const boundedSingleDay = /^\d{4}-\d{2}-\d{2}$/.test(reqFrom) && reqFrom === reqTo;
    if (!boundedSingleDay) {
      return { complete: false, reason: "EMPTY_PAYLOAD", proof: { rawRowCount: 0, requestedFrom: reqFrom || null, requestedTo: reqTo || null, boundedSingleDay: false } };
    }
    return {
      complete: true,
      empty: true,
      inventoryAvailable: false,
      snapshotDate: null,
      rows: [],
      proof: { rawRowCount: 0, boundedSingleDayEmpty: true, requestedFrom: reqFrom, requestedTo: reqTo },
      metadata: {
        requestedFrom: reqFrom,
        requestedTo: reqTo,
        inventorySnapshotDate: null,
        inventoryAvailable: false,
        inventoryUnavailable: true,
        emptyInventorySnapshot: true,
        rawRowCount: 0,
        compactedRowCount: 0,
        rawPayloadBytes: bytesOf([]),
        compactedPayloadBytes: bytesOf([]),
        latestDateCompletenessProof: { boundedSingleDayEmpty: true },
        normalizedLatestSnapshot: true,
        normalizationVersion: LATEST_SNAPSHOT_NORMALIZATION_VERSION,
        sourceExportRef: exportRef || null,
      },
    };
  }

  const dateOf = (r) => S(r && r.date);
  const latestDate = rows.reduce((m, r) => { const d = dateOf(r); return d > m ? d : m; }, "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(latestDate)) return { complete: false, reason: "NO_VALID_LATEST_DATE", proof: { latestDate } };

  // Monotonic date-descending across the WHOLE payload (DataDoe orderByDirection DESC).
  let monotonicDesc = true;
  for (let i = 1; i < rows.length; i += 1) { if (dateOf(rows[i]) > dateOf(rows[i - 1])) { monotonicDesc = false; break; } }
  // The leading contiguous block of latest-date rows.
  let k = 0; while (k < rows.length && dateOf(rows[k]) === latestDate) k += 1;
  const block = rows.slice(0, k);
  const tail = rows.slice(k);
  const blockContiguous = block.every((r) => dateOf(r) === latestDate);
  const olderDateAfterBlock = tail.some((r) => dateOf(r) < latestDate);
  const noLatestAfterOlder = !tail.some((r) => dateOf(r) === latestDate);
  const blockUnderRowCap = k < rowCap;
  const allBlockSellerMkt = block.every((r) => S(r.seller_or_vendor_id) === sellerId && S(r.marketplace_country_code).trim().toUpperCase() === mkt);
  const compactedPayloadBytes = bytesOf(block);
  const compactUnder8MB = compactedPayloadBytes <= maxObjectBytes;

  // The completeness CONDITIONS (every one must hold). `capSized` is NOT a condition -- it is a descriptor that only
  // decides whether the older-date-after proof is REQUIRED (a cap-sized response could have been cut mid-latest-date,
  // so it must show a strictly-older date after the block; a non-cap-sized response is already whole).
  const conditions = {
    monotonicDesc, blockContiguous,
    olderDateAfterBlock: capSized ? olderDateAfterBlock : true,
    noLatestAfterOlder, blockUnderRowCap, allBlockSellerMkt, compactUnder8MB,
  };
  const proof = { capSized, ...conditions };
  const complete = Object.values(conditions).every(Boolean);
  if (!complete) {
    const failed = Object.entries(conditions).filter(([, v]) => !v).map(([k2]) => k2);
    return { complete: false, reason: "LATEST_DATE_NOT_PROVABLY_COMPLETE:" + failed.join(","), proof, snapshotDate: latestDate };
  }
  return {
    complete: true,
    snapshotDate: latestDate,
    rows: block,
    proof,
    metadata: {
      requestedFrom: requestedFrom || null,
      requestedTo: requestedTo || null,
      inventorySnapshotDate: latestDate,
      rawRowCount,
      compactedRowCount: block.length,
      rawPayloadBytes: bytesOf(rows),
      compactedPayloadBytes,
      latestDateCompletenessProof: proof,
      normalizedLatestSnapshot: true,
      normalizationVersion: LATEST_SNAPSHOT_NORMALIZATION_VERSION,
      sourceExportRef: exportRef || null,
    },
  };
}
