// Phase 1d -- Keyword Rank derivation + planner tests (SHADOW MODE).
//
// One small, independently-readable ESM artifact. Proves the Keyword Rank derivation reproduces the
// api/datadoe.js `keyword-rank` route payload ({ accountId, cadence, periods, weeklyPeriodCount, rows,
// products, catalogBrands, retrievedAt }) PURELY from saved SQP-weekly + catalog (+ conditional
// SQP-monthly) fragments, with ZERO DataDoe calls. Covers exact route-payload parity (hand-computed),
// the weekly / monthly / baseline cadence branches, weekly>=4 skips monthly, the planner activating the
// monthly fallback exactly once (and not when weekly is sufficient), weekly-empty vs missing-cache as
// distinct states, disabled weekly/monthly blocking, strict row-cap / wrong-window / cross-account /
// malformed rejection preserving last-known-good, primary/dd-secondary hash isolation, deterministic
// idempotent derivation, and a worker-level no-snapshot/LKG proof.
//
// 7-bit ASCII, LF, no top-level await, synchronous writeSync progress, dynamic imports after a dummy
// Supabase env. Nothing high-entropy in the bytes.

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

// Assigned in main() after the dummy env is set.
let assembleSources, deriveReportSnapshot, runReportJobs;
let keywordRankPayload, sqpDistinctPeriods, catalogBrandNames;
let planKeywordRank, addDaysStr;

const ID = "A1";
const ASOF = "2025-08-10";
const WEEKLY_FROM = "2025-05-18"; // addDaysStr(ASOF, -84)
const LONG_FROM = "2024-08-10";   // addDaysStr(ASOF, -365)
const RETRIEVED = "2025-08-10T00:00:00Z";
const dash = (...p) => p.join("-");
const PL_CONN = [
  { id: "primary", apiKey: dash("org", "primary"), accountPrefix: "" },
  { id: "secondary", apiKey: dash("org", "secondary"), accountPrefix: dash("dd", "secondary") + ":" },
];

let hashSeq = 0;
const frag = (requestKey, from, to, ids = [ID]) => ({ requestKey, requestHash: "h" + (hashSeq += 1), from, to, sellerOrVendorIds: ids });

function buildSources(planned, rowsByHash, statusOverride = {}) {
  const statusByHash = {};
  const loaded = new Map();
  for (const p of planned) {
    const st = statusOverride[p.requestHash] || "succeeded";
    statusByHash[p.requestHash] = st;
    if (st === "succeeded") loaded.set(p.requestHash, { rows: rowsByHash[p.requestHash] || [] });
  }
  return assembleSources(planned, statusByHash, loaded).sources;
}

// Build keyword-rank planned fragments + rows. `monthly` true adds the SQP-monthly fragment.
function kwPlanned({ weeklyRows = [], monthlyRows = null, catalogRows = [], ids = [ID], monthly = monthlyRows != null } = {}) {
  const planned = [];
  const rows = {};
  const wf = frag("keyword-rank:sqp-weekly", WEEKLY_FROM, ASOF, ids); planned.push(wf); rows[wf.requestHash] = weeklyRows;
  if (monthly) { const mf = frag("keyword-rank:sqp-monthly", LONG_FROM, ASOF, ids); planned.push(mf); rows[mf.requestHash] = monthlyRows || []; }
  const cf = frag("keyword-rank:catalog", LONG_FROM, ASOF, ids); planned.push(cf); rows[cf.requestHash] = catalogRows;
  return { planned, rows };
}

const ctx = (over = {}) => ({ to: ASOF, rawSellerId: ID, accountId: ID, retrievedAt: RETRIEVED, ...over });
const deriveKw = (planned, rows, context = ctx(), statusOverride) =>
  deriveReportSnapshot({ reportKey: "keyword-rank", sources: buildSources(planned, rows, statusOverride), context });

