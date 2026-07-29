// Returns & Refund Leakage — which products are losing money to returns, how
// much, and which of four fixable causes is behind it.
//
// Three sources, each used only for what it can actually prove:
//
//  1. Returns (FBA & FBM) — one row per returned item, carrying
//     `amazon_return_reason`, `amazon_fulfillment_channel` and
//     `amazon_return_request_status`. It has NO quantity column and NO currency
//     column, and its refunded amount and label cost exist for FBM returns
//     ONLY, so it is used for reason mix and counts, never for money.
//     Documented availability is roughly 60 days (INITIAL 60 / DAILY 60).
//
//  2. Settlements & P&L Components — the money. `settlement_type = REFUND` rows
//     carry the real refunded amount for BOTH FBA and FBM, plus the return fees
//     and the COGS attached to the refunded units, with an explicit `currency`.
//
//  3. Sales & Traffic by ASIN & Date — Amazon's own `units_shipped` and
//     `units_refunded` per ASIN, which is the cleanest matched pair for a return
//     rate. That source can lag about four days, which the report displays.
//
// Refunds are distinguished from pending and cancelled activity structurally,
// not by guesswork: a refund only exists once Amazon posts a REFUND settlement
// event, whereas a cancelled order never settles at all and a pending return is
// visible as `amazon_return_request_status = PendingApproval`.

import { num } from "../datadoe.js";
import { brandLabel, fetchCatalog, fetchExportRowsStrict, sumField } from "./common.js";
import { RETURNS, ROW_LIMITS, SALES_TRAFFIC, SETTLEMENTS } from "./sources.js";
import { addDaysStr } from "../datadoe.js";

export const RETURNS_REPORT_KEY = "returns-leakage";
export const RETURNS_VERSION = "returns-leakage-v1";

// Matched to the documented availability of the Returns source.
const WINDOW_DAYS = RETURNS.historyDays;

const RETURN_COLUMNS = [
  "date",
  "sku",
  "child_asin",
  "amazon_order_id",
  "amazon_return_reason",
  "amazon_fulfillment_channel",
  "amazon_return_request_status",
  "amazon_return_refunded_amount",
  "amazon_return_label_cost",
  "amazon_return_label_to_be_paid_by",
];

