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
// Schema 2 (DESIGN-v2 5.2, the daily Returns (FBA & FBM) event source):
//   (8) every PRE-EXISTING field is byte-identical to the pre-schema-2 builder (golden digest of the production d18395d
//       module over a rich fixture), setting aside only the additive fields and the two intentional changes;
//   (9) units EXCEEDING events: returnQuantity is the units sum while returnedUnits (the rate numerator) stays the
//       event count -- the rate is unchanged;
//  (10) an all-legacy input (returned_units null / absent) -> returnQuantity null, rqx on every return day;
//  (11) a mixed asin voids its quantity; per-day rq / rqx; malformed units are unavailable (fail closed);
//  (12) fbmOnly + the daily frf / flc sum FBM rows only;
//  (13) moneyAvailableThrough + the capped latestReconciliation;
//  (14) returnsCoveredThrough = the contiguous 'returns' coverage end from the OPTIONAL coverage input;
//  (15) schema markers, appended key order, the materialization operator's { to } gate (main line: no v3 validator), and
//       the rolling-days drift pin (UNCONDITIONAL);
//  (16) returnsCoverageWindows: the event-source windows merged + clipped to [from, asOf] ([] ok-but-empty, null
//       unreadable / absent) -- a gap is kept, never cut at the first hole;
//  (17) returnsLegacyCoveredThrough: the legacy horizon (2026-08-31, clamped to asOf and to the day before the first
//       event-source day) only when the read is ok AND a saved history row is dated inside it; no row -> null;
//  (18) the RETURNS_LEGACY_SAVED_THROUGH constant.

import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { createHash } from "node:crypto";
import { returnsLeakagePayload } from "../lib/server/reports/derivation-core.js";
import {
  buildReturnsAdvancedPayload, RETURNS_ADVANCED_VERSION, RETURNS_PAYLOAD_SCHEMA, RETURNS_PAYLOAD_ROLLING_DAYS, returnsCoverageEnd,
  returnsCoverageEvidence, RETURNS_LEGACY_SAVED_THROUGH,
} from "../lib/server/reports/returns-advanced.js";
// The PURE event-source core (no I/O at import): the rolling-days drift pin is unconditional.
import { RETURNS_ROLLING_DAYS } from "../lib/server/sync/returns-event-source.js";
import { REPORT_DERIVATIONS } from "../lib/server/sync/report-derivation.js";
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

// Strip the advanced-only per-row fields so base rows can be compared to the raw payload's rows (schema 2's
// returnQuantity is an advanced-only per-row field too).
const stripAdvanced = (rows) => rows.map((r) => { const { daily, rateWithheld, provisionalReturnCount, confirmedReturnCount, returnQuantity, ...base } = r; return base; });

const buildAdv = (over = {}) => buildReturnsAdvancedPayload({
  accountId: "A1", asOf: ASOF, from: FROM, windowDays: WINDOW, ...LABELS,
  durableReturnRows: [], durableSettlementRows: [], orderedRows: [], catalogRows: [], ...over,
});

