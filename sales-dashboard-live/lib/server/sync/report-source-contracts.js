// Per-report canonical DataDoe request contracts (Scheduler v2, Phase 1b).
//
// Each entry is the EXACT input a report's api/datadoe.js builder passes to a
// create-export: a stable requestKey, the source, columns, row limit, groupBy,
// aggregations, ordering, and how the date window is derived (windowKind). The
// scheduler turns these into request_hashes with the shared sourceRequestIdentity,
// so a scheduled fetch reuses the very export a browser-triggered report would — and
// the source cache stays valid. The column/groupBy/aggregation/limit values are
// transcribed VERBATIM from the executable constants in api/datadoe.js and are
// asserted equal to them in scripts/report-source-contracts.test.mjs.
//
// Batching: the live transport (lib/server/datadoe.js fetchExportRows) splits the
// account scope into groups of MAX_SELLER_OR_VENDOR_IDS_PER_EXPORT (5) in the given
// order and creates one export per chunk. The resolver below shares that exact
// chunking via lib/server/id-batching.js, so it emits one concrete source request
// per real ID chunk with an identical request_hash. Windows are resolved PER
// requestKey — never as one shared list applied to every source — so a monthly
// source and a no-date source can never receive each other's dates.
//
// SCOPE (2026-08-06): every current sidebar report is declared here or is registered
// derived-only (REPORT_DERIVED_ONLY). Daily Reporting covers its all-brand path plus
// every named brand via the ASIN/day superset derivation (REPORT_DERIVATION); Keyword
// Rank, Content Changes, and all six insight reports (Sales Movers, Buy Box, Returns,
// Listing Health, PPC, Listing Optimizer) are declared and parity-tested. A
// dependency-map test proves no sidebar report is left unaudited. Staged/gated jobs
// (Sales Movers probe → downstream, Listing Optimizer SQP → catalog, PPC total-sales
// currency gate) and per-source failure policies are typed execution metadata that
// never enters sourceRequestIdentity, so request_hash is unaffected.

import { sourceRequestIdentity } from "../source-identity.js";
import { sourceContractForKey } from "../source-contracts.js";
import { chunkAccountIds } from "../id-batching.js";
import { addDaysStr } from "../datadoe.js";

/* ---- constants transcribed verbatim from api/datadoe.js (parity-tested) ---- */

// brand-sales: buildBrandSalesPayload — Order Line Items + Product Catalog, both
// over the same {from,to} window (monthStart(asOf) - 420 days .. asOf).
const ORDER_SALES_COLUMNS = ["date", "seller_or_vendor_id", "seller_or_vendor_name", "marketplace_country_code", "item_price_currency", "child_asin"];
const ORDER_SALES_GROUP_BY = [...ORDER_SALES_COLUMNS];
const ORDER_SALES_AGGREGATIONS = [
  { column: "item_price_value", aggregation: "sum", alias: "total_sales_sum" },
  { column: "quantity", aggregation: "sum", alias: "total_units_sold_sum" },
];
const PRODUCT_CATALOG_COLUMNS = ["child_asin", "parent_asin", "product_name", "product_brand"];

// sku-pl: fetchSkuPlRows — Profit by SKU & Date, one request per completed/current
// month over {from,to} = each month in monthStart(asOf) - 180 .. asOf.
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

// reconciliation: reconciliationRowsByMonth (per month) + a single-range catalog.
const RECON_ORDER_COLUMNS = ["date", "order_date", "amazon_order_id", "child_asin", "amazon_order_status", "fulfillment_channel", "order_is_business", "item_price_currency"];
const RECON_ORDER_GROUP_BY = [...RECON_ORDER_COLUMNS];
const RECON_ORDER_AGGREGATIONS = [
  { column: "quantity", aggregation: "sum", alias: "quantity_sum" },
  { column: "item_price_value", aggregation: "sum", alias: "item_price_sum" },
  { column: "item_tax_value", aggregation: "sum", alias: "item_tax_sum" },
];
const RECON_SETTLEMENT_COLUMNS = ["date", "amazon_order_id", "settlement_type", "currency"];
const RECON_SETTLEMENT_GROUP_BY = [...RECON_SETTLEMENT_COLUMNS];
const RECON_SETTLEMENT_AGGREGATIONS = [
  { column: "item_price", aggregation: "sum", alias: "item_price_sum" },
  { column: "item_tax", aggregation: "sum", alias: "item_tax_sum" },
  { column: "referral_fee", aggregation: "sum", alias: "referral_fee_sum" },
  { column: "fba_per_unit_fulfillment_fee", aggregation: "sum", alias: "fba_fee_sum" },
  { column: "refunded_amount", aggregation: "sum", alias: "refunded_amount_sum" },
  { column: "total", aggregation: "sum", alias: "total_sum" },
];

// daily-reporting: the scheduler fetches the ASIN/day Sales & Traffic SUPERSET
// (api/datadoe.js fetchDailyBrandSalesRows: monthly-segmented, child_asin grain) once
// per account plus Product Catalog once, and DERIVES both the all-brand total (sum
// sales/units per date over child_asin) and every named brand (join ASIN->brand via
// catalog) from those saved rows. There is NO per-brand export and NO separate compact
// all-brand export: the browser's compact all-brand export groups the SAME source
// (401ffcd7e5) by [date, seller_or_vendor_id] with the SAME aggregations, so it is a
// strict roll-up of this superset (grouped by [date, seller_or_vendor_id, child_asin]).
// Ads are derived from the scheduled Ads sources (ads_daily_source_rows). See
// REPORT_DERIVATION below. (LIVE GATE: reconcile superset-summed all-brand vs the
// compact total once before permanently retiring the compact export.)
const DAILY_BRAND_SALES_COLUMNS = ["date", "seller_or_vendor_id", "child_asin"];
const DAILY_BRAND_SALES_GROUP_BY = [...DAILY_BRAND_SALES_COLUMNS];
const DAILY_SALES_AGGREGATIONS = [
  { column: "total_sales", aggregation: "sum", alias: "total_sales_sum" },
  { column: "total_units", aggregation: "sum", alias: "total_units_sum" },
];

// keyword-rank: fetchSqpRows (raw SQP rows, strict truncation) + a 365-day catalog.
const SQP_COLUMNS = ["date", "child_asin", "search_query", "search_query_volume", "search_query_total_impression_count", "search_query_total_click_count", "search_query_total_purchase_count", "child_asin_impression_count", "child_asin_click_count", "child_asin_purchase_count", "child_asin_organic_search_rank"];

// content-changes: a no-date notification export (event_time DESC) + a 365-day catalog.
const CONTENT_CHANGE_COLUMNS = ["event_time", "sp_api_notification_id", "sp_api_notification_type", "notification_metadata", "payload"];

// fba-plan: planAsinUnits (monthly, child_asin) + a current-month daily-date probe +
// catalog + FBA Inventory Health + US-only AWD listings.
const PLAN_UNITS_COLUMNS = ["child_asin"];
const PLAN_UNITS_GROUP_BY = ["child_asin"];
const PLAN_UNITS_AGGREGATIONS = [{ column: "total_units", aggregation: "sum", alias: "units_sum" }];
const PLAN_DAILY_COLUMNS = ["date"];
const PLAN_DAILY_GROUP_BY = ["date"];
const PLAN_DAILY_AGGREGATIONS = [{ column: "total_units", aggregation: "sum", alias: "units_sum" }];
const FBA_HEALTH_COLUMNS = ["date", "marketplace_country_code", "child_asin", "sku", "fnsku", "product_name", "available", "reserved_fc_transfer", "reserved_fc_processing", "inbound_working", "inbound_shipped", "inbound_received"];
const LISTINGS_AWD_COLUMNS = ["child_asin", "sku", "fnsku", "awd_available_distributable_quantity"];

/* ---- insight-report constants (transcribed verbatim from lib/server/reports/*.js;
   parity-tested against the builder files). All insight DataDoe fetches use
   fetchExportRowsStrict (rejects rows.length >= limit) EXCEPT the Sales Movers
   latest-date probe. ROW_LIMITS (sources.js): aggregated/rawGrain 50000, catalog/
   listings 20000, inventory 15000, dateRollup 500. ---- */

// common.js — identical across the reports that call fetchCatalog / fetchInventorySnapshot,
// so those requests dedupe to one export per account (see REPORT_DERIVATION dedup groups).
const INSIGHT_CATALOG_COLUMNS = ["child_asin", "parent_asin", "product_name", "product_brand"];
const INSIGHT_INVENTORY_COLUMNS = ["date", "sku", "child_asin", "product_name", "currency", "available", "unfulfillable_quantity", "inbound_shipped", "inbound_received", "days_of_supply", "units_shipped_t30", "your_price", "sales_price", "featuredoffer_price", "lowest_price_new_plus_shipping", "alert"];

