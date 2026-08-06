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
});

// Sources represented by already-scheduled/persisted data rather than a report-
// owned DataDoe export. Keeping this explicit lets coverage tests distinguish an
// intentional derived dependency from an accidentally omitted source.
export const REPORT_DERIVED_SOURCE_KEYS = Object.freeze({
  "daily-reporting": ["ads-campaign-date"],
});

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

// Map a source's structured availabilityPolicy to the outcome when DataDoe reports
// that source as disabled for the organisation. Phase 1c branches on THIS, never on
// the report API's HTTP 424 string. `blocks` = the dependent report cannot be
// produced (terminal); a degraded source does not block — the report saves a valid
// snapshot with the source marked unavailable.
export function sourceDisabledOutcome(policy) {
  const degraded = policy && policy.disabledSource === "degraded";
  return {
    blocks: !degraded,
    safeCode: (policy && policy.safeCode) || "SOURCE_DISABLED",
    reportOutcome: (policy && policy.reportOutcome) || (degraded ? "save-unavailable-snapshot" : "blocked"),
  };
}

const VALID_DISABLED_SOURCE = new Set(["terminal", "degraded"]);
const VALID_REPORT_OUTCOME = new Set(["blocked", "save-unavailable-snapshot"]);

// Copy + validate a contract's availabilityPolicy into an IMMUTABLE value for a
// concrete source job. Returns null when the source has no disabled-source policy.
// Rejects unknown enums and any HTTP status string, so a resolved job never carries
// the report API's HTTP 424 prose. The returned object is frozen and detached from
// REPORT_SOURCE_CONTRACTS, so mutating a job cannot mutate the registry.
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
 * `fallbackSignals` maps a primary requestKey to a typed signal
 * ({ status, validated, distinctPeriods }); a `dependencyMode:"fallback"` contract is
 * planned only when its primary's signal is present and its typed condition holds. A
 * malformed signal or unsupported condition throws a safe configuration error.
 *
 * Returns null for an undeclared report (callers must not assume a contract).
 */
export function reportSourceRequestHashes({ reportKey, apiKey, ids, windowsByRequestKey, marketplaceCountry, fallbackSignals }) {
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
  const signals = fallbackSignals || {};
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
        });
      }
    }
  }
  return out;
}
