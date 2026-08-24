// Brand View PORTFOLIO membership -- pure, offline-testable core.
//
// Two DISTINCT concerns that the old code conflated into one catalog-authoritative map:
//
//   1. MEMBERSHIP (which accounts belong to a selected brand): must follow the CURRENT sales evidence -- the
//      latest validated brand-sales snapshot per account. The bug this fixes: sharedSnapshotBrandAccounts treated
//      a "complete" brand-catalog snapshot as authoritative and never consulted brand-sales, so it BOTH dropped
//      accounts that sell the brand only in brand-sales (IT/ES/UK) AND pinned accounts that merely list the brand
//      in an (org-wide) catalog with no sales (US). Membership must match the figures, which are built from
//      brand-sales, so an account belongs to a brand iff its current brand-sales contains it.
//
//   2. SELECTOR (the brand LIST offered in the dropdown): the complete catalog may still supply the full list,
//      including zero-sale brands, unioned with brand-sales. Selector brands NEVER pin account membership.
//
// Normalization is a plain trim (matching the figures' trimmed exact match on product_brand), so genuinely
// different brands are never merged.

const S = (v) => (v == null ? "" : String(v));

// Trim-normalize a brand name. Empty -> null (dropped). Case + interior spacing preserved so two genuinely
// different brands are never merged; matches how the brand FIGURES aggregate (trimmed exact match).
export function normalizeBrandName(value) {
  const t = S(value).trim();
  return t || null;
}

/**
 * MEMBERSHIP brands for one account = the latest validated brand-sales brands ONLY (normalized, de-duplicated).
 * A brand present only in the account's catalog (with no sales) is NOT a member.
 */
export function membershipBrandsForAccount(salesBrands = []) {
  const out = new Set();
  for (const b of Array.isArray(salesBrands) ? salesBrands : []) { const n = normalizeBrandName(b); if (n) out.add(n); }
  return [...out];
}

/**
 * SELECTOR brands for one account (the dropdown list only) = brand-sales UNION a COMPLETE catalog's brands. This
 * keeps zero-sale catalog brands selectable (req: catalog supplies the complete selector) without letting them
 * pin membership.
 */
export function selectorBrandsForAccount({ catalogStatus, catalogBrands = [], salesBrands = [] } = {}) {
  const out = new Set(membershipBrandsForAccount(salesBrands));
  if (catalogStatus === "complete") {
    for (const b of Array.isArray(catalogBrands) ? catalogBrands : []) { const n = normalizeBrandName(b); if (n) out.add(n); }
  }
  return [...out];
}

/**
 * Build the brand -> Set(accountId) MEMBERSHIP map from per-account evidence. Each entry is
 * { accountId, salesBrands } (catalog fields are ignored for membership). Pure: the caller supplies the
 * brand-sales brand array it read from each account's latest brand-sales snapshot.
 */
export function buildBrandAccountMembership(perAccount = []) {
  const map = new Map();
  for (const a of Array.isArray(perAccount) ? perAccount : []) {
    const id = S(a && a.accountId).trim();
    if (!id) continue;
    for (const brand of membershipBrandsForAccount(a && a.salesBrands)) {
      if (!map.has(brand)) map.set(brand, new Set());
      map.get(brand).add(id);
    }
  }
  return map;
}

// The sorted account-id array for one brand from a membership map (empty when the brand is absent).
export function accountsForBrand(membershipMap, brand) {
  const key = normalizeBrandName(brand);
  const set = key && membershipMap instanceof Map ? membershipMap.get(key) : null;
  return set ? [...set].sort() : [];
}
