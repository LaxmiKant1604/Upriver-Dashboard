// OLI SALES ESTIMATE -- INTEGRATION tests: the recompute orchestration (durable-truth in, atomic replace out) and
// the end-to-end enrichment through the REAL dashboard folds (named-brand isolation, Daily/Brand totals, ROI/TACoS)
// + the missing-value breakdown subtraction + byte-identical priced derive. ZERO I/O (mock readers/writer).
//
// 7-bit ASCII, LF, no top-level await, synchronous progress. Dynamic imports after a dummy Supabase env.

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

let ENG, RECOMP, DASH, SERVE, DERIV;
const ACC = "acct-1"; const SELLER = "SELLER1"; const ORG = "org-1";

// Build a recompute harness with injectable durable rows + a captured write.
function harness({ operationalRows = [], referenceRows = [], resolutionRows = null } = {}) {
  const writes = [];
  return {
    writes,
    readOperationalUnits: async ({ additiveOnly }) => operationalRows.filter((r) => !additiveOnly || (Number(r.explicit_zero_units || 0) + Number(r.pending_units || 0)) > 0),
    readDimensionalRows: async () => referenceRows,
    // Only wire a resolver reader when resolutionRows is supplied (else the recompute runs with NO resolver --
    // proving the fail-soft default: blank-ASIN targets stay unresolved exactly as before).
    ...(resolutionRows ? { readSkuAsinResolution: async () => resolutionRows } : {}),
    writeEstimates: async (args) => { writes.push(args.estimateRows); return { write: "ok", replaced: 0, inserted: args.estimateRows.length }; },
  };
}
const opRow = (date, { priced = 0, pending = 0, zero = 0, sku = "SKU-A", asin = "B0X", cur = "INR" } = {}) => ({
  account_id: ACC, seller_or_vendor_id: SELLER, sale_date: date, sku, child_asin: asin, currency: cur,
  priced_units: priced, priced_sales: priced ? priced * 100 : null, explicit_zero_units: zero, pending_units: pending, cancelled_units: 0, source_request_hash: "op",
});
const dimRow = (date, unitPrice, units = 1, { sku = "SKU-A", asin = "B0X", cur = "INR" } = {}) => ({
  seller_or_vendor_id: SELLER, sale_date: date, sku, child_asin: asin, currency: cur, is_cancelled: false,
  total_sales_sum: unitPrice * units, total_units_sum: units, source_request_hash: "ref-" + date,
});

async function main() {
  mark("loading modules");
  ENG = await import("../lib/server/sync/oli-sales-estimate.js");
  RECOMP = await import("../lib/server/sync/oli-sales-estimate-recompute.js");
  DASH = await import("../lib/server/sync/durable-dashboards.js");
  SERVE = await import("../lib/server/reports/oli-completeness-serve.js");
  DERIV = await import("../lib/server/reports/derivation-core.js");
  mark("running " + tests.filter((t) => !t.marker).length + " tests");
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

// ---------------------------------------------------------------------------------------------------------------
group("recomputeOliSalesEstimatesWindow: durable truth in, atomic replace out");

test("recompute writes an estimate for a missing-price grain from a dimensional reference", async () => {
  const h = harness({ operationalRows: [opRow("2026-08-29", { pending: 3 })], referenceRows: [dimRow("2026-08-29", 100)] });
  const r = await RECOMP.recomputeOliSalesEstimatesWindow({ organizationFingerprint: ORG, accountId: ACC, accountMarketplace: "IN", from: "2026-08-01", to: "2026-08-31", ...h, calculatedAt: "T" });
  assert.equal(r.estimates.length, 1);
  assert.equal(r.estimates[0].estimatedSales, 300);
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0][0].estimatedSales, 300);
});

