// DataDoe pollExport + execution-deadline hardening — deterministic OFFLINE tests.
//
// Confirmed DataDoe status behaviour: a status GET issued too soon after the create-export POST can
// return HTTP 404 before the export becomes visible. The poller must (1) wait one 5s cadence BEFORE the
// first status GET, (2) treat a status-GET 404 as temporary within the SAME bounded poll window,
// (3) NEVER issue a second create-export POST, (4) keep create-POST 404 and non-404 status errors as
// real failures, and (5) surface a TYPED resumable signal when the bounded window is exhausted by ONLY
// temporary states (repeated 404 / ordinary PENDING) -- DataDoePollPendingError -- which Scheduler v2's
// source worker defers exactly like a deadline deferral: the durable job stays fetch_status='attempted'
// with its export_id, deferred increments, drained stays false, NO source failure is recorded, and a
// fresh invocation resumes the SAME export id (total create-export count stays exactly one).
//
// The absolute execution deadline (withDataDoeDeadline) must cover NETWORK time and RATE-LIMIT sleeps,
// not just cadence sleeps: no new request starts when insufficient time remains, and slow HTTP cannot
// push work past the configured budget (the typed DataDoeDeadlineError surfaces instead).
//
// Deterministic: globalThis.setTimeout fires immediately while RECORDING each requested delay;
// globalThis.fetch is a scripted queue RECORDING method/url/start-time; Date.now is a controllable fake
// clock that responders advance to simulate HTTP latency. No network, no DataDoe, no Supabase.
//
// 7-bit ASCII, LF. Run: node scripts/datadoe-poll-export.test.js

import assert from "node:assert/strict";
import { writeSync } from "node:fs";

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };

// ---- controllable fake clock: real time until a test freezes/advances it ----
const realDateNow = Date.now.bind(Date);
let fakeNow = null; // null => real clock
Date.now = () => (fakeNow ?? realDateNow());

// ---- deterministic timer stub: fire immediately, record every requested delay in order ----
const events = []; // ordered log of { type: "sleep", ms } and { type: "fetch", method, url, at }
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => {
  events.push({ type: "sleep", ms: Number(ms) || 0 });
  return realSetTimeout(fn, 0, ...args);
};

// ---- scripted fetch stub: shift the next queued responder, record method+url+time, fail on overrun.
// A responder may carry latencyMs: the fake clock advances by that much, simulating slow HTTP. ----
let fetchQueue = [];
const mkRes = ({ status = 200, body = {} }) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => null },
  json: async () => body,
  text: async () => JSON.stringify(body),
  clone() { return this; },
});
globalThis.fetch = async (url, options = {}) => {
  const method = (options.method || "GET").toUpperCase();
  events.push({ type: "fetch", method, url: String(url), at: Date.now() });
  const next = fetchQueue.shift();
  if (!next) throw new Error(`unexpected fetch: ${method} ${url}`);
  if (next.latencyMs && fakeNow !== null) fakeNow += next.latencyMs; // slow HTTP consumes budget
  return mkRes(next);
};

const resetLog = () => { events.length = 0; fetchQueue = []; };
const fetches = () => events.filter((e) => e.type === "fetch");
const posts = () => fetches().filter((e) => e.method === "POST");
const statusGets = (id) => fetches().filter((e) => e.method === "GET" && e.url.endsWith(`/exports/${id}`));
const cadenceSleeps = () => events.filter((e) => e.type === "sleep" && e.ms === 5000);
const firstIndex = (pred) => events.findIndex(pred);

let pollExport, createExport, fetchExportRows, withDataDoeDeadline;
let DataDoeDeadlineError, isDataDoeDeadlineError, isDataDoePollPendingError;
let classifyFetchError, runSourceJobs;

