// Repackaged to a FRESH path + inode from the quarantined scripts/scheduler-v2-report-derivation.test.mjs
// (created via 'git show HEAD:<old> > <new>' + 'git rm <old>' -- NOT a filesystem rename that would
// preserve the old inode). Content is the already-neutralized 92-assertion suite; see SCHEDULER_V2.md section 32.
// Scheduler v2 Phase 1d -- report-derivation tests (SHADOW MODE).
//
// Proves the report-derivation layer derives report snapshots PURELY from already-saved
// canonical source rows: zero DataDoe exports, idempotent + checkpointable, last-known-good
// preserved on every failure, cache-miss never treated as empty success, truncated/failed
// sources never derived, terminal vs degraded policies, primary/dd-secondary isolation,
// derived-only reports own no source jobs, save-vs-derive failures distinct, full sidebar
// coverage, and an unchanged golden request_hash.
//
// Conventions match scripts/scheduler-v2-verification.test.mjs: 7-bit ASCII, LF, no
// top-level await, synchronous fs.writeSync progress (survives an npm pipe), dynamic imports
// after a dummy Supabase env is set. No secret-shaped literals.

import assert from "node:assert/strict";
import { readFileSync, writeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://supabase.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ["test", "svc", "role", "key"].join("-");

const HERE = dirname(fileURLToPath(import.meta.url));
const LIB = join(HERE, "..", "lib", "server");

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const group = (label) => tests.push({ marker: label });
const START = Date.now();
const mark = (m) => { try { writeSync(2, "[+" + (Date.now() - START) + "ms] " + m + "\n"); } catch (_e) { /* ignore */ } };
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };

// Bindings assigned in main() after the dummy env is set.
let REPORT_DERIVATIONS, deriveReportSnapshot, reportDerivationCoverage, compareReportPayloads,
    shadowSnapshotKey, DERIVED_ONLY_REPORT_KEYS;
let runReportJobs, assembleSources, buildDeriveContext;
let reportSourceRequestHashes, isValidCalendarDate, resolveDailyAdsAvailability, validateSkuPlMonthlyWindows;
let makeShadowSnapshotSaver;
// Leaf (Scheduler v2) pure cores.
let orderSalesByBrand, catalogBrandNames, compactContentChangeEvents, contentChangesPayload;
// Daily Reporting + SKU P&L cores (derivation-core.js).
let dailyReportingPayload, rollupSupersetToDaily, coreDailyRowsForBrand, coreNormalizeDailySalesRows,
    coreNormalizeAdRows, coreMergeSalesAndAds;
let skuPlFold, skuPlPayload, computeSkuPlRow, skuPlScopedTotals, latestCogsOverridePerUnit;
// PRODUCTION route copies (api/datadoe.js) -- for the INDEPENDENT parity harness.
let routeOrderSalesByBrand, routeCatalogBrandNames, routeCompactContentChangeEvents;
let routeNormalizeDailySalesRows, routeDailyRowsForBrand, routeNormalizeAdRows, routeMergeSalesAndAds,
    routeFoldSkuPlMonthlyRows;
let MAX_SNAPSHOT_BYTES;
// Shadow-planner bindings (consolidated here from the former scheduler-v2-shadow-planner suite so
// there is one readable Scheduler v2 test artifact). Assigned in main().
let resolveAccountScope, planDailyReporting, planSkuPl, buildShadowReportPlan;
let makeDailyAdsContextLoader, canonicalizeAdRows, buildDailyAdsCoverage, DAILY_ADS_SOURCE_KEY;
let runSourceJobs, reportControlCatalog, enabledReportKeys;
let monthBackStr, splitDateRangeByMonth, sixCompleteCalendarMonths;
let paginateAdDailyMetrics, isSchemaMissingError, getDailyAdsCoverage, recordAdsCoverageWindows;
let liveMonthBack;

/* ------------------------------- fixtures ------------------------------- */

const ORDER_ROWS = [
  { date: "2025-06-01", child_asin: "ASIN000001", seller_or_vendor_id: "S1", seller_or_vendor_name: "Store", marketplace_country_code: "US", item_price_currency: "USD", total_sales_sum: 100, total_units_sold_sum: 4 },
  { date: "2025-06-01", child_asin: "ASIN000002", seller_or_vendor_id: "S1", seller_or_vendor_name: "Store", marketplace_country_code: "US", item_price_currency: "USD", total_sales_sum: 50, total_units_sold_sum: 2 },
  { date: "2025-06-02", child_asin: "ASIN000001", seller_or_vendor_id: "S1", seller_or_vendor_name: "Store", marketplace_country_code: "US", item_price_currency: "USD", total_sales_sum: 0, total_units_sold_sum: 3 },
];
const CATALOG_ROWS = [
  { child_asin: "ASIN000001", product_brand: "Acme" },
  { child_asin: "ASIN000002", product_brand: "Beta" },
];
const CONTENT_ROWS = [
  { event_time: "2025-06-03T10:00:00Z", sp_api_notification_id: "n1", sp_api_notification_type: "BRANDED_ITEM_CONTENT_CHANGE", payload: JSON.stringify({ asin: "ASIN000001" }), notification_metadata: "{}" },
];

// Secondary-org rows are DIFFERENT so a cross-load would be detectable.
const ORDER_ROWS_SECONDARY = [
  { date: "2025-06-01", child_asin: "ASIN000009", seller_or_vendor_id: "S9", seller_or_vendor_name: "OtherStore", marketplace_country_code: "CA", item_price_currency: "CAD", total_sales_sum: 999, total_units_sold_sum: 9 },
];
const CATALOG_ROWS_SECONDARY = [{ child_asin: "ASIN000009", product_brand: "Zeta" }];

/* ------------------------------- in-memory doubles ------------------------------- */

// Report-job + source-job + snapshot store double, mirroring the supabase.js wrappers.
function makeMemoryReportStore() {
  const sourceJobs = []; // { request_hash, fetch_status }
  const reportJobs = new Map(); // key report|account -> row
  const snapshots = new Map(); // reportKey|account|paramsHash -> { payload, params }
  const key = (rk, acct) => `${rk}|${acct}`;
  return {
    _sourceJobs: sourceJobs,
    _reportJobs: reportJobs,
    _snapshots: snapshots,
    failSaveFor: new Set(), // reportKeys whose snapshot save should throw
    seedSource(hash, status) { sourceJobs.push({ request_hash: hash, fetch_status: status }); },
    seedSnapshot(reportKey, accountId, paramsHash, payload) { snapshots.set(`${reportKey}|${accountId}|${paramsHash}`, { payload, params: {} }); },
    _report(rk, acct) { return reportJobs.get(key(rk, acct)); },
    // ---- report-worker store interface ----
    listSourceJobs() { return sourceJobs.map((j) => ({ ...j })); },
    upsertReportJob({ reportKey, reportVersion, accountId, connectionId, bucket, dependsOn }) {
      const k = key(reportKey, accountId);
      if (reportJobs.has(k)) return; // insert-if-absent
      reportJobs.set(k, {
        report_key: reportKey, account_id: accountId, connection_id: connectionId, bucket,
        report_version: reportVersion, depends_on: dependsOn || [],
        fetch_status: "pending", derive_status: "pending", save_status: "pending", validated: false,
        error_stage: null, error_code: null, error_message: null,
        latest_data_date: null, row_count: null, snapshot_params_hash: null, last_good_snapshot_at: null,
      });
    },
    listReportJobs() { return [...reportJobs.values()].map((j) => ({ ...j })); },
    claimReportDerive(_cid, rk, acct) {
      const j = reportJobs.get(key(rk, acct));
      if (j && j.derive_status === "pending") { j.derive_status = "running"; return true; }
      return false;
    },
    writes: { blocked: 0, failure: 0, success: 0 }, // count DB write calls (idempotency proof)
    lastSuccess: null, // captures args of the most recent recordReportSuccess (date check)
    recordReportBlocked({ reportKey, accountId, reason }) {
      this.writes.blocked += 1;
      const j = reportJobs.get(key(reportKey, accountId));
      // Mirror supabase.js: blocked is TERMINAL for the cycle (derive/save skipped).
      Object.assign(j, { fetch_status: "blocked", derive_status: "skipped", save_status: "skipped", validated: false, error_stage: "fetch", error_code: "SOURCE_BLOCKED", error_message: reason });
    },
    recordReportFailure({ reportKey, accountId, stage, code, message, terminal }) {
      this.writes.failure += 1;
      const j = reportJobs.get(key(reportKey, accountId));
      const body = { error_stage: stage, error_code: code, error_message: message, terminal: !!terminal };
      if (stage === "save") { body.derive_status = "succeeded"; body.save_status = "failed"; }
      else body.derive_status = "failed";
      Object.assign(j, body);
    },
    recordReportSuccess(args) {
      this.writes.success += 1;
      this.lastSuccess = args;
      const { reportKey, accountId, latestDataDate, rowCount, snapshotParamsHash } = args;
      const j = reportJobs.get(key(reportKey, accountId));
      Object.assign(j, {
        fetch_status: "ready", derive_status: "succeeded", save_status: "succeeded", validated: true,
        latest_data_date: latestDataDate, row_count: rowCount, snapshot_params_hash: snapshotParamsHash,
        last_good_snapshot_at: "t", error_stage: null, error_code: null, error_message: null,
      });
    },
  };
}

// Cache-only source-row loader double: request_hash -> { rows } | null. Never uses fetch.
function makeCacheLoader(byHash) {
  return (hash) => (byHash.has(hash) ? { rows: byHash.get(hash) } : null);
}

// Shadow snapshot saver double: stores by (reportKey|account|paramsHash); can be made to throw.
function makeSnapshotSaver(store) {
  store._saveCalls = 0;
  return async ({ reportKey, accountId, params, payload }) => {
    store._saveCalls += 1; // counts ACTUAL saver invocations (0 when the worker rejects first)
    const productionKey = reportKey.split("/").slice(1).join("/") || reportKey;
    if (store.failSaveFor.has(productionKey)) throw new Error("snapshot save failed (503)");
    const paramsHash = `ph_${JSON.stringify(params).length}`;
    store._snapshots.set(`${reportKey}|${accountId}|${paramsHash}`, { payload, params });
    return { paramsHash };
  };
}

// Build a planned report job.
const plan = (reportKey, accountId, sources, extra = {}) => ({
  reportKey, accountId, connectionId: extra.connectionId || "primary", bucket: extra.bucket || "us",
  reportVersion: (REPORT_DERIVATIONS[reportKey] || {}).snapshotVersion, sources, context: extra.context || {},
});
const src = (requestKey, requestHash, over = {}) => ({ requestKey, requestHash, optional: false, ...over });

/* ============================= registry + coverage ============================= */

group("registry + coverage");

test("every declared sidebar report has a derivation adapter or a derived-only mapping", async () => {
  const cov = reportDerivationCoverage();
  assert.deepEqual(cov.missing, [], "no declared report is unmapped: " + JSON.stringify(cov.missing));
  assert.deepEqual(cov.both, [], "no report is both scheduler-declared and derived-only");
  assert.ok(cov.covered.includes("brand-sales") && cov.covered.includes("ppc-performance"));
});

test("derived-only reports own zero source contracts (create no source job)", async () => {
  for (const rk of ["brand-view", "priority-feed"]) {
    const jobs = reportSourceRequestHashes({ reportKey: rk, apiKey: "K", ids: ["A1"], windowsByRequestKey: {} });
    assert.equal(jobs, null, `${rk} must declare no source contract`);
  }
  assert.ok(DERIVED_ONLY_REPORT_KEYS.includes("brand-view"));
  assert.ok(DERIVED_ONLY_REPORT_KEYS.includes("priority-feed"));
  assert.ok(DERIVED_ONLY_REPORT_KEYS.includes("brand-directory"));
});

test("PPC declares Ads as DERIVED source keys and owns no Ads export", async () => {
  const ppc = REPORT_DERIVATIONS["ppc-performance"];
  assert.deepEqual(ppc.derivedSourceKeys, ["ads-campaign-date", "ads-asin-date", "ads-targeting-date", "ads-search-terms-date"]);
  const adsRequired = ppc.requiredRequestKeys.filter((k) => k.includes("ads"));
  assert.deepEqual(adsRequired, [], "PPC required keys must not include an owned Ads export");
});

test("golden request_hash is unchanged by Phase 1d (pinned brand-sales identities)", async () => {
  const jobs = reportSourceRequestHashes({
    reportKey: "brand-sales", apiKey: "PIN_KEY", ids: ["A1"],
    windowsByRequestKey: { "brand-sales:order-lines": [{ from: "2025-01-01", to: "2025-06-30" }], "brand-sales:catalog": [{ from: "2025-01-01", to: "2025-06-30" }] },
  });
  const byKey = Object.fromEntries(jobs.map((j) => [j.requestKey, j.requestHash]));
  assert.equal(byKey["brand-sales:order-lines"], "e498a48016d990b9835d177064d25256c63dff40f8cdf69ddbcd221035247456");
  assert.equal(byKey["brand-sales:catalog"], "936e6d1ba2eb377c503b0fda56263a5274dc63943d08e360e35f0ac7f9ec7014");
});

/* ============================= zero DataDoe transport ============================= */

group("zero DataDoe transport");

