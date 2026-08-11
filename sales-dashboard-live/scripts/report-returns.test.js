// Returns & Refund Leakage Scheduler-v2 derivation + generic-cycle parity tests (SHADOW MODE, offline).
//
// Part A drives deriveReportSnapshot("returns-leakage") against hand-built saved fragments and proves the
// pure payload deep-equals a hand-computed production-route fixture, plus reason classification + stable
// ordering, FBA/FBM/pending counts, currency isolation, ORDER vs REFUND money, the zero-clamped return fee,
// catalog/traffic name precedence, no-return/no-refund exclusion, public/raw identity, the exact 60-day
// window, malformed/out-of-window return dates fail-closed, missing-source LKG, and zero network. Part B
// drives the REAL buildShadowReportPlan -> runStagedSourceCycle -> runReportJobs path (shared-catalog dedup,
// coexistence, strict-cap, resume, primary-only, pending-then-saved-once).

import assert from "node:assert/strict";
import { writeSync } from "node:fs";

process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://supabase.test";
const SB_KEY_ENV = ["SUPABASE", "SERVICE", "ROLE", "KEY"].join("_");
process.env[SB_KEY_ENV] = process.env[SB_KEY_ENV] || ["test", "svc", "role", "key"].join("-");

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const group = (label) => tests.push({ marker: label });
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };

let assembleSources, deriveReportSnapshot, runReportJobs, runSourceJobs, plannedSourceJob, runStagedSourceCycle, sourceJobOwnerId;
let planReturnsLeakage, planBuyBoxLoss, planSalesMovers, buildShadowReportPlan, SHADOW_PLANNED_REPORT_KEYS, addDaysStr;

const ID = "A1";
const ASOF = "2025-08-10";
const dash = (...p) => p.join("-");
const CONNS = [
  { id: "primary", apiKey: dash("prim", "key"), accountPrefix: "" },
  { id: "secondary", apiKey: dash("sec", "key"), accountPrefix: dash("dd", "secondary") + ":" },
];
const RETURNS_LABEL = "Returns (FBA & FBM)";
const MONEY_LABEL = "Settlements & P&L Components";
const RATE_LABEL = "Sales & Traffic by ASIN & Date";
const DRIVER_CONNECTION_ID = { primary: "primary", secondary: "dd-secondary" };

let FROM; // asOf-59d, computed in main()

let hashSeq = 0;
const frag = (requestKey, from, to, ids = [ID]) => ({ requestKey, requestHash: "h" + (hashSeq += 1), from, to, sellerOrVendorIds: ids });

function buildSources(planned, rowsByHash, statusOverride = {}) {
  const statusByHash = {};
  const loaded = new Map();
  for (const p of planned) {
    const st = statusOverride[p.requestHash] || "succeeded";
    statusByHash[p.requestHash] = st;
    if (st === "succeeded") loaded.set(p.requestHash, { rows: Object.prototype.hasOwnProperty.call(rowsByHash, p.requestHash) ? rowsByHash[p.requestHash] : [] });
  }
  return assembleSources(planned, statusByHash, loaded).sources;
}

// One single-account fragment per source over [FROM, ASOF]; catalog is no-date.
function retPlanned({ returns = [], settlements = [], traffic = [], catalog = [], ids = [ID] } = {}) {
  const planned = []; const rows = {};
  const add = (key, from, to, data) => { const f = frag(key, from, to, ids); planned.push(f); rows[f.requestHash] = data; };
  add("returns-leakage:returns", FROM, ASOF, returns);
  add("returns-leakage:settlements", FROM, ASOF, settlements);
  add("returns-leakage:traffic", FROM, ASOF, traffic);
  add("returns-leakage:catalog", null, null, catalog);
  return { planned, rows };
}
const ctx = (over = {}) => ({ to: ASOF, rawSellerId: ID, accountId: ID, ...over });
const deriveRet = (built, context = ctx(), statusOverride) =>
  deriveReportSnapshot({ reportKey: "returns-leakage", sources: buildSources(built.planned, built.rows, statusOverride), context });

// ---- row builders ----
const ret = (date, asin, sku, reason, channel, status, refunded, labelCost, paidBy) => ({
  date, sku, child_asin: asin, amazon_order_id: "O", amazon_return_reason: reason,
  amazon_fulfillment_channel: channel, amazon_return_request_status: status,
  amazon_return_refunded_amount: refunded, amazon_return_label_cost: labelCost, amazon_return_label_to_be_paid_by: paidBy,
});
const order = (asin, sku, currency, itemPrice, qty) => ({ sku, child_asin: asin, settlement_type: "ORDER", currency, item_price_sum: itemPrice, quantity_sum: qty });
const refund = (asin, sku, currency, o) => ({
  sku, child_asin: asin, settlement_type: "REFUND", currency,
  refunded_amount_sum: o.amount || 0, refund_tax_sum: o.tax || 0, refunded_referral_fee_sum: o.referral || 0,
  refund_commission_sum: o.commission || 0, return_unit_fee_sum: o.unitFee || 0, refund_restocking_fee_sum: o.restock || 0,
  cogs_sum: o.cogs || 0, quantity_sum: o.qty || 0,
});
const traf = (asin, name, sales, units, shipped, refunded) => ({ child_asin: asin, product_name: name, sales_sum: sales, units_sum: units, units_shipped_sum: shipped, units_refunded_sum: refunded });
const cat = (asin, parent, name, brand) => ({ child_asin: asin, parent_asin: parent, product_name: name, product_brand: brand });

