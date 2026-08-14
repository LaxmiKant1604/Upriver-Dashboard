// Scheduler v2 -- cycle lifecycle + finalization + concurrency (deterministic OFFLINE).
//
// Proves Blocker 1's fix: the canonical dispatcher OWNS cycle finalization; a genuine terminal drain becomes a
// terminal status with finished_at + authoritative source AND report counters; non-drained/deferred/deadline/
// maxJobs work stays running (finished_at null, resumable); finalization is guarded + idempotent; and neither a
// manual subset, a concurrent continuation, nor a stale finalizer can prematurely close a cycle (and no work
// can be appended after terminalization). The in-memory finalizeCycle + append-guard MODEL the semantics of the
// PREPARED (unapplied) finalize_sync_cycle RPC + reject_append_to_terminal_cycle trigger
// (supabase/migrations/20260815_sync_cycle_finalize.sql), reusing the real cycle-lifecycle.js pure logic. NO
// network, DataDoe, or Supabase I/O.
//
// 7-bit ASCII, LF. Run: node scripts/cycle-lifecycle.test.js

import assert from "node:assert/strict";
import { writeSync } from "node:fs";

process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://supabase.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "test-svc-role";
process.env.DATADOE_API_KEY = process.env.DATADOE_API_KEY || "test-primary";

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };

let lc, runSchedulerV2Shadow;

// ---- an in-memory cycle store that MODELS the guarded finalize RPC + the append-after-terminal trigger ----
// A single cycle, cycle-scoped source/report jobs. finalizeCycle mirrors finalize_sync_cycle; the upserts
// mirror the reject_append_to_terminal_cycle trigger.
function makeCycleModel() {
  const cycle = { id: "cyc", status: "running", finished_at: null, source_total: 0, source_succeeded: 0, source_failed: 0, report_total: 0, report_succeeded: 0, report_failed: 0 };
  const source = new Map(); // request_hash -> job
  const report = new Map(); // key -> job
  const TERMINAL = new Set(["succeeded", "partial", "failed"]);
  const guardTerminal = () => { if (TERMINAL.has(cycle.status)) throw new Error(`cycle ${cycle.id} is terminal (${cycle.status}); refusing to append/alter child work`); };
  return {
    cycle,
    addSource(hash, fetch_status = "pending") { guardTerminal(); source.set(hash, { request_hash: hash, fetch_status, create_export_count: 0 }); },
    setSource(hash, patch) { guardTerminal(); Object.assign(source.get(hash), patch); },
    addReport(key, patch = {}) { guardTerminal(); report.set(key, { key, fetch_status: "pending", derive_status: "pending", save_status: "pending", ...patch }); },
    setReport(key, patch) { guardTerminal(); Object.assign(report.get(key), patch); },
    sources: () => [...source.values()].map((j) => ({ ...j })),
    reports: () => [...report.values()].map((j) => ({ ...j })),
    // MODEL of finalize_sync_cycle(p_cycle_id, p_expect_status): guarded, atomic, recomputes counters.
    finalizeCycle({ cycleId, expectStatus = "running" }) {
      if (cycleId !== cycle.id) return null;
      if (cycle.status !== expectStatus) return null;                       // idempotent / already terminal (row 9)
      const src = [...source.values()], rep = [...report.values()];
      if (!lc.cycleFullyDrained(src, rep)) return null;                     // GUARD: open work -> decline (rows 7-8)
      const c = lc.computeCycleCounters(src, rep);
      cycle.status = lc.terminalCycleStatus(c);
      cycle.finished_at = "t";
      Object.assign(cycle, { source_total: c.sourceTotal, source_succeeded: c.sourceSucceeded, source_failed: c.sourceFailed, report_total: c.reportTotal, report_succeeded: c.reportSucceeded, report_failed: c.reportFailed });
      return { ...cycle };
    },
  };
}

// ============================= Part 1: pure state-table unit tests =============================