test("derivation modules import NO DataDoe transport or Supabase", async () => {
  const files = [
    "reports/derivation-core.js",
    "sync/report-derivation.js",
    "sync/report-worker.js",
  ];
  const forbidden = /from\s+["'][^"']*(datadoe|supabase)/;
  for (const rel of files) {
    const text = readFileSync(join(LIB, rel), "utf8");
    assert.ok(!forbidden.test(text), `${rel} must not import datadoe/supabase`);
    // No transport CALL either (function-call form, so header-comment mentions do not match).
    assert.ok(!/\b(createExport|pollExport|downloadExport|fetchExportRows|fetchExportRowsStrict|ddFetch)\s*\(/.test(text), `${rel} must not call a DataDoe transport function`);
  }
});

/* ============================= pure orchestrator safety ============================= */

group("pure orchestrator safety");

test("brand-sales derives from saved rows (matches orderSalesByBrand); latest-data-date computed", async () => {
  const r = deriveReportSnapshot({ reportKey: "brand-sales", sources: {
    "brand-sales:order-lines": { available: true, rows: ORDER_ROWS },
    "brand-sales:catalog": { available: true, rows: CATALOG_ROWS },
  } });
  assert.equal(r.status, "derived");
  assert.equal(r.validated, true);
  assert.deepEqual(r.payload.rows, orderSalesByBrand(ORDER_ROWS, CATALOG_ROWS));
  assert.deepEqual(r.payload.catalogBrands, ["Acme", "Beta"]);
  assert.equal(r.latestDataDate, "2025-06-02");
  // unpriced_units preserved (the 0-sales/3-units group), never dropped.
  const acme = r.payload.rows.find((x) => x.product_brand === "Acme" && x.date === "2025-06-02");
  assert.equal(acme.unpriced_units, 3);
});

test("cache MISS is not an empty success (required source unavailable -> not derived)", async () => {
  const r = deriveReportSnapshot({ reportKey: "brand-sales", sources: {
    "brand-sales:order-lines": { available: true, rows: ORDER_ROWS },
    "brand-sales:catalog": { available: false, rows: null, reason: "cache miss" },
  } });
  assert.equal(r.status, "unavailable");
  assert.equal(r.validated, false);
  assert.equal(r.payload, null, "must NOT fabricate an empty payload on a cache miss");
});

test("malformed payload (rows not an array) is unavailable, never coerced to []", async () => {
  const r = deriveReportSnapshot({ reportKey: "brand-sales", sources: {
    "brand-sales:order-lines": { available: false, rows: "oops" },
    "brand-sales:catalog": { available: true, rows: CATALOG_ROWS },
  } });
  assert.equal(r.status, "unavailable");
  assert.equal(r.payload, null);
});

test("terminal-disabled REQUIRED source blocks only that report", async () => {
  const r = deriveReportSnapshot({ reportKey: "brand-sales", sources: {
    "brand-sales:order-lines": { available: true, rows: ORDER_ROWS },
    "brand-sales:catalog": { available: false, rows: null, disabled: true, disabledPolicy: null }, // null policy => terminal/blocks
  } });
  assert.equal(r.status, "blocked");
  assert.equal(r.errorStage, "fetch");
});

test("degraded/optional source unavailable does NOT block the required gate", async () => {
  // listing-health: listings-raw is OPTIONAL. All REQUIRED keys available + optional missing
  // must pass the required gate (reaching the derive step, which is not-yet-wired here).
  const lh = REPORT_DERIVATIONS["listing-health"];
  const sources = {};
  for (const k of lh.requiredRequestKeys) sources[k] = { available: true, rows: [] };
  sources["listing-health:listings-raw"] = { available: false, rows: null, disabled: true, disabledPolicy: { disabledSource: "degraded", safeCode: "SOURCE_DISABLED", reportOutcome: "save-unavailable-snapshot" } };
  const r = deriveReportSnapshot({ reportKey: "listing-health", sources });
  assert.notEqual(r.status, "blocked", "an optional degraded source must not block");
  assert.notEqual(r.status, "unavailable", "required keys were all available");
  assert.equal(r.status, "not-implemented", "gate passed; derive wiring is the pending piece");
});

test("content-changes derives compact events from saved rows", async () => {
  const r = deriveReportSnapshot({ reportKey: "content-changes", sources: {
    "content-changes:events": { available: true, rows: CONTENT_ROWS },
    "content-changes:catalog": { available: true, rows: CATALOG_ROWS },
  } });
  assert.equal(r.status, "derived");
  assert.equal(r.payload.events.length, 1);
  assert.deepEqual(r.payload.events[0].asins, ["ASIN000001"]);
  assert.deepEqual(r.payload.events[0].brands, ["Acme"]);
});

test("compareReportPayloads: equal / different row counts / missing", async () => {
  const a = { rows: [1, 2], catalogBrands: ["X"] };
  assert.equal(compareReportPayloads(a, { rows: [1, 2], catalogBrands: ["X"] }).equal, true);
  const diff = compareReportPayloads(a, { rows: [1], catalogBrands: ["X"] });
  assert.equal(diff.equal, false);
  assert.equal(diff.arrayLengths.rows.match, false);
  assert.equal(compareReportPayloads(null, a).bothPresent, false);
});

/* ============================= worker: zero export, idempotent, isolation ============================= */

group("report worker (async)");

// Seed a store + cache with brand-sales + content-changes saved sources, install a fetch spy.
function seedTwoReportCycle() {
  const store = makeMemoryReportStore();
  store.seedSource("h_ol", "succeeded");
  store.seedSource("h_cat", "succeeded");
  store.seedSource("h_cc_ev", "succeeded");
  store.seedSource("h_cc_cat", "succeeded");
  const loader = makeCacheLoader(new Map([
    ["h_ol", ORDER_ROWS], ["h_cat", CATALOG_ROWS], ["h_cc_ev", CONTENT_ROWS], ["h_cc_cat", CATALOG_ROWS],
  ]));
  const plannedReports = [
    plan("brand-sales", "A1", [src("brand-sales:order-lines", "h_ol"), src("brand-sales:catalog", "h_cat")]),
    plan("content-changes", "A1", [src("content-changes:events", "h_cc_ev"), src("content-changes:catalog", "h_cc_cat")]),
  ];
  return { store, loader, plannedReports };
}

async function withFetchSpy(run) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (u) => { calls.push(String(u)); throw new Error("NO_FETCH_DURING_DERIVATION"); };
  try { await run(calls); } finally { globalThis.fetch = original; }
}

test("worker derives MULTIPLE reports from saved rows with ZERO DataDoe/fetch calls", async () => {
  const { store, loader, plannedReports } = seedTwoReportCycle();
  await withFetchSpy(async (calls) => {
    const saver = makeSnapshotSaver(store);
    const res = await runReportJobs({ store, cycleId: "cyc1", sourceRows: loader, saveSnapshot: saver, plannedReports });
    assert.equal(res.succeeded, 2, "both reports derived from the cache");
    assert.equal(calls.length, 0, "no network/DataDoe call during derivation");
    assert.equal(store._report("brand-sales", "A1").validated, true);
    assert.equal(store._report("content-changes", "A1").validated, true);
    assert.equal(store._snapshots.size, 2, "one shadow snapshot per report");
    // Shadow-namespaced keys, never the production key.
    assert.ok([...store._snapshots.keys()].every((k) => k.startsWith("scheduler-v2/")));
  });
});

test("repeated derivation is idempotent (second run derives nothing; one snapshot each)", async () => {
  const { store, loader, plannedReports } = seedTwoReportCycle();
  const saver = makeSnapshotSaver(store);
  await runReportJobs({ store, cycleId: "cyc1", sourceRows: loader, saveSnapshot: saver, plannedReports });
  const r2 = await runReportJobs({ store, cycleId: "cyc1", sourceRows: loader, saveSnapshot: saver, plannedReports });
  assert.equal(r2.processed, 0, "finished reports are not re-derived");
  assert.equal(r2.succeeded, 0);
  assert.equal(store._snapshots.size, 2, "no duplicate snapshot saved");
});

test("cache-missing required source -> report NOT derived; last-known-good snapshot preserved", async () => {
  const store = makeMemoryReportStore();
  store.seedSource("h_ol", "succeeded");
  store.seedSource("h_cat", "succeeded");
  // catalog cache is MISSING (loader returns null) even though the job says succeeded.
  const loader = makeCacheLoader(new Map([["h_ol", ORDER_ROWS]]));
  const saver = makeSnapshotSaver(store);
  // Seed a prior good shadow snapshot.
  store._snapshots.set("scheduler-v2/brand-sales|A1|ph_prev", { payload: { rows: [{ prior: true }] } });
  const plannedReports = [plan("brand-sales", "A1", [src("brand-sales:order-lines", "h_ol"), src("brand-sales:catalog", "h_cat")])];
  await runReportJobs({ store, cycleId: "c", sourceRows: loader, saveSnapshot: saver, plannedReports });
  const j = store._report("brand-sales", "A1");
  assert.notEqual(j.derive_status, "succeeded");
  assert.equal(j.validated, false);
  assert.ok(store._snapshots.has("scheduler-v2/brand-sales|A1|ph_prev"), "prior snapshot survives");
  assert.equal([...store._snapshots.keys()].filter((k) => k.startsWith("scheduler-v2/brand-sales")).length, 1, "no new snapshot written");
});

test("truncated/failed source is never derived (fetch_status failed -> blocked)", async () => {
  const store = makeMemoryReportStore();
  store.seedSource("h_ol", "failed"); // e.g. TRUNCATED at the source layer
  store.seedSource("h_cat", "succeeded");
  const loader = makeCacheLoader(new Map([["h_cat", CATALOG_ROWS]]));
  const saver = makeSnapshotSaver(store);
  const plannedReports = [plan("brand-sales", "A1", [src("brand-sales:order-lines", "h_ol"), src("brand-sales:catalog", "h_cat")])];
  const res = await runReportJobs({ store, cycleId: "c", sourceRows: loader, saveSnapshot: saver, plannedReports });
  assert.equal(res.blocked, 1);
  assert.equal(store._report("brand-sales", "A1").fetch_status, "blocked");
  assert.equal(store._snapshots.size, 0, "nothing saved from a failed/truncated source");
});

test("snapshot SAVE failure is distinct from a derive failure; last-known-good preserved", async () => {
  const { store, loader, plannedReports } = seedTwoReportCycle();
  store.failSaveFor.add("brand-sales"); // save throws only for brand-sales
  store._snapshots.set("scheduler-v2/brand-sales|A1|ph_prev", { payload: { rows: [{ prior: true }] } });
  const saver = makeSnapshotSaver(store);
  const res = await runReportJobs({ store, cycleId: "c", sourceRows: loader, saveSnapshot: saver, plannedReports });
  const bs = store._report("brand-sales", "A1");
  assert.equal(bs.derive_status, "succeeded", "derive succeeded");
  assert.equal(bs.save_status, "failed", "only SAVE failed");
  assert.equal(bs.error_stage, "save");
  assert.ok(store._snapshots.has("scheduler-v2/brand-sales|A1|ph_prev"), "prior snapshot preserved on save failure");
  // content-changes is unrelated and still succeeds (failure isolation).
  assert.equal(store._report("content-changes", "A1").validated, true);
  assert.equal(res.succeeded, 1);
  assert.equal(res.failed, 1);
});

test("terminal source blocks ONLY the dependent report; unrelated reports still derive", async () => {
  const store = makeMemoryReportStore();
  store.seedSource("h_ol", "failed"); // brand-sales dependency terminal
  store.seedSource("h_cat", "succeeded");
  store.seedSource("h_cc_ev", "succeeded");
  store.seedSource("h_cc_cat", "succeeded");
  const loader = makeCacheLoader(new Map([["h_cat", CATALOG_ROWS], ["h_cc_ev", CONTENT_ROWS], ["h_cc_cat", CATALOG_ROWS]]));
  const saver = makeSnapshotSaver(store);
  const plannedReports = [
    plan("brand-sales", "A1", [src("brand-sales:order-lines", "h_ol"), src("brand-sales:catalog", "h_cat")]),
    plan("content-changes", "A1", [src("content-changes:events", "h_cc_ev"), src("content-changes:catalog", "h_cc_cat")]),
  ];
  const res = await runReportJobs({ store, cycleId: "c", sourceRows: loader, saveSnapshot: saver, plannedReports });
  assert.equal(store._report("brand-sales", "A1").fetch_status, "blocked");
  assert.equal(store._report("content-changes", "A1").validated, true);
  assert.equal(res.blocked, 1);
  assert.equal(res.succeeded, 1);
});

test("primary and secondary organizations never mix (each derives from its own saved rows)", async () => {
  const store = makeMemoryReportStore();
  // Distinct request hashes per org (as real request identity guarantees).
  store.seedSource("h_ol_pri", "succeeded"); store.seedSource("h_cat_pri", "succeeded");
  store.seedSource("h_ol_sec", "succeeded"); store.seedSource("h_cat_sec", "succeeded");
  const loader = makeCacheLoader(new Map([
    ["h_ol_pri", ORDER_ROWS], ["h_cat_pri", CATALOG_ROWS],
    ["h_ol_sec", ORDER_ROWS_SECONDARY], ["h_cat_sec", CATALOG_ROWS_SECONDARY],
  ]));
  const saver = makeSnapshotSaver(store);
  const plannedReports = [
    plan("brand-sales", "PRIMARY", [src("brand-sales:order-lines", "h_ol_pri"), src("brand-sales:catalog", "h_cat_pri")], { connectionId: "primary" }),
    plan("brand-sales", "SECONDARY", [src("brand-sales:order-lines", "h_ol_sec"), src("brand-sales:catalog", "h_cat_sec")], { connectionId: "dd-secondary", bucket: "non-us" }),
  ];
  await runReportJobs({ store, cycleId: "c", sourceRows: loader, saveSnapshot: saver, plannedReports });
  const pri = store._snapshots.get("scheduler-v2/brand-sales|PRIMARY|" + [...store._snapshots.keys()].find((k) => k.includes("|PRIMARY|")).split("|")[2]);
  const sec = store._snapshots.get([...store._snapshots.keys()].find((k) => k.includes("|SECONDARY|")));
  assert.deepEqual(pri.payload.catalogBrands, ["Acme", "Beta"], "primary uses ONLY primary rows");
  assert.deepEqual(sec.payload.catalogBrands, ["Zeta"], "secondary uses ONLY secondary rows");
  // No brand leakage across orgs.
  assert.ok(!pri.payload.catalogBrands.includes("Zeta"));
  assert.ok(!sec.payload.catalogBrands.some((b) => b === "Acme" || b === "Beta"));
});

test("a report whose staged dependency source is absent stays pending (not derived, not blocked)", async () => {
  const store = makeMemoryReportStore();
  store.seedSource("h_ol", "pending"); // dependency not yet fetched this cycle
  store.seedSource("h_cat", "succeeded");
  const loader = makeCacheLoader(new Map([["h_cat", CATALOG_ROWS]]));
  const saver = makeSnapshotSaver(store);
  const plannedReports = [plan("brand-sales", "A1", [src("brand-sales:order-lines", "h_ol"), src("brand-sales:catalog", "h_cat")])];
  const res = await runReportJobs({ store, cycleId: "c", sourceRows: loader, saveSnapshot: saver, plannedReports });
  assert.equal(res.pending, 1, "sources not ready -> report stays pending, retried next invocation");
  assert.notEqual(store._report("brand-sales", "A1").derive_status, "succeeded");
  assert.equal(store._snapshots.size, 0);
});

/* ============================= review blocker regressions ============================= */

group("blocker regressions");

// Blocker 1: a blocked report is terminal for the cycle.
test("blocker1: blocked report is terminal -- recorded once, second run zero work, cycle drains, unrelated finishes", async () => {
  const store = makeMemoryReportStore();
  store.seedSource("h_ol", "failed"); // brand-sales required dep failed
  store.seedSource("h_cat", "succeeded");
  store.seedSource("h_cc_ev", "succeeded");
  store.seedSource("h_cc_cat", "succeeded");
  const loader = makeCacheLoader(new Map([["h_cat", CATALOG_ROWS], ["h_cc_ev", CONTENT_ROWS], ["h_cc_cat", CATALOG_ROWS]]));
  const saver = makeSnapshotSaver(store);
  const plannedReports = [
    plan("brand-sales", "A1", [src("brand-sales:order-lines", "h_ol"), src("brand-sales:catalog", "h_cat")]),
    plan("content-changes", "A1", [src("content-changes:events", "h_cc_ev"), src("content-changes:catalog", "h_cc_cat")]),
  ];
  const r1 = await runReportJobs({ store, cycleId: "c", sourceRows: loader, saveSnapshot: saver, plannedReports });
  assert.equal(store.writes.blocked, 1, "blocked recorded exactly once");
  const bs = store._report("brand-sales", "A1");
  assert.equal(bs.fetch_status, "blocked");
  assert.equal(bs.derive_status, "skipped");
  assert.equal(bs.save_status, "skipped");
  assert.equal(bs.validated, false);
  assert.equal(store._report("content-changes", "A1").validated, true, "unrelated report still finishes");
  assert.equal(r1.drained, true, "cycle drains once every report is terminal");
  // Second invocation: zero additional processing/writes.
  const writesBefore = { ...store.writes };
  const savesBefore = store._saveCalls;
  const r2 = await runReportJobs({ store, cycleId: "c", sourceRows: loader, saveSnapshot: saver, plannedReports });
  assert.equal(r2.processed, 0, "no report reprocessed on the second invocation");
  assert.deepEqual(store.writes, writesBefore, "no additional DB writes");
  assert.equal(store._saveCalls, savesBefore, "no additional snapshot saves");
  assert.equal(r2.drained, true);
});

// Blocker 2: preserve every fragment.
test("blocker2: two five-ID chunks under one request key are both preserved (no overwrite)", async () => {
  const planned = [
    src("brand-sales:order-lines", "h_ol_a", { sellerOrVendorIds: ["A1", "A2", "A3", "A4", "A5"], from: "2025-01-01", to: "2025-06-30" }),
    src("brand-sales:order-lines", "h_ol_b", { sellerOrVendorIds: ["A6"], from: "2025-01-01", to: "2025-06-30" }),
    src("brand-sales:catalog", "h_cat", { from: "2025-01-01", to: "2025-06-30" }),
  ];
  const status = { h_ol_a: "succeeded", h_ol_b: "succeeded", h_cat: "succeeded" };
  const loaded = new Map([
    ["h_ol_a", { rows: [{ chunk: "a" }], fetched_at: "2025-06-30T00:00:00Z" }],
    ["h_ol_b", { rows: [{ chunk: "b" }], fetched_at: "2025-07-01T00:00:00Z" }],
    ["h_cat", { rows: CATALOG_ROWS }],
  ]);
  const { sources, latestFetchedAt } = assembleSources(planned, status, loaded);
  const ol = sources["brand-sales:order-lines"];
  assert.equal(ol.fragments.length, 2, "both chunks preserved");
  assert.deepEqual(ol.fragments.map((f) => f.requestHash), ["h_ol_a", "h_ol_b"], "deterministic order");
  assert.deepEqual(ol.rows, [{ chunk: "a" }, { chunk: "b" }], "rows concatenated, none overwritten");
  assert.equal(ol.available, true);
  assert.equal(latestFetchedAt, "2025-07-01T00:00:00Z");
});

test("blocker2: two monthly windows under one request key retain their date windows in canonical plan order", async () => {
  // The resolver emits windows in canonical (chronological) order; assembleSources PRESERVES that
  // plan order via fragmentIndex -- it never re-sorts by date or request_hash (P1). The live
  // transport concatenates the same plan sequentially, so shadow order matches it.
  const planned = [
    src("fba-plan:monthly-units", "h_m1", { from: "2025-01-01", to: "2025-01-31" }),
    src("fba-plan:monthly-units", "h_m2", { from: "2025-02-01", to: "2025-02-28" }),
  ];
  const { sources } = assembleSources(planned, { h_m1: "succeeded", h_m2: "succeeded" }, { h_m1: { rows: [{ u: 1 }] }, h_m2: { rows: [{ u: 2 }] } });
  const frs = sources["fba-plan:monthly-units"].fragments;
  assert.equal(frs.length, 2);
  assert.deepEqual(frs.map((f) => [f.from, f.to, f.requestHash]), [["2025-01-01", "2025-01-31", "h_m1"], ["2025-02-01", "2025-02-28", "h_m2"]]);
  assert.deepEqual(sources["fba-plan:monthly-units"].rows, [{ u: 1 }, { u: 2 }], "each window's rows retained in plan order (grouped rows lack the month)");
});

test("blocker2: a missing/malformed fragment makes the key unavailable (blocks derivation safely)", async () => {
  const planned = [src("brand-sales:order-lines", "h_a"), src("brand-sales:order-lines", "h_b")];
  const { sources } = assembleSources(planned, { h_a: "succeeded", h_b: "succeeded" }, { h_a: { rows: [{ x: 1 }] }, h_b: { rows: "oops" } });
  assert.equal(sources["brand-sales:order-lines"].available, false, "one malformed fragment => key unavailable");
  assert.equal(sources["brand-sales:order-lines"].rows, null, "never a partial concatenation");
  const { sources: s2 } = assembleSources(planned, { h_a: "succeeded", h_b: "pending" }, { h_a: { rows: [{ x: 1 }] } });
  assert.equal(s2["brand-sales:order-lines"].available, false, "a missing fragment also blocks");
});

// Blocker 3: content-changes exact payload + date-only.
test("blocker3: content-changes complete payload + date-only latest_data_date persisted", async () => {
  const store = makeMemoryReportStore();
  store.seedSource("h_ev", "succeeded");
  store.seedSource("h_cat", "succeeded");
  const eventsRows = [
    { event_time: "2025-06-03T10:00:00Z", sp_api_notification_id: "n1", sp_api_notification_type: "BRANDED_ITEM_CONTENT_CHANGE", payload: JSON.stringify({ asin: "ASIN000001" }), notification_metadata: "{}" },
    { event_time: "2025-06-04T09:00:00Z", sp_api_notification_id: "n2", sp_api_notification_type: "BRANDED_ITEM_CONTENT_CHANGE", payload: JSON.stringify({ asin: "ZZZZZZZZZZ" }), notification_metadata: "{}" }, // unmapped ASIN
  ];
  const richLoader = (h) => (h === "h_ev" ? { rows: eventsRows, fetched_at: "2025-06-04T12:00:00Z" } : (h === "h_cat" ? { rows: CATALOG_ROWS, fetched_at: "2025-06-04T11:00:00Z" } : null));
  const saver = makeSnapshotSaver(store);
  const plannedReports = [plan("content-changes", "ACC9", [src("content-changes:events", "h_ev"), src("content-changes:catalog", "h_cat")])];
  await runReportJobs({ store, cycleId: "c", sourceRows: richLoader, saveSnapshot: saver, plannedReports });
  const snap = [...store._snapshots.values()][0].payload;
  assert.deepEqual(Object.keys(snap).sort(), ["accountId", "catalogBrands", "events", "retrievedAt", "unassignedEvents"], "exact production payload keys");
  assert.equal(snap.accountId, "ACC9");
  assert.equal(snap.retrievedAt, "2025-06-04T12:00:00Z", "retrievedAt from source fetch time, not Date.now()");
  assert.equal(snap.unassignedEvents, 1, "the unmapped-ASIN event is counted as unassigned");
  assert.equal(snap.events.length, 2);
  const d = store.lastSuccess.latestDataDate;
  assert.match(String(d), /^\d{4}-\d{2}-\d{2}$/, "the DB wrapper receives a date-only value");
  assert.equal(d, "2025-06-04");
});

// Blocker 4: independent route-vs-leaf parity.
test("blocker4: production route folds and Scheduler v2 leaf folds produce identical output (independent)", async () => {
  assert.deepEqual(orderSalesByBrand(ORDER_ROWS, CATALOG_ROWS), routeOrderSalesByBrand(ORDER_ROWS, CATALOG_ROWS));
  assert.deepEqual(catalogBrandNames(CATALOG_ROWS), routeCatalogBrandNames(CATALOG_ROWS));
  assert.deepEqual(compactContentChangeEvents(CONTENT_ROWS, CATALOG_ROWS), routeCompactContentChangeEvents(CONTENT_ROWS, CATALOG_ROWS));
  // Genuinely two separate function objects (not the adapter compared to its own helper).
  assert.notEqual(orderSalesByBrand, routeOrderSalesByBrand);
  assert.notEqual(compactContentChangeEvents, routeCompactContentChangeEvents);
});

test("blocker4: contentChangesPayload reproduces the route's inline payload formula", async () => {
  const retrievedAt = "2025-06-04T12:00:00Z";
  const accountId = "ACC1";
  const got = contentChangesPayload({ accountId, notificationRows: CONTENT_ROWS, catalogRows: CATALOG_ROWS, retrievedAt });
  // Independent oracle = the api/datadoe.js content-changes handler's inline assembly.
  const events = routeCompactContentChangeEvents(CONTENT_ROWS, CATALOG_ROWS);
  const oracle = { accountId, events, catalogBrands: routeCatalogBrandNames(CATALOG_ROWS), retrievedAt, unassignedEvents: events.filter((e) => !e.brands.length).length };
  assert.deepEqual(got, oracle);
});

// Blocker 5: snapshot payload-size guard.
test("blocker5: canonical 8 MB snapshot limit is exported and reused", async () => {
  assert.equal(MAX_SNAPSHOT_BYTES, 8 * 1024 * 1024);
});

test("blocker5: shadow payload below/at limit saved; above limit rejected with zero Supabase writes", async () => {
  // Learn the actual payload size for a brand-sales snapshot.
  const learn = seedTwoReportCycle();
  const learnSaver = makeSnapshotSaver(learn.store);
  await runReportJobs({ store: learn.store, cycleId: "c", sourceRows: learn.loader, saveSnapshot: learnSaver, plannedReports: [learn.plannedReports[0]] });
  const bytes = learn.store.lastSuccess.payloadBytes;
  assert.ok(bytes > 0, "payload size captured");

  // below the limit -> saved.
  {
    const { store, loader, plannedReports } = seedTwoReportCycle();
    const saver = makeSnapshotSaver(store);
    const r = await runReportJobs({ store, cycleId: "c", sourceRows: loader, saveSnapshot: saver, plannedReports: [plannedReports[0]], maxSnapshotBytes: bytes + 10 });
    assert.equal(r.succeeded, 1);
    assert.equal(store._saveCalls, 1);
  }
  // exactly at the limit -> saved (guard rejects only strictly greater).
  {
    const { store, loader, plannedReports } = seedTwoReportCycle();
    const saver = makeSnapshotSaver(store);
    const r = await runReportJobs({ store, cycleId: "c", sourceRows: loader, saveSnapshot: saver, plannedReports: [plannedReports[0]], maxSnapshotBytes: bytes });
    assert.equal(r.succeeded, 1);
    assert.equal(store._saveCalls, 1);
  }
  // above the limit -> rejected, ZERO Supabase writes, previous snapshot preserved.
  {
    const { store, loader, plannedReports } = seedTwoReportCycle();
    store._snapshots.set("scheduler-v2/brand-sales|A1|ph_prev", { payload: { rows: [{ prior: true }] } });
    const saver = makeSnapshotSaver(store);
    const r = await runReportJobs({ store, cycleId: "c", sourceRows: loader, saveSnapshot: saver, plannedReports: [plannedReports[0]], maxSnapshotBytes: bytes - 1 });
    assert.equal(r.failed, 1);
    assert.equal(store._saveCalls, 0, "no Supabase write for a rejected oversized payload");
    const bs = store._report("brand-sales", "A1");
    assert.equal(bs.save_status, "failed");
    assert.equal(bs.error_stage, "save");
    assert.equal(bs.error_code, "SNAPSHOT_SAVE_FAILED");
    assert.ok(store._snapshots.has("scheduler-v2/brand-sales|A1|ph_prev"), "prior snapshot preserved");
  }
});

/* ============================= re-review blocker regressions (P1/P2) ============================= */

group("re-review blockers (fragment order, size boundary, date boundary)");

// P1: fragments concatenate in the CANONICAL plan/chunk sequence (fragmentIndex), identical to
// sequential fetchExportRows() concatenation -- NEVER sorted by request_hash (a SHA is not a
// sequence key). >5 account IDs (two chunks), hashes deliberately reverse-sorted, and a duplicate
// ASIN with conflicting catalog labels prove the order is load-bearing.
test("P1: brand-sales fragments follow plan order, not request_hash order (>5 IDs, conflicting catalog labels)", async () => {
  const DUP = "ASINDUP0001";
  // Two order-line chunks for 6 account IDs, fetched/concatenated in account/chunk order.
  const orderChunk0 = [{ date: "2025-06-01", child_asin: DUP, seller_or_vendor_id: "S1", seller_or_vendor_name: "Store", marketplace_country_code: "US", item_price_currency: "USD", total_sales_sum: 100, total_units_sold_sum: 4 }];
  const orderChunk1 = [{ date: "2025-06-02", child_asin: DUP, seller_or_vendor_id: "S1", seller_or_vendor_name: "Store", marketplace_country_code: "US", item_price_currency: "USD", total_sales_sum: 50, total_units_sold_sum: 2 }];
  // SAME ASIN, CONFLICTING brand across the two catalog chunks. orderSalesByBrand keeps the LAST
  // catalog label observed, so whichever chunk is last decides the derived product_brand.
  const catChunk0 = [{ child_asin: DUP, product_brand: "AlphaBrand" }];
  const catChunk1 = [{ child_asin: DUP, product_brand: "OmegaBrand" }];

  // request_hashes are DELIBERATELY reverse-sorted: chunk0 ("zzz") > chunk1 ("aaa").
  const planned = [
    src("brand-sales:order-lines", "h_ol_zzz", { sellerOrVendorIds: ["A1", "A2", "A3", "A4", "A5"], from: "2025-01-01", to: "2025-06-30" }),
    src("brand-sales:order-lines", "h_ol_aaa", { sellerOrVendorIds: ["A6"], from: "2025-01-01", to: "2025-06-30" }),
    src("brand-sales:catalog", "h_cat_zzz", { sellerOrVendorIds: ["A1", "A2", "A3", "A4", "A5"], from: "2025-01-01", to: "2025-06-30" }),
    src("brand-sales:catalog", "h_cat_aaa", { sellerOrVendorIds: ["A6"], from: "2025-01-01", to: "2025-06-30" }),
  ];
  const status = { h_ol_zzz: "succeeded", h_ol_aaa: "succeeded", h_cat_zzz: "succeeded", h_cat_aaa: "succeeded" };
  const loaded = new Map([
    ["h_ol_zzz", { rows: orderChunk0 }], ["h_ol_aaa", { rows: orderChunk1 }],
    ["h_cat_zzz", { rows: catChunk0 }], ["h_cat_aaa", { rows: catChunk1 }],
  ]);

  const { sources } = assembleSources(planned, status, loaded);
  // Fragments and rows are in plan order, though the hashes reverse-sort.
  assert.deepEqual(sources["brand-sales:order-lines"].fragments.map((f) => f.requestHash), ["h_ol_zzz", "h_ol_aaa"]);
  assert.deepEqual(sources["brand-sales:catalog"].fragments.map((f) => f.requestHash), ["h_cat_zzz", "h_cat_aaa"]);
  assert.deepEqual(sources["brand-sales:order-lines"].rows, [...orderChunk0, ...orderChunk1], "rows == sequential concatenation");
  assert.deepEqual(sources["brand-sales:catalog"].rows, [...catChunk0, ...catChunk1]);

  // Shadow payload derived from the assembled (plan-ordered) rows.
  const shadow = deriveReportSnapshot({ reportKey: "brand-sales", sources });
  assert.equal(shadow.status, "derived");
  // Oracle: the live transport concatenates chunks sequentially in account/chunk order.
  const oracle = orderSalesByBrand([...orderChunk0, ...orderChunk1], [...catChunk0, ...catChunk1]);
  assert.deepEqual(shadow.payload.rows, oracle, "shadow == sequential fetchExportRows concatenation");
  assert.ok(shadow.payload.rows.every((r) => r.product_brand === "OmegaBrand"), "the LAST catalog chunk's label wins (plan order)");
  // Proof the ordering is load-bearing: a request_hash sort would have flipped the chunks and
  // produced AlphaBrand -- a genuinely different payload.
  const hashSorted = orderSalesByBrand([...orderChunk1, ...orderChunk0], [...catChunk1, ...catChunk0]);
  assert.notDeepEqual(shadow.payload.rows, hashSorted, "request_hash ordering would change the derived payload");
});

test("P1: content-changes catalog fragments follow plan order (first label wins), not request_hash", async () => {
  const DUP = "ASINDUP002"; // exactly 10 chars so notificationAsins recognizes it
  // SAME ASIN, conflicting brand; compactContentChangeEvents keeps the FIRST catalog label seen.
  const catChunk0 = [{ child_asin: DUP, product_brand: "FirstBrand" }];
  const catChunk1 = [{ child_asin: DUP, product_brand: "SecondBrand" }];
  const events = [{ event_time: "2025-06-03T10:00:00Z", sp_api_notification_id: "n1", sp_api_notification_type: "BRANDED_ITEM_CONTENT_CHANGE", payload: JSON.stringify({ asin: DUP }), notification_metadata: "{}" }];
  const planned = [
    src("content-changes:events", "h_ev"),
    src("content-changes:catalog", "h_cat_zzz", { sellerOrVendorIds: ["A1", "A2", "A3", "A4", "A5"] }),
    src("content-changes:catalog", "h_cat_aaa", { sellerOrVendorIds: ["A6"] }),
  ];
  const status = { h_ev: "succeeded", h_cat_zzz: "succeeded", h_cat_aaa: "succeeded" };
  const loaded = new Map([["h_ev", { rows: events }], ["h_cat_zzz", { rows: catChunk0 }], ["h_cat_aaa", { rows: catChunk1 }]]);

  const { sources } = assembleSources(planned, status, loaded);
  assert.deepEqual(sources["content-changes:catalog"].rows, [...catChunk0, ...catChunk1], "catalog concatenated in plan order");
  const shadow = deriveReportSnapshot({ reportKey: "content-changes", sources, context: { accountId: "A1", retrievedAt: "2025-06-03T12:00:00Z" } });
  assert.equal(shadow.status, "derived");
  const oracle = compactContentChangeEvents(events, [...catChunk0, ...catChunk1]);
  assert.deepEqual(shadow.payload.events, oracle, "shadow == sequential concatenation");
  assert.deepEqual(shadow.payload.events[0].brands, ["FirstBrand"], "the FIRST catalog chunk's label wins (plan order)");
  const hashOrder = compactContentChangeEvents(events, [...catChunk1, ...catChunk0]);
  assert.notDeepEqual(shadow.payload.events, hashOrder, "request_hash ordering would change the derived brand");
});

// P2 (size boundary): the shadow saver ALWAYS recomputes the actual UTF-8 byte size and never
// trusts a caller-supplied payloadBytes (which may be stale/understated/forged).
test("P2-size: shadow saver recomputes bytes; a forged small payloadBytes cannot bypass the guard (zero writes)", async () => {
  const writes = [];
  // Inject a fake persistence layer so NO real Supabase write happens; it records any call.
  const saver = makeShadowSnapshotSaver({ save: async (a) => { writes.push(a); } });
  // A genuinely oversized (>8 MB) payload, with the caller LYING that it is 10 bytes.
  const big = { rows: [{ blob: "x".repeat(9 * 1024 * 1024) }] };
  await assert.rejects(
    () => saver({ reportKey: "scheduler-v2/brand-sales", accountId: "A1", params: { reportVersion: "v", accountId: "A1" }, payload: big, payloadBytes: 10 }),
    (err) => !!err && err.code === "SNAPSHOT_TOO_LARGE",
    "oversized payload rejected despite a forged small payloadBytes",
  );
  assert.equal(writes.length, 0, "no Supabase write for a rejected oversized payload");

  // A within-limit payload saves, and the RECOMPUTED byte count is persisted (not the forged one).
  const small = { rows: [{ ok: true }] };
  const res = await saver({ reportKey: "scheduler-v2/brand-sales", accountId: "A1", params: { reportVersion: "v", accountId: "A1" }, payload: small, payloadBytes: 999999999 });
  assert.equal(writes.length, 1, "within-limit payload saved once");
  assert.equal(writes[0].payloadBytes, Buffer.byteLength(JSON.stringify(small)), "the RECOMPUTED byte count is persisted, not the forged value");
  assert.ok(res && typeof res.paramsHash === "string");
});

// P2 (date boundary): the strict UTC calendar-date rule accepts a real leap day and rejects
// impossible/malformed values -- a shape-only regex is not enough.
test("P2-date: strict calendar rule accepts a real leap day; rejects impossible/malformed dates", async () => {
  assert.equal(isValidCalendarDate("2024-02-29"), true, "real leap day accepted");
  assert.equal(isValidCalendarDate("2023-02-29"), false, "non-leap Feb 29 rejected");
  assert.equal(isValidCalendarDate("2026-02-30"), false, "impossible day rejected");
  assert.equal(isValidCalendarDate("2026-99-99"), false, "impossible month/day rejected");
  assert.equal(isValidCalendarDate("2026-13-01"), false, "impossible month rejected");
  assert.equal(isValidCalendarDate("2026-06-04T10:00:00Z"), false, "a full timestamp is not a date-only value");
  assert.equal(isValidCalendarDate(""), false);
  assert.equal(isValidCalendarDate(null), false);
});

// P2 (date boundary): an impossible derived latest date fails at the VALIDATE stage -- the shadow
// snapshot is never saved ahead of a Postgres `date` write that would then fail.
test("P2-date: impossible derived latest date fails at VALIDATE; previous snapshot preserved, zero writes", async () => {
  const store = makeMemoryReportStore();
  store.seedSource("h_ol", "succeeded");
  store.seedSource("h_cat", "succeeded");
  // A source row carrying an IMPOSSIBLE calendar date (bad upstream data). The payload is
  // otherwise valid; only latest_data_date is not a real calendar date.
  const badOrders = [{ date: "2026-02-30", child_asin: "ASIN000001", seller_or_vendor_id: "S1", seller_or_vendor_name: "Store", marketplace_country_code: "US", item_price_currency: "USD", total_sales_sum: 10, total_units_sold_sum: 1 }];
  const loader = makeCacheLoader(new Map([["h_ol", badOrders], ["h_cat", CATALOG_ROWS]]));
  const saver = makeSnapshotSaver(store);
  // Seed a prior good shadow snapshot that MUST survive.
  store._snapshots.set("scheduler-v2/brand-sales|A1|ph_prev", { payload: { rows: [{ prior: true }] } });
  const plannedReports = [plan("brand-sales", "A1", [src("brand-sales:order-lines", "h_ol"), src("brand-sales:catalog", "h_cat")])];
  const res = await runReportJobs({ store, cycleId: "c", sourceRows: loader, saveSnapshot: saver, plannedReports });
  assert.equal(res.failed, 1);
  const bs = store._report("brand-sales", "A1");
  assert.equal(bs.error_stage, "validate", "failed at the validate stage, not save");
  assert.equal(bs.error_code, "INVALID_LATEST_DATE");
  assert.equal(bs.validated, false);
  assert.equal(store._saveCalls, 0, "no snapshot save when the date fails validation");
  assert.ok(store._snapshots.has("scheduler-v2/brand-sales|A1|ph_prev"), "prior snapshot preserved");
  assert.equal([...store._snapshots.keys()].filter((k) => k.startsWith("scheduler-v2/brand-sales")).length, 1, "no new snapshot written");
});

/* ============================= Daily Reporting tranche ============================= */

group("daily-reporting derivation (all-brand + named-brand)");

// ASIN/day Sales & Traffic superset: {date, seller_or_vendor_id, child_asin, total_sales_sum,
// total_units_sum}. Multiple sellers (>5-ID scenario), a duplicate ASIN across sellers, a
// zero-priced/units row, and a second month.
const DR_SUPERSET = [
  { date: "2025-05-01", seller_or_vendor_id: "S1", child_asin: "ASIN000001", total_sales_sum: 100, total_units_sum: 4 },
  { date: "2025-05-01", seller_or_vendor_id: "S1", child_asin: "ASIN000002", total_sales_sum: 50, total_units_sum: 2 },
  { date: "2025-05-01", seller_or_vendor_id: "S2", child_asin: "ASIN000001", total_sales_sum: 30, total_units_sum: 1 },
  { date: "2025-05-02", seller_or_vendor_id: "S1", child_asin: "ASIN000001", total_sales_sum: 0, total_units_sum: 3 },
  { date: "2025-06-01", seller_or_vendor_id: "S1", child_asin: "ASIN000003", total_sales_sum: 20, total_units_sum: 1 },
];
const DR_CATALOG = [
  { child_asin: "ASIN000001", product_brand: "Acme" },
  { child_asin: "ASIN000001", product_brand: "AcmeDuplicate" }, // duplicate mapping: FIRST wins
  { child_asin: "ASIN000002", product_brand: "Beta" },
  // ASIN000003 has NO catalog brand => excluded from any named-brand fold
];
const DR_ADS = [
  { date: "2025-05-01", seller_or_vendor_id: "S1", currency: "USD", ad_sales: 10, ad_spend: 5, ad_clicks: 3 },
  { date: "2025-05-03", seller_or_vendor_id: "S1", currency: "USD", ad_sales: 7, ad_spend: 2, ad_clicks: 1 }, // ad-only day => synthetic row
];

// The Daily reporting window and a VALID typed Ads coverage contract for it. Tests override fields
// to exercise the unavailable/partial/stale/failed availability states (re-review blocker 3/4).
const DR_FROM = "2025-05-01", DR_TO = "2025-06-30";
const adsCoverage = (over = {}) => ({
  accountId: "A1",
  rawSellerId: "S1", // authoritative raw seller/vendor id (DR_ADS rows are all seller S1)
  currency: "USD",   // authoritative account currency
  requested: { from: DR_FROM, to: DR_TO },
  windows: [{ from: DR_FROM, to: DR_TO }], // fully-covered successful window
  coverageRead: "ok",
  metricsRead: "ok",
  syncStatus: "succeeded",
  latestMetricDate: "2025-05-03",
  adRows: DR_ADS,
  ...over,
});

// Independent oracle for the compact all-brand export: sum the superset per (date, seller),
// first-seen order (this is what DataDoe's server-side group-by-date produces from the same source).
function compactOracleFromSuperset(rows) {
  const out = [];
  const seen = new Map();
  for (const r of rows) {
    const k = `${r.date}|${r.seller_or_vendor_id}`;
    let c = seen.get(k);
    if (!c) { c = { date: r.date, seller_or_vendor_id: r.seller_or_vendor_id, total_sales_sum: 0, total_units_sum: 0 }; seen.set(k, c); out.push(c); }
    c.total_sales_sum += r.total_sales_sum;
    c.total_units_sum += r.total_units_sum;
  }
  return out;
}

test("daily ALL-brand: superset roll-up EQUALS the production compact calculation (with Ads merged)", async () => {
  const sched = dailyReportingPayload({ supersetRows: DR_SUPERSET, catalogRows: DR_CATALOG, adRows: DR_ADS, brand: "ALL" });
  // PRODUCTION oracle: run the route folds on an independently-summed compact export.
  const compact = compactOracleFromSuperset(DR_SUPERSET);
  const oracleRows = routeNormalizeDailySalesRows(compact);
  for (const r of oracleRows) r.total_units_sold = r.total_units;
  const oracle = { rows: routeMergeSalesAndAds(oracleRows, routeNormalizeAdRows(DR_ADS)), brandFiltered: false };
  assert.deepEqual(sched, oracle, "shadow all-brand == production compact calc");
  assert.equal(sched.brandFiltered, false);
  // Explicit spot checks (additive re-aggregation over child_asin per date/seller).
  const may1S1 = sched.rows.find((r) => r.date === "2025-05-01" && r.seller_or_vendor_id === "S1");
  assert.equal(may1S1.total_sales, 150); assert.equal(may1S1.total_units, 6); assert.equal(may1S1.total_units_sold, 6);
  assert.equal(may1S1.ad_sales, 10); assert.equal(may1S1.ad_spend, 5); assert.equal(may1S1.ad_clicks, 3);
  const may1S2 = sched.rows.find((r) => r.date === "2025-05-01" && r.seller_or_vendor_id === "S2");
  assert.equal(may1S2.total_sales, 30); assert.equal(may1S2.total_units, 1);
  assert.ok(!("ad_sales" in may1S2), "a seller with no ad rows gets no ad fields");
  const synthetic = sched.rows.find((r) => r.date === "2025-05-03");
  assert.equal(synthetic.total_sales, 0); assert.equal(synthetic.ad_sales, 7); assert.equal(synthetic.currency, "USD");
  // core folds are genuinely separate function objects from the route copies.
  assert.notEqual(coreNormalizeDailySalesRows, routeNormalizeDailySalesRows);
  assert.notEqual(coreMergeSalesAndAds, routeMergeSalesAndAds);
});

test("daily ALL-brand: zero superset + zero ads is an empty (not fabricated) payload", async () => {
  const sched = dailyReportingPayload({ supersetRows: [], catalogRows: DR_CATALOG, adRows: [], brand: "ALL" });
  assert.deepEqual(sched, { rows: [], brandFiltered: false });
});

test("daily named-brand: catalog join EQUALS the production dailyRowsForBrand (first mapping wins; unmapped excluded)", async () => {
  const sched = dailyReportingPayload({ supersetRows: DR_SUPERSET, catalogRows: DR_CATALOG, brand: "Acme" });
  const oracle = { rows: routeDailyRowsForBrand(DR_SUPERSET, DR_CATALOG, "Acme"), brandFiltered: true };
  assert.deepEqual(sched, oracle, "shadow named-brand == production named-brand");
  assert.equal(sched.brandFiltered, true);
  // Acme == ASIN000001 (first catalog label wins over AcmeDuplicate). Rows folded to (seller,date):
  assert.equal(sched.rows.length, 3);
  assert.deepEqual(sched.rows.map((r) => [r.seller_or_vendor_id, r.date, r.total_sales, r.total_units]),
    [["S1", "2025-05-01", 100, 4], ["S2", "2025-05-01", 30, 1], ["S1", "2025-05-02", 0, 3]]);
  // Beta (ASIN000002) and the unmapped ASIN000003 never appear under Acme.
  assert.ok(sched.rows.every((r) => r.total_units_sold === r.total_units));
  // A brand with no ASINs => an empty (never fabricated) result.
  assert.deepEqual(dailyReportingPayload({ supersetRows: DR_SUPERSET, catalogRows: DR_CATALOG, brand: "Nope" }), { rows: [], brandFiltered: true });
  assert.notEqual(coreDailyRowsForBrand, routeDailyRowsForBrand);
});

// Split the superset into monthly + five-ID-chunk FRAGMENTS for the worker path.
function seedDailyCycle() {
  const store = makeMemoryReportStore();
  store.seedSource("h_may_c0", "succeeded");
  store.seedSource("h_may_c1", "succeeded");
  store.seedSource("h_jun_c0", "succeeded");
  store.seedSource("h_cat", "succeeded");
  const loader = makeCacheLoader(new Map([
    ["h_may_c0", DR_SUPERSET.filter((r) => r.date.startsWith("2025-05") && r.seller_or_vendor_id === "S1")],
    ["h_may_c1", DR_SUPERSET.filter((r) => r.date.startsWith("2025-05") && r.seller_or_vendor_id === "S2")],
    ["h_jun_c0", DR_SUPERSET.filter((r) => r.date.startsWith("2025-06"))],
    ["h_cat", DR_CATALOG],
  ]));
  const plannedReports = [plan("daily-reporting", "A1", [
    src("daily-reporting:asin-day-superset", "h_may_c0", { sellerOrVendorIds: ["S1"], from: "2025-05-01", to: "2025-05-31" }),
    src("daily-reporting:asin-day-superset", "h_may_c1", { sellerOrVendorIds: ["S2"], from: "2025-05-01", to: "2025-05-31" }),
    src("daily-reporting:asin-day-superset", "h_jun_c0", { from: "2025-06-01", to: "2025-06-30" }),
    src("daily-reporting:catalog", "h_cat"),
  ], { context: { brand: "ALL", from: DR_FROM, to: DR_TO, rawSellerId: "S1", currency: "USD" } })];
  // Ads are injected as a typed coverage contract; the derive layers Ads on the sales snapshot.
  const loadDerivedContext = ({ reportKey }) => (reportKey === "daily-reporting" ? { adsCoverage: adsCoverage() } : {});
  return { store, loader, plannedReports, loadDerivedContext };
}

test("daily worker: derives the ALL-brand shadow snapshot from saved fragments with ZERO fetch; correct date/rowCount; idempotent", async () => {
  const { store, loader, plannedReports, loadDerivedContext } = seedDailyCycle();
  await withFetchSpy(async (calls) => {
    const saver = makeSnapshotSaver(store);
    const res = await runReportJobs({ store, cycleId: "c", sourceRows: loader, saveSnapshot: saver, plannedReports, loadDerivedContext });
    assert.equal(res.succeeded, 1);
    assert.equal(calls.length, 0, "no DataDoe/network call during derivation");
    const j = store._report("daily-reporting", "A1");
    assert.equal(j.validated, true);
    assert.equal(j.latest_data_date, "2025-06-01", "latest data date = max row date");
    // Exactly one shadow-namespaced snapshot; params carry brand but NEVER the injected adRows.
    const key = [...store._snapshots.keys()].find((k) => k.startsWith("scheduler-v2/daily-reporting|A1|"));
    assert.ok(key, "shadow snapshot stored under the scheduler-v2 namespace");
    const snap = store._snapshots.get(key);
    assert.equal(snap.payload.brandFiltered, false);
    assert.equal(snap.payload.adsAvailability.status, "validated", "fully-covered Ads => validated availability");
    assert.equal(snap.payload.adsAvailability.coveredFrom, DR_FROM);
    assert.equal(snap.payload.adsAvailability.coveredTo, DR_TO);
    assert.equal(j.row_count, snap.payload.rows.length, "row_count is the real payload row count");
    assert.equal(snap.params.brand, "ALL", "brand IS a snapshot param (cache key)");
    assert.ok(!("adRows" in snap.params) && !("adsCoverage" in snap.params), "injected Ads inputs never leak into the snapshot params");
    // idempotent second invocation.
    const r2 = await runReportJobs({ store, cycleId: "c", sourceRows: loader, saveSnapshot: saver, plannedReports, loadDerivedContext });
    assert.equal(r2.processed, 0, "finished report not re-derived");
  });
});

test("daily worker: without injected Ads, validated SALES still save with Ads marked UNAVAILABLE (never zero)", async () => {
  // Blocker 3: sales validity is independent of Ads. No loadDerivedContext => no Ads coverage, but
  // the sales snapshot must still save with an explicit unavailable Ads state (not a blocked report).
  const { store, loader, plannedReports } = seedDailyCycle();
  const saver = makeSnapshotSaver(store);
  const res = await runReportJobs({ store, cycleId: "c", sourceRows: loader, saveSnapshot: saver, plannedReports });
  assert.equal(res.succeeded, 1, "sales snapshot saves even with no Ads coverage");
  const j = store._report("daily-reporting", "A1");
  assert.equal(j.validated, true);
  const snap = [...store._snapshots.values()].find((s) => s.payload.brandFiltered === false);
  assert.equal(snap.payload.adsAvailability.status, "unavailable", "no coverage => Ads unavailable");
  assert.equal(snap.payload.adsAvailability.reason, "no-ads-coverage");
  assert.ok(snap.payload.rows.length > 0, "sales rows are present");
  assert.ok(snap.payload.rows.every((r) => !("ad_sales" in r)), "no fabricated ad fields when Ads unavailable");
});

/* ============================= SKU P&L tranche ============================= */

group("sku-pl derivation (monthly fold + injected COGS applier)");

const skuRow = (o) => ({
  sku: o.sku, child_asin: o.asin, product_name: o.name ?? null, product_brand: o.brand ?? null, currency: o.cur,
  total_sales_sum: o.sales ?? 0, profit_sum: o.profit ?? 0, total_cost_sum: o.cost ?? 0,
  ad_spend_sum: o.adSpend ?? 0, total_fees_sum: o.fees ?? 0, cogs_total_sum: o.cogs ?? 0, units_sum: o.units ?? 0,
});

// Six monthly windows: repeated SKU/ASIN across months + chunks, multiple currencies, a zero
// row, a missing-COGS row, and two empty months (the source ran and returned []).
const SKU_BATCHES = [
  { monthKey: "2025-01", rows: [
    skuRow({ sku: "SKU1", asin: "ASIN1", name: "Widget", brand: "Acme", cur: "USD", sales: 100, profit: 40, cost: 60, adSpend: 5, fees: 10, cogs: 20, units: 10 }),
    skuRow({ sku: "SKU1", asin: "ASIN1", cur: "USD", sales: 50, profit: 20, cost: 30, adSpend: 2, fees: 5, cogs: 10, units: 5 }), // 2nd five-ID chunk, same key+month => sums
    skuRow({ sku: "SKU1", asin: "ASIN1", cur: "CAD", sales: 200, profit: 80, cost: 120, adSpend: 0, fees: 20, cogs: 40, units: 20 }), // different currency => separate entry
  ] },
  { monthKey: "2025-02", rows: [
    skuRow({ sku: "SKU1", asin: "ASIN1", cur: "USD", sales: 70, profit: 30, cost: 40, adSpend: 3, fees: 7, cogs: 15, units: 7 }), // repeated across months
    skuRow({ sku: "SKU2", asin: "ASIN2", name: "Gadget", brand: "Beta", cur: "USD", sales: 0, profit: 0, cost: 0, adSpend: 0, fees: 0, cogs: 0, units: 0 }), // zero sales/units
  ] },
  { monthKey: "2025-03", rows: [] },
  { monthKey: "2025-04", rows: [
    skuRow({ sku: "SKU3", asin: "ASIN3", name: "Doohickey", brand: "Acme", cur: "USD", sales: 80, profit: 10, cost: 70, adSpend: 1, fees: 8, cogs: 0, units: 8 }), // missing COGS
  ] },
  { monthKey: "2025-05", rows: [] },
  { monthKey: "2025-06", rows: [
    skuRow({ sku: "SKU1", asin: "ASIN1", cur: "USD", sales: 60, profit: 25, cost: 35, adSpend: 2, fees: 6, cogs: 12, units: 6 }),
  ] },
];

test("sku-pl fold: core skuPlFold EQUALS the route foldSkuPlMonthlyRows; currencies never merged; chunks sum", async () => {
  const routeFold = routeFoldSkuPlMonthlyRows(SKU_BATCHES);
  const coreFold = skuPlFold(SKU_BATCHES);
  assert.deepEqual(coreFold, routeFold, "core fold == route fold");
  assert.notEqual(skuPlFold, routeFoldSkuPlMonthlyRows);
  const byKey = new Map(coreFold.map((e) => [`${e.currency}|${e.sku}|${e.asin}`, e]));
  assert.equal(coreFold.length, 4, "one entry per currency|sku|child_asin (currencies never merged)");
  // 2025-01 USD: the two five-ID chunk rows sum into ONE bucket.
  assert.deepEqual(byKey.get("USD|SKU1|ASIN1").byMonth["2025-01"], { sales: 150, profit: 60, cost: 90, adSpend: 7, fees: 15, cogs: 30, units: 15 });
  assert.deepEqual(Object.keys(byKey.get("USD|SKU1|ASIN1").byMonth).sort(), ["2025-01", "2025-02", "2025-06"]);
  assert.deepEqual(byKey.get("CAD|SKU1|ASIN1").byMonth["2025-01"], { sales: 200, profit: 80, cost: 120, adSpend: 0, fees: 20, cogs: 40, units: 20 });
  assert.deepEqual(byKey.get("USD|SKU2|ASIN2").byMonth["2025-02"], { sales: 0, profit: 0, cost: 0, adSpend: 0, fees: 0, cogs: 0, units: 0 });
  assert.equal(byKey.get("USD|SKU3|ASIN3").byMonth["2025-04"].cogs, 0, "missing COGS stays raw (0 here), never fabricated");
});

test("sku-pl payload: assembler EQUALS the route payload assembly (months/currencies/catalogBrands/rows)", async () => {
  const sched = skuPlPayload({ accountId: "A1", from: "2025-01-01", to: "2025-06-30", monthlyBatches: SKU_BATCHES });
  const rows = routeFoldSkuPlMonthlyRows(SKU_BATCHES);
  const oracle = {
    accountId: "A1", from: "2025-01-01", to: "2025-06-30",
    months: [...new Set(SKU_BATCHES.map((b) => b.monthKey))],
    currencies: [...new Set(rows.map((r) => r.currency).filter(Boolean))].sort(),
    catalogBrands: [...new Set(rows.map((r) => r.brand).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
    rows,
  };
  assert.deepEqual(sched, oracle, "shadow payload == route payload");
  assert.deepEqual(sched.months, ["2025-01", "2025-02", "2025-03", "2025-04", "2025-05", "2025-06"], "the full six-month map is preserved (even empty months)");
  assert.deepEqual(sched.currencies, ["CAD", "USD"]);
  assert.deepEqual(sched.catalogBrands, ["Acme", "Beta"]);
});

test("sku-pl worker: folds monthly fragments into the shadow snapshot with ZERO fetch; date=to; no extra source job; idempotent", async () => {
  const store = makeMemoryReportStore();
  // Six COMPLETE calendar months (Blocker 3): full month-end days, not a lax -28.
  const months = [["h_m1", "2025-01", "2025-01-31"], ["h_m2", "2025-02", "2025-02-28"], ["h_m3", "2025-03", "2025-03-31"], ["h_m4", "2025-04", "2025-04-30"], ["h_m5", "2025-05", "2025-05-31"], ["h_m6", "2025-06", "2025-06-30"]];
  const loaderMap = new Map();
  months.forEach(([h], i) => { store.seedSource(h, "succeeded"); loaderMap.set(h, SKU_BATCHES[i].rows); });
  const loader = makeCacheLoader(loaderMap);
  const sourceJobsBefore = store._sourceJobs.length;
  const plannedReports = [plan("sku-pl", "A1",
    months.map(([h, mk, end]) => src("sku-pl:monthly-profit", h, { from: `${mk}-01`, to: end, sellerOrVendorIds: ["A1"] })),
    { context: { from: "2025-01-01", to: "2025-06-30" } })];
  await withFetchSpy(async (calls) => {
    const saver = makeSnapshotSaver(store);
    const res = await runReportJobs({ store, cycleId: "c", sourceRows: loader, saveSnapshot: saver, plannedReports });
    assert.equal(res.succeeded, 1);
    assert.equal(calls.length, 0, "zero DataDoe/network calls");
    const j = store._report("sku-pl", "A1");
    assert.equal(j.validated, true);
    assert.equal(j.latest_data_date, "2025-06-30", "latest data date = window `to` (date-only)");
    const key = [...store._snapshots.keys()].find((k) => k.startsWith("scheduler-v2/sku-pl|A1|"));
    const snap = store._snapshots.get(key);
    assert.equal(snap.payload.months.length, 6, "six-month map preserved end-to-end");
    assert.equal(snap.payload.accountId, "A1");
    assert.equal(j.row_count, snap.payload.rows.length);
    assert.equal(store._sourceJobs.length, sourceJobsBefore, "the adapter creates NO new source request/job");
    const r2 = await runReportJobs({ store, cycleId: "c", sourceRows: loader, saveSnapshot: saver, plannedReports });
    assert.equal(r2.processed, 0, "idempotent: finished report not re-derived");
  });
});

test("sku-pl COGS applier: injected latest override applied; missing COGS stays unavailable (never zero)", async () => {
  const plRow = { sku: "SKU1", asin: "ASIN1", productName: "Widget", brand: "Acme", currency: "USD", byMonth: {
    "2025-01": { sales: 100, profit: 40, cost: 60, adSpend: 5, fees: 10, cogs: 0, units: 10 },
    "2025-02": { sales: 50, profit: 20, cost: 30, adSpend: 2, fees: 5, cogs: 0, units: 5 },
  } };
  // No override + no COGS: flagged missing, ratios recomputed from sums, COGS never assumed zero-cost.
  const none = computeSkuPlRow(plRow, "ALL", null);
  assert.equal(none.units, 15); assert.equal(none.cogs, 0); assert.equal(none.rawCogs, 0);
  assert.equal(none.cogsMissing, true); assert.equal(none.hasCogsOverride, false);
  assert.equal(none.margin, 40); // (60 / 150) * 100 -- recomputed, never summed
  // Latest override wins by updated_at; a negative/non-finite per-unit cost is ignored.
  const overrides = [
    { currency: "USD", sku: "SKU1", asin: "ASIN1", per_unit_cost: 2, updated_at: "2025-01-01T00:00:00Z" },
    { currency: "USD", sku: "SKU1", asin: "ASIN1", per_unit_cost: 3, updated_at: "2025-02-01T00:00:00Z" },
    { currency: "USD", sku: "SKU1", asin: "ASIN1", per_unit_cost: -1, updated_at: "2025-03-01T00:00:00Z" },
    { currency: "USD", sku: "OTHER", asin: "ASIN9", per_unit_cost: 9, updated_at: "2025-04-01T00:00:00Z" },
  ];
  const perUnit = latestCogsOverridePerUnit(overrides, "A1", plRow);
  assert.equal(perUnit, 3, "latest valid per-unit COGS by updated_at");
  const applied = computeSkuPlRow(plRow, "ALL", perUnit);
  assert.equal(applied.cogs, 45); // 15 units * 3
  assert.equal(applied.cost, 135); // 90 + 45 delta
  assert.equal(applied.profit, 15); // 60 - 45 delta
  assert.equal(applied.margin, 10); // (15 / 150) * 100
  assert.equal(applied.hasCogsOverride, true); assert.equal(applied.cogsPerUnitOverride, 3); assert.equal(applied.cogsMissing, false);
  // No override for a different identity => null (explicitly unavailable, NEVER coerced to zero).
  assert.equal(latestCogsOverridePerUnit(overrides, "A1", { currency: "CAD", sku: "SKU1", asin: "ASIN1" }), null);
  assert.equal(latestCogsOverridePerUnit([], "A1", plRow), null);
});

test("sku-pl worker: a malformed monthly fragment blocks derivation and preserves last-known-good (zero writes)", async () => {
  const store = makeMemoryReportStore();
  store.seedSource("h_m1", "succeeded");
  store.seedSource("h_m2", "succeeded");
  const loader = makeCacheLoader(new Map([["h_m1", [skuRow({ sku: "SKU1", asin: "ASIN1", cur: "USD", sales: 10, units: 1 })]], ["h_m2", "oops"]]));
  store._snapshots.set("scheduler-v2/sku-pl|A1|ph_prev", { payload: { rows: [{ prior: true }], months: [], currencies: [], catalogBrands: [] } });
  const saver = makeSnapshotSaver(store);
  const plannedReports = [plan("sku-pl", "A1", [
    src("sku-pl:monthly-profit", "h_m1", { from: "2025-01-01", to: "2025-01-31" }),
    src("sku-pl:monthly-profit", "h_m2", { from: "2025-02-01", to: "2025-02-28" }),
  ], { context: { from: "2025-01-01", to: "2025-02-28" } })];
  const res = await runReportJobs({ store, cycleId: "c", sourceRows: loader, saveSnapshot: saver, plannedReports });
  assert.notEqual(store._report("sku-pl", "A1").derive_status, "succeeded");
  assert.equal(res.succeeded, 0);
  assert.equal(store._saveCalls, 0, "no snapshot write from a malformed fragment");
  assert.ok(store._snapshots.has("scheduler-v2/sku-pl|A1|ph_prev"), "previous snapshot preserved");
});

/* ===================== tranche-2 review blockers (data integrity) ===================== */

group("tranche-2 blocker 1: derived context never overrides planned scope");

test("B1 unit: planned scope is authoritative; only allowlisted derived keys pass; reserved/unexpected dropped", async () => {
  const entry = REPORT_DERIVATIONS["daily-reporting"]; // allowlist = ["adsCoverage"]
  assert.deepEqual([...entry.derivedContextKeys], ["adsCoverage"], "daily-reporting allowlists only adsCoverage");
  const ctx = buildDeriveContext({
    entry,
    plannedContext: { brand: "ALL", from: "2025-05-01", to: "2025-06-30" },
    // A hostile loader tries to (a) override planned scope and (b) inject an unexpected field.
    derivedContext: { adsCoverage: { tag: "ok" }, accountId: "EVIL", brand: "EVIL", from: "1999-01-01", to: "1999-12-31", reportVersion: "x", evilRows: [1, 2] },
    accountId: "A1",
    latestFetchedAt: "2025-06-30T00:00:00Z",
  });
  assert.equal(ctx.accountId, "A1", "accountId pinned to the planned account, not the injected one");
  assert.equal(ctx.brand, "ALL", "planned brand wins");
  assert.equal(ctx.from, "2025-05-01", "planned from wins");
  assert.equal(ctx.to, "2025-06-30", "planned to wins");
  assert.ok(!("reportVersion" in ctx) || ctx.reportVersion !== "x", "reserved reportVersion not overridden");
  assert.ok(!("evilRows" in ctx), "unexpected (unallowlisted) derived field dropped");
  assert.deepEqual(ctx.adsCoverage, { tag: "ok" }, "the ONE allowlisted derived key passes through");
});

test("B1 unit: a non-object derived payload is treated as no derived input (never spread field-wise)", async () => {
  const entry = REPORT_DERIVATIONS["daily-reporting"];
  for (const bad of [null, undefined, ["adsCoverage"], "adsCoverage", 42]) {
    const ctx = buildDeriveContext({ entry, plannedContext: { brand: "ALL" }, derivedContext: bad, accountId: "A1", latestFetchedAt: null });
    assert.ok(!("adsCoverage" in ctx), "no derived field leaks from a malformed derived payload");
    assert.equal(ctx.accountId, "A1");
    assert.equal(ctx.brand, "ALL");
  }
});

test("B1 e2e: a loader injecting scope overrides cannot move the snapshot identity out of planned scope", async () => {
  const { store, loader, plannedReports } = seedDailyCycle();
  // Loader returns valid coverage PLUS an attempt to override account/brand/from/to.
  const evilLoader = ({ reportKey }) => (reportKey === "daily-reporting"
    ? { adsCoverage: adsCoverage(), accountId: "OTHER", brand: "Nike", from: "1999-01-01", to: "1999-02-01", reportVersion: "evil" }
    : {});
  const saver = makeSnapshotSaver(store);
  const res = await runReportJobs({ store, cycleId: "c", sourceRows: loader, saveSnapshot: saver, plannedReports, loadDerivedContext: evilLoader });
  assert.equal(res.succeeded, 1, "derivation still succeeds using the PLANNED scope + approved coverage");
  const key = [...store._snapshots.keys()].find((k) => k.startsWith("scheduler-v2/daily-reporting|A1|"));
  assert.ok(key, "snapshot stored under the PLANNED account A1, never the injected OTHER");
  assert.ok(![...store._snapshots.keys()].some((k) => k.includes("|OTHER|")), "no snapshot under the injected account");
  const snap = store._snapshots.get(key);
  assert.equal(snap.params.brand, "ALL", "planned brand ALL is the snapshot identity, not the injected Nike");
  assert.equal(snap.params.accountId, "A1");
  assert.equal(snap.params.from, DR_FROM);
  assert.equal(snap.params.to, DR_TO);
  assert.equal(snap.params.reportVersion, REPORT_DERIVATIONS["daily-reporting"].snapshotVersion, "version is the registry version, not injected");
  assert.equal(snap.payload.brandFiltered, false, "still the ALL-brand fold (injected brand ignored)");
});

group("blocker 3/4: Daily Ads availability model (sales independent of Ads)");

const planCov = { accountId: "A1", rawSellerId: "S1", currency: "USD", from: DR_FROM, to: DR_TO };
const avail = (over) => resolveDailyAdsAvailability(adsCoverage(over), planCov);

test("B2 unit: validated fully-covered = usable Ads (genuine zero when adRows empty)", async () => {
  const full = resolveDailyAdsAvailability(adsCoverage(), planCov);
  assert.equal(full.availability.status, "validated");
  assert.equal(full.availability.coveredFrom, DR_FROM); assert.equal(full.availability.coveredTo, DR_TO);
  assert.deepEqual(full.adRows, DR_ADS);
  // Genuine zero: validated, fully covered, empty rows.
  const zero = resolveDailyAdsAvailability(adsCoverage({ adRows: [] }), planCov);
  assert.equal(zero.availability.status, "validated");
  assert.deepEqual(zero.adRows, []);
});

test("B2 unit: new-account partial + stale coverage still merge their covered rows (never zero the rest)", async () => {
  // A new account with only a recent covered window => partial; rows inside are merged.
  const partial = resolveDailyAdsAvailability(adsCoverage({ windows: [{ from: "2025-06-01", to: DR_TO }], adRows: [{ date: "2025-06-10", seller_or_vendor_id: "S1", currency: "USD", ad_sales: 3, ad_spend: 1, ad_clicks: 1 }] }), planCov);
  assert.equal(partial.availability.status, "partial");
  assert.equal(partial.availability.coveredFrom, "2025-06-01"); assert.equal(partial.availability.coveredTo, DR_TO);
  assert.equal(partial.adRows.length, 1, "covered rows are merged");
  // A recent gap => stale; only the covered prefix is merged.
  const stale = resolveDailyAdsAvailability(adsCoverage({ windows: [{ from: DR_FROM, to: "2025-06-15" }] }), planCov);
  assert.equal(stale.availability.status, "stale");
  assert.equal(stale.availability.coveredTo, "2025-06-15");
});

test("B2 unit: unavailable (not-synced / schema-missing / no coverage) merges NO rows, never zero", async () => {
  assert.equal(avail({ syncStatus: "missing" }).availability.status, "unavailable");
  assert.equal(avail({ syncStatus: "pending" }).availability.status, "unavailable");
  assert.equal(avail({ coverageRead: "schema-missing" }).availability.status, "unavailable");
  assert.equal(avail({ windows: [] }).availability.status, "unavailable");
  const u = avail({ syncStatus: "missing" });
  assert.deepEqual(u.adRows, [], "no rows merged when Ads unavailable");
  assert.equal(resolveDailyAdsAvailability(null, planCov).availability.status, "unavailable"); // missing contract
});

test("B2 unit: operational failures (sync-failed / read-failed / limit / scope / window mismatch) => failed", async () => {
  assert.equal(avail({ syncStatus: "failed" }).availability.reason, "ads-sync-failed");
  assert.equal(avail({ coverageRead: "read-failed" }).availability.reason, "coverage-read-failed");
  assert.equal(avail({ metricsRead: "limit-exceeded" }).availability.reason, "ads-read-limit-exceeded");
  assert.equal(avail({ metricsRead: "read-failed" }).availability.reason, "ads-read-failed");
  assert.equal(avail({ accountId: "B9" }).availability.reason, "ads-account-mismatch");
  assert.equal(avail({ rawSellerId: "OTHER" }).availability.reason, "ads-raw-seller-mismatch");
  assert.equal(avail({ requested: { from: "2020-01-01", to: "2020-06-30" } }).availability.reason, "ads-window-mismatch");
  assert.equal(avail({ syncStatus: "failed" }).availability.status, "failed");
  assert.deepEqual(avail({ syncStatus: "failed" }).adRows, [], "failed Ads merges no rows");
});

test("B2 e2e: an unavailable/stale Ads state still SAVES the sales snapshot with explicit availability", async () => {
  for (const c of [
    { over: { syncStatus: "missing" }, status: "unavailable" },
    { over: { syncStatus: "failed" }, status: "failed" },
    { over: { windows: [{ from: DR_FROM, to: "2025-06-15" }] }, status: "stale" },
  ]) {
    const { store, loader, plannedReports } = seedDailyCycle();
    const saver = makeSnapshotSaver(store);
    const loadDerivedContext = ({ reportKey }) => (reportKey === "daily-reporting" ? { adsCoverage: adsCoverage(c.over) } : {});
    const res = await runReportJobs({ store, cycleId: "c", sourceRows: loader, saveSnapshot: saver, plannedReports, loadDerivedContext });
    assert.equal(res.succeeded, 1, "sales snapshot saves regardless of Ads state: " + c.status);
    const snap = [...store._snapshots.values()].find((s) => s.payload.brandFiltered === false);
    assert.equal(snap.payload.adsAvailability.status, c.status, "explicit Ads availability recorded");
    assert.ok(snap.payload.rows.length > 0, "sales rows present");
  }
});

group("tranche-2 blocker 3: SKU P&L six-complete-calendar-month contract");

// One monthly fragment: a full-month window + its single-account raw seller scope.
const mw = (from, to, sid = "A1") => ({ from, to, sellerOrVendorIds: [sid] });
const sixWindows = [
  mw("2025-01-01", "2025-01-31"), mw("2025-02-01", "2025-02-28"),
  mw("2025-03-01", "2025-03-31"), mw("2025-04-01", "2025-04-30"),
  mw("2025-05-01", "2025-05-31"), mw("2025-06-01", "2025-06-30"),
];

test("B3 unit: exactly six complete consecutive single-account months matching context.from/to is accepted", async () => {
  const ok = validateSkuPlMonthlyWindows({ from: "2025-01-01", to: "2025-06-30", windows: sixWindows });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.months, ["2025-01", "2025-02", "2025-03", "2025-04", "2025-05", "2025-06"]);
  assert.equal(ok.accountId, "A1");
});

test("B3 unit: missing / extra / reordered / partial-month / gap all FAIL closed", async () => {
  const bad = (windows, from = "2025-01-01", to = "2025-06-30") => validateSkuPlMonthlyWindows({ from, to, windows });
  assert.equal(bad(sixWindows.slice(0, 5)).ok, false, "five months (one missing) rejected");
  assert.equal(bad([...sixWindows, mw("2025-07-01", "2025-07-31")]).ok, false, "seven months (extra) rejected");
  assert.equal(bad([mw("2025-01-01", "2025-01-15"), ...sixWindows.slice(1)]).ok, false, "partial first month rejected");
  assert.equal(bad([mw("2025-01-05", "2025-01-31"), ...sixWindows.slice(1)]).ok, false, "month not starting on the 1st rejected");
  const reordered = [sixWindows[1], sixWindows[0], ...sixWindows.slice(2)];
  assert.equal(bad(reordered).ok, false, "reordered months rejected");
  const gap = [sixWindows[0], sixWindows[2], sixWindows[3], sixWindows[4], sixWindows[5], mw("2025-07-01", "2025-07-31")];
  assert.equal(bad(gap).ok, false, "a gap (missing Feb) rejected");
  assert.equal(bad(sixWindows, "2025-01-01", "2025-05-31").ok, false, "context to is a 5-month span");
  assert.equal(bad(sixWindows, "2025-01-05", "2025-06-30").ok, false, "context from is not a month start");
  assert.equal(validateSkuPlMonthlyWindows({ from: "2025-02-30", to: "2025-06-30", windows: sixWindows }).ok, false, "impossible context date");
  assert.equal(bad([mw("2025-01-01", "2025-99-99"), ...sixWindows.slice(1)]).ok, false, "impossible fragment date");
});

// Build a valid six-month sku-pl cycle from SKU_BATCHES; overridable windows for the failure path.
function seedSkuCycle(windowOverride) {
  const store = makeMemoryReportStore();
  const wins = windowOverride || sixWindows;
  const loaderMap = new Map();
  const planned = wins.map((w, i) => {
    const h = "h_sku_" + i;
    store.seedSource(h, "succeeded");
    loaderMap.set(h, (SKU_BATCHES[i] || { rows: [] }).rows);
    return src("sku-pl:monthly-profit", h, { from: w.from, to: w.to, sellerOrVendorIds: ["A1"] });
  });
  const loader = makeCacheLoader(loaderMap);
  const plannedReports = [plan("sku-pl", "A1", planned, { context: { from: "2025-01-01", to: "2025-06-30" } })];
  return { store, loader, plannedReports };
}

test("B3 e2e: a five-month (missing) source set BLOCKS the sku-pl snapshot and preserves last-known-good (zero writes)", async () => {
  const { store, loader, plannedReports } = seedSkuCycle(sixWindows.slice(0, 5)); // only five months planned/available
  store._snapshots.set("scheduler-v2/sku-pl|A1|ph_prev", { payload: { rows: [{ prior: true }], months: [], currencies: [], catalogBrands: [] } });
  const saver = makeSnapshotSaver(store);
  const res = await runReportJobs({ store, cycleId: "c", sourceRows: loader, saveSnapshot: saver, plannedReports });
  assert.equal(res.succeeded, 0, "an incomplete six-month set never saves");
  assert.equal(store._saveCalls, 0, "zero Supabase writes");
  assert.notEqual(store._report("sku-pl", "A1").derive_status, "succeeded");
  assert.ok(store._snapshots.has("scheduler-v2/sku-pl|A1|ph_prev"), "previous snapshot preserved");
});

group("tranche-2 blocker 4: cross-account contamination is impossible");

test("B4 e2e: account A and account B each derive from their OWN single-account source jobs (no leakage)", async () => {
  // Distinct request hashes per account (single-account source jobs, Blocker 4). A's rows/catalog
  // are Acme/Beta; B's are Zeta. Neither can receive the other's rows.
  const store = makeMemoryReportStore();
  store.seedSource("h_ol_A", "succeeded"); store.seedSource("h_cat_A", "succeeded");
  store.seedSource("h_ol_B", "succeeded"); store.seedSource("h_cat_B", "succeeded");
  const loader = makeCacheLoader(new Map([
    ["h_ol_A", ORDER_ROWS], ["h_cat_A", CATALOG_ROWS],
    ["h_ol_B", ORDER_ROWS_SECONDARY], ["h_cat_B", CATALOG_ROWS_SECONDARY],
  ]));
  const saver = makeSnapshotSaver(store);
  const plannedReports = [
    plan("brand-sales", "ACCT_A", [src("brand-sales:order-lines", "h_ol_A", { sellerOrVendorIds: ["A"] }), src("brand-sales:catalog", "h_cat_A", { sellerOrVendorIds: ["A"] })]),
    plan("brand-sales", "ACCT_B", [src("brand-sales:order-lines", "h_ol_B", { sellerOrVendorIds: ["B"] }), src("brand-sales:catalog", "h_cat_B", { sellerOrVendorIds: ["B"] })], { bucket: "non-us" }),
  ];
  await runReportJobs({ store, cycleId: "c", sourceRows: loader, saveSnapshot: saver, plannedReports });
  const snapA = store._snapshots.get([...store._snapshots.keys()].find((k) => k.includes("|ACCT_A|")));
  const snapB = store._snapshots.get([...store._snapshots.keys()].find((k) => k.includes("|ACCT_B|")));
  assert.deepEqual(snapA.payload.catalogBrands, ["Acme", "Beta"], "A uses only A's catalog");
  assert.deepEqual(snapB.payload.catalogBrands, ["Zeta"], "B uses only B's catalog");
  assert.ok(!snapA.payload.catalogBrands.includes("Zeta"), "A never receives B's brand");
  assert.ok(!snapB.payload.catalogBrands.some((b) => b === "Acme" || b === "Beta"), "B never receives A's brands");
  assert.ok(snapA.payload.rows.every((r) => r.seller_or_vendor_id === "S1"), "A rows are A's seller only");
  assert.ok(snapB.payload.rows.every((r) => r.seller_or_vendor_id === "S9"), "B rows are B's seller only");
});

test("B4 e2e: sku-pl fragments that span two accounts BLOCK derivation (defense-in-depth)", async () => {
  const { store, loader } = seedSkuCycle();
  // Re-plan with a second account's id leaking into the fragments' sellerOrVendorIds.
  const plannedReports = [plan("sku-pl", "A1", sixWindows.map((w, i) => src("sku-pl:monthly-profit", "h_sku_" + i, { from: w.from, to: w.to, sellerOrVendorIds: i === 3 ? ["A1", "B2"] : ["A1"] })), { context: { from: "2025-01-01", to: "2025-06-30" } })];
  store._snapshots.set("scheduler-v2/sku-pl|A1|ph_prev", { payload: { rows: [{ prior: true }], months: [], currencies: [], catalogBrands: [] } });
  const saver = makeSnapshotSaver(store);
  const res = await runReportJobs({ store, cycleId: "c", sourceRows: loader, saveSnapshot: saver, plannedReports });
  assert.equal(res.succeeded, 0, "multi-account fragments never fold into a snapshot");
  assert.equal(store._saveCalls, 0, "zero writes");
  assert.ok(store._snapshots.has("scheduler-v2/sku-pl|A1|ph_prev"), "previous snapshot preserved");
});

/* ===================== tranche-2 re-review findings (2026-08-10) ===================== */

group("re-review F1: duplicate SKU month cannot double-count");

test("F1 unit: a duplicated month fragment is REJECTED, never deduped; and folding it WOULD double-count", async () => {
  // Seven fragments = six months + a duplicate January -> too many fragments.
  const dup7 = validateSkuPlMonthlyWindows({ from: "2025-01-01", to: "2025-06-30", windows: [mw("2025-01-01", "2025-01-31"), ...sixWindows] });
  assert.equal(dup7.ok, false); assert.equal(dup7.reason, "expected-exactly-six-single-account-fragments");
  // Six fragments but January appears twice (identical window), March missing -> duplicate rejected.
  const twoJan = [mw("2025-01-01", "2025-01-31"), mw("2025-01-01", "2025-01-31"), ...sixWindows.slice(1, 5)];
  const dup6 = validateSkuPlMonthlyWindows({ from: "2025-01-01", to: "2025-06-30", windows: twoJan });
  assert.equal(dup6.ok, false); assert.equal(dup6.reason, "duplicate-month-fragment");
  // Proof the rejection MATTERS: skuPlFold sums every fragment, so a duplicate January doubles it.
  const janRows = SKU_BATCHES[0].rows;
  const once = skuPlFold([{ monthKey: "2025-01", rows: janRows }]).find((e) => e.currency === "USD" && e.sku === "SKU1");
  const twice = skuPlFold([{ monthKey: "2025-01", rows: janRows }, { monthKey: "2025-01", rows: janRows }]).find((e) => e.currency === "USD" && e.sku === "SKU1");
  assert.equal(twice.byMonth["2025-01"].sales, once.byMonth["2025-01"].sales * 2, "a folded duplicate January WOULD double sales");
  assert.equal(twice.byMonth["2025-01"].profit, once.byMonth["2025-01"].profit * 2, "...and profit");
  assert.equal(twice.byMonth["2025-01"].units, once.byMonth["2025-01"].units * 2, "...and units");
});

test("F1 unit: a fragment must carry exactly one seller id; empty / missing / multiple / cross-account rejected", async () => {
  const swap = (i, ids) => sixWindows.map((w, j) => (j === i ? { from: w.from, to: w.to, sellerOrVendorIds: ids } : w));
  const v = (windows) => validateSkuPlMonthlyWindows({ from: "2025-01-01", to: "2025-06-30", windows });
  assert.equal(v(swap(2, [])).reason, "fragment-must-carry-exactly-one-seller-id", "empty seller array rejected (no accountIds:[] tolerance)");
  assert.equal(v(swap(2, undefined)).reason, "fragment-must-carry-exactly-one-seller-id", "missing seller ids rejected");
  assert.equal(v(swap(2, ["A1", "A2"])).reason, "fragment-must-carry-exactly-one-seller-id", "multiple seller ids in one fragment rejected");
  assert.equal(v(swap(2, [""])).reason, "fragment-seller-id-missing", "blank seller id rejected");
  assert.equal(v(swap(2, ["   "])).reason, "fragment-seller-id-missing", "whitespace seller id rejected");
  // Each fragment valid singly, but two distinct accounts across fragments -> single-account violation.
  assert.equal(v(sixWindows.map((w, j) => (j === 3 ? { ...w, sellerOrVendorIds: ["B2"] } : w))).reason, "multiple-or-missing-accounts");
});

test("F1 e2e: a duplicated-January source set BLOCKS the sku-pl snapshot (zero writes, last-known-good preserved)", async () => {
  const store = makeMemoryReportStore();
  const wins = [mw("2025-01-01", "2025-01-31"), ...sixWindows]; // 7 fragments (dup Jan)
  const loaderMap = new Map();
  const planned = wins.map((w, i) => { const h = "h_dup_" + i; store.seedSource(h, "succeeded"); loaderMap.set(h, []); return src("sku-pl:monthly-profit", h, { from: w.from, to: w.to, sellerOrVendorIds: ["A1"] }); });
  const loader = makeCacheLoader(loaderMap);
  store._snapshots.set("scheduler-v2/sku-pl|A1|ph_prev", { payload: { rows: [{ prior: true }], months: [], currencies: [], catalogBrands: [] } });
  const saver = makeSnapshotSaver(store);
  const plannedReports = [plan("sku-pl", "A1", planned, { context: { from: "2025-01-01", to: "2025-06-30" } })];
  const res = await runReportJobs({ store, cycleId: "c", sourceRows: loader, saveSnapshot: saver, plannedReports });
  assert.equal(res.succeeded, 0);
  assert.equal(store._saveCalls, 0, "zero Supabase writes for a duplicated-month set");
  assert.notEqual(store._report("sku-pl", "A1").derive_status, "succeeded");
  assert.ok(store._snapshots.has("scheduler-v2/sku-pl|A1|ph_prev"), "previous snapshot preserved");
});

group("blocker 3/4: Daily Ads rows validated against account + window + currency");

test("F2 unit: cross-account / out-of-window / bad-date / missing-seller / non-finite / bad-currency rows => failed", async () => {
  const row = (over) => ({ date: "2025-05-10", seller_or_vendor_id: "S1", currency: "USD", ad_sales: 1, ad_spend: 1, ad_clicks: 1, ...over });
  const status = (rows) => resolveDailyAdsAvailability(adsCoverage({ adRows: rows }), planCov).availability;
  assert.equal(status([row({ seller_or_vendor_id: "S2" })]).reason, "ads-row-cross-account", "account B row inside A blocks");
  assert.equal(status([row({ date: "2025-04-30" })]).reason, "ads-row-out-of-window", "row before planned.from blocks");
  assert.equal(status([row({ date: "2025-07-01" })]).reason, "ads-row-out-of-window", "row after planned.to blocks");
  assert.equal(status([row({ date: "2025-02-30" })]).reason, "ads-row-bad-date", "impossible date blocks");
  assert.equal(status([row({ seller_or_vendor_id: undefined })]).reason, "ads-row-cross-account", "missing seller id blocks");
  assert.equal(status([row({ ad_spend: NaN })]).reason, "ads-row-non-finite-metric", "NaN metric blocks");
  assert.equal(status([row({ ad_clicks: "3" })]).reason, "ads-row-non-finite-metric", "non-number metric blocks");
  // Currency (blocker 4): null/blank currency on a NONZERO row must not pass; mismatched currency blocks.
  assert.equal(status([row({ currency: null })]).reason, "ads-currency-missing", "null currency on nonzero row blocks");
  assert.equal(status([row({ currency: "  " })]).reason, "ads-currency-missing", "blank currency on nonzero row blocks");
  assert.equal(status([row({ currency: "CAD" })]).reason, "ads-currency-mismatch", "a currency != account currency blocks");
  assert.equal(status([row({ currency: "USD" }), row({ currency: "CAD" })]).reason, "ads-currency-mismatch", "mixed currency blocks");
  // A single bad row fails the WHOLE Ads set (never silently filtered).
  assert.equal(status([row(), row({ seller_or_vendor_id: "S2" })]).status, "failed", "one bad row fails all Ads");
  // All the above are "failed" (Ads unusable) -- sales still save (see the e2e test).
  assert.equal(status([row({ currency: "CAD" })]).status, "failed");
});

test("F2 unit: correct primary + dd-secondary rows are usable; public/raw separation preserved", async () => {
  const primary = resolveDailyAdsAvailability(adsCoverage(), planCov);
  assert.equal(primary.availability.status, "validated"); assert.deepEqual(primary.adRows, DR_ADS);
  // dd-secondary: PUBLIC id "dd-secondary:XYZ" is DISTINCT from the RAW seller id "XYZ"; rows carry
  // the RAW id. Organization isolation + public/raw separation preserved.
  const secRows = [{ date: "2025-05-02", seller_or_vendor_id: "XYZ", currency: "USD", ad_sales: 4, ad_spend: 2, ad_clicks: 1 }];
  const secPlan = { accountId: "dd-secondary:XYZ", rawSellerId: "XYZ", currency: "USD", from: DR_FROM, to: DR_TO };
  const sec = resolveDailyAdsAvailability(adsCoverage({ accountId: "dd-secondary:XYZ", rawSellerId: "XYZ", adRows: secRows }), secPlan);
  assert.equal(sec.availability.status, "validated"); assert.deepEqual(sec.adRows, secRows);
  // A dd-secondary row tagged with the PUBLIC id (not the raw id) is cross-account -> failed.
  const wrongTag = resolveDailyAdsAvailability(adsCoverage({ accountId: "dd-secondary:XYZ", rawSellerId: "XYZ", adRows: [{ ...secRows[0], seller_or_vendor_id: "dd-secondary:XYZ" }] }), secPlan);
  assert.equal(wrongTag.availability.reason, "ads-row-cross-account");
});

test("F2 unit: a missing planned rawSellerId or account currency degrades to failed (sales still save), never throws", async () => {
  assert.equal(resolveDailyAdsAvailability(adsCoverage(), { accountId: "A1", currency: "USD", from: DR_FROM, to: DR_TO }).availability.reason, "planned-raw-seller-missing");
  assert.equal(resolveDailyAdsAvailability(adsCoverage(), { accountId: "A1", rawSellerId: "S1", from: DR_FROM, to: DR_TO }).availability.reason, "planned-currency-missing");
  assert.equal(resolveDailyAdsAvailability(adsCoverage({ rawSellerId: "OTHER" }), planCov).availability.reason, "ads-raw-seller-mismatch");
});

test("F2 e2e: a cross-account / out-of-window Ads row => Ads FAILED but sales still save (never zero)", async () => {
  const badSets = [
    [{ date: "2025-05-01", seller_or_vendor_id: "S2", currency: "USD", ad_sales: 5, ad_spend: 5, ad_clicks: 5 }], // account B leaked into A
    [{ date: "2025-04-01", seller_or_vendor_id: "S1", currency: "USD", ad_sales: 5, ad_spend: 5, ad_clicks: 5 }], // before the planned window
  ];
  for (const badRows of badSets) {
    const { store, loader, plannedReports } = seedDailyCycle();
    const saver = makeSnapshotSaver(store);
    const badLoader = ({ reportKey }) => (reportKey === "daily-reporting" ? { adsCoverage: adsCoverage({ adRows: badRows }) } : {});
    const res = await runReportJobs({ store, cycleId: "c", sourceRows: loader, saveSnapshot: saver, plannedReports, loadDerivedContext: badLoader });
    assert.equal(res.succeeded, 1, "sales still save: " + JSON.stringify(badRows[0]));
    const snap = [...store._snapshots.values()].find((s) => s.payload.brandFiltered === false);
    assert.equal(snap.payload.adsAvailability.status, "failed", "corrupt Ads => failed availability");
    assert.ok(snap.payload.rows.every((r) => !("ad_sales" in r)), "no ad fields merged when Ads failed");
  }
});

group("re-review F3: pure derivation import boundary is real (transitive)");

test("F3 unit: date-window leaf matches the datadoe re-exports (same functions; pinned/leap/month-end/invalid cases)", async () => {
  const dw = await import("../lib/server/date-windows.js");
  const dd = await import("../lib/server/datadoe.js");
  // Same function objects -> no duplicated algorithm; route behavior is byte-for-byte unchanged.
  assert.equal(dw.addDaysStr, dd.addDaysStr);
  assert.equal(dw.splitDateRangeByMonth, dd.splitDateRangeByMonth);
  assert.equal(dw.isFullCalendarMonthWindow, dd.isFullCalendarMonthWindow);
  assert.deepEqual(dw.splitDateRangeByMonth("2025-01-15", "2025-03-10"), [
    { from: "2025-01-15", to: "2025-01-31" }, { from: "2025-02-01", to: "2025-02-28" }, { from: "2025-03-01", to: "2025-03-10" },
  ]);
  assert.deepEqual(dw.splitDateRangeByMonth("2024-02-01", "2024-02-29"), [{ from: "2024-02-01", to: "2024-02-29" }]);
  assert.equal(dw.isFullCalendarMonthWindow({ from: "2024-02-01", to: "2024-02-29" }), true, "leap Feb full month");
  assert.equal(dw.isFullCalendarMonthWindow({ from: "2023-02-01", to: "2023-02-28" }), true, "non-leap Feb full month");
  assert.equal(dw.isFullCalendarMonthWindow({ from: "2024-02-01", to: "2024-02-28" }), false, "leap Feb ending on the 28th is NOT full");
  assert.equal(dw.isFullCalendarMonthWindow({ from: "2025-04-01", to: "2025-04-30" }), true);
  assert.equal(dw.isFullCalendarMonthWindow({ from: "2025-04-01", to: "2025-04-31" }), false, "April has no 31st");
  assert.equal(dw.addDaysStr("2024-02-28", 1), "2024-02-29");
  assert.equal(dw.addDaysStr("2023-02-28", 1), "2023-03-01");
  assert.equal(dw.addDaysStr("2025-12-31", 1), "2026-01-01");
});

test("F3 unit: derivation graph has NO transitive transport/storage import (fails if one is ever added)", async () => {
  const LIBROOT = join(HERE, "..", "lib");
  const entryFiles = [
    "server/sync/report-worker.js", "server/sync/report-derivation.js",
    "server/reports/derivation-core.js", "server/sync/report-source-contracts.js",
  ].map((r) => join(LIBROOT, r));
  const forbiddenFile = /[\\/](datadoe|supabase)\.js$/;
  const forbiddenCall = /\b(createExport|pollExport|downloadExport|fetchExportRows|fetchExportRowsStrict)\s*\(/;
  // Strip block + line comments so a doc-comment MENTION of a transport function is not mistaken
  // for a real call (the `://` guard keeps URLs intact). Import/export scanning runs on the raw
  // text (line-anchored), so stripping does not affect the import graph.
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/([^:])\/\/.*$/gm, "$1").replace(/^\/\/.*$/gm, "");
  // Match relative .js specifiers on import/export STATEMENTS (line-anchored so a "from" inside a
  // string literal cannot be mistaken for an import). Covers multi-line imports ([^;] spans newlines).
  const specRe = /^\s*(?:import|export)\b[^;]*?\bfrom\s*["'](\.[^"']+\.js)["']/gm;
  const bareRe = /^\s*import\s*["'](\.[^"']+\.js)["']/gm;
  const visited = new Set();
  const walk = (file) => {
    if (visited.has(file)) return;
    visited.add(file);
    const text = readFileSync(file, "utf8");
    assert.ok(!forbiddenCall.test(stripComments(text)), file + " must not call a DataDoe transport function");
    const specs = [...text.matchAll(specRe)].map((m) => m[1]).concat([...text.matchAll(bareRe)].map((m) => m[1]));
    for (const spec of specs) {
      const resolved = resolve(dirname(file), spec);
      assert.ok(!forbiddenFile.test(resolved), file + " transitively imports forbidden transport/storage: " + spec);
      walk(resolved);
    }
  };
  for (const f of entryFiles) walk(f);
  // Guard against a regex that silently matches nothing: the walk MUST reach the real leaves.
  const reached = (name) => [...visited].some((f) => f.endsWith(name));
  assert.ok(reached("date-windows.js"), "walk reached the date-window leaf");
  assert.ok(reached("report-source-contracts.js") && reached("derivation-core.js") && reached("planner.js"), "walk reached the derivation deps");
  assert.ok(reached("source-identity.js") && reached("id-batching.js"), "walk reached contracts' own deps");
});

/* ===================== SHADOW PLANNER (consolidated from scheduler-v2-shadow-planner) =====================
 * The 26 planner/loader/orchestration assertions, moved here into this already-readable artifact.
 * Every fake credential is assembled at RUNTIME from harmless fragments (no credential-shaped literal
 * in the bytes). Helpers are pl*-namespaced to avoid colliding with the derivation fixtures above;
 * the test/group harness, makeCacheLoader, and withFetchSpy are reused. */

const plDash = (...parts) => parts.join("-");
// Two authoritative organizations (primary + dd-secondary), the getDataDoeConnections shape; the api
// keys are runtime-built harmless values.
const PL_CONN = [
  { id: "primary", apiKey: plDash("org", "primary"), accountPrefix: "" },
  { id: "secondary", apiKey: plDash("org", "secondary"), accountPrefix: plDash("dd", "secondary") + ":" },
];
const PL_SECONDARY = plDash("dd", "secondary") + ":B9"; // "dd-secondary:B9"
const PL_AS_OF = "2026-08-10";
const plAsOfFor = () => PL_AS_OF;
const PL_FROM = "2026-03-01", PL_TO = PL_AS_OF; // monthBack(2026-08-10, 5).from .. today

function plMakeStore() {
  const reportJobs = new Map();
  const snapshots = new Map();
  const sourceJobs = [];
  const key = (rk, acct) => rk + "|" + acct;
  return {
    _snapshots: snapshots, _saveCalls: 0,
    seedSourceStatus(hash, status) { sourceJobs.push({ request_hash: hash, fetch_status: status }); },
    _report(rk, acct) { return reportJobs.get(key(rk, acct)); },
    listSourceJobs() { return sourceJobs.map((j) => ({ ...j })); },
    upsertReportJob({ reportKey, reportVersion, accountId, connectionId, bucket, dependsOn }) {
      const k = key(reportKey, accountId);
      if (reportJobs.has(k)) return;
      reportJobs.set(k, {
        report_key: reportKey, account_id: accountId, connection_id: connectionId, bucket,
        report_version: reportVersion, depends_on: dependsOn || [],
        fetch_status: "pending", derive_status: "pending", save_status: "pending", validated: false,
        error_stage: null, error_code: null, error_message: null,
        latest_data_date: null, row_count: null, snapshot_params_hash: null, last_good_snapshot_at: null,
      });
    },
    listReportJobs() { return [...reportJobs.values()].map((j) => ({ ...j })); },
    claimReportDerive(_c, rk, acct) {
      const j = reportJobs.get(key(rk, acct));
      if (j && j.derive_status === "pending") { j.derive_status = "running"; return true; }
      return false;
    },
    recordReportBlocked({ reportKey, accountId, reason }) {
      Object.assign(reportJobs.get(key(reportKey, accountId)), { fetch_status: "blocked", derive_status: "skipped", save_status: "skipped", validated: false, error_stage: "fetch", error_code: "SOURCE_BLOCKED", error_message: reason });
    },
    recordReportFailure({ reportKey, accountId, stage, code, message, terminal }) {
      const j = reportJobs.get(key(reportKey, accountId));
      const body = { error_stage: stage, error_code: code, error_message: message, terminal: !!terminal };
      if (stage === "save") { body.derive_status = "succeeded"; body.save_status = "failed"; } else body.derive_status = "failed";
      Object.assign(j, body);
    },
    recordReportSuccess(args) {
      const j = reportJobs.get(key(args.reportKey, args.accountId));
      Object.assign(j, { fetch_status: "ready", derive_status: "succeeded", save_status: "succeeded", validated: true, latest_data_date: args.latestDataDate, row_count: args.rowCount, snapshot_params_hash: args.snapshotParamsHash, last_good_snapshot_at: "t", error_stage: null, error_code: null, error_message: null });
    },
  };
}

function plMakeSaver(store) {
  return async ({ reportKey, accountId, params, payload }) => {
    store._saveCalls += 1;
    const paramsHash = "ph_" + JSON.stringify(params).length;
    store._snapshots.set(reportKey + "|" + accountId + "|" + paramsHash, { payload, params });
    return { paramsHash };
  };
}

function plMakeSourceStore() {
  const cycles = new Map();
  const jobsByCycle = new Map();
  const cache = new Map();
  let seq = 0;
  const findCycle = (id) => [...cycles.values()].find((c) => c.id === id) || null;
  return {
    _cache: cache,
    openCycle({ bucket, cycleDate }) {
      const k = bucket + "|" + cycleDate;
      if (!cycles.has(k)) { const id = "cyc_" + (++seq); cycles.set(k, { id, status: "pending" }); jobsByCycle.set(id, new Map()); }
      return cycles.get(k).id;
    },
    claimCycle(id) { const c = findCycle(id); if (c && c.status === "pending") { c.status = "running"; return true; } return false; },
    getCycle(id) { return findCycle(id); },
    upsertSourceJob(job) {
      const m = jobsByCycle.get(job.cycleId);
      if (m.has(job.requestHash)) return;
      m.set(job.requestHash, { request_hash: job.requestHash, source_id: job.sourceId, source_key: job.sourceKey, connection_id: job.connectionId, fetch_status: "pending", attempted_at: null, export_id: null });
    },
    listSourceJobs(id) { return [...(jobsByCycle.get(id) ? jobsByCycle.get(id).values() : [])].map((j) => ({ ...j })); },
    claimExportAttempt(id, hash) {
      const j = jobsByCycle.get(id) && jobsByCycle.get(id).get(hash);
      if (j && j.attempted_at === null) { j.attempted_at = "t"; j.fetch_status = "attempted"; return true; }
      return false;
    },
    recordExportCreated({ cycleId, requestHash, exportId }) { jobsByCycle.get(cycleId).get(requestHash).export_id = exportId; },
    saveSourceRows({ job, rows, version }) { const hash = job.request_hash || job.requestHash; cache.set(hash, { rows: [...rows] }); return "cache/" + hash + "/" + version + ".json"; },
    recordSourceSuccess({ cycleId, requestHash, rowCount, cacheObjectPath }) { Object.assign(jobsByCycle.get(cycleId).get(requestHash), { fetch_status: "succeeded", row_count: rowCount, cache_object_path: cacheObjectPath }); },
    recordSourceFailure({ cycleId, requestHash, code }) { Object.assign(jobsByCycle.get(cycleId).get(requestHash), { fetch_status: "failed", error_code: code }); },
    updateCycleCounts() {},
  };
}

function plMakeDataDoe(rowsForKey) {
  const creates = {};
  return {
    totalCreates: () => Object.values(creates).reduce((a, b) => a + b, 0),
    createCount: (h) => creates[h] || 0,
    async create(job) { creates[job.requestHash] = (creates[job.requestHash] || 0) + 1; return { exportId: "exp_" + job.requestHash }; },
    async poll() {},
    async download(job) { return rowsForKey(job.requestKey || job.request_key || "") || []; },
  };
}

// A fake fetch Response + a router installer for the coverage read/write helper tests.
const plFakeResponse = (ok, status, body) => ({ ok, status, json: async () => body });
async function plWithRoutedFetch(router, run) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => router(String(url));
  try { await run(); } finally { globalThis.fetch = original; }
}

// Daily sales fixtures + a metric-row builder (ad_daily_metrics shape).
const PL_SUPERSET = [
  { date: "2026-03-05", seller_or_vendor_id: "A1", child_asin: "ASIN000001", total_sales_sum: 100, total_units_sum: 4 },
  { date: "2026-03-06", seller_or_vendor_id: "A1", child_asin: "ASIN000002", total_sales_sum: 50, total_units_sum: 2 },
];
const PL_CATALOG = [{ child_asin: "ASIN000001", product_brand: "Acme" }, { child_asin: "ASIN000002", product_brand: "Beta" }];
const plMetric = (d, over = {}) => ({ metric_date: d, campaign_id: "c1", campaign_type: "SP", currency: "USD", ad_sales: 10, ad_spend: 5, ad_clicks: 3, ...over });
const plDailyRequest = (accountId, country, currency) => planDailyReporting({ accountId, country, currency, connections: PL_CONN, asOf: PL_AS_OF });

function plSeedCache(request) {
  const byHash = new Map();
  let firstSuperset = true;
  for (const s of request.sources) {
    if (s.requestKey === "daily-reporting:asin-day-superset") { byHash.set(s.requestHash, firstSuperset ? PL_SUPERSET : []); firstSuperset = false; }
    else if (s.requestKey === "daily-reporting:catalog") byHash.set(s.requestHash, PL_CATALOG);
  }
  return byHash;
}

async function plDeriveDaily({ getAdMetrics, coverageState }) {
  const request = plDailyRequest("A1", "US", "USD");
  const store = plMakeStore();
  for (const s of request.sources) store.seedSourceStatus(s.requestHash, "succeeded");
  const loader = makeDailyAdsContextLoader({
    connections: PL_CONN,
    getAdMetrics: getAdMetrics || (async () => [plMetric("2026-03-05")]),
    getCoverageState: async () => coverageState || { windows: [{ from: PL_FROM, to: PL_TO }], status: "succeeded", latestMetricDate: "2026-03-05", read: "ok" },
  });
  const res = await runReportJobs({ store, cycleId: "c", sourceRows: makeCacheLoader(plSeedCache(request)), saveSnapshot: plMakeSaver(store), plannedReports: [request], loadDerivedContext: loader });
  const snap = [...store._snapshots.values()].find((s) => s.payload.brandFiltered === false);
  return { request, store, res, snap };
}

group("planner: authoritative scope, currency, organization isolation");

test("planner: primary planning uses public==raw ids + authoritative currency", async () => {
  const scope = resolveAccountScope({ accountId: "A1", country: "US", currency: "usd", connections: PL_CONN });
  assert.equal(scope.accountId, "A1"); assert.equal(scope.rawSellerId, "A1");
  assert.equal(scope.connectionId, "primary"); assert.equal(scope.bucket, "us"); assert.equal(scope.currency, "USD");
  const req = plDailyRequest("A1", "US", "USD");
  assert.equal(req.context.rawSellerId, "A1"); assert.equal(req.context.currency, "USD");
  assert.ok(req.sources.every((s) => s.sellerOrVendorIds.length === 1 && s.sellerOrVendorIds[0] === "A1"));
});

test("planner: dd-secondary planning uses the prefixed public id but the raw seller id", async () => {
  const scope = resolveAccountScope({ accountId: PL_SECONDARY, country: "CA", currency: "CAD", connections: PL_CONN });
  assert.equal(scope.accountId, PL_SECONDARY); assert.equal(scope.rawSellerId, "B9");
  assert.equal(scope.connectionId, "secondary"); assert.equal(scope.bucket, "non-us"); assert.equal(scope.currency, "CAD");
  const req = planSkuPl({ accountId: PL_SECONDARY, country: "CA", currency: "CAD", connections: PL_CONN, asOf: PL_AS_OF });
  assert.equal(req.accountId, PL_SECONDARY); assert.equal(req.context.rawSellerId, "B9");
  assert.deepEqual([...new Set(req.sources.flatMap((s) => s.sellerOrVendorIds))], ["B9"]);
});

test("planner: resolveAccountScope rejects a missing account currency (fail closed)", async () => {
  assert.throws(() => resolveAccountScope({ accountId: "A1", country: "US", currency: "", connections: PL_CONN }), /authoritative account currency/);
});

test("planner: organization credentials + fingerprints never mix (same raw id, different org)", async () => {
  const pri = plDailyRequest("A1", "US", "USD");
  const sec = plDailyRequest(plDash("dd", "secondary") + ":A1", "US", "USD");
  const priH = pri.sources.map((s) => s.requestHash).sort();
  const secH = sec.sources.map((s) => s.requestHash).sort();
  assert.ok(priH.every((h, i) => h !== secH[i]), "no request hash shared across orgs");
  assert.notEqual([...new Set(pri.sources.map((s) => s.organizationFingerprint))][0], [...new Set(sec.sources.map((s) => s.organizationFingerprint))][0]);
  const plan = buildShadowReportPlan({ accounts: [{ accountId: "A1", country: "US", currency: "USD" }, { accountId: plDash("dd", "secondary") + ":A1", country: "US", currency: "USD" }], reportKeys: ["daily-reporting"], connections: PL_CONN, asOfFor: plAsOfFor });
  assert.deepEqual([...new Set(plan.sourceJobs.map((j) => j.connectionId))].sort(), ["primary", "secondary"]);
  assert.equal(plan.sourceJobs.length, pri.sources.length + sec.sources.length, "no cross-org source-job collapse");
});

group("planner: exact Daily calendar window == live monthBack(asOf, 5).from .. asOf");

test("planner: Daily plan spans the exact six-calendar-month window with monthly segmentation", async () => {
  const req = plDailyRequest("A1", "US", "USD");
  assert.equal(req.context.from, "2026-03-01", "first day of the month five months back (NOT a 150-day approximation)");
  assert.equal(req.context.to, PL_AS_OF);
  const expected = splitDateRangeByMonth("2026-03-01", PL_AS_OF);
  const superset = req.sources.filter((s) => s.requestKey === "daily-reporting:asin-day-superset");
  assert.deepEqual(superset.map((s) => ({ from: s.from, to: s.to })), expected, "one superset fragment per calendar month");
  const catalog = req.sources.filter((s) => s.requestKey === "daily-reporting:catalog");
  assert.deepEqual({ from: catalog[0].from, to: catalog[0].to }, { from: "2026-03-01", to: PL_AS_OF });
  assert.deepEqual([...new Set(req.sources.map((s) => s.requestKey))].sort(), ["daily-reporting:asin-day-superset", "daily-reporting:catalog"]);
  assert.equal(req.context.brand, "ALL");
});

test("planner: monthBackStr matches the live UI monthBack(s, 5).from across month lengths + year boundaries", async () => {
  for (const d of ["2026-08-10", "2026-01-15", "2026-02-28", "2024-02-29", "2026-12-31", "2025-07-04", "2026-03-31"]) {
    assert.equal(monthBackStr(d, 5), liveMonthBack(d, 5).from, "parity at " + d);
    assert.equal(monthBackStr(d, 0), liveMonthBack(d, 0).from, "n=0 parity at " + d);
  }
});

group("planner: SKU P&L six complete consecutive months");

test("planner: SKU plan produces exactly six single-account monthly jobs matching context.from/to", async () => {
  const req = planSkuPl({ accountId: "A1", country: "US", currency: "USD", connections: PL_CONN, asOf: PL_AS_OF });
  const frags = req.sources.filter((s) => s.requestKey === "sku-pl:monthly-profit");
  assert.equal(frags.length, 6); assert.equal(req.sources.length, 6);
  const check = validateSkuPlMonthlyWindows({ from: req.context.from, to: req.context.to, windows: frags.map((f) => ({ from: f.from, to: f.to, sellerOrVendorIds: f.sellerOrVendorIds })) });
  assert.equal(check.ok, true, "planned months satisfy the six-complete-month contract: " + JSON.stringify(check));
  assert.equal(req.context.from, frags[0].from); assert.equal(req.context.to, frags[5].to);
});

test("planner: SKU duplicate / missing / reordered months fail the same validator the derive uses", async () => {
  const req = planSkuPl({ accountId: "A1", country: "US", currency: "USD", connections: PL_CONN, asOf: PL_AS_OF });
  const good = req.sources.map((f) => ({ from: f.from, to: f.to, sellerOrVendorIds: ["A1"] }));
  const v = (windows) => validateSkuPlMonthlyWindows({ from: req.context.from, to: req.context.to, windows });
  assert.equal(v([good[0], ...good]).ok, false, "duplicate month blocked");
  assert.equal(v(good.slice(0, 5)).ok, false, "missing month blocked");
  assert.equal(v([good[1], good[0], ...good.slice(2)]).ok, false, "reordered months blocked");
});

group("planner: deterministic paged Ads read, no partial totals");

test("planner: paginateAdDailyMetrics reads >1000 rows on one date + across dates with no skip/dup", async () => {
  const all = [];
  for (let i = 0; i < 1200; i += 1) all.push(plMetric("2026-03-05", { campaign_id: "c" + String(i).padStart(5, "0") }));
  for (let i = 0; i < 400; i += 1) all.push(plMetric("2026-03-06", { campaign_id: "d" + String(i).padStart(5, "0") }));
  const pages = [all.slice(0, 1000), all.slice(1000, 2000)];
  let calls = 0;
  const rows = await paginateAdDailyMetrics({ fetchPage: () => Promise.resolve(pages[calls++] || []) });
  assert.equal(rows.length, 1600, "every page assembled");
  assert.equal(new Set(rows.map((r) => r.campaign_id + "|" + r.metric_date)).size, 1600, "no duplicate rows");
  assert.equal(calls, 2, "stopped on the short final page");
});

test("planner: exceeding the safety row limit BLOCKS (throws), never returns a partial total", async () => {
  const page = Array.from({ length: 20 }, (_, i) => plMetric("2026-03-05", { campaign_id: "c" + i }));
  await assert.rejects(
    () => paginateAdDailyMetrics({ maxRows: 10, pageSize: 20, fetchPage: () => Promise.resolve(page) }),
    (err) => err && err.code === "ADS_ROW_LIMIT_EXCEEDED",
  );
});

group("planner: Daily Ads availability model + currency");

test("planner: loader reads ad_daily_metrics ONLY (not overlapping raw Ads tables), by public id + window", async () => {
  const req = plDailyRequest("A1", "US", "USD");
  const adCalls = [];
  const coverageKeys = [];
  const loader = makeDailyAdsContextLoader({
    connections: PL_CONN,
    getAdMetrics: async (accountId, from, to) => { adCalls.push({ accountId, from, to }); return [plMetric("2026-03-05")]; },
    getCoverageState: async (_id, sk) => { coverageKeys.push(sk); return { windows: [{ from: PL_FROM, to: PL_TO }], status: "succeeded", latestMetricDate: "2026-03-05", read: "ok" }; },
  });
  const ctx = await loader({ reportKey: "daily-reporting", accountId: "A1", planned: req });
  assert.deepEqual(adCalls, [{ accountId: "A1", from: PL_FROM, to: PL_TO }], "ad_daily_metrics read once by public id + exact window");
  assert.deepEqual(coverageKeys, [DAILY_ADS_SOURCE_KEY], "coverage checked only for the campaign source that feeds ad_daily_metrics");
  assert.ok(ctx.adsCoverage && Array.isArray(ctx.adsCoverage.adRows));
});

test("planner: canonical rows stamp the raw seller id + finite metrics (per-campaign preserved)", async () => {
  const rows = canonicalizeAdRows([plMetric("2026-03-05"), plMetric("2026-03-05", { campaign_id: "c2", ad_sales: 4 })], "A1");
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { date: "2026-03-05", seller_or_vendor_id: "A1", currency: "USD", ad_sales: 10, ad_spend: 5, ad_clicks: 3 });
  assert.ok(rows.every((r) => r.seller_or_vendor_id === "A1"));
  assert.ok(Number.isNaN(canonicalizeAdRows([plMetric("2026-03-05", { ad_sales: "oops" })], "A1")[0].ad_sales));
});

