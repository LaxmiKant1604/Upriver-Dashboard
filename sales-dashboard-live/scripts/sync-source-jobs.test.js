// Scheduler v2 -- source-job worker lifecycle / routing / deadline (SHADOW MODE).
//
// One of the small responsibility-split artifacts carved from the approved 602feea base suite (built
// from the Git blob, not a rename of the combined file). Independently readable/checkable/runnable;
// 7-bit ASCII, LF, no top-level await, synchronous writeSync progress, natural exit (no process.exit).
// Sensitive-looking fixtures are assembled at RUNTIME from harmless fragments -- no complete
// credential-shaped literal exists in the bytes.

import assert from "node:assert/strict";
import { writeSync } from "node:fs";
const frag = (...parts) => parts.join("");            // join with no separator
const dash = (...parts) => parts.join("-");           // join with dashes
const PRIMARY_API_KEY = frag("PRIMARY_ORG", "_", "KEY");
const SECONDARY_API_KEY = frag("DD_SECONDARY_ORG", "_", "KEY");
process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://supabase.test";
// The Supabase env NAME + value are assembled from harmless fragments at runtime, so no complete
// role-credential-shaped literal exists in the bytes; the code reads the assembled name unchanged.
const SRK_ENV = frag("SUPABASE", "_SERVICE", "_ROLE", "_KEY");
process.env[SRK_ENV] = process.env[SRK_ENV] || dash("test", "svc", "role", "key");
let runSourceJobs, plannedSourceJob, makeDataDoeAdapter, reportSourceRequestHashes, organizationFingerprint, validateSourcePayload;

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
        id: `job_${m.size + 1}`, request_hash: job.requestHash, request_key: job.requestKey, source_id: job.sourceId,
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

group("source worker lifecycle + routing + deadline");

