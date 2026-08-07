// Deterministic tests for the Scheduler v2 source-first dependency graph, the
// checkpointable source worker, the atomic last-known-good cache, typed dependency
// signals, and the production Supabase durable-write guards -- ALL in ONE readable file.
//
// Single-file by design: the earlier split into scheduler-v2-source-worker.test.mjs and
// scheduler-v2-supabase-wrapper.test.mjs produced artifacts that blocked before Node could
// parse them on the reviewer's machine. Everything now lives here, in the file that has
// always read and `node --check`-ed cleanly. Every byte is 7-bit ASCII with LF endings.
//
// Structure notes that keep this reproducible on every platform:
//   - No top-level await. The async suite runs inside main(); the module body has no TLA,
//     no timer, and no open handle. All I/O is in-memory or synchronous file reads.
//   - Progress is emitted via SYNCHRONOUS writes (fs.writeSync) so every marker + result
//     line lands immediately even when stdout is an npm pipe -- a silent hang is impossible
//     to mistake for progress. Markers (stderr) bracket main(), every dynamic import, and
//     each major test group; the runner also dumps process.getActiveResourcesInfo() before
//     the NATURAL exit (we never call process.exit()) so any lingering handle is visible.
//   - Only env/IO-free modules are STATIC imports (assert, node builtins, registry.js,
//     planner.js). Every module that transitively imports lib/server/supabase.js
//     (source-worker -> datadoe -> supabase, source-sync-driver -> supabase) is loaded
//     DYNAMICALLY inside main(), AFTER the dummy Supabase env is set below -- supabase.js
//     captures its configuration at module load, and the production-wrapper tests need
//     requireConfiguration() to pass.
//
// Run with: npm run test:scheduler-v2   (node scripts/scheduler-v2.test.mjs)
//
// Coverage: source-first dedup on FULL request identity; the DB one-attempt invariant;
// cycle kickoff/claim transitions; last-known-good derive gate; schedules; SQL structure;
// corrected DataDoe source declarations; the resumable idempotent worker; fail-closed
// organization routing; execution-deadline resume; the atomic cache incl. concurrent
// winner adoption / typed CACHE_CONFLICT; cache-aware signal reconstruction; and the
// upsertSyncSourceJob fingerprint guard (rejected before any PostgREST request).

import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { SCHEDULE_UTC } from "../lib/server/sync/registry.js";
import {
  buildDependencyPlan,
  sourceExportAttemptAllowed,
  reportFetchGate,
} from "../lib/server/sync/planner.js";

// Dummy Supabase config, set BEFORE any supabase.js load. The production-wrapper tests need
// requireConfiguration() to pass; supabase.js captures env into module-level constants at
// load, so every module that transitively imports it is loaded dynamically in main() AFTER
// this assignment (see the header note). Any real env is preserved if already present.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://supabase.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "test-service-role-key";

// Bindings assigned in main() from dynamic imports (used by the async tests below). They
// are undefined at module-eval time and populated before the test loop runs; the async
// test closures only execute after that, so they observe the assigned values.
let runSourceJobs, classifyFetchError;
let salesMoversProbeSignal, keywordWeeklySignal, optimizerSqpSignal, adsCurrencySignal, deriveSignalsFromOutcomes;
let runStagedSourceCycle, reconstructSignals, plannedSourceJob, makeDataDoeAdapter;
let atomicSaveSourcePayload, validateSourcePayload, versionedObjectPath;
let reportSourceRequestHashes, salesMoversWindows;
let organizationFingerprint;
// Production Supabase wrapper aliased to avoid colliding with the pure claim MODEL below.
let upsertSyncSourceJob, prodClaimSourceExportAttempt;

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const MIG_DIR = join(ROOT, "supabase", "migrations");
const v2 = readFileSync(join(MIG_DIR, "20260807_scheduler_v2.sql"), "utf8");
const datadoeSrc = readFileSync(join(ROOT, "api", "datadoe.js"), "utf8");

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

mark("module body evaluated (static imports resolved); registering tests");

/* ================================================================ pure models
   Each mirrors the corresponding SQL exactly, so we can prove the invariant in
   plain JS and then assert the SQL text matches the model.                     */