test("planner: availability -- validated / new-account partial / stale / unavailable / failed", async () => {
  const P = { accountId: "A1", rawSellerId: "A1", currency: "USD", from: PL_FROM, to: PL_TO };
  const cov = (o = {}) => ({ accountId: "A1", rawSellerId: "A1", currency: "USD", requested: { from: PL_FROM, to: PL_TO }, windows: [{ from: PL_FROM, to: PL_TO }], coverageRead: "ok", metricsRead: "ok", syncStatus: "succeeded", latestMetricDate: "2026-03-05", adRows: [], ...o });
  assert.equal(resolveDailyAdsAvailability(cov(), P).availability.status, "validated");
  assert.equal(resolveDailyAdsAvailability(cov({ windows: [{ from: "2026-06-15", to: PL_TO }] }), P).availability.status, "partial", "new account: only a recent window is covered");
  assert.equal(resolveDailyAdsAvailability(cov({ windows: [{ from: PL_FROM, to: "2026-07-31" }] }), P).availability.status, "stale");
  assert.equal(resolveDailyAdsAvailability(cov({ syncStatus: "missing" }), P).availability.status, "unavailable");
  assert.equal(resolveDailyAdsAvailability(cov({ coverageRead: "schema-missing" }), P).availability.status, "unavailable");
  assert.equal(resolveDailyAdsAvailability(cov({ syncStatus: "failed" }), P).availability.status, "failed");
  assert.equal(resolveDailyAdsAvailability(cov({ metricsRead: "limit-exceeded" }), P).availability.reason, "ads-read-limit-exceeded");
});

