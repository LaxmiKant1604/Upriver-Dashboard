// Listing & Search Optimizer — where each ASIN loses the search funnel, and
// which listing field is the evidence-backed fix.
//
// Sources:
//  * Search Query Performance (SQP) by ASIN, weekly. NOT a default DataDoe
//    table, so a disabled organisation gets an actionable setup message instead
//    of a server error. Its INITIAL window is only 21 days and it then adds one
//    period per week, so a new connection legitimately has very little history;
//    the report says how many periods it actually has instead of implying a
//    trend it cannot support.
//  * Product Catalog by ASIN — the listing content itself: title, the five
//    bullet points, description, image URL, category and BSR. CONTINUOUS, no
//    date column, so no from/to is sent.
//
// The funnel comparison is what makes a recommendation specific: SQP reports
// both the ASIN's own impressions/clicks/cart-adds/purchases AND the whole
// query's totals, so "your CTR is below the market CTR for this query" is a
// measured fact, not an opinion. Every ratio is computed from summed counts.

import { addDaysStr, isSourceDisabledError, num } from "../datadoe.js";
import { brandLabel, fetchExportRowsStrict } from "./common.js";
import { PRODUCT_CATALOG, ROW_LIMITS, SQP_WEEKLY } from "./sources.js";

export const OPTIMIZER_REPORT_KEY = "listing-optimizer";
export const OPTIMIZER_VERSION = "listing-optimizer-v1";

// The optimizer blueprint asks for at least eight weeks of SQP.
const LOOKBACK_DAYS = 84;

const SQP_COLUMNS = [
  "date",
  "child_asin",
  "search_query",
  "search_query_volume",
  "search_query_total_impression_count",
  "search_query_total_click_count",
  "search_query_total_cart_add_count",
  "search_query_total_purchase_count",
  "child_asin_impression_count",
  "child_asin_click_count",
  "child_asin_add_to_cart_count",
  "child_asin_purchase_count",
  "child_asin_organic_search_rank",
  "child_asin_median_click_price_value",
  "child_asin_median_click_price_currency",
];

const CATALOG_CONTENT_COLUMNS = [
  "child_asin",
  "parent_asin",
  "product_name",
  "product_brand",
  "product_root_category_name",
  "product_root_best_selling_rank",
  "product_bullet_point_1",
  "product_bullet_point_2",
  "product_bullet_point_3",
  "product_bullet_point_4",
  "product_bullet_point_5",
  "product_description",
  "product_image_url",
];

export async function buildListingOptimizer({ apiKey, ids, to }) {
  const from = addDaysStr(to, -LOOKBACK_DAYS);

  let sqpRows;
  try {
    sqpRows = await fetchExportRowsStrict(
      apiKey, SQP_WEEKLY.id, SQP_COLUMNS, ids, from, to, ROW_LIMITS.aggregated,
      { orderByColumn: "date", orderByDirection: "ASC" },
      "Listing Optimizer Search Query Performance export"
    );
  } catch (error) {
    if (isSourceDisabledError(error)) {
      return {
        accountId: ids[0],
        asOf: to,
        window: { from, to, days: LOOKBACK_DAYS },
        sqpAvailable: false,
        sqpUnavailableReason: SQP_WEEKLY.enableHint,
        sqpSourceLabel: SQP_WEEKLY.label,
        periods: [],
        queries: [],
        products: [],
        catalogBrands: [],
      };
    }
    throw error;
  }

  // One bucket per (ASIN, query) across the whole window. Counts are summed and
  // ratios are derived later; the best (lowest) organic rank is kept because an
  // average of ranks across weeks would be meaningless.
  const byKey = new Map();
  const periods = new Set();
  for (const row of sqpRows) {
    const asin = String(row.child_asin || "").trim();
    const query = String(row.search_query || "").trim();
    if (!asin || !query) continue;
    const period = String(row.date || "");
    if (period) periods.add(period);

    const key = `${asin}|${query}`;
    let entry = byKey.get(key);
    if (!entry) {
      entry = {
        asin,
        query,
        volume: 0,
        totalImpressions: 0,
        totalClicks: 0,
        totalCartAdds: 0,
        totalPurchases: 0,
        asinImpressions: 0,
        asinClicks: 0,
        asinCartAdds: 0,
        asinPurchases: 0,
        bestRank: null,
        medianClickPrice: null,
        medianClickPriceCurrency: null,
        periodCount: 0,
      };
      byKey.set(key, entry);
    }
    entry.periodCount += 1;
    // Query-level figures are the same for every seller in a period, so they are
    // summed across periods to make a window total.
    entry.volume += num(row.search_query_volume);
    entry.totalImpressions += num(row.search_query_total_impression_count);
    entry.totalClicks += num(row.search_query_total_click_count);
    entry.totalCartAdds += num(row.search_query_total_cart_add_count);
    entry.totalPurchases += num(row.search_query_total_purchase_count);
    entry.asinImpressions += num(row.child_asin_impression_count);
    entry.asinClicks += num(row.child_asin_click_count);
    entry.asinCartAdds += num(row.child_asin_add_to_cart_count);
    entry.asinPurchases += num(row.child_asin_purchase_count);

    const rank = num(row.child_asin_organic_search_rank);
    if (rank > 0) entry.bestRank = entry.bestRank === null ? rank : Math.min(entry.bestRank, rank);
    const price = num(row.child_asin_median_click_price_value);
    if (price > 0 && entry.medianClickPrice === null) {
      entry.medianClickPrice = price;
      entry.medianClickPriceCurrency = String(row.child_asin_median_click_price_currency || "").trim() || null;
    }
  }

  // Listing content for the ASINs that actually appear in SQP.
  const catalogRows = await fetchExportRowsStrict(
    apiKey, PRODUCT_CATALOG.id, CATALOG_CONTENT_COLUMNS, ids, null, null, ROW_LIMITS.catalog,
    { orderByColumn: "child_asin", orderByDirection: "ASC" },
    "Listing Optimizer catalog export"
  );

  const products = [];
  const brands = new Set();
  const seen = new Set();
  for (const row of catalogRows) {
    const asin = String(row.child_asin || "").trim();
    if (!asin || seen.has(asin)) continue;
    seen.add(asin);
    const brand = String(row.product_brand || "").trim();
    if (brand) brands.add(brand);
    const bullets = [1, 2, 3, 4, 5]
      .map((index) => String(row[`product_bullet_point_${index}`] || "").trim())
      .filter(Boolean);
    products.push({
      asin,
      name: String(row.product_name || "").trim() || null,
      brand: brandLabel(brand),
      category: String(row.product_root_category_name || "").trim() || null,
      bestSellerRank: num(row.product_root_best_selling_rank) || null,
      bullets,
      // Only a bounded slice is stored: the shared snapshot must stay compact,
      // and the checks only need presence, length and keyword coverage.
      description: String(row.product_description || "").trim().slice(0, 2000) || null,
      hasImage: Boolean(String(row.product_image_url || "").trim()),
    });
  }

  const sortedPeriods = [...periods].sort();
  return {
    accountId: ids[0],
    asOf: to,
    window: { from, to, days: LOOKBACK_DAYS },
    sqpAvailable: true,
    sqpSourceLabel: SQP_WEEKLY.label,
    contentSourceLabel: PRODUCT_CATALOG.label,
    periods: sortedPeriods,
    periodCount: sortedPeriods.length,
    queries: [...byKey.values()],
    products,
    catalogBrands: [...brands].sort((a, b) => a.localeCompare(b)),
  };
}