test("(pure) terminalCycleStatus follows the state table", () => {
  assert.equal(lc.terminalCycleStatus({ sourceSucceeded: 2, sourceFailed: 0, reportSucceeded: 1, reportFailed: 0 }), "succeeded");
  assert.equal(lc.terminalCycleStatus({ sourceSucceeded: 1, sourceFailed: 1, reportSucceeded: 1, reportFailed: 0 }), "partial");
  assert.equal(lc.terminalCycleStatus({ sourceSucceeded: 1, sourceFailed: 0, reportSucceeded: 0, reportFailed: 1 }), "partial");
  assert.equal(lc.terminalCycleStatus({ sourceSucceeded: 0, sourceFailed: 2, reportSucceeded: 0, reportFailed: 0 }), "failed");
  assert.equal(lc.terminalCycleStatus({ sourceSucceeded: 0, sourceFailed: 0, reportSucceeded: 0, reportFailed: 1 }), "failed");
  assert.equal(lc.terminalCycleStatus({}), "succeeded"); // vacuous: nothing failed
});

test("(pure) open-job classifiers + drained + counters", () => {
  assert.equal(lc.isSourceJobOpen({ fetch_status: "pending" }), true);
  assert.equal(lc.isSourceJobOpen({ fetch_status: "attempted" }), true);
  for (const s of ["succeeded", "failed", "skipped"]) assert.equal(lc.isSourceJobOpen({ fetch_status: s }), false);
  assert.equal(lc.isReportJobFinished({ fetch_status: "blocked" }), true);
  assert.equal(lc.isReportJobFinished({ derive_status: "succeeded", save_status: "succeeded" }), true);
  assert.equal(lc.isReportJobFinished({ derive_status: "failed" }), true);
  assert.equal(lc.isReportJobFinished({ save_status: "failed" }), true);
  assert.equal(lc.isReportJobFinished({ derive_status: "pending", save_status: "pending" }), false);
  assert.equal(lc.isReportJobSuccess({ derive_status: "succeeded", save_status: "succeeded" }), true);
  assert.equal(lc.isReportJobSuccess({ derive_status: "succeeded", save_status: "failed" }), false);
  assert.equal(lc.cycleFullyDrained([{ fetch_status: "succeeded" }], [{ derive_status: "succeeded", save_status: "succeeded" }]), true);
  assert.equal(lc.cycleFullyDrained([{ fetch_status: "attempted" }], []), false);
  assert.equal(lc.cycleFullyDrained([], [{ derive_status: "pending", save_status: "pending" }]), false);
  const c = lc.computeCycleCounters(
    [{ fetch_status: "succeeded" }, { fetch_status: "failed" }],
    [{ derive_status: "succeeded", save_status: "succeeded" }, { fetch_status: "blocked" }],
  );
  assert.deepEqual(c, { sourceTotal: 2, sourceSucceeded: 1, sourceFailed: 1, reportTotal: 2, reportSucceeded: 1, reportFailed: 1 });
});

// ============================= Part 2: guarded finalize + concurrency =============================

test("(finalize) fully drained success -> succeeded, finished_at set, exact source+report counters", () => {
  const m = makeCycleModel();
  m.addSource("h1", "succeeded"); m.addSource("h2", "succeeded");
  m.addReport("brand-sales|A1", { fetch_status: "ready", derive_status: "succeeded", save_status: "succeeded" });
  const row = m.finalizeCycle({ cycleId: "cyc" });
  assert.ok(row); assert.equal(row.status, "succeeded"); assert.equal(m.cycle.finished_at, "t");
  assert.equal(m.cycle.source_total, 2); assert.equal(m.cycle.source_succeeded, 2); assert.equal(m.cycle.source_failed, 0);
  assert.equal(m.cycle.report_total, 1); assert.equal(m.cycle.report_succeeded, 1); assert.equal(m.cycle.report_failed, 0);
});

test("(finalize) drained with a failed source -> partial; all-failed -> failed (state table rows 2-3)", () => {
  const p = makeCycleModel();
  p.addSource("h1", "succeeded"); p.addSource("h2", "failed");
  p.addReport("r|A1", { fetch_status: "blocked" }); // blocked report counts as a failure
  const rp = p.finalizeCycle({ cycleId: "cyc" });
  assert.equal(rp.status, "partial"); assert.equal(p.cycle.report_failed, 1); assert.equal(p.cycle.source_failed, 1);

  const f = makeCycleModel();
  f.addSource("h1", "failed"); f.addSource("h2", "failed");
  const rf = f.finalizeCycle({ cycleId: "cyc" });
  assert.equal(rf.status, "failed"); assert.equal(f.cycle.finished_at, "t");
});

