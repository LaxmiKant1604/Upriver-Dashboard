// DataDoe pollExport hardening — deterministic OFFLINE tests of the confirmed DataDoe status behaviour:
// a status GET issued too soon after the create-export POST can return HTTP 404 before the export becomes
// visible. The poller must (1) wait one 5s cadence BEFORE the first status GET, (2) treat a status-GET 404
// as temporary (still pending) within the SAME bounded poll window, (3) NEVER issue a second create-export
// POST, (4) keep a create-POST 404 and non-404 status errors as real failures, and (5) preserve the Vercel
// 60-second bound (9 x 5s cadence sleeps = 45s, unchanged from the old loop's total sleep budget).
//
// Deterministic: globalThis.setTimeout is stubbed to fire immediately while RECORDING each requested delay,
// and globalThis.fetch is a scripted queue that RECORDS method+url. No network, no DataDoe, no Supabase.
//
// 7-bit ASCII, LF. Run: node scripts/datadoe-poll-export.test.js

import assert from "node:assert/strict";
import { writeSync } from "node:fs";

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };

// ---- deterministic timer stub: fire immediately, record every requested delay in order ----
const events = []; // ordered log of { type: "sleep", ms } and { type: "fetch", method, url }
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => {
  events.push({ type: "sleep", ms: Number(ms) || 0 });
  return realSetTimeout(fn, 0, ...args);
};

// ---- scripted fetch stub: shift the next queued responder, record method+url, fail on overrun ----
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
  events.push({ type: "fetch", method, url: String(url) });
  const next = fetchQueue.shift();
  if (!next) throw new Error(`unexpected fetch: ${method} ${url}`);
  return mkRes(next);
};

const resetLog = () => { events.length = 0; fetchQueue = []; };
const fetches = () => events.filter((e) => e.type === "fetch");
const posts = () => fetches().filter((e) => e.method === "POST");
const statusGets = (id) => fetches().filter((e) => e.method === "GET" && e.url.endsWith(`/exports/${id}`));
const cadenceSleeps = () => events.filter((e) => e.type === "sleep" && e.ms === 5000);
const firstIndex = (pred) => events.findIndex(pred);

let pollExport, createExport, fetchExportRows, classifyFetchError;

// ================= tests =================

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

test("(repeated-404 timeout) a 404 outliving the bounded window becomes the poll timeout -- non-terminal, still zero POSTs", async () => {
  resetLog();
  fetchQueue = Array.from({ length: 9 }, () => ({ status: 404, body: {} }));
  await assert.rejects(() => pollExport("k", "e2"), /timed out/);
  assert.equal(statusGets("e2").length, 9, "all nine bounded attempts used");
  assert.equal(posts().length, 0, "never a second create-export POST");
  assert.equal(cadenceSleeps().length, 9, "9 x 5s cadence sleeps -- the 45s budget is preserved (Vercel 60s bound)");
  // The scheduler classifies this exact message as a resumable TIMEOUT (never terminal): the saved
  // export_id resumes poll/download on the next slice without a second create.
  const cls = classifyFetchError(new Error("DataDoe export timed out while processing. Try a shorter date range."), "poll");
  assert.equal(cls.code, "TIMEOUT");
  assert.equal(cls.terminal, false);
});

test("(non-404 failures stay real) status 500 throws immediately; FAILED/BLOCKED_NO_TOKENS bodies throw; create-POST 404 stays a real failure", async () => {
  resetLog();
  fetchQueue = [
    { status: 200, body: { status: "PENDING" } },
    { status: 500, body: {} },
  ];
  await assert.rejects(() => pollExport("k", "e3"), /status check failed \(500\)/);
  assert.equal(statusGets("e3").length, 2, "stops at the real failure -- no further attempts");
  assert.equal(posts().length, 0);

  resetLog();
  fetchQueue = [{ status: 200, body: { status: "FAILED" } }];
  await assert.rejects(() => pollExport("k", "e4"), /failed to process \(FAILED\)/);

  resetLog();
  fetchQueue = [{ status: 200, body: { status: "BLOCKED_NO_TOKENS" } }];
  await assert.rejects(() => pollExport("k", "e5"), /failed to process \(BLOCKED_NO_TOKENS\)/);

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
  const firstCadence = firstIndex((e) => e.type === "sleep" && e.ms === 5000);
  const firstStatusGet = firstIndex((e) => e.type === "fetch" && e.method === "GET" && e.url.endsWith("/exports/exp-1"));
  assert.ok(firstCadence !== -1 && firstCadence < firstStatusGet, "5s wait precedes the first status GET in the full flow too");
});

async function main() {
  ({ pollExport, createExport, fetchExportRows } = await import("../lib/server/datadoe.js"));
  ({ classifyFetchError } = await import("../lib/server/sync/source-worker.js"));
  for (const t of tests) {
    try { await t.fn(); passed += 1; out("  ok  " + t.name); }
    catch (e) { out("FAIL  " + t.name); out(String(e && e.stack ? e.stack : e)); process.exitCode = 1; return; }
  }
  out("\n" + passed + " assertions passed");
}

main();