// sales-movers.js
const SM_LATEST_COLUMNS = ["date"];
const SM_LATEST_AGGREGATIONS = [{ column: "total_units", aggregation: "sum", alias: "units_sum" }];
const SM_TRAFFIC_COLUMNS = ["child_asin", "product_name"];
const SM_TRAFFIC_AGGREGATIONS = [
  { column: "total_sales", aggregation: "sum", alias: "sales_sum" },
  { column: "total_units", aggregation: "sum", alias: "units_sum" },
  { column: "total_orders", aggregation: "sum", alias: "orders_sum" },
  { column: "session", aggregation: "sum", alias: "sessions_sum" },
  { column: "page_views", aggregation: "sum", alias: "page_views_sum" },
  { column: "units_shipped", aggregation: "sum", alias: "units_shipped_sum" },
  { column: "units_refunded", aggregation: "sum", alias: "units_refunded_sum" },
];
const SM_ADS_COLUMNS = ["child_asin", "currency"];
const SM_ADS_AGGREGATIONS = [
  { column: "ad_spend", aggregation: "sum", alias: "ad_spend_sum" },
  { column: "ad_sales", aggregation: "sum", alias: "ad_sales_sum" },
  { column: "ad_clicks", aggregation: "sum", alias: "ad_clicks_sum" },
];

// buy-box.js
const BB_DAILY_COLUMNS = ["date", "sku", "child_asin", "product_name", "product_brand", "currency", "buybox_percentage", "total_sales", "total_units_sold", "page_views"];

// returns.js
const RET_RETURN_COLUMNS = ["date", "sku", "child_asin", "amazon_order_id", "amazon_return_reason", "amazon_fulfillment_channel", "amazon_return_request_status", "amazon_return_refunded_amount", "amazon_return_label_cost", "amazon_return_label_to_be_paid_by"];
const RET_SETTLEMENT_COLUMNS = ["sku", "child_asin", "settlement_type", "currency"];
const RET_SETTLEMENT_AGGREGATIONS = [
  { column: "quantity", aggregation: "sum", alias: "quantity_sum" },
  { column: "item_price", aggregation: "sum", alias: "item_price_sum" },
  { column: "refunded_amount", aggregation: "sum", alias: "refunded_amount_sum" },
  { column: "refund_tax", aggregation: "sum", alias: "refund_tax_sum" },
  { column: "refunded_referral_fee", aggregation: "sum", alias: "refunded_referral_fee_sum" },
  { column: "refund_commission", aggregation: "sum", alias: "refund_commission_sum" },
  { column: "refund_restocking_fee", aggregation: "sum", alias: "refund_restocking_fee_sum" },
  { column: "fba_customer_return_per_unit_fee", aggregation: "sum", alias: "return_unit_fee_sum" },
  { column: "cogs_total_value", aggregation: "sum", alias: "cogs_sum" },
];
const RET_TRAFFIC_COLUMNS = ["child_asin", "product_name"];
const RET_TRAFFIC_AGGREGATIONS = [
  { column: "total_sales", aggregation: "sum", alias: "sales_sum" },
  { column: "total_units", aggregation: "sum", alias: "units_sum" },
  { column: "units_shipped", aggregation: "sum", alias: "units_shipped_sum" },
  { column: "units_refunded", aggregation: "sum", alias: "units_refunded_sum" },
];

// listing-health.js
const LH_LISTING_COLUMNS = ["sku", "child_asin", "listing_name", "listing_status", "listing_price_value", "listing_price_currency", "listing_current_quantity", "listing_pending_quantity", "fba_quantity_available", "fba_quantity_inbound", "fba_quantity_reserved", "listing_fulfillment_channel", "listing_open_date"];
const LH_LISTING_RAW_COLUMNS = ["child_asin", "sku", "summaries", "issues", "offers", "fulfillment_availability"];
const LH_SALES_COLUMNS = ["sku", "child_asin", "currency"];
const LH_SALES_AGGREGATIONS = [
  { column: "total_sales", aggregation: "sum", alias: "sales_sum" },
  { column: "total_units_sold", aggregation: "sum", alias: "units_sum" },
  { column: "profit", aggregation: "sum", alias: "profit_sum" },
];

// ppc.js — the ONE DataDoe export PPC makes (TACoS denominator); ads are derived.
const PPC_TOTAL_SALES_COLUMNS = ["date"];
const PPC_TOTAL_SALES_AGGREGATIONS = [
  { column: "total_sales", aggregation: "sum", alias: "sales_sum" },
  { column: "total_units", aggregation: "sum", alias: "units_sum" },
];

// listing-optimizer.js — richer SQP + a richer content catalog; deliberately NOT
// deduplicated with Keyword Rank's SQP or the common insight catalog (columns differ).
const OPT_SQP_COLUMNS = ["date", "child_asin", "search_query", "search_query_volume", "search_query_total_impression_count", "search_query_total_click_count", "search_query_total_cart_add_count", "search_query_total_purchase_count", "child_asin_impression_count", "child_asin_click_count", "child_asin_add_to_cart_count", "child_asin_purchase_count", "child_asin_organic_search_rank", "child_asin_median_click_price_value", "child_asin_median_click_price_currency"];
const OPT_CATALOG_COLUMNS = ["child_asin", "parent_asin", "product_name", "product_brand", "product_root_category_name", "product_root_best_selling_rank", "product_bullet_point_1", "product_bullet_point_2", "product_bullet_point_3", "product_bullet_point_4", "product_bullet_point_5", "product_description", "product_image_url"];

