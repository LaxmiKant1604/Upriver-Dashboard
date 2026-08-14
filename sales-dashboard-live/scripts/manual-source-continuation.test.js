// Manual DataDoe export continuation — deterministic OFFLINE tests of the durable attempt-marker
// protocol (lib/server/manual-source-continuation.js) and its wiring through fetchSourceChunk and
// the /api/datadoe route error mapping.
//
// The finding: Scheduler v2 resumes its persisted export_id, but the manual path only held the
// in-flight export in process memory -- after a 504 retryable:true, the NEXT HTTP request (a fresh
// serverless invocation) called createExport again and could spend another token. The durable
// marker (report_snapshots INSERT-IF-ABSENT + rev-CAS, keyed by the exact canonical request_hash)
// makes request B resume request A's export with ZERO new create POSTs.
//
// No network, DataDoe, or Supabase: the marker store is an injected in-memory fake; DataDoe HTTP
// is a scripted global-fetch queue; timers fire immediately (recorded); real clock.
//
// 7-bit ASCII, LF. Run: node scripts/manual-source-continuation.test.js

import assert from "node:assert/strict";
import { writeSync } from "node:fs";

process.env.DATADOE_API_KEY = process.env.DATADOE_API_KEY || "dd_api_test";

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };

// ---- instant timers (recorded) + scripted fetch ----
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => realSetTimeout(fn, 0, ...args);
const tick = () => new Promise((resolve) => realSetTimeout(resolve, 0));

let fetchQueue = [];
const fetchLog = [];
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
  fetchLog.push({ method, url: String(url) });
  const next = fetchQueue.shift();
  if (!next) throw new Error(`unexpected fetch: ${method} ${url}`);
  return mkRes(next);
};
const posts = () => fetchLog.filter((e) => e.method === "POST");
const resetHttp = () => { fetchQueue = []; fetchLog.length = 0; };

// ---- in-memory marker store (models insert-if-absent + rev-CAS + delete), with spies ----
function fakeStore() {
  const rows = new Map(); // requestHash -> payload (with rev)
  const calls = { load: 0, save: 0, remove: 0 };
  let failNext = null; // "load" | "save-throw" | "save-lose"
  return {
    rows, calls,
    failNext: (mode) => { failNext = mode; },
    async load(h) {
      calls.load += 1;
      if (failNext === "load") { failNext = null; throw new Error("supabase down (raw)"); }
      const p = rows.get(h);
      return p ? { ...p } : null;
    },
    async save(h, marker) {
      calls.save += 1;
      if (failNext === "save-throw") { failNext = null; throw new Error("supabase down (raw)"); }
      if (failNext === "save-lose") { failNext = null; return false; }
      if (marker.rev == null) {
        if (rows.has(h)) return false;
        rows.set(h, { ...marker, rev: 1 });
        return 1;
      }
      const current = rows.get(h);
      if (!current || current.rev !== marker.rev) return false;
      rows.set(h, { ...marker, rev: marker.rev + 1 });
      return marker.rev + 1;
    },
    async remove(h) { calls.remove += 1; rows.delete(h); return true; },
  };
}

// ---- fake transport for module-level protocol tests ----
const pollPendingErr = () => { const e = new Error("still processing"); e.code = "DATADOE_POLL_PENDING"; return e; };
const deadlineErr = () => { const e = new Error("deferred"); e.code = "DATADOE_DEADLINE"; return e; };
const isResumableEscape = (e) => e != null && (e.code === "DATADOE_POLL_PENDING" || e.code === "DATADOE_DEADLINE");
const isDefiniteCreateFailure = (e) => /export creation failed \(\d{3}\)/.test(e instanceof Error ? e.message : String(e));

