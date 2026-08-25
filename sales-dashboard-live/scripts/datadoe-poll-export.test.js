// DataDoe pollExport + execution-deadline hardening — deterministic OFFLINE tests.
//
// Poller contract (confirmed DataDoe behaviour): wait one 5s cadence BEFORE the first status GET;
// a status-GET 404 is temporary within the bounded window; exhaustion by ONLY temporary states
// (repeated 404 / ordinary PENDING) throws the TYPED resumable DataDoePollPendingError; terminal
// outcomes (status 500, FAILED/ERROR/BLOCKED_NO_TOKENS, create-POST 404) stay real failures; the
// poller NEVER issues a create-export POST. Scheduler v2 defers the typed signal exactly like a
// deadline deferral and resumes the SAME export id in a later invocation.
//
// Deadline harness (finding 2): deadline tests run under an injected DETERMINISTIC virtual
// clock/scheduler -- every setTimeout becomes a virtual timer, firing a timer ADVANCES the same
// clock Date.now() reads, a slow fetch stays PENDING on a virtual timer and listens to
// options.signal (rejecting AbortError when ddFetch's own deadline abort fires), and the pump
// drives timers in time order until the promise settles. So cadence sleeps, rate-limit/429
// sleeps, AND HTTP latency are all charged to one absolute deadline; in-flight aborts are real;
// and no test ever waits real seconds.
//
// 7-bit ASCII, LF. Run: node scripts/datadoe-poll-export.test.js

import assert from "node:assert/strict";
import { writeSync } from "node:fs";

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };

// ---- virtual deterministic clock + scheduler (deadline tests) ----
const realDateNow = Date.now.bind(Date);
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
let virtual = null; // { now, timers: [{ at, fn, id }], nextId }

Date.now = () => (virtual ? virtual.now : realDateNow());
globalThis.setTimeout = (fn, ms, ...args) => {
  const delay = Math.max(0, Number(ms) || 0);
  events.push({ type: "sleep", ms: delay });
  if (virtual) {
    const id = virtual.nextId++;
    virtual.timers.push({ at: virtual.now + delay, fn: () => fn(...args), id });
    return { __vid: id };
  }
  return realSetTimeout(fn, 0, ...args); // simple mode: fire immediately (delay recorded above)
};
globalThis.clearTimeout = (handle) => {
  if (handle && handle.__vid != null) {
    if (virtual) virtual.timers = virtual.timers.filter((t) => t.id !== handle.__vid);
    return undefined;
  }
  return realClearTimeout(handle);
};

const tick = () => new Promise((resolve) => realSetTimeout(resolve, 0));

// Drive a promise to settlement by firing virtual timers in time order; each firing advances the
// shared clock. Fails loudly on a deadlock (pending promise, no timers) instead of hanging.
async function pump(promise) {
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  for (let guard = 0; guard < 100000; guard++) {
    await tick(); // flush microtask continuations first
    if (settled) return;
    if (!virtual || virtual.timers.length === 0) {
      await tick();
      if (settled) return;
      throw new Error("virtual deadlock: promise pending with no scheduled timers");
    }
    virtual.timers.sort((a, b) => a.at - b.at);
    const next = virtual.timers.shift();
    if (next.at > virtual.now) virtual.now = next.at; // ADVANCE the shared clock
    next.fn();
  }
  throw new Error("pump guard exceeded");
}
async function pumpError(factory) {
  let caught = null;
  const p = factory().catch((e) => { caught = e; });
  await pump(p);
  return caught;
}
async function withVirtual(baseNow, fn) {
  virtual = { now: baseNow, timers: [], nextId: 1 };
  try { return await fn(); } finally { virtual = null; }
}

// ---- ordered event log + scripted, abort-aware fetch stub ----
const events = []; // { type: "sleep", ms } | { type: "fetch", method, url, at } | { type: "abort", at }
let fetchQueue = [];
const mkRes = ({ status = 200, body = {} }) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => null },
  json: async () => body,
  text: async () => JSON.stringify(body),
  clone() { return this; },
});
globalThis.fetch = (url, options = {}) => {
  const method = (options.method || "GET").toUpperCase();
  events.push({ type: "fetch", method, url: String(url), at: Date.now() });
  const next = fetchQueue.shift();
  if (!next) return Promise.reject(new Error(`unexpected fetch: ${method} ${url}`));
  const latency = Math.max(0, Number(next.latencyMs) || 0);
  if (!virtual || latency === 0) return Promise.resolve(mkRes(next));
  // Slow fetch in virtual mode: stays PENDING on a virtual timer and honors options.signal --
  // an abort cancels the response timer and rejects with a genuine AbortError.
  return new Promise((resolve, reject) => {
    const signal = options.signal;
    const abortError = () => { const e = new Error("This operation was aborted"); e.name = "AbortError"; return e; };
    if (signal && signal.aborted) { reject(abortError()); return; }
    const handle = globalThis.setTimeout(() => resolve(mkRes(next)), latency);
    if (signal) {
      signal.addEventListener("abort", () => {
        globalThis.clearTimeout(handle);
        events.push({ type: "abort", at: Date.now() });
        reject(abortError());
      }, { once: true });
    }
  });
};