// ---- the hand-computed production-route fixture ----
const FIXTURE = () => ({
  returns: [
    ret("2025-08-01", "R1", "SKU-R1", "DEFECTIVE", "FBA", "Approved", -10, -2, "Seller"),        // product_quality, FBA, seller label
    ret("2025-07-15", "R1", "SKU-R1", "TOO_SMALL", "FBM", "PendingApproval", -5, -1, "Amazon"),  // sizing, FBM, pending
    ret("2025-07-20", "R1", "SKU-R1b", "DEFECTIVE", "FBA", "Completed", -8, 0, ""),               // product_quality, FBA
    ret("2025-06-20", "R2", "SKU-R2", "", "", "pending", 0, 0, ""),                                // NO_REASON_GIVEN -> low_actionability, UNKNOWN channel, pending
    ret("2025-06-15", "", "", "BROKEN", "FBA", "Approved", -99, -9, "Seller"),                     // empty ASIN: counted in returnRecordCount, skipped in the fold
  ],
  settlements: [
    order("R1", "SKU-R1", "USD", 200, 20),
    refund("R1", "SKU-R1", "USD", { amount: -30, tax: -3, referral: -4, commission: -5, unitFee: -2, restock: -1, cogs: -12, qty: -3 }),
    refund("R1", "SKU-R1", "CAD", { amount: -15, tax: 0, referral: 0, commission: -3, unitFee: 0, restock: -10, cogs: -5, qty: -1 }), // returnFees clamps to 0 (3-10)
    refund("RX", "SKU-X", "USD", { amount: -9, commission: -1, unitFee: -1, restock: 0, cogs: -2, qty: -1 }),                          // money-only ASIN
    order("RY", "SKU-Y", "USD", 100, 10),                                                                                             // order-only, no refund/returns/traffic -> excluded
    order("", "", "USD", 50, 5),                                                                                                       // empty ASIN -> skipped
  ],
  traffic: [
    traf("R1", "Widget R1", 500, 50, 48, 5),
    traf("R2", "Widget R2", 100, 10, 9, 0),
    traf("RT", "Widget RT", 80, 8, 8, 2),   // traffic-only, refunded units > 0 -> included
    traf("RN", "Widget RN", 60, 6, 6, 0),   // traffic-only, no refunded units -> excluded
  ],
  catalog: [
    cat("R1", "P1", "Catalog R1", "Acme"),
    cat("R2", "P2", "", "Beta"),   // blank catalog name -> traffic name fallback
    cat("RT", "P3", "Catalog RT", ""), // blank brand -> Unassigned; brand not added to catalogBrands
  ],
});
const expectedFixturePayload = () => ({
  accountId: "A1", asOf: "2025-08-10",
  window: { from: FROM, to: "2025-08-10", days: 60 },
  returnsSourceLabel: RETURNS_LABEL, moneySourceLabel: MONEY_LABEL, rateSourceLabel: RATE_LABEL,
  rateSourceLagDays: 4, returnHistoryDays: 60,
  returnRecordCount: 5, pendingReturnRequests: 2,
  fbmOnly: { refundedAmount: 23, sellerBorneLabelCost: 2 },
  reasonTotals: [
    { reason: "DEFECTIVE", count: 2, bucket: "product_quality" },
    { reason: "TOO_SMALL", count: 1, bucket: "sizing" },
    { reason: "NO_REASON_GIVEN", count: 1, bucket: "low_actionability" },
  ],
  currencies: ["CAD", "USD"],
  rows: [
    { asin: "R1", sku: "SKU-R1", skuCount: 2, productName: "Catalog R1", brand: "Acme", currency: "USD", returnCount: 3, fbaReturns: 2, fbmReturns: 1, pendingReturnRequests: 1, reasonBuckets: { product_quality: 2, sizing: 1 }, topReasons: [{ reason: "DEFECTIVE", count: 2 }, { reason: "TOO_SMALL", count: 1 }], refundedAmount: 30, refundTax: 3, returnFees: 6, refundedReferralFeeCredit: 4, cogsOnRefundedUnits: 12, refundedUnitsSettled: 3, refundEvents: 1, settledSales: 200, settledUnits: 20, hasMoney: true, unitsSold: 50, unitsShipped: 48, unitsRefunded: 5, sales: 500, hasTraffic: true },
    { asin: "R1", sku: "SKU-R1", skuCount: 2, productName: "Catalog R1", brand: "Acme", currency: "CAD", returnCount: 3, fbaReturns: 2, fbmReturns: 1, pendingReturnRequests: 1, reasonBuckets: { product_quality: 2, sizing: 1 }, topReasons: [{ reason: "DEFECTIVE", count: 2 }, { reason: "TOO_SMALL", count: 1 }], refundedAmount: 15, refundTax: 0, returnFees: 0, refundedReferralFeeCredit: 0, cogsOnRefundedUnits: 5, refundedUnitsSettled: 1, refundEvents: 1, settledSales: 0, settledUnits: 0, hasMoney: true, unitsSold: 50, unitsShipped: 48, unitsRefunded: 5, sales: 500, hasTraffic: true },
    { asin: "R2", sku: "SKU-R2", skuCount: 1, productName: "Widget R2", brand: "Beta", currency: null, returnCount: 1, fbaReturns: 0, fbmReturns: 0, pendingReturnRequests: 1, reasonBuckets: { low_actionability: 1 }, topReasons: [{ reason: "NO_REASON_GIVEN", count: 1 }], refundedAmount: 0, refundTax: 0, returnFees: 0, refundedReferralFeeCredit: 0, cogsOnRefundedUnits: 0, refundedUnitsSettled: 0, refundEvents: 0, settledSales: 0, settledUnits: 0, hasMoney: false, unitsSold: 10, unitsShipped: 9, unitsRefunded: 0, sales: 100, hasTraffic: true },
    { asin: "RT", sku: null, skuCount: 0, productName: "Catalog RT", brand: "Unassigned", currency: null, returnCount: 0, fbaReturns: 0, fbmReturns: 0, pendingReturnRequests: 0, reasonBuckets: {}, topReasons: [], refundedAmount: 0, refundTax: 0, returnFees: 0, refundedReferralFeeCredit: 0, cogsOnRefundedUnits: 0, refundedUnitsSettled: 0, refundEvents: 0, settledSales: 0, settledUnits: 0, hasMoney: false, unitsSold: 8, unitsShipped: 8, unitsRefunded: 2, sales: 80, hasTraffic: true },
    { asin: "RX", sku: "SKU-X", skuCount: 1, productName: null, brand: "Unassigned", currency: "USD", returnCount: 0, fbaReturns: 0, fbmReturns: 0, pendingReturnRequests: 0, reasonBuckets: {}, topReasons: [], refundedAmount: 9, refundTax: 0, returnFees: 2, refundedReferralFeeCredit: 0, cogsOnRefundedUnits: 2, refundedUnitsSettled: 1, refundEvents: 1, settledSales: 0, settledUnits: 0, hasMoney: true, unitsSold: null, unitsShipped: null, unitsRefunded: null, sales: null, hasTraffic: false },
  ],
  catalogBrands: ["Acme", "Beta"],
});

