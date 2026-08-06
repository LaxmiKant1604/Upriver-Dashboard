// Scheduler v2 Phase 1c — source-worker / signals / atomic-cache tests.
//
// SPLIT OUT of scheduler-v2.test.mjs so neither file uses TOP-LEVEL AWAIT: an ESM module
// with top-level await is an async module, which makes `node --check` and piped runs hang
// in some environments. Here the async suite runs inside main(); the module body has NO
// top-level await, no timer, no open handle, no AsyncLocalStorage scope left open — so
// `node --check` and `node …` both exit normally. All I/O is in-memory (no network/DB).
//
// Run with: npm run test:scheduler-v2  (which runs this file after the sync one).

import assert from "node:assert/strict";
import { runSourceJobs, classifyFetchError } from "../lib/server/sync/source-worker.js";
import {
  salesMoversProbeSignal, keywordWeeklySignal, optimizerSqpSignal,
  adsCurrencySignal, deriveSignalsFromOutcomes,
} from "../lib/server/sync/source-signals.js";
import { runStagedSourceCycle, plannedSourceJob, makeDataDoeAdapter } from "../lib/server/sync/source-sync-driver.js";
import { atomicSaveSourcePayload, validateSourcePayload } from "../lib/server/sync/source-cache.js";
import { reportSourceRequestHashes, salesMoversWindows } from "../lib/server/sync/report-source-contracts.js";
import { organizationFingerprint } from "../lib/server/source-identity.js";

let passed = 0;
const tests = [];
const atest = (name, fn) => tests.push({ name, fn });

// ---- in-memory store (models the SQL RPCs) exposing ONLY the production PostgREST row
// shape from getSyncSourceJobs; plan-only fields (requestKey/fetchParams) live in memory.
function makeMemoryStore() {
  const cycles = new Map();
  const jobsByCycle = new Map();
  const cache = new Map(); // request_hash -> { rows, object_path }
  let seq = 0;
  const findCycle = (id) => [...cycles.values()].find((c) => c.id === id) || null;
  // The EXACT columns getSyncSourceJobs selects — nothing richer.
  const PROD_COLUMNS = ["id", "request_hash", "source_id", "source_key", "connection_id", "fetch_status", "attempted_at", "create_export_count", "export_id", "terminal", "error_stage", "error_code", "row_count"];
  const prodRow = (j) => Object.fromEntries(PROD_COLUMNS.map((c) => [c, j[c] ?? null]));
  return {
    _cache: cache,
    failSaveFor: new Set(),
    forceLoseClaim: new Set(),
    openCycle({ bucket, cycleDate }) {
      const key = `${bucket}|${cycleDate}`;
      if (!cycles.has(key)) { const id = `cyc_${++seq}`; cycles.set(key, { id, bucket, cycle_date: cycleDate, status: "pending", started_at: null, source_total: 0, source_succeeded: 0, source_failed: 0 }); jobsByCycle.set(id, new Map()); }
      return cycles.get(key).id;
    },
    claimCycle(cycleId) { const c = findCycle(cycleId); if (c && c.status === "pending") { c.status = "running"; c.started_at = "t"; return true; } return false; },
    getCycle(cycleId) { return findCycle(cycleId); },
    upsertSourceJob(job) {
      const m = jobsByCycle.get(job.cycleId);
      if (!m.has(job.requestHash)) {
        m.set(job.requestHash, {
          id: `job_${m.size + 1}`, request_hash: job.requestHash, source_id: job.sourceId, source_key: job.sourceKey,
          connection_id: job.connectionId, organization_fingerprint: job.organizationFingerprint,
          account_scope_hash: job.accountScopeHash, request_meta: job.requestMeta, bucket: job.bucket,
          fetch_status: "pending", attempted_at: null, create_export_count: 0, export_id: null,
          terminal: false, error_stage: null, error_code: null, error_message: null, row_count: null,
          cache_object_path: null, last_good_fetched_at: null,
        });
      }
    },
    // Returns the PRODUCTION row shape only (proves the worker never relies on richer fields).
    listSourceJobs(cycleId) { return [...(jobsByCycle.get(cycleId)?.values() || [])].map(prodRow); },
    _rawJob(cycleId, hash) { return jobsByCycle.get(cycleId)?.get(hash); },
    claimExportAttempt(cycleId, requestHash) {
      const j = jobsByCycle.get(cycleId)?.get(requestHash);
      if (this.forceLoseClaim.has(requestHash)) { if (j) { j.attempted_at = "t"; j.create_export_count = 1; j.fetch_status = "attempted"; } return false; }
      if (j && j.attempted_at === null) { j.attempted_at = "t"; j.create_export_count += 1; j.fetch_status = "attempted"; return true; }
      return false;
    },
    recordExportCreated({ cycleId, requestHash, exportId }) { const j = jobsByCycle.get(cycleId).get(requestHash); j.export_id = exportId; },
    loadSourceRows(requestHash) { const e = cache.get(requestHash); return e ? { rows: e.rows } : null; },
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
      Object.assign(j, { fetch_status: "succeeded", export_id: exportId, row_count: rowCount, cache_object_path: cacheObjectPath, last_good_fetched_at: "t", error_stage: null, error_code: null, error_message: null });
    },
    recordSourceFailure({ cycleId, requestHash, stage, code, message, terminal, rowCount, exportId }) {
      const j = jobsByCycle.get(cycleId).get(requestHash);
      Object.assign(j, { fetch_status: "failed", error_stage: stage, error_code: code, error_message: message, terminal: !!terminal });
      if (rowCount != null) j.row_count = rowCount;
      if (exportId != null) j.export_id = exportId;
    },
    updateCycleCounts(cycleId, c) { const cy = findCycle(cycleId); Object.assign(cy, { source_total: c.sourceTotal, source_succeeded: c.sourceSucceeded, source_failed: c.sourceFailed }); },
  };
}

