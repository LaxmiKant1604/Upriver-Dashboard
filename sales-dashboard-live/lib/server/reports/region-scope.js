// Server-side REGION scope enforcement for the regional Brand View (pure + offline-testable).
//
// Region membership is ALWAYS decided from an account's TRUSTED directory metadata (its marketplace/country) using
// the SINGLE canonical mapping the scheduler owns (regionForMarketplace via scheduler-scope). A browser-supplied
// region is validated here but never trusted to define membership: the account set is re-filtered from trusted
// country on the server, so a tampered request can never smuggle a cross-region account into a region's rollup.

import { isRegionScope, regionForCountry } from "../sync/scheduler-scope.js";

export { isRegionScope };

export class RegionScopeError extends Error {
  constructor(message) { super(message); this.name = "RegionScopeError"; this.status = 400; }
}

// Validate an OPTIONAL region query param. Blank/absent -> null (no region filter; legacy path stays byte-identical).
// A present-but-invalid value throws RegionScopeError (the caller returns 400 without disclosure -- the three region
// names are public scheduler scopes, so rejecting an invalid one reveals nothing about accounts or brands).
export function normalizeRegionParam(region) {
  const r = String(region == null ? "" : region).trim();
  if (!r) return null;
  if (!isRegionScope(r)) throw new RegionScopeError("Invalid region.");
  return r;
}

// Keep only accountIds whose TRUSTED country routes to `region`. `accountsById` maps id -> { country }. Fail-closed:
// an id missing from the directory, or with an unknown/blank country, routes to "unassigned" and is DROPPED (never
// coerced into a region). When `region` is falsy the input is returned unchanged (region is optional).
export function filterAccountIdsToRegion(accountIds, accountsById, region) {
  const ids = (Array.isArray(accountIds) ? accountIds : []).map(String);
  if (!region) return ids;
  const map = accountsById || {};
  return ids.filter((id) => regionForCountry(map[id] && map[id].country) === region);
}
