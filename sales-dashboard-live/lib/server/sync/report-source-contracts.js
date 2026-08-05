// Per-report canonical DataDoe request contracts (Scheduler v2, Phase 1b).
//
// Each entry is the EXACT input a report's api/datadoe.js builder passes to a
// create-export: source, columns, row limit, groupBy, aggregations, and ordering,
// plus how the date window is derived (windowKind). The scheduler turns these into
// request_hashes with the shared sourceRequestIdentity, so a scheduled fetch reuses
// the very export a browser-triggered report would — and the source cache stays
// valid. The column/groupBy/aggregation/limit values below are transcribed VERBATIM
// from the executable constants in api/datadoe.js and are asserted equal to them in
// scripts/report-source-contracts.test.mjs (drift fails the suite).
//
// SCOPE: only reports whose builder calls have been read line-by-line are declared
// here. Multi-call / per-month / brand-variant reports (daily-reporting, fba-plan,
// reconciliation, keyword-rank, content-changes) and the insight reports are NOT
// yet declared — declaring them from anything less than the exact builder calls
// would be an assumption. They are the next Phase 1b increment (see SCHEDULER_V2.md).

import { sourceRequestIdentity } from "../source-identity.js";
import { sourceContractForKey } from "../source-contracts.js";

/* ---- constants transcribed verbatim from api/datadoe.js (parity-tested) ---- */

// brand-sales: buildBrandSalesPayload (api/datadoe.js) — Order Line Items + Product
// Catalog, both over the same {from,to} window (monthStart(asOf) - 420 days .. asOf).
const ORDER_SALES_COLUMNS = ["date", "seller_or_vendor_id", "seller_or_vendor_name", "marketplace_country_code", "item_price_currency", "child_asin"];
const ORDER_SALES_GROUP_BY = [...ORDER_SALES_COLUMNS];
const ORDER_SALES_AGGREGATIONS = [
  { column: "item_price_value", aggregation: "sum", alias: "total_sales_sum" },
  { column: "quantity", aggregation: "sum", alias: "total_units_sold_sum" },
];
const PRODUCT_CATALOG_COLUMNS = ["child_asin", "parent_asin", "product_name", "product_brand"];

// sku-pl: fetchSkuPlRows (api/datadoe.js) — Profit by SKU & Date, one request per
// completed/current month over {from,to} = each month in monthStart(asOf) - 180 .. asOf.
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

/**
 * Resolve the concrete canonical request identities (request_hash + meta) for a
 * declared report, given the runtime organization (apiKey), the account scope
 * (ids) and the concrete date windows the caller derived from windowKind. A
 * per-month contract is resolved once per supplied window. Org isolation is
 * inherent: a different apiKey yields a different organizationFingerprint, so a
 * primary and a dd-secondary request never collide even for the same source/scope.
 *
 * Returns null for a report that is not (yet) declared here — callers must not
 * assume a contract for an undeclared report.
 */
export function reportSourceRequestHashes({ reportKey, apiKey, ids, windows }) {
  const contracts = REPORT_SOURCE_CONTRACTS[reportKey];
  if (!contracts) return null;
  const scopeIds = Array.isArray(ids) ? ids : [ids];
  const out = [];
  for (const c of contracts) {
    const contract = sourceContractForKey(c.sourceKey);
    const sourceId = contract ? contract.ids[0] : c.sourceKey;
    const wins = windows && windows.length ? windows : [{ from: null, to: null }];
    for (const w of wins) {
      const identity = sourceRequestIdentity({
        apiKey,
        sourceId,
        columns: c.columns,
        ids: scopeIds,
        from: w.from,
        to: w.to,
        limit: c.limit,
        options: {
          groupBy: c.groupBy || undefined,
          aggregations: c.aggregations || undefined,
          orderByColumn: c.orderByColumn,
          orderByDirection: c.orderByDirection,
        },
      });
      out.push({
        sourceKey: c.sourceKey,
        sourceId,
        from: w.from,
        to: w.to,
        requestHash: identity.requestHash,
        requestMeta: identity.requestMeta,
      });
    }
  }
  return out;
}

export function declaredReportKeys() {
  return Object.keys(REPORT_SOURCE_CONTRACTS);
}
