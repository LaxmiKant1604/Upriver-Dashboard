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
import { fetchAccountsDetailed, fetchCompatibleSourceNames } from "../datadoe.js";
import { fetchExportEligibleAccounts } from "./account-onboarding.js";
import { getDailyAdsCoverage, getAccountOnboardingRows, getAccountDirectorySnapshotAccounts } from "../supabase.js";
import { evaluateSourceCoverage } from "./ppc-ads-loader.js";
import { getDataDoeTokenBalance } from "../datadoe-usage.js";
import {
  REGIONS, routeAccounts, batchAccounts, planCampaignRun, splitBatchAllowlist,
  CAMPAIGN_WINDOWS, MAX_SELLERS_PER_BATCH,
} from "./campaign-region-routing.js";
import { classifyThrownSourceError, SOURCE_FAILURE } from "./source-failure-classifier.js";

export const CAMPAIGN_ADS_GRAIN = "campaign-performance-v1";     // the durable Ads worker key for Campaign Ads
export const CAMPAIGN_ADS_SOURCE_KEY = "ads-campaign-date";      // the source-registry key
export const CAMPAIGN_ADS_SOURCE_NAME = "ad performance by campaign & date"; // DataDoe compatible-source name (lowercased)
export const CAMPAIGN_ADS_TOKENS_PER_CREATE = 2;                 // STANDARD DataDoe export (registry tokenClass = standard)

const S = (v) => (v == null ? "" : String(v));
const nb = (v) => S(v).trim() !== "";
const VALID_REGIONS = Object.freeze([REGIONS.INDIA, REGIONS.EUROPE_AU, REGIONS.US_CA]);

