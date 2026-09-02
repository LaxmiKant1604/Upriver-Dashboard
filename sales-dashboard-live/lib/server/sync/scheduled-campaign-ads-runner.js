// The SHARED, REGION-AWARE Campaign Ads (campaign-performance-v1) refresh core used by the go-live operator
// (scripts/release/campaign-ads-golive.mjs) and the future regional scheduler. It mirrors the proven ASIN Ads
// runner (scheduled-asin-ads-runner.js) but routes accounts into the THREE regions (India / Europe+AU / US+CA)
// instead of us/non-us buckets. It wraps the SAME durable Ads architecture (runAdsSyncWithDeps, coverage mode)
// with the same three reviewed guards:
//   1. ZERO-TOKEN Amazon-Ads connection pre-flight (compatible-sources; 3 attempts; a consistent miss excludes the
//      account as typed unavailable so it never poisons a batch and never blocks the rest);
//   2. ZERO-TOKEN durable-coverage pre-filter (accounts already covering the window need ZERO creates -> replay
//      adopts completed work and spends zero duplicate tokens);
//   3. a guarded, counting createExport enforcing a hard create ceiling BEFORE every POST.
// Campaign Ads is a STANDARD DataDoe source (2 tokens/create). This runner NEVER runs the ASIN grain, and
// per-batch ownership isolation + currency isolation are enforced inside ads-sync.js (validateExportBatchRows +
// per-account/per-currency durable rows). One invocation runs one bounded pass; a deferred worker maps to a typed
// continuation the caller resumes -- never an auto-retry of a failed create.

import { runAdsSyncWithDeps, PRODUCTION_ADS_SYNC_DEPS } from "../ads-sync.js";
import { getDataDoeConnections, classifyDirectoryAccounts } from "../datadoe-connections.js";
import { fetchAccounts, fetchCompatibleSourceNames } from "../datadoe.js";
import { getDailyAdsCoverage } from "../supabase.js";
import { evaluateSourceCoverage } from "./ppc-ads-loader.js";
import { getDataDoeTokenBalance } from "../datadoe-usage.js";
import {
  REGIONS, routeAccounts, batchAccounts, planCampaignRun,
  CAMPAIGN_WINDOWS, MAX_SELLERS_PER_BATCH,
} from "./campaign-region-routing.js";

export const CAMPAIGN_ADS_GRAIN = "campaign-performance-v1";     // the durable Ads worker key for Campaign Ads
export const CAMPAIGN_ADS_SOURCE_KEY = "ads-campaign-date";      // the source-registry key
export const CAMPAIGN_ADS_SOURCE_NAME = "ad performance by campaign & date"; // DataDoe compatible-source name (lowercased)
export const CAMPAIGN_ADS_TOKENS_PER_CREATE = 2;                 // STANDARD DataDoe export (registry tokenClass = standard)

const S = (v) => (v == null ? "" : String(v));
const nb = (v) => S(v).trim() !== "";
const VALID_REGIONS = Object.freeze([REGIONS.INDIA, REGIONS.EUROPE_AU, REGIONS.US_CA]);

/**
 * The Campaign Ads window ending at `asOf` (strict YYYY-MM-DD): initial 56 / daily 21 / monthly-correction 49
 * inclusive days, matching the source spec + ads-sync.js ADS_SOURCES. Coverage mode fetches only the dates the
 * durable coverage does not already prove, so already-covered history is never refetched.
 */
