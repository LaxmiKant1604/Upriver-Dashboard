// OLI DATA-QUALITY summaries -- PURE, transport-free. Turns already-read dimensional OLI grain rows into the
// honest, class-separated quality indicators the dashboards display. This NEVER touches business Sales/Units (that
// is the corrected positive-value rollup); it only surfaces the SEPARATE audit classes so a user can see a
// potential sales gap without treating excluded units as confirmed sales.
//
// The three classes are kept STRICTLY separate (never combined):
//   - CANCELLED (is_cancelled) .................. audit only; no Sales/Units; no warning.
//   - EXPLICIT-ZERO (non-cancelled, order value PRESENT and numerically == 0, units > 0) .. audit only; no
//     Sales/Units; an INFORMATIONAL notice (may be promotional/replacement/free/incomplete -- never "definitely
//     missing sales").
//   - MISSING (non-cancelled, order value NULL/blank) ... the typed missing_order_value_units warning (a DIFFERENT
//     indicator). NOTE: the durable dimensional table cannot contain a MISSING row -- replace_oli_dimensional_window
//     refuses the whole window (OLI_NON_CANCELLED_VALUE_MISSING) and preserves LKG -- so a durable read yields none.
//
// Only fields already persisted in source_oli_dimensional_history are exposed (date, sku, child_asin, status,
// fulfillment, state, city, counts). amazon_order_id and address_country are NEVER requested or shown.

import { normalizeFulfillmentChannel } from "../sync/oli-order-rules.js";
import { brandKey } from "./brand-membership.js";

const S = (v) => (v == null ? "" : String(v));
const isPresentZero = (v) => v != null && S(v).trim() !== "" && Number(v) === 0;

// child_asin -> product_brand map from saved Product Catalog rows (the ONLY sanctioned attribution).
export function brandByAsinFromCatalog(catalogRows = []) {
  const m = new Map();
  for (const cr of Array.isArray(catalogRows) ? catalogRows : []) {
    const asin = S(cr && (cr.child_asin ?? cr.childAsin)).trim();
    const brand = S(cr && (cr.product_brand ?? cr.productBrand ?? cr.brand)).trim();
    if (asin && brand) m.set(asin, brand);
  }
  return m;
}

/**
 * Summarize EXPLICIT-ZERO non-cancelled units from already-read dimensional grain rows, scoped by brand.
 * `rows` are dimensional grain rows carrying { sale_date, sku, child_asin, currency, amazon_order_status,
 * fulfillment_channel, address_state, address_city, total_units_sum, is_cancelled?, total_sales_sum? }. The reader
 * should already restrict to non-cancelled present-zero positive-unit rows; this function ALSO re-checks each row
 * (defence in depth) so a cancelled / NULL-value / non-zero / zero-unit row can never slip into the indicator.
 *
 * brand:
 *   "ALL" (default) -> every explicit-zero row for the account/date range;
 *   a named brand    -> ONLY rows whose child_asin maps to that brand through the Catalog map; an UNMAPPED child
 *                       asin is NEVER attributed to a selected brand.
 * Currency/marketplace stay isolated (kept in the grain key, never merged/converted).
 * Returns { totalUnits, rowCount, currencies, brand, breakdown: [{date, sku, childAsin, status, fulfillment,
 * state, city, rows, units}] } (breakdown newest-date first). Avoids double-counting: one dimensional grain row is
 * counted exactly once.
 */
export function summarizeExplicitZeroOli(rows, { catalogRows = [], brandByAsin = null, brand = "ALL" } = {}) {
  const map = brandByAsin instanceof Map ? brandByAsin : brandByAsinFromCatalog(catalogRows);
  const wantBrand = S(brand).trim();
  const wantKey = wantBrand && wantBrand.toUpperCase() !== "ALL" ? brandKey(wantBrand) : null;
  const breakdown = new Map();
  const currencies = new Set();
  let totalUnits = 0;
  let rowCount = 0;
  for (const r of Array.isArray(rows) ? rows : []) {
    // Defence in depth: never count a cancelled, NULL-value, non-zero-value, or non-positive-unit row.
    if (r && (r.is_cancelled === true || r.isCancelled === true)) continue;
    if ("total_sales_sum" in (r || {}) && !isPresentZero(r.total_sales_sum)) continue;
    const units = Number(r && (r.total_units_sum ?? r.units)) || 0;
    if (!(units > 0)) continue;
    const childAsin = S(r.child_asin ?? r.childAsin).trim();
    if (wantKey) {
      const mapped = map.get(childAsin);
      if (!mapped || brandKey(mapped) !== wantKey) continue; // unmapped / other brand never leaks into a selected brand
    }
    const currency = S(r.currency ?? r.item_price_currency);
    const key = [S(r.sale_date), S(r.sku), childAsin, currency, S(r.amazon_order_status), S(r.fulfillment_channel), S(r.address_state), S(r.address_city)].join("");
    const cur = breakdown.get(key) || {
      date: S(r.sale_date), sku: S(r.sku), childAsin, currency,
      status: S(r.amazon_order_status), fulfillment: normalizeFulfillmentChannel(r.fulfillment_channel),
      state: S(r.address_state), city: S(r.address_city), rows: 0, units: 0,
    };
    cur.rows += 1;
    cur.units += units;
    breakdown.set(key, cur);
    totalUnits += units;
    rowCount += 1;
    if (currency) currencies.add(currency);
  }
  const list = [...breakdown.values()].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0)));
  return { brand: wantKey ? wantBrand : "ALL", totalUnits, rowCount, currencies: [...currencies].sort(), breakdown: list };
}
