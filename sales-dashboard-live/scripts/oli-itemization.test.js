// OLI ITEM-LEVEL ITEMIZATION state machine -- deterministic OFFLINE proof that a MISSING item_price_value is
// classified by the per-line item_status signal (PROVEN in raw source 89b27535d2: a null value corresponds to a
// blank item_status = an order-level shell Amazon has not yet itemized ~1-2 days after placement). The policy:
//   - not-yet-itemized (item_status blank) OR pre-sale Pending -> PENDING (audited, contributes zero, HOLDS the
//     account window as OLI_D1_PENDING_ITEMIZATION -- an expected transient lag, honest wait, LKG preserved);
//   - itemized recognized-sale (item_status present, not Pending) with a null value -> real DEFECT
//     (OLI_ITEMIZED_VALUE_MISSING, blocks only its account);
//   - cancelled / explicit-zero -> zero contribution, never a defect, never a hold; NULL is never coerced to 0.
// item_price_value is the ONLY canonical sales field in the source (no total_sales column); no alternate/fabricated
// value is ever used. Adding item_status changes every OLI request_hash so a stale wrong-projection export cannot
// be adopted. 7-bit ASCII, LF.
import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { classifyOliDimensionalRow, nonCancelledDailyRollup, isCancelledStatus } from "../lib/server/sync/oli-order-rules.js";
import { oliDimensionalRowsFromFragment, oliItemizationDetail } from "../lib/server/sync/source-durable-model.js";
import { OLI_SALES_COLUMNS, OLI_SALES_AGGREGATIONS } from "../lib/server/sync/report-source-contracts.js";
import { sourceRequestIdentity } from "../lib/server/source-identity.js";

let passed = 0;
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };
const test = (name, fn) => { try { fn(); passed += 1; out("  ok  " + name); } catch (e) { out("FAIL  " + name); out(String(e && e.stack ? e.stack : e)); process.exitCode = 1; } };

const frag = (over = {}) => ({
  date: "2026-08-26", seller_or_vendor_id: "S1", sku: "SKU-A", child_asin: "B0A", item_price_currency: "USD",
  amazon_order_status: "Shipped", item_status: "Shipped", fulfillment_channel: "AFN", address_state: "CA", address_city: "LA",
  amazon_order_id: "111-1", total_sales_sum: 100, total_units_sum: 2, ...over,
});
const accounts = { S1: { accountId: "ACC-1", currency: "USD" }, S2: { accountId: "ACC-2", currency: "USD" } };
const build = (rows) => oliDimensionalRowsFromFragment({ rows, accountsBySellerId: accounts, organizationFingerprint: "org", connectionId: "primary", sourceRequestHash: "h1" });

/* ===== 1. real-time D-1 with priced Shipped rows persists correctly (no hold, no block) ===== */
test("1. an all-itemized+priced account persists and advances (no hold, no block)", () => {
  const { blocked, byAccount, rollupByAccount } = build([
    frag({ item_status: "Shipped", total_sales_sum: 100, total_units_sum: 2, sku: "A" }),
    frag({ item_status: "Unshipped", total_sales_sum: 50, total_units_sum: 1, sku: "B" }),
  ]);
  assert.equal(blocked.length, 0, "a fully-itemized account is never held");
  assert.equal(byAccount.get("ACC-1").length, 2);
  assert.equal(rollupByAccount.get("ACC-1").reduce((s, r) => s + r.salesAmount, 0), 150);
});

/* ===== 2. pending null-price rows are AUDITED + REPORTED and do not block OTHER accounts ===== */
test("2. pending (not-itemized) holds only its account; other accounts' completed sales still persist + are reported", () => {
  const { blocked, byAccount } = build([
    frag({ seller_or_vendor_id: "S1", item_status: "", total_sales_sum: null, total_units_sum: 3 }), // pending
    frag({ seller_or_vendor_id: "S2", item_status: "Shipped", total_sales_sum: 200, total_units_sum: 2 }), // done
  ]);
  const held = blocked.find((b) => b.accountId === "ACC-1");
  assert.ok(held && held.code === "OLI_D1_PENDING_ITEMIZATION", "S1 held as pending, not a defect");
  assert.ok(held.detail && held.detail.pending === 1 && held.detail.resolved === 0, "pending surfaced in the itemization summary");
  assert.ok(!byAccount.has("ACC-1"), "held account not written (LKG preserved)");
  assert.equal(byAccount.get("ACC-2").length, 1, "the other account's completed sale still persists");
});

