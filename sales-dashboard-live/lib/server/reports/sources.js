// DataDoe sources used by the six insight reports.
//
// Every id, column name, grain, default-enablement flag and fetch window below
// was validated on 2026-07-29 against the public data scheme at
// https://api.datadoe.com/api/v1/spec/data-scheme (unauthenticated). Do not
// change an id or a column name without re-checking that document: DataDoe
// rejects unknown columns, and a silently wrong column returns nulls that would
// look like real zeroes.
//
// `defaultDataset: false` tables are NOT enabled for every organisation. Each
// report wraps those exports and turns DataDoe's "source is disabled" 400 into
// an actionable Settings > Data tables message instead of a server error.

/* ---------- Sales, traffic and profit ---------- */

// Sales & Traffic by ASIN & Date. defaultDataset. Grain: child ASIN per day.
// fetchPeriods: INITIAL 35 days, RECURRING_DAILY 4, RECURRING_MONTHLY 30 (+4
// shift). The 4-day recurring window is the documented basis for the "can lag
// up to about four days" caveat every report using it must display.
export const SALES_TRAFFIC = {
  id: "401ffcd7e50c1ea9a18cacf221ddf99858db20a0f31eff65fc22a8e8140c7e1b",
  table: "amazon_sales_and_traffic_with_cogs",
  label: "Sales & Traffic by ASIN & Date",
  lagDays: 4,
  // No currency column on this source; currency comes from the account.
};

// Profit by SKU & Date. defaultDataset, premium, CONTINUOUS history, intraday
// refresh. Grain: marketplace + connection + child ASIN + SKU + date.
// This is the only source that carries buybox_percentage together with sales,
// page views, ad spend, ad sales and an explicit `currency` column.
export const PROFIT_BY_SKU = {
  id: "57a0cb319c10a395853afc0671579bf7ef0ff45d8a40c88ed9d2a5f61b4169a4",
  table: "amazon_profit_by_sku_and_date",
  label: "Profit by SKU & Date",
};

// Order Line Items. defaultDataset. INITIAL 730 days, RECURRING_DAILY 28.
// Near-real-time ordered sales including pending orders; can be delayed about
// an hour. Used for recent operational order status, not settled profit.
export const ORDER_LINE_ITEMS = {
  id: "89b27535d27c2a94db5ae39af4717f542624ff4df7802fd633e16c78674a1778",
  table: "amazon_order_items_with_cogs",
  label: "Order Line Items",
};

// Settlements & P&L Components. defaultDataset. INITIAL 730 days,
// RECURRING_DAILY 21. `settlement_type` is ORDER / REFUND / OTHER, and REFUND
// rows carry the real refunded money for BOTH FBA and FBM returns — the
// amazon_returns table only exposes a refunded amount for FBM.
export const SETTLEMENTS = {
  id: "732dac689a6545697c2f2e36c61b2c9e93187053bcce2999914183c6f490df27",
  table: "amazon_settlements_with_cogs",
  label: "Settlements & P&L Components",
};

/* ---------- Catalog, listings and inventory ---------- */

// Product Catalog by ASIN. defaultDataset, CONTINUOUS, no date column.
// Also carries the five bullet points, description, image URL and BSR used by
// the Listing & Search Optimizer content checks.
//
// Uses the live primary DataDoe SHORT Export Source ID "68d2de238e"; the former long
// id is obsolete (DataDoe 404) and survives only as a legacy alias in
// source-contracts.js so request_hash identity and cached exports stay stable.
export const PRODUCT_CATALOG = {
  id: "68d2de238e",
  table: "amazon_products_by_child_asin",
  label: "Product Catalog by ASIN",
};

// Listings. defaultDataset, premium, CONTINUOUS, NO date column, so exports
// must omit from/to and order by child_asin. `listing_status` is the documented
// enum Active / Inactive / Incomplete and `listing_fulfillment_channel` is
// DEFAULT (= FBM) / AMAZON_NA / AMAZON_EU / null.
export const LISTINGS = {
  id: "ba689c05d7f7cee1a1690990c28995680a0654b7ed258230f4173d61bbcd1ab3",
  table: "amazon_listings_with_cogs",
  label: "Listings",
};

// Listings (Raw JSON). NOT defaultDataset — must be enabled in DataDoe
// Settings > Data tables. CONTINUOUS, no date range. `issues` carries Amazon's
// own severity / code / message, which is the only true source of suppression
// and error states. Listing Health degrades gracefully without it.
export const LISTINGS_RAW = {
  id: "6ea445cdc459f9fbb9517c5c009384da60ef31a1e70d4de9187ea3d4c28535c4",
  table: "amazon_listings_raw",
  label: "Listings (Raw JSON)",
  defaultDataset: false,
  enableHint: "In DataDoe, open Settings > Data tables and enable Listings (Raw JSON) to add Amazon's own listing issue codes, severities and suppression flags to this report.",
};