/* ============================= Part A: pure derivation parity ============================= */

group("returns derive: exact production-route payload parity");

test("1. pure payload deep-equals the hand-computed production-route fixture", () => {
  const r = deriveRet(retPlanned(FIXTURE()));
  assert.equal(r.status, "derived");
  assert.deepEqual(r.payload, expectedFixturePayload());
});

test("2. reason classification maps to the four fixable buckets + low-actionability + other", () => {
  const p = deriveRet(retPlanned(FIXTURE())).payload;
  assert.deepEqual(p.rows.find((r) => r.asin === "R1" && r.currency === "USD").reasonBuckets, { product_quality: 2, sizing: 1 });
  assert.deepEqual(p.rows.find((r) => r.asin === "R2").reasonBuckets, { low_actionability: 1 }, "empty reason -> NO_REASON_GIVEN -> low_actionability");
  assert.equal(p.reasonTotals.find((t) => t.reason === "DEFECTIVE").bucket, "product_quality");
});

test("3. reasonTotals + topReasons use stable descending-count ordering", () => {
  const p = deriveRet(retPlanned(FIXTURE())).payload;
  assert.deepEqual(p.reasonTotals.map((t) => [t.reason, t.count]), [["DEFECTIVE", 2], ["TOO_SMALL", 1], ["NO_REASON_GIVEN", 1]], "desc by count; ties keep insertion order");
  assert.deepEqual(p.rows.find((r) => r.asin === "R1" && r.currency === "USD").topReasons, [{ reason: "DEFECTIVE", count: 2 }, { reason: "TOO_SMALL", count: 1 }]);
});

test("4. FBA/FBM/pending counts + returnRecordCount (incl. skipped empty-ASIN row)", () => {
  const p = deriveRet(retPlanned(FIXTURE())).payload;
  const r1 = p.rows.find((r) => r.asin === "R1" && r.currency === "USD");
  assert.deepEqual([r1.returnCount, r1.fbaReturns, r1.fbmReturns, r1.pendingReturnRequests], [3, 2, 1, 1]);
  assert.equal(p.pendingReturnRequests, 2, "account-wide pending (R1 + R2)");
  assert.equal(p.returnRecordCount, 5, "raw return-row count includes the empty-ASIN row skipped by the fold");
});

test("5. currencies never merge: an ASIN with USD + CAD refunds keeps a separate row per currency", () => {
  const p = deriveRet(retPlanned(FIXTURE())).payload;
  const r1 = p.rows.filter((r) => r.asin === "R1");
  assert.equal(r1.length, 2);
  assert.deepEqual(r1.map((r) => r.currency).sort(), ["CAD", "USD"]);
  assert.deepEqual(p.currencies, ["CAD", "USD"]);
});

test("6. ORDER vs REFUND settlement handling (settled sales/units vs refund money)", () => {
  const p = deriveRet(retPlanned(FIXTURE())).payload;
  const usd = p.rows.find((r) => r.asin === "R1" && r.currency === "USD");
  assert.deepEqual([usd.settledSales, usd.settledUnits], [200, 20], "ORDER contributes settled sales/units");
  assert.deepEqual([usd.refundedAmount, usd.refundTax, usd.refundedReferralFeeCredit, usd.cogsOnRefundedUnits, usd.refundedUnitsSettled, usd.refundEvents], [30, 3, 4, 12, 3, 1], "REFUND contributes abs money");
});

test("7. return-fee component is clamped at zero (restocking recovery cannot make it negative)", () => {
  const p = deriveRet(retPlanned(FIXTURE())).payload;
  assert.equal(p.rows.find((r) => r.asin === "R1" && r.currency === "USD").returnFees, 6, "commission 5 + unitFee 2 - restock 1 = 6");
  assert.equal(p.rows.find((r) => r.asin === "R1" && r.currency === "CAD").returnFees, 0, "commission 3 - restock 10 clamps to 0");
});

test("8. catalog/name/brand precedence: catalog -> traffic name; brand from catalog only (Unassigned when blank)", () => {
  const p = deriveRet(retPlanned(FIXTURE())).payload;
  assert.equal(p.rows.find((r) => r.asin === "R1" && r.currency === "USD").productName, "Catalog R1", "catalog name wins");
  assert.equal(p.rows.find((r) => r.asin === "R2").productName, "Widget R2", "blank catalog name -> traffic name");
  assert.equal(p.rows.find((r) => r.asin === "RX").productName, null, "no catalog + no traffic -> null");
  assert.equal(p.rows.find((r) => r.asin === "RT").brand, "Unassigned", "blank catalog brand -> Unassigned");
  assert.equal(p.rows.find((r) => r.asin === "R1" && r.currency === "USD").brand, "Acme");
});