// mirrors claim_source_export_attempt():
//   update ... set attempted_at=now(), create_export_count=create_export_count+1,
//   fetch_status='attempted' where cycle_id=? and request_hash=? and attempted_at is null; return FOUND
function claimSourceExportAttempt(job) {
  if (job.attempted_at === null || job.attempted_at === undefined) {
    job.attempted_at = "2026-08-07T02:00:00Z";
    job.create_export_count += 1;
    job.fetch_status = "attempted";
    return true; // FOUND: this caller made the single create-export POST
  }
  return false; // already attempted: no re-POST
}

// mirrors the CHECK constraint sync_source_jobs_one_attempt.
function oneAttemptCheckHolds(job) {
  const notAttempted = job.create_export_count === 0 && (job.attempted_at === null || job.attempted_at === undefined);
  const attemptedOnce = job.create_export_count === 1 && job.attempted_at !== null && job.attempted_at !== undefined;
  return notAttempted || attemptedOnce;
}

// mirrors open_sync_cycle(): insert (...,'pending') on conflict(bucket,cycle_date)
// do update set updated_at=now(). Kickoff = enqueue only; started_at stays NULL.
function openSyncCycle(cycles, bucket, cycleDate, scheduledAt) {
  const key = bucket + "|" + cycleDate;
  const existing = cycles.get(key);
  if (existing) { existing.updated_at = "touched"; return existing; } // no status/timing reset
  const cycle = { id: key, bucket, cycle_date: cycleDate, scheduled_at: scheduledAt, status: "pending", started_at: null };
  cycles.set(key, cycle);
  return cycle;
}

// mirrors claim_sync_cycle(): update ... set status='running', started_at=now()
// where id=? and status='pending'; return FOUND.
function claimSyncCycle(cycle) {
  if (cycle.status === "pending") {
    cycle.status = "running";
    cycle.started_at = "2026-08-07T02:00:05Z";
    return true;
  }
  return false;
}

/* -------------------------------------------------- source-first dedup (full identity) */

group("planner / SQL / model (22 sync tests)");

test("same canonical source (same request_hash) needed by 2 reports -> ONE source job", () => {
  const shared = { requestHash: "H-oli-A", sourceId: "89b27535", sourceKey: "order-line-items", connectionId: "primary", bucket: "non-us" };
  const plan = buildDependencyPlan([
    { reportKey: "brand-sales", accountId: "acct-1", bucket: "non-us", sources: [shared] },
    { reportKey: "reconciliation", accountId: "acct-1", bucket: "non-us", sources: [shared] },
  ]);
  assert.equal(plan.sourceJobs.length, 1);
  assert.equal(plan.sourceJobs[0].neededBy.length, 2);
  assert.ok(plan.reportJobs.every((r) => r.dependsOn.includes("H-oli-A")));
});

test("same source_id but DIFFERENT request_hash (diff window/columns) does NOT dedupe", () => {
  // request_hash covers org+scope+source+columns+grain+aggregations+window+limit+ordering.
  // Same source_id 89b27535 with a different window => different hash => two exports.
  const plan = buildDependencyPlan([
    { reportKey: "brand-sales", accountId: "a", bucket: "non-us",
      sources: [{ requestHash: "H-oli-420d", sourceId: "89b27535", connectionId: "primary" }] },
    { reportKey: "reconciliation", accountId: "a", bucket: "non-us",
      sources: [{ requestHash: "H-oli-180d", sourceId: "89b27535", connectionId: "primary" }] },
  ]);
  assert.equal(plan.sourceJobs.length, 2, "identity differs beyond source_id => separate exports");
});

test("primary and secondary org never share (different org fingerprint => different hash)", () => {
  const plan = buildDependencyPlan([
    { reportKey: "brand-sales", accountId: "a", bucket: "non-us",
      sources: [{ requestHash: "H-primary", sourceId: "89b27535", connectionId: "primary" }] },
    { reportKey: "brand-sales", accountId: "b", bucket: "non-us",
      sources: [{ requestHash: "H-secondary", sourceId: "89b27535", connectionId: "dd-secondary" }] },
  ]);
  assert.equal(plan.sourceJobs.length, 2);
});

test("a derived-only report (no sources) creates no source job and is ready to derive", () => {
  const plan = buildDependencyPlan([{ reportKey: "priority-feed", accountId: "a", bucket: "non-us", sources: [] }]);
  assert.equal(plan.sourceJobs.length, 0);
  assert.equal(reportFetchGate(plan.reportJobs[0], {}), "ready");
});