const resetLog = () => { events.length = 0; fetchQueue = []; };
const fetches = () => events.filter((e) => e.type === "fetch");
const posts = () => fetches().filter((e) => e.method === "POST");
const statusGets = (id) => fetches().filter((e) => e.method === "GET" && e.url.endsWith(`/exports/${id}`));
const cadenceSleeps = () => events.filter((e) => e.type === "sleep" && e.ms === 5000);
const firstIndex = (pred) => events.findIndex(pred);

let pollExport, createExport, fetchExportRows, fetchAccounts, withDataDoeDeadline, ddFetch;
let DataDoeDeadlineError, isDataDoeDeadlineError, isDataDoePollPendingError;
let classifyFetchError, runSourceJobs;

// Ascending virtual bases, always ahead of the real clock so the module's rate limiter
// (stamped with earlier real/virtual times) never inserts an artificial first-call sleep.
let baseCursor = null;
const nextBase = () => { baseCursor = (baseCursor ?? realDateNow()) + 600_000; return baseCursor; };

// ---- compact in-memory store for the worker-level regression (models the SQL RPC surface) ----
function mkStore() {
  const jobs = new Map();
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

// ================= poller tests (simple mode) =================

test("(404 -> pending -> completed) status-GET 404 is temporary; poll resolves; zero POSTs; 5s wait precedes the FIRST GET", async () => {
  resetLog();
  fetchQueue = [
    { status: 404, body: { message: "Export not found" } },
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
    { status: 200, body: { exportId: "exp-1", status: "PENDING" } },
    { status: 404, body: {} },
    { status: 200, body: { status: "COMPLETED" } },
    { status: 200, body: { rawContent: JSON.stringify(rows) } },
  ];
  const got = await fetchExportRows("k", "src-1", ["a"], ["S1"], "2026-01-01", "2026-01-31", 100, { bypassSourceCache: true });
  assert.deepEqual(got, rows);
  assert.equal(posts().length, 1, "exactly ONE create-export POST across the whole flow");
  assert.equal(statusGets("exp-1").length, 2, "the 404 was absorbed by polling the SAME export id");
  assert.equal(fetches().filter((e) => e.url.endsWith("/exports/exp-1/raw")).length, 1, "one download");
});

// ================= execution-deadline regressions (virtual clock; sleeps ADVANCE time) =================

test("(deadline: cadence + HTTP latency share ONE budget) both are charged; the next cadence defers within the bound", async () => {
  resetLog();
  const base = nextBase();
  await withVirtual(base, async () => {
    const BUDGET = 12_000;
    // attempt 1: cadence sleep advances to +5000; the GET's 4s latency advances to +9000 (PENDING).
    // attempt 2: cadence pre-check sees 3000ms remaining < 5s cadence + headroom -> typed deferral.
    fetchQueue = [{ status: 200, body: { status: "PENDING" }, latencyMs: 4_000 }];
    const caught = await pumpError(() => withDataDoeDeadline(base + BUDGET, () => pollExport("k", "slow1")));
    assert.ok(isDataDoeDeadlineError(caught), "typed DataDoeDeadlineError");
    assert.ok(!isDataDoePollPendingError(caught), "a deadline stop stays distinct from poll-window exhaustion");
    assert.equal(statusGets("slow1").length, 1, "only the first GET ran; the second cadence never started");
    assert.equal(virtual.now - base, 9_000, "5s cadence + 4s HTTP latency were BOTH charged to the same clock");
    assert.ok(virtual.now - base <= BUDGET, "elapsed simulated time never exceeds the configured bound");
  });
});

test("(deadline before first cadence) insufficient budget for one cadence => zero status GETs", async () => {
  resetLog();
  const base = nextBase();
  await withVirtual(base, async () => {
    const caught = await pumpError(() => withDataDoeDeadline(base + 4_000, () => pollExport("k", "late")));
    assert.ok(isDataDoeDeadlineError(caught));
    assert.equal(statusGets("late").length, 0, "never starts a request when insufficient time remains");
    assert.equal(virtual.now, base, "nothing advanced the clock -- the cadence sleep never ran");
  });
});

test("(deadline blocks the request itself) insufficient remaining budget => the HTTP request never starts", async () => {
  resetLog();
  const base = nextBase();
  await withVirtual(base, async () => {
    fetchQueue = [{ status: 200, body: {} }];
    const caught = await pumpError(() => withDataDoeDeadline(base + 700, () => ddFetch("https://api.datadoe.com/api/v1/blocked", {})));
    assert.ok(isDataDoeDeadlineError(caught), "ddFetch's own pre-check defers inside the shutdown headroom");
    assert.equal(fetches().length, 0, "NO request was started");
  });
});

test("(deadline aborts an in-flight slow GET) the AbortSignal fires at deadline-headroom and becomes DataDoeDeadlineError", async () => {
  resetLog();
  const base = nextBase();
  await withVirtual(base, async () => {
    const BUDGET = 10_000;
    // cadence -> +5000; the GET would take 60s, so ddFetch's own deadline abort timer fires at
    // remaining-750 = +9250. The pending fetch rejects AbortError; ddFetch translates it.
    fetchQueue = [{ status: 200, body: { status: "PENDING" }, latencyMs: 60_000 }];
    const caught = await pumpError(() => withDataDoeDeadline(base + BUDGET, () => pollExport("k", "hung")));
    assert.ok(isDataDoeDeadlineError(caught), "the in-flight abort surfaces as the typed deadline error");
    assert.equal(statusGets("hung").length, 1, "the GET started once and was cancelled -- never retried past the bound");
    const abortEvent = events.find((e) => e.type === "abort");
    assert.ok(abortEvent, "the fetch stub observed the AbortSignal");
    assert.equal(abortEvent.at - base, 9_250, "aborted exactly at deadline - headroom");
    assert.ok(virtual.now - base <= BUDGET, "elapsed simulated time never exceeds the configured bound");
  });
});

test("(deadline vs rate-limit spacing) the 2-req/sec spacing sleep is budget-aware and blocks a second request", async () => {
  resetLog();
  const base = nextBase();
  await withVirtual(base, async () => {
    // Pre-seed OUTSIDE any deadline: stamps the rate limiter at `base`.
    fetchQueue = [{ status: 200, body: { ok: true } }];
    const seeded = ddFetch("https://api.datadoe.com/api/v1/x", {});
    await pump(seeded);
    assert.equal((await seeded).status, 200);
    const before = fetches().length;
    // A second request 0ms later under a 1.2s budget: the ~550ms spacing sleep + 750ms headroom
    // exceed the remaining budget, so the spacing sleep itself defers BEFORE any request starts.
    const caught = await pumpError(() => withDataDoeDeadline(base + 1_200, () => ddFetch("https://api.datadoe.com/api/v1/y", {})));
    assert.ok(isDataDoeDeadlineError(caught));
    assert.equal(fetches().length, before, "NO extra request started beyond the deadline");
    assert.ok(virtual.now - base <= 1_200, "elapsed simulated time never exceeds the configured bound");
  });
});

test("(deadline vs 429 retry sleep) the retry-after sleep consumes budget and cannot start another request", async () => {
  resetLog();
  const base = nextBase();
  await withVirtual(base, async () => {
    const BUDGET = 2_900;
    // One 429 (1s latency). The retry path would sleep retryAfterSeconds*1000+250 = 2250ms, but
    // only 1900ms remain -> the retry sleep defers; the retry request NEVER starts.
    fetchQueue = [{ status: 429, body: { retryAfterSeconds: 2 }, latencyMs: 1_000 }];
    const caught = await pumpError(() => withDataDoeDeadline(base + BUDGET, () => ddFetch("https://api.datadoe.com/api/v1/limited", {})));
    assert.ok(isDataDoeDeadlineError(caught), "the 429 retry sleep is bounded by the same deadline");
    assert.equal(fetches().length, 1, "exactly one request; the 429 retry never started");
    assert.ok(virtual.now - base <= BUDGET, "elapsed simulated time never exceeds the configured bound");
  });
});

test("(account discovery) retries only transient read-only 5xx responses; never creates an export", async () => {
  resetLog();
  fetchQueue = [
    { status: 503, body: { message: "temporary" } },
    { status: 502, body: { message: "temporary" } },
    { status: 200, body: { data: [{ id: "A1", name: "Account", marketplaceCountryCode: "US", currency: "USD" }] } },
  ];
  const rows = await fetchAccounts("key");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "A1");
  assert.equal(fetches().length, 3);
  assert.equal(posts().length, 0, "directory retries are GET-only and can never duplicate create-export");

  resetLog();
  fetchQueue = [{ status: 400, body: { message: "bad request" } }];
  await assert.rejects(() => fetchAccounts("key"), /accounts request failed \(400\)/);
  assert.equal(fetches().length, 1, "a definitive 4xx is never retried");
  assert.equal(posts().length, 0);
});

// ================= worker-level regression (Scheduler v2 two-invocation resume) =================

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
    pollExport, createExport, fetchExportRows, fetchAccounts, withDataDoeDeadline, ddFetch,
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
