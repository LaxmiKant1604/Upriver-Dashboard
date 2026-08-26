// The SHARED ASIN Ads bucket-refresh core used by BOTH the GitHub scheduler operator
// (scripts/release/scheduled-asin-ads-refresh.mjs) and the Data Sync Center manual "Sync source" action --
// one implementation, so the two paths cannot drift. It wraps the durable Ads architecture
// (runAdsSyncWithDeps, coverage mode) with the three reviewed guards:
//   1. ZERO-TOKEN connection pre-flight (compatible-sources; 3 attempts; a consistent miss excludes the account
//      as typed unavailable -- the 5 Ads-disconnected accounts never poison a batch and never block the rest);
//   2. ZERO-TOKEN durable-coverage pre-filter (missing-complement batching: fully covered accounts need no create);
//   3. a guarded, counting createExport enforcing the per-bucket create ceiling BEFORE every POST.
// One invocation runs ONE bounded pass (the worker self-budgets); `deferred` maps to a typed continuation the
// caller resumes -- never an auto-retry of a failed create.

import { runAdsSyncWithDeps, PRODUCTION_ADS_SYNC_DEPS } from "../ads-sync.js";
import { bucketForCountry } from "./registry.js";
import { assignAccountBatches, MAX_ACCOUNTS_PER_BATCH } from "./source-batching.js";
import { asinAdsBucketPlan, asinAdsRefreshWindow, assessScheduledAsinAdsCycle, ASIN_ADS_GRAIN } from "./source-scheduled-asin-ads.js";
import { getDataDoeConnections, classifyDirectoryAccounts } from "../datadoe-connections.js";
import { fetchAccounts, fetchCompatibleSourceNames } from "../datadoe.js";
import { getDailyAdsCoverage } from "../supabase.js";
import { evaluateSourceCoverage } from "./ppc-ads-loader.js";

export const ASIN_ADS_SOURCE_NAME = "ad performance by asin & date";
const S = (v) => (v == null ? "" : String(v));

/**
 * Discover the bucket's Ads-COMPATIBLE + PENDING accounts (zero tokens). Returns
 * { compatible, incompatible, unreadable, covered, pending, window } -- all arrays of { accountId, country }.
 * Every read failure fails that account CLOSED (excluded from this run, reported), never a fabricated success.
 */
export async function planAsinAdsBucketRun({ bucket, asOf, deps = {} } = {}) {
  const b = S(bucket);
  if (b !== "us" && b !== "non-us") { const e = new Error("ASIN_ADS_BAD_BUCKET"); e.code = "ASIN_ADS_BAD_BUCKET"; throw e; }
  const win = asinAdsRefreshWindow(S(asOf));
  const getConnections = deps.getConnections || getDataDoeConnections;
  const fetchAccts = deps.fetchAccounts || fetchAccounts;
  const fetchSources = deps.fetchCompatibleSourceNames || fetchCompatibleSourceNames;
  const getCoverage = deps.getCoverage || getDailyAdsCoverage;

  const connections = getConnections();
  const primaryConn = connections.find((c) => c && c.id === "primary");
  const rows = (await fetchAccts(primaryConn.apiKey)) || [];
  const { active } = classifyDirectoryAccounts(rows, connections);
  const seen = new Set();
  const bucketAccounts = [];
  for (const a of active) {
    const accountId = S((a && (a.accountId ?? a.id)) || "").trim();
    const country = S((a && a.country) || "").toUpperCase();
    if (!accountId || accountId.includes(":") || seen.has(accountId)) continue;
    if (bucketForCountry(country) !== b) continue;
    seen.add(accountId);
    bucketAccounts.push({ accountId, country });
  }

  const compatible = []; const incompatible = []; const unreadable = [];
  for (const a of bucketAccounts) {
    let outcome = null;
    for (let attempt = 0; attempt < 3 && outcome === null; attempt += 1) {
      try {
        const names = await fetchSources(primaryConn.apiKey, a.accountId);
        outcome = names.has(ASIN_ADS_SOURCE_NAME) ? "compatible" : "incompatible";
      } catch (_e) { if (attempt < 2) await new Promise((r) => setTimeout(r, 2000)); }
    }
    if (outcome === "compatible") compatible.push(a);
    else if (outcome === "incompatible") incompatible.push(a);
    else unreadable.push(a);
  }

  const covered = []; const pending = [];
  for (const a of compatible) {
    let isCovered = false;
    try {
      const cov = await getCoverage(a.accountId, ASIN_ADS_GRAIN);
      isCovered = !!cov && cov.read === "ok" && cov.status === "succeeded" && evaluateSourceCoverage(cov, win.from, win.to).proven === true;
    } catch (_e) { isCovered = false; }
    (isCovered ? covered : pending).push(a);
  }
  return { bucket: b, window: win, bucketAccounts, compatible, incompatible, unreadable, covered, pending, primaryConn };
}

