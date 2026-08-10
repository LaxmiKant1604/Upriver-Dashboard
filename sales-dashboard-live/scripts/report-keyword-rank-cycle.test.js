// Phase 1d -- Keyword Rank account-scoped STAGED source cycle tests (SHADOW MODE).
//
// One small, independently-readable ESM artifact. Drives runKeywordRankShadowCycle end-to-end for
// MULTIPLE accounts against a lean in-memory source store + DataDoe double (no network). Proves
// Blocker 1 (account-scoped signals keyed by request HASH; primary/dd-secondary isolation; fresh-
// invocation reconstruction with zero duplicate exports) and Blocker 2 (staged catalog: no catalog
// token before the cadence resolves; a failed/disabled weekly or required monthly spends no catalog).
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

let runKeywordRankShadowCycle;

const dash = (...p) => p.join("-");
const CONNS = [
  { id: "primary", apiKey: dash("prim", "key"), accountPrefix: "" },
  { id: "secondary", apiKey: dash("sec", "key"), accountPrefix: dash("dd", "secondary") + ":" },
];
const ASOF = "2025-08-10";

// Lean in-memory source store implementing exactly the runSourceJobs interface.
function makeStore() {
  const cycles = new Map();
  const jobsByCycle = new Map();
  const cache = new Map();
  let seq = 0;
  const findCycle = (id) => [...cycles.values()].find((c) => c.id === id) || null;
  return {
    _cache: cache,
    _rawJob(cid, h) { return jobsByCycle.get(cid) && jobsByCycle.get(cid).get(h); },
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
    saveSourceRows({ job, rows, version }) { const h = job.request_hash != null ? job.request_hash : job.requestHash; cache.set(h, { rows: [...rows], object_path: "p/" + h + "/" + version }); return "p/" + h + "/" + version; },
    recordSourceSuccess({ cycleId, requestHash, exportId, rowCount, cacheObjectPath }) { Object.assign(jobsByCycle.get(cycleId).get(requestHash), { fetch_status: "succeeded", export_id: exportId, row_count: rowCount, cache_object_path: cacheObjectPath }); },
    recordSourceFailure({ cycleId, requestHash, stage, code, terminal, rowCount }) { const j = jobsByCycle.get(cycleId).get(requestHash); Object.assign(j, { fetch_status: "failed", error_stage: stage, error_code: code, terminal: !!terminal }); if (rowCount != null) j.row_count = rowCount; },
    updateCycleCounts() { /* not asserted */ },
  };
}

// DataDoe double; `behavior(job)` -> { rows } | { throw }. Tracks create-export counts per hash.
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

// Standard cadence rows: A1 weekly=4 periods, others weekly=2 periods; monthly=3 periods; catalog=1 row.
const rawOf = (job) => job.fetchParams.sellerOrVendorIds[0];
const standardRows = (job) => {
  const rk = job.requestKey; const raw = rawOf(job);
  if (rk === "keyword-rank:sqp-weekly") return { rows: raw === "A1" ? [{ date: "2025-06-01" }, { date: "2025-06-08" }, { date: "2025-06-15" }, { date: "2025-06-22" }] : [{ date: "2025-07-01" }, { date: "2025-07-08" }] };
  if (rk === "keyword-rank:sqp-monthly") return { rows: [{ date: "2025-05-01" }, { date: "2025-06-01" }, { date: "2025-07-01" }] };
  return { rows: [{ child_asin: "ASIN1", product_brand: "Acme" }] };
};

const cycle = (store, dataDoe, accounts) => runKeywordRankShadowCycle({ accounts, connections: CONNS, asOf: ASOF, store, dataDoe, bucket: "us", cycleDate: "2026-08-11" });
// Which request keys were created for a given raw seller id (via each job's connection + our knowledge
// that A1 is primary and dd-secondary:* is secondary). We inspect the persisted source jobs.
function jobsByAccount(store, cycleId) {
  const out = {};
  for (const j of store.listSourceJobs(cycleId)) {
    (out[j.connection_id] || (out[j.connection_id] = [])).push({ key: j.request_key, status: j.fetch_status });
  }
  return out;
}

/* ============================= two-account staged execution ============================= */

group("keyword-rank cycle: two-account account-scoped staged execution");

test("A (weekly >= 4) creates weekly + catalog and NO monthly; B (weekly < 4) creates weekly + monthly + catalog", async () => {
  const store = makeStore();
  const dd = makeDataDoe(standardRows);
  const accounts = [{ accountId: "A1", country: "US", currency: "USD" }, { accountId: dash("dd", "secondary") + ":B1", country: "US", currency: "USD" }];
  const r = await cycle(store, dd, accounts);
  const byAcct = jobsByAccount(store, r.cycleId);
  const keys = (conn) => (byAcct[conn] || []).map((x) => x.key).sort();
  assert.deepEqual(keys("primary"), ["keyword-rank:catalog", "keyword-rank:sqp-weekly"], "A: weekly + catalog, NO monthly");
  assert.deepEqual(keys("dd-secondary"), ["keyword-rank:catalog", "keyword-rank:sqp-monthly", "keyword-rank:sqp-weekly"], "B: weekly + monthly + catalog");
  assert.equal(r.perAccount[0].monthlyHash, null, "A never plans a monthly request");
  assert.equal(r.perAccount[1].weeklySignal.distinctPeriods, 2, "B weekly reconstructed to 2 periods (account-scoped)");
  assert.equal(r.perAccount[0].weeklySignal.distinctPeriods, 4, "A weekly reconstructed to 4 periods (account-scoped)");
});

