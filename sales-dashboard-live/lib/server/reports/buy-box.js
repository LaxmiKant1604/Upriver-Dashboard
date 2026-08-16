// Buy Box Loss — which SKUs are losing the featured offer, how much revenue
// that costs, and whether price, stock or fulfilment explains it.
//
// Buy Box share has no dedicated DataDoe table. `buybox_percentage` lives on
// Profit by SKU & Date at (child ASIN, SKU, date) grain, and it is a RATIO, so
// it must never be summed and must not be averaged naively either: a day with
// two page views would count as much as a day with two thousand. This builder
// therefore fetches the raw daily rows and computes a page-view-weighted share,
// falling back to an unweighted mean over observed days only when the source
// reported no page views at all.
//
// Raw daily grain over a 28-day window would exceed the export row cap on a
// large catalogue, so the window is fetched in 7-day slices and any slice that
// reaches the cap aborts the refresh rather than returning a partial share.
//
// Cause attribution uses the competitive prices on the latest FBA Inventory
// Health snapshot (your_price, sales_price, featuredoffer_price,
// lowest_price_new_plus_shipping) plus `available`. A cause is only claimed when
// those fields are actually present; otherwise the row says the cause is
// unconfirmed.

import { addDaysStr, num, numOrNull, splitDateRangeByDays } from "../datadoe.js";
import {
  brandLabel,
  fetchCatalog,
  fetchExportRowsStrict,
  fetchInventorySnapshot,
  sumField,
} from "./common.js";
import { ORDER_LINE_ITEMS, PROFIT_BY_SKU, ROW_LIMITS } from "./sources.js";

export const BUY_BOX_REPORT_KEY = "buy-box-loss";
export const BUY_BOX_VERSION = "buy-box-loss-v1";

const WINDOW_DAYS = 28;
const SLICE_DAYS = 7;

// Raw daily columns only — no groupBy, because a weighted ratio cannot be
// produced by a SUM aggregation. Ordered sales/units are NOT read here anymore; they come
// from Order Line Items (ORDERED_* below), so this source now supplies ONLY the buy-box ratio
// + page views (the page-view-weighted share) plus the join dimensions/metadata.
const DAILY_COLUMNS = [
  "date",
  "sku",
  "child_asin",
  "product_name",
  "product_brand",
  "currency",
  "buybox_percentage",
  "page_views",
];

// Ordered sales/units from Order Line Items, grouped by sku + child_asin + item_price_currency
// so DataDoe never sums money across currencies; the fold keeps each currency isolated and joins
// to the daily buy-box rows on currency|sku.
const ORDERED_GROUP_BY = ["sku", "child_asin", "item_price_currency"];
const ORDERED_AGGREGATIONS = [
  { column: "item_price_value", aggregation: "sum", alias: "sales_sum" },
  { column: "quantity", aggregation: "sum", alias: "units_sum" },
];