test("9. no-return/no-refund rows are excluded; money-only + traffic-only rows are included", () => {
  const p = deriveRet(retPlanned(FIXTURE())).payload;
  assert.ok(!p.rows.some((r) => r.asin === "RY"), "order-only ASIN (no refund/returns/traffic) excluded");
  assert.ok(!p.rows.some((r) => r.asin === "RN"), "traffic-only ASIN with 0 refunded units excluded");
  assert.ok(p.rows.some((r) => r.asin === "RX" && r.hasMoney && !r.hasTraffic), "money-only ASIN included");
  assert.ok(p.rows.some((r) => r.asin === "RT" && !r.hasMoney && r.hasTraffic), "traffic-only ASIN (refunded units) included");
});

test("10. FBM-only refunded amount + seller-borne label cost are reported separately", () => {
  const p = deriveRet(retPlanned(FIXTURE())).payload;
  assert.deepEqual(p.fbmOnly, { refundedAmount: 23, sellerBorneLabelCost: 2 });
});

test("11. row order + full labels/lag/window match the live route", () => {
  const p = deriveRet(retPlanned(FIXTURE())).payload;
  assert.deepEqual(p.rows.map((r) => `${r.asin}/${r.currency}`), ["R1/USD", "R1/CAD", "R2/null", "RT/null", "RX/USD"]);
  assert.deepEqual([p.returnsSourceLabel, p.moneySourceLabel, p.rateSourceLabel, p.rateSourceLagDays, p.returnHistoryDays], [RETURNS_LABEL, MONEY_LABEL, RATE_LABEL, 4, 60]);
  assert.deepEqual(p.window, { from: FROM, to: ASOF, days: 60 });
});

group("returns derive: window + account validation fail closed");

test("12. the exact 60-day single windows are required; the canonical fixture derives", () => {
  assert.equal(deriveRet(retPlanned(FIXTURE())).status, "derived");
  assert.equal(FROM, addDaysStr(ASOF, -59), "returns window start = asOf-59d");
});

test("13. wrong-window returns/settlements/traffic + dated catalog fail closed (invalid)", () => {
  const good = FIXTURE();
  for (const key of ["returns-leakage:returns", "returns-leakage:settlements", "returns-leakage:traffic"]) {
    const built = retPlanned(good);
    const i = built.planned.findIndex((p) => p.requestKey === key);
    built.planned[i] = { ...built.planned[i], from: addDaysStr(FROM, -1) };
    assert.equal(deriveRet(built).status, "invalid", `${key} shifted window => invalid`);
  }
  const datedCat = retPlanned(good);
  const ci = datedCat.planned.findIndex((p) => p.requestKey === "returns-leakage:catalog");
  datedCat.planned[ci] = { ...datedCat.planned[ci], from: FROM, to: ASOF };
  assert.equal(deriveRet(datedCat).status, "invalid", "dated catalog => invalid");
});

test("14. cross-account fragments fail closed (invalid)", () => {
  for (const key of ["returns-leakage:returns", "returns-leakage:settlements", "returns-leakage:traffic", "returns-leakage:catalog"]) {
    const built = retPlanned(FIXTURE());
    const i = built.planned.findIndex((p) => p.requestKey === key);
    built.planned[i] = { ...built.planned[i], sellerOrVendorIds: ["OTHER"] };
    assert.equal(deriveRet(built).status, "invalid", `cross-account ${key} => invalid`);
  }
});

test("15. malformed / impossible / future / out-of-window RETURN row dates fail closed (never silently filtered)", () => {
  const base = FIXTURE();
  const bad = (date) => { const f = { ...base, returns: [ret(date, "R1", "SKU-R1", "DEFECTIVE", "FBA", "Approved", -1, 0, "")] }; return deriveRet(retPlanned(f)).status; };
  assert.equal(bad("2025-02-30"), "invalid", "impossible calendar date");
  assert.equal(bad(addDaysStr(FROM, -1)), "invalid", "before the 60-day window");
  assert.equal(bad(addDaysStr(ASOF, 1)), "invalid", "after asOf");
  assert.equal(bad("2099-01-01"), "invalid", "future date");
  assert.equal(bad("not-a-date"), "invalid", "non-calendar date");
});

test("16. a missing/failed required source => unavailable, ZERO writes, last-known-good preserved", () => {
  for (const key of ["returns-leakage:returns", "returns-leakage:settlements", "returns-leakage:traffic", "returns-leakage:catalog"]) {
    const built = retPlanned(FIXTURE());
    const hash = built.planned.find((p) => p.requestKey === key).requestHash;
    assert.equal(deriveRet(built, ctx(), { [hash]: "failed" }).status, "unavailable", `failed ${key} => unavailable (LKG kept)`);
  }
});

group("returns derive: public-vs-raw identity + purity");

const RAW1 = "RAW1";
const PUB1 = dash("dd", "secondary") + ":RAW1";
const idCtx = (publicId, rawId) => ctx({ accountId: publicId, rawSellerId: rawId });

test("17. primary (public==raw==A1): payload.accountId is the public id A1 (route parity)", () => {
  assert.equal(deriveRet(retPlanned({ ...FIXTURE(), ids: [ID] }), idCtx(ID, ID)).payload.accountId, "A1");
});

test("18. dormant secondary: payload.accountId is the PUBLIC prefixed id, never the raw seller id", () => {
  const p = deriveRet(retPlanned({ ...FIXTURE(), ids: [RAW1] }), idCtx(PUB1, RAW1)).payload;
  assert.equal(p.accountId, PUB1, "payload accountId is the public/prefixed id (matches snapshot key)");
  assert.notEqual(p.accountId, RAW1);
  assert.deepEqual(p.rows, expectedFixturePayload().rows, "row calculations unchanged by the identity fix");
  assert.deepEqual(p.catalogBrands, ["Acme", "Beta"], "catalogBrands travel with the PUBLIC payload accountId");
});