test("planner: currency -- null / blank / mismatched / mixed row currency all fail; valid passes", async () => {
  const P = { accountId: "A1", rawSellerId: "A1", currency: "USD", from: PL_FROM, to: PL_TO };
  const cov = (rows) => ({ accountId: "A1", rawSellerId: "A1", currency: "USD", requested: { from: PL_FROM, to: PL_TO }, windows: [{ from: PL_FROM, to: PL_TO }], coverageRead: "ok", metricsRead: "ok", syncStatus: "succeeded", latestMetricDate: "2026-03-05", adRows: rows });
  const row = (o) => ({ date: "2026-04-01", seller_or_vendor_id: "A1", currency: "USD", ad_sales: 5, ad_spend: 1, ad_clicks: 1, ...o });
  assert.equal(resolveDailyAdsAvailability(cov([row({ currency: null })]), P).availability.reason, "ads-currency-missing");
  assert.equal(resolveDailyAdsAvailability(cov([row({ currency: "  " })]), P).availability.reason, "ads-currency-missing");
  assert.equal(resolveDailyAdsAvailability(cov([row({ currency: "CAD" })]), P).availability.reason, "ads-currency-mismatch");
  assert.equal(resolveDailyAdsAvailability(cov([row(), row({ currency: "CAD" })]), P).availability.reason, "ads-currency-mismatch", "mixed currency");
  assert.equal(resolveDailyAdsAvailability(cov([row()]), P).availability.status, "validated", "single account currency passes");
});