function mkTransport({ createResult, pollThrows = null, downloadRows = [{ r: 1 }] } = {}) {
  const t = {
    creates: 0, polls: 0, downloads: 0, finished: [],
    create: async () => { t.creates += 1; if (createResult instanceof Error) throw createResult; return createResult || { exportId: "E1", status: "PENDING" }; },
    poll: async () => { t.polls += 1; if (pollThrows) throw pollThrows; },
    download: async () => { t.downloads += 1; return downloadRows; },
    finishRows: async (rows) => { t.finished.push(rows); return rows; },
  };
  return t;
}

let runManualSourceAttempt, isManualSourceContinuationError, __setManualSourceContinuationTestOverrides;
let MANUAL_CONTINUATION_IN_PROGRESS, MANUAL_CONTINUATION_UNAVAILABLE, MANUAL_CONTINUATION_UNCERTAIN;
let fetchExportRows, withDataDoeDeadline, isDataDoePollPendingError, isDataDoeDeadlineError, DataDoePollPendingError, DataDoeDeadlineError;
let classifyDataDoeRouteError;

const runAttempt = (store, transport, requestHash = "h1") => runManualSourceAttempt({
  requestHash, organizationFingerprint: "orgA", sourceId: "src-1",
  create: transport.create, poll: transport.poll, download: transport.download,
  finishRows: transport.finishRows, isResumableEscape, isDefiniteCreateFailure,
  deps: { store },
});

// ================= module-level protocol tests =================

test("(happy path) claim -> exactly one create -> exportId CAS -> poll/download -> cache first -> marker removed", async () => {
  const store = fakeStore();
  const t = mkTransport({});
  const rows = await runAttempt(store, t);
  assert.deepEqual(rows, [{ r: 1 }]);
  assert.equal(t.creates, 1);
  assert.equal(t.finished.length, 1, "rows persisted through the injected source-cache step");
  assert.equal(store.rows.size, 0, "marker removed AFTER completion");
  assert.equal(store.calls.remove, 1);
});

test("(concurrent first requests) exactly ONE create POST; the loser gets typed IN_PROGRESS retryable:true and never overwrites", async () => {
  const store = fakeStore();
  let releaseCreate;
  const gate = new Promise((resolve) => { releaseCreate = resolve; });
  const t1 = mkTransport({});
  t1.create = async () => { t1.creates += 1; await gate; return { exportId: "E1", status: "PENDING" }; };
  const p1 = runAttempt(store, t1);
  p1.catch(() => {});
  await tick(); await tick(); // request A holds the durable "creating" claim, create in flight
  assert.equal(t1.creates, 1);
  const t2 = mkTransport({});
  let caught = null;
  await runAttempt(store, t2).catch((e) => { caught = e; });
  assert.ok(isManualSourceContinuationError(caught));
  assert.equal(caught.code, MANUAL_CONTINUATION_IN_PROGRESS);
  assert.equal(caught.retryable, true, "the owner's durable marker exists, so retry is honest");
  assert.equal(t2.creates, 0, "the concurrent request made ZERO create POSTs");
  assert.equal(store.rows.get("h1").status, "creating", "the owner's marker was never overwritten");
  releaseCreate();
  await p1;
  assert.equal(store.rows.size, 0);
  assert.equal(t1.creates + t2.creates, 1, "exactly one create total");
});

test("(poll-pending after E1, then a separate request) marker keeps exportId; request B resumes with ZERO creates", async () => {
  const store = fakeStore();
  const tA = mkTransport({ pollThrows: pollPendingErr() });
  let caught = null;
  await runAttempt(store, tA).catch((e) => { caught = e; });
  assert.equal(tA.creates, 1);
  assert.equal(caught.code, "DATADOE_POLL_PENDING");
  assert.equal(caught.durableContinuation, true, "escape is flagged durable -- the route may say retryable:true");
  const marker = store.rows.get("h1");
  assert.equal(marker.status, "polling");
  assert.equal(marker.exportId, "E1", "exportId persisted BEFORE polling and preserved by the escape");
  // request B: separate invocation (fresh transport; the in-memory promise is long gone)
  const tB = mkTransport({});
  const rows = await runAttempt(store, tB);
  assert.deepEqual(rows, [{ r: 1 }]);
  assert.equal(tB.creates, 0, "request B resumed the SAVED export: zero new create POSTs");
  assert.equal(tB.polls, 1);
  assert.equal(store.rows.size, 0, "marker removed after the resumed completion");
});