export async function buildBuyBoxLoss({ apiKey, ids, to }) {
  const from = addDaysStr(to, -(WINDOW_DAYS - 1));
  const slices = splitDateRangeByDays(from, to, SLICE_DAYS);

  // key = currency|sku so two currencies for one SKU are never merged.
  const bySku = new Map();
  // Ordered sales/units keyed the SAME way (currency|sku) from Order Line Items; joined below.
  const bySkuOrdered = new Map();
  let observedFrom = null;
  let observedTo = null;

  for (const slice of slices) {
    const rows = await fetchExportRowsStrict(
      apiKey, PROFIT_BY_SKU.id, DAILY_COLUMNS, ids, slice.from, slice.to, ROW_LIMITS.rawGrain,
      { orderByColumn: "date", orderByDirection: "ASC" },
      `Buy Box daily export (${slice.from} to ${slice.to})`
    );
    for (const row of rows) {
      const sku = String(row.sku || "").trim();
      if (!sku) continue;
      const currency = String(row.currency || "").trim() || null;
      const key = `${currency || "?"}|${sku}`;
      let entry = bySku.get(key);
      if (!entry) {
        entry = {
          sku,
          asin: String(row.child_asin || "").trim() || null,
          productName: String(row.product_name || "").trim() || null,
          brand: String(row.product_brand || "").trim() || null,
          currency,
          pageViews: 0,
          // Weighted numerator/denominator for the buy-box share.
          buyBoxWeighted: 0,
          buyBoxWeight: 0,
          buyBoxSum: 0,
          buyBoxDays: 0,
        };
        bySku.set(key, entry);
      }
      if (!entry.productName) entry.productName = String(row.product_name || "").trim() || null;
      if (!entry.brand) entry.brand = String(row.product_brand || "").trim() || null;

      const date = String(row.date || "");
      if (date) {
        if (!observedFrom || date < observedFrom) observedFrom = date;
        if (!observedTo || date > observedTo) observedTo = date;
      }

      const pageViews = num(row.page_views);
      entry.pageViews += pageViews;

      // Null buy-box normally means "no featured-offer competition observed"
      // (a sole seller). Those days are excluded from the share rather than
      // counted as 0%, which would invent a loss that did not happen.
      const buyBox = numOrNull(row.buybox_percentage);
      if (buyBox !== null) {
        entry.buyBoxDays += 1;
        entry.buyBoxSum += buyBox;
        if (pageViews > 0) {
          entry.buyBoxWeighted += buyBox * pageViews;
          entry.buyBoxWeight += pageViews;
        }
      }
    }

    // Ordered sales/units for the SAME slice from Order Line Items (item_price_value / quantity),
    // grouped per (sku, child_asin, item_price_currency) so money never crosses currencies.
    const orderedRows = await fetchExportRowsStrict(
      apiKey, ORDER_LINE_ITEMS.id, ORDERED_GROUP_BY, ids, slice.from, slice.to, ROW_LIMITS.rawGrain,
      { groupBy: ORDERED_GROUP_BY, aggregations: ORDERED_AGGREGATIONS, orderByColumn: "sku", orderByDirection: "ASC" },
      `Buy Box ordered export (${slice.from} to ${slice.to})`
    );
    for (const row of orderedRows) {
      const sku = String(row.sku || "").trim();
      if (!sku) continue;
      const currency = String(row.item_price_currency || "").trim() || null;
      const key = `${currency || "?"}|${sku}`;
      let entry = bySkuOrdered.get(key);
      if (!entry) { entry = { sales: 0, units: 0 }; bySkuOrdered.set(key, entry); }
      entry.sales += sumField(row, "sales_sum", "item_price_value");
      entry.units += sumField(row, "units_sum", "quantity");
    }
  }

  const inventory = await fetchInventorySnapshot(apiKey, ids, to);
  const catalog = await fetchCatalog(apiKey, ids);

  const rows = [];
  const currencies = new Set();
  for (const entry of bySku.values()) {
    // Ordered sales/units join on the SAME currency|sku identity used by the buy-box fold.
    const sold = bySkuOrdered.get(`${entry.currency || "?"}|${entry.sku}`) || { sales: 0, units: 0 };
    // Only SKUs that actually sold in the window can have revenue at risk.
    if (sold.units <= 0 && sold.sales <= 0) continue;
    if (entry.buyBoxDays === 0) continue; // no observed buy-box data at all

    const weighted = entry.buyBoxWeight > 0;
    const buyBoxPct = weighted
      ? entry.buyBoxWeighted / entry.buyBoxWeight
      : entry.buyBoxSum / entry.buyBoxDays;

    const stock = inventory.bySku.get(entry.sku) || null;
    const meta = entry.asin ? catalog.byAsin.get(entry.asin) || {} : {};
    if (entry.currency) currencies.add(entry.currency);

    rows.push({
      sku: entry.sku,
      asin: entry.asin,
      productName: entry.productName || meta.name || null,
      brand: brandLabel(entry.brand || meta.brand),
      currency: entry.currency,
      buyBoxPct,
      buyBoxBasis: weighted ? "page-view weighted" : "unweighted mean of observed days",
      buyBoxDays: entry.buyBoxDays,
      windowDays: WINDOW_DAYS,
      sales: sold.sales,
      units: sold.units,
      pageViews: entry.pageViews,
      // Price and stock evidence. null means the snapshot did not carry it, and
      // the client must then refuse to name a cause.
      price: stock
        ? {
          yourPrice: stock.yourPrice,
          salesPrice: stock.salesPrice,
          featuredOfferPrice: stock.featuredOfferPrice,
          lowestPriceNewPlusShipping: stock.lowestPriceNewPlusShipping,
          currency: stock.currency,
        }
        : null,
      available: stock ? stock.available : null,
      unitsShippedT30: stock ? stock.unitsShippedT30 : null,
      inventoryKnown: Boolean(stock),
    });
  }

  return {
    accountId: ids[0],
    asOf: to,
    window: { from, to, days: WINDOW_DAYS, sliceDays: SLICE_DAYS },
    observedWindow: observedFrom && observedTo ? { from: observedFrom, to: observedTo } : null,
    sourceLabel: PROFIT_BY_SKU.label,
    priceSourceLabel: "FBA Inventory Health",
    inventoryAvailable: inventory.available,
    inventorySnapshotDate: inventory.snapshotDate,
    currencies: [...currencies].sort(),
    rows,
    catalogBrands: catalog.catalogBrands,
  };
}
