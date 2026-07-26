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

const BASE = "https://api.datadoe.com/api/v1";

// Verified DataDoe REST details:
// - Accounts endpoint includes the /util prefix.
// - Auth uses the custom datadoe-api-key header, not Authorization: Bearer.
// - Sales exports accept no more than 5 seller/vendor IDs per request.
const ENDPOINTS = {
  sellers: `${BASE}/util/sellers-and-vendors`,
  exportsCreate: `${BASE}/exports`,
  exportStatus: (id) => `${BASE}/exports/${id}`,
  exportRaw: (id) => `${BASE}/exports/${id}/raw`,
};

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

const MAX_SELLER_OR_VENDOR_IDS_PER_EXPORT = 5;
const DASHBOARD_ROW_LIMIT = 5000;
// Order rows are grouped by day and ASIN before download. A year of data can
// still contain more than 5,000 ASIN/day groups, so use a higher export cap.
const ORDER_SALES_ROW_LIMIT = 50000;
const CATALOG_ROW_LIMIT = 10000;
// Daily sources are aggregated by account/date before download, so a compact
// limit safely covers years of history without raw ASIN row truncation.
const DAILY_ROW_LIMIT = 5000;
const DAILY_BRAND_ROW_LIMIT = 50000;

function authHeaders(apiKey) {
  return {
    "datadoe-api-key": apiKey,
    "Content-Type": "application/json",
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// DataDoe caps requests at 2/sec per organization. `ddFetch` spaces requests
// out to stay under that cap and transparently retries on HTTP 429 using the
// server's retry hint, so a burst of exports (e.g. the all-accounts load) or
// concurrent tabs don't surface a rate-limit error to the user.
let _lastDataDoeCall = 0;
const MIN_REQUEST_INTERVAL_MS = 550;
const MAX_RATE_LIMIT_RETRIES = 6;

async function ddFetch(url, options, attempt = 0) {
  const since = Date.now() - _lastDataDoeCall;
  if (since < MIN_REQUEST_INTERVAL_MS) await sleep(MIN_REQUEST_INTERVAL_MS - since);
  _lastDataDoeCall = Date.now();

  const r = await fetch(url, options);
  if (r.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
    let retrySec = Number(r.headers.get("retry-after")) || 0;
    try {
      const body = await r.clone().json();
      retrySec = Number(body.retryAfterSeconds) || Number(body.config && body.config.retryAfterSeconds) || retrySec || 1;
    } catch (e) {
      retrySec = retrySec || 1;
    }
    await sleep(retrySec * 1000 + 250);
    return ddFetch(url, options, attempt + 1);
  }
  return r;
}

async function fetchAccounts(apiKey) {
  const r = await ddFetch(ENDPOINTS.sellers, { headers: authHeaders(apiKey) });
  if (!r.ok) {
    throw new Error(`DataDoe accounts request failed (${r.status}). Check the endpoint path in api/datadoe.js against https://api.datadoe.com/api/v1/docs`);
  }
  const body = await r.json();
  const list = body.data || body.results || (Array.isArray(body) ? body : []);
  return list.map((a) => ({
    id: a.id,
    name: a.name,
    country: a.marketplaceCountryCode,
    countryName: a.marketplaceCountryName,
    currency: a.currency || null,
  }));
}

async function createExport(apiKey, sourceId, columns, sellerOrVendorIds, from, to, limit, options = {}) {
  const { groupBy, aggregations, orderByColumn = "date", orderByDirection = "ASC" } = options;
  const r = await ddFetch(ENDPOINTS.exportsCreate, {
    method: "POST",
    headers: authHeaders(apiKey),
    body: JSON.stringify({
      sourceId,
      sellerOrVendorIds,
      columns,
      // Sources without a date column (e.g. Listings) must not receive a date
      // range; only include from/to when provided.
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      limit,
      outputType: "JSON",
      orderByColumn,
      orderByDirection,
      ...(groupBy ? { groupBy } : {}),
      ...(aggregations ? { aggregations } : {}),
    }),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`DataDoe export creation failed (${r.status}): ${text}`);
  }
  return r.json();
}

function chunkArray(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

// Run an export for any source, chunking by the 5-id-per-export cap and
// combining the returned rows.
async function fetchExportRows(apiKey, sourceId, columns, sellerOrVendorIds, from, to, limit, options = {}) {
  const chunks = chunkArray(sellerOrVendorIds, MAX_SELLER_OR_VENDOR_IDS_PER_EXPORT);
  const allRows = [];

  for (const chunk of chunks) {
    const created = await createExport(apiKey, sourceId, columns, chunk, from, to, limit, options);
    const exportId = created.exportId || created.id;
    if (created.status !== "COMPLETED") {
      await pollExport(apiKey, exportId);
    }
    const rows = await downloadExport(apiKey, exportId);
    allRows.push(...rows);
  }

  return allRows;
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
      // A compact ASIN-level export cannot deduplicate order IDs across ASINs.
      // Leave Orders/AOV unavailable rather than showing a misleading value.
      total_orders: null,
    };
    current.total_sales += num(row.total_sales_sum ?? row.item_price_value);
    current.total_units_sold += num(row.total_units_sold_sum ?? row.quantity);
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

const num = (v) => Number(v) || 0;

/* ===== FBA Shipment Plan helpers ===== */
const pad2s = (n) => String(n).padStart(2, "0");
function daysInMonthUTC(y, m /* 1..12 */) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
function addDaysStr(s, n) {
  const [y, m, d] = s.split("-").map(Number);
  const t = Date.UTC(y, m - 1, d) + n * 86400000;
  const dt = new Date(t);
  return `${dt.getUTCFullYear()}-${pad2s(dt.getUTCMonth() + 1)}-${pad2s(dt.getUTCDate())}`;
}
function splitDateRangeByMonth(from, to) {
  const windows = [];
  let cursor = from;
  while (cursor <= to) {
    const [y, m] = cursor.split("-").map(Number);
    const monthEnd = `${y}-${pad2s(m)}-${pad2s(daysInMonthUTC(y, m))}`;
    const end = monthEnd < to ? monthEnd : to;
    windows.push({ from: cursor, to: end });
    cursor = addDaysStr(end, 1);
  }
  return windows;
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

async function pollExport(apiKey, exportId) {
  const maxAttempts = 12;
  const delayMs = 1500;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const r = await ddFetch(ENDPOINTS.exportStatus(exportId), { headers: authHeaders(apiKey) });
    if (!r.ok) throw new Error(`DataDoe export status check failed (${r.status})`);
    const body = await r.json();
    if (body.status === "COMPLETED") return body;
    if (body.status === "FAILED") throw new Error("DataDoe export failed to process.");
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error("DataDoe export timed out while processing. Try a shorter date range.");
}

async function downloadExport(apiKey, exportId) {
  const r = await ddFetch(ENDPOINTS.exportRaw(exportId), { headers: authHeaders(apiKey) });
  if (!r.ok) throw new Error(`DataDoe export download failed (${r.status})`);
  const body = await r.json();
  if (typeof body.rawContent === "string") {
    return JSON.parse(body.rawContent);
  }
  return Array.isArray(body) ? body : [];
}

export default async function handler(req, res) {
  const apiKey = process.env.DATADOE_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "DATADOE_API_KEY is not set in this deployment's environment variables." });
    return;
  }

  try {
    const action = req.query.action;

    if (action === "accounts") {
      const accounts = await fetchAccounts(apiKey);
      res.status(200).json({ accounts });
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
      const ads = normalizeAdRows(adRaw);
      mergeSalesAndAds(rows, ads);
      res.status(200).json({ rows, brandFiltered: false });
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
          reservedFcTransfer: inventoryAvailable ? num(inv?.fcTransfer) : null,
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

    res.status(400).json({ error: "Unknown action. Use ?action=accounts, ?action=sales, ?action=brand-sales, ?action=daily, ?action=fba-plan, ?action=fields, or ?action=sample" });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Unexpected server error." });
  }
}
