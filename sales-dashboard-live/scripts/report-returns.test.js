// Returns & Refund Leakage Scheduler-v2 derivation + generic-cycle parity tests (SHADOW MODE, offline).
//
// Part A drives deriveReportSnapshot("returns-leakage") against hand-built saved fragments and proves the
// pure payload deep-equals a hand-computed production-route fixture, plus reason classification + stable
// ordering, FBA/FBM/pending counts, currency isolation, ORDER vs REFUND money, the zero-clamped return fee,
// catalog/ordered name precedence, no-return/no-refund exclusion, public/raw identity, the exact 60-day
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
let DERIVE_TIMEOUT_SAFE_SLICE_DAYS;
let planReturnsLeakage, planBuyBoxLoss, planSalesMovers, buildShadowReportPlan, SHADOW_PLANNED_REPORT_KEYS, addDaysStr, splitDateRangeByDays, canonicalOliSlices;

const ID = "A1";
const ASOF = "2025-08-10";
const dash = (...p) => p.join("-");
const CONNS = [
  { id: "primary", apiKey: dash("prim", "key"), accountPrefix: "" },
  { id: "secondary", apiKey: dash("sec", "key"), accountPrefix: dash("dd", "secondary") + ":" },
];
const RETURNS_LABEL = "Returns (FBA & FBM)";
const MONEY_LABEL = "Settlements & P&L Components";
const RATE_LABEL = "Order Line Items";
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

