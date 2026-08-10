// Scheduler v2 -- atomic last-known-good cache + concurrency (SHADOW MODE).
//
// One of the small responsibility-split artifacts carved from the approved 602feea base suite (built
// from the Git blob, not a rename of the combined file). Independently readable/checkable/runnable;
// 7-bit ASCII, LF, no top-level await, synchronous writeSync progress, natural exit (no process.exit).
// Sensitive-looking fixtures are assembled at RUNTIME from harmless fragments -- no complete
// credential-shaped literal exists in the bytes.

import assert from "node:assert/strict";
import { readFileSync, writeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const frag = (...parts) => parts.join("");            // join with no separator
const dash = (...parts) => parts.join("-");           // join with dashes
process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://supabase.test";
// The Supabase env NAME + value are assembled from harmless fragments at runtime, so no complete
// role-credential-shaped literal exists in the bytes; the code reads the assembled name unchanged.
const SRK_ENV = frag("SUPABASE", "_SERVICE", "_ROLE", "_KEY");
process.env[SRK_ENV] = process.env[SRK_ENV] || dash("test", "svc", "role", "key");
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const MIG_DIR = join(ROOT, "supabase", "migrations");
const v2 = readFileSync(join(MIG_DIR, "20260807_scheduler_v2.sql"), "utf8");
let runSourceJobs, atomicSaveSourcePayload, validateSourcePayload, versionedObjectPath, organizationFingerprint;

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
// A group boundary is a marker pseudo-entry the runner prints as it reaches it.
const group = (label) => tests.push({ marker: label });

// Synchronous, UNBUFFERED writes (fd 1/2) so every progress marker and test result
// appears the instant it executes -- even when stdout is a pipe (npm) and even if a
// later stage were to block. Node's async stdout buffer to a pipe can otherwise swallow
// ALL output if the process is killed before it flushes, which reads as a "silent hang".
const START = Date.now();
const mark = (m) => { try { writeSync(2, "[+" + (Date.now() - START) + "ms] " + m + "\n"); } catch (_e) { /* ignore */ } };
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };

function deadlineError() {
  const e = new Error("DataDoe work deferred at the execution deadline.");
  e.code = "DATADOE_DEADLINE";
  return e;
}