export const REPORT_SOURCE_CONTRACTS = Object.freeze({
  "brand-sales": [
    {
      requestKey: "brand-sales:order-lines",
      sourceKey: "order-line-items",
      columns: ORDER_SALES_COLUMNS,
      limit: 50000, // ORDER_SALES_ROW_LIMIT
      groupBy: ORDER_SALES_GROUP_BY,
      aggregations: ORDER_SALES_AGGREGATIONS,
      orderByColumn: "date",
      orderByDirection: "ASC",
      windowKind: "range:monthStart(asOf)-420..asOf",
    },
    {
      requestKey: "brand-sales:catalog",
      sourceKey: "product-catalog",
      columns: PRODUCT_CATALOG_COLUMNS,
      limit: 10000, // CATALOG_ROW_LIMIT
      groupBy: null,
      aggregations: null,
      orderByColumn: "child_asin",
      orderByDirection: "ASC",
      // buildBrandSalesPayload passes the same {from,to} to the catalog call.
      windowKind: "range:monthStart(asOf)-420..asOf",
    },
  ],
  "sku-pl": [
    {
      requestKey: "sku-pl:monthly-profit",
      strict: true,
      sourceKey: "profit-by-sku-date",
      columns: SKU_PL_COLUMNS,
      limit: 50000, // SKU_PL_ROW_LIMIT
      groupBy: SKU_PL_GROUP_BY,
      aggregations: SKU_PL_AGGREGATIONS,
      orderByColumn: "sku",
      orderByDirection: "ASC",
      windowKind: "per-month:monthStart(asOf)-180..asOf",
    },
  ],
  // Reconciliation (single account): orders + settlements per calendar month, plus a
  // single-range catalog over the full 6-month span. api/datadoe.js:
  // reconciliationRowsByMonth (date/ASC, 50000) + fetchExportRows catalog.
  reconciliation: [
    {
      requestKey: "reconciliation:order-lines",
      strict: true,
      sourceKey: "order-line-items",
      columns: RECON_ORDER_COLUMNS,
      limit: 50000, // RECONCILIATION_ROW_LIMIT
      groupBy: RECON_ORDER_GROUP_BY,
      aggregations: RECON_ORDER_AGGREGATIONS,
      orderByColumn: "date",
      orderByDirection: "ASC",
      windowKind: "per-month:6 complete calendar months",
    },
    {
      requestKey: "reconciliation:settlements",
      strict: true,
      sourceKey: "settlements",
      columns: RECON_SETTLEMENT_COLUMNS,
      limit: 50000, // RECONCILIATION_ROW_LIMIT
      groupBy: RECON_SETTLEMENT_GROUP_BY,
      aggregations: RECON_SETTLEMENT_AGGREGATIONS,
      orderByColumn: "date",
      orderByDirection: "ASC",
      windowKind: "per-month:6 complete calendar months",
    },
    {
      requestKey: "reconciliation:catalog",
      sourceKey: "product-catalog",
      columns: PRODUCT_CATALOG_COLUMNS,
      limit: 10000, // CATALOG_ROW_LIMIT
      groupBy: null,
      aggregations: null,
      orderByColumn: "child_asin",
      orderByDirection: "ASC",
      windowKind: "range:from..to (full 6-month span)",
    },
  ],
  // Daily Reporting (single account). Scheduler-owned strategy: ONE monthly-segmented
  // ASIN/day superset + ONE catalog; all-brand and every named brand DERIVE from the
  // saved rows. No per-brand export, no compact all-brand export (see DAILY note above
  // + REPORT_DERIVATION). Ads derived from the scheduled Ads sources.
  "daily-reporting": [
    {
      requestKey: "daily-reporting:asin-day-superset",
      strict: true,
      sourceKey: "sales-traffic-asin-date",
      columns: DAILY_BRAND_SALES_COLUMNS,
      limit: 50000, // DAILY_BRAND_ROW_LIMIT (strict: per-month cap => terminal, no partial save)
      groupBy: DAILY_BRAND_SALES_GROUP_BY,
      aggregations: DAILY_SALES_AGGREGATIONS,
      orderByColumn: "date",
      orderByDirection: "ASC",
      windowKind: "per-month:monthStart(asOf)-150..asOf",
    },
    {
      requestKey: "daily-reporting:catalog",
      sourceKey: "product-catalog",
      columns: PRODUCT_CATALOG_COLUMNS,
      limit: 10000, // CATALOG_ROW_LIMIT
      groupBy: null,
      aggregations: null,
      orderByColumn: "child_asin",
      orderByDirection: "ASC",
      windowKind: "range:monthStart(asOf)-150..asOf",
    },
  ],
  // FBA Shipment Plan (single account). Two Sales & Traffic exports with DIFFERENT
  // columns (child_asin units vs date units) => distinct request identities, never
  // shared. Catalog + Inventory Health ranges, and a US-only no-date AWD listing.
  "fba-plan": [
    {
      requestKey: "fba-plan:monthly-units",
      sourceKey: "sales-traffic-asin-date",
      columns: PLAN_UNITS_COLUMNS,
      limit: 30000, // PLAN_SALES_ROW_LIMIT
      groupBy: PLAN_UNITS_GROUP_BY,
      aggregations: PLAN_UNITS_AGGREGATIONS,
      orderByColumn: "child_asin",
      orderByDirection: "ASC",
      windowKind: "per-month:3 completed months + current MTD",
    },
    {
      requestKey: "fba-plan:current-daily-dates",
      sourceKey: "sales-traffic-asin-date",
      columns: PLAN_DAILY_COLUMNS,
      limit: 500,
      groupBy: PLAN_DAILY_GROUP_BY,
      aggregations: PLAN_DAILY_AGGREGATIONS,
      orderByColumn: "date",
      orderByDirection: "ASC",
      windowKind: "range:current month (first..asOf)",
    },
    {
      requestKey: "fba-plan:catalog",
      sourceKey: "product-catalog",
      columns: PRODUCT_CATALOG_COLUMNS,
      limit: 10000, // CATALOG_ROW_LIMIT
      groupBy: null,
      aggregations: null,
      orderByColumn: "child_asin",
      orderByDirection: "ASC",
      windowKind: "range:completed[0].from..asOf",
    },
    {
      requestKey: "fba-plan:inventory-health",
      sourceKey: "fba-inventory-health",
      columns: FBA_HEALTH_COLUMNS,
      limit: 15000, // PLAN_INVENTORY_ROW_LIMIT
      groupBy: null,
      aggregations: null,
      orderByColumn: "date",
      orderByDirection: "DESC",
      windowKind: "range:asOf-10d..asOf",
    },
    {
      requestKey: "fba-plan:awd",
      sourceKey: "listings",
      columns: LISTINGS_AWD_COLUMNS,
      limit: 10000, // CATALOG_ROW_LIMIT
      groupBy: null,
      aggregations: null,
      orderByColumn: "child_asin",
      orderByDirection: "ASC",
      windowKind: "none (no-date; US accounts only)",
      marketplaceCountries: ["US"],
    },
  ],
  // Keyword Rank (single account). SQP weekly (primary) + SQP monthly (data-dependent
  // FALLBACK, attempted only when weekly has < 4 distinct periods) + a 365-day catalog.
  // Matching the executable handler saves one monthly export per account/cycle whenever
  // weekly history is sufficient. SQP is a non-default DataDoe table; when a source is
  // disabled for an organisation the worker sees DataDoe's raw disabled-source error
  // (NOT the report API's HTTP 424) — see each contract's structured availabilityPolicy.
  // Raw rows (no groupBy/agg); strict truncation.
  "keyword-rank": [
    {
      requestKey: "keyword-rank:sqp-weekly",
      strict: true,
      sourceKey: "sqp-weekly",
      columns: SQP_COLUMNS,
      limit: 50000, // SQP_ROW_LIMIT (strict: cap => terminal, no partial save)
      groupBy: null,
      aggregations: null,
      orderByColumn: "date",
      orderByDirection: "ASC",
      windowKind: "range:asOf-84d..asOf",
      // Weekly is the primary/required source. Disabled for the org => the report is
      // blocked (matches the executable handler, which cannot produce Keyword Rank
      // without SQP). Machine-readable so Phase 1c never parses an HTTP status string.
      availabilityPolicy: { disabledSource: "terminal", safeCode: "SOURCE_DISABLED", reportOutcome: "blocked" },
    },
    {
      requestKey: "keyword-rank:sqp-monthly",
      strict: true,
      sourceKey: "sqp-monthly",
      columns: SQP_COLUMNS,
      limit: 50000, // SQP_ROW_LIMIT
      groupBy: null,
      aggregations: null,
      orderByColumn: "date",
      orderByDirection: "ASC",
      windowKind: "range:asOf-365d..asOf",
      // Data-dependent fallback: attempted ONLY when the weekly SQP payload (freshly
      // fetched OR last-known-good) has fewer than 4 distinct periods. Structured so
      // Phase 1c can enforce it deterministically — it is NOT planned at kickoff when
      // weekly history is sufficient, so repeated workers create no monthly job then;
      // when required it is one source job obeying the one-create-export-per-cycle DB
      // guard. Disabled while required => the fallback cannot be provided => blocked.
      dependencyMode: "fallback",
      dependsOnRequestKey: "keyword-rank:sqp-weekly",
      condition: { type: "distinct_periods_lt", value: 4 },
      availabilityPolicy: { disabledSource: "terminal", safeCode: "SOURCE_DISABLED", reportOutcome: "blocked" },
    },
    {
      requestKey: "keyword-rank:catalog",
      sourceKey: "product-catalog",
      columns: PRODUCT_CATALOG_COLUMNS,
      limit: 10000, // CATALOG_ROW_LIMIT
      groupBy: null,
      aggregations: null,
      orderByColumn: "child_asin",
      orderByDirection: "ASC",
      windowKind: "range:asOf-365d..asOf",
    },
  ],
  // Content Change Alerts (single account). A NO-DATE notification export (from/to
  // null, event_time DESC) + a 365-day catalog. The notification source may be disabled
  // for an organisation; the worker sees DataDoe's raw disabled-source error (not HTTP
  // 424) and applies the events contract's structured availabilityPolicy (terminal).
  "content-changes": [
    {
      requestKey: "content-changes:events",
      sourceKey: "content-changes",
      columns: CONTENT_CHANGE_COLUMNS,
      limit: 1000, // CONTENT_CHANGE_ROW_LIMIT
      groupBy: null,
      aggregations: null,
      orderByColumn: "event_time",
      orderByDirection: "DESC",
      windowKind: "none (no-date source; from/to null)",
      // The notification stream is the report's only substantive source; disabled for
      // the org => the report is blocked. Structured, not an HTTP status string.
      availabilityPolicy: { disabledSource: "terminal", safeCode: "SOURCE_DISABLED", reportOutcome: "blocked" },
    },
    {
      requestKey: "content-changes:catalog",
      sourceKey: "product-catalog",
      columns: PRODUCT_CATALOG_COLUMNS,
      limit: 10000, // CATALOG_ROW_LIMIT
      groupBy: null,
      aggregations: null,
      orderByColumn: "child_asin",
      orderByDirection: "ASC",
      windowKind: "range:asOf-365d..asOf",
    },
  ],

  // ===== Insight reports (Phase 1b). Ads for PPC are DERIVED from persisted
  // ads_daily_source_rows (see REPORT_DERIVED_SOURCE_KEYS); no report creates a
  // per-brand export. Five reports share one Product Catalog export and three share
  // one FBA Inventory export per account (identical request identity). =====
  "sales-movers": [
    {
      requestKey: "sales-movers:sales-latest-probe",
      sourceKey: "sales-traffic-asin-date",
      columns: SM_LATEST_COLUMNS,
      limit: 500, // ROW_LIMITS.dateRollup
      groupBy: SM_LATEST_COLUMNS,
      aggregations: SM_LATEST_AGGREGATIONS,
      orderByColumn: "date",
      orderByDirection: "ASC",
      // fetchSalesTrafficLatestDate uses fetchExportRows (NOT strict): a date rollup
      // never approaches 500 rows, and it only needs the max reported date.
      windowKind: "range:asOf-(lagDays+21)d..asOf (latest-completed-date probe)",
    },
    {
      requestKey: "sales-movers:traffic",
      sourceKey: "sales-traffic-asin-date",
      columns: SM_TRAFFIC_COLUMNS,
      limit: 50000, // ROW_LIMITS.aggregated
      groupBy: SM_TRAFFIC_COLUMNS,
      aggregations: SM_TRAFFIC_AGGREGATIONS,
      orderByColumn: "child_asin",
      orderByDirection: "ASC",
      windowKind: "per-7day: recent week + prior week (2 windows ending at latest reported date)",
      strict: true,
      // Staged: planned only after the latest-date probe returns a validated reported
      // date; the two 7-day windows are derived from it (salesMoversWindows).
      dependencyMode: "staged",
      dependsOnRequestKey: "sales-movers:sales-latest-probe",
      activation: { type: "validated_success", requireReportedDate: true },
    },
    {
      requestKey: "sales-movers:ads",
      sourceKey: "profit-by-sku-date",
      columns: SM_ADS_COLUMNS,
      limit: 50000, // ROW_LIMITS.aggregated
      groupBy: SM_ADS_COLUMNS,
      aggregations: SM_ADS_AGGREGATIONS,
      orderByColumn: "child_asin",
      orderByDirection: "ASC",
      windowKind: "per-7day: recent week + prior week (same 2 windows as traffic)",
      strict: true,
      dependencyMode: "staged",
      dependsOnRequestKey: "sales-movers:sales-latest-probe",
      activation: { type: "validated_success", requireReportedDate: true },
    },
    {
      requestKey: "sales-movers:inventory",
      sourceKey: "fba-inventory-health",
      columns: INSIGHT_INVENTORY_COLUMNS,
      limit: 15000, // ROW_LIMITS.inventory
      groupBy: null,
      aggregations: null,
      orderByColumn: "date",
      orderByDirection: "DESC",
      windowKind: "range:asOf-10d..asOf (latest snapshot; shared FBA inventory export)",
      strict: true,
      dependencyMode: "staged",
      dependsOnRequestKey: "sales-movers:sales-latest-probe",
      activation: { type: "validated_success", requireReportedDate: true },
    },
    {
      requestKey: "sales-movers:catalog",
      sourceKey: "product-catalog",
      columns: INSIGHT_CATALOG_COLUMNS,
      limit: 20000, // ROW_LIMITS.catalog
      groupBy: null,
      aggregations: null,
      orderByColumn: "child_asin",
      orderByDirection: "ASC",
      windowKind: "none (no-date; shared common insight catalog)",
      strict: true,
      // The builder fetches catalog only after the probe yields a date (it returns the
      // unavailable snapshot otherwise), so the shared-catalog job is staged too.
      dependencyMode: "staged",
      dependsOnRequestKey: "sales-movers:sales-latest-probe",
      activation: { type: "validated_success", requireReportedDate: true },
    },
  ],
  "buy-box-loss": [
    {
      requestKey: "buy-box-loss:daily",
      sourceKey: "profit-by-sku-date",
      columns: BB_DAILY_COLUMNS,
      limit: 50000, // ROW_LIMITS.rawGrain
      groupBy: null,
      aggregations: null,
      orderByColumn: "date",
      orderByDirection: "ASC",
      // Raw daily rows (buybox_percentage is a ratio; a page-view-weighted share is
      // computed downstream), fetched in 7-day slices; any slice at the cap aborts.
      windowKind: "per-7day-slice:asOf-27d..asOf (4 slices)",
      strict: true,
    },
    {
      requestKey: "buy-box-loss:inventory",
      sourceKey: "fba-inventory-health",
      columns: INSIGHT_INVENTORY_COLUMNS,
      limit: 15000, // ROW_LIMITS.inventory
      groupBy: null,
      aggregations: null,
      orderByColumn: "date",
      orderByDirection: "DESC",
      windowKind: "range:asOf-10d..asOf (shared FBA inventory export)",
      strict: true,
    },
    {
      requestKey: "buy-box-loss:catalog",
      sourceKey: "product-catalog",
      columns: INSIGHT_CATALOG_COLUMNS,
      limit: 20000, // ROW_LIMITS.catalog
      groupBy: null,
      aggregations: null,
      orderByColumn: "child_asin",
      orderByDirection: "ASC",
      windowKind: "none (no-date; shared common insight catalog)",
      strict: true,
    },
  ],
  "returns-leakage": [
    {
      requestKey: "returns-leakage:returns",
      sourceKey: "returns",
      columns: RET_RETURN_COLUMNS,
      limit: 50000, // ROW_LIMITS.rawGrain
      groupBy: null,
      aggregations: null,
      orderByColumn: "date",
      orderByDirection: "DESC",
      // Raw grain: the Returns source has no quantity column, so one row IS one
      // returned item and counting rows is the only correct count.
      windowKind: "range:asOf-59d..asOf (RETURNS.historyDays)",
      strict: true,
    },
    {
      requestKey: "returns-leakage:settlements",
      sourceKey: "settlements",
      columns: RET_SETTLEMENT_COLUMNS,
      limit: 50000, // ROW_LIMITS.aggregated
      groupBy: RET_SETTLEMENT_COLUMNS,
      aggregations: RET_SETTLEMENT_AGGREGATIONS,
      orderByColumn: "sku",
      orderByDirection: "ASC",
      windowKind: "range:asOf-59d..asOf",
      strict: true,
    },
    {
      requestKey: "returns-leakage:traffic",
      sourceKey: "sales-traffic-asin-date",
      columns: RET_TRAFFIC_COLUMNS,
      limit: 50000, // ROW_LIMITS.aggregated
      groupBy: RET_TRAFFIC_COLUMNS,
      aggregations: RET_TRAFFIC_AGGREGATIONS,
      orderByColumn: "child_asin",
      orderByDirection: "ASC",
      // Same source as Sales Movers traffic but a different column/aggregation set
      // and window => a distinct request identity; deliberately NOT shared.
      windowKind: "range:asOf-59d..asOf",
      strict: true,
    },
    {
      requestKey: "returns-leakage:catalog",
      sourceKey: "product-catalog",
      columns: INSIGHT_CATALOG_COLUMNS,
      limit: 20000, // ROW_LIMITS.catalog
      groupBy: null,
      aggregations: null,
      orderByColumn: "child_asin",
      orderByDirection: "ASC",
      windowKind: "none (no-date; shared common insight catalog)",
      strict: true,
    },
  ],
  "listing-health": [
    {
      requestKey: "listing-health:listings",
      sourceKey: "listings",
      columns: LH_LISTING_COLUMNS,
      limit: 20000, // ROW_LIMITS.listings
      groupBy: null,
      aggregations: null,
      orderByColumn: "child_asin",
      orderByDirection: "ASC",
      windowKind: "none (no-date listings snapshot)",
      strict: true,
    },
    {
      requestKey: "listing-health:listings-raw",
      sourceKey: "listings-raw",
      columns: LH_LISTING_RAW_COLUMNS,
      limit: 20000, // ROW_LIMITS.listings
      groupBy: null,
      aggregations: null,
      orderByColumn: "child_asin",
      orderByDirection: "ASC",
      windowKind: "none (no-date; optional listing-issues enrichment)",
      strict: true,
      // Optional enrichment: a disabled Listings Raw table is a setup state, not a
      // failure. The report is still saved with issuesAvailable:false, so this source
      // degrades (does NOT block the cycle).
      availabilityPolicy: { disabledSource: "degraded", safeCode: "SOURCE_DISABLED", reportOutcome: "save-unavailable-snapshot" },
    },
    {
      requestKey: "listing-health:sales",
      sourceKey: "profit-by-sku-date",
      columns: LH_SALES_COLUMNS,
      limit: 50000, // ROW_LIMITS.aggregated
      groupBy: LH_SALES_COLUMNS,
      aggregations: LH_SALES_AGGREGATIONS,
      orderByColumn: "sku",
      orderByDirection: "ASC",
      windowKind: "range:asOf-29d..asOf",
      strict: true,
    },
    {
      requestKey: "listing-health:inventory",
      sourceKey: "fba-inventory-health",
      columns: INSIGHT_INVENTORY_COLUMNS,
      limit: 15000, // ROW_LIMITS.inventory
      groupBy: null,
      aggregations: null,
      orderByColumn: "date",
      orderByDirection: "DESC",
      windowKind: "range:asOf-10d..asOf (shared FBA inventory export)",
      strict: true,
    },
    {
      requestKey: "listing-health:catalog",
      sourceKey: "product-catalog",
      columns: INSIGHT_CATALOG_COLUMNS,
      limit: 20000, // ROW_LIMITS.catalog
      groupBy: null,
      aggregations: null,
      orderByColumn: "child_asin",
      orderByDirection: "ASC",
      windowKind: "none (no-date; shared common insight catalog)",
      strict: true,
    },
  ],
  "ppc-performance": [
    {
      requestKey: "ppc-performance:total-sales",
      sourceKey: "sales-traffic-asin-date",
      columns: PPC_TOTAL_SALES_COLUMNS,
      limit: 500, // ROW_LIMITS.dateRollup
      groupBy: PPC_TOTAL_SALES_COLUMNS,
      aggregations: PPC_TOTAL_SALES_AGGREGATIONS,
      orderByColumn: "date",
      orderByDirection: "ASC",
      // The only DataDoe export PPC makes: total account sales for the TACoS
      // denominator (no Ads table carries it). All advertising figures are DERIVED
      // from persisted ads_daily_source_rows — PPC creates NO Ads export.
      windowKind: "range:asOf-29d..asOf",
      strict: true,
      // Planned only when a validated Ads-currency signal proves <= 1 currency. The
      // builder skips this export when persisted Ads rows mix currencies (a combined
      // denominator would be meaningless) — TACoS unavailable by design, not an error.
      dependencyMode: "ads-currency-gate",
      dependsOnSignal: "ppc-performance:ads-currency",
      // Any total-sales failure (DataDoe error, timeout, HTTP 4xx/5xx, a strict row-cap,
      // or a source-save error) degrades ONLY the TACoS denominator: the rest of PPC is
      // still derived and saved. A capped/partial result is a failure, never saved.
      failurePolicy: { onFailure: "degrade", degradedScope: "tacos-denominator", safeCode: "TOTAL_SALES_UNAVAILABLE" },
    },
    {
      requestKey: "ppc-performance:catalog",
      sourceKey: "product-catalog",
      columns: INSIGHT_CATALOG_COLUMNS,
      limit: 20000, // ROW_LIMITS.catalog
      groupBy: null,
      aggregations: null,
      orderByColumn: "child_asin",
      orderByDirection: "ASC",
      windowKind: "none (no-date; shared common insight catalog)",
      strict: true,
    },
  ],
  "listing-optimizer": [
    {
      requestKey: "listing-optimizer:sqp-weekly",
      sourceKey: "sqp-weekly",
      columns: OPT_SQP_COLUMNS,
      limit: 50000, // ROW_LIMITS.aggregated
      groupBy: null,
      aggregations: null,
      orderByColumn: "date",
      orderByDirection: "ASC",
      // SQP is not a default DataDoe table. A disabled organisation gets a valid
      // sqpAvailable:false snapshot, so this source DEGRADES (does not block).
      windowKind: "range:asOf-84d..asOf (>= 8 weeks of SQP)",
      strict: true,
      availabilityPolicy: { disabledSource: "degraded", safeCode: "SOURCE_DISABLED", reportOutcome: "save-unavailable-snapshot" },
    },
    {
      requestKey: "listing-optimizer:catalog",
      sourceKey: "product-catalog",
      columns: OPT_CATALOG_COLUMNS,
      limit: 20000, // ROW_LIMITS.catalog
      groupBy: null,
      aggregations: null,
      orderByColumn: "child_asin",
      orderByDirection: "ASC",
      // Richer content columns (bullets, description, image, BSR) than the common
      // insight catalog => a DISTINCT request identity; intentionally NOT shared.
      windowKind: "none (no-date; richer content catalog, NOT the common one)",
      strict: true,
      // Staged: the builder fetches the rich catalog only after SQP succeeds. Disabled/
      // failed SQP returns sqpAvailable:false immediately and spends no catalog export.
      // A validated SQP success with ZERO rows still activates the catalog (the builder
      // continues to catalog after a successful empty export), so no requireReportedDate.
      dependencyMode: "staged",
      dependsOnRequestKey: "listing-optimizer:sqp-weekly",
      activation: { type: "validated_success" },
    },
  ],
});

