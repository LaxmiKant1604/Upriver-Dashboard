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

let runKeywordRankShadowCycle, runReportJobs, runStagedSourceCycle, reportSourceRequestHashes, plannedSourceJob;

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
      m.set(job.requestHash, { request_hash: job.requestHash, request_key: job.requestKey, source_id: job.sourceId, source_key: job.sourceKey, connection_id: job.connectionId, organization_fingerprint: job.organizationFingerprint, account_scope_hash: job.accountScopeHash, fetch_status: "pending", attempted_at: null, create_export_count: 0, export_id: null, terminal: false, row_count: null, cache_object_path: null });
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
  // C lists the full canonical required set (weekly + catalog); the FAILED weekly blocks the report at
  // the fetch gate (a required dependency failed), so catalog is never fetched -- blocked is terminal, so
  // the report never waits on the unscheduled catalog. Monthly is NOT required (weekly did not resolve < 4).
  assert.deepEqual(keysOf(C), ["keyword-rank:catalog", "keyword-rank:sqp-weekly"], "C lists the full required set (weekly + catalog)");
  assert.ok(!C.sources.some((s) => s.requestKey === "keyword-rank:sqp-monthly"), "no monthly required (weekly never resolved < 4)");

  const { res, saved } = await deriveReports(store, cycle.cycleId, cycle.plannedReports);
  assert.equal(res.blocked, 1, "the failed-weekly account is blocked (required weekly failed)");
  assert.equal(res.succeeded, 1, "the healthy account (A1) still derives");
  assert.ok(!saved.some((s) => s.accountId === "C1"), "no snapshot written for the blocked account");
  assert.equal(store.report("keyword-rank", "C1").fetch_status, "blocked", "C1 report is terminally blocked this cycle");
  assert.deepEqual(store._snapshots.get(SHADOW_KW + "|C1").payload, LKG, "last-known-good preserved for C1");
});

/* ===================== partial invocations keep incomplete reports PENDING (Blocker 2) ===================== */

group("keyword-rank e2e: checkpointed/partial invocation -> report stays pending -> resume -> derive once");

const bounded = (store, dd, accounts, opts) => runKeywordRankShadowCycle({ accounts, connections: CONNS, asOf: ASOF, store, dataDoe: dd, bucket: "us", cycleDate: "2026-08-11", ...opts });
const deadlineErr = () => Object.assign(new Error("deferred at the execution deadline"), { code: "DATADOE_DEADLINE" });
// Source double that defers (throws) the FIRST poll or download for a given request key, then succeeds.
function makeDeferDataDoe(rowsFn, { stage, key }) {
  const create = {}; let hits = 0;
  return {
    createCount: (h) => create[h] || 0,
    totalCreates: () => Object.values(create).reduce((a, b) => a + b, 0),
    async create(job) { create[job.requestHash] = (create[job.requestHash] || 0) + 1; return { exportId: "e_" + job.requestHash }; },
    async poll(job) { if (stage === "poll" && job.requestKey === key) { hits += 1; if (hits === 1) throw deadlineErr(); } },
    async download(job) { if (stage === "download" && job.requestKey === key) { hits += 1; if (hits === 1) throw deadlineErr(); } return rowsFn(job).rows; },
  };
}
const reportStatus = (store, acct) => { const j = store.report("keyword-rank", acct); return j ? { fetch: j.fetch_status, derive: j.derive_status, save: j.save_status } : null; };
const savedFor = (calls, acct) => calls.reduce((n, c) => n + c.saved.filter((s) => s.accountId === acct).length, 0);

