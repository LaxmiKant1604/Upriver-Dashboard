// Scheduler v2 -- schema-contract MUTATION proofs (senior review Finding 3, offline, ZERO network/DB).
//
// Proves the runtime preflight FAILS CLOSED when the two new 20260817 migrations or their wrappers are missing
// or WEAKENED: a missing migration, a drifted RPC signature, a removed RPC, a weakened least-privilege ACL, a
// missing REVOKE, a missing index, RLS not enabled, a dropped primary key, and a removed required wrapper each
// surface a TYPED audit blocker. The baseline (unmutated real files) must audit clean, so the mutations are the
// only cause of failure.

import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { auditSchemaContract } from "../lib/server/sync/schema-contract.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REUSE = "20260817_scheduler_v2_reuse_cas.sql";
const BATCH = "20260817_source_batch_membership.sql";
const BUDGET = "20260818_source_tranche_budget.sql";
// Forward migration 20260823 REPLACES the original <=5 assign RPC with the one-batch (unlimited-sellers) body,
// so the assign-batch BODY invariants are proven against THIS file (not the original 20260817 definition).
const FLAT2 = "20260823_source_batch_flat_token.sql";
const WRAP = "supabase.js";

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };

function realContent(name) {
  if (name === WRAP) return fs.readFileSync(join(ROOT, "lib/server/supabase.js"), "utf8");
  return fs.readFileSync(join(ROOT, "supabase/migrations", name), "utf8");
}
// mutations: { [name]: (text)=>newText | null }. A null value simulates a MISSING file.
function auditWith(mutations = {}) {
  const readFile = (name) => {
    if (Object.prototype.hasOwnProperty.call(mutations, name)) {
      const m = mutations[name];
      return m === null ? null : m(realContent(name));
    }
    return realContent(name);
  };
  return auditSchemaContract({ readFile });
}
const hasBlocker = (audit, code) => audit.blockers.some((b) => b.code === code);

test("baseline. the REAL committed migrations + wrappers audit CLEAN (so a mutation is the only failure cause)", () => {
  const a = auditWith({});
  assert.equal(a.ok, true, "audit ok");
  assert.equal(a.blockers.length, 0, "zero blockers on the real files");
  assert.equal(a.requiredWrappers.ok, true, "every required wrapper present");
});

test("missing-migration. a missing 20260817 reuse-CAS migration => MIGRATION_MISSING (fail closed)", () => {
  const a = auditWith({ [REUSE]: null });
  assert.ok(!a.ok && hasBlocker(a, "MIGRATION_MISSING"), "MIGRATION_MISSING");
});

test("rpc-drift. a drifted adopt_source_export_cache parameter => RPC_PARAM_MISMATCH", () => {
  const a = auditWith({ [REUSE]: (t) => t.split("p_expected_source_id").join("p_drifted_source_id") });
  assert.ok(!a.ok && hasBlocker(a, "RPC_PARAM_MISMATCH"), "RPC_PARAM_MISMATCH");
});

test("rpc-missing. a removed adopt_source_export_cache function => RPC_MISSING", () => {
  const a = auditWith({ [REUSE]: (t) => t.replace("function public.adopt_source_export_cache(", "function public.adopt_source_export_cache_removed(") });
  assert.ok(!a.ok && hasBlocker(a, "RPC_MISSING"), "RPC_MISSING");
});

test("acl-weakened. GRANT ALL (instead of SELECT) to service_role on source_batch_membership => SERVICE_ROLE_GRANT_MISMATCH (direct-write bypass forbidden)", () => {
  const a = auditWith({ [BATCH]: (t) => t.replace("grant select on table public.source_batch_membership to service_role", "grant all on table public.source_batch_membership to service_role") });
  assert.ok(!a.ok && hasBlocker(a, "SERVICE_ROLE_GRANT_MISMATCH"), "SERVICE_ROLE_GRANT_MISMATCH");
});

test("acl-revoke-missing. a missing REVOKE ALL ... FROM service_role => SERVICE_ROLE_REVOKE_MISSING", () => {
  const a = auditWith({ [BATCH]: (t) => t.replace("from public, anon, authenticated, service_role;", "from public, anon, authenticated;") });
  assert.ok(!a.ok && hasBlocker(a, "SERVICE_ROLE_REVOKE_MISSING"), "SERVICE_ROLE_REVOKE_MISSING");
});

