// Scheduler v2 -- production-shape SHADOW planner for Daily Reporting, SKU P&L, FBA Shipment Plan
// and Reconciliation.
//
// Turns an authorized account (from the account directory) into a single-account report request
// carrying the exact source-contract windows the approved contracts declare, plus a planned context
// whose scope (accountId / rawSellerId / from / to / brand / asOf) is AUTHORITATIVE. It resolves the
// raw seller/vendor id from account metadata (resolveDataDoeAccountIds), NEVER from untrusted rows,
// and keeps primary vs dd-secondary organizations isolated (one connection per account; the raw id
// and the org fingerprint come from that connection). The request feeds buildDependencyPlan() ->
// runSourceJobs (source half) and runReportJobs (derive half). SHADOW MODE: not wired to any
// cron/route; report-controls keeps every planned report locked until live approval.
//
// Only Daily Reporting (ALL-brand), SKU P&L, FBA Shipment Plan and Reconciliation are planned here.
// No other adapter (Keyword Rank, insight reports) is started.

import { resolveDataDoeAccountIds } from "../datadoe-connections.js";
import { reportSourceRequestHashes, REPORT_SOURCE_CONTRACTS, evaluateFallbackCondition } from "./report-source-contracts.js";
import { REPORT_DERIVATIONS } from "./report-derivation.js";
import { monthBackStr, splitDateRangeByMonth, sixCompleteCalendarMonths, planMonthWindows, addDaysStr } from "../date-windows.js";
import { bucketForCountry } from "./registry.js";
import { buildDependencyPlan } from "./planner.js";

// Daily Reporting spans the last SIX calendar months exactly as the live UI does:
// [monthBack(asOf, 5).from .. asOf] (first day of the month five months back .. today). The prior
// 150-day approximation (monthStart(asOf)-150d) silently trimmed the first days of the oldest month.
const DAILY_MONTHS_BACK = 5;

// FBA inventory-health lookback (days) -- byte-identical to the api/datadoe.js PLAN_INVENTORY_LOOKBACK_DAYS
// constant, so the scheduled inventory window (asOf-10d..asOf) matches the live route exactly.
const FBA_INVENTORY_LOOKBACK_DAYS = 10;

// Keyword Rank SQP + catalog lookbacks (days) -- byte-identical to the api/datadoe.js
// SQP_WEEKLY_LOOKBACK_DAYS / SQP_MONTHLY_LOOKBACK_DAYS (the monthly SQP + 365-day catalog share the
// long window), so the scheduled SQP/catalog windows match the live route exactly.
const SQP_WEEKLY_LOOKBACK_DAYS = 84;
const SQP_LONG_LOOKBACK_DAYS = 365;

export const SHADOW_PLANNED_REPORT_KEYS = Object.freeze(["daily-reporting", "sku-pl", "fba-plan", "reconciliation"]);

// Keyword Rank is NOT a generic single-shot plan: its weekly->monthly fallback and catalog token
// are staged per account by runKeywordRankShadowCycle (keyword-rank-cycle.js). It therefore has ONE
// canonical entry point and MUST NOT flow through the eager generic builder (which would emit weekly +
// an eager catalog with no account-scoped fallback orchestration). buildShadowReportPlan rejects it
// fail-closed rather than silently planning or silently dropping a requested key.
export const STAGED_CYCLE_REPORT_KEYS = Object.freeze(["keyword-rank"]);

/**
 * Resolve the AUTHORITATIVE single-account scope for the planner from account metadata.
 * Returns { accountId(public), rawSellerId, connectionId(orgId), apiKey, country, currency, bucket }.
 * Throws (fail closed) on a missing/ambiguous account, a missing marketplace country, or a missing
 * account currency. The raw seller/vendor id + currency come from account metadata -- never inferred
 * from report rows. `currency` is the authoritative account currency the Daily Ads validator uses.
 */
export function resolveAccountScope({ accountId, country, currency, connections }) {
  const publicId = String(accountId || "").trim();
  if (!publicId) throw new Error("planner requires a public accountId.");
  const resolved = resolveDataDoeAccountIds([publicId], connections);
  if (!resolved) throw new Error(`planner could not resolve account "${publicId}".`);
  // Exactly one raw id per account (resolveDataDoeAccountIds maps one public id -> one raw id).
  if (resolved.rawAccountIds.length !== 1) {
    throw new Error(`planner requires exactly one raw seller/vendor id for "${publicId}", got ${resolved.rawAccountIds.length}.`);
  }
  const marketplace = String(country || "").trim().toUpperCase();
  if (!marketplace) throw new Error(`planner requires an authoritative marketplace country for account "${publicId}".`);
  const accountCurrency = String(currency || "").trim().toUpperCase();
  if (!accountCurrency) throw new Error(`planner requires an authoritative account currency for account "${publicId}".`);
  return {
    accountId: publicId,
    rawSellerId: resolved.rawAccountIds[0],
    connectionId: resolved.connection.id, // organization id (primary | secondary)
    apiKey: resolved.connection.apiKey,   // organization-scoped credential (drives the org fingerprint)
    country: marketplace,
    currency: accountCurrency,
    bucket: bucketForCountry(marketplace),
  };
}