/**
 * Run ONE bounded ASIN Ads pass for the bucket's PENDING accounts. Returns a typed result:
 *   { phase: "complete", creates, tokens, batches, incompatible }  -- every pending pair proven covered;
 *   { phase: "sync", continuationRequired: true, ... }             -- worker deferred (slice budget) -> resume;
 *   { phase: "sync", ok: false, problems }                         -- a typed failure (LKG preserved).
 * `maxCreates` HARD-CAPS this invocation's creates (checked BEFORE every POST). One pass never auto-retries a
 * failed create. `pageAllowance` adds skip-pagination headroom to the plan ceiling.
 */
export async function runAsinAdsBucketSlice({ bucket, asOf, maxCreates = null, pageAllowance = 1, plan = null, deps = {}, log = () => {} } = {}) {
  const p = plan || await planAsinAdsBucketRun({ bucket, asOf, deps });
  if (!p.compatible.length) {
    return { phase: "complete", creates: 0, tokens: 0, batches: 0, covered: 0, incompatible: p.incompatible.length, note: "no Amazon-Ads-compatible accounts" };
  }
  if (!p.pending.length) {
    return { phase: "complete", creates: 0, tokens: 0, batches: 0, covered: p.covered.length, incompatible: p.incompatible.length, note: "already fully covered" };
  }
  const bucketPlan = asinAdsBucketPlan(p.pending, new Map(), { pageAllowance });
  const { batches } = assignAccountBatches(p.pending, new Map(), MAX_ACCOUNTS_PER_BATCH);
  const hardCeiling = maxCreates != null ? Math.min(bucketPlan.maxCreates, Math.max(0, Math.trunc(Number(maxCreates)))) : bucketPlan.maxCreates;
  let creates = 0;
  const baseCreate = (deps.createExport || PRODUCTION_ADS_SYNC_DEPS.createExport);
  const guardedCreate = async (...args) => {
    if (creates >= hardCeiling) { const e = new Error("ASIN_ADS_CREATE_CEILING_EXCEEDED: refusing create " + (creates + 1) + " > ceiling " + hardCeiling); e.code = "ASIN_ADS_CEILING"; throw e; }
    creates += 1;
    return baseCreate(...args);
  };
  const workerDeps = { ...PRODUCTION_ADS_SYNC_DEPS, ...(deps.workerDeps || {}), createExport: guardedCreate };
  const runWorker = deps.runAdsSyncWithDeps || runAdsSyncWithDeps;

  const batchResults = [];
  let deferred = false;
  for (const batch of batches) {
    const batchIds = batch.accounts.map((a) => a.accountId);
    const batchCountries = [...new Set(batch.accounts.map((a) => a.country))].filter(Boolean);
    let summary;
    try {
      summary = await runWorker(workerDeps, batchCountries, [ASIN_ADS_GRAIN], { accountIds: batchIds, requiredCoverage: { from: p.window.from, to: p.window.to } });
    } catch (e) {
      return { phase: "sync", ok: false, problems: ["batch failed: " + (e && e.code === "ASIN_ADS_CEILING" ? e.message : S(e && e.message).slice(0, 120))], creates, tokens: creates * 2 };
    }
    if (summary && summary.status === "skipped") { return { phase: "sync", ok: false, problems: ["ads lock held (concurrent run)"], creates, tokens: creates * 2 }; }
    if (summary && summary.deferred === true) { deferred = true; batchResults.push({ accountIds: batchIds, summary }); break; }
    batchResults.push({ accountIds: batchIds, summary });
    log("ads batch [" + batchCountries.join(",") + "] " + batchIds.length + " accts: " + S(summary && summary.status));
  }
  if (deferred) return { phase: "sync", continuationRequired: true, creates, tokens: creates * 2 };

  const assessment = assessScheduledAsinAdsCycle({ bucket: p.bucket, discoveredAccounts: p.pending, batchResults, creates, pageAllowance });
  if (!assessment.ok) return { phase: "sync", ok: false, problems: assessment.problems.slice(0, 6), creates, tokens: assessment.tokens };
  return { phase: "complete", creates: assessment.creates, tokens: assessment.tokens, batches: assessment.batches, covered: p.covered.length + p.pending.length, incompatible: p.incompatible.length };
}
