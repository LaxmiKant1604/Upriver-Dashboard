// Scheduler v2 -- production-shape tests for the Daily Reporting + SKU P&L SHADOW planner, the
// Daily Ads derived-context loader, and their wiring into the source + report workers.
//
// Conventions match the other scheduler-v2 suites: 7-bit ASCII, LF, no top-level await, synchronous
// fs.writeSync progress, dynamic imports after a dummy Supabase env is set. No secret-shaped literals.
//
// Covers the 18 requirements: primary/dd-secondary public+raw ids, org isolation, ad_daily_metrics
// (not overlapping raw Ads tables), canonical rows, genuine zero, missing/stale/partial/failed
// coverage blocks, cross-account/out-of-window/malformed/non-finite/mixed-currency blocks, exactly
// six SKU months, month-set failures block, no repeated create-export, zero DataDoe in derivation,
// zero snapshot writes on invalid input, golden request_hash unchanged, five-ID batching unchanged,
// controls locked.

import assert from "node:assert/strict";
import { writeSync } from "node:fs";

process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://supabase.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ["test", "svc", "role", "key"].join("-");

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const group = (label) => tests.push({ marker: label });
const START = Date.now();
const mark = (m) => { try { writeSync(2, "[+" + (Date.now() - START) + "ms] " + m + "\n"); } catch (_e) { /* ignore */ } };
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };

// Bindings assigned in main() after the dummy env is set.
let resolveAccountScope, planDailyReporting, planSkuPl, buildShadowReportPlan, SHADOW_PLANNED_REPORT_KEYS;
let makeDailyAdsContextLoader, canonicalizeAdRows, adsCoveredThrough, buildDailyAdsCoverage, DAILY_ADS_SOURCE_KEY;
let reportSourceRequestHashes, evaluateDailyAdsCoverage, validateSkuPlMonthlyWindows;
let runReportJobs, runSourceJobs, REPORT_DERIVATIONS, shadowSnapshotKey;
let reportControlCatalog, enabledReportKeys;
let splitDateRangeByMonth, monthStartStr, addDaysStr, sixCompleteCalendarMonths;

// Two authoritative organizations (primary + dd-secondary), the exact shape getDataDoeConnections
// returns. The raw seller id is what resolveDataDoeAccountIds derives from the public account id.
const CONN = [
  { id: "primary", apiKey: "PRIMARY_ORG_KEY", accountPrefix: "" },
  { id: "secondary", apiKey: "SECONDARY_ORG_KEY", accountPrefix: "dd-secondary:" },
];
const AS_OF = "2026-08-10";
const asOfFor = () => AS_OF;

/* ------------------------------- in-memory doubles ------------------------------- */

// Report-job + snapshot store double (mirrors supabase.js report wrappers).
function makeReportStore() {
  const reportJobs = new Map();
  const snapshots = new Map();
  const sourceJobs = [];
  const key = (rk, acct) => `${rk}|${acct}`;
  return {
    _snapshots: snapshots, _saveCalls: 0, failSaveFor: new Set(), lastSuccess: null,
    writes: { blocked: 0, failure: 0, success: 0 },
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
    claimReportDerive(_cid, rk, acct) {
      const j = reportJobs.get(key(rk, acct));
      if (j && j.derive_status === "pending") { j.derive_status = "running"; return true; }
      return false;
    },
    recordReportBlocked({ reportKey, accountId, reason }) {
      this.writes.blocked += 1;
      Object.assign(reportJobs.get(key(reportKey, accountId)), { fetch_status: "blocked", derive_status: "skipped", save_status: "skipped", validated: false, error_stage: "fetch", error_code: "SOURCE_BLOCKED", error_message: reason });
    },
    recordReportFailure({ reportKey, accountId, stage, code, message, terminal }) {
      this.writes.failure += 1;
      const j = reportJobs.get(key(reportKey, accountId));
      const body = { error_stage: stage, error_code: code, error_message: message, terminal: !!terminal };
      if (stage === "save") { body.derive_status = "succeeded"; body.save_status = "failed"; } else body.derive_status = "failed";
      Object.assign(j, body);
    },
    recordReportSuccess(args) {
      this.writes.success += 1; this.lastSuccess = args;
      const { reportKey, accountId, latestDataDate, rowCount, snapshotParamsHash } = args;
      Object.assign(reportJobs.get(key(reportKey, accountId)), { fetch_status: "ready", derive_status: "succeeded", save_status: "succeeded", validated: true, latest_data_date: latestDataDate, row_count: rowCount, snapshot_params_hash: snapshotParamsHash, last_good_snapshot_at: "t", error_stage: null, error_code: null, error_message: null });
    },
  };
}

