// OLI source-correction proof suite (offline, deterministic, ZERO network/DB).
//
// Consolidated cross-cutting proof that Daily Reporting, FBA Plan, Buy Box Loss, Returns Leakage and
// PPC Performance now read ordered sales/units from Order Line Items (item_price_value / quantity,
// currency = item_price_currency) instead of Sales & Traffic, while Sales Movers keeps Sales & Traffic
// (it needs sessions / page views / total_orders that OLI does not carry).
//
// Each test is labelled (a)..(j) against the acceptance items. The derive-level malformed / capped /
// missing fail-closed matrix is exercised in depth by the per-report suites (report-buy-box.test.js,
// report-returns.test.js, report-ppc-performance.test.js, timeout-slicing.test.js); here we add the
// currency-isolation and cross-account fail-closed proofs specific to the OLI correction.

import assert from "node:assert/strict";
import { writeSync } from "node:fs";

import { REPORT_SOURCE_CONTRACTS, reportSourceRequestHashes } from "../lib/server/sync/report-source-contracts.js";
import { SOURCE_CONTRACTS, REPORT_SOURCE_REQUIREMENTS } from "../lib/server/source-contracts.js";
import { deriveReportSnapshot } from "../lib/server/sync/report-derivation.js";
import { assembleSources } from "../lib/server/sync/report-worker.js";
import { addDaysStr, splitDateRangeByDays } from "../lib/server/date-windows.js";
import {
  ppcPerformancePayload,
  buyBoxLossPayload,
  returnsLeakagePayload,
  dailyReportingPayload,
  foldPlanAsinUnits,
} from "../lib/server/reports/derivation-core.js";

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };

const OLI_ID = "89b27535d27c2a94db5ae39af4717f542624ff4df7802fd633e16c78674a1778";
const OLI_SOURCES = new Map(SOURCE_CONTRACTS.map((c) => [c.key, c]));
// The five reports that MUST have moved off Sales & Traffic onto Order Line Items.
const CORRECTED = ["daily-reporting", "fba-plan", "buy-box-loss", "returns-leakage", "ppc-performance"];
// The exact OLI request keys each corrected report now owns.
const OLI_REQUEST_KEYS = {
  "daily-reporting": ["daily-reporting:asin-day-superset"],
  "fba-plan": ["fba-plan:monthly-units", "fba-plan:current-daily-dates"],
  "buy-box-loss": ["buy-box-loss:ordered"],
  "returns-leakage": ["returns-leakage:ordered"],
  "ppc-performance": ["ppc-performance:total-sales"],
};
const contractsFor = (reportKey) => REPORT_SOURCE_CONTRACTS[reportKey] || [];
const byKey = (reportKey, requestKey) => contractsFor(reportKey).find((c) => c.requestKey === requestKey);

/* ---------------------- (a) OLI is the sales/units source ---------------------- */

test("(a) every corrected report's sales/units request uses order-line-items -> the canonical OLI id", () => {
  // The "order-line-items" source key resolves to the ONE canonical OLI DataDoe id.
  assert.equal(OLI_SOURCES.get("order-line-items").ids[0], OLI_ID, "order-line-items resolves to the canonical OLI id");
  for (const rep of CORRECTED) {
    for (const rk of OLI_REQUEST_KEYS[rep]) {
      const c = byKey(rep, rk);
      assert.ok(c, `${rk} must be a declared contract`);
      assert.equal(c.sourceKey, "order-line-items", `${rk} sourceKey must be order-line-items`);
    }
  }
  // REPORT_SOURCE_REQUIREMENTS lists order-line-items for every corrected report.
  for (const rep of CORRECTED) {
    assert.ok((REPORT_SOURCE_REQUIREMENTS[rep] || []).includes("order-line-items"), `${rep} requires order-line-items`);
  }
});

/* ---------------------- (b) none of the five plan Sales & Traffic ---------------------- */

test("(b) no corrected report owns or requires a sales-traffic-asin-date request", () => {
  for (const rep of CORRECTED) {
    for (const c of contractsFor(rep)) {
      assert.notEqual(c.sourceKey, "sales-traffic-asin-date", `${c.requestKey} must NOT read sales-traffic-asin-date`);
    }
    assert.ok(!(REPORT_SOURCE_REQUIREMENTS[rep] || []).includes("sales-traffic-asin-date"), `${rep} must not require sales-traffic-asin-date`);
  }
});

/* ---------------------- (j) Sales Movers is the one legit remaining Sales & Traffic consumer ---------------------- */