// FBA Inventory Health. defaultDataset, premium. INITIAL 1 day and
// RECURRING_DAILY 1 day, so only a recent snapshot exists; keep the latest
// snapshot date only. Carries the competitive prices used for Buy Box cause
// attribution: your_price, sales_price, featuredoffer_price and
// lowest_price_new_plus_shipping, plus `available` and `currency`.
export const FBA_INVENTORY_HEALTH = {
  id: "44fc5ba0ce81a7807601f6d7a9b8b7aaec64be4c7e046ea30dc6864d1a4aa823",
  table: "amazon_fba_inventory_health",
  label: "FBA Inventory Health",
  snapshotLookbackDays: 10,
};

// Returns (FBA & FBM). defaultDataset. INITIAL 60 days and RECURRING_DAILY 60,
// so roughly 60 days of return history is the documented availability. One row
// per returned item; there is NO quantity column and NO currency column, and
// amazon_return_refunded_amount / amazon_return_label_cost are FBM-only.
export const RETURNS = {
  id: "27c6fc0ec69648b5fed4612dbd9ccdfdeaaca6787f8f985c01266e4dc11f9038",
  table: "amazon_returns",
  label: "Returns (FBA & FBM)",
  historyDays: 60,
};

/* ---------- Advertising ---------- */

// Ad Performance by Campaign & Date. defaultDataset. 56 initial / 21 daily /
// 49 monthly. Already persisted by the scheduled worker as campaign-performance-v1.
export const ADS_CAMPAIGN = {
  id: "08cdc77d3dc24a7651553e2e926f598188c66172f64cd6512265900af6073a6c",
  table: "amazon_ads_performance_by_campaign_by_date",
  label: "Ad Performance by Campaign & Date",
  syncKey: "campaign-performance-v1",
};

// Ad Performance by ASIN & Date. defaultDataset. 60 / 21 / 49. Persisted as
// asin-performance-v1. Metrics are same-SKU attributed: ad_sales_same_sku,
// ad_orders_same_sku, ad_units_sold_same_sku.
export const ADS_ASIN = {
  id: "d0017e92fb089c2c8c3fe65f81d08666ecb4fe937ffbce9969ce2fc7d28c805c",
  table: "amazon_ads_performance_by_child_asin_and_date",
  label: "Ad Performance by ASIN & Date",
  syncKey: "asin-performance-v1",
};

// Keyword Targeting Performance. NOT defaultDataset. 56 / 21 / 49. Persisted as
// keyword-targeting-performance-v1. Its DataDoe dependencies are the Sponsored
// Products, legacy Sponsored Brands and Sponsored Display targeting reports, so
// this source is SP + SB + SD. Keep ad_campaign_type on every row.
export const ADS_TARGETING = {
  id: "bbba3d213ac78ccbaf22cfa68eecb3f475641f49da26d51d1ac36446310051e3",
  table: "amazon_ads_targeting_by_campaign_by_date",
  label: "Keyword Targeting Performance",
  syncKey: "keyword-targeting-performance-v1",
  defaultDataset: false,
  coverage: "SP + SB + SD",
  enableHint: "In DataDoe, open Settings > Data tables and enable Keyword Targeting Performance, then refresh this report again.",
};

// Search Term Performance (Ads). NOT defaultDataset. 60 / 21 / 49. Its
// documented ad_campaign_type values are SPONSORED_BRANDS or
// SPONSORED_PRODUCTS and its dependencies are only the SB/SP search-term
// reports, so this source is SP + SB and MUST NOT be labelled as covering
// Sponsored Display.
export const ADS_SEARCH_TERMS = {
  id: "e94e9671989ce4aa2814ac729807c7ddcc1cc47a71ebcd75d9fe661ed80335be",
  table: "amazon_ads_search_terms_by_campaign_by_date",
  label: "Search Term Performance (Ads)",
  syncKey: "search-terms-performance-v1",
  defaultDataset: false,
  coverage: "SP + SB only (no Sponsored Display)",
  enableHint: "In DataDoe, open Settings > Data tables and enable Search Term Performance (Ads), then refresh this report again.",
};

/* ---------- Search query performance ---------- */

// Search Query Performance (SQP) by ASIN, weekly. NOT defaultDataset.
// INITIAL 21 days, RECURRING_WEEKLY 7 (+7 shift), so a new connection starts
// with very little history and accumulates one period per week.
export const SQP_WEEKLY = {
  id: "81aa5b4cc248bb70de405b9ff9d51290b9232f84570d76ba2a1289b67b6595fb",
  table: "amazon_child_product_organic_search_ranks_per_week",
  label: "Search Query Performance (SQP) by ASIN (Weekly)",
  defaultDataset: false,
  enableHint: "In DataDoe, open Settings > Data tables and enable Search Query Performance (SQP) by ASIN (Weekly), then refresh this report again.",
};

/* ---------- Shared export limits ---------- */

// Aggregated exports stay far below these; raw-grain exports are split into
// windows and rejected at the cap rather than silently truncated.
export const ROW_LIMITS = {
  aggregated: 50000,
  rawGrain: 50000,
  catalog: 20000,
  listings: 20000,
  inventory: 15000,
  dateRollup: 500,
};
