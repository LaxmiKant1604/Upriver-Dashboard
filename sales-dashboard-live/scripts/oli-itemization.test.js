// OLI PROVISIONAL / FINAL two-layer model -- deterministic OFFLINE proof that a real-time D-1 export PUBLISHES the
// itemized data immediately (labelled provisional while some order shells are not yet itemized), never fabricating a
// missing value, and blocks ONLY a genuine itemized-value defect. item_status is the completion signal (PROVEN in
// raw source 89b27535d2): item_status present -> itemized (priced); blank / Pending + null price -> expected pending
// itemization (published provisional, counted separately, NEVER coerced to 0); itemized recognized-sale + null price
// -> genuine defect (OLI_ITEMIZED_VALUE_MISSING, that account keeps LKG). item_price_value is the only sales field.
// 7-bit ASCII, LF.
import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { classifyOliDimensionalRow } from "../lib/server/sync/oli-order-rules.js";
import { oliDimensionalRowsFromFragment, oliDateCompleteness } from "../lib/server/sync/source-durable-model.js";
import { OLI_SALES_COLUMNS, OLI_SALES_AGGREGATIONS } from "../lib/server/sync/report-source-contracts.js";
import { sourceRequestIdentity } from "../lib/server/source-identity.js";

let passed = 0;
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };
const test = (name, fn) => { try { fn(); passed += 1; out("  ok  " + name); } catch (e) { out("FAIL  " + name); out(String(e && e.stack ? e.stack : e)); process.exitCode = 1; } };

const D = "2026-08-26";
const frag = (over = {}) => ({
  date: D, seller_or_vendor_id: "S1", sku: "SKU-A", child_asin: "B0A", item_price_currency: "USD",
  amazon_order_status: "Shipped", item_status: "Shipped", fulfillment_channel: "AFN", address_state: "CA", address_city: "LA",
  amazon_order_id: "111-1", total_sales_sum: 100, total_units_sum: 2, ...over,
});
const accounts = { S1: { accountId: "ACC-1", currency: "USD" }, S2: { accountId: "ACC-2", currency: "USD" } };
const build = (rows) => oliDimensionalRowsFromFragment({ rows, accountsBySellerId: accounts, organizationFingerprint: "org", connectionId: "primary", sourceRequestHash: "h1" });
const comp = (r, acc = "ACC-1", date = D) => r.completenessByAccount.get(acc).byDate.get(date);

/* ===== 1. exact D-1 export with pending itemization PUBLISHES provisional (not blocked, not not-ready) ===== */
test("1. a D-1 window with some pending order shells PUBLISHES the itemized data as PROVISIONAL (never blocked)", () => {
  const r = build([
    frag({ item_status: "Shipped", amazon_order_id: "O1", total_sales_sum: 100, total_units_sum: 2 }), // itemized
    frag({ item_status: "", amazon_order_id: "O2", total_sales_sum: null, total_units_sum: 3 }),          // pending shell
  ]);
  assert.equal(r.blocked.length, 0, "pending itemization NEVER blocks / holds -- it publishes provisionally");
  assert.ok(r.byAccount.has("ACC-1"), "the itemized window is published");
  assert.equal(comp(r).completenessStatus, "provisional");
  assert.equal(comp(r).itemizedOrderCount, 1);
  assert.equal(comp(r).pendingOrderCount, 1);
  assert.equal(comp(r).itemizationPercent, 50);
});

/* ===== 2. a fully-itemized D-1 window publishes FINAL ===== */
test("2. a D-1 window with every recognized sale itemized publishes FINAL (100%)", () => {
  const r = build([
    frag({ item_status: "Shipped", amazon_order_id: "O1", total_sales_sum: 100, total_units_sum: 2 }),
    frag({ item_status: "Unshipped", amazon_order_id: "O2", total_sales_sum: 50, total_units_sum: 1 }),
  ]);
  assert.equal(r.blocked.length, 0);
  assert.equal(comp(r).completenessStatus, "final");
  assert.equal(comp(r).pendingOrderCount, 0);
  assert.equal(comp(r).itemizationPercent, 100);
});

/* ===== 3. provisional Total Sales uses ONLY actual itemized values (pending excluded, never fabricated) ===== */
test("3. provisional sales = itemized values ONLY; pending contributes nothing (never fabricated/estimated)", () => {
  const r = build([
    frag({ item_status: "Shipped", amazon_order_id: "O1", sku: "A", total_sales_sum: 100, total_units_sum: 2 }),
    frag({ item_status: "", amazon_order_id: "O2", sku: "B", total_sales_sum: null, total_units_sum: 9 }), // pending
  ]);
  const roll = r.rollupByAccount.get("ACC-1");
  assert.equal(roll.reduce((s, x) => s + x.salesAmount, 0), 100, "only the itemized 100");
  assert.equal(roll.reduce((s, x) => s + x.units, 0), 2, "only the itemized 2 units");
});