test("(j) sales-movers STILL reads sales-traffic-asin-date (sessions/page-views/total_orders)", () => {
  const smKeys = contractsFor("sales-movers").filter((c) => c.sourceKey === "sales-traffic-asin-date").map((c) => c.requestKey);
  assert.ok(smKeys.includes("sales-movers:traffic"), "sales-movers:traffic keeps Sales & Traffic");
  // And Sales & Traffic's declared consumer set is exactly sales-movers now.
  const stContract = SOURCE_CONTRACTS.find((c) => c.key === "sales-traffic-asin-date");
  assert.deepEqual(stContract.consumers, ["sales-movers"], "Sales & Traffic's only remaining consumer is Sales Movers");
});

/* ---------------------- (f) FBA Plan demand = OLI quantity (never Sales & Traffic total_units) ---------------------- */

test("(f) fba-plan demand fold reads OLI quantity (units_sum), never total_units", () => {
  // units_sum alias wins; raw fallback is `quantity` (OLI), never `total_units` (Sales & Traffic).
  const m = foldPlanAsinUnits([
    { child_asin: "A1", quantity: 5 },
    { child_asin: "A1", units_sum: 3 },
    { child_asin: "A2", quantity: 7 },
  ]);
  assert.equal(m.get("A1"), 8, "quantity + units_sum accumulate");
  assert.equal(m.get("A2"), 7);
  // A Sales & Traffic-shaped row (total_units only) contributes ZERO -> proves total_units is not read.
  assert.equal(foldPlanAsinUnits([{ child_asin: "A9", total_units: 999 }]).get("A9"), 0, "total_units is ignored");
});

/* ---------------------- (e) daily brand totals == sum of ASIN-level OLI rows ---------------------- */

test("(e) daily all-brand total equals the sum of the ASIN-level OLI superset rows", () => {
  const superset = [
    { date: "2025-05-01", seller_or_vendor_id: "S1", child_asin: "A1", item_price_currency: "USD", total_sales_sum: 100, total_units_sum: 4 },
    { date: "2025-05-01", seller_or_vendor_id: "S1", child_asin: "A2", item_price_currency: "USD", total_sales_sum: 50, total_units_sum: 2 },
    { date: "2025-05-01", seller_or_vendor_id: "S2", child_asin: "A1", item_price_currency: "USD", total_sales_sum: 30, total_units_sum: 1 },
  ];
  const p = dailyReportingPayload({ supersetRows: superset, catalogRows: [], adRows: [], brand: "ALL" });
  const s1 = p.rows.find((r) => r.date === "2025-05-01" && r.seller_or_vendor_id === "S1");
  assert.equal(s1.total_sales, 150, "S1 sales = 100 + 50 (sum over child_asin)");
  assert.equal(s1.total_units, 6, "S1 units = 4 + 2");
  const s2 = p.rows.find((r) => r.date === "2025-05-01" && r.seller_or_vendor_id === "S2");
  assert.equal(s2.total_sales, 30);
  assert.equal(s2.total_units, 1);
});

/* ---------------------- (c) Buy Box: buybox%/page-views from Profit-by-SKU; sales/units from OLI ---------------------- */

test("(c) buy-box derives a page-view-weighted buybox% + page views from profit-by-sku, sales/units from OLI", () => {
  const p = buyBoxLossPayload({
    accountId: "A1", asOf: "2025-08-10", from: "2025-07-14", windowDays: 28, sliceDays: 7,
    sourceLabel: "Profit by SKU & Date", priceSourceLabel: "FBA Inventory Health",
    // Profit-by-SKU daily rows: ONLY buybox_percentage + page_views (+ dims). No sales/units.
    dailySliceRows: [[
      { date: "2025-07-15", sku: "SKU1", child_asin: "ASIN1", product_name: "P1", product_brand: "Acme", currency: "USD", buybox_percentage: 80, page_views: 50 },
      { date: "2025-07-16", sku: "SKU1", child_asin: "ASIN1", currency: "USD", buybox_percentage: 90, page_views: 150 },
    ]],
    // Order Line Items ordered rows: sales/units.
    orderedSliceRows: [[
      { sku: "SKU1", child_asin: "ASIN1", item_price_currency: "USD", sales_sum: 300, units_sum: 30 },
    ]],
    inventoryRows: [], catalogRows: [],
  });
  const row = p.rows.find((r) => r.sku === "SKU1" && r.currency === "USD");
  assert.ok(row, "SKU1 derives");
  assert.equal(row.buyBoxPct, (80 * 50 + 90 * 150) / (50 + 150), "page-view-weighted buybox% from profit-by-sku");
  assert.equal(row.buyBoxBasis, "page-view weighted");
  assert.equal(row.pageViews, 200, "page views from profit-by-sku");
  assert.equal(row.sales, 300, "sales from Order Line Items");
  assert.equal(row.units, 30, "units from Order Line Items");
});

