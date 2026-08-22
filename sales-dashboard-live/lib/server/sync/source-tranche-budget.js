// Scheduler v2 Blocker 4d -- FROZEN per-(cycle, tranche) create-export + AI-token budget (pure, ZERO I/O).
//
// Official DataDoe cost rules this module encodes (NEVER a blanket "exports x 2"):
//   - an ExportRequest carries at most 5 sellerOrVendorIds;
//   - a STANDARD source export costs 2 AI tokens; a PREMIUM source export costs 5;
//   - source discovery exposes isPremium per source.
// So the token ceiling is sum over the UNIQUE canonical request_hashes of (isPremium ? 5 : 2) -- the batching
// (seller = ceil(N/5) hashes per window; organization-wide Product Catalog = one hash per org/window;
// non-batchable = one hash per account/window) is ALREADY reflected in the plan's unique hashes, so the budget
// just counts them. Missing/ambiguous pricing FAILS CLOSED before any create-export POST.
//
// The frozen budget (plan fingerprint + max creates + max tokens + the per-hash costs) is persisted per
// (cycle, tranche). A continuation recomputes it and MUST match the frozen fingerprint (plan/pricing drift is
// rejected). Accounts discovered after a cycle begins are simply absent from the frozen plan -- they join the
// NEXT cycle's fresh budget and can never widen an existing frozen one.

import { sha256 } from "../source-identity.js";

export const STANDARD_SOURCE_TOKENS = 2;
export const PREMIUM_SOURCE_TOKENS = 5;
export const MAX_SELLER_IDS_PER_EXPORT = 5;

// The AI-token cost of ONE source export, from its discovery isPremium. isPremium MUST be a definite boolean
// (from source discovery); anything else is missing/ambiguous pricing and throws (fail closed) -- there is no
// default cost.
export function sourceTokenCost(isPremium) {
  if (isPremium === true) return PREMIUM_SOURCE_TOKENS;
  if (isPremium === false) return STANDARD_SOURCE_TOKENS;
  throw new Error("sourceTokenCost: missing/ambiguous source pricing (isPremium must be a definite boolean); refusing (fail closed).");
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
export function computeFrozenTrancheBudget({ plannedJobs, sourceTranche = null, isPremiumOf, trancheKey = null } = {}) {
  if (typeof isPremiumOf !== "function") {
    throw new Error("computeFrozenTrancheBudget requires an isPremiumOf(job) pricing reader (fail closed).");
  }
  const selects = sourceTranche && typeof sourceTranche.selects === "function" ? (j) => sourceTranche.selects(j) : () => true;
  const byHash = new Map();
  for (const job of plannedJobs || []) {
    if (!job || !selects(job)) continue;
    const requestHash = job.requestHash ?? job.request_hash;
    if (!requestHash) throw new Error("computeFrozenTrancheBudget: a planned job is missing its request_hash (fail closed).");
    if (byHash.has(requestHash)) continue; // UNIQUE canonical hashes only (batching already reflected)
    const tokenCost = sourceTokenCost(isPremiumOf(job)); // throws on missing/ambiguous pricing
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