test("19. fragments still require the RAW seller id; a public-id-scoped fragment is cross-account", () => {
  assert.equal(deriveRet(retPlanned({ ...FIXTURE(), ids: [RAW1] }), idCtx(PUB1, RAW1)).status, "derived");
  assert.equal(deriveRet(retPlanned({ ...FIXTURE(), ids: [PUB1] }), idCtx(PUB1, RAW1)).status, "invalid", "public-id fragments never satisfy raw-id scope");
});

test("20. derivation makes ZERO network calls; 21. repeated derivation is idempotent", () => {
  const realFetch = globalThis.fetch; let hits = 0;
  globalThis.fetch = () => { hits += 1; throw new Error("network during derivation"); };
  let a, b;
  try { a = deriveRet(retPlanned(FIXTURE())).payload; b = deriveRet(retPlanned(FIXTURE())).payload; } finally { globalThis.fetch = realFetch; }
  assert.equal(hits, 0, "zero DataDoe/network calls during derivation");
  assert.deepEqual(a, b, "repeated derivation is idempotent");
  assert.deepEqual(a, expectedFixturePayload());
});

/* ============================= Part B: real generic planner/driver ============================= */

group("returns generic path: buildShadowReportPlan -> runStagedSourceCycle -> runReportJobs");

function makeStore() {
  const cycles = new Map(); const jobsByCycle = new Map(); const ownersByCycle = new Map();
  const cache = new Map(); const reportJobs = new Map(); const snapshots = new Map(); let seq = 0;
  const findCycle = (id) => [...cycles.values()].find((c) => c.id === id) || null;
  const ownerRows = (cid) => [...((ownersByCycle.get(cid) && ownersByCycle.get(cid).values()) || [])];
  const rkey = (rk, a) => rk + "|" + a;
  return {
    _owners: (cid) => ownerRows(cid).map((m) => ({ ...m })),
    _snapshots: snapshots, saveCalls: 0,
    openCycle({ bucket, cycleDate }) { const k = bucket + "|" + cycleDate; if (!cycles.has(k)) { const id = "cyc_" + (seq += 1); cycles.set(k, { id, bucket, status: "pending" }); jobsByCycle.set(id, new Map()); } return cycles.get(k).id; },
    claimCycle(id) { const c = findCycle(id); if (c && c.status === "pending") { c.status = "running"; return true; } return false; },
    getCycle(id) { return findCycle(id); },
    upsertSourceJob(job) { const m = jobsByCycle.get(job.cycleId); if (m.has(job.requestHash)) return; m.set(job.requestHash, { request_hash: job.requestHash, request_key: job.requestKey, source_id: job.sourceId, source_key: job.sourceKey, connection_id: job.connectionId, organization_fingerprint: job.organizationFingerprint, account_scope_hash: job.accountScopeHash, fetch_status: "pending", attempted_at: null, create_export_count: 0, export_id: null, terminal: false, row_count: null }); },
    listSourceJobs(id) { return [...((jobsByCycle.get(id) && jobsByCycle.get(id).values()) || [])].map((j) => ({ ...j })); },
    upsertSourceJobOwners(ms) { for (const m of ms || []) { if (!ownersByCycle.has(m.cycleId)) ownersByCycle.set(m.cycleId, new Map()); ownersByCycle.get(m.cycleId).set(m.ownerId + "|" + m.requestHash, { cycle_id: m.cycleId, request_hash: m.requestHash, owner_id: m.ownerId, request_key: m.requestKey, report_key: m.reportKey, account_id: m.accountId, connection_id: m.connectionId, organization_fingerprint: m.organizationFingerprint, account_scope_hash: m.accountScopeHash, owner_status: "active", error_code: null }); } },
    listSourceJobOwners(cid, ids) { const s = new Set(ids || []); return ownerRows(cid).filter((m) => s.has(m.owner_id)).map((m) => ({ ...m })); },
    recordSourceOwnerStale({ cycleId, requestHash, ownerId, code }) { const m = ownersByCycle.get(cycleId) && ownersByCycle.get(cycleId).get(ownerId + "|" + requestHash); if (m) { m.owner_status = "stale"; m.error_code = code || "STALE_PLAN"; } },
    claimExportAttempt(id, h) { const j = jobsByCycle.get(id) && jobsByCycle.get(id).get(h); if (j && j.attempted_at === null) { j.attempted_at = "t"; j.create_export_count += 1; j.fetch_status = "attempted"; return true; } return false; },
    recordExportCreated({ cycleId, requestHash, exportId }) { jobsByCycle.get(cycleId).get(requestHash).export_id = exportId; },
    loadSourceRows(h) { const e = cache.get(h); return e ? { rows: e.rows } : null; },
    saveSourceRows({ job, rows }) { const h = job.request_hash != null ? job.request_hash : job.requestHash; cache.set(h, { rows: [...rows] }); return "p/" + h; },
    recordSourceSuccess({ cycleId, requestHash, exportId, rowCount, cacheObjectPath }) { Object.assign(jobsByCycle.get(cycleId).get(requestHash), { fetch_status: "succeeded", export_id: exportId, row_count: rowCount, cache_object_path: cacheObjectPath }); },
    recordSourceFailure({ cycleId, requestHash, stage, code, terminal }) { Object.assign(jobsByCycle.get(cycleId).get(requestHash), { fetch_status: "failed", error_stage: stage, error_code: code, terminal: !!terminal }); },
    updateCycleCounts() {},
    seedSnapshot(rk, a, payload) { snapshots.set(rkey(rk, a), { payload }); },
    report(rk, a) { return reportJobs.get(rkey(rk, a)); },
    listReportJobs() { return [...reportJobs.values()].map((j) => ({ ...j })); },
    upsertReportJob({ reportKey, accountId, connectionId, bucket, reportVersion, dependsOn }) { const k = rkey(reportKey, accountId); if (reportJobs.has(k)) return; reportJobs.set(k, { report_key: reportKey, account_id: accountId, connection_id: connectionId, bucket, report_version: reportVersion, depends_on: dependsOn || [], fetch_status: "pending", derive_status: "pending", save_status: "pending", validated: false }); },
    claimReportDerive(_c, rk, a) { const j = reportJobs.get(rkey(rk, a)); if (j && j.derive_status === "pending") { j.derive_status = "running"; return true; } return false; },
    recordReportBlocked({ reportKey, accountId }) { Object.assign(reportJobs.get(rkey(reportKey, accountId)), { fetch_status: "blocked", derive_status: "skipped", save_status: "skipped" }); },
    recordReportFailure({ reportKey, accountId, stage, code }) { Object.assign(reportJobs.get(rkey(reportKey, accountId)), { derive_status: stage === "save" ? "succeeded" : "failed", save_status: stage === "save" ? "failed" : "pending", error_code: code }); },
    recordReportSuccess({ reportKey, accountId }) { Object.assign(reportJobs.get(rkey(reportKey, accountId)), { fetch_status: "ready", derive_status: "succeeded", save_status: "succeeded", validated: true }); },
  };
}

