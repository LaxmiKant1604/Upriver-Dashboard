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
// here (brand-sales, sku-pl). Daily, FBA, Reconciliation, Keyword, Content and the
// insight reports are the next Phase 1b increment, same parity-tested method.

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
});

export function declaredReportKeys() {
  return Object.keys(REPORT_SOURCE_CONTRACTS);
}

export function declaredRequestKeys(reportKey) {
  const contracts = REPORT_SOURCE_CONTRACTS[reportKey];
  return contracts ? contracts.map((c) => c.requestKey) : null;
}

/**
 * Resolve the concrete canonical source requests for a declared report.
 *
 *   reportSourceRequestHashes({ reportKey, apiKey, ids, windowsByRequestKey })
 *
 * - `ids` is the account scope; it is chunked into groups of 5 in the GIVEN order,
 *   exactly like the live fetchExportRows transport. One request is emitted PER
 *   (window, chunk). An empty scope returns [] (no source job).
 * - `windowsByRequestKey` maps each declared requestKey to an array of {from,to}
 *   windows (use { from:null, to:null } for a no-date source). Windows are applied
 *   only to their own requestKey — never cross-multiplied across sources. Every
 *   declared requestKey must be present; an unknown key throws.
 *
 * Each returned request carries everything the worker needs to create the export
 * and record the job: requestKey, sourceKey, sourceId, sellerOrVendorIds (the exact
 * chunk), from, to, limit, options, requestHash, organizationFingerprint,
 * accountScopeHash, requestMeta.
 *
 * Returns null for an undeclared report (callers must not assume a contract).
 */
export function reportSourceRequestHashes({ reportKey, apiKey, ids, windowsByRequestKey }) {
  const contracts = REPORT_SOURCE_CONTRACTS[reportKey];
  if (!contracts) return null;

  const windowsMap = windowsByRequestKey || {};
  const declaredKeys = contracts.map((c) => c.requestKey);

  for (const c of contracts) {
    const wins = windowsMap[c.requestKey];
    if (!Array.isArray(wins) || wins.length === 0) {
      throw new Error(`Missing windows for request key "${c.requestKey}" in report "${reportKey}".`);
    }
  }
  for (const key of Object.keys(windowsMap)) {
    if (!declaredKeys.includes(key)) {
      throw new Error(`Unknown request key "${key}" for report "${reportKey}". Declared: ${declaredKeys.join(", ")}.`);
    }
  }

  const chunks = chunkAccountIds(ids);
  if (chunks.length === 0) return []; // empty account scope => no source job

  const out = [];
  for (const c of contracts) {
    const contract = sourceContractForKey(c.sourceKey);
    const sourceId = contract ? contract.ids[0] : c.sourceKey;
    const options = {
      groupBy: c.groupBy || undefined,
      aggregations: c.aggregations || undefined,
      orderByColumn: c.orderByColumn,
      orderByDirection: c.orderByDirection,
    };
    for (const w of windowsMap[c.requestKey]) {
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