test("recompute is IDEMPOTENT: same durable evidence -> byte-identical estimate rows", async () => {
  const args = { organizationFingerprint: ORG, accountId: ACC, accountMarketplace: "IN", from: "2026-08-01", to: "2026-08-31", calculatedAt: "T" };
  const a = await RECOMP.recomputeOliSalesEstimatesWindow({ ...args, ...harness({ operationalRows: [opRow("2026-08-29", { pending: 3 })], referenceRows: [dimRow("2026-08-29", 100)] }) });
  const b = await RECOMP.recomputeOliSalesEstimatesWindow({ ...args, ...harness({ operationalRows: [opRow("2026-08-29", { pending: 3 })], referenceRows: [dimRow("2026-08-29", 100)] }) });
  assert.deepEqual(a.estimates, b.estimates);
});

test("ACTUAL supersedes: once itemized (no missing units) the estimate window is CLEARED (empty write)", async () => {
  const h = harness({ operationalRows: [opRow("2026-08-29", { priced: 3, pending: 0 })] }); // additiveOnly filters it out
  const r = await RECOMP.recomputeOliSalesEstimatesWindow({ organizationFingerprint: ORG, accountId: ACC, accountMarketplace: "IN", from: "2026-08-01", to: "2026-08-31", ...h, calculatedAt: "T" });
  assert.equal(r.estimates.length, 0);
  assert.equal(h.writes.length, 1);
  assert.deepEqual(h.writes[0], [], "the window is cleared so a resolved grain leaves no estimate (no double-count)");
});

test("no reference within 7 days -> unresolved, empty estimate write (grain stays in the breakdown)", async () => {
  const h = harness({ operationalRows: [opRow("2026-08-29", { pending: 2 })], referenceRows: [dimRow("2026-08-10", 100)] });
  const r = await RECOMP.recomputeOliSalesEstimatesWindow({ organizationFingerprint: ORG, accountId: ACC, accountMarketplace: "IN", from: "2026-08-01", to: "2026-08-31", ...h, calculatedAt: "T" });
  assert.equal(r.estimates.length, 0);
  assert.equal(r.unresolved.length, 1);
  assert.deepEqual(h.writes[0], []);
});

// ---------------------------------------------------------------------------------------------------------------
group("enrichment through the REAL dashboard folds: named-brand isolation + totals");

const brandMaps = { byAsin: new Map([["B0X", "BrandX"], ["B0Y", "BrandY"]]), bySku: new Map() };
const hist = (date, sku, asin, sales, units, cur = "INR") => ({ account_id: ACC, seller_or_vendor_id: SELLER, sale_date: date, sku, child_asin: asin, currency: cur, sales_amount: sales, units });

test("named-brand isolation: an estimate lands ONLY in its ASIN's brand (no cross-brand leak)", () => {
  // Priced BrandX row + a FULLY-UNPRICED BrandY grain resolved by estimate (synthetic row).
  const history = [hist("2026-08-29", "SKU-A", "B0X", 500, 5)];
  const estimates = [{ accountId: ACC, sellerOrVendorId: SELLER, saleDate: "2026-08-29", sku: "SKU-B", childAsin: "B0Y", currency: "INR", estimatedSales: 200 }];
  const enriched = ENG.enrichOliHistoryRowsWithEstimates(history, estimates);
  const bv = DASH.brandViewRowsFromHistory({ historyRows: enriched, brandMaps, from: "2026-08-01", to: "2026-08-31" });
  const byBrand = new Map(bv.brands.map((r) => [r.brand, r.sales]));
  assert.equal(byBrand.get("BrandX"), 500, "BrandX sales unchanged (no estimate leak)");
  assert.equal(byBrand.get("BrandY"), 200, "BrandY gets ONLY its own estimate");
});

test("Daily total + ROI/TACoS include the estimate (corrected Total Sales)", () => {
  const history = [hist("2026-08-29", "SKU-A", "B0X", 300, 3)];
  const estimates = [{ accountId: ACC, sellerOrVendorId: SELLER, saleDate: "2026-08-29", sku: "SKU-A", childAsin: "B0X", currency: "INR", estimatedSales: 200 }];
  const enriched = ENG.enrichOliHistoryRowsWithEstimates(history, estimates);
  const daily = DASH.dailyRowsFromHistory({ historyRows: enriched, brandMaps, brand: "ALL", from: "2026-08-01", to: "2026-08-31" });
  const totalSales = daily.rows.reduce((s, r) => s + r.sales, 0);
  assert.equal(totalSales, 500, "Total Sales = priced 300 + estimate 200");
  const adSpend = 100;
  assert.equal(Number((totalSales / adSpend).toFixed(2)), 5, "ROI = Total Sales / Ad Spend recomputes from corrected sales");
  assert.equal(Number((adSpend / totalSales).toFixed(2)), 0.2, "TACoS = Ad Spend / Total Sales recomputes from corrected sales");
});

