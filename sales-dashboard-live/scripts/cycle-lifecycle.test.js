// Scheduler v2 -- cycle lifecycle + finalization + concurrency + scope semantics (deterministic OFFLINE).
//
// Proves Blocker 1's fix: the canonical dispatcher OWNS cycle finalization via a GUARDED, TYPED-disposition
// finalize; auto-finalization is attempted ONLY for a COMPLETE SCHEDULED scope (manual subsets never terminalize
// the shared cycle -> the unplanned-manual-subset hole is closed); a drained scheduled cycle becomes terminal
// with finished_at + authoritative source AND report counters; open-work requests continuation; unknown/
// malformed dispositions fail closed; and neither ordering of append vs finalize can corrupt the cycle. The
// in-memory finalizeCycle + append-guard MODEL the semantics of the PREPARED (unapplied) finalize_sync_cycle
// RPC + reject_append_to_terminal_cycle trigger, reusing the real cycle-lifecycle.js pure logic.
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

// ---- in-memory cycle model: guarded finalizeCycle (TYPED disposition) + append-after-terminal guard ----
function makeCycleModel() {
  const cycle = { id: "cyc", status: "running", finished_at: null, source_total: 0, source_succeeded: 0, source_failed: 0, report_total: 0, report_succeeded: 0, report_failed: 0 };
  const source = new Map();
  const report = new Map();
  const TERMINAL = new Set(["succeeded", "partial", "failed"]);
  const guardTerminal = () => { if (TERMINAL.has(cycle.status)) throw new Error(`cycle ${cycle.id} is terminal (${cycle.status}); refusing to append/alter child work`); };
  return {
    cycle,
    addSource(hash, fetch_status = "pending") { guardTerminal(); source.set(hash, { request_hash: hash, fetch_status }); },
    setSource(hash, patch) { guardTerminal(); Object.assign(source.get(hash), patch); },
    addReport(key, patch = {}) { guardTerminal(); report.set(key, { key, fetch_status: "pending", derive_status: "pending", save_status: "pending", ...patch }); },
    finalizeCycle({ cycleId }) {
      if (cycleId !== cycle.id) return { disposition: "not-found", cycle: null };
      if (TERMINAL.has(cycle.status)) return { disposition: "already-terminal", cycle: { ...cycle } };
      if (cycle.status !== "running") return { disposition: "invalid-status", cycle: null };
      const src = [...source.values()], rep = [...report.values()];
      if (!lc.cycleFullyDrained(src, rep)) return { disposition: "open-work", cycle: null };
      const c = lc.computeCycleCounters(src, rep);
      cycle.status = lc.terminalCycleStatus(c); cycle.finished_at = "t";
      Object.assign(cycle, { source_total: c.sourceTotal, source_succeeded: c.sourceSucceeded, source_failed: c.sourceFailed, report_total: c.reportTotal, report_succeeded: c.reportSucceeded, report_failed: c.reportFailed });
      return { disposition: "finalized", cycle: { ...cycle } };
    },
  };
}

// ============================= Part 1: pure state-table unit tests =============================

test("(pure) terminalCycleStatus + classifiers + counters + cycleFullyDrained", () => {
  assert.equal(lc.terminalCycleStatus({ sourceSucceeded: 2, reportSucceeded: 1 }), "succeeded");
  assert.equal(lc.terminalCycleStatus({ sourceSucceeded: 1, sourceFailed: 1 }), "partial");
  assert.equal(lc.terminalCycleStatus({ reportFailed: 1 }), "failed");
  assert.equal(lc.isSourceJobOpen({ fetch_status: "attempted" }), true);
  for (const s of ["succeeded", "failed", "skipped"]) assert.equal(lc.isSourceJobOpen({ fetch_status: s }), false);
  assert.equal(lc.isReportJobFinished({ fetch_status: "blocked" }), true);
  assert.equal(lc.isReportJobFinished({ derive_status: "succeeded", save_status: "succeeded" }), true);
  assert.equal(lc.isReportJobFinished({ derive_status: "pending", save_status: "pending" }), false);
  assert.equal(lc.cycleFullyDrained([{ fetch_status: "succeeded" }], [{ derive_status: "succeeded", save_status: "succeeded" }]), true);
  assert.equal(lc.cycleFullyDrained([{ fetch_status: "attempted" }], []), false);
  assert.deepEqual(lc.computeCycleCounters([{ fetch_status: "succeeded" }, { fetch_status: "failed" }], [{ derive_status: "succeeded", save_status: "succeeded" }, { fetch_status: "blocked" }]),
    { sourceTotal: 2, sourceSucceeded: 1, sourceFailed: 1, reportTotal: 2, reportSucceeded: 1, reportFailed: 1 });
});

