// Phase 1d -- Keyword Rank END-TO-END: staged source worker -> returned final report plans ->
// runReportJobs -> saved shadow snapshots (SHADOW MODE, fully offline).
//
// Blocker 4: runKeywordRankShadowCycle must, after staged source execution, reconstruct each account's
// persisted weekly/monthly state one final time and RETURN the canonical per-account plannedReports.
// This harness drives that return value straight into the report worker for TWO cadences and proves:
//   - exact final depends_on hashes per account (weekly + catalog vs weekly + monthly + catalog);
//   - correct saved cadence + payload;
//   - ZERO DataDoe / network calls during derivation (fetch is trapped; the dd counters never move);
//   - primary / dd-secondary isolation (disjoint hashes; the reports keep their connection);
//   - repeated invocation writes no duplicate exports or snapshots (idempotent);
//   - a failed cadence path preserves last-known-good (blocked, zero writes) and never waits on an
//     intentionally unscheduled catalog.
//
// 7-bit ASCII, LF, no top-level await, synchronous writeSync progress, dynamic imports after a dummy
// Supabase env. No secret-shaped literals; no process.exit / timers / background work.

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

let runKeywordRankShadowCycle, runReportJobs;

const dash = (...p) => p.join("-");
const SECONDARY = dash("dd", "secondary");
const CONNS = [
  { id: "primary", apiKey: dash("prim", "key"), accountPrefix: "" },
  { id: "secondary", apiKey: dash("sec", "key"), accountPrefix: SECONDARY + ":" },
];
const ASOF = "2025-08-10";
const SHADOW_KW = "scheduler-v2/keyword-rank";

// A1 (primary) weekly = 4 periods -> weekly cadence. B1 (dd-secondary) weekly = 2, monthly = 3 ->
// monthly cadence. C1 (primary) weekly export FAILS -> blocked (last-known-good preserved).
const standardRows = (job) => {
  const rk = job.requestKey; const raw = job.fetchParams.sellerOrVendorIds[0];
  if (rk === "keyword-rank:sqp-weekly") return { rows: raw === "A1" ? [{ date: "2025-06-01" }, { date: "2025-06-08" }, { date: "2025-06-15" }, { date: "2025-06-22" }] : [{ date: "2025-07-01" }, { date: "2025-07-08" }] };
  if (rk === "keyword-rank:sqp-monthly") return { rows: [{ date: "2025-05-01" }, { date: "2025-06-01" }, { date: "2025-07-01" }] };
  return { rows: [{ child_asin: "ASIN1", product_brand: "Acme" }] };
};
const failWeeklyFor = (id) => (job) => (job.requestKey === "keyword-rank:sqp-weekly" && job.fetchParams.sellerOrVendorIds[0] === id ? { throw: new Error("DataDoe export creation failed (500).") } : standardRows(job));

