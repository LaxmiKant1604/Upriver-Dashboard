// api/datadoe.js
//
// Serverless function that talks to DataDoe on the server side, so the
// DATADOE_API_KEY never reaches the browser. Deployed automatically by
// Vercel as /api/datadoe because it lives in the /api folder.
//
// IMPORTANT — please read:
// The endpoint paths below (ENDPOINTS) are inferred from DataDoe's MCP tool
// names (sellers_and_vendors_list, exports_create, exports_get,
// exports_raw_download), since DataDoe's docs confirm the REST API and MCP
// server expose the same underlying data. If DataDoe's actual REST paths
// turn out to differ, THIS is the only place that needs to change.
//
// To verify before relying on it, run this once with your real key
// (replace YOUR_KEY, never share the output containing your key):
//
//   curl -H "Authorization: Bearer YOUR_KEY" https://api.datadoe.com/api/v1/sellers-and-vendors
//
// If that doesn't return a list of your Amazon accounts, check
// https://api.datadoe.com/api/v1/docs for the correct path and let me know
// what you find — it's a one-line fix here.

import {
  DashboardAccessError,
  assertAccountAccess,
  assertAdmin,
  getAdDailyMetrics,
  getDashboardAccess,
  isSupabaseConfigured,
} from "../lib/server/supabase.js";
// Shared DataDoe transport. Extracted so every report — the seven original ones
// and the six insight reports — shares one 2-req/sec rate limiter, one export
// poller, and one row-cap policy.
import {
  DATADOE_BASE as BASE,
  ENDPOINTS,
  MAX_SELLER_OR_VENDOR_IDS_PER_EXPORT,
  addDaysStr,
  authHeaders,
  createExport,
  daysInMonthUTC,
  ddFetch,
  downloadExport,
  fetchAccounts,
  fetchExportRows,
  isDateStr,
  isFullCalendarMonthWindow,
  num,
  pad2s,
  pollExport,
  splitDateRangeByMonth,
} from "../lib/server/datadoe.js";
import { serveSharedReport, wantsRefresh } from "../lib/server/report-store.js";
import { buildSalesMovers, SALES_MOVERS_REPORT_KEY, SALES_MOVERS_VERSION } from "../lib/server/reports/sales-movers.js";
import { buildListingHealth, LISTING_HEALTH_REPORT_KEY, LISTING_HEALTH_VERSION } from "../lib/server/reports/listing-health.js";
import { buildBuyBoxLoss, BUY_BOX_REPORT_KEY, BUY_BOX_VERSION } from "../lib/server/reports/buy-box.js";

const ACCOUNT_SCOPED_ACTIONS = new Set([
  "sales", "brand-sales", "daily", "reconciliation", "sku-pl",
  "keyword-rank", "content-changes", "fba-plan",
  // Insight reports. Each is single-account and served from the shared
  // Supabase snapshot unless an explicit refresh is requested.
  "sales-movers", "listing-health", "buy-box-loss",
  "returns-leakage", "ppc-performance", "listing-optimizer",
  "priority-feed",
]);

// Every insight report is strictly one selected account: the shared snapshot,
// the refresh lock, and the permission check are all keyed by a single account.
function singleAccountId(req, res, label) {
  const ids = String(req.query.ids || "").split(",").filter(Boolean);
  if (ids.length !== 1) {
    res.status(400).json({ error: `${label} requires exactly one selected account.` });
    return null;
  }
  return ids;
}

function reportAsOf(req, res) {
  const to = String(req.query.to || "");
  if (!isDateStr(to)) {
    res.status(400).json({ error: "Invalid or missing `to` date. Use YYYY-MM-DD." });
    return null;
  }
  return to;
}

// Source table for daily sales/units per account. 401ffcd7e5 ("Sales &
// Traffic by ASIN & Date") is the user-confirmed correct sales report.
// (Previously used b24cd69c06 "Profit by Date".) DataDoe aggregates each
// export by the non-metric columns selected, so requesting only date +
// seller_or_vendor_id returns one row per account per day.
// Dashboard source: fast daily per-account rollup ("Profit by Date",
// ~1 row/account/day, includes order counts). Used by action=sales for the
// multi-account dashboard, where per-ASIN volume would be millions of rows.
const DASHBOARD_SOURCE_ID = "b24cd69c06";
const DASHBOARD_COLUMNS = [
  "date",
  "seller_or_vendor_id",
  "seller_or_vendor_name",
  "marketplace_country_code",
  "currency",
  "total_sales",
  "total_units_sold",
  "total_orders",
];

// Main dashboard sales source. Order Line Items is the Seller Central order
// report equivalent: `item_price_value` is the source-of-truth ordered item
// value, including pending orders. It intentionally replaces Profit by SKU &
// Date, which includes shipped orders only and therefore cannot reconcile to
// Seller Central's Order Report total.
const ORDER_LINE_ITEMS_SOURCE_ID = "89b27535d27c2a94db5ae39af4717f542624ff4df7802fd633e16c78674a1778";
const ORDER_SALES_COLUMNS = [
  "date",
  "seller_or_vendor_id",
  "seller_or_vendor_name",
  "marketplace_country_code",
  "item_price_currency",
  "child_asin",
];
const ORDER_SALES_AGGREGATIONS = [
  { column: "item_price_value", aggregation: "sum", alias: "total_sales_sum" },
  { column: "quantity", aggregation: "sum", alias: "total_units_sold_sum" },
];
const ORDER_SALES_GROUP_BY = [
  "date",
  "seller_or_vendor_id",
  "seller_or_vendor_name",
  "marketplace_country_code",
  "item_price_currency",
  "child_asin",
];

// Product Catalog by ASIN. This is the authoritative ASIN-to-brand mapping
// used to populate the brand selector, including brands with no sales in the
// selected reporting window.
const PRODUCT_CATALOG_SOURCE_ID = "68d2de238e8d1a47bc56a981a99d54558507b0bafb1e09f1b3e95fb7750a17a8";
const PRODUCT_CATALOG_COLUMNS = [
  "child_asin",
  "parent_asin",
  "product_name",
  "product_brand",
];

// Amazon SP-API BRANDED_ITEM_CONTENT_CHANGE notifications. This real-time
// source reports changes to A+ / branded item content after Amazon publishes
// them. Its payload is intentionally normalised before it reaches the browser:
// notification payloads vary by Amazon event version and can be very large.
const CONTENT_CHANGE_SOURCE_ID = "aec3d5976911a7a80110c08801a741e4f0a25dd997d639f5d918284d905a4758";
const CONTENT_CHANGE_COLUMNS = [
  "event_time",
  "sp_api_notification_id",
  "sp_api_notification_type",
  "notification_metadata",
  "payload",
];

// Daily Reporting sales source: "Sales & Traffic by ASIN & Date" (401ffcd7e5),
// the user-confirmed accurate report. It is per-ASIN, so DataDoe aggregates it
// by account/date before the server returns it to the dashboard.
const DAILY_SALES_SOURCE_ID = "401ffcd7e5";
const DAILY_SALES_COLUMNS = [
  "date",
  "seller_or_vendor_id",
];
const DAILY_SALES_GROUP_BY = ["date", "seller_or_vendor_id"];
const DAILY_SALES_AGGREGATIONS = [
  { column: "total_sales", aggregation: "sum", alias: "total_sales_sum" },
  { column: "total_units", aggregation: "sum", alias: "total_units_sum" },
];
// A named brand needs ASIN-level grouping before it can be joined to the
// Product Catalog. The all-brand report keeps the more compact date grouping.
const DAILY_BRAND_SALES_COLUMNS = ["date", "seller_or_vendor_id", "child_asin"];
const DAILY_BRAND_SALES_GROUP_BY = ["date", "seller_or_vendor_id", "child_asin"];

// Advertising source (ad sales / spend / clicks), merged into the daily report
// by (account, date).
const ADS_SOURCE_ID = "08cdc77d3d";
const ADS_COLUMNS = [
  "date",
  "seller_or_vendor_id",
];
const ADS_GROUP_BY = ["date", "seller_or_vendor_id"];
const ADS_AGGREGATIONS = [
  { column: "ad_sales", aggregation: "sum", alias: "ad_sales_sum" },
  { column: "ad_spend", aggregation: "sum", alias: "ad_spend_sum" },
  { column: "ad_clicks", aggregation: "sum", alias: "ad_clicks_sum" },
];

