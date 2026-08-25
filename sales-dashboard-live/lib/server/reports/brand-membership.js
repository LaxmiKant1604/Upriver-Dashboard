// Brand View PORTFOLIO membership -- pure, offline-testable core.
//
// Two DISTINCT concerns that the old code conflated into one catalog-authoritative map:
//
//   1. MEMBERSHIP (which accounts belong to a selected brand): must follow the CURRENT sales evidence -- the
//      latest validated brand-sales snapshot per account. An account belongs to a brand iff its current
//      brand-sales contains it. Product Catalog is evidence for the SELECTOR list only, never membership: it
//      may never REMOVE an account that validated brand-sales proves sells the brand.
//
//   2. SELECTOR (the brand LIST offered in the dropdown): the complete catalog may still supply the full list,
//      including zero-sale brands, unioned with brand-sales. Selector brands NEVER pin account membership.
//
// ONE shared CANONICAL BRAND-KEY (brandKey) is used everywhere a brand is MATCHED -- directory, membership,
// account/portfolio filtering, ASIN Ads attribution, frontend selection -- so a case/whitespace variant of the
// same brand is treated as the same brand. It normalizes leading/trailing + repeated interior whitespace and
// case; punctuation is PRESERVED, so punctuation-distinct brands ("Bebi-Born" vs "Bebi Born") stay separate and
// no fuzzy matching ever merges genuinely different brands. A stable human-readable DISPLAY label is preserved.

const S = (v) => (v == null ? "" : String(v));

// The CANONICAL brand-key for MATCHING: trim, collapse repeated interior whitespace to one space, lowercase.
// Empty -> null (dropped). Punctuation preserved (no fuzzy merge). Two brands are the same iff their keys match.
export function brandKey(value) {
  const t = S(value).trim().replace(/\s+/g, " ").toLowerCase();
  return t || null;
}

// The stable human-readable DISPLAY label: trim + collapse interior whitespace, ORIGINAL case preserved.
export function brandDisplay(value) {
  const t = S(value).trim().replace(/\s+/g, " ");
  return t || null;
}

// Back-compat alias: legacy callers used normalizeBrandName as the display/trim normalizer.
export function normalizeBrandName(value) {
  return brandDisplay(value);
}

// Deterministic display for a key when merging variants: the lexicographically-smallest display is chosen so the
// label is STABLE regardless of the order accounts are read in (never order-dependent).
function pickDisplay(existing, candidate) {
  if (!existing) return candidate;
  if (!candidate) return existing;
  return candidate < existing ? candidate : existing;
}

/**
 * MEMBERSHIP brands for one account = the latest validated brand-sales brands ONLY, as {key, display} pairs
 * (canonical-key de-duplicated). A brand present only in the account's catalog (with no sales) is NOT a member.
 */
export function membershipBrandsForAccount(salesBrands = []) {
  const byKey = new Map();
  for (const b of Array.isArray(salesBrands) ? salesBrands : []) {
    const key = brandKey(b);
    if (!key) continue;
    byKey.set(key, pickDisplay(byKey.get(key), brandDisplay(b)));
  }
  return [...byKey.entries()].map(([key, display]) => ({ key, display }));
}

/**
 * SELECTOR brands for one account (the dropdown list only) = brand-sales UNION a COMPLETE catalog's brands, as
 * {key, display} pairs. Keeps zero-sale catalog brands selectable without letting them pin membership.
 */
export function selectorBrandsForAccount({ catalogStatus, catalogBrands = [], salesBrands = [] } = {}) {
  const byKey = new Map();
  for (const { key, display } of membershipBrandsForAccount(salesBrands)) byKey.set(key, pickDisplay(byKey.get(key), display));
  if (catalogStatus === "complete") {
    for (const b of Array.isArray(catalogBrands) ? catalogBrands : []) {
      const key = brandKey(b);
      if (!key) continue;
      byKey.set(key, pickDisplay(byKey.get(key), brandDisplay(b)));
    }
  }
  return [...byKey.entries()].map(([key, display]) => ({ key, display }));
}

/**
 * Build the canonical MEMBERSHIP map from per-account evidence. Each entry is { accountId, salesBrands } (catalog
 * fields are ignored for membership). Returns Map<brandKey, { display, accounts: Set<accountId> }>. Pure: the
 * caller supplies the brand-sales brand array it read (storage-first) from each account's latest snapshot.
 */
