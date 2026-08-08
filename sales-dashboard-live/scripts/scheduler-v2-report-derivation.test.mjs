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
import { dirname, join } from "node:path";

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
let runReportJobs, assembleSources;
let reportSourceRequestHashes, isValidCalendarDate;
let makeShadowSnapshotSaver;
// Leaf (Scheduler v2) pure cores.
let orderSalesByBrand, catalogBrandNames, compactContentChangeEvents, contentChangesPayload;
// PRODUCTION route copies (api/datadoe.js) -- for the INDEPENDENT parity harness.
let routeOrderSalesByBrand, routeCatalogBrandNames, routeCompactContentChangeEvents;
let MAX_SNAPSHOT_BYTES;

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

/* ---- run the async suite with NO top-level await; deterministic natural exit ---- */
async function main() {
  mark("main(): loading Phase 1d modules");
  ({ REPORT_DERIVATIONS, deriveReportSnapshot, reportDerivationCoverage, compareReportPayloads, shadowSnapshotKey, DERIVED_ONLY_REPORT_KEYS } = await import("../lib/server/sync/report-derivation.js"));
  ({ runReportJobs, assembleSources } = await import("../lib/server/sync/report-worker.js"));
  ({ reportSourceRequestHashes, isValidCalendarDate } = await import("../lib/server/sync/report-source-contracts.js"));
  ({ orderSalesByBrand, catalogBrandNames, compactContentChangeEvents, contentChangesPayload } = await import("../lib/server/reports/derivation-core.js"));
  ({ MAX_SNAPSHOT_BYTES } = await import("../lib/server/report-store.js"));
  ({ makeShadowSnapshotSaver } = await import("../lib/server/sync/report-snapshot-store.js"));
  // The PRODUCTION route's own copies (now exported) -- executed independently for parity.
  const route = await import("../api/datadoe.js");
  routeOrderSalesByBrand = route.orderSalesByBrand;
  routeCatalogBrandNames = route.catalogBrandNames;
  routeCompactContentChangeEvents = route.compactContentChangeEvents;
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