function makeDataDoe(opts = {}) {
  const create = {}; let hits = 0;
  const deadlineErr = () => Object.assign(new Error("deferred"), { code: "DATADOE_DEADLINE" });
  const rowsFor = (job) => {
    const rk = job.requestKey || ""; const fp = job.fetchParams || {};
    if (rk.includes("returns-leakage:returns")) return [ret(fp.to || ASOF, "R1", "SKU-R1", "DEFECTIVE", "FBA", "Approved", -5, 0, "")];
    if (rk.includes("settlements")) return [refund("R1", "SKU-R1", "USD", { amount: -9, commission: -1, unitFee: -1, cogs: -2, qty: -1 })];
    if (rk.includes("returns-leakage:traffic")) return [traf("R1", "Widget R1", 100, 10, 9, 1)];
    if (rk.includes("catalog")) return [cat("R1", "P1", "Catalog R1", "Acme")];
    return [{ child_asin: "R1" }];
  };
  return {
    createCount: (h) => create[h] || 0, totalCreates: () => Object.values(create).reduce((a, b) => a + b, 0),
    async create(job) { create[job.requestHash] = (create[job.requestHash] || 0) + 1; return { exportId: "e_" + job.requestHash }; },
    async poll(job) { if (opts.deferKey && (job.requestKey || "").includes(opts.deferKey)) { hits += 1; if (hits === 1) throw deadlineErr(); } },
    async download(job) { if (opts.capKey && (job.requestKey || "").includes(opts.capKey)) return new Array(Number(job.limit)).fill(0).map(() => ({ x: 1 })); return rowsFor(job); },
  };
}

const ACCTS = [{ accountId: ID, country: "US", currency: "USD" }];
const asOfForUS = () => ASOF;
const shadowPlan = (accounts, keys, connections = CONNS) => buildShadowReportPlan({ accounts, reportKeys: keys, connections, asOfFor: asOfForUS });
const resolveFromPlan = (plan) => () => ({
  sourceJobs: plan.reportRequests.flatMap((req) => req.sources.map((s) => plannedSourceJob(req.reportKey, s, req.bucket, DRIVER_CONNECTION_ID[req.connectionId] || req.connectionId, req.accountId))),
});
const runGeneric = (store, dd, plan, opts = {}) => runStagedSourceCycle({ store, dataDoe: dd, resolvePlan: resolveFromPlan(plan), bucket: "us", cycleDate: "2026-08-11", ...opts });
const srcOf = (plan, key) => plan.reportRequests[0].sources.find((s) => s.requestKey === key);

test("22. default AND explicit planning include returns-leakage; the plan holds exactly four canonical jobs with exact windows/deps/owner/context", () => {
  assert.ok(SHADOW_PLANNED_REPORT_KEYS.includes("returns-leakage"), "returns-leakage is a default generic report key");
  assert.ok(shadowPlan(ACCTS).reportRequests.some((r) => r.reportKey === "returns-leakage"), "DEFAULT plan includes returns-leakage");
  const plan = shadowPlan(ACCTS, ["returns-leakage"]);
  const bb = plan.reportRequests.find((r) => r.reportKey === "returns-leakage");
  assert.equal(plan.sourceJobs.length, 4, "exactly four deduplicated canonical source jobs");
  for (const key of ["returns-leakage:returns", "returns-leakage:settlements", "returns-leakage:traffic"]) {
    assert.deepEqual([srcOf(plan, key).from, srcOf(plan, key).to], [FROM, ASOF], `${key} window asOf-59d..asOf`);
  }
  assert.deepEqual([srcOf(plan, "returns-leakage:catalog").from, srcOf(plan, "returns-leakage:catalog").to], [null, null], "no-date catalog");
  const rj = plan.reportJobs.find((j) => j.reportKey === "returns-leakage");
  assert.equal(rj.dependsOn.length, 4, "report depends on all four canonical sources");
  assert.deepEqual([...rj.dependsOn].sort(), plan.sourceJobs.map((j) => j.requestHash).sort());
  assert.deepEqual(bb.context, { to: ASOF, rawSellerId: ID }, "context carries asOf + raw seller id");
  const jobs = resolveFromPlan(plan)().sourceJobs;
  assert.ok(jobs.every((j) => j.owner && j.owner.reportKey === "returns-leakage" && j.owner.accountId === ID && j.owner.ownerId), "each job carries returns-leakage owner metadata");
  assert.equal(new Set(jobs.map((j) => j.owner.ownerId)).size, 1, "one owner for the single account/org");
});

