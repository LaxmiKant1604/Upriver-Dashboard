// OLI ORDER-VALUE POLICY -- deterministic OFFLINE proof of the authoritative "units have no order value" rules for
// the brand-sales / account Sales Dashboard fold (orderSalesByBrand) and the App.jsx aggregate. The ambiguous
// legacy `sales === 0 && units > 0 => unpriced_units` inference is retired; the displayed warning is driven ONLY by
// the typed `missing_order_value_units` (genuinely NULL/missing order value on non-cancelled units). 7-bit ASCII.
import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { orderSalesByBrand } from "../lib/server/reports/derivation-core.js";
import { classifyOliDimensionalRow } from "../lib/server/sync/oli-order-rules.js";

let passed = 0;
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };
const test = (name, fn) => { try { fn(); passed += 1; out("  ok  " + name); } catch (e) { out("FAIL  " + name); out(String(e && e.stack ? e.stack : e)); process.exitCode = 1; } };

const CAT = [{ child_asin: "B0A", product_brand: "Acme" }, { child_asin: "B0B", product_brand: "Bolt" }];
// One order-line (rollup-grain) row. `val` may be a number, 0, or null (genuinely missing -- never coerced here).
const row = (over = {}) => ({ date: "2026-08-10", seller_or_vendor_id: "S1", seller_or_vendor_name: "Store", marketplace_country_code: "US", item_price_currency: "USD", child_asin: "B0A", total_sales_sum: 100, total_units_sold_sum: 2, ...over });
// The App.jsx warning driver: it sums the TYPED field only (a legacy `unpriced_units` is intentionally ignored).
const aggregateMissing = (rows) => rows.reduce((s, r) => s + (r.missing_order_value_units || 0), 0);
const aggregateUnits = (rows) => rows.reduce((s, r) => s + (r.total_units_sold || 0), 0);
const aggregateSales = (rows) => rows.reduce((s, r) => s + (r.total_sales || 0), 0);

/* (1) Cancelled rows never reach this fold (the durable rollup excludes them); classify proves zero contribution. */
test("1. cancelled row: audit only, zero business contribution, never a missing-value warning", () => {
  const c = classifyOliDimensionalRow({ amazon_order_status: "Cancelled", total_units_sum: 5, total_sales_sum: 999 });
  assert.equal(c.isCancelled, true);
  assert.equal(c.contributesToRollup, false, "cancelled contributes zero sales + zero units to the rollup the fold reads");
});

/* (2) Present-zero (shipped promotional/replacement/free) -> zero sales, zero units, NO warning. */
test("2. non-cancelled PRESENT-zero value: zero sales, zero units, no missing warning", () => {
  const out = orderSalesByBrand([row({ total_sales_sum: 0, total_units_sold_sum: 3 })], CAT);
  assert.equal(out.length, 1);
  assert.equal(out[0].total_sales, 0);
  assert.equal(out[0].total_units_sold, 0, "a present-zero unit contributes zero business units");
  assert.equal(out[0].missing_order_value_units, 0, "present-zero is never a missing-value defect");
  assert.equal(out[0].unpriced_units, undefined, "the ambiguous legacy field is gone");
});

/* (3) Genuinely NULL/missing value -> typed evidence, never coerced, units NOT counted. */
test("3. non-cancelled MISSING (null) value: typed evidence, no fabricated sales, units excluded from Units Sold", () => {
  const out = orderSalesByBrand([row({ total_sales_sum: null, total_units_sold_sum: 4 })], CAT);
  assert.equal(out[0].total_sales, 0, "no fabricated sales");
  assert.equal(out[0].total_units_sold, 0, "missing-value units are NOT Units Sold");
  assert.equal(out[0].missing_order_value_units, 4, "surfaced ONLY as typed missing-value evidence");
});

/* (4) Normal positive value -> contributes sales + units. */
test("4. non-cancelled positive value: contributes Total Sales and Units Sold", () => {
  const out = orderSalesByBrand([row({ total_sales_sum: 100, total_units_sold_sum: 2 })], CAT);
  assert.equal(out[0].total_sales, 100);
  assert.equal(out[0].total_units_sold, 2);
  assert.equal(out[0].missing_order_value_units, 0);
});