test("index-missing. a renamed/absent required index => INDEX_MISSING", () => {
  const a = auditWith({ [BATCH]: (t) => t.split("source_batch_membership_family_idx").join("source_batch_membership_family_idx_gone") });
  assert.ok(!a.ok && hasBlocker(a, "INDEX_MISSING"), "INDEX_MISSING");
});

test("rls-missing. RLS not enabled on source_batch_membership => RLS_NOT_ENABLED", () => {
  const a = auditWith({ [BATCH]: (t) => t.replace("alter table public.source_batch_membership enable row level security;", "") });
  assert.ok(!a.ok && hasBlocker(a, "RLS_NOT_ENABLED"), "RLS_NOT_ENABLED");
});

test("pk-dropped. a renamed primary-key constraint => NAMED_CONSTRAINT_MISSING", () => {
  const a = auditWith({ [BATCH]: (t) => t.replace("source_batch_membership_pk primary key", "source_batch_membership_pk_renamed primary key") });
  assert.ok(!a.ok && hasBlocker(a, "NAMED_CONSTRAINT_MISSING"), "NAMED_CONSTRAINT_MISSING");
});

test("wrapper-missing. a removed adoptSourceExportCache wrapper => REQUIRED_WRAPPER_MISSING", () => {
  const a = auditWith({ [WRAP]: (t) => t.replace("export async function adoptSourceExportCache(", "export async function adoptSourceExportCacheGone(") });
  assert.ok(!a.ok && hasBlocker(a, "REQUIRED_WRAPPER_MISSING"), "REQUIRED_WRAPPER_MISSING");
});

/* --- senior review gap 4/5: STRUCTURAL index / trigger / RPC-body proofs each fail closed when weakened --- */

// Every mutation below WEAKENS a structural invariant the runtime preflight relies on; each must surface its
// OWN typed blocker (the preflight re-emits these as SCHEMA_<code> and refuses to turn on). The baseline test
// above already proves the REAL files carry ALL of these intact.

test("index-columns. a WRONG-column/order required index => INDEX_COLUMNS_MISMATCH (gap 4a)", () => {
  const a = auditWith({ [BATCH]: (t) => t.replace("(batch_family, batch_index)", "(batch_index, batch_family)") });
  assert.ok(!a.ok && hasBlocker(a, "INDEX_COLUMNS_MISMATCH"), "INDEX_COLUMNS_MISMATCH");
});

test("trigger-after. an AFTER (not BEFORE) touch trigger => TABLE_TRIGGER_INVALID (gap 4b)", () => {
  const a = auditWith({ [BATCH]: (t) => t.replace("source_batch_membership_touch before update", "source_batch_membership_touch after update") });
  assert.ok(!a.ok && hasBlocker(a, "TABLE_TRIGGER_INVALID"), "TABLE_TRIGGER_INVALID (AFTER)");
});

test("trigger-delete. a DELETE (not UPDATE) touch trigger => TABLE_TRIGGER_INVALID (gap 4b)", () => {
  const a = auditWith({ [BATCH]: (t) => t.replace("before update on public.source_batch_membership", "before delete on public.source_batch_membership") });
  assert.ok(!a.ok && hasBlocker(a, "TABLE_TRIGGER_INVALID"), "TABLE_TRIGGER_INVALID (DELETE)");
});

test("trigger-statement. a FOR EACH STATEMENT (not ROW) touch trigger => TABLE_TRIGGER_INVALID (gap 4b)", () => {
  const a = auditWith({ [BATCH]: (t) => t.replace("for each row execute function public.touch_updated_at", "for each statement execute function public.touch_updated_at") });
  assert.ok(!a.ok && hasBlocker(a, "TABLE_TRIGGER_INVALID"), "TABLE_TRIGGER_INVALID (STATEMENT)");
});

test("trigger-wrong-fn. a touch trigger executing the WRONG function => TABLE_TRIGGER_INVALID (gap 4b)", () => {
  const a = auditWith({ [BATCH]: (t) => t.replace("execute function public.touch_updated_at()", "execute function public.not_touch_updated_at()") });
  assert.ok(!a.ok && hasBlocker(a, "TABLE_TRIGGER_INVALID"), "TABLE_TRIGGER_INVALID (wrong function)");
});

