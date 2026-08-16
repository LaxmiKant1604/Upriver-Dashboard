// Scheduler v2 -- schema / planner / SQL-model tests (SHADOW MODE).
//
// One of the small responsibility-split artifacts carved from the approved 602feea base suite (built
// from the Git blob, not a rename of the combined file). Independently readable/checkable/runnable;
// 7-bit ASCII, LF, no top-level await, synchronous writeSync progress, natural exit (no process.exit).
// Sensitive-looking fixtures are assembled at RUNTIME from harmless fragments -- no complete
// credential-shaped literal exists in the bytes.

import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { SCHEDULE_UTC } from "../lib/server/sync/registry.js";
import { buildDependencyPlan, sourceExportAttemptAllowed, reportFetchGate } from "../lib/server/sync/planner.js";
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
  assert.ok(/PLAN_SALES_SOURCE_ID\s*=\s*"89b27535/.test(datadoeSrc), "FBA velocity = Order Line Items 89b27535 (ordered quantity)");
  assert.ok(/DAILY_SALES_SOURCE_ID\s*=\s*"89b27535/.test(datadoeSrc), "Daily Reporting sales = Order Line Items 89b27535");
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
    assert.ok(!(new RegExp(frag("ey", "J") + "[A-Za-z0-9_-]{20,}")).test(text), f + " contains a JWT-looking secret");
    assert.ok(!(new RegExp(frag("service", "_role", "_key") + "\\s*=\\s*['\"]")).test(text), f + " assigns a service-role key");
    assert.ok(!(new RegExp(frag("DATADOE", "_API", "_KEY") + "\\s*=\\s*['\"][^'\"]+['\"]")).test(text), f + " assigns a DataDoe key");
    assert.ok(!(new RegExp(frag("CRON", "_SECRET") + "\\s*=\\s*['\"][^'\"]+['\"]")).test(text), f + " assigns a CRON secret");
  }
});

async function main() {
  mark("main(): entered");

  const step = async (label, thunk) => {
    mark("import " + label + ": start");
    const mod = await import(thunk);
    mark("import " + label + ": done");
    return mod;
  };


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