// Run a partial keyword invocation, derive (report must stay pending), resume unbounded, derive again
// (report must derive+save exactly once). Returns evidence. `firstDD` may defer; `resumeOpts` bounds resume.
async function partialThenResume({ account, first, resumeRounds = 3 }) {
  const store = makeStore();
  const dd = first.dd;
  // LKG snapshot from a prior run; partial/pending states must NOT overwrite it.
  const LKG = { cadence: "weekly", weeklyPeriodCount: 9, rows: [], products: [], catalogBrands: [], periods: ["2024-12-31"], accountId: account.accountId, retrievedAt: null };
  store.seedSnapshot(SHADOW_KW, account.accountId, LKG);
  const calls = [];

  const c1 = await bounded(store, dd, [account], first.opts);
  const d1 = await deriveReports(store, c1.cycleId, c1.plannedReports);
  calls.push(d1);

  const partial = {
    pending: d1.res.pending, blocked: d1.res.blocked, failed: d1.res.failed,
    status: reportStatus(store, account.accountId),
    lkgIntact: JSON.stringify(store._snapshots.get(SHADOW_KW + "|" + account.accountId).payload) === JSON.stringify(LKG),
    savedDuringPartial: savedFor(calls, account.accountId),
  };

  // Resume: a fresh invocation over the SAME cycle finishes the remaining source work, then derives.
  const c2 = await bounded(store, dd, [account], { maxRounds: resumeRounds });
  const d2 = await deriveReports(store, c2.cycleId, c2.plannedReports);
  calls.push(d2);
  // A redundant third derivation proves the snapshot is written exactly once (idempotent).
  const d3 = await deriveReports(store, c2.cycleId, c2.plannedReports);
  calls.push(d3);

  const perHashCreates = c2.plannedReports[0].sources.map((s) => dd.createCount(s.requestHash));
  return {
    store, dd, cycleId: c2.cycleId, partial,
    finalStatus: reportStatus(store, account.accountId),
    savedTotal: savedFor(calls, account.accountId),
    finalPayload: store._snapshots.get(SHADOW_KW + "|" + account.accountId).payload,
    perHashCreates,
  };
}

test("maxJobs:1 (weekly-high): weekly succeeds, catalog not staged -> report PENDING (no failure/snapshot), then resumes and derives exactly once", async () => {
  const r = await partialThenResume({ account: { accountId: "A1", country: "US", currency: "USD" }, first: { dd: makeDataDoe(standardRows), opts: { maxJobs: 1 } } });
  assert.equal(r.partial.pending, 1, "incomplete report is PENDING, not runnable");
  assert.equal(r.partial.failed, 0, "no derive failure during the partial invocation");
  assert.equal(r.partial.status.derive, "pending", "report never marked derive-failed while catalog is unstaged");
  assert.equal(r.partial.savedDuringPartial, 0, "no snapshot written during the partial invocation");
  assert.ok(r.partial.lkgIntact, "last-known-good preserved during the partial state");
  assert.equal(r.finalStatus.derive, "succeeded", "resumes and derives after catalog is staged");
  assert.equal(r.savedTotal, 1, "exactly one snapshot written across all invocations");
  assert.equal(r.finalPayload.cadence, "weekly");
  assert.ok(r.perHashCreates.every((n) => n <= 1), "each canonical hash created at most once (no duplicate export)");
});

test("maxRounds:1 (weekly-high): catalog round never runs -> report PENDING, then resume derives once", async () => {
  const r = await partialThenResume({ account: { accountId: "A1", country: "US", currency: "USD" }, first: { dd: makeDataDoe(standardRows), opts: { maxRounds: 1 } } });
  assert.equal(r.partial.pending, 1);
  assert.equal(r.partial.savedDuringPartial, 0);
  assert.ok(r.partial.lkgIntact);
  assert.equal(r.finalStatus.derive, "succeeded");
  assert.equal(r.savedTotal, 1);
  assert.ok(r.perHashCreates.every((n) => n <= 1), "no duplicate export on resume");
});