// The existing Scheduler-v2 runs in TWO buckets (us / non-us); a bucket is the set of the 3 regions whose accounts
// fall in it. This lets the 2-bucket scheduler refresh Campaign Ads per bucket (keeping Daily/Brand fresh at publish)
// while the dedicated regional schedules cover the 3-region cadence -- the coverage pre-filter makes any overlap free.
export const BUCKET_REGIONS = Object.freeze({ "non-us": [REGIONS.INDIA, REGIONS.EUROPE_AU], us: [REGIONS.US_CA] });
export function regionsForBucket(bucket) { return BUCKET_REGIONS[S(bucket)] || []; }

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
  // EXPORT-ELIGIBILITY GATE (default path): only export-eligible primary accounts are routed -- a
  // DataDoe still-loading account never enters a Campaign Ads batch (its export would 400 and poison
  // the whole <=5-seller batch). Tests may inject deps.fetchAccounts to bypass the gate.
  const fetchAccts = deps.fetchAccounts
    || ((apiKey) => fetchExportEligibleAccounts(apiKey, { fetchDetailed: fetchAccountsDetailed, readOnboardingRows: getAccountOnboardingRows, readEstablishedAccountIds: getAccountDirectorySnapshotAccounts }));
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

  // Per-account window kind: an account with NO durable Campaign coverage AT ALL is a NEW account and
  // gets the INITIAL 56-inclusive-day window through the same asOf (its bootstrap history); every
  // account with any prior coverage stays on the run's rolling window (daily 21d from the scheduler).
  // After the initial window completes, its coverage exists, so every later run is rolling -- the
  // "initial 56D then rolling 21D" contract with zero extra state.
  const initialWin = campaignAdsWindow(S(win.to), "initial");
  const covered = []; const pending = []; const initialPending = [];
  for (const a of compatible) {
    let cov = null;
    try { cov = await getCoverage(a.accountId, CAMPAIGN_ADS_GRAIN); } catch (_e) { cov = null; }
    const neverCovered = !!cov && cov.read === "ok" && (!Array.isArray(cov.windows) || cov.windows.length === 0);
    let isCovered = false;
    try {
      isCovered = !!cov && cov.read === "ok" && cov.status === "succeeded" && evaluateSourceCoverage(cov, win.from, win.to).proven === true;
    } catch (_e) { isCovered = false; }
    if (isCovered) covered.push(a);
    else if (neverCovered) initialPending.push(a);
    else pending.push(a);
  }
  return { region, window: win, initialWindow: initialWin, regionAccounts, compatible, incompatible, unreadable, covered, pending, initialPending, primaryConn };
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
export async function runCampaignAdsRegionSlice({ region, asOf, runKind = "initial", windowOverride = null, maxCreates = null, maxFallbackCreates = null, plan = null, deps = {}, log = () => {} } = {}) {
  const p = plan || await planCampaignAdsRegionRun({ region, asOf, runKind, windowOverride, deps });
  const initialPending = Array.isArray(p.initialPending) ? p.initialPending : [];
  const pendingAll = [...p.pending, ...initialPending];
  if (!p.compatible.length) {
    return { phase: "complete", region: p.region, creates: 0, tokens: 0, batches: 0, covered: 0, incompatible: p.incompatible.length, rejected: [], transient: [], ambiguous: [], diagnostics: [], note: "no Amazon-Ads-compatible accounts in region" };
  }
  if (!pendingAll.length) {
    return { phase: "complete", region: p.region, creates: 0, tokens: 0, batches: 0, covered: p.covered.length, incompatible: p.incompatible.length, rejected: [], transient: [], ambiguous: [], diagnostics: [], note: "already fully covered" };
  }
  // Rolling-window accounts batch together; never-covered NEW accounts batch SEPARATELY under the
  // INITIAL 56-inclusive-day window (their bootstrap history). Each batch carries its own window; a
  // create-time-4xx split child inherits its parent's window.
  const batches = [
    ...batchAccounts(p.pending, MAX_SELLERS_PER_BATCH).map((b) => ({ ...b, window: p.window })),
    ...batchAccounts(initialPending, MAX_SELLERS_PER_BATCH).map((b) => ({ ...b, window: p.initialWindow || p.window })),
  ];
  // Normal ceiling = one create per planned batch. FALLBACK ceiling = extra creates a create-time-4xx SPLIT may need,
  // bounded by the pending seller count (worst case: every rejected batch bisects down to single sellers). Both are
  // configurable; the combined hard ceiling is enforced BEFORE every POST (fail closed -> never spends past budget).
  const normalCeiling = maxCreates != null ? Math.max(0, Math.trunc(Number(maxCreates))) : batches.length;
  const fallbackCeiling = maxFallbackCreates != null ? Math.max(0, Math.trunc(Number(maxFallbackCreates))) : pendingAll.length;
  // TWO independent budgets: a normal (depth-0) planned-batch create draws from normalCeiling; a SPLIT child create
  // (depth>0, born from a create-time-4xx) draws from the SEPARATE fallbackCeiling. Both refuse BEFORE the POST (fail
  // closed) so a split can never exhaust the normal budget and no budget can ever be exceeded.
  let normalCreates = 0; let fallbackCreates = 0;
  const isFallbackRef = { value: false };
  const baseCreate = (deps.createExport || PRODUCTION_ADS_SYNC_DEPS.createExport);
  const guardedCreate = async (...args) => {
    if (isFallbackRef.value) {
      if (fallbackCreates >= fallbackCeiling) { const e = new Error("CAMPAIGN_ADS_CREATE_CEILING_EXCEEDED: fallback ceiling " + fallbackCeiling + " reached"); e.code = "CAMPAIGN_ADS_CEILING"; throw e; }
      fallbackCreates += 1;
    } else {
      if (normalCreates >= normalCeiling) { const e = new Error("CAMPAIGN_ADS_CREATE_CEILING_EXCEEDED: normal ceiling " + normalCeiling + " reached"); e.code = "CAMPAIGN_ADS_CEILING"; throw e; }
      normalCreates += 1;
    }
    return baseCreate(...args);
  };
  const workerDeps = { ...PRODUCTION_ADS_SYNC_DEPS, ...(deps.workerDeps || {}), createExport: guardedCreate };
  const runWorker = deps.runAdsSyncWithDeps || runAdsSyncWithDeps;
  const countryOf = new Map(pendingAll.map((a) => [S(a.accountId), S(a.marketplace).toUpperCase()]));
  const runOne = (ids, depth = 0, window = null) => {
    isFallbackRef.value = depth > 0; // split-child creates (depth>0) draw from the fallback budget; sequential, no interleave
    const countries = [...new Set(ids.map((id) => countryOf.get(S(id))).filter(Boolean))];
    const win = window || p.window; // per-batch window (initial 56d for never-covered accounts; rolling otherwise)
    return runWorker(workerDeps, countries, [CAMPAIGN_ADS_GRAIN], { accountIds: ids, requiredCoverage: { from: win.from, to: win.to } });
  };

  const rec = await runCampaignAdsBatchesWithRecovery({ batches, runOne, classifyError: classifyThrownSourceError, log });
  const creates = normalCreates + fallbackCreates;
  const tokens = creates * CAMPAIGN_ADS_TOKENS_PER_CREATE;
  if (rec.lockHeld) return { phase: "sync", ok: false, region: p.region, problems: ["ads lock held (concurrent run)"], creates, tokens };
  if (rec.deferred) return { phase: "sync", region: p.region, continuationRequired: true, creates, tokens };
  if (rec.ceilingExhausted && rec.covered.size === 0) {
    // No account could be refreshed within budget -> a real budget-insufficiency failure (refuse, retain all LKG).
    return { phase: "sync", ok: false, region: p.region, problems: ["create ceiling exhausted before any account covered (hardCeiling=" + hardCeiling + ")"], creates, tokens };
  }
  const covered = [...rec.covered];
  const rejected = [...new Set(rec.rejected.map(S))];
  const transient = [...new Set([...rec.transient, ...(rec.budgetDeferred || [])].map(S))].filter((id) => !rec.covered.has(id));
  const ambiguous = [...new Set(rec.ambiguous.map(S))].filter((id) => !rec.covered.has(id));

  // Assess ONLY the accounts a batch actually SUCCEEDED for (isolated accounts are honestly reported, not coverage
  // failures of the run). A structural problem in a SUCCESSFUL batch (wrong account, oversize, non-campaign source)
  // still fails the run. Every pending account must be accounted for: covered OR isolated (rejected/transient/ambiguous).
  const assessment = assessCampaignAdsRegionCycle({ region: p.region, discoveredAccounts: covered, batchResults: rec.batchResults.filter((b) => !b.summary || b.summary.deferred !== true), creates, allowZeroBatches: covered.length === 0 });
  if (!assessment.ok && covered.length) return { phase: "sync", ok: false, region: p.region, problems: assessment.problems.slice(0, 6), creates, tokens };
  const accountedFor = new Set([...rec.covered, ...rejected, ...transient, ...ambiguous].map(S));
  const unaccounted = pendingAll.map((a) => S(a.accountId)).filter((id) => !accountedFor.has(id));
  if (unaccounted.length) return { phase: "sync", ok: false, region: p.region, problems: ["accounts unaccounted for: " + unaccounted.length], creates, tokens };
  const isolatedCount = rejected.length + transient.length + ambiguous.length;
  if (isolatedCount) {
    log("region " + p.region + " PARTIAL: covered=" + covered.length + " rejected=" + rejected.length + " transient=" + transient.length + " ambiguous=" + ambiguous.length + " (isolated accounts retain last-known-good)");
  }
  return {
    // COMPLETE only when every pending account is COVERED (fresh). Any isolation -> PARTIAL: incomplete coverage is
    // never labelled complete; the isolated accounts retain last-known-good and are reported, not fabricated as zero.
    phase: isolatedCount ? "partial" : "complete", region: p.region, creates, tokens,
    batches: rec.batchResults.length, covered: p.covered.length + covered.length,
    incompatible: p.incompatible.length,
    rejected, transient, ambiguous, diagnostics: rec.diagnostics.slice(0, 20),
  };
}