// ---- schema 2 fixture: a rich multi-day / multi-channel / multi-currency window with mixed returned_units ----
const d = (n) => addDaysStr(ASOF, -n);
const uRet = (date, asin, sku, reason, channel, status, count, units, { fbmRefund = 0, fbmLabel = 0, payer = "" } = {}) => {
  const row = {
    return_date: date, child_asin: asin, sku, amazon_return_reason: reason, fulfillment_channel: channel,
    request_status: status, label_payer: payer, detailed_disposition: "", return_count: count,
    fbm_refunded_amount: fbmRefund, fbm_seller_label_cost: fbmLabel, cogs_total_value: 0, source_request_hash: "h",
  };
  if (units !== undefined) row.returned_units = units; // undefined -> the column absent (a pre-migration reader)
  return row;
};
const gOrd = (asin, name, sales, units, currency, date) => ({ date, child_asin: asin, item_price_currency: currency, product_name: name, total_sales_sum: sales, total_units_sum: units });
const RICH = {
  durableReturnRows: [
    uRet(d(2), "R1", "SKU-R1", "DEFECTIVE", "FBA", "Approved", 2, 5, { fbmRefund: 3.25 }),
    uRet(d(2), "R1", "SKU-R1b", "TOO_SMALL", "FBM", "PendingApproval", 1, 1, { fbmRefund: 7.5, fbmLabel: 2.1, payer: "Seller" }),
    uRet(d(9), "R1", "SKU-R1", "UNWANTED_ITEM", "FBA", "Approved", 3, null),
    uRet(d(9), "R1", "SKU-R1", "NOT_AS_DESCRIBED", "FBM", "Approved", 1, 2, { fbmRefund: 4, fbmLabel: 1, payer: "Amazon" }),
    uRet(d(30), "R1", "SKU-R1", "DEFECTIVE", "FBA", "Approved", 1, 1),
    uRet(d(1), "M1", "SKU-M1", "DAMAGED_BY_CARRIER", "FBA", "Approved", 4, 4),
    uRet(d(1), "M1", "SKU-M1", "SWITCHEROO", "FBM", "Approved", 1, undefined, { fbmRefund: 9, fbmLabel: 3, payer: "seller" }),
    uRet(d(5), "Z1", "SKU-Z1", "", "", "Approved", 2, 2),
    uRet(d(3), "", "SKU-BLANK", "DEFECTIVE", "FBA", "Approved", 6, 6),
    uRet(d(4), "R2", "SKU-R2", "DEFECTIVE", "FBA", "Approved", 0, null),
    uRet(addDaysStr(FROM, -3), "R1", "SKU-R1", "DEFECTIVE", "FBA", "Approved", 2, 2),
  ],
  durableSettlementRows: [
    dOrder(d(20), "R1", "SKU-R1", "USD", 400, 40),
    dRefund(d(12), "R1", "SKU-R1", "USD", { amount: -30, tax: -3, referral: -4, commission: -5, unitFee: -2, restock: -1, cogs: -12, qty: -3, events: 2 }),
    dRefund(d(6), "R1", "SKU-R1", "USD", { amount: -10, commission: 0, restock: -3, qty: -1, events: 1 }),
    dRefund(d(7), "M1", "SKU-M1", "CAD", { amount: -10, qty: -1, events: 1 }),
    dRefund(d(4), "RX", "SKU-X", "USD", { amount: -9, commission: -1, unitFee: -1, cogs: -2, qty: -1, events: 3 }),
    dOrder(d(0), "", "SKU-BLANK", "USD", 5, 1),
  ],
  orderedRows: [
    gOrd("R1", "Widget R1", 500, 50, "USD", d(15)), gOrd("R1", "Widget R1", 100, 10, "USD", d(2)),
    gOrd("M1", "M One", 300, 30, "USD", d(3)), gOrd("M1", "M One", 100, 20, "CAD", d(3)),
    gOrd("Z1", "Zed", 40, 4, "USD", d(5)),
  ],
  catalogRows: [cat("R1", "Catalog R1", "Acme"), cat("M1", "Catalog M1", "Bolt")],
  returnsRefreshedAt: "2026-08-30T02:00:00.000Z", settlementsRefreshedAt: "2026-08-29T02:00:00.000Z",
};
// The pre-schema-2 view: drop the ADDITIVE fields and the two INTENTIONALLY changed fields (fbmOnly -> FBM rows only;
// freshness.latestReconciliation -> capped by moneyAvailableThrough), each pinned by its own explicit test below.
const ADDITIVE_TOP = ["returnsSchema", "moneyAvailableThrough", "returnsCoveredThrough", "rollingDays", "returnsCoverageWindows", "returnsLegacyCoveredThrough"];
const ADDITIVE_CELL = ["rq", "rqx", "frf", "flc"];
const legacyView = (p) => {
  const c = JSON.parse(JSON.stringify(p));
  for (const k of ADDITIVE_TOP) delete c[k];
  for (const r of c.rows) { delete r.returnQuantity; for (const cell of r.daily) for (const k of ADDITIVE_CELL) delete cell[k]; }
  delete c.fbmOnly; delete c.freshness.latestReconciliation;
  return c;
};
// sha256(JSON.stringify(legacyView(<the UNMODIFIED production d18395d builder over RICH>))), recorded once from that module.
const PRE_SCHEMA2_GOLDEN = "a3c538beeefbcc1d011aed82cead72cb3533c2241cd18dbec07edf81679e7afa";
const sha256 = (s) => createHash("sha256").update(s).digest("hex");

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

// ---- schema 2 (DESIGN-v2 5.2) ----

