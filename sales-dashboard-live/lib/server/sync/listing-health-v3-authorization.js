// EXPLICIT DURABLE Listing Health v3 spend authorization (P1-3).
//
// THREE concepts are DELIBERATELY separate and must never be conflated:
//   1. STRUCTURAL required creates -- computed from the frozen plan membership (2 creates per <=5-seller batch =
//      2 * ceil(eligibleAccountCount / 5)). This is what the run NEEDS. It scales with account growth.
//   2. EXPLICIT DURABLE AUTHORIZED maxCreates / maxTokens -- what an operator has REVIEWED and authorized for a
//      region, bound to a pricing revision. This is a CEILING on structural spend. It is NOT derived from the token
//      balance and it does NOT auto-increase when accounts are added: growth beyond the authorized ceiling returns a
//      typed awaiting-budget until an operator reviews and raises it (a reviewed, durable, git-audited change).
//   3. LIVE AFFORDABILITY balance -- the usable DataDoe balance minus the emergency reserve, checked SEPARATELY at
//      run time. Authorization does NOT imply affordability and affordability does NOT imply authorization; a live
//      create requires BOTH (plus the atomic pre-POST reservation + frozen tranche budget, the true runtime ceiling).
//
// The authorization is read from the durable control system via an INJECTABLE reader. The default reader is the
// reviewed, region-scoped configuration below (durable in git, changed only through a reviewed PR -- the same control
// mechanism as the emergency-reserve constant and the region ceilings). A future migration-backed operator-runtime
// authorization table can replace `readListingHealthV3Authorization` with zero changes to the operation logic.
//
// This module NEVER touches the network, DataDoe, or the token balance. 7-bit ASCII, LF.

const S = (v) => (v == null ? "" : String(v));

export const V3_INGESTION_REGIONS = Object.freeze(["india", "europe-au", "us-ca"]);

// STANDARD per-create token estimate for a Listings / Listings-Raw export. rowCountBilling=true means the real bill
// can EXCEED this -- it is an ESTIMATE, never a guaranteed maximum. The authorization caps the STRUCTURAL plan; the
// frozen tranche budget's atomic pre-POST reservation + the live balance gate are the true runtime enforcers.
export const V3_AUTHORIZED_TOKENS_PER_CREATE = 2;

// The pricing revision the current authorization was reviewed against. Authorization is bound to it: if the live
// pricing revision differs, the authorization is STALE and the run defers (awaiting-budget) until re-reviewed.
export const LISTING_HEALTH_V3_PRICING_REVISION = "2026-09-lhv3-std2";

// REVIEWED DURABLE per-region authorization. `maxAccounts` is the operator-authorized ceiling on export-eligible
// accounts for the region (chosen with deliberate headroom over the current membership so ordinary growth does not
// trip awaiting-budget, while a large unexpected jump does -- forcing a reviewed decision). maxCreates / maxTokens are
// DERIVED from it via the SAME structural formula the run uses (2 * ceil(N / 5) creates), so the authorization is a
// true ceiling on structural spend rather than an independent magic number. These are EXPLICIT authorizations, NOT the
// obsolete fixed 4/8/4 batch-count assumption: they are membership CEILINGS with headroom, not the current batch count.
export const LISTING_HEALTH_V3_REGION_AUTHORIZATION = Object.freeze({
  "india": { maxAccounts: 20, pricingRevision: LISTING_HEALTH_V3_PRICING_REVISION },
  "europe-au": { maxAccounts: 35, pricingRevision: LISTING_HEALTH_V3_PRICING_REVISION },
  "us-ca": { maxAccounts: 20, pricingRevision: LISTING_HEALTH_V3_PRICING_REVISION },
});

/** STRUCTURAL required creates for N export-eligible accounts: 2 creates per <=5-seller batch. */
export function structuralRequiredCreates(accountCount) {
  const n = Number(accountCount);
  if (!Number.isInteger(n) || n <= 0) return 0;
  return 2 * Math.ceil(n / 5);
}

/**
 * The DEFAULT durable authorization reader (config-backed). Returns a TYPED decision -- never throws for a
 * missing/stale/malformed authorization (those are typed refusals, so the caller emits awaiting-budget, not a crash):
 *   { authorized:true, region, maxAccounts, maxCreates, maxTokens, pricingRevision }
 *   { authorized:false, reason:"no-authorization"|"pricing-revision-stale"|"authorization-malformed", region, ... }
 */
export function readListingHealthV3Authorization({ region, pricingRevision = LISTING_HEALTH_V3_PRICING_REVISION, config = LISTING_HEALTH_V3_REGION_AUTHORIZATION } = {}) {
  const r = S(region);
  const cfg = config && config[r];
  if (!cfg) return { authorized: false, reason: "no-authorization", region: r };
  if (S(cfg.pricingRevision) !== S(pricingRevision)) {
    return { authorized: false, reason: "pricing-revision-stale", region: r, expected: S(pricingRevision), found: S(cfg.pricingRevision) };
  }
  const maxAccounts = Number(cfg.maxAccounts);
  if (!Number.isInteger(maxAccounts) || maxAccounts <= 0) return { authorized: false, reason: "authorization-malformed", region: r };
  const maxCreates = structuralRequiredCreates(maxAccounts);
  const maxTokens = maxCreates * V3_AUTHORIZED_TOKENS_PER_CREATE;
  return { authorized: true, region: r, maxAccounts, maxCreates, maxTokens, pricingRevision: S(cfg.pricingRevision) };
}

/**
 * Decide whether a run's STRUCTURAL required spend is authorized. PURE (no I/O). Returns a typed decision:
 *   { ok:true, authorization }                                  -- proceed to the SEPARATE affordability check
 *   { ok:false, reason, detail, authorization? }                -- emit awaiting-budget (zero creates, LKG preserved)
 * `reason` is one of: no-authorization | pricing-revision-stale | authorization-malformed | authorization-unreadable
 *   | membership-exceeds-authorization | creates-exceed-authorization | tokens-exceed-authorization.
 * NOTE: this checks authorization ONLY. Affordability (usable balance - reserve) is a distinct gate the caller runs
 * on top; passing here never implies the tokens are affordable.
 */
export function decideListingHealthV3Authorization({ region, accountCount, requiredCreates, requiredTokens, authorization } = {}) {
  const authz = authorization;
  if (!authz || typeof authz !== "object") return { ok: false, reason: "authorization-unreadable", detail: "no authorization decision available" };
  if (authz.authorized !== true) return { ok: false, reason: S(authz.reason) || "no-authorization", detail: authz.found ? `expected ${authz.expected} found ${authz.found}` : null, authorization: authz };
  const n = Number(accountCount);
  const rc = Number(requiredCreates);
  const rt = Number(requiredTokens);
  if (Number.isInteger(n) && n > Number(authz.maxAccounts)) {
    return { ok: false, reason: "membership-exceeds-authorization", detail: `${n} eligible accounts > authorized maxAccounts ${authz.maxAccounts}`, authorization: authz };
  }
  if (Number.isFinite(rc) && rc > Number(authz.maxCreates)) {
    return { ok: false, reason: "creates-exceed-authorization", detail: `${rc} required creates > authorized maxCreates ${authz.maxCreates}`, authorization: authz };
  }
  if (Number.isFinite(rt) && rt > Number(authz.maxTokens)) {
    return { ok: false, reason: "tokens-exceed-authorization", detail: `${rt} required tokens > authorized maxTokens ${authz.maxTokens}`, authorization: authz };
  }
  return { ok: true, authorization: authz };
}
