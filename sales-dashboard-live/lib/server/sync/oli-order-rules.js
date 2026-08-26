// Authoritative Order Line Items order rules -- the PURE, testable core shared by the JS persist path and
// mirrored by the atomic replace_oli_dimensional_window RPC. These rules govern how the four new dimensions
// (amazon_order_status, fulfillment_channel, address_state, address_city) are normalized, validated, and rolled
// up so that:
//   - a missing order status is INVALID (cancellation cannot be classified) -> OLI_ORDER_STATUS_MISSING;
//   - status is normalized ONLY for comparison (trim + lower-case); 'canceled' == 'cancelled';
//   - cancelled rows are kept for audit but contribute ZERO to the dashboard rollup (sales/units/orders);
//   - every NON-cancelled row with units > 0 must carry an order value PRESENT and strictly > 0, else the whole
//     window is refused with OLI_NON_CANCELLED_VALUE_MISSING (a missing value is NEVER coerced to 0 first);
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
  if (!cancelled && units > 0) {
    // Rules 4-7: a non-cancelled positive-unit row MUST have a value present and strictly > 0. A missing/null/
    // zero value is incorrect source evidence -> refuse (never a fabricated zero).
    if (!valuePresent || value == null || !(value > 0)) {
      throw new OliOrderRuleError(
        "OLI_NON_CANCELLED_VALUE_MISSING",
        "non-cancelled row with units>0 has a missing/zero order value",
        { date: S(row.date ?? row.sale_date), status },
      );
    }
  }
  return {
    status,
    statusNormalized: normalizeOrderStatus(status),
    isCancelled: cancelled,
    units,
    valuePresent,
    value, // null when absent -- NOT coerced to 0
    fulfillmentChannel: S(row.fulfillment_channel).trim(), // blank allowed
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
export function nonCancelledDailyRollup(dimRows) {
  const byGrain = new Map();
  for (const r of Array.isArray(dimRows) ? dimRows : []) {
    if (r && r.isCancelled) continue; // cancelled contributes zero to the dashboard rollup
    const key = [S(r.accountId), S(r.saleDate), S(r.sku), S(r.childAsin), S(r.currency)].join("");
    const prev = byGrain.get(key);
    const addValue = orderValuePresent(r.value) ? Number(r.value) : 0; // a non-cancelled units=0 row may have no value
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