// staged DataDoe fake: behavior(job, stage) -> undefined (ok) | {throw} | {exportId} | {rows}
function makeDataDoe(behavior) {
  const calls = { create: {}, poll: {}, download: {} };
  const bump = (s, h) => { calls[s][h] = (calls[s][h] || 0) + 1; };
  const dd = {
    calls,
    createCount: (h) => calls.create[h] || 0,
    totalCreates: () => Object.values(calls.create).reduce((a, b) => a + b, 0),
    create: async (job) => { const h = job.requestHash; bump("create", h); const b = behavior ? behavior(job, "create") : null; if (b?.throw) throw b.throw; return { exportId: b?.exportId ?? `exp_${h}`, completed: false }; },
    poll: async (job) => { bump("poll", job.requestHash); const b = behavior ? behavior(job, "poll") : null; if (b?.throw) throw b.throw; },
    download: async (job) => { bump("download", job.requestHash); const b = behavior ? behavior(job, "download") : null; if (b?.throw) throw b.throw; return b && "rows" in b ? b.rows : [{ ok: 1 }]; },
  };
  return dd;
}

const synthJob = (hash, extra = {}) => ({
  requestHash: hash, requestKey: extra.requestKey || `rk:${hash}`, sourceId: "src", sourceKey: "sk",
  connectionId: extra.connectionId || "primary", organizationFingerprint: extra.org || "orgA",
  accountScopeHash: "ash", requestMeta: extra.requestMeta || {}, strict: extra.strict || false, limit: extra.limit || 50000,
  fetchParams: extra.fetchParams || { columns: ["c"], sellerOrVendorIds: ["A1"], from: null, to: null, limit: 50000, options: {} },
});
const keysOf = (jobs) => [...new Set(jobs.map((j) => j.request_key ?? j.requestKey))].sort();
const runOpts = (over) => ({ bucket: "us", cycleDate: "2026-08-07", ...over });

/* ===================================== one-attempt / resume ===================================== */

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
  assert.equal(res.succeeded, 0);
});

atest("repeated invocations never repeat create; completed jobs skipped on resume", async () => {
  const store = makeMemoryStore();
  const dd = makeDataDoe(() => ({ rows: [{ a: 1 }] }));
  const opts = runOpts({ store, dataDoe: dd, plannedJobs: [synthJob("h1"), synthJob("h2")] });
  const r1 = await runSourceJobs(opts); assert.equal(r1.succeeded, 2); assert.equal(r1.drained, true);
  const r2 = await runSourceJobs(opts); assert.equal(r2.processed, 0);
  assert.equal(dd.createCount("h1"), 1); assert.equal(dd.createCount("h2"), 1);
});

atest("checkpoint: maxJobs then a later invocation drains the rest; each created once", async () => {
  const store = makeMemoryStore();
  const dd = makeDataDoe(() => ({ rows: [{ a: 1 }] }));
  const base = runOpts({ store, dataDoe: dd, plannedJobs: ["h1", "h2", "h3", "h4", "h5"].map((h) => synthJob(h)), maxJobs: 2 });
  const r1 = await runSourceJobs(base); assert.equal(r1.processed, 2); assert.equal(r1.drained, false);
  await runSourceJobs(base);
  const r3 = await runSourceJobs(base); assert.equal(r3.drained, true);
  assert.equal(dd.totalCreates(), 5);
});

