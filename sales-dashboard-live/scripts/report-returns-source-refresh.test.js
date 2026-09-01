// Returns & Refund Leakage -- source-refresh transforms: aggregation, currency/window/seller fail-closed, batching,
// windows (offline, pure). Proves the raw DataDoe export -> durable window payload mapping is faithful + safe.

import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import {
  aggregateReturnsForAccount, aggregateSettlementsForAccount, planReturnsBatches, returnsTokenPlan,
  returnsWindow, settlementWindow, reshapeOrderedRows, SETTLEMENT_HISTORY_FLOOR,
} from "../lib/server/sync/returns-source-refresh.js";
import { addDaysStr } from "../lib/server/datadoe.js";

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };

const ASOF = "2026-08-30";
const FROM = addDaysStr(ASOF, -59);

test("1. returns aggregate: same grain -> one row with the summed count; different grain -> separate rows", () => {
  const rows = [
    { seller_or_vendor_id: "A", date: ASOF, sku: "S1", child_asin: "X1", amazon_return_reason: "DEFECTIVE", amazon_fulfillment_channel: "FBA", amazon_return_request_status: "Approved", amazon_return_label_to_be_paid_by: "", amazon_return_refunded_amount: 0, amazon_return_label_cost: 0, cogs_total_value: -2 },
    { seller_or_vendor_id: "A", date: ASOF, sku: "S1", child_asin: "X1", amazon_return_reason: "DEFECTIVE", amazon_fulfillment_channel: "FBA", amazon_return_request_status: "Approved", amazon_return_label_to_be_paid_by: "", amazon_return_refunded_amount: 0, amazon_return_label_cost: 0, cogs_total_value: -3 },
    { seller_or_vendor_id: "A", date: ASOF, sku: "S1", child_asin: "X1", amazon_return_reason: "TOO_SMALL", amazon_fulfillment_channel: "FBM", amazon_return_request_status: "PendingApproval", amazon_return_label_to_be_paid_by: "Seller", amazon_return_refunded_amount: -5, amazon_return_label_cost: -1, cogs_total_value: 0 },
  ];
  const durable = aggregateReturnsForAccount({ rows, accountId: "A", sellerOrVendorId: "A", marketplaceCountryCode: "US", from: FROM, to: ASOF, sourceRequestHash: "h" });
  assert.equal(durable.length, 2, "two distinct grains");
  const defective = durable.find((d) => d.amazon_return_reason === "DEFECTIVE");
  assert.equal(defective.return_count, 2, "two DEFECTIVE returns counted");
  assert.equal(defective.cogs_total_value, 5, "abs cogs summed (2+3)");
  const sizing = durable.find((d) => d.amazon_return_reason === "TOO_SMALL");
  assert.equal(sizing.return_count, 1);
  assert.equal(sizing.fbm_refunded_amount, 5, "abs FBM refunded amount");
  assert.equal(sizing.fbm_seller_label_cost, 1, "seller-paid label cost counted");
  for (const d of durable) { assert.equal(d.source_request_hash, "h"); assert.equal(d.seller_or_vendor_id, "A"); assert.equal(d.marketplace_country_code, "US"); }
});

test("2. returns aggregate: FBM label cost is counted ONLY when the seller pays; out-of-window + wrong-seller rows are dropped", () => {
  const rows = [
    { seller_or_vendor_id: "A", date: ASOF, sku: "S", child_asin: "X", amazon_return_reason: "R", amazon_fulfillment_channel: "FBM", amazon_return_request_status: "", amazon_return_label_to_be_paid_by: "Amazon", amazon_return_refunded_amount: -9, amazon_return_label_cost: -4 },
    { seller_or_vendor_id: "A", date: addDaysStr(FROM, -1), sku: "S", child_asin: "X", amazon_return_reason: "R", amazon_fulfillment_channel: "FBM", amazon_return_request_status: "", amazon_return_label_to_be_paid_by: "Seller", amazon_return_refunded_amount: -1, amazon_return_label_cost: -1 }, // out of window
    { seller_or_vendor_id: "OTHER", date: ASOF, sku: "S", child_asin: "X", amazon_return_reason: "R", amazon_fulfillment_channel: "FBM", amazon_return_request_status: "", amazon_return_label_to_be_paid_by: "Seller", amazon_return_refunded_amount: -1, amazon_return_label_cost: -1 }, // wrong seller
  ];
  const durable = aggregateReturnsForAccount({ rows, accountId: "A", sellerOrVendorId: "A", from: FROM, to: ASOF, sourceRequestHash: "h" });
  assert.equal(durable.length, 1, "only the in-window, in-seller row survives");
  assert.equal(durable[0].return_count, 1);
  assert.equal(durable[0].fbm_seller_label_cost, 0, "Amazon-paid label cost is NOT counted as seller-borne");
  assert.equal(durable[0].fbm_refunded_amount, 9);
});