// Compact report store for the worker (runReportJobs): source deps seeded, snapshot save tracked.
function makeReportStore() {
  const reportJobs = new Map();
  const snapshots = new Map();
  const sourceJobs = [];
  const key = (rk, a) => rk + "|" + a;
  return {
    _snapshots: snapshots,
    saveCalls: 0,
    seedSource(hash, status) { sourceJobs.push({ request_hash: hash, fetch_status: status }); },
    seedSnapshot(reportKey, accountId, payload) { snapshots.set(key(reportKey, accountId), { payload }); },
    report(rk, a) { return reportJobs.get(key(rk, a)); },
    listSourceJobs() { return sourceJobs.map((j) => ({ ...j })); },
    upsertReportJob({ reportKey, accountId, connectionId, bucket, reportVersion, dependsOn }) {
      const k = key(reportKey, accountId);
      if (reportJobs.has(k)) return;
      reportJobs.set(k, { report_key: reportKey, account_id: accountId, connection_id: connectionId, bucket, report_version: reportVersion, depends_on: dependsOn || [], fetch_status: "pending", derive_status: "pending", save_status: "pending", validated: false });
    },
    listReportJobs() { return [...reportJobs.values()].map((j) => ({ ...j })); },
    claimReportDerive(_c, rk, a) { const j = reportJobs.get(key(rk, a)); if (j && j.derive_status === "pending") { j.derive_status = "running"; return true; } return false; },
    recordReportBlocked({ reportKey, accountId }) { Object.assign(reportJobs.get(key(reportKey, accountId)), { fetch_status: "blocked", derive_status: "skipped", save_status: "skipped" }); },
    recordReportFailure({ reportKey, accountId, stage, code }) { Object.assign(reportJobs.get(key(reportKey, accountId)), { derive_status: stage === "save" ? "succeeded" : "failed", save_status: stage === "save" ? "failed" : "pending", error_code: code }); },
    recordReportSuccess({ reportKey, accountId }) { Object.assign(reportJobs.get(key(reportKey, accountId)), { fetch_status: "ready", derive_status: "succeeded", save_status: "succeeded", validated: true }); },
  };
}

/* ============================= route-payload parity ============================= */

group("keyword-rank: exact route-payload parity");

const WEEKLY_ROWS = [
  { date: "2025-06-01", child_asin: "ASIN1", search_query: "widget", search_query_volume: 100 },
  { date: "2025-06-08", child_asin: "ASIN1", search_query: "widget", search_query_volume: 90 },
  { date: "2025-06-15", child_asin: "ASIN2", search_query: "gadget", search_query_volume: 50 },
  { date: "2025-06-22", child_asin: "ASIN1", search_query: "widget", search_query_volume: 80 },
];
const CATALOG = [
  { child_asin: "ASIN1", product_brand: "Acme", product_name: "Widget" },
  { child_asin: "ASIN2", product_brand: "", product_name: "Gadget" },   // blank brand -> Unassigned
  { child_asin: "ASIN3", product_brand: "Beta", product_name: "" },     // blank name -> null
  { child_asin: "ASIN1", product_brand: "Dup", product_name: "DupName" }, // dup ASIN skipped in products
];
// Hand-computed expected payload, transcribed from the route formula (retrievedAt is the deterministic
// scheduler value, not the route's Date.now()).
const EXPECTED_WEEKLY = {
  accountId: "A1",
  cadence: "weekly",
  periods: ["2025-06-01", "2025-06-08", "2025-06-15", "2025-06-22"],
  weeklyPeriodCount: 4,
  rows: WEEKLY_ROWS,
  products: [
    { asin: "ASIN1", name: "Widget", brand: "Acme" },
    { asin: "ASIN2", name: "Gadget", brand: "Unassigned" },
    { asin: "ASIN3", name: null, brand: "Beta" },
  ],
  catalogBrands: ["Acme", "Beta", "Dup"],
  retrievedAt: RETRIEVED,
};

test("keyword-rank: weekly-cadence payload deep-equals the hand-computed route payload", () => {
  const { planned, rows } = kwPlanned({ weeklyRows: WEEKLY_ROWS, catalogRows: CATALOG });
  const res = deriveKw(planned, rows);
  assert.equal(res.status, "derived");
  assert.deepEqual(res.payload, EXPECTED_WEEKLY);
  assert.equal(res.latestDataDate, "2025-06-22", "latest data date = most recent SQP period");
});