test("23. the no-date catalog canonical hash is SHARED with Buy Box + Sales Movers; returns/settlements/traffic are distinct", () => {
  const retPlan = shadowPlan(ACCTS, ["returns-leakage"]);
  const bb = planBuyBoxLoss({ accountId: ID, country: "US", currency: "USD", connections: CONNS, asOf: ASOF });
  const sm = planSalesMovers({ accountId: ID, country: "US", currency: "USD", connections: CONNS, asOf: ASOF, probeSignal: { status: "success", validated: true, latestReportedDate: "2025-08-08" } });
  const retCat = srcOf(retPlan, "returns-leakage:catalog").requestHash;
  assert.equal(retCat, bb.sources.find((s) => s.requestKey === "buy-box-loss:catalog").requestHash, "shared catalog identity with Buy Box");
  assert.equal(retCat, sm.sources.find((s) => s.requestKey === "sales-movers:catalog").requestHash, "shared catalog identity with Sales Movers");
  // The returns traffic uses a different column/window set than Sales Movers traffic => distinct identity.
  assert.notEqual(srcOf(retPlan, "returns-leakage:traffic").requestHash, sm.sources.find((s) => s.requestKey === "sales-movers:traffic").requestHash, "returns traffic is NOT shared with Sales Movers traffic");
});

test("24. one canonical export per shared catalog request_hash across Returns + Buy Box owners", async () => {
  const store = makeStore(); const dd = makeDataDoe();
  const plan = shadowPlan(ACCTS, ["returns-leakage"]);
  const catSrc = srcOf(plan, "returns-leakage:catalog");
  const retJobs = resolveFromPlan(plan)().sourceJobs;
  const catJob = retJobs.find((j) => j.requestKey === "returns-leakage:catalog");
  // A SECOND owner (Buy Box) holds a membership on the SAME shared catalog canonical hash.
  const bbOwnerId = sourceJobOwnerId({ reportKey: "buy-box-loss", connectionId: catJob.connectionId, organizationFingerprint: catJob.organizationFingerprint, accountScopeHash: catJob.accountScopeHash });
  const bbCatJob = { ...catJob, requestKey: "buy-box-loss:catalog", owner: { ownerId: bbOwnerId, requestKey: "buy-box-loss:catalog", reportKey: "buy-box-loss", accountId: ID } };
  const plannedJobs = [...retJobs, bbCatJob];
  const r = await runSourceJobs({ store, dataDoe: dd, plannedJobs, ownerIds: [...new Set(plannedJobs.map((j) => j.owner.ownerId))], bucket: "us", cycleDate: "2026-08-11" });
  assert.equal(dd.createCount(catSrc.requestHash), 1, "the shared catalog export is created exactly once");
  assert.equal(store.listSourceJobs(r.cycleId).filter((j) => j.request_hash === catSrc.requestHash).length, 1, "one canonical catalog row");
  assert.equal(store._owners(r.cycleId).filter((m) => m.request_hash === catSrc.requestHash).length, 2, "two owner memberships share the one canonical hash");
});

test("25. shared-owner reconciliation: Returns owner reconciliation never stales/fails a second owner sharing the catalog", async () => {
  const store = makeStore(); const dd = makeDataDoe();
  const plan = shadowPlan(ACCTS, ["returns-leakage"]);
  const r = await runGeneric(store, dd, plan);
  const cid = r.cycleId;
  const catSrc = srcOf(plan, "returns-leakage:catalog");
  const bbOwnerId = sourceJobOwnerId({ reportKey: "buy-box-loss", connectionId: "primary", organizationFingerprint: catSrc.organizationFingerprint, accountScopeHash: catSrc.accountScopeHash });
  store.upsertSourceJobOwners([{ cycleId: cid, requestHash: catSrc.requestHash, ownerId: bbOwnerId, requestKey: "buy-box-loss:catalog", reportKey: "buy-box-loss", accountId: ID, connectionId: "primary", organizationFingerprint: catSrc.organizationFingerprint, accountScopeHash: catSrc.accountScopeHash }]);
  await runGeneric(store, dd, plan); // re-run to fixpoint: reconciliation touches only Returns owners
  const bbMemberships = store._owners(cid).filter((m) => m.report_key === "buy-box-loss");
  assert.equal(bbMemberships.length, 1);
  assert.equal(bbMemberships[0].owner_status, "active", "the second owner's shared-catalog membership is never staled by Returns reconciliation");
});

test("26. strict-cap: a settlement export at the row cap fails TRUNCATED, saves no source, and the report never derives (LKG)", async () => {
  const store = makeStore();
  const dd = makeDataDoe({ capKey: "settlements" });
  const plan = shadowPlan(ACCTS, ["returns-leakage"]);
  const r = await runGeneric(store, dd, plan);
  const settleJobs = store.listSourceJobs(r.cycleId).filter((j) => j.request_key === "returns-leakage:settlements");
  assert.ok(settleJobs.every((j) => j.fetch_status === "failed" && j.error_code === "TRUNCATED"), "capped settlement fails TRUNCATED");
  assert.ok(!store.loadSourceRows(settleJobs[0].request_hash), "no truncated source payload is saved");
  const saved = [];
  const saveSnapshot = async ({ accountId, payload }) => { saved.push({ accountId, payload }); return { paramsHash: "ph" }; };
  const res = await runReportJobs({ store, cycleId: r.cycleId, sourceRows: (h) => store.loadSourceRows(h), saveSnapshot, plannedReports: plan.reportRequests });
  assert.equal(res.succeeded, 0, "the report does not derive/save on a truncated required source");
  assert.equal(saved.length, 0, "zero snapshot writes (LKG preserved)");
});