test("8. every PRE-EXISTING field is BYTE-IDENTICAL to the pre-schema-2 builder (golden digest of production d18395d over a rich fixture); only the additive fields + the two intentional changes differ", () => {
  const p = buildAdv(RICH);
  assert.equal(sha256(JSON.stringify(legacyView(p))), PRE_SCHEMA2_GOLDEN, "rows (counts, money, rates, daily cells), series, provisional, freshness, labels: unchanged");
  const withCov = buildAdv({ ...RICH, returnsCoverage: { read: "ok", windows: [{ from: FROM, to: d(1) }] } });
  assert.equal(sha256(JSON.stringify(legacyView(withCov))), PRE_SCHEMA2_GOLDEN, "the optional coverage input moves nothing but returnsCoveredThrough");
  // The two INTENTIONAL changes, explicitly: the pre-schema-2 fbmOnly.refundedAmount was 23.75 (it included the FBA
  // row's 3.25); latestReconciliation keeps asOf - 21 here because the money (2026-08-26) is newer than that cut.
  assert.deepEqual(p.fbmOnly, { refundedAmount: 20.5, sellerBorneLabelCost: 6.1 }, "fbmOnly: FBM rows only");
  assert.equal(p.freshness.latestReconciliation, addDaysStr(ASOF, -21));
  assert.equal(p.moneyAvailableThrough, d(4), "the blank-ASIN ORDER on asOf never extends the money");
  // returnedUnits (the rate numerator) is the EVENT count wherever it was before: R1 holds 10 events (on d(2) its 3
  // events carry 6 units -- more units than events) and keeps returnedUnits 10.
  const r1 = p.rows.find((r) => r.asin === "R1");
  assert.equal(r1.returnedUnits, 10); assert.equal(r1.returnCount, 10); assert.equal(r1.returnQuantity, null, "one unit-less row on d(9) voids R1's quantity");
  assert.equal(p.rows.find((r) => r.asin === "Z1").returnQuantity, 2);
  const m1 = p.rows.filter((r) => r.asin === "M1");
  assert.ok(m1.find((r) => r.currency === "USD").returnQuantity === null && m1.find((r) => r.currency === "CAD").returnQuantity === 0, "M1: the holder's FBM row has no units column -> null; the non-holder currency row 0");
});

test("9. units EXCEED events: returnQuantity = sum(returned_units) while returnedUnits (the rate numerator) stays the EVENT count -- the return rate is unchanged", () => {
  const rows = (u0, u1) => [
    uRet(d(3), "R1", "SKU-R1", "DEFECTIVE", "FBA", "Approved", 2, u0),
    uRet(d(1), "R1", "SKU-R1", "TOO_SMALL", "FBM", "Approved", 1, u1),
  ];
  const orderedRows = [gOrd("R1", "Widget", 500, 50, "USD", d(2))];
  const withUnits = buildAdv({ durableReturnRows: rows(5, 3), orderedRows });
  const legacy = buildAdv({ durableReturnRows: rows(null, null), orderedRows });
  const u = withUnits.rows.find((r) => r.asin === "R1");
  const l = legacy.rows.find((r) => r.asin === "R1");
  assert.equal(u.returnQuantity, 8, "8 units returned on 3 events");
  assert.equal(u.returnCount, 3);
  assert.equal(u.returnedUnits, 3, "returnedUnits stays the EVENT count (never the units)");
  assert.equal(u.returnedUnits / u.orderedUnits, 3 / 50, "rate = events / ordered units");
  assert.equal(u.returnedUnits / u.orderedUnits, l.returnedUnits / l.orderedUnits, "the rate is identical with or without units");
  assert.deepEqual(stripAdvanced(withUnits.rows), stripAdvanced(legacy.rows), "every base row field is identical with or without units");
  assert.deepEqual(withUnits.series, legacy.series, "the account series (counts) never read units");
  assert.deepEqual(withUnits.provisional, legacy.provisional);
  assert.equal(l.returnQuantity, null, "the same rows without units -> null");
  const c3 = u.daily.find((c) => c.date === d(3));
  const c1 = u.daily.find((c) => c.date === d(1));
  assert.ok(c3.rq === 5 && c3.rc === 2 && c1.rq === 3 && c1.rc === 1 && !("rqx" in c3) && !("rqx" in c1), "per-day rq = that day's units");
});

