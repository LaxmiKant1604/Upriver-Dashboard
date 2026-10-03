// The SHARED, REGION-AWARE ASIN Ads (asin-performance-v1 / "Ad Performance by ASIN & Date") refresh core used by the
// scheduler-v2 asin_ads job (scripts/release/scheduled-asin-ads-refresh.mjs) and the admin Data Sync Center card -- one
// implementation, so the scheduled and manual paths cannot drift. ASIN Ads is an ADDITIONAL durable source: it never
// changes the active read grain (Campaign) or any report calculation; its saved ASIN-by-date rows are for future
// consumers. Guards, in order:
//   1. ONE population with Campaign: the export-eligible PRIMARY accounts (fetchExportEligibleAccounts), routed into the
//      three regions from the live directory every run (a newly onboarded account joins automatically) -- the same
//      discoverRoutedAccounts the Campaign runner uses. A secondary organization is never mixed in.
//   2. ZERO-TOKEN compatible-source pre-flight ("ad performance by asin & date"; 3 attempts): a seller without the Ads
//      connection is typed incompatible and never poisons a batch.
//   3. ZERO-TOKEN per-account window from REAL durable coverage (never from latest_metric_date): the rolling 21-day
//      window ending at D-1, widened to a one-time catch-up from the earliest UNCOVERED date inside the 60-day initial
//      horizon -- never further back (no unrequested historical backfill). A fully covered account creates nothing.
//   4. <=5-seller batches per (region, window); a batch whose saved history predicts more rows than a safe target is
//      split into contiguous date chunks before any create, and ads-sync.js bisects any export still at the 50,000-row
//      limit (never persisted) -- see fetchWindowBySplit.
//   5. ZERO-TOKEN completed-export REUSE: before every create, an EXACT-identity COMPLETED export (same source, sellers,
//      columns, grouping, aggregations, window, limit, skip, ordering) created in the last few hours is adopted instead.
//   6. ONE hard total create cap checked BEFORE every POST (normal, chunk, bisection, seller-split alike).
//   7. Per-account isolation through the shared recovery engine (a create-time 4xx splits the batch; a single seller is
//      isolated; ambiguous / transient keep last-known-good; the cap budget-defers the rest with ZERO state writes).
// Persistence (idempotent upsert-then-prune, per-batch ownership + marketplace + currency checks, coverage recorded only
// after a positive acknowledgement) lives in ads-sync.js coverage mode.

import { runAdsSyncWithDeps, PRODUCTION_ADS_SYNC_DEPS, buildAdsExportRequestBody, ADS_SOURCES, EXPORT_LIMIT, inclusiveDaySpan } from "../ads-sync.js";
import { ASIN_ADS_RUNNER_AUTHORIZATION } from "../active-ads-source.js";
import { fetchCompatibleSourceNames } from "../datadoe.js";
import { getDailyAdsCoverage, getAdsDailySourceRowCount, upsertSourceRunStatus } from "../supabase.js";
import { evaluateSourceCoverage } from "./ppc-ads-loader.js";
import { discoverRoutedAccounts, runCampaignAdsBatchesWithRecovery, regionsForBucket } from "./scheduled-campaign-ads-runner.js";
import { REGIONS, batchAccounts, MAX_SELLERS_PER_BATCH } from "./campaign-region-routing.js";

export const ASIN_ADS_GRAIN = "asin-performance-v1";              // the durable Ads worker key
export const ASIN_ADS_SOURCE_KEY = "ads-asin-date";               // the source-registry key
export const ASIN_ADS_SOURCE_NAME = "ad performance by asin & date"; // DataDoe compatible-source name (lowercased)
export const ASIN_ADS_TOKENS_PER_CREATE = 2;                      // STANDARD DataDoe source (data-scheme isPremium=false)
const ASIN_SOURCE = ADS_SOURCES.find((s) => s.key === ASIN_ADS_GRAIN);
// The window contract, DERIVED from the one ASIN source declaration (initial 60 / daily 21 inclusive days).
export const ASIN_ADS_WINDOWS = Object.freeze({ initialDays: ASIN_SOURCE.initialDays, dailyDays: ASIN_SOURCE.dailyDays });
// A planned export whose predicted rows exceed this is split into date chunks BEFORE any create (60% of the limit, so
// an under-estimate still has head-room before the full-page bisection is needed).
export const ASIN_ADS_PLAN_TARGET_ROWS = Math.floor(EXPORT_LIMIT * 0.6);
export const ASIN_ADS_RATE_LOOKBACK_DAYS = 28;
// Completed-export reuse horizon: adopt only an export created within this age that stays downloadable for a while.
export const ASIN_ADS_REUSE_MAX_AGE_MS = 6 * 3600 * 1000;
export const ASIN_ADS_REUSE_MIN_REMAINING_MS = 15 * 60 * 1000;
const REUSE_LIST_MAX_PAGES = 4;