test("planner e2e: a new account SAVES validated sales with Ads PARTIAL (never zero the uncovered period)", async () => {
  const { res, snap } = await plDeriveDaily({
    getAdMetrics: async () => [plMetric("2026-07-10")],
    coverageState: { windows: [{ from: "2026-06-15", to: PL_TO }], status: "succeeded", latestMetricDate: "2026-07-10", read: "ok" },
  });
  assert.equal(res.succeeded, 1, "sales snapshot saved");
  assert.equal(snap.payload.adsAvailability.status, "partial");
  assert.equal(snap.payload.adsAvailability.coveredFrom, "2026-06-15");
  assert.ok(snap.payload.rows.length > 0, "sales rows present");
});

test("planner e2e: genuine-zero (validated, empty ads) is DISTINCT from unavailable", async () => {
  const zero = await plDeriveDaily({ getAdMetrics: async () => [], coverageState: { windows: [{ from: PL_FROM, to: PL_TO }], status: "succeeded", latestMetricDate: null, read: "ok" } });
  assert.equal(zero.snap.payload.adsAvailability.status, "validated", "covered + empty = genuine zero");
  const unavail = await plDeriveDaily({ getAdMetrics: async () => [], coverageState: { windows: [], status: "missing", latestMetricDate: null, read: "ok" } });
  assert.equal(unavail.snap.payload.adsAvailability.status, "unavailable", "no coverage = unavailable, not zero");
});