// ---- compact in-memory store for the worker-level regression (models the SQL RPC surface) ----
function mkStore() {
  const jobs = new Map(); // request_hash -> row
  let failureCalls = 0;
  return {
    jobs,
    failureCount: () => failureCalls,
    openCycle() { return "cyc_1"; },
    claimCycle() { return true; },
    getCycle() { return { id: "cyc_1", status: "running" }; },
    upsertSourceJob(j) {
      if (jobs.has(j.requestHash)) return;
      jobs.set(j.requestHash, {
        id: `job_${jobs.size + 1}`, request_hash: j.requestHash, request_key: j.requestKey,
        source_id: j.sourceId, source_key: j.sourceKey, connection_id: j.connectionId,
        organization_fingerprint: j.organizationFingerprint, account_scope_hash: j.accountScopeHash,
        fetch_status: "pending", attempted_at: null, create_export_count: 0, export_id: null,
        terminal: false, error_stage: null, error_code: null, row_count: null,
      });
    },
    listSourceJobs() { return [...jobs.values()].map((j) => ({ ...j })); },
    claimExportAttempt(_cycleId, requestHash) {
      const j = jobs.get(requestHash);
      if (j && j.attempted_at === null) { j.attempted_at = "t"; j.create_export_count += 1; j.fetch_status = "attempted"; return true; }
      return false;
    },
    recordExportCreated({ requestHash, exportId }) { jobs.get(requestHash).export_id = exportId; },
    saveSourceRows({ job }) { return `source-cache/v2/${job.request_hash}/v.json`; },
    recordSourceSuccess({ requestHash, exportId, rowCount, cacheObjectPath }) {
      Object.assign(jobs.get(requestHash), {
        fetch_status: "succeeded", export_id: exportId, row_count: rowCount,
        cache_object_path: cacheObjectPath, error_stage: null, error_code: null,
      });
    },
    recordSourceFailure({ requestHash, stage, code, terminal }) {
      failureCalls += 1;
      Object.assign(jobs.get(requestHash), { fetch_status: "failed", error_stage: stage, error_code: code, terminal: !!terminal });
    },
    updateCycleCounts() {},
  };
}
const PLANNED = Object.freeze({
  requestHash: "h1", requestKey: "rk:h1", sourceId: "src", sourceKey: "sk",
  connectionId: "primary", organizationFingerprint: "orgA", accountScopeHash: "ash",
  requestMeta: {}, strict: false, limit: 50000,
});

// ================= poller tests =================

test("(404 -> pending -> completed) status-GET 404 is temporary; poll resolves; zero POSTs; 5s wait precedes the FIRST GET", async () => {
  resetLog();
  fetchQueue = [
    { status: 404, body: { message: "Export not found" } },   // too-soon GET: export not visible yet
    { status: 200, body: { status: "PENDING" } },
    { status: 200, body: { status: "COMPLETED", id: "e1" } },
  ];
  const body = await pollExport("k", "e1");
  assert.equal(body.status, "COMPLETED");
  assert.equal(statusGets("e1").length, 3, "exactly three status GETs");
  assert.equal(posts().length, 0, "a status 404 NEVER triggers a create-export POST");
  assert.equal(cadenceSleeps().length, 3, "one 5s cadence sleep per attempt (bounded window intact)");
  const firstCadence = firstIndex((e) => e.type === "sleep" && e.ms === 5000);
  const firstFetch = firstIndex((e) => e.type === "fetch");
  assert.ok(firstCadence !== -1 && firstCadence < firstFetch, "the 5s wait happens BEFORE the first status GET");
});

test("(repeated-404 exhaustion) TYPED poll-pending signal -- resumable, never terminal, zero POSTs", async () => {
  resetLog();
  fetchQueue = Array.from({ length: 9 }, () => ({ status: 404, body: {} }));
  let caught = null;
  await pollExport("k", "e2").catch((e) => { caught = e; });
  assert.ok(isDataDoePollPendingError(caught), "typed DataDoePollPendingError (not a generic timeout)");
  assert.equal(caught.code, "DATADOE_POLL_PENDING");
  assert.equal(caught.exportId, "e2", "the typed signal carries the export id to resume");
  assert.equal(statusGets("e2").length, 9, "all nine bounded attempts used");
  assert.equal(posts().length, 0, "never a second create-export POST");
  assert.equal(cadenceSleeps().length, 9, "9 x 5s cadence sleeps -- the 45s budget is preserved");
  const cls = classifyFetchError(caught, "poll");
  assert.equal(cls.code, "POLL_PENDING");
  assert.equal(cls.terminal, false, "poll-pending is NEVER terminal");
  // Policy unchanged for a genuine plain processing-timeout error (e.g. ads-sync): still TIMEOUT.
  assert.equal(classifyFetchError(new Error("DataDoe export timed out while processing.")).code, "TIMEOUT");
});

test("(repeated-PENDING exhaustion) ordinary PENDING all window long yields the SAME typed resumable signal", async () => {
  resetLog();
  fetchQueue = Array.from({ length: 9 }, () => ({ status: 200, body: { status: "PENDING" } }));
  let caught = null;
  await pollExport("k", "e2b").catch((e) => { caught = e; });
  assert.ok(isDataDoePollPendingError(caught));
  assert.equal(statusGets("e2b").length, 9);
  assert.equal(posts().length, 0);
});

