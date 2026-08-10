// Scheduler v2 -- production-shape SHADOW planner for Daily Reporting + SKU P&L only.
//
// Turns an authorized account (from the account directory) into a single-account report request
// carrying the exact source-contract windows the approved contracts declare, plus a planned context
// whose scope (accountId / rawSellerId / from / to / brand) is AUTHORITATIVE. It resolves the raw
// seller/vendor id from account metadata (resolveDataDoeAccountIds), NEVER from untrusted rows, and
// keeps primary vs dd-secondary organizations isolated (one connection per account; the raw id and
// the org fingerprint come from that connection). The request feeds buildDependencyPlan() ->
// runSourceJobs (source half) and runReportJobs (derive half). SHADOW MODE: not wired to any
// cron/route; report-controls keeps daily-reporting + sku-pl locked until live approval.
//
// Only Daily Reporting (ALL-brand) and SKU P&L are planned here. No other adapter is started.

import { resolveDataDoeAccountIds } from "../datadoe-connections.js";
import { reportSourceRequestHashes } from "./report-source-contracts.js";
import { REPORT_DERIVATIONS } from "./report-derivation.js";
import { monthBackStr, splitDateRangeByMonth, sixCompleteCalendarMonths } from "../date-windows.js";
import { bucketForCountry } from "./registry.js";
import { buildDependencyPlan } from "./planner.js";

// Daily Reporting spans the last SIX calendar months exactly as the live UI does:
// [monthBack(asOf, 5).from .. asOf] (first day of the month five months back .. today). The prior
// 150-day approximation (monthStart(asOf)-150d) silently trimmed the first days of the oldest month.
const DAILY_MONTHS_BACK = 5;

export const SHADOW_PLANNED_REPORT_KEYS = Object.freeze(["daily-reporting", "sku-pl"]);

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

const PLANNERS = { "daily-reporting": planDailyReporting, "sku-pl": planSkuPl };

/**
 * Build the full SHADOW plan for a set of authorized accounts. Returns:
 *   - reportRequests: the per-account report requests (fed to runReportJobs as plannedReports);
 *   - sourceJobs: the DEDUPLICATED canonical source jobs (fed to runSourceJobs) -- one job per
 *     unique request_hash, so identical source contracts across reports/accounts fetch once;
 *   - reportJobs: buildDependencyPlan's report->sources dependency map (telemetry).
 * `accounts`: [{ accountId, country, currency }] (from the authoritative account directory).
 * `asOfFor(country)` supplies the marketplace-local as-of date (the caller passes marketplaceToday).
 * Only daily-reporting + sku-pl are planned; other keys are ignored. Pure given its inputs; no I/O.
 */
export function buildShadowReportPlan({ accounts = [], reportKeys = SHADOW_PLANNED_REPORT_KEYS, connections, asOfFor }) {
  const keys = (reportKeys || []).filter((key) => SHADOW_PLANNED_REPORT_KEYS.includes(key));
  const reportRequests = [];
  for (const account of accounts) {
    const asOf = typeof asOfFor === "function" ? asOfFor(account.country) : account.asOf;
    for (const reportKey of keys) {
      reportRequests.push(PLANNERS[reportKey]({ accountId: account.accountId, country: account.country, currency: account.currency, connections, asOf }));
    }
  }
  const { sourceJobs, reportJobs } = buildDependencyPlan(reportRequests);
  return { reportRequests, sourceJobs, reportJobs };
}
