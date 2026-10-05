// The REGION-AWARE runner of the daily "Returns (FBA & FBM)"-ONLY durable source (DESIGN-v2 sections 3 + 4.1), driven by
// scripts/release/scheduled-returns-refresh.mjs (scheduler-v2 returns_source job + the owner-approved operator canary).
// It creates ONLY Returns exports (RETURNS_PSEUDO_SOURCE through the shared ads-sync transport) -- never Settlements,
// OLI or any other source; the legacy returns-operation.js / returns-leakage-golive.mjs pair is not in its import graph.
// Order of one paid region run (every I/O injected through `deps`; the production defaults are imported below):
//   1. POPULATION: the export-eligible PRIMARY accounts routed into this region from the live directory every run
//      (discoverRoutedAccounts -- a newly onboarded account joins automatically); an operator --accounts allowlist must
//      be a subset of the region (else a typed refusal before anything else).
//   2. FREE PREFLIGHT (zero tokens; every runner GET is spaced through ONE rate-limited fetch carrying an AbortSignal
//      timeout; a GET 429 is retried, bounded): the public data-scheme must list ALL 24 requested columns for RETURNS.id as a STANDARD source, else
//      RETURNS_SCHEMA_DRIFT with zero creates; per account GET /exports/sources (3 attempts, 2 s apart): "returns (fba &
//      fbm)" present = compatible, absent = incompatible (excluded, reported), unreadable = pending.
//   3. STATE + COVERAGE: one batched account-state read + each account's 'returns' coverage -> the PURE decideAccountMode
//      (pending | held | reverify | initial | rolling | skipped-current; every unreadable input fails closed).
//   4. RUN LEASE (acquire_returns_run_lease, uuid owner token, ttl 900 s) BEFORE any re-verify / slot claim / persist:
//      refused -> typed RETURNS_LEASE_HELD skip with zero creates; renewed before every create, every account persist
//      and every re-verify; released (owner-checked) in finally. A lost lease stops the run (systemic). Right after the
//      grant -- before any confirm, slot claim or create -- every compatible account's state + coverage is RE-READ and
//      its mode decided again (the step-3 read predates the lease; an overlapping run may have moved any account since);
//      an unreadable re-read stops the run (systemic, fail closed).
//   5. ZERO-TOKEN RE-VERIFY of every account a crashed run left in last_status 'replaced' -- held ones included, so the
//      confirm can drop an ambiguous initial's coverage (independent read-back count + confirm_returns_events_window),
//      then a re-read + re-decision of those accounts BEFORE any paid planning.
//   6. PLAN: planReturnsBatches (identical windows, <=5 sellers, rolling first) through the shared recovery engine
//      (runCampaignAdsBatchesWithRecovery, grain 'returns-events', ceiling RETURNS_CEILING): a create-time rejection, a
//      provider loading notice or a page rejected for shape / row-outside-window / data-source issue on a multi-seller
//      batch splits it (each half a new create within the cap); a single seller is isolated with its typed code; an
//      ambiguous create is never re-sent.
//   7. PER CREATE, in order: completed-export REUSE (exact identity, zero tokens, no slot; off with adoptList=false);
//      claim_returns_create_slot (the DB-enforced per-(region, UTC claim day) ceiling -- refused = the rest
//      budget-deferred); a FRESH balance read (usable - remaining*2 < reserve -> RETURNS_TOKEN_RESERVE, stop creating);
//      the guarded POST (only RETURNS.id, 1..5 sellers, limit 50000, skip 0, the 24 columns); the strict download +
//      validateSplitWindowPage (COMPLETED, integer rowCount == array length, no loading notice / data-source issue, every
//      row inside ITS fragment, every NOT-NULL spec column an own property -- RETURNS_SHAPE_SOURCE; an omitted nullable
//      column is null); rowCount >= 50000 -> date bisection within the cap (a capped page is never persisted); a single
//      day at the cap -> RETURNS_DAY_AT_ROW_LIMIT. A failed status / download GET keeps the export id for ONE end-of-run
//      zero-create pass (known ids + one fresh adopt-only listing for an ambiguous create; no slot, no POST; it checks
//      the run deadline before each batch and before each download and stops cleanly past it).
//   8. PER ACCOUNT (after every fragment of its batch): validateAccountRows (seller / marketplace / window / quantity /
//      numerics / identity); an INVALID account fails ALONE (record_returns_window_failure, nothing written) while its
//      batch-mates persist; replace_returns_events_window (one transaction; identity status + counts-only detail;
//      attribution RETURNS_ATTRIBUTION; allowShrink only for operator --allow-shrink ids) -> an INDEPENDENT read-back count
//      (a read error = verify-unreadable, retried next run at zero tokens, never verify-failed) -> the post-commit confirm
//      (ALWAYS called once the count is read -- a count mismatch still lets the server recount and cut the window's
//      coverage, and fails the account RETURNS_READBACK_MISMATCH). A failure is recorded ONLY for a PROVEN rollback (a
//      typed RPC refusal, a PostgREST / SQLSTATE code); an unknown replace outcome (transport loss, a gateway 5xx without
//      a code) writes nothing: pending RETURNS_PERSIST_UNCONFIRMED, settled by the next run's zero-token re-verify.
// OUTPUT CONTRACT (public repo): every log line, the RESULT payload, the step summary, the status row and every RPC detail
// carry ONLY counts, typed codes, dates and 8-character account / export prefixes -- never an order id, LPN, RMA, FNSKU,
// SKU or a full seller id. Full export ids stay in the result object for the operator's local evidence file. 7-bit ASCII.

import { randomUUID } from "node:crypto";
import { PRODUCTION_ADS_SYNC_DEPS, buildAdsExportRequestBody, validateSplitWindowPage, bisectDateWindow, EXPORT_LIMIT } from "../ads-sync.js";
import { fetchCompatibleSourceNames } from "../datadoe.js";
import { getDataDoeTokenBalance } from "../datadoe-usage.js";
import { organizationFingerprint } from "../source-identity.js";
import {
  getSourceCoverageWindows, getReturnsAccountStates, countReturnsEventsWindow, replaceReturnsEventsWindow,
  confirmReturnsEventsWindow, recordReturnsWindowFailure, claimReturnsCreateSlot, acquireReturnsRunLease,
  renewReturnsRunLease, releaseReturnsRunLease, upsertSourceRunStatus,
} from "../supabase.js";
import { discoverRoutedAccounts, runCampaignAdsBatchesWithRecovery } from "./scheduled-campaign-ads-runner.js";
import { exportRequestIdentity, matchReusableExport, listRecentExports } from "./scheduled-asin-ads-runner.js";
import { classifyThrownSourceError, SOURCE_FAILURE } from "./source-failure-classifier.js";
import {
  RETURNS_EVENT_SOURCE_KEY, RETURNS_SOURCE_ID, RETURNS_EVENT_COLUMNS, RETURNS_TOKENS_PER_CREATE, RETURNS_EXPORT_ROW_LIMIT,
  RETURNS_MAX_SELLERS, RETURNS_ATTRIBUTION, RETURNS_COMPATIBLE_SOURCE_NAME, RETURNS_PSEUDO_SOURCE, RETURNS_SHAPE_SOURCE, RETURNS_REGIONS,
  RETURNS_ACCOUNT_OUTCOMES, returnsWindows, accountD1, decideAccountMode, normalizeMarketplace, validateAccountRows,
  planReturnsBatches, returnsPlanExposure, returnsRequestHash, crossAccountOrderCollisions, maskId, summarizeAnomalies,
  returnsRunStatusEntry,
} from "./returns-event-source.js";

export const RETURNS_RUNNER_GRAIN = RETURNS_PSEUDO_SOURCE.key;          // 'returns-events' (the recovery-engine grain)
export const RETURNS_CEILING_CODE = "RETURNS_CEILING";
export const RETURNS_LEASE_TTL_SECONDS = 900;
export const RETURNS_DEFAULT_RESERVE_TOKENS = 100;
export const RETURNS_SPEC_URL = "https://api.datadoe.com/api/v1/spec/data-scheme";
export const RETURNS_MIN_REQUEST_INTERVAL_MS = 550;                    // DataDoe allows 2 requests/s per organization
export const RETURNS_REQUEST_TIMEOUT_MS = 30000;                       // the AbortSignal timeout of every runner GET
// The shared ads-sync transport takes no AbortSignal, so its two calls are bounded by a runner-side deadline instead: a
// create past it is AMBIGUOUS (never re-sent; the end-of-run adopt-only pass may reuse it), a download past it keeps the
// export id for the end-of-run GET-only retry.
export const RETURNS_CREATE_TIMEOUT_MS = 90000;
export const RETURNS_DOWNLOAD_TIMEOUT_MS = 300000;
export const RETURNS_RECONCILE_WAIT_MS = 30000;
// The per-account outcome categories of DESIGN-v2 3.9, in reporting order (the core's list -- one vocabulary).
export const RETURNS_OUTCOME_CATEGORIES = RETURNS_ACCOUNT_OUTCOMES;
// Run classifications that are typed SKIPS (zero creates; exit 0) rather than an executed run.
export const RETURNS_SKIP_CLASSIFICATIONS = Object.freeze(["RETURNS_LEASE_HELD", "RETURNS_SCHEMA_DRIFT", "RETURNS_SCHEMA_UNREADABLE"]);
const SUCCESS_CODES = new Set(["RETURNS_INITIAL_LOADED", "RETURNS_DAILY_REFRESHED", "RETURNS_ALREADY_CURRENT"]);

const S = (v) => (v == null ? "" : String(v));
const isDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(S(v));
const p8 = (v) => { let m; try { m = maskId(v); } catch { m = v; } return S(m).slice(0, 8); };
const typed = (code, message, extra = {}) => Object.assign(new Error(code + ": " + message), { code, returnsCode: code, ...extra });
const uniq = (xs) => [...new Set(xs)];
const SAFE_CODE = /^[A-Z0-9_]{1,64}$/;
const safeCode = (c, fallback) => (SAFE_CODE.test(S(c)) ? S(c) : fallback);
const defaultSleep = (ms) => new Promise((res) => setTimeout(res, ms));

// ---- pure helpers ---------------------------------------------------------------------------------------------------

/**
 * PURE: the public data-scheme check for the Returns source. Every requested column (RETURNS_EVENT_COLUMNS, 24) must be
 * listed for RETURNS.id, and the source must still be a STANDARD (non-premium, 2-token) source -- the reserve math and
 * the approved ceilings assume that price. -> { read:"ok", ok:true } | { read:"ok", ok:false, code:"RETURNS_SCHEMA_DRIFT",
 * missing, missingColumns, premium, sourceMissing } | { read:"error", reason }. Column names are schema names only.
 */
export function checkReturnsSpec(body) {
  const sources = body && Array.isArray(body.sources) ? body.sources : null;
  if (!sources) return { read: "error", reason: "spec-shape" };
  const src = sources.find((s) => s && S(s.id) === RETURNS_SOURCE_ID);
  if (!src || !Array.isArray(src.columns)) return { read: "ok", ok: false, code: "RETURNS_SCHEMA_DRIFT", sourceMissing: true, missing: RETURNS_EVENT_COLUMNS.length, missingColumns: [...RETURNS_EVENT_COLUMNS], premium: false };
  const have = new Set(src.columns.map((c) => S(c && c.name)));
  const missingColumns = RETURNS_EVENT_COLUMNS.filter((c) => !have.has(c));
  const premium = src.isPremium === true;
  if (missingColumns.length || premium) return { read: "ok", ok: false, code: "RETURNS_SCHEMA_DRIFT", sourceMissing: false, missing: missingColumns.length, missingColumns, premium };
  return { read: "ok", ok: true, code: null, sourceMissing: false, missing: 0, missingColumns: [], premium: false };
}

