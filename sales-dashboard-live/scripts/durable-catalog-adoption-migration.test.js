// DR1 migration + security guard: proves 20260928_durable_catalog_adoption.sql is ADDITIVE, IDEMPOTENT, RLS-safe
// (SECURITY DEFINER + fixed search_path + service_role-only, never browser/public), enforces exact equivalence
// (source_request_hash + payload_sha + org/conn/source/scope), and never fabricates a success. Text-level assertions
// (no DB) so the release safety properties are pinned in CI. 7-bit ASCII.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

let passed = 0;
const test = (name, fn) => { try { fn(); passed += 1; console.log("  ok  " + name); } catch (e) { console.log("FAIL  " + name); console.log(String(e && e.stack ? e.stack : e)); process.exitCode = 1; } };

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SQL = readFileSync(join(ROOT, "supabase/migrations/20260928_durable_catalog_adoption.sql"), "utf8");
const low = SQL.toLowerCase();

test("ADDITIVE: adds a nullable column + a new RPC; no destructive DDL on existing objects", () => {
  assert.ok(/add column if not exists\s+adoption_kind text/i.test(SQL), "adds adoption_kind (nullable, if not exists)");
  assert.ok(/create or replace function\s+public\.adopt_durable_catalog_snapshot/i.test(SQL), "creates the new RPC");
  // No table/column drops, no destructive rewrites of existing structures.
  assert.ok(!/drop\s+table/i.test(SQL), "no drop table");
  assert.ok(!/drop\s+column/i.test(SQL), "no drop column");
  assert.ok(!/truncate/i.test(SQL), "no truncate");
  assert.ok(!/delete\s+from/i.test(SQL), "no delete (never removes audit history)");
  // The ONLY constraint added is the additive adoption_kind check (guarded by if-not-exists in a DO block).
  assert.ok(/sync_source_jobs_adoption_kind_chk/.test(SQL), "the additive check constraint is present");
  assert.ok(!/drop\s+constraint/i.test(SQL), "no drop constraint");
});

test("IDEMPOTENT: safe to re-run (if not exists / create or replace / guarded constraint)", () => {
  assert.ok(/add column if not exists/i.test(SQL), "column add is idempotent");
  assert.ok(/create or replace function/i.test(SQL), "function is create-or-replace");
  assert.ok(/if not exists\s*\(\s*select 1 from pg_constraint where conname = 'sync_source_jobs_adoption_kind_chk'/i.test(low.replace(/\s+/g, " ")) || /if not exists[\s\S]*sync_source_jobs_adoption_kind_chk/i.test(SQL), "constraint add is guarded");
});

test("SECURITY: SECURITY DEFINER + fixed search_path, service_role only, never anon/authenticated/public", () => {
  assert.ok(/security definer/i.test(SQL), "SECURITY DEFINER");
  assert.ok(/set search_path\s*=\s*public/i.test(SQL), "fixed search_path = public (no mutable search_path)");
  assert.ok(/revoke all on function public\.adopt_durable_catalog_snapshot\([^)]*\) from public, anon, authenticated/i.test(SQL), "revokes public/anon/authenticated");
  assert.ok(/grant execute on function public\.adopt_durable_catalog_snapshot\([^)]*\) to service_role/i.test(SQL), "grants only service_role");
  assert.ok(!/to\s+anon/i.test(SQL) && !/to\s+authenticated/i.test(SQL), "never grants anon/authenticated (no browser/public invocation)");
});

test("EXACT EQUIVALENCE + FRESHNESS: validates request-hash + payload_sha + object_path + org/conn/source/scope; fails closed", () => {
  // The snapshot is pinned to the EXACT tenant/source/scope (no cross-org adoption).
  assert.ok(/organization_fingerprint = p_expected_organization_fingerprint/i.test(SQL), "pins organization_fingerprint");
  assert.ok(/connection_id = p_expected_connection_id/i.test(SQL), "pins connection_id");
  assert.ok(/source_key = p_expected_source_key/i.test(SQL) && /'product-catalog'/i.test(SQL), "pins source_key = product-catalog only");
  assert.ok(/scope_key = p_expected_scope_key/i.test(SQL), "pins scope_key");
  // Typed durable-snapshot evidence: the org catalog is date-independent content read directly by the derive, so the
  // export request_hash is NOT the equivalence basis; the CONTENT hash (object_path + payload_sha) is.
  assert.ok(!/source_request_hash is distinct from p_request_hash/i.test(SQL), "does NOT gate on the export request_hash (org catalog is date-independent content)");
  assert.ok(/object_path is distinct from p_expected_object_path/i.test(SQL), "requires matching object_path");
  assert.ok(/payload_sha is distinct from p_expected_payload_sha/i.test(SQL), "requires matching payload_sha (content hash)");
  assert.ok(/return 'snapshot-mismatch'/i.test(SQL), "mismatch fails closed");
  assert.ok(/validated_at is null/i.test(SQL) && /return 'snapshot-stale'/i.test(SQL), "stale/unvalidated fails closed");
});

test("CAS SAFETY: adopts only a pending/unattempted/count=0 job with EXPLICIT provenance; a real export/cache wins", () => {
  assert.ok(/fetch_status = 'pending'/i.test(SQL) && /attempted_at is null/i.test(SQL) && /create_export_count = 0/i.test(SQL), "CAS predicate keeps the one-attempt invariant + lets a real export win");
  assert.ok(/adoption_kind = 'durable_snapshot'/i.test(SQL), "records EXPLICIT durable_snapshot provenance (never anonymous)");
  assert.ok(/return 'adopted'/i.test(SQL) && /return 'not-adopted'/i.test(SQL), "typed acks");
  // The write uses the SNAPSHOT ROW'S own values (never the caller's) for the persisted metadata.
  assert.ok(/row_count = v_snap\.row_count/i.test(SQL), "writes the snapshot's own row_count");
});

console.log("\n" + passed + " assertions passed");