atest("worker exits safely near its deadline without creating any export", async () => {
  const store = makeMemoryStore();
  const dd = makeDataDoe(() => ({ rows: [{ a: 1 }] }));
  const res = await runSourceJobs(runOpts({ store, dataDoe: dd, plannedJobs: [synthJob("h1"), synthJob("h2")], clock: () => 100_000, deadlineMs: 1_000, reserveMs: 3_000 }));
  assert.equal(res.deadlineReached, true);
  assert.equal(res.processed, 0);
  assert.equal(dd.totalCreates(), 0);
});

/* ===================================== FIX 3: resumable state machine ===================================== */

atest("export_id is persisted immediately; a resumed attempted job polls/downloads WITHOUT a second create", async () => {
  const store = makeMemoryStore();
  const dd = makeDataDoe(() => ({ rows: [{ a: 1 }] }));
  const cid = store.openCycle({ bucket: "us", cycleDate: "2026-08-07" });
  // simulate a crash AFTER create: the store has attempted + export_id, but no success.
  store.upsertSourceJob({ cycleId: cid, bucket: "us", ...synthJob("h1") });
  store.claimExportAttempt(cid, "h1");
  store.recordExportCreated({ cycleId: cid, requestHash: "h1", exportId: "exp_pre" });
  const res = await runSourceJobs(runOpts({ store, dataDoe: dd, plannedJobs: [synthJob("h1")] }));
  assert.equal(dd.createCount("h1"), 0, "resume must NOT create a second export");
  assert.equal(dd.calls.poll.h1, 1); assert.equal(dd.calls.download.h1, 1);
  assert.equal(res.succeeded, 1);
  assert.equal(store._rawJob(cid, "h1").export_id, "exp_pre");
});

atest("an attempted job with NO export_id is an explicit CREATE_INTERRUPTED failure, never silently skipped", async () => {
  const store = makeMemoryStore();
  const dd = makeDataDoe(() => ({ rows: [{ a: 1 }] }));
  const cid = store.openCycle({ bucket: "us", cycleDate: "2026-08-07" });
  store.upsertSourceJob({ cycleId: cid, bucket: "us", ...synthJob("h1") });
  store.claimExportAttempt(cid, "h1"); // attempted, but recordExportCreated never ran (interrupted create)
  const res = await runSourceJobs(runOpts({ store, dataDoe: dd, plannedJobs: [synthJob("h1")] }));
  assert.equal(res.failed, 1);
  assert.equal(dd.totalCreates(), 0);
  const j = store._rawJob(cid, "h1");
  assert.equal(j.error_stage, "create-export"); assert.equal(j.error_code, "CREATE_INTERRUPTED");
});

atest("crash AFTER source save but before final status resumes to success without re-create", async () => {
  const store = makeMemoryStore();
  const dd = makeDataDoe(() => ({ rows: [{ a: 1 }] }));
  const cid = store.openCycle({ bucket: "us", cycleDate: "2026-08-07" });
  store.upsertSourceJob({ cycleId: cid, bucket: "us", ...synthJob("h1") });
  store.claimExportAttempt(cid, "h1");
  store.recordExportCreated({ cycleId: cid, requestHash: "h1", exportId: "exp_pre" });
  store.saveSourceRows({ job: { request_hash: "h1" }, rows: [{ a: 1 }], version: "v0" }); // save happened, status not yet updated
  const res = await runSourceJobs(runOpts({ store, dataDoe: dd, plannedJobs: [synthJob("h1")] }));
  assert.equal(dd.createCount("h1"), 0);
  assert.equal(res.succeeded, 1);
  assert.equal(store._rawJob(cid, "h1").fetch_status, "succeeded");
});

atest("distinct safe error stages are recorded for create/poll/download/validate/persist", async () => {
  const cases = [
    { hash: "e_create", behavior: (j, s) => (s === "create" ? { throw: new Error("DataDoe export creation failed (500).") } : null), stage: "create-export" },
    { hash: "e_poll", behavior: (j, s) => (s === "poll" ? { throw: new Error("DataDoe export failed to process (FAILED).") } : null), stage: "poll" },
    { hash: "e_dl", behavior: (j, s) => (s === "download" ? { throw: new Error("DataDoe export download failed (404)") } : null), stage: "download" },
    { hash: "e_val", behavior: (j, s) => (s === "download" ? { rows: { not: "an array" } } : null), stage: "validate" },
  ];
  for (const c of cases) {
    const store = makeMemoryStore();
    const dd = makeDataDoe(c.behavior);
    const res = await runSourceJobs(runOpts({ store, dataDoe: dd, plannedJobs: [synthJob(c.hash)] }));
    assert.equal(res.failed, 1, c.stage);
    assert.equal(store._rawJob(res.cycleId, c.hash).error_stage, c.stage, `${c.hash} => ${c.stage}`);
  }
  // persist failure is its own stage and never overwrites last-known-good
  const store = makeMemoryStore(); store.failSaveFor.add("e_persist");
  const dd = makeDataDoe(() => ({ rows: [{ a: 1 }] }));
  const res = await runSourceJobs(runOpts({ store, dataDoe: dd, plannedJobs: [synthJob("e_persist")] }));
  assert.equal(store._rawJob(res.cycleId, "e_persist").error_stage, "persist");
  assert.equal(store._cache.has("e_persist"), false);
});

