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
// The AUTHORITATIVE final correction (undoes 20260823): restores the <=5 multi-batch assign + variable-cost
// persist RPCs and DROPS the flat-2 constraint. Its proofs describe the runtime state.
const FLAT2REVERT = "20260824_revert_flat_token_batch.sql";
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

/* --- AUTHORITATIVE FINAL correction (20260824): the restored <=5 multi-batch assign + variable-cost persist +
      the dropped flat-2 constraint each fail closed when weakened (Codex req 5). --- */

test("final-cap-widened. weakening the restored hard <=5 cap in 20260824 => ASSIGN_LEGACY_CAP_MISSING", () => {
  const a = auditWith({ [FLAT2REVERT]: (t) => t.replace("least(greatest(coalesce(p_max, 5), 1), 5)", "least(greatest(coalesce(p_max, 5), 1), 6)") });
  assert.ok(!a.ok && hasBlocker(a, "ASSIGN_LEGACY_CAP_MISSING"), "ASSIGN_LEGACY_CAP_MISSING");
});

test("final-wrong-batch. a one-batch (hardcoded index 0) insert in 20260824 => ASSIGN_LEGACY_MULTIBATCH_MISSING", () => {
  const a = auditWith({ [FLAT2REVERT]: (t) => t.replace("(p_batch_family, p_account_id, v_index, p_connection_id, p_organization_fingerprint)", "(p_batch_family, p_account_id, 0, p_connection_id, p_organization_fingerprint)") });
  assert.ok(!a.ok && hasBlocker(a, "ASSIGN_LEGACY_MULTIBATCH_MISSING"), "ASSIGN_LEGACY_MULTIBATCH_MISSING");
});

test("final-flat2-not-dropped. failing to DROP the flat-2 constraint in 20260824 => STATEMENT_MISSING", () => {
  const a = auditWith({ [FLAT2REVERT]: (t) => t.replace("drop constraint if exists source_tranche_budget_hash_cost_flat2", "-- constraint left in place") });
  assert.ok(!a.ok && hasBlocker(a, "STATEMENT_MISSING"), "STATEMENT_MISSING (the flat-2 constraint must be dropped)");
});

test("final-flat2-guard-retained. re-introducing the flat-2 persist guard in 20260824 => PERSIST_VARIABLE_FLAT2_RETAINED", () => {
  const a = auditWith({ [FLAT2REVERT]: (t) => t.replace("return 'created';", "if (h->>'token_cost') is distinct from '2' then raise exception 'FLAT_TOKEN_COST_REQUIRED'; end if;\n  return 'created';") });
  assert.ok(!a.ok && hasBlocker(a, "PERSIST_VARIABLE_FLAT2_RETAINED"), "PERSIST_VARIABLE_FLAT2_RETAINED");
});