test("keywordRankPayload + sqpDistinctPeriods leaves reproduce the route formula", () => {
  assert.deepEqual(sqpDistinctPeriods(WEEKLY_ROWS), ["2025-06-01", "2025-06-08", "2025-06-15", "2025-06-22"]);
  assert.deepEqual(sqpDistinctPeriods([{ date: "" }, { date: "2025-01-02" }, {}]), ["2025-01-02"]);
  const p = keywordRankPayload({ accountId: "A1", cadence: "weekly", periods: EXPECTED_WEEKLY.periods, weeklyPeriodCount: 4, rows: WEEKLY_ROWS, catalogRows: CATALOG, retrievedAt: RETRIEVED });
  assert.deepEqual(p, EXPECTED_WEEKLY);
  // products come only from catalog (unique child_asin, source order); catalogBrands drop blanks + sort.
  assert.deepEqual(catalogBrandNames(CATALOG), ["Acme", "Beta", "Dup"]);
});

/* ============================= cadence branches ============================= */

group("keyword-rank: cadence (weekly / monthly / baseline)");

test("keyword-rank: >= 4 weekly periods => cadence weekly; monthly is neither read nor required", () => {
  const { planned, rows } = kwPlanned({ weeklyRows: WEEKLY_ROWS, catalogRows: CATALOG }); // no monthly fragment
  const res = deriveKw(planned, rows);
  assert.equal(res.status, "derived");
  assert.equal(res.payload.cadence, "weekly");
  assert.equal(res.payload.weeklyPeriodCount, 4);
});

test("keyword-rank: weekly < 4 + monthly >= 2 periods => cadence monthly (uses monthly rows/periods)", () => {
  const weekly = [{ date: "2025-07-01" }, { date: "2025-07-08" }];
  const monthly = [{ date: "2025-05-01" }, { date: "2025-06-01" }, { date: "2025-07-01" }];
  const { planned, rows } = kwPlanned({ weeklyRows: weekly, monthlyRows: monthly, catalogRows: CATALOG });
  const res = deriveKw(planned, rows);
  assert.equal(res.payload.cadence, "monthly");
  assert.deepEqual(res.payload.periods, ["2025-05-01", "2025-06-01", "2025-07-01"]);
  assert.equal(res.payload.weeklyPeriodCount, 2, "weeklyPeriodCount always reflects the weekly source");
  assert.deepEqual(res.payload.rows, monthly);
});

test("keyword-rank: weekly < 4 + monthly < 2 => baseline; prefers non-empty weekly rows", () => {
  const weekly = [{ date: "2025-07-01" }];
  const monthly = [{ date: "2025-05-01" }];
  const { planned, rows } = kwPlanned({ weeklyRows: weekly, monthlyRows: monthly, catalogRows: CATALOG });
  const res = deriveKw(planned, rows);
  assert.equal(res.payload.cadence, "baseline");
  assert.deepEqual(res.payload.rows, weekly, "non-empty weekly preferred");
  assert.deepEqual(res.payload.periods, ["2025-07-01"]);
});

test("keyword-rank: baseline with EMPTY weekly uses monthly rows (honest current baseline)", () => {
  const monthly = [{ date: "2025-05-01" }];
  const { planned, rows } = kwPlanned({ weeklyRows: [], monthlyRows: monthly, catalogRows: CATALOG });
  const res = deriveKw(planned, rows);
  assert.equal(res.payload.cadence, "baseline");
  assert.deepEqual(res.payload.rows, monthly, "empty weekly falls back to monthly rows");
  assert.equal(res.payload.weeklyPeriodCount, 0);
  assert.deepEqual(res.payload.periods, ["2025-05-01"]);
});

/* ============================= empty-vs-missing, disabled, fallback-required ============================= */

group("keyword-rank: empty vs missing, disabled, required-fallback");

test("keyword-rank: EMPTY validated weekly is a real state (derives via monthly fallback)", () => {
  const { planned, rows } = kwPlanned({ weeklyRows: [], monthlyRows: [{ date: "2025-05-01" }, { date: "2025-06-01" }], catalogRows: CATALOG });
  assert.equal(deriveKw(planned, rows).status, "derived", "empty weekly + monolithic monthly derives");
});