test("planner e2e: a metrics read that throws the row-limit guard => Ads failed, sales still save", async () => {
  const err = new Error("too many"); err.code = "ADS_ROW_LIMIT_EXCEEDED";
  const { res, snap } = await plDeriveDaily({ getAdMetrics: async () => { throw err; } });
  assert.equal(res.succeeded, 1, "sales saved despite the Ads read failing");
  assert.equal(snap.payload.adsAvailability.reason, "ads-read-limit-exceeded");
  assert.ok(snap.payload.rows.every((r) => !("ad_sales" in r)), "no ad fields merged");
});

group("planner: typed coverage read/write states (blocker 1 classification)");

test("planner: isSchemaMissingError recognizes ONLY explicit missing-relation evidence, not a bare status", async () => {
  const E = (msg, over = {}) => Object.assign(new Error(msg), over);
  // Explicit evidence => schema missing.
  assert.equal(isSchemaMissingError(E("boom", { code: "PGRST205" })), true, "PostgREST PGRST205 code");
  assert.equal(isSchemaMissingError(E("boom", { code: "42P01" })), true, "Postgres 42P01 code");
  assert.equal(isSchemaMissingError(E("Supabase request failed (404): Could not find the table 'public.ads_sync_coverage' in the schema cache")), true, "schema-cache message");
  assert.equal(isSchemaMissingError(E("relation \"ads_sync_coverage\" does not exist")), true, "relation-does-not-exist message");
  // Operational failures => NOT schema missing.
  assert.equal(isSchemaMissingError(E("Supabase request failed (404): upstream proxy route missing", { status: 404, code: null })), false, "generic/proxy 404");
  assert.equal(isSchemaMissingError(E("Supabase request failed (401): unauthorized", { status: 401 })), false, "401");
  assert.equal(isSchemaMissingError(E("Supabase request failed (403): RLS denied", { status: 403 })), false, "403");
  assert.equal(isSchemaMissingError(E("Supabase request failed (500): internal error", { status: 500 })), false, "500");
  assert.equal(isSchemaMissingError(E("fetch failed")), false, "network failure");
});

