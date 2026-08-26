// OLI DIMENSIONAL contract + authoritative order rules -- deterministic OFFLINE proof of the mandatory
// behaviours for the four new order dimensions (amazon_order_status, fulfillment_channel, address_state,
// address_city). 7-bit ASCII, LF, no top-level await.

import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import {
  normalizeOrderStatus, isCancelledStatus, orderValuePresent, classifyOliDimensionalRow,
  nonCancelledDailyRollup, OliOrderRuleError,
} from "../lib/server/sync/oli-order-rules.js";
import { oliDimensionalRowsFromFragment } from "../lib/server/sync/source-durable-model.js";
import { OLI_SALES_COLUMNS } from "../lib/server/sync/report-source-contracts.js";

let passed = 0;
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// A fragment row at the dimensional grain (what DataDoe returns with the widened group-by).
const frag = (over = {}) => ({
  date: "2026-08-10", seller_or_vendor_id: "S1", sku: "SKU-A", child_asin: "B0A", item_price_currency: "USD",
  amazon_order_status: "Shipped", fulfillment_channel: "AFN", address_state: "CA", address_city: "LA",
  total_sales_sum: 100, total_units_sum: 2, ...over,
});
const accounts = { S1: { accountId: "ACC-1", currency: "USD" }, S2: { accountId: "ACC-2", currency: "USD" } };
const build = (rows) => oliDimensionalRowsFromFragment({ rows, accountsBySellerId: accounts, organizationFingerprint: "org", connectionId: "primary", sourceRequestHash: "h1" });

/* ===== A. the exported contract carries the exact requested columns ===== */

test("A1. OLI_SALES_COLUMNS includes the 4 new dimensions and EXCLUDES address_country + amazon_order_id", () => {
  for (const c of ["date", "seller_or_vendor_id", "sku", "child_asin", "item_price_currency", "amazon_order_status", "fulfillment_channel", "address_state", "address_city"]) {
    assert.ok(OLI_SALES_COLUMNS.includes(c), "missing requested column: " + c);
  }
  assert.ok(!OLI_SALES_COLUMNS.includes("address_country"), "address_country must NOT be requested");
  assert.ok(!OLI_SALES_COLUMNS.includes("amazon_order_id"), "amazon_order_id must NOT be requested");
  assert.equal(OLI_SALES_COLUMNS.length, 9, "exactly 5 kept + 4 added");
});

/* ===== B. status normalization + cancellation ===== */

test("B1. status normalized for comparison only (trim + case-insensitive); CANCELED == CANCELLED", () => {
  assert.equal(normalizeOrderStatus("  Shipped "), "shipped");
  assert.ok(isCancelledStatus("Cancelled"));
  assert.ok(isCancelledStatus("CANCELED"));
  assert.ok(isCancelledStatus("  canceled  "));
  assert.ok(!isCancelledStatus("Shipped"));
  assert.ok(!isCancelledStatus("Pending"));
});

test("B2. cancelled positive-unit rows contribute ZERO business sales/units (kept only for audit)", () => {
  const { byAccount, rollupByAccount, blocked } = build([
    frag({ amazon_order_status: "Shipped", total_sales_sum: 100, total_units_sum: 2 }),
    frag({ amazon_order_status: "Cancelled", total_sales_sum: 999, total_units_sum: 9 }),
    frag({ amazon_order_status: "CANCELED", total_sales_sum: 500, total_units_sum: 5, address_state: "NY" }),
  ]);
  assert.equal(blocked.length, 0);
  // dimensional table keeps ALL 3 rows (audit)
  assert.equal(byAccount.get("ACC-1").length, 3);
  // rollup excludes both cancelled variants -> only the shipped row's 100/2
  const roll = rollupByAccount.get("ACC-1");
  assert.equal(roll.length, 1);
  assert.equal(roll[0].salesAmount, 100);
  assert.equal(roll[0].units, 2);
});

/* ===== C. non-cancelled value rules ===== */