function makeSnapshotSaver(store) {
  return async ({ reportKey, accountId, params, payload }) => {
    store._saveCalls += 1;
    const productionKey = reportKey.split("/").slice(1).join("/") || reportKey;
    if (store.failSaveFor.has(productionKey)) throw new Error("snapshot save failed (503)");
    const paramsHash = `ph_${JSON.stringify(params).length}`;
    store._snapshots.set(`${reportKey}|${accountId}|${paramsHash}`, { payload, params });
    return { paramsHash };
  };
}

const cacheLoader = (byHash) => (hash) => (byHash.has(hash) ? { rows: byHash.get(hash) } : null);

// Source-job worker store double (mirrors sync_source_jobs + source cache).
function makeSourceStore() {
  const cycles = new Map();
  const jobsByCycle = new Map();
  const cache = new Map();
  let seq = 0;
  const findCycle = (id) => [...cycles.values()].find((c) => c.id === id) || null;
  return {
    _cache: cache,
    openCycle({ bucket, cycleDate }) {
      const k = `${bucket}|${cycleDate}`;
      if (!cycles.has(k)) { const id = `cyc_${++seq}`; cycles.set(k, { id, status: "pending" }); jobsByCycle.set(id, new Map()); }
      return cycles.get(k).id;
    },
    claimCycle(id) { const c = findCycle(id); if (c && c.status === "pending") { c.status = "running"; return true; } return false; },
    getCycle(id) { return findCycle(id); },
    upsertSourceJob(job) {
      const m = jobsByCycle.get(job.cycleId);
      if (m.has(job.requestHash)) return;
      m.set(job.requestHash, { request_hash: job.requestHash, source_id: job.sourceId, source_key: job.sourceKey, connection_id: job.connectionId, fetch_status: "pending", attempted_at: null, export_id: null });
    },
    listSourceJobs(id) { return [...(jobsByCycle.get(id)?.values() || [])].map((j) => ({ ...j })); },
    claimExportAttempt(id, hash) {
      const j = jobsByCycle.get(id)?.get(hash);
      if (j && j.attempted_at === null) { j.attempted_at = "t"; j.fetch_status = "attempted"; return true; }
      return false;
    },
    recordExportCreated({ cycleId, requestHash, exportId }) { jobsByCycle.get(cycleId).get(requestHash).export_id = exportId; },
    saveSourceRows({ job, rows, version }) { const hash = job.request_hash ?? job.requestHash; cache.set(hash, { rows: [...rows] }); return `cache/${hash}/${version}.json`; },
    recordSourceSuccess({ cycleId, requestHash, rowCount, cacheObjectPath }) { Object.assign(jobsByCycle.get(cycleId).get(requestHash), { fetch_status: "succeeded", row_count: rowCount, cache_object_path: cacheObjectPath }); },
    recordSourceFailure({ cycleId, requestHash, code }) { Object.assign(jobsByCycle.get(cycleId).get(requestHash), { fetch_status: "failed", error_code: code }); },
    updateCycleCounts() {},
  };
}

// DataDoe fake: returns rows per requestKey. Counts create-export POSTs per request_hash.
function makeDataDoe(rowsForKey) {
  const creates = {};
  return {
    totalCreates: () => Object.values(creates).reduce((a, b) => a + b, 0),
    createCount: (h) => creates[h] || 0,
    async create(job) { creates[job.requestHash] = (creates[job.requestHash] || 0) + 1; return { exportId: `exp_${job.requestHash}` }; },
    async poll() {},
    async download(job) { return rowsForKey(job.requestKey || job.request_key || "", job) || []; },
  };
}

const withFetchSpy = async (run) => {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (u) => { calls.push(String(u)); throw new Error("NO_FETCH_DURING_DERIVATION"); };
  try { await run(calls); } finally { globalThis.fetch = original; }
};