test("production bridge fragmentRowsFromHistory carries the enriched sales as total_sales_sum", () => {
  const history = [hist("2026-08-29", "SKU-A", "B0X", 300, 3)];
  const estimates = [{ accountId: ACC, sellerOrVendorId: SELLER, saleDate: "2026-08-29", sku: "SKU-A", childAsin: "B0X", currency: "INR", estimatedSales: 200 }];
  const enriched = ENG.enrichOliHistoryRowsWithEstimates(history, estimates);
  const frag = DASH.fragmentRowsFromHistory(enriched, ACC);
  const total = frag.reduce((s, r) => s + Number(r.total_sales_sum || 0), 0);
  assert.equal(total, 500, "the durable derive bridge sees the enriched Total Sales");
});

// ---------------------------------------------------------------------------------------------------------------
group("breakdown subtraction + byte-identical priced derive");

test("resolved grain drops out of the missing-value breakdown (units reclassified, observed unchanged)", () => {
  const rows = [{ account_id: ACC, sale_date: "2026-08-29", sku: "SKU-A", child_asin: "B0X", currency: "INR", priced_units: 2, priced_sales: 200, explicit_zero_units: 0, pending_units: 3, cancelled_units: 0 }];
  const before = SERVE.summarizeOperationalUnitBreakdown(rows, "2026-08-29", null);
  assert.equal(before.pendingWithSkuUnits, 3);
  assert.equal(before.pricedUnits, 2);
  const resolved = ENG.resolvedEstimateGroupKeys([{ accountId: ACC, saleDate: "2026-08-29", sku: "SKU-A", childAsin: "B0X", currency: "INR", estimatedSales: 1 }]);
  const after = SERVE.summarizeOperationalUnitBreakdown(rows, "2026-08-29", resolved);
  assert.equal(after.pendingWithSkuUnits, 0, "resolved pending no longer shows as unresolved");
  assert.equal(after.pricedUnits, 5, "resolved units reclassified as priced (2 + 3)");
  assert.equal(after.observedUnits, before.observedUnits, "observed units total unchanged (only reclassified)");
});

test("genuinely-unresolved grain STILL shows in the breakdown (no estimate for it)", () => {
  const rows = [{ account_id: ACC, sale_date: "2026-08-29", sku: "SKU-A", child_asin: "B0X", currency: "INR", priced_units: 0, priced_sales: null, explicit_zero_units: 0, pending_units: 4, cancelled_units: 0 }];
  const resolved = ENG.resolvedEstimateGroupKeys([{ accountId: ACC, saleDate: "2026-08-29", sku: "OTHER", childAsin: "B0Z", currency: "INR", estimatedSales: 1 }]);
  const after = SERVE.summarizeOperationalUnitBreakdown(rows, "2026-08-29", resolved);
  assert.equal(after.pendingWithSkuUnits, 4, "an unresolved grain is untouched");
});

test("UNRELATED byte-identical: no estimates -> the enriched history rows are the priced rows unchanged", () => {
  const history = [hist("2026-08-29", "SKU-A", "B0X", 300, 3), hist("2026-08-28", "SKU-B", "B0Y", 100, 1)];
  const enriched = ENG.enrichOliHistoryRowsWithEstimates(history, []);
  assert.deepEqual(enriched, history, "an empty estimate set never changes the priced Total Sales");
  const before = SERVE.summarizeOperationalUnitBreakdown([{ account_id: ACC, sale_date: "2026-08-29", sku: "SKU-A", child_asin: "B0X", currency: "INR", priced_units: 3, priced_sales: 300, explicit_zero_units: 0, pending_units: 0, cancelled_units: 0 }], "2026-08-29", null);
  const withEmpty = SERVE.summarizeOperationalUnitBreakdown([{ account_id: ACC, sale_date: "2026-08-29", sku: "SKU-A", child_asin: "B0X", currency: "INR", priced_units: 3, priced_sales: 300, explicit_zero_units: 0, pending_units: 0, cancelled_units: 0 }], "2026-08-29", new Set());
  assert.deepEqual(withEmpty, before, "an empty resolved set never changes the breakdown");
});