// Combined in-memory store: the SOURCE-worker interface (cycles, source jobs, source cache) AND the
// REPORT-worker interface (report jobs, snapshots). Sharing one store makes the persisted source rows
// the ONLY input to derivation -- no re-fetch path exists.
function makeStore() {
  const cycles = new Map();
  const jobsByCycle = new Map();
  const cache = new Map();
  const reportJobs = new Map();
  const snapshots = new Map();
  let seq = 0;
  const findCycle = (id) => [...cycles.values()].find((c) => c.id === id) || null;
  const rkey = (rk, a) => rk + "|" + a;
  return {
    _rawJob(cid, h) { return jobsByCycle.get(cid) && jobsByCycle.get(cid).get(h); },
    _snapshots: snapshots,
    saveCalls: 0,
    // ---- source-worker interface ----
    openCycle({ bucket, cycleDate }) {
      const k = bucket + "|" + cycleDate;
      if (!cycles.has(k)) { const id = "cyc_" + (seq += 1); cycles.set(k, { id, bucket, cycle_date: cycleDate, status: "pending" }); jobsByCycle.set(id, new Map()); }
      return cycles.get(k).id;
    },
    claimCycle(id) { const c = findCycle(id); if (c && c.status === "pending") { c.status = "running"; return true; } return false; },
    getCycle(id) { return findCycle(id); },
    upsertSourceJob(job) {
      const m = jobsByCycle.get(job.cycleId);
      if (m.has(job.requestHash)) return;
      m.set(job.requestHash, { request_hash: job.requestHash, request_key: job.requestKey, source_id: job.sourceId, source_key: job.sourceKey, connection_id: job.connectionId, fetch_status: "pending", attempted_at: null, create_export_count: 0, export_id: null, terminal: false, row_count: null, cache_object_path: null });
    },
    listSourceJobs(id) { return [...((jobsByCycle.get(id) && jobsByCycle.get(id).values()) || [])].map((j) => ({ ...j })); },
    claimExportAttempt(id, h) { const j = jobsByCycle.get(id) && jobsByCycle.get(id).get(h); if (j && j.attempted_at === null) { j.attempted_at = "t"; j.create_export_count += 1; j.fetch_status = "attempted"; return true; } return false; },
    recordExportCreated({ cycleId, requestHash, exportId }) { jobsByCycle.get(cycleId).get(requestHash).export_id = exportId; },
    loadSourceRows(h) { const e = cache.get(h); return e ? { rows: e.rows } : null; },
    saveSourceRows({ job, rows, version }) { const h = job.request_hash != null ? job.request_hash : job.requestHash; cache.set(h, { rows: [...rows] }); return "p/" + h + "/" + version; },
    recordSourceSuccess({ cycleId, requestHash, exportId, rowCount, cacheObjectPath }) { Object.assign(jobsByCycle.get(cycleId).get(requestHash), { fetch_status: "succeeded", export_id: exportId, row_count: rowCount, cache_object_path: cacheObjectPath }); },
    recordSourceFailure({ cycleId, requestHash, stage, code, terminal, rowCount }) { const j = jobsByCycle.get(cycleId).get(requestHash); Object.assign(j, { fetch_status: "failed", error_stage: stage, error_code: code, terminal: !!terminal }); if (rowCount != null) j.row_count = rowCount; },
    updateCycleCounts() { /* not asserted */ },
    // ---- report-worker interface ----
    seedSnapshot(reportKey, accountId, payload) { snapshots.set(rkey(reportKey, accountId), { payload }); },
    report(rk, a) { return reportJobs.get(rkey(rk, a)); },
    listReportJobs() { return [...reportJobs.values()].map((j) => ({ ...j })); },
    upsertReportJob({ reportKey, accountId, connectionId, bucket, reportVersion, dependsOn }) {
      const k = rkey(reportKey, accountId);
      if (reportJobs.has(k)) return;
      reportJobs.set(k, { report_key: reportKey, account_id: accountId, connection_id: connectionId, bucket, report_version: reportVersion, depends_on: dependsOn || [], fetch_status: "pending", derive_status: "pending", save_status: "pending", validated: false });
    },
    claimReportDerive(_c, rk, a) { const j = reportJobs.get(rkey(rk, a)); if (j && j.derive_status === "pending") { j.derive_status = "running"; return true; } return false; },
    recordReportBlocked({ reportKey, accountId }) { Object.assign(reportJobs.get(rkey(reportKey, accountId)), { fetch_status: "blocked", derive_status: "skipped", save_status: "skipped" }); },
    recordReportFailure({ reportKey, accountId, stage, code }) { Object.assign(reportJobs.get(rkey(reportKey, accountId)), { derive_status: stage === "save" ? "succeeded" : "failed", save_status: stage === "save" ? "failed" : "pending", error_code: code }); },
    recordReportSuccess({ reportKey, accountId }) { Object.assign(reportJobs.get(rkey(reportKey, accountId)), { fetch_status: "ready", derive_status: "succeeded", save_status: "succeeded", validated: true }); },
  };
}

// DataDoe double for the SOURCE half; counts create-exports per hash.
function makeDataDoe(behavior) {
  const create = {};
  return {
    createCount: (h) => create[h] || 0,
    totalCreates: () => Object.values(create).reduce((a, b) => a + b, 0),
    async create(job) { create[job.requestHash] = (create[job.requestHash] || 0) + 1; const b = behavior(job); if (b && b.throw) throw b.throw; return { exportId: "e_" + job.requestHash }; },
    async poll() { /* completes */ },
    async download(job) { const b = behavior(job); if (b && b.throw) throw b.throw; return (b && b.rows) || []; },
  };
}