/**
 * The BOUNDED, IDEMPOTENT Campaign Ads batch recovery engine (pure control-flow; all I/O injected via `runOne`).
 * Processes a queue of <=5-seller batches; on a per-batch failure it CLASSIFIES and recovers WITHOUT aborting the
 * other batches:
 *   - SOURCE_REQUEST_REJECTED (create-time 4xx, >1 seller): deterministically BINARY-SPLIT only the failed batch and
 *     re-enqueue the two ordered halves (bounded by maxSplitDepth); successful siblings are never re-run.
 *   - SOURCE_ACCOUNT_REJECTED (create-time 4xx, single seller) OR a split-exhausted rejection: ISOLATE the seller(s)
 *     -> retain last-known-good, never fabricate zeros, never delete history.
 *   - SOURCE_CREATE_AMBIGUOUS: do NOT recreate here; the seller(s) are reconciled by the next coverage-pre-filtered
 *     pass (the fetch layer already refuses to blind-retry an ambiguous create POST).
 *   - 429/5xx/poll/download/schema/coverage (already retried at the fetch layer where safe): mark this batch's
 *     accounts transient -> retain LKG; the next scheduled pass retries.
 *   - the create-ceiling guard (CAMPAIGN_ADS_CEILING): STOP creating; remaining + this batch's accounts are
 *     budget-deferred (retain LKG); the caller decides if zero coverage is a real budget-insufficiency failure.
 * Returns { covered:Set, rejected, transient, ambiguous, budgetDeferred, diagnostics, batchResults, lockHeld?,
 * deferred?, ceilingExhausted? }.
 */