test("10. an ALL-LEGACY input (returned_units null, or the column absent) -> returnQuantity null on every return-holder row, rqx:1 on every return day, never an rq; a row without returns has returnQuantity 0", () => {
  const durableReturnRows = [
    uRet(d(5), "R1", "SKU-R1", "DEFECTIVE", "FBA", "Approved", 2, null),
    uRet(d(2), "R1", "SKU-R1", "DEFECTIVE", "FBA", "Approved", 1, undefined),
    dRet(d(2), "R2", "SKU-R2", "TOO_SMALL", "FBM", "Approved", 3),
  ];
  const durableSettlementRows = [dRefund(ASOF, "RX", "SKU-X", "USD", { amount: -9, qty: -1, events: 1 })];
  const adv = buildAdv({ durableReturnRows, durableSettlementRows });
  const holders = adv.rows.filter((r) => r.returnCount > 0);
  assert.equal(holders.length, 2);
  assert.ok(holders.every((r) => r.returnQuantity === null), "every return-holder row: units unavailable");
  const cells = holders.flatMap((r) => r.daily.filter((c) => c.rc > 0));
  assert.ok(cells.length === 3 && cells.every((c) => c.rqx === 1 && !("rq" in c)), "every return day: rqx 1, no rq");
  const moneyOnly = adv.rows.find((r) => r.asin === "RX");
  assert.ok(moneyOnly.returnCount === 0 && moneyOnly.returnQuantity === 0, "no returns -> 0 units (not 'unavailable')");
});

test("11. a MIXED asin voids its returnQuantity; per day: all rows with units -> rq (sum), any unit-less row -> rqx:1 and no rq; malformed units are unavailable (fail closed)", () => {
  const durableReturnRows = [
    uRet(d(6), "R1", "SKU-R1", "DEFECTIVE", "FBA", "Approved", 1, 2),
    uRet(d(6), "R1", "SKU-R1b", "TOO_SMALL", "FBM", "Approved", 2, 4),
    uRet(d(3), "R1", "SKU-R1", "DEFECTIVE", "FBA", "Approved", 1, 1),
    uRet(d(3), "R1", "SKU-R1", "UNWANTED_ITEM", "FBA", "Approved", 1, null),
  ];
  const r1 = buildAdv({ durableReturnRows }).rows.find((r) => r.asin === "R1");
  assert.equal(r1.returnQuantity, null, "one unit-less row voids the asin's quantity (never a partial 7)");
  const c6 = r1.daily.find((c) => c.date === d(6));
  const c3 = r1.daily.find((c) => c.date === d(3));
  assert.ok(c6.rq === 6 && !("rqx" in c6), "a day whose rows all carry units -> rq = their sum");
  assert.ok(c3.rqx === 1 && !("rq" in c3), "a day with a unit-less row -> rqx 1, rq omitted");
  const q = (units) => buildAdv({ durableReturnRows: [uRet(d(1), "R9", "SKU-R9", "DEFECTIVE", "FBA", "Approved", 1, units)] }).rows[0].returnQuantity;
  for (const bad of [0, -1, 1.5, "abc", "", " ", "1.5", "-2", true, NaN, Infinity, {}, []]) assert.equal(q(bad), null, "malformed units " + String(bad) + " -> unavailable");
  assert.equal(q("3"), 3, "a numeric string is accepted");
  assert.equal(q(7), 7);
});

