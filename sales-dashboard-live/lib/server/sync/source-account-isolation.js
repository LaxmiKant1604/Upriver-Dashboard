// Scheduler v2 Blocker 4c -- PER-ACCOUNT ISOLATION of rows loaded from ONE shared <=5-account batch source.
//
// Pure, ZERO I/O. It does NOT orchestrate anything (that is the global fixpoint driver) and is not wired to
// any route/cron. Two concerns:
//
//   (1) validateBatchSourcePayload -- proves a COMPLETE downloaded batch payload contains ONLY rows for the
//       exact canonical batch sellers BEFORE it is saved, so ONE canonical payload can be kept in
//       source_export_cache and split back per account later (never a per-account duplicate object).
//
//   (2) isolateFragmentRowsForOwner -- at DERIVE time, filters ONE owner's rows out of the shared payload and
//       narrows the fragment scope to exactly [ownerRawSellerId], WITHOUT mutating the shared cached payload.
//
// The authoritative public accountId -> rawSellerId mapping is the PLANNED OWNER metadata established in
// corrected Blocker 4b -- never inferred from row order and never a caller-provided hash. Rows are trusted for
// identity only through the seller_or_vendor_id column the seller-scoped contract actually fetched; a source
// that did NOT fetch that column (e.g. organization-wide Product Catalog) is NEVER seller-filtered.

export const SELLER_ID_COLUMN = "seller_or_vendor_id";

// A source/contract is SELLER-SCOPED iff its fetched columns include the per-account partition column
// seller_or_vendor_id. This is the EXPLICIT proof required before any per-account filtering: Product Catalog
// (organization-wide) does not fetch it, so it can never be seller-filtered.
export function isSellerScopedColumns(columns) {
  return Array.isArray(columns) && columns.map((c) => String(c)).includes(SELLER_ID_COLUMN);
}

// The fetched column list of a planned source fragment, from its immutable request metadata (or an explicit
// `columns`), or null. Never guesses from row keys (a row is not authority for what was fetched).
export function fragmentColumns(fragment) {
  if (!fragment || typeof fragment !== "object") return null;
  if (fragment.requestMeta && Array.isArray(fragment.requestMeta.columns)) return fragment.requestMeta.columns;
  if (Array.isArray(fragment.columns)) return fragment.columns;
  return null;
}

// A row carries account evidence when it is a non-null, non-array object with at least one own defined,
// non-blank value. An all-empty row ({}) asserts NO account, so it does not itself fail the seller-membership
// proof (item 1: "every NON-EMPTY row must contain a nonblank seller_or_vendor_id").
function rowIsNonEmpty(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return false;
  return Object.keys(row).some((k) => {
    const v = row[k];
    return v !== null && v !== undefined && String(v) !== "";
  });
}

// The row's seller_or_vendor_id as a canonical string ("" when blank/absent). Never coerces null/undefined
// to the literal strings "null"/"undefined".
function rowSellerId(row) {
  const v = row ? row[SELLER_ID_COLUMN] : undefined;
  return v === null || v === undefined ? "" : String(v);
}

/**
 * Validate a COMPLETE downloaded batch payload BEFORE it is saved (item 1). Returns `{ valid, code, reason }`.
 *   - the payload must be an ARRAY (else MALFORMED_PAYLOAD);
 *   - a NON-seller-scoped source (no seller_or_vendor_id column, e.g. Product Catalog) is never
 *     seller-validated -- it is organization-wide (item 6);
 *   - a seller-scoped batch must resolve a non-empty canonical `sellerOrVendorIds` (else BATCH_SCOPE_MISSING);
 *   - EVERY non-empty row must carry a nonblank seller_or_vendor_id (else BATCH_ROW_NO_SELLER) that is one of
 *     the EXACT canonical batch sellers (else BATCH_CROSS_ACCOUNT -- covers unknown/cross-org ids); with an
 *     optional expected marketplace, a row whose marketplace_country_code differs is BATCH_CROSS_MARKETPLACE;
 *   - a ZERO-ROW payload is VALID-EMPTY evidence (a completed export that returned no rows for the batch).
 * The WHOLE batch is rejected on the first offending row -- a partial/cross-account payload is never saved.
 */
