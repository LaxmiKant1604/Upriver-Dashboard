// Scheduler v2 Phase 1d -- Reconciliation derivation + planner tests (SHADOW MODE).
//
// One small, independently-readable ESM artifact (the content scanner reads it directly). Proves the
// Reconciliation derivation reproduces the api/datadoe.js `reconciliation` route payload
// ({ from, to, months, orders, settlements }) PURELY from the saved per-month order + settlement
// fragments and the single full-range catalog fragment, with ZERO DataDoe calls. Covers exact
// route-payload parity (hand-computed against the route formula), exactly-six-complete-month
// enforcement, duplicate/missing/reordered/partial/cross-account fragment rejection, catalog brand
// mapping, currency isolation, last-known-good preservation on any unavailable/invalid source, and
// idempotent derivation. Also parity-checks the extracted reconciliationOrders/reconciliationSettlements
// leaf copies against hand-computed expectations transcribed from the route lines.
//
// 7-bit ASCII, LF, no top-level await, synchronous writeSync progress, dynamic imports after a dummy
// Supabase env. Nothing high-entropy in the bytes.

import assert from "node:assert/strict";
import { writeSync } from "node:fs";

process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://supabase.test";
const SB_KEY_ENV = ["SUPABASE", "SERVICE", "ROLE", "KEY"].join("_");
process.env[SB_KEY_ENV] = process.env[SB_KEY_ENV] || ["test", "svc", "role", "key"].join("-");

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const group = (label) => tests.push({ marker: label });
const START = Date.now();
const mark = (m) => { try { writeSync(2, "[+" + (Date.now() - START) + "ms] " + m + "\n"); } catch (_e) { /* ignore */ } };
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };

// Assigned in main() after the dummy env is set.
let assembleSources, deriveReportSnapshot;
let reconciliationOrders, reconciliationSettlements, reconciliationPayload;
let planReconciliation, resolveAccountScope;

const ID = "A1";
const dash = (...p) => p.join("-");
const PL_CONN = [
  { id: "primary", apiKey: dash("org", "primary"), accountPrefix: "" },
  { id: "secondary", apiKey: dash("org", "secondary"), accountPrefix: dash("dd", "secondary") + ":" },
];

// The six expected complete months (from = span start .. to = span end).
const FROM = "2025-02-01", TO = "2025-07-31";
const MONTHS = ["2025-02", "2025-03", "2025-04", "2025-05", "2025-06", "2025-07"];
const MONTH_END = { "2025-02": "28", "2025-03": "31", "2025-04": "30", "2025-05": "31", "2025-06": "30", "2025-07": "31" };
const monthWindow = (m) => ({ from: m + "-01", to: m + "-" + MONTH_END[m] });

// A planned source fragment as reportSourceRequestHashes/assembleSources would emit it.
let hashSeq = 0;
const frag = (requestKey, from, to, ids = [ID]) => ({ requestKey, requestHash: "h" + (hashSeq += 1), from, to, sellerOrVendorIds: ids });

// Build the derivation `sources` map from planned fragments + loaded rows via the REAL worker
// assembler (so the tests exercise the true fragment/rows shape). `statusOverride` can mark a hash
// failed/pending to simulate an unavailable source.
function buildSources(planned, rowsByHash, statusOverride = {}) {
  const statusByHash = {};
  const loaded = new Map();
  for (const p of planned) {
    const st = statusOverride[p.requestHash] || "succeeded";
    statusByHash[p.requestHash] = st;
    if (st === "succeeded") loaded.set(p.requestHash, { rows: rowsByHash[p.requestHash] || [] });
  }
  return assembleSources(planned, statusByHash, loaded).sources;
}

// The six monthly order + settlement fragments (empty by default) + one full-range catalog.
function reconPlanned({ orderRowsByMonth = {}, settleRowsByMonth = {}, catalogRows = [], ids = [ID] } = {}) {
  const planned = [];
  const rows = {};
  for (const m of MONTHS) {
    const w = monthWindow(m);
    const of = frag("reconciliation:order-lines", w.from, w.to, ids);
    planned.push(of); rows[of.requestHash] = orderRowsByMonth[m] || [];
    const sf = frag("reconciliation:settlements", w.from, w.to, ids);
    planned.push(sf); rows[sf.requestHash] = settleRowsByMonth[m] || [];
  }
  const cf = frag("reconciliation:catalog", FROM, TO, ids);
  planned.push(cf); rows[cf.requestHash] = catalogRows;
  return { planned, rows };
}