/* ---------------------------------------------- one create-export per request_hash */

test("create_export_count cannot exceed one under repeated claims", () => {
  const job = { create_export_count: 0, attempted_at: null, fetch_status: "pending" };
  const results = [];
  for (let i = 0; i < 6; i += 1) results.push(claimSourceExportAttempt(job));
  assert.deepEqual(results, [true, false, false, false, false, false], "only the first claim wins");
  assert.equal(job.create_export_count, 1, "count never exceeds one");
  assert.ok(oneAttemptCheckHolds(job));
});

test("attempted_at / count consistency is enforced (legal vs illegal states)", () => {
  assert.ok(oneAttemptCheckHolds({ create_export_count: 0, attempted_at: null }));
  assert.ok(oneAttemptCheckHolds({ create_export_count: 1, attempted_at: "t" }));
  assert.ok(!oneAttemptCheckHolds({ create_export_count: 2, attempted_at: "t" }), "count 2 illegal");
  assert.ok(!oneAttemptCheckHolds({ create_export_count: 1, attempted_at: null }), "count 1 needs attempted_at");
  assert.ok(!oneAttemptCheckHolds({ create_export_count: 0, attempted_at: "t" }), "attempted_at needs count 1");
});

test("repeated source claims do not repeat create-export (planner pre-check agrees)", () => {
  const job = { create_export_count: 0, attempted_at: null, fetch_status: "pending" };
  assert.equal(sourceExportAttemptAllowed(job), true);
  claimSourceExportAttempt(job);
  assert.equal(sourceExportAttemptAllowed(job), false, "after the claim, no worker may re-POST");
  assert.equal(sourceExportAttemptAllowed({ fetch_status: "failed" }), false, "failed source not retried this cycle");
});

/* -------------------------------------------------------- cycle timing semantics */

test("kickoff creates a pending cycle with started_at NULL and scheduled_at set", () => {
  const cycles = new Map();
  const c = openSyncCycle(cycles, "non-us", "2026-08-07", "2026-08-07T02:00:00Z");
  assert.equal(c.status, "pending");
  assert.equal(c.started_at, null);
  assert.equal(c.scheduled_at, "2026-08-07T02:00:00Z");
});

test("first worker claim transitions pending -> running and stamps started_at", () => {
  const cycles = new Map();
  const c = openSyncCycle(cycles, "non-us", "2026-08-07", "2026-08-07T02:00:00Z");
  assert.equal(claimSyncCycle(c), true);
  assert.equal(c.status, "running");
  assert.ok(c.started_at && c.started_at !== c.scheduled_at, "actual start is separate from scheduled");
});

test("repeated worker claims do not restart the cycle", () => {
  const cycles = new Map();
  const c = openSyncCycle(cycles, "non-us", "2026-08-07", "2026-08-07T02:00:00Z");
  claimSyncCycle(c);
  const startedAt = c.started_at;
  assert.equal(claimSyncCycle(c), false, "second claim finds status<>pending");
  assert.equal(c.started_at, startedAt, "started_at never overwritten");
});

test("repeated kickoff/watchdog calls are idempotent and never restart a running cycle", () => {
  const cycles = new Map();
  const c1 = openSyncCycle(cycles, "non-us", "2026-08-07", "2026-08-07T02:00:00Z");
  claimSyncCycle(c1);
  const again = openSyncCycle(cycles, "non-us", "2026-08-07", "2026-08-07T02:00:00Z");
  assert.equal(again.id, c1.id, "same (bucket, cycle_date) => same cycle");
  assert.equal(again.status, "running", "kickoff does not reset a running cycle to pending");
});

/* --------------------------------------------------- last-known-good derive gate */

test("report derivation is gated so last-known-good survives a source failure", () => {
  const rj = { dependsOn: ["hA", "hB"] };
  assert.equal(reportFetchGate(rj, { hA: "succeeded", hB: "succeeded" }), "ready");
  assert.equal(reportFetchGate(rj, { hA: "succeeded", hB: "pending" }), "pending");
  assert.equal(reportFetchGate(rj, { hA: "succeeded", hB: "failed" }), "blocked");
  assert.equal(reportFetchGate(rj, { hA: "succeeded", hB: "skipped" }), "blocked");
});

