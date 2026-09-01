// Returns & Refund Leakage -- ADVANCED durable payload (returns-leakage-v3) correctness (offline, ZERO network/DB).
//
// Proves the durable-history advanced builder is a faithful SUPERSET of the proven raw returnsLeakagePayload:
//   (1) base `rows` (+ reasonTotals/currencies/fbmOnly/pending/returnRecordCount) are byte-identical to the raw
//       path for equivalent underlying data (so the aggregate never diverges from buildReturnsLeakage);
//   (2) the return-fee zero-clamp is applied ONCE over the window (per-day durable rows sum-then-clamp), matching
//       the raw grouped export;
//   (3) refundEvents uses refund_event_count, not a per-row +1;
//   (4) the grace period splits confirmed vs provisional returns by recency (recent returns are NOT leakage);
//   (5) the account daily series + per-row daily sub-series reconcile to the window totals;
//   (6) currency isolation is preserved and the rate is withheld on a multi-currency ASIN;
//   (7) the builder is pure + idempotent (no network).

import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { returnsLeakagePayload } from "../lib/server/reports/derivation-core.js";
import { buildReturnsAdvancedPayload, RETURNS_ADVANCED_VERSION } from "../lib/server/reports/returns-advanced.js";
import { addDaysStr } from "../lib/server/datadoe.js";

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };

const ASOF = "2026-08-30";
const WINDOW = 60;
const FROM = addDaysStr(ASOF, -(WINDOW - 1));
const LABELS = { returnsSourceLabel: "Returns (FBA & FBM)", moneySourceLabel: "Settlements & P&L Components", rateSourceLabel: "Order Line Items", rateSourceLagDays: 0, returnHistoryDays: 60 };

// ---- durable row builders ----
const dRet = (date, asin, sku, reason, channel, status, count, { fbmRefund = 0, fbmLabel = 0, payer = "" } = {}) => ({
  return_date: date, child_asin: asin, sku, amazon_return_reason: reason, fulfillment_channel: channel,
  request_status: status, label_payer: payer, detailed_disposition: "", return_count: count,
  fbm_refunded_amount: fbmRefund, fbm_seller_label_cost: fbmLabel, cogs_total_value: 0, source_request_hash: "h",
});
const dOrder = (date, asin, sku, currency, itemPrice, qty) => ({
  settlement_date: date, child_asin: asin, sku, currency, settlement_type: "ORDER",
  quantity: qty, item_price: itemPrice, refunded_amount: 0, refund_tax: 0, refunded_referral_fee: 0,
  refund_commission: 0, refund_restocking_fee: 0, fba_customer_return_per_unit_fee: 0, fba_customer_return_fee: 0,
  customer_return_hrr_unit_fee: 0, cogs_total_value: 0, refund_event_count: 0, source_request_hash: "h",
});
const dRefund = (date, asin, sku, currency, o) => ({
  settlement_date: date, child_asin: asin, sku, currency, settlement_type: "REFUND",
  quantity: o.qty || 0, item_price: 0, refunded_amount: o.amount || 0, refund_tax: o.tax || 0,
  refunded_referral_fee: o.referral || 0, refund_commission: o.commission || 0, refund_restocking_fee: o.restock || 0,
  fba_customer_return_per_unit_fee: o.unitFee || 0, fba_customer_return_fee: 0, customer_return_hrr_unit_fee: 0,
  cogs_total_value: o.cogs || 0, refund_event_count: o.events ?? 1, source_request_hash: "h",
});
const dOrd = (asin, name, sales, units, currency = "USD", date = ASOF) => ({
  date, child_asin: asin, item_price_currency: currency, product_name: name, total_sales_sum: sales, total_units_sum: units,
});
const cat = (asin, name, brand) => ({ child_asin: asin, parent_asin: "P", product_name: name, product_brand: brand });