test("final-cost-hardcoded. hardcoding the per-hash token_cost (ignoring the variable 2|5) in 20260824 => PERSIST_VARIABLE_COST_PASSTHROUGH_MISSING", () => {
  const a = auditWith({ [FLAT2REVERT]: (t) => t.replace("(h->>'token_cost')::integer", "2::integer") });
  assert.ok(!a.ok && hasBlocker(a, "PERSIST_VARIABLE_COST_PASSTHROUGH_MISSING"), "PERSIST_VARIABLE_COST_PASSTHROUGH_MISSING");
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

// ---- Migration 9: operation-wide durable Catalog reservation -- weakening any guard is a typed blocker ----
const PRIORITY = "20260825_priority_catalog_reservation.sql";
const m9 = (mut, code, msg) => { const a = auditWith({ [PRIORITY]: mut }); assert.ok(!a.ok && hasBlocker(a, code), msg || code); };

test("m9-tokens-widened. widening tokens_check (0,2 -> 0,2,9) => NAMED_CONSTRAINT_MISSING", () => m9((t) => t.replace("tokens_spent in (0, 2)", "tokens_spent in (0, 2, 9)"), "NAMED_CONSTRAINT_MISSING"));
test("m9-status-widened. widening status_check => NAMED_CONSTRAINT_MISSING", () => m9((t) => t.replace("status in ('reserved', 'created')", "status in ('reserved', 'created', 'open')"), "NAMED_CONSTRAINT_MISSING"));
test("m9-coherent-weakened. AND->OR in the created-coherent check => NAMED_CONSTRAINT_MISSING", () => m9((t) => t.replace("export_id is null and tokens_spent = 0", "export_id is null or tokens_spent = 0"), "NAMED_CONSTRAINT_MISSING"));
test("m9-pk-renamed. renaming the operation-wide PK => NAMED_CONSTRAINT_MISSING", () => m9((t) => t.replace("source_priority_catalog_reservation_pk primary key", "source_priority_catalog_reservation_pk_renamed primary key"), "NAMED_CONSTRAINT_MISSING"));
test("m9-acl-widened. GRANT ALL to service_role => SERVICE_ROLE_GRANT_MISMATCH", () => m9((t) => t.replace("grant select on table public.source_priority_catalog_reservation to service_role", "grant all on table public.source_priority_catalog_reservation to service_role"), "SERVICE_ROLE_GRANT_MISMATCH"));
test("m9-authed-grant-missing. dropping authenticated SELECT (unreachable policy) => AUTH_GRANT_MISSING", () => m9((t) => t.replace("grant select on table public.source_priority_catalog_reservation to authenticated;\n", ""), "AUTH_GRANT_MISSING"));
test("m9-rls-off. RLS not enabled => RLS_NOT_ENABLED", () => m9((t) => t.replace("alter table public.source_priority_catalog_reservation enable row level security;", ""), "RLS_NOT_ENABLED"));
test("m9-policy-dropped. removing the admin-read policy => POLICY_MISSING", () => m9((t) => t.replace(/create policy source_priority_catalog_reservation_admin_read[\s\S]*?is_dashboard_admin\(\)\);/, ""), "POLICY_MISSING"));
test("m9-rpc-param-drift. a drifted reserve RPC param => RPC_PARAM_MISMATCH", () => m9((t) => t.replace("  p_operation_key text,\n  p_catalog_request_hash text\n)", "  p_operation_key text,\n  p_catalog_request_hash text,\n  p_extra text\n)"), "RPC_PARAM_MISMATCH"));
test("m9-reserve-no-advisory. removing the operation advisory lock in reserve => PRIORITY_RESERVE_ADVISORY_LOCK_MISSING", () => m9((t) => t.replace("  perform pg_advisory_xact_lock(hashtext(p_operation_key));\n", ""), "PRIORITY_RESERVE_ADVISORY_LOCK_MISSING"));
test("m9-reserve-no-hash-mismatch. breaking reserve's hash-mismatch detection => PRIORITY_RESERVE_HASH_MISMATCH_MISSING", () => m9((t) => t.replace("v_row.catalog_request_hash is distinct from p_catalog_request_hash", "false"), "PRIORITY_RESERVE_HASH_MISMATCH_MISSING"));
test("m9-reserve-delete. adding a delete/reset route in reserve => PRIORITY_RESERVE_HAS_DELETE", () => m9((t) => t.replace("  insert into public.source_priority_catalog_reservation (operation_key, catalog_request_hash)", "  delete from public.source_priority_catalog_reservation where operation_key = p_operation_key;\n  insert into public.source_priority_catalog_reservation (operation_key, catalog_request_hash)"), "PRIORITY_RESERVE_HAS_DELETE"));
test("m9-record-hash-mutable. making catalog_request_hash mutable in record => PRIORITY_RECORD_HASH_MUTABLE", () => m9((t) => t.replace("set export_id = p_export_id, status = 'created', tokens_spent = 2, updated_at = now()", "set export_id = p_export_id, status = 'created', tokens_spent = 2, catalog_request_hash = p_catalog_request_hash, updated_at = now()"), "PRIORITY_RECORD_HASH_MUTABLE"));
test("m9-wrapper-missing. removing the reservePriorityCatalogCreate wrapper => REQUIRED_WRAPPER_MISSING", () => { const a = auditWith({ [WRAP]: (t) => t.replace("export async function reservePriorityCatalogCreate", "async function reservePriorityCatalogCreate_removed") }); assert.ok(!a.ok && hasBlocker(a, "REQUIRED_WRAPPER_MISSING")); });

// ---- Migration 11: FUTURE-ONLY order-audit (amazon_order_id) -- weakening any invariant is a typed blocker ----
const ORDERAUDIT = "20260827_oli_order_audit.sql";
const m11 = (mut, code, msg) => { const a = auditWith({ [ORDERAUDIT]: mut }); assert.ok(!a.ok && hasBlocker(a, code), msg || code); };

test("m11-missing. a missing order-audit migration => MIGRATION_MISSING", () => { const a = auditWith({ [ORDERAUDIT]: null }); assert.ok(!a.ok && hasBlocker(a, "MIGRATION_MISSING")); });
test("m11-param-dropped. dropping p_order_rows from the replace RPC => RPC_PARAM_MISMATCH", () => m11((t) => t.replace("  p_source_refreshed_at timestamptz default now(),\n  p_order_rows jsonb default '[]'::jsonb\n)", "  p_source_refreshed_at timestamptz default now()\n)"), "RPC_PARAM_MISMATCH"));
test("m11-audit-insert-removed. removing the order-audit INSERT => REPLACE_OLI_AUDIT_INSERT_MISSING", () => m11((t) => t.replace("insert into public.source_oli_order_audit (", "insert into public.source_oli_order_audit_removed ("), "REPLACE_OLI_AUDIT_INSERT_MISSING"));
test("m11-audit-delete-removed. removing the windowed order-audit DELETE => REPLACE_OLI_AUDIT_DELETE_MISSING", () => m11((t) => t.replace("delete from public.source_oli_order_audit\n", "delete from public.source_oli_order_audit_x\n"), "REPLACE_OLI_AUDIT_DELETE_MISSING"));
test("m11-availability-forced. forcing order_id_available true (not derived) => REPLACE_OLI_AUDIT_AVAILABILITY_MISSING", () => m11((t) => t.replace("char_length(coalesce(btrim(o->>'amazon_order_id'), '')) > 0,", "true,"), "REPLACE_OLI_AUDIT_AVAILABILITY_MISSING"));
test("m11-hash-removed. removing the md5 surrogate key => REPLACE_OLI_AUDIT_HASH_MISSING", () => m11((t) => t.replace("md5(concat_ws('|',", "(concat_ws('|',"), "REPLACE_OLI_AUDIT_HASH_MISSING"));
test("m11-availability-check-weakened. weakening the order_id_available CHECK => NAMED_CONSTRAINT_MISSING", () => m11((t) => t.replace("order_id_available = (char_length(btrim(amazon_order_id)) > 0)", "order_id_available = order_id_available"), "NAMED_CONSTRAINT_MISSING"));
test("m11-pk-renamed. renaming the order-audit PK => NAMED_CONSTRAINT_MISSING", () => m11((t) => t.replace("source_oli_order_audit_pk\n    primary key", "source_oli_order_audit_pk_x\n    primary key"), "NAMED_CONSTRAINT_MISSING"));
test("m11-rls-off. RLS not enabled on the order-audit table => RLS_NOT_ENABLED", () => m11((t) => t.replace("alter table public.source_oli_order_audit enable row level security;", ""), "RLS_NOT_ENABLED"));
test("m11-acl-widened. GRANT ALL to service_role => SERVICE_ROLE_GRANT_MISMATCH (direct-write bypass forbidden)", () => m11((t) => t.replace("grant select on table public.source_oli_order_audit to service_role;", "grant all on table public.source_oli_order_audit to service_role;"), "SERVICE_ROLE_GRANT_MISMATCH"));
test("m11-revoke-missing. a missing REVOKE ALL on the order-audit table => SERVICE_ROLE_REVOKE_MISSING", () => m11((t) => t.replace("revoke all on table public.source_oli_order_audit from public, anon, authenticated, service_role;", ""), "SERVICE_ROLE_REVOKE_MISSING"));
test("m11-index-missing. a renamed required index => INDEX_MISSING", () => m11((t) => t.replace("source_oli_order_audit_account_date_idx", "source_oli_order_audit_account_date_idx_x"), "INDEX_MISSING"));
test("m11-wrapper-missing. removing the getExplicitZeroOliOrderAudit wrapper => REQUIRED_WRAPPER_MISSING", () => { const a = auditWith({ [WRAP]: (t) => t.replace("export async function getExplicitZeroOliOrderAudit", "async function getExplicitZeroOliOrderAudit_removed") }); assert.ok(!a.ok && hasBlocker(a, "REQUIRED_WRAPPER_MISSING")); });

let failures = 0;
for (const t of tests) {
  try { t.fn(); passed += 1; out("  ok  " + t.name); }
  catch (err) { failures += 1; out("FAIL  " + t.name); out(String(err && err.stack ? err.stack : err)); }
}
out("\n" + passed + " assertions passed");
if (failures) process.exitCode = 1;