test("deadline during the weekly POLL: weekly stays attempted -> report PENDING, resumes with NO duplicate create -> derives once", async () => {
  const r = await partialThenResume({ account: { accountId: "A1", country: "US", currency: "USD" }, first: { dd: makeDeferDataDoe(standardRows, { stage: "poll", key: "keyword-rank:sqp-weekly" }), opts: {} } });
  assert.equal(r.partial.pending, 1, "a resumable (attempted) weekly leaves the report PENDING, not blocked");
  assert.equal(r.partial.failed, 0);
  assert.equal(r.partial.savedDuringPartial, 0);
  assert.ok(r.partial.lkgIntact);
  assert.equal(r.finalStatus.derive, "succeeded");
  assert.equal(r.savedTotal, 1);
  assert.ok(r.perHashCreates.every((n) => n <= 1), "resume made no duplicate create-export POST");
});

test("deadline during the weekly DOWNLOAD: weekly stays attempted -> report PENDING, resumes with no duplicate create -> derives once", async () => {
  const r = await partialThenResume({ account: { accountId: "A1", country: "US", currency: "USD" }, first: { dd: makeDeferDataDoe(standardRows, { stage: "download", key: "keyword-rank:sqp-weekly" }), opts: {} } });
  assert.equal(r.partial.pending, 1);
  assert.equal(r.partial.savedDuringPartial, 0);
  assert.ok(r.partial.lkgIntact);
  assert.equal(r.finalStatus.derive, "succeeded");
  assert.equal(r.savedTotal, 1);
  assert.ok(r.perHashCreates.every((n) => n <= 1));
});

test("weekly-low: report stays PENDING while monthly, then catalog, are staged across invocations; derives once at the end", async () => {
  const store = makeStore();
  const dd = makeDataDoe(standardRows);
  const account = { accountId: SECONDARY + ":B1", country: "US", currency: "USD" };
  const LKG = { cadence: "monthly", weeklyPeriodCount: 1, rows: [], products: [], catalogBrands: [], periods: ["2024-11-30"], accountId: account.accountId, retrievedAt: null };
  store.seedSnapshot(SHADOW_KW, account.accountId, LKG);
  const calls = [];
  const derive = async (c) => { const d = await deriveReports(store, c.cycleId, c.plannedReports); calls.push(d); return d; };

  // Invocation 1: weekly only (maxJobs:1). Report requires weekly + monthly + catalog -> PENDING.
  const c1 = await bounded(store, dd, [account], { maxJobs: 1 });
  const d1 = await derive(c1);
  assert.deepEqual(keysOf(c1.plannedReports[0]), ["keyword-rank:catalog", "keyword-rank:sqp-monthly", "keyword-rank:sqp-weekly"], "weekly-low report lists the full fallback set up front");
  assert.equal(d1.res.pending, 1, "pending: monthly + catalog not yet staged");

  // Invocation 2: monthly staged (maxJobs:1). Catalog still missing -> still PENDING.
  const c2 = await bounded(store, dd, [account], { maxJobs: 1 });
  const d2 = await derive(c2);
  assert.equal(d2.res.pending, 1, "still pending: catalog not yet staged");
  assert.equal(savedFor(calls, account.accountId), 0, "no snapshot while any required dependency is unstaged");
  assert.equal(JSON.stringify(store._snapshots.get(SHADOW_KW + "|" + account.accountId).payload), JSON.stringify(LKG), "LKG preserved throughout");

  // Invocation 3: catalog staged (unbounded). Now all required sources succeeded -> derive once.
  const c3 = await bounded(store, dd, [account], {});
  const d3 = await derive(c3);
  assert.equal(d3.res.succeeded, 1, "derives once monthly + catalog are present");
  assert.equal(savedFor(calls, account.accountId), 1, "exactly one snapshot written");
  assert.equal(store._snapshots.get(SHADOW_KW + "|" + account.accountId).payload.cadence, "monthly", "monthly cadence saved");
  for (const s of c3.plannedReports[0].sources) assert.ok(dd.createCount(s.requestHash) <= 1, "no duplicate export for " + s.requestKey);
});