/* ---------------------- (g) Returns: denominator = OLI ordered units; numerator = Returns record count ---------------------- */

test("(g) returns-leakage rate uses OLI ordered units as denominator and Returns record count as numerator", () => {
  const from = addDaysStr("2025-08-10", -59);
  const ret = returnsLeakagePayload({
    accountId: "A1", asOf: "2025-08-10", from, windowDays: 60,
    returnsSourceLabel: "Returns (FBA & FBM)", moneySourceLabel: "Settlements & P&L Components",
    rateSourceLabel: "Order Line Items", rateSourceLagDays: 0, returnHistoryDays: 60,
    returnRows: [
      { date: "2025-08-01", child_asin: "A1", sku: "S1", amazon_return_reason: "DEFECTIVE", amazon_fulfillment_channel: "FBA", amazon_return_request_status: "Approved", amazon_return_refunded_amount: -5 },
      { date: "2025-08-02", child_asin: "A1", sku: "S1", amazon_return_reason: "TOO_SMALL", amazon_fulfillment_channel: "FBA", amazon_return_request_status: "Approved", amazon_return_refunded_amount: -3 },
    ],
    settlementRows: [],
    orderedRows: [{ child_asin: "A1", item_price_currency: "USD", sales_sum: 500, units_sum: 100 }],
    catalogRows: [],
  });
  const row = ret.rows.find((r) => r.asin === "A1");
  assert.ok(row, "A1 derives (has return records)");
  assert.equal(row.orderedUnits, 100, "ordered units (denominator) from Order Line Items quantity");
  assert.equal(row.returnedUnits, 2, "returned units (numerator) = count of Returns records for the ASIN");
  assert.equal(ret.rateSourceLabel, "Order Line Items");
  assert.equal(ret.rateSourceLagDays, 0, "OLI is near-real-time (no rate lag)");
});

/* ---------------------- (d) PPC TACoS sums OLI sales in the Ads currency; degrades on currency mismatch ---------------------- */

const PPC_DESC = [
  { syncKey: "campaign", label: "Campaign", coverage: "c", defaultDataset: true },
  { syncKey: "asin", label: "ASIN", coverage: "a", defaultDataset: true },
  { syncKey: "targeting", label: "Targeting", coverage: "t", defaultDataset: false },
  { syncKey: "search", label: "Search", coverage: "s", defaultDataset: false },
];
const USD_ADS = [{ source_key: "campaign", metric_date: "2025-08-01", currency: "USD", dimensions: { ad_campaign_name: "C1" }, metrics: { ad_spend: 10, ad_sales: 20, ad_clicks: 5 } }];
const ppcCall = (over = {}) => ppcPerformancePayload({
  accountId: "A1", asOf: "2025-08-10", from: "2025-07-12", windowDays: 30,
  adsSourceDescriptors: PPC_DESC, totalSalesSourceLabel: "Order Line Items", totalSalesLagDays: 0,
  adsRows: USD_ADS, syncStates: [], catalogRows: [], ...over,
});

test("(d) PPC TACoS sums OLI sales that match the single Ads currency", () => {
  const p = ppcCall({ totalSalesRows: [
    { date: "2025-08-01", item_price_currency: "USD", sales_sum: 400 },
    { date: "2025-08-02", item_price_currency: "USD", sales_sum: 100 },
  ] });
  assert.deepEqual(p.currencies, ["USD"], "single Ads currency");
  assert.equal(p.totalSales, 500, "OLI sales summed in the Ads currency");
  assert.equal(p.totalSalesUnavailable, null);
});

test("(d) PPC TACoS DEGRADES (never sums across currencies) when OLI sales are a different currency than Ads", () => {
  const p = ppcCall({ totalSalesRows: [{ date: "2025-08-01", item_price_currency: "CAD", sales_sum: 400 }] });
  assert.equal(p.totalSales, null, "no cross-currency sum");
  assert.ok(/different currency/i.test(p.totalSalesUnavailable), "typed currency-mismatch degrade reason");
  // A MIX (one matching + one mismatching) also degrades rather than partially summing.
  const mix = ppcCall({ totalSalesRows: [
    { date: "2025-08-01", item_price_currency: "USD", sales_sum: 400 },
    { date: "2025-08-02", item_price_currency: "CAD", sales_sum: 100 },
  ] });
  assert.equal(mix.totalSales, null, "a currency mix degrades, never partially sums");
  assert.ok(/different currency/i.test(mix.totalSalesUnavailable));
});

