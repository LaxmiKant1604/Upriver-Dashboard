// Authoritative Order Line Items order rules -- the PURE, testable core shared by the JS persist path and
// mirrored by the atomic replace_oli_dimensional_window RPC. These rules govern how the four new dimensions
// (amazon_order_status, fulfillment_channel, address_state, address_city) are normalized, validated, and rolled
// up so that:
//   - a missing order status is INVALID (cancellation cannot be classified) -> OLI_ORDER_STATUS_MISSING;
//   - status is normalized ONLY for comparison (trim + lower-case); 'canceled' == 'cancelled';
//   - cancelled rows are kept for audit but contribute ZERO to the dashboard rollup (sales/units/orders);
//   - a NON-cancelled row with units > 0 must carry an order value PRESENT (never null/blank), else the whole
//     window is refused with OLI_NON_CANCELLED_VALUE_MISSING (a missing value is NEVER coerced to 0 first). A
//     PRESENT-but-zero value is a REAL zero-priced unit (promotional / replacement / free): it is kept for audit
//     and treated LIKE a cancelled row -- contributing ZERO sales AND units to the rollup -- and NEVER blocks the
//     window (`contributesToRollup` is true only when not-cancelled AND value present AND value > 0);
//   - blank state/city is allowed (stored '') and never blocks an otherwise-valid sale.

export class OliOrderRuleError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = "OliOrderRuleError";
    this.code = code;
    this.detail = detail;
  }
}

const S = (v) => (v == null ? "" : String(v));

// Normalize a status for COMPARISON only (never mutates the stored raw status): trim + lower-case.
export function normalizeOrderStatus(status) {
  return S(status).trim().toLowerCase();
}

// Cancelled iff the normalized status is one of the cancelled spellings (Amazon uses both CANCELED and CANCELLED).
export function isCancelledStatus(status) {
  const n = normalizeOrderStatus(status);
  return n === "cancelled" || n === "canceled";
}

// A value is PRESENT only when it is neither null/undefined nor a blank string. A missing value is NEVER
// silently turned into 0 -- the caller must decide (a non-cancelled positive-unit row with no value is invalid).
export function orderValuePresent(v) {
  return v != null && S(v).trim() !== "";
}

// Canonical fulfillment categories. The raw fulfillment_channel is ALWAYS preserved (audit); this maps its
// synonyms onto ONE presentation bucket so Amazon/AFN and Merchant/MFN can never split a contribution total into
// four separate categories.
export const FULFILLMENT_CATEGORY = Object.freeze({
  AMAZON: "Amazon/FBA",
  MERCHANT: "Merchant/FBM",
  UNAVAILABLE: "Unavailable",
});

/**
 * Normalize a raw fulfillment_channel into exactly one canonical category:
 *   Amazon | AFN                    -> "Amazon/FBA"    (Amazon-fulfilled / FBA)
 *   Merchant | MFN | Seller         -> "Merchant/FBM"  (merchant-fulfilled / FBM)
 *   blank / unknown / anything else -> "Unavailable"   (never a fabricated category, never dropped)
 * Comparison is trim + lower-case; the raw value is never mutated by this function.
 */
export function normalizeFulfillmentChannel(raw) {
  const n = S(raw).trim().toLowerCase();
  if (n === "amazon" || n === "afn" || n === "amazon fulfilled" || n === "fba") return FULFILLMENT_CATEGORY.AMAZON;
  if (n === "merchant" || n === "mfn" || n === "seller" || n === "merchant fulfilled" || n === "fbm") return FULFILLMENT_CATEGORY.MERCHANT;
  return FULFILLMENT_CATEGORY.UNAVAILABLE;
}

/**
 * Validate ONE grain row of the dimensional OLI fragment and return the canonical shape. Throws OliOrderRuleError
 * on a rule violation (the caller refuses the whole account/window and preserves the last-known-good).
 * `row` carries { seller_or_vendor_id, date|sale_date, item_price_currency|currency, amazon_order_status,
 * fulfillment_channel, address_state, address_city, total_sales_sum, total_units_sum }.
 */