test("adopt-no-lock. a removed FOR UPDATE cache-row lock => ADOPT_CACHE_ROW_LOCK_MISSING (gap 4c)", () => {
  const a = auditWith({ [REUSE]: (t) => t.replace("for update;", ";") });
  assert.ok(!a.ok && hasBlocker(a, "ADOPT_CACHE_ROW_LOCK_MISSING"), "ADOPT_CACHE_ROW_LOCK_MISSING");
});

test("adopt-no-expiry. a removed expiry gate => ADOPT_CACHE_EXPIRY_GATE_MISSING (gap 4c)", () => {
  const a = auditWith({ [REUSE]: (t) => t.replace("v_cache.expires_at <= now()", "false") });
  assert.ok(!a.ok && hasBlocker(a, "ADOPT_CACHE_EXPIRY_GATE_MISSING"), "ADOPT_CACHE_EXPIRY_GATE_MISSING");
});

test("adopt-no-identity. a removed identity/integrity comparison => ADOPT_CACHE_IDENTITY_CHECK_MISSING (gap 4c)", () => {
  const a = auditWith({ [REUSE]: (t) => t.replace("or v_cache.row_count is distinct from p_expected_row_count", "") });
  assert.ok(!a.ok && hasBlocker(a, "ADOPT_CACHE_IDENTITY_CHECK_MISSING"), "ADOPT_CACHE_IDENTITY_CHECK_MISSING");
});

test("assign-no-lock. a removed advisory lock in the one-batch RPC => ASSIGN_BATCH_ADVISORY_LOCK_MISSING", () => {
  const a = auditWith({ [FLAT2]: (t) => t.replace("perform pg_advisory_xact_lock(hashtext(p_batch_family));", "perform 1;") });
  assert.ok(!a.ok && hasBlocker(a, "ASSIGN_BATCH_ADVISORY_LOCK_MISSING"), "ASSIGN_BATCH_ADVISORY_LOCK_MISSING");
});

test("assign-stale-cap. RE-INTRODUCING the obsolete <=5 per-family cap => ASSIGN_BATCH_STALE_CAP", () => {
  // The forward migration DROPPED the least(greatest(coalesce(p_max,...))) cap; smuggling it back into the insert
  // (which would split one bucket into many exports) is caught by the body auditor.
  const a = auditWith({ [FLAT2]: (t) => t.replace("(p_batch_family, p_account_id, 0, p_connection_id, p_organization_fingerprint)", "(p_batch_family, p_account_id, least(greatest(coalesce(p_max, 5), 1), 5), p_connection_id, p_organization_fingerprint)") });
  assert.ok(!a.ok && hasBlocker(a, "ASSIGN_BATCH_STALE_CAP"), "ASSIGN_BATCH_STALE_CAP");
});

test("assign-not-single-batch. an insert that does NOT place the single canonical batch index 0 => ASSIGN_BATCH_NOT_SINGLE_BATCH", () => {
  const a = auditWith({ [FLAT2]: (t) => t.replace("(p_batch_family, p_account_id, 0, p_connection_id, p_organization_fingerprint)", "(p_batch_family, p_account_id, 1, p_connection_id, p_organization_fingerprint)") });
  assert.ok(!a.ok && hasBlocker(a, "ASSIGN_BATCH_NOT_SINGLE_BATCH"), "ASSIGN_BATCH_NOT_SINGLE_BATCH");
});

test("assign-no-scope-reject. a removed existing connection/organization scope rejection => ASSIGN_BATCH_SCOPE_MATCH_MISSING", () => {
  const a = auditWith({ [FLAT2]: (t) => t.replace("if v_conn is distinct from p_connection_id or v_org is distinct from p_organization_fingerprint then", "if false then") });
  assert.ok(!a.ok && hasBlocker(a, "ASSIGN_BATCH_SCOPE_MATCH_MISSING"), "ASSIGN_BATCH_SCOPE_MATCH_MISSING");
});

/* --- Blocker 4d: the frozen tranche budget + atomic pre-POST reservation RPC each fail closed when weakened --- */

test("reserve-no-lock. a removed budget FOR UPDATE lock => RESERVE_BUDGET_LOCK_MISSING (atomic reservation)", () => {
  const a = auditWith({ [BUDGET]: (t) => t.split("for update").join("") });
  assert.ok(!a.ok && hasBlocker(a, "RESERVE_BUDGET_LOCK_MISSING"), "RESERVE_BUDGET_LOCK_MISSING");
});