// ============================= Part 2: guarded finalize -> TYPED disposition + concurrency =============================

test("(finalize) drained success -> 'finalized' + succeeded + finished_at + exact source AND report counters", () => {
  const m = makeCycleModel();
  m.addSource("h1", "succeeded"); m.addSource("h2", "succeeded");
  m.addReport("brand-sales|A1", { fetch_status: "ready", derive_status: "succeeded", save_status: "succeeded" });
  const r = m.finalizeCycle({ cycleId: "cyc" });
  assert.equal(r.disposition, "finalized"); assert.equal(r.cycle.status, "succeeded"); assert.equal(m.cycle.finished_at, "t");
  assert.equal(m.cycle.source_total, 2); assert.equal(m.cycle.source_succeeded, 2);
  assert.equal(m.cycle.report_total, 1); assert.equal(m.cycle.report_succeeded, 1); assert.equal(m.cycle.report_failed, 0);
});

test("(finalize) partial + failed statuses follow the table; counters persist only on terminal completion", () => {
  const p = makeCycleModel();
  p.addSource("h1", "succeeded"); p.addSource("h2", "failed"); p.addReport("r|A1", { fetch_status: "blocked" });
  assert.equal(p.finalizeCycle({ cycleId: "cyc" }).disposition, "finalized");
  assert.equal(p.cycle.status, "partial"); assert.equal(p.cycle.report_failed, 1); assert.equal(p.cycle.source_failed, 1);
  const f = makeCycleModel(); f.addSource("h1", "failed");
  assert.equal(f.finalizeCycle({ cycleId: "cyc" }).cycle.status, "failed");
});

test("(finalize) open source/report -> 'open-work' (continuation), NOT terminal; finished_at null", () => {
  const s = makeCycleModel(); s.addSource("h1", "succeeded"); s.addSource("h2", "attempted");
  const r = s.finalizeCycle({ cycleId: "cyc" });
  assert.equal(r.disposition, "open-work"); assert.equal(s.cycle.status, "running"); assert.equal(s.cycle.finished_at, null);
  const q = makeCycleModel(); q.addSource("h1", "succeeded"); q.addReport("r|A1", { derive_status: "pending", save_status: "pending" });
  assert.equal(q.finalizeCycle({ cycleId: "cyc" }).disposition, "open-work");
});

test("(finalize) idempotent replay -> 'already-terminal' + complete; unknown cycle -> 'not-found'", () => {
  const m = makeCycleModel(); m.addSource("h1", "succeeded");
  assert.equal(m.finalizeCycle({ cycleId: "cyc" }).disposition, "finalized");
  const fin = m.cycle.finished_at;
  const again = m.finalizeCycle({ cycleId: "cyc" });
  assert.equal(again.disposition, "already-terminal"); assert.equal(again.cycle.status, "succeeded"); assert.equal(m.cycle.finished_at, fin);
  assert.equal(m.finalizeCycle({ cycleId: "nope" }).disposition, "not-found");
});

test("(concurrency A: append-then-finalize) an appended OPEN job makes finalize return 'open-work' (stale finalizer cannot close)", () => {
  const m = makeCycleModel(); m.addSource("h1", "succeeded"); m.addSource("h2", "pending");
  assert.equal(m.finalizeCycle({ cycleId: "cyc" }).disposition, "open-work"); assert.equal(m.cycle.status, "running");
  m.setSource("h2", { fetch_status: "succeeded" });
  assert.equal(m.finalizeCycle({ cycleId: "cyc" }).disposition, "finalized");
});

test("(concurrency B: finalize-then-append) after terminalization, appending/altering any child work is REJECTED", () => {
  const m = makeCycleModel(); m.addSource("h1", "succeeded");
  assert.equal(m.finalizeCycle({ cycleId: "cyc" }).disposition, "finalized");
  assert.throws(() => m.addSource("h2", "pending"), /terminal/);
  assert.throws(() => m.addReport("r|A1"), /terminal/);
  assert.throws(() => m.setSource("h1", { fetch_status: "failed" }), /terminal/);
});