// Sources represented by already-scheduled/persisted data rather than a report-
// owned DataDoe export. Keeping this explicit lets coverage tests distinguish an
// intentional derived dependency from an accidentally omitted source.
export const REPORT_DERIVED_SOURCE_KEYS = Object.freeze({
  "daily-reporting": ["ads-campaign-date"],
  // PPC Performance reads ALL advertising figures from the persisted Ads history the
  // scheduled worker maintains (ads_daily_source_rows). Opening/refreshing PPC never
  // runs an Amazon Ads export, so these four Ads sources are derived, not owned.
  "ppc-performance": ["ads-campaign-date", "ads-asin-date", "ads-targeting-date", "ads-search-terms-date"],
});

// Reports that create ZERO owned DataDoe exports: every figure comes from other
// reports' persisted rows. Declaring them explicitly lets the dependency-map test
// prove every sidebar report is covered exactly one way (owned OR derived-only),
// never silently unaudited.
//   * brand-view    — composed from brand-sales rows + persisted Ads + fba-plan.
//   * priority-feed — a command centre over the six insight reports' outputs.
export const REPORT_DERIVED_ONLY = Object.freeze(["brand-view", "priority-feed"]);

// Deterministic, scheduler-owned derivation strategy for reports whose saved source
// rows produce more than one UI output. Not controlled by browser input.
export const REPORT_DERIVATION = Object.freeze({
  "daily-reporting": {
    outputs: ["all-brand", "named-brand (every brand for the account)"],
    derivedFrom: ["daily-reporting:asin-day-superset", "daily-reporting:catalog"],
    strategy:
      "Fetch the ASIN/day Sales & Traffic superset once per account (monthly-segmented) "
      + "and Product Catalog once; sum the superset over child_asin per (date, seller) for "
      + "the all-brand total, and join ASIN->brand via the catalog for every named brand. "
      + "No per-brand export; no compact all-brand export.",
    adsFrom: "ads_daily_source_rows (scheduled Ads sources)",
    liveGate:
      "The compact all-brand export is a strict roll-up of the superset (same source + "
      + "same aggregations, coarser grouping); reconcile superset-summed all-brand vs the "
      + "compact total for one account before permanently retiring the compact export.",
  },
  "ppc-performance": {
    outputs: ["account/campaign/ASIN/target/search-term PPC metrics + TACoS"],
    derivedFrom: ["ads_daily_source_rows", "ppc-performance:total-sales", "ppc-performance:catalog"],
    strategy:
      "All advertising figures come from persisted ads_daily_source_rows (four scheduled "
      + "Ads sources), joined to product names via the common catalog. The scheduler makes "
      + "exactly one small grouped total-sales export for the TACoS denominator; if it fails "
      + "or the account mixes currencies, TACoS degrades to unavailable and the rest of the "
      + "report is still saved. No Ads DataDoe export is ever created by this report.",
    adsFrom: "ads_daily_source_rows (scheduled Ads sources: campaign/asin/targeting/search-terms)",
    liveGate:
      "Confirm the scheduled Ads worker keeps ads_daily_source_rows fresh per account before "
      + "PPC is enabled in Phase 1c; the report has no export fallback for stale Ads history.",
  },
});