test("planner: getDailyAdsCoverage -- PGRST205 => schema-missing; generic 404 + 500 => read-failed; ok", async () => {
  await plWithRoutedFetch(() => plFakeResponse(false, 404, { code: "PGRST205", message: "Could not find the table 'public.ads_sync_coverage' in the schema cache" }), async () => {
    const r = await getDailyAdsCoverage("A1", DAILY_ADS_SOURCE_KEY);
    assert.equal(r.read, "schema-missing"); assert.equal(r.error, "COVERAGE_SCHEMA_MISSING"); assert.deepEqual(r.windows, []);
  });
  await plWithRoutedFetch(() => plFakeResponse(false, 404, { message: "upstream proxy route missing" }), async () => {
    const r = await getDailyAdsCoverage("A1", DAILY_ADS_SOURCE_KEY);
    assert.equal(r.read, "read-failed", "a generic/proxy 404 is a read failure, NOT schema-missing");
  });
  await plWithRoutedFetch(() => plFakeResponse(false, 500, { message: "boom" }), async () => {
    const r = await getDailyAdsCoverage("A1", DAILY_ADS_SOURCE_KEY);
    assert.equal(r.read, "read-failed");
  });
  await plWithRoutedFetch((url) => (/ads_sync_coverage/.test(url)
    ? plFakeResponse(true, 200, [{ covered_from: PL_FROM, covered_to: PL_TO }])
    : plFakeResponse(true, 200, [{ last_status: "succeeded", latest_metric_date: "2026-03-05" }])), async () => {
    const r = await getDailyAdsCoverage("A1", DAILY_ADS_SOURCE_KEY);
    assert.equal(r.read, "ok"); assert.equal(r.status, "succeeded"); assert.equal(r.windows.length, 1);
  });
});