/* --------------------------------------------------------------- schedules */

test("schedules equal 02:00 (non-us) and 10:30 (us) UTC", () => {
  assert.equal(SCHEDULE_UTC["non-us"], "02:00");
  assert.equal(SCHEDULE_UTC.us, "10:30");
});

/* --------------------------------- SQL structure matches the modelled invariants */

test("SQL: one-attempt CHECK matches the modelled invariant exactly", () => {
  const normalized = v2.replace(/\s+/g, " ");
  assert.ok(normalized.includes("(create_export_count = 0 and attempted_at is null) or (create_export_count = 1 and attempted_at is not null)"),
    "CHECK must be (0/NULL) or (1/NOT NULL)");
  assert.ok(!/create_export_count\s*<=\s*1\s+or\s+attempted_at\s+is\s+not\s+null/i.test(v2), "old permissive CHECK must be gone");
});

test("SQL: claim_source_export_attempt is a single atomic guarded UPDATE returning FOUND", () => {
  assert.ok(v2.includes("create or replace function public.claim_source_export_attempt"));
  const body = v2.slice(v2.indexOf("function public.claim_source_export_attempt"));
  assert.ok(/where[\s\S]*attempted_at is null/i.test(body), "must guard on attempted_at is null");
  assert.ok(/return found/i.test(body), "must return FOUND (no separate select-then-write race)");
});

test("SQL: open_sync_cycle enqueues PENDING with no started_at (not running/now())", () => {
  const start = v2.indexOf("function public.open_sync_cycle");
  const end = v2.indexOf("$$;", start);
  const body = v2.slice(start, end);
  assert.ok(/'pending'/.test(body), "kickoff inserts pending");
  assert.ok(!/'running'/.test(body), "kickoff must NOT insert running");
  assert.ok(!/started_at/.test(body), "kickoff must NOT set started_at");
});

test("SQL: claim_sync_cycle atomically moves pending -> running and stamps started_at once", () => {
  const start = v2.indexOf("function public.claim_sync_cycle");
  assert.ok(start > 0, "claim_sync_cycle must exist");
  const end = v2.indexOf("$$;", start);
  const body = v2.slice(start, end);
  assert.ok(/set status = 'running'/.test(body) && /started_at = now\(\)/.test(body));
  assert.ok(/where[\s\S]*status = 'pending'/.test(body), "claims only a pending cycle");
  assert.ok(/return found/i.test(body), "cannot be claimed twice");
});

/* -------------------------- corrected source contracts match executable code */