export function validateBatchSourcePayload({ rows, sellerOrVendorIds, columns, marketplaceCountry = null } = {}) {
  if (!Array.isArray(rows)) return { valid: false, code: "MALFORMED_PAYLOAD", reason: "batch payload was not an array" };
  if (!isSellerScopedColumns(columns)) return { valid: true, code: null, reason: null };
  const allowed = new Set((Array.isArray(sellerOrVendorIds) ? sellerOrVendorIds : []).map((s) => String(s)));
  if (allowed.size === 0) {
    return { valid: false, code: "BATCH_SCOPE_MISSING", reason: "seller-scoped batch has no canonical sellerOrVendorIds to validate against" };
  }
  const expectMkt = marketplaceCountry == null ? null : String(marketplaceCountry).trim().toUpperCase();
  for (const row of rows) {
    if (!rowIsNonEmpty(row)) continue; // an empty row asserts no account
    const sid = rowSellerId(row);
    if (sid === "") return { valid: false, code: "BATCH_ROW_NO_SELLER", reason: "a non-empty batch row is missing its seller_or_vendor_id" };
    if (!allowed.has(sid)) return { valid: false, code: "BATCH_CROSS_ACCOUNT", reason: "a batch row's seller_or_vendor_id is not one of the canonical batch sellers (unknown/cross-org)" };
    if (expectMkt != null) {
      const mkt = row.marketplace_country_code == null ? "" : String(row.marketplace_country_code).trim().toUpperCase();
      if (mkt !== "" && mkt !== expectMkt) return { valid: false, code: "BATCH_CROSS_MARKETPLACE", reason: "a batch row's marketplace_country_code is not the expected marketplace" };
    }
  }
  return { valid: true, code: null, reason: null };
}

/**
 * Isolate ONE owner's rows from a shared batch fragment at DERIVE time (items 3-6). `fragment` carries the
 * shared batch payload rows + the fetched `columns` (or requestMeta) + the batch `sellerOrVendorIds` + the
 * batch org/connection; `owner` is the authoritative `{ rawSellerId, connectionId?, organizationFingerprint? }`
 * from the planned owner metadata (Blocker 4b). Returns `{ rows, sellerOrVendorIds, rejected }`:
 *   - a NON-seller-scoped fragment (Product Catalog) is returned UNCHANGED -- organization-wide (item 6);
 *   - a seller-scoped fragment is REJECTED (rows:null) when the owner has no rawSellerId, or when the owner's
 *     organization/connection does NOT match the batch's -- so the SAME raw seller id from another
 *     org/connection can never attribute these rows (fail closed);
 *   - otherwise rows are filtered into a NEW array of ONLY the owner's rawSellerId rows (the shared payload is
 *     never mutated) and the scope is narrowed to exactly [rawSellerId]; zero matches => [] (valid-empty).
 * With no `owner`, the fragment is returned unchanged (legacy single-account path stays byte-identical).
 */
export function isolateFragmentRowsForOwner(fragment, owner) {
  const rows = fragment ? fragment.rows : null;
  const sellerOrVendorIds = fragment ? fragment.sellerOrVendorIds : null;
  const unchanged = { rows, sellerOrVendorIds, rejected: false };
  if (!owner) return unchanged;
  if (!isSellerScopedColumns(fragmentColumns(fragment))) return unchanged; // organization-wide (catalog)

  const ownerRaw = owner.rawSellerId == null ? "" : String(owner.rawSellerId);
  if (ownerRaw === "") return { rows: null, sellerOrVendorIds, rejected: true };

  // ORG / CONNECTION binding: the owner MUST belong to the same organization + connection as the batch. A
  // matching raw seller id from ANOTHER org/connection can never see these rows (checked only when both sides
  // carry the evidence, so a legacy single-account fragment without org metadata stays byte-identical).
  const fOrg = fragment.organizationFingerprint;
  const fConn = fragment.connectionId;
  if (fOrg != null && owner.organizationFingerprint != null && String(owner.organizationFingerprint) !== String(fOrg)) {
    return { rows: null, sellerOrVendorIds, rejected: true };
  }
  if (fConn != null && owner.connectionId != null && String(owner.connectionId) !== String(fConn)) {
    return { rows: null, sellerOrVendorIds, rejected: true };
  }

  const mine = Array.isArray(rows) ? rows.filter((r) => rowSellerId(r) === ownerRaw) : rows;
  return { rows: mine, sellerOrVendorIds: [ownerRaw], rejected: false };
}