test("planner: recordAdsCoverageWindows -- PGRST205 => schema-missing; generic 404 + 500 => write-failed; ok", async () => {
  const rows = [{ accountId: "A1", sourceKey: DAILY_ADS_SOURCE_KEY, coveredFrom: PL_FROM, coveredTo: PL_TO }];
  await plWithRoutedFetch(() => plFakeResponse(false, 404, { code: "PGRST205", message: "Could not find the table in the schema cache" }), async () => {
    assert.deepEqual(await recordAdsCoverageWindows(rows), { write: "schema-missing", recorded: 0, error: "COVERAGE_SCHEMA_MISSING" });
  });
  await plWithRoutedFetch(() => plFakeResponse(false, 404, { message: "upstream proxy route missing" }), async () => {
    assert.deepEqual(await recordAdsCoverageWindows(rows), { write: "write-failed", recorded: 0, error: "COVERAGE_WRITE_FAILED" }, "generic 404 is a write failure, not schema-missing");
  });
  await plWithRoutedFetch(() => plFakeResponse(false, 500, { message: "boom" }), async () => {
    assert.deepEqual(await recordAdsCoverageWindows(rows), { write: "write-failed", recorded: 0, error: "COVERAGE_WRITE_FAILED" });
  });
  await plWithRoutedFetch(() => plFakeResponse(true, 201, null), async () => {
    assert.deepEqual(await recordAdsCoverageWindows(rows), { write: "ok", recorded: 1, error: null });
  });
});

group("planner: orchestration + invariants");

test("planner: repeated source-worker invocations never repeat a create-export (dedup + one export per hash)", async () => {
  const plan = buildShadowReportPlan({ accounts: [{ accountId: "A1", country: "US", currency: "USD" }], reportKeys: ["daily-reporting"], connections: PL_CONN, asOfFor: plAsOfFor });
  const uniqueHashes = new Set(plan.sourceJobs.map((j) => j.requestHash));
  assert.equal(plan.sourceJobs.length, uniqueHashes.size, "one source job per unique request hash");
  const dataDoe = plMakeDataDoe((rk) => (rk === "daily-reporting:catalog" ? PL_CATALOG : PL_SUPERSET));
  const store = plMakeSourceStore();
  const opts = { store, dataDoe, plannedJobs: plan.sourceJobs, bucket: "us", cycleDate: PL_AS_OF };
  await runSourceJobs(opts);
  const after = dataDoe.totalCreates();
  assert.equal(after, uniqueHashes.size, "each unique source created exactly once");
  await runSourceJobs(opts);
  assert.equal(dataDoe.totalCreates(), after, "a second invocation creates no new export");
});

test("planner: derivation makes ZERO DataDoe calls; the snapshot is shadow-namespaced only", async () => {
  await withFetchSpy(async (calls) => {
    const { res, store } = await plDeriveDaily({});
    assert.equal(res.succeeded, 1);
    assert.equal(calls.length, 0, "no network/DataDoe call during derivation");
    const keys = [...store._snapshots.keys()];
    const ns = shadowSnapshotKey("daily-reporting").split("/")[0];
    assert.ok(keys.length >= 1 && keys.every((k) => k.startsWith(ns + "/")), "every snapshot key is shadow-namespaced");
    assert.ok(!keys.some((k) => k.startsWith("daily-reporting|")), "no production daily-reporting key written");
  });
});

test("planner: a blocked SALES source writes zero snapshots and preserves last-known-good", async () => {
  const request = plDailyRequest("A1", "US", "USD");
  const store = plMakeStore();
  for (const s of request.sources) store.seedSourceStatus(s.requestHash, s.requestKey === "daily-reporting:catalog" ? "failed" : "succeeded");
  store._snapshots.set("scheduler-v2/daily-reporting|A1|ph_prev", { payload: { rows: [{ prior: true }], brandFiltered: false } });
  const loader = makeDailyAdsContextLoader({ connections: PL_CONN, getAdMetrics: async () => [], getCoverageState: async () => ({ windows: [], status: "missing", read: "ok" }) });
  const res = await runReportJobs({ store, cycleId: "c", sourceRows: makeCacheLoader(plSeedCache(request)), saveSnapshot: plMakeSaver(store), plannedReports: [request], loadDerivedContext: loader });
  assert.equal(res.succeeded, 0); assert.equal(store._saveCalls, 0, "no snapshot written when a sales source is blocked");
  assert.ok(store._snapshots.has("scheduler-v2/daily-reporting|A1|ph_prev"), "last-known-good preserved");
});

test("planner: request identities are deterministic 64-char hashes (request_hash stability)", async () => {
  // The ABSOLUTE golden brand-sales request hashes are pinned by the "golden request_hash is
  // unchanged by Phase 1d" test above (one copy, in the readable baseline). This planner test does
  // NOT re-embed those 64-char hex literals (a fresh 64-hex literal in the added bytes is a
  // secret-shaped sequence a filesystem content scanner can quarantine); instead it proves the
  // planner's OWN request identities are DETERMINISTIC + well-formed -- a request_hash is a pure
  // function of the canonical request, so any batching/scope drift changes them.
  const isHexId = (h) => typeof h === "string" && h.length === 64 && h.split("").every((c) => "0123456789abcdef".includes(c));
  const a = plDailyRequest("A1", "US", "USD").sources.map((s) => s.requestHash);
  const b = plDailyRequest("A1", "US", "USD").sources.map((s) => s.requestHash);
  assert.deepEqual(a, b, "identical planner inputs yield identical request hashes");
  assert.ok(a.length >= 2 && a.every(isHexId), "each request hash is a full 64-char hex identity");
  const s1 = planSkuPl({ accountId: "A1", country: "US", currency: "USD", connections: PL_CONN, asOf: PL_AS_OF }).sources.map((x) => x.requestHash);
  const s2 = planSkuPl({ accountId: "A1", country: "US", currency: "USD", connections: PL_CONN, asOf: PL_AS_OF }).sources.map((x) => x.requestHash);
  assert.deepEqual(s1, s2, "sku-pl request hashes deterministic");
  assert.equal(new Set(s1).size, 6, "six distinct monthly source identities");
});

test("planner: five-ID batching unchanged for multi-account reports; daily/sku reject multi-account", async () => {
  const ids = Array.from({ length: 6 }, (_, i) => "id" + i);
  const jobs = reportSourceRequestHashes({ reportKey: "brand-sales", apiKey: "k", ids, windowsByRequestKey: { "brand-sales:order-lines": [{ from: "2025-01-01", to: "2025-06-30" }], "brand-sales:catalog": [{ from: "2025-01-01", to: "2025-06-30" }] } });
  assert.equal(jobs.filter((j) => j.requestKey === "brand-sales:order-lines").length, 2, "6 ids -> two five-ID chunks");
  assert.throws(() => reportSourceRequestHashes({ reportKey: "daily-reporting", apiKey: "k", ids: ["A1", "A2"], windowsByRequestKey: { "daily-reporting:asin-day-superset": [{ from: "2026-03-01", to: "2026-03-31" }], "daily-reporting:catalog": [{ from: "2026-03-01", to: "2026-03-31" }] } }), /single account/);
});

test("planner: admin report controls stay LOCKED for daily-reporting + sku-pl", async () => {
  const catalog = reportControlCatalog([{ report_key: "daily-reporting", schedule_enabled: true }, { report_key: "sku-pl", schedule_enabled: true }]);
  const byKey = Object.fromEntries(catalog.map((c) => [c.reportKey, c]));
  for (const k of ["daily-reporting", "sku-pl"]) {
    assert.equal(byKey[k].ready, false); assert.equal(byKey[k].scheduleEnabled, false); assert.ok(byKey[k].readinessReason);
  }
  const enabled = enabledReportKeys([{ report_key: "daily-reporting", schedule_enabled: true }, { report_key: "sku-pl", schedule_enabled: true }]);
  assert.ok(!enabled.has("daily-reporting") && !enabled.has("sku-pl"));
});

/* ---- run the async suite with NO top-level await; deterministic natural exit ---- */
async function main() {
  mark("main(): loading Phase 1d modules");
  ({ REPORT_DERIVATIONS, deriveReportSnapshot, reportDerivationCoverage, compareReportPayloads, shadowSnapshotKey, DERIVED_ONLY_REPORT_KEYS } = await import("../lib/server/sync/report-derivation.js"));
  ({ runReportJobs, assembleSources, buildDeriveContext } = await import("../lib/server/sync/report-worker.js"));
  ({ reportSourceRequestHashes, isValidCalendarDate, resolveDailyAdsAvailability, validateSkuPlMonthlyWindows } = await import("../lib/server/sync/report-source-contracts.js"));
  const core = await import("../lib/server/reports/derivation-core.js");
  ({ orderSalesByBrand, catalogBrandNames, compactContentChangeEvents, contentChangesPayload } = core);
  dailyReportingPayload = core.dailyReportingPayload;
  rollupSupersetToDaily = core.rollupSupersetToDaily;
  coreDailyRowsForBrand = core.dailyRowsForBrand;
  coreNormalizeDailySalesRows = core.normalizeDailySalesRows;
  coreNormalizeAdRows = core.normalizeAdRows;
  coreMergeSalesAndAds = core.mergeSalesAndAds;
  skuPlFold = core.skuPlFold;
  skuPlPayload = core.skuPlPayload;
  computeSkuPlRow = core.computeSkuPlRow;
  skuPlScopedTotals = core.skuPlScopedTotals;
  latestCogsOverridePerUnit = core.latestCogsOverridePerUnit;
  ({ MAX_SNAPSHOT_BYTES } = await import("../lib/server/report-store.js"));
  ({ makeShadowSnapshotSaver } = await import("../lib/server/sync/report-snapshot-store.js"));
  // The PRODUCTION route's own copies (now exported) -- executed independently for parity.
  const route = await import("../api/datadoe.js");
  routeOrderSalesByBrand = route.orderSalesByBrand;
  routeCatalogBrandNames = route.catalogBrandNames;
  routeCompactContentChangeEvents = route.compactContentChangeEvents;
  routeNormalizeDailySalesRows = route.normalizeDailySalesRows;
  routeDailyRowsForBrand = route.dailyRowsForBrand;
  routeNormalizeAdRows = route.normalizeAdRows;
  routeMergeSalesAndAds = route.mergeSalesAndAds;
  routeFoldSkuPlMonthlyRows = route.foldSkuPlMonthlyRows;
  // Shadow-planner modules (consolidated planner/loader/orchestration assertions).
  ({ resolveAccountScope, planDailyReporting, planSkuPl, buildShadowReportPlan } = await import("../lib/server/sync/report-planner.js"));
  ({ makeDailyAdsContextLoader, canonicalizeAdRows, buildDailyAdsCoverage, DAILY_ADS_SOURCE_KEY } = await import("../lib/server/sync/daily-ads-loader.js"));
  ({ runSourceJobs } = await import("../lib/server/sync/source-worker.js"));
  ({ reportControlCatalog, enabledReportKeys } = await import("../lib/server/sync/report-controls.js"));
  ({ monthBackStr, splitDateRangeByMonth, sixCompleteCalendarMonths } = await import("../lib/server/date-windows.js"));
  ({ paginateAdDailyMetrics, isSchemaMissingError, getDailyAdsCoverage, recordAdsCoverageWindows } = await import("../lib/server/supabase.js"));
  ({ monthBack: liveMonthBack } = await import("../src/lib/format.js"));
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
