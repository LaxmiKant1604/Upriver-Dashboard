// Scheduler v2 Blocker 4c -- PER-ACCOUNT ISOLATION of rows loaded from ONE shared <=5-account batch source.
//
// Pure, ZERO I/O. It does NOT orchestrate anything (that is the global fixpoint driver) and is not wired to
// any route/cron. Two concerns:
//
//   (1) validateBatchSourcePayload -- proves a COMPLETE downloaded batch payload contains ONLY rows for the
//       exact canonical batch sellers (and, when the contract fetched marketplace_country_code, ONLY the
//       batch's canonical marketplace) BEFORE it is saved, so ONE canonical payload can be kept in
//       source_export_cache and split back per account later (never a per-account duplicate object).
//
//   (2) isolateFragmentRowsForOwner -- at DERIVE time, filters ONE owner's rows out of the shared payload and
//       narrows the fragment scope to exactly [ownerRawSellerId], WITHOUT mutating the shared cached payload.
//
// SCOPE IS EXPLICIT (Blocker 4c correction, Finding 2): a source is seller-filtered ONLY when its DECLARED
// `sourceScope === "seller"` -- never inferred from whether columns contain seller_or_vendor_id. Product
// Catalog (sourceScope "organization") is never seller-filtered. The authoritative accountId -> rawSellerId
// mapping is the PLANNED OWNER metadata established in corrected Blocker 4b -- never row order, never a hash.

export const SELLER_ID_COLUMN = "seller_or_vendor_id";
export const MARKETPLACE_COLUMN = "marketplace_country_code";

// True iff the DECLARED source scope is seller-scoped. The ONLY gate for per-account filtering/validation.
export function isSellerScoped(sourceScope) {
  return sourceScope === "seller";
}

// Back-compat column heuristic (a seller-scoped source MUST carry seller_or_vendor_id) -- used by the static
// contract consistency check, NEVER as the decision to seller-filter (that is the explicit sourceScope).
export function isSellerScopedColumns(columns) {
  return Array.isArray(columns) && columns.map((c) => String(c)).includes(SELLER_ID_COLUMN);
}

// A row carries account evidence when it is a non-null, non-array object with at least one own defined,
// non-blank value. An all-empty row ({}) asserts NO account, so it does not itself fail the seller-membership
// proof (item 1: "every NON-EMPTY row must contain a nonblank seller_or_vendor_id").
function rowIsNonEmpty(row) {
  return Object.keys(row).some((k) => {
    const v = row[k];
    return v !== null && v !== undefined && String(v) !== "";
  });
}

// The row's value for a canonical column as a string ("" when blank/absent). Never coerces null/undefined to
// the literal strings "null"/"undefined".
function rowValue(row, column) {
  const v = row ? row[column] : undefined;
  return v === null || v === undefined ? "" : String(v);
}

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Validate a COMPLETE downloaded batch payload BEFORE it is saved (Findings 1 & 3). Returns
 * `{ valid, code, reason }`.
 *   - the payload must be an ARRAY, and EVERY member must be a PLAIN OBJECT (a primitive/null/array member is
 *     MALFORMED_PAYLOAD; `[]` is the only valid completely empty payload);
 *   - an unknown/missing `sourceScope` fails closed (SOURCE_SCOPE_UNKNOWN);
 *   - a NON-seller-scoped source (Product Catalog) is organization-wide and never seller/marketplace-validated;
 *   - a seller-scoped batch must resolve a non-empty canonical `sellerOrVendorIds` (BATCH_SCOPE_MISSING);
 *   - EVERY non-empty row must carry a nonblank seller_or_vendor_id (BATCH_ROW_NO_SELLER) that is one of the
 *     EXACT canonical batch sellers (BATCH_CROSS_ACCOUNT -- unknown/cross-org);
 *   - when the contract fetched marketplace_country_code (`marketplaceScoped`), the batch MUST carry a canonical
 *     `marketplaceCountry` constraint (BATCH_MARKETPLACE_CONSTRAINT_MISSING) and every non-empty row must carry
 *     a nonblank marketplace (BATCH_ROW_NO_MARKETPLACE) equal to it (BATCH_CROSS_MARKETPLACE);
 *   - a ZERO-ROW payload is VALID-EMPTY evidence.
 * The WHOLE batch is rejected on the first offending row -- a partial/cross-account payload is never saved.
 */