// A valid Daily plan for account A1 (primary) + a matching cache of superset/catalog rows.
const DR_SUPERSET = [
  { date: "2026-03-05", seller_or_vendor_id: "A1", child_asin: "ASIN000001", total_sales_sum: 100, total_units_sum: 4 },
  { date: "2026-03-06", seller_or_vendor_id: "A1", child_asin: "ASIN000002", total_sales_sum: 50, total_units_sum: 2 },
];
const DR_CATALOG = [{ child_asin: "ASIN000001", product_brand: "Acme" }, { child_asin: "ASIN000002", product_brand: "Beta" }];
const AD_METRIC_ROWS = [
  { metric_date: "2026-03-05", currency: "USD", ad_sales: 10, ad_spend: 5, ad_clicks: 3 },
  { metric_date: "2026-03-05", currency: "USD", ad_sales: 4, ad_spend: 2, ad_clicks: 1 }, // 2nd campaign, same day
];

function dailyRequestFor(accountId, country) {
  return planDailyReporting({ accountId, country, connections: CONN, asOf: AS_OF });
}
// Seed a cache keyed by the plan's ACTUAL request hashes: superset rows in the first monthly
// fragment, [] in the rest; catalog rows in the catalog source.
function seedDailyCache(request) {
  const byHash = new Map();
  let firstSuperset = true;
  for (const s of request.sources) {
    if (s.requestKey === "daily-reporting:asin-day-superset") { byHash.set(s.requestHash, firstSuperset ? DR_SUPERSET : []); firstSuperset = false; }
    else if (s.requestKey === "daily-reporting:catalog") byHash.set(s.requestHash, DR_CATALOG);
  }
  return byHash;
}
const fullCoverageState = (from, to) => ({ windows: [{ from, to }], status: "succeeded", latestMetricDate: "2026-03-05" });
function dailyLoader(over = {}) {
  return makeDailyAdsContextLoader({
    connections: CONN,
    getAdMetrics: over.getAdMetrics || (async () => AD_METRIC_ROWS),
    getCoverageState: over.getCoverageState || (async (_id, _sk) => fullCoverageState(over.covFrom || "2026-03-04", over.covTo || AS_OF)),
  });
}

/* ============================= 1-3: primary/secondary ids + org isolation ============================= */

group("planner: authoritative account scope + organization isolation");

test("R1: primary planning uses the correct public and raw ids (public == raw for primary)", async () => {
  const scope = resolveAccountScope({ accountId: "A1", country: "US", connections: CONN });
  assert.equal(scope.accountId, "A1"); assert.equal(scope.rawSellerId, "A1");
  assert.equal(scope.connectionId, "primary"); assert.equal(scope.bucket, "us");
  const req = dailyRequestFor("A1", "US");
  assert.equal(req.accountId, "A1"); assert.equal(req.context.rawSellerId, "A1");
  assert.ok(req.sources.every((s) => s.sellerOrVendorIds.length === 1 && s.sellerOrVendorIds[0] === "A1"));
  assert.ok(req.sources.every((s) => s.connectionId === "primary"));
});

test("R2: dd-secondary planning uses the prefixed public id but the raw DataDoe seller id", async () => {
  const scope = resolveAccountScope({ accountId: "dd-secondary:B9", country: "CA", connections: CONN });
  assert.equal(scope.accountId, "dd-secondary:B9", "public id keeps the dd-secondary prefix");
  assert.equal(scope.rawSellerId, "B9", "raw seller id is the un-prefixed DataDoe id");
  assert.equal(scope.connectionId, "secondary"); assert.equal(scope.bucket, "non-us");
  const req = planSkuPl({ accountId: "dd-secondary:B9", country: "CA", connections: CONN, asOf: AS_OF });
  assert.equal(req.accountId, "dd-secondary:B9");
  assert.equal(req.context.rawSellerId, "B9");
  assert.deepEqual([...new Set(req.sources.flatMap((s) => s.sellerOrVendorIds))], ["B9"], "every fragment carries only the raw seller id");
});

test("R3: organization credentials + fingerprints never mix (same raw id, different org => different hash/fingerprint)", async () => {
  // The SAME raw id "A1" under primary vs dd-secondary must resolve to distinct request identities.
  const pri = dailyRequestFor("A1", "US");
  const sec = dailyRequestFor("dd-secondary:A1", "US");
  const priH = pri.sources.map((s) => s.requestHash).sort();
  const secH = sec.sources.map((s) => s.requestHash).sort();
  assert.ok(priH.every((h, i) => h !== secH[i]), "no request hash is shared across organizations");
  const priFp = new Set(pri.sources.map((s) => s.organizationFingerprint));
  const secFp = new Set(sec.sources.map((s) => s.organizationFingerprint));
  assert.equal(priFp.size, 1); assert.equal(secFp.size, 1);
  assert.notEqual([...priFp][0], [...secFp][0], "organization fingerprints differ");
  // A cross-org shadow plan never dedups a source across organizations.
  const plan = buildShadowReportPlan({ accounts: [{ accountId: "A1", country: "US" }, { accountId: "dd-secondary:A1", country: "US" }], reportKeys: ["daily-reporting"], connections: CONN, asOfFor });
  const orgs = new Set(plan.sourceJobs.map((j) => j.connectionId));
  assert.deepEqual([...orgs].sort(), ["primary", "secondary"]);
  assert.equal(plan.sourceJobs.length, pri.sources.length + sec.sources.length, "no cross-org source-job collapse");
});

