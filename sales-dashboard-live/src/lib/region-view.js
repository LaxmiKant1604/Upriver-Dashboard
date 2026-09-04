/* =====================================================================
   region-view -- client-side Region -> Brand selection helpers
   =====================================================================

   Brand View (the cross-account portfolio) selects a REGION first, then a brand
   within that region. Region membership is decided by an account's TRUSTED
   marketplace/country metadata, using the SINGLE canonical mapping the scheduler
   already owns (regionForMarketplace / REGIONS in
   lib/server/sync/campaign-region-routing.js). That module is pure (zero imports,
   no I/O), so importing it in the browser bundle is safe and -- crucially --
   guarantees there is exactly ONE marketplace->region definition shared by the
   scheduler, the server report guards and this client. We never re-derive the
   mapping here; we only compose selection/filtering helpers on top of it.

   A newly-connected account inherits its region automatically because region is
   computed from its marketplace every time -- there is no stored assignment to
   update. An unknown/blank marketplace resolves to REGIONS.UNASSIGNED and is
   never offered as a selectable region (never silently folded into one). */

import { REGIONS, REGION_SCHEDULE, regionForMarketplace } from "../../lib/server/sync/campaign-region-routing.js";

export { REGIONS, regionForMarketplace };

// The three selectable regions, in display order, with labels from the canonical
// schedule (UNASSIGNED is deliberately NOT selectable).
export const REGION_OPTIONS = Object.freeze([
  { value: REGIONS.INDIA, label: REGION_SCHEDULE[REGIONS.INDIA].label },
  { value: REGIONS.EUROPE_AU, label: REGION_SCHEDULE[REGIONS.EUROPE_AU].label },
  { value: REGIONS.US_CA, label: REGION_SCHEDULE[REGIONS.US_CA].label },
]);

const LABEL_BY_REGION = new Map(REGION_OPTIONS.map((o) => [o.value, o.label]));

// Display label for a region value (falls back to the raw value for an unknown one).
export function regionLabel(region) {
  return LABEL_BY_REGION.get(String(region || "")) || String(region || "");
}

// Is `region` one of the three selectable regions (never UNASSIGNED / blank)?
export function isSelectableRegion(region) {
  return LABEL_BY_REGION.has(String(region || ""));
}

// The region an account belongs to, from its trusted country/marketplace metadata.
// Accepts either a `country` or `marketplace` field; returns REGIONS.UNASSIGNED for
// an unknown/blank marketplace (never silently assigned to a region).
export function accountRegion(account) {
  if (!account) return REGIONS.UNASSIGNED;
  return regionForMarketplace(account.country ?? account.marketplace);
}

// Accounts (from an already-authorized list) that belong to `region`. An unknown
// marketplace matches no selectable region, so it is excluded rather than assigned.
export function accountsInRegion(accounts, region) {
  const target = String(region || "");
  if (!isSelectableRegion(target)) return [];
  return (Array.isArray(accounts) ? accounts : []).filter((a) => accountRegion(a) === target);
}

// The regions that contain at least one of the given (authorized) accounts, in
// canonical order, each with its account count. Regions with zero authorized
// accounts are omitted so the selector only ever offers regions the signed-in
// user can actually access. UNASSIGNED accounts contribute to no region.
export function regionsForAccounts(accounts) {
  const counts = new Map();
  for (const account of Array.isArray(accounts) ? accounts : []) {
    const region = accountRegion(account);
    if (!isSelectableRegion(region)) continue;
    counts.set(region, (counts.get(region) || 0) + 1);
  }
  return REGION_OPTIONS
    .filter((o) => counts.has(o.value))
    .map((o) => ({ value: o.value, label: o.label, count: counts.get(o.value) }));
}

// The number of authorized accounts in `region` whose marketplace is unknown --
// always 0 by construction (unassigned accounts are never counted into a region),
// exposed as a helper so callers can surface "unassigned" coverage separately.
export function unassignedAccounts(accounts) {
  return (Array.isArray(accounts) ? accounts : []).filter((a) => accountRegion(a) === REGIONS.UNASSIGNED);
}

// Choose the region to show given the currently-authorized accounts and a possibly
// stale prior selection: keep the prior region if it still has authorized accounts,
// otherwise fall back to the first available region (or "" when none). Pure, so the
// caller can drive a controlled selector from it deterministically.
export function resolveSelectedRegion(prevRegion, accounts) {
  const available = regionsForAccounts(accounts);
  if (prevRegion && available.some((r) => r.value === prevRegion)) return prevRegion;
  return available.length ? available[0].value : "";
}