/**
 * ONE rate-limited fetch for every DataDoe GET the runner itself makes (spec, compatible sources, export listing, token
 * balance): requests are spaced >= minIntervalMs apart and each carries its own AbortSignal timeout. A 429 on a GET (free;
 * these reads never create anything) is retried at most `max429Retries` times after Retry-After (capped at 10 s) or a
 * short backoff -- the runner's GETs interleave with the shared transport's create / status / download requests, and a
 * throttled FRESH balance read must not stop the run as "balance unreadable". Any other method is never retried here.
 * `fetchImpl` defaults to the global fetch resolved at call time.
 */
export function createRateLimitedFetch({ fetchImpl = null, minIntervalMs = RETURNS_MIN_REQUEST_INTERVAL_MS, timeoutMs = RETURNS_REQUEST_TIMEOUT_MS, sleep = null, nowMs = null, max429Retries = 2 } = {}) {
  const wait = sleep || defaultSleep;
  const clock = nowMs || (() => Date.now());
  let last = null;
  const once = async (url, options) => {
    const gap = last == null ? 0 : Math.max(0, minIntervalMs - (clock() - last));
    if (gap > 0) await wait(gap);
    last = clock();
    const signal = options && options.signal ? options.signal : (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(timeoutMs) : undefined);
    const impl = fetchImpl || globalThis.fetch;
    return impl(url, { ...(options || {}), ...(signal ? { signal } : {}) });
  };
  return async (url, options = {}) => {
    const method = S((options && options.method) || "GET").toUpperCase();
    for (let attempt = 0; ; attempt += 1) {
      const res = await once(url, options);
      if (!(res && res.status === 429 && method === "GET" && attempt < max429Retries)) return res;
      const ra = Number(res.headers && typeof res.headers.get === "function" ? res.headers.get("retry-after") : NaN);
      await wait(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 10000) : 1000 * (attempt + 1));
    }
  };
}

// A promise bounded by a deadline: past it the returned promise rejects with onTimeout() (the original settles unobserved).
// The timer is deliberately NOT unref'd: it is cleared the moment the promise settles, and while the promise is pending
// it is what keeps the process alive until the deadline fires -- an unref'd timer let a hung create with no open handle
// drain the event loop and exit 0 before the deadline (a run that silently never finished).
function withDeadline(promise, ms, onTimeout) {
  if (!(Number.isFinite(ms) && ms > 0)) return Promise.resolve(promise);
  return new Promise((resolve, reject) => {
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; reject(onTimeout()); } }, ms);
    Promise.resolve(promise).then(
      (v) => { if (!done) { done = true; clearTimeout(t); resolve(v); } },
      (e) => { if (!done) { done = true; clearTimeout(t); reject(e); } },
    );
  });
}

// A coverage read (getSourceCoverageWindows shape) normalized to the CONTRACT C shape decideAccountMode takes.
function normalizeCoverageRead(cov) {
  if (!cov || typeof cov !== "object") return { read: "error", windows: [] };
  if (cov.read === "ok") return { read: "ok", windows: Array.isArray(cov.windows) ? cov.windows.map((w) => ({ from: S(w && w.from), to: S(w && w.to) })) : [] };
  return { read: cov.read === "schema-missing" || cov.read === "missing" ? "missing" : "error", windows: [] };
}

// The ads-sync page-validation failures mapped to the Returns vocabulary (their messages are never surfaced).
function returnsPageCode(error) {
  const c = S(error && error.code);
  if (c === "ADS_EXPORT_HISTORY_STILL_LOADING") return "RETURNS_HISTORY_LOADING";
  if (c === "ADS_EXPORT_DATA_SOURCE_ISSUE") return "RETURNS_DATA_SOURCE_ISSUE";
  if (c === "ADS_EXPORT_ROW_OUTSIDE_WINDOW") return "RETURNS_ROW_OUTSIDE_WINDOW";
  if (c === "ADS_EXPORT_SHAPE_MISMATCH") return "RETURNS_SHAPE_MISMATCH";
  return "RETURNS_EXPORT_PAGE_INVALID";
}
// Page rejections that ONE seller of a multi-seller export can cause: the batch is split (like a loading notice) so the
// other sellers still persist; a single seller keeps the typed code as a definitive failure.
const SPLIT_PAGE_CODES = new Set(["RETURNS_SHAPE_MISMATCH", "RETURNS_ROW_OUTSIDE_WINDOW", "RETURNS_DATA_SOURCE_ISSUE"]);
const pastDeadline = (ctx) => ctx.deadlineAtMs != null && ctx.nowMs() >= ctx.deadlineAtMs;

/**
 * The recovery-engine classifier for one failed Returns batch. Runner-typed failures carry `returnsStage`:
 *   'loading'   a provider loading notice: SPLIT like a rejection on a multi-seller batch; one seller = history-loading;
 *   'split'     a page rejected for shape / row-outside-window / data-source issue: SPLIT on a multi-seller batch (each
 *               half a new create within the cap); one seller = a definitive typed failure (like 'export');
 *   'export'    a definitive page / batch failure (page invalid, day at the cap, foreign seller);
 *   'download'  a failed status / download GET (the export id is kept for the end-of-run GET-only pass);
 *   'reconcile' no known / reusable export in the zero-create pass.
 * Anything else is a create-time transport error, classified by the shared source-failure classifier.
 */
export function classifyReturnsBatchError(error, { stage = "create", singleSeller = false } = {}) {
  const e = error || {};
  const base = { stage, status: null, terminal: false, retryable: false, ambiguous: false, retryAfterMs: null, excerpt: "" };
  if (e.returnsStage === "loading") {
    return singleSeller ? { ...base, classification: "RETURNS_HISTORY_LOADING", retryable: true } : { ...base, classification: SOURCE_FAILURE.REQUEST_REJECTED, terminal: true };
  }
  if (e.returnsStage === "split") {
    return singleSeller ? { ...base, classification: "RETURNS_EXPORT_INVALID", terminal: true } : { ...base, classification: SOURCE_FAILURE.REQUEST_REJECTED, terminal: true };
  }
  if (e.returnsStage === "export") return { ...base, classification: "RETURNS_EXPORT_INVALID", terminal: true };
  if (e.returnsStage === "download") return { ...base, classification: SOURCE_FAILURE.DOWNLOAD_FAILED, retryable: true };
  if (e.returnsStage === "reconcile") return { ...base, classification: "RETURNS_RECONCILE_NO_EXPORT", retryable: true };
  return classifyThrownSourceError(e, { stage, singleSeller });
}

// ---- planning (ZERO tokens, ZERO writes, ZERO export listing) --------------------------------------------------------

/**
 * Plan ONE region's Returns run: the spec preflight, discovery + routing (shared with the Ads runners), the compatible-
 * sources preflight, the batched account-state read, each account's 'returns' coverage and its decided mode / window,
 * then the create items. Throws typed on a bad region / as-of, a foreign allowlist id, or (systemic: true) a discovery
 * failure. Every per-account read failure fails that account closed (pending, reported), never fabricated.
 */
export async function planReturnsRegionRun({ region, asOf, accountAllowlist = null, deps = {} } = {}) {
  if (!RETURNS_REGIONS.includes(region)) throw typed("RETURNS_BAD_REGION", "region must be one of " + RETURNS_REGIONS.join("|"));
  if (!isDay(asOf)) throw typed("RETURNS_BAD_ASOF", "as-of must be YYYY-MM-DD");
  const sleep = deps.sleep || defaultSleep;
  const fetchImpl = deps.fetchImpl || createRateLimitedFetch({ sleep, nowMs: deps.nowMs || null });
  const regionWindows = returnsWindows(asOf);

  // (a) the public spec, once per run (zero tokens, no key)
  let schema;
  if (deps.readReturnsSpec) { try { schema = await deps.readReturnsSpec(); } catch { schema = { read: "error", reason: "spec-read-threw" }; } }
  else {
    try {
      const res = await fetchImpl(RETURNS_SPEC_URL, { method: "GET" });
      if (!res || !res.ok) schema = { read: "error", reason: "spec-http-" + (res ? res.status : "no-response") };
      else { let body = null; try { body = await res.json(); } catch { body = null; } schema = body ? checkReturnsSpec(body) : { read: "error", reason: "spec-bad-json" }; }
    } catch { schema = { read: "error", reason: "spec-fetch-failed" }; }
  }
  if (!schema || typeof schema !== "object") schema = { read: "error", reason: "spec-unknown" };

  // (b) the export-eligible primary population of this region (a newly onboarded account joins automatically)
  let routed;
  try { routed = deps.routed || await discoverRoutedAccounts({ deps }); }
  catch (e) { throw typed("RETURNS_DISCOVERY_FAILED", "export-eligible discovery failed (" + safeCode(e && e.code, "UNKNOWN") + ")", { systemic: true }); }
  const primaryConn = routed && routed.primaryConn;
  if (!primaryConn || !primaryConn.apiKey) throw typed("RETURNS_NO_PRIMARY_CONNECTION", "no primary DataDoe connection", { systemic: true });
  let regionAccounts = ((routed.byRegion && routed.byRegion[region]) || [])
    .map((a) => ({ accountId: S(a && a.accountId).trim(), marketplace: normalizeMarketplace(a && a.marketplace) }))
    .filter((a) => a.accountId);
  if (Array.isArray(accountAllowlist)) {
    const want = uniq(accountAllowlist.map((x) => S(x).trim()).filter(Boolean));
    const have = new Set(regionAccounts.map((a) => a.accountId));
    const foreign = want.filter((id) => !have.has(id));
    if (!want.length || foreign.length) throw typed("RETURNS_ALLOWLIST_NOT_IN_REGION", (foreign.length || "empty") + " allowlisted account(s) are not export-eligible accounts of " + region);
    regionAccounts = regionAccounts.filter((a) => want.includes(a.accountId));
  }
  const orgFp = deps.organizationFingerprint || organizationFingerprint(primaryConn.apiKey);

  // (c) per account compatible-sources preflight (3 attempts, 2 s apart)
  const fetchSources = deps.fetchCompatibleSourceNames || ((apiKey, sellerId) => fetchCompatibleSourceNames(apiKey, sellerId, fetchImpl));
  const compatible = []; const incompatible = []; const pending = [];
  for (const a of regionAccounts) {
    let outcome = null;
    for (let attempt = 0; attempt < 3 && outcome === null; attempt += 1) {
      try { const names = await fetchSources(primaryConn.apiKey, a.accountId); outcome = names && typeof names.has === "function" && names.has(RETURNS_COMPATIBLE_SOURCE_NAME) ? "compatible" : "incompatible"; }
      catch { if (attempt < 2) await sleep(2000); }
    }
    if (outcome === "compatible") compatible.push(a);
    else if (outcome === "incompatible") incompatible.push({ ...a, code: "RETURNS_SOURCE_INCOMPATIBLE" });
    else pending.push({ ...a, code: "RETURNS_SOURCES_UNREADABLE" });
  }

  // (d) states (one paged read) + coverage per account -> the decided mode
  const readStates = deps.getReturnsAccountStates || getReturnsAccountStates;
  let statesRead = { read: "ok", rows: [] };
  if (compatible.length) {
    try { statesRead = await readStates({ organizationFingerprint: orgFp, connectionId: "primary", accountIds: compatible.map((a) => a.accountId) }); }
    catch { statesRead = { read: "error" }; }
    if (!statesRead || (statesRead.read !== "ok" && statesRead.read !== "missing")) statesRead = { read: "error" };
  }
  const stateOf = new Map();
  if (statesRead.read === "ok") for (const row of statesRead.rows || []) if (row && S(row.account_id)) stateOf.set(S(row.account_id), row);
  const readCoverage = deps.getSourceCoverageWindows || getSourceCoverageWindows;
  const now = deps.now ? new Date(deps.now()) : new Date();
  const decided = [];
  for (const a of compatible) {
    const d1 = accountD1({ regionAsOf: asOf, marketplace: a.marketplace, now });
    if (statesRead.read !== "ok") { pending.push({ ...a, d1, code: statesRead.read === "missing" ? "RETURNS_STATE_SCHEMA_MISSING" : "RETURNS_STATE_UNREADABLE" }); continue; }
    let cov;
    try { cov = await readCoverage({ organizationFingerprint: orgFp, connectionId: "primary", accountId: a.accountId, sourceKey: RETURNS_EVENT_SOURCE_KEY }); }
    catch { cov = null; }
    const state = stateOf.get(a.accountId) || null;
    const coverage = normalizeCoverageRead(cov);
    let decision;
    try { decision = decideAccountMode({ d1, state, coverage }); }
    catch { decision = null; }
    if (!decision || typeof decision !== "object") decision = { kind: "pending", window: null, reason: "RETURNS_MODE_UNDECIDABLE", gapDays: 0 };
    decided.push({ ...a, d1, state, coverage, decision });
  }
  return finishPlan({
    region, asOf, regionWindows, schema, primaryConn, organizationFingerprint: orgFp,
    regionAccounts, compatible, incompatible, unassigned: (routed.unassigned || []).length,
    statesRead: statesRead.read, decided, pending,
  });
}