/* ===== 3. cancelled rows contribute zero and do not block ===== */
test("3. cancelled rows contribute zero and never block", () => {
  const { blocked, byAccount, rollupByAccount } = build([
    frag({ amazon_order_status: "Cancelled", item_status: "", total_sales_sum: null, total_units_sum: 5 }),
    frag({ amazon_order_status: "Shipped", item_status: "Shipped", total_sales_sum: 80, total_units_sum: 1 }),
  ]);
  assert.equal(blocked.length, 0, "a cancelled null-value row never blocks");
  assert.equal(rollupByAccount.get("ACC-1").reduce((s, r) => s + r.salesAmount, 0), 80, "cancelled contributes zero");
  assert.equal(byAccount.get("ACC-1").length, 2, "cancelled kept for audit");
});

/* ===== 4. explicit-zero non-cancelled rows are audited, contribute zero, do not block ===== */
test("4. explicit present-zero rows are audited, contribute zero, never block", () => {
  const { blocked, rollupByAccount, byAccount } = build([
    frag({ item_status: "Shipped", total_sales_sum: 0, total_units_sum: 4, sku: "FREE" }),
    frag({ item_status: "Shipped", total_sales_sum: 100, total_units_sum: 2, sku: "PAID" }),
  ]);
  assert.equal(blocked.length, 0);
  assert.equal(rollupByAccount.get("ACC-1").length, 1, "only PAID contributes");
  assert.equal(rollupByAccount.get("ACC-1")[0].salesAmount, 100);
  assert.equal(byAccount.get("ACC-1").length, 2, "the zero-priced row is kept for audit");
});

/* ===== 5. itemized/completed null-price row with no fallback blocks ONLY that account ===== */
test("5. an itemized recognized-sale with a null value blocks only that account (real defect)", () => {
  const { blocked, byAccount } = build([
    frag({ seller_or_vendor_id: "S1", item_status: "Shipped", total_sales_sum: null, total_units_sum: 2 }), // defect
    frag({ seller_or_vendor_id: "S2", item_status: "Shipped", total_sales_sum: 90, total_units_sum: 1 }),   // ok
  ]);
  const d = blocked.find((b) => b.accountId === "ACC-1");
  assert.ok(d && d.code === "OLI_ITEMIZED_VALUE_MISSING", "itemized + null -> real defect");
  assert.equal(d.detail.defect, 1);
  assert.ok(!byAccount.has("ACC-1"));
  assert.equal(byAccount.get("ACC-2").length, 1, "the other account is unaffected");
});

/* ===== 6. item_price_value is the ONLY canonical sales field; no alternate/fabricated value ===== */
test("6. the OLI contract sums item_price_value for sales (the proven canonical field) -- no total_sales alternate", () => {
  const salesAgg = OLI_SALES_AGGREGATIONS.find((a) => a.alias === "total_sales_sum");
  assert.ok(salesAgg, "there is a total_sales_sum aggregation");
  assert.equal(salesAgg.column, "item_price_value", "sales is summed from item_price_value (source 89b27535d2 has no total_sales)");
  assert.equal(salesAgg.aggregation, "sum");
});

/* ===== 7. NULL is never coerced to 0 ===== */
test("7. a missing value stays null in the classification (never coerced to 0) for pending AND defect", () => {
  assert.equal(classifyOliDimensionalRow(frag({ item_status: "", total_sales_sum: null, total_units_sum: 1 })).value, null);
  assert.equal(classifyOliDimensionalRow(frag({ item_status: "Shipped", total_sales_sum: null, total_units_sum: 1 })).value, null);
  assert.equal(classifyOliDimensionalRow(frag({ item_status: "", total_sales_sum: "", total_units_sum: 1 })).valuePresent, false);
});