test("(execution deadline after E1) same durable resume path as poll-pending", async () => {
  const store = fakeStore();
  const tA = mkTransport({ pollThrows: deadlineErr() });
  let caught = null;
  await runAttempt(store, tA).catch((e) => { caught = e; });
  assert.equal(caught.code, "DATADOE_DEADLINE");
  assert.equal(caught.durableContinuation, true);
  assert.equal(store.rows.get("h1").exportId, "E1");
  const tB = mkTransport({});
  await runAttempt(store, tB);
  assert.equal(tA.creates + tB.creates, 1, "exactly one create across the deadline + resume");
});

test("(claim write failure) typed CONTINUATION_UNAVAILABLE, retryable:false, create NEVER called", async () => {
  const store = fakeStore();
  store.failNext("save-throw");
  const t = mkTransport({});
  let caught = null;
  await runAttempt(store, t).catch((e) => { caught = e; });
  assert.equal(caught.code, MANUAL_CONTINUATION_UNAVAILABLE);
  assert.equal(caught.retryable, false, "no durable continuation could be established");
  assert.equal(t.creates, 0, "failed claim => NO create-export (fail closed)");
});

test("(exportId transition failure: CAS throw AND CAS loss) fail closed; no duplicate POST ever for that marker", async () => {
  for (const mode of ["save-throw", "save-lose"]) {
    const store = fakeStore();
    const t = mkTransport({});
    const original = store.save.bind(store);
    let saves = 0;
    store.save = async (h, m) => { saves += 1; if (saves === 2) { store.failNext(mode); } return original(h, m); }; // claim ok; exportId CAS fails
    let caught = null;
    await runAttempt(store, t).catch((e) => { caught = e; });
    assert.equal(t.creates, 1, `${mode}: the one create happened`);
    assert.equal(caught.code, MANUAL_CONTINUATION_UNCERTAIN, `${mode}: typed uncertain (never terminal-raw)`);
    assert.equal(caught.retryable, false);
    // a follow-up request must NOT auto-create for this marker
    const t2 = mkTransport({});
    let caught2 = null;
    await runAttempt(store, t2).catch((e) => { caught2 = e; });
    assert.equal(t2.creates, 0, `${mode}: zero duplicate POSTs`);
    assert.equal(caught2.code, MANUAL_CONTINUATION_IN_PROGRESS, `${mode}: fresh creating marker -> in-progress`);
  }
});

test("(definite create failure) admin-safe typed code only; marker becomes failed and IS re-claimable", async () => {
  const store = fakeStore();
  const boom = new Error('DataDoe export creation failed (404): {"message":"Source not found","statusCode":404}');
  const tA = mkTransport({ createResult: boom });
  await runAttempt(store, tA).catch(() => {});
  assert.equal(tA.creates, 1);
  const marker = store.rows.get("h1");
  assert.equal(marker.status, "failed");
  assert.equal(marker.code, "CREATE_FAILED_404", "only the status digits survive");
  assert.ok(!JSON.stringify([...store.rows.values()]).includes("Source not found"), "no raw DataDoe text in the marker");
  // definite failure = no export existed: a later request may safely re-claim and create
  const tB = mkTransport({});
  const rows = await runAttempt(store, tB);
  assert.deepEqual(rows, [{ r: 1 }]);
  assert.equal(tB.creates, 1, "re-claimed via CAS after a DEFINITE failure only");
});