// Split the decided accounts by kind and build the create items (re-run after a re-verify). An initial / rolling decision
// without a usable window fails closed to pending.
function finishPlan(plan) {
  const byKind = { pending: [], held: [], reverify: [], initial: [], rolling: [], "skipped-current": [] };
  const decided = plan.decided.map((a) => {
    const d = a.decision || {};
    const exportKind = d.kind === "initial" || d.kind === "rolling";
    if (exportKind && !(d.window && isDay(d.window.from) && isDay(d.window.to) && d.window.from <= d.window.to)) return { ...a, decision: { kind: "pending", window: null, reason: "RETURNS_WINDOW_INVALID", gapDays: 0 } };
    return byKind[d.kind] ? a : { ...a, decision: { kind: "pending", window: null, reason: "RETURNS_MODE_UNKNOWN", gapDays: 0 } };
  });
  for (const a of decided) byKind[a.decision.kind].push(a);
  const toExport = [...byKind.rolling, ...byKind.initial].map((a) => ({
    accountId: a.accountId, sellerId: a.accountId, sellerOrVendorId: a.accountId, marketplace: a.marketplace,
    mode: a.decision.kind, kind: a.decision.kind, window: { from: a.decision.window.from, to: a.decision.window.to },
    d1: a.d1, state: a.state, lastSuccessAt: a.state ? (a.state.last_success_at || null) : null,
    last_success_at: a.state ? (a.state.last_success_at || null) : null,
  }));
  const items = toExport.length ? planReturnsBatches(toExport) : [];
  const accountsById = new Map(decided.map((a) => [a.accountId, a]));
  const coverageGaps = [...byKind.rolling, ...byKind["skipped-current"]]
    .map((a) => ({ accountId: a.accountId, days: Math.max(0, Math.trunc(Number(a.decision.gapDays) || 0)) }))
    .filter((g) => g.days > 0);
  return { ...plan, decided, byKind, toExport, items, accountsById, coverageGaps };
}

// ---- the paid run ------------------------------------------------------------------------------------------------------

/**
 * Run (or dry-run) ONE region. `dryRun` = plan + exposure + balance only (ZERO creates, ZERO export listing, ZERO writes).
 * A paid run needs `maxCreates` (0..60; the DB-enforced per-(region, UTC claim day) ceiling) and `reserveTokens`. Returns the typed
 * result (full export ids included for the operator's evidence file -- print it ONLY through returnsResultPayload /
 * returnsStepSummary). Never throws for an account-level failure; throws typed only for a usage error.
 */
export async function runReturnsRegion({
  region, asOf, dryRun = false, maxCreates = null, reserveTokens = RETURNS_DEFAULT_RESERVE_TOKENS, accountAllowlist = null,
  allowShrinkIds = null, adoptList = true, runKey = null, deps = {}, log = () => {}, onRowsWritten = null,
} = {}) {
  const nowMs = deps.nowMs || (() => Date.now());
  const startedIso = new Date(nowMs()).toISOString();
  const sleep = deps.sleep || defaultSleep;
  const fetchImpl = deps.fetchImpl || createRateLimitedFetch({ sleep, nowMs: deps.nowMs || null });
  const pdeps = { ...deps, fetchImpl, sleep };
  const cap = maxCreates == null ? null : Math.trunc(Number(maxCreates));
  if (!dryRun && !(Number.isSafeInteger(cap) && cap >= 0 && cap <= 60)) throw typed("RETURNS_BAD_MAX_CREATES", "a paid run needs --max-creates in 0..60");
  const reserve = Math.max(0, Math.trunc(Number(reserveTokens)) || 0);
  const ownerToken = deps.ownerToken || randomUUID();
  const key = S(runKey || ("returns-events/" + region + "/" + asOf + "/" + ownerToken)).slice(0, 200);
  const result = emptyResult({ region, asOf, dryRun, maxCreates: cap, reserveTokens: reserve, runKey: key, startedIso });
  const writeStatus = deps.upsertSourceRunStatus || upsertSourceRunStatus;
  const finishSkipOrFail = async (plan, { code, systemic = false, skip = null }) => {
    result.code = code; result.problems.push(code);
    if (systemic) { result.ok = false; result.classification = "RETURNS_FAILED"; } else result.classification = skip || code;
    finalizeOutcomes(result, plan, null, { skipped: code });
    if (!dryRun) await bestEffortStatus(writeStatus, result, plan, log);
    return result;
  };

  let plan;
  try { plan = await planReturnsRegionRun({ region, asOf, accountAllowlist, deps: pdeps }); }
  catch (e) {
    if (e && e.systemic) { log("systemic failure " + safeCode(e.code, "RETURNS_FAILED")); return finishSkipOrFail(null, { code: safeCode(e.code, "RETURNS_FAILED"), systemic: true }); }
    throw e;
  }
  result.plan = planSummary(plan);
  // the operator's --allow-shrink ids must be accounts of THIS run
  const shrink = new Set((Array.isArray(allowShrinkIds) ? allowShrinkIds : []).map((x) => S(x).trim()).filter(Boolean));
  const foreignShrink = [...shrink].filter((id) => !plan.regionAccounts.some((a) => a.accountId === id));
  if (foreignShrink.length) throw typed("RETURNS_ALLOW_SHRINK_NOT_IN_SCOPE", foreignShrink.length + " --allow-shrink account(s) are not accounts of this run");
  logPlan(plan, log);

  const exposure = returnsPlanExposure(plan.items, { maxCreates: cap });
  result.exposure = exposure;
  let balance = null;
  try { const b = await (deps.getDataDoeTokenBalance || getDataDoeTokenBalance)({ apiKey: plan.primaryConn.apiKey, fetchImpl }); balance = b && b.read === "ok" && Number.isFinite(b.usable) ? b.usable : null; } catch { balance = null; }
  result.balanceBefore = balance;
  log("PLAN: " + exposure.plannedCreates + " planned export(s) / " + exposure.expectedTokens + " token(s); cap " + (cap == null ? "-" : cap) + " create(s) / "
    + (cap == null ? "-" : cap * RETURNS_TOKENS_PER_CREATE) + " token(s); re-verify " + reverifyTargets(plan).length + "; balance " + (balance == null ? "UNREADABLE" : balance) + "; reserve " + reserve);

  const schemaBad = plan.schema.read !== "ok" || plan.schema.ok !== true;
  const schemaCode = plan.schema.read !== "ok" ? "RETURNS_SCHEMA_UNREADABLE" : "RETURNS_SCHEMA_DRIFT";
  if (schemaBad) log("schema preflight " + schemaCode + (plan.schema.read === "ok" ? " (missing columns " + plan.schema.missing + ", premium " + (plan.schema.premium ? "yes" : "no") + ")" : "") + " -- zero creates");
  if (dryRun) {
    if (schemaBad) result.problems.push(schemaCode);
    result.classification = "DRY_RUN";
    result.planned = plan.toExport.map((a) => ({ accountId: a.accountId, mode: a.mode, from: a.window.from, to: a.window.to }));
    result.reverifyPending = reverifyTargets(plan).map((a) => a.accountId);
    finalizeOutcomes(result, plan, null, { dryRun: true });
    return result;
  }
  if (schemaBad) return finishSkipOrFail(plan, { code: schemaCode });
  if (plan.statesRead === "missing" || plan.statesRead === "error") return finishSkipOrFail(plan, { code: plan.statesRead === "missing" ? "RETURNS_STATE_SCHEMA_MISSING" : "RETURNS_STATE_UNREADABLE", systemic: true });

  // ---- the run lease (before any re-verify / slot / persist) ----
  const acquire = deps.acquireReturnsRunLease || acquireReturnsRunLease;
  const renew = deps.renewReturnsRunLease || renewReturnsRunLease;
  const release = deps.releaseReturnsRunLease || releaseReturnsRunLease;
  let lease;
  try { lease = await acquire({ region, ownerToken, ttlSeconds: RETURNS_LEASE_TTL_SECONDS, runKey: key }); }
  catch (e) { return finishSkipOrFail(plan, { code: safeCode(e && e.returnsCode, "RETURNS_LEASE_UNAVAILABLE"), systemic: true }); }
  if (!lease || lease.granted !== true) {
    log("run lease held by another Returns run (expires " + S(lease && lease.expiresAt).slice(0, 25) + ") -- SKIP, zero creates");
    return finishSkipOrFail(plan, { code: "RETURNS_LEASE_HELD" });
  }
  const generation = lease.generation;
  result.executed = true;
  const ctx = makeRunContext({ region, asOf, plan, deps: pdeps, log, cap, reserve, adoptList, shrink, ownerToken, generation, runKey: key, renew, onRowsWritten, result });
  try {
    // the planning read predates the lease: re-read + re-decide under it BEFORE any confirm / slot claim / create
    await replanUnderLease(ctx);
    if (ctx.stop && ctx.stop.systemic) throw typed(ctx.stop.code, "state re-read under the run lease failed", { systemic: true });
    await reverifyLeftovers(ctx);
    if (ctx.stop && ctx.stop.systemic) throw typed(ctx.stop.code, "stopped during re-verify", { systemic: true });
    const p2 = ctx.plan;
    result.plan = planSummary(p2);
    result.exposure = returnsPlanExposure(p2.items, { maxCreates: cap });
    if (result.exposure.plannedCreates > cap) log("WARNING RETURNS_CAP_BELOW_PLAN: cap " + cap + " < " + result.exposure.plannedCreates + " planned export(s) -- the rest are budget-deferred (last-known-good kept)");
    p2.items.forEach((it, i) => log("  export " + (i + 1) + ": " + it.accountIds.length + " seller(s) " + it.mode + " [" + it.window.from + ".." + it.window.to + "]"));
    // ---- the main pass through the shared recovery engine ----
    ctx.engine = await runCampaignAdsBatchesWithRecovery({
      batches: p2.items.map((it) => ({ allowlist: it.accountIds, window: { from: it.window.from, to: it.window.to } })),
      runOne: (ids, depth, window) => runBatchRecorded(ctx, ids, window, { zeroCreate: false }),
      classifyError: classifyReturnsBatchError, grain: RETURNS_RUNNER_GRAIN, ceilingCode: RETURNS_CEILING_CODE, log,
    });
    // ---- ONE end-of-run zero-create pass: known export ids (failed GETs) + one fresh adopt-only listing (ambiguous) ----
    if (ctx.reconcileBatches.length && !(ctx.stop && ctx.stop.systemic)) await reconcilePass(ctx);
    if (ctx.stop && ctx.stop.systemic) { result.ok = false; result.code = ctx.stop.code; result.problems.push(ctx.stop.code); }
  } catch (e) {
    result.ok = false;
    result.code = safeCode(e && (e.returnsCode || e.code), "RETURNS_RUN_FAILED");
    result.problems.push(result.code);
    log("systemic failure " + result.code + " (" + safeCode(S(e && e.name).toUpperCase(), "ERROR") + ")");
  } finally {
    try { await release({ region, ownerToken, generation }); } catch { log("run lease release failed (it expires on its own)"); }
  }
  finalizeOutcomes(result, ctx.plan, ctx);
  await bestEffortStatus(writeStatus, result, ctx.plan, log);
  return result;
}