// Amazon Reconciliation Dashboard. These sources are intentionally kept at
// order / settlement-event grain so the browser can make cross-month timing
// visible instead of comparing incompatible daily aggregates.
const RECONCILIATION_SETTLEMENTS_SOURCE_ID = "732dac689a6545697c2f2e36c61b2c9e93187053bcce2999914183c6f490df27";
const RECONCILIATION_ORDER_COLUMNS = [
  "date", "order_date", "amazon_order_id", "child_asin", "amazon_order_status",
  "fulfillment_channel", "order_is_business", "item_price_currency",
];
const RECONCILIATION_ORDER_GROUP_BY = [...RECONCILIATION_ORDER_COLUMNS];
const RECONCILIATION_ORDER_AGGREGATIONS = [
  { column: "quantity", aggregation: "sum", alias: "quantity_sum" },
  { column: "item_price_value", aggregation: "sum", alias: "item_price_sum" },
  { column: "item_tax_value", aggregation: "sum", alias: "item_tax_sum" },
];
const RECONCILIATION_SETTLEMENT_COLUMNS = ["date", "amazon_order_id", "settlement_type", "currency"];
const RECONCILIATION_SETTLEMENT_GROUP_BY = [...RECONCILIATION_SETTLEMENT_COLUMNS];
const RECONCILIATION_SETTLEMENT_AGGREGATIONS = [
  { column: "item_price", aggregation: "sum", alias: "item_price_sum" },
  { column: "item_tax", aggregation: "sum", alias: "item_tax_sum" },
  { column: "referral_fee", aggregation: "sum", alias: "referral_fee_sum" },
  { column: "fba_per_unit_fulfillment_fee", aggregation: "sum", alias: "fba_fee_sum" },
  { column: "refunded_amount", aggregation: "sum", alias: "refunded_amount_sum" },
  { column: "total", aggregation: "sum", alias: "total_sum" },
];
// ===== SKU P&L Analyzer source =====
// "Profit by SKU & Date" (57a0...) is DataDoe's canonical Premium P&L table: it
// already pre-joins settlements, COGS, and advertising, so `profit` is trusted
// directly and never rebuilt from raw orders/settlements. Aggregated per SKU with
// enough grouping (child_asin/product_name/product_brand/currency) to support
// local product, brand, and currency filtering. Ratio columns (acos/tacos/roi)
// are deliberately NOT summed — the browser recomputes ratios from the sums.
const SKU_PL_SOURCE_ID = "57a0cb319c10a395853afc0671579bf7ef0ff45d8a40c88ed9d2a5f61b4169a4";
const SKU_PL_GROUP_BY = ["sku", "child_asin", "product_name", "product_brand", "currency"];
const SKU_PL_COLUMNS = [...SKU_PL_GROUP_BY];
const SKU_PL_AGGREGATIONS = [
  { column: "total_sales", aggregation: "sum", alias: "total_sales_sum" },
  { column: "profit", aggregation: "sum", alias: "profit_sum" },
  { column: "total_cost", aggregation: "sum", alias: "total_cost_sum" },
  { column: "ad_spend", aggregation: "sum", alias: "ad_spend_sum" },
  { column: "total_fees", aggregation: "sum", alias: "total_fees_sum" },
  { column: "cogs_total", aggregation: "sum", alias: "cogs_total_sum" },
  { column: "total_units_sold", aggregation: "sum", alias: "units_sum" },
];
const SKU_PL_ROW_LIMIT = 50000;

// ===== Keyword Rank & Share Tracker sources =====
// Search Query Performance is Amazon Brand Analytics data at the exact
// child-ASIN/query/period grain needed for organic-rank and share-of-query
// monitoring. These tables are not default data sources, so the action below
// turns an organisation-disabled response into an actionable setup message.
const SQP_WEEKLY_SOURCE_ID = "81aa5b4cc248bb70de405b9ff9d51290b9232f84570d76ba2a1289b67b6595fb";
const SQP_MONTHLY_SOURCE_ID = "df4160ff8e1add239172a69ebd6c8abfec7116ee4a17720983757b1b55599830";
const SQP_COLUMNS = [
  "date",
  "child_asin",
  "search_query",
  "search_query_volume",
  "search_query_total_impression_count",
  "search_query_total_click_count",
  "search_query_total_purchase_count",
  "child_asin_impression_count",
  "child_asin_click_count",
  "child_asin_purchase_count",
  "child_asin_organic_search_rank",
];
const SQP_ROW_LIMIT = 50000;
const SQP_WEEKLY_LOOKBACK_DAYS = 84;
const SQP_MONTHLY_LOOKBACK_DAYS = 365;

// ===== FBA Shipment Plan sources (verified against api/v1/spec/data-scheme) =====
// Per-ASIN unit sales. "Sales & Traffic by ASIN & Date" (401ffcd7e5) exposes
// child_asin + total_units and is the report the Daily Reporting view already
// reconciled to Seller Central. It is used here for the 3 completed months and
// current-month MTD unit velocity.
const PLAN_SALES_SOURCE_ID = "401ffcd7e5";
// Live FBA inventory snapshot. "FBA Inventory Health" (44fc5ba0...) is the only
// source that splits reserved into reserved_fc_transfer / reserved_fc_processing
// / reserved_customer_order and splits inbound into working / shipped / received,
// which is exactly what the shipment-plan definition requires. It is per SKU per
// snapshot date; the latest snapshot date is kept and SKUs are folded to ASIN.
const FBA_HEALTH_SOURCE_ID = "44fc5ba0ce81a7807601f6d7a9b8b7aaec64be4c7e046ea30dc6864d1a4aa823";
const FBA_HEALTH_COLUMNS = [
  "date",
  "marketplace_country_code",
  "child_asin",
  "sku",
  "fnsku",
  "product_name",
  "available",
  "reserved_fc_transfer",
  "reserved_fc_processing",
  "inbound_working",
  "inbound_shipped",
  "inbound_received",
];
// AWD available inventory (US marketplace only). The "Listings" source
// (ba689c05...) exposes awd_available_distributable_quantity per SKU. Listings
// has no date column, so its exports must not send a date range or a date
// orderBy.
const LISTINGS_SOURCE_ID = "ba689c05d7f7cee1a1690990c28995680a0654b7ed258230f4173d61bbcd1ab3";
const LISTINGS_AWD_COLUMNS = [
  "child_asin",
  "sku",
  "fnsku",
  "awd_available_distributable_quantity",
];
// Inventory Health is a daily snapshot; look back a short window and keep the
// latest snapshot date. DESC ordering guarantees the full latest snapshot is at
// the front of the result, so the row limit only ever drops older snapshots.
const PLAN_INVENTORY_LOOKBACK_DAYS = 10;
const PLAN_INVENTORY_ROW_LIMIT = 15000;
const PLAN_SALES_ROW_LIMIT = 30000;

const DASHBOARD_ROW_LIMIT = 5000;
// Order rows are grouped by day and ASIN before download. A year of data can
// still contain more than 5,000 ASIN/day groups, so use a higher export cap.
const ORDER_SALES_ROW_LIMIT = 50000;
const CATALOG_ROW_LIMIT = 10000;
// Daily sources are aggregated by account/date before download, so a compact
// limit safely covers years of history without raw ASIN row truncation.
const DAILY_ROW_LIMIT = 5000;
const DAILY_BRAND_ROW_LIMIT = 50000;
const RECONCILIATION_ROW_LIMIT = 50000;
const CONTENT_CHANGE_ROW_LIMIT = 1000;

function sqpDistinctPeriods(rows) {
  return [...new Set(rows.map((row) => String(row.date || "")).filter(Boolean))].sort();
}

async function fetchSqpRows(apiKey, sourceId, sellerOrVendorIds, from, to) {
  const rows = await fetchExportRows(
    apiKey, sourceId, SQP_COLUMNS, sellerOrVendorIds, from, to, SQP_ROW_LIMIT,
    { orderByColumn: "date", orderByDirection: "ASC" }
  );
  // A full result exactly at the cap is indistinguishable from a truncated one.
  // Refuse to save a misleading keyword trend rather than silently dropping
  // long-tail terms from the money-keyword watch list.
  if (rows.length >= SQP_ROW_LIMIT) {
    throw new Error(`Search Query Performance export reached the ${SQP_ROW_LIMIT.toLocaleString("en-US")} row cap. The Keyword Rank report was not saved because a partial keyword history would be misleading.`);
  }
  return rows;
}

