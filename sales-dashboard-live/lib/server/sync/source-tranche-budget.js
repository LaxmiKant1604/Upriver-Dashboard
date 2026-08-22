// Scheduler v2 Blocker 4d -- FROZEN per-(cycle, tranche) create-export + AI-token budget (pure, ZERO I/O).
//
// Official DataDoe cost rule this module encodes (confirmed by DataDoe in writing):
//   - EVERY export costs EXACTLY 2 AI tokens -- regardless of seller count, marketplace mix, or rows;
//   - any number of sellerOrVendorIds may be combined in one export (the only cap is 5,000,000 rows/export).
// So the token ceiling is simply 2 x (the number of UNIQUE canonical request_hashes). The batching (one US +
// one Non-US export per seller-scoped source/window; organization-wide Product Catalog = one export per
// org/window) is ALREADY reflected in the plan's unique hashes, so the budget just counts them x 2.
// [Superseded: the former standard=2/premium=5 pricing and the <=5-seller-per-export cap.]
//
// The frozen budget (plan fingerprint + max creates + max tokens + the per-hash costs) is persisted per
// (cycle, tranche). A continuation recomputes it and MUST match the frozen fingerprint (plan/pricing drift is
// rejected). Accounts discovered after a cycle begins are simply absent from the frozen plan -- they join the
// NEXT cycle's fresh budget and can never widen an existing frozen one.

import { sha256 } from "../source-identity.js";

// EVERY DataDoe export costs exactly 2 AI tokens (flat). The former standard/premium split and the <=5-seller
// cap are SUPERSEDED; these aliases are retained (flat 2 / unlimited) so importers keep resolving.
export const EXPORT_TOKEN_COST = 2;
export const STANDARD_SOURCE_TOKENS = 2;
export const PREMIUM_SOURCE_TOKENS = 2; // superseded: no premium tier -- every export is 2 tokens
export const MAX_SELLER_IDS_PER_EXPORT = Number.MAX_SAFE_INTEGER; // superseded: no per-export seller cap

// The AI-token cost of ONE source export: a flat 2 tokens (DataDoe confirmed every export is exactly 2). The
// isPremium argument is retained for call-site back-compat but is IGNORED -- there is no premium tier.
export function sourceTokenCost(_isPremium) {
  return EXPORT_TOKEN_COST;
}

// A deterministic tranche key for a built tranche descriptor (or "all" for the full plan). Stable across
// invocations so a continuation resolves the SAME persisted budget row.
export function trancheKeyOf(sourceTranche) {
  if (!sourceTranche) return "all";
  if (typeof sourceTranche.name === "string" && sourceTranche.name.trim() !== "") return sourceTranche.name;
  return "all";
}

/**
 * Compute the FROZEN budget for the source jobs the tranche selects (Blocker 4d, part 1). `plannedJobs` are the
 * canonical planned source jobs (each with requestHash + sourceKey); `sourceTranche` is the built tranche
 * descriptor (or null for the whole plan); `isPremiumOf(job)` returns the source's discovery isPremium (a
 * definite boolean, else this fails closed). Returns
 *   { trancheKey, planFingerprint, maxCreates, maxTokens, hashes:[{requestHash, sourceKey, tokenCost}] }
 * where maxCreates = the number of UNIQUE selected request_hashes, maxTokens = the sum of their token costs,
 * and planFingerprint = a sha256 over the sorted (request_hash, token_cost) pairs -- so ANY added/removed hash
 * OR changed price yields a different fingerprint (drift is detectable). Deterministic; performs no I/O.
 */
export function computeFrozenTrancheBudget({ plannedJobs, sourceTranche = null, isPremiumOf = null, trancheKey = null } = {}) {
  // Every export is a FLAT 2 tokens (DataDoe confirmed). No per-source pricing reader is required; isPremiumOf
  // is accepted for call-site back-compat but IGNORED (there is no premium tier).
  void isPremiumOf;
  const selects = sourceTranche && typeof sourceTranche.selects === "function" ? (j) => sourceTranche.selects(j) : () => true;
  const byHash = new Map();
  for (const job of plannedJobs || []) {
    if (!job || !selects(job)) continue;
    const requestHash = job.requestHash ?? job.request_hash;
    if (!requestHash) throw new Error("computeFrozenTrancheBudget: a planned job is missing its request_hash (fail closed).");
    if (byHash.has(requestHash)) continue; // UNIQUE canonical hashes only (batching already reflected)
    const tokenCost = sourceTokenCost(); // flat EXPORT_TOKEN_COST (2) per export
    byHash.set(requestHash, { requestHash, sourceKey: job.sourceKey ?? job.source_key ?? "", tokenCost });
  }
  // Deterministic order (by request_hash) for a stable fingerprint independent of plan emission order.
  const hashes = [...byHash.values()].sort((a, b) => (a.requestHash < b.requestHash ? -1 : a.requestHash > b.requestHash ? 1 : 0));
  const maxCreates = hashes.length;
  const maxTokens = hashes.reduce((sum, h) => sum + h.tokenCost, 0);
  const planFingerprint = sha256(JSON.stringify(["source-tranche-budget/v1", hashes.map((h) => [h.requestHash, h.tokenCost])]));
  return { trancheKey: trancheKey || trancheKeyOf(sourceTranche), planFingerprint, maxCreates, maxTokens, hashes };
}

// Assert a freshly recomputed budget matches the FROZEN one (a continuation must not drift). Throws a typed
// PLAN_BUDGET_MISMATCH error when the plan fingerprint, create ceiling, or token ceiling differs.
export function assertFrozenBudgetMatches(frozen, recomputed) {
  const mismatch = !frozen || !recomputed
    || frozen.planFingerprint !== recomputed.planFingerprint
    || Number(frozen.maxCreates) !== Number(recomputed.maxCreates)
    || Number(frozen.maxTokens) !== Number(recomputed.maxTokens);
  if (mismatch) {
    const err = new Error("PLAN_BUDGET_MISMATCH: the recomputed tranche plan/pricing differs from the frozen budget; refusing (fail closed).");
    err.code = "PLAN_BUDGET_MISMATCH";
    throw err;
  }
  return true;
}