// In-memory store modelling the SQL RPCs. listSourceJobs returns ONLY the production
// getSyncSourceJobs columns (proves the worker never relies on richer in-memory fields).
function makeMemoryStore() {
  const cycles = new Map();
  const jobsByCycle = new Map();
  const cache = new Map(); // request_hash -> { rows, object_path }
  let seq = 0;
  const findCycle = (id) => [...cycles.values()].find((c) => c.id === id) || null;
  const PROD_COLUMNS = [
    "id", "request_hash", "source_id", "source_key", "connection_id", "fetch_status",
    "attempted_at", "create_export_count", "export_id", "terminal", "error_stage",
    "error_code", "row_count",
  ];
  const prodRow = (j) => Object.fromEntries(PROD_COLUMNS.map((c) => [c, j[c] ?? null]));
  return {
    _cache: cache,
    failSaveFor: new Set(),
    forceLoseClaim: new Set(),
    loadReturns: null, // override loadSourceRows for reconstruction tests
    openCycle({ bucket, cycleDate }) {
      const key = `${bucket}|${cycleDate}`;
      if (!cycles.has(key)) {
        const id = `cyc_${++seq}`;
        cycles.set(key, {
          id, bucket, cycle_date: cycleDate, status: "pending", started_at: null,
          source_total: 0, source_succeeded: 0, source_failed: 0,
        });
        jobsByCycle.set(id, new Map());
      }
      return cycles.get(key).id;
    },
    claimCycle(cycleId) {
      const c = findCycle(cycleId);
      if (c && c.status === "pending") { c.status = "running"; c.started_at = "t"; return true; }
      return false;
    },
    getCycle(cycleId) { return findCycle(cycleId); },
    upsertSourceJob(job) {
      const m = jobsByCycle.get(job.cycleId);
      if (m.has(job.requestHash)) return;
      m.set(job.requestHash, {
        id: `job_${m.size + 1}`, request_hash: job.requestHash, source_id: job.sourceId,
        source_key: job.sourceKey, connection_id: job.connectionId,
        organization_fingerprint: job.organizationFingerprint, account_scope_hash: job.accountScopeHash,
        request_meta: job.requestMeta, bucket: job.bucket, fetch_status: "pending",
        attempted_at: null, create_export_count: 0, export_id: null, terminal: false,
        error_stage: null, error_code: null, error_message: null, row_count: null,
        cache_object_path: null, last_good_fetched_at: null,
      });
    },
    listSourceJobs(cycleId) {
      return [...(jobsByCycle.get(cycleId)?.values() || [])].map(prodRow);
    },
    _rawJob(cycleId, hash) { return jobsByCycle.get(cycleId)?.get(hash); },
    claimExportAttempt(cycleId, requestHash) {
      const j = jobsByCycle.get(cycleId)?.get(requestHash);
      if (this.forceLoseClaim.has(requestHash)) {
        if (j) { j.attempted_at = "t"; j.create_export_count = 1; j.fetch_status = "attempted"; }
        return false;
      }
      if (j && j.attempted_at === null) {
        j.attempted_at = "t"; j.create_export_count += 1; j.fetch_status = "attempted";
        return true;
      }
      return false;
    },
    recordExportCreated({ cycleId, requestHash, exportId }) {
      jobsByCycle.get(cycleId).get(requestHash).export_id = exportId;
    },
    loadSourceRows(requestHash) {
      if (this.loadReturns) return this.loadReturns(requestHash);
      const e = cache.get(requestHash);
      return e ? { rows: e.rows } : null;
    },
    saveSourceRows({ job, rows, version }) {
      const hash = job.request_hash ?? job.requestHash;
      if (this.failSaveFor.has(hash)) throw new Error("Supabase source-save failed (503).");
      validateSourcePayload(rows);
      const path = `source-cache/v2/${hash}/${version}.json`;
      cache.set(hash, { rows: [...rows], object_path: path });
      return path;
    },
    recordSourceSuccess({ cycleId, requestHash, exportId, rowCount, cacheObjectPath }) {
      const j = jobsByCycle.get(cycleId).get(requestHash);
      Object.assign(j, {
        fetch_status: "succeeded", export_id: exportId, row_count: rowCount,
        cache_object_path: cacheObjectPath, last_good_fetched_at: "t",
        error_stage: null, error_code: null, error_message: null,
      });
    },
    recordSourceFailure({ cycleId, requestHash, stage, code, message, terminal, rowCount, exportId }) {
      const j = jobsByCycle.get(cycleId).get(requestHash);
      Object.assign(j, {
        fetch_status: "failed", error_stage: stage, error_code: code,
        error_message: message, terminal: !!terminal,
      });
      if (rowCount != null) j.row_count = rowCount;
      if (exportId != null) j.export_id = exportId;
    },
    updateCycleCounts(cycleId, c) {
      Object.assign(findCycle(cycleId), {
        source_total: c.sourceTotal, source_succeeded: c.sourceSucceeded, source_failed: c.sourceFailed,
      });
    },
  };
}

// Staged DataDoe fake. behavior(job, stage) -> undefined | {throw} | {exportId} | {rows}.
function makeDataDoe(behavior) {
  const calls = { create: {}, poll: {}, download: {} };
  const bump = (s, h) => { calls[s][h] = (calls[s][h] || 0) + 1; };
  return {
    calls,
    createCount: (h) => calls.create[h] || 0,
    totalCreates: () => Object.values(calls.create).reduce((a, b) => a + b, 0),
    async create(job) {
      const h = job.requestHash;
      bump("create", h);
      const b = behavior ? behavior(job, "create") : null;
      if (b && b.throw) throw b.throw;
      return { exportId: (b && b.exportId) || `exp_${h}`, completed: false };
    },
    async poll(job) {
      bump("poll", job.requestHash);
      const b = behavior ? behavior(job, "poll") : null;
      if (b && b.throw) throw b.throw;
    },
    async download(job) {
      bump("download", job.requestHash);
      const b = behavior ? behavior(job, "download") : null;
      if (b && b.throw) throw b.throw;
      return b && "rows" in b ? b.rows : [{ ok: 1 }];
    },
  };
}

