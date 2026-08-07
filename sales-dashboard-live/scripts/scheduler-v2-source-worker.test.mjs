// Scheduler v2 Phase 1c -- source-worker / signals / atomic-cache tests.
//
// Fresh file (replaces the earlier scheduler-v2-worker.test.mjs, which became an
// unreadable checkout artifact on the review machine). Kept separate from
// scheduler-v2.test.mjs so NEITHER file uses top-level await (an async module body can
// hang `node --check` / piped runs on some setups). The async suite runs inside main();
// the module body has no top-level await, no timer, and no open handle. All I/O is
// in-memory. Every byte is 7-bit ASCII with LF line endings (see the repo .gitattributes)
// so the file reads cleanly with a plain file read on every platform.
//
// Run with: npm run test:scheduler-v2

import assert from "node:assert/strict";
import { runSourceJobs, classifyFetchError } from "../lib/server/sync/source-worker.js";
import {
  salesMoversProbeSignal,
  keywordWeeklySignal,
  optimizerSqpSignal,
  adsCurrencySignal,
  deriveSignalsFromOutcomes,
} from "../lib/server/sync/source-signals.js";
import {
  runStagedSourceCycle,
  reconstructSignals,
  plannedSourceJob,
  makeDataDoeAdapter,
} from "../lib/server/sync/source-sync-driver.js";
import { atomicSaveSourcePayload, validateSourcePayload, versionedObjectPath } from "../lib/server/sync/source-cache.js";
import { reportSourceRequestHashes, salesMoversWindows } from "../lib/server/sync/report-source-contracts.js";
import { organizationFingerprint } from "../lib/server/source-identity.js";

let passed = 0;
const tests = [];
const atest = (name, fn) => tests.push({ name, fn });

// A DataDoe execution-deadline error (our withDataDoeDeadline), distinct from a genuine
// DataDoe processing timeout.
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

/* ============================= one-attempt / resume / checkpoint ============================= */

atest("single-winner attempt claim; a worker that LOSES it creates no export", async () => {
  const guard = makeMemoryStore();
  const cid = guard.openCycle({ bucket: "us", cycleDate: "2026-08-07" });
  guard.upsertSourceJob({ cycleId: cid, bucket: "us", ...synthJob("h1") });
  assert.equal(guard.claimExportAttempt(cid, "h1"), true);
  assert.equal(guard.claimExportAttempt(cid, "h1"), false);
  const store = makeMemoryStore();
  store.forceLoseClaim.add("h1");
  const dd = makeDataDoe(() => ({ rows: [{ a: 1 }] }));
  const res = await runSourceJobs(runOpts({ store, dataDoe: dd, plannedJobs: [synthJob("h1")] }));
  assert.equal(dd.totalCreates(), 0);
  assert.equal(res.skipped, 1);
});

atest("repeated invocations never repeat create; completed jobs skipped on resume", async () => {
  const store = makeMemoryStore();
  const dd = makeDataDoe(() => ({ rows: [{ a: 1 }] }));
  const opts = runOpts({ store, dataDoe: dd, plannedJobs: [synthJob("h1"), synthJob("h2")] });
  const r1 = await runSourceJobs(opts);
  assert.equal(r1.succeeded, 2);
  assert.equal(r1.drained, true);
  const r2 = await runSourceJobs(opts);
  assert.equal(r2.processed, 0);
  assert.equal(dd.createCount("h1"), 1);
  assert.equal(dd.createCount("h2"), 1);
});

atest("checkpoint: maxJobs then a later invocation drains the rest; each created once", async () => {
  const store = makeMemoryStore();
  const dd = makeDataDoe(() => ({ rows: [{ a: 1 }] }));
  const jobs = ["h1", "h2", "h3", "h4", "h5"].map((h) => synthJob(h));
  const base = runOpts({ store, dataDoe: dd, plannedJobs: jobs, maxJobs: 2 });
  const r1 = await runSourceJobs(base);
  assert.equal(r1.processed, 2);
  assert.equal(r1.drained, false);
  await runSourceJobs(base);
  const r3 = await runSourceJobs(base);
  assert.equal(r3.drained, true);
  assert.equal(dd.totalCreates(), 5);
});

