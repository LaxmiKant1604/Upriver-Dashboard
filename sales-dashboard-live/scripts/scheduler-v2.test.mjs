// Deterministic tests for the Scheduler v2 source-first dependency graph.
//
// No network, no DB, no dynamic import, no top-level await: plain static imports
// of pure modules (registry.js / planner.js are dependency-free of env or I/O) plus
// synchronous file reads. This keeps `node --check` and execution fast and
// reproducible from the checked-out worktree on any platform.
//
// Run with: npm run test:scheduler-v2
//
// Coverage: source-first dedup on FULL request identity, the DB one-attempt
// invariant (count in {0,1}, consistent with attempted_at), cycle kickoff/claim
// transitions, last-known-good derive gate, schedules, and that the corrected
// Dashboard/FBA source declarations match the executable contracts in
// api/datadoe.js. Pure transition models below mirror the SQL RPCs/CHECK exactly;
// precise structural assertions confirm the SQL matches those models. Live cycle
// validation against real DataDoe/Supabase remains Codex's separate gate.

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { SCHEDULE_UTC } from "../lib/server/sync/registry.js";
import {
  buildDependencyPlan,
  sourceExportAttemptAllowed,
  reportFetchGate,
} from "../lib/server/sync/planner.js";
// Phase 1c: the source worker + typed signals + staged driver (in-memory fakes below;
// no network/DB — these imports only define pure functions and injected orchestrators).
import { runSourceJobs, classifyFetchError } from "../lib/server/sync/source-worker.js";
import {
  salesMoversProbeSignal, keywordWeeklySignal, optimizerSqpSignal,
  adsCurrencySignal, deriveSignalsFromOutcomes,
} from "../lib/server/sync/source-signals.js";
import { runStagedSourceCycle, plannedSourceJob } from "../lib/server/sync/source-sync-driver.js";
import { reportSourceRequestHashes, salesMoversWindows } from "../lib/server/sync/report-source-contracts.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const MIG_DIR = join(ROOT, "supabase", "migrations");
const v2 = readFileSync(join(MIG_DIR, "20260807_scheduler_v2.sql"), "utf8");

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log("  ok  " + name);
  } catch (err) {
    console.error("FAIL  " + name);
    console.error(err && err.message ? err.message : err);
    process.exitCode = 1;
    throw err;
  }
}

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

const dd = readFileSync(join(ROOT, "api", "datadoe.js"), "utf8");