test("(finalize) an OPEN source or report job DECLINES finalization -> stays running, finished_at null", () => {
  const s = makeCycleModel();
  s.addSource("h1", "succeeded"); s.addSource("h2", "attempted"); // one still resumable
  assert.equal(s.finalizeCycle({ cycleId: "cyc" }), null);
  assert.equal(s.cycle.status, "running"); assert.equal(s.cycle.finished_at, null);

  const r = makeCycleModel();
  r.addSource("h1", "succeeded");
  r.addReport("r|A1", { derive_status: "pending", save_status: "pending" }); // report not finished
  assert.equal(r.finalizeCycle({ cycleId: "cyc" }), null);
  assert.equal(r.cycle.status, "running");
});

test("(finalize) idempotent -- a second finalize returns null and never changes a terminal cycle (row 9)", () => {
  const m = makeCycleModel();
  m.addSource("h1", "succeeded");
  const first = m.finalizeCycle({ cycleId: "cyc" });
  assert.equal(first.status, "succeeded");
  const finishedAt = m.cycle.finished_at;
  const second = m.finalizeCycle({ cycleId: "cyc" });
  assert.equal(second, null, "second finalize is a no-op");
  assert.equal(m.cycle.status, "succeeded"); assert.equal(m.cycle.finished_at, finishedAt);
});

test("(concurrency A: append-then-finalize) a continuation that appended OPEN work makes finalize decline", () => {
  const m = makeCycleModel();
  m.addSource("h1", "succeeded");
  // a concurrent continuation appends a fresh pending source job BEFORE the (stale) finalizer runs
  m.addSource("h2", "pending");
  assert.equal(m.finalizeCycle({ cycleId: "cyc" }), null, "stale finalizer cannot close while open work exists");
  assert.equal(m.cycle.status, "running");
  // once that job drains, finalize succeeds
  m.setSource("h2", { fetch_status: "succeeded" });
  assert.equal(m.finalizeCycle({ cycleId: "cyc" }).status, "succeeded");
});

test("(concurrency B: finalize-then-append) after terminalization, appending any child work is REJECTED", () => {
  const m = makeCycleModel();
  m.addSource("h1", "succeeded");
  assert.equal(m.finalizeCycle({ cycleId: "cyc" }).status, "succeeded");
  assert.throws(() => m.addSource("h2", "pending"), /terminal/);        // no new source job after terminal
  assert.throws(() => m.addReport("r|A1"), /terminal/);                 // no new report job after terminal
  assert.throws(() => m.setSource("h1", { fetch_status: "failed" }), /terminal/); // no alteration after terminal
});

test("(manual subset / shared cycle) a subset drain cannot close a cycle that still has another owner's open work (row 7)", () => {
  const m = makeCycleModel();
  // this run's owned scope drained...
  m.addSource("owned-1", "succeeded");
  m.addReport("brand-sales|A1", { derive_status: "succeeded", save_status: "succeeded" });
  // ...but ANOTHER owner/report on the SAME shared cycle still has open work
  m.addSource("other-owner-1", "pending");
  assert.equal(m.finalizeCycle({ cycleId: "cyc" }), null, "manual subset must not prematurely close the shared cycle");
  assert.equal(m.cycle.status, "running"); assert.equal(m.cycle.finished_at, null);
});

