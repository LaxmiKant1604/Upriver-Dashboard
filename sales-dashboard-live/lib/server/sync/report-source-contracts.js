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
// SCOPE: only reports whose builder calls have been read line-by-line are declared
// here. Daily Reporting currently covers its all-brand path only; its ASIN-grain
// named-brand path remains explicitly incomplete. Keyword, Content and the insight
// reports are later Phase 1b increments using the same parity-tested method.

import { sourceRequestIdentity } from "../source-identity.js";
import { sourceContractForKey } from "../source-contracts.js";
import { chunkAccountIds } from "../id-batching.js";

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

// daily-reporting (all-brand path): the Sales & Traffic export. Ads are DERIVED from
// the scheduled Ads sources (saved ads_daily_source_rows) — when Supabase is
// configured (always, for the scheduler) Daily reads saved ads and issues NO ads
// export; the REST ads export in api/datadoe.js is a no-Supabase fallback only, so it
// is intentionally NOT declared as a Daily-owned export.
const DAILY_SALES_COLUMNS = ["date", "seller_or_vendor_id"];
const DAILY_SALES_GROUP_BY = [...DAILY_SALES_COLUMNS];
const DAILY_SALES_AGGREGATIONS = [
  { column: "total_sales", aggregation: "sum", alias: "total_sales_sum" },
  { column: "total_units", aggregation: "sum", alias: "total_units_sum" },
];

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
  // Daily Reporting (all-brand): the Sales & Traffic export only. Ads are derived
  // from the scheduled Ads sources (see the DAILY_SALES_* note above).
  "daily-reporting": [
    {
      requestKey: "daily-reporting:sales",
      sourceKey: "sales-traffic-asin-date",
      columns: DAILY_SALES_COLUMNS,
      limit: 5000, // DAILY_ROW_LIMIT
      groupBy: DAILY_SALES_GROUP_BY,
      aggregations: DAILY_SALES_AGGREGATIONS,
      orderByColumn: "date",
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
});

// Sources represented by already-scheduled/persisted data rather than a report-
// owned DataDoe export. Keeping this explicit lets coverage tests distinguish an
// intentional derived dependency from an accidentally omitted source.
export const REPORT_DERIVED_SOURCE_KEYS = Object.freeze({
  "daily-reporting": ["ads-campaign-date"],
});

// Phase 1c must not enable a partially declared report as though it covered every
// current UI mode. Daily's named-brand path still needs its ASIN/month + catalog
// contracts; the other reports below cover their current builder paths.
export const REPORT_SOURCE_COVERAGE = Object.freeze({
  "brand-sales": "complete",
  "sku-pl": "complete",
  reconciliation: "complete",
  "daily-reporting": "all-brand-only",
  "fba-plan": "complete",
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
 * Each returned request carries everything the worker needs to create the export
 * and record the job: requestKey, sourceKey, sourceId, sellerOrVendorIds (the exact
 * chunk), from, to, limit, options, requestHash, organizationFingerprint,
 * accountScopeHash, requestMeta.
 *
 * Returns null for an undeclared report (callers must not assume a contract).
 */
export function reportSourceRequestHashes({ reportKey, apiKey, ids, windowsByRequestKey, marketplaceCountry }) {
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
  const applies = (c) => !Array.isArray(c.marketplaceCountries)
    || c.marketplaceCountries.map((value) => String(value).toUpperCase()).includes(country);
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
        });
      }
    }
  }
  return out;
}