test("12. FBM-only money: fbmOnly and the daily frf / flc cells sum ONLY fulfillment_channel 'FBM' rows (an FBA row's refunded amount / label cost never counts)", () => {
  const durableReturnRows = [
    uRet(d(4), "R1", "SKU-R1", "DEFECTIVE", "FBA", "Approved", 1, 1, { fbmRefund: 5, fbmLabel: 2 }),
    uRet(d(4), "R1", "SKU-R1", "TOO_SMALL", "fbm", "Approved", 1, 1, { fbmRefund: -7, fbmLabel: -1.5, payer: "Seller" }),
    uRet(d(2), "R1", "SKU-R1", "DEFECTIVE", "FBA", "Approved", 1, 1, { fbmRefund: 11 }),
    uRet(d(2), "", "SKU-BLANK", "DEFECTIVE", "FBM", "Approved", 1, 1, { fbmRefund: 13, fbmLabel: 4 }),
  ];
  const adv = buildAdv({ durableReturnRows });
  assert.deepEqual(adv.fbmOnly, { refundedAmount: 7, sellerBorneLabelCost: 1.5 }, "FBM rows only (abs); the FBA amounts and the blank-ASIN row are excluded");
  const r1 = adv.rows.find((r) => r.asin === "R1");
  const c4 = r1.daily.find((c) => c.date === d(4));
  const c2 = r1.daily.find((c) => c.date === d(2));
  assert.ok(c4.frf === 7 && c4.flc === 1.5, "the FBM day carries frf / flc");
  assert.ok(!("frf" in c2) && !("flc" in c2), "an FBA-only day carries no FBM money");
  assert.equal(r1.daily.reduce((a, c) => a + (c.frf || 0), 0), adv.fbmOnly.refundedAmount, "daily frf sums to fbmOnly.refundedAmount");
  assert.equal(r1.daily.reduce((a, c) => a + (c.flc || 0), 0), adv.fbmOnly.sellerBorneLabelCost, "daily flc sums to fbmOnly.sellerBorneLabelCost");
});

test("13. moneyAvailableThrough = the max NONBLANK-ASIN settlement_date received (null when none); freshness.latestReconciliation = min(asOf - grace, moneyAvailableThrough), null without money", () => {
  const graceCut = addDaysStr(ASOF, -21);
  const recent = buildAdv({ durableSettlementRows: [dRefund(d(30), "R1", "SKU-R1", "USD", { amount: -5, qty: -1 }), dRefund(d(10), "R1", "SKU-R1", "USD", { amount: -5, qty: -1 }), dOrder(d(1), "", "SKU-X", "USD", 9, 1)] });
  assert.equal(recent.moneyAvailableThrough, d(10), "the blank-ASIN row on d(1) never extends the money");
  assert.equal(recent.freshness.latestReconciliation, graceCut, "money newer than the grace cut -> the grace cut");
  assert.equal(recent.freshness.latestSettlementDate, recent.moneyAvailableThrough, "the same nonblank-ASIN rule as latestSettlementDate");
  const old = buildAdv({ durableSettlementRows: [dOrder(d(40), "R1", "SKU-R1", "USD", 100, 2), dRefund(d(25), "R1", "SKU-R1", "USD", { amount: -5, qty: -1 })] });
  assert.ok(old.moneyAvailableThrough === d(25) && old.freshness.latestReconciliation === d(25), "money OLDER than the grace cut caps the reconciliation");
  const none = buildAdv({ durableReturnRows: [dRet(d(2), "R1", "SKU-R1", "DEFECTIVE", "FBA", "Approved", 1)] });
  assert.ok(none.moneyAvailableThrough === null && none.freshness.latestReconciliation === null, "no money -> nothing reconciled");
  const blankOnly = buildAdv({ durableSettlementRows: [dOrder(d(1), " ", "SKU-X", "USD", 9, 1)] });
  assert.ok(blankOnly.moneyAvailableThrough === null && blankOnly.freshness.latestReconciliation === null, "blank-ASIN money only -> null");
});