function emptyResult({ region, asOf, dryRun, maxCreates, reserveTokens, runKey, startedIso }) {
  return {
    region, asOf, mode: dryRun ? "dry-run" : "paid", runKey, startedIso, ok: true, executed: false, classification: null, code: null,
    creates: 0, reused: 0, reconciled: 0, tokens: 0, slotsRefused: 0, maxCreates, reserveTokens, balanceBefore: null, rowsWritten: false,
    outcomes: Object.fromEntries(RETURNS_OUTCOME_CATEGORIES.map((c) => [c, []])), accountCodes: {}, fragments: [],
    createdExportIds: [], adoptedExportIds: [], coverageGaps: [], crossAccount: { orders: 0, accountsAffected: 0 },
    anomalies: {}, rowFailures: {}, identityAmbiguous: 0, reverify: { attempted: 0, verified: 0, failed: 0, unreadable: 0 },
    exposure: null, plan: null, planned: [], reverifyPending: [], problems: [], diagnostics: {},
  };
}

function planSummary(plan) {
  return {
    regionAccounts: plan.regionAccounts.length, compatible: plan.compatible.length, incompatible: plan.incompatible.length,
    unassigned: plan.unassigned || 0, pending: plan.pending.length + plan.byKind.pending.length, held: plan.byKind.held.length,
    reverify: plan.byKind.reverify.length, initial: plan.byKind.initial.length, rolling: plan.byKind.rolling.length,
    skippedCurrent: plan.byKind["skipped-current"].length, plannedCreates: plan.items.length,
    windows: { initial: { from: plan.regionWindows.initial.from, to: plan.regionWindows.initial.to }, rolling: { from: plan.regionWindows.rolling.from, to: plan.regionWindows.rolling.to } },
    schema: plan.schema.read === "ok" ? (plan.schema.ok ? "ok" : "drift") : "unreadable",
  };
}

function logPlan(plan, log) {
  log(plan.regionAccounts.length + " export-eligible, " + plan.compatible.length + " Returns-compatible, " + plan.incompatible.length + " incompatible, "
    + plan.byKind.initial.length + " initial, " + plan.byKind.rolling.length + " rolling, " + plan.byKind["skipped-current"].length + " current, "
    + plan.byKind.reverify.length + " re-verify, " + plan.byKind.held.length + " held, " + (plan.pending.length + plan.byKind.pending.length) + " pending; "
    + "region windows initial [" + plan.regionWindows.initial.from + ".." + plan.regionWindows.initial.to + "] rolling [" + plan.regionWindows.rolling.from + ".." + plan.regionWindows.rolling.to + "]");
  for (const a of plan.toExport) log("  " + a.mode + " " + p8(a.accountId) + " (" + a.marketplace + ") [" + a.window.from + ".." + a.window.to + "]");
  for (const a of plan.incompatible) log("  incompatible " + p8(a.accountId) + " (" + a.marketplace + ") -- no Returns source on its DataDoe connection");
  for (const a of plan.pending) log("  pending " + p8(a.accountId) + " " + a.code);
  for (const a of plan.byKind.pending) log("  pending " + p8(a.accountId) + " " + safeCode(a.decision && a.decision.reason, "RETURNS_PENDING"));
  for (const a of plan.byKind.held) log("  held " + p8(a.accountId) + " " + safeCode(a.state && a.state.hold_reason, "RETURNS_HELD") + " (zero creates until the owner clears the hold)");
  for (const g of plan.coverageGaps) log("  RETURNS_COVERAGE_GAP " + p8(g.accountId) + " " + g.days + " day(s) older than the rolling window not covered (reported, never fetched)");
}

async function bestEffortStatus(writeStatus, result, plan, log) {
  try { await writeStatus(buildStatusEntry(result, plan)); }
  catch { log("run-status write failed (non-fatal)"); }
}

// ---- the run context: the guarded create pipeline + per-account bookkeeping -------------------------------------------

function makeRunContext({ region, asOf, plan, deps, log, cap, reserve, adoptList, shrink, ownerToken, generation, runKey, renew, onRowsWritten, result }) {
  return {
    region, asOf, plan, deps, log, cap, reserve, adoptList: adoptList !== false, shrink, ownerToken, generation, runKey, renewFn: renew, onRowsWritten, result,
    apiKey: plan.primaryConn.apiKey, orgFp: plan.organizationFingerprint,
    nowMs: deps.nowMs || (() => Date.now()),
    sleep: deps.sleep || defaultSleep,
    createFn: deps.createExport || PRODUCTION_ADS_SYNC_DEPS.createExport,
    downloadFn: deps.downloadExport || PRODUCTION_ADS_SYNC_DEPS.downloadExport,
    listFn: deps.listRecentExports || ((o) => listRecentExports(o)),
    claimFn: deps.claimReturnsCreateSlot || claimReturnsCreateSlot,
    balanceFn: deps.getDataDoeTokenBalance || getDataDoeTokenBalance,
    replaceFn: deps.replaceReturnsEventsWindow || replaceReturnsEventsWindow,
    countFn: deps.countReturnsEventsWindow || countReturnsEventsWindow,
    confirmFn: deps.confirmReturnsEventsWindow || confirmReturnsEventsWindow,
    failureFn: deps.recordReturnsWindowFailure || recordReturnsWindowFailure,
    statesFn: deps.getReturnsAccountStates || getReturnsAccountStates,
    coverageFn: deps.getSourceCoverageWindows || getSourceCoverageWindows,
    createTimeoutMs: deps.createTimeoutMs != null ? deps.createTimeoutMs : RETURNS_CREATE_TIMEOUT_MS,
    downloadTimeoutMs: deps.downloadTimeoutMs != null ? deps.downloadTimeoutMs : RETURNS_DOWNLOAD_TIMEOUT_MS,
    reconcileWaitMs: deps.reconcileWaitMs != null ? deps.reconcileWaitMs : RETURNS_RECONCILE_WAIT_MS,
    deadlineAtMs: deps.deadlineAtMs != null ? deps.deadlineAtMs : null,
    stop: null, listing: null, reconcileListing: null, reconcileCandidate: null,
    knownExports: new Map(),      // exportRequestIdentity(body) -> exportId (created or adopted this run)
    pageCache: new Map(),         // exportId -> { rowCount, rows | null, atCap } (validated pages only)
    adoptedIds: new Set(),
    reconcileBatches: [],         // [{ ids, window, why: "create" | "download" }] for the zero-create pass
    records: new Map(),           // accountId -> { category, code, stage: "export" | "persist" }
    deferReason: new Map(),       // accountId -> the stop code that budget-deferred it
    eventsByAccount: new Map(),   // accountId -> validated events (cross-account order collisions; counts only)
    anomalyInputs: [],            // per-account {code:count} anomaly objects (summarized; unknown keys fold to OTHER)
    failureInputs: [],            // per-account {code:count} row-failure objects of INVALID accounts
    engine: null,
  };
}

function record(ctx, accountId, category, code, stage) { ctx.records.set(S(accountId), { category, code: safeCode(code, "RETURNS_UNKNOWN"), stage }); }
const ceilingError = (code) => typed(RETURNS_CEILING_CODE, S(code) + " -- no further creates this run");

async function renewLease(ctx) {
  if (ctx.stop && ctx.stop.code === "RETURNS_LEASE_LOST") return false;
  let r = null;
  try { r = await ctx.renewFn({ region: ctx.region, ownerToken: ctx.ownerToken, generation: ctx.generation, ttlSeconds: RETURNS_LEASE_TTL_SECONDS }); } catch { r = null; }
  if (r && r.renewed === true) return true;
  ctx.stop = { code: "RETURNS_LEASE_LOST", systemic: true };
  ctx.log("run lease LOST -- no further creates or persists this run");
  return false;
}

// The exact create body, refused unless it is a Returns-only request inside the provider contract (fail closed BEFORE a
// slot is claimed or a POST is sent).
export function guardedReturnsBody(source, ids, from, to) {
  if (source !== RETURNS_PSEUDO_SOURCE) throw typed("RETURNS_SOURCE_MISMATCH", "the Returns runner only creates the Returns pseudo source", { guard: true });
  const body = buildAdsExportRequestBody(RETURNS_PSEUDO_SOURCE, ids, from, to, 0);
  if (body.sourceId !== RETURNS_SOURCE_ID) throw typed("RETURNS_SOURCE_MISMATCH", "sourceId is not RETURNS.id", { guard: true });
  if (!Array.isArray(body.sellerOrVendorIds) || body.sellerOrVendorIds.length < 1 || body.sellerOrVendorIds.length > RETURNS_MAX_SELLERS) throw typed("RETURNS_SELLER_LIMIT", "1.." + RETURNS_MAX_SELLERS + " sellers per export", { guard: true });
  if (body.limit !== RETURNS_EXPORT_ROW_LIMIT || body.limit !== EXPORT_LIMIT) throw typed("RETURNS_LIMIT_MISMATCH", "limit must be " + RETURNS_EXPORT_ROW_LIMIT, { guard: true });
  if (body.skip !== 0) throw typed("RETURNS_SKIP_MISMATCH", "skip must be 0", { guard: true });
  if (JSON.stringify(body.columns) !== JSON.stringify(RETURNS_EVENT_COLUMNS)) throw typed("RETURNS_COLUMNS_MISMATCH", "columns must be the 24 Returns event columns", { guard: true });
  if (body.groupBy !== undefined || body.aggregations !== undefined) throw typed("RETURNS_GRAIN_MISMATCH", "a Returns export is raw rows (no grouping)", { guard: true });
  if (!isDay(from) || !isDay(to) || from > to) throw typed("RETURNS_WINDOW_INVALID", "bad fragment window", { guard: true });
  return body;
}