// ---------------------------------------------------------------------------------------------------------------
group("orchestration fail-closed: shared resolver + recompute (runtime/backfill pattern)");

// Mirror EXACTLY what the runtime and the backfill do: resolve the authoritative marketplace with the ONE shared
// resolver, then recompute each account under authoritativeMarketplace() ("" when missing/ambiguous).
async function orchestrate(directoryAccounts, jobs) {
  const resolution = ENG.resolveUniqueMarketplaceByAccount(directoryAccounts);
  const out = [];
  for (const j of jobs) {
    const acctMkt = ENG.authoritativeMarketplace(resolution, j.accountId);
    const r = await RECOMP.recomputeOliSalesEstimatesWindow({
      organizationFingerprint: ORG, accountId: j.accountId, accountMarketplace: acctMkt,
      from: "2026-08-01", to: "2026-08-31", ...j.h, calculatedAt: "T",
    });
    out.push({ accountId: j.accountId, acctMkt, r, status: (resolution.get(j.accountId) || {}).status });
  }
  return out;
}
const eurOp = (date, pending) => ({ account_id: ACC, seller_or_vendor_id: SELLER, sale_date: date, sku: "SKU-A", child_asin: "B0X", currency: "EUR", marketplace_country_code: "DE", priced_units: 0, priced_sales: null, explicit_zero_units: 0, pending_units: pending, cancelled_units: 0, source_request_hash: "op" });
const eurRef = (date, unitPrice, mkt) => ({ seller_or_vendor_id: SELLER, sale_date: date, sku: "SKU-A", child_asin: "B0X", currency: "EUR", marketplace_country_code: mkt, is_cancelled: false, total_sales_sum: unitPrice, total_units_sum: 1, source_request_hash: "ref" });

test("AMBIGUOUS account: orchestration NEVER computes or persists an estimate, even with a valid same-marketplace reference", async () => {
  const dir = [{ accountId: ACC, country: "DE" }, { accountId: ACC, country: "FR" }]; // ambiguous
  const h = harness({ operationalRows: [eurOp("2026-08-29", 3)], referenceRows: [eurRef("2026-08-29", 100, "DE")] });
  const [res] = await orchestrate(dir, [{ accountId: ACC, h }]);
  assert.equal(res.status, "ambiguous");
  assert.equal(res.acctMkt, "", "ambiguous authority never yields a marketplace");
  assert.equal(res.r.estimates.length, 0, "no estimate is ever computed for an ambiguous account");
  assert.equal(res.r.unresolved.length, 1, "the grain is left unresolved");
  assert.deepEqual(h.writes[0], [], "the estimate window is CLEARED (stale estimates cannot linger)");
});

test("MISSING account: orchestration recompute clears the window and leaves grains unresolved", async () => {
  const dir = [{ accountId: ACC, country: "" }]; // missing
  const h = harness({ operationalRows: [eurOp("2026-08-29", 2)], referenceRows: [eurRef("2026-08-29", 100, "DE")] });
  const [res] = await orchestrate(dir, [{ accountId: ACC, h }]);
  assert.equal(res.status, "missing");
  assert.equal(res.r.estimates.length, 0);
  assert.deepEqual(h.writes[0], []);
});

test("UNIQUE account: orchestration estimates normally (no regression) under the proven marketplace", async () => {
  const dir = [{ accountId: ACC, country: "DE" }, { accountId: ACC, country: "DE" }]; // duplicate-same -> unique
  const h = harness({ operationalRows: [eurOp("2026-08-29", 2)], referenceRows: [eurRef("2026-08-29", 100, "DE")] });
  const [res] = await orchestrate(dir, [{ accountId: ACC, h }]);
  assert.equal(res.status, "unique");
  assert.equal(res.acctMkt, "DE");
  assert.equal(res.r.estimates.length, 1);
  assert.equal(res.r.estimates[0].estimatedSales, 200);
  assert.equal(res.r.estimates[0].marketplaceCountryCode, "DE");
});

