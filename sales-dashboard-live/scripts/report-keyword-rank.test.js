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
    seedSource(hash, status, errorCode = null) { sourceJobs.push({ request_hash: hash, fetch_status: status, error_code: errorCode }); },
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

// Blocker 3: required-now monthly fallback preserves TYPED outcomes (not everything -> invalid).
test("keyword-rank: weekly < 4 with a TERMINAL-DISABLED monthly fallback => BLOCKED (not invalid)", () => {
  const { planned, rows } = kwPlanned({ weeklyRows: [{ date: "2025-07-01" }], catalogRows: CATALOG }); // no monthly fragment
  const s = buildSources(planned, rows);
  s["keyword-rank:sqp-monthly"] = { available: false, rows: null, disabled: true, disabledPolicy: { disabledSource: "terminal", safeCode: "SOURCE_DISABLED", reportOutcome: "blocked" }, fragments: [] };
  const res = deriveReportSnapshot({ reportKey: "keyword-rank", sources: s, context: ctx() });
  assert.equal(res.status, "blocked");
  assert.equal(res.payload, null);
});

test("keyword-rank: weekly < 4 with a MISSING/failed monthly fallback => UNAVAILABLE (not invalid)", () => {
  const { planned, rows } = kwPlanned({ weeklyRows: [{ date: "2025-07-01" }], catalogRows: CATALOG }); // monthly absent
  const res = deriveKw(planned, rows);
  assert.equal(res.status, "unavailable");
  assert.equal(res.payload, null);
});

test("keyword-rank: weekly < 4 with a VALIDATED EMPTY monthly is a real baseline input (derives)", () => {
  const { planned, rows } = kwPlanned({ weeklyRows: [], monthlyRows: [], catalogRows: CATALOG }); // both validated empty
  const res = deriveKw(planned, rows);
  assert.equal(res.status, "derived", "an empty (but validated) monthly array is honored, not treated as missing");
  assert.equal(res.payload.cadence, "baseline");
  assert.deepEqual(res.payload.periods, []);
  assert.deepEqual(res.payload.rows, []);
});

/* ============================= Blocker 4: SQP row-date validation ============================= */

group("keyword-rank: SQP row date validation (plain object, real date, in-window)");

test("keyword-rank: a non-object weekly SQP row => invalid (not silently filtered)", () => {
  const { planned, rows } = kwPlanned({ weeklyRows: [{ date: "2025-06-01" }, "2025-06-08"], catalogRows: CATALOG });
  assert.equal(deriveKw(planned, rows).status, "invalid");
});

test("keyword-rank: an impossible weekly SQP date (2025-02-30 / 99-99) => invalid", () => {
  for (const bad of ["2025-02-30", "2025-99-99", "not-a-date", ""]) {
    const { planned, rows } = kwPlanned({ weeklyRows: [{ date: "2025-06-01" }, { date: bad }], catalogRows: CATALOG });
    assert.equal(deriveKw(planned, rows).status, "invalid", "bad date " + JSON.stringify(bad));
  }
});

test("keyword-rank: an OUT-OF-WINDOW weekly SQP date (before asOf-84) => invalid", () => {
  const { planned, rows } = kwPlanned({ weeklyRows: [{ date: "2025-06-01" }, { date: addDaysStr(ASOF, -85) }], catalogRows: CATALOG });
  assert.equal(deriveKw(planned, rows).status, "invalid");
});

test("keyword-rank: an OUT-OF-WINDOW monthly SQP date (before asOf-365) => invalid", () => {
  const { planned, rows } = kwPlanned({ weeklyRows: [{ date: "2025-07-01" }], monthlyRows: [{ date: "2025-05-01" }, { date: addDaysStr(ASOF, -366) }], catalogRows: CATALOG });
  assert.equal(deriveKw(planned, rows).status, "invalid");
});

test("keyword-rank: a future weekly SQP date (after asOf) => invalid", () => {
  const { planned, rows } = kwPlanned({ weeklyRows: [{ date: "2025-06-01" }, { date: addDaysStr(ASOF, 1) }], catalogRows: CATALOG });
  assert.equal(deriveKw(planned, rows).status, "invalid");
});

test("keyword-rank: clean in-window SQP dates derive normally (validation does not reject good data)", () => {
  const { planned, rows } = kwPlanned({ weeklyRows: WEEKLY_ROWS, catalogRows: CATALOG });
  assert.equal(deriveKw(planned, rows).status, "derived");
});

/* ============================= worker-level typed-state persistence + LKG ============================= */

group("keyword-rank worker: blocked terminal / unavailable+invalid preserve LKG; unrelated continues");

// The keyword-rank report's three planned sources (weekly + monthly[optional] + catalog); `monthlyExtra`
// can add a disabledPolicy so the worker marks a failed monthly as terminal-disabled.
const KW_REPORT_SOURCES = (monthlyExtra = {}) => [
  { requestKey: "keyword-rank:sqp-weekly", requestHash: "kw-w", from: WEEKLY_FROM, to: ASOF, sellerOrVendorIds: [ID], optional: false },
  { requestKey: "keyword-rank:sqp-monthly", requestHash: "kw-m", from: LONG_FROM, to: ASOF, sellerOrVendorIds: [ID], optional: true, ...monthlyExtra },
  { requestKey: "keyword-rank:catalog", requestHash: "kw-c", from: LONG_FROM, to: ASOF, sellerOrVendorIds: [ID], optional: false },
];
const LKG = { cadence: "weekly", periods: ["prior"], rows: [] };