test("keyword-rank: MISSING (cache-miss/failed) weekly => unavailable (required gate), no payload", () => {
  const { planned, rows } = kwPlanned({ weeklyRows: [{ date: "2025-07-01" }], monthlyRows: [{ date: "2025-05-01" }], catalogRows: CATALOG });
  const wHash = planned.find((p) => p.requestKey === "keyword-rank:sqp-weekly").requestHash;
  const res = deriveKw(planned, rows, ctx(), { [wHash]: "failed" });
  assert.equal(res.status, "unavailable");
  assert.equal(res.payload, null, "no snapshot -> last-known-good preserved");
});

test("keyword-rank: missing-weekly (unavailable) and empty-weekly (derived) are DISTINCT states", () => {
  const empty = kwPlanned({ weeklyRows: [], monthlyRows: [{ date: "2025-05-01" }, { date: "2025-06-01" }], catalogRows: CATALOG });
  const missing = kwPlanned({ weeklyRows: [{ date: "2025-07-01" }], monthlyRows: [{ date: "2025-05-01" }], catalogRows: CATALOG });
  const wHash = missing.planned.find((p) => p.requestKey === "keyword-rank:sqp-weekly").requestHash;
  assert.equal(deriveKw(empty.planned, empty.rows).status, "derived");
  assert.equal(deriveKw(missing.planned, missing.rows, ctx(), { [wHash]: "failed" }).status, "unavailable");
});

test("keyword-rank: a disabled weekly SQP source is terminal => blocked", () => {
  // weekly is required; a disabled required source with a terminal policy blocks (route parity).
  const sources = {
    "keyword-rank:sqp-weekly": { available: false, rows: null, disabled: true, disabledPolicy: { disabledSource: "terminal", safeCode: "SOURCE_DISABLED", reportOutcome: "blocked" } },
    "keyword-rank:catalog": { available: true, rows: CATALOG, fragments: [{ from: LONG_FROM, to: ASOF, sellerOrVendorIds: [ID], rows: CATALOG }] },
  };
  assert.equal(deriveReportSnapshot({ reportKey: "keyword-rank", sources, context: ctx() }).status, "blocked");
});

test("keyword-rank: weekly < 4 with a DISABLED monthly fallback blocks (never a silent baseline)", () => {
  const { planned, rows } = kwPlanned({ weeklyRows: [{ date: "2025-07-01" }], catalogRows: CATALOG }); // no monthly fragment
  const s = buildSources(planned, rows);
  s["keyword-rank:sqp-monthly"] = { available: false, rows: null, disabled: true, disabledPolicy: { disabledSource: "terminal", safeCode: "SOURCE_DISABLED", reportOutcome: "blocked" }, fragments: [] };
  const res = deriveReportSnapshot({ reportKey: "keyword-rank", sources: s, context: ctx() });
  assert.equal(res.status, "invalid");
  assert.equal(res.payload, null);
});

test("keyword-rank: weekly < 4 with a MISSING monthly fallback blocks (LKG preserved)", () => {
  const { planned, rows } = kwPlanned({ weeklyRows: [{ date: "2025-07-01" }], catalogRows: CATALOG }); // monthly absent
  const res = deriveKw(planned, rows);
  assert.equal(res.status, "invalid");
  assert.equal(res.payload, null);
});

/* ============================= window / account / integrity ============================= */

group("keyword-rank: window + account + strict-cap integrity");

test("keyword-rank: a wrong weekly window (not asOf-84..asOf) blocks", () => {
  const { planned, rows } = kwPlanned({ weeklyRows: WEEKLY_ROWS, catalogRows: CATALOG });
  const idx = planned.findIndex((p) => p.requestKey === "keyword-rank:sqp-weekly");
  planned[idx] = { ...planned[idx], from: addDaysStr(ASOF, -83) }; // shifted lookback
  assert.equal(deriveKw(planned, rows).status, "invalid");
});