test("C1. a NON-cancelled row with units>0 and a NULL value fails OLI_NON_CANCELLED_VALUE_MISSING (before persistence)", () => {
  const { blocked, byAccount } = build([frag({ amazon_order_status: "Shipped", total_sales_sum: null, total_units_sum: 3 })]);
  assert.equal(blocked.length, 1, "the account is blocked (LKG preserved)");
  assert.equal(blocked[0].code, "OLI_NON_CANCELLED_VALUE_MISSING");
  assert.ok(!byAccount.has("ACC-1"), "no rows written for a refused account");
});

test("C2. a NON-cancelled row with units>0 and a ZERO value also fails (a fabricated zero is invalid)", () => {
  assert.throws(() => classifyOliDimensionalRow(frag({ amazon_order_status: "Shipped", total_sales_sum: 0, total_units_sum: 1 })), (e) => e instanceof OliOrderRuleError && e.code === "OLI_NON_CANCELLED_VALUE_MISSING");
  assert.throws(() => classifyOliDimensionalRow(frag({ amazon_order_status: "Shipped", total_sales_sum: "", total_units_sum: 1 })), (e) => e.code === "OLI_NON_CANCELLED_VALUE_MISSING");
});

test("C3. a CANCELLED row with a null/zero value is FINE (cancelled has no value requirement)", () => {
  const c = classifyOliDimensionalRow(frag({ amazon_order_status: "Cancelled", total_sales_sum: null, total_units_sum: 4 }));
  assert.equal(c.isCancelled, true);
  assert.equal(c.value, null); // never coerced to 0
});

test("C4. a NON-cancelled row with ZERO units and no value is allowed (no units => no value requirement)", () => {
  const c = classifyOliDimensionalRow(frag({ amazon_order_status: "Shipped", total_sales_sum: null, total_units_sum: 0 }));
  assert.equal(c.valuePresent, false);
  assert.equal(c.value, null);
});

test("C5. missing item value is NEVER coerced to 0 before validation (orderValuePresent distinguishes null from 0)", () => {
  assert.equal(orderValuePresent(null), false);
  assert.equal(orderValuePresent(undefined), false);
  assert.equal(orderValuePresent(""), false);
  assert.equal(orderValuePresent("  "), false);
  assert.equal(orderValuePresent(0), true, "an explicit 0 is present (and then rejected as <=0 for non-cancelled units>0)");
});

/* ===== D. missing status fails closed ===== */

test("D1. a row with NO amazon_order_status fails closed OLI_ORDER_STATUS_MISSING (cancellation unclassifiable)", () => {
  assert.throws(() => classifyOliDimensionalRow(frag({ amazon_order_status: "" })), (e) => e.code === "OLI_ORDER_STATUS_MISSING");
  assert.throws(() => classifyOliDimensionalRow(frag({ amazon_order_status: "   " })), (e) => e.code === "OLI_ORDER_STATUS_MISSING");
  const { blocked } = build([frag({ amazon_order_status: "  " })]);
  assert.equal(blocked[0].code, "OLI_ORDER_STATUS_MISSING");
});

/* ===== E. blank state/city allowed (unavailable), never invented, never blocking ===== */

test("E1. blank state/city is allowed as unavailable; a valid sale is NEVER blocked for absent geography", () => {
  const c = classifyOliDimensionalRow(frag({ address_state: "", address_city: "", total_sales_sum: 50, total_units_sum: 1 }));
  assert.equal(c.addressState, "");
  assert.equal(c.addressCity, "");
  const { blocked, rollupByAccount } = build([frag({ address_state: "", address_city: "", total_sales_sum: 50, total_units_sum: 1 })]);
  assert.equal(blocked.length, 0, "no geography never blocks a valid sale");
  assert.equal(rollupByAccount.get("ACC-1")[0].salesAmount, 50);
});