/* ---------------------- (h) cross-currency is fail-closed (never merged) across the OLI reports ---------------------- */

test("(h) daily reporting NEVER merges two currencies for one (date, seller) -> separate rows", () => {
  const p = dailyReportingPayload({ supersetRows: [
    { date: "2025-05-01", seller_or_vendor_id: "S1", child_asin: "A1", item_price_currency: "USD", total_sales_sum: 100, total_units_sum: 4 },
    { date: "2025-05-01", seller_or_vendor_id: "S1", child_asin: "A1", item_price_currency: "CAD", total_sales_sum: 200, total_units_sum: 8 },
  ], catalogRows: [], adRows: [], brand: "ALL" });
  const s1 = p.rows.filter((r) => r.date === "2025-05-01" && r.seller_or_vendor_id === "S1");
  assert.equal(s1.length, 2, "USD and CAD keep separate rows (never summed into one)");
  assert.deepEqual(s1.map((r) => r.currency).sort(), ["CAD", "USD"]);
  assert.deepEqual(s1.map((r) => r.total_sales).sort((a, b) => a - b), [100, 200]);
});

test("(h) buy-box NEVER merges two currencies for one SKU -> a separate row per currency", () => {
  const p = buyBoxLossPayload({
    accountId: "A1", asOf: "2025-08-10", from: "2025-07-14", windowDays: 28, sliceDays: 7,
    sourceLabel: "Profit by SKU & Date", priceSourceLabel: "FBA Inventory Health",
    dailySliceRows: [[
      { date: "2025-07-15", sku: "SKU1", child_asin: "ASIN1", currency: "USD", buybox_percentage: 80, page_views: 10 },
      { date: "2025-07-15", sku: "SKU1", child_asin: "ASIN1", currency: "CAD", buybox_percentage: 70, page_views: 10 },
    ]],
    orderedSliceRows: [[
      { sku: "SKU1", child_asin: "ASIN1", item_price_currency: "USD", sales_sum: 100, units_sum: 10 },
      { sku: "SKU1", child_asin: "ASIN1", item_price_currency: "CAD", sales_sum: 200, units_sum: 20 },
    ]],
    inventoryRows: [], catalogRows: [],
  });
  const sku1 = p.rows.filter((r) => r.sku === "SKU1");
  assert.equal(sku1.length, 2, "one row per currency, never merged");
  assert.deepEqual(sku1.map((r) => r.currency).sort(), ["CAD", "USD"]);
  const usd = sku1.find((r) => r.currency === "USD");
  const cad = sku1.find((r) => r.currency === "CAD");
  assert.deepEqual([usd.sales, usd.units], [100, 10], "USD sales/units isolated");
  assert.deepEqual([cad.sales, cad.units], [200, 20], "CAD sales/units isolated");
});

test("(h) returns money NEVER merges currencies: one settlement REFUND per currency keeps a separate row", () => {
  const from = addDaysStr("2025-08-10", -59);
  const refund = (currency, amount) => ({ child_asin: "A1", sku: "S1", settlement_type: "REFUND", currency, refunded_amount_sum: amount, quantity_sum: -1 });
  const ret = returnsLeakagePayload({
    accountId: "A1", asOf: "2025-08-10", from, windowDays: 60,
    returnsSourceLabel: "Returns (FBA & FBM)", moneySourceLabel: "Settlements & P&L Components",
    rateSourceLabel: "Order Line Items", rateSourceLagDays: 0, returnHistoryDays: 60,
    returnRows: [], settlementRows: [refund("USD", -30), refund("CAD", -15)],
    orderedRows: [{ child_asin: "A1", item_price_currency: "USD", sales_sum: 500, units_sum: 50 }], catalogRows: [],
  });
  const a1 = ret.rows.filter((r) => r.asin === "A1");
  assert.equal(a1.length, 2, "USD and CAD refunds keep a separate row each");
  assert.deepEqual(a1.map((r) => r.currency).sort(), ["CAD", "USD"]);
  assert.deepEqual(ret.currencies, ["CAD", "USD"], "account currencies reported, never combined");
});

/* ---------------------- (h) cross-account OLI fragment fails closed (no partial write) ---------------------- */

