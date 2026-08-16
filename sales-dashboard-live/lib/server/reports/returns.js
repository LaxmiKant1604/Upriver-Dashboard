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
//  3. Order Line Items — ordered `quantity` per ASIN (the return-rate
//     DENOMINATOR). The return-rate NUMERATOR is the count of Returns records
//     (one row = one returned item). Near-real-time, so effectively no lag.
//
// Refunds are distinguished from pending and cancelled activity structurally,
// not by guesswork: a refund only exists once Amazon posts a REFUND settlement
// event, whereas a cancelled order never settles at all and a pending return is
// visible as `amazon_return_request_status = PendingApproval`.

import { num, canonicalOliSlices } from "../datadoe.js";
import { brandLabel, fetchCatalog, fetchExportRowsStrict, sumField } from "./common.js";
import { ORDER_LINE_ITEMS, RETURNS, ROW_LIMITS, SETTLEMENTS } from "./sources.js";
import { addDaysStr } from "../datadoe.js";

export const RETURNS_REPORT_KEY = "returns-leakage";
export const RETURNS_VERSION = "returns-leakage-v2";

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

// Ordered units are the return-rate DENOMINATOR, from the ONE CANONICAL Order Line Items sales fragment
// (Blocker 1): item_price_value ordered sales + quantity ordered units. The RETURNED units NUMERATOR is
// the count of Returns records per ASIN (one row = one returned item). Grouped by
// [date, seller_or_vendor_id, sku, child_asin, item_price_currency] so DataDoe never sums money across
// currencies and this export is byte-identical to the other OLI reports (shared request_hashes on
// overlapping calendar-anchored slices => one export, many owners). The fold re-aggregates to
// (currency, child_asin) so ordered evidence is bound per currency (Blocker 2) — never ASIN alone.
const OLI_SALES_GROUP_BY = ["date", "seller_or_vendor_id", "sku", "child_asin", "item_price_currency"];
const OLI_SALES_AGGREGATIONS = [
  { column: "item_price_value", aggregation: "sum", alias: "total_sales_sum" },
  { column: "quantity", aggregation: "sum", alias: "total_units_sum" },
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

  // 3) Ordered sales/units per (currency, ASIN) from the ONE canonical Order Line Items fragment over the
  // SAME 60-day window, sliced by canonicalOliSlices so its interior + asOf-boundary slices share
  // request_hashes with the other OLI reports (one export, many owners).
  const orderedRows = [];
  for (const slice of canonicalOliSlices(from, to)) {
    const sliceRows = await fetchExportRowsStrict(
      apiKey, ORDER_LINE_ITEMS.id, OLI_SALES_GROUP_BY, ids, slice.from, slice.to, ROW_LIMITS.aggregated,
      {
        groupBy: OLI_SALES_GROUP_BY,
        aggregations: OLI_SALES_AGGREGATIONS,
        orderByColumn: "date",
        orderByDirection: "ASC",
      },
      `Returns ordered-units export (${slice.from} to ${slice.to})`
    );
    for (const row of sliceRows) orderedRows.push(row);
  }

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

  /* ----- ordered sales/units per (currency, ASIN) -- ordered evidence bound per currency (Blocker 2) ----- */
  const orderedByKey = new Map();
  for (const row of orderedRows) {
    const asin = String(row.child_asin || "").trim();
    if (!asin) continue;
    const currency = String(row.item_price_currency || "").trim() || null;
    const key = `${currency || "?"}|${asin}`;
    const entry = orderedByKey.get(key) || { asin, currency, sales: 0, orderedUnits: 0, productName: null };
    entry.sales += sumField(row, "total_sales_sum", "item_price_value");
    entry.orderedUnits += sumField(row, "total_units_sum", "quantity");
    if (!entry.productName) entry.productName = String(row.product_name || "").trim() || null;
    orderedByKey.set(key, entry);
  }

  /* ----- assemble one row per (currency, ASIN); Returns records carry NO currency (Blocker 2) ----- */
  const asins = new Set([
    ...returnsByAsin.keys(),
    ...[...orderedByKey.values()].map((entry) => entry.asin),
    ...[...moneyByKey.values()].map((entry) => entry.asin),
  ]);

  const rows = [];
  for (const asin of asins) {
    const returns = returnsByAsin.get(asin) || null;
    const meta = catalog.byAsin.get(asin) || {};
    // The ASIN's currency universe = union of settlement-money currencies + ordered currencies. Each row's
    // orderedUnits/sales/refund money come from THAT currency ONLY (never a combined total copied across).
    const byCurrency = new Map();
    for (const m of [...moneyByKey.values()].filter((e) => e.asin === asin)) {
      const c = m.currency ?? null;
      const slot = byCurrency.get(c) || { currency: c, money: null, ordered: null };
      slot.money = m; byCurrency.set(c, slot);
    }
    for (const o of [...orderedByKey.values()].filter((e) => e.asin === asin)) {
      const c = o.currency ?? null;
      const slot = byCurrency.get(c) || { currency: c, money: null, ordered: null };
      slot.ordered = o; byCurrency.set(c, slot);
    }
    // An ASIN with returns but NO money and NO ordered evidence has a single null-currency row.
    if (byCurrency.size === 0 && returns) byCurrency.set(null, { currency: null, money: null, ordered: null });
    const slots = [...byCurrency.values()];
    const multiCurrency = slots.length > 1;
    // Returns carry no currency. SINGLE currency: the sole row holds the returnCount + returnedUnits (rate
    // known). MULTIPLE currencies: the returnCount goes on exactly ONE deterministic PRIMARY row (greatest
    // ordered units; tie-break lexicographically smallest currency), 0 on the others, and returnedUnits is
    // WITHHELD (null) on ALL of the ASIN's rows so the rate is never computed from a currency-ambiguous count.
    let primary = null;
    if (returns && multiCurrency) {
      primary = slots.slice().sort((a, b) => {
        const ua = a.ordered ? a.ordered.orderedUnits : 0;
        const ub = b.ordered ? b.ordered.orderedUnits : 0;
        if (ub !== ua) return ub - ua;
        return String(a.currency ?? "").localeCompare(String(b.currency ?? ""));
      })[0];
    }
    for (const slot of slots) {
      const money = slot.money;
      const ordered = slot.ordered;
      const isReturnHolder = Boolean(returns) && (!multiCurrency || slot === primary);
      // A return-leakage candidate row holds the ASIN's returns OR has its OWN currency's refund events.
      const hasReturnActivity = isReturnHolder || (money && money.refundEvents > 0);
      if (!hasReturnActivity) continue;

      const skus = new Set([...(isReturnHolder ? returns.skus : []), ...(money?.skus || [])]);
      rows.push({
        asin,
        sku: [...skus].sort((a, b) => a.localeCompare(b))[0] || null,
        skuCount: skus.size,
        productName: meta.name || ordered?.productName || null,
        brand: brandLabel(meta.brand),
        currency: slot.currency,

        // Counts from the Returns source (row count = returned items) -- ONLY the return-holder row carries
        // them, so an ASIN's return count is NEVER duplicated across its currency rows.
        returnCount: isReturnHolder ? returns.returnCount : 0,
        fbaReturns: isReturnHolder ? returns.fba : 0,
        fbmReturns: isReturnHolder ? returns.fbm : 0,
        pendingReturnRequests: isReturnHolder ? returns.pending : 0,
        reasonBuckets: isReturnHolder ? returns.byBucket : {},
        topReasons: isReturnHolder
          ? Object.entries(returns.byReason).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([reason, count]) => ({ reason, count }))
          : [],

        // Money from settlement REFUND events only (this currency).
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

        // Return rate = returned units (Returns record count) / ordered units (Order Line Items), per THIS
        // currency. returnedUnits is WITHHELD (null) whenever the ASIN spans multiple currencies.
        orderedUnits: ordered ? ordered.orderedUnits : null,
        returnedUnits: (!multiCurrency && isReturnHolder) ? returns.returnCount : null,
        sales: ordered ? ordered.sales : null,
        hasOrdered: Boolean(ordered),
      });
    }
  }

  return {
    accountId: ids[0],
    asOf: to,
    window: { from, to, days: WINDOW_DAYS },
    returnsSourceLabel: RETURNS.label,
    moneySourceLabel: SETTLEMENTS.label,
    rateSourceLabel: ORDER_LINE_ITEMS.label,
    rateSourceLagDays: ORDER_LINE_ITEMS.lagDays,
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
