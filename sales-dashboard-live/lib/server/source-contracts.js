// Canonical DataDoe source contracts.
//
// Reports may share a saved export only when the source, account scope, date
// window, requested fields, grouping and aggregations are identical. A source
// contract also documents which metrics a source can truthfully provide. This
// prevents future reports from using a convenient-but-wrong dataset (for
// example, Order Line Items cannot provide sessions or conversion).

const contract = ({ key, ids, label, grain, fields, consumers, cacheHours = 12 }) => ({
  key,
  ids,
  label,
  grain,
  fields: new Set(fields),
  consumers,
  cacheHours,
});

export const SOURCE_CONTRACTS = [
  contract({
    key: "order-line-items",
    ids: ["89b27535d27c2a94db5ae39af4717f542624ff4df7802fd633e16c78674a1778"],
    label: "Order Line Items",
    grain: "order-item",
    fields: ["date", "order_date", "amazon_order_id", "sku", "child_asin", "seller_or_vendor_id", "seller_or_vendor_name", "marketplace_country_code", "quantity", "item_price_value", "item_price_currency", "item_tax_value", "amazon_order_status", "fulfillment_channel", "order_is_business"],
    // Canonical sales/ordered-units source (item_price_value for sales, quantity for
    // ordered units). Daily Reporting, FBA Plan, Buy Box Loss, Returns Leakage and PPC
    // read sales/units here; Sales Movers keeps Sales & Traffic (it needs sessions/page views).
    consumers: ["dashboard", "reconciliation", "daily-reporting", "fba-plan", "buy-box-loss", "returns-leakage", "ppc-performance"],
  }),
  contract({
    key: "sales-traffic-asin-date",
    ids: ["401ffcd7e5", "401ffcd7e50c1ea9a18cacf221ddf99858db20a0f31eff65fc22a8e8140c7e1b"],
    label: "Sales & Traffic by ASIN & Date",
    grain: "asin-day",
    fields: ["date", "child_asin", "product_name", "total_sales", "total_units", "total_orders", "session", "page_views", "units_shipped", "units_refunded"],
    // Sales Movers is the only remaining consumer: it needs sessions/page views/total_orders,
    // which Order Line Items does not carry. Every sales/units consumer moved to order-line-items.
    consumers: ["sales-movers"],
  }),
  contract({
    key: "profit-by-sku-date",
    ids: ["57a0cb319c10a395853afc0671579bf7ef0ff45d8a40c88ed9d2a5f61b4169a4"],
    label: "Profit by SKU & Date",
    grain: "sku-day",
    fields: ["date", "sku", "child_asin", "currency", "total_sales", "total_units_sold", "profit", "total_cost", "total_fees", "cogs_total", "ad_spend", "ad_sales", "ad_clicks", "buybox_percentage", "page_views"],
    consumers: ["sku-pl", "sales-movers:ads", "listing-health", "buy-box-loss"],
  }),
  contract({
    key: "profit-by-date",
    ids: ["b24cd69c06"],
    label: "Profit by Date",
    grain: "account-day",
    fields: ["date", "currency", "total_sales", "total_units_sold", "profit", "total_cost"],
    consumers: ["legacy-sales"],
  }),
  contract({
    key: "settlements",
    ids: ["732dac689a6545697c2f2e36c61b2c9e93187053bcce2999914183c6f490df27"],
    label: "Settlements & P&L Components",
    grain: "settlement-component",
    fields: ["date", "amazon_order_id", "sku", "child_asin", "currency", "settlement_type", "quantity", "item_price", "item_tax", "referral_fee", "fba_per_unit_fulfillment_fee", "refunded_amount", "refund_tax", "refunded_referral_fee", "refund_commission", "refund_restocking_fee", "fba_customer_return_per_unit_fee", "cogs_total_value", "total"],
    consumers: ["reconciliation", "returns-leakage"],
  }),
  contract({
    // The live primary DataDoe short Export Source ID is first; the obsolete long id
    // (now DataDoe 404) is retained ONLY as a legacy alias so both resolve to this one
    // canonical contract key. request_hash is derived from the key, so switching the
    // live request to the short id leaves every cached export and identity unchanged.
    key: "product-catalog",
    ids: ["68d2de238e", "68d2de238e8d1a47bc56a981a99d54558507b0bafb1e09f1b3e95fb7750a17a8"],
    label: "Product Catalog by ASIN",
    grain: "asin-current",
    fields: ["child_asin", "parent_asin", "product_name", "product_brand", "sku", "product_root_category_name", "product_root_best_selling_rank", "product_description", "product_bullet_point_1", "product_bullet_point_2", "product_bullet_point_3", "product_bullet_point_4", "product_bullet_point_5", "product_image_url"],
    consumers: ["dashboard", "reconciliation", "fba-plan", "keyword-rank", "content-changes", "sales-movers", "listing-health", "buy-box-loss", "returns-leakage", "ppc-performance", "listing-optimizer", "brand-view"],
    cacheHours: 24,
  }),
  contract({
    key: "fba-inventory-health",
    ids: ["44fc5ba0ce81a7807601f6d7a9b8b7aaec64be4c7e046ea30dc6864d1a4aa823"],
    label: "FBA Inventory Health",
    grain: "sku-snapshot-day",
    fields: ["date", "marketplace_country_code", "sku", "fnsku", "child_asin", "product_name", "currency", "available", "reserved_fc_transfer", "reserved_fc_processing", "inbound_working", "inbound_shipped", "inbound_received", "unfulfillable_quantity", "days_of_supply", "units_shipped_t30", "your_price", "sales_price", "featuredoffer_price", "lowest_price_new_plus_shipping", "alert"],
    consumers: ["fba-plan", "sales-movers", "listing-health", "buy-box-loss", "brand-view"],
    cacheHours: 8,
  }),
  contract({
    key: "listings",
    ids: ["ba689c05d7f7cee1a1690990c28995680a0654b7ed258230f4173d61bbcd1ab3"],
    label: "Listings",
    grain: "sku-current",
    fields: ["sku", "fnsku", "child_asin", "listing_name", "listing_status", "listing_price_value", "listing_price_currency", "listing_current_quantity", "listing_pending_quantity", "fba_quantity_available", "fba_quantity_inbound", "fba_quantity_reserved", "listing_fulfillment_channel", "listing_open_date", "awd_available_distributable_quantity"],
    consumers: ["fba-plan:awd", "listing-health"],
    cacheHours: 12,
  }),
  contract({
    key: "listings-raw",
    ids: ["6ea445cdc459f9fbb9517c5c009384da60ef31a1e70d4de9187ea3d4c28535c4"],
    label: "Listings (Raw JSON)",
    grain: "sku-current",
    fields: ["sku", "child_asin", "summaries", "issues", "offers", "fulfillment_availability"],
    consumers: ["listing-health"],
    cacheHours: 12,
  }),
  contract({
    key: "returns",
    ids: ["27c6fc0ec69648b5fed4612dbd9ccdfdeaaca6787f8f985c01266e4dc11f9038"],
    label: "Returns (FBA & FBM)",
    grain: "returned-item",
    fields: ["date", "amazon_order_id", "sku", "child_asin", "amazon_return_reason", "amazon_fulfillment_channel", "amazon_return_request_status", "amazon_return_refunded_amount", "amazon_return_label_cost", "amazon_return_label_to_be_paid_by"],
    consumers: ["returns-leakage"],
  }),
  contract({
    key: "content-changes",
    ids: ["aec3d5976911a7a80110c08801a741e4f0a25dd997d639f5d918284d905a4758"],
    label: "Content Change Alerts",
    grain: "listing-event",
    fields: ["event_time", "sp_api_notification_id", "sp_api_notification_type", "notification_metadata", "payload"],
    consumers: ["content-changes"],
  }),
  contract({
    key: "ads-campaign-date",
    ids: ["08cdc77d3d", "08cdc77d3dc24a7651553e2e926f598188c66172f64cd6512265900af6073a6c"],
    label: "Ad Performance by Campaign & Date",
    grain: "campaign-day",
    fields: ["date", "ad_campaign_id", "ad_campaign_type", "ad_campaign_budget_currency", "ad_sales", "ad_spend", "ad_clicks", "ad_impressions", "ad_orders", "ad_units_sold"],
    consumers: ["daily-reporting", "ppc-performance", "brand-view"],
    cacheHours: 6,
  }),
  contract({
    key: "ads-asin-date",
    ids: ["d0017e92fb089c2c8c3fe65f81d08666ecb4fe937ffbce9969ce2fc7d28c805c"],
    label: "Ad Performance by ASIN & Date",
    grain: "asin-campaign-ad-day",
    fields: ["date", "child_asin", "sku", "ad_campaign_id", "ad_group_id", "ad_id", "ad_campaign_type", "ad_campaign_budget_currency", "ad_sales_same_sku", "ad_spend", "ad_clicks", "ad_impressions", "ad_orders_same_sku", "ad_units_sold_same_sku"],
    consumers: ["ppc-performance", "brand-view"],
    cacheHours: 6,
  }),
  contract({
    key: "ads-targeting-date",
    ids: ["bbba3d213ac78ccbaf22cfa68eecb3f475641f49da26d51d1ac36446310051e3"],
    label: "Keyword Targeting Performance",
    grain: "target-campaign-ad-group-day",
    fields: ["date", "ad_targeting_text", "ad_targeting_id", "ad_keyword_id", "ad_keyword", "ad_campaign_id", "ad_group_id", "ad_campaign_type", "ad_campaign_budget_currency", "ad_sales", "ad_spend", "ad_clicks", "ad_impressions", "ad_orders"],
    consumers: ["ppc-performance"],
    cacheHours: 6,
  }),
  contract({
    key: "ads-search-terms-date",
    ids: ["e94e9671989ce4aa2814ac729807c7ddcc1cc47a71ebcd75d9fe661ed80335be"],
    label: "Search Term Performance (Ads)",
    grain: "search-term-campaign-day",
    fields: ["date", "ad_search_term", "ad_targeting_text", "ad_keyword_id", "ad_campaign_id", "ad_group_id", "ad_campaign_type", "ad_campaign_budget_currency", "ad_sales", "ad_spend", "ad_clicks", "ad_impressions", "ad_orders"],
    consumers: ["ppc-performance"],
    cacheHours: 6,
  }),
  contract({
    key: "sqp-weekly",
    ids: ["81aa5b4cc248bb70de405b9ff9d51290b9232f84570d76ba2a1289b67b6595fb"],
    label: "Search Query Performance by ASIN (Weekly)",
    grain: "asin-query-week",
    fields: ["date", "child_asin", "search_query", "search_query_volume", "search_query_total_impression_count", "search_query_total_click_count", "search_query_total_cart_add_count", "search_query_total_purchase_count", "child_asin_impression_count", "child_asin_click_count", "child_asin_add_to_cart_count", "child_asin_purchase_count", "child_asin_organic_search_rank", "child_asin_median_click_price_value", "child_asin_median_click_price_currency"],
    consumers: ["keyword-rank", "listing-optimizer"],
  }),
  contract({
    key: "sqp-monthly",
    ids: ["df4160ff8e1add239172a69ebd6c8abfec7116ee4a17720983757b1b55599830"],
    label: "Search Query Performance by ASIN (Monthly)",
    grain: "asin-query-month",
    fields: ["date", "child_asin", "search_query", "search_query_volume", "search_query_total_impression_count", "search_query_total_click_count", "search_query_total_purchase_count", "child_asin_impression_count", "child_asin_click_count", "child_asin_purchase_count", "child_asin_organic_search_rank"],
    consumers: ["keyword-rank"],
  }),
];

