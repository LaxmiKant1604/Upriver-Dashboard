// Pieces every insight report needs: the ASIN/brand map, honest source
// freshness, and the latest FBA inventory snapshot.

import {
  addDaysStr,
  fetchExportRows,
  fetchExportRowsStrict,
  num,
  numOrNull,
} from "../datadoe.js";
import {
  FBA_INVENTORY_HEALTH,
  PRODUCT_CATALOG,
  ROW_LIMITS,
  SALES_TRAFFIC,
} from "./sources.js";

export const CATALOG_COLUMNS = ["child_asin", "parent_asin", "product_name", "product_brand"];

export function brandLabel(value) {
  return String(value || "").trim() || "Unassigned";
}

/**
 * ASIN -> { name, brand } for the selected account, plus the distinct brand
 * list the shared header selector needs.
 *
 * Product Catalog by ASIN has no date column, so no from/to is sent and the
 * export orders by child_asin.
 */
export async function fetchCatalog(apiKey, ids) {
  // Strict: a truncated catalog would silently drop product names and, worse,
  // brands — which would make the shared header brand filter hide real rows.
  const rows = await fetchExportRowsStrict(
    apiKey, PRODUCT_CATALOG.id, CATALOG_COLUMNS, ids, null, null, ROW_LIMITS.catalog,
    { orderByColumn: "child_asin", orderByDirection: "ASC" },
    "Product catalog export"
  );
  const byAsin = new Map();
  const brands = new Set();
  for (const row of rows) {
    const asin = String(row.child_asin || "").trim();
    if (!asin) continue;
    const brand = String(row.product_brand || "").trim();
    if (brand) brands.add(brand);
    if (!byAsin.has(asin)) {
      byAsin.set(asin, {
        name: String(row.product_name || "").trim() || null,
        brand: brand || null,
        parentAsin: String(row.parent_asin || "").trim() || null,
      });
    }
  }
  return {
    byAsin,
    catalogBrands: [...brands].sort((a, b) => a.localeCompare(b)),
  };
}

/**
 * The latest date on which Sales & Traffic actually reported units for this
 * account. The source can emit a newer row with zero sales before its data
 * lands, so anchoring on that placeholder would silently understate a window.
 * Returns null when nothing was reported, and the caller must then say so
 * instead of showing zeroes.
 */
export async function fetchSalesTrafficLatestDate(apiKey, ids, from, to) {
  const rows = await fetchExportRows(
    apiKey, SALES_TRAFFIC.id, ["date"], ids, from, to, ROW_LIMITS.dateRollup,
    {
      groupBy: ["date"],
      aggregations: [{ column: "total_units", aggregation: "sum", alias: "units_sum" }],
      orderByColumn: "date",
      orderByDirection: "ASC",
    }
  );
  let latest = null;
  for (const row of rows) {
    if (num(row.units_sum) > 0 && row.date && (!latest || row.date > latest)) latest = row.date;
  }
  return latest;
}

export const INVENTORY_COLUMNS = [
  "date",
  "sku",
  "child_asin",
  "product_name",
  "currency",
  "available",
  "unfulfillable_quantity",
  "inbound_shipped",
  "inbound_received",
  "days_of_supply",
  "units_shipped_t30",
  "your_price",
  "sales_price",
  "featuredoffer_price",
  "lowest_price_new_plus_shipping",
  "alert",
];

/**
 * The latest FBA Inventory Health snapshot, keyed by SKU and folded to ASIN.
 *
 * The source is a daily per-SKU snapshot (INITIAL 1 / RECURRING_DAILY 1), so the
 * export looks back a few days ordered by date DESC and keeps only the newest
 * date present. Prices are kept per SKU because a competitive price is a
 * per-offer fact and must not be summed or averaged across SKUs.
 *
 * `available: null` on the returned object means the whole snapshot is missing,
 * which the UI must show as unavailable rather than as zero stock.
 */
export async function fetchInventorySnapshot(apiKey, ids, asOf) {
  // Strict on purpose. Ordering by date DESC puts the newest snapshot first, so
  // hitting the cap only ever drops OLDER snapshots — unless the latest snapshot
  // itself is bigger than the cap, in which case a SKU absent from the truncated
  // result would look like zero stock and produce a false stockout claim. That
  // is exactly the kind of confident-but-wrong output worth failing for.
  const rows = await fetchExportRowsStrict(
    apiKey, FBA_INVENTORY_HEALTH.id, INVENTORY_COLUMNS, ids,
    addDaysStr(asOf, -FBA_INVENTORY_HEALTH.snapshotLookbackDays), asOf, ROW_LIMITS.inventory,
    { orderByColumn: "date", orderByDirection: "DESC" },
    "FBA inventory snapshot export"
  );

  let snapshotDate = null;
  for (const row of rows) {
    if (row.date && (!snapshotDate || row.date > snapshotDate)) snapshotDate = row.date;
  }
  const current = snapshotDate ? rows.filter((row) => row.date === snapshotDate) : [];

  const bySku = new Map();
  const byAsin = new Map();
  for (const row of current) {
    const sku = String(row.sku || "").trim();
    const asin = String(row.child_asin || "").trim();
    const entry = {
      sku: sku || null,
      asin: asin || null,
      productName: String(row.product_name || "").trim() || null,
      currency: String(row.currency || "").trim() || null,
      available: num(row.available),
      unfulfillable: num(row.unfulfillable_quantity),
      inbound: num(row.inbound_shipped) + num(row.inbound_received),
      daysOfSupply: numOrNull(row.days_of_supply),
      unitsShippedT30: num(row.units_shipped_t30),
      // Competitive prices are nullable in the source; keep null so a missing
      // price is never read as "priced at zero".
      yourPrice: numOrNull(row.your_price),
      salesPrice: numOrNull(row.sales_price),
      featuredOfferPrice: numOrNull(row.featuredoffer_price),
      lowestPriceNewPlusShipping: numOrNull(row.lowest_price_new_plus_shipping),
      alert: String(row.alert || "").trim() || null,
    };
    if (sku && !bySku.has(sku)) bySku.set(sku, entry);
    if (asin) {
      const folded = byAsin.get(asin) || {
        asin, available: 0, unfulfillable: 0, inbound: 0, unitsShippedT30: 0,
        daysOfSupply: null, skuCount: 0,
      };
      folded.available += entry.available;
      folded.unfulfillable += entry.unfulfillable;
      folded.inbound += entry.inbound;
      folded.unitsShippedT30 += entry.unitsShippedT30;
      if (entry.daysOfSupply !== null) {
        folded.daysOfSupply = folded.daysOfSupply === null
          ? entry.daysOfSupply
          : Math.min(folded.daysOfSupply, entry.daysOfSupply);
      }
      folded.skuCount += 1;
      byAsin.set(asin, folded);
    }
  }

  return {
    snapshotDate,
    available: current.length > 0,
    bySku,
    byAsin,
  };
}

/** Sum helper for grouped exports that return `<alias>` or the raw column. */
export function sumField(row, alias, column) {
  return num(row[alias] ?? row[column]);
}

export { fetchExportRowsStrict };