// Equivalent RAW rows for the same scenario, to compute the proven raw payload.
const rRet = (asin, sku, reason, channel, status, refunded, labelCost, paidBy) => ({
  date: ASOF, sku, child_asin: asin, amazon_order_id: "O", amazon_return_reason: reason,
  amazon_fulfillment_channel: channel, amazon_return_request_status: status,
  amazon_return_refunded_amount: refunded, amazon_return_label_cost: labelCost, amazon_return_label_to_be_paid_by: paidBy,
});
const rOrder = (asin, sku, currency, itemPrice, qty) => ({ sku, child_asin: asin, settlement_type: "ORDER", currency, item_price_sum: itemPrice, quantity_sum: qty });
const rRefund = (asin, sku, currency, o) => ({
  sku, child_asin: asin, settlement_type: "REFUND", currency,
  refunded_amount_sum: o.amount || 0, refund_tax_sum: o.tax || 0, refunded_referral_fee_sum: o.referral || 0,
  refund_commission_sum: o.commission || 0, return_unit_fee_sum: o.unitFee || 0, refund_restocking_fee_sum: o.restock || 0,
  cogs_sum: o.cogs || 0, quantity_sum: o.qty || 0,
});
const rOrd = (asin, name, sales, units, currency = "USD") => ({ date: ASOF, sku: "SKU-" + asin, child_asin: asin, item_price_currency: currency, product_name: name, total_sales_sum: sales, total_units_sum: units });

// Strip the advanced-only per-row fields so base rows can be compared to the raw payload's rows.
const stripAdvanced = (rows) => rows.map((r) => { const { daily, rateWithheld, provisionalReturnCount, confirmedReturnCount, ...base } = r; return base; });

const buildAdv = (over = {}) => buildReturnsAdvancedPayload({
  accountId: "A1", asOf: ASOF, from: FROM, windowDays: WINDOW, ...LABELS,
  durableReturnRows: [], durableSettlementRows: [], orderedRows: [], catalogRows: [], ...over,
});

// ---------------------------------------------------------------------------

test("1. base rows deep-equal the proven raw returnsLeakagePayload for equivalent single-day data", () => {
  // A single-currency ASIN with 3 returns + a refund + ordered units, and a money-only ASIN.
  const durableReturnRows = [
    dRet(ASOF, "R1", "SKU-R1", "DEFECTIVE", "FBA", "Approved", 2, { fbmRefund: 0, fbmLabel: 0 }),
    dRet(ASOF, "R1", "SKU-R1", "TOO_SMALL", "FBM", "PendingApproval", 1, { fbmRefund: 5, fbmLabel: 1, payer: "Seller" }),
  ];
  const durableSettlementRows = [
    dOrder(ASOF, "R1", "SKU-R1", "USD", 200, 20),
    dRefund(ASOF, "R1", "SKU-R1", "USD", { amount: -30, tax: -3, referral: -4, commission: -5, unitFee: -2, restock: -1, cogs: -12, qty: -3, events: 1 }),
    dRefund(ASOF, "RX", "SKU-X", "USD", { amount: -9, commission: -1, unitFee: -1, restock: 0, cogs: -2, qty: -1, events: 1 }),
  ];
  const orderedRows = [dOrd("R1", "Widget R1", 500, 50)];
  const catalogRows = [cat("R1", "Catalog R1", "Acme")];

  const adv = buildAdv({ durableReturnRows, durableSettlementRows, orderedRows, catalogRows });

  const raw = returnsLeakagePayload({
    accountId: "A1", asOf: ASOF, from: FROM, windowDays: WINDOW, ...LABELS,
    returnRows: [
      rRet("R1", "SKU-R1", "DEFECTIVE", "FBA", "Approved", 0, 0, ""),
      rRet("R1", "SKU-R1", "DEFECTIVE", "FBA", "Approved", 0, 0, ""),
      rRet("R1", "SKU-R1", "TOO_SMALL", "FBM", "PendingApproval", -5, -1, "Seller"),
    ],
    settlementRows: [
      rOrder("R1", "SKU-R1", "USD", 200, 20),
      rRefund("R1", "SKU-R1", "USD", { amount: -30, tax: -3, referral: -4, commission: -5, unitFee: -2, restock: -1, cogs: -12, qty: -3 }),
      rRefund("RX", "SKU-X", "USD", { amount: -9, commission: -1, unitFee: -1, restock: 0, cogs: -2, qty: -1 }),
    ],
    orderedRows: [rOrd("R1", "Widget R1", 500, 50)],
    catalogRows: [cat("R1", "Catalog R1", "Acme")],
  });

  assert.deepEqual(stripAdvanced(adv.rows), raw.rows, "durable base rows == raw payload rows");
  assert.deepEqual(adv.reasonTotals, raw.reasonTotals, "reasonTotals match");
  assert.deepEqual(adv.currencies, raw.currencies, "currencies match");
  assert.deepEqual(adv.fbmOnly, raw.fbmOnly, "fbmOnly match");
  assert.equal(adv.pendingReturnRequests, raw.pendingReturnRequests, "pending match");
  assert.equal(adv.returnRecordCount, raw.returnRecordCount, "returnRecordCount match");
  assert.equal(adv.version, RETURNS_ADVANCED_VERSION);
});