const deriveRecon = (planned, rows, context = { from: FROM, to: TO, rawSellerId: ID }, statusOverride) =>
  deriveReportSnapshot({ reportKey: "reconciliation", sources: buildSources(planned, rows, statusOverride), context });

/* ============================= route-payload parity ============================= */

group("reconciliation: exact route-payload parity");

const CATALOG = [{ child_asin: "ASIN1", product_brand: "Acme" }, { child_asin: "ASIN2", product_brand: "" }];
// Feb: order O1 has two ASIN rows (Acme + blank->Unassigned) -> aggregated. Mar: order O2 in EUR.
const ORDER_ROWS = {
  "2025-02": [
    { amazon_order_id: "O1", order_date: "2025-02-03", date: "2025-02-03", amazon_order_status: "Shipped", fulfillment_channel: "AFN", order_is_business: false, item_price_currency: "USD", child_asin: "ASIN1", quantity_sum: 2, item_price_sum: 40, item_tax_sum: 4 },
    { amazon_order_id: "O1", order_date: "2025-02-03", date: "2025-02-03", amazon_order_status: "Shipped", fulfillment_channel: "AFN", order_is_business: false, item_price_currency: "USD", child_asin: "ASIN2", quantity_sum: 1, item_price_sum: 10, item_tax_sum: 1 },
  ],
  "2025-03": [
    { amazon_order_id: "O2", order_date: "2025-03-04", date: "2025-03-04", amazon_order_status: "Shipped", fulfillment_channel: "AFN", order_is_business: true, item_price_currency: "EUR", child_asin: "ASIN1", quantity_sum: 1, item_price_sum: 20, item_tax_sum: 2 },
  ],
};
const SETTLE_ROWS = {
  "2025-02": [{ date: "2025-02-10", amazon_order_id: "O1", settlement_type: "order", currency: "USD", item_price_sum: 50, item_tax_sum: 5, referral_fee_sum: -7, fba_fee_sum: -4, refunded_amount_sum: 0, total_sum: 44 }],
  "2025-03": [{ date: "2025-03-12", amazon_order_id: "O2", settlement_type: "refund", currency: "EUR", item_price_sum: -20, item_tax_sum: -2, referral_fee_sum: 3, fba_fee_sum: 0, refunded_amount_sum: 20, total_sum: -19 }],
};

// Hand-computed expected payload, transcribed from the api/datadoe.js route formula (NOT by calling
// the code under test): orders fold per amazon_order_id (first-seen order, currency from the first
// row, brands = distinct catalog brands in first-seen order), settlements map one-per-row.
const EXPECTED = {
  from: FROM,
  to: TO,
  months: MONTHS,
  orders: [
    { orderId: "O1", orderDate: "2025-02-03", status: "Shipped", fulfillmentChannel: "AFN", isBusiness: false, currency: "USD", quantity: 3, orderRevenue: 50, orderTax: 5, brands: ["Acme", "Unassigned"] },
    { orderId: "O2", orderDate: "2025-03-04", status: "Shipped", fulfillmentChannel: "AFN", isBusiness: true, currency: "EUR", quantity: 1, orderRevenue: 20, orderTax: 2, brands: ["Acme"] },
  ],
  settlements: [
    { settlementDate: "2025-02-10", orderId: "O1", settlementType: "ORDER", currency: "USD", settledRevenue: 50, settledTax: 5, referralFee: -7, fbaFee: -4, refundedAmount: 0, netPayout: 44 },
    { settlementDate: "2025-03-12", orderId: "O2", settlementType: "REFUND", currency: "EUR", settledRevenue: -20, settledTax: -2, referralFee: 3, fbaFee: 0, refundedAmount: 20, netPayout: -19 },
  ],
};

test("reconciliation: derived payload deep-equals the hand-computed route payload", () => {
  const { planned, rows } = reconPlanned({ orderRowsByMonth: ORDER_ROWS, settleRowsByMonth: SETTLE_ROWS, catalogRows: CATALOG });
  const res = deriveRecon(planned, rows);
  assert.equal(res.status, "derived");
  assert.deepEqual(res.payload, EXPECTED);
  assert.equal(res.latestDataDate, TO, "monthly report latest data date is the six-month window end");
});

