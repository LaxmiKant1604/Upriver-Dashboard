// Scheduler v2 -- Daily Reporting Ads derived-context loader (SHADOW MODE).
//
// The report worker's `loadDerivedContext` for daily-reporting. Preserves production-route parity:
// the live Daily route reads ALREADY-AGGREGATED advertising from `ad_daily_metrics` via
// getAdDailyMetrics(accountId, from, to) -- it does NOT sum the overlapping raw campaign / ASIN /
// targeting / search-term source tables together (those grains overlap and would double-count). So
// this loader reads the same aggregated table and canonicalizes each row.
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

// The ONE Ads source that feeds ad_daily_metrics (campaign-level daily); ads-sync.js only upserts
// ad_daily_metrics for this source. Daily Reporting's TACoS/ad columns come from here.
export const DAILY_ADS_SOURCE_KEY = "campaign-performance-v1";

// Coerce a metric to a finite number, or NaN when it is missing/non-numeric so the coverage
// validator BLOCKS it rather than silently coercing corruption to zero.
function finiteMetric(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * Canonicalize `ad_daily_metrics` rows into merge-ready Ads rows. Mirrors the production Daily route
 * mapping (metric_date -> date; per-campaign row preserved so mergeSalesAndAds sums them per
 * seller/day) EXCEPT the seller id is the AUTHORITATIVE raw seller/vendor id (so rows match the
 * sales rows' seller_or_vendor_id and can be validated per account). Pure.
 */
export function canonicalizeAdRows(metricRows, rawSellerId) {
  return (metricRows || []).map((row) => ({
    date: row.metric_date,
    seller_or_vendor_id: rawSellerId,
    currency: row.currency ?? null,
    ad_sales: finiteMetric(row.ad_sales),
    ad_spend: finiteMetric(row.ad_spend),
    ad_clicks: finiteMetric(row.ad_clicks),
  }));
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
 * it resolves the authoritative raw seller id, reads ad_daily_metrics (paginated, truncation-guarded)
 * + durable coverage, and returns { adsCoverage }. A metrics read that throws (e.g. the row-limit
 * guard) or an unresolvable account is captured as a typed read/scope state so the derive marks Ads
 * failed/unavailable WITHOUT blocking the sales snapshot. For the named-brand path and every other
 * report it returns {}. Injected:
 *   connections     -- DataDoe connections (for resolveDataDoeAccountIds); default is production.
 *   getAdMetrics    -- (accountId, from, to) -> ad_daily_metrics rows (getAdDailyMetrics; may throw).
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