export function campaignAdsWindow(asOf, runKind = "initial") {
  const to = S(asOf);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(to)) { const e = new Error("CAMPAIGN_ADS_BAD_ASOF"); e.code = "CAMPAIGN_ADS_BAD_ASOF"; throw e; }
  const days = runKind === "daily" ? CAMPAIGN_WINDOWS.dailyDays : runKind === "monthly" ? CAMPAIGN_WINDOWS.monthlyCorrectionDays : CAMPAIGN_WINDOWS.initialDays;
  const d = new Date(`${to}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - (days - 1));
  return { from: d.toISOString().slice(0, 10), to, days };
}

/**
 * Discover ALL active primary accounts (ZERO tokens) with their marketplace and route them into the three regions.
 * Newly connected accounts auto-join their region because discovery + routing are recomputed from the live seller
 * list every run (never a static list). Returns { primaryConn, accounts, byRegion, unassigned }. An account with an
 * unknown/blank marketplace lands in `unassigned` (the caller must alert + skip it, never export it).
 */
export async function discoverRoutedAccounts({ deps = {} } = {}) {
  const getConnections = deps.getConnections || getDataDoeConnections;
  const fetchAccts = deps.fetchAccounts || fetchAccounts;
  const connections = getConnections();
  const primaryConn = connections.find((c) => c && c.id === "primary");
  if (!primaryConn || !primaryConn.apiKey) { const e = new Error("CAMPAIGN_ADS_NO_PRIMARY_CONNECTION: no primary DataDoe connection / api key (fail closed)."); e.code = "CAMPAIGN_ADS_NO_PRIMARY"; throw e; }
  const rows = (await fetchAccts(primaryConn.apiKey)) || [];
  const { active } = classifyDirectoryAccounts(rows, connections);
  const seen = new Set();
  const accounts = [];
  for (const a of active) {
    const accountId = S((a && (a.accountId ?? a.id)) || "").trim();
    const marketplace = S((a && a.country) || "").toUpperCase();
    if (!accountId || accountId.includes(":") || seen.has(accountId)) continue;
    seen.add(accountId);
    accounts.push({ accountId, marketplace });
  }
  const { byRegion, unassigned } = routeAccounts(accounts);
  return { primaryConn, accounts, byRegion, unassigned };
}

/**
 * Plan ONE region's Campaign Ads run (ZERO tokens): connection pre-flight + durable-coverage pre-filter over the
 * region's accounts. Returns { region, window, regionAccounts, compatible, incompatible, unreadable, covered,
 * pending, primaryConn }. Every read failure fails that account CLOSED (excluded + reported), never fabricated.
 */
export async function planCampaignAdsRegionRun({ region, asOf, runKind = "initial", windowOverride = null, routed = null, deps = {} } = {}) {
  if (!VALID_REGIONS.includes(region)) { const e = new Error("CAMPAIGN_ADS_BAD_REGION: " + S(region)); e.code = "CAMPAIGN_ADS_BAD_REGION"; throw e; }
  const ov = windowOverride && /^\d{4}-\d{2}-\d{2}$/.test(S(windowOverride.from)) && /^\d{4}-\d{2}-\d{2}$/.test(S(windowOverride.to)) ? { from: S(windowOverride.from), to: S(windowOverride.to), days: null } : null;
  if (ov && ov.from > ov.to) { const e = new Error("CAMPAIGN_ADS_BAD_WINDOW: from > to"); e.code = "CAMPAIGN_ADS_BAD_WINDOW"; throw e; }
  const win = ov || campaignAdsWindow(asOf, runKind);
  const r = routed || await discoverRoutedAccounts({ deps });
  const regionAccounts = r.byRegion[region] || [];
  const fetchSources = deps.fetchCompatibleSourceNames || fetchCompatibleSourceNames;
  const getCoverage = deps.getCoverage || getDailyAdsCoverage;
  const primaryConn = r.primaryConn;

  const compatible = []; const incompatible = []; const unreadable = [];
  for (const a of regionAccounts) {
    let outcome = null;
    for (let attempt = 0; attempt < 3 && outcome === null; attempt += 1) {
      try {
        const names = await fetchSources(primaryConn.apiKey, a.accountId);
        outcome = names && names.has(CAMPAIGN_ADS_SOURCE_NAME) ? "compatible" : "incompatible";
      } catch (_e) { if (attempt < 2) await new Promise((res) => setTimeout(res, 2000)); }
    }
    if (outcome === "compatible") compatible.push(a);
    else if (outcome === "incompatible") incompatible.push(a);
    else unreadable.push(a);
  }

  const covered = []; const pending = [];
  for (const a of compatible) {
    let isCovered = false;
    try {
      const cov = await getCoverage(a.accountId, CAMPAIGN_ADS_GRAIN);
      isCovered = !!cov && cov.read === "ok" && cov.status === "succeeded" && evaluateSourceCoverage(cov, win.from, win.to).proven === true;
    } catch (_e) { isCovered = false; }
    (isCovered ? covered : pending).push(a);
  }
  return { region, window: win, regionAccounts, compatible, incompatible, unreadable, covered, pending, primaryConn };
}

/**
 * Run ONE bounded Campaign Ads pass for a region's PENDING accounts. Deterministic <=5-seller batches (mixed
 * marketplaces allowed, as explicitly approved); per-batch ownership + currency isolation enforced inside
 * ads-sync.js. `maxCreates` HARD-CAPS this invocation's creates (checked BEFORE every POST). Returns a typed
 * result:
 *   { phase: "complete", creates, tokens, batches, covered, incompatible } -- every pending account proven covered;
 *   { phase: "sync", continuationRequired: true, ... }                     -- worker deferred (slice budget) -> resume;
 *   { phase: "sync", ok: false, problems, creates, tokens }               -- a typed failure (LKG preserved).
 */
export async function runCampaignAdsRegionSlice({ region, asOf, runKind = "initial", windowOverride = null, maxCreates = null, plan = null, deps = {}, log = () => {} } = {}) {
  const p = plan || await planCampaignAdsRegionRun({ region, asOf, runKind, windowOverride, deps });
  if (!p.compatible.length) {
    return { phase: "complete", region: p.region, creates: 0, tokens: 0, batches: 0, covered: 0, incompatible: p.incompatible.length, note: "no Amazon-Ads-compatible accounts in region" };
  }
  if (!p.pending.length) {
    return { phase: "complete", region: p.region, creates: 0, tokens: 0, batches: 0, covered: p.covered.length, incompatible: p.incompatible.length, note: "already fully covered" };
  }
  const batches = batchAccounts(p.pending, MAX_SELLERS_PER_BATCH);
  const hardCeiling = maxCreates != null ? Math.min(batches.length, Math.max(0, Math.trunc(Number(maxCreates)))) : batches.length;
  let creates = 0;
  const baseCreate = (deps.createExport || PRODUCTION_ADS_SYNC_DEPS.createExport);
  const guardedCreate = async (...args) => {
    if (creates >= hardCeiling) { const e = new Error("CAMPAIGN_ADS_CREATE_CEILING_EXCEEDED: refusing create " + (creates + 1) + " > ceiling " + hardCeiling); e.code = "CAMPAIGN_ADS_CEILING"; throw e; }
    creates += 1;
    return baseCreate(...args);
  };
  const workerDeps = { ...PRODUCTION_ADS_SYNC_DEPS, ...(deps.workerDeps || {}), createExport: guardedCreate };
  const runWorker = deps.runAdsSyncWithDeps || runAdsSyncWithDeps;

  const batchResults = [];
  let deferred = false;
  for (const batch of batches) {
    const batchIds = batch.allowlist;
    const batchCountries = [...new Set(batch.accounts.map((a) => S(a.marketplace).toUpperCase()))].filter(Boolean);
    let summary;
    try {
      summary = await runWorker(workerDeps, batchCountries, [CAMPAIGN_ADS_GRAIN], { accountIds: batchIds, requiredCoverage: { from: p.window.from, to: p.window.to } });
    } catch (e) {
      return { phase: "sync", ok: false, region: p.region, problems: ["batch failed: " + (e && e.code === "CAMPAIGN_ADS_CEILING" ? e.message : S(e && e.message).slice(0, 120))], creates, tokens: creates * CAMPAIGN_ADS_TOKENS_PER_CREATE };
    }
    if (summary && summary.status === "skipped") { return { phase: "sync", ok: false, region: p.region, problems: ["ads lock held (concurrent run)"], creates, tokens: creates * CAMPAIGN_ADS_TOKENS_PER_CREATE }; }
    if (summary && summary.deferred === true) { deferred = true; batchResults.push({ accountIds: batchIds, summary }); break; }
    batchResults.push({ accountIds: batchIds, summary });
    log("campaign batch [" + batchCountries.join(",") + "] " + batchIds.length + " accts: " + S(summary && summary.status));
  }
  if (deferred) return { phase: "sync", region: p.region, continuationRequired: true, creates, tokens: creates * CAMPAIGN_ADS_TOKENS_PER_CREATE };

  const assessment = assessCampaignAdsRegionCycle({ region: p.region, discoveredAccounts: p.pending, batchResults, creates });
  if (!assessment.ok) return { phase: "sync", ok: false, region: p.region, problems: assessment.problems.slice(0, 6), creates, tokens: assessment.tokens };
  return { phase: "complete", region: p.region, creates: assessment.creates, tokens: assessment.tokens, batches: assessment.batches, covered: p.covered.length + p.pending.length, incompatible: p.incompatible.length };
}

/**
 * STRICT assessment of one region's Campaign Ads refresh (pure). Proves: at least one batch ran; every pending
 * account is covered by exactly one <=5-seller batch inside the discovered set (no leakage); every batch summary is
 * "completed" + coverageComplete + successfulCoveragePairs==expected + not deferred + ONLY the campaign grain +
 * zero failed / coverage-failed accounts; and creates/tokens stay within the batch-count ceiling.
 */
export function assessCampaignAdsRegionCycle({ region, discoveredAccounts, batchResults, creates } = {}) {
  const problems = [];
  const push = (x) => problems.push(x);
  if (!VALID_REGIONS.includes(region)) return { ok: false, problems: ["bad-region"], creates: 0, tokens: 0, batches: 0 };
  const discovered = [...new Set((discoveredAccounts || []).map((a) => S(a && (a.accountId ?? a)).trim()).filter(Boolean))].sort();
  if (!discovered.length) return { ok: false, problems: ["no-discovered-accounts"], creates: 0, tokens: 0, batches: 0 };
  const discoveredSet = new Set(discovered);
  const ceilingCreates = batchAccounts(discovered.map((accountId) => ({ accountId })), MAX_SELLERS_PER_BATCH).length;

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
    for (const key of Object.keys(sources)) if (key !== CAMPAIGN_ADS_GRAIN) push("non-campaign-source:" + key);
    const camp = sources[CAMPAIGN_ADS_GRAIN] || {};
    if ((camp.failedAccounts || []).length) push("failed-accounts:" + camp.failedAccounts.length);
    if ((camp.coverageFailedAccounts || []).length) push("coverage-failed-accounts:" + camp.coverageFailedAccounts.length);
    if (batchIds.length > MAX_SELLERS_PER_BATCH) push("batch-oversized:" + batchIds.length);
    if (!batchIds.length) push("batch-empty");
    for (const id of batchIds) { if (!discoveredSet.has(id)) push("batch-account-unexpected"); coveredUnion.add(id); }
  }
  for (const a of discovered) if (!coveredUnion.has(a)) push("account-coverage-missing");

  const createsN = Number(creates) || 0;
  const tokens = createsN * CAMPAIGN_ADS_TOKENS_PER_CREATE;
  if (createsN > ceilingCreates) push("creates-over-ceiling:" + createsN + ">" + ceilingCreates);
  return { ok: problems.length === 0, problems, creates: createsN, tokens, batches: results.length, ceilingCreates, ceilingTokens: ceilingCreates * CAMPAIGN_ADS_TOKENS_PER_CREATE };
}

/**
 * The MANDATORY zero-create dry-run gate. Discovers + routes accounts, computes the WORST-CASE plan (every routed
 * account batched -> the maximum exports + token spend), reads the live usable balance (ZERO tokens), and decides
 * whether a create is authorized: price known AND worst-case spend <= maxTokens AND balance >= worst-case spend.
 * Never creates anything. Returns the full plan for the operator to print + gate on.
 */
export async function planCampaignAdsDryRun({ asOf, runKind = "initial", tokenPrice = CAMPAIGN_ADS_TOKENS_PER_CREATE, maxTokens = 40, deps = {} } = {}) {
  const routed = await discoverRoutedAccounts({ deps });
  const plan = planCampaignRun({ accounts: routed.accounts, runKind, tokenPrice });
  let balance = null; let balanceRead = "error";
  try {
    const bal = await (deps.getDataDoeTokenBalance || getDataDoeTokenBalance)({ apiKey: routed.primaryConn.apiKey });
    if (bal && bal.read === "ok" && Number.isFinite(bal.usable)) { balance = bal.usable; balanceRead = "ok"; } else { balanceRead = (bal && bal.read) || "error"; }
  } catch (_e) { balanceRead = "error"; }
  const window = campaignAdsWindow(asOf, runKind);
  const withinCeiling = plan.maxTokenSpend != null && plan.maxTokenSpend <= maxTokens;
  const balanceProven = balanceRead === "ok" && Number.isFinite(balance);
  const balanceSufficient = balanceProven && plan.maxTokenSpend != null && balance >= plan.maxTokenSpend;
  // A create is authorized ONLY when the price is known, the worst-case spend is within the authorized ceiling, AND
  // the balance is PROVEN sufficient. An unprovable balance or price refuses (fail closed) -- never assume tokens.
  const createAuthorized = !!(plan.createReady && withinCeiling && balanceSufficient);
  return {
    asOf, runKind, window, maxTokens, tokenPrice: plan.tokenPrice,
    accountCount: routed.accounts.length, plan, unassigned: plan.unassigned,
    balance, balanceRead, withinCeiling, balanceProven, balanceSufficient, createAuthorized,
  };
}