// Phase 1c must not enable a partially declared report as though it covered every
// current UI mode. Daily's named-brand path still needs its ASIN/month + catalog
// contracts; the other reports below cover their current builder paths.
export const REPORT_SOURCE_COVERAGE = Object.freeze({
  "brand-sales": "complete",
  "sku-pl": "complete",
  reconciliation: "complete",
  "daily-reporting": "complete", // all-brand + every named brand derive from the ASIN/day superset
  "fba-plan": "complete",
  "keyword-rank": "complete",
  "content-changes": "complete",
  "sales-movers": "complete", // traffic+ads (2 windows each), inventory, catalog, latest-date probe
  "buy-box-loss": "complete", // raw daily (4x7-day slices), inventory, catalog
  "returns-leakage": "complete", // returns raw, settlements, traffic, catalog
  "listing-health": "complete", // listings, listings-raw (degraded), sales, inventory, catalog
  "ppc-performance": "complete", // total-sales export + catalog; ads DERIVED from persisted rows
  "listing-optimizer": "complete", // SQP weekly (degraded) + richer content catalog
});

export function declaredReportKeys() {
  return Object.keys(REPORT_SOURCE_CONTRACTS);
}

export function declaredRequestKeys(reportKey) {
  const contracts = REPORT_SOURCE_CONTRACTS[reportKey];
  return contracts ? contracts.map((c) => c.requestKey) : null;
}