test("api/datadoe.js declares the corrected source-id constants", () => {
  assert.ok(/ORDER_LINE_ITEMS_SOURCE_ID\s*=\s*"89b27535/.test(dd));
  assert.ok(/PRODUCT_CATALOG_SOURCE_ID\s*=\s*"68d2de/.test(dd));
  assert.ok(/PLAN_SALES_SOURCE_ID\s*=\s*"401ffcd7e5"/.test(dd), "FBA velocity = Sales & Traffic 401ffcd7e5");
  assert.ok(/DAILY_SALES_SOURCE_ID\s*=\s*"401ffcd7e5"/.test(dd));
});

test("buildBrandSalesPayload uses Order Line Items + Product Catalog, NOT Sales & Traffic", () => {
  const bs = dd.indexOf("function buildBrandSalesPayload");
  assert.ok(bs > 0, "buildBrandSalesPayload must exist");
  const nextDef = dd.indexOf("SOURCE_ID = \"", bs); // next top-level source-id definition after the fn
  const body = dd.slice(bs, nextDef > bs ? nextDef : bs + 2000);
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

/* ==================================================================================
   Phase 1c — source worker + typed signals + staged driver (async; in-memory fakes).
   The memory store models the SQL RPCs exactly: open_sync_cycle (idempotent),
   claim_sync_cycle (pending->running once), claim_source_export_attempt (single winner),
   upsert (ignore-duplicates), and a failure path that never clears last-known-good.
   ================================================================================== */

function makeMemoryStore() {
  const cycles = new Map();      // "bucket|date" -> cycle
  const jobsByCycle = new Map(); // cycleId -> Map(request_hash -> jobRow)
  const cache = new Map();       // request_hash -> { rows, object_path }  (source_export_cache)
  let seq = 0;
  const findCycle = (id) => [...cycles.values()].find((c) => c.id === id) || null;
  return {
    _cache: cache,
    failSaveFor: new Set(),
    forceLoseClaim: new Set(), // simulate another worker winning the attempt first
    openCycle({ bucket, cycleDate }) {
      const key = `${bucket}|${cycleDate}`;
      if (!cycles.has(key)) {
        const id = `cyc_${++seq}`;
        cycles.set(key, { id, bucket, cycle_date: cycleDate, status: "pending", started_at: null });
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
      if (!m.has(job.requestHash)) {
        m.set(job.requestHash, {
          request_hash: job.requestHash, request_key: job.requestKey, source_id: job.sourceId,
          source_key: job.sourceKey, connection_id: job.connectionId,
          organization_fingerprint: job.organizationFingerprint, account_scope_hash: job.accountScopeHash,
          request_meta: job.requestMeta, bucket: job.bucket, fetch_status: "pending",
          attempted_at: null, create_export_count: 0, export_id: null, terminal: false,
          error_stage: null, error_code: null, error_message: null, row_count: null,
          cache_object_path: null, last_good_fetched_at: null,
        });
      } // ignore-duplicates: an existing job is never reset
    },
    listSourceJobs(cycleId) { return [...(jobsByCycle.get(cycleId)?.values() || [])].map((j) => ({ ...j })); },
    claimExportAttempt(cycleId, requestHash) {
      const j = jobsByCycle.get(cycleId)?.get(requestHash);
      if (this.forceLoseClaim.has(requestHash)) { if (j) { j.attempted_at = "t"; j.create_export_count = 1; j.fetch_status = "attempted"; } return false; }
      if (j && j.attempted_at === null) { j.attempted_at = "t"; j.create_export_count += 1; j.fetch_status = "attempted"; return true; }
      return false; // already attempted -> caller must NOT create an export
    },
    saveSourceRows({ job, rows }) {
      const hash = job.request_hash ?? job.requestHash;
      if (this.failSaveFor.has(hash)) throw new Error("Supabase source-save failed (503).");
      const path = `source-cache/${hash}.json`;
      cache.set(hash, { rows: [...rows], object_path: path });
      return path;
    },
    recordSourceSuccess({ cycleId, requestHash, exportId, rowCount, cacheObjectPath }) {
      const j = jobsByCycle.get(cycleId).get(requestHash);
      Object.assign(j, { fetch_status: "succeeded", export_id: exportId, row_count: rowCount, cache_object_path: cacheObjectPath, last_good_fetched_at: "t", error_stage: null, error_code: null, error_message: null });
    },
    recordSourceFailure({ cycleId, requestHash, stage, code, message, terminal, rowCount, exportId }) {
      const j = jobsByCycle.get(cycleId).get(requestHash);
      // Failure NEVER touches cache_object_path / last_good_fetched_at -> last-known-good survives.
      Object.assign(j, { fetch_status: "failed", error_stage: stage, error_code: code, error_message: message, terminal: !!terminal });
      if (rowCount != null) j.row_count = rowCount;
      if (exportId != null) j.export_id = exportId;
    },
    updateCycleCounts() {},
  };
}

// behaviorFn(job) -> { rows } | { throw: Error }. Records call count per request_hash.
function makeFetcher(behaviorFn) {
  const calls = {};
  const fn = async (job) => {
    const h = job.request_hash ?? job.requestHash;
    calls[h] = (calls[h] || 0) + 1;
    const b = (behaviorFn ? behaviorFn(job) : null) || { rows: [] };
    if (b.throw) throw b.throw;
    return { rows: b.rows || [], exportId: `exp_${h}` };
  };
  fn.callCount = (h) => calls[h] || 0;
  fn.total = () => Object.values(calls).reduce((a, b) => a + b, 0);
  return fn;
}

const synthJob = (hash, extra = {}) => ({
  requestHash: hash, requestKey: extra.requestKey || `rk:${hash}`, sourceId: "src", sourceKey: "sk",
  connectionId: extra.connectionId || "primary", organizationFingerprint: extra.org || "orgA",
  accountScopeHash: "ash", requestMeta: extra.requestMeta || {}, strict: extra.strict || false, limit: extra.limit || 50000,
});

const asyncTests = [];
function atest(name, fn) { asyncTests.push({ name, fn }); }

// --- one attempt / idempotency / resume ---
atest("the atomic attempt claim has a single winner; a worker that LOSES it creates no export", async () => {
  // The RPC itself: first caller true, every later caller false (one create-export/cycle).
  const guard = makeMemoryStore();
  const cid = guard.openCycle({ bucket: "us", cycleDate: "2026-08-07" });
  guard.upsertSourceJob({ cycleId: cid, bucket: "us", ...synthJob("h1") });
  assert.equal(guard.claimExportAttempt(cid, "h1"), true);
  assert.equal(guard.claimExportAttempt(cid, "h1"), false);
  assert.equal(guard.claimExportAttempt(cid, "h1"), false);
  // The worker path: a job is still pending when listed, but another worker wins the
  // atomic claim first -> this worker must create ZERO exports and record a skip.
  const store = makeMemoryStore();
  store.forceLoseClaim.add("h1");
  const fetch = makeFetcher(() => ({ rows: [{ a: 1 }] }));
  const res = await runSourceJobs({ store, fetchSource: fetch, plannedJobs: [synthJob("h1")], bucket: "us", cycleDate: "2026-08-07" });
  assert.equal(fetch.total(), 0, "the worker that lost the claim created zero exports");
  assert.equal(res.skipped, 1);
  assert.equal(res.succeeded, 0);
});

atest("repeated worker invocations never repeat a claimed export; completed jobs are skipped on resume", async () => {
  const store = makeMemoryStore();
  const fetch = makeFetcher(() => ({ rows: [{ a: 1 }] }));
  const planned = [synthJob("h1"), synthJob("h2")];
  const opts = { store, fetchSource: fetch, plannedJobs: planned, bucket: "us", cycleDate: "2026-08-07" };
  const r1 = await runSourceJobs(opts);
  assert.equal(r1.succeeded, 2); assert.equal(r1.drained, true);
  const r2 = await runSourceJobs(opts); // resume: everything already succeeded
  assert.equal(r2.processed, 0);
  assert.equal(fetch.callCount("h1"), 1); assert.equal(fetch.callCount("h2"), 1);
});

atest("checkpoint: a bounded worker processes maxJobs, then a later invocation drains the rest", async () => {
  const store = makeMemoryStore();
  const fetch = makeFetcher(() => ({ rows: [{ a: 1 }] }));
  const planned = ["h1", "h2", "h3", "h4", "h5"].map((h) => synthJob(h));
  const base = { store, fetchSource: fetch, plannedJobs: planned, bucket: "us", cycleDate: "2026-08-07", maxJobs: 2 };
  const r1 = await runSourceJobs(base); assert.equal(r1.processed, 2); assert.equal(r1.drained, false);
  const r2 = await runSourceJobs(base); assert.equal(r2.processed, 2); assert.equal(r2.drained, false);
  const r3 = await runSourceJobs(base); assert.equal(r3.processed, 1); assert.equal(r3.drained, true);
  assert.equal(fetch.total(), 5); // each source fetched exactly once across the checkpoints
});

atest("worker exits safely near its time deadline without creating any export", async () => {
  const store = makeMemoryStore();
  const fetch = makeFetcher(() => ({ rows: [{ a: 1 }] }));
  const planned = [synthJob("h1"), synthJob("h2")];
  const res = await runSourceJobs({
    store, fetchSource: fetch, plannedJobs: planned, bucket: "us", cycleDate: "2026-08-07",
    clock: () => 100_000, deadlineMs: 1_000, reserveMs: 3_000, // already past the deadline
  });
  assert.equal(res.deadlineReached, true);
  assert.equal(res.processed, 0);
  assert.equal(fetch.total(), 0, "no export is started at/after the deadline");
});

// --- failure isolation / no-retry / last-known-good ---
atest("a failed source is not retried in the same cycle, but a NEW cycle attempts it again", async () => {
  const store = makeMemoryStore();
  const boom = new Error("DataDoe export creation failed (500): upstream");
  const fetch = makeFetcher(() => ({ throw: boom }));
  const planned = [synthJob("h1")];
  const r1 = await runSourceJobs({ store, fetchSource: fetch, plannedJobs: planned, bucket: "us", cycleDate: "2026-08-07" });
  assert.equal(r1.failed, 1);
  const r1b = await runSourceJobs({ store, fetchSource: fetch, plannedJobs: planned, bucket: "us", cycleDate: "2026-08-07" });
  assert.equal(r1b.processed, 0, "same cycle: the failed job is not retried");
  assert.equal(fetch.callCount("h1"), 1);
  // A new cycle date opens a fresh cycle with a fresh pending job -> retried.
  const r2 = await runSourceJobs({ store, fetchSource: fetch, plannedJobs: planned, bucket: "us", cycleDate: "2026-08-08" });
  assert.equal(r2.processed, 1);
  assert.equal(fetch.callCount("h1"), 2);
});

atest("last-known-good source data survives a later failure (never overwritten)", async () => {
  const store = makeMemoryStore();
  let mode = "ok";
  const fetch = makeFetcher(() => (mode === "ok" ? { rows: [{ good: 1 }, { good: 2 }] } : { throw: new Error("DataDoe export creation failed (500).") }));
  const planned = [synthJob("h1")];
  await runSourceJobs({ store, fetchSource: fetch, plannedJobs: planned, bucket: "us", cycleDate: "2026-08-07" });
  assert.deepEqual(store._cache.get("h1").rows, [{ good: 1 }, { good: 2 }]); // saved
  mode = "fail";
  await runSourceJobs({ store, fetchSource: fetch, plannedJobs: planned, bucket: "us", cycleDate: "2026-08-08" });
  assert.deepEqual(store._cache.get("h1").rows, [{ good: 1 }, { good: 2 }]); // preserved after failure
});

atest("strict row-cap data is never saved as successful (recorded as a validate/TRUNCATED failure)", async () => {
  const store = makeMemoryStore();
  const fetch = makeFetcher(() => ({ rows: [{}, {}, {}] })); // 3 rows, cap 3 -> truncated
  const planned = [synthJob("h1", { strict: true, limit: 3 })];
  const res = await runSourceJobs({ store, fetchSource: fetch, plannedJobs: planned, bucket: "us", cycleDate: "2026-08-07" });
  assert.equal(res.failed, 1);
  assert.equal(store._cache.has("h1"), false, "truncated data is NOT persisted");
  const job = store.listSourceJobs(res.cycleId).find((j) => j.request_hash === "h1");
  assert.equal(job.error_stage, "validate");
  assert.equal(job.error_code, "TRUNCATED");
  assert.equal(job.terminal, true);
});

atest("DataDoe fetch failure and Supabase save failure are recorded on SEPARATE stages", async () => {
  const store = makeMemoryStore();
  store.failSaveFor.add("h2");
  const fetch = makeFetcher((job) => ((job.request_hash ?? job.requestHash) === "h1" ? { throw: new Error("DataDoe export creation failed (404): missing") } : { rows: [{ a: 1 }] }));
  const planned = [synthJob("h1"), synthJob("h2")];
  const res = await runSourceJobs({ store, fetchSource: fetch, plannedJobs: planned, bucket: "us", cycleDate: "2026-08-07" });
  assert.equal(res.failed, 2);
  const jobs = store.listSourceJobs(res.cycleId);
  const j1 = jobs.find((j) => j.request_hash === "h1");
  const j2 = jobs.find((j) => j.request_hash === "h2");
  assert.equal(j1.error_stage, "create-export"); assert.equal(j1.error_code, "HTTP_404");
  assert.equal(j2.error_stage, "persist"); assert.equal(j2.error_code, "SAVE_FAILED");
  assert.equal(store._cache.has("h2"), false, "a save failure leaves no partial cache entry");
});

atest("no secret value ever appears in a recorded error message or the progress output", async () => {
  const store = makeMemoryStore();
  const leaky = new Error("DataDoe export creation failed (403): apikey=SECRET-KEY-123 url=https://api.datadoe.com/x?token=abc");
  const fetch = makeFetcher(() => ({ throw: leaky }));
  const planned = [synthJob("h1")];
  const res = await runSourceJobs({ store, fetchSource: fetch, plannedJobs: planned, bucket: "us", cycleDate: "2026-08-07" });
  const job = store.listSourceJobs(res.cycleId).find((j) => j.request_hash === "h1");
  assert.ok(!/SECRET-KEY-123|token=abc/.test(job.error_message), "stored message must not echo the raw error");
  assert.equal(job.error_message, "DataDoe returned HTTP 403 for this source.");
  assert.ok(!/SECRET-KEY-123|token=abc/.test(JSON.stringify(res)), "progress output must not carry a secret");
});

// --- five-ID batching + organization isolation at the job level ---
atest("five-ID chunks remain SEPARATE source jobs, each fetched once", async () => {
  const store = makeMemoryStore();
  const ids = Array.from({ length: 6 }, (_, i) => `A${i}`); // 6 ids -> 2 chunks of 5 + 1
  const resolved = reportSourceRequestHashes({
    reportKey: "brand-sales", apiKey: "K", ids,
    windowsByRequestKey: { "brand-sales:order-lines": [{ from: "2025-01-01", to: "2025-06-30" }], "brand-sales:catalog": [{ from: "2025-01-01", to: "2025-06-30" }] },
  });
  const orderLines = resolved.filter((r) => r.requestKey === "brand-sales:order-lines");
  assert.equal(orderLines.length, 2, "6 ids -> 2 chunks -> 2 order-line jobs");
  assert.equal(new Set(orderLines.map((r) => r.requestHash)).size, 2, "distinct request_hash per chunk");
  const planned = resolved.map((r) => plannedSourceJob("brand-sales", r, "us"));
  const fetch = makeFetcher(() => ({ rows: [{ a: 1 }] }));
  const res = await runSourceJobs({ store, fetchSource: fetch, plannedJobs: planned, bucket: "us", cycleDate: "2026-08-07" });
  assert.equal(res.succeeded, planned.length);
  for (const r of orderLines) assert.equal(fetch.callCount(r.requestHash), 1);
});

atest("primary and dd-secondary organizations never mix (disjoint request hashes / jobs)", async () => {
  const win = { "brand-sales:order-lines": [{ from: "2025-01-01", to: "2025-06-30" }], "brand-sales:catalog": [{ from: "2025-01-01", to: "2025-06-30" }] };
  const primary = reportSourceRequestHashes({ reportKey: "brand-sales", apiKey: "PRIMARY_ORG_KEY", ids: ["A1"], windowsByRequestKey: win }).map((r) => plannedSourceJob("brand-sales", r, "us"));
  const secondary = reportSourceRequestHashes({ reportKey: "brand-sales", apiKey: "DD_SECONDARY_ORG_KEY", ids: ["A1"], windowsByRequestKey: win }).map((r) => plannedSourceJob("brand-sales", { ...r, connectionId: "dd-secondary" }, "us"));
  const pHashes = new Set(primary.map((j) => j.requestHash));
  const sHashes = new Set(secondary.map((j) => j.requestHash));
  for (const h of sHashes) assert.ok(!pHashes.has(h), "no request_hash is shared across organizations");
  const store = makeMemoryStore();
  const fetch = makeFetcher(() => ({ rows: [{ a: 1 }] }));
  await runSourceJobs({ store, fetchSource: fetch, plannedJobs: [...primary, ...secondary], bucket: "us", cycleDate: "2026-08-07" });
  const cid = store.openCycle({ bucket: "us", cycleDate: "2026-08-07" });
  const jobs = store.listSourceJobs(cid);
  assert.equal(jobs.length, primary.length + secondary.length, "each org keeps its own jobs");
});

// --- typed dependency signals (only from validated saved results) ---
atest("dependency signals are derived ONLY from validated saved results", async () => {
  // A validated success yields an activating signal; a failed outcome does not.
  const ok = deriveSignalsFromOutcomes([{ requestKey: "sales-movers:sales-latest-probe", status: "success", validated: true, rows: [{ date: "2025-07-30", units_sum: 4 }] }]);
  assert.deepEqual(ok["sales-movers:sales-latest-probe"], { status: "success", validated: true, latestReportedDate: "2025-07-30" });
  const failed = deriveSignalsFromOutcomes([{ requestKey: "sales-movers:sales-latest-probe", status: "failed", validated: false }]);
  assert.deepEqual(failed["sales-movers:sales-latest-probe"], { status: "failed", validated: false, latestReportedDate: null });
  // A shared/non-signal source produces no signal.
  assert.deepEqual(deriveSignalsFromOutcomes([{ requestKey: "sales-movers:catalog", status: "success", validated: true, rows: [] }]), {});
  // pure signal shapes
  assert.deepEqual(keywordWeeklySignal({ status: "success", validated: true, rows: [{ date: "2025-07-01" }, { date: "2025-07-08" }, { date: "2025-07-01" }] }), { status: "success", validated: true, distinctPeriods: 2 });
  assert.deepEqual(optimizerSqpSignal({ status: "success", validated: true, rows: [] }), { status: "success", validated: true }); // zero rows still valid
  assert.deepEqual(optimizerSqpSignal({ status: "terminal", validated: false }), { status: "terminal", validated: false });
  assert.deepEqual(adsCurrencySignal([{ currency: "USD" }, { currency: "USD" }, { currency: "CAD" }, { currency: "" }]), { status: "success", validated: true, currencyCount: 2 });
});

// --- staged flow through the real Phase 1b resolver ---
const smFullWin = (date) => {
  const w = salesMoversWindows(date);
  return {
    "sales-movers:sales-latest-probe": [{ from: "2025-07-12", to: "2025-08-06" }],
    "sales-movers:traffic": [w.recent, w.prior], "sales-movers:ads": [w.recent, w.prior],
    "sales-movers:inventory": [{ from: "2025-07-27", to: "2025-08-06" }], "sales-movers:catalog": [{ from: null, to: null }],
  };
};
const smResolvePlan = (signals) => {
  const sig = signals["sales-movers:sales-latest-probe"];
  const win = sig && sig.status === "success" && sig.validated && sig.latestReportedDate
    ? smFullWin(sig.latestReportedDate)
    : { "sales-movers:sales-latest-probe": [{ from: "2025-07-12", to: "2025-08-06" }] };
  const resolved = reportSourceRequestHashes({ reportKey: "sales-movers", apiKey: "K", ids: ["A1"], windowsByRequestKey: win, dependencySignals: signals }) || [];
  return { sourceJobs: resolved.map((r) => plannedSourceJob("sales-movers", r, "us")) };
};

atest("Sales Movers: kickoff plans probe only; downstream jobs use the VALIDATED probe date", async () => {
  const store = makeMemoryStore();
  const fetch = makeFetcher((job) => ((job.request_key ?? job.requestKey) === "sales-movers:sales-latest-probe"
    ? { rows: [{ date: "2025-07-28", units_sum: 5 }, { date: "2025-07-30", units_sum: 3 }] }
    : { rows: [{ a: 1 }] }));
  const rollup = await runStagedSourceCycle({ store, fetchSource: fetch, resolvePlan: smResolvePlan, bucket: "us", cycleDate: "2026-08-07" });
  assert.equal(rollup.signals["sales-movers:sales-latest-probe"].latestReportedDate, "2025-07-30");
  // The store must contain EXACTLY the downstream jobs the resolver derives from 2025-07-30.
  const expected = reportSourceRequestHashes({ reportKey: "sales-movers", apiKey: "K", ids: ["A1"], windowsByRequestKey: smFullWin("2025-07-30"), dependencySignals: { "sales-movers:sales-latest-probe": { status: "success", validated: true, latestReportedDate: "2025-07-30" } } });
  const stored = new Set(store.listSourceJobs(rollup.cycleId).map((j) => j.request_hash));
  for (const e of expected) assert.ok(stored.has(e.requestHash), `${e.requestKey} present`);
  assert.equal(stored.size, expected.length, "no extra/mismatched-window jobs were created");
});

atest("Sales Movers: a FAILED probe plans no downstream export (prior report preserved)", async () => {
  const store = makeMemoryStore();
  const fetch = makeFetcher((job) => ((job.request_key ?? job.requestKey) === "sales-movers:sales-latest-probe"
    ? { throw: new Error("DataDoe export creation failed (500).") }
    : { rows: [{ a: 1 }] }));
  const rollup = await runStagedSourceCycle({ store, fetchSource: fetch, resolvePlan: smResolvePlan, bucket: "us", cycleDate: "2026-08-07" });
  const keys = new Set(store.listSourceJobs(rollup.cycleId).map((j) => j.request_key));
  assert.deepEqual([...keys], ["sales-movers:sales-latest-probe"], "only the probe was ever planned");
  assert.equal(fetch.callCount(store.listSourceJobs(rollup.cycleId)[0].request_hash), 1);
});

atest("Listing Optimizer catalog waits for a VALIDATED SQP success", async () => {
  const optResolve = (sqp) => (signals) => {
    const win = { "listing-optimizer:sqp-weekly": [{ from: "2025-05-14", to: "2025-08-06" }] };
    if (signals["listing-optimizer:sqp-weekly"]?.status === "success") win["listing-optimizer:catalog"] = [{ from: null, to: null }];
    const resolved = reportSourceRequestHashes({ reportKey: "listing-optimizer", apiKey: "K", ids: ["A1"], windowsByRequestKey: win, dependencySignals: signals }) || [];
    return { sourceJobs: resolved.map((r) => plannedSourceJob("listing-optimizer", r, "us")) };
  };
  // disabled SQP -> catalog never planned
  const s1 = makeMemoryStore();
  const f1 = makeFetcher((job) => ((job.request_key ?? job.requestKey) === "listing-optimizer:sqp-weekly" ? { throw: new Error("source is disabled for this organization") } : { rows: [{ a: 1 }] }));
  const r1 = await runStagedSourceCycle({ store: s1, fetchSource: f1, resolvePlan: optResolve(), bucket: "us", cycleDate: "2026-08-07" });
  assert.deepEqual(s1.listSourceJobs(r1.cycleId).map((j) => j.request_key), ["listing-optimizer:sqp-weekly"]);
  // validated SQP success (even zero rows) -> catalog planned
  const s2 = makeMemoryStore();
  const f2 = makeFetcher(() => ({ rows: [] }));
  const r2 = await runStagedSourceCycle({ store: s2, fetchSource: f2, resolvePlan: optResolve(), bucket: "us", cycleDate: "2026-08-07" });
  const keys2 = new Set(s2.listSourceJobs(r2.cycleId).map((j) => j.request_key));
  assert.ok(keys2.has("listing-optimizer:sqp-weekly") && keys2.has("listing-optimizer:catalog"), "zero-row SQP success activates catalog");
});

atest("Keyword monthly fallback follows the approved distinct-period policy (from validated weekly)", async () => {
  const kwResolve = (signals) => {
    const win = { "keyword-rank:sqp-weekly": [{ from: "2025-07-01", to: "2025-08-06" }], "keyword-rank:catalog": [{ from: "2025-07-01", to: "2025-08-06" }] };
    if (signals["keyword-rank:sqp-weekly"]?.validated) win["keyword-rank:sqp-monthly"] = [{ from: "2025-05-01", to: "2025-07-31" }];
    const resolved = reportSourceRequestHashes({ reportKey: "keyword-rank", apiKey: "K", ids: ["A1"], windowsByRequestKey: win, fallbackSignals: signals }) || [];
    return { sourceJobs: resolved.map((r) => plannedSourceJob("keyword-rank", r, "us")) };
  };
  // weekly with only 2 distinct periods (< 4) -> monthly fallback fires
  const store = makeMemoryStore();
  const fetch = makeFetcher((job) => ((job.request_key ?? job.requestKey) === "keyword-rank:sqp-weekly" ? { rows: [{ date: "2025-07-07" }, { date: "2025-07-14" }] } : { rows: [{ a: 1 }] }));
  const rollup = await runStagedSourceCycle({ store, fetchSource: fetch, resolvePlan: kwResolve, bucket: "us", cycleDate: "2026-08-07" });
  assert.equal(rollup.signals["keyword-rank:sqp-weekly"].distinctPeriods, 2);
  const keys = new Set(store.listSourceJobs(rollup.cycleId).map((j) => j.request_key));
  assert.ok(keys.has("keyword-rank:sqp-monthly"), "under-threshold validated weekly schedules the monthly fallback");
});

atest("PPC total-sales respects the Ads-currency count derived from persisted rows", async () => {
  const ppcResolve = (currencyCount) => (signals) => {
    const sig = { "ppc-performance:ads-currency": adsCurrencySignal(Array.from({ length: currencyCount }, (_, i) => ({ currency: `C${i}` }))) };
    const merged = { ...signals, ...sig };
    const win = { "ppc-performance:catalog": [{ from: null, to: null }] };
    if (merged["ppc-performance:ads-currency"].currencyCount <= 1) win["ppc-performance:total-sales"] = [{ from: "2025-07-08", to: "2025-08-06" }];
    const resolved = reportSourceRequestHashes({ reportKey: "ppc-performance", apiKey: "K", ids: ["A1"], windowsByRequestKey: win, dependencySignals: merged }) || [];
    return { sourceJobs: resolved.map((r) => plannedSourceJob("ppc-performance", r, "us")) };
  };
  const fetch = makeFetcher(() => ({ rows: [{ a: 1 }] }));
  // single currency -> total-sales runs
  const s1 = makeMemoryStore();
  const r1 = await runStagedSourceCycle({ store: s1, fetchSource: fetch, resolvePlan: ppcResolve(1), bucket: "us", cycleDate: "2026-08-07" });
  assert.ok(new Set(s1.listSourceJobs(r1.cycleId).map((j) => j.request_key)).has("ppc-performance:total-sales"));
  // multi-currency -> total-sales skipped by design; catalog still present
  const s2 = makeMemoryStore();
  const r2 = await runStagedSourceCycle({ store: s2, fetchSource: makeFetcher(() => ({ rows: [{ a: 1 }] })), resolvePlan: ppcResolve(2), bucket: "us", cycleDate: "2026-08-07" });
  const keys2 = s2.listSourceJobs(r2.cycleId).map((j) => j.request_key);
  assert.deepEqual(keys2, ["ppc-performance:catalog"], "multi-currency: TACoS denominator not scheduled, catalog remains");
});

atest("classifyFetchError maps to SAFE codes/terminality and never echoes the raw error", () => {
  assert.deepEqual(classifyFetchError(new Error("source is disabled for this organization")), { stage: "create-export", code: "SOURCE_DISABLED", message: "Source is disabled for this organization.", terminal: true });
  assert.equal(classifyFetchError(new Error("DataDoe export creation failed (402): tokens")).code, "HTTP_402");
  assert.equal(classifyFetchError(new Error("DataDoe export creation failed (402): tokens")).terminal, true); // 4xx terminal
  assert.equal(classifyFetchError(new Error("DataDoe export creation failed (503): busy")).terminal, false); // 5xx transient
  assert.equal(classifyFetchError(new Error("DataDoe export timed out while processing.")).code, "TIMEOUT");
});

/* ---- run the async suite, then report the combined count ---- */
for (const t of asyncTests) {
  try { await t.fn(); passed += 1; console.log("  ok  " + t.name); }
  catch (err) { console.error("FAIL  " + t.name); console.error(err && err.message ? err.message : err); process.exitCode = 1; }
}

console.log("\n" + passed + " assertions passed");
