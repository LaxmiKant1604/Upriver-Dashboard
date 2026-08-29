// TRUSTED server-side validation for seller-warehouse writes. The browser is NEVER a correctness/security boundary:
// every write row (single edit AND bulk import) is re-validated here against the account's OWN published fba-plan
// snapshot evidence -- the account SKU directory, the reusable Product Catalog ASIN set, and the account's marketplace
// scope. Directory / brand / product / provenance / account identity supplied by the browser are ignored; the child
// ASIN is RESOLVED from the trusted directory (a known SKU) or validated against the catalog (a new manual SKU).
//
// Evidence tiers (fail closed):
//   * v2d-5 snapshot (accountSkuDirectory + catalogByAsin present) -> full identity validation.
//   * v2d-4 snapshot (only the string accountSkus + rows) -> membership + marketplace check; a NEW SKU (not already an
//     account SKU) is rejected because its ASIN cannot be catalog-verified yet -- refresh the plan first.
//   * no snapshot / no evidence -> every write rejected.

const U = (v) => String(v == null ? "" : v).trim().toUpperCase();
const S = (v) => String(v == null ? "" : v).trim();

// Build the trusted authority from a published fba-plan snapshot payload.
export function buildWarehouseAuthority(payload) {
  const p = payload && typeof payload === "object" ? payload : {};
  const dirArr = Array.isArray(p.accountSkuDirectory) ? p.accountSkuDirectory : null;
  const directory = new Map();
  if (dirArr) for (const e of dirArr) { if (e && e.sku) directory.set(S(e.sku), e); }
  const catalogAsins = new Set(Object.keys(p.catalogByAsin && typeof p.catalogByAsin === "object" ? p.catalogByAsin : {}));
  const accountSkus = new Set((Array.isArray(p.accountSkus) ? p.accountSkus : []).map(S).filter(Boolean));
  const marketCountry = U(p.marketCountry);
  const allowedMarketplaces = new Set();
  if (marketCountry) allowedMarketplaces.add(marketCountry);
  if (dirArr) for (const e of dirArr) { const m = U(e && e.marketplace); if (m) allowedMarketplaces.add(m); }
  return {
    hasSnapshot: !!payload,
    hasDirectory: !!dirArr,
    hasAccountSkus: accountSkus.size > 0,
    directory, catalogAsins, accountSkus, allowedMarketplaces, marketCountry,
  };
}

// Validate ONE structured write row { marketplace, sku, childAsin } against the trusted authority.
// Returns { ok, problems: [string], resolvedChildAsin: string }.
export function validateWarehouseRow(row, authority) {
  const problems = [];
  const marketplace = U(row && row.marketplace);
  const sku = S(row && row.sku);
  const rowAsin = S(row && row.childAsin);
  if (!sku) problems.push("missing SKU");
  if (!marketplace) problems.push("missing Marketplace");

  if (!authority || !authority.hasSnapshot) {
    problems.push("no published FBA plan for this account yet (refresh the plan before saving warehouse stock)");
    return { ok: false, problems, resolvedChildAsin: rowAsin || "" };
  }
  // Marketplace must be within the account's canonical scope.
  if (marketplace && authority.allowedMarketplaces.size > 0 && !authority.allowedMarketplaces.has(marketplace)) {
    problems.push(`marketplace ${marketplace} is not in this account's scope`);
  }

  let resolvedChildAsin = rowAsin || "";
  if (authority.hasDirectory) {
    const entry = sku ? authority.directory.get(sku) : null;
    if (entry) {
      // KNOWN account SKU: child ASIN optional; a supplied ASIN must equal the directory mapping.
      const dirAsin = S(entry.childAsin);
      if (rowAsin && dirAsin && rowAsin !== dirAsin) problems.push(`SKU maps to ${dirAsin}, not ${rowAsin}`);
      resolvedChildAsin = rowAsin || dirAsin || "";
    } else if (sku) {
      // NEW MANUAL SKU: a child ASIN is mandatory and must exist in the account's Product Catalog.
      if (!rowAsin) problems.push("new SKU requires a Child ASIN");
      else if (!authority.catalogAsins.has(rowAsin)) problems.push(`Child ASIN ${rowAsin} is not in this account's catalog`);
      resolvedChildAsin = rowAsin || "";
    }
  } else if (authority.hasAccountSkus) {
    // v2d-4 evidence: membership only. A new SKU cannot be ASIN-verified without the directory/catalog -> reject.
    if (sku && !authority.accountSkus.has(sku)) problems.push("SKU is not in this account (refresh the FBA plan to add new SKUs)");
  } else {
    problems.push("account SKU evidence unavailable (refresh the FBA plan before saving warehouse stock)");
  }

  return { ok: problems.length === 0, problems, resolvedChildAsin };
}

// Validate MANY rows; ALL-OR-NOTHING. Returns { ok, errors: [{ index, sku, marketplace, problems }], valid: [row+resolvedChildAsin] }.
export function validateWarehouseRows(rows, authority) {
  const list = Array.isArray(rows) ? rows : [];
  const errors = [];
  const valid = [];
  const seen = new Set();
  list.forEach((row, index) => {
    const res = validateWarehouseRow(row, authority);
    const key = `${U(row && row.marketplace)} ${S(row && row.sku)}`;
    if (S(row && row.sku) && U(row && row.marketplace)) {
      if (seen.has(key)) res.problems.push("duplicate row in this import");
      else seen.add(key);
    }
    if (res.problems.length > 0) errors.push({ index, sku: S(row && row.sku), marketplace: U(row && row.marketplace), problems: res.problems });
    else valid.push({ ...row, childAsin: res.resolvedChildAsin });
  });
  return { ok: errors.length === 0, errors, valid };
}