async function listingFor(ctx, fresh) {
  const slot = fresh ? "reconcileListing" : "listing";
  if (ctx[slot] === null) {
    try { ctx[slot] = await ctx.listFn({ apiKey: ctx.apiKey, nowMs: ctx.nowMs(), fetchImpl: ctx.deps.fetchImpl }); }
    catch (e) { ctx[slot] = []; ctx.log("export reuse listing unavailable this pass (" + safeCode(e && e.code, "UNREADABLE") + ")"); }
    if (!Array.isArray(ctx[slot])) ctx[slot] = [];
  }
  return ctx[slot];
}

/**
 * ONE export for one fragment: reuse -> slot -> fresh balance -> guarded POST (main pass), or known id -> one fresh
 * adopt-only listing (zero-create pass). -> { exportId, via: "created" | "adopted" | "known", requestHash }. Throws the
 * ceiling code on every stop condition (the engine budget-defers the rest), a typed create error otherwise.
 */
async function obtainExport(ctx, ids, from, to, { zeroCreate }) {
  let body;
  try { body = guardedReturnsBody(RETURNS_PSEUDO_SOURCE, ids, from, to); }
  catch (e) { ctx.stop = { code: safeCode(e && e.code, "RETURNS_GUARD_REFUSED"), systemic: true }; throw ceilingError(ctx.stop.code); }
  const identity = exportRequestIdentity(body);
  const requestHash = returnsRequestHash(body);
  const known = ctx.knownExports.get(identity);
  if (known) return { exportId: known, via: "known", requestHash };
  if (zeroCreate) {
    if (ctx.adoptList) {
      const m = matchReusableExport({ exports: await listingFor(ctx, true), body, nowMs: ctx.nowMs() });
      if (m.disposition === "adopt") { ctx.knownExports.set(identity, m.exportId); ctx.adoptedIds.add(m.exportId); ctx.result.reused += 1; return { exportId: m.exportId, via: "adopted", requestHash }; }
    }
    throw typed("RETURNS_RECONCILE_NO_EXPORT", "no known or reusable export for this fragment (zero-create pass)", { returnsStage: "reconcile" });
  }
  if (ctx.stop) throw ceilingError(ctx.stop.code);
  if (pastDeadline(ctx)) { ctx.stop = { code: "RETURNS_DEADLINE", systemic: false }; throw ceilingError("RETURNS_DEADLINE"); }
  if (ctx.adoptList) {
    const m = matchReusableExport({ exports: await listingFor(ctx, false), body, nowMs: ctx.nowMs(), exclude: ctx.adoptedIds });
    if (m.disposition === "adopt") {
      ctx.knownExports.set(identity, m.exportId); ctx.adoptedIds.add(m.exportId); ctx.result.reused += 1;
      ctx.log("reused completed export " + p8(m.exportId) + " [" + from + ".." + to + "] (zero tokens, no slot)");
      return { exportId: m.exportId, via: "adopted", requestHash };
    }
  }
  if (!(await renewLease(ctx))) throw ceilingError("RETURNS_LEASE_LOST");
  let slot;
  try { slot = await ctx.claimFn({ region: ctx.region, asOf: ctx.asOf, maxCreates: ctx.cap, ownerToken: ctx.ownerToken, generation: ctx.generation, runKey: ctx.runKey, requestHash }); }
  catch (e) {
    const code = S(e && e.returnsCode) === "RETURNS_LEASE_LOST" ? "RETURNS_LEASE_LOST" : "RETURNS_SLOT_UNAVAILABLE";
    ctx.stop = { code, systemic: true };
    ctx.log("create slot claim FAILED (" + code + ") -- no further creates");
    throw ceilingError(code);
  }
  if (!slot || slot.granted !== true) {
    ctx.result.slotsRefused += 1;
    ctx.stop = { code: RETURNS_CEILING_CODE, systemic: false };
    ctx.log("create slot REFUSED (" + (slot ? Number(slot.claimed) + "/" + Number(slot.max) : "-") + " claimed for this region today (UTC)) -- the rest are budget-deferred");
    throw ceilingError(RETURNS_CEILING_CODE);
  }
  let bal = null;
  try { bal = await ctx.balanceFn({ apiKey: ctx.apiKey, fetchImpl: ctx.deps.fetchImpl }); } catch { bal = null; }
  if (!bal || bal.read !== "ok" || !Number.isFinite(bal.usable)) { ctx.stop = { code: "RETURNS_BALANCE_UNREADABLE", systemic: false }; ctx.log("token balance UNREADABLE -- no further creates (fail closed)"); throw ceilingError("RETURNS_BALANCE_UNREADABLE"); }
  const claimed = Number(slot.claimed); const max = Number(slot.max);
  const remaining = Number.isFinite(claimed) && Number.isFinite(max) ? Math.max(1, max - claimed + 1) : Math.max(1, ctx.cap - ctx.result.creates);
  if (bal.usable - remaining * RETURNS_TOKENS_PER_CREATE < ctx.reserve) {
    ctx.stop = { code: "RETURNS_TOKEN_RESERVE", systemic: false };
    ctx.log("token reserve: balance " + bal.usable + " - " + remaining + " remaining create(s) x " + RETURNS_TOKENS_PER_CREATE + " < reserve " + ctx.reserve + " -- no further creates");
    throw ceilingError("RETURNS_TOKEN_RESERVE");
  }
  ctx.result.creates += 1;
  let created;
  try {
    created = await withDeadline(ctx.createFn(ctx.apiKey, RETURNS_PSEUDO_SOURCE, ids, from, to, 0), ctx.createTimeoutMs,
      () => Object.assign(new Error("DataDoe returns-events create timeout"), { sourceStage: "create", network: true }));
  } catch (e) {
    // an ambiguous / server-side create (network, timeout, 5xx, untyped) may have landed: reconcile it adopt-only, never re-POST
    const st = Number(e && e.httpStatus);
    if ((e && e.network === true) || !Number.isFinite(st) || st >= 500) ctx.reconcileCandidate = { why: "create" };
    throw e;
  }
  const exportId = S(created && (created.exportId || created.id));
  if (!exportId) { ctx.reconcileCandidate = { why: "create" }; throw Object.assign(new Error("DataDoe returns-events create returned no export id"), { sourceStage: "create", network: true }); }
  ctx.knownExports.set(identity, exportId);
  ctx.result.createdExportIds.push(exportId);
  return { exportId, via: "created", requestHash };
}

// The strict page of one export (cached per export id within the run; a capped page keeps no rows). The shape check
// requires only the NOT-NULL spec columns (RETURNS_SHAPE_SOURCE); the zero-create pass starts no GET past the deadline.
async function pageOf(ctx, exportId, from, to, opts = {}) {
  const cached = ctx.pageCache.get(exportId);
  if (cached) return cached;
  if (opts.zeroCreate && pastDeadline(ctx)) {
    throw typed("RETURNS_DEADLINE", "the run deadline passed before this download (the zero-create pass stops)", { returnsStage: "reconcile", deadline: true });
  }
  let page;
  try {
    page = await withDeadline(ctx.downloadFn(ctx.apiKey, exportId), ctx.downloadTimeoutMs,
      () => Object.assign(new Error("DataDoe returns-events download timeout"), { sourceStage: "download", network: true }));
  } catch {
    ctx.reconcileCandidate = { why: "download" };
    throw typed("RETURNS_DOWNLOAD_FAILED", "status / download GET failed (export id kept for the GET-only retry)", { returnsStage: "download" });
  }
  let rows;
  try { rows = validateSplitWindowPage(page, from, to, RETURNS_SHAPE_SOURCE); }
  catch (e) {
    const code = returnsPageCode(e);
    throw typed(code, "page rejected (fail closed; not persisted)", { returnsStage: code === "RETURNS_HISTORY_LOADING" ? "loading" : SPLIT_PAGE_CODES.has(code) ? "split" : "export" });
  }
  const atCap = Number(page.rowCount) >= EXPORT_LIMIT;
  const entry = { rowCount: Number(page.rowCount), rows: atCap ? null : rows, atCap };
  ctx.pageCache.set(exportId, entry);
  return entry;
}

/**
 * The COMPLETE [from,to] window of one <=5-seller batch: one export per fragment; a fragment at the row limit is discarded
 * and bisected (each half a new create within the cap); a single day still at the limit fails closed. Returns the rows
 * (each tagged with its fragment) and the disjoint, contiguous fragments.
 */
async function fetchReturnsWindow(ctx, ids, window, opts) {
  const fragments = [];
  const rows = [];
  const fetchFragment = async (f, t) => {
    const ex = await obtainExport(ctx, ids, f, t, opts);
    const page = await pageOf(ctx, ex.exportId, f, t, opts);
    if (page.atCap) {
      const halves = bisectDateWindow(f, t);
      if (!halves) throw typed("RETURNS_DAY_AT_ROW_LIMIT", "a single-day fragment returned the full row limit (fail closed; not persisted)", { returnsStage: "export" });
      ctx.log("fragment [" + f + ".." + t + "] at the " + EXPORT_LIMIT + "-row limit -> bisect (never persisted)");
      for (const h of halves) await fetchFragment(h.from, h.to);
      return;
    }
    const frag = { from: f, to: t, rowCount: page.rowCount, exportId: ex.exportId, requestHash: ex.requestHash, via: ex.via, sellers: ids.length };
    fragments.push(frag);
    for (const row of page.rows) rows.push({ row, frag });
  };
  await fetchFragment(window.from, window.to);
  fragments.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  return { rows, fragments };
}

// runOne for the recovery engine: records the per-account reason of a failed batch (and whether the zero-create pass may
// recover it) before the engine classifies it.
async function runBatchRecorded(ctx, ids, window, opts) {
  ctx.reconcileCandidate = null;
  try { return await runBatch(ctx, ids, window, opts); }
  catch (e) {
    if (e && e.code === RETURNS_CEILING_CODE) { for (const id of ids) ctx.deferReason.set(S(id), ctx.stop ? ctx.stop.code : RETURNS_CEILING_CODE); throw e; }
    const why = ctx.reconcileCandidate && ctx.reconcileCandidate.why;
    if (!opts.zeroCreate && why) ctx.reconcileBatches.push({ ids: ids.map(S), window: { from: window.from, to: window.to }, why });
    const stage = e && e.returnsStage;
    // 'loading' / 'split' on a multi-seller batch: the engine splits it and the halves record their own outcomes
    if (stage === "loading") { if (ids.length === 1) record(ctx, ids[0], "incomplete", "RETURNS_HISTORY_LOADING", "export"); }
    else if (stage === "split") { if (ids.length === 1) record(ctx, ids[0], "failed", safeCode(e.returnsCode, "RETURNS_EXPORT_FAILED"), "export"); }
    else if (stage === "export") for (const id of ids) record(ctx, id, "failed", safeCode(e.returnsCode, "RETURNS_EXPORT_FAILED"), "export");
    else if (stage === "download") for (const id of ids) record(ctx, id, "failed", "RETURNS_DOWNLOAD_FAILED", "export");
    else if (stage !== "reconcile") for (const id of ids) record(ctx, id, "incomplete", why === "create" ? "RETURNS_CREATE_UNCONFIRMED" : "RETURNS_EXPORT_TRANSIENT", "export");
    throw e;
  }
}