let hashSeq = 0;
const frag = (rk, from, to, ids = ["A1"]) => ({ requestKey: rk, requestHash: "h" + (hashSeq += 1), from, to, sellerOrVendorIds: ids });
function buildSources(planned, rowsByHash) {
  const statusByHash = {};
  const loaded = new Map();
  for (const p of planned) {
    statusByHash[p.requestHash] = "succeeded";
    loaded.set(p.requestHash, { rows: rowsByHash[p.requestHash] ?? [] });
  }
  return assembleSources(planned, statusByHash, loaded).sources;
}

test("(h) a CROSS-ACCOUNT returns OLI ordered fragment fails closed (derive-invalid, no payload written)", () => {
  const ASOF = "2025-08-10";
  const FROM = addDaysStr(ASOF, -59);
  const planned = [];
  const rows = {};
  // Returns is sliced NEWEST-FIRST; every other source is one grouped/no-date fragment.
  for (const s of splitDateRangeByDays(FROM, ASOF, 7).reverse()) {
    const f = frag("returns-leakage:returns", s.from, s.to);
    planned.push(f); rows[f.requestHash] = [];
  }
  const se = frag("returns-leakage:settlements", FROM, ASOF); planned.push(se); rows[se.requestHash] = [];
  // The OLI ordered fragment is scoped to ANOTHER seller id -> cross-account.
  const od = frag("returns-leakage:ordered", FROM, ASOF, ["OTHER"]); planned.push(od); rows[od.requestHash] = [];
  const ca = frag("returns-leakage:catalog", null, null); planned.push(ca); rows[ca.requestHash] = [];
  const res = deriveReportSnapshot({
    reportKey: "returns-leakage",
    sources: buildSources(planned, rows),
    context: { to: ASOF, rawSellerId: "A1", accountId: "A1" },
  });
  assert.equal(res.status, "invalid", "a cross-account OLI fragment makes the report invalid");
  assert.ok(!res.payload, "no partial payload is written when a source fails closed");
});

/* ---------------------- (i) one create-export per request_hash (stable + distinct identities) ---------------------- */

test("(i) OLI request identities are deterministic (one export per hash) and distinct per report", () => {
  const slices = [
    { from: "2025-07-14", to: "2025-07-20" }, { from: "2025-07-21", to: "2025-07-27" },
    { from: "2025-07-28", to: "2025-08-03" }, { from: "2025-08-04", to: "2025-08-10" },
  ];
  const bbWin = {
    "buy-box-loss:daily": slices,
    "buy-box-loss:ordered": slices,
    "buy-box-loss:inventory": [{ from: "2025-07-31", to: "2025-08-10" }],
    "buy-box-loss:catalog": [{ from: null, to: null }],
  };
  const resolve = () => reportSourceRequestHashes({ reportKey: "buy-box-loss", apiKey: "k", ids: ["A1"], windowsByRequestKey: bbWin });
  const a = resolve();
  const b = resolve();
  // Identical inputs => identical request identities: the source worker creates ONE export per request_hash.
  assert.deepEqual(a.map((r) => r.requestHash), b.map((r) => r.requestHash), "request identity is deterministic");
  const ordered = a.filter((r) => r.requestKey === "buy-box-loss:ordered");
  assert.equal(ordered.length, 4, "four ordered slices");
  assert.equal(new Set(ordered.map((r) => r.requestHash)).size, 4, "each slice is a distinct export identity (never collapsed)");
  // The Buy Box OLI request must NOT share an identity with the Returns OLI request (different columns/window),
  // so a shared canonical hash can never under-export one report's ordered units.
  const retWin = {
    "returns-leakage:returns": [{ from: "2025-06-12", to: "2025-08-10" }],
    "returns-leakage:settlements": [{ from: "2025-06-12", to: "2025-08-10" }],
    "returns-leakage:ordered": [{ from: "2025-06-12", to: "2025-08-10" }],
    "returns-leakage:catalog": [{ from: null, to: null }],
  };
  const retOrdered = reportSourceRequestHashes({ reportKey: "returns-leakage", apiKey: "k", ids: ["A1"], windowsByRequestKey: retWin }).find((r) => r.requestKey === "returns-leakage:ordered");
  assert.equal(retOrdered.sourceId, ordered[0].sourceId, "same DataDoe source id (Order Line Items)...");
  assert.notEqual(retOrdered.requestHash, ordered[0].requestHash, "...but a distinct request identity");
});

async function main() {
  for (const t of tests) {
    try {
      await t.fn();
      passed += 1;
      out("  ok  " + t.name);
    } catch (err) {
      out("FAIL  " + t.name);
      out(String(err && err.stack ? err.stack : err));
      process.exitCode = 1;
    }
  }
  out("\n" + passed + "/" + tests.length + " tests passed");
  if (passed !== tests.length) process.exitCode = 1;
}

main();