// ============================= Part 3: dispatcher scope semantics + typed-disposition handling =============================
function makeDispatchStore(over = {}) {
  const cycles = new Map(), jobsByCycle = new Map(), ownersByCycle = new Map(), cache = new Map(), reportJobs = new Map(), cycleOfReport = new Map();
  let seq = 0;
  const findCycle = (id) => [...cycles.values()].find((c) => c.id === id) || null;
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
    finalizeCycle({ cycleId }) {
      store.finalizeCalls += 1;
      if (over.finalizeCycle) return over.finalizeCycle(cycleId, findCycle(cycleId));
      const c = findCycle(cycleId);
      if (!c) return { disposition: "not-found", cycle: null };
      if (TERMINAL.has(c.status)) return { disposition: "already-terminal", cycle: { ...c } };
      const src = this.listSourceJobs(cycleId), rep = this.listReportJobs(cycleId);
      if (!lc.cycleFullyDrained(src, rep)) return { disposition: "open-work", cycle: null };
      const k = lc.computeCycleCounters(src, rep);
      c.status = lc.terminalCycleStatus(k); c.finished_at = "t";
      Object.assign(c, { source_total: k.sourceTotal, source_succeeded: k.sourceSucceeded, source_failed: k.sourceFailed, report_total: k.reportTotal, report_succeeded: k.reportSucceeded, report_failed: k.reportFailed });
      return { disposition: "finalized", cycle: { ...c } };
    },
  };
  if (over.dropFinalize) delete store.finalizeCycle;
  return store;
}
function makeDataDoe(opts = {}) {
  const create = {}; const pollHits = {};
  const deadlineErr = () => Object.assign(new Error("deferred"), { code: "DATADOE_DEADLINE" });
  return {
    totalCreates: () => Object.values(create).reduce((a, b) => a + b, 0),
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
  bucket: "us", cycleDate: over.cycleDate || "2026-08-11", asOf: "2026-08-01",
  connections: CONNS, discoverAccounts: async () => US_ACCTS,
  store: over.store, dataDoe: over.dataDoe || makeDataDoe(), saveSnapshot: saver,
  controlCatalog: over.controlCatalog, manualReportKeys: over.manualReportKeys,
  maxJobs: over.maxJobs, deadlineMs: over.deadlineMs, clock: over.clock,
});
// scheduled run: ready + schedule-enabled, NO manualReportKeys
const scheduled = (keys, over = {}) => dispatch({ ...over, controlCatalog: mkCatalog(keys, keys) });
// manual run: named keys, ready (not necessarily enabled)
const manual = (keys, over = {}) => dispatch({ ...over, controlCatalog: mkCatalog(keys), manualReportKeys: keys });

test("(dispatcher: SCHEDULED complete scope) a drained scheduled run auto-finalizes -> terminal + finished_at + counters", async () => {
  const store = makeDispatchStore();
  const r = await scheduled(["brand-sales"], { store });
  assert.equal(r.drained, true); assert.equal(r.finalized, true, "scheduled drain auto-finalizes");
  assert.ok(["succeeded", "partial", "failed"].includes(r.cycleStatus));
  const c = store.getCycle(r.cycleId);
  assert.equal(c.finished_at, "t"); assert.equal(c.source_total, store.listSourceJobs(r.cycleId).length);
  assert.equal(c.report_total, store.listReportJobs(r.cycleId).length, "report counters persisted");
});

test("(dispatcher: MANUAL subset) a manual run NEVER auto-finalizes -- the cycle stays running", async () => {
  const store = makeDispatchStore();
  const r = await manual(["brand-sales"], { store });
  assert.equal(r.drained, true, "the manual run drained its scope");
  assert.equal(r.finalized, false, "a manual subset does NOT auto-finalize the shared cycle");
  assert.equal(store.finalizeCalls, 0, "finalizeCycle is not even called for a manual run");
  assert.equal(store.getCycle(r.cycleId).status, "running"); assert.equal(store.getCycle(r.cycleId).finished_at, null);
});

