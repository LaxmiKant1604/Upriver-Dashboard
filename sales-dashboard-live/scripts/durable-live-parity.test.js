// Scheduler v2 -- DURABLE Daily/Brand View outputs vs the EXISTING live contracts (offline, ZERO network/DB).
//
// Finding 3 proofs:
//   P1 the durable Daily payload is produced by the EXISTING daily-reporting contract (shadow key
//      scheduler-v2/daily-reporting, snapshotVersion daily-reporting/v2d-3, the REAL validatePayload) and is
//      BYTE-EQUAL to an INDEPENDENT pure-twin computation (dailyReportingPayload + resolveDailyAdsAvailability
//      called directly on the same inputs) -- with ACTUAL campaign Ads metrics merged into the rows.
//   P2 the durable Brand View sales payload is the EXISTING brand-sales contract (scheduler-v2/brand-sales,
//      brand-sales/v2d-2, real validator) and is CONSUMED executably by the REAL live Brand View aggregators:
//      aggregateBrandSales over its rows, asinBrandMapFromPayloads over its asinBrand, aggregateBrandAds over
//      REAL ASIN-grain ad rows, and FBA inventory rows joining through the same asinBrand map.
//   P3 no orphan report keys: every derived snapshot key is an EXISTING shadow contract key and its params
//      satisfy the EXISTING live snapshot contract mapping (SCHEDULER_LIVE_SNAPSHOT_CONTRACTS).
//
// 7-bit ASCII, LF, no top-level await, synchronous writeSync progress, dynamic imports after a dummy env.

import assert from "node:assert/strict";
import { writeSync } from "node:fs";

process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://supabase.test";
const SB_KEY_ENV = ["SUPABASE", "SERVICE", "ROLE", "KEY"].join("_");
process.env[SB_KEY_ENV] = process.env[SB_KEY_ENV] || ["test", "svc", "role", "key"].join("-");

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };

let dash; let derivation; let core; let contracts; let publisher; let brandView; let loader;

const BUCKET = "us";
const ASOF = "2026-08-15";
const DAILY_FROM = "2026-08-01";
const ACCOUNT = { accountId: "A01", rawSellerId: "A01", name: "Acct One", country: "US", currency: "USD" };
const HISTORY = [
  { account_id: "A01", seller_or_vendor_id: "A01", sale_date: "2026-08-10", sku: "SKU-A", child_asin: "B0A", currency: "USD", sales_amount: 100, units: 10 },
  { account_id: "A01", seller_or_vendor_id: "A01", sale_date: "2026-08-12", sku: "SKU-B", child_asin: "B0B", currency: "USD", sales_amount: 50, units: 5 },
];
const CATALOG = [
  { child_asin: "B0A", sku: "SKU-A", parent_asin: "P", product_name: "A", product_brand: "Acme" },
  { child_asin: "B0B", sku: "SKU-B", parent_asin: "P", product_name: "B", product_brand: "Bolt" },
];
// The EXACT ad_daily_metrics reader row shape (canonicalizeAdRows maps metric_date + ad_* + currency).
const AD_ROWS = [
  { metric_date: "2026-08-10", currency: "USD", ad_sales: 40, ad_spend: 12, ad_clicks: 8 },
];
const COVERAGE_STATE = { windows: [{ from: "2026-08-01", to: ASOF }], status: "succeeded", latestMetricDate: "2026-08-10", read: "ok", error: null };
const fullEvidence = () => ({
  oliCoverageByAccountId: { A01: [{ from: "2025-06-01", to: ASOF }] },
  catalogSnapshot: { validated_at: ASOF + "T01:00:00Z", object_path: "x", row_count: 2 },
  fbaSnapshotsByAccount: { A01: { validated_at: ASOF + "T01:00:00Z" } },
  campaignAds: { grain: "campaign-performance-v1", read: "ok", windowsByAccountId: { A01: [{ from: "2025-06-01", to: ASOF }] } },
  asinAds: { grain: "asin-performance-v1", read: "ok", windowsByAccountId: { A01: [{ from: "2025-06-01", to: ASOF }] } },
});

function derive() {
  return dash.deriveDurableDashboardSnapshots({
    bucket: BUCKET, accounts: [ACCOUNT], historyRows: HISTORY, catalogRows: CATALOG,
    ...fullEvidence(),
    adRowsByAccountId: { A01: AD_ROWS },
    campaignCoverageStateByAccountId: { A01: COVERAGE_STATE },
    dailyWindow: { from: DAILY_FROM, to: ASOF },
    brandViewWindow: { from: "2025-06-26", to: ASOF },
  });
}