test("(non-404 failures stay real) status 500 throws immediately; FAILED/ERROR/BLOCKED_NO_TOKENS throw; create-POST 404 stays a real failure", async () => {
  resetLog();
  fetchQueue = [
    { status: 200, body: { status: "PENDING" } },
    { status: 500, body: {} },
  ];
  await assert.rejects(() => pollExport("k", "e3"), /status check failed \(500\)/);
  assert.equal(statusGets("e3").length, 2, "stops at the real failure -- no further attempts");
  assert.equal(posts().length, 0);

  for (const st of ["FAILED", "ERROR", "BLOCKED_NO_TOKENS"]) {
    resetLog();
    fetchQueue = [{ status: 200, body: { status: st } }];
    let caught = null;
    await pollExport("k", "e4").catch((e) => { caught = e; });
    assert.match(String(caught && caught.message), new RegExp(`failed to process \\(${st}\\)`));
    assert.ok(!isDataDoePollPendingError(caught), `${st} is a genuine failure, never poll-pending`);
  }

  // A 404 on the CREATE POST itself is a real failure (source unavailable), never retried/absorbed.
  resetLog();
  fetchQueue = [{ status: 404, body: { message: "Source not found", statusCode: 404 } }];
  await assert.rejects(
    () => createExport("k", "src-1", ["a"], ["S1"], "2026-01-01", "2026-01-31", 100),
    /export creation failed \(404\)/,
  );
  assert.equal(posts().length, 1, "the create POST happened exactly once and failed");
});

test("(exactly one create-export) full flow with a too-soon 404 mid-poll still makes EXACTLY ONE POST", async () => {
  resetLog();
  const rows = [{ a: 1 }, { a: 2 }];
  fetchQueue = [
    { status: 200, body: { exportId: "exp-1", status: "PENDING" } },              // POST create (the only one)
    { status: 404, body: {} },                                                    // status GET: not visible yet
    { status: 200, body: { status: "COMPLETED" } },                               // status GET: done
    { status: 200, body: { rawContent: JSON.stringify(rows) } },                  // GET raw download
  ];
  const got = await fetchExportRows("k", "src-1", ["a"], ["S1"], "2026-01-01", "2026-01-31", 100, { bypassSourceCache: true });
  assert.deepEqual(got, rows);
  assert.equal(posts().length, 1, "exactly ONE create-export POST across the whole flow");
  assert.equal(statusGets("exp-1").length, 2, "the 404 was absorbed by polling the SAME export id");
  assert.equal(fetches().filter((e) => e.url.endsWith("/exports/exp-1/raw")).length, 1, "one download");
});

// ================= execution-deadline tests (fake clock) =================

test("(deadline vs slow HTTP) slow status GETs consume the budget; the next step defers -- no request starts past the bound", async () => {
  resetLog();
  const base = realDateNow() + 600_000; // ahead of the real rate-limiter timestamp: no artificial first sleep
  fakeNow = base;
  const DEADLINE = base + 20_000;
  // Each status GET "takes" 9s of wall clock. Budget 20s => two GETs fit (18s); the third attempt's
  // cadence sleep sees < 5s+headroom remaining and surfaces the typed deadline error instead.
  fetchQueue = [
    { status: 200, body: { status: "PENDING" }, latencyMs: 9_000 },
    { status: 200, body: { status: "PENDING" }, latencyMs: 9_000 },
  ];
  let caught = null;
  await withDataDoeDeadline(DEADLINE, () => pollExport("k", "slow")).catch((e) => { caught = e; });
  assert.ok(isDataDoeDeadlineError(caught), "typed DataDoeDeadlineError (deadline covers HTTP latency, not just sleeps)");
  assert.ok(!isDataDoePollPendingError(caught), "a deadline stop is distinct from poll-window exhaustion");
  assert.equal(statusGets("slow").length, 2, "no third status GET starts once the budget cannot fit it");
  assert.ok(fakeNow - base <= 20_000, "simulated elapsed time never exceeds the configured deadline");
  for (const f of fetches()) assert.ok(f.at <= DEADLINE - 750, "every request STARTED with more than the shutdown headroom remaining");
});

test("(deadline vs rate-limit sleep) the 2-req/sec spacing sleep is budget-aware: it defers instead of running past the bound", async () => {
  resetLog();
  const base = realDateNow() + 1_200_000;
  fakeNow = base;
  // Pre-seed the rate limiter OUTSIDE any deadline: this fetch stamps lastCall = base.
  fetchQueue = [{ status: 200, body: { ok: true } }];
  const r0 = await (await import("../lib/server/datadoe.js")).ddFetch("https://api.datadoe.com/api/v1/x", {});
  assert.equal(r0.status, 200);
  const fetchesBefore = fetches().length;
  // Now a SECOND request 0ms later under a 1.2s budget: the ~550ms spacing sleep + 750ms headroom
  // exceed the remaining budget, so the rate-limit sleep itself surfaces the deadline error BEFORE
  // any request starts.
  let caught = null;
  await withDataDoeDeadline(base + 1_200, () => (import("../lib/server/datadoe.js").then((m) => m.ddFetch("https://api.datadoe.com/api/v1/y", {})))).catch((e) => { caught = e; });
  assert.ok(isDataDoeDeadlineError(caught), "rate-limit spacing is bounded by the same deadline");
  assert.equal(fetches().length, fetchesBefore, "NO extra request started beyond the deadline");
});