// Stamp each resolved source with the report's connection/bucket and its required/optional flag from
// the derivation registry, so the plan carries everything buildDependencyPlan + the workers need.
function decorateSources(sources, { reportKey, connectionId, bucket }) {
  const entry = REPORT_DERIVATIONS[reportKey];
  const optionalKeys = new Set(entry ? entry.optionalRequestKeys : []);
  return (sources || []).map((source) => ({
    ...source,
    connectionId,
    bucket,
    optional: optionalKeys.has(source.requestKey),
  }));
}

/**
 * Plan Daily Reporting (ALL-brand only) for ONE account. Emits the ASIN/day superset (monthly
 * fragments) + the catalog (single range) over monthStart(asOf) - 150d .. asOf, all for the one raw
 * seller id. No extra Daily sales or Ads DataDoe export is added (Ads are a derive-only input read
 * from ad_daily_metrics; see daily-ads-loader.js). rawSellerId is stored in the planned context.
 */
export function planDailyReporting({ accountId, country, currency, connections, asOf }) {
  const scope = resolveAccountScope({ accountId, country, currency, connections });
  const from = monthBackStr(asOf, DAILY_MONTHS_BACK);
  const to = String(asOf);
  const windowsByRequestKey = {
    "daily-reporting:asin-day-superset": splitDateRangeByMonth(from, to),
    "daily-reporting:catalog": [{ from, to }],
  };
  const sources = reportSourceRequestHashes({
    reportKey: "daily-reporting", apiKey: scope.apiKey, ids: [scope.rawSellerId],
    windowsByRequestKey, marketplaceCountry: scope.country,
  });
  return {
    reportKey: "daily-reporting",
    reportVersion: REPORT_DERIVATIONS["daily-reporting"].snapshotVersion,
    accountId: scope.accountId,
    connectionId: scope.connectionId,
    bucket: scope.bucket,
    sources: decorateSources(sources, { reportKey: "daily-reporting", connectionId: scope.connectionId, bucket: scope.bucket }),
    // Planned scope is authoritative: brand ALL, the reporting window, the raw seller id (used to
    // validate every Ads row), and the account currency (used to reject mismatched/null Ads
    // currency). The worker's fail-closed context builder pins these.
    context: { brand: "ALL", from, to, rawSellerId: scope.rawSellerId, currency: scope.currency },
  };
}

/**
 * Plan SKU P&L for ONE account over exactly SIX complete consecutive calendar months (one monthly
 * fragment per month), first day of month one to last day of month six, all for the one raw seller
 * id. Reuses the strict six-month helper so the plan satisfies validateSkuPlMonthlyWindows by
 * construction. No COGS override is baked into the snapshot (the browser applies overrides at
 * display; that is unchanged).
 */
export function planSkuPl({ accountId, country, currency, connections, asOf }) {
  const scope = resolveAccountScope({ accountId, country, currency, connections });
  const span = sixCompleteCalendarMonths(asOf);
  if (!span) throw new Error(`sku-pl planner could not compute six complete calendar months from asOf "${asOf}".`);
  const windowsByRequestKey = { "sku-pl:monthly-profit": span.months };
  const sources = reportSourceRequestHashes({
    reportKey: "sku-pl", apiKey: scope.apiKey, ids: [scope.rawSellerId],
    windowsByRequestKey, marketplaceCountry: scope.country,
  });
  return {
    reportKey: "sku-pl",
    reportVersion: REPORT_DERIVATIONS["sku-pl"].snapshotVersion,
    accountId: scope.accountId,
    connectionId: scope.connectionId,
    bucket: scope.bucket,
    sources: decorateSources(sources, { reportKey: "sku-pl", connectionId: scope.connectionId, bucket: scope.bucket }),
    context: { from: span.from, to: span.to, rawSellerId: scope.rawSellerId },
  };
}

/**
 * Plan Reconciliation for ONE account over exactly SIX complete consecutive calendar months. Emits
 * the per-month order-line + settlement fragments plus a single full-range catalog, all for the one
 * raw seller id. Reuses the strict six-month helper so the plan satisfies the derivation's
 * six-complete-calendar-month contract by construction. Never mixes currencies or organizations (one
 * account, one connection). The browser localises to a single currency at display; unchanged here.
 */
