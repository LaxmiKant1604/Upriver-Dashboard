// Listing Health / Suppressed Listings — which SKUs are not selling properly
// right now, ranked by the sales actually at risk.
//
// Primary source: Listings (defaultDataset, premium). It gives the documented
// `listing_status` enum (Active / Inactive / Incomplete), the offer price and
// currency, FBM vs FBA through `listing_fulfillment_channel`, and the units the
// listing is holding. It has no date column, so exports send no from/to.
//
// Optional source: Listings (Raw JSON). NOT enabled by default. When available
// it adds Amazon's own `issues` array (severity ERROR / WARNING / INFO with a
// code and message) and the `summaries` buyable/discoverable flags, which are
// the only true suppression signals. When it is disabled the report still works
// and says exactly which extra signal is missing — it never invents an issue.
//
// Revenue at risk comes from Profit by SKU & Date over a trailing 30-day
// window, grouped per SKU and currency so currencies are never combined.

import { addDaysStr, isSourceDisabledError, num } from "../datadoe.js";
import {
  brandLabel,
  fetchCatalog,
  fetchExportRowsStrict,
  fetchInventorySnapshot,
  sumField,
} from "./common.js";
import { LISTINGS, LISTINGS_RAW, PROFIT_BY_SKU, ROW_LIMITS } from "./sources.js";

export const LISTING_HEALTH_REPORT_KEY = "listing-health";
export const LISTING_HEALTH_VERSION = "listing-health-v1";

const SALES_WINDOW_DAYS = 30;

const LISTING_COLUMNS = [
  "sku",
  "child_asin",
  "listing_name",
  "listing_status",
  "listing_price_value",
  "listing_price_currency",
  "listing_current_quantity",
  "listing_pending_quantity",
  "fba_quantity_available",
  "fba_quantity_inbound",
  "fba_quantity_reserved",
  "listing_fulfillment_channel",
  "listing_open_date",
];

const LISTING_RAW_COLUMNS = ["child_asin", "sku", "summaries", "issues", "offers", "fulfillment_availability"];

const SALES_COLUMNS = ["sku", "child_asin", "currency"];
const SALES_AGGREGATIONS = [
  { column: "total_sales", aggregation: "sum", alias: "sales_sum" },
  { column: "total_units_sold", aggregation: "sum", alias: "units_sum" },
  { column: "profit", aggregation: "sum", alias: "profit_sum" },
];

function parseJson(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "object") return value;
  try { return JSON.parse(String(value)); } catch (e) { return null; }
}

// Amazon's issues payload is an array of { severity, code, message, categories }.
// Only the fields the report displays are kept, and only the first few issues
// per SKU, so a shared snapshot stays compact.
function normaliseIssues(value) {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed)) return [];
  return parsed.slice(0, 6).map((issue) => ({
    severity: String(issue?.severity || "").toUpperCase() || null,
    code: issue?.code === undefined || issue?.code === null ? null : String(issue.code),
    message: String(issue?.message || "").slice(0, 260) || null,
  })).filter((issue) => issue.severity || issue.code || issue.message);
}

// `summaries` is either an object or a one-element array depending on the
// Amazon SP-API version DataDoe captured. Read both shapes and only report a
// flag that is genuinely present.
function normaliseSummary(value) {
  const parsed = parseJson(value);
  const summary = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!summary || typeof summary !== "object") return { buyable: null, discoverable: null, status: null };
  const statuses = Array.isArray(summary.status)
    ? summary.status.map((entry) => String(entry).toUpperCase())
    : Array.isArray(summary.statuses)
      ? summary.statuses.map((entry) => String(entry).toUpperCase())
      : null;
  return {
    buyable: statuses ? statuses.includes("BUYABLE") : null,
    discoverable: statuses ? statuses.includes("DISCOVERABLE") : null,
    status: statuses ? statuses.join(",") : null,
  };
}

function hasLiveOffer(value) {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  return parsed.some((offer) => {
    const price = offer?.price?.amount ?? offer?.price ?? null;
    const amount = Number(price);
    return Number.isFinite(amount) && amount > 0;
  });
}