// ============================= Part 3: the dispatcher OWNS finalization =============================
// A compact dispatcher store (source + report + owner + cache) WITH a guarded finalizeCycle + append-guard.
function makeDispatchStore() {
  const cycles = new Map(), jobsByCycle = new Map(), ownersByCycle = new Map(), cache = new Map(), reportJobs = new Map();
  let seq = 0;
  const findCycle = (id) => [...cycles.values()].find((c) => c.id === id) || null;
  const cycleOfReport = new Map();
  const TERMINAL = new Set(["succeeded", "partial", "failed"]);
  const guard = (cid) => { const c = findCycle(cid); if (c && TERMINAL.has(c.status)) throw new Error(`cycle ${cid} terminal; refusing append`); };
  const ownerRows = (cid) => [...((ownersByCycle.get(cid) && ownersByCycle.get(cid).values()) || [])];
  const rkey = (rk, a) => rk + "|" + a;
  const store = {
    finalizeCalls: 0,
    openCycle({ bucket, cycleDate }) { const k = bucket + "|" + cycleDate; if (!cycles.has(k)) { const id = "cyc_" + (seq += 1); cycles.set(k, { id, bucket, status: "pending", finished_at: null }); jobsByCycle.set(id, new Map()); } return cycles.get(k).id; },
    claimCycle(id) { const c = findCycle(id); if (c && c.status === "pending") { c.status = "running"; return true; } return false; },
    getCycle(id) { return findCycle(id); },
    upsertSourceJob(job) { guard(job.cycleId); const m = jobsByCycle.get(job.cycleId); if (m.has(job.requestHash)) return; m.set(job.requestHash, { cycle_id: job.cycleId, request_hash: job.requestHash, request_key: job.requestKey, source_id: job.sourceId, source_key: job.sourceKey, connection_id: job.connectionId, organization_fingerprint: job.organizationFingerprint, account_scope_hash: job.accountScopeHash, fetch_status: "pending", attempted_at: null, create_export_count: 0, export_id: null, terminal: false, row_count: null }); },
    listSourceJobs(id) { return [...((jobsByCycle.get(id) && jobsByCycle.get(id).values()) || [])].map((j) => ({ ...j })); },
    upsertSourceJobOwners(ms) { for (const m of ms || []) { guard(m.cycleId); if (!ownersByCycle.has(m.cycleId)) ownersByCycle.set(m.cycleId, new Map()); ownersByCycle.get(m.cycleId).set(m.ownerId + "|" + m.requestHash, { cycle_id: m.cycleId, request_hash: m.requestHash, owner_id: m.ownerId, request_key: m.requestKey, report_key: m.reportKey, account_id: m.accountId, connection_id: m.connectionId, organization_fingerprint: m.organizationFingerprint, account_scope_hash: m.accountScopeHash, owner_status: "active", error_code: null }); } },
    listSourceJobOwners(cid, ids) { const s = new Set(ids || []); return ownerRows(cid).filter((m) => s.has(m.owner_id)).map((m) => ({ ...m })); },
    listSourceJobsForOwners(cid, ids) { const s = new Set(ids || []); const hs = new Set(ownerRows(cid).filter((m) => s.has(m.owner_id) && m.owner_status !== "stale").map((m) => m.request_hash)); return this.listSourceJobs(cid).filter((j) => hs.has(j.request_hash)); },
    recordSourceOwnerStale({ cycleId, requestHash, ownerId, code }) { const m = ownersByCycle.get(cycleId) && ownersByCycle.get(cycleId).get(ownerId + "|" + requestHash); if (m) { m.owner_status = "stale"; m.error_code = code || "STALE_PLAN"; } },
    claimExportAttempt(id, h) { const j = jobsByCycle.get(id) && jobsByCycle.get(id).get(h); if (j && j.attempted_at === null) { j.attempted_at = "t"; j.create_export_count += 1; j.fetch_status = "attempted"; return true; } return false; },
    recordExportCreated({ cycleId, requestHash, exportId }) { jobsByCycle.get(cycleId).get(requestHash).export_id = exportId; },
    loadSourceRows(h) { const e = cache.get(h); return e ? { rows: e.rows } : null; },
    saveSourceRows({ job, rows }) { const h = job.request_hash != null ? job.request_hash : job.requestHash; cache.set(h, { rows: [...rows] }); return "p/" + h; },
    recordSourceSuccess({ cycleId, requestHash, exportId, rowCount, cacheObjectPath }) { Object.assign(jobsByCycle.get(cycleId).get(requestHash), { fetch_status: "succeeded", export_id: exportId, row_count: rowCount, cache_object_path: cacheObjectPath }); },
    recordSourceFailure({ cycleId, requestHash, stage, code, terminal }) { Object.assign(jobsByCycle.get(cycleId).get(requestHash), { fetch_status: "failed", error_stage: stage, error_code: code, terminal: !!terminal }); },
    updateCycleCounts() {},
    listReportJobs(cid) { return [...reportJobs.values()].filter((j) => !cid || cycleOfReport.get(j.report_key + "|" + j.account_id) === cid).map((j) => ({ ...j })); },
    upsertReportJob({ cycleId, reportKey, accountId, connectionId, bucket, reportVersion, dependsOn }) { const k = rkey(reportKey, accountId); if (reportJobs.has(k)) return; if (cycleId) guard(cycleId); reportJobs.set(k, { report_key: reportKey, account_id: accountId, connection_id: connectionId, bucket, report_version: reportVersion, depends_on: dependsOn || [], fetch_status: "pending", derive_status: "pending", save_status: "pending", validated: false }); if (cycleId) cycleOfReport.set(k, cycleId); },
    claimReportDerive(_c, rk, a) { const j = reportJobs.get(rkey(rk, a)); if (j && j.derive_status === "pending") { j.derive_status = "running"; return true; } return false; },
    recordReportBlocked({ reportKey, accountId }) { Object.assign(reportJobs.get(rkey(reportKey, accountId)), { fetch_status: "blocked", derive_status: "skipped", save_status: "skipped" }); },
    recordReportFailure({ reportKey, accountId, stage, code }) { Object.assign(reportJobs.get(rkey(reportKey, accountId)), { derive_status: stage === "save" ? "succeeded" : "failed", save_status: stage === "save" ? "failed" : "pending", error_code: code }); },
    recordReportSuccess({ reportKey, accountId, latestDataDate }) { Object.assign(reportJobs.get(rkey(reportKey, accountId)), { fetch_status: "ready", derive_status: "succeeded", save_status: "succeeded", validated: true, latest_data_date: latestDataDate ?? null }); },
    // guarded finalize modeling finalize_sync_cycle: recompute counters, decline while open work exists.
    finalizeCycle({ cycleId, expectStatus = "running" }) {
      store.finalizeCalls += 1;
      const c = findCycle(cycleId);
      if (!c || c.status !== expectStatus) return null;
      const src = this.listSourceJobs(cycleId);
      const rep = this.listReportJobs(cycleId);
      if (!lc.cycleFullyDrained(src, rep)) return null;
      const k = lc.computeCycleCounters(src, rep);
      c.status = lc.terminalCycleStatus(k); c.finished_at = "t";
      Object.assign(c, { source_total: k.sourceTotal, source_succeeded: k.sourceSucceeded, source_failed: k.sourceFailed, report_total: k.reportTotal, report_succeeded: k.reportSucceeded, report_failed: k.reportFailed });
      return { ...c };
    },
  };
  return store;
}
function makeDataDoe(opts = {}) {
  const create = {}; const pollHits = {};
  const deadlineErr = () => Object.assign(new Error("deferred"), { code: "DATADOE_DEADLINE" });
  return {
    totalCreates: () => Object.values(create).reduce((a, b) => a + b, 0),
    createCount: (h) => create[h] || 0,
    async create(job) { create[job.requestHash] = (create[job.requestHash] || 0) + 1; return { exportId: "e_" + job.requestHash }; },
    async poll(job) { const k = job.requestKey || ""; if (opts.deferPollKey && k === opts.deferPollKey) { pollHits[k] = (pollHits[k] || 0) + 1; if (pollHits[k] === 1) throw deadlineErr(); } },
    async download(job) { const rk = job.requestKey || ""; if (rk.endsWith(":catalog")) return [{ child_asin: "A", parent_asin: "P", product_name: "P", product_brand: "Acme" }]; return [{ x: 1 }]; },
  };
}
const CONNS = [{ id: "primary", apiKey: "org-primary", accountPrefix: "" }];
const US_ACCTS = [{ accountId: "A1", country: "US", currency: "USD", name: "Acct One" }];
const mkCatalog = (ready = [], enabled = ready) => () => [...new Set([...ready, ...enabled])].map((rk) => ({ reportKey: rk, ready: ready.includes(rk), scheduleEnabled: enabled.includes(rk) }));
const saver = async () => ({ paramsHash: "ph" });
const dispatch = (over = {}) => runSchedulerV2Shadow({
  bucket: "us", cycleDate: "2026-08-11", asOf: "2026-08-01",
  connections: CONNS, discoverAccounts: async () => US_ACCTS,
  store: over.store, dataDoe: over.dataDoe, saveSnapshot: saver,
  controlCatalog: over.controlCatalog, manualReportKeys: over.manualReportKeys,
  maxJobs: over.maxJobs, deadlineMs: over.deadlineMs, clock: over.clock,
});