const SETTLEMENT_GROUP_BY = ["sku", "child_asin", "settlement_type", "currency"];
const SETTLEMENT_AGGREGATIONS = [
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

const TRAFFIC_GROUP_BY = ["child_asin", "product_name"];
const TRAFFIC_AGGREGATIONS = [
  { column: "total_sales", aggregation: "sum", alias: "sales_sum" },
  { column: "total_units", aggregation: "sum", alias: "units_sum" },
  { column: "units_shipped", aggregation: "sum", alias: "units_shipped_sum" },
  { column: "units_refunded", aggregation: "sum", alias: "units_refunded_sum" },
];

/**
 * Amazon's return-reason enum grouped into the four levers a seller can
 * actually pull, plus an explicit low-actionability bucket. Anything unmatched
 * stays "other" rather than being forced into a bucket it does not belong in.
 */
export const RETURN_REASON_BUCKETS = [
  { key: "product_quality", label: "Product / quality", lever: "Supplier and QC", test: /DEFECT|QUALITY|DAMAGED_BY|MISSING_PART|NOT_WORK|BROKEN|EXPIRED/ },
  { key: "listing_accuracy", label: "Listing accuracy", lever: "Listing content", test: /NOT_AS_DESCRIB|NOT_COMPATIB|WRONG_ITEM|SWITCHEROO|MISSED_DESCRIPTION|INACCURATE/ },
  { key: "sizing", label: "Sizing / fit", lever: "Size chart and images", test: /TOO_SMALL|TOO_LARGE|TOO_BIG|APPAREL_STYLE|SIZE|FIT/ },
  { key: "delivery", label: "Delivery / fulfilment", lever: "Packaging and carrier", test: /UNDELIVERABLE|REFUSED|LATE|NEVER_ARRIVED|IN_TRANSIT|SHIPPING/ },
  { key: "low_actionability", label: "Low actionability", lever: "Usually not fixable", test: /UNWANTED|NO_REASON|MISORDER|NO_LONGER_NEED|FOUND_CHEAPER|ACCIDENTAL/ },
];

export function classifyReturnReason(reason) {
  const text = String(reason || "").toUpperCase();
  if (!text) return "other";
  for (const bucket of RETURN_REASON_BUCKETS) {
    if (bucket.test.test(text)) return bucket.key;
  }
  return "other";
}

export async function buildReturnsLeakage({ apiKey, ids, to }) {
  const from = addDaysStr(to, -(WINDOW_DAYS - 1));

  // 1) Return records. Raw grain, because the Returns source has no quantity
  // column: one row IS one returned item, so counting rows is the only correct
  // count. Aborts rather than truncating.
  const returnRows = await fetchExportRowsStrict(
    apiKey, RETURNS.id, RETURN_COLUMNS, ids, from, to, ROW_LIMITS.rawGrain,
    { orderByColumn: "date", orderByDirection: "DESC" },
    "Returns export"
  );

  // 2) The money. Grouped, so this stays compact over the whole window.
  const settlementRows = await fetchExportRowsStrict(
    apiKey, SETTLEMENTS.id, SETTLEMENT_GROUP_BY, ids, from, to, ROW_LIMITS.aggregated,
    {
      groupBy: SETTLEMENT_GROUP_BY,
      aggregations: SETTLEMENT_AGGREGATIONS,
      orderByColumn: "sku",
      orderByDirection: "ASC",
    },
    "Returns settlement export"
  );

  // 3) Amazon's own shipped/refunded unit pair for the return rate.
  const trafficRows = await fetchExportRowsStrict(
    apiKey, SALES_TRAFFIC.id, TRAFFIC_GROUP_BY, ids, from, to, ROW_LIMITS.aggregated,
    {
      groupBy: TRAFFIC_GROUP_BY,
      aggregations: TRAFFIC_AGGREGATIONS,
      orderByColumn: "child_asin",
      orderByDirection: "ASC",
    },
    "Returns sales-and-traffic export"
  );

  const catalog = await fetchCatalog(apiKey, ids);

  /* ----- fold returns to ASIN, keeping the reason and channel mix ----- */
  const returnsByAsin = new Map();
  const reasonTotals = new Map();
  let pendingReturnRequests = 0;
  let fbmRefundedAmount = 0;
  let fbmLabelCostBorneBySeller = 0;

  for (const row of returnRows) {
    const asin = String(row.child_asin || "").trim();
    if (!asin) continue;
    const reason = String(row.amazon_return_reason || "").trim() || "NO_REASON_GIVEN";
    const bucket = classifyReturnReason(reason);
    const channel = String(row.amazon_fulfillment_channel || "").trim().toUpperCase() || "UNKNOWN";
    const status = String(row.amazon_return_request_status || "").trim();

    const entry = returnsByAsin.get(asin) || {
      returnCount: 0,
      fba: 0,
      fbm: 0,
      pending: 0,
      byBucket: {},
      byReason: {},
      skus: new Set(),
    };
    entry.returnCount += 1;
    if (channel === "FBA") entry.fba += 1;
    else if (channel === "FBM") entry.fbm += 1;
    if (/pending/i.test(status)) { entry.pending += 1; pendingReturnRequests += 1; }
    entry.byBucket[bucket] = (entry.byBucket[bucket] || 0) + 1;
    entry.byReason[reason] = (entry.byReason[reason] || 0) + 1;
    const sku = String(row.sku || "").trim();
    if (sku) entry.skus.add(sku);
    returnsByAsin.set(asin, entry);

    reasonTotals.set(reason, (reasonTotals.get(reason) || 0) + 1);

    // FBM-only fields, kept separate so they are never presented as an
    // account-wide refund total.
    fbmRefundedAmount += Math.abs(num(row.amazon_return_refunded_amount));
    if (/seller/i.test(String(row.amazon_return_label_to_be_paid_by || ""))) {
      fbmLabelCostBorneBySeller += Math.abs(num(row.amazon_return_label_cost));
    }
  }

  /* ----- fold settlement money per (currency, ASIN) ----- */
  const moneyByKey = new Map();
  const currencies = new Set();
  for (const row of settlementRows) {
    const asin = String(row.child_asin || "").trim();
    if (!asin) continue;
    const currency = String(row.currency || "").trim() || null;
    if (currency) currencies.add(currency);
    const type = String(row.settlement_type || "").trim().toUpperCase();
    const key = `${currency || "?"}|${asin}`;
    const entry = moneyByKey.get(key) || {
      asin,
      currency,
      skus: new Set(),
      settledSales: 0,
      settledUnits: 0,
      refundedAmount: 0,
      refundTax: 0,
      refundedReferralFeeCredit: 0,
      returnFees: 0,
      cogsOnRefundedUnits: 0,
      refundedUnitsSettled: 0,
      refundEvents: 0,
    };
    const sku = String(row.sku || "").trim();
    if (sku) entry.skus.add(sku);

    if (type === "ORDER") {
      entry.settledSales += sumField(row, "item_price_sum", "item_price");
      entry.settledUnits += sumField(row, "quantity_sum", "quantity");
    } else if (type === "REFUND") {
      entry.refundEvents += 1;
      // Amazon posts money out as a negative amount. Absolute values are used
      // for a leakage ranking; the raw signs stay in Reconciliation.
      entry.refundedAmount += Math.abs(sumField(row, "refunded_amount_sum", "refunded_amount"));
      entry.refundTax += Math.abs(sumField(row, "refund_tax_sum", "refund_tax"));
      entry.refundedReferralFeeCredit += Math.abs(sumField(row, "refunded_referral_fee_sum", "refunded_referral_fee"));
      // Seller-borne return handling, less any restocking fee recovered from the
      // customer. Clamped at zero so a large restocking recovery can never make
      // the fee component negative and understate the leakage below the refund.
      entry.returnFees += Math.max(0,
        Math.abs(sumField(row, "refund_commission_sum", "refund_commission"))
        + Math.abs(sumField(row, "return_unit_fee_sum", "fba_customer_return_per_unit_fee"))
        - Math.abs(sumField(row, "refund_restocking_fee_sum", "refund_restocking_fee"))
      );
      entry.cogsOnRefundedUnits += Math.abs(sumField(row, "cogs_sum", "cogs_total_value"));
      entry.refundedUnitsSettled += Math.abs(sumField(row, "quantity_sum", "quantity"));
    }
    moneyByKey.set(key, entry);
  }

  /* ----- Amazon's shipped / refunded units per ASIN ----- */
  const trafficByAsin = new Map();
  for (const row of trafficRows) {
    const asin = String(row.child_asin || "").trim();
    if (!asin) continue;
    const entry = trafficByAsin.get(asin) || { sales: 0, units: 0, unitsShipped: 0, unitsRefunded: 0, productName: null };
    entry.sales += sumField(row, "sales_sum", "total_sales");
    entry.units += sumField(row, "units_sum", "total_units");
    entry.unitsShipped += sumField(row, "units_shipped_sum", "units_shipped");
    entry.unitsRefunded += sumField(row, "units_refunded_sum", "units_refunded");
    if (!entry.productName) entry.productName = String(row.product_name || "").trim() || null;
    trafficByAsin.set(asin, entry);
  }

  /* ----- assemble one row per (currency, ASIN) ----- */
  const asins = new Set([
    ...returnsByAsin.keys(),
    ...trafficByAsin.keys(),
    ...[...moneyByKey.values()].map((entry) => entry.asin),
  ]);

  const rows = [];
  for (const asin of asins) {
    const returns = returnsByAsin.get(asin) || null;
    const traffic = trafficByAsin.get(asin) || null;
    // An ASIN can appear under more than one currency; each keeps its own row.
    const moneyEntries = [...moneyByKey.values()].filter((entry) => entry.asin === asin);
    const targets = moneyEntries.length ? moneyEntries : [null];
    const meta = catalog.byAsin.get(asin) || {};

    for (const money of targets) {
      const hasReturnActivity = Boolean(returns) || (money && money.refundEvents > 0) || (traffic && traffic.unitsRefunded > 0);
      if (!hasReturnActivity) continue;

      const skus = new Set([...(returns?.skus || []), ...(money?.skus || [])]);
      rows.push({
        asin,
        sku: [...skus].sort((a, b) => a.localeCompare(b))[0] || null,
        skuCount: skus.size,
        productName: meta.name || traffic?.productName || null,
        brand: brandLabel(meta.brand),
        currency: money?.currency || null,

        // Counts from the Returns source (row count = returned items).
        returnCount: returns ? returns.returnCount : 0,
        fbaReturns: returns ? returns.fba : 0,
        fbmReturns: returns ? returns.fbm : 0,
        pendingReturnRequests: returns ? returns.pending : 0,
        reasonBuckets: returns ? returns.byBucket : {},
        topReasons: returns
          ? Object.entries(returns.byReason).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([reason, count]) => ({ reason, count }))
          : [],

        // Money from settlement REFUND events only.
        refundedAmount: money ? money.refundedAmount : 0,
        refundTax: money ? money.refundTax : 0,
        returnFees: money ? money.returnFees : 0,
        refundedReferralFeeCredit: money ? money.refundedReferralFeeCredit : 0,
        cogsOnRefundedUnits: money ? money.cogsOnRefundedUnits : 0,
        refundedUnitsSettled: money ? money.refundedUnitsSettled : 0,
        refundEvents: money ? money.refundEvents : 0,
        settledSales: money ? money.settledSales : 0,
        settledUnits: money ? money.settledUnits : 0,
        hasMoney: Boolean(money),

        // Amazon's own matched pair for the rate.
        unitsSold: traffic ? traffic.units : null,
        unitsShipped: traffic ? traffic.unitsShipped : null,
        unitsRefunded: traffic ? traffic.unitsRefunded : null,
        sales: traffic ? traffic.sales : null,
        hasTraffic: Boolean(traffic),
      });
    }
  }

  return {
    accountId: ids[0],
    asOf: to,
    window: { from, to, days: WINDOW_DAYS },
    returnsSourceLabel: RETURNS.label,
    moneySourceLabel: SETTLEMENTS.label,
    rateSourceLabel: SALES_TRAFFIC.label,
    rateSourceLagDays: SALES_TRAFFIC.lagDays,
    returnHistoryDays: RETURNS.historyDays,
    returnRecordCount: returnRows.length,
    pendingReturnRequests,
    // FBM-only figures from the Returns source, reported separately so they are
    // never mistaken for an account-wide refund total.
    fbmOnly: {
      refundedAmount: fbmRefundedAmount,
      sellerBorneLabelCost: fbmLabelCostBorneBySeller,
    },
    reasonTotals: [...reasonTotals.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([reason, count]) => ({ reason, count, bucket: classifyReturnReason(reason) })),
    currencies: [...currencies].sort(),
    rows,
    catalogBrands: catalog.catalogBrands,
  };
}
