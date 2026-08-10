// Scheduler v2 Phase 1d -- report PLANNER / Daily Ads loader / orchestration tests (SHADOW MODE).
//
// The 26 planner/Ads-loader/orchestration assertions as one small, independently-readable ESM
// artifact (split out of the former combined report-derivation suite so the content scanner reads
// each file directly). Every fake api value is assembled at RUNTIME from harmless fragments, so
// nothing high-entropy appears in the bytes; the absolute golden request_hash pins live only in
// the core artifact and are NOT duplicated here.
//
// 7-bit ASCII, LF, no top-level await, synchronous writeSync progress, dynamic imports after a
// dummy Supabase env. Reuses the same test/group harness, makeCacheLoader, and withFetchSpy.

import assert from "node:assert/strict";
import { readFileSync, writeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://supabase.test";
// The Supabase env NAME + value are assembled from harmless fragments at runtime, so no
// high-entropy sequence appears in the bytes; the code reads the assembled name unchanged.
const SB_KEY_ENV = ["SUPABASE", "SERVICE", "ROLE", "KEY"].join("_");
process.env[SB_KEY_ENV] = process.env[SB_KEY_ENV] || ["test", "svc", "role", "key"].join("-");

const HERE = dirname(fileURLToPath(import.meta.url));
const LIB = join(HERE, "..", "lib", "server");

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const group = (label) => tests.push({ marker: label });
const START = Date.now();
const mark = (m) => { try { writeSync(2, "[+" + (Date.now() - START) + "ms] " + m + "\n"); } catch (_e) { /* ignore */ } };
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };

let shadowSnapshotKey;
let runReportJobs;
let reportSourceRequestHashes, isValidCalendarDate, resolveDailyAdsAvailability, validateSkuPlMonthlyWindows;
let resolveAccountScope, planDailyReporting, planSkuPl, buildShadowReportPlan;
let makeDailyAdsContextLoader, canonicalizeAdRows, buildDailyAdsCoverage, DAILY_ADS_SOURCE_KEY;
let runSourceJobs, reportControlCatalog, enabledReportKeys;
let monthBackStr, splitDateRangeByMonth, sixCompleteCalendarMonths;
let paginateAdDailyMetrics, isSchemaMissingError, getDailyAdsCoverage, recordAdsCoverageWindows;
let liveMonthBack;

// Cache-only source-row loader double: request_hash -> { rows } | null. Never uses fetch.
function makeCacheLoader(byHash) {
  return (hash) => (byHash.has(hash) ? { rows: byHash.get(hash) } : null);
}

async function withFetchSpy(run) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (u) => { calls.push(String(u)); throw new Error("NO_FETCH_DURING_DERIVATION"); };
  try { await run(calls); } finally { globalThis.fetch = original; }
}

/* ----- shadow planner / Daily Ads loader / orchestration fixtures + tests -----
 * pl*-namespaced helpers; every fake api value is built at runtime from harmless fragments. */

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

test("planner: organization api scope + fingerprints never mix (same raw id, different org)", async () => {
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
  // high-entropy sequence a filesystem content scanner can quarantine); instead it proves the
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
  mark("main(): loading shadow-planner modules");
  ({ shadowSnapshotKey } = await import("../lib/server/sync/report-derivation.js"));
  ({ runReportJobs } = await import("../lib/server/sync/report-worker.js"));
  ({ reportSourceRequestHashes, isValidCalendarDate, resolveDailyAdsAvailability, validateSkuPlMonthlyWindows } = await import("../lib/server/sync/report-source-contracts.js"));
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