/* ===== 8. an exact-window export with ZERO completed sales still advances coverage (not blocked) ===== */
test("8. a zero-sales account (only cancelled + explicit-zero) is NOT held/blocked -> its window advances", () => {
  const { blocked, byAccount, rollupByAccount } = build([
    frag({ amazon_order_status: "Cancelled", item_status: "", total_sales_sum: null, total_units_sum: 3 }),
    frag({ item_status: "Shipped", total_sales_sum: 0, total_units_sum: 2, sku: "FREE" }),
  ]);
  assert.equal(blocked.length, 0, "zero completed sales is valid evidence, never a block");
  assert.ok(byAccount.has("ACC-1"), "the account is written (coverage can advance for a proven zero-sales window)");
  assert.equal((rollupByAccount.get("ACC-1") || []).length, 0, "no positive-value rollup rows, but the window is covered");
});

/* ===== 9. pre-sale Pending (payment unconfirmed) with a null value is PENDING, not a defect ===== */
test("9. a Pending order with a null value is pre-sale PENDING (held), never a defect -- even if it were itemized", () => {
  const p = classifyOliDimensionalRow(frag({ amazon_order_status: "Pending", item_status: "", total_sales_sum: null, total_units_sum: 1 }));
  assert.equal(p.pending, true);
  assert.equal(p.pendingReason, "pre-sale-pending");
  assert.equal(p.defect, false);
  const { blocked } = build([frag({ amazon_order_status: "Pending", item_status: "", total_sales_sum: null, total_units_sum: 1 })]);
  assert.equal(blocked[0].code, "OLI_D1_PENDING_ITEMIZATION");
});

/* ===== 10. corrected request identity cannot adopt a stale wrong-projection export ===== */
test("10. adding item_status CHANGES the OLI request_hash (a stale export without it cannot be adopted)", () => {
  const base = { apiKey: "k", sourceId: "89b27535d2", ids: ["S1"], from: "2026-08-20", to: "2026-08-26", limit: 5000,
    options: { groupBy: OLI_SALES_COLUMNS, aggregations: OLI_SALES_AGGREGATIONS, orderByColumn: "date", orderByDirection: "ASC" } };
  const withItem = sourceRequestIdentity({ ...base, columns: OLI_SALES_COLUMNS }).requestHash;
  const withoutItem = sourceRequestIdentity({ ...base, columns: OLI_SALES_COLUMNS.filter((c) => c !== "item_status"), options: { ...base.options, groupBy: OLI_SALES_COLUMNS.filter((c) => c !== "item_status") } }).requestHash;
  assert.notEqual(withItem, withoutItem, "the request_hash must differ so a pre-item_status export is never adopted");
  assert.ok(OLI_SALES_COLUMNS.includes("item_status"), "item_status is in the canonical columns");
});

/* ===== 11. many accounts in one run partition correctly (resolved persist, pending held, defect blocked) ===== */
test("11. a mixed batch partitions per account with no cross-account leakage", () => {
  const rows = [];
  for (let i = 0; i < 6; i += 1) { accounts["S" + i] = { accountId: "ACC-" + i, currency: "USD" }; }
  rows.push(frag({ seller_or_vendor_id: "S0", item_status: "Shipped", total_sales_sum: 10, total_units_sum: 1 })); // resolved
  rows.push(frag({ seller_or_vendor_id: "S1", item_status: "", total_sales_sum: null, total_units_sum: 1 }));       // pending
  rows.push(frag({ seller_or_vendor_id: "S2", item_status: "Shipped", total_sales_sum: null, total_units_sum: 1 })); // defect
  const { blocked, byAccount } = build(rows);
  assert.equal(byAccount.get("ACC-0").length, 1, "resolved account persists");
  assert.equal(blocked.find((b) => b.accountId === "ACC-1").code, "OLI_D1_PENDING_ITEMIZATION");
  assert.equal(blocked.find((b) => b.accountId === "ACC-2").code, "OLI_ITEMIZED_VALUE_MISSING");
  assert.ok(!byAccount.has("ACC-1") && !byAccount.has("ACC-2"), "held/blocked accounts write nothing");
});