test("(dispatcher: the unplanned-manual-subset REGRESSION) manual brand-sales then manual content-changes on the SAME (bucket,date) both append + drain", async () => {
  const store = makeDispatchStore();
  // A. manual brand-sales drains on (us, 2026-08-20); B. content-changes NOT yet planned/upserted.
  const rA = await manual(["brand-sales"], { store, cycleDate: "2026-08-20" });
  assert.equal(rA.drained, true); assert.equal(rA.finalized, false);
  const cid = rA.cycleId;
  const brandKeys = store.listSourceJobs(cid).map((j) => j.request_key);
  assert.ok(brandKeys.some((k) => k.startsWith("brand-sales:")), "brand-sales sources exist");
  assert.ok(!brandKeys.some((k) => k.startsWith("content-changes:")), "content-changes was NOT pre-seeded");
  // C. a LATER manual content-changes invocation uses the SAME (bucket, date).
  const rC = await manual(["content-changes"], { store, cycleDate: "2026-08-20" });
  // D. Brand Sales must NOT have terminalized the shared cycle -> content-changes appends its sources and drains.
  assert.equal(rC.cycleId, cid, "same shared cycle");
  assert.equal(rC.drained, true, "content-changes drained (no terminal-cycle rejection)");
  const afterKeys = store.listSourceJobs(cid).map((j) => j.request_key);
  assert.ok(afterKeys.some((k) => k.startsWith("content-changes:")), "content-changes sources were appended to the shared running cycle");
  assert.equal(store.getCycle(cid).status, "running");
});

test("(dispatcher: open-work disposition) a scheduled drain whose whole cycle still has open work -> drained=false, continuationRequired=true", async () => {
  const store = makeDispatchStore({ finalizeCycle: () => ({ disposition: "open-work", cycle: null }) });
  const r = await scheduled(["brand-sales"], { store });
  assert.equal(r.finalized, false); assert.equal(r.drained, false, "open-work forces re-observation");
  assert.equal(r.continuationRequired, true); assert.equal(r.cycleStatus, "running");
});

test("(dispatcher: fail closed) a scheduled drain with finalization UNAVAILABLE throws (never claims success)", async () => {
  const store = makeDispatchStore({ dropFinalize: true });
  await assert.rejects(() => scheduled(["brand-sales"], { store }), /finalization is unavailable/);
});

test("(dispatcher: fail closed) an unknown/malformed finalize disposition throws", async () => {
  const store = makeDispatchStore({ finalizeCycle: () => ({ disposition: "weird", cycle: null }) });
  await assert.rejects(() => scheduled(["brand-sales"], { store }), /unexpected finalize disposition/);
  const store2 = makeDispatchStore({ finalizeCycle: () => ({}) });
  await assert.rejects(() => scheduled(["brand-sales"], { store: store2 }), /unexpected finalize disposition/);
});

test("(dispatcher: fail closed) a malformed POSITIVE ack (finalized/already-terminal without a terminal cycle) throws -- never leaves drained=true", async () => {
  for (const bad of [
    () => ({ disposition: "finalized", cycle: null }),
    () => ({ disposition: "finalized", cycle: { id: "x", status: "running" } }),
    () => ({ disposition: "already-terminal", cycle: null }),
  ]) {
    const store = makeDispatchStore({ finalizeCycle: bad });
    await assert.rejects(() => scheduled(["brand-sales"], { store }), /malformed positive finalize acknowledgement/);
  }
});

test("(dispatcher: not-drained) maxJobs truncation + resumable deferral do NOT finalize; resume finalizes with ZERO duplicate create-export", async () => {
  // maxJobs truncation (scheduled) -> not drained -> no finalize call
  const s1 = makeDispatchStore();
  const r1 = await scheduled(["brand-sales"], { store: s1, maxJobs: 1 });
  assert.equal(r1.drained, false); assert.equal(r1.finalized, false); assert.equal(s1.finalizeCalls, 0);
  assert.equal(s1.getCycle(r1.cycleId).status, "running");
  // deferral (scheduled) -> not drained -> no finalize; resume -> finalize; no dup create-export
  const s2 = makeDispatchStore();
  const rd = await scheduled(["brand-sales"], { store: s2, dataDoe: makeDataDoe({ deferPollKey: "brand-sales:order-lines" }) });
  assert.equal(rd.drained, false); assert.equal(rd.finalized, false); assert.equal(s2.finalizeCalls, 0);
  const dd2 = makeDataDoe();
  const rr = await scheduled(["brand-sales"], { store: s2, dataDoe: dd2 });
  assert.equal(rr.drained, true); assert.equal(rr.finalized, true);
  assert.equal(dd2.totalCreates(), 0, "resume created ZERO new exports (persisted export_id reused)");
});

test("(dispatcher: no-op) nothing dispatchable -> no cycle, no finalize", async () => {
  const store = makeDispatchStore();
  const r = await dispatch({ store, controlCatalog: mkCatalog([]), manualReportKeys: ["brand-sales"] });
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