test("api/datadoe.js declares the corrected source-id constants", () => {
  assert.ok(/ORDER_LINE_ITEMS_SOURCE_ID\s*=\s*"89b27535/.test(datadoeSrc));
  assert.ok(/PRODUCT_CATALOG_SOURCE_ID\s*=\s*"68d2de/.test(datadoeSrc));
  assert.ok(/PLAN_SALES_SOURCE_ID\s*=\s*"401ffcd7e5"/.test(datadoeSrc), "FBA velocity = Sales & Traffic 401ffcd7e5");
  assert.ok(/DAILY_SALES_SOURCE_ID\s*=\s*"401ffcd7e5"/.test(datadoeSrc));
});

test("buildBrandSalesPayload uses Order Line Items + Product Catalog, NOT Sales & Traffic", () => {
  const bs = datadoeSrc.indexOf("function buildBrandSalesPayload");
  assert.ok(bs > 0, "buildBrandSalesPayload must exist");
  const nextDef = datadoeSrc.indexOf("SOURCE_ID = \"", bs); // next top-level source-id definition after the fn
  const body = datadoeSrc.slice(bs, nextDef > bs ? nextDef : bs + 2000);
  assert.ok(body.includes("ORDER_LINE_ITEMS_SOURCE_ID"), "brand-sales must use Order Line Items 89b27535");
  assert.ok(body.includes("PRODUCT_CATALOG_SOURCE_ID"), "brand-sales must use Product Catalog 68d2de");
  assert.ok(!body.includes("401ffcd7e5"), "brand-sales must NOT use Sales & Traffic 401ffcd7e5");
  assert.ok(!body.includes("PLAN_SALES_SOURCE_ID") && !body.includes("DAILY_SALES_SOURCE_ID"),
    "brand-sales must not reference the Sales & Traffic constants");
});

/* ------------------------------------------ migration additive + no-secret scans */

test("v2 migration declares the three tables + separated fetch/derive/save statuses", () => {
  for (const t of ["public.sync_cycles", "public.sync_source_jobs", "public.sync_report_jobs"]) {
    assert.ok(v2.includes("create table if not exists " + t), "missing " + t);
  }
  assert.ok(/unique\s*\(\s*bucket\s*,\s*cycle_date\s*\)/.test(v2));
  assert.ok(/unique\s*\(\s*cycle_id\s*,\s*request_hash\s*\)/.test(v2));
  for (const s of ["fetch_status", "derive_status", "save_status", "validated"]) assert.ok(v2.includes(s));
});

test("v2 migration is additive (no alter/drop of an existing table)", () => {
  assert.ok(!/alter table public\.(report_snapshots|source_export_cache|sync_targets|sync_runs|ads_daily_source_rows)/i.test(v2));
  assert.ok(!/drop table/i.test(v2));
});

test("no migration file embeds a secret (JWT / service-role / DataDoe / CRON_SECRET value)", () => {
  for (const f of readdirSync(MIG_DIR).filter((n) => n.endsWith(".sql"))) {
    const text = readFileSync(join(MIG_DIR, f), "utf8");
    assert.ok(!/eyJ[A-Za-z0-9_-]{20,}/.test(text), f + " contains a JWT-looking secret");
    assert.ok(!/service_role_key\s*=\s*['"]/.test(text), f + " assigns a service-role key");
    assert.ok(!/DATADOE_API_KEY\s*=\s*['"][^'"]+['"]/.test(text), f + " assigns a DataDoe key");
    assert.ok(!/CRON_SECRET\s*=\s*['"][^'"]+['"]/.test(text), f + " assigns a CRON secret");
  }
});

/* ============================================================================================
   Source worker / signals / atomic cache  (async; formerly scheduler-v2-source-worker.test.mjs)
   ============================================================================================ */

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

/* ----------------------------- one-attempt / resume / checkpoint ----------------------------- */

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
  const leaky = new Error("DataDoe export creation failed (403): apikey=SECRET-KEY-123 token=abc");
  const dd = makeDataDoe(() => ({ throw: leaky }));
  const res = await runSourceJobs(runOpts({ store, dataDoe: dd, plannedJobs: [synthJob("h1")] }));
  const j = store._rawJob(res.cycleId, "h1");
  assert.ok(!/SECRET-KEY-123|token=abc/.test(j.error_message));
  assert.equal(j.error_message, "DataDoe returned HTTP 403 for this source.");
  assert.ok(!/SECRET-KEY-123|token=abc/.test(JSON.stringify(res)));
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

group("dependency signals + reconstruction");

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

test("reconstructSignals: a genuine empty success ({rows:[]}) activates downstream; missing/malformed does NOT", async () => {
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

test("reconstructSignals: a failed/unavailable ads read yields no scheduling currency (not count 0)", async () => {
  const store = makeMemoryStore();
  const cid = store.openCycle({ bucket: "us", cycleDate: "2026-08-07" });
  const s = await reconstructSignals({ store, cycleId: cid, resolvePlan: async () => ({ sourceJobs: [] }), adsRowsProvider: async () => { throw new Error("ads read failed"); } });
  assert.equal(s["ppc-performance:ads-currency"].validated, false);
  assert.equal(s["ppc-performance:ads-currency"].currencyCount, null);
});

/* ----------------------------- signals (pure) ----------------------------- */

test("dependency signals are derived ONLY from validated saved results", async () => {
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

/* ----------------------------- staged flow through the real resolver ----------------------------- */

group("staged flow through the real resolver");

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

test("Sales Movers downstream jobs use the validated probe date (single invocation)", async () => {
  const store = makeMemoryStore();
  const rollup = await runStagedSourceCycle(runOpts({ store, dataDoe: smDataDoe(), resolvePlan: smResolvePlan }));
  assert.equal(rollup.signals["sales-movers:sales-latest-probe"].latestReportedDate, "2025-07-30");
  const expected = reportSourceRequestHashes({ reportKey: "sales-movers", apiKey: "K", ids: ["A1"], windowsByRequestKey: smFullWin("2025-07-30"), dependencySignals: { "sales-movers:sales-latest-probe": { status: "success", validated: true, latestReportedDate: "2025-07-30" } } });
  const stored = new Set(store.listSourceJobs(rollup.cycleId).map((j) => j.request_hash));
  for (const e of expected) assert.ok(stored.has(e.requestHash));
  assert.equal(stored.size, expected.length);
});

test("staged signals survive a brand-new invocation: reconstructed from persisted job+payload, no repeated primary create", async () => {
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

test("Listing Optimizer catalog waits for a validated SQP success", async () => {
  const s1 = makeMemoryStore();
  const f1 = makeDataDoe((job) => ((job.requestKey ?? job.request_key) === "listing-optimizer:sqp-weekly" ? { throw: new Error("source is disabled for this organization") } : { rows: [{ a: 1 }] }));
  const r1 = await runStagedSourceCycle(runOpts({ store: s1, dataDoe: f1, resolvePlan: optResolvePlan }));
  assert.deepEqual(sources(s1, r1.cycleId), ["sqp-weekly"]);
  const s2 = makeMemoryStore();
  const r2 = await runStagedSourceCycle(runOpts({ store: s2, dataDoe: makeDataDoe(() => ({ rows: [] })), resolvePlan: optResolvePlan }));
  const set2 = new Set(sources(s2, r2.cycleId));
  assert.ok(set2.has("sqp-weekly") && set2.has("product-catalog"));
});

test("Keyword monthly fallback follows the distinct-period policy; PPC total-sales respects Ads currency", async () => {
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

test("classifyFetchError maps to SAFE codes/terminality and never echoes the raw error", async () => {
  assert.deepEqual(classifyFetchError(new Error("source is disabled for this organization"), "create-export"), { stage: "create-export", code: "SOURCE_DISABLED", message: "Source is disabled for this organization.", terminal: true });
  assert.equal(classifyFetchError(new Error("DataDoe export creation failed (402): tokens")).code, "HTTP_402");
  assert.equal(classifyFetchError(new Error("DataDoe export creation failed (402): tokens")).terminal, true);
  assert.equal(classifyFetchError(new Error("DataDoe export creation failed (503): busy")).terminal, false);
  assert.equal(classifyFetchError(new Error("DataDoe export timed out while processing.")).code, "TIMEOUT");
});

/* ============================================================================================
   Production Supabase durable-write guards  (async; formerly scheduler-v2-supabase-wrapper.test.mjs)

   Exercises the REAL lib/server/supabase.js wrappers -- not an in-memory double -- to prove a
   durable-write invariant: upsertSyncSourceJob REJECTS a job with a missing/empty
   organization_fingerprint BEFORE issuing any PostgREST request, so a fingerprint-less job is
   never written (never as an empty string) and never reaches the one-attempt claim
   (claim_source_export_attempt), which keys organization routing off that durable row.
   Global fetch is replaced with a spy that RECORDS every call and throws a sentinel; the dummy
   Supabase env set at the top of this file lets requireConfiguration() pass so the positive
   control actually reaches the network boundary.
   ============================================================================================ */

group("production Supabase durable-write guards");

// Install a fetch spy that records each request URL and throws a recognizable sentinel, so
// ANY PostgREST/network call is both observable and prevented from doing real I/O.
function withFetchSpy(run) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const e = new Error("SPY_FETCH_CALLED");
    e.code = "SPY_FETCH_CALLED";
    throw e;
  };
  return Promise.resolve(run(calls)).finally(() => { globalThis.fetch = original; });
}

const wellFormed = {
  cycleId: "cyc_1", requestHash: "h1", sourceId: "src", sourceKey: "sk",
  connectionId: "primary", organizationFingerprint: "org-fingerprint-abc",
  accountScopeHash: "ash", requestMeta: {}, bucket: "us",
};

test("upsertSyncSourceJob REJECTS an empty organization fingerprint BEFORE any PostgREST request", async () => {
  await withFetchSpy(async (calls) => {
    await assert.rejects(
      upsertSyncSourceJob({ ...wellFormed, organizationFingerprint: "" }),
      /organization fingerprint|organizationFingerprint/i,
    );
    assert.equal(calls.length, 0, "no PostgREST request was issued for a fingerprint-less job");
  });
});

test("upsertSyncSourceJob REJECTS a missing/undefined organization fingerprint (fail closed, no request)", async () => {
  const noFp = { ...wellFormed };
  delete noFp.organizationFingerprint;
  await withFetchSpy(async (calls) => {
    await assert.rejects(upsertSyncSourceJob(noFp), /organization fingerprint|organizationFingerprint/i);
    assert.equal(calls.length, 0, "still no PostgREST request for an undefined fingerprint");
  });
});

test("positive control: a well-formed job DOES reach the sync_source_jobs PostgREST insert", async () => {
  await withFetchSpy(async (calls) => {
    // The spy throws at the network boundary; the point is that a well-formed job GETS there.
    await assert.rejects(upsertSyncSourceJob({ ...wellFormed }), /SPY_FETCH_CALLED/);
    assert.equal(calls.length, 1, "a well-formed job issues exactly one PostgREST request");
    assert.match(calls[0], /\/rest\/v1\/sync_source_jobs/, "and it targets the sync_source_jobs table");
  });
});

test("the fingerprint guard runs before the one-attempt claim: a rejected upsert never writes the row the claim needs", async () => {
  await withFetchSpy(async (calls) => {
    // In the worker's order, upsertSyncSourceJob writes the durable row FIRST; only later does
    // claim_source_export_attempt operate on it. A fingerprint-less job dies at the upsert with
    // zero requests, so the claim RPC is never reachable for it.
    await assert.rejects(upsertSyncSourceJob({ ...wellFormed, organizationFingerprint: "" }), /fingerprint/i);
    assert.ok(!calls.some((u) => /claim_source_export_attempt/.test(u)), "the one-attempt claim RPC was never called");
    assert.ok(!calls.some((u) => /sync_source_jobs/.test(u)), "and no durable job row was inserted");
    // Sanity: the claim wrapper itself is a real PostgREST call (proves the guard, not a stub,
    // is what stopped us above).
    await assert.rejects(prodClaimSourceExportAttempt("cyc_1", "h1"), /SPY_FETCH_CALLED/);
    assert.ok(calls.some((u) => /rpc\/claim_source_export_attempt/.test(u)), "claim RPC hits PostgREST when actually invoked");
  });
});

/* ---- load env-dependent modules AFTER env is set, then run the async suite (no TLA) ----
   Each dynamic import is bracketed by a synchronous progress marker so a blocking import is
   pinpointed immediately (see the `mark`/`out` note above). The modules below transitively
   import lib/server/datadoe.js -> lib/server/supabase.js; both only declare constants /
   functions / one AsyncLocalStorage at module top level (no network, timer, or handle at
   import time), so these awaits resolve promptly and open no handle. */
async function main() {
  mark("main(): entered");

  const step = async (label, thunk) => {
    mark("import " + label + ": start");
    const mod = await import(thunk);
    mark("import " + label + ": done");
    return mod;
  };

  ({ runSourceJobs, classifyFetchError } = await step("source-worker.js", "../lib/server/sync/source-worker.js"));
  ({ salesMoversProbeSignal, keywordWeeklySignal, optimizerSqpSignal, adsCurrencySignal, deriveSignalsFromOutcomes } = await step("source-signals.js", "../lib/server/sync/source-signals.js"));
  ({ runStagedSourceCycle, reconstructSignals, plannedSourceJob, makeDataDoeAdapter } = await step("source-sync-driver.js (-> datadoe -> supabase)", "../lib/server/sync/source-sync-driver.js"));
  ({ atomicSaveSourcePayload, validateSourcePayload, versionedObjectPath } = await step("source-cache.js", "../lib/server/sync/source-cache.js"));
  ({ reportSourceRequestHashes, salesMoversWindows } = await step("report-source-contracts.js", "../lib/server/sync/report-source-contracts.js"));
  ({ organizationFingerprint } = await step("source-identity.js", "../lib/server/source-identity.js"));
  const sb = await step("supabase.js", "../lib/server/supabase.js");
  upsertSyncSourceJob = sb.upsertSyncSourceJob;
  prodClaimSourceExportAttempt = sb.claimSourceExportAttempt;

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