/* ===== 4. pending units + orders are VISIBLE separately, never mixed into itemized totals ===== */
test("4. pending unit/order counts are surfaced separately from the itemized totals", () => {
  const r = build([
    frag({ item_status: "Shipped", amazon_order_id: "O1", total_sales_sum: 100, total_units_sum: 2 }),
    frag({ item_status: "", amazon_order_id: "O2", total_sales_sum: null, total_units_sum: 4 }),
    frag({ amazon_order_status: "Pending", item_status: "", amazon_order_id: "O3", total_sales_sum: null, total_units_sum: 1 }),
  ]);
  const c = comp(r);
  assert.equal(c.itemizedUnitCount, 2);
  assert.equal(c.pendingUnitCount, 5, "4 not-itemized + 1 pre-sale units");
  assert.equal(c.pendingOrderCount, 2);
  assert.equal(c.itemizedOrderCount, 1);
});

/* ===== 5. NULL price is never coerced to zero ===== */
test("5. a missing value stays null in the classification (never coerced to 0)", () => {
  assert.equal(classifyOliDimensionalRow(frag({ item_status: "", total_sales_sum: null, total_units_sum: 1 })).value, null);
  assert.equal(classifyOliDimensionalRow(frag({ item_status: "", total_sales_sum: "", total_units_sum: 1 })).valuePresent, false);
});

/* ===== 6. cancelled rows contribute zero and never block ===== */
test("6. cancelled rows contribute zero, never block, and do not count toward itemization", () => {
  const r = build([
    frag({ amazon_order_status: "Cancelled", item_status: "", amazon_order_id: "C1", total_sales_sum: null, total_units_sum: 5 }),
    frag({ item_status: "Shipped", amazon_order_id: "O1", total_sales_sum: 80, total_units_sum: 1 }),
  ]);
  assert.equal(r.blocked.length, 0);
  assert.equal(r.rollupByAccount.get("ACC-1").reduce((s, x) => s + x.salesAmount, 0), 80);
  assert.equal(comp(r).completenessStatus, "final", "a cancelled order is not a pending order -> still final");
  assert.equal(comp(r).pendingOrderCount, 0);
});

/* ===== 7. explicit-zero approved rows contribute zero, remain audited, count as itemized (resolved) ===== */
test("7. explicit present-zero rows contribute zero, are audited, and count as itemized (resolved, not pending)", () => {
  const r = build([
    frag({ item_status: "Shipped", amazon_order_id: "O1", sku: "FREE", total_sales_sum: 0, total_units_sum: 4 }),
    frag({ item_status: "Shipped", amazon_order_id: "O2", sku: "PAID", total_sales_sum: 100, total_units_sum: 2 }),
  ]);
  assert.equal(r.blocked.length, 0);
  assert.equal(r.rollupByAccount.get("ACC-1")[0].salesAmount, 100, "only PAID contributes");
  assert.equal(comp(r).completenessStatus, "final");
  assert.equal(comp(r).itemizedOrderCount, 2, "the zero-priced order is resolved (itemized), not pending");
});

/* ===== 8. an itemized recognized-sale with a null value is a GENUINE defect -> that account keeps LKG ===== */
test("8. an itemized recognized-sale null value BLOCKS only that account (OLI_ITEMIZED_VALUE_MISSING); others publish", () => {
  const r = build([
    frag({ seller_or_vendor_id: "S1", item_status: "Shipped", amazon_order_id: "O1", total_sales_sum: null, total_units_sum: 2 }), // defect
    frag({ seller_or_vendor_id: "S2", item_status: "Shipped", amazon_order_id: "O9", total_sales_sum: 90, total_units_sum: 1 }),   // ok
  ]);
  const d = r.blocked.find((b) => b.accountId === "ACC-1");
  assert.ok(d && d.code === "OLI_ITEMIZED_VALUE_MISSING");
  assert.ok(!r.byAccount.has("ACC-1"), "defect account keeps LKG (nothing published)");
  assert.ok(r.byAccount.has("ACC-2"), "a defect on one account never blocks another");
  assert.ok(!r.completenessByAccount.has("ACC-1"), "a blocked account gets no provisional/final completeness (source-defect is recorded by the caller)");
});

/* ===== 9. item_price_value is the only canonical sales field (no alternate/fabricated value) ===== */
test("9. the OLI contract sums item_price_value for sales (proven canonical field; no total_sales alternate)", () => {
  const salesAgg = OLI_SALES_AGGREGATIONS.find((a) => a.alias === "total_sales_sum");
  assert.equal(salesAgg.column, "item_price_value");
  assert.ok(OLI_SALES_COLUMNS.includes("item_status"));
});

/* ===== 10. corrected request identity cannot adopt a stale wrong-projection export ===== */
test("10. item_status is folded into the OLI request_hash (a stale pre-item_status export cannot be adopted)", () => {
  const base = { apiKey: "k", sourceId: "89b27535d2", ids: ["S1"], from: "2026-08-20", to: D, limit: 5000,
    options: { groupBy: OLI_SALES_COLUMNS, aggregations: OLI_SALES_AGGREGATIONS, orderByColumn: "date", orderByDirection: "ASC" } };
  const withItem = sourceRequestIdentity({ ...base, columns: OLI_SALES_COLUMNS }).requestHash;
  const withoutItem = sourceRequestIdentity({ ...base, columns: OLI_SALES_COLUMNS.filter((c) => c !== "item_status"), options: { ...base.options, groupBy: OLI_SALES_COLUMNS.filter((c) => c !== "item_status") } }).requestHash;
  assert.notEqual(withItem, withoutItem);
});