const runCycle = (store, dd, accounts) => runKeywordRankShadowCycle({ accounts, connections: CONNS, asOf: ASOF, store, dataDoe: dd, bucket: "us", cycleDate: "2026-08-11" });

// Drive runReportJobs from the returned plannedReports against the SAME store (cache-only). Traps
// globalThis.fetch so any network attempt during derivation throws -- proving derivation is offline.
async function deriveReports(store, cycleId, plannedReports) {
  const saved = [];
  const sourceRows = (hash) => store.loadSourceRows(hash);
  const saveSnapshot = async ({ reportKey, accountId, payload, params }) => { store.saveCalls += 1; store.seedSnapshot(reportKey, accountId, payload); saved.push({ reportKey, accountId, payload, params }); return { paramsHash: "ph-" + accountId }; };
  const realFetch = globalThis.fetch;
  let fetchHits = 0;
  globalThis.fetch = () => { fetchHits += 1; throw new Error("network call during derivation"); };
  let res;
  try {
    res = await runReportJobs({ store, cycleId, sourceRows, saveSnapshot, plannedReports });
  } finally { globalThis.fetch = realFetch; }
  return { res, saved, fetchHits };
}

const findReport = (list, accountId) => list.find((r) => r.accountId === accountId);
const keysOf = (report) => report.sources.map((s) => s.requestKey).sort();

/* ============================= end-to-end: two cadences, offline derivation ============================= */

group("keyword-rank e2e: staged sources -> final plans -> runReportJobs -> saved snapshots");

test("Account A (weekly) depends on weekly + catalog; Account B (monthly) on weekly + monthly + catalog; both derive offline with correct cadence", async () => {
  const store = makeStore();
  const dd = makeDataDoe(standardRows);
  const accounts = [{ accountId: "A1", country: "US", currency: "USD" }, { accountId: SECONDARY + ":B1", country: "US", currency: "USD" }];
  const cycle = await runCycle(store, dd, accounts);
  const createsAfterSource = dd.totalCreates();
  assert.equal(createsAfterSource, 5, "A: weekly+catalog (2); B: weekly+monthly+catalog (3)");

  const A = findReport(cycle.plannedReports, "A1");
  const B = findReport(cycle.plannedReports, SECONDARY + ":B1");
  assert.deepEqual(keysOf(A), ["keyword-rank:catalog", "keyword-rank:sqp-weekly"], "A final plan: weekly + catalog, NO monthly");
  assert.deepEqual(keysOf(B), ["keyword-rank:catalog", "keyword-rank:sqp-monthly", "keyword-rank:sqp-weekly"], "B final plan: weekly + monthly + catalog");
  assert.equal(A.connectionId, "primary");
  assert.equal(B.connectionId, "dd-secondary", "B keeps its dd-secondary connection");
  // Every final source is REQUIRED (none optional) so a failed staged dependency blocks honestly.
  assert.ok([...A.sources, ...B.sources].every((s) => s.optional === false), "every staged source is required in the final plan");

  // Primary/dd-secondary isolation: A and B share NO request hash.
  const aHashes = new Set(A.sources.map((s) => s.requestHash));
  const bHashes = B.sources.map((s) => s.requestHash);
  assert.ok(bHashes.every((h) => !aHashes.has(h)), "A and B share no source hash (org isolation)");

  const { res, saved, fetchHits } = await deriveReports(store, cycle.cycleId, cycle.plannedReports);
  assert.equal(fetchHits, 0, "ZERO network calls during derivation");
  assert.equal(dd.totalCreates(), createsAfterSource, "derivation creates NO DataDoe export");
  assert.equal(res.succeeded, 2, "both accounts derived + saved");

  // Exact final depends_on hashes per account == the staged source hashes (persisted on the report job).
  assert.deepEqual([...store.report("keyword-rank", "A1").depends_on].sort(), [...A.sources.map((s) => s.requestHash)].sort());
  assert.deepEqual([...store.report("keyword-rank", SECONDARY + ":B1").depends_on].sort(), [...B.sources.map((s) => s.requestHash)].sort());

  // Correct saved cadence + payload.
  const savedA = saved.find((s) => s.accountId === "A1").payload;
  const savedB = saved.find((s) => s.accountId === SECONDARY + ":B1").payload;
  assert.equal(savedA.cadence, "weekly", "A saved with weekly cadence");
  assert.equal(savedA.weeklyPeriodCount, 4);
  assert.equal(savedB.cadence, "monthly", "B saved with monthly cadence (weekly < 4 fallback)");
  assert.equal(savedB.weeklyPeriodCount, 2);
  assert.deepEqual(savedA.products, [{ asin: "ASIN1", name: null, brand: "Acme" }], "payload products derived purely from the saved catalog");
});