test("STALE window is cleared when authority FLIPS unique -> ambiguous", async () => {
  const h1 = harness({ operationalRows: [eurOp("2026-08-29", 2)], referenceRows: [eurRef("2026-08-29", 100, "DE")] });
  const [a] = await orchestrate([{ accountId: ACC, country: "DE" }], [{ accountId: ACC, h: h1 }]);
  assert.equal(a.r.estimates.length, 1, "initially unique -> an estimate is written");
  // Directory later becomes ambiguous (DE + FR): the very next recompute writes [] over the same window.
  const h2 = harness({ operationalRows: [eurOp("2026-08-29", 2)], referenceRows: [eurRef("2026-08-29", 100, "DE")] });
  const [b] = await orchestrate([{ accountId: ACC, country: "DE" }, { accountId: ACC, country: "FR" }], [{ accountId: ACC, h: h2 }]);
  assert.equal(b.r.estimates.length, 0);
  assert.deepEqual(h2.writes[0], [], "the previously-estimated window is cleared once authority is ambiguous");
});

test("BASE priced sales + units are unchanged when estimates fail closed (fail-closed never regresses the priced path)", async () => {
  const dir = [{ accountId: ACC, country: "DE" }, { accountId: ACC, country: "FR" }]; // ambiguous -> no estimates
  const h = harness({ operationalRows: [eurOp("2026-08-29", 3)], referenceRows: [eurRef("2026-08-29", 100, "DE")] });
  const [res] = await orchestrate(dir, [{ accountId: ACC, h }]);
  const priced = [hist("2026-08-29", "SKU-A", "B0X", 300, 3, "EUR")];
  const enriched = ENG.enrichOliHistoryRowsWithEstimates(priced, res.r.estimates); // res.r.estimates === []
  assert.deepEqual(enriched, priced, "no estimate -> the priced Total Sales and units are byte-identical");
});

// ---------------------------------------------------------------------------------------------------------------
group("recompute WITH server-side SKU->ASIN resolution (the fix, end-to-end through the orchestration)");

const blankOp = (date, pending, { sku = "SKU-A", cur = "INR" } = {}) => ({
  account_id: ACC, seller_or_vendor_id: SELLER, sale_date: date, sku, child_asin: "", currency: cur,
  priced_units: 0, priced_sales: null, explicit_zero_units: 0, pending_units: pending, cancelled_units: 0, source_request_hash: "op",
});
const resRow = (over = {}) => ({ seller_or_vendor_id: SELLER, currency: "INR", sku: "SKU-A", asin_count: 1, child_asin: "B0X", ...over });

test("recompute resolves a blank-ASIN pending grain via the injected resolver and writes the estimate", async () => {
  const h = harness({ operationalRows: [blankOp("2026-08-30", 5)], referenceRows: [dimRow("2026-08-30", 100)], resolutionRows: [resRow()] });
  const r = await RECOMP.recomputeOliSalesEstimatesWindow({ organizationFingerprint: ORG, accountId: ACC, accountMarketplace: "IN", from: "2026-08-01", to: "2026-08-31", ...h, calculatedAt: "T" });
  assert.equal(r.estimates.length, 1);
  assert.equal(r.estimates[0].estimatedSales, 500);
  assert.equal(r.estimates[0].childAsin, "B0X", "resolved ASIN attributed");
  assert.equal(h.writes[0][0].estimatedSales, 500);
});

test("FAIL-SOFT: no resolver reader -> the blank-ASIN grain stays unresolved (priced path never breaks)", async () => {
  const h = harness({ operationalRows: [blankOp("2026-08-30", 5)], referenceRows: [dimRow("2026-08-30", 100)] });
  const r = await RECOMP.recomputeOliSalesEstimatesWindow({ organizationFingerprint: ORG, accountId: ACC, accountMarketplace: "IN", from: "2026-08-01", to: "2026-08-31", ...h, calculatedAt: "T" });
  assert.equal(r.estimates.length, 0);
  assert.equal(r.unresolved.length, 1);
  assert.deepEqual(h.writes[0], []);
});