test("27. report stays PENDING until all four sources succeed, then saves EXACTLY once; zero network during derivation; idempotent", async () => {
  const store = makeStore(); const dd = makeDataDoe();
  const plan = shadowPlan(ACCTS, ["returns-leakage"]);
  const saved = [];
  const saveSnapshot = async ({ reportKey, accountId, payload }) => { store.saveCalls += 1; store.seedSnapshot(reportKey, accountId, payload); saved.push({ accountId, payload }); return { paramsHash: "ph" }; };
  const r1 = await runGeneric(store, dd, plan, { maxJobs: 2 });
  assert.ok(store.listSourceJobs(r1.cycleId).filter((j) => j.fetch_status === "succeeded").length < 4, "not all sources succeeded yet");
  let res = await runReportJobs({ store, cycleId: r1.cycleId, sourceRows: (h) => store.loadSourceRows(h), saveSnapshot, plannedReports: plan.reportRequests });
  assert.equal(res.succeeded, 0, "report PENDING while a required source is missing");
  assert.equal(saved.length, 0, "zero writes while pending");
  const r2 = await runGeneric(store, dd, plan);
  assert.ok(store.listSourceJobs(r2.cycleId).every((j) => j.fetch_status === "succeeded"), "all four sources succeeded after resume");
  const realFetch = globalThis.fetch; let hits = 0;
  globalThis.fetch = () => { hits += 1; throw new Error("network during derivation"); };
  try { res = await runReportJobs({ store, cycleId: r2.cycleId, sourceRows: (h) => store.loadSourceRows(h), saveSnapshot, plannedReports: plan.reportRequests }); } finally { globalThis.fetch = realFetch; }
  assert.equal(hits, 0, "zero DataDoe/network during derivation");
  assert.equal(res.succeeded, 1, "report derives + saves once all sources are ready");
  assert.equal(saved.length, 1, "snapshot saved exactly once");
  assert.equal(saved[0].accountId, ID);
  const before = store.saveCalls;
  await runReportJobs({ store, cycleId: r2.cycleId, sourceRows: (h) => store.loadSourceRows(h), saveSnapshot, plannedReports: plan.reportRequests });
  assert.equal(store.saveCalls, before, "no duplicate snapshot on re-run");
});

test("28. maxJobs partial + poll/download deferral resume through the real driver with ONE create-export per request hash", async () => {
  const s1 = makeStore(); const d1 = makeDataDoe();
  const plan = shadowPlan(ACCTS, ["returns-leakage"]);
  await runGeneric(s1, d1, plan, { maxJobs: 1 });
  const r = await runGeneric(s1, d1, plan);
  assert.ok(s1.listSourceJobs(r.cycleId).every((j) => j.fetch_status === "succeeded"), "all sources complete after maxJobs resume");
  for (const j of s1.listSourceJobs(r.cycleId)) assert.ok(d1.createCount(j.request_hash) <= 1, j.request_key + " exported at most once");
  const s2 = makeStore();
  const dDefer = makeDataDoe({ deferKey: "returns-leakage:returns" });
  const r1 = await runGeneric(s2, dDefer, plan);
  assert.ok((r1.deferred || 0) > 0, "the driver surfaces the resumable deferral");
  assert.ok(s2._owners(r1.cycleId).every((m) => m.owner_status === "active"), "no membership staled by a deferral");
  const retReturns = srcOf(plan, "returns-leakage:returns").requestHash;
  const dOk = makeDataDoe();
  const r2 = await runGeneric(s2, dOk, plan);
  assert.equal(dDefer.createCount(retReturns) + dOk.createCount(retReturns), 1, "returns export created exactly once across deferral + resume");
  assert.ok(s2.listSourceJobs(r2.cycleId).every((j) => j.fetch_status === "succeeded"), "all sources complete after the deferral resume");
});

test("29. primary-only: a stale dd-secondary account is skipped read-only with ZERO DataDoe calls and is never routed through the primary key", async () => {
  const store = makeStore(); const dd = makeDataDoe();
  const PRIMARY_ONLY = [{ id: "primary", apiKey: dash("prim", "key"), accountPrefix: "" }];
  const accounts = [{ accountId: ID, country: "US", currency: "USD" }, { accountId: PUB1, country: "US", currency: "USD" }];
  const plan = shadowPlan(accounts, ["returns-leakage"], PRIMARY_ONLY);
  assert.deepEqual(plan.unavailableAccounts.map((a) => a.accountId), [PUB1], "the dd-secondary account is classified unavailable");
  assert.deepEqual(plan.reportRequests.map((r) => r.accountId), [ID], "only the primary account is planned");
  const r = await runGeneric(store, dd, plan);
  const jobs = store.listSourceJobs(r.cycleId);
  assert.ok(jobs.every((j) => j.connection_id === "primary"), "no dd-secondary jobs; nothing routed to the primary key for the stale account");
  assert.equal(jobs.length, 4, "exactly the four primary-account canonical jobs ran");
});

async function main() {
  ({ assembleSources, runReportJobs } = await import("../lib/server/sync/report-worker.js"));
  ({ deriveReportSnapshot } = await import("../lib/server/sync/report-derivation.js"));
  ({ runSourceJobs } = await import("../lib/server/sync/source-worker.js"));
  ({ plannedSourceJob, runStagedSourceCycle } = await import("../lib/server/sync/source-sync-driver.js"));
  ({ sourceJobOwnerId } = await import("../lib/server/source-identity.js"));
  ({ planReturnsLeakage, planBuyBoxLoss, planSalesMovers, buildShadowReportPlan, SHADOW_PLANNED_REPORT_KEYS } = await import("../lib/server/sync/report-planner.js"));
  ({ addDaysStr } = await import("../lib/server/date-windows.js"));
  FROM = addDaysStr(ASOF, -59);

  let failures = 0;
  for (const t of tests) {
    if (t.marker) { out("\n# " + t.marker); continue; }
    try { await t.fn(); passed += 1; out("  ok  " + t.name); }
    catch (err) { failures += 1; out("FAIL  " + t.name); out(String(err && err.stack ? err.stack : err)); }
  }
  out("\n" + passed + " assertions passed");
  return failures;
}

main().then((failures) => { if (failures) process.exitCode = 1; }).catch((err) => { out("FATAL " + String(err && err.stack ? err.stack : err)); process.exitCode = 1; });
