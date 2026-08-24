// Scheduler v2 -- TRUSTED plan + assessment core for the AUTOMATIC scheduled ASIN Ads (ads-asin-date) refresh.
//
// ASIN Ads does NOT flow through the Scheduler-v2 source-job engine; it is fetched by the durable Ads
// architecture (lib/server/ads-sync.js -> runAdsSync). The scheduled operator (scripts/release/
// scheduled-asin-ads-refresh.mjs) runs ONLY the ASIN grain ("asin-performance-v1") for one bucket in
// COVERAGE mode -- <=5-seller batches, an exact 21-day rolling window, idempotent skip of already-proven
// coverage (no refetch), one create per batch, LKG preserved on failure -- then calls assessScheduledAsinAdsCycle
// to PROVE the outcome stayed inside scope + the per-bucket create/token ceiling. This module is the pure,
// offline-testable core. Campaign Ads and FBA are NEVER run here.

import { assignAccountBatches, MAX_ACCOUNTS_PER_BATCH } from "./source-batching.js";

export const ASIN_ADS_GRAIN = "asin-performance-v1";   // the durable Ads worker key for ASIN Ads
export const ASIN_ADS_SOURCE_KEY = "ads-asin-date";    // the registry key
export const ASIN_ADS_TOKENS_PER_CREATE = 2;           // standard DataDoe export
export const ASIN_ADS_ROLLING_WINDOW_DAYS = 21;        // rolling incremental window

const S = (v) => (v == null ? "" : String(v));
const nb = (v) => S(v).trim() !== "";

/**
 * The daily ASIN Ads plan for a bucket: batch the discovered PRIMARY accounts into <=5-seller groups (same
 * stable packing OLI uses). Returns { batches, expectedBatches, maxCreates, maxTokens }. Standard export = 2
 * tokens, so US 8 -> 2 batches / 4 tokens and Non-US 22 -> 5 batches / 10 tokens (combined <= 7 exports / 14
 * tokens for a full Ads refresh).
 */
export function asinAdsBucketPlan(accounts, existingMembership = new Map()) {
  const primary = (accounts || []).filter((a) => a && nb(a.accountId) && !S(a.accountId).includes(":"));
  const { batches } = assignAccountBatches(primary, existingMembership, MAX_ACCOUNTS_PER_BATCH);
  const expectedBatches = batches.length;
  return { batches, expectedBatches, maxCreates: expectedBatches, maxTokens: expectedBatches * ASIN_ADS_TOKENS_PER_CREATE };
}

/**
 * The rolling ASIN Ads refresh window ending at `asOf` (strict YYYY-MM-DD): a 21-day inclusive window
 * [asOf-20 .. asOf]. Coverage mode fetches only the dates in this window that durable coverage does not already
 * prove, so historical Ads already covered is never refetched.
 */
export function asinAdsRefreshWindow(asOf) {
  const to = S(asOf);
  const d = new Date(`${to}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - (ASIN_ADS_ROLLING_WINDOW_DAYS - 1));
  return { from: d.toISOString().slice(0, 10), to };
}

/**
 * STRICT assessment of a scheduled ASIN Ads refresh. `batchResults` is one entry per <=5-account coverage batch:
 * { accountIds: [<=5 public ids], summary: <coverage-mode runAdsSync return> }. `creates` is the real
 * DataDoe create-export count observed via an injected counting createExport. Proves:
 *   - at least one batch ran and every discovered account is covered by exactly one batch (<=5 each, all
 *     inside the discovered set -- no leakage, no US/Non-US mix because the caller batches within the bucket);
 *   - every batch summary is status "completed" + coverageComplete + successfulCoveragePairs==expected +
 *     not deferred + ONLY the asin-performance-v1 source + zero failed/coverage-failed accounts;
 *   - total creates <= the plan ceiling and tokens (creates*2) <= the token ceiling.
 * ok === true ONLY when problems is empty (a warm run with 0 creates is ok: skipped == covered).
 */
export function assessScheduledAsinAdsCycle({ bucket, discoveredAccounts, batchResults, creates } = {}) {
  const problems = [];
  const push = (p) => problems.push(p);
  if (bucket !== "us" && bucket !== "non-us") return { ok: false, problems: ["bad-bucket"], creates: 0, tokens: 0, batches: 0, ceilingCreates: 0, ceilingTokens: 0 };
  const discovered = [...new Set((discoveredAccounts || []).map((a) => S(a && (a.accountId ?? a)).trim()).filter(Boolean))].sort();
  if (!discovered.length) return { ok: false, problems: ["no-discovered-accounts"], creates: 0, tokens: 0, batches: 0, ceilingCreates: 0, ceilingTokens: 0 };
  const discoveredSet = new Set(discovered);
  const plan = asinAdsBucketPlan(discovered.map((accountId) => ({ accountId })));

  const results = Array.isArray(batchResults) ? batchResults : [];
  if (!results.length) push("no-batches");
  const coveredUnion = new Set();
  for (const r of results) {
    const summary = r && r.summary;
    const batchIds = ((r && r.accountIds) || []).map(S).filter(nb);
    if (!summary) { push("missing-summary"); continue; }
    if (S(summary.status) !== "completed") push("batch-not-completed:" + S(summary.status));
    if (summary.coverageComplete !== true) push("batch-coverage-incomplete");
    if (Number(summary.successfulCoveragePairs) !== Number(summary.expectedCoveragePairs)) push("coverage-pairs-mismatch");
    if (summary.deferred === true) push("batch-deferred");
    const sources = summary.sources || {};
    for (const key of Object.keys(sources)) if (key !== ASIN_ADS_GRAIN) push("non-asin-source:" + key);
    const asin = sources[ASIN_ADS_GRAIN] || {};
    if ((asin.failedAccounts || []).length) push("failed-accounts:" + asin.failedAccounts.length);
    if ((asin.coverageFailedAccounts || []).length) push("coverage-failed-accounts:" + asin.coverageFailedAccounts.length);
    if (batchIds.length > MAX_ACCOUNTS_PER_BATCH) push("batch-oversized:" + batchIds.length);
    if (!batchIds.length) push("batch-empty");
    for (const id of batchIds) { if (!discoveredSet.has(id)) push("batch-account-unexpected"); coveredUnion.add(id); }
  }
  for (const a of discovered) if (!coveredUnion.has(a)) push("account-coverage-missing");

  const createsN = Number(creates) || 0;
  const tokens = createsN * ASIN_ADS_TOKENS_PER_CREATE;
  if (createsN > plan.maxCreates) push("creates-over-ceiling:" + createsN + ">" + plan.maxCreates);
  if (tokens > plan.maxTokens) push("tokens-over-ceiling:" + tokens + ">" + plan.maxTokens);

  return {
    ok: problems.length === 0,
    problems,
    creates: createsN,
    tokens,
    batches: results.length,
    ceilingCreates: plan.maxCreates,
    ceilingTokens: plan.maxTokens,
  };
}