export function reportSourceCoverage(reportKey) {
  return REPORT_SOURCE_COVERAGE[reportKey] || null;
}

// A source result at (or above) its row cap is indistinguishable from a truncated
// one. Contracts marked `strict: true` MUST reject such a result rather than derive
// or save an understated total; this mirrors the executable guard in the
// api/datadoe.js builders (`rows.length >= LIMIT`). Phase 1c reads `strict` to know
// which source jobs to fail (terminal) at the cap instead of persisting them.
export function rejectsAtCap(rowCount, limit) {
  return Number(rowCount) >= Number(limit);
}

// A typed fallback signal describes the primary source's result THIS cycle:
//   { status: "success" | "last-known-good" | "failed" | "terminal",
//     validated: boolean,
//     distinctPeriods: number | null }
// Only a VALIDATED fresh or last-known-good payload is a legitimate basis for a
// data-dependent fallback decision. A failed/terminal primary (or an unvalidated
// one) is NOT — it must preserve the prior report rather than spend a fallback
// export. A malformed signal fails closed (throws), never a silent false.
const FALLBACK_SIGNAL_STATUSES = new Set(["success", "last-known-good", "failed", "terminal"]);

export function validateFallbackSignal(signal) {
  if (signal == null || typeof signal !== "object" || Array.isArray(signal)) {
    throw new Error("Fallback signal must be an object with status/validated/distinctPeriods.");
  }
  if (!FALLBACK_SIGNAL_STATUSES.has(signal.status)) {
    throw new Error(`Invalid fallback signal status "${signal.status}".`);
  }
  if (typeof signal.validated !== "boolean") {
    throw new Error("Fallback signal.validated must be a boolean.");
  }
  if (!(signal.distinctPeriods === null || (Number.isInteger(signal.distinctPeriods) && signal.distinctPeriods >= 0))) {
    throw new Error("Fallback signal.distinctPeriods must be a non-negative integer or null.");
  }
  return signal;
}

// Evaluate a typed data-dependent fallback condition against a typed signal from its
// `dependsOnRequestKey` source. Returns true when the fallback source SHOULD be
// attempted. Fails closed: an unsupported condition type, an invalid threshold, or a
// malformed signal throws a safe configuration error rather than returning false.
export function evaluateFallbackCondition(condition, signal) {
  if (!condition || typeof condition !== "object" || condition.type == null) {
    throw new Error("Fallback condition must be a typed object with a `type`.");
  }
  if (condition.type !== "distinct_periods_lt") {
    throw new Error(`Unsupported fallback condition type "${condition.type}".`);
  }
  if (!Number.isInteger(condition.value) || condition.value < 0) {
    throw new Error("Fallback condition.value (threshold) must be a non-negative integer.");
  }
  const sig = validateFallbackSignal(signal);
  // A failed/terminal weekly (or one with no validated payload) is not a valid basis:
  // do NOT schedule the fallback; the previous report snapshot is preserved.
  if (sig.status === "failed" || sig.status === "terminal") return false;
  if (!sig.validated) return false;
  if (sig.distinctPeriods === null) {
    throw new Error("A validated weekly signal must carry a numeric distinctPeriods.");
  }
  return sig.distinctPeriods < condition.value;
}

/* ============================ staged dependencies ============================
 * A STAGED dependency gates a set of downstream source jobs behind the VALIDATED
 * result of an already-run primary job (a probe or a first-source export). At
 * kickoff the primary's signal is absent, so only the primary is planned; the
 * downstream jobs are planned in a later pass once the worker supplies the typed
 * signal. This is the ONE reusable mechanism for Sales Movers (probe → traffic/
 * ads/inventory/catalog) and Listing Optimizer (SQP → catalog) — no report keeps
 * ad-hoc branching. A staged signal describes the primary's result THIS cycle:
 *   { status, validated, latestReportedDate?: "YYYY-MM-DD" | null }
 * Conservative + token-safe: only a FRESH validated success activates downstream.
 * A last-known-good/failed/terminal/unvalidated primary does NOT (it preserves the
 * prior report and spends no new export). A malformed signal fails closed (throws).
 */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function validateStagedSignal(signal) {
  if (signal == null || typeof signal !== "object" || Array.isArray(signal)) {
    throw new Error("Staged dependency signal must be an object with status/validated.");
  }
  if (!FALLBACK_SIGNAL_STATUSES.has(signal.status)) {
    throw new Error(`Invalid staged signal status "${signal.status}".`);
  }
  if (typeof signal.validated !== "boolean") {
    throw new Error("Staged signal.validated must be a boolean.");
  }
  // latestReportedDate is optional (SQP staging does not use it), but when present it
  // must be a well-formed ISO date or an explicit null (probe succeeded, no reported day).
  if ("latestReportedDate" in signal
    && !(signal.latestReportedDate === null || (typeof signal.latestReportedDate === "string" && ISO_DATE.test(signal.latestReportedDate)))) {
    throw new Error("Staged signal.latestReportedDate must be a YYYY-MM-DD string or null.");
  }
  return signal;
}

// Decide whether a staged contract's downstream job activates. Fails closed on a
// malformed activation or signal. Returns false (not an error) for the legitimate
// no-data / not-yet-successful states so the worker preserves the prior report.
export function evaluateStagedActivation(activation, signal) {
  if (!activation || typeof activation !== "object" || activation.type == null) {
    throw new Error("Staged activation must be a typed object with a `type`.");
  }
  if (activation.type !== "validated_success") {
    throw new Error(`Unsupported staged activation type "${activation.type}".`);
  }
  const sig = validateStagedSignal(signal);
  // FRESH success only. last-known-good must NOT re-activate downstream (it would spend
  // new exports on a stale anchor or pretend the current primary succeeded); failed/
  // terminal/unvalidated preserve the prior report.
  if (sig.status !== "success") return false;
  if (!sig.validated) return false;
  if (activation.requireReportedDate) {
    if (!("latestReportedDate" in sig) || sig.latestReportedDate === undefined) {
      throw new Error("Staged activation requires latestReportedDate on the signal (null when there is none).");
    }
    // Success but no reported date => honest "data unavailable" snapshot, no downstream.
    if (sig.latestReportedDate === null) return false;
  }
  return true;
}

/**
 * Pure Sales Movers comparison windows, derived from the VALIDATED latest reported
 * date exactly as buildSalesMovers does:
 *   recent = [latest-6, latest]; prior = [recent.from-7, recent.from-1]  (two 7-day weeks)
 * Fails closed on a malformed date. Never guessed from the calendar.
 */
export function salesMoversWindows(latestReportedDate) {
  if (typeof latestReportedDate !== "string" || !ISO_DATE.test(latestReportedDate)) {
    throw new Error("salesMoversWindows requires a valid YYYY-MM-DD latest reported date.");
  }
  const recentFrom = addDaysStr(latestReportedDate, -(7 - 1));
  const recent = { from: recentFrom, to: latestReportedDate };
  const prior = { from: addDaysStr(recentFrom, -7), to: addDaysStr(recentFrom, -1) };
  return { recent, prior };
}

/* ===================== PPC total-sales: typed Ads-currency gate =====================
 * The TACoS denominator export is planned from a typed, validated currency signal
 * derived from persisted ads_daily_source_rows — never from live Ads exports. Zero or
 * one currency: schedule. More than one currency: do NOT schedule (a combined
 * denominator would be meaningless; TACoS is unavailable BY DESIGN, not an error).
 * Unvalidated: do not schedule (fail closed). Malformed: throw.
 */
const ADS_CURRENCY_STATUSES = new Set(["success", "failed", "terminal"]);

