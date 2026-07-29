// Sales Movers — week-over-week ASIN gains and declines with an evidence-based
// driver decomposition.
//
// Source of truth: Sales & Traffic by ASIN & Date (defaultDataset). It is the
// only source carrying `session` and `page_views`, which are what separate a
// traffic problem from a conversion problem. Its RECURRING_DAILY window is 4
// days, so both comparison windows end at the latest date that actually
// reported units, never at today.
//
// Advertising context comes from Profit by SKU & Date, grouped to child ASIN
// with SUM aggregations only. Stock context comes from the latest FBA Inventory
// Health snapshot. Buy Box is deliberately NOT diagnosed here: aggregating
// buybox_percentage needs a weighted average over raw daily rows, which the Buy
// Box Loss report does properly on its own scope. This report reports "buy box
// not evaluated" instead of guessing.

import { addDaysStr, num } from "../datadoe.js";
import {
  brandLabel,
  fetchCatalog,
  fetchExportRowsStrict,
  fetchInventorySnapshot,
  fetchSalesTrafficLatestDate,
  sumField,
} from "./common.js";
import { PROFIT_BY_SKU, ROW_LIMITS, SALES_TRAFFIC } from "./sources.js";

export const SALES_MOVERS_REPORT_KEY = "sales-movers";
export const SALES_MOVERS_VERSION = "sales-movers-v1";

const WINDOW_DAYS = 7;

const TRAFFIC_COLUMNS = ["child_asin", "product_name"];
const TRAFFIC_AGGREGATIONS = [
  { column: "total_sales", aggregation: "sum", alias: "sales_sum" },
  { column: "total_units", aggregation: "sum", alias: "units_sum" },
  { column: "total_orders", aggregation: "sum", alias: "orders_sum" },
  { column: "session", aggregation: "sum", alias: "sessions_sum" },
  { column: "page_views", aggregation: "sum", alias: "page_views_sum" },
  { column: "units_shipped", aggregation: "sum", alias: "units_shipped_sum" },
  { column: "units_refunded", aggregation: "sum", alias: "units_refunded_sum" },
];

const ADS_COLUMNS = ["child_asin", "currency"];
const ADS_AGGREGATIONS = [
  { column: "ad_spend", aggregation: "sum", alias: "ad_spend_sum" },
  { column: "ad_sales", aggregation: "sum", alias: "ad_sales_sum" },
  { column: "ad_clicks", aggregation: "sum", alias: "ad_clicks_sum" },
];

function emptyWindowTotals() {
  return { sales: 0, units: 0, orders: 0, sessions: 0, pageViews: 0, unitsShipped: 0, unitsRefunded: 0 };
}

async function fetchTrafficWindow(apiKey, ids, window) {
  const rows = await fetchExportRowsStrict(
    apiKey, SALES_TRAFFIC.id, TRAFFIC_COLUMNS, ids, window.from, window.to, ROW_LIMITS.aggregated,
    {
      groupBy: TRAFFIC_COLUMNS,
      aggregations: TRAFFIC_AGGREGATIONS,
      orderByColumn: "child_asin",
      orderByDirection: "ASC",
    },
    `Sales Movers traffic export (${window.from} to ${window.to})`
  );
  const byAsin = new Map();
  const nameByAsin = new Map();
  for (const row of rows) {
    const asin = String(row.child_asin || "").trim();
    if (!asin) continue;
    const name = String(row.product_name || "").trim();
    if (name && !nameByAsin.has(asin)) nameByAsin.set(asin, name);
    // A defensive merge: the grouped export returns one row per ASIN, but
    // folding again keeps totals correct if the grain ever widens.
    const current = byAsin.get(asin) || emptyWindowTotals();
    current.sales += sumField(row, "sales_sum", "total_sales");
    current.units += sumField(row, "units_sum", "total_units");
    current.orders += sumField(row, "orders_sum", "total_orders");
    current.sessions += sumField(row, "sessions_sum", "session");
    current.pageViews += sumField(row, "page_views_sum", "page_views");
    current.unitsShipped += sumField(row, "units_shipped_sum", "units_shipped");
    current.unitsRefunded += sumField(row, "units_refunded_sum", "units_refunded");
    byAsin.set(asin, current);
  }
  return { byAsin, nameByAsin };
}

async function fetchAdsWindow(apiKey, ids, window) {
  const rows = await fetchExportRowsStrict(
    apiKey, PROFIT_BY_SKU.id, ADS_COLUMNS, ids, window.from, window.to, ROW_LIMITS.aggregated,
    {
      groupBy: ADS_COLUMNS,
      aggregations: ADS_AGGREGATIONS,
      orderByColumn: "child_asin",
      orderByDirection: "ASC",
    },
    `Sales Movers advertising export (${window.from} to ${window.to})`
  );
  const byAsin = new Map();
  const currencies = new Set();
  for (const row of rows) {
    const asin = String(row.child_asin || "").trim();
    if (!asin) continue;
    const currency = String(row.currency || "").trim();
    if (currency) currencies.add(currency);
    const current = byAsin.get(asin) || { spend: 0, sales: 0, clicks: 0 };
    current.spend += sumField(row, "ad_spend_sum", "ad_spend");
    current.sales += sumField(row, "ad_sales_sum", "ad_sales");
    current.clicks += sumField(row, "ad_clicks_sum", "ad_clicks");
    byAsin.set(asin, current);
  }
  return { byAsin, currencies: [...currencies].sort() };
}

