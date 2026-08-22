// Scheduler v2 Blocker 4c -- PER-ACCOUNT ISOLATION of rows loaded from ONE shared batch source (any account
// count; DataDoe allows any number of sellers per export, mixed marketplaces safe within one org/connection).
//
// Pure, ZERO I/O. Two concerns:
//
//   (1) validateBatchSourcePayload -- proves a COMPLETE downloaded batch payload contains ONLY rows for the
//       batch's exact discovered account tuples BEFORE it is saved, so ONE canonical payload can be kept in
//       source_export_cache and split back per account later (never a per-account duplicate object).
//
//   (2) isolateFragmentRowsForOwner -- at DERIVE time, filters ONE owner's rows out of the shared payload and
//       narrows the fragment scope to exactly [ownerRawSellerId], WITHOUT mutating the shared cached payload.
//
// EXACT-TUPLE ISOLATION (isolation correction): a seller-scoped batch is formed within ONE organization + ONE
// DataDoe connection, and its authoritative allowed set is the batch's exact discovered account tuples
// (rawSellerId, marketplaceCountryCode). Seller id + marketplace are validated as an EXACT PAIR -- NEVER two
// independent sets -- because one Amazon seller id may participate in MULTIPLE marketplaces: a row bearing
// account A's seller id with account B's marketplace fails closed (BATCH_CROSS_ACCOUNT) even when both values
// exist somewhere in the batch. When a seller-scoped source returns NO marketplace evidence, seller-only
// isolation is allowed ONLY when the rawSellerId maps to exactly ONE account in the batch; a rawSellerId that
// maps to multiple marketplace accounts fails closed (AMBIGUOUS_ACCOUNT_EVIDENCE) rather than duplicate rows.
//
// SCOPE IS EXPLICIT: a source is seller-filtered ONLY when its DECLARED `sourceScope === "seller"` -- never
// inferred from columns. Product Catalog (sourceScope "organization") is never seller/account-validated. The
// authoritative account tuples + owner mapping are the PLANNED metadata (Blocker 4b) -- never row order.

export const SELLER_ID_COLUMN = "seller_or_vendor_id";
export const MARKETPLACE_COLUMN = "marketplace_country_code";
const PAIR_SEP = "|"; // safe join for (rawSellerId, marketplace) pair keys (a pipe never appears in an alphanumeric seller id or a 2-letter marketplace code)

// True iff the DECLARED source scope is seller-scoped. The ONLY gate for per-account filtering/validation.
export function isSellerScoped(sourceScope) {
  return sourceScope === "seller";
}