const S = (v) => (v == null ? "" : String(v));
const isDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(S(v));
const VALID_REGIONS = Object.freeze([REGIONS.INDIA, REGIONS.EUROPE_AU, REGIONS.US_CA]);
const addDays = (day, n) => { const d = new Date(`${day}T00:00:00.000Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const typed = (code, message, extra = {}) => Object.assign(new Error(code + ": " + message), { code, ...extra });

/** The two windows ending at `asOf` (D-1): the 60-day initial HORIZON and the 21-day ROLLING window. Pure. */
export function asinAdsWindows(asOf) {
  if (!isDay(asOf)) throw typed("ASIN_ADS_BAD_ASOF", "as-of must be YYYY-MM-DD");
  return {
    horizon: { from: addDays(asOf, -(ASIN_ADS_WINDOWS.initialDays - 1)), to: asOf, days: ASIN_ADS_WINDOWS.initialDays },
    rolling: { from: addDays(asOf, -(ASIN_ADS_WINDOWS.dailyDays - 1)), to: asOf, days: ASIN_ADS_WINDOWS.dailyDays },
  };
}

// The EARLIEST date in [from..to] not inside any of `windows` (null when [from..to] is fully covered). Pure.
export function earliestUncoveredDate(windows, from, to) {
  const ws = (Array.isArray(windows) ? windows : []).filter((w) => w && isDay(w.from) && isDay(w.to) && w.from <= w.to)
    .map((w) => ({ from: w.from, to: w.to })).sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  let cursor = from;
  for (const w of ws) {
    if (w.to < cursor) continue;
    if (w.from > cursor) return cursor;
    cursor = addDays(w.to, 1);
    if (cursor > to) return null;
  }
  return cursor <= to ? cursor : null;
}

/**
 * PURE: the ONE window an account needs at `asOf`, decided from its REAL durable coverage evidence (getDailyAdsCoverage
 * shape). Never from latest_metric_date; a missing day is never treated as covered or as zero.
 *   unreadable : the coverage read was not ok -> excluded this run (fail closed, reported);
 *   covered    : last run succeeded AND the coverage proves the whole rolling window -> ZERO creates;
 *   rolling    : the rolling 21-day window (the daily contract: re-read for attribution corrections);
 *   catch-up   : a one-time window from the earliest uncovered date inside the 60-day horizon (prior coverage exists);
 *   initial    : no coverage inside the horizon -> the full 60-day initial window.
 * The window always ends at asOf and never starts before the horizon.
 */
export function asinAdsAccountWindow({ asOf, coverage }) {
  const { horizon, rolling } = asinAdsWindows(asOf);
  if (!coverage || coverage.read !== "ok" || !Array.isArray(coverage.windows)) return { kind: "unreadable", reason: (coverage && coverage.error) || "coverage-read-not-ok" };
  let rollingProven = false;
  try { rollingProven = coverage.status === "succeeded" && evaluateSourceCoverage(coverage, rolling.from, rolling.to).proven === true; } catch { rollingProven = false; }
  if (rollingProven) return { kind: "covered", from: rolling.from, to: rolling.to };
  let malformed = false;
  try { malformed = evaluateSourceCoverage(coverage, horizon.from, horizon.from).reason === "coverage-window-malformed"; } catch { malformed = true; }
  if (malformed) return { kind: "unreadable", reason: "coverage-window-malformed" };
  const gap = earliestUncoveredDate(coverage.windows, horizon.from, asOf);
  const anyInHorizon = coverage.windows.some((w) => w && isDay(w.from) && isDay(w.to) && w.to >= horizon.from && w.from <= asOf);
  if (gap != null && gap < rolling.from) return { kind: anyInHorizon ? "catch-up" : "initial", from: gap, to: asOf };
  return { kind: "rolling", from: rolling.from, to: rolling.to };
}

// PURE: the account's saved-history rate window -- the last <= ASIN_ADS_RATE_LOOKBACK_DAYS days of its latest
// CONTIGUOUS covered span at or before asOf (null when it has no coverage).
export function asinAdsRateWindow(windows, asOf) {
  const ws = (Array.isArray(windows) ? windows : []).filter((w) => w && isDay(w.from) && isDay(w.to) && w.from <= w.to && w.from <= asOf)
    .map((w) => ({ from: w.from, to: w.to < asOf ? w.to : asOf })).sort((a, b) => (a.from < b.from ? -1 : 1));
  if (!ws.length) return null;
  // merge into contiguous spans, keep the latest
  const spans = [];
  for (const w of ws) { const last = spans[spans.length - 1]; if (last && w.from <= addDays(last.to, 1)) { if (w.to > last.to) last.to = w.to; } else spans.push({ ...w }); }
  const span = spans[spans.length - 1];
  const from = addDays(span.to, -(ASIN_ADS_RATE_LOOKBACK_DAYS - 1)) > span.from ? addDays(span.to, -(ASIN_ADS_RATE_LOOKBACK_DAYS - 1)) : span.from;
  return { from, to: span.to, days: inclusiveDaySpan(from, span.to) };
}

// PURE: split an inclusive window into `n` contiguous chunks whose day counts differ by at most one (earlier chunks
// take the extra day). n <= 1 or a 1-day window -> the window itself.
export function chunkWindow(window, n) {
  const days = inclusiveDaySpan(window.from, window.to);
  const k = Math.max(1, Math.min(days, Math.trunc(Number(n) || 1)));
  const out = []; let cursor = window.from;
  for (let i = 0; i < k; i += 1) {
    const len = Math.floor(days / k) + (i < days % k ? 1 : 0);
    const to = addDays(cursor, len - 1);
    out.push({ from: cursor, to });
    cursor = addDays(to, 1);
  }
  return out;
}

/**
 * PURE: the create plan for one region's pending accounts. Accounts sharing the SAME window are batched together
 * (deterministic <=5-seller chunks by account id, as Campaign); a batch whose predicted rows (each account's saved
 * rows/day x window days; unknown rate = 0, covered by the full-page bisection) exceed ASIN_ADS_PLAN_TARGET_ROWS is
 * split into contiguous date chunks. Every item is ONE planned create: { allowlist, window, expectedRows, chunk }.
 */
export function planAsinAdsItems(pending, { targetRows = ASIN_ADS_PLAN_TARGET_ROWS } = {}) {
  const groups = new Map();
  for (const a of Array.isArray(pending) ? pending : []) {
    const key = a.window.from + ".." + a.window.to;
    if (!groups.has(key)) groups.set(key, { window: { from: a.window.from, to: a.window.to }, accounts: [] });
    groups.get(key).accounts.push(a);
  }
  const items = [];
  for (const key of [...groups.keys()].sort()) {
    const g = groups.get(key);
    for (const b of batchAccounts(g.accounts, MAX_SELLERS_PER_BATCH)) {
      const days = inclusiveDaySpan(g.window.from, g.window.to);
      const perDay = b.accounts.reduce((t, a) => t + (Number.isFinite(a.ratePerDay) && a.ratePerDay > 0 ? a.ratePerDay : 0), 0);
      const expectedRows = Math.round(perDay * days);
      const n = Math.max(1, Math.ceil(expectedRows / Math.max(1, targetRows)));
      const chunks = chunkWindow(g.window, n);
      chunks.forEach((w, i) => items.push({
        allowlist: b.allowlist, window: w, chunk: { index: i + 1, of: chunks.length },
        expectedRows: Math.round(perDay * inclusiveDaySpan(w.from, w.to)),
      }));
    }
  }
  return items;
}

/**
 * Plan ONE region's ASIN Ads run (ZERO tokens; ZERO writes): export-eligible discovery + routing (shared with Campaign),
 * the compatible-source pre-flight, the coverage-derived per-account window, a saved-history size estimate, and the
 * create items. `accountAllowlist` (operator canary) restricts the region to exact account ids, each of which MUST be a
 * discovered account of this region (else refused). `trustSucceededAsCompatible` (the time-bounded Data Sync Center
 * path only) skips the DataDoe compatibility probe for an account whose LAST ASIN export SUCCEEDED (it was just proven
 * compatible by a real export); every other account is probed. Returns the full typed plan; every read failure fails
 * that account closed (excluded + reported), never fabricated.
 */
export async function planAsinAdsRegionRun({ region, asOf, routed = null, accountAllowlist = null, trustSucceededAsCompatible = false, deps = {} } = {}) {
  if (!VALID_REGIONS.includes(region)) throw typed("ASIN_ADS_BAD_REGION", S(region));
  const windows = asinAdsWindows(asOf);
  const r = routed || await discoverRoutedAccounts({ deps });
  let regionAccounts = (r.byRegion && r.byRegion[region]) || [];
  if (Array.isArray(accountAllowlist)) {
    const want = [...new Set(accountAllowlist.map((x) => S(x).trim()).filter(Boolean))];
    const have = new Set(regionAccounts.map((a) => S(a.accountId)));
    const foreign = want.filter((id) => !have.has(id));
    if (!want.length || foreign.length) throw typed("ASIN_ADS_ALLOWLIST_NOT_IN_REGION", (foreign.length || "empty") + " allowlisted account(s) are not export-eligible accounts of " + region);
    regionAccounts = regionAccounts.filter((a) => want.includes(S(a.accountId)));
  }
  const fetchSources = deps.fetchCompatibleSourceNames || fetchCompatibleSourceNames;
  const getCoverage = deps.getCoverage || getDailyAdsCoverage;
  const countRows = deps.getAdsDailySourceRowCount || getAdsDailySourceRowCount;
  const sleep = deps.sleep || ((ms) => new Promise((res) => setTimeout(res, ms)));
  const compatible = []; const incompatible = []; const unreadable = [];
  const coverageOf = new Map();
  for (const a of regionAccounts) {
    let outcome = null;
    if (trustSucceededAsCompatible) {
      let cov = null;
      try { cov = await getCoverage(a.accountId, ASIN_ADS_GRAIN); } catch { cov = null; }
      coverageOf.set(S(a.accountId), cov);
      if (cov && cov.read === "ok" && cov.status === "succeeded") outcome = "compatible";
    }
    for (let attempt = 0; attempt < 3 && outcome === null; attempt += 1) {
      try { const names = await fetchSources(r.primaryConn.apiKey, a.accountId); outcome = names && names.has(ASIN_ADS_SOURCE_NAME) ? "compatible" : "incompatible"; }
      catch { if (attempt < 2) await sleep(2000); }
    }
    if (outcome === "compatible") compatible.push(a); else if (outcome === "incompatible") incompatible.push(a); else unreadable.push({ ...a, reason: "compatible-sources-unreadable" });
  }
  const covered = []; const pending = [];
  for (const a of compatible) {
    let cov = coverageOf.has(S(a.accountId)) ? coverageOf.get(S(a.accountId)) : null;
    if (!coverageOf.has(S(a.accountId))) { try { cov = await getCoverage(a.accountId, ASIN_ADS_GRAIN); } catch { cov = null; } }
    const w = asinAdsAccountWindow({ asOf, coverage: cov });
    if (w.kind === "unreadable") { unreadable.push({ ...a, reason: w.reason }); continue; }
    if (w.kind === "covered") { covered.push({ ...a, window: { from: w.from, to: w.to } }); continue; }
    let ratePerDay = null; let rateWindow = null;
    const rw = asinAdsRateWindow(cov.windows, asOf);
    if (rw) {
      try { const c = await countRows({ accountId: a.accountId, sourceKey: ASIN_ADS_GRAIN, from: rw.from, to: rw.to }); ratePerDay = Math.round((c.rows / rw.days) * 10) / 10; rateWindow = rw; }
      catch { ratePerDay = null; }
    }
    pending.push({ ...a, kind: w.kind, window: { from: w.from, to: w.to, days: inclusiveDaySpan(w.from, w.to) }, ratePerDay, rateWindow });
  }
  const items = planAsinAdsItems(pending);
  return { region, asOf, windows, regionAccounts, compatible, incompatible, unreadable, covered, pending, items, primaryConn: r.primaryConn, unassigned: r.unassigned || [] };
}

/** PURE: the create exposure of one region plan: planned creates + the split allowance the caller may approve. */
export function asinAdsPlanExposure(plan, { splitAllowance = null } = {}) {
  const items = plan && Array.isArray(plan.items) ? plan.items : [];
  const normalCreates = items.length;
  const allowance = splitAllowance != null ? Math.max(0, Math.trunc(Number(splitAllowance)) || 0) : Math.min(4, normalCreates);
  return { normalCreates, splitAllowance: allowance, worstCaseCreates: normalCreates + allowance, tokensPerCreate: ASIN_ADS_TOKENS_PER_CREATE,
    expectedTokens: normalCreates * ASIN_ADS_TOKENS_PER_CREATE, worstCaseTokens: (normalCreates + allowance) * ASIN_ADS_TOKENS_PER_CREATE,
    predictedRows: items.reduce((t, it) => t + (it.expectedRows || 0), 0), maxPredictedRowsPerExport: items.reduce((m, it) => Math.max(m, it.expectedRows || 0), 0) };
}

// ---- completed-export reuse (zero tokens) ----
const canonAggs = (aggs) => (Array.isArray(aggs) ? aggs : []).map((a) => [S(a && a.column), S(a && a.aggregation).toLowerCase(), S(a && a.alias)].join(":")).sort().join("|");
/** PURE: the canonical identity of one create-export request (order-independent sellers + aggregations). */
export function exportRequestIdentity(x) {
  const e = x || {};
  return JSON.stringify([
    S(e.sourceId), [...(e.sellerOrVendorIds || [])].map(S).sort(), (e.columns || []).map(S), S(e.from).slice(0, 10), S(e.to).slice(0, 10),
    (e.groupBy || []).map(S), canonAggs(e.aggregations), Number(e.limit), Number(e.skip || 0), S(e.outputType).toUpperCase(),
    S(e.orderByColumn), S(e.orderByDirection).toUpperCase(),
  ]);
}
/**
 * PURE: the ONE listed export that may be adopted in place of creating `body`: COMPLETED, an EXACT request identity,
 * created within the reuse horizon (and not in the future), and downloadable for at least the minimum remaining time.
 * The newest such export wins. -> { disposition: "adopt", exportId } | { disposition: "none" }.
 */
export function matchReusableExport({ exports, body, nowMs, maxAgeMs = ASIN_ADS_REUSE_MAX_AGE_MS, minRemainingMs = ASIN_ADS_REUSE_MIN_REMAINING_MS, exclude = new Set() } = {}) {
  const want = exportRequestIdentity(body);
  const ok = (Array.isArray(exports) ? exports : []).filter((e) => {
    if (!e || S(e.status) !== "COMPLETED" || !S(e.id) || exclude.has(S(e.id))) return false;
    const created = Date.parse(S(e.createdAt)); const expires = Date.parse(S(e.expiresAt));
    if (!Number.isFinite(created) || created > nowMs || nowMs - created > maxAgeMs) return false;
    if (Number.isFinite(expires) && expires - nowMs < minRemainingMs) return false;
    return exportRequestIdentity(e) === want;
  }).sort((a, b) => Date.parse(S(b.createdAt)) - Date.parse(S(a.createdAt)));
  return ok.length ? { disposition: "adopt", exportId: S(ok[0].id) } : { disposition: "none" };
}
/** The recent exports list (free GET pages, newest first) back to the reuse horizon. Throws on an unreadable list. */
export async function listRecentExports({ apiKey, nowMs = Date.now(), maxAgeMs = ASIN_ADS_REUSE_MAX_AGE_MS, fetchImpl = fetch, maxPages = REUSE_LIST_MAX_PAGES } = {}) {
  const out = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const r = await fetchImpl("https://api.datadoe.com/api/v1/exports?pageSize=25&page=" + page, { method: "GET", headers: { "datadoe-api-key": apiKey } });
    if (!r || !r.ok) throw typed("ASIN_ADS_EXPORT_LIST_UNREADABLE", "exports list " + (r ? r.status : "no-response"));
    const j = await r.json(); const list = Array.isArray(j && j.data) ? j.data : [];
    out.push(...list);
    const oldest = list.length ? Date.parse(S(list[list.length - 1].createdAt)) : NaN;
    if (!list.length || !(j.meta && j.meta.hasNextPage) || (Number.isFinite(oldest) && nowMs - oldest > maxAgeMs)) break;
  }
  return out;
}

/**
 * Run ONE bounded ASIN Ads pass for a region plan. `maxTotalCreates` HARD-caps every create POST of this pass (checked
 * BEFORE the POST; a reused export costs nothing and is not counted). `adoptOnly` = reuse completed exports only, never
 * create (the CLI's post-failure reconcile pass). Returns a typed result:
 *   { phase: "complete" | "partial", creates, reused, tokens, covered[], incompatible[], unreadable[], rejected[],
 *     transient[], ambiguous[], budgetDeferred[], fragments[], diagnostics[] }
 *   { phase: "sync", continuationRequired: true, ... }  -- deadline reached between items (resume the same plan);
 *   { phase: "sync", ok: false, problems, ... }         -- a systemic failure (LKG preserved).
 */
export async function runAsinAdsRegionSlice({ region, asOf, plan = null, maxTotalCreates = null, adoptOnly = false, deadlineAtMs = null, deps = {}, log = () => {} } = {}) {
  const p = plan || await planAsinAdsRegionRun({ region, asOf, deps });
  const base = { region: p.region, incompatible: p.incompatible.map((a) => a.accountId), unreadable: p.unreadable.map((a) => a.accountId), alreadyCovered: p.covered.map((a) => a.accountId) };
  const empty = { creates: 0, reused: 0, tokens: 0, covered: [], rejected: [], transient: [], ambiguous: [], budgetDeferred: [], fragments: [], diagnostics: [] };
  if (!p.items.length) return { phase: "complete", ...base, ...empty, note: p.compatible.length ? "already fully covered" : "no Amazon-Ads-compatible accounts in region" };
  const cap = maxTotalCreates != null ? Math.max(0, Math.trunc(Number(maxTotalCreates)) || 0) : asinAdsPlanExposure(p).worstCaseCreates;
  const nowMs = deps.nowMs || (() => Date.now());
  const baseCreate = deps.createExport || PRODUCTION_ADS_SYNC_DEPS.createExport;
  const listExports = deps.listRecentExports || ((o) => listRecentExports(o));
  let creates = 0; let reused = 0; let listing = null; let ceilingHit = false;
  const adoptedIds = new Set(); const createdIds = [];
  const createErr = { value: null };
  const reusable = async (body) => {
    if (listing === null) { try { listing = await listExports({ apiKey: p.primaryConn.apiKey, nowMs: nowMs() }); } catch (e) { listing = []; log("export reuse unavailable this pass (" + S(e && e.code) + "); creates proceed under the cap"); } }
    return matchReusableExport({ exports: listing, body, nowMs: nowMs(), exclude: adoptedIds });
  };
  const ceilingError = () => typed("ASIN_ADS_CEILING", "approved total create cap " + cap + " reached");
  const guardedCreate = async (apiKey, source, ids, from, to, skip = 0) => {
    if (!source || source.key !== ASIN_ADS_GRAIN) throw typed("ASIN_ADS_GRAIN_MISMATCH", "the ASIN runner only creates " + ASIN_ADS_GRAIN);
    const body = buildAdsExportRequestBody(source, ids, from, to, skip);
    const m = await reusable(body);
    if (m.disposition === "adopt") { adoptedIds.add(m.exportId); reused += 1; log("reused completed export " + m.exportId.slice(0, 8) + " [" + from + ".." + to + "] (zero tokens)"); return { exportId: m.exportId, reused: true }; }
    if (adoptOnly) throw typed("ASIN_ADS_ADOPT_ONLY_NO_MATCH", "no reusable completed export", { sourceStage: "download" });
    if (creates >= cap) { ceilingHit = true; throw ceilingError(); }
    creates += 1;
    try { const r = await baseCreate(apiKey, source, ids, from, to, skip); const id = r && (r.exportId || r.id); if (id) createdIds.push(S(id)); return r; }
    catch (e) { createErr.value = e; throw e; }
  };
  const workerDeps = { ...PRODUCTION_ADS_SYNC_DEPS, ...(deps.workerDeps || {}), createExport: guardedCreate };
  const runWorker = deps.runAdsSyncWithDeps || runAdsSyncWithDeps;
  const countryOf = new Map(p.pending.map((a) => [S(a.accountId), S(a.marketplace).toUpperCase()]));
  const fragments = [];
  const runOne = async (ids, depth = 0, window = null) => {
    if (deadlineAtMs != null && nowMs() >= deadlineAtMs) return { status: "partial", deferred: true, sources: {} };
    if (!adoptOnly && creates >= cap) { ceilingHit = true; throw ceilingError(); } // budget-defer: ZERO worker calls / state writes
    if (adoptOnly) {
      const first = buildAdsExportRequestBody(ASIN_SOURCE, ids, window.from, window.to, 0);
      if ((await reusable(first)).disposition !== "adopt") throw typed("ASIN_ADS_ADOPT_ONLY_NO_MATCH", "no reusable completed export for this batch", { sourceStage: "download" });
    }
    createErr.value = null; ceilingHit = false;
    const countries = [...new Set(ids.map((id) => countryOf.get(S(id))).filter(Boolean))];
    const summary = await runWorker(workerDeps, countries, [ASIN_ADS_GRAIN], { accountIds: ids, requiredCoverage: { from: window.from, to: window.to }, adsRunnerAuthorization: ASIN_ADS_RUNNER_AUTHORIZATION });
    const asin = (summary && summary.sources && summary.sources[ASIN_ADS_GRAIN]) || {};
    for (const fr of asin.fragments || []) fragments.push({ ...fr, sellers: ids.length, window: { from: window.from, to: window.to } });
    const failed = (asin.failedAccounts || []).length + (asin.coverageFailedAccounts || []).length;
    // A create-time HTTP failure inside the worker is surfaced TYPED so the shared engine can split / isolate; the cap
    // reached mid-window is surfaced as the ceiling (the rest is budget-deferred).
    if (failed && ceilingHit) throw ceilingError();
    if (failed && createErr.value && createErr.value.sourceStage === "create") throw createErr.value;
    return summary;
  };
  const rec = await runCampaignAdsBatchesWithRecovery({
    batches: p.items.map((it) => ({ allowlist: it.allowlist, window: it.window })), runOne, grain: ASIN_ADS_GRAIN, ceilingCode: "ASIN_ADS_CEILING", log,
  });
  const tokens = creates * ASIN_ADS_TOKENS_PER_CREATE;
  const counts = { creates, reused, tokens, createdExportIds: createdIds.map((x) => x.slice(0, 8)), adoptedExportIds: [...adoptedIds].map((x) => x.slice(0, 8)) };
  if (rec.lockHeld) return { phase: "sync", ok: false, ...base, ...counts, problems: ["ads lock held (concurrent ASIN run)"] };
  if (rec.deferred) return { phase: "sync", continuationRequired: true, ...base, ...counts };
  const uniq = (xs) => [...new Set(xs.map(S))];
  const failedIds = new Set(uniq([...rec.rejected, ...rec.transient, ...rec.ambiguous, ...(rec.budgetDeferred || [])]));
  const covered = uniq([...rec.covered]).filter((id) => !failedIds.has(id));
  const rejected = uniq(rec.rejected); const ambiguous = uniq(rec.ambiguous).filter((id) => !rejected.includes(id));
  const budgetDeferred = uniq(rec.budgetDeferred || []).filter((id) => !rejected.includes(id) && !ambiguous.includes(id));
  const transient = uniq(rec.transient).filter((id) => !rejected.includes(id) && !ambiguous.includes(id) && !budgetDeferred.includes(id));
  const assessment = assessAsinAdsRegionCycle({ region: p.region, pendingAccounts: p.pending.map((a) => a.accountId), batchResults: rec.batchResults.filter((b) => !b.summary || b.summary.deferred !== true), coveredAccounts: covered, fragments });
  if (!assessment.ok && covered.length) return { phase: "sync", ok: false, ...base, ...counts, problems: assessment.problems.slice(0, 6) };
  const accountedFor = new Set([...covered, ...rejected, ...transient, ...ambiguous, ...budgetDeferred]);
  const unaccounted = p.pending.map((a) => S(a.accountId)).filter((id) => !accountedFor.has(id));
  if (unaccounted.length) return { phase: "sync", ok: false, ...base, ...counts, problems: ["accounts unaccounted for: " + unaccounted.length] };
  const isolated = rejected.length + transient.length + ambiguous.length + budgetDeferred.length;
  return { phase: isolated ? "partial" : "complete", ...base, ...counts, covered, rejected, transient, ambiguous, budgetDeferred, fragments, diagnostics: rec.diagnostics.slice(0, 20), batches: rec.batchResults.length };
}

/**
 * STRICT, PURE assessment of the batches that SUCCEEDED in one ASIN region pass: every summary completed with full
 * coverage pairs, ONLY the ASIN grain, zero failed accounts, <=5 sellers, all inside the region's pending set; every
 * covered account appears in a successful batch; every fragment is below the row limit (a full page is never accepted).
 */
export function assessAsinAdsRegionCycle({ region, pendingAccounts, batchResults, coveredAccounts, fragments = [] } = {}) {
  const problems = [];
  if (!VALID_REGIONS.includes(region)) return { ok: false, problems: ["bad-region"] };
  const pendingSet = new Set((pendingAccounts || []).map(S));
  const seen = new Set();
  for (const r of Array.isArray(batchResults) ? batchResults : []) {
    const summary = r && r.summary; const ids = ((r && r.accountIds) || []).map(S).filter(Boolean);
    if (!summary) { problems.push("missing-summary"); continue; }
    const asin = (summary.sources || {})[ASIN_ADS_GRAIN] || {};
    const failed = (asin.failedAccounts || []).length + (asin.coverageFailedAccounts || []).length;
    for (const key of Object.keys(summary.sources || {})) if (key !== ASIN_ADS_GRAIN) problems.push("non-asin-source:" + key);
    if (ids.length > MAX_SELLERS_PER_BATCH) problems.push("batch-oversized:" + ids.length);
    if (!ids.length) problems.push("batch-empty");
    for (const id of ids) if (!pendingSet.has(id)) problems.push("batch-account-unexpected");
    if (failed) continue; // isolated by the engine (reported per account), not a structural problem of the run
    if (S(summary.status) !== "completed") problems.push("batch-not-completed:" + S(summary.status));
    if (summary.coverageComplete !== true) problems.push("batch-coverage-incomplete");
    if (Number(summary.successfulCoveragePairs) !== Number(summary.expectedCoveragePairs)) problems.push("coverage-pairs-mismatch");
    for (const id of ids) seen.add(id);
  }
  for (const id of (coveredAccounts || []).map(S)) if (!seen.has(id)) problems.push("covered-account-without-successful-batch");
  for (const f of Array.isArray(fragments) ? fragments : []) if (!(Number(f.rowCount) < EXPORT_LIMIT)) problems.push("fragment-at-row-limit");
  return { ok: problems.length === 0, problems };
}

/**
 * PURE: the operator status row (source_run_status, keyed (ads-asin-date, region)) for one finished region run.
 * succeeded only when every compatible account is covered through asOf (then the rolling window is the covered range
 * and last_success_at advances); partial when some accounts were isolated / deferred; failed on a systemic failure.
 * Counts are accounts, never ids; the safe code is a typed slug.
 */
export function asinAdsRunStatusEntry({ region, plan, outcome, maxCreates = null, nowIso }) {
  const o = outcome || {};
  const failedN = ["rejected", "transient", "ambiguous", "budgetDeferred"].reduce((t, k) => t + ((o[k] || []).length), 0);
  const systemic = o.systemic === true;
  const complete = !systemic && failedN === 0 && (plan.unreadable || []).length === 0;
  return {
    sourceKey: ASIN_ADS_SOURCE_KEY, bucket: region,
    lastStatus: systemic ? "failed" : (complete ? "succeeded" : "partial"),
    lastAttemptAt: nowIso, ...(complete ? { lastSuccessAt: nowIso } : {}),
    safeErrorCode: systemic ? "ASIN_ADS_FAILED" : (failedN ? "ASIN_ADS_ACCOUNTS_ISOLATED" : ((plan.unreadable || []).length ? "ASIN_ADS_ACCOUNTS_UNREADABLE" : null)),
    safeErrorStage: systemic ? "run" : null,
    coveredFrom: complete ? plan.windows.rolling.from : null, coveredTo: complete ? plan.windows.rolling.to : null,
    accountsCompleted: (o.covered || []).length + (plan.covered || []).length, accountsFailed: failedN + (plan.unreadable || []).length,
    accountsTotal: (plan.compatible || []).length, batchCount: (plan.items || []).length,
    createsSpent: Number(o.creates) || 0, tokensSpent: (Number(o.creates) || 0) * ASIN_ADS_TOKENS_PER_CREATE,
    createsCeiling: maxCreates, tokensCeiling: maxCreates == null ? null : maxCreates * ASIN_ADS_TOKENS_PER_CREATE,
  };
}

/**
 * ONE bounded ASIN Ads pass for a Data Sync Center BUCKET (us -> us-ca; non-us -> india + europe-au). Every region is
 * planned first (zero tokens); a plan whose planned creates exceed `maxTotalCreates` is refused typed with ZERO creates;
 * otherwise each region runs under the cap still unspent. Returns a DSC-compatible typed result.
 */
export async function runAsinAdsBucketSlice({ bucket, asOf, maxTotalCreates = null, deadlineAtMs = null, trustSucceededAsCompatible = false, deps = {}, log = () => {} } = {}) {
  const regions = regionsForBucket(bucket);
  if (!regions.length) return { phase: "sync", ok: false, problems: ["bad-bucket:" + S(bucket)], creates: 0, tokens: 0 };
  const cap = maxTotalCreates != null ? Math.max(0, Math.trunc(Number(maxTotalCreates)) || 0) : null;
  const routed = await discoverRoutedAccounts({ deps });
  const plans = [];
  for (const region of regions) plans.push(await planAsinAdsRegionRun({ region, asOf, routed, trustSucceededAsCompatible, deps }));
  const plannedCreates = plans.reduce((t, pl) => t + pl.items.length, 0);
  if (cap != null && plannedCreates > cap) {
    return { phase: "sync", ok: false, refused: true, code: "ASIN_ADS_APPROVAL_EXCEEDED", plannedCreates, maxTotalCreates: cap, creates: 0, tokens: 0,
      problems: ["the ASIN Ads plan needs " + plannedCreates + " create(s) > the " + cap + " the approval still covers; refusing (zero creates)"] };
  }
  let creates = 0; let tokens = 0; let reused = 0; const perRegion = [];
  const writeStatus = deps.upsertSourceRunStatus || upsertSourceRunStatus;
  for (const pl of plans) {
    const startedIso = new Date((deps.nowMs || Date.now)()).toISOString();
    const regionCap = cap != null ? Math.max(0, cap - creates) : null;
    const r = await runAsinAdsRegionSlice({ region: pl.region, asOf, plan: pl, maxTotalCreates: regionCap, deadlineAtMs, deps, log });
    creates += r.creates || 0; tokens += r.tokens || 0; reused += r.reused || 0;
    if (r.phase === "complete" || r.phase === "partial" || (r.phase === "sync" && r.ok === false)) {
      try { await writeStatus(asinAdsRunStatusEntry({ region: pl.region, plan: pl, maxCreates: regionCap, nowIso: startedIso, outcome: { ...r, systemic: r.phase === "sync" } })); }
      catch { /* best-effort operator status; never changes the outcome */ }
    }
    perRegion.push({ region: pl.region, phase: r.phase, covered: (r.covered || []).length, transient: (r.transient || []).length, rejected: (r.rejected || []).length, budgetDeferred: (r.budgetDeferred || []).length });
    if (r.phase !== "complete" && r.phase !== "partial") {
      if (r.continuationRequired === true) return { phase: "sync", continuationRequired: true, creates, tokens, reused, perRegion };
      return { phase: "sync", ok: false, problems: r.problems || [], creates, tokens, reused, perRegion };
    }
  }
  const anyIsolated = perRegion.some((x) => x.transient || x.rejected || x.budgetDeferred || x.phase === "partial");
  return { phase: anyIsolated ? "partial" : "complete", creates, tokens, reused, perRegion };
}