test("(deadline before first GET) a poll invoked with < one cadence of budget defers immediately -- zero status GETs", async () => {
  resetLog();
  const base = realDateNow() + 1_800_000;
  fakeNow = base;
  let caught = null;
  await withDataDoeDeadline(base + 5_500, () => pollExport("k", "late")).catch((e) => { caught = e; });
  assert.ok(isDataDoeDeadlineError(caught));
  assert.equal(statusGets("late").length, 0, "never starts a request when insufficient time remains");
});

// ================= worker-level regression (Blocker 1) =================
// First invocation wins the claim and creates export E once; the poll window exhausts on ONLY
// temporary states (or the execution deadline); the durable row stays attempted with export_id E,
// deferred >= 1, drained=false, NO source failure. A second invocation resumes E, creates ZERO new
// exports, downloads, validates, succeeds. Total create-export count stays exactly one.

for (const cause of ["repeated-404", "repeated-PENDING", "execution-deadline"]) {
  test(`(worker resume: ${cause}) attempted+export_id preserved, deferred, drained:false, then resumed with ZERO new creates`, async () => {
    resetLog();
    const store = mkStore();
    const creates = { count: 0 };
    const realPoll = (job, exportId) => pollExport("k", exportId);
    const dd = {
      create: async () => { creates.count += 1; return { exportId: "E1" }; },
      poll: cause === "execution-deadline" ? async () => { throw new DataDoeDeadlineError(); } : realPoll,
      download: async () => [{ a: 1 }],
    };
    if (cause === "repeated-404") fetchQueue = Array.from({ length: 9 }, () => ({ status: 404, body: {} }));
    if (cause === "repeated-PENDING") fetchQueue = Array.from({ length: 9 }, () => ({ status: 200, body: { status: "PENDING" } }));

    // ---- invocation 1: create once, exhaust the temporary window, DEFER (no failure) ----
    const run1 = await runSourceJobs({ store, dataDoe: dd, plannedJobs: [PLANNED], bucket: "us", cycleDate: "2026-08-14" });
    const row1 = store.jobs.get("h1");
    assert.equal(creates.count, 1, "exactly one create-export in invocation 1");
    assert.equal(row1.fetch_status, "attempted", "durable row remains attempted (NOT failed)");
    assert.equal(row1.export_id, "E1", "export_id preserved for resume");
    assert.equal(row1.create_export_count, 1);
    assert.ok(run1.deferred >= 1, "deferred incremented");
    assert.equal(run1.drained, false, "continuation required");
    assert.equal(run1.failed, 0);
    assert.equal(store.failureCount(), 0, "NO source failure recorded for a temporary exhaustion");
    const o1 = run1.outcomes.find((o) => o.requestHash === "h1");
    assert.equal(o1.status, "deferred");
    assert.equal(o1.resumable, true);

    // ---- invocation 2: resume the SAME export id; zero new creates; succeed ----
    resetLog();
    fetchQueue = [{ status: 200, body: { status: "COMPLETED" } }];
    const dd2 = { create: async () => { creates.count += 1; return { exportId: "E2-WRONG" }; }, poll: realPoll, download: async () => [{ a: 1 }] };
    const run2 = await runSourceJobs({ store, dataDoe: dd2, plannedJobs: [PLANNED], bucket: "us", cycleDate: "2026-08-14" });
    const row2 = store.jobs.get("h1");
    assert.equal(creates.count, 1, "ZERO new create-exports in invocation 2 -- total stays exactly one");
    assert.equal(row2.fetch_status, "succeeded");
    assert.equal(row2.export_id, "E1", "the SAVED export id was resumed and recorded");
    assert.equal(row2.create_export_count, 1, "total create-export count remains exactly one");
    assert.equal(row2.row_count, 1);
    assert.equal(run2.drained, true);
    assert.equal(store.failureCount(), 0);
    if (cause !== "execution-deadline") {
      assert.equal(statusGets("E1").length, 1, "invocation 2 polled the saved export id E1");
    }
  });
}

async function main() {
  ({
    pollExport, createExport, fetchExportRows, withDataDoeDeadline,
    DataDoeDeadlineError, isDataDoeDeadlineError, isDataDoePollPendingError,
  } = await import("../lib/server/datadoe.js"));
  ({ classifyFetchError, runSourceJobs } = await import("../lib/server/sync/source-worker.js"));
  for (const t of tests) {
    try { await t.fn(); passed += 1; out("  ok  " + t.name); }
    catch (e) { out("FAIL  " + t.name); out(String(e && e.stack ? e.stack : e)); process.exitCode = 1; return; }
  }
  out("\n" + passed + " assertions passed");
}

main();