// Every current report declares its canonical source dependencies here. A new
// report must add an entry before it is scheduled. Snapshot-only reports name
// the upstream report/source they read instead of inventing another export.
export const REPORT_SOURCE_REQUIREMENTS = Object.freeze({
  "brand-sales": ["order-line-items", "product-catalog"],
  "daily-reporting": ["order-line-items", "product-catalog", "ads-campaign-date"],
  reconciliation: ["order-line-items", "settlements", "product-catalog"],
  "fba-plan": ["order-line-items", "product-catalog", "fba-inventory-health", "listings"],
  "sku-pl": ["profit-by-sku-date"],
  "keyword-rank": ["sqp-weekly", "sqp-monthly", "product-catalog"],
  "content-changes": ["content-changes", "product-catalog"],
  "sales-movers": ["sales-traffic-asin-date", "profit-by-sku-date", "fba-inventory-health", "product-catalog"],
  "listing-health": ["listings", "listings-raw", "profit-by-sku-date", "fba-inventory-health", "product-catalog"],
  "buy-box-loss": ["order-line-items", "profit-by-sku-date", "fba-inventory-health", "product-catalog"],
  "returns-leakage": ["returns", "settlements", "order-line-items", "product-catalog"],
  "ppc-performance": ["ads-campaign-date", "ads-asin-date", "ads-targeting-date", "ads-search-terms-date", "order-line-items", "product-catalog"],
  "listing-optimizer": ["sqp-weekly", "product-catalog"],
  "brand-view": ["brand-sales", "ads-asin-date", "fba-plan"],
  "priority-feed": ["sales-movers", "listing-health", "buy-box-loss", "returns-leakage", "ppc-performance", "listing-optimizer"],
});