// Run runReportJobs for a keyword-rank plan (+ an unrelated content-changes report). Seeds the source
// job statuses + cache rows + a prior LKG snapshot; returns { store, savedKeys }.
async function runKwWorker({ kwSources, statusByHash, rowsByHash, errorByHash = {} }) {
  const store = makeReportStore();
  // The durable safe error_code is what proves a source-disabled outcome (B1); a policy alone never does.
  for (const [h, st] of Object.entries(statusByHash)) store.seedSource(h, st, errorByHash[h] || null);
  store.seedSource("other-src", "succeeded");
  store.seedSnapshot("scheduler-v2/keyword-rank", ID, LKG);
  const sourceRows = (hash) => (Object.prototype.hasOwnProperty.call(rowsByHash, hash) ? { rows: rowsByHash[hash] } : { rows: [] });
  const kwReport = { reportKey: "keyword-rank", accountId: ID, connectionId: "primary", bucket: "us", reportVersion: "keyword-rank/v2d-1", sources: kwSources, context: ctx() };
  const other = { reportKey: "content-changes", accountId: "OTHER", connectionId: "primary", bucket: "us", reportVersion: "content-changes/v2d-1", sources: [{ requestKey: "content-changes:events", requestHash: "other-src", from: null, to: null, sellerOrVendorIds: ["OTHER"], optional: false }, { requestKey: "content-changes:catalog", requestHash: "other-src", from: null, to: null, sellerOrVendorIds: ["OTHER"], optional: false }], context: { accountId: "OTHER" } };
  const savedKeys = [];
  const saveSnapshot = async ({ reportKey }) => { savedKeys.push(reportKey); return { paramsHash: "ph" }; };
  await runReportJobs({ store, cycleId: "cyc1", sourceRows, saveSnapshot, plannedReports: [kwReport, other] });
  return { store, savedKeys };
}

test("keyword-rank worker: BLOCKED (terminal-disabled monthly) is terminal, writes zero snapshots, keeps LKG, unrelated continues", async () => {
  const { store, savedKeys } = await runKwWorker({
    kwSources: KW_REPORT_SOURCES({ disabledPolicy: { disabledSource: "terminal", safeCode: "SOURCE_DISABLED", reportOutcome: "blocked" } }),
    statusByHash: { "kw-w": "succeeded", "kw-m": "failed", "kw-c": "succeeded" },
    // The durable SOURCE_DISABLED error_code (not policy presence) proves the terminal-disabled outcome.
    errorByHash: { "kw-m": "SOURCE_DISABLED" },
    rowsByHash: { "kw-w": [{ date: "2025-07-01" }], "kw-c": CATALOG },
  });
  assert.ok(!savedKeys.includes("scheduler-v2/keyword-rank"), "no keyword-rank snapshot saved");
  assert.equal(store.report("keyword-rank", ID).fetch_status, "blocked", "blocked is TERMINAL for the cycle");
  assert.deepEqual(store._snapshots.get("scheduler-v2/keyword-rank|" + ID).payload, LKG, "last-known-good preserved");
  assert.ok(savedKeys.includes("scheduler-v2/content-changes"), "an unrelated report continues + saves");
});

test("keyword-rank worker: UNAVAILABLE (failed/missing monthly) writes zero snapshots, keeps LKG, unrelated continues", async () => {
  const { store, savedKeys } = await runKwWorker({
    kwSources: KW_REPORT_SOURCES(), // monthly optional, NO disabledPolicy
    statusByHash: { "kw-w": "succeeded", "kw-m": "failed", "kw-c": "succeeded" },
    rowsByHash: { "kw-w": [{ date: "2025-07-01" }], "kw-c": CATALOG },
  });
  assert.ok(!savedKeys.includes("scheduler-v2/keyword-rank"), "no keyword-rank snapshot saved");
  assert.equal(store.report("keyword-rank", ID).derive_status, "failed", "unavailable recorded (non-terminal derive failure)");
  assert.deepEqual(store._snapshots.get("scheduler-v2/keyword-rank|" + ID).payload, LKG, "last-known-good preserved");
  assert.ok(savedKeys.includes("scheduler-v2/content-changes"), "an unrelated report continues + saves");
});

test("keyword-rank worker: INVALID (out-of-window weekly date) writes zero snapshots, keeps LKG, unrelated continues", async () => {
  const { store, savedKeys } = await runKwWorker({
    kwSources: KW_REPORT_SOURCES(),
    statusByHash: { "kw-w": "succeeded", "kw-c": "succeeded" }, // monthly not needed; weekly date is bad
    rowsByHash: { "kw-w": [{ date: "2025-06-01" }, { date: addDaysStr(ASOF, -85) }], "kw-c": CATALOG },
  });
  assert.ok(!savedKeys.includes("scheduler-v2/keyword-rank"), "no keyword-rank snapshot saved");
  assert.deepEqual(store._snapshots.get("scheduler-v2/keyword-rank|" + ID).payload, LKG, "last-known-good preserved");
  assert.ok(savedKeys.includes("scheduler-v2/content-changes"), "an unrelated report continues + saves");
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