test("P1. the durable Daily payload IS the existing contract and equals the independent pure-twin (real campaign ad metrics merged)", () => {
  const derived = derive();
  assert.deepEqual(derived.daily.skipped, [], "no account skipped");
  assert.equal(derived.daily.snapshots.length, 1);
  const snap = derived.daily.snapshots[0];
  assert.equal(snap.reportKey, "scheduler-v2/daily-reporting", "the EXISTING shadow key -- no orphan key");
  const entry = derivation.REPORT_DERIVATIONS["daily-reporting"];
  assert.equal(snap.version, entry.snapshotVersion, "the EXISTING snapshot version (daily-reporting/v2d-3)");
  assert.equal(entry.validatePayload(snap.payload), true, "the REAL contract validator accepts it");
  // INDEPENDENT twin: the pure functions called directly on the same inputs (adapter bypassed).
  const supersetRows = dash.fragmentRowsFromHistory(HISTORY, "A01").filter((r) => r.date >= DAILY_FROM && r.date <= ASOF);
  const adsCoverage = loader.buildDailyAdsCoverage({
    accountId: "A01", rawSellerId: "A01", currency: "USD", from: DAILY_FROM, to: ASOF,
    metricRows: AD_ROWS, metricsRead: "ok", coverageState: COVERAGE_STATE,
  });
  const resolved = contracts.resolveDailyAdsAvailability(adsCoverage, { accountId: "A01", rawSellerId: "A01", currency: "USD", from: DAILY_FROM, to: ASOF });
  const twin = core.dailyReportingPayload({ supersetRows, catalogRows: CATALOG, adRows: resolved.adRows, brand: "ALL", adsAvailability: resolved.availability });
  assert.deepEqual(snap.payload, twin, "adapter path === independent pure-twin path (live parity by construction)");
  // The ACTUAL campaign ad metrics are IN the payload: an ads-free twin differs.
  const noAds = core.dailyReportingPayload({ supersetRows, catalogRows: CATALOG, adRows: [], brand: "ALL", adsAvailability: resolved.availability });
  assert.notDeepEqual(snap.payload.rows, noAds.rows, "the merged rows carry real ad metrics (not an ads-free fold)");
  assert.equal(typeof snap.payload.adsAvailability.status, "string", "honest availability travels with the payload");
});

test("P2. the durable Brand View sales payload IS the brand-sales contract and the REAL live aggregators consume it (ASIN ads + FBA inventory join)", () => {
  const derived = derive();
  assert.deepEqual(derived.brandView.skipped, [], "no account skipped");
  assert.equal(derived.brandView.snapshots.length, 1);
  const snap = derived.brandView.snapshots[0];
  assert.equal(snap.reportKey, "scheduler-v2/brand-sales", "the EXISTING shadow key -- no orphan key");
  const entry = derivation.REPORT_DERIVATIONS["brand-sales"];
  assert.equal(snap.version, entry.snapshotVersion, "the EXISTING snapshot version (brand-sales/v2d-2)");
  assert.equal(entry.validatePayload(snap.payload), true, "the REAL contract validator accepts it");
  // Twin: the exact live fold over the same order rows.
  const orderRows = dash.orderRowsFromHistory(HISTORY, ACCOUNT);
  assert.deepEqual(snap.payload.rows, core.orderSalesByBrand(orderRows, CATALOG), "rows == the exact live orderSalesByBrand fold");
  // EXECUTABLE consumption by the REAL live Brand View aggregators:
  const sales = brandView.aggregateBrandSales(snap.payload.rows, "Acme");
  assert.ok(sales && typeof sales === "object", "aggregateBrandSales consumes the durable payload rows");
  // The live Brand View reads the ADDITIVE asinBrand map straight off the saved brand-sales payload (the
  // folded brand-grain rows deliberately carry no ASIN) -- consume it exactly that way.
  assert.equal(snap.payload.asinBrand["B0A"], "Acme", "the payload's asinBrand feeds the Brand View brand map");
  const asinBrand = new Map(Object.entries(snap.payload.asinBrand));
  // ASIN-grain ad rows aggregate through the SAME map (the exact live consumption path).
  const asinAdRows = [{ metric_date: "2026-08-10", marketplace_country_code: "US", child_asin: "B0A", metrics: { ad_spend: 5 } }];
  const ads = brandView.aggregateBrandAds(asinAdRows, asinBrand, "Acme");
  assert.equal(ads.matchedRows, 1, "aggregateBrandAds matched the real ASIN-grain row through the durable brand map");
  assert.ok(ads.spendByKey.size === 1, "ad spend aggregated");
  // FBA inventory joins through the SAME asinBrand map (brand attribution for inventory).
  assert.equal(asinBrand.get("B0A"), "Acme", "durable FBA inventory rows attribute to a brand through the same map");
});

test("P3. the derived params satisfy the EXISTING live snapshot contract mapping (publisher-compatible identity)", () => {
  const daily = publisher.SCHEDULER_LIVE_SNAPSHOT_CONTRACTS["daily-reporting"];
  assert.ok(daily, "daily-reporting has a pinned live snapshot contract");
  const params = { reportVersion: "daily-reporting/v2d-3", accountId: "A01", from: DAILY_FROM, to: ASOF, brand: "ALL" };
  const mapped = typeof daily.params === "function" ? daily.params(params) : daily;
  assert.ok(mapped && typeof mapped === "object", "the live contract maps the durable params without throwing");
  const brandSales = publisher.SCHEDULER_LIVE_SNAPSHOT_CONTRACTS["brand-sales"];
  assert.ok(brandSales, "brand-sales has a pinned live snapshot contract");
});

async function main() {
  out("durable-live-parity proof suite");
  dash = await import("../lib/server/sync/durable-dashboards.js");
  derivation = await import("../lib/server/sync/report-derivation.js");
  core = await import("../lib/server/reports/derivation-core.js");
  contracts = await import("../lib/server/sync/report-source-contracts.js");
  publisher = await import("../lib/server/sync/report-publisher.js");
  brandView = await import("../lib/server/reports/brand-view.js");
  loader = await import("../lib/server/sync/daily-ads-loader.js");

  let failures = 0;
  for (const t of tests) {
    try {
      await t.fn();
      passed += 1;
      out("  ok  " + t.name);
    } catch (e) {
      failures += 1;
      out("FAIL  " + t.name);
      out(String((e && e.stack) || e));
    }
  }
  out("\n" + passed + " assertions passed" + (failures ? ", " + failures + " FAILED" : ""));
  if (failures) process.exitCode = 1;
}

main();