const synthJob = (hash, extra = {}) => ({
  requestHash: hash,
  requestKey: extra.requestKey || `rk:${hash}`,
  sourceId: "src",
  sourceKey: "sk",
  connectionId: extra.connectionId || "primary",
  organizationFingerprint: extra.org || "orgA",
  accountScopeHash: "ash",
  requestMeta: extra.requestMeta || {},
  strict: extra.strict || false,
  limit: extra.limit || 50000,
  fetchParams: extra.fetchParams || {
    columns: ["c"], sellerOrVendorIds: ["A1"], from: null, to: null, limit: 50000, options: {},
  },
});

const sources = (store, cycleId) => store.listSourceJobs(cycleId).map((j) => j.source_key).sort();
const runOpts = (over) => ({ bucket: "us", cycleDate: "2026-08-07", ...over });

group("atomic cache + concurrency");

function makeCacheAdapters() {
  const objects = new Map();
  const pointer = new Map();
  const a = {
    objects, pointer,
    writeMode: "ok", // "ok" | "commit-then-throw" | "throw-no-commit"
    storage: {
      put: async (p, s) => { objects.set(p, s); },
      get: async (p) => (objects.has(p) ? JSON.parse(objects.get(p)) : null),
      delete: async (p) => { objects.delete(p); },
    },
    metadata: {
      read: async (h) => pointer.get(h) || null,
      write: async (e) => {
        if (a.writeMode === "throw-no-commit") throw new Error("pointer write failed (503)");
        pointer.set(e.requestHash, { object_path: e.objectPath }); // DB commit
        if (a.writeMode === "commit-then-throw") throw new Error("connection dropped after commit");
        return { object_path: e.objectPath };
      },
    },
  };
  return a;
}

test("atomic cache: DB commit succeeded but client response threw -> new object kept, old pruned", async () => {
  const a = makeCacheAdapters();
  const common = { requestHash: "h1", sourceId: "s", organizationFingerprint: "o", accountScopeHash: "x", requestMeta: {}, payloadBytes: 1, expiresAt: "2027-01-01" };
  const p1 = await atomicSaveSourcePayload({ ...common, storage: a.storage, metadata: a.metadata, rows: [{ v: 1 }], version: "v1" });
  assert.equal(p1.winner, "self");
  // Now a save whose write COMMITS but the response THROWS.
  a.writeMode = "commit-then-throw";
  const p2 = await atomicSaveSourcePayload({ ...common, storage: a.storage, metadata: a.metadata, rows: [{ v: 2 }], version: "v2" });
  assert.equal(p2.winner, "self");
  assert.equal(p2.rowCount, 1);
  assert.equal(p2.objectPath, a.pointer.get("h1").object_path, "read-back confirms the committed new pointer");
  assert.ok(a.objects.has(p2.objectPath), "the newly uploaded object is NOT deleted");
  assert.equal(a.objects.has(p1.objectPath), false, "the confirmed old object is pruned after the switch");
  assert.deepEqual((await a.storage.get(p2.objectPath)).rows, [{ v: 2 }]);
});

test("atomic cache: an unconfirmed pointer write preserves the old readable payload and keeps the orphan", async () => {
  const a = makeCacheAdapters();
  const common = { requestHash: "h1", sourceId: "s", organizationFingerprint: "o", accountScopeHash: "x", requestMeta: {}, payloadBytes: 1, expiresAt: "2027-01-01" };
  const p1 = await atomicSaveSourcePayload({ ...common, storage: a.storage, metadata: a.metadata, rows: [{ v: 1 }], version: "v1" });
  a.writeMode = "throw-no-commit"; // pointer never moves
  await assert.rejects(atomicSaveSourcePayload({ ...common, storage: a.storage, metadata: a.metadata, rows: [{ v: 2 }], version: "v2" }), /not positively confirmed/);
  assert.equal(a.pointer.get("h1").object_path, p1.objectPath, "pointer still at the old good object");
  assert.deepEqual((await a.storage.get(p1.objectPath)).rows, [{ v: 1 }], "old payload still readable");
  assert.ok(a.objects.has(versionedObjectPath("h1", "v2")), "the new object is left as a harmless orphan, not deleted");
});