export function validateBatchSourcePayload({ rows, sellerOrVendorIds, sourceScope, marketplaceScoped = false, marketplaceCountry = null, marketplacePairs = null } = {}) {
  if (!Array.isArray(rows)) return { valid: false, code: "MALFORMED_PAYLOAD", reason: "batch payload was not an array" };
  if (sourceScope !== "seller" && sourceScope !== "organization") {
    return { valid: false, code: "SOURCE_SCOPE_UNKNOWN", reason: "batch job has an unknown/missing sourceScope" };
  }
  // Every member must be a plain object (a primitive/null/array member is malformed) -- applies to every scope.
  for (const row of rows) {
    if (!isPlainObject(row)) return { valid: false, code: "MALFORMED_PAYLOAD", reason: "a batch payload member is not a plain object" };
  }
  if (sourceScope !== "seller") return { valid: true, code: null, reason: null }; // organization-wide (never seller/marketplace-validated)

  const allowed = new Set((Array.isArray(sellerOrVendorIds) ? sellerOrVendorIds : []).map((s) => String(s)));
  if (allowed.size === 0) {
    return { valid: false, code: "BATCH_SCOPE_MISSING", reason: "seller-scoped batch has no canonical sellerOrVendorIds to validate against" };
  }
  const needMkt = marketplaceScoped === true;
  const expectMkt = marketplaceCountry == null ? "" : String(marketplaceCountry).trim().toUpperCase();
  if (marketplacePairs != null && (!Array.isArray(marketplacePairs) || marketplacePairs.some((p) => !p || typeof p !== "object"))) {
    return { valid: false, code: "BATCH_MARKETPLACE_CONSTRAINT_MISSING", reason: "seller-marketplace allowlist is malformed" };
  }
  const pairSet = Array.isArray(marketplacePairs) ? new Set(marketplacePairs.map((p) => JSON.stringify([String(p.sellerId), String(p.marketplace).trim().toUpperCase()]))) : null;
  if (pairSet && (!marketplacePairs.length || marketplacePairs.some((p) => !allowed.has(String(p.sellerId)) || !/^[A-Z]{2}$/.test(String(p.marketplace)))
    || [...allowed].some((id) => !marketplacePairs.some((p) => String(p.sellerId) === id)))) {
    return { valid: false, code: "BATCH_MARKETPLACE_CONSTRAINT_MISSING", reason: "seller-marketplace allowlist is incomplete or invalid" };
  }
  if (needMkt && expectMkt === "" && !pairSet) {
    return { valid: false, code: "BATCH_MARKETPLACE_CONSTRAINT_MISSING", reason: "a marketplace-scoped seller batch has no canonical marketplace constraint" };
  }
  for (const row of rows) {
    if (!rowIsNonEmpty(row)) continue; // an empty row asserts no account
    const sid = rowValue(row, SELLER_ID_COLUMN);
    if (sid === "") return { valid: false, code: "BATCH_ROW_NO_SELLER", reason: "a non-empty batch row is missing its seller_or_vendor_id" };
    if (!allowed.has(sid)) return { valid: false, code: "BATCH_CROSS_ACCOUNT", reason: "a batch row's seller_or_vendor_id is not one of the canonical batch sellers (unknown/cross-org)" };
    if (needMkt) {
      const mkt = rowValue(row, MARKETPLACE_COLUMN).trim().toUpperCase();
      if (mkt === "") return { valid: false, code: "BATCH_ROW_NO_MARKETPLACE", reason: "a non-empty batch row is missing its marketplace_country_code" };
      if (pairSet ? !pairSet.has(JSON.stringify([sid, mkt])) : mkt !== expectMkt) return { valid: false, code: "BATCH_CROSS_MARKETPLACE", reason: "a batch row does not match an authorized seller-marketplace pair" };
    }
  }
  return { valid: true, code: null, reason: null };
}

/**
 * Isolate ONE owner's rows from a shared batch fragment at DERIVE time (Findings 1-3, items 3-6). `fragment`
 * carries the shared batch payload `rows` + the DECLARED `sourceScope` + the batch `sellerOrVendorIds` + the
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
  if (!isSellerScoped(fragment && fragment.sourceScope)) return unchanged; // organization-wide (catalog)

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

  const marketplace = owner.marketplace == null ? null : String(owner.marketplace).trim().toUpperCase();
  const mine = Array.isArray(rows) ? rows.filter((r) => rowValue(r, SELLER_ID_COLUMN) === ownerRaw
    && (!marketplace || rowValue(r, MARKETPLACE_COLUMN).trim().toUpperCase() === marketplace)) : rows;
  return { rows: mine, sellerOrVendorIds: [ownerRaw], rejected: false };
}

// A planned source fragment is a BATCHED seller source when it is DECLARED seller-scoped and covers more than
// one canonical seller id -- exactly the case that REQUIRES complete owner metadata to isolate (Finding 1).
export function isBatchedSellerFragment(fragment) {
  if (!fragment || !isSellerScoped(fragment.sourceScope)) return false;
  const ids = Array.isArray(fragment.sellerOrVendorIds) ? fragment.sellerOrVendorIds : [];
  return ids.length > 1;
}

// The complete owner metadata a batched seller-scoped report REQUIRES for isolation (Finding 1). Returns the
// list of MISSING/blank fields (empty => complete). Never accepts these from operational/run arguments.
export const REQUIRED_OWNER_FIELDS = Object.freeze(["accountId", "rawSellerId", "connectionId", "organizationFingerprint", "accountScopeHash"]);
export function missingOwnerFields(owner) {
  if (!owner || typeof owner !== "object") return [...REQUIRED_OWNER_FIELDS];
  return REQUIRED_OWNER_FIELDS.filter((f) => owner[f] == null || String(owner[f]).trim() === "");
}
