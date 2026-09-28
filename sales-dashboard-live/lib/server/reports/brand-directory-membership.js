// Brand View PORTFOLIO directory membership -- the ONE pure function set the browser serve (api/datadoe.js
// sharedSnapshotBrandAccounts, the brand directory that decides which accounts a portfolio request carries) and the
// zero-export brand-view-portfolio recovery route (lib/server/sync/routes/brand-view-portfolio.release.js) share, so a
// route-published portfolio row carries EXACTLY the account set + brand label the page requests (a one-sided edit would
// silently publish rows that are never served).
//
//   snapshotBrandNames(payload)            -- COPIED VERBATIM from api/datadoe.js (the directory's brand-name read of a
//                                             saved brand-sales payload). NOTE: unlike brand-view.js brandNamesFromPayload
//                                             it does NOT drop "Unassigned" -- the directory keeps it as a brand, so the
//                                             route must too (parity). Pinned byte-identical by
//                                             scripts/brand-view-portfolio-route.test.js until api/datadoe.js imports it.
//   computeBrandDirectoryMembership(perAccountSales)
//                                          -- the directory MEMBERSHIP: buildBrandAccountMembership over the
//                                             snapshotBrandNames of each CURRENT-PRIMARY account's latest brand-sales
//                                             (dd-secondary / blank ids never pin membership, exactly like the serve's
//                                             primaryAccountIdsOnly scope). -> { membership, selectorKeys }.
//   regionPortfolioMembers(membership, accountsById, region)
//                                          -- per membership brand, its members inside ONE region through the SERVER's
//                                             own trusted-metadata filter (region-scope.js filterAccountIdsToRegion over
//                                             the sorted members): the account set the page's region portfolio carries.
//
// Pure: no I/O, no DataDoe, no Supabase. 7-bit ASCII, LF.

import { buildBrandAccountMembership, primaryAccountIdsOnly } from "./brand-membership.js";
import { filterAccountIdsToRegion, isRegionScope } from "./region-scope.js";

function snapshotBrandNames(payload) {
  const names = new Set((payload?.catalogBrands || []).map((brand) => String(brand || "").trim()).filter(Boolean));
  // Older Dashboard and SKU P&L snapshots predate catalogBrands on every
  // payload, but their row records still carry the joined brand. This keeps
  // the directory recoverable after a schema upgrade without any DataDoe call.
  (payload?.rows || []).forEach((row) => {
    const brand = row?.product_brand || row?.brand;
    if (String(brand || "").trim()) names.add(String(brand).trim());
  });
  return [...names];
}

export { snapshotBrandNames };

/**
 * The directory MEMBERSHIP over per-account latest brand-sales evidence.
 *
 * `perAccountSales` = [{ accountId, salesPayload }] -- the account's latest brand-sales payload hydrated STORAGE-FIRST
 * (null / absent when the account has no saved brand-sales yet: it pins nothing). An entry may instead carry an
 * already-extracted `salesBrands` array (the serve extracts the names inside its per-account read and never holds the
 * payload); when both are present `salesBrands` wins. The account scope is the serve's: primaryAccountIdsOnly (trimmed,
 * de-duplicated -- the FIRST entry of a duplicated id is the one read -- and dd-secondary "conn:uuid" ids excluded).
 *
 * Returns { membership: Map<brandKey, { display, accounts:Set }>, selectorKeys: string[] } where selectorKeys are the
 * sorted canonical keys of every brand that pins at least one account -- the only brands a portfolio request can ever
 * carry an account set for (a selector-only catalog brand maps to [] in the page and never issues a request).
 */
export function computeBrandDirectoryMembership(perAccountSales = []) {
  const entries = Array.isArray(perAccountSales) ? perAccountSales : [];
  const allowed = new Set(primaryAccountIdsOnly(entries.map((e) => (e ? e.accountId : null))));
  const seen = new Set();
  const scoped = [];
  for (const e of entries) {
    const id = String((e && e.accountId) == null ? "" : e.accountId).trim();
    if (!allowed.has(id) || seen.has(id)) continue;
    seen.add(id);
    const salesBrands = Array.isArray(e.salesBrands) ? e.salesBrands : snapshotBrandNames(e.salesPayload);
    scoped.push({ accountId: id, salesBrands });
  }
  const membership = buildBrandAccountMembership(scoped);
  return { membership, selectorKeys: [...membership.keys()].sort() };
}

// accountsById may be the serve's plain object { id: { country } } or a Map (the durable directory shape).
function accountsByIdObject(accountsById) {
  if (accountsById instanceof Map) {
    const out = {};
    for (const [id, m] of accountsById) out[String(id)] = { country: m && m.country != null ? m.country : null };
    return out;
  }
  return accountsById && typeof accountsById === "object" ? accountsById : {};
}

/**
 * Every membership brand's account set inside ONE region: [{ key, display, members }] sorted by key, members = the
 * brand's SORTED accounts filtered by filterAccountIdsToRegion(members, accountsById, region) (an account missing from
 * the trusted metadata or with an unknown / blank country is dropped -- fail closed, exactly the serve). Brands whose
 * region member set is EMPTY are omitted (the page never requests them for this region). THROWS on a region that is
 * not one of the three scheduler regions (a route never runs an unregioned portfolio).
 */
export function regionPortfolioMembers(membership, accountsById, region) {
  if (!isRegionScope(region)) throw new Error("regionPortfolioMembers requires a scheduler region (india|europe-au|us-ca) (fail closed).");
  const byId = accountsByIdObject(accountsById);
  const out = [];
  const map = membership instanceof Map ? membership : new Map();
  for (const key of [...map.keys()].sort()) {
    const entry = map.get(key);
    const sorted = [...((entry && entry.accounts) || [])].map(String).sort();
    const members = filterAccountIdsToRegion(sorted, byId, region);
    if (members.length) out.push({ key, display: String((entry && entry.display) || key), members });
  }
  return out;
}