export function validateAdsCurrencySignal(signal) {
  if (signal == null || typeof signal !== "object" || Array.isArray(signal)) {
    throw new Error("Ads-currency signal must be an object with status/validated/currencyCount.");
  }
  if (!ADS_CURRENCY_STATUSES.has(signal.status)) {
    throw new Error(`Invalid ads-currency signal status "${signal.status}".`);
  }
  if (typeof signal.validated !== "boolean") {
    throw new Error("Ads-currency signal.validated must be a boolean.");
  }
  if (!(Number.isInteger(signal.currencyCount) && signal.currencyCount >= 0)) {
    throw new Error("Ads-currency signal.currencyCount must be a non-negative integer.");
  }
  return signal;
}

export function evaluateAdsCurrencyGate(signal) {
  const sig = validateAdsCurrencySignal(signal);
  // A non-success or unvalidated currency read is not a trustworthy basis: do not
  // schedule total-sales (TACoS stays unavailable; the rest of PPC still derives).
  if (sig.status !== "success" || !sig.validated) return false;
  return sig.currencyCount <= 1;
}

/* ===================== generic source FAILURE policy =====================
 * Distinct from availabilityPolicy (which is ONLY for org-disabled sources). A
 * failurePolicy says what happens when a source's export/save FAILS for any reason —
 * DataDoe/export error, timeout, HTTP 4xx/5xx, a strict row-cap/truncation, or a
 * Supabase source-save error. For a degrade policy the report is NOT blocked: the
 * degraded scope (e.g. the TACoS denominator) is marked unavailable, the rest of the
 * report is derived and saved, and a capped/partial result is treated as a failure —
 * never saved as data. HTTP codes are enumerated as typed causes, never parsed from text.
 */
const VALID_FAILURE_OUTCOME = new Set(["degrade"]);
const FAILURE_CAUSES = Object.freeze(["export-error", "timeout", "http-4xx", "http-5xx", "strict-row-cap", "source-save-error"]);

export function normalizeFailurePolicy(policy) {
  if (policy == null) return null;
  if (typeof policy !== "object" || Array.isArray(policy)) {
    throw new Error("failurePolicy must be an object or null.");
  }
  const { onFailure, degradedScope, safeCode } = policy;
  if (!VALID_FAILURE_OUTCOME.has(onFailure)) {
    throw new Error(`Invalid failurePolicy.onFailure "${onFailure}".`);
  }
  if (typeof degradedScope !== "string" || !degradedScope) {
    throw new Error("failurePolicy.degradedScope must be a non-empty string.");
  }
  if (typeof safeCode !== "string" || !safeCode) {
    throw new Error("failurePolicy.safeCode must be a non-empty string.");
  }
  // The admin-safe code must not smuggle a raw HTTP status string; causes are typed.
  if (/\b(40[24]|429|5\d\d|424)\b/.test(safeCode)) {
    throw new Error("failurePolicy.safeCode must not carry an HTTP status string.");
  }
  return Object.freeze({
    onFailure,          // "degrade"
    degradedScope,      // what becomes unavailable, e.g. "tacos-denominator"
    safeCode,           // admin-safe reason code, never a raw DataDoe error/secret
    blocks: false,      // a degrade failure never blocks the whole report
    neverPartial: true, // a capped/truncated/partial result is a failure, never saved as data
    causes: FAILURE_CAUSES, // the failure modes this policy governs (typed, not parsed)
  });
}

// Typed, immutable dependency descriptor for a resolved staged/gated/fallback job.
// Carries the mode, what it depends on, the required signal status, and the OBSERVED
// signal state that gated it (status/validated/latestReportedDate). Not part of the
// DataDoe request, so it never affects request_hash. null for an unconditional job.
function resolveDependencyMeta(contract, signals) {
  if (!contract.dependencyMode) return null;
  const dependsOn = contract.dependsOnRequestKey || contract.dependsOnSignal || null;
  const sig = dependsOn != null && dependsOn in signals ? signals[dependsOn] : null;
  const required = contract.dependencyMode === "staged" ? "validated success (fresh)"
    : contract.dependencyMode === "ads-currency-gate" ? "validated, <= 1 currency"
    : contract.dependencyMode === "fallback" ? "validated success/last-known-good under threshold"
    : "unknown";
  return Object.freeze({
    mode: contract.dependencyMode,
    dependsOn,
    requiredSignalStatus: required,
    signalStatus: sig && typeof sig === "object" ? (sig.status ?? null) : null,
    validated: sig && typeof sig === "object" && typeof sig.validated === "boolean" ? sig.validated : null,
    latestReportedDate: sig && typeof sig === "object" && "latestReportedDate" in sig ? sig.latestReportedDate : null,
  });
}

// Map a source's structured availabilityPolicy to the outcome when DataDoe reports
// that source as disabled for the organisation. Phase 1c branches on THIS, never on
// the report API's HTTP 424 string. `blocks` = the dependent report cannot be
// produced (terminal); a degraded source does not block — the report saves a valid
// snapshot with the source marked unavailable.
export function sourceDisabledOutcome(policy) {
  // Consume the SAME normalized invariant as the resolved jobs, so both functions
  // enforce identical valid pairs and can never disagree. A malformed or contradictory
  // policy throws here too (fail closed).
  const normalized = normalizeAvailabilityPolicy(policy);
  if (normalized == null) {
    // No disabled-source policy (a default-dataset source). This is only reached if a
    // caller asks about a source with no policy; treat a disabled default source
    // conservatively as terminal/blocked.
    return { blocks: true, safeCode: "SOURCE_DISABLED", reportOutcome: "blocked" };
  }
  return {
    // The pair is guaranteed consistent by normalizeAvailabilityPolicy: terminal =>
    // blocked, degraded => save-unavailable-snapshot.
    blocks: normalized.disabledSource === "terminal",
    safeCode: normalized.safeCode,
    reportOutcome: normalized.reportOutcome,
  };
}

const VALID_DISABLED_SOURCE = new Set(["terminal", "degraded"]);
const VALID_REPORT_OUTCOME = new Set(["blocked", "save-unavailable-snapshot"]);
// The ONLY consistent pairs: a terminal source blocks its report; a degraded source
// lets the report save an unavailable snapshot. Any crossed pair
// (terminal + save-unavailable-snapshot, degraded + blocked) is contradictory.
const REQUIRED_REPORT_OUTCOME = { terminal: "blocked", degraded: "save-unavailable-snapshot" };

// Copy + validate a contract's availabilityPolicy into an IMMUTABLE value for a
// concrete source job. Returns null when the source has no disabled-source policy
// (a default-dataset source that never reports disabled). Rejects unknown enums, any
// HTTP status string, and — critically — any disabledSource/reportOutcome combination
// that is not one of the two valid pairs, so a resolved job (and sourceDisabledOutcome,
// which consumes this) can never carry contradictory worker instructions. The returned
// object is frozen and detached from REPORT_SOURCE_CONTRACTS, so mutating a job cannot
// mutate the registry.
export function normalizeAvailabilityPolicy(policy) {
  if (policy == null) return null;
  if (typeof policy !== "object" || Array.isArray(policy)) {
    throw new Error("availabilityPolicy must be an object or null.");
  }
  const { disabledSource, safeCode, reportOutcome } = policy;
  if (!VALID_DISABLED_SOURCE.has(disabledSource)) {
    throw new Error(`Invalid availabilityPolicy.disabledSource "${disabledSource}".`);
  }
  if (!VALID_REPORT_OUTCOME.has(reportOutcome)) {
    throw new Error(`Invalid availabilityPolicy.reportOutcome "${reportOutcome}".`);
  }
  if (typeof safeCode !== "string" || !safeCode) {
    throw new Error("availabilityPolicy.safeCode must be a non-empty string.");
  }
  if (/424/.test(safeCode) || /424/.test(String(reportOutcome)) || /424/.test(String(disabledSource))) {
    throw new Error("availabilityPolicy must not carry HTTP status strings.");
  }
  if (reportOutcome !== REQUIRED_REPORT_OUTCOME[disabledSource]) {
    throw new Error(`Contradictory availabilityPolicy: disabledSource "${disabledSource}" requires reportOutcome "${REQUIRED_REPORT_OUTCOME[disabledSource]}", got "${reportOutcome}".`);
  }
  return Object.freeze({ disabledSource, safeCode, reportOutcome });
}