test("(ambiguous create outcome) marker stays creating; fresh => in-progress; expired => UNCERTAIN; never auto-created", async () => {
  const store = fakeStore();
  const tA = mkTransport({ createResult: new Error("socket hang up") }); // NOT the definite shape
  await runAttempt(store, tA).catch(() => {});
  assert.equal(tA.creates, 1);
  assert.equal(store.rows.get("h1").status, "creating", "ambiguous outcome leaves the claim in place");
  const t2 = mkTransport({});
  let caught = null;
  await runAttempt(store, t2).catch((e) => { caught = e; });
  assert.equal(caught.code, MANUAL_CONTINUATION_IN_PROGRESS, "fresh marker: in-progress");
  assert.equal(t2.creates, 0);
  // conservative retention: once expired, the outcome is UNCERTAIN -- surfaced, never silently retried
  store.rows.get("h1").expiresAt = new Date(Date.now() - 1000).toISOString();
  const t3 = mkTransport({});
  let caught3 = null;
  await runAttempt(store, t3).catch((e) => { caught3 = e; });
  assert.equal(caught3.code, MANUAL_CONTINUATION_UNCERTAIN);
  assert.equal(caught3.retryable, false);
  assert.equal(t3.creates, 0, "an uncertain create is NEVER silently retried");
});

test("(genuine export failure during poll) marker records EXPORT_FAILED; no resumable flag", async () => {
  const store = fakeStore();
  const tA = mkTransport({ pollThrows: new Error("DataDoe export failed to process (FAILED).") });
  let caught = null;
  await runAttempt(store, tA).catch((e) => { caught = e; });
  assert.ok(!isManualSourceContinuationError(caught) && caught.durableContinuation !== true);
  assert.equal(store.rows.get("h1").status, "failed");
  assert.equal(store.rows.get("h1").code, "EXPORT_FAILED");
});

test("(hash isolation) an in-flight marker for one request_hash never affects another", async () => {
  const store = fakeStore();
  const tA = mkTransport({ pollThrows: pollPendingErr() });
  await runAttempt(store, tA, "h1").catch(() => {});
  assert.equal(store.rows.get("h1").status, "polling");
  const tB = mkTransport({});
  const rows = await runAttempt(store, tB, "h2");
  assert.deepEqual(rows, [{ r: 1 }]);
  assert.equal(tB.creates, 1, "h2 proceeds independently");
  assert.equal(store.rows.get("h1").status, "polling", "h1 marker untouched");
});

test("(corrupt marker rev) fails closed as UNCERTAIN; zero creates", async () => {
  const store = fakeStore();
  store.rows.set("h1", { version: "manual-source-attempt-v1", requestHash: "h1", status: "polling", exportId: "E1", rev: "1" });
  const t = mkTransport({});
  let caught = null;
  await runAttempt(store, t).catch((e) => { caught = e; });
  assert.equal(caught.code, MANUAL_CONTINUATION_UNCERTAIN);
  assert.equal(t.creates, 0);
});

test("(marker payload shape) safe typed fields only -- never an api key, rows, or raw error text", async () => {
  const store = fakeStore();
  const tA = mkTransport({ pollThrows: pollPendingErr() });
  await runAttempt(store, tA).catch(() => {});
  const marker = store.rows.get("h1");
  assert.deepEqual(Object.keys(marker).sort(), ["code", "createdAt", "expiresAt", "exportId", "organizationFingerprint", "requestHash", "rev", "sourceId", "status", "updatedAt", "version"].sort());
  const blob = JSON.stringify(marker);
  assert.ok(!blob.includes("dd_api_test") && !/apiKey/i.test(blob), "no credential material");
});

// ================= integration: two separate HTTP-style requests through fetchExportRows =================

