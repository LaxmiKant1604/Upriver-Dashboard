// Authoritative Order Line Items order rules -- the PURE, testable core shared by the JS persist path and
// mirrored by the atomic replace_oli_dimensional_window RPC. These rules govern how the four new dimensions
// (amazon_order_status, fulfillment_channel, address_state, address_city) are normalized, validated, and rolled
// up so that:
//   - a missing order status is INVALID (cancellation cannot be classified) -> OLI_ORDER_STATUS_MISSING;
//   - status is normalized ONLY for comparison (trim + lower-case); 'canceled' == 'cancelled';
//   - cancelled rows are kept for audit but contribute ZERO to the dashboard rollup (sales/units/orders);
//   - a NON-cancelled positive-unit row with a MISSING order value is classified by the ITEM-LEVEL signal
//     (item_status), never coerced to 0: (a) not-yet-itemized (item_status blank) or a pre-sale Pending order is
//     PENDING -- an expected, transient Amazon item-level lag that is audited, contributes zero, and HOLDS the
//     account window (honest wait), reported as OLI_D1_PENDING_ITEMIZATION; (b) an ITEMIZED recognized-sale
//     (item_status present, not Pending) with a genuinely null value is a real DEFECT, reported as
//     OLI_ITEMIZED_VALUE_MISSING, blocking only its account. A PRESENT-but-zero value is a REAL zero-priced unit
//     (promotional / replacement / free): kept for audit, treated LIKE a cancelled row -- contributing ZERO sales
//     AND units -- and NEVER blocks (`contributesToRollup` is true only when not-cancelled AND value present AND
//     value > 0);
//   - blank state/city is allowed (stored '') and never blocks an otherwise-valid sale;
//   - amazon_order_id is AUDIT-ONLY: it is trimmed to a canonical form and NEVER blocks a window. A blank/missing
//     Order ID is stored '' with orderIdAvailable=false (never fabricated, never copied from another row) so a
//     distinct order can never masquerade under a neighbour's ID. It contributes NOTHING to sales/units/rollup.

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

// The CANONICAL Amazon Order ID: trimmed only (Amazon Order IDs are case-sensitive, e.g. "123-4567890-1234567").
// A blank/whitespace/null source value canonicalizes to '' -- an UNAVAILABLE Order ID, never a valid identity.
export function canonicalizeOrderId(v) {
  return S(v).trim();
}

// Redact a full Order ID for logs/errors: keep only the first segment prefix so distinct orders stay distinguishable
// in diagnostics without ever leaking a complete, replayable identifier. '' (unavailable) redacts to '(none)'.
export function redactOrderId(v) {
  const id = canonicalizeOrderId(v);
  if (id === "") return "(none)";
  const head = id.split("-")[0] || id.slice(0, 3);
  return `${head}…`;
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

// The exact presentation state for an Amazon Order ID cell in the explicit-zero breakdown. PURE + shared by the
// server reader shaping and the React UI so both agree. Three states, never a fabricated ID:
//   - captured    : a future audit row with a real captured Order ID -> show it (copyable);
//   - unavailable  : a future audit row whose SOURCE had no Order ID -> "Order ID unavailable from source";
//   - not-captured : a row with NO audit evidence at all (historical, before tracking) -> "Not captured ...".
// `row` carries { hasAudit (an order-audit row exists for this grain), orderIdAvailable, amazonOrderId|orderId }.
export function orderIdDisplayState(row) {
  const id = canonicalizeOrderId(row && (row.amazonOrderId ?? row.orderId ?? row.amazon_order_id));
  if (!row || !row.hasAudit) {
    return { kind: "not-captured", text: "Not captured — before Order ID tracking", orderId: "" };
  }
  if (row.orderIdAvailable && id !== "") {
    return { kind: "captured", text: id, orderId: id };
  }
  return { kind: "unavailable", text: "Order ID unavailable from source", orderId: "" };
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
  const isPendingOrder = normalizeOrderStatus(status) === "pending"; // Amazon pre-sale: order placed, payment not confirmed
  const units = Number(row.total_units_sum ?? 0);
  if (!Number.isFinite(units)) {
    throw new OliOrderRuleError("OLI_MALFORMED_ROW", "a row carries a non-finite units value", { date: S(row.date ?? row.sale_date) });
  }
  const valuePresent = orderValuePresent(row.total_sales_sum);
  const value = valuePresent ? Number(row.total_sales_sum) : null;
  if (valuePresent && !Number.isFinite(value)) {
    throw new OliOrderRuleError("OLI_MALFORMED_ROW", "a row carries a non-finite order value", { date: S(row.date ?? row.sale_date) });
  }
  // ITEM-LEVEL completion signal. PROVEN (raw source 89b27535d2): Amazon populates the per-line item detail
  // (item_status / amazon_order_item_id / item_price_value) over ~1-2 days AFTER the order is placed. On the D+1
  // run only a fraction of D-1 orders are itemized; the rest are order-level shells whose item_status is blank and
  // whose item_price_value is genuinely null in the raw response (NOT lost in our SUM). So a missing value is NOT
  // uniformly "incorrect evidence": item_status distinguishes an expected, transient item-level lag from a real
  // data defect.
  const itemStatus = S(row.item_status).trim();
  const itemized = itemStatus !== ""; // has per-line detail -> Amazon has recognized/priced the item
  // Classify a NON-cancelled positive-unit row whose value is MISSING (never fabricate a zero):
  //   - not-yet-itemized (item_status blank) OR a pre-sale Pending order -> PENDING: expected item-level lag,
  //     audited, contributes zero, and HOLDS the window (honest wait) -- it is not a defect.
  //   - itemized recognized-sale (item_status present, not Pending) with a genuinely null value -> DEFECT: a real
  //     source-data problem that blocks only its account.
  let pending = false;
  let pendingReason = null;
  let defect = false;
  if (!cancelled && units > 0 && !valuePresent) {
    if (itemized && !isPendingOrder) {
      defect = true;
    } else {
      pending = true;
      pendingReason = isPendingOrder ? "pre-sale-pending" : "not-itemized";
    }
  }
  // A row contributes real sales/units to the dashboard rollup ONLY when it is not cancelled AND carries a
  // present, strictly-positive value. A cancelled row OR a present-but-zero-value non-cancelled unit (a real
  // zero-priced / promotional / replacement unit) contributes ZERO -- it stays in the dimensional table for audit.
  const contributesToRollup = !cancelled && valuePresent && value > 0;
  return {
    status,
    statusNormalized: normalizeOrderStatus(status),
    isCancelled: cancelled,
    isPendingOrder,
    itemStatus,
    itemized,
    pending,           // not-yet-itemized / pre-sale: expected item-level lag (audited, holds the window)
    pendingReason,     // "not-itemized" | "pre-sale-pending" | null
    defect,            // itemized recognized-sale with a genuinely missing value: a REAL source-data defect
    units,
    valuePresent,
    value, // null when absent -- NOT coerced to 0
    contributesToRollup,
    fulfillmentChannel: S(row.fulfillment_channel).trim(),                    // RAW, preserved for audit (blank allowed)
    fulfillmentCategory: normalizeFulfillmentChannel(row.fulfillment_channel), // ONE canonical presentation bucket
    addressState: S(row.address_state).trim(),             // blank allowed (unavailable)
    addressCity: S(row.address_city).trim(),               // blank allowed (unavailable)
    orderId: canonicalizeOrderId(row.amazon_order_id),     // AUDIT-ONLY, canonical (blank '' = unavailable)
    orderIdAvailable: canonicalizeOrderId(row.amazon_order_id) !== "", // true ONLY for a real captured ID
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
