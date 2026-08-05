// Deterministic tests for the Scheduler v2 source-first dependency graph.
// No network, no DB: pure planner functions + static assertions on the additive
// migration text. Run with: npm run test:scheduler-v2
//
// Proves the token-saving and safety invariants at the logic level; live cycle
// validation against real DataDoe/Supabase remains Codex's separate gate.

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

const { SCHEDULE_UTC } = await import("../lib/server/sync/registry.js");
const {
  buildDependencyPlan, sourceExportAttemptAllowed, reportFetchGate,
} = await import("../lib/server/sync/planner.js");

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}`);
    console.error(err);
    process.exit(1);
  }
}

/* ------------------------------------------------------------------ dedup */

test("same canonical source needed by multiple reports creates ONE source job", () => {
  const shared = {
    requestHash: "hash-order-line-items-A",
    sourceId: "src-oli", sourceKey: "order-line-items", connectionId: "primary", bucket: "non-us",
  };
  const plan = buildDependencyPlan([
    { reportKey: "reconciliation", accountId: "acct-1", bucket: "non-us", sources: [shared] },
    { reportKey: "sku-pl", accountId: "acct-1", bucket: "non-us", sources: [shared] },
  ]);
  assert.equal(plan.sourceJobs.length, 1, "identical request_hash must collapse to one source job");
  assert.equal(plan.sourceJobs[0].requestHash, "hash-order-line-items-A");
  assert.equal(plan.sourceJobs[0].neededBy.length, 2, "both reports recorded as needing the source");
  assert.equal(plan.reportJobs.length, 2);
  assert.ok(plan.reportJobs.every((r) => r.dependsOn.includes("hash-order-line-items-A")));
});

test("distinct canonical sources (different window/org) stay separate jobs", () => {
  const plan = buildDependencyPlan([
    { reportKey: "reconciliation", accountId: "acct-1", bucket: "non-us",
      sources: [{ requestHash: "h1", sourceId: "s", connectionId: "primary" }] },
    { reportKey: "reconciliation", accountId: "acct-2", bucket: "non-us",
      sources: [{ requestHash: "h2", sourceId: "s", connectionId: "dd-secondary" }] },
  ]);
  assert.equal(plan.sourceJobs.length, 2, "different request_hash must NOT be deduplicated");
});

test("a report with no sources is derived-only (no source job, ready to derive)", () => {
  const plan = buildDependencyPlan([
    { reportKey: "priority-feed", accountId: "acct-1", bucket: "non-us", sources: [] },
  ]);
  assert.equal(plan.sourceJobs.length, 0);
  assert.equal(plan.reportJobs[0].dependsOn.length, 0);
  assert.equal(reportFetchGate(plan.reportJobs[0], {}), "ready");
});

/* ------------------------------------------------------- one attempt / cycle */

test("failed source gets exactly one attempt: pending allowed, everything else blocked", () => {
  assert.equal(sourceExportAttemptAllowed({ fetch_status: "pending" }), true);
  assert.equal(sourceExportAttemptAllowed({ fetch_status: "attempted" }), false);
  assert.equal(sourceExportAttemptAllowed({ fetch_status: "failed" }), false);
  assert.equal(sourceExportAttemptAllowed({ fetch_status: "succeeded" }), false);
});

test("repeated worker calls do not repeat create-export: attempted_at blocks re-POST", () => {
  const job = { fetch_status: "pending", attempted_at: null };
  assert.equal(sourceExportAttemptAllowed(job), true);      // first worker may POST
  job.attempted_at = "2026-08-07T02:00:05Z";                // claim guard set it
  job.fetch_status = "attempted";
  assert.equal(sourceExportAttemptAllowed(job), false);     // every later worker: no re-POST
});

/* ----------------------------------------------- last-known-good derive gate */

test("report derivation is gated so last-known-good survives a source failure", () => {
  const rj = { dependsOn: ["hA", "hB"] };
  assert.equal(reportFetchGate(rj, { hA: "succeeded", hB: "succeeded" }), "ready");
  assert.equal(reportFetchGate(rj, { hA: "succeeded", hB: "pending" }), "pending");
  // A terminally failed source blocks the report; the worker must skip derive/save
  // and preserve the previous snapshot rather than overwrite it with partial data.
  assert.equal(reportFetchGate(rj, { hA: "succeeded", hB: "failed" }), "blocked");
  assert.equal(reportFetchGate(rj, { hA: "succeeded", hB: "skipped" }), "blocked");
});

/* --------------------------------------------------------------- schedules */

test("schedules equal 02:00 (non-us) and 10:30 (us) UTC", () => {
  assert.equal(SCHEDULE_UTC["non-us"], "02:00");
  assert.equal(SCHEDULE_UTC.us, "10:30");
});

/* -------------------------------------------- additive migration structure */

const migDir = join(ROOT, "supabase", "migrations");
const migFiles = readdirSync(migDir).filter((f) => f.endsWith(".sql"));
const v2 = readFileSync(join(migDir, "20260807_scheduler_v2.sql"), "utf8");

test("v2 migration declares the three dependency-graph tables + key constraints", () => {
  for (const t of ["public.sync_cycles", "public.sync_source_jobs", "public.sync_report_jobs"]) {
    assert.ok(v2.includes(`create table if not exists ${t}`), `missing table ${t}`);
  }
  assert.ok(/unique\s*\(\s*bucket\s*,\s*cycle_date\s*\)/.test(v2), "missing unique(bucket, cycle_date)");
  assert.ok(/unique\s*\(\s*cycle_id\s*,\s*request_hash\s*\)/.test(v2), "missing unique(cycle_id, request_hash)");
  assert.ok(v2.includes("attempted_at"), "missing attempted_at guard column");
  assert.ok(v2.includes("claim_source_export_attempt"), "missing claim_source_export_attempt guard RPC");
  assert.ok(v2.includes("open_sync_cycle"), "missing idempotent open_sync_cycle RPC");
  // fetch/derive/save statuses recorded separately.
  for (const s of ["fetch_status", "derive_status", "save_status"]) {
    assert.ok(v2.includes(s), `missing ${s}`);
  }
});

test("v2 migration is additive (no alter/drop of an existing table)", () => {
  assert.ok(!/alter table public\.(report_snapshots|source_export_cache|sync_targets|sync_runs|ads_daily_source_rows)/i.test(v2));
  assert.ok(!/drop table/i.test(v2), "no drop table allowed");
});

test("no migration file embeds a secret (JWT / service-role / DataDoe / CRON_SECRET value)", () => {
  for (const f of migFiles) {
    const text = readFileSync(join(migDir, f), "utf8");
    assert.ok(!/eyJ[A-Za-z0-9_-]{20,}/.test(text), `${f} contains a JWT-looking secret`);
    assert.ok(!/service_role_key\s*=\s*['"]/.test(text), `${f} assigns a service-role key`);
    assert.ok(!/DATADOE_API_KEY\s*=\s*['"][^'"]+['"]/.test(text), `${f} assigns a DataDoe key`);
    assert.ok(!/CRON_SECRET\s*=\s*['"][^'"]+['"]/.test(text), `${f} assigns a CRON secret`);
  }
});

console.log(`\n${passed} assertions passed`);
