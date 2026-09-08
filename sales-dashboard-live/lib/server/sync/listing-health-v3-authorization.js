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

import { sha256 } from "../source-identity.js";

const S = (v) => (v == null ? "" : String(v));
// STRICT numeric validation: a real JS number that is a finite integer (a numeric STRING, NaN, Infinity, a float or a
// boolean is REJECTED -- never coerced). Authorization limits must be positive; request counts non-negative.
export const isStrictPositiveInt = (v) => typeof v === "number" && Number.isInteger(v) && v > 0;
export const isStrictNonNegativeInt = (v) => typeof v === "number" && Number.isInteger(v) && v >= 0;

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
// APPROVAL PROVENANCE of the standing limits below (verified from git history: the limits were introduced in commit
// 90d981e, 2026-09-08, reviewed release "Onboarding/scheduler P0+P1: ... durable LH authorization"). They are STANDING
// REGIONAL LIMITS -- a reviewed policy that authorizes any NEW frozen cycle whose structural spend fits within them --
// NOT an exact-plan approval of a specific day's plan and NOT a daily manual approval. They never raise themselves;
// raising one is a reviewed PR. Exact per-cycle binding (region + cycle/operation + tranche + membership + request
// hashes + plan fingerprint + pricing revision) is computed at run time by computeListingHealthV3AuthorizationBinding
// and verified EXACTLY on replay by verifyListingHealthV3ReplayBinding.
export const LISTING_HEALTH_V3_AUTHORIZATION_PROVENANCE = Object.freeze({
  kind: "standing-regional-limit",
  approvedIn: "commit 90d981e (2026-09-08) reviewed release; unchanged since",
  approvedBy: "release-owner review (git-audited; changed only through a reviewed PR)",
  tokensPerCreate: "ESTIMATE (rowCountBilling=true): the provider's final charge may differ; not a guaranteed maximum",
});

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
  const maxAccounts = cfg.maxAccounts;
  if (!isStrictPositiveInt(maxAccounts)) return { authorized: false, reason: "authorization-malformed", region: r, detail: "maxAccounts must be a strict positive integer" };
  const maxCreates = structuralRequiredCreates(maxAccounts);
  const maxTokens = maxCreates * V3_AUTHORIZED_TOKENS_PER_CREATE;
  return { authorized: true, region: r, maxAccounts, maxCreates, maxTokens, pricingRevision: S(cfg.pricingRevision), provenance: LISTING_HEALTH_V3_AUTHORIZATION_PROVENANCE };
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
export function decideListingHealthV3Authorization({ region, accountCount, requiredCreates, requiredTokens, authorization, pricingRevision = null } = {}) {
  const authz = authorization;
  if (!authz || typeof authz !== "object") return { ok: false, reason: "authorization-unreadable", detail: "no authorization decision available" };
  if (authz.authorized !== true) return { ok: false, reason: S(authz.reason) || "no-authorization", detail: authz.found ? `expected ${authz.expected} found ${authz.found}` : (authz.detail || null), authorization: authz };
  // The authorization must be FOR this request: same region and (when the caller states it) the same pricing revision.
  if (S(authz.region) !== S(region)) return { ok: false, reason: "authorization-region-mismatch", detail: `authorization is for "${S(authz.region)}" but the request is for "${S(region)}"`, authorization: authz };
  if (pricingRevision != null && S(authz.pricingRevision) !== S(pricingRevision)) return { ok: false, reason: "pricing-revision-stale", detail: `expected ${S(pricingRevision)} found ${S(authz.pricingRevision)}`, authorization: authz };
  // STRICT numeric limits: a malformed authorization (non-integer / string / NaN / <=0) or request count never passes.
  if (!isStrictPositiveInt(authz.maxAccounts) || !isStrictPositiveInt(authz.maxCreates) || !isStrictPositiveInt(authz.maxTokens)) {
    return { ok: false, reason: "authorization-malformed", detail: "maxAccounts/maxCreates/maxTokens must be strict positive integers", authorization: authz };
  }
  if (!isStrictNonNegativeInt(accountCount) || !isStrictNonNegativeInt(requiredCreates) || !isStrictNonNegativeInt(requiredTokens)) {
    return { ok: false, reason: "request-malformed", detail: "accountCount/requiredCreates/requiredTokens must be strict non-negative integers", authorization: authz };
  }
  const n = accountCount;
  const rc = requiredCreates;
  const rt = requiredTokens;
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

/**
 * EXACT per-cycle authorization BINDING (pure). Binds the standing regional authorization to the ACTUAL frozen work:
 * region + cycleDate + operationId + trancheKey + sorted membership (membershipHash) + sorted frozen request hashes
 * (requestHashesHash) + the frozen tranche plan fingerprint + the pricing revision + the frozen maxCreates/maxTokens.
 * The frozen spend must fit the authorization (strict integers). Returns
 *   { ok:true, binding:{ ..., bindingHash } } | { ok:false, reason, detail }
 * `estimatedTokens` is the ESTIMATED reservation ceiling (tokensPerCreate is an estimate; the provider's final charge
 * is not guaranteed by an internal reservation). Never performs I/O.
 */
export function computeListingHealthV3AuthorizationBinding({ region, cycleDate, operationId, trancheKey, accountIds, frozen, pricingRevision, authorization } = {}) {
  const authz = authorization;
  if (!authz || authz.authorized !== true) return { ok: false, reason: "no-authorization", detail: "binding requires an authorized decision" };
  if (S(authz.region) !== S(region)) return { ok: false, reason: "authorization-region-mismatch", detail: `authorization "${S(authz.region)}" vs request "${S(region)}"` };
  if (S(authz.pricingRevision) !== S(pricingRevision)) return { ok: false, reason: "pricing-revision-stale", detail: `expected ${S(pricingRevision)} found ${S(authz.pricingRevision)}` };
  if (!frozen || typeof frozen !== "object") return { ok: false, reason: "binding-unavailable", detail: "no frozen tranche budget to bind" };
  const hashes = [...new Set((Array.isArray(frozen.hashes) ? frozen.hashes : []).map((h) => S(h && (h.requestHash ?? h.request_hash ?? h))).filter(Boolean))].sort();
  const members = [...new Set((Array.isArray(accountIds) ? accountIds : []).map(S).filter(Boolean))].sort();
  if (!S(trancheKey) || !S(cycleDate) || !S(operationId)) return { ok: false, reason: "binding-malformed", detail: "trancheKey/cycleDate/operationId required" };
  if (!S(frozen.planFingerprint)) return { ok: false, reason: "binding-malformed", detail: "frozen plan fingerprint is blank" };
  if (S(frozen.trancheKey) && S(frozen.trancheKey) !== S(trancheKey)) return { ok: false, reason: "binding-malformed", detail: `frozen tranche "${S(frozen.trancheKey)}" vs "${S(trancheKey)}"` };
  if (!isStrictNonNegativeInt(frozen.maxCreates) || !isStrictNonNegativeInt(frozen.maxTokens)) return { ok: false, reason: "binding-malformed", detail: "frozen maxCreates/maxTokens must be strict non-negative integers" };
  if (hashes.length !== frozen.maxCreates) return { ok: false, reason: "binding-malformed", detail: `${hashes.length} frozen hashes vs maxCreates ${frozen.maxCreates}` };
  if (!isStrictPositiveInt(authz.maxCreates) || !isStrictPositiveInt(authz.maxTokens) || !isStrictPositiveInt(authz.maxAccounts)) return { ok: false, reason: "authorization-malformed", detail: "authorization limits must be strict positive integers" };
  if (members.length > authz.maxAccounts) return { ok: false, reason: "membership-exceeds-authorization", detail: `${members.length} accounts > ${authz.maxAccounts}` };
  if (frozen.maxCreates > authz.maxCreates) return { ok: false, reason: "creates-exceed-authorization", detail: `frozen ${frozen.maxCreates} creates > authorized ${authz.maxCreates}` };
  if (frozen.maxTokens > authz.maxTokens) return { ok: false, reason: "tokens-exceed-authorization", detail: `frozen ${frozen.maxTokens} tokens > authorized ${authz.maxTokens}` };
  const membershipHash = sha256(JSON.stringify(members));
  const requestHashesHash = sha256(JSON.stringify(hashes));
  const core = {
    region: S(region), cycleDate: S(cycleDate), operationId: S(operationId), trancheKey: S(trancheKey),
    membershipHash, requestHashesHash, planFingerprint: S(frozen.planFingerprint), pricingRevision: S(pricingRevision),
    maxCreates: frozen.maxCreates, maxTokens: frozen.maxTokens,
  };
  const bindingHash = sha256(JSON.stringify(core));
  return { ok: true, binding: Object.freeze({ ...core, bindingHash, requestHashes: Object.freeze(hashes), accountCount: members.length, estimatedTokens: frozen.maxTokens, authorizedMaxCreates: authz.maxCreates, authorizedMaxTokens: authz.maxTokens, authorizedMaxAccounts: authz.maxAccounts }) };
}

/**
 * EXACT replay verification (pure). `persisted` is the durable frozen budget already on the v3 cycle for this tranche
 * ({ row:{plan_fingerprint,max_creates,max_tokens}, hashes:[{request_hash}] }) or null when no cycle/budget exists yet
 * (a NEW frozen cycle: the standing policy authorizes it -- ok, replay:false). On replay EVERY bound element must match
 * exactly: fingerprint, ceilings and the frozen request-hash set. Any mismatch => typed awaiting-budget BEFORE paid work.
 */
export function verifyListingHealthV3ReplayBinding({ binding, persisted } = {}) {
  if (!binding || !binding.bindingHash) return { ok: false, reason: "binding-unavailable", detail: "no binding to verify" };
  if (persisted == null) return { ok: true, replay: false };
  const row = persisted.row || persisted;
  const fp = S(row.plan_fingerprint ?? row.planFingerprint);
  const mc = Number(row.max_creates ?? row.maxCreates);
  const mt = Number(row.max_tokens ?? row.maxTokens);
  const hashes = [...new Set((Array.isArray(persisted.hashes) ? persisted.hashes : []).map((h) => S(h && (h.request_hash ?? h.requestHash ?? h))).filter(Boolean))].sort();
  const problems = [];
  if (fp !== binding.planFingerprint) problems.push("plan-fingerprint");
  if (mc !== binding.maxCreates) problems.push("max-creates");
  if (mt !== binding.maxTokens) problems.push("max-tokens");
  if (JSON.stringify(hashes) !== JSON.stringify([...binding.requestHashes])) problems.push("request-hashes");
  if (problems.length) return { ok: false, reason: "replay-binding-mismatch", detail: `persisted frozen budget differs from the bound plan: ${problems.join(", ")}` };
  return { ok: true, replay: true };
}