test("E2. geography is never invented: a blank stays blank ('' ), not a placeholder", () => {
  const { byAccount } = build([frag({ address_state: "", address_city: "  ", total_sales_sum: 10, total_units_sum: 1 })]);
  const row = byAccount.get("ACC-1")[0];
  assert.equal(row.address_state, "");
  assert.equal(row.address_city, "");
});

/* ===== F. dimensional rollup reconciles to valid totals across status/fulfillment/state/city ===== */

test("F1. summing valid NON-cancelled rows across every dimension reconciles EXACTLY to the dashboard rollup", () => {
  const rows = [
    frag({ fulfillment_channel: "AFN", address_state: "CA", address_city: "LA", total_sales_sum: 100, total_units_sum: 2 }),
    frag({ fulfillment_channel: "MFN", address_state: "CA", address_city: "SF", total_sales_sum: 60, total_units_sum: 1 }),
    frag({ fulfillment_channel: "AFN", address_state: "NY", address_city: "NYC", total_sales_sum: 40, total_units_sum: 1 }),
    frag({ amazon_order_status: "Cancelled", total_sales_sum: 500, total_units_sum: 5 }), // excluded
  ];
  const { rollupByAccount } = build(rows);
  const roll = rollupByAccount.get("ACC-1");
  // all three non-cancelled rows are the SAME (date, sku, asin, currency) grain -> ONE rollup row summing them
  assert.equal(roll.length, 1);
  assert.equal(roll[0].salesAmount, 200, "100+60+40, cancelled 500 excluded");
  assert.equal(roll[0].units, 4, "2+1+1, cancelled 5 excluded");
  // nonCancelledDailyRollup over canonical dim rows gives the identical total (reconciliation reference)
  const dimCanon = rows.map((r) => ({ accountId: "ACC-1", saleDate: r.date, sku: r.sku, childAsin: r.child_asin, currency: r.item_price_currency, isCancelled: isCancelledStatus(r.amazon_order_status), value: r.total_sales_sum, units: r.total_units_sum, sellerOrVendorId: "S1", sourceRequestHash: "h1" }));
  const ref = nonCancelledDailyRollup(dimCanon);
  assert.equal(ref[0].salesAmount, 200);
  assert.equal(ref[0].units, 4);
});

/* ===== G. no seller/account leakage ===== */

test("G1. rows are attributed to each account ONLY by its own seller id (no cross-account leakage)", () => {
  const { byAccount, rollupByAccount } = build([
    frag({ seller_or_vendor_id: "S1", total_sales_sum: 100, total_units_sum: 1 }),
    frag({ seller_or_vendor_id: "S2", total_sales_sum: 200, total_units_sum: 2 }),
  ]);
  assert.equal(rollupByAccount.get("ACC-1")[0].salesAmount, 100);
  assert.equal(rollupByAccount.get("ACC-2")[0].salesAmount, 200);
  assert.equal(byAccount.get("ACC-1").length, 1);
  assert.equal(byAccount.get("ACC-2").length, 1);
});

test("G2. one account's invalid evidence blocks ONLY that account; the other still persists", () => {
  const { byAccount, blocked } = build([
    frag({ seller_or_vendor_id: "S1", amazon_order_status: "Shipped", total_sales_sum: null, total_units_sum: 3 }), // bad
    frag({ seller_or_vendor_id: "S2", amazon_order_status: "Shipped", total_sales_sum: 200, total_units_sum: 2 }), // good
  ]);
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].accountId, "ACC-1");
  assert.ok(!byAccount.has("ACC-1"), "bad account not written (LKG preserved)");
  assert.equal(byAccount.get("ACC-2").length, 1, "good account still persists");
});

let failures = 0;
for (const t of tests) {
  try { t.fn(); passed += 1; out("  ok  " + t.name); }
  catch (e) { failures += 1; out("FAIL  " + t.name); out(String((e && e.stack) || e)); }
}
out("\n" + passed + " assertions passed" + (failures ? ", " + failures + " FAILED" : ""));
if (failures) process.exitCode = 1;