// Normalize the batch's authoritative account tuples into: the exact allowed (rawSellerId, marketplace) pair
// keys, and a rawSellerId -> Set(marketplace) map for ambiguity detection. Accepts either the new
// `accountTuples: [{ rawSellerId, marketplaceCountryCode }]` OR the legacy `(sellerOrVendorIds, marketplace)`
// single-marketplace shape (each seller mapped to the one marketplace). Blank marketplace => "" (seller-only).
export function buildAllowedAccountPairs({ accountTuples = null, sellerOrVendorIds = null, marketplaceCountry = null } = {}) {
  const tuples = Array.isArray(accountTuples) && accountTuples.length
    ? accountTuples.map((t) => ({ rawSellerId: String(t.rawSellerId ?? ""), marketplace: String(t.marketplaceCountryCode ?? "").trim().toUpperCase() }))
    : (Array.isArray(sellerOrVendorIds) ? sellerOrVendorIds : []).map((s) => ({ rawSellerId: String(s), marketplace: marketplaceCountry == null ? "" : String(marketplaceCountry).trim().toUpperCase() }));
  const pairs = new Set();
  const sellerMarketplaces = new Map(); // rawSellerId -> Set(marketplace)
  for (const t of tuples) {
    if (!t.rawSellerId) continue;
    pairs.add(t.rawSellerId + PAIR_SEP + t.marketplace);
    if (!sellerMarketplaces.has(t.rawSellerId)) sellerMarketplaces.set(t.rawSellerId, new Set());
    sellerMarketplaces.get(t.rawSellerId).add(t.marketplace);
  }
  return { pairs, sellerMarketplaces, count: tuples.filter((t) => t.rawSellerId).length };
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
 * Validate a COMPLETE downloaded batch payload BEFORE it is saved. Returns `{ valid, code, reason }`.
 *   - the payload must be an ARRAY, and EVERY member must be a PLAIN OBJECT (else MALFORMED_PAYLOAD; `[]` is valid);
 *   - an unknown/missing `sourceScope` fails closed (SOURCE_SCOPE_UNKNOWN);
 *   - a NON-seller-scoped source (Product Catalog) is organization-wide and never seller/account-validated;
 *   - a seller-scoped batch must resolve a non-empty authoritative account set (BATCH_SCOPE_MISSING) -- either
 *     `accountTuples: [{ rawSellerId, marketplaceCountryCode }]` (preferred) or the legacy
 *     `(sellerOrVendorIds, marketplaceCountry)` single-marketplace shape;
 *   - EVERY non-empty row must carry a nonblank seller_or_vendor_id (BATCH_ROW_NO_SELLER);
 *   - when the contract fetched marketplace_country_code (`marketplaceScoped`): every non-empty row must carry a
 *     nonblank marketplace (BATCH_ROW_NO_MARKETPLACE), and the EXACT (seller, marketplace) PAIR must be one of
 *     the batch's discovered account tuples (BATCH_CROSS_ACCOUNT) -- a seller from account A carrying account
 *     B's marketplace fails EVEN when both values exist independently in the batch;
 *   - when the source returns NO marketplace evidence: the seller must be a batch seller (BATCH_CROSS_ACCOUNT),
 *     AND that seller must map to EXACTLY ONE account in the batch -- a seller mapping to multiple marketplace
 *     accounts fails closed (AMBIGUOUS_ACCOUNT_EVIDENCE) rather than be duplicated across marketplaces;
 *   - a ZERO-ROW payload is VALID-EMPTY evidence.
 * The batch is single-organization/single-connection, so those bind the whole batch; rows are rejected on the
 * first offending row -- a partial/cross-account payload is never saved.
 */
export function validateBatchSourcePayload({ rows, accountTuples = null, sellerOrVendorIds, sourceScope, marketplaceScoped = false, marketplaceCountry = null } = {}) {
  if (!Array.isArray(rows)) return { valid: false, code: "MALFORMED_PAYLOAD", reason: "batch payload was not an array" };
  if (sourceScope !== "seller" && sourceScope !== "organization") {
    return { valid: false, code: "SOURCE_SCOPE_UNKNOWN", reason: "batch job has an unknown/missing sourceScope" };
  }
  for (const row of rows) {
    if (!isPlainObject(row)) return { valid: false, code: "MALFORMED_PAYLOAD", reason: "a batch payload member is not a plain object" };
  }
  if (sourceScope !== "seller") return { valid: true, code: null, reason: null }; // organization-wide (never account-validated)

  const { pairs, sellerMarketplaces } = buildAllowedAccountPairs({ accountTuples, sellerOrVendorIds, marketplaceCountry });
  if (sellerMarketplaces.size === 0) {
    return { valid: false, code: "BATCH_SCOPE_MISSING", reason: "seller-scoped batch has no authoritative account tuples to validate against" };
  }
  const needMkt = marketplaceScoped === true;
  for (const row of rows) {
    if (!rowIsNonEmpty(row)) continue; // an empty row asserts no account
    const sid = rowValue(row, SELLER_ID_COLUMN);
    if (sid === "") return { valid: false, code: "BATCH_ROW_NO_SELLER", reason: "a non-empty batch row is missing its seller_or_vendor_id" };
    if (needMkt) {
      const mkt = rowValue(row, MARKETPLACE_COLUMN).trim().toUpperCase();
      if (mkt === "") return { valid: false, code: "BATCH_ROW_NO_MARKETPLACE", reason: "a non-empty batch row is missing its marketplace_country_code" };
      // EXACT (seller, marketplace) pair -- never two independent sets.
      if (!pairs.has(sid + PAIR_SEP + mkt)) return { valid: false, code: "BATCH_CROSS_ACCOUNT", reason: "a batch row's (seller_or_vendor_id, marketplace_country_code) is not one of the batch's discovered account tuples" };
    } else {
      // No marketplace evidence: the seller must be a batch seller AND map to exactly one account.
      const mkts = sellerMarketplaces.get(sid);
      if (!mkts) return { valid: false, code: "BATCH_CROSS_ACCOUNT", reason: "a batch row's seller_or_vendor_id is not one of the batch sellers (unknown/cross-org)" };
      if (mkts.size > 1) return { valid: false, code: "AMBIGUOUS_ACCOUNT_EVIDENCE", reason: "a seller_or_vendor_id maps to multiple marketplace accounts but the source returned no marketplace_country_code to disambiguate" };
    }
  }
  return { valid: true, code: null, reason: null };
}

/**
 * Isolate ONE owner's rows from a shared batch fragment at DERIVE time. `fragment` carries the shared batch
 * `rows` + DECLARED `sourceScope` + the batch's `accountTuples` (or legacy `sellerOrVendorIds`) + org/connection
 * + `marketplaceScoped`; `owner` is the authoritative `{ rawSellerId, marketplaceCountryCode?, connectionId?,
 * organizationFingerprint? }`. Returns `{ rows, sellerOrVendorIds, rejected, code? }`:
 *   - a NON-seller-scoped fragment (Product Catalog) is returned UNCHANGED (organization-wide);
 *   - REJECTED when the owner has no rawSellerId, or the owner's org/connection != the batch's;
 *   - when the source returns marketplace evidence (`marketplaceScoped`): the owner MUST carry a nonblank
 *     marketplaceCountryCode (else OWNER_MARKETPLACE_MISSING), and rows are filtered by the EXACT
 *     (seller_or_vendor_id, marketplace_country_code) pair -- so one seller id shared across marketplaces routes
 *     each row ONLY to its exact marketplace account;
 *   - with NO marketplace evidence: seller-only filtering is allowed ONLY when the owner's rawSellerId maps to
 *     exactly one account in the batch; if it maps to multiple, REJECTED (AMBIGUOUS_ACCOUNT_EVIDENCE);
 *   - the shared payload is never mutated; zero matches => [] (valid-empty).
 * With no `owner`, the fragment is returned unchanged (legacy single-account path stays byte-identical).
 */
export function isolateFragmentRowsForOwner(fragment, owner) {
  const rows = fragment ? fragment.rows : null;
  const sellerOrVendorIds = fragment ? fragment.sellerOrVendorIds : null;
  const unchanged = { rows, sellerOrVendorIds, rejected: false };
  if (!owner) return unchanged;
  if (!isSellerScoped(fragment && fragment.sourceScope)) return unchanged; // organization-wide (catalog)

  const reject = (code) => ({ rows: null, sellerOrVendorIds, rejected: true, code });
  const ownerRaw = owner.rawSellerId == null ? "" : String(owner.rawSellerId);
  if (ownerRaw === "") return reject("OWNER_SELLER_MISSING");

  // ORG / CONNECTION binding: the owner MUST belong to the same organization + connection as the batch.
  const fOrg = fragment.organizationFingerprint, fConn = fragment.connectionId;
  if (fOrg != null && owner.organizationFingerprint != null && String(owner.organizationFingerprint) !== String(fOrg)) return reject("OWNER_ORG_MISMATCH");
  if (fConn != null && owner.connectionId != null && String(owner.connectionId) !== String(fConn)) return reject("OWNER_CONNECTION_MISMATCH");

  const rowMkt = (r) => rowValue(r, MARKETPLACE_COLUMN).trim().toUpperCase();
  if (fragment.marketplaceScoped === true) {
    const ownerMkt = owner.marketplaceCountryCode == null ? "" : String(owner.marketplaceCountryCode).trim().toUpperCase();
    if (ownerMkt === "") return reject("OWNER_MARKETPLACE_MISSING"); // a marketplace-scoped source needs the exact marketplace to isolate
    const mine = Array.isArray(rows) ? rows.filter((r) => rowValue(r, SELLER_ID_COLUMN) === ownerRaw && rowMkt(r) === ownerMkt) : rows;
    return { rows: mine, sellerOrVendorIds: [ownerRaw], rejected: false };
  }
  // No marketplace evidence: seller-only isolation is safe ONLY when this rawSellerId is unambiguous in the batch.
  const { sellerMarketplaces } = buildAllowedAccountPairs({ accountTuples: fragment.accountTuples || null, sellerOrVendorIds });
  const mkts = sellerMarketplaces.get(ownerRaw);
  if (mkts && mkts.size > 1) return reject("AMBIGUOUS_ACCOUNT_EVIDENCE");
  const mine = Array.isArray(rows) ? rows.filter((r) => rowValue(r, SELLER_ID_COLUMN) === ownerRaw) : rows;
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