/* ============================= daily exact windows + ALL only ============================= */

group("planner: daily exact source windows + ALL-brand only");

test("daily plan emits the exact contract windows: monthly superset fragments + one catalog range; no extra ads/sales export", async () => {
  const req = dailyRequestFor("A1", "US");
  const from = addDaysStr(monthStartStr(AS_OF), -150), to = AS_OF;
  const expectedMonths = splitDateRangeByMonth(from, to);
  const superset = req.sources.filter((s) => s.requestKey === "daily-reporting:asin-day-superset");
  const catalog = req.sources.filter((s) => s.requestKey === "daily-reporting:catalog");
  assert.deepEqual(superset.map((s) => ({ from: s.from, to: s.to })), expectedMonths, "one superset fragment per calendar month over monthStart(asOf)-150..asOf");
  assert.equal(catalog.length, 1);
  assert.deepEqual({ from: catalog[0].from, to: catalog[0].to }, { from, to }, "catalog is a single range over the same span");
  // ONLY these two source keys -- no separate Daily sales export, no owned Ads export.
  assert.deepEqual([...new Set(req.sources.map((s) => s.requestKey))].sort(), ["daily-reporting:asin-day-superset", "daily-reporting:catalog"]);
  assert.equal(req.context.brand, "ALL", "this tranche derives only the ALL-brand snapshot");
});

/* ============================= 10-11: SKU six months ============================= */

group("planner: SKU P&L exactly six complete consecutive months");

test("R10: SKU plan produces exactly six single-account monthly jobs matching context.from/to", async () => {
  const req = planSkuPl({ accountId: "A1", country: "US", connections: CONN, asOf: AS_OF });
  const frags = req.sources.filter((s) => s.requestKey === "sku-pl:monthly-profit");
  assert.equal(frags.length, 6, "exactly six monthly fragments");
  assert.equal(req.sources.length, 6, "no other source (no catalog) for sku-pl");
  // The planner output passes the strict production validator by construction.
  const check = validateSkuPlMonthlyWindows({ from: req.context.from, to: req.context.to, windows: frags.map((f) => ({ from: f.from, to: f.to, sellerOrVendorIds: f.sellerOrVendorIds })) });
  assert.equal(check.ok, true, "planned months satisfy the six-complete-month contract: " + JSON.stringify(check));
  assert.equal(req.context.from, frags[0].from); assert.equal(req.context.to, frags[5].to);
});

test("R11: a duplicate/missing/reordered/partial month set fails the same validator the derive uses", async () => {
  const req = planSkuPl({ accountId: "A1", country: "US", connections: CONN, asOf: AS_OF });
  const good = req.sources.map((f) => ({ from: f.from, to: f.to, sellerOrVendorIds: ["A1"] }));
  const v = (windows) => validateSkuPlMonthlyWindows({ from: req.context.from, to: req.context.to, windows });
  assert.equal(v([good[0], ...good]).ok, false, "duplicate month (seven fragments) blocked");
  assert.equal(v(good.slice(0, 5)).ok, false, "missing month blocked");
  assert.equal(v([good[1], good[0], ...good.slice(2)]).ok, false, "reordered months blocked");
  assert.equal(v([{ from: good[0].from, to: addDaysStr(good[0].from, 5), sellerOrVendorIds: ["A1"] }, ...good.slice(1)]).ok, false, "partial first month blocked");
});

/* ============================= 4-5: ad_daily_metrics + canonical rows ============================= */

group("daily ads loader: ad_daily_metrics parity + canonical rows");