test("14. returnsCoveredThrough = the CONTIGUOUS 'returns' coverage end <= asOf from the optional coverage input; absent / unreadable / empty -> null", () => {
  const cov = (windows, read = "ok") => ({ read, windows });
  const at = (c) => buildAdv({ returnsCoverage: c }).returnsCoveredThrough;
  assert.equal(at(undefined), null, "no coverage input (a caller without the reader)");
  assert.equal(at(null), null);
  assert.equal(at(cov([{ from: FROM, to: d(1) }], "read-failed")), null, "an unreadable coverage read");
  assert.equal(at(cov([{ from: FROM, to: d(1) }], "schema-missing")), null, "schema missing");
  assert.equal(at({ read: "ok", windows: null }), null, "a malformed read");
  assert.equal(at(cov([])), null, "a legacy-only account: read ok, no 'returns' window");
  assert.equal(at(cov([{ from: addDaysStr(FROM, -1), to: d(1) }])), d(1), "one window covering the window start -> its end (the 1-day tail is unavailable)");
  assert.equal(at(cov([{ from: FROM, to: addDaysStr(ASOF, 5) }])), ASOF, "clamped to asOf");
  assert.equal(at(cov([{ from: d(20), to: d(5) }, { from: addDaysStr(FROM, -3), to: d(21) }])), d(5), "TOUCHING windows merge (unordered input)");
  assert.equal(at(cov([{ from: FROM, to: d(12) }, { from: d(10), to: d(3) }])), d(12), "a 1-day HOLE (d(11)) ends the contiguous run");
  assert.equal(at(cov([{ from: FROM, to: d(12) }, { from: d(10), to: d(3) }, { from: d(11), to: d(11) }])), d(3), "... and a 1-day window closing the hole merges the run through");
  assert.equal(at(cov([{ from: FROM, to: d(30) }, { from: d(25), to: ASOF }])), d(30), "later coverage is never claimed across a hole");
  assert.equal(at(cov([{ from: addDaysStr(FROM, -40), to: addDaysStr(FROM, -10) }, { from: addDaysStr(FROM, 3), to: ASOF }])), addDaysStr(FROM, -10),
    "the window START inside a hole (a reported coverage gap) -> the earlier run's end (< from): every window day reads unavailable");
  assert.equal(at(cov([{ from: d(10), to: d(2) }])), d(2), "coverage that BEGINS inside the window: earlier days predate the source (legacy, kept); its end is the cutoff");
  assert.equal(at(cov([{ from: addDaysStr(ASOF, 1), to: addDaysStr(ASOF, 9) }])), null, "every window starts after asOf -> null");
  assert.equal(at(cov([{ from: d(3), to: d(9) }, { from: "x", to: "y" }, null, { from: FROM }, { to: d(1) }])), null, "inverted / malformed / partial windows are ignored");
  assert.equal(returnsCoverageEnd([{ from: FROM, to: ASOF }], { from: FROM, asOf: "bad" }), null, "an invalid asOf -> null");
  assert.equal(returnsCoverageEnd(null, { from: FROM, asOf: ASOF }), null, "no windows array -> null");
  assert.equal(returnsCoverageEnd([{ from: FROM, to: ASOF }], { asOf: ASOF }), ASOF, "no window start -> the first covered day is the reference");
  const withCov = buildAdv({ ...RICH, returnsCoverage: cov([{ from: FROM, to: d(2) }]) });
  const without = buildAdv(RICH);
  assert.equal(withCov.returnsCoveredThrough, d(2));
  assert.deepEqual({ ...withCov, returnsCoveredThrough: null, returnsCoverageWindows: null, returnsLegacyCoveredThrough: null }, without, "ONLY the coverage fields depend on the coverage input");
  assert.ok(without.returnsCoverageWindows === null && without.returnsLegacyCoveredThrough === null, "no coverage input -> both per-day fields null");
});

test("15. schema markers: returnsSchema 2 + rollingDays 14 (== the event source's RETURNS_ROLLING_DAYS, unconditional); every new key is APPENDED; the live v3 validator accepts the payload", async () => {
  const p = buildAdv({ ...RICH, returnsCoverage: { read: "ok", windows: [{ from: FROM, to: d(1) }] } });
  assert.ok(p.returnsSchema === 2 && RETURNS_PAYLOAD_SCHEMA === 2 && p.rollingDays === 14 && RETURNS_PAYLOAD_ROLLING_DAYS === 14);
  assert.deepEqual(Object.keys(p).slice(-ADDITIVE_TOP.length), ADDITIVE_TOP, "the six top-level fields follow every pre-existing key");
  assert.ok(p.rows.every((r) => Object.keys(r).slice(-1)[0] === "returnQuantity"), "returnQuantity is the LAST row key");
  const NEW = new Set(ADDITIVE_CELL);
  assert.ok(p.rows.every((r) => r.daily.every((c) => { const k = Object.keys(c); const i = k.findIndex((x) => NEW.has(x)); return i < 0 || k.slice(i).every((x) => NEW.has(x)); })), "rq / rqx / frf / flc follow every pre-existing cell key");
  // MAIN (scheduler) line: no returns-leakage-v3 derivation validator exists here -- the scheduled write gate is the
  // materialization operator's (a payload + a dated { to } identity = latestDataDate), which the schema-2 payload meets.
  assert.equal(REPORT_DERIVATIONS["returns-leakage-v3"], undefined, "this line has no returns-leakage-v3 derivation entry (the operator gate below applies)");
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(String(p.latestDataDate)), "the schema-2 payload carries the dated { to } identity the materialization operator requires");
  assert.equal(p.rollingDays, RETURNS_ROLLING_DAYS, "payload.rollingDays == returns-event-source.js RETURNS_ROLLING_DAYS (drift pin)");
  assert.equal(RETURNS_PAYLOAD_ROLLING_DAYS, RETURNS_ROLLING_DAYS, "the inlined builder constant == the core constant");
});