// One batch: fetch every fragment, partition the rows by seller, validate each account, persist the valid ones (an invalid
// account fails ALONE). Returns the engine summary (accounts that did not end verified are listed as failed for the grain).
async function runBatch(ctx, ids, window, opts) {
  const fetched = await fetchReturnsWindow(ctx, ids, window, opts);
  const bySeller = new Map(ids.map((id) => [S(id), []]));
  let foreign = 0;
  for (const x of fetched.rows) {
    const seller = S(x.row && x.row.seller_or_vendor_id).trim();
    if (bySeller.has(seller)) bySeller.get(seller).push(x); else foreign += 1;
  }
  if (foreign) throw typed("RETURNS_SELLER_NOT_IN_BATCH", foreign + " row(s) belong to no seller of this export (fail closed; batch not persisted)", { returnsStage: "export" });
  for (const f of fetched.fragments) ctx.result.fragments.push({ ...f });
  const fetchedAtIso = new Date(ctx.nowMs()).toISOString();
  const failedAccounts = [];
  for (const id of ids) {
    const acct = ctx.plan.accountsById.get(S(id));
    const list = bySeller.get(S(id)) || [];
    const meta = list.map((x) => ({ sourceRequestHash: x.frag.requestHash, exportId: x.frag.exportId }));
    const metaByRow = new Map(list.map((x, i) => [x.row, meta[i]]));
    let v;
    try {
      v = validateAccountRows({
        rows: list.map((x) => x.row), accountId: S(id), sellerId: S(id), marketplace: acct.marketplace, from: window.from, to: window.to,
        fragmentOf: (row, i) => (Number.isInteger(i) && meta[i] ? meta[i] : metaByRow.get(row) || null),
      });
    } catch { v = { ok: false, code: "RETURNS_VALIDATION_FAILED" }; }
    if (v && v.anomalies) ctx.anomalyInputs.push(v.anomalies);
    if (v && v.ok !== true && v.failures) ctx.failureInputs.push(v.failures);
    const mode = acct.decision.kind;
    if (!v || v.ok !== true) {
      const code = safeCode(v && v.code, "RETURNS_VALIDATION_FAILED");
      record(ctx, id, "failed", code, "persist");
      ctx.log("account INVALID " + p8(id) + " " + code + " (fails alone; nothing written; last-known-good kept)");
      await recordFailure(ctx, acct, mode, window, code, { rows: list.length, stage: "validation" });
      failedAccounts.push(S(id));
      continue;
    }
    ctx.eventsByAccount.set(S(id), v.events);
    const ok = await persistAccount(ctx, acct, mode, window, v, fetched.fragments, fetchedAtIso);
    if (!ok) failedAccounts.push(S(id));
  }
  return { status: "completed", sources: { [RETURNS_RUNNER_GRAIN]: { failedAccounts } } };
}

async function recordFailure(ctx, acct, mode, window, code, detail) {
  if (ctx.stop && ctx.stop.code === "RETURNS_LEASE_LOST") return;
  try {
    await ctx.failureFn({
      organizationFingerprint: ctx.orgFp, connectionId: "primary", accountId: acct.accountId, marketplace: acct.marketplace,
      mode: mode === "rolling" ? "rolling" : "initial", from: window.from, to: window.to, errorCode: safeCode(code, "RETURNS_FAILED"),
      detail: countsOnly(detail), runKey: ctx.runKey, region: ctx.region,
    });
  } catch { ctx.log("failure record for " + p8(acct.accountId) + " not written (non-fatal; " + safeCode(code, "RETURNS_FAILED") + ")"); }
}

// A detail object reduced to safe counts / booleans / typed codes / dates (anything else is dropped).
export function countsOnly(detail) {
  const out = {};
  for (const [k, v] of Object.entries(detail && typeof detail === "object" ? detail : {})) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(k)) continue;
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    else if (typeof v === "boolean") out[k] = v;
    else if (typeof v === "string" && (SAFE_CODE.test(v) || isDay(v) || /^[a-z][a-z-]{0,31}$/.test(v))) out[k] = v;
  }
  return out;
}

// A replace error PROVES a rollback only when the database answered with a typed refusal (.returnsCode) or a PostgREST
// (PGRSTnnn) / SQLSTATE code on an HTTP response. A transport failure, a gateway 5xx without a code, a malformed 2xx
// (RETURNS_RPC_RESPONSE_INVALID -- the call may well have committed), SQLSTATE 40003 (statement_completion_unknown) or
// a class-08 connection exception leave the outcome UNKNOWN.
function isDefinitiveRollback(error) {
  const e = error || {};
  if (typeof e.returnsCode === "string" && SAFE_CODE.test(e.returnsCode)) return true;
  const c = S(e.code);
  if (!Number.isInteger(e.status)) return false;
  if (/^PGRST[0-9]{3}$/.test(c)) return true;
  return /^[0-9A-Z]{5}$/.test(c) && c !== "40003" && !c.startsWith("08");
}

async function persistAccount(ctx, acct, mode, window, v, fragments, fetchedAtIso) {
  const id = acct.accountId;
  if (!(await renewLease(ctx))) { record(ctx, id, "incomplete", "RETURNS_LEASE_LOST", "persist"); return false; }
  const requestHashes = uniq(fragments.map((f) => f.requestHash)).sort();
  const exportIds = uniq(fragments.map((f) => f.exportId).filter(Boolean));
  const identity = v.identity && typeof v.identity === "object" ? v.identity : { status: "clear", detail: {} };
  const identityStatus = identity.status === "ambiguous" ? "ambiguous" : "clear";
  if (identityStatus === "ambiguous") ctx.result.identityAmbiguous += 1;
  try {
    await ctx.replaceFn({
      organizationFingerprint: ctx.orgFp, connectionId: "primary", accountId: id, sellerOrVendorId: id, marketplace: acct.marketplace,
      from: window.from, to: window.to, mode, events: v.events, expectedCount: v.expectedCount, expectedUnits: v.expectedUnits,
      requestHashes, exportIds, fragmentRows: fragments.map((f) => f.rowCount), sourceRefreshedAt: fetchedAtIso,
      attribution: RETURNS_ATTRIBUTION, allowShrink: ctx.shrink.has(id), identityStatus, identityDetail: countsOnly(identity.detail),
      ownerToken: ctx.ownerToken, generation: ctx.generation, runKey: ctx.runKey, region: ctx.region,
    });
  } catch (e) {
    const code = safeCode(e && e.returnsCode, "RETURNS_PERSIST_FAILED");
    if (code === "RETURNS_LEASE_LOST") { ctx.stop = { code, systemic: true }; record(ctx, id, "incomplete", code, "persist"); return false; }
    if (!isDefinitiveRollback(e)) {
      // The replace may have COMMITTED: write NOTHING (a failure row would erase the 'replaced' evidence). The next run
      // reads either last_status 'replaced' (zero-token re-verify) or the untouched previous state (re-planned).
      record(ctx, id, "pending", "RETURNS_PERSIST_UNCONFIRMED", "persist");
      ctx.log("persist outcome UNKNOWN " + p8(id) + " RETURNS_PERSIST_UNCONFIRMED (no state write; settled by the next run at zero tokens)");
      return false;
    }
    record(ctx, id, "failed", code, "persist");
    ctx.log("persist REFUSED " + p8(id) + " " + code + " (whole transaction rolled back; last-known-good kept)");
    await recordFailure(ctx, acct, mode, window, code, { expectedCount: Number(v.expectedCount) || 0, stage: "persist" });
    return false;
  }
  if (!ctx.result.rowsWritten) { ctx.result.rowsWritten = true; if (typeof ctx.onRowsWritten === "function") { try { ctx.onRowsWritten(); } catch { /* best effort */ } } }
  const ver = await verifyPersisted(ctx, acct, { from: window.from, to: window.to, mode, expectedCount: v.expectedCount, expectedUnits: v.expectedUnits, requestHashes });
  if (ver.status === "verified") {
    const held = identityStatus === "ambiguous";
    record(ctx, id, held ? "held" : (mode === "initial" ? "initial-loaded" : "daily-refreshed"), held ? "RETURNS_IDENTITY_AMBIGUOUS" : (mode === "initial" ? "RETURNS_INITIAL_LOADED" : "RETURNS_DAILY_REFRESHED"), "persist");
    ctx.log((held ? "HELD " : "persisted ") + p8(id) + " " + mode + " [" + window.from + ".." + window.to + "] " + Number(v.expectedCount) + " event(s)" + (held ? " RETURNS_IDENTITY_AMBIGUOUS (every row kept, reported, not complete)" : ""));
    return true;
  }
  record(ctx, id, ver.status === "unreadable" ? "pending" : "failed", ver.code, "persist");
  ctx.log("verify " + p8(id) + " " + ver.code + (ver.status === "unreadable" ? " (re-verified next run at zero tokens)" : ""));
  return false;
}

// The INDEPENDENT read-back (count) then the post-commit confirm. A read error is never a verify failure. A count that
// disagrees STILL runs the confirm -- the server recounts the committed window under the account lock and, on its own
// mismatch, fails the state and cuts the window's coverage -- and the account fails RETURNS_READBACK_MISMATCH whatever
// the confirm says. Never a failure write here: the state carries the confirm's verdict, or (a lost confirm) the
// 'replaced' evidence the next run re-verifies at zero tokens.
async function verifyPersisted(ctx, acct, { from, to, mode, expectedCount, expectedUnits, requestHashes }) {
  let cnt = null;
  try { cnt = await ctx.countFn({ organizationFingerprint: ctx.orgFp, connectionId: "primary", accountId: acct.accountId, from, to }); } catch { cnt = null; }
  if (!cnt || cnt.read !== "ok" || !Number.isInteger(Number(cnt.count))) return { status: "unreadable", code: "RETURNS_VERIFY_UNREADABLE" };
  const readBackMismatch = Number(cnt.count) !== Number(expectedCount);
  let conf = null;
  try {
    conf = await ctx.confirmFn({ organizationFingerprint: ctx.orgFp, connectionId: "primary", accountId: acct.accountId, from, to, mode: mode === "rolling" ? "rolling" : "initial",
      expectedCount: Number(expectedCount), expectedUnits: Number(expectedUnits), requestHashes, runKey: ctx.runKey, region: ctx.region });
  } catch (e) {
    if (readBackMismatch) return { status: "mismatch", code: "RETURNS_READBACK_MISMATCH" };
    return { status: "unreadable", code: S(e && e.returnsCode) ? "RETURNS_CONFIRM_REJECTED" : "RETURNS_VERIFY_UNREADABLE" };
  }
  if (readBackMismatch) {
    ctx.log("read-back " + p8(acct.accountId) + " " + Number(cnt.count) + " vs " + Number(expectedCount) + " expected; server confirm " + safeCode(S(conf && conf.reason).toUpperCase(), "UNKNOWN"));
    return { status: "mismatch", code: "RETURNS_READBACK_MISMATCH" };
  }
  if (conf && conf.verified === true) return { status: "verified", code: null };
  if (conf && S(conf.reason) === "superseded") return { status: "superseded", code: "RETURNS_VERIFY_SUPERSEDED" };
  return { status: "mismatch", code: "RETURNS_VERIFY_MISMATCH" };
}