/* ===== 11. a mixed batch partitions per account (provisional publishes, defect blocks, no leakage) ===== */
test("11. a mixed batch: provisional + final accounts publish; only a defect account is blocked", () => {
  const rows = [];
  for (let i = 0; i < 4; i += 1) accounts["M" + i] = { accountId: "MACC-" + i, currency: "USD" };
  rows.push(frag({ seller_or_vendor_id: "M0", item_status: "Shipped", amazon_order_id: "a", total_sales_sum: 10, total_units_sum: 1 })); // final
  rows.push(frag({ seller_or_vendor_id: "M1", item_status: "Shipped", amazon_order_id: "b", total_sales_sum: 10, total_units_sum: 1 }));
  rows.push(frag({ seller_or_vendor_id: "M1", item_status: "", amazon_order_id: "c", total_sales_sum: null, total_units_sum: 1 }));   // -> M1 provisional
  rows.push(frag({ seller_or_vendor_id: "M2", item_status: "Shipped", amazon_order_id: "d", total_sales_sum: null, total_units_sum: 1 })); // defect
  const r = build(rows);
  assert.equal(comp(r, "MACC-0").completenessStatus, "final");
  assert.equal(comp(r, "MACC-1").completenessStatus, "provisional");
  assert.ok(r.blocked.find((b) => b.accountId === "MACC-2" && b.code === "OLI_ITEMIZED_VALUE_MISSING"));
  assert.ok(r.byAccount.has("MACC-0") && r.byAccount.has("MACC-1") && !r.byAccount.has("MACC-2"));
});

/* ===== 12. oliDateCompleteness: an order that is PARTIALLY itemized counts as pending (not final) ===== */
test("12. an order with any not-yet-itemized line is PENDING (partial != final); percent is order-based", () => {
  const r = build([
    frag({ item_status: "Shipped", amazon_order_id: "O1", sku: "A", total_sales_sum: 40, total_units_sum: 1 }), // O1 itemized line
    frag({ item_status: "", amazon_order_id: "O1", sku: "B", total_sales_sum: null, total_units_sum: 1 }),        // O1 pending line
    frag({ item_status: "Shipped", amazon_order_id: "O2", total_sales_sum: 60, total_units_sum: 1 }),             // O2 fully itemized
  ]);
  const c = comp(r);
  assert.equal(c.pendingOrderCount, 1, "O1 is pending (has a not-yet-itemized line)");
  assert.equal(c.itemizedOrderCount, 1, "only O2 is fully itemized");
  assert.equal(c.completenessStatus, "provisional");
});

/* ===== 13. a zero-non-cancelled-order date is trivially FINAL (100%), never a false provisional ===== */
test("13. oliDateCompleteness of a date with no non-cancelled orders is final/100 (never a stuck provisional)", () => {
  const c = oliDateCompleteness({ orders: new Map(), itemizedUnits: 0, pendingUnits: 0 });
  assert.equal(c.completenessStatus, "final");
  assert.equal(c.itemizationPercent, 100);
});

/* ===== 14. per-date completeness: today provisional, an older fully-itemized date final ===== */
test("14. completeness is PER DATE: an older fully-itemized date is final while D-1 is provisional", () => {
  const r = build([
    frag({ date: "2026-08-20", item_status: "Shipped", amazon_order_id: "P1", total_sales_sum: 30, total_units_sum: 1 }), // older, itemized
    frag({ date: D, item_status: "Shipped", amazon_order_id: "O1", total_sales_sum: 100, total_units_sum: 2 }),
    frag({ date: D, item_status: "", amazon_order_id: "O2", total_sales_sum: null, total_units_sum: 1 }),                    // D-1 pending
  ]);
  assert.equal(comp(r, "ACC-1", "2026-08-20").completenessStatus, "final");
  assert.equal(comp(r, "ACC-1", D).completenessStatus, "provisional");
});

/* ===== 15. pre-sale Pending null value is pending itemization (published provisional), never a defect ===== */
test("15. a Pending-status null-value order is pending itemization (provisional), never a defect", () => {
  const p = classifyOliDimensionalRow(frag({ amazon_order_status: "Pending", item_status: "", total_sales_sum: null, total_units_sum: 1 }));
  assert.equal(p.pending, true);
  assert.equal(p.pendingReason, "pre-sale-pending");
  assert.equal(p.defect, false);
  const r = build([frag({ amazon_order_status: "Pending", item_status: "", amazon_order_id: "O1", total_sales_sum: null, total_units_sum: 1 })]);
  assert.equal(r.blocked.length, 0);
  assert.equal(comp(r).completenessStatus, "provisional");
});

out("\n" + passed + " assertions passed");