/**
 * @param {object} options
 * @param {string} options.apiKey
 * @param {string[]} options.ids   exactly one authorised account
 * @param {string} options.to      as-of date (YYYY-MM-DD)
 */
export async function buildSalesMovers({ apiKey, ids, to }) {
  // Anchor on real reported data, not the calendar. Look back far enough to
  // find the latest completed date even after a long weekend of lag.
  const probeFrom = addDaysStr(to, -(SALES_TRAFFIC.lagDays + WINDOW_DAYS * 3));
  const salesLatestDate = await fetchSalesTrafficLatestDate(apiKey, ids, probeFrom, to);
  if (!salesLatestDate) {
    return {
      accountId: ids[0],
      asOf: to,
      salesLatestDate: null,
      lagDays: SALES_TRAFFIC.lagDays,
      sourceLabel: SALES_TRAFFIC.label,
      dataUnavailable: true,
      unavailableReason: `${SALES_TRAFFIC.label} reported no units for this account between ${probeFrom} and ${to}, so there is no completed week to compare. This is upstream source availability, not a zero-sales week.`,
      windows: null,
      rows: [],
      catalogBrands: [],
    };
  }

  const recent = { from: addDaysStr(salesLatestDate, -(WINDOW_DAYS - 1)), to: salesLatestDate };
  const prior = { from: addDaysStr(recent.from, -WINDOW_DAYS), to: addDaysStr(recent.from, -1) };

  const recentTraffic = await fetchTrafficWindow(apiKey, ids, recent);
  const priorTraffic = await fetchTrafficWindow(apiKey, ids, prior);
  const recentAds = await fetchAdsWindow(apiKey, ids, recent);
  const priorAds = await fetchAdsWindow(apiKey, ids, prior);
  const inventory = await fetchInventorySnapshot(apiKey, ids, to);
  const catalog = await fetchCatalog(apiKey, ids);

  const asins = new Set([...recentTraffic.byAsin.keys(), ...priorTraffic.byAsin.keys()]);
  const rows = [];
  for (const asin of asins) {
    const recentTotals = recentTraffic.byAsin.get(asin) || emptyWindowTotals();
    const priorTotals = priorTraffic.byAsin.get(asin) || emptyWindowTotals();
    // Drop the permanent zero tail this source emits for every catalog ASIN.
    if (
      recentTotals.sales === 0 && priorTotals.sales === 0
      && recentTotals.units === 0 && priorTotals.units === 0
      && recentTotals.sessions === 0 && priorTotals.sessions === 0
    ) continue;

    const meta = catalog.byAsin.get(asin) || {};
    const stock = inventory.byAsin.get(asin) || null;
    rows.push({
      asin,
      productName: meta.name || recentTraffic.nameByAsin.get(asin) || priorTraffic.nameByAsin.get(asin) || null,
      brand: brandLabel(meta.brand),
      recent: recentTotals,
      prior: priorTotals,
      ads: {
        recentSpend: num(recentAds.byAsin.get(asin)?.spend),
        recentSales: num(recentAds.byAsin.get(asin)?.sales),
        recentClicks: num(recentAds.byAsin.get(asin)?.clicks),
        priorSpend: num(priorAds.byAsin.get(asin)?.spend),
        priorSales: num(priorAds.byAsin.get(asin)?.sales),
        priorClicks: num(priorAds.byAsin.get(asin)?.clicks),
      },
      // null (not 0) when the whole snapshot is missing, so the UI can say so.
      inventory: inventory.available
        ? {
          available: num(stock?.available),
          inbound: num(stock?.inbound),
          daysOfSupply: stock?.daysOfSupply ?? null,
          unitsShippedT30: num(stock?.unitsShippedT30),
        }
        : null,
    });
  }

  const currencies = [...new Set([...recentAds.currencies, ...priorAds.currencies])];
  return {
    accountId: ids[0],
    asOf: to,
    salesLatestDate,
    lagDays: SALES_TRAFFIC.lagDays,
    sourceLabel: SALES_TRAFFIC.label,
    dataUnavailable: false,
    windows: { recent, prior, days: WINDOW_DAYS },
    // Profit by SKU is the only currency-bearing source here; Sales & Traffic
    // has no currency column, so a mixed-currency account is reported rather
    // than combined.
    currencies,
    buyBoxEvaluated: false,
    inventoryAvailable: inventory.available,
    inventorySnapshotDate: inventory.snapshotDate,
    rows,
    catalogBrands: catalog.catalogBrands,
  };
}