test("R4: the loader reads ad_daily_metrics ONLY (no overlapping raw campaign/ASIN/targeting/search-term sums)", async () => {
  const req = dailyRequestFor("A1", "US");
  const adCalls = [];
  const otherAdsReads = [];
  const loader = makeDailyAdsContextLoader({
    connections: CONN,
    getAdMetrics: async (accountId, from, to) => { adCalls.push({ accountId, from, to }); return AD_METRIC_ROWS; },
    getCoverageState: async (_id, sk) => { otherAdsReads.push(sk); return fullCoverageState("2026-03-04", AS_OF); },
  });
  const ctx = await loader({ reportKey: "daily-reporting", accountId: "A1", planned: req });
  assert.equal(adCalls.length, 1, "ad_daily_metrics read exactly once");
  assert.deepEqual(adCalls[0], { accountId: "A1", from: req.context.from, to: req.context.to }, "read by public account id + exact window");
  assert.deepEqual(otherAdsReads, [DAILY_ADS_SOURCE_KEY], "coverage checked only for the campaign source that feeds ad_daily_metrics");
  assert.ok(ctx.adsCoverage && Array.isArray(ctx.adsCoverage.adRows));
});

test("R5: ad_daily_metrics rows canonicalize to the raw seller id + finite metrics (per-campaign preserved)", async () => {
  const rows = canonicalizeAdRows(AD_METRIC_ROWS, "A1");
  assert.equal(rows.length, 2, "each campaign row preserved (the merge sums them per seller/day)");
  assert.deepEqual(rows[0], { date: "2026-03-05", seller_or_vendor_id: "A1", currency: "USD", ad_sales: 10, ad_spend: 5, ad_clicks: 3 });
  assert.ok(rows.every((r) => r.seller_or_vendor_id === "A1"), "stamped with the AUTHORITATIVE raw seller id, never a row value");
  // A non-finite source metric becomes NaN so the coverage validator blocks it (never coerced to 0).
  const bad = canonicalizeAdRows([{ metric_date: "2026-03-05", currency: "USD", ad_sales: "oops", ad_spend: 1, ad_clicks: 1 }], "A1");
  assert.ok(Number.isNaN(bad[0].ad_sales));
});

test("adsCoveredThrough: contiguous coverage from `from`; gaps and shortfalls detected", async () => {
  assert.equal(adsCoveredThrough([{ from: "2026-03-04", to: "2026-08-10" }], "2026-03-04", "2026-08-10"), "2026-08-10", "full window covered");
  assert.equal(adsCoveredThrough([{ from: "2026-03-04", to: "2026-06-30" }, { from: "2026-07-01", to: "2026-08-10" }], "2026-03-04", "2026-08-10"), "2026-08-10", "adjacent windows join");
  assert.equal(adsCoveredThrough([{ from: "2026-03-04", to: "2026-06-15" }], "2026-03-04", "2026-08-10"), "2026-06-15", "shortfall => covered end < to");
  assert.equal(adsCoveredThrough([{ from: "2026-04-01", to: "2026-08-10" }], "2026-03-04", "2026-08-10"), null, "start gap => not covered");
  assert.equal(adsCoveredThrough([{ from: "2026-03-04", to: "2026-05-01" }, { from: "2026-06-01", to: "2026-08-10" }], "2026-03-04", "2026-08-10"), "2026-05-01", "internal gap stops coverage");
});

/* ============================= 6-9: coverage acceptance / blocking ============================= */

group("daily ads loader: genuine zero, coverage blocks, row blocks, mixed currency");

// Derive one Daily snapshot end-to-end from a seeded source cache + an injected ads loader.
async function deriveDaily({ adMetrics, coverageState, seedPrev }) {
  const req = dailyRequestFor("A1", "US");
  const store = makeReportStore();
  for (const s of req.sources) store.seedSourceStatus(s.requestHash, "succeeded");
  if (seedPrev) store._snapshots.set("scheduler-v2/daily-reporting|A1|ph_prev", { payload: { rows: [{ prior: true }], brandFiltered: false } });
  const loader = makeDailyAdsContextLoader({
    connections: CONN,
    getAdMetrics: async () => (adMetrics === undefined ? AD_METRIC_ROWS : adMetrics),
    getCoverageState: async () => coverageState,
  });
  const res = await runReportJobs({ store, cycleId: "c", sourceRows: cacheLoader(seedDailyCache(req)), saveSnapshot: makeSnapshotSaver(store), plannedReports: [req], loadDerivedContext: loader });
  return { req, store, res };
}

