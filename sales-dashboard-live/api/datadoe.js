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
  getAdsDailySourceRows,
  getAdDailyMetrics,
  getDashboardAccess,
  getLatestReportSnapshot,
  getReportSnapshot,
  isSupabaseConfigured,
  publishSnapshotUpdate,
  saveReportSnapshot,
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
  fetchAccounts as fetchAccountsRaw,
  fetchExportRows as fetchExportRowsRaw,
  isDateStr,
  isFullCalendarMonthWindow,
  num,
  pad2s,
  pollExport,
  splitDateRangeByMonth,
} from "../lib/server/datadoe.js";
import {
  connectionForApiKey,
  decorateDataDoeAccount,
  getDataDoeConnections,
  mergeDiscoveredDataDoeAccounts,
  resolveDataDoeAccountIds,
  scopeDataDoeRows,
} from "../lib/server/datadoe-connections.js";
import { beginSharedRefresh, paramsHashFor, serveSharedReport, wantsRefresh } from "../lib/server/report-store.js";
import { buildSalesMovers, SALES_MOVERS_REPORT_KEY, SALES_MOVERS_VERSION } from "../lib/server/reports/sales-movers.js";
import { buildListingHealth, LISTING_HEALTH_REPORT_KEY, LISTING_HEALTH_VERSION } from "../lib/server/reports/listing-health.js";
import { buildBuyBoxLoss, BUY_BOX_REPORT_KEY, BUY_BOX_VERSION } from "../lib/server/reports/buy-box.js";
import { buildReturnsLeakage, RETURNS_REPORT_KEY, RETURNS_VERSION } from "../lib/server/reports/returns.js";
import { buildPpcPerformance, PPC_REPORT_KEY, PPC_VERSION } from "../lib/server/reports/ppc.js";
import { buildListingOptimizer, OPTIMIZER_REPORT_KEY, OPTIMIZER_VERSION } from "../lib/server/reports/listing-optimizer.js";
// Account-scoped Brand View (Account -> Brand -> Brand Reports). Entirely
// separate from the older portfolio `brand-portfolio` action above: different
// report keys, different snapshot scope, different builders.
import {
  BRAND_VIEW_BRANDS_REPORT_KEY,
  BRAND_VIEW_BRANDS_VERSION,
  BRAND_VIEW_PORTFOLIO_REPORT_KEY,
  BRAND_VIEW_PORTFOLIO_VERSION,
  BRAND_VIEW_REPORT_KEY,
  BRAND_VIEW_VERSION,
  brandViewPortfolioScopeId,
  brandViewScopeId,
  buildBrandViewBrandDirectory,
  buildBrandViewPortfolioSnapshot,
  buildBrandViewSnapshot,
} from "../lib/server/reports/brand-view.js";
import { FX_DISPLAY_CURRENCIES, getFxRates } from "../lib/server/fx.js";

// Keep the rest of this legacy route's report builders connection-agnostic.
// They still receive a normal API key and raw DataDoe seller IDs, while this
// wrapper returns the stable public account ID for secondary-connection rows.
async function fetchExportRows(apiKey, ...args) {
  const rows = await fetchExportRowsRaw(apiKey, ...args);
  return scopeDataDoeRows(connectionForApiKey(apiKey), rows);
}

async function fetchAccounts(apiKey) {
  const connection = connectionForApiKey(apiKey);
  const accounts = await fetchAccountsRaw(apiKey);
  return accounts.map((account) => decorateDataDoeAccount(connection, account));
}