/* (5) Mixed rows same date/ASIN/account -> exact totals and classification. */
test("5. mixed positive + present-zero + missing on the same date/ASIN/brand: exact split", () => {
  const out = orderSalesByBrand([
    row({ total_sales_sum: 100, total_units_sold_sum: 2 }),
    row({ total_sales_sum: 0, total_units_sold_sum: 3 }),
    row({ total_sales_sum: null, total_units_sold_sum: 4 }),
  ], CAT);
  assert.equal(out.length, 1, "one brand/date/currency group");
  assert.equal(out[0].total_sales, 100, "only the positive value's sales");
  assert.equal(out[0].total_units_sold, 2, "only the positive value's units (present-zero + missing excluded)");
  assert.equal(out[0].missing_order_value_units, 4, "only the genuinely-missing units are typed evidence");
});

/* (6) Account / date / brand / currency isolation. */
test("6. account / date / brand / currency isolation -- no leakage across groups", () => {
  const out = orderSalesByBrand([
    row({ seller_or_vendor_id: "S1", total_sales_sum: 100, total_units_sold_sum: 2 }),
    row({ seller_or_vendor_id: "S2", total_sales_sum: 0, total_units_sold_sum: 9 }),   // other account: present-zero
    row({ date: "2026-08-11", total_sales_sum: null, total_units_sold_sum: 5 }),        // other date: missing
    row({ child_asin: "B0B", total_sales_sum: 50, total_units_sold_sum: 1 }),           // other brand
    row({ item_price_currency: "EUR", total_sales_sum: 7, total_units_sold_sum: 1 }),   // other currency
  ], CAT);
  const g = (pred) => out.find(pred);
  assert.equal(g((x) => x.seller_or_vendor_id === "S1" && x.date === "2026-08-10" && x.product_brand === "Acme" && x.currency === "USD").total_units_sold, 2);
  assert.equal(g((x) => x.seller_or_vendor_id === "S2").total_units_sold, 0, "S2 present-zero stays in S2 and counts zero");
  assert.equal(g((x) => x.date === "2026-08-11").missing_order_value_units, 5, "the missing units belong only to their own date group");
  assert.equal(g((x) => x.product_brand === "Bolt").total_sales, 50);
  assert.equal(g((x) => x.currency === "EUR").total_sales, 7, "currency never merged/converted");
  // The other groups carry no missing evidence.
  assert.equal(g((x) => x.seller_or_vendor_id === "S1" && x.date === "2026-08-10" && x.currency === "USD").missing_order_value_units, 0);
});

/* (7) A legacy payload carrying only `unpriced_units` cannot resurrect the warning. */
test("7. legacy payload with unpriced_units cannot be served as corrected (aggregate ignores it)", () => {
  const legacyRows = [{ total_units_sold: 10, total_sales: 500, unpriced_units: 118 }]; // OLD shape, no typed field
  assert.equal(aggregateMissing(legacyRows), 0, "the warning driver reads ONLY missing_order_value_units");
  const correctedRows = orderSalesByBrand([row({ total_sales_sum: 0, total_units_sold_sum: 118 })], CAT);
  assert.equal(correctedRows[0].unpriced_units, undefined, "a corrected payload never carries unpriced_units");
});

/* (11) Production-shaped regression matching the screenshot: 118 present-zero units do NOT show the banner. */
test("11. screenshot regression: 118 present-zero units -> banner driver is 0 (no 'no order value' warning)", () => {
  const rows = Array.from({ length: 84 }, (_v, i) => row({ child_asin: "B0A", sku: "SKU" + i, total_sales_sum: 0, total_units_sold_sum: i < 34 ? 2 : 1 }));
  const out = orderSalesByBrand(rows, CAT);
  assert.equal(aggregateMissing(out), 0, "present-zero units never drive the warning");
  assert.equal(aggregateUnits(out), 0, "present-zero units are excluded from Units Sold");
  assert.equal(aggregateSales(out), 0);
});

/* (12) A true NULL/missing case shows an honest typed warning WITHOUT adding those units to Units Sold. */
test("12. true missing-value case: typed warning > 0, and those units are NOT in Units Sold", () => {
  const out = orderSalesByBrand([
    row({ total_sales_sum: 200, total_units_sold_sum: 5 }),
    row({ total_sales_sum: null, total_units_sold_sum: 7 }),
  ], CAT);
  assert.equal(aggregateMissing(out), 7, "honest typed missing-value warning");
  assert.equal(aggregateUnits(out), 5, "Units Sold excludes the missing-value units");
  assert.equal(aggregateSales(out), 200, "Total Sales never fabricated for missing values");
});

out("\n" + passed + " assertions passed");