atest("worker exits safely near its deadline without creating any export", async () => {
  const store = makeMemoryStore();
  const dd = makeDataDoe(() => ({ rows: [{ a: 1 }] }));
  const res = await runSourceJobs(runOpts({
    store, dataDoe: dd, plannedJobs: [synthJob("h1"), synthJob("h2")],
    clock: () => 100000, deadlineMs: 1000, reserveMs: 3000,
  }));
  assert.equal(res.deadlineReached, true);
  assert.equal(res.processed, 0);
  assert.equal(dd.totalCreates(), 0);
});

/* ============================= resumable state machine ============================= */

atest("export_id persisted immediately; a resumed attempted job polls/downloads with no re-create", async () => {
  const store = makeMemoryStore();
  const dd = makeDataDoe(() => ({ rows: [{ a: 1 }] }));
  const cid = store.openCycle({ bucket: "us", cycleDate: "2026-08-07" });
  store.upsertSourceJob({ cycleId: cid, bucket: "us", ...synthJob("h1") });
  store.claimExportAttempt(cid, "h1");
  store.recordExportCreated({ cycleId: cid, requestHash: "h1", exportId: "exp_pre" });
  const res = await runSourceJobs(runOpts({ store, dataDoe: dd, plannedJobs: [synthJob("h1")] }));
  assert.equal(dd.createCount("h1"), 0);
  assert.equal(dd.calls.poll.h1, 1);
  assert.equal(dd.calls.download.h1, 1);
  assert.equal(res.succeeded, 1);
});

atest("an attempted job with NO export_id is an explicit CREATE_INTERRUPTED failure", async () => {
  const store = makeMemoryStore();
  const dd = makeDataDoe(() => ({ rows: [{ a: 1 }] }));
  const cid = store.openCycle({ bucket: "us", cycleDate: "2026-08-07" });
  store.upsertSourceJob({ cycleId: cid, bucket: "us", ...synthJob("h1") });
  store.claimExportAttempt(cid, "h1");
  const res = await runSourceJobs(runOpts({ store, dataDoe: dd, plannedJobs: [synthJob("h1")] }));
  assert.equal(res.failed, 1);
  assert.equal(dd.totalCreates(), 0);
  assert.equal(store._rawJob(cid, "h1").error_code, "CREATE_INTERRUPTED");
});

atest("distinct safe error stages: create-export / poll / download / validate / persist", async () => {
  const cases = [
    { hash: "e_create", stage: "create-export", behavior: (j, s) => (s === "create" ? { throw: new Error("DataDoe export creation failed (500).") } : null) },
    { hash: "e_poll", stage: "poll", behavior: (j, s) => (s === "poll" ? { throw: new Error("DataDoe export failed to process (FAILED).") } : null) },
    { hash: "e_dl", stage: "download", behavior: (j, s) => (s === "download" ? { throw: new Error("DataDoe export download failed (404)") } : null) },
    { hash: "e_val", stage: "validate", behavior: (j, s) => (s === "download" ? { rows: { not: "array" } } : null) },
  ];
  for (const c of cases) {
    const store = makeMemoryStore();
    const dd = makeDataDoe(c.behavior);
    const res = await runSourceJobs(runOpts({ store, dataDoe: dd, plannedJobs: [synthJob(c.hash)] }));
    assert.equal(res.failed, 1, c.stage);
    assert.equal(store._rawJob(res.cycleId, c.hash).error_stage, c.stage);
  }
  const store = makeMemoryStore();
  store.failSaveFor.add("e_persist");
  const dd = makeDataDoe(() => ({ rows: [{ a: 1 }] }));
  const res = await runSourceJobs(runOpts({ store, dataDoe: dd, plannedJobs: [synthJob("e_persist")] }));
  assert.equal(store._rawJob(res.cycleId, "e_persist").error_stage, "persist");
  assert.equal(store._cache.has("e_persist"), false);
});

/* ============================= failure isolation / last-known-good ============================= */

atest("a failed source is not retried in-cycle; a NEW cycle attempts it again", async () => {
  const store = makeMemoryStore();
  const dd = makeDataDoe(() => ({ throw: new Error("DataDoe export creation failed (500).") }));
  const p = [synthJob("h1")];
  await runSourceJobs(runOpts({ store, dataDoe: dd, plannedJobs: p }));
  const r = await runSourceJobs(runOpts({ store, dataDoe: dd, plannedJobs: p }));
  assert.equal(r.processed, 0);
  assert.equal(dd.createCount("h1"), 1);
  await runSourceJobs(runOpts({ store, dataDoe: dd, plannedJobs: p, cycleDate: "2026-08-08" }));
  assert.equal(dd.createCount("h1"), 2);
});