export function planReconciliation({ accountId, country, currency, connections, asOf }) {
  const scope = resolveAccountScope({ accountId, country, currency, connections });
  const span = sixCompleteCalendarMonths(asOf);
  if (!span) throw new Error(`reconciliation planner could not compute six complete calendar months from asOf "${asOf}".`);
  const windowsByRequestKey = {
    "reconciliation:order-lines": span.months,
    "reconciliation:settlements": span.months,
    "reconciliation:catalog": [{ from: span.from, to: span.to }],
  };
  const sources = reportSourceRequestHashes({
    reportKey: "reconciliation", apiKey: scope.apiKey, ids: [scope.rawSellerId],
    windowsByRequestKey, marketplaceCountry: scope.country,
  });
  return {
    reportKey: "reconciliation",
    reportVersion: REPORT_DERIVATIONS.reconciliation.snapshotVersion,
    accountId: scope.accountId,
    connectionId: scope.connectionId,
    bucket: scope.bucket,
    sources: decorateSources(sources, { reportKey: "reconciliation", connectionId: scope.connectionId, bucket: scope.bucket }),
    context: { from: span.from, to: span.to, rawSellerId: scope.rawSellerId },
  };
}

/**
 * Plan FBA Shipment Plan for ONE account. Emits the exact route windows from planMonthWindows(asOf):
 * monthly-units = 3 completed months + current MTD (one fragment each), a current-month daily-date
 * probe, a catalog over completed[0].from .. asOf, an inventory-health snapshot over asOf-10d..asOf,
 * and -- for US accounts only -- the no-date AWD listing source. All for the one raw seller id.
 * `name` is the AUTHORITATIVE account name; `marketCountry` (raw) + `isUS` drive the US-only AWD +
 * per-row AWD payload fields. The AWD source is planned ONLY for US (the contract is US-conditional).
 */
export function planFbaPlan({ accountId, name, country, currency, connections, asOf }) {
  const scope = resolveAccountScope({ accountId, country, currency, connections });
  const asOfStr = String(asOf);
  const { completed, current } = planMonthWindows(asOfStr);
  const isUS = scope.country === "US";
  const windowsByRequestKey = {
    "fba-plan:monthly-units": [
      ...completed.map((m) => ({ from: m.from, to: m.to })),
      { from: current.from, to: current.to },
    ],
    "fba-plan:current-daily-dates": [{ from: current.from, to: current.to }],
    "fba-plan:catalog": [{ from: completed[0].from, to: current.to }],
    "fba-plan:inventory-health": [{ from: addDaysStr(asOfStr, -FBA_INVENTORY_LOOKBACK_DAYS), to: asOfStr }],
  };
  // AWD is a US-only no-date source; supply its window ONLY for US (the contract's country gate would
  // otherwise reject an inapplicable request key).
  if (isUS) windowsByRequestKey["fba-plan:awd"] = [{ from: null, to: null }];
  const sources = reportSourceRequestHashes({
    reportKey: "fba-plan", apiKey: scope.apiKey, ids: [scope.rawSellerId],
    windowsByRequestKey, marketplaceCountry: scope.country,
  });
  return {
    reportKey: "fba-plan",
    reportVersion: REPORT_DERIVATIONS["fba-plan"].snapshotVersion,
    accountId: scope.accountId,
    connectionId: scope.connectionId,
    bucket: scope.bucket,
    sources: decorateSources(sources, { reportKey: "fba-plan", connectionId: scope.connectionId, bucket: scope.bucket }),
    // asOf/name/country/isUS are authoritative account metadata the derivation reproduces in the
    // payload; rawSellerId scopes every fragment. marketCountry is the RAW account country (the
    // payload preserves it verbatim), isUS is derived from the uppercased scope country.
    context: { to: asOfStr, rawSellerId: scope.rawSellerId, accountName: name || null, marketCountry: country || null, isUS },
  };
}

/**
 * Plan Keyword Rank for ONE account from that account's OWN typed weekly signal (Blocker 1: never a
 * global request-key signal). Emits the SQP-weekly probe (asOf-84d..asOf) + the 365-day catalog, and --
 * ONLY when the typed weekly signal makes the contract's `distinct_periods < 4` fallback apply -- the
 * monthly SQP request (asOf-365d..asOf). The catalog window is always resolved here (the catalog
 * contract is unconditional); the STAGED-cycle driver decides WHEN the catalog export is actually
 * spent (never before the cadence is resolved -- Blocker 2). request_hash + primary/dd-secondary
 * isolation come from the shared resolver (unchanged by staging).
 */
