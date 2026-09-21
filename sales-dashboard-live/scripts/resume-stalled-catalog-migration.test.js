// DR4 watchdog migration guard: proves 20260930_resume_stalled_catalog_job.sql (adds the RPC) and
// 20260931_resume_stalled_catalog_job_pending.sql (CREATE OR REPLACE extending it to PENDING catalog jobs) are
// ADDITIVE, IDEMPOTENT, RLS-safe (SECURITY DEFINER + fixed search_path + service_role-only), FENCED (status='running'
// + staleness + no non-catalog open job), TOKEN-SAFE (export_id NULL only -> never orphans a paid export), and
// SNAPSHOT-GATED (adopts only a VALIDATED durable org snapshot; never fabricates). Text-level assertions (no DB). 7-bit ASCII.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

let passed = 0;
const test = (name, fn) => { try { fn(); passed += 1; console.log("  ok  " + name); } catch (e) { console.log("FAIL  " + name); console.log(String(e && e.stack ? e.stack : e)); process.exitCode = 1; } };

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const V1 = readFileSync(join(ROOT, "supabase/migrations/20260930_resume_stalled_catalog_job.sql"), "utf8");
const V2 = readFileSync(join(ROOT, "supabase/migrations/20260931_resume_stalled_catalog_job_pending.sql"), "utf8");

for (const [label, SQL, handlesPending] of [["20260930 (failed)", V1, false], ["20260931 (failed+pending)", V2, true]]) {
  test(`${label}: ADDITIVE new RPC; no destructive DDL, no deletion`, () => {
    assert.ok(/create or replace function\s+public\.resume_stalled_catalog_job/i.test(SQL), "creates/replaces the RPC");
    assert.ok(!/drop\s+table/i.test(SQL) && !/drop\s+column/i.test(SQL) && !/truncate/i.test(SQL) && !/delete\s+from/i.test(SQL), "no destructive DDL / deletion");
    assert.ok(!/alter\s+table/i.test(SQL), "adds no column/constraint (pure RPC)");
  });
  test(`${label}: SECURITY DEFINER + fixed search_path, service_role only`, () => {
    assert.ok(/security definer/i.test(SQL) && /set search_path\s*=\s*public/i.test(SQL), "security definer + fixed search_path");
    assert.ok(/revoke all on function public\.resume_stalled_catalog_job\([^)]*\) from public, anon, authenticated/i.test(SQL), "revokes public/anon/authenticated");
    assert.ok(/grant execute on function public\.resume_stalled_catalog_job\([^)]*\) to service_role/i.test(SQL), "grants only service_role");
    assert.ok(!/to\s+anon/i.test(SQL) && !/to\s+authenticated/i.test(SQL), "never anon/authenticated");
  });
  test(`${label}: FENCED on a stalled running cycle (status + staleness)`, () => {
    assert.ok(/v_cycle\.status <> 'running'/i.test(SQL) && /v_cycle\.updated_at > p_stale_before/i.test(SQL), "only status='running' AND not-updated-since the staleness fence -> 'not-stalled'");
    assert.ok(/return 'not-stalled'/i.test(SQL), "typed not-stalled ack");
  });
  test(`${label}: TOKEN-SAFE + SNAPSHOT-GATED + explicit provenance`, () => {
    assert.ok(/export_id is null/i.test(SQL) && /create_export_count <= 1/i.test(SQL), "only a create that spent NO tokens (export_id NULL) is reset");
    assert.ok(/scope_key = '__organization'/i.test(SQL) && /source_key = 'product-catalog'/i.test(SQL), "org-scoped product-catalog snapshot exactly");
    assert.ok(/organization_fingerprint = v_job\.organization_fingerprint/i.test(SQL) && /connection_id = v_job\.connection_id/i.test(SQL), "matches the job's EXACT tenant (no cross-org recovery)");
    assert.ok(/v_snap\.validated_at is null/i.test(SQL) && /return 'no-snapshot'/i.test(SQL), "requires a validated snapshot; else 'no-snapshot' (never fabricated)");
    assert.ok(/adoption_kind = 'durable_snapshot'/i.test(SQL), "EXPLICIT durable_snapshot provenance");
    assert.ok(/return 'resumed'/i.test(SQL), "typed resumed ack");
  });
}

test("20260931: extends the eligible catalog states to FAILED **or** PENDING, fencing only NON-catalog open jobs", () => {
  assert.ok(/fetch_status in \('failed', 'pending'\)/i.test(V2), "eligible catalog job may be failed OR pending");
  assert.ok(/source_key <> 'product-catalog'/i.test(V2) && /return 'has-open-jobs'/i.test(V2), "only a NON-catalog open job blocks (a pending catalog is adoptable)");
});

test("20260930: original handles FAILED only (superseded by 20260931 CREATE OR REPLACE)", () => {
  assert.ok(/fetch_status = 'failed'/i.test(V1), "20260930 gated on failed only");
});

console.log("\n" + passed + " assertions passed");