const ACCOUNT_SCOPED_ACTIONS = new Set([
  "sales", "brand-sales", "daily", "reconciliation", "sku-pl",
  "keyword-rank", "content-changes", "fba-plan",
  // Account-scoped Brand View. Both actions take exactly one account, are
  // authorised against it, and read only that account's saved snapshots.
  "brand-view-brands", "brand-view",
  // Insight reports. Each is single-account and served from the shared
  // Supabase snapshot unless an explicit refresh is requested.
  // The Priority Feed has no action of its own: it combines the six snapshots
  // in the browser, so there is nothing extra to authorise here.
  "sales-movers", "listing-health", "buy-box-loss",
  "returns-leakage", "ppc-performance", "listing-optimizer",
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

// Each of these snapshots already preserves catalog brand names at an
// account-level grain. They let Brand View rebuild its directory from
// Supabase when DataDoe Product Catalog exports are unavailable or out of
// credits, without guessing a brand's country from portfolio-wide data.
const BRAND_DIRECTORY_SNAPSHOT_KEYS = [
  // This compact per-account catalog snapshot is populated only by the
  // explicit Brand View directory sync. It is first because it includes
  // catalog brands even when an item has not sold in the report window.
  "brand-catalog",
  "brand-sales",
  "fba-plan",
  "sku-pl",
  SALES_MOVERS_REPORT_KEY,
  LISTING_HEALTH_REPORT_KEY,
  BUY_BOX_REPORT_KEY,
  RETURNS_REPORT_KEY,
  PPC_REPORT_KEY,
  OPTIMIZER_REPORT_KEY,
  "content-changes",
];

const BRAND_CATALOG_REPORT_KEY = "brand-catalog";
const BRAND_CATALOG_REPORT_VERSION = "brand-catalog-shared-v1";
// One account per DataDoe organisation per request keeps each function under
// Vercel's 60-second limit while allowing primary and secondary catalog work
// to progress together. The browser continues the explicitly requested sync.
const BRAND_CATALOG_ACCOUNTS_PER_CONNECTION = 1;

function addBrandAccount(brandAccountIds, brand, accountId) {
  const name = String(brand || "").trim();
  if (!name) return;
  const accountIds = brandAccountIds.get(name) || new Set();
  accountIds.add(String(accountId));
  brandAccountIds.set(name, accountIds);
}

function serialiseBrandAccountMap(brandAccountIds) {
  const brands = [...brandAccountIds.keys()].sort((a, b) => a.localeCompare(b));
  return {
    brands,
    brandAccounts: Object.fromEntries(brands.map((brand) => [brand, [...brandAccountIds.get(brand)].sort()])),
  };
}

const BRAND_PORTFOLIO_REPORT_KEY = "brand-portfolio";
const BRAND_PORTFOLIO_VERSION = "brand-portfolio-shared-v3";
const BRAND_ADS_SOURCE_KEY = "asin-performance-v1";

// Brand View is a portfolio report, but it must be as quick and cheap as any
// account report once users have refreshed their source snapshots.  It reads
// the shared account snapshots and the scheduled ASIN-level Ads history only;
// it never starts a new DataDoe export itself.  This is what lets one saved
// portfolio snapshot be reused by every authorised user.
async function buildBrandPortfolioSnapshot({ brand, accountIds, asOf }) {
  const rows = [];
  const ads = [];
  const inventory = [];
  const unavailable = [];

  for (const accountId of accountIds) {
    const salesSnapshot = await getLatestReportSnapshot({ reportKey: "brand-sales", accountId });
    const salesPayload = salesSnapshot?.payload;
    const sourceRows = salesPayload?.rows || [];
    if (!sourceRows.length) {
      unavailable.push({ accountId, reason: "No saved account sales snapshot" });
      continue;
    }

    const asinBrand = new Map();
    for (const row of sourceRows) {
      const rowBrand = String(row.product_brand || "").trim();
      const asin = String(row.child_asin || "").trim();
      if (asin && rowBrand) asinBrand.set(asin, rowBrand);
      if (rowBrand !== brand) continue;
      rows.push({
        ...row,
        accountId,
        accountName: row.seller_or_vendor_name || null,
        accountCountry: row.marketplace_country_code || null,
        accountCurrency: row.currency || null,
      });
    }

    // Inventory is read from the latest saved FBA-plan snapshot.  Its ASIN
    // mapping is already joined to the product brand and its fields are live
    // FBA Health values, so no client-side inference is needed.
    const planSnapshot = await getLatestReportSnapshot({ reportKey: "fba-plan", accountId });
    const planPayload = planSnapshot?.payload;
    let fbaAvailable = 0;
    let fbaKnown = false;
    for (const row of planPayload?.rows || []) {
      if (String(row.brand || "").trim() !== brand) continue;
      if (row.fbaAvailable === null || row.fbaAvailable === undefined) continue;
      fbaKnown = true;
      fbaAvailable += num(row.fbaAvailable);
    }
    if (fbaKnown) {
      const sample = sourceRows.find((row) => String(row.product_brand || "").trim() === brand) || sourceRows[0];
      inventory.push({
        accountId,
        country: sample.marketplace_country_code || null,
        currency: sample.currency || null,
        fbaAvailable,
        snapshotDate: planPayload?.inventoryDate || null,
      });
    }

    // ASIN-level Ads history is maintained by the scheduled worker.  Joining
    // it to this account's saved ASIN->brand map avoids the old bug where all
    // account spend was displayed for one selected brand.
    try {
      const adRows = await getAdsDailySourceRows({
        accountId,
        sourceKeys: [BRAND_ADS_SOURCE_KEY],
        from: addDaysStr(asOf, -60),
        to: asOf,
        maxRows: 60000,
      });
      for (const row of adRows) {
        if (asinBrand.get(String(row.child_asin || "").trim()) !== brand) continue;
        ads.push({
          accountId,
          date: row.metric_date,
          country: row.marketplace_country_code || null,
          currency: row.currency || null,
          adSpend: num(row.metrics?.ad_spend),
        });
      }
    } catch (error) {
      unavailable.push({ accountId, reason: `Saved Ads history unavailable: ${error instanceof Error ? error.message : String(error)}` });
    }
  }

  return {
    brand,
    asOf,
    rows,
    ads,
    inventory,
    unavailable,
    sources: {
      sales: "Saved Brand Sales snapshots (Order Line Items + Product Catalog)",
      ads: "Saved Ad Performance by ASIN & Date history",
      inventory: "Saved FBA Shipment Plan snapshots (FBA Inventory Health)",
    },
  };
}

function snapshotBrandNames(payload) {
  const names = new Set((payload?.catalogBrands || []).map((brand) => String(brand || "").trim()).filter(Boolean));
  // Older Dashboard and SKU P&L snapshots predate catalogBrands on every
  // payload, but their row records still carry the joined brand. This keeps
  // the directory recoverable after a schema upgrade without any DataDoe call.
  (payload?.rows || []).forEach((row) => {
    const brand = row?.product_brand || row?.brand;
    if (String(brand || "").trim()) names.add(String(brand).trim());
  });
  return [...names];
}

async function sharedSnapshotBrandAccounts(accountIds) {
  const brandAccountIds = new Map();
  const coveredAccountIds = new Set();
  const catalogPendingAccountIds = new Set();
  const catalogUnavailable = new Map();
  if (!isSupabaseConfigured()) return { brandAccountIds, coveredAccountIds, catalogPendingAccountIds, catalogUnavailable };

  // The explicit catalog snapshot is authoritative for a complete selector.
  // Other reports are still useful fallback data while an account waits for its
  // one-time catalog sync, but recent sales must never be mistaken for a full
  // catalog because zero-sale brands would disappear.
  await Promise.all(accountIds.map(async (accountId) => {
    const id = String(accountId);
    const catalogSnapshot = await getLatestReportSnapshot({ reportKey: BRAND_CATALOG_REPORT_KEY, accountId });
    const catalogStatus = catalogSnapshot?.payload?.catalogSyncStatus;
    const catalogBrands = snapshotBrandNames(catalogSnapshot?.payload);
    if (catalogStatus === "complete") {
      catalogBrands.forEach((brand) => addBrandAccount(brandAccountIds, brand, accountId));
      coveredAccountIds.add(id);
      return;
    }
    if (catalogStatus === "unavailable") {
      catalogUnavailable.set(id, String(catalogSnapshot?.payload?.catalogSyncError || "Product Catalog is unavailable for this account."));
    } else {
      catalogPendingAccountIds.add(id);
    }

    for (const reportKey of BRAND_DIRECTORY_SNAPSHOT_KEYS.slice(1)) {
      const snapshot = await getLatestReportSnapshot({ reportKey, accountId });
      const brands = snapshotBrandNames(snapshot?.payload);
      if (brands.length) {
        brands.forEach((brand) => addBrandAccount(brandAccountIds, brand, accountId));
        coveredAccountIds.add(id);
        break;
      }
    }
  }));
  return { brandAccountIds, coveredAccountIds, catalogPendingAccountIds, catalogUnavailable };
}

async function saveBrandCatalogSnapshot(accountId, payload) {
  const paramsHash = paramsHashFor(BRAND_CATALOG_REPORT_VERSION, { accountId });
  const saved = await saveReportSnapshot({
    reportKey: BRAND_CATALOG_REPORT_KEY,
    accountId,
    paramsHash,
    params: { reportVersion: BRAND_CATALOG_REPORT_VERSION, accountId },
    payload,
    payloadBytes: Buffer.byteLength(JSON.stringify(payload), "utf8"),
    sourceRefreshedAt: new Date().toISOString(),
  });
  if (saved?.id) {
    await publishSnapshotUpdate({ reportKey: BRAND_CATALOG_REPORT_KEY, accountId, paramsHash, snapshotId: saved.id }).catch(() => {});
  }
}

async function syncAccountBrandCatalog({ accountId, rawAccountId, connection }) {
  try {
    const rows = await fetchExportRowsRaw(
      connection.apiKey,
      PRODUCT_CATALOG_SOURCE_ID,
      PRODUCT_CATALOG_COLUMNS,
      [rawAccountId],
      null,
      null,
      CATALOG_ROW_LIMIT,
      { orderByColumn: "child_asin", orderByDirection: "ASC" }
    );
    if (rows.length >= CATALOG_ROW_LIMIT) {
      throw new Error(`Product Catalog reached the ${CATALOG_ROW_LIMIT.toLocaleString("en-US")} row cap and was not used.`);
    }
    const payload = {
      catalogBrands: catalogBrandNames(rows),
      catalogSyncStatus: "complete",
      catalogSyncedAt: new Date().toISOString(),
    };
    await saveBrandCatalogSnapshot(accountId, payload);
    return { accountId, status: "complete", brandCount: payload.catalogBrands.length };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Persist the outcome so the automatic continuation can finish. A later
    // explicit directory sync retries these accounts after access/credits are
    // corrected; normal reads never spend DataDoe tokens.
    await saveBrandCatalogSnapshot(accountId, {
      catalogBrands: [],
      catalogSyncStatus: "unavailable",
      catalogSyncError: message,
      catalogSyncedAt: new Date().toISOString(),
    }).catch(() => {});
    return { accountId, status: "unavailable", error: message };
  }
}

async function syncBrandCatalogBatch(accountIds, connections) {
  const byConnection = new Map();
  for (const accountId of [...new Set(accountIds.map(String))].sort()) {
    const scope = resolveDataDoeAccountIds([accountId], connections);
    const group = byConnection.get(scope.connection.id) || { connection: scope.connection, accounts: [] };
    group.accounts.push({ accountId, rawAccountId: scope.rawAccountIds[0], connection: scope.connection });
    byConnection.set(scope.connection.id, group);
  }
  const work = [...byConnection.values()]
    .flatMap((group) => group.accounts.slice(0, BRAND_CATALOG_ACCOUNTS_PER_CONNECTION));
  return Promise.all(work.map(syncAccountBrandCatalog));
}

function stableSelectionId(prefix, accountIds) {
  return `${prefix}:${[...new Set(accountIds.map(String))].sort().join(",")}`;
}

// A Brand View refresh already discovers the connected account catalogue in
// order to find its permitted brands. Persist that same catalogue so a future
// browser can establish its account scope from Supabase before it reads the
// saved Brand View directory. The accounts response still filters this shared
// record by the requesting user's permissions.
async function persistAccountDirectory(accounts) {
  if (!isSupabaseConfigured() || !accounts.length) return;
  const reportKey = "account-directory";
  const reportVersion = "account-directory-shared-v1";
  const accountId = "__account-directory__";
  const paramsHash = paramsHashFor(reportVersion, {});
  const payload = { accounts };
  const saved = await saveReportSnapshot({
    reportKey,
    accountId,
    paramsHash,
    params: { reportVersion },
    payload,
    payloadBytes: Buffer.byteLength(JSON.stringify(payload), "utf8"),
    sourceRefreshedAt: new Date().toISOString(),
  });
  if (saved?.id) {
    await publishSnapshotUpdate({ reportKey, accountId, paramsHash, snapshotId: saved.id }).catch(() => {});
  }
}

// Account name and marketplace country for one account, from the shared account
// directory snapshot. Supabase only: Brand View must never call DataDoe's
// account list merely to label a row. Returns null metadata rather than failing
// when the directory has not been seeded, because the report itself does not
// depend on it.
async function sharedAccountMetadata(accountId) {
  if (!isSupabaseConfigured()) return null;
  const snapshot = await getLatestReportSnapshot({
    reportKey: "account-directory",
    accountId: "__account-directory__",
  }).catch(() => null);
  const account = (snapshot?.payload?.accounts || []).find((entry) => String(entry.id) === String(accountId));
  return account ? { name: account.name || null, country: account.country || null, currency: account.currency || null } : null;
}

/**
 * The account-scoped Brand View brand directory, cache-first.
 *
 * Deriving the list means reading this account's saved Dashboard payload, which
 * for a large account is megabytes. Doing that on every page load — and again
 * to validate the selected brand — would make the page slow for exactly the
 * accounts that need it most. So the derived list is itself saved as a small
 * shared snapshot and served from there; it is only rebuilt when nothing has
 * been derived yet or the user explicitly refreshes.
 *
 * Rebuilding needs no refresh lock: it reads Supabase only, costs nothing
 * upstream, and the write is an idempotent upsert of a deterministic result.
 */
async function brandViewDirectory(accountId, { rebuild = false } = {}) {
  const paramsHash = paramsHashFor(BRAND_VIEW_BRANDS_VERSION, { accountId });
  if (!rebuild) {
    const saved = await getReportSnapshot({ reportKey: BRAND_VIEW_BRANDS_REPORT_KEY, accountId, paramsHash });
    if (saved?.payload) {
      return {
        payload: saved.payload,
        savedAt: saved.source_refreshed_at || saved.updated_at || null,
        shared: true,
      };
    }
  }
  const payload = await buildBrandViewBrandDirectory({ accountId, getSnapshot: getLatestReportSnapshot });
  const saved = await saveReportSnapshot({
    reportKey: BRAND_VIEW_BRANDS_REPORT_KEY,
    accountId,
    paramsHash,
    params: { reportVersion: BRAND_VIEW_BRANDS_VERSION, accountId },
    payload,
    payloadBytes: Buffer.byteLength(JSON.stringify(payload), "utf8"),
    sourceRefreshedAt: new Date().toISOString(),
  }).catch(() => null);
  return {
    payload,
    savedAt: saved?.source_refreshed_at || new Date().toISOString(),
    shared: Boolean(saved),
  };
}

// The first dashboard reports predate the shared snapshot layer. Keep their
// existing builders intact, but give them the exact same saved-data contract as
// the newer insight reports. Browser storage is now only a fast fallback.
function legacySharedDescriptor({ action, req, access, publicAccountIds, accountScope }) {
  const accountId = accountScope?.accountIds?.[0];
  const from = String(req.query.from || "");
  const to = String(req.query.to || "");
  switch (action) {
    case "accounts":
      return {
        reportKey: "account-directory", reportVersion: "account-directory-shared-v1", accountId: "__account-directory__", params: {}, label: "account directory",
        present: (payload) => ({
          ...payload,
          accounts: access.role === "admin"
            ? (payload.accounts || [])
            : (payload.accounts || []).filter((account) => access.accountIds.includes(String(account.id))),
        }),
      };
    case "brand-directory":
      if (!publicAccountIds.length) return null;
      return {
        reportKey: "brand-directory", reportVersion: "brand-directory-shared-v2",
        accountId: stableSelectionId("brand-directory", publicAccountIds),
        params: { accountIds: [...publicAccountIds].sort().join(",") }, label: "brand directory",
      };
    case "sales":
      if (!publicAccountIds.length || !from || !to) return null;
      return {
        reportKey: "sales", reportVersion: "sales-shared-v1",
        accountId: stableSelectionId("sales", publicAccountIds), params: { from, to }, label: "sales report",
      };
    case "brand-sales":
      if (!accountId || !from || !to) return null;
      return {
        reportKey: "brand-sales", reportVersion: "brand-sales-shared-v1", accountId,
        params: { from, to }, label: "Dashboard",
      };
    case "daily":
      if (!accountId || !from || !to) return null;
      return {
        reportKey: "daily-reporting", reportVersion: "daily-reporting-shared-v1", accountId,
        params: { from, to, brand: String(req.query.brand || "ALL") }, label: "Daily Reporting",
      };
    case "reconciliation":
      if (!accountId || !from || !to) return null;
      return { reportKey: "reconciliation", reportVersion: "reconciliation-shared-v1", accountId, params: { from, to }, label: "Reconciliation" };
    case "sku-pl":
      if (!accountId || !from || !to) return null;
      return { reportKey: "sku-pl", reportVersion: "sku-pl-shared-v1", accountId, params: { from, to }, label: "SKU P&L Analyzer" };
    case "keyword-rank":
      if (!accountId || !to) return null;
      return { reportKey: "keyword-rank", reportVersion: "keyword-rank-shared-v1", accountId, params: { to }, label: "Keyword Rank" };
    case "content-changes":
      if (!accountId) return null;
      return { reportKey: "content-changes", reportVersion: "content-changes-shared-v1", accountId, params: { asOf: String(req.query.asOf || "") }, label: "Content Change Alerts" };
    case "fba-plan":
      if (!accountId || !to) return null;
      return { reportKey: "fba-plan", reportVersion: "fba-plan-shared-v1", accountId, params: { to }, label: "FBA Shipment Plan" };
    default:
      return null;
  }
}

/**
 * Build the Dashboard (brand-sales) payload for one account, headlessly.
 *
 * Co-located here so it reuses the module-scoped source ids, columns and the
 * orderSalesByBrand/catalogBrandNames helpers in place (no risky cross-file move).
 * Shared by the `action=brand-sales` refresh handler below AND the scheduled-sync
 * report adapter (lib/server/sync/adapters/brand-sales.js), so the calculation has
 * exactly one implementation. `ids` is the account's raw seller/vendor id(s).
 */
export async function buildBrandSalesPayload({ apiKey, ids, from, to }) {
  const sellerOrVendorIds = (Array.isArray(ids) ? ids : String(ids).split(",")).filter(Boolean);
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
  const rows = orderSalesByBrand(rawRows, catalog);
  // Derive the brand list from the account's already-joined sales rows, never
  // from wider catalog metadata, so the header brand filter cannot exceed scope.
  return { rows, catalogBrands: catalogBrandNames(rows) };
}

async function discoverConnectedAccounts(connections) {
  const accountsByConnection = [];
  for (const connection of connections) {
    const discovered = await fetchAccountsRaw(connection.apiKey);
    accountsByConnection.push({ connection, accounts: discovered });
  }
  return mergeDiscoveredDataDoeAccounts(accountsByConnection);
}

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
  let legacySharedRefresh = null;
  try {
    const access = await getDashboardAccess(req);
    const connections = getDataDoeConnections();
    const action = req.query.action;
    let publicAccountIds = String(req.query.ids || "").split(",").map((id) => id.trim()).filter(Boolean);
    let accountScope = null;
    let brandDirectoryAccounts = null;
    let discoveredDirectoryAccounts = null;

    const accountScopedAction = ACCOUNT_SCOPED_ACTIONS.has(action);
    // `sample` is admin-only diagnostics, but it still needs the same routing
    // when an administrator explicitly samples a secondary account.
    const diagnosticAccountScope = action === "sample" && publicAccountIds.length > 0;
    if (accountScopedAction || diagnosticAccountScope) {
      if (accountScopedAction && publicAccountIds.length) assertAccountAccess(access, publicAccountIds);
      accountScope = resolveDataDoeAccountIds(publicAccountIds, connections);
      // Every existing action below can continue to send DataDoe its raw IDs.
      // The public, connection-scoped ID remains available in accountScope for
      // Supabase and response metadata.
      if (accountScope) req.query.ids = accountScope.rawAccountIds.join(",");
    }
    const apiKey = accountScope?.connection.apiKey || connections[0].apiKey;
    if (action === "fields" || action === "sample") assertAdmin(access);
    // A new browser may not yet have the shared account directory. Brand View
    // remains usable: on its explicit manual refresh only, discover the
    // accounts the user may access and use them to seed the brand directory.
    // Ordinary reads still never call DataDoe.
    if (action === "brand-directory" && !publicAccountIds.length && access.role !== "admin") {
      publicAccountIds = [...new Set(access.accountIds || [])];
    }
    // The browser continues a catalog sync in several small requests. Account
    // discovery belongs only to the first explicit click; repeating it for
    // every batch would waste DataDoe calls and slow the directory down.
    const continuingBrandDirectorySync = String(req.query.catalogSyncContinue || "") === "1";
    if (action === "brand-directory" && wantsRefresh(req) && !continuingBrandDirectorySync) {
      const discovered = await discoverConnectedAccounts(connections);
      discoveredDirectoryAccounts = discovered;
      brandDirectoryAccounts = access.role === "admin"
        ? discovered
        : discovered.filter((account) => access.accountIds.includes(String(account.id)));
      // A manual directory refresh is the explicit account-discovery action.
      // Replace a stale browser scope with every currently permitted account,
      // including newly added secondary-organisation accounts. Ordinary reads
      // remain cache-only and never call DataDoe.
      publicAccountIds = brandDirectoryAccounts.map((account) => String(account.id));
    }
    // Brand View is multi-account and therefore is not in ACCOUNT_SCOPED_ACTIONS.
    // Authorise its directory and aggregate portfolio reads before the shared
    // snapshot is served as well as before a manual refresh.
    // `brand-view-portfolio` is multi-account and can legitimately span both
    // DataDoe organisations, so it is deliberately not in ACCOUNT_SCOPED_ACTIONS
    // (that path resolves a single connection). It is authorised here instead,
    // before any read, exactly like the other portfolio actions.
    if (
      (action === "brand-directory" || action === "brand-portfolio" || action === "brand-view-portfolio")
      && publicAccountIds.length
    ) {
      assertAccountAccess(access, publicAccountIds);
    }

    if (action === "brand-portfolio") {
      const brand = String(req.query.brand || "").trim();
      const asOf = String(req.query.asOf || "");
      if (!brand || !publicAccountIds.length || !isDateStr(asOf)) {
        res.status(400).json({ error: "Brand View requires brand, one or more allowed account ids, and an asOf date (YYYY-MM-DD)." });
        return;
      }
      const accountIds = [...new Set(publicAccountIds.map(String))].sort();
      await serveSharedReport({
        res,
        refresh: wantsRefresh(req),
        reportKey: BRAND_PORTFOLIO_REPORT_KEY,
        reportVersion: BRAND_PORTFOLIO_VERSION,
        accountId: stableSelectionId("brand-portfolio", accountIds),
        params: { brand, accountIds: accountIds.join(","), asOf },
        userId: access.userId,
        label: "Brand View",
        // A portfolio build only aggregates shared snapshots plus persisted
        // Ads rows, but a larger set of mapped marketplaces may still take a
        // little longer than the default account report.
        lockSeconds: 300,
        build: () => buildBrandPortfolioSnapshot({ brand, accountIds, asOf }),
      });
      return;
    }

    /* ============================================================
       Account-scoped Brand View: Account -> Brand -> Brand Reports.

       Both actions are single-account and cache-only. Neither ever starts a
       DataDoe export, not even on an explicit Refresh: a Brand View refresh
       re-aggregates this account's already-saved Dashboard, Ads and FBA
       snapshots and saves one compact shared result. Getting *newer source*
       data is still the job of the account's own reports, which keeps DataDoe
       cost exactly where it already was.
       ============================================================ */

    if (action === "brand-view-brands") {
      if (!accountScope || accountScope.accountIds.length !== 1) {
        res.status(400).json({ error: "Brand View requires exactly one selected account." });
        return;
      }
      const accountId = accountScope.accountIds[0];
      if (!isSupabaseConfigured()) {
        res.status(200).json({
          accountId, brands: [], sources: [],
          message: "Brand View needs the shared Supabase snapshot store. This deployment has no Supabase configuration.",
        });
        return;
      }
      const { payload, savedAt, shared } = await brandViewDirectory(accountId, { rebuild: wantsRefresh(req) });
      res.status(200).json({
        ...payload,
        reportKey: BRAND_VIEW_BRANDS_REPORT_KEY,
        reportVersion: BRAND_VIEW_BRANDS_VERSION,
        snapshot: { savedAt, shared },
      });
      return;
    }

    if (action === "brand-view") {
      if (!accountScope || accountScope.accountIds.length !== 1) {
        res.status(400).json({ error: "Brand View requires exactly one selected account." });
        return;
      }
      const accountId = accountScope.accountIds[0];
      const brand = String(req.query.brand || "").trim();
      const asOf = String(req.query.asOf || "");
      if (!brand) {
        res.status(400).json({ error: "Brand View requires a selected brand." });
        return;
      }
      if (!isDateStr(asOf)) {
        res.status(400).json({ error: "Brand View requires an asOf date (YYYY-MM-DD)." });
        return;
      }
      // The brand must be one this account's own saved data records. This is the
      // server-side guarantee behind "the Brand dropdown must never contain
      // brands from another account": a crafted request naming another
      // account's brand is refused rather than silently returning nothing.
      // Cache-first, then one rebuild only if the brand is not in the saved
      // list. That covers a brand added since the directory was last derived
      // without paying for a rebuild on the common path.
      let { payload: directory } = await brandViewDirectory(accountId);
      if (!directory.brands.includes(brand)) {
        ({ payload: directory } = await brandViewDirectory(accountId, { rebuild: true }));
      }
      if (!directory.brands.includes(brand)) {
        res.status(400).json({
          error: directory.brands.length
            ? `"${brand}" is not a brand recorded in this account's saved data. Choose a brand from this account.`
            : directory.message,
        });
        return;
      }

      const accountMeta = await sharedAccountMetadata(accountId);
      await serveSharedReport({
        res,
        refresh: wantsRefresh(req),
        reportKey: BRAND_VIEW_REPORT_KEY,
        reportVersion: BRAND_VIEW_VERSION,
        // The brand is part of the snapshot's account key, not only its params
        // hash, so the across-midnight stale-scope fallback can never serve one
        // brand's saved report for another brand.
        accountId: brandViewScopeId(accountId, brand),
        params: { accountId, brand, asOf },
        userId: access.userId,
        label: "Brand View",
        build: () => buildBrandViewSnapshot({
          accountId,
          brand,
          asOf,
          account: accountMeta,
          getSnapshot: getLatestReportSnapshot,
          getAdsRows: getAdsDailySourceRows,
        }),
      });
      return;
    }

    // The cross-account Brand View: one brand across every account it is mapped
    // to. Same builder pieces, same payload shape and same client code as the
    // single-account report above; only the account set differs. Still cache-only:
    // it aggregates saved snapshots and never starts a DataDoe export.
    if (action === "brand-view-portfolio") {
      const brand = String(req.query.brand || "").trim();
      const asOf = String(req.query.asOf || "");
      const accountIds = [...new Set(publicAccountIds.map(String))].sort();
      if (!brand || !accountIds.length || !isDateStr(asOf)) {
        res.status(400).json({ error: "Brand View requires a brand, one or more allowed account ids, and an asOf date (YYYY-MM-DD)." });
        return;
      }
      // Authorised above for this action, but assert again next to the read so
      // the guarantee is visible at the point of use.
      assertAccountAccess(access, accountIds);

      const directory = await getLatestReportSnapshot({
        reportKey: "account-directory",
        accountId: "__account-directory__",
      }).catch(() => null);
      const accountsById = Object.fromEntries(
        (directory?.payload?.accounts || [])
          .filter((entry) => accountIds.includes(String(entry.id)))
          .map((entry) => [String(entry.id), { name: entry.name || null, country: entry.country || null }])
      );

      await serveSharedReport({
        res,
        refresh: wantsRefresh(req),
        reportKey: BRAND_VIEW_PORTFOLIO_REPORT_KEY,
        reportVersion: BRAND_VIEW_PORTFOLIO_VERSION,
        accountId: brandViewPortfolioScopeId(accountIds, brand),
        params: { accountIds: accountIds.join(","), brand, asOf },
        userId: access.userId,
        label: "Brand View",
        // Reading a dozen saved Dashboard payloads sequentially takes longer
        // than a single-account build, so the lock is held for longer.
        lockSeconds: 300,
        build: () => buildBrandViewPortfolioSnapshot({
          accountIds,
          brand,
          asOf,
          accountsById,
          getSnapshot: getLatestReportSnapshot,
          getAdsRows: getAdsDailySourceRows,
        }),
      });
      return;
    }

    // Exchange rates for the Brand View currency selector. Reading is always
    // Supabase-first; the provider is contacted server-side at most once per
    // provider cycle. A browser never calls the FX provider directly.
    if (action === "fx-rates") {
      const rates = await getFxRates();
      res.status(200).json({ ...rates, displayCurrencies: FX_DISPLAY_CURRENCIES });
      return;
    }

    const legacyShared = legacySharedDescriptor({ action, req, access, publicAccountIds, accountScope });
    if (legacyShared) {
      const sharedOptions = {
        res,
        ...legacyShared,
        userId: access.userId,
      };
      if (!wantsRefresh(req)) {
        // Brand Directory v1 contained a usable brand list but not the newer
        // brand-to-account map. Keep serving it instantly while a v2 map is
        // being rebuilt from saved reports; the browser safely falls back to
        // its permitted account set for that older payload.
        if (action === "brand-directory") {
          const previous = await getLatestReportSnapshot({
            reportKey: legacyShared.reportKey,
            accountId: legacyShared.accountId,
          });
          if (previous?.payload?.brands?.length) {
            res.status(200).json({
              ...previous.payload,
              reportKey: legacyShared.reportKey,
              reportVersion: legacyShared.reportVersion,
              paramsHash: legacyShared.params ? paramsHashFor(legacyShared.reportVersion, legacyShared.params) : null,
              snapshot: {
                savedAt: previous.source_refreshed_at || previous.updated_at || null,
                updatedAt: previous.updated_at || null,
                shared: true,
                legacyDirectory: previous.params?.reportVersion !== legacyShared.reportVersion,
              },
            });
            return;
          }
        }
        // Reading a report is always server-side and shared. It never reaches
        // DataDoe, even on a new browser or under a different user account.
        await serveSharedReport({ ...sharedOptions, refresh: false });
        return;
      }
      legacySharedRefresh = await beginSharedRefresh(sharedOptions);
      if (!legacySharedRefresh) return;
      if (action === "brand-directory" && discoveredDirectoryAccounts) {
        await persistAccountDirectory(discoveredDirectoryAccounts);
      }
    }
    const sendLegacyPayload = async (payload) => {
      if (legacySharedRefresh) {
        await legacySharedRefresh.finish(payload);
        return;
      }
      res.status(200).json(payload);
    };

    if (action === "accounts") {
      const accounts = await discoverConnectedAccounts(connections);
      await sendLegacyPayload({ accounts });
      return;
    }

    // Brand View needs a global picker before a user has selected an account.
    // This is deliberately a manual, catalog-only request: it avoids the old
    // 14-month order-history scan merely to populate a dropdown. Requested
    // public IDs are authorized and resolved one at a time so the resulting
    // brand-to-account map is exact across both DataDoe connections.
    if (action === "brand-directory") {
      if (!publicAccountIds.length) {
        res.status(400).json({ error: "Brand directory requires at least one accessible account." });
        return;
      }
      assertAccountAccess(access, publicAccountIds);
      let directory = await sharedSnapshotBrandAccounts(publicAccountIds);
      let unresolvedAccountIds = [...directory.catalogPendingAccountIds];
      let catalogSync = [];

      // Loading the picker is cache-only. On the explicit button action, seed
      // one missing account per configured DataDoe organisation, then let the
      // browser continue in small batches until the shared directory is done.
      // Existing unavailable catalog snapshots are also retried explicitly,
      // which lets an administrator recover after adding DataDoe credits.
      if (wantsRefresh(req)) {
        // A new explicit click retries prior catalog failures after credits or
        // source access change. Continuation requests process only untouched
        // accounts, so one blocked account cannot starve the rest of its
        // DataDoe organisation.
        const retryUnavailable = String(req.query.retryUnavailable || "") === "1";
        const retryAccountIds = retryUnavailable ? [...directory.catalogUnavailable.keys()] : [];
        const targets = [...new Set([...unresolvedAccountIds, ...retryAccountIds])];
        if (targets.length) {
          catalogSync = await syncBrandCatalogBatch(targets, connections);
          directory = await sharedSnapshotBrandAccounts(publicAccountIds);
          unresolvedAccountIds = [...directory.catalogPendingAccountIds];
        }
      }

      const saved = serialiseBrandAccountMap(directory.brandAccountIds);
      const catalogUnavailableAccounts = [...directory.catalogUnavailable.entries()].map(([accountId, error]) => {
        const account = (brandDirectoryAccounts || []).find((entry) => String(entry.id) === String(accountId));
        return { accountId, name: account?.name || accountId, error };
      });
      await sendLegacyPayload({
        ...saved,
        accounts: brandDirectoryAccounts || [],
        source: catalogSync.length ? "shared-snapshots-and-catalog-sync" : "shared-snapshots",
        partial: unresolvedAccountIds.length > 0,
        unresolvedAccountIds,
        catalogUnavailableAccounts,
        catalogSync: {
          completed: catalogSync.filter((entry) => entry.status === "complete").length,
          unavailable: catalogSync.filter((entry) => entry.status === "unavailable").length,
          pendingAccountIds: unresolvedAccountIds,
        },
        message: saved.brands.length
          ? null
          : "No brand data is saved yet. The explicit directory sync is loading Product Catalog data account by account; keep this page open until it completes.",
      });
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
      await sendLegacyPayload({ rows });
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
      // Single implementation, shared with the scheduled-sync adapter.
      const payload = await buildBrandSalesPayload({ apiKey, ids: sellerOrVendorIds, from, to });
      await sendLegacyPayload(payload);
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
        await sendLegacyPayload({ rows: dailyRowsForBrand(salesRaw, catalog, brand), brandFiltered: true });
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
        const savedAds = await getAdDailyMetrics(accountScope.accountIds[0], from, to);
        ads = normalizeAdRows(savedAds.map((row) => ({
          date: row.metric_date,
          seller_or_vendor_id: accountScope.accountIds[0],
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
      await sendLegacyPayload({ rows, brandFiltered: false });
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
      await sendLegacyPayload({
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
      await sendLegacyPayload({
        accountId: accountScope.accountIds[0],
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

      await sendLegacyPayload({
        accountId: accountScope.accountIds[0],
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
      await sendLegacyPayload({
        accountId: accountScope.accountIds[0],
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
      const accounts = await fetchAccountsRaw(apiKey);
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
      // ADDITIVE ONLY. FBA Inventory Health is per marketplace, but the per-ASIN
      // rows below intentionally fold that dimension away for the shipment plan.
      // The account-scoped Brand View needs FBA inventory per country, so the
      // same rows are also folded to (marketplace, brand) here. Nothing existing
      // reads this key, so the FBA Shipment Plan report is unchanged.
      const invByCountryBrand = new Map();
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
        // Per-marketplace roll-up for Brand View. `brandByAsin` is the same
        // catalog map the per-ASIN rows use, so a brand's country inventory can
        // never disagree with its shipment-plan inventory.
        const invCountry = String(r.marketplace_country_code || account?.country || "").trim().toUpperCase();
        const invBrand = brandByAsin.get(asin) || null;
        const countryBrandKey = `${invCountry}|${invBrand || ""}`;
        const bucket = invByCountryBrand.get(countryBrandKey)
          || { country: invCountry || null, brand: invBrand, fbaAvailable: 0, skus: new Set() };
        bucket.fbaAvailable += num(r.available);
        if (sku) bucket.skus.add(sku);
        invByCountryBrand.set(countryBrandKey, bucket);
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

      await sendLegacyPayload({
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
        // Additive: consumed only by the account-scoped Brand View. Bounded by
        // (marketplaces x brands), so it stays small for accounts with
        // thousands of SKUs.
        inventoryByBrandCountry: [...invByCountryBrand.values()].map(({ skus, ...entry }) => ({
          ...entry,
          skuCount: skus.size,
        })),
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
        accountId: accountScope.accountIds[0],
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
        accountId: accountScope.accountIds[0],
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
        accountId: accountScope.accountIds[0],
        params: { to },
        userId: access.userId,
        label: "Buy Box Loss",
        build: () => buildBuyBoxLoss({ apiKey, ids, to }),
      });
      return;
    }

    if (action === "returns-leakage") {
      const ids = singleAccountId(req, res, "Returns & Refund Leakage");
      if (!ids) return;
      const to = reportAsOf(req, res);
      if (!to) return;
      await serveSharedReport({
        res,
        refresh: wantsRefresh(req),
        reportKey: RETURNS_REPORT_KEY,
        reportVersion: RETURNS_VERSION,
        accountId: accountScope.accountIds[0],
        params: { to },
        userId: access.userId,
        label: "Returns & Refund Leakage",
        build: () => buildReturnsLeakage({ apiKey, ids, to }),
      });
      return;
    }

    // PPC reads the persisted Supabase Ads history, never a live Ads export.
    // Only its small total-sales figure (needed for TACoS) touches DataDoe, and
    // only on an explicit refresh.
    if (action === "ppc-performance") {
      const ids = singleAccountId(req, res, "PPC Performance");
      if (!ids) return;
      const to = reportAsOf(req, res);
      if (!to) return;
      await serveSharedReport({
        res,
        refresh: wantsRefresh(req),
        reportKey: PPC_REPORT_KEY,
        reportVersion: PPC_VERSION,
        accountId: accountScope.accountIds[0],
        params: { to },
        userId: access.userId,
        label: "PPC Performance",
        build: () => buildPpcPerformance({ apiKey, ids, accountId: accountScope.accountIds[0], to }),
      });
      return;
    }

    if (action === "listing-optimizer") {
      const ids = singleAccountId(req, res, "Listing & Search Optimizer");
      if (!ids) return;
      const to = reportAsOf(req, res);
      if (!to) return;
      await serveSharedReport({
        res,
        refresh: wantsRefresh(req),
        reportKey: OPTIMIZER_REPORT_KEY,
        reportVersion: OPTIMIZER_VERSION,
        accountId: accountScope.accountIds[0],
        params: { to },
        userId: access.userId,
        label: "Listing & Search Optimizer",
        build: () => buildListingOptimizer({ apiKey, ids, to }),
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

    res.status(400).json({ error: "Unknown action. Use ?action=accounts, ?action=brand-directory, ?action=brand-portfolio, ?action=brand-view-brands, ?action=brand-view, ?action=brand-view-portfolio, ?action=fx-rates, ?action=sales, ?action=brand-sales, ?action=daily, ?action=reconciliation, ?action=sku-pl, ?action=keyword-rank, ?action=content-changes, ?action=fba-plan, ?action=fields, or ?action=sample" });
  } catch (err) {
    const status = err instanceof DashboardAccessError ? err.status : 500;
    res.status(status).json({ error: err instanceof Error ? err.message : "Unexpected server error." });
  } finally {
    await legacySharedRefresh?.release();
  }
}