/**
 * Resolve the concrete canonical source requests for a declared report.
 *
 *   reportSourceRequestHashes({ reportKey, apiKey, ids, windowsByRequestKey, marketplaceCountry })
 *
 * - `ids` is the account scope; it is chunked into groups of 5 in the GIVEN order,
 *   exactly like the live fetchExportRows transport. One request is emitted PER
 *   (window, chunk). An empty scope returns [] (no source job).
 * - `windowsByRequestKey` maps each declared requestKey to an array of {from,to}
 *   windows (use { from:null, to:null } for a no-date source). Windows are applied
 *   only to their own requestKey — never cross-multiplied across sources. Every
 *   applicable requestKey must be present; an unknown or inapplicable key throws.
 * - `marketplaceCountry` is required when a report has country-conditional source
 *   contracts. It must come from authoritative account metadata, not UI input.
 *
 * Each returned request carries everything the worker needs to create the export,
 * record the job, and enforce its execution policy: requestKey, sourceKey, sourceId,
 * sellerOrVendorIds (the exact chunk), from, to, limit, options, requestHash,
 * organizationFingerprint, accountScopeHash, requestMeta, plus immutable execution
 * metadata `strict` (explicit boolean) and `availabilityPolicy` (null, or a frozen
 * { disabledSource, safeCode, reportOutcome }). The execution metadata is normalised
 * copies — detached from REPORT_SOURCE_CONTRACTS — and is NOT part of the DataDoe
 * request, so it never affects request_hash deduplication.
 *
 * `fallbackSignals` / `dependencySignals` map a primary requestKey (or a well-known
 * signal key) to a typed signal from an already-run source THIS cycle. Both are merged
 * into one gate map:
 *   - `dependencyMode:"fallback"` (Keyword Rank monthly) plans only when its primary's
 *     `{status,validated,distinctPeriods}` condition holds.
 *   - `dependencyMode:"staged"` (Sales Movers downstream, Listing Optimizer catalog)
 *     plans only when the primary's `{status,validated,latestReportedDate?}` proves a
 *     fresh validated success (with a real reported date where required).
 *   - `dependencyMode:"ads-currency-gate"` (PPC total-sales) plans only when a validated
 *     `{status,validated,currencyCount}` Ads-currency signal proves <= 1 currency.
 * At kickoff (no signals) only the unconditional primaries are planned. A malformed
 * signal or unsupported condition throws a safe configuration error (fail closed).
 *
 * Resolved jobs additionally carry (immutable, outside request identity):
 *   - `failurePolicy`: null, or a frozen generic any-failure degrade policy.
 *   - `dependency`: null, or a frozen descriptor { mode, dependsOn, requiredSignalStatus,
 *     signalStatus, validated, latestReportedDate } of the gate that activated the job.
 *
 * Returns null for an undeclared report (callers must not assume a contract).
 */
export function reportSourceRequestHashes({ reportKey, apiKey, ids, windowsByRequestKey, marketplaceCountry, fallbackSignals, dependencySignals }) {
  const contracts = REPORT_SOURCE_CONTRACTS[reportKey];
  if (!contracts) return null;

  // An empty account scope produces no source job, so return before validating the
  // window map: a caller with nothing to sync should never be forced to supply
  // windows just to receive an empty result.
  const chunks = chunkAccountIds(ids);
  if (chunks.length === 0) return [];

  const windowsMap = windowsByRequestKey || {};
  const declaredKeys = contracts.map((c) => c.requestKey);

  // Conditional exports are decided from authoritative account marketplace
  // metadata, not from whether a caller happened to supply a window. This keeps
  // the US-only AWD request mandatory for US accounts and impossible elsewhere.
  const country = String(marketplaceCountry || "").trim().toUpperCase();
  for (const c of contracts) {
    if (Array.isArray(c.marketplaceCountries) && c.marketplaceCountries.length && !country) {
      throw new Error(`Marketplace country is required to resolve conditional request key "${c.requestKey}".`);
    }
  }
  // Typed signals from already-run primaries this cycle, keyed by requestKey (or a
  // well-known signal key). `fallbackSignals` is the legacy name; `dependencySignals`
  // is the general one. Both feed the same gate map.
  const signals = { ...(fallbackSignals || {}), ...(dependencySignals || {}) };
  const applies = (c) => {
    // Country-conditional gate: authoritative account metadata, never window presence.
    if (Array.isArray(c.marketplaceCountries) && c.marketplaceCountries.length
      && !c.marketplaceCountries.map((value) => String(value).toUpperCase()).includes(country)) {
      return false;
    }
    // Data-dependent fallback gate: a fallback source is active ONLY once its primary
    // has been evaluated (a typed signal for dependsOnRequestKey is PRESENT) AND its
    // typed condition holds. At kickoff the signal is absent, so the fallback is
    // neither required nor planned. A failed/terminal/unvalidated primary does NOT
    // activate the fallback (evaluateFallbackCondition returns false); a malformed
    // signal throws. Only a validated fresh/last-known-good weekly with < N periods
    // schedules the monthly export.
    if (c.dependencyMode === "fallback") {
      if (!(c.dependsOnRequestKey in signals)) return false;
      return evaluateFallbackCondition(c.condition, signals[c.dependsOnRequestKey]);
    }
    // Staged gate: a downstream job is active ONLY once its primary's typed signal is
    // present AND a fresh validated success (and, where required, a real reported date)
    // is proven. At kickoff the primary's signal is absent, so only the primary is
    // planned. last-known-good/failed/terminal/unvalidated/no-date => not activated
    // (prior report preserved, no wasted export). A malformed signal throws.
    if (c.dependencyMode === "staged") {
      if (!(c.dependsOnRequestKey in signals)) return false;
      return evaluateStagedActivation(c.activation, signals[c.dependsOnRequestKey]);
    }
    // Ads-currency gate (PPC total-sales): scheduled only when a validated Ads-currency
    // signal proves <= 1 currency. Absent signal => not scheduled (safe). >1 currency or
    // unvalidated => not scheduled (TACoS unavailable by design). Malformed => throws.
    if (c.dependencyMode === "ads-currency-gate") {
      if (!(c.dependsOnSignal in signals)) return false;
      return evaluateAdsCurrencyGate(signals[c.dependsOnSignal]);
    }
    return true;
  };
  const activeContracts = contracts.filter(applies);
  const activeKeys = new Set(activeContracts.map((c) => c.requestKey));

  for (const c of activeContracts) {
    const wins = windowsMap[c.requestKey];
    if (!Array.isArray(wins) || wins.length === 0) {
      throw new Error(`Missing windows for request key "${c.requestKey}" in report "${reportKey}".`);
    }
  }
  for (const key of Object.keys(windowsMap)) {
    if (!declaredKeys.includes(key)) {
      throw new Error(`Unknown request key "${key}" for report "${reportKey}". Declared: ${declaredKeys.join(", ")}.`);
    }
    if (!activeKeys.has(key)) {
      throw new Error(`Request key "${key}" does not apply to marketplace country "${country}".`);
    }
  }

  const out = [];
  for (const c of activeContracts) {
    const wins = windowsMap[c.requestKey];
    const contract = sourceContractForKey(c.sourceKey);
    const sourceId = contract ? contract.ids[0] : c.sourceKey;
    const options = {
      groupBy: c.groupBy || undefined,
      aggregations: c.aggregations || undefined,
      orderByColumn: c.orderByColumn,
      orderByDirection: c.orderByDirection,
    };
    for (const w of wins) {
      const from = w && w.from != null ? w.from : null;
      const to = w && w.to != null ? w.to : null;
      for (const chunk of chunks) {
        const identity = sourceRequestIdentity({
          apiKey, sourceId, columns: c.columns, ids: chunk, from, to, limit: c.limit, options,
        });
        out.push({
          requestKey: c.requestKey,
          sourceKey: c.sourceKey,
          sourceId,
          sellerOrVendorIds: chunk,
          from,
          to,
          limit: c.limit,
          options,
          requestHash: identity.requestHash,
          organizationFingerprint: identity.organizationFingerprint,
          accountScopeHash: identity.accountScopeHash,
          requestMeta: identity.requestMeta,
          // Immutable execution policy Phase 1c enforces. Normalised (not the shared
          // contract object) so a worker mutating a job cannot mutate the registry,
          // and NOT part of the DataDoe request — request_hash is unaffected.
          strict: c.strict === true,
          availabilityPolicy: normalizeAvailabilityPolicy(c.availabilityPolicy),
          // Generic any-failure degradation policy (distinct from availabilityPolicy);
          // null unless declared. Frozen + detached from the registry.
          failurePolicy: normalizeFailurePolicy(c.failurePolicy),
          // Typed staged/gated/fallback dependency descriptor + the observed signal
          // state that activated this job; null for an unconditional job.
          dependency: resolveDependencyMeta(c, signals),
        });
      }
    }
  }
  return out;
}