// ONE paged state read for `accounts` + each one's 'returns' coverage -> their decided mode again (the planner's rules;
// an unreadable coverage fails that account closed). -> { read: 'ok', decided } | { read: 'missing' | 'error' }.
async function readDecisions(ctx, accounts) {
  let st = null;
  try { st = await ctx.statesFn({ organizationFingerprint: ctx.orgFp, connectionId: "primary", accountIds: accounts.map((a) => a.accountId) }); } catch { st = null; }
  if (!st || st.read !== "ok") return { read: st && st.read === "missing" ? "missing" : "error" };
  const fresh = new Map();
  for (const row of st.rows || []) if (row && S(row.account_id)) fresh.set(S(row.account_id), row);
  const decided = [];
  for (const a of accounts) {
    let cov = null;
    try { cov = await ctx.coverageFn({ organizationFingerprint: ctx.orgFp, connectionId: "primary", accountId: a.accountId, sourceKey: RETURNS_EVENT_SOURCE_KEY }); } catch { cov = null; }
    const state = fresh.get(a.accountId) || null;
    const coverage = normalizeCoverageRead(cov);
    let decision = null;
    try { decision = decideAccountMode({ d1: a.d1, state, coverage }); } catch { decision = null; }
    if (!decision || typeof decision !== "object") decision = { kind: "pending", window: null, reason: "RETURNS_MODE_UNDECIDABLE", gapDays: 0 };
    decided.push({ ...a, state, coverage, decision });
  }
  return { read: "ok", decided };
}

// The planning read happened BEFORE the lease, so an overlapping run (or an operator release) may have moved any account
// since: under the lease, before any confirm / slot claim / create, re-read EVERY decided account and plan again from
// what the database says now. An unreadable re-read stops the run (systemic, fail closed -- nothing was spent).
async function replanUnderLease(ctx) {
  const plan = ctx.plan;
  if (!plan.decided.length) return;
  const r = await readDecisions(ctx, plan.decided);
  if (r.read !== "ok") {
    ctx.stop = { code: r.read === "missing" ? "RETURNS_STATE_SCHEMA_MISSING" : "RETURNS_STATE_UNREADABLE", systemic: true };
    ctx.log("state re-read under the run lease FAILED (" + ctx.stop.code + ") -- zero creates");
    return;
  }
  ctx.plan = finishPlan({ ...plan, decided: r.decided });
  const moved = r.decided.filter((a, i) => a.decision.kind !== plan.decided[i].decision.kind).length;
  if (moved) ctx.log("re-read under the run lease: " + moved + " account(s) changed mode since planning (re-planned)");
}

// ZERO-TOKEN re-verify of every account a previous run left in last_status 'replaced', then a re-read + re-decision.
// DESIGN 1.7 names EVERY such account, so a HELD one is included too: the hold wins the mode decision, but a crash between
// its replace and its confirm would otherwise leave an ambiguous initial's window coverage in place indefinitely (the
// confirm is what removes it). A held account stays held after its re-verify (zero creates either way).
function reverifyTargets(plan) {
  return [...plan.byKind.reverify, ...plan.byKind.held.filter((a) => a.state && S(a.state.last_status) === "replaced")];
}
async function reverifyLeftovers(ctx) {
  const plan = ctx.plan;
  const targets = reverifyTargets(plan);
  if (!targets.length) return;
  const touched = new Set();
  for (const a of targets) {
    const st = a.state || {};
    const from = S(st.last_window_from).slice(0, 10); const to = S(st.last_window_to).slice(0, 10);
    ctx.result.reverify.attempted += 1;
    if (!isDay(from) || !isDay(to) || !Array.isArray(st.last_request_hashes) || !st.last_request_hashes.length) { ctx.result.reverify.unreadable += 1; continue; }
    if (!(await renewLease(ctx))) return;
    const ver = await verifyPersisted(ctx, a, {
      from, to, mode: st.last_mode === "rolling" ? "rolling" : "initial", expectedCount: Number(st.last_event_count) || 0,
      expectedUnits: Number(st.last_unit_sum) || 0, requestHashes: st.last_request_hashes.map(S),
    });
    if (ver.status === "verified") ctx.result.reverify.verified += 1;
    else if (ver.status === "unreadable") ctx.result.reverify.unreadable += 1;
    else ctx.result.reverify.failed += 1;
    ctx.log("re-verify " + p8(a.accountId) + " [" + from + ".." + to + "] " + (ver.status === "verified" ? "verified (zero tokens)" : ver.code));
    touched.add(a.accountId);
  }
  if (touched.size) {
    // re-read the touched accounts' state + coverage and decide again (fail closed: unreadable / unresolved -> pending)
    const r = await readDecisions(ctx, plan.decided.filter((a) => touched.has(a.accountId)));
    const byId = new Map((r.decided || []).map((a) => [a.accountId, a]));
    const decided = plan.decided.map((a) => {
      if (!touched.has(a.accountId)) return a;
      if (r.read !== "ok") return { ...a, decision: { kind: "pending", window: null, reason: "RETURNS_STATE_UNREADABLE", gapDays: 0 } };
      const d = byId.get(a.accountId);
      return d.decision.kind === "reverify" ? { ...d, decision: { kind: "pending", window: null, reason: "RETURNS_REVERIFY_UNRESOLVED", gapDays: 0 } } : d;
    });
    ctx.plan = finishPlan({ ...plan, decided });
  }
  // anything still marked 'reverify' (an unusable recorded window) is excluded as pending this run
  if (ctx.plan.byKind.reverify.length) {
    ctx.plan = finishPlan({ ...ctx.plan, decided: ctx.plan.decided.map((a) => (a.decision.kind === "reverify" ? { ...a, decision: { kind: "pending", window: null, reason: "RETURNS_REVERIFY_UNRESOLVED", gapDays: 0 } } : a)) });
  }
}

// The ONE end-of-run zero-create pass (no slot, no POST): a batch whose status / download GET failed re-reads its KNOWN
// export ids; a batch whose create was ambiguous may adopt an exact completed export from ONE fresh listing. The run
// deadline is checked before each batch and (pageOf) before each download: past it the pass stops cleanly and every
// remaining batch keeps its main-pass outcome.
async function reconcilePass(ctx) {
  const batches = [];
  const seen = new Set();
  for (const b of ctx.reconcileBatches) {
    if (b.why === "create" && !ctx.adoptList) continue; // nothing to adopt without the listing
    const k = b.ids.join(",") + "|" + b.window.from + ".." + b.window.to;
    if (!seen.has(k)) { seen.add(k); batches.push(b); }
  }
  if (!batches.length) return;
  if (batches.some((b) => b.why === "create") && ctx.reconcileWaitMs > 0) await ctx.sleep(ctx.reconcileWaitMs);
  ctx.log("zero-create reconcile pass over " + batches.length + " batch(es) (known export ids" + (ctx.adoptList ? " + one fresh adopt-only listing" : "") + "; no slot, no POST)");
  const stopAtDeadline = () => ctx.log("run deadline reached -- the zero-create pass stops (the remaining batch(es) keep their main-pass outcome)");
  for (const b of batches) {
    if (ctx.stop && ctx.stop.systemic) return;
    if (pastDeadline(ctx)) { stopAtDeadline(); return; }
    // Renew BEFORE each batch's GETs: several slow downloads must never outlive the lease (a lost lease stops the pass;
    // every remaining batch keeps its main-pass outcome and LKG).
    if (!(await renewLease(ctx))) return;
    try {
      const summary = await runBatchRecorded(ctx, b.ids, b.window, { zeroCreate: true });
      const failed = new Set(((((summary || {}).sources || {})[RETURNS_RUNNER_GRAIN] || {}).failedAccounts || []).map(S));
      for (const id of b.ids) if (!failed.has(S(id))) ctx.result.reconciled += 1;
    } catch (e) {
      // the batch keeps its main-pass outcome; a download refused at the deadline ends the pass
      if (e && e.deadline === true) { stopAtDeadline(); return; }
    }
  }
}

// ---- outcomes, payloads, status ----------------------------------------------------------------------------------------

function finalizeOutcomes(result, plan, ctx, { dryRun = false, skipped = null } = {}) {
  const out = Object.fromEntries(RETURNS_OUTCOME_CATEGORIES.map((c) => [c, []]));
  const codes = {};
  const put = (id, category, code) => { out[category].push(S(id)); codes[S(id)] = safeCode(code, "RETURNS_UNKNOWN"); };
  if (plan) {
    for (const a of plan.incompatible) put(a.accountId, "incompatible", a.code || "RETURNS_SOURCE_INCOMPATIBLE");
    for (const a of plan.pending) put(a.accountId, "pending", a.code || "RETURNS_PENDING");
    const engine = ctx && ctx.engine;
    const rejected = new Set(((engine && engine.rejected) || []).map(S));
    const ambiguous = new Set(((engine && engine.ambiguous) || []).map(S));
    const deferred = new Set(((engine && engine.budgetDeferred) || []).map(S));
    const deferCode = (id) => { const c = ctx.deferReason.get(id) || (ctx.stop && ctx.stop.code) || RETURNS_CEILING_CODE; return c === RETURNS_CEILING_CODE ? "RETURNS_BUDGET_DEFERRED" : c; };
    for (const a of plan.decided) {
      const id = a.accountId; const kind = a.decision.kind;
      if (kind === "pending") { put(id, "pending", safeCode(a.decision.reason, "RETURNS_PENDING")); continue; }
      if (kind === "held") { put(id, "held", safeCode(a.state && a.state.hold_reason, "RETURNS_HELD")); continue; }
      if (kind === "skipped-current") { put(id, "skipped-current", "RETURNS_ALREADY_CURRENT"); continue; }
      if (dryRun) continue; // planned / re-verify accounts are listed in result.planned / result.reverifyPending
      if (kind === "reverify") { put(id, "pending", "RETURNS_REVERIFY_PENDING"); continue; }
      if (!ctx) { put(id, "incomplete", skipped || result.code || "RETURNS_NOT_RUN"); continue; }
      const rec = ctx.records.get(id);
      if (rec && rec.stage === "persist") { put(id, rec.category, rec.code); continue; }
      if (rejected.has(id)) { put(id, "failed", "RETURNS_EXPORT_REJECTED"); continue; }
      if (deferred.has(id)) { put(id, "incomplete", deferCode(id)); continue; }
      if (ambiguous.has(id)) { put(id, "incomplete", "RETURNS_CREATE_AMBIGUOUS"); continue; }
      if (rec) { put(id, rec.category, rec.code); continue; }
      put(id, "incomplete", ctx.stop ? ctx.stop.code : "RETURNS_EXPORT_TRANSIENT");
    }
    result.coverageGaps = plan.coverageGaps.map((g) => ({ accountId: g.accountId, days: g.days }));
  }
  result.outcomes = out;
  result.accountCodes = codes;
  if (ctx) {
    try { result.anomalies = summarizeAnomalies(...ctx.anomalyInputs); } catch { result.anomalies = {}; }
    try { result.rowFailures = summarizeAnomalies(...ctx.failureInputs); } catch { result.rowFailures = {}; }
    result.adoptedExportIds = [...ctx.adoptedIds];
    try { const c = crossAccountOrderCollisions(ctx.eventsByAccount); result.crossAccount = { orders: Number(c && c.orders) || 0, accountsAffected: Number(c && c.accountsAffected) || 0 }; }
    catch { result.crossAccount = { orders: 0, accountsAffected: 0 }; }
    const diag = {};
    for (const d of ((ctx.engine && ctx.engine.diagnostics) || [])) { const k = safeCode(d && d.classification, "OTHER"); diag[k] = (diag[k] || 0) + 1; }
    result.diagnostics = diag;
  }
  result.tokens = result.creates * RETURNS_TOKENS_PER_CREATE;
  if (!result.classification) {
    if (!result.ok) result.classification = "RETURNS_FAILED";
    else {
      const notDone = ["held", "incomplete", "failed", "pending"].some((c) => out[c].length);
      // nothing refreshed and every planned account stopped by the token gate -> the typed reserve skip
      const stopCodes = new Set(out.incomplete.map((id) => codes[id]));
      const reserveOnly = !result.creates && out.incomplete.length > 0 && !out["initial-loaded"].length && !out["daily-refreshed"].length
        && stopCodes.size === 1 && (stopCodes.has("RETURNS_TOKEN_RESERVE") || stopCodes.has("RETURNS_BALANCE_UNREADABLE"));
      result.classification = reserveOnly ? [...stopCodes][0] : (notDone ? "PARTIAL" : "COMPLETE");
      if (reserveOnly && !result.code) result.code = result.classification;
    }
  }
}