// ---- per-day coverage evidence (review A1 / A4) ----
// A post-legacy as-of: the window 2026-08-05..2026-10-03 straddles the legacy pipeline's last saved day (2026-08-31).
const AS2 = "2026-10-03";
const FROM2 = addDaysStr(AS2, -59);
const build2 = (over = {}) => buildReturnsAdvancedPayload({
  accountId: "A2", asOf: AS2, from: FROM2, windowDays: WINDOW, ...LABELS,
  durableReturnRows: [], durableSettlementRows: [], orderedRows: [], catalogRows: [], ...over,
});
const LEGACY_ROWS = [
  uRet("2026-08-10", "R1", "SKU-R1", "DEFECTIVE", "FBA", "Approved", 2, null),
  uRet("2026-08-31", "R1", "SKU-R1", "TOO_SMALL", "FBM", "Approved", 1, undefined),
];

test("16. returnsCoverageWindows = the event-source windows MERGED + CLIPPED to [from, asOf]; ok-but-empty -> []; unreadable / absent / malformed -> null; a gap is kept (later covered days stay covered)", () => {
  const cov = (windows, read = "ok") => ({ read, windows });
  const at = (c) => build2({ returnsCoverage: c }).returnsCoverageWindows;
  assert.equal(at(undefined), null, "no coverage input");
  assert.equal(at(cov([{ from: FROM2, to: AS2 }], "read-failed")), null, "unreadable");
  assert.equal(at(cov([], "schema-missing")), null, "schema missing");
  assert.equal(at({ read: "ok", windows: null }), null, "malformed read");
  assert.deepEqual(at(cov([])), [], "read ok, no 'returns' window: [] (NOT null -- nothing is covered)");
  assert.deepEqual(at(cov([{ from: "2026-07-01", to: "2026-12-31" }])), [{ from: FROM2, to: AS2 }], "clipped to [from, asOf]");
  assert.deepEqual(at(cov([{ from: "2026-09-20", to: "2026-10-01" }, { from: "2026-07-27", to: "2026-09-10" }, { from: "2026-09-11", to: "2026-09-12" }])),
    [{ from: FROM2, to: "2026-09-12" }, { from: "2026-09-20", to: "2026-10-01" }], "touching windows merge (unordered input); the 09-13..09-19 GAP is kept and the later run survives");
  assert.deepEqual(at(cov([{ from: "2026-06-01", to: "2026-07-31" }, { from: "2026-10-05", to: "2026-10-09" }])), [], "windows wholly outside [from, asOf] prove no day of it");
  assert.deepEqual(at(cov([{ from: "x", to: AS2 }, { from: "2026-09-02", to: "2026-09-01" }, null, { from: "2026-09-25" }, { from: "2026-09-25", to: "2026-09-26" }])),
    [{ from: "2026-09-25", to: "2026-09-26" }], "malformed / inverted / partial windows are ignored");
  // returnsCoveredThrough (compatibility) keeps the FIRST-run semantics next to the new per-day evidence.
  const gap = build2({ returnsCoverage: cov([{ from: "2026-07-27", to: "2026-09-12" }, { from: "2026-09-20", to: AS2 }]) });
  assert.equal(gap.returnsCoveredThrough, "2026-09-12", "compat field: the first contiguous run end (unchanged)");
  assert.deepEqual(gap.returnsCoverageWindows, [{ from: FROM2, to: "2026-09-12" }, { from: "2026-09-20", to: AS2 }], "per-day evidence: both runs");
});