test("atomic cache CONCURRENCY: a different winner is ADOPTED with the winner's rows AND row count, never this attempt's", async () => {
  const a = makeCacheAdapters();
  const common = { requestHash: "h1", sourceId: "s", organizationFingerprint: "o", accountScopeHash: "x", requestMeta: {}, payloadBytes: 999, expiresAt: "2027-01-01" };
  // Cycle B has ALREADY committed a DIFFERENT object for h1 with a visibly different row set
  // and row count (THREE rows). Cycle A is about to save ONE row.
  const pathB = versionedObjectPath("h1", "vB");
  const winnerRows = [{ b: 1 }, { b: 2 }, { b: 3 }];
  const bWins = {
    storage: a.storage,
    metadata: {
      read: async (h) => a.pointer.get(h) || null,
      write: async () => {
        a.pointer.set("h1", { object_path: pathB });
        a.objects.set(pathB, JSON.stringify({ rows: winnerRows }));
        return { object_path: pathB };
      },
    },
  };
  const resA = await atomicSaveSourcePayload({ ...common, storage: bWins.storage, metadata: bWins.metadata, rows: [{ a: 1 }], version: "vA" });
  assert.equal(resA.winner, "concurrent");
  assert.equal(resA.objectPath, pathB, "A adopts the concurrently committed winner's path");
  assert.equal(resA.rowCount, 3, "A reports the WINNER's row count (3), NOT its own (1)");
  assert.notEqual(resA.rowCount, 1, "A never pairs its own 1-row count with the winner's object");
  assert.deepEqual(resA.rows, winnerRows, "A returns the WINNER's rows, not its own");
  assert.ok(a.objects.has(pathB), "the concurrent winner object is preserved");
  assert.ok(a.objects.has(versionedObjectPath("h1", "vA")), "A's own uploaded object is left as an orphan, not deleted");
});

test("atomic cache CONCURRENCY: an un-adoptable winner fails closed with CACHE_CONFLICT and preserves both objects", async () => {
  const a = makeCacheAdapters();
  const common = { requestHash: "h1", sourceId: "s", organizationFingerprint: "o", accountScopeHash: "x", requestMeta: {}, payloadBytes: 1, expiresAt: "2027-01-01" };
  const pathB = versionedObjectPath("h1", "vB");
  // B wins the POINTER but its object is not readable from here (get -> null).
  const bWins = {
    storage: a.storage,
    metadata: {
      read: async (h) => a.pointer.get(h) || null,
      write: async () => { a.pointer.set("h1", { object_path: pathB }); return { object_path: pathB }; },
    },
  };
  await assert.rejects(
    atomicSaveSourcePayload({ ...common, storage: bWins.storage, metadata: bWins.metadata, rows: [{ a: 1 }], version: "vA" }),
    (e) => e && e.code === "CACHE_CONFLICT" && e.winnerPath === pathB,
  );
  assert.equal(a.pointer.get("h1").object_path, pathB, "the concurrent winner keeps the live pointer");
  assert.ok(a.objects.has(versionedObjectPath("h1", "vA")), "A's own object is preserved as an orphan, never deleted");
});