test("a repeated cycle + repeated derivation writes NO duplicate exports and NO duplicate snapshots (idempotent)", async () => {
  const store = makeStore();
  const dd = makeDataDoe(standardRows);
  const accounts = [{ accountId: "A1", country: "US", currency: "USD" }, { accountId: SECONDARY + ":B1", country: "US", currency: "USD" }];
  const c1 = await runCycle(store, dd, accounts);
  const createsAfterFirst = dd.totalCreates();
  const first = await deriveReports(store, c1.cycleId, c1.plannedReports);
  assert.equal(first.res.succeeded, 2);
  const savesAfterFirst = store.saveCalls;

  // A fresh cycle (same store) re-derives from persisted state: no new source export.
  const c2 = await runCycle(store, dd, accounts);
  assert.equal(dd.totalCreates(), createsAfterFirst, "fresh cycle creates NO duplicate export");
  // A fresh derivation over finished report jobs writes no duplicate snapshot.
  const second = await deriveReports(store, c2.cycleId, c2.plannedReports);
  assert.equal(second.res.succeeded, 0, "finished reports are not re-derived");
  assert.equal(store.saveCalls, savesAfterFirst, "no duplicate snapshot written");
});

test("a FAILED weekly cadence path is BLOCKED (never waits on an unscheduled catalog) and preserves last-known-good", async () => {
  const store = makeStore();
  const dd = makeDataDoe(failWeeklyFor("C1"));
  // A good LKG snapshot exists for C1 from a prior run; the failed cadence must NOT overwrite it.
  const LKG = { cadence: "weekly", weeklyPeriodCount: 4, rows: [{ date: "2025-01-01" }], products: [], catalogBrands: [], periods: ["2025-01-01"], accountId: "C1", retrievedAt: null };
  store.seedSnapshot(SHADOW_KW, "C1", LKG);
  const cycle = await runCycle(store, dd, [{ accountId: "A1", country: "US", currency: "USD" }, { accountId: "C1", country: "US", currency: "USD" }]);

  const C = findReport(cycle.plannedReports, "C1");
  assert.deepEqual(keysOf(C), ["keyword-rank:sqp-weekly"], "C staged ONLY the weekly (no catalog fabricated)");
  assert.ok(!C.sources.some((s) => s.requestKey === "keyword-rank:catalog"), "the report never lists an unscheduled catalog dependency");

  const { res, saved } = await deriveReports(store, cycle.cycleId, cycle.plannedReports);
  assert.equal(res.blocked, 1, "the failed-weekly account is blocked");
  assert.equal(res.succeeded, 1, "the healthy account (A1) still derives");
  assert.ok(!saved.some((s) => s.accountId === "C1"), "no snapshot written for the blocked account");
  assert.equal(store.report("keyword-rank", "C1").fetch_status, "blocked", "C1 report is terminally blocked this cycle");
  assert.deepEqual(store._snapshots.get(SHADOW_KW + "|C1").payload, LKG, "last-known-good preserved for C1");
});

async function main() {
  mark("main(): loading keyword-rank e2e modules");
  ({ runKeywordRankShadowCycle } = await import("../lib/server/sync/keyword-rank-cycle.js"));
  ({ runReportJobs } = await import("../lib/server/sync/report-worker.js"));
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