const CONTRACT_BY_ID = new Map();
const CONTRACT_BY_KEY = new Map();
for (const item of SOURCE_CONTRACTS) {
  CONTRACT_BY_KEY.set(item.key, item);
  for (const id of item.ids) CONTRACT_BY_ID.set(id, item);
}

export function sourceContractForId(sourceId) {
  return CONTRACT_BY_ID.get(String(sourceId || "")) || null;
}

export function sourceContractForKey(sourceKey) {
  return CONTRACT_BY_KEY.get(String(sourceKey || "")) || null;
}

export function sourceSupports(sourceKey, { grain, fields = [] } = {}) {
  const item = sourceContractForKey(sourceKey);
  if (!item) return false;
  if (grain && item.grain !== grain) return false;
  return fields.every((field) => item.fields.has(field));
}

export function assertSourceSupports(sourceKey, requirement) {
  if (!sourceSupports(sourceKey, requirement)) {
    const fields = (requirement?.fields || []).join(", ") || "none";
    throw new Error(`Source ${sourceKey} cannot satisfy grain=${requirement?.grain || "any"}, fields=${fields}. Add or select a compatible canonical source.`);
  }
  return true;
}

export function cacheHoursForSource(sourceId) {
  return sourceContractForId(sourceId)?.cacheHours || 12;
}

export function sourceRequirementsForReport(reportKey) {
  return REPORT_SOURCE_REQUIREMENTS[String(reportKey || "")] || null;
}