test("an unrelated (complete) report derives normally while an incomplete report stays pending in the same runReportJobs", async () => {
  const store = makeStore();
  const dd = makeDataDoe(standardRows);
  // D1 fully drains (weekly + catalog). A1 is bounded to weekly only (catalog pending).
  const cD = await bounded(store, dd, [{ accountId: "D1", country: "US", currency: "USD" }], {});
  const cA = await bounded(store, dd, [{ accountId: "A1", country: "US", currency: "USD" }], { maxJobs: 1 });
  assert.equal(cA.cycleId, cD.cycleId, "same shared cycle");
  const { res, saved } = await deriveReports(store, cD.cycleId, [cD.plannedReports[0], cA.plannedReports[0]]);
  assert.equal(res.succeeded, 1, "the complete report (D1) derives");
  assert.equal(res.pending, 1, "the incomplete report (A1) stays pending");
  assert.ok(saved.some((s) => s.accountId === "D1") && !saved.some((s) => s.accountId === "A1"), "only the complete report is saved");
  assert.equal(reportStatus(store, "A1").derive, "pending", "the pending report is never derive-failed");
});

/* ===================== REAL generic driver + REAL keyword driver share ONE cycle (Blocker 2) ===================== */

group("keyword-rank e2e: real runStagedSourceCycle + runKeywordRankShadowCycle coexist in one shared cycle");

// The REAL generic staged driver, driven over a simple no-fallback report (brand-sales) for account G1
// on the primary org. Not a test-only runSourceJobs helper -- this is the production runStagedSourceCycle.
const GEN_WIN = { "brand-sales:order-lines": [{ from: "2025-01-01", to: "2025-06-30" }], "brand-sales:catalog": [{ from: "2025-01-01", to: "2025-06-30" }] };
const genResolve = () => {
  const resolved = reportSourceRequestHashes({ reportKey: "brand-sales", apiKey: dash("prim", "key"), ids: ["G1"], windowsByRequestKey: GEN_WIN }) || [];
  return { sourceJobs: resolved.map((r) => plannedSourceJob("brand-sales", r, "us", "primary")) };
};
const runGenericDriver = (store, dd, opts = {}) => runStagedSourceCycle({ store, dataDoe: dd, resolvePlan: genResolve, bucket: "us", cycleDate: "2026-08-11", ...opts });
const runKw = (store, dd, accounts, opts = {}) => runKeywordRankShadowCycle({ accounts, connections: CONNS, asOf: ASOF, store, dataDoe: dd, bucket: "us", cycleDate: "2026-08-11", ...opts });
const KW_ACCOUNTS = [{ accountId: "A1", country: "US", currency: "USD" }, { accountId: "A2", country: "US", currency: "USD" }];
const noMissingPlan = (store, cid) => store.listSourceJobs(cid).every((j) => j.error_code !== "MISSING_PLAN");
const isKw = (j) => String(j.request_key).startsWith("keyword-rank:");
const isGen = (j) => String(j.request_key).startsWith("brand-sales:");