test("keyword-rank: a wrong catalog window (not asOf-365..asOf) blocks", () => {
  const { planned, rows } = kwPlanned({ weeklyRows: WEEKLY_ROWS, catalogRows: CATALOG });
  const idx = planned.findIndex((p) => p.requestKey === "keyword-rank:catalog");
  planned[idx] = { ...planned[idx], to: addDaysStr(ASOF, -1) };
  assert.equal(deriveKw(planned, rows).status, "invalid");
});

test("keyword-rank: a cross-account weekly fragment blocks", () => {
  const { planned, rows } = kwPlanned({ weeklyRows: WEEKLY_ROWS, catalogRows: CATALOG });
  const idx = planned.findIndex((p) => p.requestKey === "keyword-rank:sqp-weekly");
  planned[idx] = { ...planned[idx], sellerOrVendorIds: ["OTHER"] };
  assert.equal(deriveKw(planned, rows).status, "invalid");
});

test("keyword-rank: a malformed / multi-fragment weekly source blocks", () => {
  const { planned, rows } = kwPlanned({ weeklyRows: WEEKLY_ROWS, catalogRows: CATALOG });
  // Duplicate the weekly fragment -> two fragments for one single-range key.
  const wf = planned.find((p) => p.requestKey === "keyword-rank:sqp-weekly");
  const dup = { ...wf, requestHash: "hDUP" };
  planned.push(dup); rows[dup.requestHash] = WEEKLY_ROWS;
  assert.equal(deriveKw(planned, rows).status, "invalid");
});

test("keyword-rank: a strict row-cap failure (weekly TRUNCATED at source) writes nothing, preserves LKG", () => {
  const { planned, rows } = kwPlanned({ weeklyRows: WEEKLY_ROWS, catalogRows: CATALOG });
  const wHash = planned.find((p) => p.requestKey === "keyword-rank:sqp-weekly").requestHash;
  // A TRUNCATED strict source is recorded failed by the source worker -> unavailable here.
  const res = deriveKw(planned, rows, ctx(), { [wHash]: "failed" });
  assert.equal(res.status, "unavailable");
  assert.equal(res.payload, null);
});

/* ============================= safety: no fetch, idempotent, worker LKG ============================= */

group("keyword-rank: zero DataDoe, idempotent, worker LKG");

test("keyword-rank: derivation performs ZERO fetch/DataDoe calls", async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (u) => { calls.push(String(u)); throw new Error("NO_FETCH_DURING_DERIVATION"); };
  try {
    const { planned, rows } = kwPlanned({ weeklyRows: WEEKLY_ROWS, catalogRows: CATALOG });
    assert.equal(deriveKw(planned, rows).status, "derived");
  } finally { globalThis.fetch = original; }
  assert.equal(calls.length, 0);
});

test("keyword-rank: derivation is idempotent (same inputs -> identical payload)", () => {
  const { planned, rows } = kwPlanned({ weeklyRows: WEEKLY_ROWS, catalogRows: CATALOG });
  assert.deepEqual(deriveKw(planned, rows).payload, deriveKw(planned, rows).payload);
});

test("keyword-rank worker: a blocked derive (weekly<4, monthly missing) writes ZERO snapshots + keeps LKG", async () => {
  const { planned, rows } = kwPlanned({ weeklyRows: [{ date: "2025-07-01" }], catalogRows: CATALOG }); // monthly absent -> invalid
  const store = makeReportStore();
  for (const p of planned) store.seedSource(p.requestHash, "succeeded");
  const LKG = { cadence: "weekly", periods: ["prior"], rows: [] };
  store.seedSnapshot("scheduler-v2/keyword-rank", ID, LKG);
  const sourceRows = (hash) => { const p = planned.find((x) => x.requestHash === hash); return { rows: p ? rows[hash] : [] }; };
  const plannedReport = { reportKey: "keyword-rank", accountId: ID, connectionId: "primary", bucket: "us", reportVersion: "keyword-rank/v2d-1", sources: planned.map((p) => ({ ...p, optional: p.requestKey === "keyword-rank:sqp-monthly" })), context: ctx() };
  const saveSnapshot = async () => { store.saveCalls += 1; return { paramsHash: "ph" }; };
  await runReportJobs({ store, cycleId: "cyc1", sourceRows, saveSnapshot, plannedReports: [plannedReport] });
  assert.equal(store.saveCalls, 0, "no snapshot saved for the blocked derive");
  assert.deepEqual(store._snapshots.get("scheduler-v2/keyword-rank|" + ID).payload, LKG, "last-known-good snapshot unchanged");
});