function orderSalesByBrand(rows, catalogRows) {
  const brandByAsin = new Map();
  for (const catalogRow of catalogRows) {
    const asin = String(catalogRow.child_asin || "").trim();
    const brand = String(catalogRow.product_brand || "").trim();
    if (asin && brand) brandByAsin.set(asin, brand);
  }

  // The export is compact at date/ASIN grain. Join the catalog brand and fold
  // those ASIN rows again so the browser receives only date/brand totals.
  const totals = new Map();
  for (const row of rows) {
    const productBrand = brandByAsin.get(String(row.child_asin || "").trim()) || "Unassigned";
    const currency = row.item_price_currency || row.currency || null;
    const key = [
      row.date,
      row.seller_or_vendor_id,
      row.seller_or_vendor_name,
      row.marketplace_country_code,
      currency,
      productBrand,
    ].join("|");
    const current = totals.get(key) || {
      date: row.date,
      seller_or_vendor_id: row.seller_or_vendor_id,
      seller_or_vendor_name: row.seller_or_vendor_name,
      marketplace_country_code: row.marketplace_country_code,
      currency,
      product_brand: productBrand,
      total_sales: 0,
      total_units_sold: 0,
      unpriced_units: 0,
      // A compact ASIN-level export cannot deduplicate order IDs across ASINs.
      // Leave Orders/AOV unavailable rather than showing a misleading value.
      total_orders: null,
    };
    const sales = num(row.total_sales_sum ?? row.item_price_value);
    const units = num(row.total_units_sold_sum ?? row.quantity);
    current.total_sales += sales;
    current.total_units_sold += units;
    // A zero-valued group with units is an upstream order-data completeness
    // signal. Preserve it so the UI can warn instead of silently understating
    // sales when Amazon/DataDoe has not populated an item price yet.
    if (sales === 0 && units > 0) current.unpriced_units += units;
    totals.set(key, current);
  }
  return [...totals.values()];
}

function normalizeDailySalesRows(rows) {
  return rows.map((row) => ({
    ...row,
    total_sales: num(row.total_sales_sum ?? row.total_sales),
    total_units: num(row.total_units_sum ?? row.total_units),
  }));
}

// Join the ASIN-level daily export to the account's catalog, then fold the
// chosen brand back to one row per day for the existing Daily Reporting table.
function dailyRowsForBrand(rows, catalogRows, brand) {
  const brandByAsin = new Map();
  for (const catalogRow of catalogRows) {
    const asin = String(catalogRow.child_asin || "").trim();
    const productBrand = String(catalogRow.product_brand || "").trim();
    if (asin && productBrand && !brandByAsin.has(asin)) brandByAsin.set(asin, productBrand);
  }
  const totals = new Map();
  for (const row of rows) {
    if (brandByAsin.get(String(row.child_asin || "").trim()) !== brand) continue;
    const key = `${row.seller_or_vendor_id}|${row.date}`;
    const current = totals.get(key) || {
      date: row.date,
      seller_or_vendor_id: row.seller_or_vendor_id,
      total_sales: 0,
      total_units: 0,
      total_units_sold: 0,
    };
    current.total_sales += num(row.total_sales_sum ?? row.total_sales);
    current.total_units += num(row.total_units_sum ?? row.total_units);
    current.total_units_sold = current.total_units;
    totals.set(key, current);
  }
  return [...totals.values()];
}

function normalizeAdRows(rows) {
  return rows.map((row) => ({
    ...row,
    ad_sales: num(row.ad_sales_sum ?? row.ad_sales),
    ad_spend: num(row.ad_spend_sum ?? row.ad_spend),
    ad_clicks: num(row.ad_clicks_sum ?? row.ad_clicks),
  }));
}

function catalogBrandNames(rows) {
  return [...new Set(
    rows
      .map((row) => String(row.product_brand || "").trim())
      .filter(Boolean)
  )].sort((a, b) => a.localeCompare(b));
}

function parseJsonValue(value) {
  if (!value || typeof value !== "string") return value;
  try { return JSON.parse(value); } catch (e) { return value; }
}