test("17. returnsLegacyCoveredThrough: ok-but-empty + saved legacy rows -> min(asOf, 2026-08-31); NO saved row -> null (nothing covered, never a fabricated 0); unreadable -> null; never past the event source's first day", () => {
  const empty = { read: "ok", windows: [] };
  const legacy = build2({ durableReturnRows: LEGACY_ROWS, returnsCoverage: empty });
  assert.deepEqual(legacy.returnsCoverageWindows, [], "the event source covered nothing");
  assert.equal(legacy.returnsLegacyCoveredThrough, RETURNS_LEGACY_SAVED_THROUGH, "legacy rows -> their saved horizon counts (counts only)");
  assert.equal(legacy.returnsCoveredThrough, null, "compat field unchanged: null for ok-but-empty");
  const none = build2({ returnsCoverage: empty });
  assert.ok(none.returnsLegacyCoveredThrough === null && Array.isArray(none.returnsCoverageWindows) && none.returnsCoverageWindows.length === 0, "no history row at all -> nothing covered");
  const lateOnly = build2({ durableReturnRows: [uRet("2026-09-15", "R1", "SKU-R1", "DEFECTIVE", "FBA", "Approved", 1, 1)], returnsCoverage: empty });
  assert.equal(lateOnly.returnsLegacyCoveredThrough, null, "rows only AFTER the legacy horizon are no legacy evidence (e.g. a load whose coverage was removed)");
  const unreadable = build2({ durableReturnRows: LEGACY_ROWS, returnsCoverage: { read: "read-failed", windows: [] } });
  assert.ok(unreadable.returnsLegacyCoveredThrough === null && unreadable.returnsCoverageWindows === null, "unreadable coverage -> both null (today's behaviour)");
  const early = buildReturnsAdvancedPayload({ accountId: "A3", asOf: "2026-08-20", from: addDaysStr("2026-08-20", -59), windowDays: WINDOW, ...LABELS, durableReturnRows: LEGACY_ROWS, returnsCoverage: empty });
  assert.equal(early.returnsLegacyCoveredThrough, "2026-08-20", "clamped to asOf");
  // Coverage that BEGINS inside the window: the days before the event source's first day are legacy (counts only).
  const startsInside = build2({ durableReturnRows: LEGACY_ROWS, returnsCoverage: { read: "ok", windows: [{ from: "2026-08-20", to: AS2 }] } });
  assert.equal(startsInside.returnsLegacyCoveredThrough, "2026-08-19", "the legacy span stops the day before the first event-source day");
  assert.deepEqual(startsInside.returnsCoverageWindows, [{ from: "2026-08-20", to: AS2 }]);
  const startsBefore = build2({ durableReturnRows: LEGACY_ROWS, returnsCoverage: { read: "ok", windows: [{ from: "2026-08-01", to: AS2 }] } });
  assert.equal(startsBefore.returnsLegacyCoveredThrough, null, "the event source covers the whole window start: no legacy span");
  // The pure helper directly.
  assert.deepEqual(returnsCoverageEvidence(null, { from: FROM2, asOf: AS2, rows: LEGACY_ROWS }), { windows: null, legacyThrough: null });
  assert.deepEqual(returnsCoverageEvidence([], { from: FROM2, asOf: "bad", rows: LEGACY_ROWS }), { windows: null, legacyThrough: null }, "an invalid asOf proves nothing");
  assert.deepEqual(returnsCoverageEvidence([], { from: FROM2, asOf: AS2, rows: [{ return_date: "2026-08-04" }] }), { windows: [], legacyThrough: null }, "a row BEFORE the window is not evidence for it");
  assert.deepEqual(returnsCoverageEvidence([], { from: FROM2, asOf: AS2, rows: [{ return_date: FROM2 }] }), { windows: [], legacyThrough: "2026-08-31" });
});

test("18. RETURNS_LEGACY_SAVED_THROUGH is the legacy manual pipeline's last saved day (2026-08-31); the new keys never move a pre-existing field", () => {
  assert.equal(RETURNS_LEGACY_SAVED_THROUGH, "2026-08-31");
  const a = build2({ ...RICH, durableReturnRows: [...RICH.durableReturnRows, ...LEGACY_ROWS], returnsCoverage: { read: "ok", windows: [] } });
  const b = build2({ ...RICH, durableReturnRows: [...RICH.durableReturnRows, ...LEGACY_ROWS] });
  const strip = (p) => { const c = JSON.parse(JSON.stringify(p)); for (const k of ["returnsCoveredThrough", "returnsCoverageWindows", "returnsLegacyCoveredThrough"]) delete c[k]; return c; };
  assert.deepEqual(strip(a), strip(b), "rows / series / money / counts are identical with or without the coverage evidence");
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