/* ============================= planner ============================= */

group("keyword-rank: planner (kickoff, fallback activation, isolation)");

test("planKeywordRank kickoff: SQP-weekly (asOf-84) + catalog (asOf-365), NO monthly, single account", () => {
  const req = planKeywordRank({ accountId: ID, country: "US", currency: "USD", connections: PL_CONN, asOf: ASOF });
  const keys = [...new Set(req.sources.map((s) => s.requestKey))].sort();
  assert.deepEqual(keys, ["keyword-rank:catalog", "keyword-rank:sqp-weekly"]);
  const wk = req.sources.find((s) => s.requestKey === "keyword-rank:sqp-weekly");
  assert.equal(wk.from, WEEKLY_FROM); assert.equal(wk.to, ASOF);
  const cat = req.sources.find((s) => s.requestKey === "keyword-rank:catalog");
  assert.equal(cat.from, LONG_FROM); assert.equal(cat.to, ASOF);
  assert.ok(req.sources.every((s) => s.sellerOrVendorIds.length === 1 && s.sellerOrVendorIds[0] === ID));
  assert.deepEqual(req.context, { to: ASOF, rawSellerId: ID });
});

test("planKeywordRank: weekly < 4 periods activates EXACTLY ONE monthly SQP request (asOf-365)", () => {
  const req = planKeywordRank({ accountId: ID, country: "US", currency: "USD", connections: PL_CONN, asOf: ASOF, weeklySignal: { status: "success", validated: true, distinctPeriods: 2 } });
  const monthly = req.sources.filter((s) => s.requestKey === "keyword-rank:sqp-monthly");
  assert.equal(monthly.length, 1, "exactly one monthly fallback request");
  assert.equal(monthly[0].from, LONG_FROM); assert.equal(monthly[0].to, ASOF);
});

test("planKeywordRank: weekly >= 4 periods does NOT plan a monthly SQP request", () => {
  const req = planKeywordRank({ accountId: ID, country: "US", currency: "USD", connections: PL_CONN, asOf: ASOF, weeklySignal: { status: "success", validated: true, distinctPeriods: 5 } });
  assert.ok(!req.sources.some((s) => s.requestKey === "keyword-rank:sqp-monthly"), "sufficient weekly => no monthly");
});

test("planKeywordRank: deterministic hashes; primary and dd-secondary organizations never share a hash", () => {
  const a = planKeywordRank({ accountId: ID, country: "US", currency: "USD", connections: PL_CONN, asOf: ASOF }).sources.map((s) => s.requestHash);
  const b = planKeywordRank({ accountId: ID, country: "US", currency: "USD", connections: PL_CONN, asOf: ASOF }).sources.map((s) => s.requestHash);
  assert.deepEqual(a, b, "identical inputs -> identical request hashes");
  const sec = planKeywordRank({ accountId: dash("dd", "secondary") + ":" + ID, country: "US", currency: "USD", connections: PL_CONN, asOf: ASOF }).sources.map((s) => s.requestHash);
  assert.ok(a.every((h) => !sec.includes(h)), "primary and secondary hashes are disjoint");
});

/* ============================= run ============================= */

async function main() {
  mark("main(): loading keyword-rank modules");
  ({ assembleSources, runReportJobs } = await import("../lib/server/sync/report-worker.js"));
  ({ deriveReportSnapshot } = await import("../lib/server/sync/report-derivation.js"));
  ({ keywordRankPayload, sqpDistinctPeriods, catalogBrandNames } = await import("../lib/server/reports/derivation-core.js"));
  ({ planKeywordRank } = await import("../lib/server/sync/report-planner.js"));
  ({ addDaysStr } = await import("../lib/server/date-windows.js"));
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