function compactJsonPreview(value, maxLength = 420) {
  const parsed = parseJsonValue(value);
  const text = typeof parsed === "string" ? parsed : JSON.stringify(parsed || {});
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

// DataDoe passes through Amazon notification payloads whose nesting changes
// over time. Find ASIN values by semantic key names as well as any exact ASIN
// pattern in strings, so known payload variants remain brand-filterable.
function notificationAsins(value) {
  const found = new Set();
  const visit = (node, key = "") => {
    if (node === null || node === undefined) return;
    if (typeof node === "string") {
      const text = node.trim();
      if (/asin/i.test(key) && /^[A-Z0-9]{10}$/i.test(text)) found.add(text.toUpperCase());
      const matches = text.match(/\b[A-Z0-9]{10}\b/gi) || [];
      matches.forEach((match) => found.add(match.toUpperCase()));
      return;
    }
    if (Array.isArray(node)) { node.forEach((item) => visit(item, key)); return; }
    if (typeof node === "object") Object.entries(node).forEach(([childKey, child]) => visit(child, childKey));
  };
  visit(parseJsonValue(value));
  return [...found].sort();
}

function compactContentChangeEvents(rows, catalogRows) {
  const brandByAsin = new Map();
  for (const catalogRow of catalogRows) {
    const asin = String(catalogRow.child_asin || "").trim().toUpperCase();
    const brand = String(catalogRow.product_brand || "").trim();
    if (asin && brand && !brandByAsin.has(asin)) brandByAsin.set(asin, brand);
  }
  return rows.map((row) => {
    const asins = notificationAsins(row.payload);
    const brands = [...new Set(asins.map((asin) => brandByAsin.get(asin)).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    return {
      eventTime: row.event_time || null,
      notificationId: String(row.sp_api_notification_id || "").trim() || null,
      notificationType: String(row.sp_api_notification_type || "BRANDED_ITEM_CONTENT_CHANGE").trim(),
      asins,
      brands,
      metadataPreview: compactJsonPreview(row.notification_metadata),
      payloadPreview: compactJsonPreview(row.payload),
    };
  }).sort((a, b) => String(b.eventTime || "").localeCompare(String(a.eventTime || "")));
}

/* ===== FBA Shipment Plan helpers =====
   Date and range helpers now live in lib/server/datadoe.js so the insight
   reports share exactly the same UTC string arithmetic. */

function reconciliationOrders(rows, catalogRows) {
  const brandByAsin = new Map();
  for (const row of catalogRows) {
    const asin = String(row.child_asin || "").trim();
    const brand = String(row.product_brand || "").trim() || "Unassigned";
    if (asin && !brandByAsin.has(asin)) brandByAsin.set(asin, brand);
  }
  const byOrder = new Map();
  for (const row of rows) {
    const orderId = String(row.amazon_order_id || "").trim();
    if (!orderId) continue;
    const brand = brandByAsin.get(String(row.child_asin || "").trim()) || "Unassigned";
    const current = byOrder.get(orderId) || {
      orderId,
      orderDate: row.order_date || row.date || null,
      status: row.amazon_order_status || "Unknown",
      fulfillmentChannel: row.fulfillment_channel || "Unknown",
      isBusiness: row.order_is_business === true || String(row.order_is_business).toLowerCase() === "true",
      currency: row.item_price_currency || null,
      quantity: 0,
      orderRevenue: 0,
      orderTax: 0,
      brandBreakdown: {},
    };
    const quantity = num(row.quantity_sum ?? row.quantity);
    const revenue = num(row.item_price_sum ?? row.item_price_value);
    const tax = num(row.item_tax_sum ?? row.item_tax_value);
    current.quantity += quantity;
    current.orderRevenue += revenue;
    current.orderTax += tax;
    const brandTotal = current.brandBreakdown[brand] || { quantity: 0, orderRevenue: 0, orderTax: 0 };
    brandTotal.quantity += quantity;
    brandTotal.orderRevenue += revenue;
    brandTotal.orderTax += tax;
    current.brandBreakdown[brand] = brandTotal;
    byOrder.set(orderId, current);
  }
  // The browser only needs the list of brands: named-brand reconciliation
  // accepts single-brand orders and intentionally excludes mixed-brand orders
  // because settlement entries cannot be split reliably by item. Do not send
  // duplicate per-brand monetary maps for every order in a large six-month
  // payload.
  return [...byOrder.values()].map(({ brandBreakdown, ...order }) => ({
    ...order,
    brands: Object.keys(brandBreakdown),
  }));
}

function reconciliationSettlements(rows) {
  return rows.map((row) => ({
    settlementDate: row.date || null,
    orderId: String(row.amazon_order_id || "").trim() || null,
    settlementType: String(row.settlement_type || "OTHER").trim().toUpperCase(),
    currency: row.currency || null,
    settledRevenue: num(row.item_price_sum ?? row.item_price),
    settledTax: num(row.item_tax_sum ?? row.item_tax),
    referralFee: num(row.referral_fee_sum ?? row.referral_fee),
    fbaFee: num(row.fba_fee_sum ?? row.fba_per_unit_fulfillment_fee),
    refundedAmount: num(row.refunded_amount_sum ?? row.refunded_amount),
    netPayout: num(row.total_sum ?? row.total),
  }));
}

async function reconciliationRowsByMonth(apiKey, sourceId, columns, ids, from, to, aggregations, groupBy) {
  const result = [];
  for (const window of splitDateRangeByMonth(from, to)) {
    const rows = await fetchExportRows(
      apiKey, sourceId, columns, ids, window.from, window.to, RECONCILIATION_ROW_LIMIT,
      { groupBy, aggregations, orderByColumn: "date", orderByDirection: "ASC" }
    );
    // Exact row-cap results are unsafe: the API may have truncated more data.
    if (rows.length >= RECONCILIATION_ROW_LIMIT) {
      throw new Error(`Reconciliation export reached the ${RECONCILIATION_ROW_LIMIT.toLocaleString("en-US")} row cap for ${window.from.slice(0, 7)}. The report was not saved because a partial reconciliation would be misleading.`);
    }
    result.push(...rows);
  }
  return result;
}

// Fetch Profit by SKU & Date in monthly batches and fold to one row per
// (currency|sku|child_asin), with per-month numeric sums kept under `byMonth`.
// Each month is aggregated server-side by DataDoe; hitting the row cap throws so
// a truncated (misleading) P&L is never returned as complete.
async function fetchSkuPlRows(apiKey, sellerOrVendorIds, windows) {
  const combined = new Map();
  for (const window of windows) {
    const monthKey = window.from.slice(0, 7);
    const rows = await fetchExportRows(
      apiKey, SKU_PL_SOURCE_ID, SKU_PL_COLUMNS, sellerOrVendorIds, window.from, window.to, SKU_PL_ROW_LIMIT,
      { groupBy: SKU_PL_GROUP_BY, aggregations: SKU_PL_AGGREGATIONS, orderByColumn: "sku", orderByDirection: "ASC" }
    );
    if (rows.length >= SKU_PL_ROW_LIMIT) {
      throw new Error(`SKU P&L export reached the ${SKU_PL_ROW_LIMIT.toLocaleString("en-US")} row cap for ${monthKey}. The report was not saved because a partial P&L would be misleading.`);
    }
    for (const row of rows) {
      const sku = String(row.sku || "").trim();
      const childAsin = String(row.child_asin || "").trim();
      const currency = String(row.currency || "").trim() || null;
      // Never merge across currencies: currency is part of the identity key.
      const key = `${currency || "?"}|${sku}|${childAsin}`;
      let entry = combined.get(key);
      if (!entry) {
        entry = {
          sku: sku || null,
          asin: childAsin || null,
          productName: String(row.product_name || "").trim() || null,
          brand: String(row.product_brand || "").trim() || null,
          currency,
          byMonth: {},
        };
        combined.set(key, entry);
      }
      // Fill missing product name/brand from any month that has them.
      if (!entry.productName) entry.productName = String(row.product_name || "").trim() || null;
      if (!entry.brand) entry.brand = String(row.product_brand || "").trim() || null;
      const bucket = entry.byMonth[monthKey] || { sales: 0, profit: 0, cost: 0, adSpend: 0, fees: 0, cogs: 0, units: 0 };
      bucket.sales += num(row.total_sales_sum ?? row.total_sales);
      bucket.profit += num(row.profit_sum ?? row.profit);
      bucket.cost += num(row.total_cost_sum ?? row.total_cost);
      bucket.adSpend += num(row.ad_spend_sum ?? row.ad_spend);
      bucket.fees += num(row.total_fees_sum ?? row.total_fees);
      bucket.cogs += num(row.cogs_total_sum ?? row.cogs_total);
      bucket.units += num(row.units_sum ?? row.total_units_sold);
      entry.byMonth[monthKey] = bucket;
    }
  }
  return [...combined.values()];
}

async function fetchDailyBrandSalesRows(apiKey, sellerOrVendorIds, from, to) {
  const allRows = [];
  for (const window of splitDateRangeByMonth(from, to)) {
    const rows = await fetchExportRows(
      apiKey,
      DAILY_SALES_SOURCE_ID,
      DAILY_BRAND_SALES_COLUMNS,
      sellerOrVendorIds,
      window.from,
      window.to,
      DAILY_BRAND_ROW_LIMIT,
      { groupBy: DAILY_BRAND_SALES_GROUP_BY, aggregations: DAILY_SALES_AGGREGATIONS }
    );
    allRows.push(...rows);
  }
  return allRows;
}

// The 3 completed calendar months before the month containing `toStr`, plus the
// current (MTD) month window ending at `toStr`.
function planMonthWindows(toStr) {
  const [ty, tm] = toStr.split("-").map(Number);
  const completed = [];
  for (let i = 3; i >= 1; i--) {
    const total = ty * 12 + (tm - 1) - i;
    const y = Math.floor(total / 12), m = (((total % 12) + 12) % 12) + 1;
    completed.push({
      key: `${y}-${pad2s(m)}`,
      from: `${y}-${pad2s(m)}-01`,
      to: `${y}-${pad2s(m)}-${pad2s(daysInMonthUTC(y, m))}`,
    });
  }
  const current = {
    key: `${ty}-${pad2s(tm)}`,
    from: `${ty}-${pad2s(tm)}-01`,
    to: toStr,
    daysInMonth: daysInMonthUTC(ty, tm),
  };
  return { completed, current };
}

// Sum per-ASIN units for one grouped Sales & Traffic export window.
async function planAsinUnits(apiKey, ids, from, to) {
  const rows = await fetchExportRows(
    apiKey, PLAN_SALES_SOURCE_ID, ["child_asin"], ids, from, to, PLAN_SALES_ROW_LIMIT,
    { groupBy: ["child_asin"], aggregations: [{ column: "total_units", aggregation: "sum", alias: "units_sum" }], orderByColumn: "child_asin", orderByDirection: "ASC" }
  );
  const byAsin = new Map();
  for (const r of rows) {
    const asin = String(r.child_asin || "").trim();
    if (!asin) continue;
    byAsin.set(asin, (byAsin.get(asin) || 0) + num(r.units_sum ?? r.total_units));
  }
  return byAsin;
}

// Fold advertising rows (ad_sales/ad_spend/ad_clicks) into the sales rows by
// (account, date). Ad totals attach to the first sales row for each key so
// downstream range sums count them exactly once; days with ad activity but no
// sales row get a synthetic zero-sales row.
function mergeSalesAndAds(salesRows, adRows) {
  const firstByKey = new Map();
  for (const r of salesRows) {
    const key = `${r.seller_or_vendor_id}|${r.date}`;
    if (!firstByKey.has(key)) firstByKey.set(key, r);
  }
  for (const a of adRows) {
    const key = `${a.seller_or_vendor_id}|${a.date}`;
    const target = firstByKey.get(key);
    if (target) {
      target.ad_sales = num(target.ad_sales) + num(a.ad_sales);
      target.ad_spend = num(target.ad_spend) + num(a.ad_spend);
      target.ad_clicks = num(target.ad_clicks) + num(a.ad_clicks);
    } else {
      const row = {
        date: a.date,
        seller_or_vendor_id: a.seller_or_vendor_id,
        currency: a.currency,
        total_sales: 0,
        total_units: 0,
        total_units_sold: 0,
        ad_sales: num(a.ad_sales),
        ad_spend: num(a.ad_spend),
        ad_clicks: num(a.ad_clicks),
      };
      salesRows.push(row);
      firstByKey.set(key, row);
    }
  }
  return salesRows;
}

export default async function handler(req, res) {
  try {
    const access = await getDashboardAccess(req);
    const apiKey = process.env.DATADOE_API_KEY;
    if (!apiKey) {
      res.status(500).json({ error: "DATADOE_API_KEY is not set in this deployment's environment variables." });
      return;
    }
    const action = req.query.action;

    if (ACCOUNT_SCOPED_ACTIONS.has(action)) {
      const ids = String(req.query.ids || "").split(",").filter(Boolean);
      if (ids.length) assertAccountAccess(access, ids);
    }
    if (action === "fields" || action === "sample") assertAdmin(access);

    if (action === "accounts") {
      const accounts = await fetchAccounts(apiKey);
      const allowedAccounts = access.role === "admin"
        ? accounts
        : accounts.filter((account) => access.accountIds.includes(String(account.id)));
      res.status(200).json({ accounts: allowedAccounts });
      return;
    }

    if (action === "sales") {
      const { ids, from, to } = req.query;
      if (!ids || !from || !to) {
        res.status(400).json({ error: "Missing required params: ids, from, to" });
        return;
      }
      const sellerOrVendorIds = String(ids).split(",").filter(Boolean);
      const rows = await fetchExportRows(apiKey, DASHBOARD_SOURCE_ID, DASHBOARD_COLUMNS, sellerOrVendorIds, from, to, DASHBOARD_ROW_LIMIT);
      res.status(200).json({ rows });
      return;
    }

    // Brand-aware dashboard data for one selected account. Order Line Items
    // is rolled up by date + ASIN, then joined to the catalog's product_brand
    // field server-side. This keeps headline sales aligned to Seller Central's
    // Order Report while retaining the existing brand filter.
    if (action === "brand-sales") {
      const { ids, from, to } = req.query;
      if (!ids || !from || !to) {
        res.status(400).json({ error: "Missing required params: ids, from, to" });
        return;
      }
      const sellerOrVendorIds = String(ids).split(",").filter(Boolean);
      if (sellerOrVendorIds.length !== 1) {
        res.status(400).json({ error: "Dashboard refresh requires exactly one selected account." });
        return;
      }
      const rawRows = await fetchExportRows(
        apiKey,
        ORDER_LINE_ITEMS_SOURCE_ID,
        ORDER_SALES_COLUMNS,
        sellerOrVendorIds,
        from,
        to,
        ORDER_SALES_ROW_LIMIT,
        { groupBy: ORDER_SALES_GROUP_BY, aggregations: ORDER_SALES_AGGREGATIONS }
      );
      const catalog = await fetchExportRows(
        apiKey,
        PRODUCT_CATALOG_SOURCE_ID,
        PRODUCT_CATALOG_COLUMNS,
        sellerOrVendorIds,
        from,
        to,
        CATALOG_ROW_LIMIT,
        { orderByColumn: "child_asin" }
      );
      res.status(200).json({ rows: orderSalesByBrand(rawRows, catalog), catalogBrands: catalogBrandNames(catalog) });
      return;
    }

    // Daily Reporting data. All brands stay compact at account/date grain;
    // a named brand is joined through the catalog at ASIN/day grain first.
    if (action === "daily") {
      const { ids, from, to } = req.query;
      const brand = String(req.query.brand || "ALL");
      if (!ids || !from || !to) {
        res.status(400).json({ error: "Missing required params: ids, from, to" });
        return;
      }
      const sellerOrVendorIds = String(ids).split(",").filter(Boolean);
      if (sellerOrVendorIds.length !== 1) {
        res.status(400).json({ error: "Daily Reporting requires exactly one selected account." });
        return;
      }

      if (brand !== "ALL") {
        const salesRaw = await fetchDailyBrandSalesRows(apiKey, sellerOrVendorIds, from, to);
        const catalog = await fetchExportRows(
          apiKey,
          PRODUCT_CATALOG_SOURCE_ID,
          PRODUCT_CATALOG_COLUMNS,
          sellerOrVendorIds,
          from,
          to,
          CATALOG_ROW_LIMIT,
          { orderByColumn: "child_asin" }
        );
        // Advertising data is account-level in the current source. Omitting it
        // is safer than presenting the whole account's spend as one brand's.
        res.status(200).json({ rows: dailyRowsForBrand(salesRaw, catalog, brand), brandFiltered: true });
        return;
      }

      const salesRaw = await fetchExportRows(
        apiKey,
        DAILY_SALES_SOURCE_ID,
        DAILY_SALES_COLUMNS,
        sellerOrVendorIds,
        from,
        to,
        DAILY_ROW_LIMIT,
        { groupBy: DAILY_SALES_GROUP_BY, aggregations: DAILY_SALES_AGGREGATIONS }
      );
      const rows = normalizeDailySalesRows(salesRaw);
      for (const r of rows) r.total_units_sold = r.total_units;
      // The scheduled Ads worker owns campaign data. Reading its saved
      // upserts avoids another DataDoe export whenever a user opens or
      // refreshes Daily Reporting. Keep a REST fallback until the first
      // scheduled seed has completed for an existing deployment.
      let ads;
      if (isSupabaseConfigured()) {
        const savedAds = await getAdDailyMetrics(sellerOrVendorIds[0], from, to);
        ads = normalizeAdRows(savedAds.map((row) => ({
          date: row.metric_date,
          seller_or_vendor_id: sellerOrVendorIds[0],
          currency: row.currency,
          ad_sales: row.ad_sales,
          ad_spend: row.ad_spend,
          ad_clicks: row.ad_clicks,
        })));
      } else {
        const adRaw = await fetchExportRows(
          apiKey,
          ADS_SOURCE_ID,
          ADS_COLUMNS,
          sellerOrVendorIds,
          from,
          to,
          DAILY_ROW_LIMIT,
          { groupBy: ADS_GROUP_BY, aggregations: ADS_AGGREGATIONS }
        );
        ads = normalizeAdRows(adRaw);
      }
      mergeSalesAndAds(rows, ads);
      res.status(200).json({ rows, brandFiltered: false });
      return;
    }

    // Reconciliation is deliberately fetched as six monthly, order-level
    // batches. The UI joins the two sources locally by amazon_order_id and
    // exposes settlement posting dates separately from purchase dates.
    if (action === "reconciliation") {
      const { ids, from, to } = req.query;
      if (!ids || !from || !to) {
        res.status(400).json({ error: "Missing required params: ids, from, to" });
        return;
      }
      const sellerOrVendorIds = String(ids).split(",").filter(Boolean);
      if (sellerOrVendorIds.length !== 1) {
        res.status(400).json({ error: "Reconciliation requires exactly one selected account." });
        return;
      }
      const start = String(from), end = String(to);
      const windows = splitDateRangeByMonth(start, end);
      if (windows.length !== 6 || windows.some((window) => !isFullCalendarMonthWindow(window))) {
        res.status(400).json({ error: "Reconciliation requires exactly six complete calendar months." });
        return;
      }
      const orderRows = await reconciliationRowsByMonth(
        apiKey, ORDER_LINE_ITEMS_SOURCE_ID, RECONCILIATION_ORDER_COLUMNS, sellerOrVendorIds,
        start, end, RECONCILIATION_ORDER_AGGREGATIONS, RECONCILIATION_ORDER_GROUP_BY
      );
      const settlementRows = await reconciliationRowsByMonth(
        apiKey, RECONCILIATION_SETTLEMENTS_SOURCE_ID, RECONCILIATION_SETTLEMENT_COLUMNS, sellerOrVendorIds,
        start, end, RECONCILIATION_SETTLEMENT_AGGREGATIONS, RECONCILIATION_SETTLEMENT_GROUP_BY
      );
      const catalog = await fetchExportRows(
        apiKey, PRODUCT_CATALOG_SOURCE_ID, PRODUCT_CATALOG_COLUMNS, sellerOrVendorIds, start, end, CATALOG_ROW_LIMIT,
        { orderByColumn: "child_asin" }
      );
      res.status(200).json({
        from: start,
        to: end,
        months: windows.map((w) => w.from.slice(0, 7)),
        orders: reconciliationOrders(orderRows, catalog),
        settlements: reconciliationSettlements(settlementRows),
      });
      return;
    }

    // SKU P&L Analyzer: one selected account only, exactly six complete
    // calendar months. Uses the Premium "Profit by SKU & Date" source, fetched
    // in monthly batches and folded to one row per (currency|sku|child_asin)
    // with per-month sums. The browser localises to a single currency, applies
    // the shared brand scope, switches month, and recomputes every ratio.
    if (action === "sku-pl") {
      const { ids, from, to } = req.query;
      if (!ids || !from || !to) {
        res.status(400).json({ error: "Missing required params: ids, from, to" });
        return;
      }
      const sellerOrVendorIds = String(ids).split(",").filter(Boolean);
      if (sellerOrVendorIds.length !== 1) {
        res.status(400).json({ error: "SKU P&L Analyzer requires exactly one selected account." });
        return;
      }
      const start = String(from), end = String(to);
      const windows = splitDateRangeByMonth(start, end);
      if (windows.length !== 6 || windows.some((window) => !isFullCalendarMonthWindow(window))) {
        res.status(400).json({ error: "SKU P&L Analyzer requires exactly six complete calendar months." });
        return;
      }
      const rows = await fetchSkuPlRows(apiKey, sellerOrVendorIds, windows);
      const currencies = [...new Set(rows.map((r) => r.currency).filter(Boolean))].sort();
      const catalogBrands = [...new Set(rows.map((r) => r.brand).filter(Boolean))].sort((a, b) => a.localeCompare(b));
      res.status(200).json({
        accountId: sellerOrVendorIds[0],
        from: start,
        to: end,
        months: windows.map((w) => w.from.slice(0, 7)),
        currencies,
        catalogBrands,
        rows,
      });
      return;
    }

    // Keyword Rank & Share Tracker: fetch the selected account's weekly SQP
    // series. The client derives money keywords and every share/trend locally,
    // so brand/ASIN/search/status filters never make another DataDoe request.
    // New SQP connections commonly have only four weekly periods. When fewer
    // than four arrive, use the longer monthly source; only report a baseline
    // when neither cadence has two comparable periods.
    if (action === "keyword-rank") {
      const { ids, to } = req.query;
      if (!ids || !to) {
        res.status(400).json({ error: "Missing required params: ids, to" });
        return;
      }
      const sellerOrVendorIds = String(ids).split(",").filter(Boolean);
      if (sellerOrVendorIds.length !== 1) {
        res.status(400).json({ error: "Keyword Rank requires exactly one selected account." });
        return;
      }
      const end = String(to);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(end)) {
        res.status(400).json({ error: "Invalid to date. Use YYYY-MM-DD." });
        return;
      }

      let weeklyRows;
      try {
        weeklyRows = await fetchSqpRows(
          apiKey, SQP_WEEKLY_SOURCE_ID, sellerOrVendorIds,
          addDaysStr(end, -SQP_WEEKLY_LOOKBACK_DAYS), end
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (/source is disabled for this organization/i.test(message)) {
          res.status(424).json({ error: "Keyword Rank is disabled in DataDoe. In DataDoe, open Settings > Data tables and enable Search Query Performance (SQP) by ASIN (Weekly), then refresh this report again." });
          return;
        }
        throw err;
      }

      const weeklyPeriods = sqpDistinctPeriods(weeklyRows);
      let cadence = "weekly";
      let rows = weeklyRows;
      let periods = weeklyPeriods;
      if (weeklyPeriods.length < 4) {
        let monthlyRows;
        try {
          monthlyRows = await fetchSqpRows(
            apiKey, SQP_MONTHLY_SOURCE_ID, sellerOrVendorIds,
            addDaysStr(end, -SQP_MONTHLY_LOOKBACK_DAYS), end
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (/source is disabled for this organization/i.test(message)) {
            res.status(424).json({ error: "Keyword Rank needs more SQP history, but the monthly SQP fallback is disabled in DataDoe. In DataDoe, open Settings > Data tables and enable Search Query Performance (SQP) by ASIN (Monthly), then refresh this report again." });
            return;
          }
          throw err;
        }
        const monthlyPeriods = sqpDistinctPeriods(monthlyRows);
        if (monthlyPeriods.length >= 2) {
          cadence = "monthly";
          rows = monthlyRows;
          periods = monthlyPeriods;
        } else {
          cadence = "baseline";
          // Prefer the fresher weekly observation; when it is empty use the
          // monthly row so the user still gets an honest current baseline.
          rows = weeklyRows.length ? weeklyRows : monthlyRows;
          periods = sqpDistinctPeriods(rows);
        }
      }

      const catalogRows = await fetchExportRows(
        apiKey, PRODUCT_CATALOG_SOURCE_ID, PRODUCT_CATALOG_COLUMNS, sellerOrVendorIds,
        addDaysStr(end, -365), end, CATALOG_ROW_LIMIT,
        { orderByColumn: "child_asin", orderByDirection: "ASC" }
      );
      const products = [];
      const seenAsins = new Set();
      for (const row of catalogRows) {
        const asin = String(row.child_asin || "").trim();
        if (!asin || seenAsins.has(asin)) continue;
        seenAsins.add(asin);
        products.push({
          asin,
          name: String(row.product_name || "").trim() || null,
          brand: String(row.product_brand || "").trim() || "Unassigned",
        });
      }

      res.status(200).json({
        accountId: sellerOrVendorIds[0],
        cadence,
        periods,
        weeklyPeriodCount: weeklyPeriods.length,
        rows,
        products,
        catalogBrands: catalogBrandNames(catalogRows),
        retrievedAt: new Date().toISOString(),
      });
      return;
    }

    // Content Change Alerts: one selected account only. Amazon sends these
    // near-real-time A+ / branded-item notifications without a stable payload
    // schema, so the server extracts ASINs and resolves them through the
    // existing Product Catalog before returning a compact event summary.
    if (action === "content-changes") {
      const { ids, asOf } = req.query;
      if (!ids) {
        res.status(400).json({ error: "Missing required param: ids" });
        return;
      }
      const sellerOrVendorIds = String(ids).split(",").filter(Boolean);
      if (sellerOrVendorIds.length !== 1) {
        res.status(400).json({ error: "Content Change Alerts requires exactly one selected account." });
        return;
      }
      const catalogTo = /^\d{4}-\d{2}-\d{2}$/.test(String(asOf || "")) ? String(asOf) : new Date().toISOString().slice(0, 10);
      const catalogFrom = addDaysStr(catalogTo, -365);
      let notificationRows;
      try {
        notificationRows = await fetchExportRows(
          apiKey, CONTENT_CHANGE_SOURCE_ID, CONTENT_CHANGE_COLUMNS, sellerOrVendorIds,
          null, null, CONTENT_CHANGE_ROW_LIMIT,
          { orderByColumn: "event_time", orderByDirection: "DESC" }
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (/source is disabled for this organization/i.test(message)) {
          res.status(424).json({ error: "Content Change Alerts is disabled in DataDoe. In DataDoe, open Settings > Data tables and enable Branded Item Content Change Notifications, then refresh this report again." });
          return;
        }
        throw err;
      }
      const catalogRows = await fetchExportRows(
        apiKey, PRODUCT_CATALOG_SOURCE_ID, PRODUCT_CATALOG_COLUMNS, sellerOrVendorIds,
        catalogFrom, catalogTo, CATALOG_ROW_LIMIT,
        { orderByColumn: "child_asin", orderByDirection: "ASC" }
      );
      const events = compactContentChangeEvents(notificationRows, catalogRows);
      res.status(200).json({
        accountId: sellerOrVendorIds[0],
        events,
        catalogBrands: catalogBrandNames(catalogRows),
        retrievedAt: new Date().toISOString(),
        unassignedEvents: events.filter((event) => !event.brands.length).length,
      });
      return;
    }

    // FBA Shipment Plan: one selected account only. Combines per-ASIN unit
    // velocity (3 completed months + current-month MTD) with the latest FBA
    // inventory-health snapshot and (US only) AWD available inventory. All
    // derived planning metrics are computed in the browser so filter/target
    // changes never trigger a DataDoe request.
    if (action === "fba-plan") {
      const { ids, to } = req.query;
      if (!ids || !to) {
        res.status(400).json({ error: "Missing required params: ids, to" });
        return;
      }
      const sellerOrVendorIds = String(ids).split(",").filter(Boolean);
      if (sellerOrVendorIds.length !== 1) {
        res.status(400).json({ error: "FBA Shipment Plan requires exactly one selected account." });
        return;
      }
      const { completed, current } = planMonthWindows(String(to));

      // Authoritative account country (drives US-only AWD logic).
      const accounts = await fetchAccounts(apiKey);
      const account = accounts.find((a) => a.id === sellerOrVendorIds[0]) || null;
      const isUS = String(account?.country || "").toUpperCase() === "US";

      // 1) Per-ASIN units for each completed month.
      const asinSet = new Set();
      const unitsByAsinByMonth = {}; // asin -> { monthKey: units }
      for (const mo of completed) {
        const byAsin = await planAsinUnits(apiKey, sellerOrVendorIds, mo.from, mo.to);
        for (const [asin, units] of byAsin) {
          asinSet.add(asin);
          (unitsByAsinByMonth[asin] || (unitsByAsinByMonth[asin] = {}))[mo.key] = units;
        }
      }

      // 2a) Current-month MTD units per ASIN (grouped by ASIN, so it stays small
      // and cannot be truncated by an ASIN*day row explosion).
      const mtdByAsin = await planAsinUnits(apiKey, sellerOrVendorIds, current.from, current.to);
      for (const asin of mtdByAsin.keys()) asinSet.add(asin);
      // 2b) Latest completed sales date in the current month (grouped by date
      // only, ~1 row/day). Elapsed days are measured to this date so the MTD
      // projection is not diluted by dates the source has not populated yet.
      const dateRows = await fetchExportRows(
        apiKey, PLAN_SALES_SOURCE_ID, ["date"], sellerOrVendorIds, current.from, current.to, 500,
        { groupBy: ["date"], aggregations: [{ column: "total_units", aggregation: "sum", alias: "units_sum" }], orderByColumn: "date", orderByDirection: "ASC" }
      );
      let salesLatestDate = null;
      for (const r of dateRows) {
        if (num(r.units_sum) > 0 && r.date && (!salesLatestDate || r.date > salesLatestDate)) salesLatestDate = r.date;
      }
      // Elapsed days = day-of-month of the latest completed sales date, so the
      // MTD projection uses the true covered days rather than the raw calendar
      // day (the sales source can lag a few days).
      const elapsedDays = (salesLatestDate && salesLatestDate >= current.from && salesLatestDate <= current.to)
        ? Number(salesLatestDate.slice(8, 10))
        : 0;

      // 3) Catalog brand + product name. Use the full 3-month + MTD window so a
      // product released before the current month is still resolved to a brand.
      const catalog = await fetchExportRows(
        apiKey, PRODUCT_CATALOG_SOURCE_ID, PRODUCT_CATALOG_COLUMNS, sellerOrVendorIds, completed[0].from, current.to, CATALOG_ROW_LIMIT,
        { orderByColumn: "child_asin" }
      );
      const brandByAsin = new Map();
      const nameByAsin = new Map();
      for (const c of catalog) {
        const asin = String(c.child_asin || "").trim();
        if (!asin) continue;
        const brand = String(c.product_brand || "").trim();
        if (brand && !brandByAsin.has(asin)) brandByAsin.set(asin, brand);
        const name = String(c.product_name || "").trim();
        if (name && !nameByAsin.has(asin)) nameByAsin.set(asin, name);
      }

      // 4) Latest FBA inventory-health snapshot, folded from SKU to ASIN.
      const invRows = await fetchExportRows(
        apiKey, FBA_HEALTH_SOURCE_ID, FBA_HEALTH_COLUMNS, sellerOrVendorIds,
        addDaysStr(String(to), -PLAN_INVENTORY_LOOKBACK_DAYS), String(to), PLAN_INVENTORY_ROW_LIMIT,
        { orderByColumn: "date", orderByDirection: "DESC" }
      );
      let inventoryDate = null;
      for (const r of invRows) {
        if (r.date && (!inventoryDate || r.date > inventoryDate)) inventoryDate = r.date;
      }
      const invByAsin = {};
      const skusByAsin = {};
      const invProductName = new Map();
      for (const r of invRows) {
        if (inventoryDate && r.date !== inventoryDate) continue; // latest snapshot only
        const asin = String(r.child_asin || "").trim();
        if (!asin) continue;
        asinSet.add(asin);
        const cur = invByAsin[asin] || (invByAsin[asin] = {
          available: 0, fcTransfer: 0, fcProcessing: 0,
          inboundShipped: 0, inboundReceived: 0, inboundWorking: 0,
        });
        cur.available += num(r.available);
        cur.fcTransfer += num(r.reserved_fc_transfer);
        cur.fcProcessing += num(r.reserved_fc_processing);
        cur.inboundShipped += num(r.inbound_shipped);
        cur.inboundReceived += num(r.inbound_received);
        cur.inboundWorking += num(r.inbound_working);
        const sku = String(r.sku || "").trim();
        if (sku) (skusByAsin[asin] || (skusByAsin[asin] = new Set())).add(sku);
        const nm = String(r.product_name || "").trim();
        if (nm && !invProductName.has(asin)) invProductName.set(asin, nm);
      }
      const inventoryAvailable = invRows.length > 0;

      // 5) AWD available (US only), folded from SKU to ASIN.
      const awdByAsin = {};
      let awdAvailable = false;
      if (isUS) {
        const awdRows = await fetchExportRows(
          apiKey, LISTINGS_SOURCE_ID, LISTINGS_AWD_COLUMNS, sellerOrVendorIds,
          null, null, CATALOG_ROW_LIMIT,
          { orderByColumn: "child_asin" }
        );
        awdAvailable = awdRows.length > 0;
        for (const r of awdRows) {
          const asin = String(r.child_asin || "").trim();
          if (!asin) continue;
          awdByAsin[asin] = (awdByAsin[asin] || 0) + num(r.awd_available_distributable_quantity);
          const sku = String(r.sku || "").trim();
          if (sku) (skusByAsin[asin] || (skusByAsin[asin] = new Set())).add(sku);
        }
      }

      // 6) Assemble one row per ASIN. Representative SKU = first non-empty SKU
      // in ascending (localeCompare) order, so it is stable across refreshes.
      // Only ASINs with real activity are kept: any unit sales in the window, or
      // any live FBA/AWD stock. This drops the large tail of zero-sales,
      // zero-stock catalog ASINs that the Sales & Traffic source emits daily.
      const rows = [];
      for (const asin of asinSet) {
        const inv = invByAsin[asin] || null;
        const skus = skusByAsin[asin] ? [...skusByAsin[asin]].sort((a, b) => a.localeCompare(b)) : [];
        const unitsByMonth = {};
        let salesTotal = 0;
        for (const mo of completed) {
          const u = num(unitsByAsinByMonth[asin]?.[mo.key]);
          unitsByMonth[mo.key] = u;
          salesTotal += u;
        }
        const mtdUnits = num(mtdByAsin.get(asin));
        salesTotal += mtdUnits;
        const invTotal = inv
          ? inv.available + inv.fcTransfer + inv.fcProcessing + inv.inboundShipped + inv.inboundReceived + inv.inboundWorking
          : 0;
        const awdUnits = isUS ? num(awdByAsin[asin]) : 0;
        if (salesTotal <= 0 && invTotal <= 0 && awdUnits <= 0) continue;
        // DataDoe's FBA Inventory Health snapshot can include the same units in
        // both `reserved_fc_transfer` and `inbound_shipped`. Amazon exposes
        // that overlap only as Inbound, so subtract it from the FC-transfer
        // reserve before returning the planning components. This preserves a
        // genuine residual FC-transfer balance without double-counting stock.
        const adjustedFcTransfer = inv ? Math.max(0, inv.fcTransfer - inv.inboundShipped) : 0;
        rows.push({
          asin,
          productName: nameByAsin.get(asin) || invProductName.get(asin) || null,
          brand: brandByAsin.get(asin) || null,
          sku: skus[0] || null,
          unitsByMonth,
          mtdUnits,
          // Inventory numbers: when the snapshot exists but this ASIN is absent,
          // it genuinely holds no FBA stock (0). When the whole snapshot is
          // unavailable, inventory fields are null so the UI can flag it.
          fbaAvailable: inventoryAvailable ? num(inv?.available) : null,
          reservedFcTransfer: inventoryAvailable ? adjustedFcTransfer : null,
          reservedFcProcessing: inventoryAvailable ? num(inv?.fcProcessing) : null,
          inboundShipped: inventoryAvailable ? num(inv?.inboundShipped) : null,
          inboundReceived: inventoryAvailable ? num(inv?.inboundReceived) : null,
          inboundWorking: inventoryAvailable ? num(inv?.inboundWorking) : null,
          awdAvailable: isUS ? awdUnits : null,
        });
      }

      res.status(200).json({
        asOf: String(to),
        accountName: account?.name || null,
        marketCountry: account?.country || null,
        isUS,
        months: completed,
        currentMonth: current,
        salesLatestDate,
        elapsedDays,
        inventoryDate,
        inventoryAvailable,
        awdAvailable,
        rows,
      });
      return;
    }

    /* ============================================================
       Insight reports.
       All six share one contract: without `refresh=1` the request only reads
       the shared Supabase snapshot and never touches DataDoe, so navigation,
       brand changes, filters, search, sorting and paging cost nothing. With
       `refresh=1` a database lock is claimed first, so two people clicking
       Refresh cannot spend DataDoe tokens twice, and the validated result is
       saved once for every user permitted on that account.
       ============================================================ */

    if (action === "sales-movers") {
      const ids = singleAccountId(req, res, "Sales Movers");
      if (!ids) return;
      const to = reportAsOf(req, res);
      if (!to) return;
      await serveSharedReport({
        res,
        refresh: wantsRefresh(req),
        reportKey: SALES_MOVERS_REPORT_KEY,
        reportVersion: SALES_MOVERS_VERSION,
        accountId: ids[0],
        params: { to },
        userId: access.userId,
        label: "Sales Movers",
        build: () => buildSalesMovers({ apiKey, ids, to }),
      });
      return;
    }

    if (action === "listing-health") {
      const ids = singleAccountId(req, res, "Listing Health");
      if (!ids) return;
      const to = reportAsOf(req, res);
      if (!to) return;
      await serveSharedReport({
        res,
        refresh: wantsRefresh(req),
        reportKey: LISTING_HEALTH_REPORT_KEY,
        reportVersion: LISTING_HEALTH_VERSION,
        accountId: ids[0],
        params: { to },
        userId: access.userId,
        label: "Listing Health",
        build: () => buildListingHealth({ apiKey, ids, to }),
      });
      return;
    }

    if (action === "buy-box-loss") {
      const ids = singleAccountId(req, res, "Buy Box Loss");
      if (!ids) return;
      const to = reportAsOf(req, res);
      if (!to) return;
      await serveSharedReport({
        res,
        refresh: wantsRefresh(req),
        reportKey: BUY_BOX_REPORT_KEY,
        reportVersion: BUY_BOX_VERSION,
        accountId: ids[0],
        params: { to },
        userId: access.userId,
        label: "Buy Box Loss",
        build: () => buildBuyBoxLoss({ apiKey, ids, to }),
      });
      return;
    }

    // Temporary discovery route to find DataDoe's advertising data source and
    // its column names. Hit this once on the live deployment, e.g.
    //   /api/datadoe?action=fields
    //   /api/datadoe?action=fields&sourceId=<id>
    // then read the JSON to identify the ad source id + ad sales/spend/clicks
    // column names, wire them into the "sales" export columns (or a new
    // "ads" action), and remove this route afterwards.
    if (action === "fields") {
      const sourceId = req.query.sourceId || DAILY_SALES_SOURCE_ID;
      const candidates = [
        `${BASE}/sources`,
        `${BASE}/util/sources`,
        `${BASE}/data-sources`,
        `${BASE}/util/data-sources`,
        `${BASE}/util/data-models`,
        `${BASE}/sources/${sourceId}`,
        `${BASE}/sources/${sourceId}/columns`,
        `${BASE}/util/sources/${sourceId}`,
        `${BASE}/util/sources/${sourceId}/columns`,
      ];
      const results = {};
      for (const url of candidates) {
        try {
          const r = await fetch(url, { headers: authHeaders(apiKey) });
          const text = await r.text().catch(() => "");
          results[url] = { status: r.status, ok: r.ok, body: text.slice(0, 4000) };
        } catch (e) {
          results[url] = { error: e instanceof Error ? e.message : String(e) };
        }
        // Stay under DataDoe's ~2 req/sec org rate limit while probing.
        await new Promise((resolve) => setTimeout(resolve, 550));
      }
      res.status(200).json({ sourceId, note: "Discovery route — identify the ad source id + column names, then remove this action.", results });
      return;
    }

    // Temporary discovery route: pull a small real sample from a source (no
    // columns specified) to reveal its actual column names and row granularity.
    //   /api/datadoe?action=sample&sourceId=401ffcd7e5
    // Remove this route once the source/columns are confirmed.
    if (action === "sample") {
      const sourceId = req.query.sourceId || DAILY_SALES_SOURCE_ID;
      let ids = req.query.ids;
      if (!ids) {
        const accts = await fetchAccounts(apiKey);
        const aak = accts.find((a) => /aakriti/i.test(a.name));
        ids = accts.length ? (aak || accts[0]).id : "";
      }
      const sellerOrVendorIds = String(ids).split(",").filter(Boolean).slice(0, MAX_SELLER_OR_VENDOR_IDS_PER_EXPORT);
      const to = req.query.to || new Date().toISOString().slice(0, 10);
      const from = req.query.from || new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
      const limit = Number(req.query.limit) || 200;
      // Columns must be specified (DataDoe rejects an empty/absent list). Pass
      // ?columns=a,b,c to probe arbitrary columns, else default by source.
      let columns;
      if (req.query.columns) columns = String(req.query.columns).split(",").map((c) => c.trim()).filter(Boolean);
      else if (sourceId === DAILY_SALES_SOURCE_ID) columns = DAILY_SALES_COLUMNS;
      else if (sourceId === DASHBOARD_SOURCE_ID) columns = DASHBOARD_COLUMNS;
      else if (sourceId === ADS_SOURCE_ID) columns = ADS_COLUMNS;
      else columns = ["date", "seller_or_vendor_id"];

      // Sources without a date column need a different orderBy and no date
      // range; pass ?orderBy=<col> and omit from/to for those.
      const orderByColumn = req.query.orderBy || "date";
      const createRes = await ddFetch(ENDPOINTS.exportsCreate, {
        method: "POST",
        headers: authHeaders(apiKey),
        body: JSON.stringify({ sourceId, sellerOrVendorIds, columns, ...(from ? { from } : {}), ...(to ? { to } : {}), limit, outputType: "JSON", orderByColumn, orderByDirection: "ASC" }),
      });
      const createText = await createRes.text().catch(() => "");
      if (!createRes.ok) {
        res.status(200).json({ sourceId, from, to, columns, sellerOrVendorIds, ok: false, stage: "create", status: createRes.status, body: createText.slice(0, 2000) });
        return;
      }
      let created = {};
      try { created = JSON.parse(createText); } catch (e) { /* leave empty */ }
      const exportId = created.exportId || created.id;
      if (created.status !== "COMPLETED") {
        try {
          await pollExport(apiKey, exportId);
        } catch (e) {
          res.status(200).json({ sourceId, from, to, columns, sellerOrVendorIds, ok: false, stage: "poll", error: e instanceof Error ? e.message : String(e) });
          return;
        }
      }
      const rows = await downloadExport(apiKey, exportId);
      // Summaries to diagnose granularity/magnitude without dumping everything.
      const salesSum = rows.reduce((a, r) => a + (Number(r.total_sales) || 0), 0);
      const unitsSum = rows.reduce((a, r) => a + (Number(r.total_units) || 0), 0);
      const dates = rows.map((r) => r.date).filter(Boolean);
      res.status(200).json({
        sourceId, from, to, columns, sellerOrVendorIds, ok: true,
        rowCount: rows.length,
        rowKeys: rows.length ? Object.keys(rows[0]) : [],
        distinctDates: new Set(dates).size,
        minDate: dates.length ? dates.reduce((a, b) => (a < b ? a : b)) : null,
        maxDate: dates.length ? dates.reduce((a, b) => (a > b ? a : b)) : null,
        salesSum, unitsSum,
        sample: rows.slice(0, 8),
      });
      return;
    }

    res.status(400).json({ error: "Unknown action. Use ?action=accounts, ?action=sales, ?action=brand-sales, ?action=daily, ?action=reconciliation, ?action=sku-pl, ?action=keyword-rank, ?action=content-changes, ?action=fba-plan, ?action=fields, or ?action=sample" });
  } catch (err) {
    const status = err instanceof DashboardAccessError ? err.status : 500;
    res.status(status).json({ error: err instanceof Error ? err.message : "Unexpected server error." });
  }
}