// Returns is TIMEOUT-SAFE SLICED (<=7-day slices over [FROM, ASOF] -- the shape the derive now requires),
// each raw dated row distributed into its own slice; ordered is the ONE CANONICAL Order Line Items sales
// fragment (Blocker 1), sliced by canonicalOliSlices(FROM, ASOF) with each canonical row bound to the slice
// whose window contains its own `date`; settlements stay one grouped whole-window fragment (grouped WITHOUT
// date -- not sliceable); catalog is no-date.
function retPlanned({ returns = [], settlements = [], ordered = [], catalog = [], ids = [ID] } = {}) {
  const planned = []; const rows = {};
  const add = (key, from, to, data) => { const f = frag(key, from, to, ids); planned.push(f); rows[f.requestHash] = data; };
  // NEWEST-FIRST slices (returns is fetched date DESC): the concatenation of per-slice rows reproduces the
  // former whole-window DESC order exactly.
  const slices = splitDateRangeByDays(FROM, ASOF, DERIVE_TIMEOUT_SAFE_SLICE_DAYS).reverse();
  slices.forEach((slice, i) => {
    const inSlice = returns.filter((r) => typeof r.date === "string" && r.date >= slice.from && r.date <= slice.to);
    // Rows whose date matches NO slice (malformed/out-of-window fixtures) land in the FIRST slice so the
    // derive's per-slice row-window binding still sees -- and rejects -- them (fail-closed test paths).
    const orphans = i === 0 ? returns.filter((r) => !(typeof r.date === "string" && slices.some((w) => r.date >= w.from && r.date <= w.to))) : [];
    add("returns-leakage:returns", slice.from, slice.to, [...inSlice, ...orphans]);
  });
  add("returns-leakage:settlements", FROM, ASOF, settlements);
  // Blocker 1: ordered = the ONE canonical OLI sales fragment, sliced by canonicalOliSlices (chronological,
  // calendar-anchored) EXACTLY as the derive validates returns-leakage:oli-sales. Each ordered row lands in
  // the slice whose window contains its own `date`; rows matching NO slice land in the FIRST slice so the
  // derive's per-slice row-window binding still sees -- and rejects -- them (fail-closed test paths).
  const oliSlices = canonicalOliSlices(FROM, ASOF);
  oliSlices.forEach((slice, i) => {
    const inSlice = ordered.filter((r) => typeof r.date === "string" && r.date >= slice.from && r.date <= slice.to);
    const orphans = i === 0 ? ordered.filter((r) => !(typeof r.date === "string" && oliSlices.some((w) => r.date >= w.from && r.date <= w.to))) : [];
    add("returns-leakage:oli-sales", slice.from, slice.to, [...inSlice, ...orphans]);
  });
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
// Canonical OLI sales row (Blocker 1): { date, seller_or_vendor_id, sku, child_asin, item_price_currency,
// total_sales_sum, total_units_sum }. `currency`/`date` are per-row so multi-currency fixtures are
// expressible; `date` defaults to ASOF (inside [FROM, ASOF], lands in the final canonicalOliSlices bin).
const ord = (asin, name, sales, units, currency = "USD", date = ASOF) => ({
  date, seller_or_vendor_id: ID, sku: "SKU-" + asin, child_asin: asin,
  item_price_currency: currency, product_name: name, total_sales_sum: sales, total_units_sum: units,
});
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
    order("RY", "SKU-Y", "USD", 100, 10),                                                                                             // order-only, no refund/returns -> excluded
    order("", "", "USD", 50, 5),                                                                                                       // empty ASIN -> skipped
  ],
  ordered: [
    ord("R1", "Widget R1", 500, 50),
    ord("R2", "Widget R2", 100, 10),
    ord("RT", "Widget RT", 80, 8),   // ordered-only (no returns/refunds) -> excluded
    ord("RN", "Widget RN", 60, 6),   // ordered-only (no returns/refunds) -> excluded
  ],
  catalog: [
    cat("R1", "P1", "Catalog R1", "Acme"),
    cat("R2", "P2", "", "Beta"),   // blank catalog name -> ordered name fallback
    cat("RT", "P3", "Catalog RT", ""), // blank brand -> Unassigned; brand not added to catalogBrands
  ],
});
const expectedFixturePayload = () => ({
  accountId: "A1", asOf: "2025-08-10",
  window: { from: FROM, to: "2025-08-10", days: 60 },
  returnsSourceLabel: RETURNS_LABEL, moneySourceLabel: MONEY_LABEL, rateSourceLabel: RATE_LABEL,
  rateSourceLagDays: 0, returnHistoryDays: 60,
  returnRecordCount: 5, pendingReturnRequests: 2,
  fbmOnly: { refundedAmount: 23, sellerBorneLabelCost: 2 },
  reasonTotals: [
    { reason: "DEFECTIVE", count: 2, bucket: "product_quality" },
    { reason: "TOO_SMALL", count: 1, bucket: "sizing" },
    { reason: "NO_REASON_GIVEN", count: 1, bucket: "low_actionability" },
  ],
  currencies: ["CAD", "USD"],
  rows: [
    // R1 spans TWO currencies (USD ordered + USD refund + CAD refund) => MULTI-CURRENCY: the returnCount goes
    // on the USD row (greatest ordered units = 50), the CAD row carries returnCount 0, and returnedUnits is
    // WITHHELD (null) on BOTH rows (currency-ambiguous rate). Ordered evidence is per currency: only USD has
    // ordered units/sales, so the CAD row has orderedUnits/sales null + hasOrdered false.
    { asin: "R1", sku: "SKU-R1", skuCount: 2, productName: "Catalog R1", brand: "Acme", currency: "USD", returnCount: 3, fbaReturns: 2, fbmReturns: 1, pendingReturnRequests: 1, reasonBuckets: { product_quality: 2, sizing: 1 }, topReasons: [{ reason: "DEFECTIVE", count: 2 }, { reason: "TOO_SMALL", count: 1 }], refundedAmount: 30, refundTax: 3, returnFees: 6, refundedReferralFeeCredit: 4, cogsOnRefundedUnits: 12, refundedUnitsSettled: 3, refundEvents: 1, settledSales: 200, settledUnits: 20, hasMoney: true, orderedUnits: 50, returnedUnits: null, sales: 500, hasOrdered: true },
    { asin: "R1", sku: "SKU-R1", skuCount: 1, productName: "Catalog R1", brand: "Acme", currency: "CAD", returnCount: 0, fbaReturns: 0, fbmReturns: 0, pendingReturnRequests: 0, reasonBuckets: {}, topReasons: [], refundedAmount: 15, refundTax: 0, returnFees: 0, refundedReferralFeeCredit: 0, cogsOnRefundedUnits: 5, refundedUnitsSettled: 1, refundEvents: 1, settledSales: 0, settledUnits: 0, hasMoney: true, orderedUnits: null, returnedUnits: null, sales: null, hasOrdered: false },
    { asin: "R2", sku: "SKU-R2", skuCount: 1, productName: "Widget R2", brand: "Beta", currency: "USD", returnCount: 1, fbaReturns: 0, fbmReturns: 0, pendingReturnRequests: 1, reasonBuckets: { low_actionability: 1 }, topReasons: [{ reason: "NO_REASON_GIVEN", count: 1 }], refundedAmount: 0, refundTax: 0, returnFees: 0, refundedReferralFeeCredit: 0, cogsOnRefundedUnits: 0, refundedUnitsSettled: 0, refundEvents: 0, settledSales: 0, settledUnits: 0, hasMoney: false, orderedUnits: 10, returnedUnits: 1, sales: 100, hasOrdered: true },
    { asin: "RX", sku: "SKU-X", skuCount: 1, productName: null, brand: "Unassigned", currency: "USD", returnCount: 0, fbaReturns: 0, fbmReturns: 0, pendingReturnRequests: 0, reasonBuckets: {}, topReasons: [], refundedAmount: 9, refundTax: 0, returnFees: 2, refundedReferralFeeCredit: 0, cogsOnRefundedUnits: 2, refundedUnitsSettled: 1, refundEvents: 1, settledSales: 0, settledUnits: 0, hasMoney: true, orderedUnits: null, returnedUnits: null, sales: null, hasOrdered: false },
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

test("8. catalog/name/brand precedence: catalog -> ordered name; brand from catalog only (Unassigned when blank)", () => {
  const p = deriveRet(retPlanned(FIXTURE())).payload;
  assert.equal(p.rows.find((r) => r.asin === "R1" && r.currency === "USD").productName, "Catalog R1", "catalog name wins");
  assert.equal(p.rows.find((r) => r.asin === "R2").productName, "Widget R2", "blank catalog name -> ordered name");
  assert.equal(p.rows.find((r) => r.asin === "RX").productName, null, "no catalog + no ordered -> null");
  assert.equal(p.rows.find((r) => r.asin === "RX").brand, "Unassigned", "no catalog entry -> Unassigned brand");
  assert.equal(p.rows.find((r) => r.asin === "R1" && r.currency === "USD").brand, "Acme");
});

test("9. rows with no returns AND no refund events are excluded; money-only + returns-only rows are included", () => {
  const p = deriveRet(retPlanned(FIXTURE())).payload;
  assert.ok(!p.rows.some((r) => r.asin === "RY"), "order-only settlement ASIN (no refund/returns) excluded");
  assert.ok(!p.rows.some((r) => r.asin === "RN"), "ordered-only ASIN (no returns/refunds) excluded");
  assert.ok(!p.rows.some((r) => r.asin === "RT"), "ordered-only ASIN (no returns/refunds) excluded, even with ordered units");
  assert.ok(p.rows.some((r) => r.asin === "RX" && r.hasMoney && !r.hasOrdered), "money-only ASIN included");
  assert.ok(p.rows.some((r) => r.asin === "R2" && !r.hasMoney && r.hasOrdered), "returns ASIN with ordered units but no settlement money included");
});

test("10. FBM-only refunded amount + seller-borne label cost are reported separately", () => {
  const p = deriveRet(retPlanned(FIXTURE())).payload;
  assert.deepEqual(p.fbmOnly, { refundedAmount: 23, sellerBorneLabelCost: 2 });
});

test("11. row order + full labels/lag/window match the live route", () => {
  const p = deriveRet(retPlanned(FIXTURE())).payload;
  assert.deepEqual(p.rows.map((r) => `${r.asin}/${r.currency}`), ["R1/USD", "R1/CAD", "R2/USD", "RX/USD"]);
  assert.deepEqual([p.returnsSourceLabel, p.moneySourceLabel, p.rateSourceLabel, p.rateSourceLagDays, p.returnHistoryDays], [RETURNS_LABEL, MONEY_LABEL, RATE_LABEL, 0, 60]);
  assert.deepEqual(p.window, { from: FROM, to: ASOF, days: 60 });
});

group("returns derive: window + account validation fail closed");

test("12. the exact 60-day single windows are required; the canonical fixture derives", () => {
  assert.equal(deriveRet(retPlanned(FIXTURE())).status, "derived");
  assert.equal(FROM, addDaysStr(ASOF, -59), "returns window start = asOf-59d");
});

test("13. wrong-window returns/settlements/ordered + dated catalog fail closed (invalid)", () => {
  const good = FIXTURE();
  for (const key of ["returns-leakage:returns", "returns-leakage:settlements", "returns-leakage:oli-sales"]) {
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
  for (const key of ["returns-leakage:returns", "returns-leakage:settlements", "returns-leakage:oli-sales", "returns-leakage:catalog"]) {
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
  for (const key of ["returns-leakage:returns", "returns-leakage:settlements", "returns-leakage:oli-sales", "returns-leakage:catalog"]) {
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

group("returns derive: Blocker 2 currency correctness -- no duplicated counts/sales/units; rate withheld when currency-ambiguous");

// A dedicated fixture pinning Blocker 2 independently of the main FIXTURE. M1 is a GENUINE USD+CAD
// multi-currency ASIN: it has ordered units in BOTH currencies (USD 30 / CAD 20) AND a CAD refund, so BOTH
// currency rows are emitted (the CAD row via its own refund activity). USD (greatest ordered units) is the
// deterministic PRIMARY return holder. S1 is single-currency USD (ordered 20 units, 2 returns). Every
// expectation below is HAND-WRITTEN -- never read back from the derived payload -- so correctness is pinned.
const B2_FIXTURE = () => ({
  returns: [
    ret("2025-08-01", "M1", "SKU-M1", "DEFECTIVE", "FBA", "Approved", 0, 0, ""),
    ret("2025-08-02", "M1", "SKU-M1", "DEFECTIVE", "FBA", "Approved", 0, 0, ""),
    ret("2025-08-03", "M1", "SKU-M1", "DEFECTIVE", "FBA", "Approved", 0, 0, ""),
    ret("2025-08-04", "M1", "SKU-M1", "TOO_SMALL", "FBM", "Approved", 0, 0, ""),  // M1 => 4 return records
    ret("2025-08-05", "S1", "SKU-S1", "DEFECTIVE", "FBA", "Approved", 0, 0, ""),
    ret("2025-08-06", "S1", "SKU-S1", "DEFECTIVE", "FBA", "Approved", 0, 0, ""),  // S1 => 2 return records
  ],
  settlements: [
    refund("M1", "SKU-M1", "CAD", { amount: -10, qty: -1 }), // the CAD row's OWN return activity (so it emits)
  ],
  ordered: [
    ord("M1", "M One", 300, 30, "USD"), // USD ordered: 30 units / 300 sales
    ord("M1", "M One", 100, 20, "CAD"), // CAD ordered: 20 units / 100 sales
    ord("S1", "S One", 200, 20, "USD"), // single-currency USD: 20 units / 200 sales
  ],
  catalog: [],
});

test("b2a. no duplicated return counts: the PRIMARY currency row carries the count, others 0; the per-ASIN sum equals the true return-record count", () => {
  const r = deriveRet(retPlanned(B2_FIXTURE()));
  assert.equal(r.status, "derived");
  const m1 = r.payload.rows.filter((row) => row.asin === "M1");
  const usd = m1.find((row) => row.currency === "USD");
  const cad = m1.find((row) => row.currency === "CAD");
  assert.equal(usd.returnCount, 4, "USD (greatest ordered units = 30) is the deterministic primary return holder");
  assert.equal(cad.returnCount, 0, "the non-primary currency row carries returnCount 0");
  assert.equal(m1.reduce((s, row) => s + row.returnCount, 0), 4, "summing returnCount across the ASIN's currency rows = its 4 true return records (never duplicated)");
  assert.deepEqual(cad.reasonBuckets, {}, "non-holder currency row carries no reason mix");
  assert.deepEqual(cad.topReasons, []);
  assert.deepEqual([usd.fbaReturns, usd.fbmReturns], [3, 1], "the channel counts also live ONLY on the primary row");
  assert.deepEqual([cad.fbaReturns, cad.fbmReturns], [0, 0]);
});

test("b2b. no duplicated sales / ordered units / refund money: each currency row holds ONLY its own currency's totals", () => {
  const p = deriveRet(retPlanned(B2_FIXTURE())).payload;
  const usd = p.rows.find((row) => row.asin === "M1" && row.currency === "USD");
  const cad = p.rows.find((row) => row.asin === "M1" && row.currency === "CAD");
  assert.deepEqual([usd.orderedUnits, usd.sales], [30, 300], "USD row = the USD ordered total only");
  assert.deepEqual([cad.orderedUnits, cad.sales], [20, 100], "CAD row = the CAD ordered total only (its own, not copied)");
  assert.deepEqual([usd.refundedAmount, cad.refundedAmount], [0, 10], "refund money stays on its own currency row (only CAD refunded)");
});

test("b2c. per-currency ordered units are isolated: a currency row is NEVER the combined cross-currency total", () => {
  const p = deriveRet(retPlanned(B2_FIXTURE())).payload;
  const usd = p.rows.find((row) => row.asin === "M1" && row.currency === "USD");
  const cad = p.rows.find((row) => row.asin === "M1" && row.currency === "CAD");
  assert.equal(usd.orderedUnits, 30);
  assert.notEqual(usd.orderedUnits, 50, "the USD row is NOT the combined USD+CAD ordered total (30+20)");
  assert.equal(usd.orderedUnits + cad.orderedUnits, 50, "the two currency rows PARTITION the 50 combined ordered units");
});

test("b2d. the return RATE is WITHHELD (returnedUnits null) on every row of a multi-currency ASIN, and PRESENT (returnedUnits === returnCount) on a single-currency ASIN", () => {
  const p = deriveRet(retPlanned(B2_FIXTURE())).payload;
  const m1 = p.rows.filter((row) => row.asin === "M1");
  assert.equal(m1.length, 2, "both M1 currency rows are emitted");
  assert.ok(m1.every((row) => row.returnedUnits === null), "currency-ambiguous rate withheld on ALL of the multi-currency ASIN's rows");
  const s1 = p.rows.find((row) => row.asin === "S1");
  assert.equal(s1.currency, "USD", "the single-currency ASIN keeps its one currency row");
  assert.equal(s1.returnCount, 2);
  assert.equal(s1.returnedUnits, 2, "single-currency ASIN keeps returnedUnits === returnCount (rate known)");
  assert.equal(s1.orderedUnits, 20, "its ordered denominator is intact");
});

test("b2e. Blocker 3: payload.currencies is the UNION of the currencies EMITTED on the rows, NOT the settlement-fold currencies", () => {
  const p = deriveRet(retPlanned(B2_FIXTURE())).payload;
  // Emitted rows: M1/USD, M1/CAD, S1/USD. The ONLY settlement is a CAD refund, so the settlement-fold
  // currencies would be just ["CAD"] -- the ordered-only USD would be DROPPED by the old logic. The corrected
  // field is the deduped, sorted union of the nonblank row currencies actually emitted, so USD is present.
  assert.deepEqual(p.currencies, ["CAD", "USD"], "currencies == union of emitted row currencies (incl. the ordered-only USD)");
  const emitted = [...new Set(p.rows.map((row) => row.currency).filter(Boolean))].sort();
  assert.deepEqual(p.currencies, emitted, "exactly the deduped, sorted union of emitted row currencies");
});

group("returns latestDataDate: an OBSERVED source-evidence date, never the requested asOf (freshness blocker)");

// latestDataDate must be the MAX real date in the already-validated raw Returns rows (null if none), never
// context.to / payload.window.to / Date.now(). deriveRet returns the full derive result (status + payload +
// latestDataDate).

test("f1. four successful-but-EMPTY source payloads => status derived, latestDataDate null (never asOf)", () => {
  const r = deriveRet(retPlanned({ returns: [], settlements: [], ordered: [], catalog: [] }));
  assert.equal(r.status, "derived", "empty-but-valid sources derive a valid empty report");
  assert.deepEqual(r.payload.rows, []);
  assert.equal(r.payload.window.to, ASOF, "the payload window end is still asOf (route parity)");
  assert.equal(r.latestDataDate, null, "no dated source evidence => latestDataDate null, NOT asOf");
});

test("f2. returns rows dated Jul 20 + Jul 31 with asOf Aug 10 => latestDataDate === Jul 31, never Aug 10", () => {
  const built = retPlanned({ returns: [
    ret("2025-07-20", "R1", "SKU-R1", "DEFECTIVE", "FBA", "Approved", -1, 0, ""),
    ret("2025-07-31", "R1", "SKU-R1", "DEFECTIVE", "FBA", "Approved", -1, 0, ""),
  ] });
  const r = deriveRet(built);
  assert.equal(r.status, "derived");
  assert.equal(r.latestDataDate, "2025-07-31", "the maximum observed return date");
  assert.notEqual(r.latestDataDate, ASOF, "never the requested asOf");
});

test("f3. an empty-ASIN return row (folded out) still contributes its valid source date as freshness evidence", () => {
  const built = retPlanned({ returns: [ret("2025-08-05", "", "", "DEFECTIVE", "FBA", "Approved", -1, 0, "")] });
  const r = deriveRet(built);
  assert.equal(r.status, "derived");
  assert.equal(r.payload.returnRecordCount, 1);
  assert.equal(r.payload.rows.length, 0, "the empty-ASIN row folds out of the rows");
  assert.equal(r.latestDataDate, "2025-08-05", "but its validated source date still counts");
});

test("f4. impossible/future/out-of-window return date => typed invalid, latestDataDate null", () => {
  for (const bad of ["2025-02-30", "2099-01-01", addDaysStr(ASOF, 1), addDaysStr(FROM, -1)]) {
    const r = deriveRet(retPlanned({ returns: [ret(bad, "R1", "SKU-R1", "DEFECTIVE", "FBA", "Approved", -1, 0, "")] }));
    assert.equal(r.status, "invalid", `${bad} => invalid`);
    assert.equal(r.latestDataDate, null, `${bad} => latestDataDate null`);
  }
});

test("f5. worker-level: recordReportSuccess receives the EXACT observed latestDataDate (Jul 31), not asOf", async () => {
  const store = makeStore();
  const cid = store.openCycle({ bucket: "us", cycleDate: "2026-08-11" });
  const built = retPlanned({
    returns: [ret("2025-07-20", "R1", "SKU-R1", "DEFECTIVE", "FBA", "Approved", -1, 0, ""), ret("2025-07-31", "R1", "SKU-R1", "DEFECTIVE", "FBA", "Approved", -2, 0, "")],
    settlements: [refund("R1", "SKU-R1", "USD", { amount: -9, qty: -1 })],
    ordered: [ord("R1", "Widget R1", 100, 10)],
    catalog: [cat("R1", "P1", "Catalog R1", "Acme")],
  });
  for (const p of built.planned) {
    store.upsertSourceJob({ cycleId: cid, requestHash: p.requestHash, requestKey: p.requestKey, sourceId: "s", sourceKey: "k", connectionId: "primary", organizationFingerprint: "org", accountScopeHash: "sch" });
    store.saveSourceRows({ job: { request_hash: p.requestHash }, rows: built.rows[p.requestHash] || [] });
    store.recordSourceSuccess({ cycleId: cid, requestHash: p.requestHash, exportId: "e", rowCount: (built.rows[p.requestHash] || []).length, cacheObjectPath: "p/" + p.requestHash });
  }
  const plannedReports = [{
    reportKey: "returns-leakage", accountId: ID, connectionId: "primary", bucket: "us",
    sources: built.planned.map((p) => ({ requestKey: p.requestKey, requestHash: p.requestHash, from: p.from, to: p.to, sellerOrVendorIds: p.sellerOrVendorIds, optional: false })),
    context: { to: ASOF, rawSellerId: ID },
  }];
  const saveSnapshot = async () => ({ paramsHash: "ph" });
  const res = await runReportJobs({ store, cycleId: cid, sourceRows: (h) => store.loadSourceRows(h), saveSnapshot, plannedReports });
  assert.equal(res.succeeded, 1);
  assert.equal(store.report("returns-leakage", ID).latest_data_date, "2025-07-31", "worker records the observed evidence date, not asOf");
});

test("f4b. worker-level: an out-of-window return date => report NOT saved, prior LKG snapshot preserved, no latest_data_date write", async () => {
  const store = makeStore();
  const cid = store.openCycle({ bucket: "us", cycleDate: "2026-08-11" });
  const built = retPlanned({
    returns: [ret("2099-01-01", "R1", "SKU-R1", "DEFECTIVE", "FBA", "Approved", -1, 0, "")], // future date
    settlements: [refund("R1", "SKU-R1", "USD", { amount: -9, qty: -1 })],
    ordered: [ord("R1", "Widget R1", 100, 10)],
    catalog: [cat("R1", "P1", "Catalog R1", "Acme")],
  });
  for (const p of built.planned) {
    store.upsertSourceJob({ cycleId: cid, requestHash: p.requestHash, requestKey: p.requestKey, sourceId: "s", sourceKey: "k", connectionId: "primary", organizationFingerprint: "org", accountScopeHash: "sch" });
    store.saveSourceRows({ job: { request_hash: p.requestHash }, rows: built.rows[p.requestHash] || [] });
    store.recordSourceSuccess({ cycleId: cid, requestHash: p.requestHash, exportId: "e", rowCount: 1, cacheObjectPath: "p/" + p.requestHash });
  }
  const lkg = { accountId: ID, prior: true };
  store.seedSnapshot("scheduler-v2/returns-leakage", ID, lkg);
  const plannedReports = [{
    reportKey: "returns-leakage", accountId: ID, connectionId: "primary", bucket: "us",
    sources: built.planned.map((p) => ({ requestKey: p.requestKey, requestHash: p.requestHash, from: p.from, to: p.to, sellerOrVendorIds: p.sellerOrVendorIds, optional: false })),
    context: { to: ASOF, rawSellerId: ID },
  }];
  let saveCalls = 0;
  const saveSnapshot = async () => { saveCalls += 1; return { paramsHash: "ph" }; };
  const res = await runReportJobs({ store, cycleId: cid, sourceRows: (h) => store.loadSourceRows(h), saveSnapshot, plannedReports });
  assert.equal(res.succeeded, 0, "invalid source data => report not saved");
  assert.equal(saveCalls, 0, "zero snapshot writes");
  assert.deepEqual(store._snapshots.get("scheduler-v2/returns-leakage|" + ID).payload, lkg, "prior last-known-good preserved");
});

test("f6. other adapters retain their existing latestDataDate results (the sources arg is backward-compatible)", () => {
  // Buy Box Loss reads its latestDataDate from a PAYLOAD field (observedWindow.to), not from `sources`.
  // Deriving it through the same 3-arg invocation must yield the max observed daily date, unchanged.
  const slices = splitDateRangeByDays(addDaysStr(ASOF, -27), ASOF, 7);
  const planned = []; const rows = {};
  slices.forEach((w) => { const f = frag("buy-box-loss:daily", w.from, w.to); planned.push(f); rows[f.requestHash] = [{ date: w.from, sku: "S", child_asin: "A", product_name: "P", product_brand: "B", currency: "USD", buybox_percentage: 90, page_views: 5 }]; });
  // Blocker 1: buy-box ordered is the canonical OLI sales fragment sliced by canonicalOliSlices over the SAME
  // [asOf-27d, asOf] window; each canonical row carries a `date` inside its own slice window.
  canonicalOliSlices(addDaysStr(ASOF, -27), ASOF).forEach((w) => { const f = frag("buy-box-loss:oli-sales", w.from, w.to); planned.push(f); rows[f.requestHash] = [{ date: w.from, sku: "S", child_asin: "A", item_price_currency: "USD", total_sales_sum: 10, total_units_sum: 1 }]; });
  const invDay = addDaysStr(ASOF, -1); // EXACT single D-1 snapshot day
  const inv = frag("buy-box-loss:inventory", invDay, invDay); planned.push(inv); rows[inv.requestHash] = [{ date: invDay, sku: "S", child_asin: "A", product_name: "P", currency: "USD", available: 5, units_shipped_t30: 1 }];
  const catF = frag("buy-box-loss:catalog", null, null); planned.push(catF); rows[catF.requestHash] = [{ child_asin: "A", parent_asin: "P", product_name: "P", product_brand: "B" }];
  const r = deriveReportSnapshot({ reportKey: "buy-box-loss", sources: buildSources(planned, rows), context: ctx() });
  assert.equal(r.status, "derived");
  assert.equal(r.latestDataDate, slices[3].from, "buy-box latestDataDate is unchanged: the payload observedWindow.to (max daily date)");
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
    recordReportSuccess({ reportKey, accountId, latestDataDate }) { Object.assign(reportJobs.get(rkey(reportKey, accountId)), { fetch_status: "ready", derive_status: "succeeded", save_status: "succeeded", validated: true, latest_data_date: latestDataDate ?? null }); },
  };
}

function makeDataDoe(opts = {}) {
  const create = {}; let hits = 0;
  const deadlineErr = () => Object.assign(new Error("deferred"), { code: "DATADOE_DEADLINE" });
  const rowsFor = (job) => {
    const rk = job.requestKey || ""; const fp = job.fetchParams || {};
    if (rk.includes("returns-leakage:returns")) return [ret(fp.to || ASOF, "R1", "SKU-R1", "DEFECTIVE", "FBA", "Approved", -5, 0, "")];
    if (rk.includes("settlements")) return [refund("R1", "SKU-R1", "USD", { amount: -9, commission: -1, unitFee: -1, cogs: -2, qty: -1 })];
    if (rk.includes("returns-leakage:oli-sales")) return [ord("R1", "Widget R1", 100, 10, "USD", fp.to || ASOF)];
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

test("22. default AND explicit planning include returns-leakage; the plan holds the sliced returns sequence + the canonical OLI-sales slice sequence + two single-window jobs", () => {
  assert.ok(SHADOW_PLANNED_REPORT_KEYS.includes("returns-leakage"), "returns-leakage is a default generic report key");
  assert.ok(shadowPlan(ACCTS).reportRequests.some((r) => r.reportKey === "returns-leakage"), "DEFAULT plan includes returns-leakage");
  const plan = shadowPlan(ACCTS, ["returns-leakage"]);
  const bb = plan.reportRequests.find((r) => r.reportKey === "returns-leakage");
  // GOLDEN: returns is <=7-day sliced NEWEST-FIRST; ordered (oli-sales) is the ONE canonical OLI sales
  // fragment sliced by canonicalOliSlices CHRONOLOGICALLY (Blocker 1); settlements + catalog stay one job
  // each. Total deduplicated jobs = returnSlices + oliSlices + 2.
  const expectedSlices = splitDateRangeByDays(FROM, ASOF, DERIVE_TIMEOUT_SAFE_SLICE_DAYS).reverse();
  const retJobs = plan.reportRequests[0].sources.filter((s) => s.requestKey === "returns-leakage:returns");
  assert.deepEqual(retJobs.map((s) => ({ from: s.from, to: s.to })), expectedSlices, "returns = the exact newest-first <=7d slice sequence");
  assert.equal(retJobs[0].to, ASOF, "newest slice first");
  assert.equal(retJobs[retJobs.length - 1].from, FROM, "oldest slice last; exact original coverage");
  const expectedOliSlices = canonicalOliSlices(FROM, ASOF);
  const oliJobs = plan.reportRequests[0].sources.filter((s) => s.requestKey === "returns-leakage:oli-sales");
  assert.deepEqual(oliJobs.map((s) => ({ from: s.from, to: s.to })), expectedOliSlices, "oli-sales = the exact canonicalOliSlices sequence (chronological, calendar-anchored)");
  assert.equal(oliJobs[0].from, FROM, "first canonical slice starts at the window start");
  assert.equal(oliJobs[oliJobs.length - 1].to, ASOF, "last canonical slice ends at asOf");
  assert.equal(plan.sourceJobs.length, expectedSlices.length + expectedOliSlices.length + 2, "sliced returns + canonical oli-sales slices + settlements + catalog");
  assert.deepEqual([srcOf(plan, "returns-leakage:settlements").from, srcOf(plan, "returns-leakage:settlements").to], [FROM, ASOF], "settlements window asOf-59d..asOf (grouped -- unsliced)");
  assert.deepEqual([srcOf(plan, "returns-leakage:catalog").from, srcOf(plan, "returns-leakage:catalog").to], [null, null], "no-date catalog");
  const rj = plan.reportJobs.find((j) => j.reportKey === "returns-leakage");
  assert.equal(rj.dependsOn.length, expectedSlices.length + expectedOliSlices.length + 2, "report depends on every returns slice + every oli-sales slice + settlements + catalog");
  assert.deepEqual([...rj.dependsOn].sort(), plan.sourceJobs.map((j) => j.requestHash).sort());
  assert.deepEqual(bb.context, { to: ASOF, rawSellerId: ID }, "context carries asOf + raw seller id");
  const jobs = resolveFromPlan(plan)().sourceJobs;
  assert.ok(jobs.every((j) => j.owner && j.owner.reportKey === "returns-leakage" && j.owner.accountId === ID && j.owner.ownerId), "each job carries returns-leakage owner metadata");
  assert.equal(new Set(jobs.map((j) => j.owner.ownerId)).size, 1, "one owner for the single account/org");
});

test("23. the no-date catalog canonical hash is SHARED with Buy Box + Sales Movers; returns/settlements/oli-sales are distinct", () => {
  const retPlan = shadowPlan(ACCTS, ["returns-leakage"]);
  const bb = planBuyBoxLoss({ accountId: ID, country: "US", currency: "USD", connections: CONNS, asOf: ASOF });
  const sm = planSalesMovers({ accountId: ID, country: "US", currency: "USD", connections: CONNS, asOf: ASOF, probeSignal: { status: "success", validated: true, latestReportedDate: "2025-08-08" } });
  const retCat = srcOf(retPlan, "returns-leakage:catalog").requestHash;
  assert.equal(retCat, bb.sources.find((s) => s.requestKey === "buy-box-loss:catalog").requestHash, "shared catalog identity with Buy Box");
  assert.equal(retCat, sm.sources.find((s) => s.requestKey === "sales-movers:catalog").requestHash, "shared catalog identity with Sales Movers");
  // The returns ordered (Order Line Items) uses a different source/column/window set than Sales Movers traffic => distinct identity.
  assert.notEqual(srcOf(retPlan, "returns-leakage:oli-sales").requestHash, sm.sources.find((s) => s.requestKey === "sales-movers:traffic").requestHash, "returns oli-sales is NOT shared with Sales Movers traffic");
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

test("24b. Blocker 1: TWO OLI reports (buy-box + returns) share ONE canonical OLI-slice export owned by BOTH (one create-export, two report owners)", async () => {
  const store = makeStore(); const dd = makeDataDoe();
  // Build ONE shadow plan for TWO of the five OLI reports at the SAME account/asOf. Their canonical OLI
  // fragments are calendar-anchored (canonicalOliSlices), so an interior slice both windows cover resolves
  // to the IDENTICAL request_hash -- two report jobs, ONE source identity.
  const plan = shadowPlan(ACCTS, ["buy-box-loss", "returns-leakage"]);
  const jobs = resolveFromPlan(plan)().sourceJobs;
  const bbOli = jobs.filter((j) => j.requestKey === "buy-box-loss:oli-sales");
  const retOli = jobs.filter((j) => j.requestKey === "returns-leakage:oli-sales");
  const shared = bbOli.find((b) => retOli.some((r) => r.requestHash === b.requestHash));
  assert.ok(shared, "buy-box and returns share at least one canonical OLI slice request_hash");
  const sharedJobs = jobs.filter((j) => j.requestHash === shared.requestHash);
  assert.equal(new Set(sharedJobs.map((j) => j.owner.reportKey)).size, 2, "the shared OLI slice is referenced by TWO distinct report owners");
  const r = await runSourceJobs({ store, dataDoe: dd, plannedJobs: jobs, ownerIds: [...new Set(jobs.map((j) => j.owner.ownerId))], bucket: "us", cycleDate: "2026-08-11" });
  assert.equal(dd.createCount(shared.requestHash), 1, "the shared canonical OLI slice export is created EXACTLY once");
  assert.equal(store.listSourceJobs(r.cycleId).filter((j) => j.request_hash === shared.requestHash).length, 1, "one canonical OLI source job for the shared slice");
  assert.equal(store._owners(r.cycleId).filter((m) => m.request_hash === shared.requestHash).length, 2, "the ONE canonical export carries TWO report-owner memberships");
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
  const sliceCount = splitDateRangeByDays(FROM, ASOF, DERIVE_TIMEOUT_SAFE_SLICE_DAYS).length;
  const oliSliceCount = canonicalOliSlices(FROM, ASOF).length;
  assert.equal(jobs.length, sliceCount + oliSliceCount + 2, "exactly the primary-account canonical jobs ran (sliced returns + canonical oli-sales + settlements + catalog)");
});

async function main() {
  ({ assembleSources, runReportJobs } = await import("../lib/server/sync/report-worker.js"));
  ({ deriveReportSnapshot, DERIVE_TIMEOUT_SAFE_SLICE_DAYS } = await import("../lib/server/sync/report-derivation.js"));
  ({ runSourceJobs } = await import("../lib/server/sync/source-worker.js"));
  ({ plannedSourceJob, runStagedSourceCycle } = await import("../lib/server/sync/source-sync-driver.js"));
  ({ sourceJobOwnerId } = await import("../lib/server/source-identity.js"));
  ({ planReturnsLeakage, planBuyBoxLoss, planSalesMovers, buildShadowReportPlan, SHADOW_PLANNED_REPORT_KEYS } = await import("../lib/server/sync/report-planner.js"));
  ({ addDaysStr, splitDateRangeByDays, canonicalOliSlices } = await import("../lib/server/date-windows.js"));
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