/**
 * The source_run_status entry for one region run (counts / codes / dates only). A typed skip or a failure before any
 * account was attempted writes a MINIMAL entry (status + code + attempt time; the previous counts stay untouched); an
 * executed run goes through the core's returnsRunStatusEntry (falling back to the runner's own entry only when the
 * helper is unavailable or returns a malformed entry). The run's typed code always wins.
 */
export function buildStatusEntry(result, plan) {
  const r = result || {};
  const nowIso = r.startedIso || new Date().toISOString();
  if (!plan || r.executed !== true || RETURNS_SKIP_CLASSIFICATIONS.includes(r.classification)) return minimalStatusEntry({ region: r.region, code: r.code || r.classification || "RETURNS_FAILED", lastStatus: r.classification === "RETURNS_LEASE_HELD" ? "partial" : "failed", nowIso, stage: r.ok === false ? "run" : "preflight" });
  const o = r.outcomes || {};
  const ids = (k) => (o[k] || []).slice();
  const outcome = {
    systemic: r.ok === false, code: r.code || null, classification: r.classification, creates: Number(r.creates) || 0, tokens: Number(r.tokens) || 0,
    outcomes: Object.fromEntries(RETURNS_OUTCOME_CATEGORIES.map((c) => [c, ids(c)])),
    initialLoaded: ids("initial-loaded"), dailyRefreshed: ids("daily-refreshed"), skippedCurrent: ids("skipped-current"),
    held: ids("held"), incomplete: ids("incomplete"), failed: ids("failed"), pending: ids("pending"), incompatible: ids("incompatible"),
    coverageGap: { accounts: (r.coverageGaps || []).length, days: (r.coverageGaps || []).reduce((t, g) => t + (Number(g.days) || 0), 0) },
  };
  const planArg = {
    region: plan.region, asOf: plan.asOf, windows: plan.regionWindows, regionAccounts: plan.regionAccounts, compatible: plan.compatible,
    incompatible: plan.incompatible, items: plan.items, covered: plan.byKind["skipped-current"], unreadable: plan.pending,
    pending: plan.pending, held: plan.byKind.held, byKind: plan.byKind,
  };
  let entry = null;
  try { entry = returnsRunStatusEntry({ region: r.region, plan: planArg, outcome, maxCreates: r.maxCreates == null ? null : r.maxCreates, nowIso }); } catch { entry = null; }
  if (!entry || typeof entry !== "object" || entry.sourceKey !== RETURNS_EVENT_SOURCE_KEY || entry.bucket !== r.region) entry = fallbackStatusEntry(r, nowIso);
  if (r.code && SAFE_CODE.test(S(r.code))) entry = { ...entry, safeErrorCode: r.code };
  else if (!entry.safeErrorCode && (r.coverageGaps || []).length) entry = { ...entry, safeErrorCode: "RETURNS_COVERAGE_GAP" };
  return entry;
}

function minimalStatusEntry({ region, code, lastStatus, nowIso, stage }) {
  return { sourceKey: RETURNS_EVENT_SOURCE_KEY, bucket: region, lastStatus, lastAttemptAt: nowIso, safeErrorCode: safeCode(code, "RETURNS_FAILED"), safeErrorStage: stage };
}

// The runner's own entry, used only when the core helper is unavailable or returns a malformed entry.
function fallbackStatusEntry(r, nowIso) {
  const o = r.outcomes || {};
  const n = (k) => (o[k] || []).length;
  const systemic = r.ok === false;
  const complete = !systemic && r.classification === "COMPLETE";
  return {
    sourceKey: RETURNS_EVENT_SOURCE_KEY, bucket: r.region,
    lastStatus: systemic ? "failed" : (complete ? "succeeded" : "partial"),
    lastAttemptAt: nowIso, ...(complete ? { lastSuccessAt: nowIso } : {}),
    safeErrorCode: r.code || (complete ? null : "RETURNS_ACCOUNTS_ISOLATED"), safeErrorStage: systemic ? "run" : null,
    accountsCompleted: n("initial-loaded") + n("daily-refreshed") + n("skipped-current"),
    accountsFailed: n("failed") + n("incomplete") + n("pending") + n("held"),
    accountsTotal: RETURNS_OUTCOME_CATEGORIES.reduce((t, c) => t + n(c), 0) - n("incompatible"),
    batchCount: r.exposure ? Number(r.exposure.plannedCreates) || 0 : 0,
    createsSpent: Number(r.creates) || 0, tokensSpent: (Number(r.creates) || 0) * RETURNS_TOKENS_PER_CREATE,
    createsCeiling: r.maxCreates == null ? null : r.maxCreates, tokensCeiling: r.maxCreates == null ? null : r.maxCreates * RETURNS_TOKENS_PER_CREATE,
  };
}

/**
 * The MINIMAL failed status entry of a CLI-level outcome outside the runner's own status write: a controls skip before
 * the runner plans (stage 'controls': unreadable / missing control row) or an unexpected runner throw (stage 'run').
 */
export function returnsSkipStatusEntry({ region, code, nowIso, stage = "controls" }) {
  return minimalStatusEntry({ region, code, lastStatus: "failed", nowIso: nowIso || new Date().toISOString(), stage: stage === "run" ? "run" : "controls" });
}

/** The PUBLIC RESULT payload (one JSON line): counts, typed codes, dates and 8-character account / export prefixes only. */
export function returnsResultPayload(result) {
  const r = result || {};
  const o = r.outcomes || {};
  const codes = r.accountCodes || {};
  const codeCounts = {};
  for (const c of Object.values(codes)) codeCounts[c] = (codeCounts[c] || 0) + 1;
  return {
    region: r.region, asOf: r.asOf, mode: r.mode, ok: r.ok !== false, classification: r.classification, code: r.code || null,
    creates: Number(r.creates) || 0, reused: Number(r.reused) || 0, reconciled: Number(r.reconciled) || 0, tokens: Number(r.tokens) || 0,
    maxCreates: r.maxCreates == null ? null : r.maxCreates, reserveTokens: r.reserveTokens, slotsRefused: Number(r.slotsRefused) || 0,
    balance: r.balanceBefore == null ? null : r.balanceBefore, rowsWritten: r.rowsWritten === true,
    plan: r.plan || null,
    exposure: r.exposure ? { plannedCreates: r.exposure.plannedCreates, expectedTokens: r.exposure.expectedTokens, maxCreates: r.exposure.maxCreates, ceilingTokens: r.exposure.ceilingTokens } : null,
    planned: (r.planned || []).map((a) => ({ id: p8(a.accountId), mode: a.mode, from: a.from, to: a.to })),
    reverifyPending: (r.reverifyPending || []).map((id) => p8(id)),
    counts: Object.fromEntries(RETURNS_OUTCOME_CATEGORIES.map((c) => [c, (o[c] || []).length])),
    outcomes: Object.fromEntries(RETURNS_OUTCOME_CATEGORIES.map((c) => [c, (o[c] || []).map((id) => p8(id))])),
    accounts: Object.entries(codes).filter(([, c]) => !SUCCESS_CODES.has(c)).map(([id, c]) => ({ id: p8(id), code: c })),
    codes: codeCounts,
    reverify: r.reverify,
    fragments: (r.fragments || []).map((f) => ({ from: f.from, to: f.to, rowCount: f.rowCount, sellers: f.sellers, exportId: p8(f.exportId), via: f.via })),
    createdExports: (r.createdExportIds || []).map((x) => p8(x)), adoptedExports: (r.adoptedExportIds || []).map((x) => p8(x)),
    coverageGaps: (r.coverageGaps || []).map((g) => ({ id: p8(g.accountId), days: g.days, code: "RETURNS_COVERAGE_GAP" })),
    coverageGapDays: (r.coverageGaps || []).reduce((t, g) => t + (Number(g.days) || 0), 0),
    crossAccountOrders: r.crossAccount || { orders: 0, accountsAffected: 0 },
    identityAmbiguous: Number(r.identityAmbiguous) || 0,
    anomalies: r.anomalies || {}, rowFailures: r.rowFailures || {}, diagnostics: r.diagnostics || {},
    problems: uniq((r.problems || []).map((c) => safeCode(c, "RETURNS_PROBLEM"))),
  };
}

/** The GITHUB_STEP_SUMMARY markdown of one region run (counts / codes / dates only). */
export function returnsStepSummary(result) {
  const p = returnsResultPayload(result);
  const c = p.counts;
  const lines = [
    "### Returns (FBA & FBM) " + S(p.region) + " @ " + S(p.asOf) + " -- " + S(p.classification) + (p.code ? " (" + p.code + ")" : ""),
    "- initial-loaded " + c["initial-loaded"] + ", daily-refreshed " + c["daily-refreshed"] + ", skipped-current " + c["skipped-current"] + ", held " + c.held
      + ", incomplete " + c.incomplete + ", failed " + c.failed + ", pending " + c.pending + ", incompatible " + c.incompatible,
    "- " + p.creates + " create(s) / " + p.tokens + " token(s) (cap " + (p.maxCreates == null ? "-" : p.maxCreates) + "), reused " + p.reused + " completed export(s) at zero tokens, slots refused " + p.slotsRefused,
    "- re-verified " + (p.reverify ? p.reverify.verified + "/" + p.reverify.attempted : "0/0") + " at zero tokens; identity-ambiguous " + p.identityAmbiguous
      + "; cross-account orders " + p.crossAccountOrders.orders + " (" + p.crossAccountOrders.accountsAffected + " account(s))",
    "- coverage gaps older than the rolling window: " + p.coverageGaps.length + " account(s), " + p.coverageGapDays + " day(s) (RETURNS_COVERAGE_GAP; reported, never fetched)",
    "- freshness: the daily refresh re-reads the last 14 days; older returns keep the status / FBM refund / disposition they had when last fetched",
  ];
  const codeLine = Object.entries(p.codes).filter(([k]) => !SUCCESS_CODES.has(k)).map(([k, n]) => k + " x" + n).join(", ");
  if (codeLine) lines.push("- account codes: " + codeLine);
  return lines.join("\n");
}