test("R6: genuine zero -- validated, fully covered, empty ads -> a real snapshot with zero ads", async () => {
  const { store, res } = await deriveDaily({ adMetrics: [], coverageState: { windows: [{ from: "2026-03-04", to: AS_OF }], status: "succeeded", latestMetricDate: null } });
  assert.equal(res.succeeded, 1, "validated fully-covered empty ads is a genuine zero snapshot");
  assert.equal(store._report("daily-reporting", "A1").validated, true);
  const snap = [...store._snapshots.values()].find((s) => s.payload.brandFiltered === false);
  assert.ok(snap, "ALL-brand snapshot saved");
});

test("R7: missing / failed / stale / partial coverage BLOCKS and preserves last-known-good (zero writes)", async () => {
  const cases = [
    { label: "missing", coverageState: { windows: [], status: "missing", latestMetricDate: null } },
    { label: "failed", coverageState: { windows: [{ from: "2026-03-04", to: AS_OF }], status: "failed", latestMetricDate: "2026-03-05" } },
    { label: "stale", coverageState: { windows: [{ from: "2026-03-04", to: "2026-06-15" }], status: "succeeded", latestMetricDate: "2026-03-05" } },
    { label: "partial", coverageState: { windows: [{ from: "2026-04-01", to: AS_OF }], status: "succeeded", latestMetricDate: "2026-03-05" } },
  ];
  for (const c of cases) {
    const { store, res } = await deriveDaily({ coverageState: c.coverageState, seedPrev: true });
    assert.equal(res.succeeded, 0, `${c.label} coverage blocks`);
    assert.equal(store._saveCalls, 0, `${c.label}: zero snapshot writes`);
    assert.equal(store._report("daily-reporting", "A1").error_code, "DERIVE_INVALID");
    assert.ok(store._snapshots.has("scheduler-v2/daily-reporting|A1|ph_prev"), `${c.label}: last-known-good preserved`);
  }
});

test("R8: cross-account / out-of-window / non-finite ad rows BLOCK the snapshot (zero writes, LKG)", async () => {
  const cov = { windows: [{ from: "2026-03-04", to: AS_OF }], status: "succeeded", latestMetricDate: "2026-03-05" };
  const cases = [
    { label: "cross-account (row seller mismatch would fail canonical raw stamp) -- use out-of-window", ads: [{ metric_date: "2026-01-01", currency: "USD", ad_sales: 5, ad_spend: 5, ad_clicks: 5 }] },
    { label: "out-of-window", ads: [{ metric_date: "2027-01-01", currency: "USD", ad_sales: 5, ad_spend: 5, ad_clicks: 5 }] },
    { label: "non-finite", ads: [{ metric_date: "2026-03-05", currency: "USD", ad_sales: "NaNish", ad_spend: 1, ad_clicks: 1 }] },
  ];
  for (const c of cases) {
    const { store, res } = await deriveDaily({ adMetrics: c.ads, coverageState: cov, seedPrev: true });
    assert.equal(res.succeeded, 0, `${c.label} blocks`);
    assert.equal(store._saveCalls, 0, `${c.label}: zero writes`);
    assert.ok(store._snapshots.has("scheduler-v2/daily-reporting|A1|ph_prev"), `${c.label}: LKG preserved`);
  }
});

test("R8b: a directly-injected cross-account raw seller row is blocked by evaluateDailyAdsCoverage", async () => {
  const planned = { accountId: "A1", rawSellerId: "A1", from: "2026-03-04", to: AS_OF };
  const cov = { accountId: "A1", rawSellerId: "A1", requested: { from: "2026-03-04", to: AS_OF }, coverage: { from: "2026-03-04", to: AS_OF }, validated: true, latestMetricDate: "2026-03-05", requiredSourceStatus: "succeeded", adRows: [{ date: "2026-03-05", seller_or_vendor_id: "B9", currency: "USD", ad_sales: 1, ad_spend: 1, ad_clicks: 1 }] };
  assert.deepEqual(evaluateDailyAdsCoverage(cov, planned), { ok: false, status: "ads-row-cross-account", adRows: [] });
});

