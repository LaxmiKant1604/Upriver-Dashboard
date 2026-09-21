// DR1/DR4 reclaim migration guard: proves 20260929_reclaim_stale_catalog_jobs.sql is ADDITIVE, IDEMPOTENT, RLS-safe
// (SECURITY DEFINER + fixed search_path + service_role-only, never browser/public), and that the reclaim is SCOPED +
// SNAPSHOT-GATED + TOKEN-SAFE: it only resets fetch_status='failed', export_id IS NULL product-catalog jobs inside the
// reconciler's OWN priority-partial cycle namespace, and ONLY where a VALIDATED durable org snapshot exists. Text-level
// assertions (no DB) so the release-safety properties are pinned in CI. 7-bit ASCII.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

let passed = 0;
const test = (name, fn) => { try { fn(); passed += 1; console.log("  ok  " + name); } catch (e) { console.log("FAIL  " + name); console.log(String(e && e.stack ? e.stack : e)); process.exitCode = 1; } };

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SQL = readFileSync(join(ROOT, "supabase/migrations/20260929_reclaim_stale_catalog_jobs.sql"), "utf8");

test("ADDITIVE: adds ONE new RPC; no destructive DDL, no data deletion", () => {
  assert.ok(/create or replace function\s+public\.reclaim_stale_priority_catalog_jobs/i.test(SQL), "creates the new RPC");
  assert.ok(!/drop\s+table/i.test(SQL), "no drop table");
  assert.ok(!/drop\s+column/i.test(SQL), "no drop column");
  assert.ok(!/drop\s+function/i.test(SQL), "no drop function");
  assert.ok(!/truncate/i.test(SQL), "no truncate");
  assert.ok(!/delete\s+from/i.test(SQL), "no delete (never removes rows/audit history)");
  assert.ok(!/alter\s+table/i.test(SQL), "adds no column/constraint (pure new RPC)");
});

test("IDEMPOTENT: create or replace, and the failed-only predicate makes re-runs no-ops", () => {
  assert.ok(/create or replace function/i.test(SQL), "function is create-or-replace");
  assert.ok(/fetch_status\s*=\s*'failed'/i.test(SQL), "only failed jobs are reset -> re-running after they are pending/succeeded reclaims nothing");
});

test("SECURITY: SECURITY DEFINER + fixed search_path, service_role only, never anon/authenticated/public", () => {
  assert.ok(/security definer/i.test(SQL), "SECURITY DEFINER");
  assert.ok(/set search_path\s*=\s*public/i.test(SQL), "fixed search_path = public");
  assert.ok(/revoke all on function public\.reclaim_stale_priority_catalog_jobs\([^)]*\) from public, anon, authenticated/i.test(SQL), "revokes public/anon/authenticated");
  assert.ok(/grant execute on function public\.reclaim_stale_priority_catalog_jobs\([^)]*\) to service_role/i.test(SQL), "grants only service_role");
  assert.ok(!/to\s+anon/i.test(SQL) && !/to\s+authenticated/i.test(SQL), "never grants anon/authenticated (no browser/public invocation)");
});

test("SCOPED + TOKEN-SAFE: only priority-partial catalog jobs, failed, export_id NULL (no real export -> no tokens)", () => {
  assert.ok(/c\.bucket like 'priority-partial-'\s*\|\|\s*p_bucket\s*\|\|\s*'-%'/i.test(SQL), "scoped to the reconciler's priority-partial-<bucket>-% cycle namespace ONLY (scheduled cycles untouched)");
  assert.ok(/j\.source_key\s*=\s*'product-catalog'/i.test(SQL), "only product-catalog jobs");
  assert.ok(/j\.fetch_status\s*=\s*'failed'/i.test(SQL), "only currently-failed jobs");
  assert.ok(/j\.export_id is null/i.test(SQL), "only jobs that never created a real export (export_id NULL -> zero tokens spent) -> can never orphan a paid export");
});

test("SNAPSHOT-GATED: only reclaims where a VALIDATED durable org Catalog snapshot with a content object exists", () => {
  assert.ok(/join\s+public\.source_snapshots/i.test(SQL) || /public\.source_snapshots\s+s/i.test(SQL), "joins source_snapshots (the recovery-evidence gate)");
  assert.ok(/s\.source_key\s*=\s*'product-catalog'/i.test(SQL) && /s\.scope_key\s*=\s*'__organization'/i.test(SQL), "matches the org-scoped catalog snapshot exactly");
  assert.ok(/s\.organization_fingerprint\s*=\s*j\.organization_fingerprint/i.test(SQL) && /s\.connection_id\s*=\s*j\.connection_id/i.test(SQL), "matches the job's EXACT tenant/connection (no cross-org recovery)");
  assert.ok(/s\.validated_at is not null/i.test(SQL), "requires a validated snapshot");
  assert.ok(/s\.object_path/i.test(SQL) && /s\.payload_sha/i.test(SQL), "requires the snapshot to carry a content object (object_path + payload_sha)");
});

test("RESET makes the job re-adoptable by DR1: pending + unattempted + count=0 + cleared error/adoption", () => {
  assert.ok(/fetch_status\s*=\s*'pending'/i.test(SQL), "back to pending (adopt_durable_catalog_snapshot requires pending)");
  assert.ok(/attempted_at\s*=\s*null/i.test(SQL) && /create_export_count\s*=\s*0/i.test(SQL), "unattempted + count=0 (re-adoptable + a real export can still win)");
  assert.ok(/adoption_kind\s*=\s*null/i.test(SQL), "clears any stale adoption provenance");
  assert.ok(/error_stage\s*=\s*null/i.test(SQL) && /error_code\s*=\s*null/i.test(SQL), "clears the stale terminal error");
});

console.log("\n" + passed + " assertions passed");