test("(dispatcher) a genuine terminal drain FINALIZES the cycle: terminal status + finished_at + persisted counters", async () => {
  const store = makeDispatchStore();
  const r = await dispatch({ store, dataDoe: makeDataDoe(), manualReportKeys: ["brand-sales"], controlCatalog: mkCatalog(["brand-sales"]) });
  assert.equal(r.drained, true, "the run drained");
  assert.equal(r.finalized, true, "the dispatcher owns + performed finalization");
  assert.ok(["succeeded", "partial", "failed"].includes(r.cycleStatus), "cycle reached a terminal status");
  const c = store.getCycle(r.cycleId);
  assert.ok(["succeeded", "partial", "failed"].includes(c.status));
  assert.equal(c.finished_at, "t", "finished_at is stamped on terminalization");
  assert.equal(c.source_total, store.listSourceJobs(r.cycleId).length, "authoritative source counters persisted");
  assert.equal(c.report_total, store.listReportJobs(r.cycleId).length, "authoritative report counters persisted");
  // report counters were persisted (Blocker 1: previously nothing wrote them)
  assert.equal(c.report_succeeded + c.report_failed <= c.report_total, true);
});

test("(dispatcher) maxJobs truncation does NOT finalize -- cycle stays running, finished_at null (resumable)", async () => {
  const store = makeDispatchStore();
  // brand-sales has 2 source hashes; maxJobs:1 truncates -> not drained
  const r = await dispatch({ store, dataDoe: makeDataDoe(), manualReportKeys: ["brand-sales"], controlCatalog: mkCatalog(["brand-sales"]), maxJobs: 1 });
  assert.equal(r.drained, false, "a maxJobs truncation is not drained");
  assert.equal(r.finalized, false, "no finalization on a non-drained run");
  const c = store.getCycle(r.cycleId);
  assert.equal(c.status, "running"); assert.equal(c.finished_at, null);
});