atest("strict row-cap data is never saved (validate / TRUNCATED)", async () => {
  const store = makeMemoryStore();
  const dd = makeDataDoe(() => ({ rows: [{}, {}, {}] }));
  const res = await runSourceJobs(runOpts({
    store, dataDoe: dd, plannedJobs: [synthJob("h1", { strict: true, limit: 3 })],
  }));
  assert.equal(res.failed, 1);
  assert.equal(store._cache.has("h1"), false);
  assert.equal(store._rawJob(res.cycleId, "h1").error_code, "TRUNCATED");
});

atest("no secret value appears in a recorded error or the progress output", async () => {
  const store = makeMemoryStore();
  const leaky = new Error("DataDoe export creation failed (403): apikey=SECRET-KEY-123 token=abc");
  const dd = makeDataDoe(() => ({ throw: leaky }));
  const res = await runSourceJobs(runOpts({ store, dataDoe: dd, plannedJobs: [synthJob("h1")] }));
  const j = store._rawJob(res.cycleId, "h1");
  assert.ok(!/SECRET-KEY-123|token=abc/.test(j.error_message));
  assert.equal(j.error_message, "DataDoe returned HTTP 403 for this source.");
  assert.ok(!/SECRET-KEY-123|token=abc/.test(JSON.stringify(res)));
});

/* ============================= production row shape + batching + isolation ============================= */

atest("production PostgREST row reaches the fetcher with exact source/columns/ids/window/limit/options", async () => {
  const store = makeMemoryStore();
  const win = {
    "brand-sales:order-lines": [{ from: "2025-01-01", to: "2025-06-30" }],
    "brand-sales:catalog": [{ from: "2025-01-01", to: "2025-06-30" }],
  };
  const resolved = reportSourceRequestHashes({ reportKey: "brand-sales", apiKey: "K", ids: ["A1", "A2"], windowsByRequestKey: win });
  const planned = resolved.map((r) => plannedSourceJob("brand-sales", r, "us", "primary"));
  const oli = resolved.find((r) => r.requestKey === "brand-sales:order-lines");
  const seen = [];
  const dd = {
    createCount: () => 0, totalCreates: () => 0,
    create: async (job) => { seen.push(job); return { exportId: "e" }; },
    poll: async () => {},
    download: async () => [{ ok: 1 }],
  };
  const res = await runSourceJobs(runOpts({ store, dataDoe: dd, plannedJobs: planned }));
  assert.equal(res.succeeded, planned.length);
  const j = seen.find((x) => x.requestHash === oli.requestHash);
  assert.ok(j);
  assert.equal(j.requestKey, "brand-sales:order-lines");
  assert.deepEqual(j.fetchParams.sellerOrVendorIds, oli.sellerOrVendorIds);
  assert.equal(j.fetchParams.from, "2025-01-01");
  assert.equal(j.fetchParams.to, "2025-06-30");
  assert.equal(j.fetchParams.limit, oli.limit);
  assert.ok(Array.isArray(j.fetchParams.columns) && j.fetchParams.columns.length);
  assert.deepEqual(j.fetchParams.options, oli.options);
});

atest("five-ID chunks remain separate jobs, each created once; primary/dd-secondary never mix", async () => {
  const store = makeMemoryStore();
  const ids = Array.from({ length: 6 }, (_, i) => `A${i}`);
  const win = {
    "brand-sales:order-lines": [{ from: "2025-01-01", to: "2025-06-30" }],
    "brand-sales:catalog": [{ from: "2025-01-01", to: "2025-06-30" }],
  };
  const primary = reportSourceRequestHashes({ reportKey: "brand-sales", apiKey: "PRIMARY_ORG_KEY", ids, windowsByRequestKey: win })
    .map((r) => plannedSourceJob("brand-sales", r, "us", "primary"));
  const secondary = reportSourceRequestHashes({ reportKey: "brand-sales", apiKey: "DD_SECONDARY_ORG_KEY", ids: ["A1"], windowsByRequestKey: win })
    .map((r) => plannedSourceJob("brand-sales", r, "us", "dd-secondary"));
  const oli = primary.filter((j) => j.requestKey === "brand-sales:order-lines");
  assert.equal(oli.length, 2);
  const pHashes = new Set(primary.map((j) => j.requestHash));
  for (const j of secondary) assert.ok(!pHashes.has(j.requestHash));
  const dd = makeDataDoe(() => ({ rows: [{ a: 1 }] }));
  await runSourceJobs(runOpts({ store, dataDoe: dd, plannedJobs: [...primary, ...secondary] }));
  for (const j of oli) assert.equal(dd.createCount(j.requestHash), 1);
});