test("R9: mixed / unusable currency fails safely (block, zero writes, LKG)", async () => {
  const cov = { windows: [{ from: "2026-03-04", to: AS_OF }], status: "succeeded", latestMetricDate: "2026-03-05" };
  const mixed = [
    { metric_date: "2026-03-05", currency: "USD", ad_sales: 10, ad_spend: 5, ad_clicks: 3 },
    { metric_date: "2026-03-06", currency: "CAD", ad_sales: 7, ad_spend: 2, ad_clicks: 1 },
  ];
  const { store, res } = await deriveDaily({ adMetrics: mixed, coverageState: cov, seedPrev: true });
  assert.equal(res.succeeded, 0, "two currencies cannot be summed => block");
  assert.equal(store._saveCalls, 0);
  assert.ok(store._snapshots.has("scheduler-v2/daily-reporting|A1|ph_prev"));
  // Direct evaluator status.
  const planned = { accountId: "A1", rawSellerId: "A1", from: "2026-03-04", to: AS_OF };
  const covObj = { accountId: "A1", rawSellerId: "A1", requested: { from: "2026-03-04", to: AS_OF }, coverage: { from: "2026-03-04", to: AS_OF }, validated: true, latestMetricDate: "2026-03-05", requiredSourceStatus: "succeeded", adRows: canonicalizeAdRows(mixed, "A1") };
  assert.equal(evaluateDailyAdsCoverage(covObj, planned).status, "ads-mixed-currency");
});

/* ============================= 12-14: orchestration wiring ============================= */

group("orchestration: create-once, zero-fetch derivation, zero-write on invalid");

test("R12: repeated source-worker invocations never repeat a DataDoe create-export", async () => {
  const req = dailyRequestFor("A1", "US");
  const plan = buildShadowReportPlan({ accounts: [{ accountId: "A1", country: "US" }], reportKeys: ["daily-reporting"], connections: CONN, asOfFor });
  const uniqueHashes = new Set(plan.sourceJobs.map((j) => j.requestHash));
  assert.equal(plan.sourceJobs.length, uniqueHashes.size, "one source job per unique request hash (dedup)");
  const dataDoe = makeDataDoe((requestKey) => (requestKey === "daily-reporting:catalog" ? DR_CATALOG : DR_SUPERSET));
  const store = makeSourceStore();
  const opts = { store, dataDoe, plannedJobs: plan.sourceJobs, bucket: "us", cycleDate: "2026-08-10" };
  await runSourceJobs(opts);
  const createsAfterFirst = dataDoe.totalCreates();
  assert.equal(createsAfterFirst, uniqueHashes.size, "each unique source created exactly once");
  await runSourceJobs(opts); // resume same cycle
  assert.equal(dataDoe.totalCreates(), createsAfterFirst, "a second invocation creates NO new export");
  assert.ok([...uniqueHashes].every((h) => dataDoe.createCount(h) === 1), "no request hash was created twice");
});

test("R13/R14: derivation makes ZERO DataDoe calls; an invalid ads coverage writes ZERO snapshots (LKG preserved)", async () => {
  await withFetchSpy(async (calls) => {
    // Valid path: zero fetches, snapshot saved.
    const okRun = await deriveDaily({ coverageState: { windows: [{ from: "2026-03-04", to: AS_OF }], status: "succeeded", latestMetricDate: "2026-03-05" } });
    assert.equal(okRun.res.succeeded, 1);
    assert.equal(calls.length, 0, "no network/DataDoe call during derivation");
    // Invalid path: blocked coverage => zero saveSnapshot calls, previous snapshot preserved.
    const badRun = await deriveDaily({ coverageState: { windows: [], status: "missing", latestMetricDate: null }, seedPrev: true });
    assert.equal(badRun.res.succeeded, 0);
    assert.equal(badRun.store._saveCalls, 0, "invalid derivation performs zero snapshot writes");
    assert.equal(calls.length, 0, "still zero DataDoe calls");
  });
});

test("shadow keys only: the saved snapshot is namespaced scheduler-v2/, never a production report key", async () => {
  const { store } = await deriveDaily({ coverageState: { windows: [{ from: "2026-03-04", to: AS_OF }], status: "succeeded", latestMetricDate: "2026-03-05" } });
  const keys = [...store._snapshots.keys()];
  assert.ok(keys.length >= 1 && keys.every((k) => k.startsWith(shadowSnapshotKey("daily-reporting").split("/")[0] + "/")), "every snapshot key is shadow-namespaced");
  assert.ok(!keys.some((k) => k.startsWith("daily-reporting|")), "no production daily-reporting key written");
});

/* ============================= 15-17: golden hash, batching, controls ============================= */

group("invariants: golden request_hash, five-ID batching, locked controls");