test("(dispatcher) a resumable deferral does NOT finalize; a fresh invocation resumes + finalizes with NO duplicate create-export", async () => {
  const store = makeDispatchStore();
  const dd1 = makeDataDoe({ deferPollKey: "brand-sales:order-lines" }); // first poll defers
  const r1 = await dispatch({ store, dataDoe: dd1, manualReportKeys: ["brand-sales"], controlCatalog: mkCatalog(["brand-sales"]) });
  assert.equal(r1.drained, false, "deferral -> not drained");
  assert.equal(r1.finalized, false, "no finalization while a deferral is outstanding");
  assert.equal(store.getCycle(r1.cycleId).status, "running");
  const createsAfter1 = dd1.totalCreates();
  // resume: fresh dataDoe that no longer defers; the persisted export_id is reused (no second create)
  const dd2 = makeDataDoe();
  const r2 = await dispatch({ store, dataDoe: dd2, manualReportKeys: ["brand-sales"], controlCatalog: mkCatalog(["brand-sales"]) });
  assert.equal(r2.drained, true, "the resume drains");
  assert.equal(r2.finalized, true, "the resume finalizes");
  assert.equal(store.getCycle(r2.cycleId).finished_at, "t");
  assert.equal(dd2.totalCreates(), 0, "resume created ZERO new exports (persisted export_id reused) -- no duplicate create-export");
  void createsAfter1;
});

test("(dispatcher) a locked/no-op invocation (nothing dispatchable) never finalizes a cycle", async () => {
  const store = makeDispatchStore();
  const r = await dispatch({ store, dataDoe: makeDataDoe(), manualReportKeys: ["brand-sales"], controlCatalog: mkCatalog([]) }); // brand-sales NOT ready
  assert.equal(r.cycleId, null); assert.equal(r.finalized, false); assert.equal(store.finalizeCalls, 0);
});

async function main() {
  lc = await import("../lib/server/sync/cycle-lifecycle.js");
  ({ runSchedulerV2Shadow } = await import("../lib/server/sync/sync-dispatch.js"));
  for (const t of tests) {
    try { await t.fn(); passed += 1; out("  ok  " + t.name); }
    catch (e) { out("FAIL  " + t.name); out(String(e && e.stack ? e.stack : e)); process.exitCode = 1; return; }
  }
  out("\n" + passed + " assertions passed");
}
main();