/* ============================= BLOCKER 1: fail-closed organization routing ============================= */

atest("plannedSourceJob requires an explicit primary/dd-secondary connection id", async () => {
  const resolved = reportSourceRequestHashes({
    reportKey: "brand-sales", apiKey: "K", ids: ["A1"],
    windowsByRequestKey: { "brand-sales:order-lines": [{ from: "2025-01-01", to: "2025-06-30" }], "brand-sales:catalog": [{ from: "2025-01-01", to: "2025-06-30" }] },
  })[0];
  assert.throws(() => plannedSourceJob("brand-sales", resolved, "us"), /explicit connectionId/);
  assert.throws(() => plannedSourceJob("brand-sales", resolved, "us", "tertiary"), /explicit connectionId/);
  assert.throws(() => plannedSourceJob("brand-sales", { ...resolved, organizationFingerprint: "" }, "us", "primary"), /organizationFingerprint/);
  assert.doesNotThrow(() => plannedSourceJob("brand-sales", resolved, "us", "dd-secondary"));
});

atest("makeDataDoeAdapter refuses missing/unknown/mismatched routing and a missing secondary key (zero DataDoe calls)", async () => {
  const primaryKey = "PRIMARY_ORG_KEY";
  const secondaryKey = "DD_SECONDARY_ORG_KEY";
  const pFp = organizationFingerprint(primaryKey);
  const sFp = organizationFingerprint(secondaryKey);
  const adapter = makeDataDoeAdapter([
    { id: "primary", apiKey: primaryKey, organizationFingerprint: pFp },
    { id: "dd-secondary", apiKey: secondaryKey, organizationFingerprint: sFp },
  ]);
  const base = { sourceId: "src", fetchParams: { columns: ["c"], sellerOrVendorIds: ["A1"], from: null, to: null, limit: 10, options: {} } };
  await assert.rejects(adapter.create({ ...base }), /missing\/invalid connection id/); // missing id
  await assert.rejects(adapter.create({ ...base, connection_id: "tertiary" }), /missing\/invalid connection id/); // unknown id
  await assert.rejects(adapter.create({ ...base, connection_id: "primary" }), /missing its organization fingerprint/); // missing fingerprint
  await assert.rejects(adapter.create({ ...base, connection_id: "dd-secondary", organizationFingerprint: pFp }), /does not match connection/); // mismatch
  await assert.rejects(adapter.poll({ connection_id: "dd-secondary", organizationFingerprint: pFp }, "exp"), /does not match connection/);
  // A secondary job with no configured secondary key must NOT fall back to primary.
  const primaryOnly = makeDataDoeAdapter([{ id: "primary", apiKey: primaryKey, organizationFingerprint: pFp }]);
  await assert.rejects(primaryOnly.create({ ...base, connection_id: "dd-secondary", organizationFingerprint: sFp }), /No configured DataDoe connection for "dd-secondary"/);
});

/* ============================= BLOCKER 3: deadline during poll/download is resumable ============================= */

atest("execution-deadline during poll defers (resumable); a fresh invocation later succeeds with one create", async () => {
  const store = makeMemoryStore();
  let pollCalls = 0;
  const behavior = (job, stage) => {
    if (stage === "poll") {
      pollCalls += 1;
      if (pollCalls === 1) return { throw: deadlineError() }; // hit our deadline on the first poll
    }
    return { rows: [{ a: 1 }] };
  };
  // Invocation 1: create once, persist export_id, then poll hits the deadline -> deferred.
  const dd1 = makeDataDoe(behavior);
  const r1 = await runSourceJobs(runOpts({ store, dataDoe: dd1, plannedJobs: [synthJob("h1")] }));
  assert.equal(dd1.createCount("h1"), 1);
  assert.equal(r1.deferred, 1);
  assert.equal(r1.failed, 0, "a deadline defer is NOT a failure");
  const j = store._rawJob(r1.cycleId, "h1");
  assert.equal(j.fetch_status, "attempted"); // resumable
  assert.equal(j.export_id, "exp_h1");
  // Invocation 2: a completely fresh worker call. It resumes poll/download, no new create.
  const dd2 = makeDataDoe(behavior);
  const r2 = await runSourceJobs(runOpts({ store, dataDoe: dd2, plannedJobs: [synthJob("h1")] }));
  assert.equal(dd2.createCount("h1"), 0, "resume must not create a second export");
  assert.equal(r2.succeeded, 1);
  assert.equal(store._rawJob(r2.cycleId, "h1").fetch_status, "succeeded");
});