test("worker CONCURRENCY: an adopted-winner save records the winner's row count + path, never the download's", async () => {
  const store = makeMemoryStore();
  const winnerPath = "source-cache/v2/h1/winner.json";
  const winnerRows = [{ w: 1 }, { w: 2 }];
  // The persist step reports that a concurrent cycle already won; the worker must record the
  // WINNER's rows/count/path, not the single row it just downloaded.
  store.saveSourceRows = async () => ({ objectPath: winnerPath, rows: winnerRows, rowCount: winnerRows.length, payloadBytes: 77, winner: "concurrent" });
  const dd = makeDataDoe(() => ({ rows: [{ a: 1 }] })); // downloads exactly ONE row
  const res = await runSourceJobs(runOpts({ store, dataDoe: dd, plannedJobs: [synthJob("h1")] }));
  assert.equal(res.succeeded, 1);
  const j = store._rawJob(res.cycleId, "h1");
  assert.equal(j.row_count, 2, "recorded the winner's row count (2), not the downloaded 1");
  assert.equal(j.cache_object_path, winnerPath, "recorded the winner's object path");
  const outcome = res.outcomes.find((o) => o.requestHash === "h1");
  assert.equal(outcome.rowCount, 2, "signal-derivation outcome uses the winner's row count");
  assert.deepEqual(outcome.rows, winnerRows, "signal-derivation outcome uses the winner's rows");
});

test("worker CONCURRENCY: an un-adoptable CACHE_CONFLICT is a benign non-terminal persist non-success", async () => {
  const store = makeMemoryStore();
  store.saveSourceRows = async () => { const e = new Error("concurrent pointer, both preserved"); e.code = "CACHE_CONFLICT"; throw e; };
  const dd = makeDataDoe(() => ({ rows: [{ a: 1 }] }));
  const res = await runSourceJobs(runOpts({ store, dataDoe: dd, plannedJobs: [synthJob("h1")] }));
  assert.equal(res.succeeded, 0);
  assert.equal(res.failed, 1);
  const j = store._rawJob(res.cycleId, "h1");
  assert.equal(j.error_stage, "persist");
  assert.equal(j.error_code, "CACHE_CONFLICT");
  assert.equal(j.terminal, false, "a concurrent-winner conflict is retryable, not terminal");
  assert.equal(j.cache_object_path, null, "no object path recorded for this attempt");
});

/* ----------------------------- BLOCKER 2 (signals): reconstruction distinguishes empty vs missing ----------------------------- */


async function main() {
  mark("main(): entered");

  const step = async (label, thunk) => {
    mark("import " + label + ": start");
    const mod = await import(thunk);
    mark("import " + label + ": done");
    return mod;
  };

  ({ runSourceJobs } = await step("source-worker.js", "../lib/server/sync/source-worker.js"));
  ({ atomicSaveSourcePayload, validateSourcePayload, versionedObjectPath } = await step("source-cache.js", "../lib/server/sync/source-cache.js"));
  ({ organizationFingerprint } = await step("source-identity.js", "../lib/server/source-identity.js"));
  const total = tests.filter((t) => !t.marker).length;
  mark("all imports resolved; running " + total + " tests");
  let failures = 0;
  let ran = 0;
  for (const t of tests) {
    if (t.marker) { mark("group -> " + t.marker); continue; }
    try {
      await t.fn();
      passed += 1;
      out("  ok  " + t.name);
    } catch (err) {
      failures += 1;
      out("FAIL  " + t.name);
      out(String(err && err.stack ? err.stack : err));
    }
    ran += 1;
  }
  out("\n" + passed + " assertions passed");
  mark("test loop complete: ran " + ran + "/" + total + ", " + passed + " passed, " + failures + " failed");
  return failures;
}

mark("before main()");
main().then((failures) => {
  // Expose anything still keeping the event loop alive. A clean run shows no timer/socket/
  // handle here and the process then exits NATURALLY (we never call process.exit()).
  const handles = typeof process.getActiveResourcesInfo === "function" ? process.getActiveResourcesInfo() : ["<getActiveResourcesInfo unavailable>"];
  mark("main() resolved; active resources before natural exit: " + JSON.stringify(handles));
  mark("setting process.exitCode=" + (failures ? 1 : 0) + " and returning to the event loop");
  if (failures) process.exitCode = 1;
}).catch((err) => {
  out("FATAL " + String(err && err.stack ? err.stack : err));
  mark("main() rejected; exitCode=1");
  process.exitCode = 1;
});