export async function buildListingHealth({ apiKey, ids, to }) {
  const salesFrom = addDaysStr(to, -(SALES_WINDOW_DAYS - 1));

  const listingRows = await fetchExportRowsStrict(
    apiKey, LISTINGS.id, LISTING_COLUMNS, ids, null, null, ROW_LIMITS.listings,
    { orderByColumn: "child_asin", orderByDirection: "ASC" },
    "Listing Health listings export"
  );

  const salesRows = await fetchExportRowsStrict(
    apiKey, PROFIT_BY_SKU.id, SALES_COLUMNS, ids, salesFrom, to, ROW_LIMITS.aggregated,
    {
      groupBy: SALES_COLUMNS,
      aggregations: SALES_AGGREGATIONS,
      orderByColumn: "sku",
      orderByDirection: "ASC",
    },
    "Listing Health sales export"
  );

  const salesBySku = new Map();
  const currencies = new Set();
  for (const row of salesRows) {
    const sku = String(row.sku || "").trim();
    if (!sku) continue;
    const currency = String(row.currency || "").trim() || null;
    if (currency) currencies.add(currency);
    const current = salesBySku.get(sku) || { sales: 0, units: 0, profit: 0, currency };
    current.sales += sumField(row, "sales_sum", "total_sales");
    current.units += sumField(row, "units_sum", "total_units_sold");
    current.profit += sumField(row, "profit_sum", "profit");
    if (!current.currency && currency) current.currency = currency;
    salesBySku.set(sku, current);
  }

  const inventory = await fetchInventorySnapshot(apiKey, ids, to);
  const catalog = await fetchCatalog(apiKey, ids);

  // Optional enrichment. A disabled table is a setup state, not a failure: the
  // report is still returned with issuesAvailable false and the exact hint.
  let issuesAvailable = true;
  let issuesUnavailableReason = null;
  const rawBySku = new Map();
  try {
    const rawRows = await fetchExportRowsStrict(
      apiKey, LISTINGS_RAW.id, LISTING_RAW_COLUMNS, ids, null, null, ROW_LIMITS.listings,
      { orderByColumn: "child_asin", orderByDirection: "ASC" },
      "Listing Health listing-issues export"
    );
    for (const row of rawRows) {
      const sku = String(row.sku || "").trim();
      if (!sku) continue;
      rawBySku.set(sku, {
        issues: normaliseIssues(row.issues),
        summary: normaliseSummary(row.summaries),
        hasLiveOffer: hasLiveOffer(row.offers),
      });
    }
  } catch (error) {
    if (isSourceDisabledError(error)) {
      issuesAvailable = false;
      issuesUnavailableReason = LISTINGS_RAW.enableHint;
    } else {
      throw error;
    }
  }

  const rows = [];
  for (const listing of listingRows) {
    const sku = String(listing.sku || "").trim();
    const asin = String(listing.child_asin || "").trim();
    if (!sku && !asin) continue;
    const meta = catalog.byAsin.get(asin) || {};
    const sales = salesBySku.get(sku) || null;
    const stock = sku ? inventory.bySku.get(sku) || null : null;
    const raw = rawBySku.get(sku) || null;
    const channelRaw = String(listing.listing_fulfillment_channel || "").trim().toUpperCase();

    const fbaAvailable = num(listing.fba_quantity_available);
    const listingQuantity = num(listing.listing_current_quantity);
    const snapshotAvailable = stock ? num(stock.available) : null;

    rows.push({
      sku: sku || null,
      asin: asin || null,
      productName: meta.name || String(listing.listing_name || "").trim() || null,
      brand: brandLabel(meta.brand),
      // Documented enum: Active / Inactive / Incomplete.
      listingStatus: String(listing.listing_status || "").trim() || null,
      // DEFAULT means FBM; AMAZON_NA / AMAZON_EU mean FBA; null is unknown.
      fulfillmentChannel: channelRaw ? (channelRaw === "DEFAULT" ? "FBM" : "FBA") : null,
      fulfillmentChannelRaw: channelRaw || null,
      price: listing.listing_price_value === null || listing.listing_price_value === undefined
        ? null
        : num(listing.listing_price_value),
      currency: String(listing.listing_price_currency || "").trim() || sales?.currency || null,
      listingQuantity,
      fbaAvailable,
      fbaInbound: num(listing.fba_quantity_inbound),
      fbaReserved: num(listing.fba_quantity_reserved),
      snapshotAvailable,
      openDate: listing.listing_open_date || null,
      sales30d: sales ? sales.sales : 0,
      units30d: sales ? sales.units : 0,
      profit30d: sales ? sales.profit : 0,
      hasSalesData: Boolean(sales),
      issues: raw ? raw.issues : [],
      summary: raw ? raw.summary : null,
      hasLiveOffer: raw ? raw.hasLiveOffer : null,
    });
  }

  return {
    accountId: ids[0],
    asOf: to,
    salesWindow: { from: salesFrom, to, days: SALES_WINDOW_DAYS },
    sourceLabel: LISTINGS.label,
    salesSourceLabel: PROFIT_BY_SKU.label,
    issuesAvailable,
    issuesUnavailableReason,
    issuesSourceLabel: LISTINGS_RAW.label,
    inventoryAvailable: inventory.available,
    inventorySnapshotDate: inventory.snapshotDate,
    currencies: [...currencies].sort(),
    listingCount: listingRows.length,
    rows,
    catalogBrands: catalog.catalogBrands,
  };
}