test("FAIL-SOFT: a THROWING resolver reader is swallowed -> unresolved, never a thrown recompute", async () => {
  const h = harness({ operationalRows: [blankOp("2026-08-30", 5)], referenceRows: [dimRow("2026-08-30", 100)] });
  h.readSkuAsinResolution = async () => { throw new Error("boom"); };
  const r = await RECOMP.recomputeOliSalesEstimatesWindow({ organizationFingerprint: ORG, accountId: ACC, accountMarketplace: "IN", from: "2026-08-01", to: "2026-08-31", ...h, calculatedAt: "T" });
  assert.equal(r.estimates.length, 0);
  assert.equal(r.unresolved.length, 1);
});

test("resolved-from-blank estimate flows through the REAL brand fold to the resolved ASIN's brand", async () => {
  const h = harness({ operationalRows: [blankOp("2026-08-30", 2)], referenceRows: [dimRow("2026-08-30", 100)], resolutionRows: [resRow()] });
  const r = await RECOMP.recomputeOliSalesEstimatesWindow({ organizationFingerprint: ORG, accountId: ACC, accountMarketplace: "IN", from: "2026-08-01", to: "2026-08-31", ...h, calculatedAt: "T" });
  const enriched = ENG.enrichOliHistoryRowsWithEstimates([], r.estimates);
  const bv = DASH.brandViewRowsFromHistory({ historyRows: enriched, brandMaps, from: "2026-08-01", to: "2026-08-31" });
  const byBrand = new Map(bv.brands.map((x) => [x.brand, x.sales]));
  assert.equal(byBrand.get("BrandX"), 200, "the resolved-from-blank estimate attributes to BrandX (via resolved ASIN B0X)");
});

test("AMBIGUOUS resolution through the recompute -> unresolved, empty write", async () => {
  const h = harness({ operationalRows: [blankOp("2026-08-30", 3)], referenceRows: [dimRow("2026-08-30", 100)], resolutionRows: [resRow({ asin_count: 2 })] });
  const r = await RECOMP.recomputeOliSalesEstimatesWindow({ organizationFingerprint: ORG, accountId: ACC, accountMarketplace: "IN", from: "2026-08-01", to: "2026-08-31", ...h, calculatedAt: "T" });
  assert.equal(r.estimates.length, 0);
  assert.equal(r.unresolved[0].reason, ENG.UNRESOLVED_ASIN_AMBIGUOUS);
  assert.deepEqual(h.writes[0], []);
});

// ---------------------------------------------------------------------------------------------------------------
group("ordered-units PARITY through the REAL derive: Daily == Brand Sales == ordered units (priced + zero + pending)");

const CAT_PAR = [{ child_asin: "B0X", product_brand: "BrandX" }];
const ACCT = { accountId: ACC, name: "Store IN", country: "IN" };
// One account, one day: 2 priced (sales 200), 3 pending (resolved -> estimate 300), 1 explicit-zero (resolved -> est 10).
function mergedEvidence() {
  const historyRows = [{ account_id: ACC, seller_or_vendor_id: SELLER, sale_date: "2026-08-30", sku: "SKU-A", child_asin: "B0X", currency: "INR", sales_amount: 200, units: 2 }];
  const operationalRows = [{ account_id: ACC, seller_or_vendor_id: SELLER, sale_date: "2026-08-30", sku: "SKU-A", child_asin: "", currency: "INR", priced_units: 2, explicit_zero_units: 1, pending_units: 3, cancelled_units: 5, source_request_hash: "op" }];
  const estimateRows = [{ account_id: ACC, seller_or_vendor_id: SELLER, sale_date: "2026-08-30", sku: "SKU-A", child_asin: "B0X", currency: "INR", target_quantity: 4, estimated_sales: 310 }];
  const resolver = ENG.buildSkuAsinResolver({ accountMarketplace: "IN", historyRows: [{ seller_or_vendor_id: SELLER, currency: "INR", sku: "SKU-A", asin_count: 1, child_asin: "B0X" }], catalogRows: [] });
  return ENG.mergeOrderedOliHistory({ historyRows, operationalRows, estimateRows, skuAsinResolver: resolver });
}