test("R15: golden brand-sales request_hash is unchanged by this tranche", async () => {
  const jobs = reportSourceRequestHashes({
    reportKey: "brand-sales", apiKey: "PIN_KEY", ids: ["A1"],
    windowsByRequestKey: { "brand-sales:order-lines": [{ from: "2025-01-01", to: "2025-06-30" }], "brand-sales:catalog": [{ from: "2025-01-01", to: "2025-06-30" }] },
  });
  const byKey = Object.fromEntries(jobs.map((j) => [j.requestKey, j.requestHash]));
  assert.equal(byKey["brand-sales:order-lines"], "e498a48016d990b9835d177064d25256c63dff40f8cdf69ddbcd221035247456");
  assert.equal(byKey["brand-sales:catalog"], "936e6d1ba2eb377c503b0fda56263a5274dc63943d08e360e35f0ac7f9ec7014");
});

test("R15b: the planner is deterministic -- the same account/asOf yields identical request hashes", async () => {
  const a = dailyRequestFor("A1", "US").sources.map((s) => s.requestHash);
  const b = dailyRequestFor("A1", "US").sources.map((s) => s.requestHash);
  assert.deepEqual(a, b);
});

test("R16: five-ID batching is unchanged for multi-account reports (brand-sales 6 ids -> two chunks)", async () => {
  const ids = Array.from({ length: 6 }, (_, i) => "id" + i);
  const jobs = reportSourceRequestHashes({ reportKey: "brand-sales", apiKey: "k", ids, windowsByRequestKey: { "brand-sales:order-lines": [{ from: "2025-01-01", to: "2025-06-30" }], "brand-sales:catalog": [{ from: "2025-01-01", to: "2025-06-30" }] } });
  const ol = jobs.filter((j) => j.requestKey === "brand-sales:order-lines");
  assert.equal(ol.length, 2, "6 ids still split into two five-ID chunks for multi-account reports");
  // ...while the account-scoped daily/sku planner refuses more than one account per source job.
  assert.throws(() => reportSourceRequestHashes({ reportKey: "daily-reporting", apiKey: "k", ids: ["A1", "A2"], windowsByRequestKey: { "daily-reporting:asin-day-superset": [{ from: "2026-03-01", to: "2026-03-31" }], "daily-reporting:catalog": [{ from: "2026-03-01", to: "2026-03-31" }] } }), /single account/);
});

test("R17: admin report controls stay LOCKED for daily-reporting + sku-pl", async () => {
  const catalog = reportControlCatalog([{ report_key: "daily-reporting", schedule_enabled: true }, { report_key: "sku-pl", schedule_enabled: true }]);
  const byKey = Object.fromEntries(catalog.map((c) => [c.reportKey, c]));
  for (const k of ["daily-reporting", "sku-pl"]) {
    assert.equal(byKey[k].ready, false, `${k} not runner-ready`);
    assert.equal(byKey[k].scheduleEnabled, false, `${k} cannot be schedule-enabled while locked`);
    assert.ok(byKey[k].readinessReason, `${k} carries a readiness reason`);
  }
  // Even with the schedule setting on, the enabled set excludes the locked reports.
  const enabled = enabledReportKeys([{ report_key: "daily-reporting", schedule_enabled: true }, { report_key: "sku-pl", schedule_enabled: true }]);
  assert.ok(!enabled.has("daily-reporting") && !enabled.has("sku-pl"), "locked reports never enter the enabled set");
});

/* ---- run the async suite with NO top-level await; deterministic natural exit ---- */
async function main() {
  mark("main(): loading planner modules");
  ({ resolveAccountScope, planDailyReporting, planSkuPl, buildShadowReportPlan, SHADOW_PLANNED_REPORT_KEYS } = await import("../lib/server/sync/report-planner.js"));
  ({ makeDailyAdsContextLoader, canonicalizeAdRows, adsCoveredThrough, buildDailyAdsCoverage, DAILY_ADS_SOURCE_KEY } = await import("../lib/server/sync/daily-ads-loader.js"));
  ({ reportSourceRequestHashes, evaluateDailyAdsCoverage, validateSkuPlMonthlyWindows } = await import("../lib/server/sync/report-source-contracts.js"));
  ({ runReportJobs } = await import("../lib/server/sync/report-worker.js"));
  ({ runSourceJobs } = await import("../lib/server/sync/source-worker.js"));
  ({ REPORT_DERIVATIONS, shadowSnapshotKey } = await import("../lib/server/sync/report-derivation.js"));
  ({ reportControlCatalog, enabledReportKeys } = await import("../lib/server/sync/report-controls.js"));
  ({ splitDateRangeByMonth, monthStartStr, addDaysStr, sixCompleteCalendarMonths } = await import("../lib/server/date-windows.js"));
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