export function planKeywordRank({ accountId, country, currency, connections, asOf, weeklySignal = null }) {
  const scope = resolveAccountScope({ accountId, country, currency, connections });
  const end = String(asOf);
  const weeklyFrom = addDaysStr(end, -SQP_WEEKLY_LOOKBACK_DAYS);
  const longFrom = addDaysStr(end, -SQP_LONG_LOOKBACK_DAYS);
  const windowsByRequestKey = {
    "keyword-rank:sqp-weekly": [{ from: weeklyFrom, to: end }],
    "keyword-rank:catalog": [{ from: longFrom, to: end }],
  };
  const dependencySignals = {};
  if (weeklySignal != null) {
    dependencySignals["keyword-rank:sqp-weekly"] = weeklySignal;
    // Supply the monthly window ONLY when the typed weekly signal makes the fallback apply (fail
    // closed via the shared evaluateFallbackCondition); the resolver rejects an inapplicable window.
    const monthlyContract = (REPORT_SOURCE_CONTRACTS["keyword-rank"] || []).find((c) => c.requestKey === "keyword-rank:sqp-monthly");
    if (monthlyContract && evaluateFallbackCondition(monthlyContract.condition, weeklySignal)) {
      windowsByRequestKey["keyword-rank:sqp-monthly"] = [{ from: longFrom, to: end }];
    }
  }
  const sources = reportSourceRequestHashes({
    reportKey: "keyword-rank", apiKey: scope.apiKey, ids: [scope.rawSellerId],
    windowsByRequestKey, marketplaceCountry: scope.country, dependencySignals,
  });
  return {
    reportKey: "keyword-rank",
    reportVersion: REPORT_DERIVATIONS["keyword-rank"].snapshotVersion,
    accountId: scope.accountId,
    connectionId: scope.connectionId,
    bucket: scope.bucket,
    sources: decorateSources(sources, { reportKey: "keyword-rank", connectionId: scope.connectionId, bucket: scope.bucket }),
    context: { to: end, rawSellerId: scope.rawSellerId },
  };
}

// Generic single-shot planners ONLY. keyword-rank is deliberately absent: it is staged by
// runKeywordRankShadowCycle (see STAGED_CYCLE_REPORT_KEYS), never dispatched here.
const PLANNERS = {
  "daily-reporting": planDailyReporting,
  "sku-pl": planSkuPl,
  "fba-plan": planFbaPlan,
  reconciliation: planReconciliation,
};

/**
 * Build the full SHADOW plan for a set of authorized accounts. Returns:
 *   - reportRequests: the per-account report requests (fed to runReportJobs as plannedReports);
 *   - sourceJobs: the DEDUPLICATED canonical source jobs (fed to runSourceJobs) -- one job per
 *     unique request_hash, so identical source contracts across reports/accounts fetch once;
 *   - reportJobs: buildDependencyPlan's report->sources dependency map (telemetry).
 * `accounts`: [{ accountId, country, currency }] (from the authoritative account directory).
 * `asOfFor(country)` supplies the marketplace-local as-of date (the caller passes marketplaceToday).
 * Plans ONLY the generic single-shot reports (SHADOW_PLANNED_REPORT_KEYS); a requested staged-cycle
 * key (Keyword Rank) is REJECTED fail-closed, never silently planned OR silently dropped. Any other
 * unknown key is ignored. Pure given its inputs; no I/O.
 */
export function buildShadowReportPlan({ accounts = [], reportKeys = SHADOW_PLANNED_REPORT_KEYS, connections, asOfFor }) {
  const requested = reportKeys || [];
  // Fail closed: a staged-cycle report (Keyword Rank) has ONE canonical entry point
  // (runKeywordRankShadowCycle) and must never be planned by -- or silently dropped from -- the generic
  // eager builder. A caller that explicitly asks for it here is a bug we surface rather than mis-plan.
  const stagedRequested = requested.filter((key) => STAGED_CYCLE_REPORT_KEYS.includes(key));
  if (stagedRequested.length) {
    throw new Error(`buildShadowReportPlan cannot plan staged-cycle report(s) [${stagedRequested.join(", ")}]; use runKeywordRankShadowCycle (account-scoped staged weekly/monthly/catalog cycle).`);
  }
  const keys = requested.filter((key) => SHADOW_PLANNED_REPORT_KEYS.includes(key));
  const reportRequests = [];
  for (const account of accounts) {
    const asOf = typeof asOfFor === "function" ? asOfFor(account.country) : account.asOf;
    for (const reportKey of keys) {
      // `name` is threaded for FBA Shipment Plan (its payload carries the authoritative account
      // name); the other planners ignore it.
      reportRequests.push(PLANNERS[reportKey]({ accountId: account.accountId, name: account.name, country: account.country, currency: account.currency, connections, asOf }));
    }
  }
  const { sourceJobs, reportJobs } = buildDependencyPlan(reportRequests);
  return { reportRequests, sourceJobs, reportJobs };
}