atest("a genuine DataDoe processing timeout/failure during poll stays FAILED (not resumable)", async () => {
  const store = makeMemoryStore();
  const dd = makeDataDoe((job, stage) => (stage === "poll" ? { throw: new Error("DataDoe export timed out while processing.") } : { rows: [{ a: 1 }] }));
  const res = await runSourceJobs(runOpts({ store, dataDoe: dd, plannedJobs: [synthJob("h1")] }));
  assert.equal(res.failed, 1);
  assert.equal(res.deferred, 0);
  assert.equal(store._rawJob(res.cycleId, "h1").fetch_status, "failed");
});

/* ============================= BLOCKER 4/2: atomic cache under ambiguity + concurrency ============================= */

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

atest("atomic cache: DB commit succeeded but client response threw -> new object kept, old pruned", async () => {
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

atest("atomic cache: an unconfirmed pointer write preserves the old readable payload and keeps the orphan", async () => {
  const a = makeCacheAdapters();
  const common = { requestHash: "h1", sourceId: "s", organizationFingerprint: "o", accountScopeHash: "x", requestMeta: {}, payloadBytes: 1, expiresAt: "2027-01-01" };
  const p1 = await atomicSaveSourcePayload({ ...common, storage: a.storage, metadata: a.metadata, rows: [{ v: 1 }], version: "v1" });
  a.writeMode = "throw-no-commit"; // pointer never moves
  await assert.rejects(atomicSaveSourcePayload({ ...common, storage: a.storage, metadata: a.metadata, rows: [{ v: 2 }], version: "v2" }), /not positively confirmed/);
  assert.equal(a.pointer.get("h1").object_path, p1.objectPath, "pointer still at the old good object");
  assert.deepEqual((await a.storage.get(p1.objectPath)).rows, [{ v: 1 }], "old payload still readable");
  assert.ok(a.objects.has(versionedObjectPath("h1", "v2")), "the new object is left as a harmless orphan, not deleted");
});

atest("atomic cache CONCURRENCY: a different winner is ADOPTED with the winner's rows AND row count, never this attempt's", async () => {
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

atest("atomic cache CONCURRENCY: an un-adoptable winner fails closed with CACHE_CONFLICT and preserves both objects", async () => {
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

atest("worker CONCURRENCY: an adopted-winner save records the winner's row count + path, never the download's", async () => {
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

atest("worker CONCURRENCY: an un-adoptable CACHE_CONFLICT is a benign non-terminal persist non-success", async () => {
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

/* ============================= BLOCKER 2 (signals): reconstruction distinguishes empty vs missing ============================= */

const optResolvePlan = (signals) => {
  const win = { "listing-optimizer:sqp-weekly": [{ from: "2025-05-14", to: "2025-08-06" }] };
  if (signals["listing-optimizer:sqp-weekly"] && signals["listing-optimizer:sqp-weekly"].status === "success") {
    win["listing-optimizer:catalog"] = [{ from: null, to: null }];
  }
  const resolved = reportSourceRequestHashes({ reportKey: "listing-optimizer", apiKey: "K", ids: ["A1"], windowsByRequestKey: win, dependencySignals: signals }) || [];
  return { sourceJobs: resolved.map((r) => plannedSourceJob("listing-optimizer", r, "us", "primary")) };
};

// Prepare a cycle where the SQP job is marked succeeded, with a configurable cached payload.
async function seedOptimizerCycle(loadReturns) {
  const store = makeMemoryStore();
  const cid = store.openCycle({ bucket: "us", cycleDate: "2026-08-07" });
  const sqp = (await optResolvePlan({})).sourceJobs.find((j) => j.requestKey === "listing-optimizer:sqp-weekly");
  store.upsertSourceJob({ cycleId: cid, bucket: "us", ...sqp });
  const j = store._rawJob(cid, sqp.requestHash);
  j.fetch_status = "succeeded"; // the DB says success...
  store.loadReturns = loadReturns; // ...but the cached payload varies
  return { store, cid, sqp };
}

atest("reconstructSignals: a genuine empty success ({rows:[]}) activates downstream; missing/malformed does NOT", async () => {
  // 1) valid empty success -> optimizer SQP validated -> catalog activates.
  {
    const { store, cid } = await seedOptimizerCycle(() => ({ rows: [] }));
    const signals = await reconstructSignals({ store, cycleId: cid, resolvePlan: optResolvePlan });
    assert.deepEqual(signals["listing-optimizer:sqp-weekly"], { status: "success", validated: true });
  }
  // 2) cache MISS (null) -> unavailable -> NOT validated.
  {
    const { store, cid } = await seedOptimizerCycle(() => null);
    const s = await reconstructSignals({ store, cycleId: cid, resolvePlan: optResolvePlan });
    assert.equal(s["listing-optimizer:sqp-weekly"].validated, false);
  }
  // 3) malformed payload (rows not an array) -> unavailable -> NOT validated.
  {
    const { store, cid } = await seedOptimizerCycle(() => ({ rows: "oops" }));
    const s = await reconstructSignals({ store, cycleId: cid, resolvePlan: optResolvePlan });
    assert.equal(s["listing-optimizer:sqp-weekly"].validated, false);
  }
  // 4) read error (throws) -> unavailable -> NOT validated.
  {
    const { store, cid } = await seedOptimizerCycle(() => { throw new Error("storage read failed (500)"); });
    const s = await reconstructSignals({ store, cycleId: cid, resolvePlan: optResolvePlan });
    assert.equal(s["listing-optimizer:sqp-weekly"].validated, false);
  }
});

atest("reconstructSignals: a failed/unavailable ads read yields no scheduling currency (not count 0)", async () => {
  const store = makeMemoryStore();
  const cid = store.openCycle({ bucket: "us", cycleDate: "2026-08-07" });
  const s = await reconstructSignals({ store, cycleId: cid, resolvePlan: async () => ({ sourceJobs: [] }), adsRowsProvider: async () => { throw new Error("ads read failed"); } });
  assert.equal(s["ppc-performance:ads-currency"].validated, false);
  assert.equal(s["ppc-performance:ads-currency"].currencyCount, null);
});

/* ============================= signals (pure) ============================= */

atest("dependency signals are derived ONLY from validated saved results", async () => {
  const ok = deriveSignalsFromOutcomes([{ requestKey: "sales-movers:sales-latest-probe", status: "success", validated: true, rows: [{ date: "2025-07-30", units_sum: 4 }] }]);
  assert.deepEqual(ok["sales-movers:sales-latest-probe"], { status: "success", validated: true, latestReportedDate: "2025-07-30" });
  const failed = deriveSignalsFromOutcomes([{ requestKey: "sales-movers:sales-latest-probe", status: "failed", validated: false }]);
  assert.deepEqual(failed["sales-movers:sales-latest-probe"], { status: "failed", validated: false, latestReportedDate: null });
  // a deferred primary produces NO signal this round
  assert.deepEqual(deriveSignalsFromOutcomes([{ requestKey: "sales-movers:sales-latest-probe", status: "deferred", validated: false }]), {});
  assert.deepEqual(deriveSignalsFromOutcomes([{ requestKey: "sales-movers:catalog", status: "success", validated: true, rows: [] }]), {});
  assert.deepEqual(keywordWeeklySignal({ status: "success", validated: true, rows: [{ date: "2025-07-01" }, { date: "2025-07-08" }, { date: "2025-07-01" }] }), { status: "success", validated: true, distinctPeriods: 2 });
  assert.deepEqual(optimizerSqpSignal({ status: "success", validated: true, rows: [] }), { status: "success", validated: true });
  assert.deepEqual(adsCurrencySignal([{ currency: "USD" }, { currency: "USD" }, { currency: "CAD" }, { currency: "" }]), { status: "success", validated: true, currencyCount: 2 });
  assert.deepEqual(salesMoversProbeSignal({ status: "success", validated: true, rows: [{ date: "2025-07-30", units_sum: 2 }, { date: "2025-07-28", units_sum: 9 }] }), { status: "success", validated: true, latestReportedDate: "2025-07-30" });
});

/* ============================= staged flow through the real resolver ============================= */

const smFullWin = (date) => {
  const w = salesMoversWindows(date);
  return {
    "sales-movers:sales-latest-probe": [{ from: "2025-07-12", to: "2025-08-06" }],
    "sales-movers:traffic": [w.recent, w.prior],
    "sales-movers:ads": [w.recent, w.prior],
    "sales-movers:inventory": [{ from: "2025-07-27", to: "2025-08-06" }],
    "sales-movers:catalog": [{ from: null, to: null }],
  };
};
const smResolvePlan = (signals) => {
  const sig = signals["sales-movers:sales-latest-probe"];
  const win = sig && sig.status === "success" && sig.validated && sig.latestReportedDate
    ? smFullWin(sig.latestReportedDate)
    : { "sales-movers:sales-latest-probe": [{ from: "2025-07-12", to: "2025-08-06" }] };
  const resolved = reportSourceRequestHashes({ reportKey: "sales-movers", apiKey: "K", ids: ["A1"], windowsByRequestKey: win, dependencySignals: signals }) || [];
  return { sourceJobs: resolved.map((r) => plannedSourceJob("sales-movers", r, "us", "primary")) };
};
const smDataDoe = () => makeDataDoe((job) => ((job.requestKey ?? job.request_key) === "sales-movers:sales-latest-probe"
  ? { rows: [{ date: "2025-07-28", units_sum: 5 }, { date: "2025-07-30", units_sum: 3 }] }
  : { rows: [{ a: 1 }] }));

atest("Sales Movers downstream jobs use the validated probe date (single invocation)", async () => {
  const store = makeMemoryStore();
  const rollup = await runStagedSourceCycle(runOpts({ store, dataDoe: smDataDoe(), resolvePlan: smResolvePlan }));
  assert.equal(rollup.signals["sales-movers:sales-latest-probe"].latestReportedDate, "2025-07-30");
  const expected = reportSourceRequestHashes({ reportKey: "sales-movers", apiKey: "K", ids: ["A1"], windowsByRequestKey: smFullWin("2025-07-30"), dependencySignals: { "sales-movers:sales-latest-probe": { status: "success", validated: true, latestReportedDate: "2025-07-30" } } });
  const stored = new Set(store.listSourceJobs(rollup.cycleId).map((j) => j.request_hash));
  for (const e of expected) assert.ok(stored.has(e.requestHash));
  assert.equal(stored.size, expected.length);
});

atest("staged signals survive a brand-new invocation: reconstructed from persisted job+payload, no repeated primary create", async () => {
  const store = makeMemoryStore();
  const dd1 = smDataDoe();
  const r1 = await runStagedSourceCycle(runOpts({ store, dataDoe: dd1, resolvePlan: smResolvePlan, maxJobs: 1 }));
  const probeHash = store.listSourceJobs(r1.cycleId).find((j) => j.fetch_status === "succeeded").request_hash;
  const dd2 = smDataDoe();
  const r2 = await runStagedSourceCycle(runOpts({ store, dataDoe: dd2, resolvePlan: smResolvePlan }));
  assert.equal(r2.signals["sales-movers:sales-latest-probe"].latestReportedDate, "2025-07-30");
  assert.equal(dd2.createCount(probeHash), 0);
  const expected = reportSourceRequestHashes({ reportKey: "sales-movers", apiKey: "K", ids: ["A1"], windowsByRequestKey: smFullWin("2025-07-30"), dependencySignals: { "sales-movers:sales-latest-probe": { status: "success", validated: true, latestReportedDate: "2025-07-30" } } });
  const stored = new Set(store.listSourceJobs(r2.cycleId).map((j) => j.request_hash));
  for (const e of expected) assert.ok(stored.has(e.requestHash));
});

atest("Listing Optimizer catalog waits for a validated SQP success", async () => {
  const s1 = makeMemoryStore();
  const f1 = makeDataDoe((job) => ((job.requestKey ?? job.request_key) === "listing-optimizer:sqp-weekly" ? { throw: new Error("source is disabled for this organization") } : { rows: [{ a: 1 }] }));
  const r1 = await runStagedSourceCycle(runOpts({ store: s1, dataDoe: f1, resolvePlan: optResolvePlan }));
  assert.deepEqual(sources(s1, r1.cycleId), ["sqp-weekly"]);
  const s2 = makeMemoryStore();
  const r2 = await runStagedSourceCycle(runOpts({ store: s2, dataDoe: makeDataDoe(() => ({ rows: [] })), resolvePlan: optResolvePlan }));
  const set2 = new Set(sources(s2, r2.cycleId));
  assert.ok(set2.has("sqp-weekly") && set2.has("product-catalog"));
});

atest("Keyword monthly fallback follows the distinct-period policy; PPC total-sales respects Ads currency", async () => {
  const kwResolve = (signals) => {
    const win = { "keyword-rank:sqp-weekly": [{ from: "2025-07-01", to: "2025-08-06" }], "keyword-rank:catalog": [{ from: "2025-07-01", to: "2025-08-06" }] };
    if (signals["keyword-rank:sqp-weekly"] && signals["keyword-rank:sqp-weekly"].validated) {
      win["keyword-rank:sqp-monthly"] = [{ from: "2025-05-01", to: "2025-07-31" }];
    }
    const resolved = reportSourceRequestHashes({ reportKey: "keyword-rank", apiKey: "K", ids: ["A1"], windowsByRequestKey: win, fallbackSignals: signals }) || [];
    return { sourceJobs: resolved.map((r) => plannedSourceJob("keyword-rank", r, "us", "primary")) };
  };
  const ks = makeMemoryStore();
  const kdd = makeDataDoe((job) => ((job.requestKey ?? job.request_key) === "keyword-rank:sqp-weekly" ? { rows: [{ date: "2025-07-07" }, { date: "2025-07-14" }] } : { rows: [{ a: 1 }] }));
  const kr = await runStagedSourceCycle(runOpts({ store: ks, dataDoe: kdd, resolvePlan: kwResolve }));
  assert.equal(kr.signals["keyword-rank:sqp-weekly"].distinctPeriods, 2);
  assert.ok(new Set(sources(ks, kr.cycleId)).has("sqp-weekly"));
  assert.ok(ks.listSourceJobs(kr.cycleId).length >= 3);

  const ppcResolve = (signals) => {
    const win = { "ppc-performance:catalog": [{ from: null, to: null }] };
    const cc = signals["ppc-performance:ads-currency"] && signals["ppc-performance:ads-currency"].currencyCount;
    if (cc != null && cc <= 1) win["ppc-performance:total-sales"] = [{ from: "2025-07-08", to: "2025-08-06" }];
    const resolved = reportSourceRequestHashes({ reportKey: "ppc-performance", apiKey: "K", ids: ["A1"], windowsByRequestKey: win, dependencySignals: signals }) || [];
    return { sourceJobs: resolved.map((r) => plannedSourceJob("ppc-performance", r, "us", "primary")) };
  };
  const single = makeMemoryStore();
  const r1 = await runStagedSourceCycle(runOpts({ store: single, dataDoe: makeDataDoe(() => ({ rows: [{ a: 1 }] })), resolvePlan: ppcResolve, adsRowsProvider: async () => [{ currency: "USD" }, { currency: "USD" }] }));
  assert.ok(new Set(sources(single, r1.cycleId)).has("sales-traffic-asin-date"));
  const multi = makeMemoryStore();
  const r2 = await runStagedSourceCycle(runOpts({ store: multi, dataDoe: makeDataDoe(() => ({ rows: [{ a: 1 }] })), resolvePlan: ppcResolve, adsRowsProvider: async () => [{ currency: "USD" }, { currency: "CAD" }] }));
  assert.deepEqual(sources(multi, r2.cycleId), ["product-catalog"]);
});

atest("classifyFetchError maps to SAFE codes/terminality and never echoes the raw error", async () => {
  assert.deepEqual(classifyFetchError(new Error("source is disabled for this organization"), "create-export"), { stage: "create-export", code: "SOURCE_DISABLED", message: "Source is disabled for this organization.", terminal: true });
  assert.equal(classifyFetchError(new Error("DataDoe export creation failed (402): tokens")).code, "HTTP_402");
  assert.equal(classifyFetchError(new Error("DataDoe export creation failed (402): tokens")).terminal, true);
  assert.equal(classifyFetchError(new Error("DataDoe export creation failed (503): busy")).terminal, false);
  assert.equal(classifyFetchError(new Error("DataDoe export timed out while processing.")).code, "TIMEOUT");
});

/* ---- run the async suite with NO top-level await; deterministic exit ---- */
async function main() {
  let failures = 0;
  for (const t of tests) {
    try {
      await t.fn();
      passed += 1;
      console.log("  ok  " + t.name);
    } catch (err) {
      failures += 1;
      console.error("FAIL  " + t.name);
      console.error(err && err.message ? err.message : err);
    }
  }
  console.log("\n" + passed + " assertions passed");
  return failures;
}

main().then((failures) => {
  if (failures) process.exitCode = 1;
}).catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