test("(two-request integration: poll-pending) request A creates E1 + poll-pends; request B resumes E1 -- ONE POST total", async () => {
  resetHttp();
  const store = fakeStore();
  __setManualSourceContinuationTestOverrides({ enabled: true, store });
  // request A: create POST -> E1, then the full temporary window (9 x 404) -> typed escape
  fetchQueue = [
    { status: 200, body: { exportId: "E1", status: "PENDING" } },
    ...Array.from({ length: 9 }, () => ({ status: 404, body: {} })),
  ];
  let caughtA = null;
  await fetchExportRows("kA", "src-manual-1", ["a"], ["S1"], "2026-01-01", "2026-01-31", 100, {}).catch((e) => { caughtA = e; });
  assert.ok(isDataDoePollPendingError(caughtA));
  assert.equal(caughtA.durableContinuation, true, "durable marker exists -> the route may answer retryable:true");
  assert.equal(posts().length, 1);
  assert.equal(store.rows.size, 1);
  const marker = [...store.rows.values()][0];
  assert.equal(marker.status, "polling");
  assert.equal(marker.exportId, "E1");
  // request B: a separate invocation -- request A's in-memory in-flight promise is GONE (its
  // rejected work was dropped in fetchSourceChunk's finally). B recomputes the same request_hash,
  // loads the marker, and resumes E1.
  const rows = [{ ok: 1 }];
  fetchQueue = [
    { status: 200, body: { status: "COMPLETED" } },
    { status: 200, body: { rawContent: JSON.stringify(rows) } },
  ];
  const got = await fetchExportRows("kA", "src-manual-1", ["a"], ["S1"], "2026-01-01", "2026-01-31", 100, {});
  assert.deepEqual(got, rows);
  assert.equal(posts().length, 1, "EXACTLY ONE create-export POST across both requests");
  assert.equal(store.rows.size, 0, "marker removed after the resumed completion");
  __setManualSourceContinuationTestOverrides(null);
});

test("(two-request integration: execution deadline after E1) request B resumes -- ONE POST total", async () => {
  resetHttp();
  const store = fakeStore();
  __setManualSourceContinuationTestOverrides({ enabled: true, store });
  // request A runs under a 5s DataDoe budget: the create POST fits, the exportId is persisted,
  // and the first 5s poll cadence cannot fit (5s remaining <= 5s + headroom) -> typed deadline.
  fetchQueue = [{ status: 200, body: { exportId: "E9", status: "PENDING" } }];
  let caughtA = null;
  await withDataDoeDeadline(Date.now() + 5_000, () => fetchExportRows("kB", "src-manual-2", ["a"], ["S1"], "2026-02-01", "2026-02-28", 100, {})).catch((e) => { caughtA = e; });
  assert.ok(isDataDoeDeadlineError(caughtA));
  assert.equal(caughtA.durableContinuation, true);
  assert.equal(posts().length, 1);
  assert.equal([...store.rows.values()][0].exportId, "E9", "exportId persisted BEFORE the deadline hit");
  const rows = [{ ok: 2 }];
  fetchQueue = [
    { status: 200, body: { status: "COMPLETED" } },
    { status: 200, body: { rawContent: JSON.stringify(rows) } },
  ];
  const got = await fetchExportRows("kB", "src-manual-2", ["a"], ["S1"], "2026-02-01", "2026-02-28", 100, {});
  assert.deepEqual(got, rows);
  assert.equal(posts().length, 1, "EXACTLY ONE create-export POST across deadline + resume");
  __setManualSourceContinuationTestOverrides(null);
});

test("(cache-first) a warm source cache returns before ANY marker read or DataDoe request", async () => {
  resetHttp();
  const store = fakeStore();
  __setManualSourceContinuationTestOverrides({ enabled: true, store });
  const loadsBefore = store.calls.load;
  // src-manual-1 completed in the poll-pending integration test above; its rows are in the
  // in-process source memory cache under the same identity.
  const got = await fetchExportRows("kA", "src-manual-1", ["a"], ["S1"], "2026-01-01", "2026-01-31", 100, {});
  assert.deepEqual(got, [{ ok: 1 }]);
  assert.equal(fetchLog.length, 0, "zero DataDoe requests");
  assert.equal(store.calls.load, loadsBefore, "zero marker reads -- the cache answered first");
  __setManualSourceContinuationTestOverrides(null);
});