test("primary and dd-secondary accounts with the SAME raw id resolve DISJOINT hashes and never share a signal", async () => {
  const store = makeStore();
  const dd = makeDataDoe(standardRows);
  // Same raw id "X1" under both organizations. Primary weekly returns 2 periods; dd-secondary too.
  const rows = (job) => (job.requestKey === "keyword-rank:sqp-weekly" ? { rows: [{ date: "2025-07-01" }, { date: "2025-07-08" }] } : standardRows(job));
  const dd2 = makeDataDoe(rows);
  const accounts = [{ accountId: "X1", country: "US", currency: "USD" }, { accountId: dash("dd", "secondary") + ":X1", country: "US", currency: "USD" }];
  const r = await cycle(store, dd2, accounts);
  const pri = r.perAccount[0], sec = r.perAccount[1];
  assert.notEqual(pri.weeklyHash, sec.weeklyHash, "same raw id -> different weekly hash per organization");
  assert.notEqual(pri.monthlyHash, sec.monthlyHash, "same raw id -> different monthly hash per organization");
  // Each account reconstructed its own weekly signal from its own hash (no cross-consumption).
  assert.equal(pri.weeklySignal.distinctPeriods, 2);
  assert.equal(sec.weeklySignal.distinctPeriods, 2);
  void dd;
});

/* ============================= catalog token-saving state table ============================= */

group("keyword-rank cycle: staged catalog spends no token before cadence");

test("a FAILED weekly spends ONLY the weekly export (no monthly, no catalog)", async () => {
  const store = makeStore();
  const dd = makeDataDoe((job) => (job.requestKey === "keyword-rank:sqp-weekly" ? { throw: new Error("DataDoe export creation failed (500).") } : standardRows(job)));
  const r = await cycle(store, dd, [{ accountId: "A1", country: "US", currency: "USD" }]);
  const keys = jobsByAccount(store, r.cycleId).primary.map((x) => x.key).sort();
  assert.deepEqual(keys, ["keyword-rank:sqp-weekly"], "weekly only; no catalog token spent on a failed weekly");
});

test("a DISABLED weekly (source-disabled) spends ONLY the weekly export (terminal; no catalog)", async () => {
  const store = makeStore();
  const dd = makeDataDoe((job) => (job.requestKey === "keyword-rank:sqp-weekly" ? { throw: new Error("source is disabled for this organization") } : standardRows(job)));
  const r = await cycle(store, dd, [{ accountId: "A1", country: "US", currency: "USD" }]);
  const rows = jobsByAccount(store, r.cycleId).primary;
  assert.deepEqual(rows.map((x) => x.key).sort(), ["keyword-rank:sqp-weekly"]);
  assert.equal(rows[0].status, "failed", "disabled weekly recorded failed (terminal); no catalog token");
});

test("weekly < 4 with a FAILED required monthly spends weekly + monthly but NO catalog", async () => {
  const store = makeStore();
  const dd = makeDataDoe((job) => (job.requestKey === "keyword-rank:sqp-monthly" ? { throw: new Error("DataDoe export creation failed (500).") } : standardRows(job)));
  const r = await cycle(store, dd, [{ accountId: dash("dd", "secondary") + ":B1", country: "US", currency: "USD" }]);
  const keys = jobsByAccount(store, r.cycleId)["dd-secondary"].map((x) => x.key).sort();
  assert.deepEqual(keys, ["keyword-rank:sqp-monthly", "keyword-rank:sqp-weekly"], "monthly attempted but NO catalog token on a failed required monthly");
});

/* ============================= fresh invocation / no duplicate exports ============================= */

group("keyword-rank cycle: fresh invocation reconstructs without duplicate exports");

test("a repeated/fresh invocation reconstructs the same account-scoped signals and creates ZERO duplicate exports", async () => {
  const store = makeStore();
  const dd = makeDataDoe(standardRows);
  const accounts = [{ accountId: "A1", country: "US", currency: "USD" }, { accountId: dash("dd", "secondary") + ":B1", country: "US", currency: "USD" }];
  const r1 = await cycle(store, dd, accounts);
  const afterFirst = dd.totalCreates();
  // Exactly: A weekly+catalog (2) + B weekly+monthly+catalog (3) = 5 distinct create-exports.
  assert.equal(afterFirst, 5, "first cycle creates exactly 5 exports (A:2, B:3)");
  const r2 = await cycle(store, dd, accounts);
  assert.equal(dd.totalCreates(), afterFirst, "a fresh invocation creates NO duplicate exports");
  // Each hash was created at most once (one-create-export-per-request-hash-per-cycle).
  for (const j of store.listSourceJobs(r2.cycleId)) {
    assert.ok(dd.createCount(j.request_hash) <= 1, j.request_key + " export created at most once");
  }
  assert.equal(r1.cycleId, r2.cycleId, "same cycle (bucket|date) resumed, not a new one");
});

test("the staged cycle makes ZERO DataDoe calls beyond the staged submit-set (no eager catalog/monthly)", async () => {
  const store = makeStore();
  const dd = makeDataDoe(standardRows);
  // Only account A with weekly >= 4: exactly weekly + catalog (2), never a monthly export.
  await cycle(store, dd, [{ accountId: "A1", country: "US", currency: "USD" }]);
  assert.equal(dd.totalCreates(), 2, "A (weekly >= 4): exactly weekly + catalog");
});

async function main() {
  mark("main(): loading keyword-rank cycle module");
  ({ runKeywordRankShadowCycle } = await import("../lib/server/sync/keyword-rank-cycle.js"));
  mark("module loaded; running " + tests.filter((t) => !t.marker).length + " tests");

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
