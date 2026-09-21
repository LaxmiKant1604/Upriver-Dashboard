// DR2 transactional-outbox migration guard: proves 20260932_report_publication_outbox.sql is ADDITIVE, IDEMPOTENT,
// RLS-safe (SECURITY DEFINER + fixed search_path + service_role-only, never browser/public), a TRUE transactional outbox
// (an AFTER trigger on source_coverage enqueues IN the persist transaction), FAIL-SOFT (never rolls back the persist),
// GATED (default OFF -> expand-first), and CONCURRENCY-SAFE (FOR UPDATE SKIP LOCKED lease claim + re-arm + dead-letter).
// Text-level assertions (no DB). 7-bit ASCII.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

let passed = 0;
const test = (name, fn) => { try { fn(); passed += 1; console.log("  ok  " + name); } catch (e) { console.log("FAIL  " + name); console.log(String(e && e.stack ? e.stack : e)); process.exitCode = 1; } };

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SQL = readFileSync(join(ROOT, "supabase/migrations/20260932_report_publication_outbox.sql"), "utf8");

test("ADDITIVE + IDEMPOTENT: new tables/trigger/RPCs only; no destructive DDL; re-runnable", () => {
  assert.ok(/create table if not exists public\.report_publication_outbox/i.test(SQL), "creates the outbox table (if not exists)");
  assert.ok(/create table if not exists public\.publication_outbox_control/i.test(SQL), "creates the gate table (if not exists)");
  assert.ok(/create or replace function public\.enqueue_report_publication_on_coverage/i.test(SQL), "the enqueue trigger fn");
  assert.ok(/create or replace function public\.claim_report_publication_outbox/i.test(SQL), "the claim RPC");
  assert.ok(/create or replace function public\.complete_report_publication_outbox/i.test(SQL), "the complete RPC");
  assert.ok(!/drop\s+table/i.test(SQL) && !/drop\s+column/i.test(SQL) && !/truncate/i.test(SQL) && !/delete\s+from/i.test(SQL), "no destructive DDL / row deletion");
  assert.ok(/create unique index if not exists|create index if not exists/i.test(SQL), "indexes are if-not-exists");
});

test("TRANSACTIONAL: an AFTER INSERT OR UPDATE trigger on source_coverage enqueues IN the persist transaction", () => {
  assert.ok(/after insert or update on public\.source_coverage/i.test(SQL), "trigger fires on the source_coverage write (which the persist RPC does in-transaction)");
  assert.ok(/for each row execute function public\.enqueue_report_publication_on_coverage/i.test(SQL), "row-level enqueue");
  assert.ok(/on conflict[\s\S]*do update set/i.test(SQL), "idempotent upsert (coalesces bursts into one live row)");
});

test("FAIL-SOFT: the enqueue is wrapped so any defect NEVER rolls back the persist", () => {
  assert.ok(/exception when others then[\s\S]*return null/i.test(SQL), "the trigger body catches ALL exceptions -> never propagates (never rolls back the durable OLI persist)");
});

test("GATED (expand-first): default OFF; only the OLI source; no-op until enabled", () => {
  assert.ok(/enabled boolean not null default false/i.test(SQL), "the gate defaults to false (nothing enqueues until explicitly enabled)");
  assert.ok(/if v_enabled is not true then return null/i.test(SQL), "the trigger no-ops while the gate is off");
  assert.ok(/NEW\.source_key <> 'order-line-items'/i.test(SQL) && /return null/i.test(SQL), "only order-line-items enqueues; other coverage writers unaffected");
});

test("CONCURRENCY-SAFE at-least-once: FOR UPDATE SKIP LOCKED lease claim + lease-expiry reclaim + dead-letter", () => {
  assert.ok(/for update skip locked/i.test(SQL), "SKIP LOCKED -> concurrency-safe claim");
  assert.ok(/status = 'claimed'.*claimed_at < now\(\) - make_interval/is.test(SQL) || /claimed_at < now\(\) - make_interval/i.test(SQL), "a crashed drainer's lease-expired rows are re-claimable");
  assert.ok(/attempts >= p_max_attempts/i.test(SQL) && /status = 'dead-letter'/i.test(SQL), "a poison row dead-letters after the attempt cap (isolated; never blocks the batch)");
});

test("RE-ARM + owner-fence: complete refuses a stale token and re-arms a newer persist", () => {
  assert.ok(/claim_token = p_claim_token and status = 'claimed'/i.test(SQL), "complete is owner-fenced by claim_token");
  assert.ok(/return 'not-owner'/i.test(SQL), "a non-owner/stale-token complete is refused");
  assert.ok(/v_req > p_done_as_of/i.test(SQL) && /return 're-armed'/i.test(SQL), "a persist newer than what was drained re-arms the row to pending (never lost)");
});

test("SECURITY: SECURITY DEFINER + fixed search_path, RLS on, service_role only, never anon/authenticated/public", () => {
  assert.ok((SQL.match(/security definer/gi) || []).length >= 3, "the trigger fn + claim + complete are all SECURITY DEFINER");
  assert.ok((SQL.match(/set search_path = public/gi) || []).length >= 3, "fixed search_path on every function");
  assert.ok(/alter table public\.report_publication_outbox enable row level security/i.test(SQL), "RLS on the outbox table");
  assert.ok(/revoke all on table public\.report_publication_outbox from public, anon, authenticated/i.test(SQL), "revokes table from public/anon/authenticated");
  assert.ok(/grant execute on function public\.claim_report_publication_outbox\([^)]*\) to service_role/i.test(SQL), "claim granted only to service_role");
  assert.ok(!/to\s+anon/i.test(SQL) && !/to\s+authenticated/i.test(SQL), "never grants anon/authenticated (no browser/public invocation)");
});

console.log("\n" + passed + " assertions passed");