test("2. return-fee zero-clamp is applied ONCE over the window (per-day durable rows sum-then-clamp)", () => {
  // Same (asin,currency) refunded on two days: day A commission 5 restock 0; day B commission 0 restock 3.
  // Per-day clamp would give 5 + 0 = 5; window clamp = max(0, 5 - 3) = 2. The durable path MUST give 2.
  const dayA = addDaysStr(ASOF, -5), dayB = ASOF;
  const durableSettlementRows = [
    dRefund(dayA, "R1", "SKU-R1", "USD", { amount: -10, commission: -5, restock: 0, qty: -1, events: 1 }),
    dRefund(dayB, "R1", "SKU-R1", "USD", { amount: -10, commission: 0, restock: -3, qty: -1, events: 1 }),
  ];
  const adv = buildAdv({ durableSettlementRows });
  const r1 = adv.rows.find((r) => r.asin === "R1");
  assert.equal(r1.returnFees, 2, "commission 5 - restock 3 clamped ONCE over the window = 2 (not 5)");
  assert.equal(r1.refundEvents, 2, "two refund events across the two days");
});

test("3. refundEvents uses refund_event_count, not a per-row +1", () => {
  const durableSettlementRows = [dRefund(ASOF, "R1", "SKU-R1", "USD", { amount: -30, qty: -3, events: 7 })];
  const adv = buildAdv({ durableSettlementRows });
  assert.equal(adv.rows.find((r) => r.asin === "R1").refundEvents, 7, "one durable row can carry many refund events");
});

test("4. grace period splits confirmed vs provisional returns by recency (recent = NOT leakage)", () => {
  const recent = addDaysStr(ASOF, -3);          // inside the 21-day grace window -> provisional
  const old = addDaysStr(ASOF, -40);            // outside grace -> confirmed
  const durableReturnRows = [
    dRet(recent, "R1", "SKU-R1", "DEFECTIVE", "FBA", "Approved", 4),
    dRet(old, "R1", "SKU-R1", "DEFECTIVE", "FBA", "Approved", 6),
  ];
  const adv = buildAdv({ durableReturnRows, graceDays: 21 });
  assert.equal(adv.provisional.graceDays, 21);
  assert.equal(adv.provisional.cutoff, addDaysStr(ASOF, -20), "cutoff = asOf - (grace-1)");
  assert.equal(adv.provisional.returnCount, 4, "4 recent returns are provisional");
  assert.equal(adv.provisional.confirmedReturnCount, 6, "6 old returns are confirmed");
  const r1 = adv.rows.find((r) => r.asin === "R1");
  assert.equal(r1.provisionalReturnCount, 4);
  assert.equal(r1.confirmedReturnCount, 6);
});

