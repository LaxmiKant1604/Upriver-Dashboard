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

let ENG, RECOMP, DASH, SERVE;
const ACC = "acct-1"; const SELLER = "SELLER1"; const ORG = "org-1";

// Build a recompute harness with injectable durable rows + a captured write.
function harness({ operationalRows = [], referenceRows = [] } = {}) {
  const writes = [];
  return {
    writes,
    readOperationalUnits: async ({ additiveOnly }) => operationalRows.filter((r) => !additiveOnly || (Number(r.explicit_zero_units || 0) + Number(r.pending_units || 0)) > 0),
    readDimensionalRows: async () => referenceRows,
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
  const r = await RECOMP.recomputeOliSalesEstimatesWindow({ organizationFingerprint: ORG, accountId: ACC, from: "2026-08-01", to: "2026-08-31", ...h, calculatedAt: "T" });
  assert.equal(r.estimates.length, 1);
  assert.equal(r.estimates[0].estimatedSales, 300);
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0][0].estimatedSales, 300);
});

test("recompute is IDEMPOTENT: same durable evidence -> byte-identical estimate rows", async () => {
  const args = { organizationFingerprint: ORG, accountId: ACC, from: "2026-08-01", to: "2026-08-31", calculatedAt: "T" };
  const a = await RECOMP.recomputeOliSalesEstimatesWindow({ ...args, ...harness({ operationalRows: [opRow("2026-08-29", { pending: 3 })], referenceRows: [dimRow("2026-08-29", 100)] }) });
  const b = await RECOMP.recomputeOliSalesEstimatesWindow({ ...args, ...harness({ operationalRows: [opRow("2026-08-29", { pending: 3 })], referenceRows: [dimRow("2026-08-29", 100)] }) });
  assert.deepEqual(a.estimates, b.estimates);
});

test("ACTUAL supersedes: once itemized (no missing units) the estimate window is CLEARED (empty write)", async () => {
  const h = harness({ operationalRows: [opRow("2026-08-29", { priced: 3, pending: 0 })] }); // additiveOnly filters it out
  const r = await RECOMP.recomputeOliSalesEstimatesWindow({ organizationFingerprint: ORG, accountId: ACC, from: "2026-08-01", to: "2026-08-31", ...h, calculatedAt: "T" });
  assert.equal(r.estimates.length, 0);
  assert.equal(h.writes.length, 1);
  assert.deepEqual(h.writes[0], [], "the window is cleared so a resolved grain leaves no estimate (no double-count)");
});

test("no reference within 7 days -> unresolved, empty estimate write (grain stays in the breakdown)", async () => {
  const h = harness({ operationalRows: [opRow("2026-08-29", { pending: 2 })], referenceRows: [dimRow("2026-08-10", 100)] });
  const r = await RECOMP.recomputeOliSalesEstimatesWindow({ organizationFingerprint: ORG, accountId: ACC, from: "2026-08-01", to: "2026-08-31", ...h, calculatedAt: "T" });
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

main().then((f) => { if (f) process.exitCode = 1; }).catch((e) => { out("FATAL " + String(e && e.stack ? e.stack : e)); process.exitCode = 1; });
