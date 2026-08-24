// Scheduler v2 -- Daily Reporting Ads derived-context loader (SHADOW MODE).
//
// The report worker's `loadDerivedContext` for daily-reporting. Preserves production-route parity:
// the live Daily route reads the durable ASIN grain (ads_daily_source_rows, asin-performance-v1) via
// getAsinAdsDailyRows(accountId, from, to) -- the SINGLE reusable Ads source it shares with Brand View. It
// reads ONLY that grain (never summing the overlapping campaign / targeting / search-term grains, which would
// double-count) and folds every ASIN into per-(date, currency) canonical rows (ad_sales_same_sku -> ad_sales).
//
// Two corrections over a naive reader (from the prior review):
//   1. The authoritative raw seller/vendor id is resolved from account metadata
//      (resolveDataDoeAccountIds) and stamped onto every canonical row, NEVER taken from a row. It
//      is the partition key evaluateDailyAdsCoverage checks every row against.
//   2. Coverage is proven from DURABLE successful-sync window metadata (ads_sync_coverage), not from
//      the first/last returned metric row -- a successfully-covered day can have zero ads and thus
//      no metric row, so first/last rows understate coverage.
//
// All I/O is injected (getAdMetrics, getCoverageState, connections), so this is offline-testable and
// makes ZERO DataDoe calls.

import { resolveDataDoeAccountIds } from "../datadoe-connections.js";
import { aggregateAsinAdsDailyRows } from "../reports/asin-ads-aggregation.js";

// The ONE Ads source Daily Reporting reads: the durable ASIN grain (asin-performance-v1, in
// ads_daily_source_rows) -- the SINGLE reusable advertising source it shares with Brand View. Its attributed
// sales is ad_sales_same_sku (same-SKU only; no campaign halo). The overlapping campaign grain is NEVER summed
// with it. (Historically Daily read the aggregated campaign table ad_daily_metrics; that grain is now PPC-only.)
export const DAILY_ADS_SOURCE_KEY = "asin-performance-v1";

/**
 * Canonicalize durable ASIN-Ads rows (ads_daily_source_rows, source asin-performance-v1) into merge-ready Daily
 * Ads rows { date, seller_or_vendor_id, currency, ad_sales, ad_spend, ad_clicks }, folded per (date, currency)
 * via the SHARED canonical aggregation (aggregateAsinAdsDailyRows): metrics are read from the row's `metrics`
 * JSONB, deduped by the natural grain, currencies never combined, absent metrics never invented, and
 * ad_sales_same_sku -> ad_sales. The seller id is the AUTHORITATIVE raw seller/vendor id (never a row's) so rows
 * match the sales rows and can be validated per account. Pure.
 */
export function canonicalizeAdRows(asinRows, rawSellerId) {
  return aggregateAsinAdsDailyRows(asinRows, { rawSellerId });
}

/**
 * Build the typed adsCoverage contract that resolveDailyAdsAvailability consumes. `coverageState` =
 * { windows:[{from,to}], status, latestMetricDate, read } from the durable ads coverage store, and
 * `metricsRead` reports the ad_daily_metrics read outcome ("ok" | "limit-exceeded" | "read-failed").
 * Pure. Carries the AUTHORITATIVE account currency + raw seller scope + raw successful windows so the
 * availability resolver can compute the covered sub-window and validate every row.
 */
export function buildDailyAdsCoverage({ accountId, rawSellerId, currency, from, to, metricRows, metricsRead = "ok", coverageState }) {
  const state = coverageState || {};
  return {
    accountId,
    rawSellerId,
    currency: currency == null ? null : currency,
    requested: { from, to },
    windows: Array.isArray(state.windows) ? state.windows : [],
    coverageRead: state.read || "ok",
    metricsRead,
    syncStatus: state.status || "missing",
    latestMetricDate: state.latestMetricDate ?? null,
    adRows: canonicalizeAdRows(metricRows, rawSellerId),
  };
}

/**
 * Make the report-worker `loadDerivedContext` callback for Daily Reporting. For daily-reporting ALL,
 * it resolves the authoritative raw seller id, reads durable ASIN-Ads rows (ads_daily_source_rows,
 * paginated + truncation-guarded) + durable coverage, and returns { adsCoverage }. A metrics read that
 * throws (e.g. the row-limit guard) or an unresolvable account is captured as a typed read/scope state so
 * the derive marks Ads failed/unavailable WITHOUT blocking the sales snapshot. For the named-brand path and
 * every other report it returns {}. Injected:
 *   connections     -- DataDoe connections (for resolveDataDoeAccountIds); default is production.
 *   getAdMetrics    -- (accountId, from, to) -> durable ASIN-Ads rows (getAsinAdsDailyRows; may throw).
 *   getCoverageState-- (accountId, sourceKey) -> { windows, status, latestMetricDate, read }.
 */
export function makeDailyAdsContextLoader({ connections, getAdMetrics, getCoverageState }) {
  return async ({ reportKey, accountId, planned }) => {
    if (reportKey !== "daily-reporting") return {};
    const context = (planned && planned.context) || {};
    if ((context.brand ?? "ALL") !== "ALL") return {}; // named-brand Daily uses no ads
    const { from, to, currency } = context;
    // Authoritative raw seller/vendor id from account metadata -- never from rows. An unresolvable
    // account yields a null raw id; the availability resolver then marks Ads failed (sales survive).
    const resolved = resolveDataDoeAccountIds([accountId], connections);
    const rawSellerId = resolved && resolved.rawAccountIds.length === 1 ? resolved.rawAccountIds[0] : null;
    let metricRows = [];
    let metricsRead = "ok";
    try {
      metricRows = await getAdMetrics(accountId, from, to);
    } catch (error) {
      metricsRead = error && error.code === "ADS_ROW_LIMIT_EXCEEDED" ? "limit-exceeded" : "read-failed";
      metricRows = [];
    }
    const coverageState = await getCoverageState(accountId, DAILY_ADS_SOURCE_KEY);
    return { adsCoverage: buildDailyAdsCoverage({ accountId, rawSellerId, currency, from, to, metricRows, metricsRead, coverageState }) };
  };
}
