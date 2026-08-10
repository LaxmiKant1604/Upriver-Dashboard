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

import { addDaysStr } from "../date-windows.js";
import { isValidCalendarDate } from "./report-source-contracts.js";
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
 * The last date D such that [from, D] is CONTIGUOUSLY covered by the successful windows, or null
 * when `from` itself is not covered. Pure; `windows` = [{from,to}] successful calendar windows. A
 * gap before/at `from` yields null (missing); a gap after yields a D < to (stale). Clamped to `to`.
 */
export function adsCoveredThrough(windows, from, to) {
  if (!isValidCalendarDate(from) || !isValidCalendarDate(to) || from > to) return null;
  const valid = (windows || [])
    .filter((w) => w && isValidCalendarDate(w.from) && isValidCalendarDate(w.to) && w.from <= w.to && w.to >= from && w.from <= to)
    .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  let cursor = from; // the next day that still needs coverage
  let covered = false;
  for (const w of valid) {
    if (w.from > cursor) break;            // a gap before this window: contiguous coverage ends
    if (w.to >= cursor) { cursor = addDaysStr(w.to, 1); covered = true; }
  }
  if (!covered) return null;
  const through = addDaysStr(cursor, -1);
  return through > to ? to : through;
}

/**
 * Build the typed adsCoverage contract for evaluateDailyAdsCoverage. `coverageState` =
 * { windows:[{from,to}], status, latestMetricDate } from the durable ads coverage store. Pure.
 * Coverage.from/to is the contiguous covered span anchored at `from` (so a start gap => coverage
 * null => missing; an end shortfall => coverage.to < to => stale). validated tracks the sync status.
 */
export function buildDailyAdsCoverage({ accountId, rawSellerId, from, to, metricRows, coverageState }) {
  const state = coverageState || {};
  const through = adsCoveredThrough(state.windows || [], from, to);
  return {
    accountId,
    rawSellerId,
    requested: { from, to },
    coverage: through ? { from, to: through } : { from: null, to: null },
    validated: state.status === "succeeded",
    latestMetricDate: state.latestMetricDate ?? null,
    requiredSourceStatus: state.status || "missing",
    adRows: canonicalizeAdRows(metricRows, rawSellerId),
  };
}

/**
 * Make the report-worker `loadDerivedContext` callback for Daily Reporting. For daily-reporting ALL,
 * it resolves the authoritative raw seller id, reads ad_daily_metrics + durable coverage, and returns
 * { adsCoverage }. For the named-brand path (no ads) and every other report it returns {}. Injected:
 *   connections     -- DataDoe connections (for resolveDataDoeAccountIds); default is production.
 *   getAdMetrics    -- (accountId, from, to) -> ad_daily_metrics rows (getAdDailyMetrics).
 *   getCoverageState-- (accountId, sourceKey) -> { windows, status, latestMetricDate }.
 */
export function makeDailyAdsContextLoader({ connections, getAdMetrics, getCoverageState }) {
  return async ({ reportKey, accountId, planned }) => {
    if (reportKey !== "daily-reporting") return {};
    const context = (planned && planned.context) || {};
    if ((context.brand ?? "ALL") !== "ALL") return {}; // named-brand Daily uses no ads
    const { from, to } = context;
    // Authoritative raw seller/vendor id from account metadata -- never from rows. A missing or
    // ambiguous resolution fails closed (the derive then blocks and preserves last-known-good).
    const resolved = resolveDataDoeAccountIds([accountId], connections);
    if (!resolved || resolved.rawAccountIds.length !== 1) {
      throw new Error(`daily ads loader could not resolve a single raw seller/vendor id for "${accountId}".`);
    }
    const rawSellerId = resolved.rawAccountIds[0];
    const metricRows = await getAdMetrics(accountId, from, to);
    const coverageState = await getCoverageState(accountId, DAILY_ADS_SOURCE_KEY);
    return { adsCoverage: buildDailyAdsCoverage({ accountId, rawSellerId, from, to, metricRows, coverageState }) };
  };
}
