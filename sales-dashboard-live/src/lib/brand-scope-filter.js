// PURE, offline-testable client brand-scope helpers (defense-in-depth for the brand SELECTOR options).
//
// The SERVER is the security boundary: every brand-scoped payload it serves is projected to the viewer's permitted
// brands and a forbidden brand request is denied (403) before any read. These helpers ensure the browser SELECTOR
// never OFFERS a brand name the user is not granted for the selected account -- even when a stale (pre-restriction)
// localStorage/IndexedDB cache or a still-in-memory pre-restriction payload contributed the name, and even before an
// in-session grant change has been re-fetched. They NEVER widen scope; they only remove non-permitted names.
//
// ONE canonical brand key, identical to lib/server/reports/brand-membership.js#brandKey: trim, collapse repeated
// interior whitespace to a single space, lowercase. Punctuation is PRESERVED so punctuation-distinct brands
// ("Bebi-Born" vs "Bebi Born") stay separate and no fuzzy matching ever merges genuinely different brands.
export function canonicalBrandKey(value) {
  const t = String(value == null ? "" : value).trim().replace(/\s+/g, " ").toLowerCase();
  return t || null;
}

// The permitted canonical brand-key Set for ONE account grant, or null when the account is UNRESTRICTED (admin or an
// ALL_BRANDS grant, or no grant row). A SELECTED_BRANDS grant yields the Set of its granted canonical keys (which the
// server further intersects with the account's trusted membership at serve time). An explicit SELECTED_BRANDS grant
// with zero brand rows yields an EMPTY set (no brands) -- it NEVER falls back to "all".
export function permittedBrandKeySetFromGrant(grant) {
  if (!grant || grant.mode !== "SELECTED_BRANDS") return null; // unrestricted
  const set = new Set();
  for (const k of Array.isArray(grant.brandKeys) ? grant.brandKeys : []) {
    const ck = canonicalBrandKey(k);
    if (ck) set.add(ck);
  }
  return set;
}

// The permitted key Set for one account from a whole access object (admin -> null unrestricted). Never trusts a
// browser-supplied brand; reads only the authenticated access.accountGrants delivered by /api/access?action=me.
export function permittedBrandKeySetForAccount(access, accountId) {
  if (!access || access.role === "admin") return null;
  const grant = access.accountGrants ? access.accountGrants[accountId] : null;
  return permittedBrandKeySetFromGrant(grant);
}

// Filter a list of brand DISPLAY names to those whose canonical key is permitted. A null permittedSet means the
// account is unrestricted -> the list is returned unchanged (byte-identical for admins / ALL_BRANDS). Order is
// preserved; duplicates are removed by the caller's own Set if desired.
export function filterBrandNamesToPermitted(names, permittedSet) {
  if (!permittedSet) return Array.isArray(names) ? [...names] : [];
  return (Array.isArray(names) ? names : []).filter((n) => permittedSet.has(canonicalBrandKey(n)));
}