/* ===== 19. Daily/Brand rollup reconciles to the corrected rules (pending + cancelled + zero excluded) ===== */
test("19. the non-cancelled rollup EXCLUDES pending/cancelled/zero and reconciles to completed sales only", () => {
  const { rollupByAccount } = build([
    frag({ item_status: "Shipped", total_sales_sum: 100, total_units_sum: 2, sku: "A" }),   // counts
    frag({ item_status: "", total_sales_sum: null, total_units_sum: 9, sku: "B" }),          // pending -> excluded (but this holds the account)
  ]);
  // The account is HELD (pending present) so nothing is persisted -- prove the account is not partially published.
  assert.equal((rollupByAccount.get("ACC-1") || []).length, 0, "a held account publishes NOTHING (no partial D-1)");
  // On a fully-resolved account, the rollup reconciles exactly to the completed sales.
  const resolved = build([
    frag({ item_status: "Shipped", total_sales_sum: 100, total_units_sum: 2, sku: "A" }),
    frag({ amazon_order_status: "Cancelled", item_status: "", total_sales_sum: 500, total_units_sum: 5, sku: "C" }),
    frag({ item_status: "Shipped", total_sales_sum: 0, total_units_sum: 3, sku: "Z" }),
  ]);
  const roll = resolved.rollupByAccount.get("ACC-1");
  assert.equal(roll.reduce((s, r) => s + r.salesAmount, 0), 100, "only the completed positive sale (cancelled 500 + zero excluded)");
  assert.equal(roll.reduce((s, r) => s + r.units, 0), 2);
});

/* ===== 20. the itemization diagnostics are visible and MUTUALLY EXCLUSIVE ===== */
test("20. pending / not-itemized / pre-sale / cancelled / zero / defect / resolved counts are mutually exclusive + visible", () => {
  const { blocked } = build([
    frag({ item_status: "Shipped", total_sales_sum: 100, total_units_sum: 2, sku: "A1" }),  // resolved
    frag({ item_status: "Shipped", total_sales_sum: 0, total_units_sum: 1, sku: "A2" }),     // resolved (explicit zero)
    frag({ item_status: "", total_sales_sum: null, total_units_sum: 1, sku: "B1" }),          // pending / not-itemized
    frag({ amazon_order_status: "Pending", item_status: "", total_sales_sum: null, total_units_sum: 1, sku: "B2" }), // pending / pre-sale
    frag({ amazon_order_status: "Cancelled", item_status: "", total_sales_sum: null, total_units_sum: 3, sku: "C1" }), // cancelled
  ]);
  const d = blocked.find((b) => b.accountId === "ACC-1").detail; // held (pending present)
  assert.equal(d.resolved, 2, "two priced rows (incl. explicit-zero) are resolved");
  assert.equal(d.zeroPriced, 1, "one of the resolved is an explicit zero");
  assert.equal(d.pending, 2, "two pending rows");
  assert.equal(d.notItemized, 1);
  assert.equal(d.presalePending, 1);
  assert.equal(d.cancelled, 1);
  assert.equal(d.notItemized + d.presalePending, d.pending, "not-itemized + pre-sale == pending (no double-count)");
  assert.equal(d.itemizedPct, 50, "resolved 2 / (resolved 2 + pending 2) = 50%");
  assert.equal(d.latestDate, "2026-08-26");
});

/* ===== 21. the summary detail carries NO order id / customer identifiers (redacted diagnostics) ===== */
test("21. the blocked itemization detail is redacted -- only counts + dates, never an order id or address", () => {
  const { blocked } = build([frag({ item_status: "", amazon_order_id: "555-SECRET-9", address_city: "Seattle", total_sales_sum: null, total_units_sum: 1 })]);
  const detail = blocked[0].detail;
  const asText = JSON.stringify(detail);
  assert.ok(!/SECRET/.test(asText) && !/Seattle/.test(asText), "no raw order id or address leaks into diagnostics");
  assert.ok(Number.isFinite(detail.pending) && typeof detail.latestDate === "string", "only structured counts + date");
});

out("\n" + passed + " assertions passed");