test("merged grain: ordered = 2 priced + 1 zero + 3 pending = 6 (cancelled excluded), sales = 200 + 310", () => {
  const m = mergedEvidence();
  assert.equal(m.length, 1);
  assert.equal(m[0].units, 6, "priced 2 + zero 1 + pending 3; cancelled 5 excluded");
  assert.equal(m[0].sales_amount, 510, "priced 200 + estimate 310");
  assert.equal(m[0].child_asin, "B0X", "pending/zero resolved + co-located with priced + estimate");
  assert.equal(m[0].unpriced_units, 0, "estimate covers the 4 zero+pending units");
});

test("DAILY (rollupSupersetToDaily) Units Sold = 6 ordered units; Total Sales = 510", () => {
  const frag = DASH.fragmentRowsFromHistory(mergedEvidence(), ACC);
  const daily = DERIV.rollupSupersetToDaily(frag);
  const units = daily.reduce((s, r) => s + Number(r.total_units_sum || 0), 0);
  const sales = daily.reduce((s, r) => s + Number(r.total_sales_sum || 0), 0);
  assert.equal(units, 6, "Daily counts every ordered non-cancelled unit");
  assert.equal(sales, 510, "Daily Total Sales includes estimated sales");
});

test("BRAND SALES (orderSalesByBrand) total_units_sold = 6 ordered; sales = 510; attributed to BrandX", () => {
  const orderRows = DASH.orderRowsFromHistory(mergedEvidence(), ACCT);
  const brand = DERIV.orderSalesByBrand(orderRows, CAT_PAR);
  const bx = brand.find((r) => r.product_brand === "BrandX");
  assert.ok(bx, "resolved pending/zero units attribute to BrandX (not Unassigned)");
  assert.equal(bx.total_units_sold, 6, "Brand Sales Units Sold = ordered (parity with Daily)");
  assert.equal(bx.total_sales, 510, "Brand Sales Total Sales includes estimate");
  assert.equal(bx.missing_order_value_units, 0, "nothing unresolved here");
});

test("PARITY with an UNRESOLVED grain: units counted in BOTH Daily and Brand Sales; breakdown shows the gap", () => {
  // A pending grain that cannot resolve (no history) -> no estimate. Its units must still count in both reports.
  const historyRows = [];
  const operationalRows = [{ account_id: ACC, seller_or_vendor_id: SELLER, sale_date: "2026-08-30", sku: "SKU-N", child_asin: "", currency: "INR", pending_units: 4, source_request_hash: "op" }];
  const merged = ENG.mergeOrderedOliHistory({ historyRows, operationalRows, estimateRows: [], skuAsinResolver: ENG.buildSkuAsinResolver({ accountMarketplace: "IN", historyRows: [], catalogRows: [] }) });
  const dailyUnits = DERIV.rollupSupersetToDaily(DASH.fragmentRowsFromHistory(merged, ACC)).reduce((s, r) => s + Number(r.total_units_sum || 0), 0);
  const brand = DERIV.orderSalesByBrand(DASH.orderRowsFromHistory(merged, ACCT), CAT_PAR);
  const totUnits = brand.reduce((s, r) => s + Number(r.total_units_sold || 0), 0);
  const totMissing = brand.reduce((s, r) => s + Number(r.missing_order_value_units || 0), 0);
  assert.equal(dailyUnits, 4, "Daily counts the unresolved pending units");
  assert.equal(totUnits, 4, "Brand Sales ALSO counts them (parity)");
  assert.equal(totMissing, 4, "and surfaces them as the unresolved breakdown gap");
});

main().then((f) => { if (f) process.exitCode = 1; }).catch((e) => { out("FATAL " + String(e && e.stack ? e.stack : e)); process.exitCode = 1; });