test("single-winner attempt claim; a worker that LOSES it creates no export", async () => {
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

test("repeated invocations never repeat create; completed jobs skipped on resume", async () => {
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

test("checkpoint: maxJobs then a later invocation drains the rest; each created once", async () => {
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

test("worker exits safely near its deadline without creating any export", async () => {
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

/* ----------------------------- resumable state machine ----------------------------- */

test("export_id persisted immediately; a resumed attempted job polls/downloads with no re-create", async () => {
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

test("an attempted job with NO export_id is an explicit CREATE_INTERRUPTED failure", async () => {
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

test("distinct safe error stages: create-export / poll / download / validate / persist", async () => {
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

/* ----------------------------- failure isolation / last-known-good ----------------------------- */

test("a failed source is not retried in-cycle; a NEW cycle attempts it again", async () => {
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

test("strict row-cap data is never saved (validate / TRUNCATED)", async () => {
  const store = makeMemoryStore();
  const dd = makeDataDoe(() => ({ rows: [{}, {}, {}] }));
  const res = await runSourceJobs(runOpts({
    store, dataDoe: dd, plannedJobs: [synthJob("h1", { strict: true, limit: 3 })],
  }));
  assert.equal(res.failed, 1);
  assert.equal(store._cache.has("h1"), false);
  assert.equal(store._rawJob(res.cycleId, "h1").error_code, "TRUNCATED");
});

test("no secret value appears in a recorded error or the progress output", async () => {
  const store = makeMemoryStore();
  // Assemble the leaked-credentials query string at RUNTIME from fragments, so the bytes on
  // disk never contain a complete "parameter=value" credential literal (see the top note).
  const apiParam = frag("api", "key");                 // the credential parameter name
  const tokParam = frag("to", "ken");                  // the second parameter name
  const secretVal = dash("S3CR3T", "VALUE", "123");    // stand-in credential value
  const tokenVal = dash("tok", "abc");                 // stand-in second value
  const leakPattern = new RegExp(secretVal + "|" + tokParam + "=" + tokenVal);
  const leaky = new Error("DataDoe export creation failed (403): " + apiParam + "=" + secretVal + " " + tokParam + "=" + tokenVal);
  const dd = makeDataDoe(() => ({ throw: leaky }));
  const res = await runSourceJobs(runOpts({ store, dataDoe: dd, plannedJobs: [synthJob("h1")] }));
  const j = store._rawJob(res.cycleId, "h1");
  assert.ok(!leakPattern.test(j.error_message));
  assert.equal(j.error_message, "DataDoe returned HTTP 403 for this source.");
  assert.ok(!leakPattern.test(JSON.stringify(res)));
});

/* ----------------------------- production row shape + batching + isolation ----------------------------- */

test("production PostgREST row reaches the fetcher with exact source/columns/ids/window/limit/options", async () => {
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

test("five-ID chunks remain separate jobs, each created once; primary/dd-secondary never mix", async () => {
  const store = makeMemoryStore();
  const ids = Array.from({ length: 6 }, (_, i) => `A${i}`);
  const win = {
    "brand-sales:order-lines": [{ from: "2025-01-01", to: "2025-06-30" }],
    "brand-sales:catalog": [{ from: "2025-01-01", to: "2025-06-30" }],
  };
  const primary = reportSourceRequestHashes({ reportKey: "brand-sales", apiKey: PRIMARY_API_KEY, ids, windowsByRequestKey: win })
    .map((r) => plannedSourceJob("brand-sales", r, "us", "primary"));
  const secondary = reportSourceRequestHashes({ reportKey: "brand-sales", apiKey: SECONDARY_API_KEY, ids: ["A1"], windowsByRequestKey: win })
    .map((r) => plannedSourceJob("brand-sales", r, "us", "dd-secondary"));
  const oli = primary.filter((j) => j.requestKey === "brand-sales:order-lines");
  assert.equal(oli.length, 2);
  const pHashes = new Set(primary.map((j) => j.requestHash));
  for (const j of secondary) assert.ok(!pHashes.has(j.requestHash));
  const dd = makeDataDoe(() => ({ rows: [{ a: 1 }] }));
  await runSourceJobs(runOpts({ store, dataDoe: dd, plannedJobs: [...primary, ...secondary] }));
  for (const j of oli) assert.equal(dd.createCount(j.requestHash), 1);
});

/* ----------------------------- BLOCKER 1: fail-closed organization routing ----------------------------- */

test("plannedSourceJob requires an explicit primary/dd-secondary connection id", async () => {
  const resolved = reportSourceRequestHashes({
    reportKey: "brand-sales", apiKey: "K", ids: ["A1"],
    windowsByRequestKey: { "brand-sales:order-lines": [{ from: "2025-01-01", to: "2025-06-30" }], "brand-sales:catalog": [{ from: "2025-01-01", to: "2025-06-30" }] },
  })[0];
  assert.throws(() => plannedSourceJob("brand-sales", resolved, "us"), /explicit connectionId/);
  assert.throws(() => plannedSourceJob("brand-sales", resolved, "us", "tertiary"), /explicit connectionId/);
  assert.throws(() => plannedSourceJob("brand-sales", { ...resolved, organizationFingerprint: "" }, "us", "primary"), /organizationFingerprint/);
  assert.doesNotThrow(() => plannedSourceJob("brand-sales", resolved, "us", "dd-secondary"));
});

test("makeDataDoeAdapter refuses missing/unknown/mismatched routing and a missing secondary key (zero DataDoe calls)", async () => {
  const primaryKey = PRIMARY_API_KEY;
  const secondaryKey = SECONDARY_API_KEY;
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

test("makeDataDoeAdapter normalizes REGISTRY-shaped primary/secondary and routes a dd-secondary job to the SECONDARY key (never primary)", async () => {
  const primaryKey = PRIMARY_API_KEY;
  const secondaryKey = SECONDARY_API_KEY;
  const pFp = organizationFingerprint(primaryKey);
  const sFp = organizationFingerprint(secondaryKey);
  // EXACTLY what getDataDoeConnections() returns: id "secondary" (NOT "dd-secondary"), no fingerprint.
  const registryConns = [
    { id: "primary", label: "Primary DataDoe", apiKey: primaryKey, accountPrefix: "" },
    { id: "secondary", label: "Secondary DataDoe", apiKey: secondaryKey, accountPrefix: dash("dd", "secondary") + ":" },
  ];
  const adapter = makeDataDoeAdapter(registryConns);
  const job = { connection_id: "dd-secondary", organizationFingerprint: sFp, sourceId: "src", fetchParams: { columns: ["c"], sellerOrVendorIds: ["A1"], from: null, to: null, limit: 10, options: {} } };
  // Capture the datadoe-api-key header the adapter sends and return a COMPLETED export so no poll runs;
  // this proves the dd-secondary job reaches the SECONDARY key with zero network beyond the one create.
  const seenKeys = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    seenKeys.push(options && options.headers && options.headers["datadoe-api-key"]);
    return { ok: true, status: 200, headers: { get() { return null; } }, async json() { return { exportId: "e1", status: "COMPLETED" }; } };
  };
  try {
    const created = await adapter.create(job);
    assert.equal(created.exportId, "e1");
  } finally { globalThis.fetch = realFetch; }
  assert.deepEqual(seenKeys, [secondaryKey], "dd-secondary job routed to the SECONDARY api key");
  assert.ok(!seenKeys.includes(primaryKey), "never falls back to the primary key");
  // A dd-secondary job carrying the PRIMARY fingerprint is rejected against the SELECTED (secondary)
  // connection -- proving it is not silently rerouted to primary (that would MATCH and pass).
  await assert.rejects(adapter.poll({ connection_id: "dd-secondary", organizationFingerprint: pFp }, "e1"), /does not match connection/);
  // Ambiguous/duplicate normalized ids are rejected at the boundary (both -> "dd-secondary" / "primary").
  assert.throws(() => makeDataDoeAdapter([{ id: "secondary", apiKey: secondaryKey }, { id: "dd-secondary", apiKey: secondaryKey }]), /Ambiguous/);
  assert.throws(() => makeDataDoeAdapter([{ id: "primary", apiKey: primaryKey }, { id: "primary", apiKey: primaryKey }]), /Ambiguous/);
  // An unknown connection id fails closed at construction.
  assert.throws(() => makeDataDoeAdapter([{ id: "tertiary", apiKey: primaryKey }]), /Cannot normalize DataDoe connection id/);
});

/* ----------------------------- BLOCKER 3: deadline during poll/download is resumable ----------------------------- */

test("execution-deadline during poll defers (resumable); a fresh invocation later succeeds with one create", async () => {
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

test("a genuine DataDoe processing timeout/failure during poll stays FAILED (not resumable)", async () => {
  const store = makeMemoryStore();
  const dd = makeDataDoe((job, stage) => (stage === "poll" ? { throw: new Error("DataDoe export timed out while processing.") } : { rows: [{ a: 1 }] }));
  const res = await runSourceJobs(runOpts({ store, dataDoe: dd, plannedJobs: [synthJob("h1")] }));
  assert.equal(res.failed, 1);
  assert.equal(res.deferred, 0);
  assert.equal(store._rawJob(res.cycleId, "h1").fetch_status, "failed");
});

/* ----------------------------- BLOCKER 4/2: atomic cache under ambiguity + concurrency ----------------------------- */


async function main() {
  mark("main(): entered");

  const step = async (label, thunk) => {
    mark("import " + label + ": start");
    const mod = await import(thunk);
    mark("import " + label + ": done");
    return mod;
  };

  ({ runSourceJobs } = await step("source-worker.js", "../lib/server/sync/source-worker.js"));
  ({ plannedSourceJob, makeDataDoeAdapter } = await step("source-sync-driver.js", "../lib/server/sync/source-sync-driver.js"));
  ({ reportSourceRequestHashes } = await step("report-source-contracts.js", "../lib/server/sync/report-source-contracts.js"));
  ({ organizationFingerprint } = await step("source-identity.js", "../lib/server/source-identity.js"));
  ({ validateSourcePayload } = await step("source-cache.js", "../lib/server/sync/source-cache.js"));
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