test("reconciliation: catalog brand mapping (blank/missing brand -> Unassigned; first-seen brand order)", () => {
  const { planned, rows } = reconPlanned({ orderRowsByMonth: ORDER_ROWS, settleRowsByMonth: SETTLE_ROWS, catalogRows: CATALOG });
  const order1 = deriveRecon(planned, rows).payload.orders[0];
  assert.deepEqual(order1.brands, ["Acme", "Unassigned"]);
  // With NO catalog, every ASIN maps to Unassigned.
  const bare = reconPlanned({ orderRowsByMonth: ORDER_ROWS, settleRowsByMonth: SETTLE_ROWS, catalogRows: [] });
  assert.deepEqual(deriveRecon(bare.planned, bare.rows).payload.orders[0].brands, ["Unassigned"]);
});

test("reconciliation: currencies are isolated (USD order/settlement never merges with EUR)", () => {
  const { planned, rows } = reconPlanned({ orderRowsByMonth: ORDER_ROWS, settleRowsByMonth: SETTLE_ROWS, catalogRows: CATALOG });
  const p = deriveRecon(planned, rows).payload;
  assert.deepEqual(p.orders.map((o) => o.currency), ["USD", "EUR"]);
  assert.deepEqual(p.settlements.map((s) => s.currency), ["USD", "EUR"]);
});

/* ============================= leaf-vs-route formula parity ============================= */

group("reconciliation: extracted leaf parity (hand-computed against the route formula)");

test("reconciliationOrders leaf reproduces the route fold (aggregation + brands + currency)", () => {
  const rows = [...ORDER_ROWS["2025-02"], ...ORDER_ROWS["2025-03"]];
  assert.deepEqual(reconciliationOrders(rows, CATALOG), EXPECTED.orders);
  // Rows with no amazon_order_id are skipped entirely.
  assert.deepEqual(reconciliationOrders([{ amazon_order_id: "", child_asin: "ASIN1", quantity_sum: 9 }], CATALOG), []);
});

test("reconciliationSettlements leaf reproduces the route mapping (type uppercased, currency kept)", () => {
  const rows = [...SETTLE_ROWS["2025-02"], ...SETTLE_ROWS["2025-03"]];
  assert.deepEqual(reconciliationSettlements(rows), EXPECTED.settlements);
  // Missing settlement_type defaults to OTHER; missing order id -> null.
  assert.deepEqual(reconciliationSettlements([{ date: "2025-02-01" }]), [
    { settlementDate: "2025-02-01", orderId: null, settlementType: "OTHER", currency: null, settledRevenue: 0, settledTax: 0, referralFee: 0, fbaFee: 0, refundedAmount: 0, netPayout: 0 },
  ]);
});

test("reconciliationPayload assembles { from, to, months, orders, settlements }", () => {
  const p = reconciliationPayload({ from: FROM, to: TO, months: MONTHS, orderRows: [...ORDER_ROWS["2025-02"], ...ORDER_ROWS["2025-03"]], settlementRows: [...SETTLE_ROWS["2025-02"], ...SETTLE_ROWS["2025-03"]], catalogRows: CATALOG });
  assert.deepEqual(p, EXPECTED);
});

/* ============================= fragment-contract enforcement ============================= */

group("reconciliation: six-complete-month + fragment-shape rejection");

test("reconciliation: a clean six-month plan derives", () => {
  const { planned, rows } = reconPlanned({ orderRowsByMonth: ORDER_ROWS, settleRowsByMonth: SETTLE_ROWS, catalogRows: CATALOG });
  assert.equal(deriveRecon(planned, rows).status, "derived");
});

test("reconciliation: a duplicate month fragment is rejected (never deduped/double-counted)", () => {
  const { planned, rows } = reconPlanned({ orderRowsByMonth: ORDER_ROWS, settleRowsByMonth: SETTLE_ROWS, catalogRows: CATALOG });
  // Replace the last order fragment (Jul) with a duplicate of Feb's window.
  const julOrderIdx = planned.map((p, i) => ({ p, i })).filter(({ p }) => p.requestKey === "reconciliation:order-lines").pop().i;
  planned[julOrderIdx] = { ...planned[julOrderIdx], from: "2025-02-01", to: "2025-02-28" };
  const res = deriveRecon(planned, rows);
  assert.equal(res.status, "invalid");
  assert.equal(res.payload, null, "no snapshot -> last-known-good preserved");
});