export async function runCampaignAdsBatchesWithRecovery({ batches, runOne, classifyError = classifyThrownSourceError, maxSplitDepth = 4, log = () => {} } = {}) {
  // Each batch may carry its OWN window (per-account initial-56d vs rolling); splits inherit it.
  const queue = (Array.isArray(batches) ? batches : []).map((b) => ({ ids: [...((b && b.allowlist) || b || [])].map(S).filter(nb), depth: 0, window: (b && b.window) || null }));
  const covered = new Set(); const rejected = []; const transient = []; const ambiguous = []; const budgetDeferred = [];
  const diagnostics = []; const batchResults = [];
  let ceilingExhausted = false;
  while (queue.length) {
    const { ids, depth, window } = queue.shift();
    if (!ids.length) continue;
    if (ceilingExhausted) { for (const id of ids) budgetDeferred.push(id); continue; }
    let summary;
    try {
      summary = await runOne(ids, depth, window);
    } catch (error) {
      if (error && error.code === "CAMPAIGN_ADS_CEILING") {
        ceilingExhausted = true; for (const id of ids) budgetDeferred.push(id);
        log("create ceiling reached; " + ids.length + " account(s) budget-deferred (retain last-known-good)");
        continue;
      }
      const cls = classifyError(error, { stage: "create", singleSeller: ids.length === 1 });
      diagnostics.push({ classification: cls.classification, stage: cls.stage, status: cls.status, batchSize: ids.length, sellers: ids, excerpt: cls.excerpt, terminal: cls.terminal, retryable: cls.retryable, ambiguous: cls.ambiguous });
      if (cls.classification === SOURCE_FAILURE.REQUEST_REJECTED && ids.length > 1 && depth < maxSplitDepth) {
        const halves = splitBatchAllowlist(ids);
        for (const h of halves) queue.push({ ids: h, depth: depth + 1, window });
        log("split rejected batch (" + ids.length + " sellers) -> " + halves.map((h) => h.length).join("+"));
        continue;
      }
      if (cls.classification === SOURCE_FAILURE.REQUEST_REJECTED || cls.classification === SOURCE_FAILURE.ACCOUNT_REJECTED) { for (const id of ids) rejected.push(id); continue; }
      if (cls.classification === SOURCE_FAILURE.CREATE_AMBIGUOUS) { for (const id of ids) ambiguous.push(id); continue; }
      for (const id of ids) transient.push(id); // 429/5xx exhausted, poll/download/schema/coverage -> LKG
      continue;
    }
    if (summary && summary.status === "skipped") return { covered, rejected, transient, ambiguous, budgetDeferred, diagnostics, batchResults, lockHeld: true };
    if (summary && summary.deferred === true) { batchResults.push({ accountIds: ids, summary }); return { covered, rejected, transient, ambiguous, budgetDeferred, diagnostics, batchResults, deferred: true }; }
    batchResults.push({ accountIds: ids, summary });
    const camp = (summary && summary.sources && summary.sources[CAMPAIGN_ADS_GRAIN]) || {};
    const failedSet = new Set([...(camp.failedAccounts || []), ...(camp.coverageFailedAccounts || [])].map(S));
    for (const id of ids) { if (failedSet.has(S(id))) transient.push(id); else covered.add(S(id)); }
  }
  return { covered, rejected, transient, ambiguous, budgetDeferred, diagnostics, batchResults, ceilingExhausted };
}