test("reserve-no-advisory. a removed per-(cycle,tranche) advisory lock => RESERVE_ADVISORY_LOCK_MISSING", () => {
  const a = auditWith({ [BUDGET]: (t) => t.split("perform pg_advisory_xact_lock(hashtext(p_cycle_id::text || '|' || p_tranche_key));").join("perform 1;") });
  assert.ok(!a.ok && hasBlocker(a, "RESERVE_ADVISORY_LOCK_MISSING"), "RESERVE_ADVISORY_LOCK_MISSING");
});

test("reserve-no-drift-check. a removed plan-fingerprint drift check => RESERVE_PLAN_FINGERPRINT_CHECK_MISSING", () => {
  const a = auditWith({ [BUDGET]: (t) => t.replace("v_budget.plan_fingerprint is distinct from p_plan_fingerprint", "false") });
  assert.ok(!a.ok && hasBlocker(a, "RESERVE_PLAN_FINGERPRINT_CHECK_MISSING"), "RESERVE_PLAN_FINGERPRINT_CHECK_MISSING");
});

test("reserve-no-membership. a removed request_hash membership proof => RESERVE_HASH_MEMBERSHIP_MISSING", () => {
  const a = auditWith({ [BUDGET]: (t) => t.replace("and request_hash = p_request_hash;", ";") });
  assert.ok(!a.ok && hasBlocker(a, "RESERVE_HASH_MEMBERSHIP_MISSING"), "RESERVE_HASH_MEMBERSHIP_MISSING");
});

test("reserve-no-ceiling. a removed token-ceiling check => RESERVE_CEILING_CHECK_MISSING", () => {
  const a = auditWith({ [BUDGET]: (t) => t.replace("v_budget.spent_tokens + v_cost > v_budget.max_tokens", "false") });
  assert.ok(!a.ok && hasBlocker(a, "RESERVE_CEILING_CHECK_MISSING"), "RESERVE_CEILING_CHECK_MISSING");
});

test("reserve-weak-claim. a widened create-count claim guard => RESERVE_JOB_CLAIM_MISSING (mutual exclusion lost)", () => {
  const a = auditWith({ [BUDGET]: (t) => t.replace("and create_export_count = 0", "and create_export_count >= 0") });
  assert.ok(!a.ok && hasBlocker(a, "RESERVE_JOB_CLAIM_MISSING"), "RESERVE_JOB_CLAIM_MISSING");
});

test("reserve-no-spend. a removed token reservation => RESERVE_SPEND_MISSING", () => {
  const a = auditWith({ [BUDGET]: (t) => t.replace("spent_tokens = spent_tokens + v_cost", "spent_tokens = spent_tokens") });
  assert.ok(!a.ok && hasBlocker(a, "RESERVE_SPEND_MISSING"), "RESERVE_SPEND_MISSING");
});

test("budget-cost-widened. a widened per-hash token cost (2,5 -> 2,5,9) => NAMED_CONSTRAINT_MISSING", () => {
  const a = auditWith({ [BUDGET]: (t) => t.replace("token_cost in (2, 5)", "token_cost in (2, 5, 9)") });
  assert.ok(!a.ok && hasBlocker(a, "NAMED_CONSTRAINT_MISSING"), "NAMED_CONSTRAINT_MISSING");
});

test("budget-index-columns. a wrong budget-hash index column set => INDEX_COLUMNS_MISMATCH", () => {
  const a = auditWith({ [BUDGET]: (t) => t.replace("source_tranche_budget_hash_budget_idx\n  on public.source_tranche_budget_hash (cycle_id, tranche_key)", "source_tranche_budget_hash_budget_idx\n  on public.source_tranche_budget_hash (request_hash, tranche_key)") });
  assert.ok(!a.ok && hasBlocker(a, "INDEX_COLUMNS_MISMATCH"), "INDEX_COLUMNS_MISMATCH");
});

let failures = 0;
for (const t of tests) {
  try { t.fn(); passed += 1; out("  ok  " + t.name); }
  catch (err) { failures += 1; out("FAIL  " + t.name); out(String(err && err.stack ? err.stack : err)); }
}
out("\n" + passed + " assertions passed");
if (failures) process.exitCode = 1;