export function classifyOliDimensionalRow(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    throw new OliOrderRuleError("OLI_MALFORMED_ROW", "malformed dimensional row (not a plain object)");
  }
  const status = S(row.amazon_order_status);
  if (status.trim() === "") {
    // Rule 9: missing order status is invalid -- cancellation cannot be classified.
    throw new OliOrderRuleError("OLI_ORDER_STATUS_MISSING", "a row has no amazon_order_status; cancellation cannot be classified", { date: S(row.date ?? row.sale_date) });
  }
  const cancelled = isCancelledStatus(status);
  const units = Number(row.total_units_sum ?? 0);
  if (!Number.isFinite(units)) {
    throw new OliOrderRuleError("OLI_MALFORMED_ROW", "a row carries a non-finite units value", { date: S(row.date ?? row.sale_date) });
  }
  const valuePresent = orderValuePresent(row.total_sales_sum);
  const value = valuePresent ? Number(row.total_sales_sum) : null;
  if (valuePresent && !Number.isFinite(value)) {
    throw new OliOrderRuleError("OLI_MALFORMED_ROW", "a row carries a non-finite order value", { date: S(row.date ?? row.sale_date) });
  }
  if (!cancelled && units > 0 && !valuePresent) {
    // A non-cancelled positive-unit row with a MISSING (null/blank) value is incorrect source evidence -> refuse
    // the whole window (never a fabricated zero). A PRESENT-but-zero value is NOT refused (handled below).
    throw new OliOrderRuleError(
      "OLI_NON_CANCELLED_VALUE_MISSING",
      "non-cancelled row with units>0 has a missing order value",
      { date: S(row.date ?? row.sale_date), status },
    );
  }
  // A row contributes real sales/units to the dashboard rollup ONLY when it is not cancelled AND carries a
  // present, strictly-positive value. A cancelled row OR a present-but-zero-value non-cancelled unit (a real
  // zero-priced / promotional / replacement unit) contributes ZERO -- it stays in the dimensional table for audit.
  const contributesToRollup = !cancelled && valuePresent && value > 0;
  return {
    status,
    statusNormalized: normalizeOrderStatus(status),
    isCancelled: cancelled,
    units,
    valuePresent,
    value, // null when absent -- NOT coerced to 0
    contributesToRollup,
    fulfillmentChannel: S(row.fulfillment_channel).trim(),                    // RAW, preserved for audit (blank allowed)
    fulfillmentCategory: normalizeFulfillmentChannel(row.fulfillment_channel), // ONE canonical presentation bucket
    addressState: S(row.address_state).trim(),             // blank allowed (unavailable)
    addressCity: S(row.address_city).trim(),               // blank allowed (unavailable)
  };
}

/**
 * The NON-CANCELLED daily rollup of a set of ALREADY-CANONICAL dimensional history rows -- the exact rollup the
 * RPC persists into source_oli_daily_history and the dashboards read. Cancelled rows contribute nothing. Rows are
 * keyed by (accountId, saleDate, sku, childAsin, currency); values SUM. This is the reconciliation reference:
 * summing valid non-cancelled dimensional rows across status/fulfillment/state/city equals these dashboard totals.
 * `dimRows` carry { accountId, saleDate, sku, childAsin, currency, isCancelled, value, units, sellerOrVendorId,
 * sourceRequestHash }.
 */
/**
 * Aggregate dimensional contribution rows by CANONICAL fulfillment category. Each raw row carries a
 * `fulfillment_channel` (raw), `total_sales_sum`, `total_units_sum`. Synonyms (Amazon/AFN, Merchant/MFN) collapse
 * onto one category each, so the returned map has AT MOST three keys ("Amazon/FBA", "Merchant/FBM",
 * "Unavailable") -- never four split by spelling. Returns { [category]: { sales, units } }. This is the parity
 * reference: summing per-category totals equals summing the raw rows, and two synonyms land in ONE bucket.
 */
export function aggregateFulfillmentContribution(rows) {
  const out = {};
  for (const r of Array.isArray(rows) ? rows : []) {
    const category = normalizeFulfillmentChannel(r && (r.fulfillment_channel ?? r.fulfillmentChannel));
    const sales = Number((r && (r.total_sales_sum ?? r.salesAmount ?? r.value)) ?? 0) || 0;
    const units = Number((r && (r.total_units_sum ?? r.units)) ?? 0) || 0;
    const cur = out[category] || { sales: 0, units: 0 };
    cur.sales += sales;
    cur.units += units;
    out[category] = cur;
  }
  return out;
}

export function nonCancelledDailyRollup(dimRows) {
  const byGrain = new Map();
  for (const r of Array.isArray(dimRows) ? dimRows : []) {
    // Contribute ONLY not-cancelled rows carrying a present, strictly-positive value. A cancelled row OR a
    // present-but-zero-value non-cancelled unit contributes ZERO sales AND units (kept only in the dimensional table).
    if (!(r && !r.isCancelled && orderValuePresent(r.value) && Number(r.value) > 0)) continue;
    const key = [S(r.accountId), S(r.saleDate), S(r.sku), S(r.childAsin), S(r.currency)].join("");
    const prev = byGrain.get(key);
    const addValue = Number(r.value);
    const addUnits = Number(r.units ?? 0);
    if (prev) {
      prev.salesAmount += addValue;
      prev.units += addUnits;
    } else {
      byGrain.set(key, {
        accountId: S(r.accountId), sellerOrVendorId: S(r.sellerOrVendorId),
        saleDate: S(r.saleDate), sku: S(r.sku), childAsin: S(r.childAsin), currency: S(r.currency),
        salesAmount: addValue, units: addUnits, sourceRequestHash: S(r.sourceRequestHash),
      });
    }
  }
  return [...byGrain.values()];
}