/**
 * STRICT assessment of one region's Campaign Ads refresh (pure). Proves: at least one batch ran; every pending
 * account is covered by exactly one <=5-seller batch inside the discovered set (no leakage); every batch summary is
 * "completed" + coverageComplete + successfulCoveragePairs==expected + not deferred + ONLY the campaign grain +
 * zero failed / coverage-failed accounts; and creates/tokens stay within the batch-count ceiling.
 */
export function assessCampaignAdsRegionCycle({ region, discoveredAccounts, batchResults, creates, allowZeroBatches = false } = {}) {
  const problems = [];
  const push = (x) => problems.push(x);
  if (!VALID_REGIONS.includes(region)) return { ok: false, problems: ["bad-region"], creates: 0, tokens: 0, batches: 0 };
  // `discoveredAccounts` here is the set of accounts a batch SUCCESSFULLY covered (isolated accounts are reported by
  // the caller, not judged as coverage failures of the run). When every account was isolated, covered is empty and
  // allowZeroBatches lets the assessment pass (nothing was created for those; they retain LKG).
  const discovered = [...new Set((discoveredAccounts || []).map((a) => S(a && (a.accountId ?? a)).trim()).filter(Boolean))].sort();
  if (!discovered.length) return { ok: allowZeroBatches, problems: allowZeroBatches ? [] : ["no-covered-accounts"], creates: Number(creates) || 0, tokens: (Number(creates) || 0) * CAMPAIGN_ADS_TOKENS_PER_CREATE, batches: 0 };
  const discoveredSet = new Set(discovered);

  const results = Array.isArray(batchResults) ? batchResults : [];
  if (!results.length && !allowZeroBatches) push("no-batches");
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
  // The create budget is enforced BEFORE every POST by the runner's guardedCreate (a split legitimately adds child
  // creates within the combined normal+fallback ceiling), so the assessment no longer re-derives a batch-count ceiling.
  return { ok: problems.length === 0, problems, creates: createsN, tokens, batches: results.length };
}

/**
 * Run ONE bounded Campaign Ads pass for a whole Scheduler-v2 BUCKET (the regions in that bucket), aggregating the
 * per-region results. Used by the Data Sync Center manual "Sync source" action + the scheduled bucket operator so the
 * scheduled + manual paths share one implementation. Returns a DSC-compatible typed result
 * ({ phase:"complete", creates, tokens, covered } | { phase:"sync", continuationRequired } | { phase:"sync", ok:false, problems }).
 */
export async function runCampaignAdsBucketSlice({ bucket, asOf, runKind = "daily", maxCreates = null, maxFallbackCreates = null, deps = {}, log = () => {} } = {}) {
  const regions = regionsForBucket(bucket);
  if (!regions.length) return { phase: "sync", ok: false, problems: ["bad-bucket:" + S(bucket)], creates: 0, tokens: 0 };
  let creates = 0; let tokens = 0; let covered = 0; let incompatible = 0;
  const rejected = []; const transient = []; const ambiguous = [];
  for (const region of regions) {
    const plan = await planCampaignAdsRegionRun({ region, asOf, runKind, deps });
    const r = await runCampaignAdsRegionSlice({ region, asOf, runKind, plan, maxCreates, maxFallbackCreates, deps, log });
    creates += r.creates || 0; tokens += r.tokens || 0;
    if (r.phase !== "complete" && r.phase !== "partial") {
      if (r.continuationRequired === true) return { phase: "sync", continuationRequired: true, creates, tokens };
      return { phase: "sync", ok: false, problems: r.problems || [], creates, tokens };
    }
    covered += r.covered || 0; incompatible += r.incompatible || 0;
    rejected.push(...(r.rejected || [])); transient.push(...(r.transient || [])); ambiguous.push(...(r.ambiguous || []));
  }
  // A partial region (some sellers isolated with LKG) is a successful bounded pass -- the isolation is surfaced, never
  // suppressed. The bucket reports PARTIAL when any region isolated an account; only a systemic failure is ok:false.
  const anyIsolated = rejected.length || transient.length || ambiguous.length;
  return { phase: anyIsolated ? "partial" : "complete", creates, tokens, covered, incompatible, rejected, transient, ambiguous };
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
