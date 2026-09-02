// Central scheduler SCOPE resolver -- the ONE server-side authority for (a) which scope values the durable
// scheduler namespace may carry and (b) which accounts route to a scope. PURE + offline (no I/O, no DataDoe,
// no side effects), so every routing decision is deterministic + unit-testable.
//
// A "scope" is one of:
//   - a legacy revenue bucket : us | non-us          (NO LONGER scheduled, but every historical row keeps them
//                                                      valid + a one-flag rollback can reuse them)
//   - one of the three ACTIVE regions : india | europe-au | us-ca
// plus, for the DECOUPLED FBA cycle namespace only, an "-fba" twin of any of the above. The -fba twin is a
// sync_cycles.bucket NAMESPACE (so an FBA cycle never collides with the revenue cycle on the same slot); it is
// NEVER an account-routing target -- accounts always route to a base routing scope.
//
// Region membership + the deterministic cron<->region mapping live in campaign-region-routing.js (the pure routing
// groundwork). This module builds the scheduler-facing validation + the account-scope predicate on top of it, so
// there is exactly ONE definition of "which marketplace belongs to which region". A browser-supplied region is
// never trusted: callers pass an account's stored marketplace/country evidence, and routing is recomputed from the
// live discovered list on every run so a newly-connected seller auto-joins its region.

import { REGIONS, regionForMarketplace } from "./campaign-region-routing.js";

const S = (v) => (v == null ? "" : String(v).trim());

// The three ACTIVE regional scopes (the automatic scheduler runs exactly these).
export const REGION_SCOPES = Object.freeze(["india", "europe-au", "us-ca"]);
// Legacy revenue buckets -- retained for historical rows + one-flag rollback; not scheduled automatically.
export const LEGACY_SCOPES = Object.freeze(["us", "non-us"]);
// A scope that is an account-routing target (region or legacy bucket) -- excludes the -fba namespace twins.
export const ROUTING_SCOPES = Object.freeze([...REGION_SCOPES, ...LEGACY_SCOPES]);

export const FBA_SUFFIX = "-fba";
// The decoupled FBA cycle-namespace twin of every routing scope (sync_cycles.bucket only).
export const FBA_SCOPES = Object.freeze(ROUTING_SCOPES.map((s) => `${s}${FBA_SUFFIX}`));
// Every scope value the durable scheduler namespace may legitimately carry (matches the DB CHECK allow-list).
export const ALL_SCOPES = Object.freeze([...ROUTING_SCOPES, ...FBA_SCOPES]);

export function isRegionScope(scope) { return REGION_SCOPES.includes(S(scope)); }
export function isLegacyScope(scope) { return LEGACY_SCOPES.includes(S(scope)); }
export function isRoutingScope(scope) { return ROUTING_SCOPES.includes(S(scope)); }
export function isFbaScope(scope) { return FBA_SCOPES.includes(S(scope)); }
export function isValidScope(scope) { return ALL_SCOPES.includes(S(scope)); }

// Strip the FBA namespace twin back to its base routing scope (idempotent for a non-fba scope).
export function baseScope(scope) {
  const s = S(scope);
  return s.endsWith(FBA_SUFFIX) ? s.slice(0, -FBA_SUFFIX.length) : s;
}
// The FBA cycle-namespace twin for a routing scope (idempotent if already an -fba twin).
export function fbaScope(scope) {
  const s = S(scope);
  return s.endsWith(FBA_SUFFIX) ? s : `${s}${FBA_SUFFIX}`;
}

// The region an account's marketplace/country routes to: india | europe-au | us-ca | unassigned.
export function regionForCountry(country) { return regionForMarketplace(country); }

// Legacy us/non-us classification (inlined to keep this module dependency-light + cycle-free; mirrors
// registry.bucketForCountry, which stays the authority for the legacy path).
function legacyBucketForCountry(country) {
  const code = S(country).toUpperCase();
  if (!code) return "unknown";
  return code === "US" ? "us" : "non-us";
}

// Does an account (by its marketplace/country evidence) belong to `scope`? Region scopes route by
// regionForMarketplace; legacy scopes by the us/non-us rule; the -fba twin routes identically to its base.
// Fail-closed: an unknown/blank marketplace matches NO region scope (regionForMarketplace -> "unassigned"), so
// the caller must skip + alert it, never coerce it into a region.
export function accountInScope(scope, country) {
  const base = baseScope(scope);
  if (REGION_SCOPES.includes(base)) return regionForMarketplace(country) === base;
  if (LEGACY_SCOPES.includes(base)) return legacyBucketForCountry(country) === base;
  return false;
}

// Assert a scope is valid; throw (fail closed) otherwise. `routingOnly` restricts to account-routing scopes
// (rejects the -fba namespace twins), used where a value must name a real account bucket.
export function assertScope(scope, { routingOnly = false } = {}) {
  const s = S(scope);
  const ok = routingOnly ? ROUTING_SCOPES.includes(s) : ALL_SCOPES.includes(s);
  if (!ok) {
    const allowed = (routingOnly ? ROUTING_SCOPES : ALL_SCOPES).join(" | ");
    throw new Error(`invalid scheduler scope "${s}"; expected one of ${allowed} (fail closed).`);
  }
  return s;
}

// Re-export the canonical region constant so downstream code has one import site for both scope + region.
export { REGIONS };