test("5. account daily series + per-row daily reconcile to the window totals", () => {
  const d1 = addDaysStr(ASOF, -10), d2 = ASOF;
  const durableReturnRows = [
    dRet(d1, "R1", "SKU-R1", "DEFECTIVE", "FBA", "Approved", 3),
    dRet(d2, "R1", "SKU-R1", "DEFECTIVE", "FBA", "Approved", 2),
  ];
  const durableSettlementRows = [
    dRefund(d1, "R1", "SKU-R1", "USD", { amount: -10, qty: -1, events: 1 }),
    dRefund(d2, "R1", "SKU-R1", "USD", { amount: -20, qty: -2, events: 1 }),
  ];
  const orderedRows = [dOrd("R1", "Widget", 100, 10, "USD", d1), dOrd("R1", "Widget", 50, 5, "USD", d2)];
  const adv = buildAdv({ durableReturnRows, durableSettlementRows, orderedRows });
  const sum = (arr) => arr.reduce((a, b) => a + b, 0);
  assert.equal(sum(adv.series.returns.returnCount), 5, "returns series sums to 5");
  assert.equal(sum(adv.series.money.USD.refundedAmount), 30, "USD refund series sums to 30");
  assert.equal(sum(adv.series.money.USD.orderedUnits), 15, "USD ordered-units series sums to 15");
  const r1 = adv.rows.find((r) => r.asin === "R1");
  assert.equal(r1.daily.reduce((a, c) => a + (c.rc || 0), 0), 5, "per-row daily rc sums to the row returnCount");
  assert.equal(r1.daily.reduce((a, c) => a + (c.rfd || 0), 0), r1.refundedAmount, "per-row daily rfd sums to refundedAmount");
});

test("6. currency isolation preserved + rate withheld on a multi-currency ASIN", () => {
  const durableReturnRows = [dRet(ASOF, "M1", "SKU-M1", "DEFECTIVE", "FBA", "Approved", 4)];
  const durableSettlementRows = [dRefund(ASOF, "M1", "SKU-M1", "CAD", { amount: -10, qty: -1, events: 1 })];
  const orderedRows = [dOrd("M1", "M One", 300, 30, "USD"), dOrd("M1", "M One", 100, 20, "CAD")];
  const adv = buildAdv({ durableReturnRows, durableSettlementRows, orderedRows });
  const m = adv.rows.filter((r) => r.asin === "M1");
  assert.equal(m.length, 2, "two currency rows");
  const usd = m.find((r) => r.currency === "USD"), cad = m.find((r) => r.currency === "CAD");
  assert.equal(usd.returnCount, 4, "USD (greatest ordered) is the return holder");
  assert.equal(cad.returnCount, 0);
  assert.ok(usd.returnedUnits === null && cad.returnedUnits === null, "rate withheld on both currency rows");
  assert.ok(usd.rateWithheld === true, "rateWithheld flag set on the holder");
  assert.equal(usd.orderedUnits, 30); assert.equal(cad.orderedUnits, 20);
  assert.equal(cad.refundedAmount, 10); assert.equal(usd.refundedAmount, 0);
});

test("7. the builder makes ZERO network calls and is idempotent", () => {
  const realFetch = globalThis.fetch; let hits = 0;
  globalThis.fetch = () => { hits += 1; throw new Error("network during derivation"); };
  const args = { durableReturnRows: [dRet(ASOF, "R1", "SKU-R1", "DEFECTIVE", "FBA", "Approved", 1)], durableSettlementRows: [dRefund(ASOF, "R1", "SKU-R1", "USD", { amount: -5, qty: -1, events: 1 })] };
  let a, b;
  try { a = buildAdv(args); b = buildAdv(args); } finally { globalThis.fetch = realFetch; }
  assert.equal(hits, 0, "zero network calls");
  assert.deepEqual(a, b, "idempotent");
});

// ---- runner ----
(async () => {
  out("\nReturns & Refund Leakage -- advanced durable payload");
  for (const t of tests) {
    try { await t.fn(); passed += 1; out("  ok  " + t.name); }
    catch (e) { out("FAIL  " + t.name + "\n      " + (e && e.stack ? e.stack.split("\n").slice(0, 4).join("\n      ") : e)); process.exitCode = 1; }
  }
  out("\n" + passed + "/" + tests.length + " assertions passed");
  if (passed !== tests.length) process.exitCode = 1;
})();