async function coexist(order) {
  const store = makeStore();
  const dd = makeDataDoe(standardRows);
  // Pre-queue PENDING jobs of BOTH families using the REAL drivers, bounded so some stay pending:
  //   - keyword [A1,A2] maxJobs:1 -> A1 weekly succeeds, A2 weekly stays PENDING;
  //   - generic maxJobs:1        -> one brand-sales source succeeds, the other stays PENDING.
  await runKw(store, dd, KW_ACCOUNTS, { maxJobs: 1 });
  await runGenericDriver(store, dd, { maxJobs: 1 });
  const cid = store.openCycle({ bucket: "us", cycleDate: "2026-08-11" });
  const pendingBefore = store.listSourceJobs(cid).filter((j) => j.fetch_status === "pending");
  assert.ok(pendingBefore.some(isKw) && pendingBefore.some(isGen), "both families have a pending job before either unbounded worker runs");

  // Run the REAL drivers UNBOUNDED in the requested order.
  const steps = order === "generic-first"
    ? [() => runGenericDriver(store, dd, {}), () => runKw(store, dd, KW_ACCOUNTS, {})]
    : [() => runKw(store, dd, KW_ACCOUNTS, {}), () => runGenericDriver(store, dd, {})];
  await steps[0]();
  assert.ok(noMissingPlan(store, cid), `no MISSING_PLAN after step 1 (${order})`);
  await steps[1]();
  assert.ok(noMissingPlan(store, cid), `no MISSING_PLAN after step 2 (${order})`);

  const jobs = store.listSourceJobs(cid);
  assert.ok(jobs.filter(isGen).length >= 2 && jobs.filter(isGen).every((j) => j.fetch_status === "succeeded"), "all generic jobs succeeded");
  assert.ok(jobs.filter(isKw).length >= 4 && jobs.filter(isKw).every((j) => j.fetch_status === "succeeded"), "all keyword jobs succeeded (A1 + A2)");
  for (const j of jobs) assert.ok(dd.createCount(j.request_hash) <= 1, "at most one create-export for " + j.request_key);
  // Same-request-key keyword jobs for DIFFERENT accounts resolved to distinct hashes (account isolation).
  const weeklyHashes = jobs.filter((j) => j.request_key === "keyword-rank:sqp-weekly").map((j) => j.request_hash);
  assert.equal(new Set(weeklyHashes).size, weeklyHashes.length, "A1 and A2 weekly hashes are distinct (same key, isolated)");
}

test("coexistence order 1: real generic driver first, then real keyword driver -- neither MISSING_PLANs the other; both complete; one export per hash", async () => {
  await coexist("generic-first");
});

test("coexistence order 2: real keyword driver first, then real generic driver -- neither MISSING_PLANs the other; both complete; one export per hash", async () => {
  await coexist("keyword-first");
});

test("during coexistence a partial keyword report stays PENDING, then saves exactly once after keyword source work completes", async () => {
  const store = makeStore();
  const dd = makeDataDoe(standardRows);
  const A1 = { accountId: "A1", country: "US", currency: "USD" };
  // Keyword bounded to weekly only (catalog unstaged) + the REAL generic driver runs to completion alongside.
  const kwPartial = await runKw(store, dd, [A1], { maxJobs: 1 });
  await runGenericDriver(store, dd, {});
  // The generic driver completing does NOT let the incomplete keyword report derive: catalog is unstaged.
  const d1 = await deriveReports(store, kwPartial.cycleId, kwPartial.plannedReports);
  assert.equal(d1.res.pending, 1, "keyword report is PENDING while catalog is unstaged");
  assert.equal(d1.saved.length, 0, "no snapshot written during the partial state");
  assert.ok(noMissingPlan(store, kwPartial.cycleId), "generic completion never MISSING_PLANs the pending keyword job");
  // Resume keyword to completion, then derive: saves exactly once.
  const kwDone = await runKw(store, dd, [A1], {});
  const d2 = await deriveReports(store, kwDone.cycleId, kwDone.plannedReports);
  const d3 = await deriveReports(store, kwDone.cycleId, kwDone.plannedReports);
  assert.equal(d2.res.succeeded, 1, "derives once keyword sources complete");
  assert.equal(d2.saved.length + d3.saved.length, 1, "exactly one snapshot across the resumed + redundant derivations");
  assert.equal(store.report("keyword-rank", "A1").derive_status, "succeeded");
});

async function main() {
  mark("main(): loading keyword-rank e2e modules");
  ({ runKeywordRankShadowCycle } = await import("../lib/server/sync/keyword-rank-cycle.js"));
  ({ runReportJobs } = await import("../lib/server/sync/report-worker.js"));
  ({ runStagedSourceCycle, plannedSourceJob } = await import("../lib/server/sync/source-sync-driver.js"));
  ({ reportSourceRequestHashes } = await import("../lib/server/sync/report-source-contracts.js"));
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