test("(non-durable fallback) without a durable store, a resumable escape is NOT flagged durable", async () => {
  resetHttp();
  __setManualSourceContinuationTestOverrides({ enabled: false });
  fetchQueue = [
    { status: 200, body: { exportId: "E5", status: "PENDING" } },
    ...Array.from({ length: 9 }, () => ({ status: 404, body: {} })),
  ];
  let caught = null;
  await fetchExportRows("kC", "src-manual-3", ["a"], ["S1"], "2026-03-01", "2026-03-31", 100, {}).catch((e) => { caught = e; });
  assert.ok(isDataDoePollPendingError(caught));
  assert.equal(caught.durableContinuation, false, "no durable continuation could be established");
  __setManualSourceContinuationTestOverrides(null);
});

// ================= route error mapping =================

test("(route mapping) retryable:true ONLY with a durable continuation; fixed safe messages; no raw text", async () => {
  const durablePending = new DataDoePollPendingError("E1"); durablePending.durableContinuation = true;
  const bareP = new DataDoePollPendingError("E1"); bareP.durableContinuation = false;
  const durableDeadline = new DataDoeDeadlineError(); durableDeadline.durableContinuation = true;
  const bareDeadline = new DataDoeDeadlineError();
  assert.deepEqual(classifyDataDoeRouteError(durablePending), { status: 504, body: { error: "DataDoe is still processing this request. Please retry in a moment.", retryable: true } });
  assert.equal(classifyDataDoeRouteError(bareP).body.retryable, false);
  assert.equal(classifyDataDoeRouteError(durableDeadline).body.retryable, true);
  assert.equal(classifyDataDoeRouteError(bareDeadline).body.retryable, false, "a deadline WITHOUT a durable continuation must not invite a token-spending retry");
  const inProgress = { code: MANUAL_CONTINUATION_IN_PROGRESS, message: "raw internal detail" };
  const mappedInProgress = classifyDataDoeRouteError(inProgress);
  assert.deepEqual(mappedInProgress, { status: 504, body: { error: "Another request is already fetching this data. Please retry in a moment.", retryable: true } });
  for (const code of [MANUAL_CONTINUATION_UNAVAILABLE, MANUAL_CONTINUATION_UNCERTAIN]) {
    const mapped = classifyDataDoeRouteError({ code, message: "raw supabase text with secrets" });
    assert.equal(mapped.status, 503);
    assert.equal(mapped.body.retryable, false);
    assert.ok(!mapped.body.error.includes("raw supabase"), "fixed safe message only");
  }
  assert.ok(!JSON.stringify(mappedInProgress).includes("raw internal"), "never the error's own text");
  assert.ok(!JSON.stringify(classifyDataDoeRouteError(durablePending)).includes("E1"), "exportId never reaches the browser");
  assert.equal(classifyDataDoeRouteError(new Error("ordinary failure")), null, "other errors keep their existing handling");
});

async function main() {
  ({
    runManualSourceAttempt, isManualSourceContinuationError, __setManualSourceContinuationTestOverrides,
    MANUAL_CONTINUATION_IN_PROGRESS, MANUAL_CONTINUATION_UNAVAILABLE, MANUAL_CONTINUATION_UNCERTAIN,
  } = await import("../lib/server/manual-source-continuation.js"));
  ({
    fetchExportRows, withDataDoeDeadline, isDataDoePollPendingError, isDataDoeDeadlineError,
    DataDoePollPendingError, DataDoeDeadlineError,
  } = await import("../lib/server/datadoe.js"));
  ({ classifyDataDoeRouteError } = await import("../api/datadoe.js"));
  for (const t of tests) {
    try { await t.fn(); passed += 1; out("  ok  " + t.name); }
    catch (e) { out("FAIL  " + t.name); out(String(e && e.stack ? e.stack : e)); process.exitCode = 1; return; }
  }
  out("\n" + passed + " assertions passed");
}

main();