/* ===================================== failure isolation / last-known-good ===================================== */

atest("a failed source is not retried in-cycle; a NEW cycle attempts it again", async () => {
  const store = makeMemoryStore();
  const dd = makeDataDoe(() => ({ throw: new Error("DataDoe export creation failed (500).") }));
  const p = [synthJob("h1")];
  await runSourceJobs(runOpts({ store, dataDoe: dd, plannedJobs: p }));
  const r1b = await runSourceJobs(runOpts({ store, dataDoe: dd, plannedJobs: p }));
  assert.equal(r1b.processed, 0);
  assert.equal(dd.createCount("h1"), 1);
  await runSourceJobs(runOpts({ store, dataDoe: dd, plannedJobs: p, cycleDate: "2026-08-08" }));
  assert.equal(dd.createCount("h1"), 2);
});

atest("strict row-cap data is never saved (validate/TRUNCATED)", async () => {
  const store = makeMemoryStore();
  const dd = makeDataDoe(() => ({ rows: [{}, {}, {}] }));
  const res = await runSourceJobs(runOpts({ store, dataDoe: dd, plannedJobs: [synthJob("h1", { strict: true, limit: 3 })] }));
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

/* ===================================== FIX 1: production row shape ===================================== */

atest("production PostgREST row (getSyncSourceJobs columns) still reaches the fetcher with exact params", async () => {
  const store = makeMemoryStore();
  const win = { "brand-sales:order-lines": [{ from: "2025-01-01", to: "2025-06-30" }], "brand-sales:catalog": [{ from: "2025-01-01", to: "2025-06-30" }] };
  const resolved = reportSourceRequestHashes({ reportKey: "brand-sales", apiKey: "K", ids: ["A1", "A2"], windowsByRequestKey: win });
  const planned = resolved.map((r) => plannedSourceJob("brand-sales", r, "us"));
  const oli = resolved.find((r) => r.requestKey === "brand-sales:order-lines");
  const seen = [];
  const dd = { createCount: () => 0, totalCreates: () => 0, create: async (job) => { seen.push(job); return { exportId: "e" }; }, poll: async () => {}, download: async () => [{ ok: 1 }] };
  // The store returns ONLY prod columns (no requestKey/fetchParams); the merge must restore them.
  const res = await runSourceJobs(runOpts({ store, dataDoe: dd, plannedJobs: planned }));
  assert.equal(res.succeeded, planned.length);
  const oliJob = seen.find((j) => j.requestHash === oli.requestHash);
  assert.ok(oliJob, "the order-lines job reached the fetcher");
  assert.equal(oliJob.requestKey, "brand-sales:order-lines"); // preserved for signals
  assert.deepEqual(oliJob.fetchParams.sellerOrVendorIds, oli.sellerOrVendorIds);
  assert.equal(oliJob.fetchParams.from, "2025-01-01");
  assert.equal(oliJob.fetchParams.to, "2025-06-30");
  assert.equal(oliJob.fetchParams.limit, oli.limit);
  assert.ok(Array.isArray(oliJob.fetchParams.columns) && oliJob.fetchParams.columns.length);
  assert.deepEqual(oliJob.fetchParams.options, oli.options);
});

atest("five-ID chunks remain separate jobs, each created once; primary/dd-secondary never mix", async () => {
  const store = makeMemoryStore();
  const ids = Array.from({ length: 6 }, (_, i) => `A${i}`);
  const win = { "brand-sales:order-lines": [{ from: "2025-01-01", to: "2025-06-30" }], "brand-sales:catalog": [{ from: "2025-01-01", to: "2025-06-30" }] };
  const primary = reportSourceRequestHashes({ reportKey: "brand-sales", apiKey: "PRIMARY_ORG_KEY", ids, windowsByRequestKey: win }).map((r) => plannedSourceJob("brand-sales", r, "us"));
  const secondary = reportSourceRequestHashes({ reportKey: "brand-sales", apiKey: "DD_SECONDARY_ORG_KEY", ids: ["A1"], windowsByRequestKey: win }).map((r) => plannedSourceJob("brand-sales", { ...r, connectionId: "dd-secondary" }, "us"));
  const oli = primary.filter((j) => j.requestKey === "brand-sales:order-lines");
  assert.equal(oli.length, 2); // 6 ids -> 2 chunks
  const pHashes = new Set(primary.map((j) => j.requestHash));
  for (const j of secondary) assert.ok(!pHashes.has(j.requestHash));
  const dd = makeDataDoe(() => ({ rows: [{ a: 1 }] }));
  await runSourceJobs(runOpts({ store, dataDoe: dd, plannedJobs: [...primary, ...secondary] }));
  for (const j of oli) assert.equal(dd.createCount(j.requestHash), 1);
});

/* ===================================== FIX 2: fail-closed org routing ===================================== */

atest("makeDataDoeAdapter refuses missing/unknown/mismatched routing BEFORE any DataDoe call; a secondary job never uses the primary key", async () => {
  const primaryKey = "PRIMARY_ORG_KEY"; const secondaryKey = "DD_SECONDARY_ORG_KEY";
  const primaryFp = organizationFingerprint(primaryKey);
  const secondaryFp = organizationFingerprint(secondaryKey);
  const adapter = makeDataDoeAdapter([
    { id: "primary", apiKey: primaryKey, organizationFingerprint: primaryFp },
    { id: "dd-secondary", apiKey: secondaryKey, organizationFingerprint: secondaryFp },
  ]);
  const base = { sourceId: "src", fetchParams: { columns: ["c"], sellerOrVendorIds: ["A1"], from: null, to: null, limit: 10, options: {} } };
  // create() throws in resolveConnection, BEFORE createExport — so zero DataDoe requests.
  await assert.rejects(adapter.create({ ...base }), /missing\/invalid connection id/);                                   // missing
  await assert.rejects(adapter.create({ ...base, connection_id: "tertiary" }), /missing\/invalid connection id/);        // unknown
  await assert.rejects(adapter.create({ ...base, connection_id: "dd-secondary", organizationFingerprint: primaryFp }), /does not match connection/); // mismatched
  // poll/download route by the same guard, so a mismatched secondary job cannot reach the primary key either.
  await assert.rejects(adapter.poll({ connection_id: "dd-secondary", organizationFingerprint: primaryFp }, "exp"), /does not match connection/);
  // An adapter missing the secondary connection must NOT fall back to primary — it throws.
  const primaryOnly = makeDataDoeAdapter([{ id: "primary", apiKey: primaryKey, organizationFingerprint: primaryFp }]);
  await assert.rejects(primaryOnly.create({ ...base, connection_id: "dd-secondary", organizationFingerprint: secondaryFp }), /No configured DataDoe connection for "dd-secondary"/);
});

/* ===================================== FIX 6: cumulative counts ===================================== */

atest("cumulative cycle counts never decrease across invocations", async () => {
  const store = makeMemoryStore();
  const dd = makeDataDoe(() => ({ rows: [{ a: 1 }] }));
  const r1 = await runSourceJobs(runOpts({ store, dataDoe: dd, plannedJobs: [synthJob("h1"), synthJob("h2")], maxJobs: 1 }));
  assert.equal(r1.counts.sourceSucceeded, 1);
  // add MORE staged jobs on the next invocation; totals grow, succeeded never drops.
  const r2 = await runSourceJobs(runOpts({ store, dataDoe: dd, plannedJobs: [synthJob("h1"), synthJob("h2"), synthJob("h3")] }));
  assert.ok(r2.counts.sourceTotal >= 3);
  assert.ok(r2.counts.sourceSucceeded >= r1.counts.sourceSucceeded);
  assert.equal(r2.counts.sourceSucceeded, 3);
});

/* ===================================== FIX 5: atomic source cache ===================================== */

function makeFakeCacheAdapters() {
  const objects = new Map(); // path -> serialized
  const pointer = new Map(); // hash -> { object_path }
  return {
    objects, pointer, failWrite: false,
    storage: { put: async (p, s) => { objects.set(p, s); }, get: async (p) => (objects.has(p) ? JSON.parse(objects.get(p)) : null), delete: async (p) => { objects.delete(p); } },
    metadata: { read: async (h) => pointer.get(h) || null, write: async (e) => { if (adapters.failWrite) throw new Error("pointer write failed (503)"); pointer.set(e.requestHash, { object_path: e.objectPath }); return { object_path: e.objectPath }; } },
  };
}
let adapters;
atest("atomic cache: metadata failure preserves the old payload; success requires a non-empty path; payload must be an array", async () => {
  adapters = makeFakeCacheAdapters();
  const common = { requestHash: "h1", sourceId: "s", organizationFingerprint: "o", accountScopeHash: "a", requestMeta: {}, payloadBytes: 10, expiresAt: "2027-01-01" };
  // 1) first good save
  const p1 = await atomicSaveSourcePayload({ ...common, storage: adapters.storage, metadata: adapters.metadata, rows: [{ v: 1 }], version: "v1" });
  assert.ok(p1);
  assert.deepEqual((await adapters.storage.get(p1)).rows, [{ v: 1 }]);
  // 2) second save where the pointer write FAILS -> old object + pointer preserved, new orphan removed
  adapters.failWrite = true;
  await assert.rejects(atomicSaveSourcePayload({ ...common, storage: adapters.storage, metadata: adapters.metadata, rows: [{ v: 2 }], version: "v2" }), /pointer write failed/);
  adapters.failWrite = false;
  assert.equal(adapters.pointer.get("h1").object_path, p1, "pointer still points at the old good object");
  assert.deepEqual((await adapters.storage.get(p1)).rows, [{ v: 1 }], "old payload still readable");
  assert.equal(adapters.objects.has("source-cache/v2/h1/v2.json"), false, "new orphan deleted");
  // 3) malformed payload is refused; empty array is valid
  await assert.rejects(atomicSaveSourcePayload({ ...common, storage: adapters.storage, metadata: adapters.metadata, rows: { not: "array" }, version: "v3" }), /not an array/);
  assert.throws(() => validateSourcePayload(null), /not an array/);
  const pEmpty = await atomicSaveSourcePayload({ ...common, storage: adapters.storage, metadata: adapters.metadata, rows: [], version: "v4" });
  assert.ok(pEmpty);
});

/* ===================================== signals (pure) ===================================== */

atest("dependency signals are derived ONLY from validated saved results", async () => {
  assert.deepEqual(deriveSignalsFromOutcomes([{ requestKey: "sales-movers:sales-latest-probe", status: "success", validated: true, rows: [{ date: "2025-07-30", units_sum: 4 }] }])["sales-movers:sales-latest-probe"], { status: "success", validated: true, latestReportedDate: "2025-07-30" });
  assert.deepEqual(deriveSignalsFromOutcomes([{ requestKey: "sales-movers:sales-latest-probe", status: "failed", validated: false }])["sales-movers:sales-latest-probe"], { status: "failed", validated: false, latestReportedDate: null });
  assert.deepEqual(deriveSignalsFromOutcomes([{ requestKey: "sales-movers:catalog", status: "success", validated: true, rows: [] }]), {});
  assert.deepEqual(keywordWeeklySignal({ status: "success", validated: true, rows: [{ date: "2025-07-01" }, { date: "2025-07-08" }, { date: "2025-07-01" }] }), { status: "success", validated: true, distinctPeriods: 2 });
  assert.deepEqual(optimizerSqpSignal({ status: "success", validated: true, rows: [] }), { status: "success", validated: true });
  assert.deepEqual(adsCurrencySignal([{ currency: "USD" }, { currency: "USD" }, { currency: "CAD" }, { currency: "" }]), { status: "success", validated: true, currencyCount: 2 });
});

/* ===================================== FIX 4: staged signals survive a brand-new invocation ===================================== */

const smFullWin = (date) => {
  const w = salesMoversWindows(date);
  return { "sales-movers:sales-latest-probe": [{ from: "2025-07-12", to: "2025-08-06" }], "sales-movers:traffic": [w.recent, w.prior], "sales-movers:ads": [w.recent, w.prior], "sales-movers:inventory": [{ from: "2025-07-27", to: "2025-08-06" }], "sales-movers:catalog": [{ from: null, to: null }] };
};
const smResolvePlan = (signals) => {
  const sig = signals["sales-movers:sales-latest-probe"];
  const win = sig && sig.status === "success" && sig.validated && sig.latestReportedDate ? smFullWin(sig.latestReportedDate) : { "sales-movers:sales-latest-probe": [{ from: "2025-07-12", to: "2025-08-06" }] };
  const resolved = reportSourceRequestHashes({ reportKey: "sales-movers", apiKey: "K", ids: ["A1"], windowsByRequestKey: win, dependencySignals: signals }) || [];
  return { sourceJobs: resolved.map((r) => plannedSourceJob("sales-movers", r, "us")) };
};
const smDataDoe = () => makeDataDoe((job) => ((job.requestKey ?? job.request_key) === "sales-movers:sales-latest-probe" ? { rows: [{ date: "2025-07-28", units_sum: 5 }, { date: "2025-07-30", units_sum: 3 }] } : { rows: [{ a: 1 }] }));

atest("Sales Movers downstream jobs use the validated probe date (single driver invocation)", async () => {
  const store = makeMemoryStore();
  const dd = smDataDoe();
  const rollup = await runStagedSourceCycle(runOpts({ store, dataDoe: dd, resolvePlan: smResolvePlan }));
  assert.equal(rollup.signals["sales-movers:sales-latest-probe"].latestReportedDate, "2025-07-30");
  const expected = reportSourceRequestHashes({ reportKey: "sales-movers", apiKey: "K", ids: ["A1"], windowsByRequestKey: smFullWin("2025-07-30"), dependencySignals: { "sales-movers:sales-latest-probe": { status: "success", validated: true, latestReportedDate: "2025-07-30" } } });
  const stored = new Set(store.listSourceJobs(rollup.cycleId).map((j) => j.request_hash));
  for (const e of expected) assert.ok(stored.has(e.requestHash));
  assert.equal(stored.size, expected.length);
});

atest("staged signals SURVIVE a brand-new invocation: reconstructed from persisted job+payload, no repeated primary create", async () => {
  const store = makeMemoryStore();
  // Invocation 1: process ONLY the probe (maxJobs=1), then stop.
  const dd1 = smDataDoe();
  const r1 = await runStagedSourceCycle(runOpts({ store, dataDoe: dd1, resolvePlan: smResolvePlan, maxJobs: 1 }));
  assert.equal(dd1.createCount(store.listSourceJobs(r1.cycleId).find((j) => j.source_key === "sales-traffic-asin-date" && j.fetch_status === "succeeded")?.request_hash), 1);
  const probeHash = store.listSourceJobs(r1.cycleId).find((j) => j.fetch_status === "succeeded").request_hash;
  // Invocation 2: a BRAND-NEW driver call with NO in-memory signals. It must reconstruct
  // the probe signal from the persisted success + payload and plan downstream.
  const dd2 = smDataDoe();
  const r2 = await runStagedSourceCycle(runOpts({ store, dataDoe: dd2, resolvePlan: smResolvePlan }));
  assert.equal(r2.signals["sales-movers:sales-latest-probe"].latestReportedDate, "2025-07-30", "signal reconstructed from persisted state");
  assert.equal(dd2.createCount(probeHash), 0, "the probe export is NOT repeated");
  const expected = reportSourceRequestHashes({ reportKey: "sales-movers", apiKey: "K", ids: ["A1"], windowsByRequestKey: smFullWin("2025-07-30"), dependencySignals: { "sales-movers:sales-latest-probe": { status: "success", validated: true, latestReportedDate: "2025-07-30" } } });
  const stored = new Set(store.listSourceJobs(r2.cycleId).map((j) => j.request_hash));
  for (const e of expected) assert.ok(stored.has(e.requestHash), `${e.requestKey} planned`);
});

atest("a FAILED primary does not activate downstream on a fresh invocation", async () => {
  const store = makeMemoryStore();
  const failProbe = () => makeDataDoe((job) => ((job.requestKey ?? job.request_key) === "sales-movers:sales-latest-probe" ? { throw: new Error("DataDoe export creation failed (500).") } : { rows: [{ a: 1 }] }));
  await runStagedSourceCycle(runOpts({ store, dataDoe: failProbe(), resolvePlan: smResolvePlan }));
  const r2 = await runStagedSourceCycle(runOpts({ store, dataDoe: failProbe(), resolvePlan: smResolvePlan }));
  const keys = new Set(store.listSourceJobs(r2.cycleId).map((j) => j.source_key));
  // only the probe source ever planned (sales-traffic used by probe); no downstream ads/profit/inventory catalog beyond probe
  assert.ok(!r2.signals["sales-movers:sales-latest-probe"] || r2.signals["sales-movers:sales-latest-probe"].status !== "success");
  assert.deepEqual([...store.listSourceJobs(r2.cycleId)].filter((j) => j.fetch_status === "succeeded").length, 0);
  void keys;
});

/* ===================================== staged flow: optimizer / keyword / ppc ===================================== */

atest("Listing Optimizer catalog waits for a validated SQP success", async () => {
  const optResolve = (signals) => {
    const win = { "listing-optimizer:sqp-weekly": [{ from: "2025-05-14", to: "2025-08-06" }] };
    if (signals["listing-optimizer:sqp-weekly"]?.status === "success") win["listing-optimizer:catalog"] = [{ from: null, to: null }];
    const resolved = reportSourceRequestHashes({ reportKey: "listing-optimizer", apiKey: "K", ids: ["A1"], windowsByRequestKey: win, dependencySignals: signals }) || [];
    return { sourceJobs: resolved.map((r) => plannedSourceJob("listing-optimizer", r, "us")) };
  };
  const s1 = makeMemoryStore();
  const f1 = makeDataDoe((job) => ((job.requestKey ?? job.request_key) === "listing-optimizer:sqp-weekly" ? { throw: new Error("source is disabled for this organization") } : { rows: [{ a: 1 }] }));
  const r1 = await runStagedSourceCycle(runOpts({ store: s1, dataDoe: f1, resolvePlan: optResolve }));
  assert.deepEqual(s1.listSourceJobs(r1.cycleId).map((j) => j.source_key).sort(), ["sqp-weekly"]); // disabled SQP => catalog never planned
  const s2 = makeMemoryStore();
  const f2 = makeDataDoe(() => ({ rows: [] }));
  const r2 = await runStagedSourceCycle(runOpts({ store: s2, dataDoe: f2, resolvePlan: optResolve }));
  const sources2 = new Set(s2.listSourceJobs(r2.cycleId).map((j) => j.source_key));
  assert.ok(sources2.has("sqp-weekly") && sources2.has("product-catalog"));
});

atest("Keyword monthly fallback follows the distinct-period policy; PPC total-sales respects Ads currency", async () => {
  // Keyword: 2 distinct weekly periods (<4) -> monthly fallback scheduled.
  const kwResolve = (signals) => {
    const win = { "keyword-rank:sqp-weekly": [{ from: "2025-07-01", to: "2025-08-06" }], "keyword-rank:catalog": [{ from: "2025-07-01", to: "2025-08-06" }] };
    if (signals["keyword-rank:sqp-weekly"]?.validated) win["keyword-rank:sqp-monthly"] = [{ from: "2025-05-01", to: "2025-07-31" }];
    const resolved = reportSourceRequestHashes({ reportKey: "keyword-rank", apiKey: "K", ids: ["A1"], windowsByRequestKey: win, fallbackSignals: signals }) || [];
    return { sourceJobs: resolved.map((r) => plannedSourceJob("keyword-rank", r, "us")) };
  };
  const kstore = makeMemoryStore();
  const kdd = makeDataDoe((job) => ((job.requestKey ?? job.request_key) === "keyword-rank:sqp-weekly" ? { rows: [{ date: "2025-07-07" }, { date: "2025-07-14" }] } : { rows: [{ a: 1 }] }));
  const kr = await runStagedSourceCycle(runOpts({ store: kstore, dataDoe: kdd, resolvePlan: kwResolve }));
  assert.equal(kr.signals["keyword-rank:sqp-weekly"].distinctPeriods, 2);
  assert.ok(new Set(kstore.listSourceJobs(kr.cycleId).map((j) => j.source_key)).has("sqp-weekly"));
  assert.ok(kstore.listSourceJobs(kr.cycleId).length >= 3, "monthly fallback added a job");

  // PPC: currencyCount from persisted ads rows (via adsRowsProvider); <=1 runs total-sales, >1 skips.
  const ppcResolve = (signals) => {
    const win = { "ppc-performance:catalog": [{ from: null, to: null }] };
    if ((signals["ppc-performance:ads-currency"]?.currencyCount ?? 99) <= 1) win["ppc-performance:total-sales"] = [{ from: "2025-07-08", to: "2025-08-06" }];
    const resolved = reportSourceRequestHashes({ reportKey: "ppc-performance", apiKey: "K", ids: ["A1"], windowsByRequestKey: win, dependencySignals: signals }) || [];
    return { sourceJobs: resolved.map((r) => plannedSourceJob("ppc-performance", r, "us")) };
  };
  const single = makeMemoryStore();
  const r1 = await runStagedSourceCycle(runOpts({ store: single, dataDoe: makeDataDoe(() => ({ rows: [{ a: 1 }] })), resolvePlan: ppcResolve, adsRowsProvider: async () => [{ currency: "USD" }, { currency: "USD" }] }));
  assert.ok(new Set(single.listSourceJobs(r1.cycleId).map((j) => j.source_key)).has("sales-traffic-asin-date"));
  const multi = makeMemoryStore();
  const r2 = await runStagedSourceCycle(runOpts({ store: multi, dataDoe: makeDataDoe(() => ({ rows: [{ a: 1 }] })), resolvePlan: ppcResolve, adsRowsProvider: async () => [{ currency: "USD" }, { currency: "CAD" }] }));
  assert.deepEqual(multi.listSourceJobs(r2.cycleId).map((j) => j.source_key), ["product-catalog"]);
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
    try { await t.fn(); passed += 1; console.log("  ok  " + t.name); }
    catch (err) { failures += 1; console.error("FAIL  " + t.name); console.error(err && err.message ? err.message : err); }
  }
  console.log("\n" + passed + " assertions passed");
  return failures;
}

main().then((failures) => { if (failures) process.exitCode = 1; }).catch((err) => { console.error(err); process.exitCode = 1; });