export function buildBrandAccountMembership(perAccount = []) {
  const map = new Map();
  // Sort by accountId so display selection + iteration are deterministic regardless of read order.
  const ordered = (Array.isArray(perAccount) ? perAccount : []).slice().sort((a, b) => (S(a && a.accountId) < S(b && b.accountId) ? -1 : 1));
  for (const a of ordered) {
    const id = S(a && a.accountId).trim();
    if (!id) continue;
    for (const { key, display } of membershipBrandsForAccount(a && a.salesBrands)) {
      let entry = map.get(key);
      if (!entry) { entry = { display, accounts: new Set() }; map.set(key, entry); }
      else entry.display = pickDisplay(entry.display, display);
      entry.accounts.add(id);
    }
  }
  return map;
}

// The sorted account-id array for one brand from a membership map (empty when the brand is absent). Matches by
// the CANONICAL brand-key, so a case/whitespace variant of the selected brand resolves to the same accounts.
export function accountsForBrand(membershipMap, brand) {
  const key = brandKey(brand);
  const entry = key && membershipMap instanceof Map ? membershipMap.get(key) : null;
  return entry && entry.accounts ? [...entry.accounts].sort() : [];
}

// The display label a membership map holds for a brand (canonical-key matched), or the brand's own display.
export function displayForBrand(membershipMap, brand) {
  const key = brandKey(brand);
  const entry = key && membershipMap instanceof Map ? membershipMap.get(key) : null;
  return (entry && entry.display) || brandDisplay(brand);
}

/**
 * Serialise a membership map (+ selector-only brand entries) into the directory PAYLOAD the frontend reads:
 *   { brands: display[], brandKeys: key[], brandAccounts: { [key]: accountId[] }, brandDisplay: { [key]: display } }
 * MEMBERSHIP (brandAccounts) is keyed by the CANONICAL key, so the frontend looks it up by brandKey(selected) and
 * a case/whitespace variant resolves to the same accounts. A selector-only brand appears with an EMPTY account
 * array (selectable, pins no membership). `selectorEntries` are {key, display} from selectorBrandsForAccount.
 */
export function serialiseBrandAccountMembership(membershipMap, selectorEntries = []) {
  const byKey = new Map();
  if (membershipMap instanceof Map) {
    for (const [key, entry] of membershipMap) byKey.set(key, { display: entry.display || key, accounts: [...entry.accounts].sort() });
  }
  for (const { key, display } of Array.isArray(selectorEntries) ? selectorEntries : []) {
    if (!key) continue;
    if (!byKey.has(key)) byKey.set(key, { display: display || key, accounts: [] });
  }
  const entries = [...byKey.entries()].sort((a, b) => {
    const da = (a[1].display || a[0]); const db = (b[1].display || b[0]);
    return da < db ? -1 : da > db ? 1 : (a[0] < b[0] ? -1 : 1);
  });
  return {
    brands: entries.map(([, v]) => v.display),
    brandKeys: entries.map(([k]) => k),
    brandAccounts: Object.fromEntries(entries.map(([k, v]) => [k, v.accounts])),
    brandDisplay: Object.fromEntries(entries.map(([k, v]) => [k, v.display])),
  };
}

/**
 * A DETERMINISTIC membership PROVENANCE fingerprint over the latest validated brand-sales snapshot identity of
 * every authorized primary account. `perAccountMeta` = [{ accountId, updatedAt, paramsHash }]. When the scheduler
 * publishes a new brand-sales snapshot for ANY account (its updatedAt / paramsHash changes), the fingerprint
 * changes -> the stale directory self-heals. Missing snapshots contribute a stable "none" marker so appearing/
 * disappearing evidence also flips the fingerprint. No crypto: the canonical string IS the fingerprint.
 */
export function membershipFingerprint(perAccountMeta = []) {
  const parts = (Array.isArray(perAccountMeta) ? perAccountMeta : [])
    .map((m) => {
      const id = S(m && m.accountId).trim();
      if (!id) return null;
      const stamp = S(m && m.updatedAt).trim() || S(m && m.paramsHash).trim() || "none";
      return `${id}|${stamp}`;
    })
    .filter(Boolean)
    .sort();
  return parts.join("\n");
}