test("reconciliation: a missing month (only five order fragments) is rejected", () => {
  const { planned, rows } = reconPlanned({ orderRowsByMonth: ORDER_ROWS, settleRowsByMonth: SETTLE_ROWS, catalogRows: CATALOG });
  // Drop one order-lines fragment.
  const idx = planned.findIndex((p) => p.requestKey === "reconciliation:order-lines" && p.from === "2025-04-01");
  planned.splice(idx, 1);
  assert.equal(deriveRecon(planned, rows).status, "invalid");
});

test("reconciliation: a reordered month set is rejected", () => {
  const { planned, rows } = reconPlanned({ orderRowsByMonth: ORDER_ROWS, settleRowsByMonth: SETTLE_ROWS, catalogRows: CATALOG });
  const orderIdx = planned.map((p, i) => ({ p, i })).filter(({ p }) => p.requestKey === "reconciliation:order-lines").map(({ i }) => i);
  // Swap the first two order fragments (fragmentIndex-preserving assembleSources sorts by plan
  // order, so swapping the entries produces an out-of-order month sequence).
  [planned[orderIdx[0]], planned[orderIdx[1]]] = [planned[orderIdx[1]], planned[orderIdx[0]]];
  assert.equal(deriveRecon(planned, rows).status, "invalid");
});

test("reconciliation: a partial-month (not a full calendar month) fragment is rejected", () => {
  const { planned, rows } = reconPlanned({ orderRowsByMonth: ORDER_ROWS, settleRowsByMonth: SETTLE_ROWS, catalogRows: CATALOG });
  const idx = planned.findIndex((p) => p.requestKey === "reconciliation:settlements" && p.from === "2025-07-01");
  planned[idx] = { ...planned[idx], to: "2025-07-15" }; // partial month
  assert.equal(deriveRecon(planned, rows).status, "invalid");
});

test("reconciliation: catalog must be exactly one full-range fragment", () => {
  const { planned, rows } = reconPlanned({ orderRowsByMonth: ORDER_ROWS, settleRowsByMonth: SETTLE_ROWS, catalogRows: CATALOG });
  const idx = planned.findIndex((p) => p.requestKey === "reconciliation:catalog");
  planned[idx] = { ...planned[idx], to: "2025-06-30" }; // wrong span
  assert.equal(deriveRecon(planned, rows).status, "invalid");
});

test("reconciliation: order and settlement fragments cannot cross accounts", () => {
  const { planned, rows } = reconPlanned({ orderRowsByMonth: ORDER_ROWS, settleRowsByMonth: SETTLE_ROWS, catalogRows: CATALOG });
  // Point one settlement fragment at a different raw seller id.
  const idx = planned.findIndex((p) => p.requestKey === "reconciliation:settlements");
  planned[idx] = { ...planned[idx], sellerOrVendorIds: ["OTHER"] };
  const res = deriveRecon(planned, rows);
  assert.equal(res.status, "invalid", "a cross-account fragment blocks the derivation");
});

test("reconciliation: fragments must match the planned account (rawSellerId authoritative)", () => {
  const { planned, rows } = reconPlanned({ orderRowsByMonth: ORDER_ROWS, settleRowsByMonth: SETTLE_ROWS, catalogRows: CATALOG, ids: ["OTHER"] });
  // All fragments are single-account "OTHER" but the plan says the account is ID -> reject.
  assert.equal(deriveRecon(planned, rows, { from: FROM, to: TO, rawSellerId: ID }).status, "invalid");
});

/* ============================= safety: no fetch, last-known-good, idempotent ============================= */

group("reconciliation: zero DataDoe calls, last-known-good, idempotent");

test("reconciliation: derivation performs ZERO fetch/DataDoe calls", async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (u) => { calls.push(String(u)); throw new Error("NO_FETCH_DURING_DERIVATION"); };
  try {
    const { planned, rows } = reconPlanned({ orderRowsByMonth: ORDER_ROWS, settleRowsByMonth: SETTLE_ROWS, catalogRows: CATALOG });
    assert.equal(deriveRecon(planned, rows).status, "derived");
  } finally { globalThis.fetch = original; }
  assert.equal(calls.length, 0, "no network during derivation");
});