test("3. settlement aggregate: keeps ORDER + REFUND with a valid currency; drops blank-currency + non-ORDER/REFUND; refund_event_count=1/refund; aliases map", () => {
  const rows = [
    { seller_or_vendor_id: "A", date: ASOF, sku: "S", child_asin: "X", currency: "usd", settlement_type: "order", quantity_sum: 20, item_price_sum: 200 },
    { seller_or_vendor_id: "A", date: ASOF, sku: "S", child_asin: "X", currency: "USD", settlement_type: "REFUND", refunded_amount_sum: -30, refund_commission_sum: -5, fba_return_unit_fee_sum: -2, refund_restocking_fee_sum: -1, cogs_sum: -12, quantity_sum: -3 },
    { seller_or_vendor_id: "A", date: ASOF, sku: "S", child_asin: "X", currency: "", settlement_type: "REFUND", refunded_amount_sum: -9 }, // blank currency -> drop
    { seller_or_vendor_id: "A", date: ASOF, sku: "S", child_asin: "X", currency: "USD", settlement_type: "TRANSFER", refunded_amount_sum: -1 }, // not ORDER/REFUND -> drop
  ];
  const durable = aggregateSettlementsForAccount({ rows, accountId: "A", sellerOrVendorId: "A", from: FROM, to: ASOF, sourceRequestHash: "h" });
  assert.equal(durable.length, 2, "ORDER + REFUND only");
  const order = durable.find((d) => d.settlement_type === "ORDER");
  assert.equal(order.currency, "USD", "currency uppercased");
  assert.deepEqual([order.quantity, order.item_price], [20, 200], "alias mapping (quantity_sum/item_price_sum)");
  assert.equal(order.refund_event_count, 0);
  const refund = durable.find((d) => d.settlement_type === "REFUND");
  assert.equal(refund.refunded_amount, -30, "raw signed sum preserved (report abs's at read)");
  assert.equal(refund.refund_commission, -5);
  assert.equal(refund.fba_customer_return_per_unit_fee, -2, "aliased fba_return_unit_fee_sum -> per_unit_fee");
  assert.equal(refund.refund_event_count, 1, "one refund event per grouped refund row");
});

test("4. batching: <=5 sellers/batch, deterministic (sorted) + de-duplicated; token plan is 4 tokens/batch", () => {
  const accts = [{ accountId: "c" }, { accountId: "a" }, { accountId: "b" }, { accountId: "a" }, { accountId: "e" }, { accountId: "d" }, { accountId: "f" }];
  const batches = planReturnsBatches(accts);
  assert.deepEqual(batches, [["a", "b", "c", "d", "e"], ["f"]], "sorted, deduped, <=5/batch");
  assert.deepEqual(returnsTokenPlan(2), { batches: 2, creates: 4, tokens: 8 });
  assert.deepEqual(returnsTokenPlan(5), { batches: 5, creates: 10, tokens: 20 });
});

test("5. windows: returns = 60 days floored at 2026-07-01; settlements initial=floor, daily=21 days", () => {
  assert.deepEqual(returnsWindow("2026-08-30"), { from: addDaysStr("2026-08-30", -59), to: "2026-08-30" });
  assert.equal(returnsWindow("2026-07-05").from, SETTLEMENT_HISTORY_FLOOR, "floored at 2026-07-01");
  assert.equal(settlementWindow("2026-08-30", null).from, "2026-07-01", "initial from the floor");
  assert.equal(settlementWindow("2026-08-30", null).mode, "initial");
  assert.equal(settlementWindow("2026-08-30", "2026-07-01").from, addDaysStr("2026-08-30", -20), "daily 21-day window");
  assert.equal(settlementWindow("2026-08-30", "2026-07-01").mode, "daily");
});

test("6. reshapeOrderedRows maps merged OLI to the ordered-fold shape (currency + ordered units + sales)", () => {
  const merged = [{ sale_date: ASOF, child_asin: "X", currency: "USD", ordered_units: 12, sales_amount: 340, units: 12 }];
  const shaped = reshapeOrderedRows(merged);
  assert.deepEqual(shaped, [{ date: ASOF, child_asin: "X", item_price_currency: "USD", total_units_sum: 12, total_sales_sum: 340, product_name: null }]);
});

(async () => {
  out("\nReturns & Refund Leakage -- source-refresh transforms");
  for (const t of tests) {
    try { await t.fn(); passed += 1; out("  ok  " + t.name); }
    catch (e) { out("FAIL  " + t.name + "\n      " + (e && e.stack ? e.stack.split("\n").slice(0, 4).join("\n      ") : e)); process.exitCode = 1; }
  }
  out("\n" + passed + "/" + tests.length + " assertions passed");
  if (passed !== tests.length) process.exitCode = 1;
})();