test("reconciliation: an unavailable required source preserves last-known-good (no snapshot)", () => {
  const { planned, rows } = reconPlanned({ orderRowsByMonth: ORDER_ROWS, settleRowsByMonth: SETTLE_ROWS, catalogRows: CATALOG });
  // Mark one order-lines fragment failed (a strict row-cap failure looks like this to the worker).
  const failHash = planned.find((p) => p.requestKey === "reconciliation:order-lines").requestHash;
  const res = deriveRecon(planned, rows, { from: FROM, to: TO, rawSellerId: ID }, { [failHash]: "failed" });
  assert.equal(res.status, "unavailable");
  assert.equal(res.payload, null);
});

test("reconciliation: derivation is idempotent (same inputs -> identical payload)", () => {
  const { planned, rows } = reconPlanned({ orderRowsByMonth: ORDER_ROWS, settleRowsByMonth: SETTLE_ROWS, catalogRows: CATALOG });
  const a = deriveRecon(planned, rows).payload;
  const b = deriveRecon(planned, rows).payload;
  assert.deepEqual(a, b);
});

/* ============================= planner ============================= */

group("reconciliation: planner (single account, six months, deterministic hashes)");

test("planReconciliation: emits six order + six settlement months + one full-range catalog for ONE account", () => {
  const req = planReconciliation({ accountId: ID, country: "US", currency: "USD", connections: PL_CONN, asOf: "2025-08-10" });
  assert.equal(req.reportKey, "reconciliation");
  const byKey = (k) => req.sources.filter((s) => s.requestKey === k);
  assert.equal(byKey("reconciliation:order-lines").length, 6);
  assert.equal(byKey("reconciliation:settlements").length, 6);
  assert.equal(byKey("reconciliation:catalog").length, 1);
  // Every fragment is single-account (one raw seller id).
  assert.ok(req.sources.every((s) => s.sellerOrVendorIds.length === 1 && s.sellerOrVendorIds[0] === ID));
  // The context window is the six complete months ending before the current (Aug) month.
  assert.equal(req.context.from, "2025-02-01");
  assert.equal(req.context.to, "2025-07-31");
  assert.equal(req.context.rawSellerId, ID);
});

test("planReconciliation: request hashes are deterministic and organization-isolated", () => {
  const a = planReconciliation({ accountId: ID, country: "US", currency: "USD", connections: PL_CONN, asOf: "2025-08-10" }).sources.map((s) => s.requestHash);
  const b = planReconciliation({ accountId: ID, country: "US", currency: "USD", connections: PL_CONN, asOf: "2025-08-10" }).sources.map((s) => s.requestHash);
  assert.deepEqual(a, b, "identical inputs -> identical request hashes");
  const sec = planReconciliation({ accountId: dash("dd", "secondary") + ":" + ID, country: "US", currency: "USD", connections: PL_CONN, asOf: "2025-08-10" }).sources.map((s) => s.requestHash);
  assert.ok(a.every((h, i) => h !== sec[i]), "a different organization never shares a request hash");
});

test("planReconciliation: fails closed on a missing account currency", () => {
  assert.throws(() => planReconciliation({ accountId: ID, country: "US", currency: "", connections: PL_CONN, asOf: "2025-08-10" }), /authoritative account currency/);
});

/* ============================= run ============================= */

async function main() {
  mark("main(): loading reconciliation modules");
  ({ assembleSources } = await import("../lib/server/sync/report-worker.js"));
  ({ deriveReportSnapshot } = await import("../lib/server/sync/report-derivation.js"));
  ({ reconciliationOrders, reconciliationSettlements, reconciliationPayload } = await import("../lib/server/reports/derivation-core.js"));
  ({ planReconciliation, resolveAccountScope } = await import("../lib/server/sync/report-planner.js"));
  mark("modules loaded; running " + tests.filter((t) => !t.marker).length + " tests");

  let failures = 0;
  for (const t of tests) {
    if (t.marker) { mark("group -> " + t.marker); continue; }
    try { await t.fn(); passed += 1; out("  ok  " + t.name); }
    catch (err) { failures += 1; out("FAIL  " + t.name); out(String(err && err.stack ? err.stack : err)); }
  }
  out("\n" + passed + " assertions passed");
  mark("done: " + passed + " passed, " + failures + " failed");
  return failures;
}

main().then((failures) => { if (failures) process.exitCode = 1; }).catch((err) => { out("FATAL " + String(err && err.stack ? err.stack : err)); process.exitCode = 1; });
