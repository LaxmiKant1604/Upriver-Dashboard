// FROZEN release manifest + SEMANTICALLY-EXACT catalog verification engine (Scheduler-v2 release).
// Reviewed contracts are explicit DATA (never regex-inferred at runtime). Constraint/index/policy bodies are
// compared as COMPLETE canonical expressions (AND/OR structure preserved); PK/FK prove exact ordered columns +
// referenced table/columns + on-delete/update; indexes prove ordered key columns + uniqueness + access method
// + predicate/include + no extras; triggers bind tgfoid to the exact function OID; ACLs enumerate via
// aclexplode (incl PG17 MAINTAIN). Every engine fn takes an injected async q(text,params); no credential.

// ---- APPROVED, REVIEWED, NON-SECRET release identity (blocker 5: exact host/port/db, not a substring) -----
export const APPROVED_IDENTITY = Object.freeze({
  projectRef: "cfmfunptwuwhcayajsrj",
  supabaseHost: "cfmfunptwuwhcayajsrj.supabase.co",
  pgHost: "aws-1-ap-south-1.pooler.supabase.com",
  pgPort: "6543",
  pgDatabase: "postgres",
});

// ---- APPROVED, PINNED production control state (blocker 3, from Appendix AI/AB) --------------------------
const APPROVED_ACCOUNT = "d658442d-6273-4c2d-aeda-f247e638ef98";
const ENABLED_REPORTS = ["brand-sales", "content-changes", "keyword-rank", "listing-optimizer"];
const ALL_REPORTS = ["brand-sales", "daily-reporting", "reconciliation", "fba-plan", "sku-pl", "keyword-rank", "content-changes", "sales-movers", "listing-health", "buy-box-loss", "returns-leakage", "ppc-performance", "listing-optimizer"];
export const APPROVED_INVARIANTS = Object.freeze({
  allPrimary: false,
  cronJobsTotal: 0, // Appendix AI proves NO cron -> require the TOTAL cron.job count to be zero.
  rolloutRows: [{ account_id: APPROVED_ACCOUNT, enabled: true }], // exactly one enabled row; nothing else.
  approvalRows: ENABLED_REPORTS.map((k) => ({ account_id: APPROVED_ACCOUNT, report_key: k, approved: true })), // exactly four approved rows.
  reportSyncSettings: ALL_REPORTS.map((k) => ({ report_key: k, schedule_enabled: ENABLED_REPORTS.includes(k) })), // exactly 13; 4 enabled, 9 disabled.
  // Blocker 3 / Phase 1D: the uniquely-matched dfca8f75 cycle row. The cycle-COLUMN report_total is 0 -- a
  // running cycle does not roll the report counter up until terminal, so its report_total column stays 0 even
  // though 8 child report jobs exist (that child count lives in dfca8f75Children.report.total below). The
  // earlier pin of 8 was a mis-encoding of the child count against the cycle column; corrected to 0 after the
  // read-only invariants pass proved the column is 0 (status=running => report_succeeded/failed 0, finished_at NULL).
  dfca8f75: { status: "running", source_total: 122, source_succeeded: 8, source_failed: 9, report_total: 0, report_succeeded: 0, report_failed: 0, finished_at: null },
  // Blocker 3: dfca8f75 durable CHILD state (queried by the uniquely-matched cycle id; Appendix AB).
  dfca8f75Children: {
    source: { total: 122, byStatus: { succeeded: 8, failed: 9, attempted: 4, pending: 101 }, maxCreateExport: 1, overCreateCount: 0 },
    report: { total: 8, pendingPending: 8 }, // all 8 derive_status=pending AND save_status=pending
  },
});

// Blocker 1/2: manifest-pinned protected digests, computed by the ESTABLISHED RUNBOOK algorithm (Appendix W):
//   md5( string_agg( md5(row::text), ',' ORDER BY natural_key ) )
// where, for report_snapshots, natural_key = report_key || '/' || account_id || '/' || params_hash.
// ALL EIGHT are pinned from the RECONCILED PASS read-only capture (2026-08-21; reconciliation-runner verdict
// RECONCILED PASS: contract 40/40, lineage 40/40, promo-audit byte-identical, invariants all pass; the earlier
// live/shadow Appendix-AI values 176/26 were superseded -- they predated legitimate growth and a runner
// mis-classification, both corrected). Stage 0 (ro-prod-check.mjs 0) re-captures these live and REQUIRES an
// exact 8/8 match; any drift => STOP (never a silent repin).
export const PROTECTED_DIGEST_KEYS = Object.freeze(["live_snapshots", "shadow_snapshots", "rollout", "mode", "approvals", "settings", "sync_cycles", "report_jobs"]);
export const PROTECTED_DIGESTS = Object.freeze({
  live_snapshots: { c: 183, h: "cf52240eac046339cc71878e3e6d1247" },
  shadow_snapshots: { c: 48, h: "1ff7d823030f021d6389603f673add84" },
  rollout: { c: 1, h: "1c85fedad9fde794305619c771a547bf" },
  mode: { c: 1, h: "b4ebf7ef96a797225eda8ff692d2c308" },
  approvals: { c: 4, h: "853ad5c6a619dab3f0ba41d43a62686d" },
  settings: { c: 13, h: "0638bc18cc428442b7b9e28a4a9d0aff" },
  sync_cycles: { c: 17, h: "29ad627c7fa6132edba061c5431f74dd" },
  report_jobs: { c: 191, h: "b63d32ae3ed2e5f75ab5ecff2150fe7a" },
});

export const BASELINE_VERSION = 3;

// ---- canonicalizer: pg body -> tight, formatting-independent token string (case-preserving) --------------
export function canonTight(s) {
  return String(s == null ? "" : s)
    .replace(/public\./g, "")
    .replace(/"/g, "")
    .replace(/::[A-Za-z0-9_ ]+(?:\[\])?/g, "")
    .replace(/=\s*ANY\s*\(\s*ARRAY\s*\[([^\]]*)\]\s*\)/gi, "in ($1)")
    .replace(/\s+/g, "")
    .replace(/[()]/g, "");
}
// The constraint BODY, with the leading type keyword removed, for exact expression comparison.
export function bodyCanon(def) { return canonTight(def).replace(/^(CHECK|PRIMARYKEY|FOREIGNKEY|UNIQUE)/i, ""); }
export function enumSet(canon, col) {
  const m = canon.match(new RegExp(col + "in([^;]*)$"));
  if (!m) return null;
  return new Set(m[1].split(",").map((v) => v.replace(/^'|'$/g, "")).filter((v) => v !== ""));
}
const norm = (s) => String(s == null ? "" : s).toLowerCase().replace(/\s+/g, " ").trim();
const setEq = (a, b) => { const A = [...new Set(a)].sort(), B = [...new Set(b)].sort(); return A.length === B.length && A.every((v, i) => v === B[i]); };
export const TYPE = { text: "text", int: "integer", bigint: "bigint", uuid: "uuid", bool: "boolean", tstz: "timestamp with time zone", date: "date", numeric: "numeric", jsonb: "jsonb" };

const TOUCH = (table) => ({ name: table + "_touch", table, tgtype: 19, enabled: "O", fnsig: "public.touch_updated_at()" });
const ADMIN_READ = (name, table) => ({ name, table, permissive: "PERMISSIVE", cmd: "SELECT", roles: ["authenticated"], using: "is_dashboard_admin()", withCheck: null });
const SR_READ = { service_role: ["SELECT"] };
const SR_RW = { service_role: ["SELECT", "INSERT", "UPDATE"], authenticated: ["SELECT"] };
const FN_SR = { service_role: ["EXECUTE"] };
// constraint helpers: exact canonical body (or an exact enum value set).
const CK = (name, canon) => [name, "c", { canon }];
const EN = (name, col, values) => [name, "c", { enum: { col, values } }];
const PK = (name, ...cols) => [name, "p", { cols }];
const FK = (name, canon) => [name, "f", { canon }];
const IX = (name, ...cols) => ({ name, cols, unique: false });

export const MIGRATIONS = [
  {
    file: "20260817_scheduler_v2_reuse_cas.sql", sha: "5f8e4092b50ef26b373dbb4f5a3bca6201f33503b85cd8120f255b8d30aa967e", adv: [20260817, 1], tables: [], alters: [],
    functions: [
      { sig: "public.adopt_source_export_cache(uuid, text, text, text, text, text, integer, bigint)", ret: "text", secdef: true, searchPath: "public", acl: FN_SR, createdNew: true },
      { sig: "public.claim_source_export_attempt(uuid, text)", ret: "boolean", secdef: true, searchPath: "public", acl: FN_SR, createdNew: false },
    ],
  },
  {
    file: "20260817_source_batch_membership.sql", sha: "aed01e1c0caaee12d31fb3922df79e8ac1adce11b02edf3ecc3b3b53a09ec5fb", adv: [20260817, 2],
    tables: [{
      name: "source_batch_membership",
      columns: [["batch_family", TYPE.text, true, null], ["account_id", TYPE.text, true, null], ["batch_index", TYPE.int, true, null], ["connection_id", TYPE.text, true, "'primary'::text"], ["organization_fingerprint", TYPE.text, true, null], ["created_at", TYPE.tstz, true, "now()"], ["updated_at", TYPE.tstz, true, "now()"]],
      constraints: [PK("source_batch_membership_pk", "batch_family", "account_id"), CK("source_batch_membership_batch_index_nonneg", "batch_index>=0"), EN("source_batch_membership_connection_id_check", "connection_id", ["primary", "dd-secondary"])],
      indexes: [IX("source_batch_membership_family_idx", "batch_family", "batch_index")],
      rls: true, policies: [ADMIN_READ("admins read source batch membership", "source_batch_membership")], triggers: [TOUCH("source_batch_membership")], acl: SR_READ,
    }],
    functions: [{ sig: "public.assign_source_account_batch(text, text, text, text, integer)", ret: "integer", secdef: true, searchPath: "public", acl: FN_SR, createdNew: true }],
    alters: [],
  },
  {
    file: "20260818_source_tranche_budget.sql", sha: "58506dbdccd48046f26b0507b1b54e10287ba34802f023ab10577f774a3eb4ba", adv: [20260818, 1],
    tables: [
      {
        name: "source_tranche_budget",
        columns: [["cycle_id", TYPE.uuid, true, null], ["tranche_key", TYPE.text, true, null], ["plan_fingerprint", TYPE.text, true, null], ["max_creates", TYPE.int, true, null], ["max_tokens", TYPE.int, true, null], ["spent_creates", TYPE.int, true, "0"], ["spent_tokens", TYPE.int, true, "0"], ["created_at", TYPE.tstz, true, "now()"], ["updated_at", TYPE.tstz, true, "now()"]],
        constraints: [PK("source_tranche_budget_pk", "cycle_id", "tranche_key"), CK("source_tranche_budget_fingerprint_nonblank", "char_lengthbtrimplan_fingerprint>0"), CK("source_tranche_budget_max_creates_nonneg", "max_creates>=0"), CK("source_tranche_budget_max_tokens_nonneg", "max_tokens>=0"), CK("source_tranche_budget_spent_creates_bounded", "spent_creates>=0ANDspent_creates<=max_creates"), CK("source_tranche_budget_spent_tokens_bounded", "spent_tokens>=0ANDspent_tokens<=max_tokens")],
        indexes: [], rls: true, policies: [ADMIN_READ("admins read source tranche budget", "source_tranche_budget")], triggers: [TOUCH("source_tranche_budget")], acl: SR_READ,
      },
      {
        name: "source_tranche_budget_hash",
        columns: [["cycle_id", TYPE.uuid, true, null], ["tranche_key", TYPE.text, true, null], ["request_hash", TYPE.text, true, null], ["token_cost", TYPE.int, true, null]],
        constraints: [PK("source_tranche_budget_hash_pk", "cycle_id", "tranche_key", "request_hash"), EN("source_tranche_budget_hash_cost_check", "token_cost", ["2", "5"]), FK("source_tranche_budget_hash_budget_fk", "cycle_id,tranche_keyREFERENCESsource_tranche_budgetcycle_id,tranche_key")],
        indexes: [IX("source_tranche_budget_hash_budget_idx", "cycle_id", "tranche_key")], rls: true, policies: [ADMIN_READ("admins read source tranche budget hash", "source_tranche_budget_hash")], triggers: [], acl: SR_READ,
      },
    ],
    functions: [
      { sig: "public.persist_source_tranche_budget(uuid, text, text, integer, integer, jsonb)", ret: "text", secdef: true, searchPath: "public", acl: FN_SR, createdNew: true },
      { sig: "public.reserve_source_export_create(uuid, text, text, text)", ret: "text", secdef: true, searchPath: "public", acl: FN_SR, createdNew: true },
    ],
    alters: [],
  },
  {
    file: "20260820_source_durable_model.sql", sha: "e7909f646b9d00aefefe550118aecd5cb174485f39962a5433b1da3467c5ffaa", adv: [20260820, 1],
    tables: [
      {
        name: "source_oli_daily_history",
        columns: [["organization_fingerprint", TYPE.text, true, null], ["connection_id", TYPE.text, true, "'primary'::text"], ["account_id", TYPE.text, true, null], ["seller_or_vendor_id", TYPE.text, true, null], ["sale_date", TYPE.date, true, null], ["sku", TYPE.text, true, null], ["child_asin", TYPE.text, true, null], ["currency", TYPE.text, true, null], ["sales_amount", TYPE.numeric, true, null], ["units", TYPE.numeric, true, null], ["source_request_hash", TYPE.text, true, null], ["created_at", TYPE.tstz, true, "now()"], ["updated_at", TYPE.tstz, true, "now()"]],
        constraints: [PK("source_oli_daily_history_pk", "organization_fingerprint", "connection_id", "account_id", "sale_date", "sku", "child_asin", "currency"), EN("source_oli_daily_history_connection_id_check", "connection_id", ["primary", "dd-secondary"]), CK("source_oli_daily_history_account_nonblank", "char_lengthbtrimaccount_id>0"), CK("source_oli_daily_history_seller_nonblank", "char_lengthbtrimseller_or_vendor_id>0"), CK("source_oli_daily_history_currency_check", "currency~'^[A-Z]{3}$'"), CK("source_oli_daily_history_hash_nonblank", "char_lengthbtrimsource_request_hash>0")],
        indexes: [IX("source_oli_daily_history_account_date_idx", "account_id", "sale_date"), IX("source_oli_daily_history_org_date_idx", "organization_fingerprint", "sale_date")], rls: true, policies: [], triggers: [TOUCH("source_oli_daily_history")], acl: SR_READ,
      },
      {
        name: "source_coverage",
        columns: [["organization_fingerprint", TYPE.text, true, null], ["connection_id", TYPE.text, true, "'primary'::text"], ["account_id", TYPE.text, true, null], ["source_key", TYPE.text, true, null], ["covered_from", TYPE.date, true, null], ["covered_to", TYPE.date, true, null], ["status", TYPE.text, true, "'succeeded'::text"], ["source_refreshed_at", TYPE.tstz, false, null], ["created_at", TYPE.tstz, true, "now()"], ["updated_at", TYPE.tstz, true, "now()"]],
        constraints: [PK("source_coverage_pk", "organization_fingerprint", "connection_id", "account_id", "source_key", "covered_from", "covered_to"), EN("source_coverage_connection_id_check", "connection_id", ["primary", "dd-secondary"]), CK("source_coverage_account_nonblank", "char_lengthbtrimaccount_id>0"), CK("source_coverage_source_key_nonblank", "char_lengthbtrimsource_key>0"), CK("source_coverage_status_check", "status='succeeded'"), CK("source_coverage_window_check", "covered_from<=covered_to")],
        indexes: [IX("source_coverage_lookup_idx", "account_id", "source_key", "covered_from")], rls: true, policies: [ADMIN_READ("source_coverage_admin_read", "source_coverage")], triggers: [TOUCH("source_coverage")], acl: SR_RW,
      },
      {
        name: "source_controls",
        columns: [["source_key", TYPE.text, true, null], ["paused", TYPE.bool, true, "false"], ["schedule_enabled", TYPE.bool, true, "false"], ["updated_by", TYPE.uuid, false, null], ["updated_at", TYPE.tstz, true, "now()"]],
        constraints: [PK("source_controls_pkey", "source_key"), CK("source_controls_source_key_nonblank", "char_lengthbtrimsource_key>0"), FK("source_controls_updated_by_fkey", "updated_byREFERENCESauth.usersidONDELETESETNULL")],
        indexes: [], rls: true, policies: [ADMIN_READ("source_controls_admin_read", "source_controls")], triggers: [TOUCH("source_controls")], acl: SR_RW,
        seed: { column: "source_key", exact: true, values: ["order-line-items", "product-catalog", "settlements", "returns", "profit-by-sku-date", "sales-traffic-asin-date", "listings", "listings-raw", "fba-inventory-health", "content-changes", "sqp-weekly", "sqp-monthly", "ads-campaign-date", "ads-asin-date", "ads-targeting-date", "ads-search-terms-date"], off: "paused = false and schedule_enabled = false" },
      },
      {
        name: "source_run_status",
        columns: [["source_key", TYPE.text, true, null], ["bucket", TYPE.text, true, null], ["last_status", TYPE.text, true, "'never'::text"], ["last_attempt_at", TYPE.tstz, false, null], ["last_success_at", TYPE.tstz, false, null], ["safe_error_code", TYPE.text, false, null], ["safe_error_stage", TYPE.text, false, null], ["covered_from", TYPE.date, false, null], ["covered_to", TYPE.date, false, null], ["accounts_completed", TYPE.int, true, "0"], ["accounts_failed", TYPE.int, true, "0"], ["accounts_total", TYPE.int, true, "0"], ["batch_count", TYPE.int, true, "0"], ["creates_spent", TYPE.int, true, "0"], ["tokens_spent", TYPE.int, true, "0"], ["creates_ceiling", TYPE.int, false, null], ["tokens_ceiling", TYPE.int, false, null], ["updated_at", TYPE.tstz, true, "now()"]],
        constraints: [PK("source_run_status_pk", "source_key", "bucket"), CK("source_run_status_source_key_nonblank", "char_lengthbtrimsource_key>0"), EN("source_run_status_bucket_check", "bucket", ["us", "non-us"]), EN("source_run_status_last_status_check", "last_status", ["never", "running", "succeeded", "partial", "failed", "paused"]), CK("source_run_status_accounts_completed_nonneg", "accounts_completed>=0"), CK("source_run_status_accounts_failed_nonneg", "accounts_failed>=0"), CK("source_run_status_accounts_total_nonneg", "accounts_total>=0"), CK("source_run_status_batch_count_nonneg", "batch_count>=0"), CK("source_run_status_creates_spent_nonneg", "creates_spent>=0"), CK("source_run_status_tokens_spent_nonneg", "tokens_spent>=0")],
        indexes: [], rls: true, policies: [ADMIN_READ("source_run_status_admin_read", "source_run_status")], triggers: [TOUCH("source_run_status")], acl: SR_RW,
      },
      {
        name: "source_snapshots",
        columns: [["organization_fingerprint", TYPE.text, true, null], ["connection_id", TYPE.text, true, "'primary'::text"], ["source_key", TYPE.text, true, null], ["scope_key", TYPE.text, true, null], ["object_path", TYPE.text, true, null], ["payload_sha", TYPE.text, true, null], ["row_count", TYPE.int, true, null], ["payload_bytes", TYPE.bigint, true, "0"], ["source_request_hash", TYPE.text, true, null], ["validated_at", TYPE.tstz, true, null], ["created_at", TYPE.tstz, true, "now()"], ["updated_at", TYPE.tstz, true, "now()"]],
        constraints: [PK("source_snapshots_pk", "organization_fingerprint", "connection_id", "source_key", "scope_key"), CK("source_snapshots_org_nonblank", "char_lengthbtrimorganization_fingerprint>0"), EN("source_snapshots_connection_id_check", "connection_id", ["primary", "dd-secondary"]), CK("source_snapshots_source_key_nonblank", "char_lengthbtrimsource_key>0"), CK("source_snapshots_scope_key_nonblank", "char_lengthbtrimscope_key>0"), CK("source_snapshots_object_path_nonblank", "char_lengthbtrimobject_path>0"), CK("source_snapshots_payload_sha_nonblank", "char_lengthbtrimpayload_sha>0"), CK("source_snapshots_row_count_nonneg", "row_count>=0"), CK("source_snapshots_payload_bytes_nonneg", "payload_bytes>=0"), CK("source_snapshots_hash_nonblank", "char_lengthbtrimsource_request_hash>0")],
        indexes: [], rls: true, policies: [], triggers: [TOUCH("source_snapshots")], acl: SR_READ,
      },
    ],
    functions: [
      { sig: "public.record_source_snapshot(text, text, text, text, text, text, integer, bigint, text, timestamp with time zone)", ret: "text", secdef: true, searchPath: "public", acl: FN_SR, createdNew: true },
      { sig: "public.replace_oli_history_window(text, text, text, date, date, jsonb, timestamp with time zone)", ret: "jsonb", secdef: true, searchPath: "public", acl: FN_SR, createdNew: true },
    ],
    // PostgreSQL serializes `position(':' in account_id)` as the SQL-standard operator form
    // `POSITION(':' IN account_id)` (operand order preserved: needle ':' IN haystack account_id) -- NOT the
    // strpos-style `position(account_id, ':')`. Pin that exact canonical representation (bodyCanon output).
    alters: [{ table: "source_batch_membership", addColumns: [], addConstraints: [CK("source_batch_membership_account_canonical", "account_id=btrimaccount_idANDchar_lengthaccount_id>0ANDPOSITION':'INaccount_id=0")] }],
  },
  {
    file: "20260821_source_promoted_publish_controls.sql", sha: "381a41ff607a7566b6fbeacb9598d629fe5d8defd4cec0bc8d0123ececbc4b3a", adv: [20260821, 1],
    tables: [{
      name: "source_promoted_publish_settings",
      columns: [["report_key", TYPE.text, true, null], ["publish_enabled", TYPE.bool, true, "false"], ["updated_by", TYPE.uuid, false, null], ["updated_at", TYPE.tstz, true, "now()"]],
      constraints: [PK("source_promoted_publish_settings_pkey", "report_key"), CK("source_promoted_publish_settings_report_key_nonblank", "char_lengthbtrimreport_key>0"), FK("source_promoted_publish_settings_updated_by_fkey", "updated_byREFERENCESauth.usersidONDELETESETNULL")],
      indexes: [], rls: true, policies: [ADMIN_READ("source_promoted_publish_settings_admin_read", "source_promoted_publish_settings")], triggers: [TOUCH("source_promoted_publish_settings")], acl: SR_RW,
      seed: { column: "report_key", exact: true, values: ["brand-inventory"], off: "publish_enabled = false" },
    }],
    functions: [], alters: [],
  },
  {
    file: "20260822_report_derive_lease.sql", sha: "6e315413ba8fc0cf33216fd546b124c97dc3c497be150b949a34eb23be3bbaa0", adv: [20260822, 1], tables: [],
    functions: [
      { sig: "public.claim_report_derive_lease(uuid, text, text, integer)", ret: "jsonb", secdef: true, searchPath: "public", acl: FN_SR, createdNew: true },
      { sig: "public.reconcile_report_derive_success(uuid, text, text, text, uuid, date)", ret: "jsonb", secdef: true, searchPath: "public", acl: FN_SR, createdNew: true },
      { sig: "public.cas_report_snapshot_if_newer(text, text, text, jsonb, jsonb, text, bigint, timestamp with time zone)", ret: "jsonb", secdef: true, searchPath: "public", acl: FN_SR, createdNew: true },
    ],
    alters: [{ table: "sync_report_jobs", addColumns: [["derive_lease_token", TYPE.uuid, false, null], ["derive_lease_expires_at", TYPE.tstz, false, null], ["derive_attempt_count", TYPE.int, true, "0"]], addConstraints: [] }],
  },
  {
    // Forward correction: one-batch-per-family assignment (REPLACES the 20260817 <=5 assign RPC) + DB-enforced
    // flat 2-token cost (an ADDITIVE named constraint on the 20260818 source_tranche_budget_hash table + a
    // hardened persist RPC). Both functions are createdNew:false (replaced, not created); the flat-2 constraint
    // is a later ALTER-added constraint (auto-registered in ALTER_ADDED_CONSTRAINTS -> a stage-7-due extra on
    // source_tranche_budget_hash, so migration 3's recorded catalog is NOT weakened). Function BODIES are proven
    // by schema-contract; the manifest proves signatures/ACL + the added constraint.
    file: "20260823_source_batch_flat_token.sql", sha: "310d4b1750c91224567abb0daf0d4ed2c7c7493c3028300ca944e7b7a7bac4c7", adv: [20260823, 1], tables: [],
    functions: [
      { sig: "public.assign_source_account_batch(text, text, text, text, integer)", ret: "integer", secdef: true, searchPath: "public", acl: FN_SR, createdNew: false },
      { sig: "public.persist_source_tranche_budget(uuid, text, text, integer, integer, jsonb)", ret: "text", secdef: true, searchPath: "public", acl: FN_SR, createdNew: false },
    ],
    alters: [{ table: "source_tranche_budget_hash", addColumns: [], addConstraints: [CK("source_tranche_budget_hash_cost_flat2", "token_cost=2")] }],
  },
  {
    // FORWARD CORRECTION of 20260823. DataDoe hard-caps sellerOrVendorIds at 5/export and prices standard=2/
    // premium=5 (both empirically confirmed 2026-08-22); the unlimited-batch/flat-2 model was false. This
    // migration DROPS the flat-2 token constraint (the permissive (2,5) constraint from 20260818 remains) and
    // restores the <=5 multi-batch assign RPC (20260817 body) + the variable-cost persist RPC (20260818 body).
    // Both functions predate 20260823 (createdNew:false); function BODIES are proven by schema-contract, the
    // manifest proves signatures/ACL + that the flat-2 constraint is DROPPED (a later ALTER-removed constraint).
    file: "20260824_revert_flat_token_batch.sql", sha: "da17dd1ff7e586b90a0467b33f5f374e93669e6f233f2c55721349ddf68e03ef", adv: [20260824, 1], tables: [],
    functions: [
      { sig: "public.assign_source_account_batch(text, text, text, text, integer)", ret: "integer", secdef: true, searchPath: "public", acl: FN_SR, createdNew: false },
      { sig: "public.persist_source_tranche_budget(uuid, text, text, integer, integer, jsonb)", ret: "text", secdef: true, searchPath: "public", acl: FN_SR, createdNew: false },
    ],
    alters: [{ table: "source_tranche_budget_hash", addColumns: [], addConstraints: [], dropConstraints: ["source_tranche_budget_hash_cost_flat2"] }],
  },
];

export const NEW6 = MIGRATIONS.map((m) => m.file);

// Stage-aware CUMULATIVE constraint model: a constraint that a LATER migration's ALTER adds to a table an
// EARLIER migration created (here: source_batch_membership_account_canonical, owned by 20260820, on
// source_batch_membership which 20260817 created). verifyTable(the earlier table) must EXPECT that constraint
// once its OWNING migration is applied (ownerIndex < stage) and REJECT it before (premature). The owning
// migration's ALTER check still validates the constraint's exact kind + complete body. This is NOT a blanket
// "allow any extra": only these explicitly-owned constraints are permitted, and only at/after their owner stage.
export const ALTER_ADDED_CONSTRAINTS = Object.freeze(
  MIGRATIONS.flatMap((mig, i) => (mig.alters || []).flatMap((alt) => (alt.addConstraints || []).map(([name]) => Object.freeze({ table: alt.table, name, ownerIndex: i })))),
);
// A LATER migration may DROP an ALTER-added constraint (here: 20260824 drops source_tranche_budget_hash_cost_flat2
// that 20260823 added). Such a constraint is present ONLY for stages in [ownerIndex+1 .. dropIndex]; once the
// dropping migration is applied (dropIndex < stage) it must be ABSENT again.
export const ALTER_DROPPED_CONSTRAINTS = Object.freeze(
  MIGRATIONS.flatMap((mig, i) => (mig.alters || []).flatMap((alt) => (alt.dropConstraints || []).map((name) => Object.freeze({ table: alt.table, name, dropIndex: i })))),
);
// The set of (table, constraint) an APPLIED prefix through `stage` has DROPPED (dropIndex < stage).
export function cumulativeDroppedConstraints(stage) {
  return ALTER_DROPPED_CONSTRAINTS.filter((d) => d.dropIndex < stage).map((d) => ({ table: d.table, name: d.name }));
}
// The exact extra-constraint names per table that MUST be present at `stage` (owning migration applied AND not
// yet dropped by a later applied migration).
export function cumulativeAlterConstraints(stage) {
  const byTable = {};
  const dropped = cumulativeDroppedConstraints(stage);
  for (const c of ALTER_ADDED_CONSTRAINTS) {
    if (c.ownerIndex >= stage) continue;
    if (dropped.some((d) => d.table === c.table && d.name === c.name)) continue;
    (byTable[c.table] = byTable[c.table] || []).push(c.name);
  }
  return byTable;
}
// Pre-existing tables ALTERED by these migrations (blocker 3): digest a projection EXCLUDING the added columns.
export const ALTERED_TABLE_PROJECTIONS = Object.freeze({ sync_report_jobs: ["derive_lease_token", "derive_lease_expires_at", "derive_attempt_count"] });
export const BASELINE = Object.freeze(["20260728_shared_dashboard.sql", "20260729_automated_ads_sync.sql", "20260729_dashboard_auth_and_access.sql", "20260803_fx_rate_cache.sql", "20260805_scheduled_sync.sql", "20260806_shared_source_export_cache.sql", "20260807_scheduler_v2.sql", "20260810_ads_sync_coverage.sql", "20260810_report_sync_controls.sql", "20260811_sync_source_job_owners.sql", "20260815_sync_cycle_finalize.sql", "20260816_account_rollout.sql"]);

// ---- identity: pinned APPROVED ref/host/port/db (EXACT) + Postgres username ref cross-check ---------------
export function validateIdentity(env) {
  const problems = [];
  let supaHost = null, supaRef = null, pgHost = null, pgPort = null, pgDb = null, pgUserRef = null;
  try { supaHost = new URL(env.SUPABASE_URL || "").host; supaRef = supaHost.split(".")[0]; } catch { problems.push("SUPABASE_URL blank/unparseable"); }
  try {
    const p = new URL(env.POSTGRES_URL || ""); pgHost = p.hostname; pgPort = p.port; pgDb = p.pathname.replace(/^\//, "");
    const um = decodeURIComponent(p.username || "").match(/^postgres\.([a-z0-9]{16,})$/i);
    pgUserRef = um ? um[1] : null;
  } catch { problems.push("POSTGRES_URL blank/unparseable"); }
  if (supaRef !== APPROVED_IDENTITY.projectRef) problems.push(`SUPABASE_URL ref ${supaRef} != approved`);
  if (supaHost && supaHost !== APPROVED_IDENTITY.supabaseHost) problems.push(`SUPABASE_URL host ${supaHost} != approved`);
  if (pgHost !== APPROVED_IDENTITY.pgHost) problems.push(`Postgres host ${pgHost} != approved ${APPROVED_IDENTITY.pgHost}`);
  if (pgPort !== APPROVED_IDENTITY.pgPort) problems.push(`Postgres port ${pgPort} != approved ${APPROVED_IDENTITY.pgPort}`);
  if (pgDb !== APPROVED_IDENTITY.pgDatabase) problems.push(`Postgres db ${pgDb} != approved ${APPROVED_IDENTITY.pgDatabase}`);
  if (pgUserRef == null || pgUserRef.toLowerCase() !== APPROVED_IDENTITY.projectRef) problems.push(`Postgres user ref ${pgUserRef} != approved`);
  return { ok: problems.length === 0, projectRef: APPROVED_IDENTITY.projectRef, supaHost, pgHost, pgPort, problems };
}

// ---- catalog query helpers ------------------------------------------------------------------------------
async function rows(q, text, params) { const r = await q(text, params || []); return r && r.rows ? r.rows : []; }
async function one(q, text, params) { const r = await rows(q, text, params); return r[0] || null; }
async function tableExists(q, name) { const r = await one(q, "select to_regclass($1) r", [`public.${name}`]); return !!(r && r.r); }
async function funcExists(q, sig) { const r = await one(q, "select to_regprocedure($1) r", [sig]); return !!(r && r.r); }
// NOTE: `$1::regclass` throws 42P01 when the table is absent, so guard with to_regclass first (a not-yet-
// created altered table -- e.g. source_batch_membership before M2 -- must resolve to "absent", not crash).
async function columnExists(q, table, col) { if (!(await tableExists(q, table))) return false; return !!(await one(q, "select 1 from pg_attribute where attrelid=$1::regclass and attname=$2 and attnum>0 and not attisdropped", [`public.${table}`, col])); }
async function constraintExists(q, table, name) { if (!(await tableExists(q, table))) return false; return !!(await one(q, "select 1 from pg_constraint where conrelid=$1::regclass and conname=$2", [`public.${table}`, name])); }

function checkConstraint(P, table, name, kind, def, spec) {
  if (spec.enum) { const s = enumSet(canonTight(def), spec.enum.col); if (!s) P.push(`${table} ${name}: no value set for ${spec.enum.col}`); else if (!setEq([...s], spec.enum.values)) P.push(`${table} ${name} values {${[...s]}} != {${spec.enum.values}}`); return; }
  const want = spec.canon != null ? spec.canon : (spec.cols || []).join(","); // PK canon = ordered cols
  if (bodyCanon(def) !== want) P.push(`${table} ${name} body "${bodyCanon(def)}" != "${want}"`);
}

export async function verifyTable(q, t, extraConstraints = []) {
  const P = [];
  if (!(await tableExists(q, t.name))) return [`table public.${t.name} absent`];
  const cols = await rows(q, `select a.attname, format_type(a.atttypid,a.atttypmod) typ, a.attnotnull nn, pg_get_expr(ad.adbin, ad.adrelid) def from pg_attribute a left join pg_attrdef ad on ad.adrelid=a.attrelid and ad.adnum=a.attnum where a.attrelid=$1::regclass and a.attnum>0 and not a.attisdropped order by a.attnum`, [`public.${t.name}`]);
  if (cols.length !== t.columns.length) P.push(`${t.name} has ${cols.length} columns, expected ${t.columns.length}`);
  for (let i = 0; i < t.columns.length; i++) {
    const [name, type, notnull, def] = t.columns[i]; const c = cols[i];
    if (!c) { P.push(`${t.name} missing column ${name} at ${i + 1}`); continue; }
    if (c.attname !== name) P.push(`${t.name} column ${i + 1} is ${c.attname}, expected ${name}`);
    if (norm(c.typ) !== norm(type)) P.push(`${t.name}.${name} type ${c.typ} != ${type}`);
    if (!!c.nn !== !!notnull) P.push(`${t.name}.${name} notnull ${c.nn} != ${notnull}`);
    if (def == null) { if (c.def != null) P.push(`${t.name}.${name} unexpected default ${c.def}`); }
    else if (canonTight(c.def) !== canonTight(def)) P.push(`${t.name}.${name} default ${c.def} != ${def}`);
  }
  const cons = await rows(q, "select conname, contype, pg_get_constraintdef(oid) def from pg_constraint where conrelid=$1::regclass", [`public.${t.name}`]);
  // Exact CUMULATIVE set: the table's own constraints PLUS the stage-due ALTER-added constraints (extraConstraints).
  // A missing base OR missing due-extra fails; any unknown extra (incl. a premature ALTER-added one) fails.
  const expectConstraintNames = [...t.constraints.map((x) => x[0]), ...extraConstraints];
  if (!setEq(cons.map((c) => c.conname), expectConstraintNames)) P.push(`${t.name} constraint set {${cons.map((c) => c.conname).sort()}} != {${expectConstraintNames.slice().sort()}}`);
  const conByName = new Map(cons.map((c) => [c.conname, c]));
  for (const [name, kind, spec] of t.constraints) {
    const c = conByName.get(name); if (!c) { P.push(`${t.name} constraint ${name} missing`); continue; }
    if (c.contype !== kind) P.push(`${t.name} constraint ${name} kind ${c.contype} != ${kind}`);
    checkConstraint(P, t.name, name, kind, c.def, spec);
  }
  P.push(...await verifyIndexes(q, t));
  const rls = await one(q, "select relrowsecurity r from pg_class where oid=$1::regclass", [`public.${t.name}`]);
  if (!!(rls && rls.r) !== !!t.rls) P.push(`${t.name} rls ${rls && rls.r} != ${t.rls}`);
  P.push(...await verifyPolicies(q, t.name, t.policies || []));
  P.push(...await verifyTriggers(q, t.name, t.triggers || []));
  P.push(...await verifyTableAcl(q, t.name, t.acl));
  if (t.seed) P.push(...await verifySeed(q, t.name, t.seed));
  return P;
}

// Indexes: exact set (explicit + constraint-backed), each proven by full canonical indexdef (ordered columns,
// uniqueness, access method, predicate/include).
export async function verifyIndexes(q, t) {
  const P = [];
  const idx = await rows(q, "select indexname, indexdef from pg_indexes where schemaname='public' and tablename=$1", [t.name]);
  const expect = [
    ...(t.indexes || []).map((e) => ({ name: e.name, cols: e.cols, unique: false })),
    ...t.constraints.filter((x) => x[1] === "p" || x[1] === "u").map((x) => ({ name: x[0], cols: x[2].cols, unique: true })),
  ];
  if (!setEq(idx.map((i) => i.indexname), expect.map((e) => e.name))) P.push(`${t.name} index set {${idx.map((i) => i.indexname).sort()}} != {${expect.map((e) => e.name).sort()}}`);
  const byName = new Map(idx.map((i) => [i.indexname, i]));
  for (const e of expect) {
    const live = byName.get(e.name); if (!live) { P.push(`${t.name} index ${e.name} missing`); continue; }
    const want = canonTight(`CREATE ${e.unique ? "UNIQUE " : ""}INDEX ${e.name} ON public.${t.name} USING btree (${e.cols.join(", ")})`);
    if (canonTight(live.indexdef) !== want) P.push(`${t.name} index ${e.name} def "${live.indexdef}" != expected (ordered cols/uniqueness/am/predicate)`);
  }
  return P;
}

// Policies: exact set + complete canonical USING and WITH CHECK (an OR-true weakening changes the canon).
export async function verifyPolicies(q, table, expected) {
  const P = [];
  const pol = await rows(q, "select policyname, permissive, cmd, roles, qual, with_check from pg_policies where schemaname='public' and tablename=$1", [table]);
  if (!setEq(pol.map((p) => p.policyname), expected.map((e) => e.name))) P.push(`${table} policy set {${pol.map((p) => p.policyname).sort()}} != {${expected.map((e) => e.name).sort()}}`);
  const byName = new Map(pol.map((p) => [p.policyname, p]));
  for (const e of expected) {
    const p = byName.get(e.name); if (!p) { P.push(`${table} policy ${e.name} missing`); continue; }
    if (norm(p.permissive) !== norm(e.permissive)) P.push(`${table} policy ${e.name} permissive ${p.permissive} != ${e.permissive}`);
    if (norm(p.cmd) !== norm(e.cmd)) P.push(`${table} policy ${e.name} cmd ${p.cmd} != ${e.cmd}`);
    const roles = Array.isArray(p.roles) ? p.roles : String(p.roles || "").replace(/[{}]/g, "").split(",").filter(Boolean);
    if (!setEq(roles, e.roles)) P.push(`${table} policy ${e.name} roles {${roles}} != {${e.roles}}`);
    if (canonTight(p.qual) !== canonTight(e.using)) P.push(`${table} policy ${e.name} USING "${p.qual}" != "${e.using}"`);
    const wc = p.with_check == null ? null : canonTight(p.with_check);
    const ewc = e.withCheck == null ? null : canonTight(e.withCheck);
    if (wc !== ewc) P.push(`${table} policy ${e.name} WITH CHECK ${p.with_check} != ${e.withCheck}`);
  }
  return P;
}

// Triggers: exact set; each bound to tgfoid == to_regprocedure(exact fn signature)::oid.
export async function verifyTriggers(q, table, expected) {
  const P = [];
  const trg = await rows(q, "select t.tgname from pg_trigger t where not t.tgisinternal and t.tgrelid=$1::regclass", [`public.${table}`]);
  if (!setEq(trg.map((x) => x.tgname), expected.map((e) => e.name))) P.push(`${table} trigger set {${trg.map((x) => x.tgname).sort()}} != {${expected.map((e) => e.name).sort()}}`);
  for (const e of expected) {
    const r = await one(q, "select t.tgtype, t.tgenabled, (t.tgfoid = to_regprocedure($3)::oid) fn_ok from pg_trigger t where not t.tgisinternal and t.tgrelid=$1::regclass and t.tgname=$2", [`public.${e.table}`, e.name, e.fnsig]);
    if (!r) { P.push(`${table} trigger ${e.name} missing`); continue; }
    if (Number(r.tgtype) !== e.tgtype) P.push(`${table} trigger ${e.name} tgtype ${r.tgtype} != ${e.tgtype}`);
    if (r.tgenabled !== e.enabled) P.push(`${table} trigger ${e.name} enabled ${r.tgenabled} != ${e.enabled}`);
    if (r.fn_ok !== true) P.push(`${table} trigger ${e.name} tgfoid != ${e.fnsig}`);
  }
  return P;
}

export async function verifyTableAcl(q, table, expected) {
  const P = [];
  const owner = await one(q, "select r.rolname o from pg_class c join pg_roles r on r.oid=c.relowner where c.oid=$1::regclass", [`public.${table}`]);
  const ownerName = owner ? owner.o : null;
  const acl = await rows(q, "select coalesce(r.rolname,'PUBLIC') grantee, a.privilege_type priv from pg_class c, aclexplode(c.relacl) a left join pg_roles r on r.oid=a.grantee where c.oid=$1::regclass", [`public.${table}`]);
  const byGrantee = new Map();
  for (const g of acl) { if (g.grantee === ownerName) continue; if (!byGrantee.has(g.grantee)) byGrantee.set(g.grantee, []); byGrantee.get(g.grantee).push(g.priv.toUpperCase()); }
  for (const [grantee, verbs] of byGrantee) {
    if (!Object.prototype.hasOwnProperty.call(expected, grantee)) { P.push(`${table} ACL: unexpected grantee ${grantee} (${verbs})`); continue; }
    if (!setEq(verbs, expected[grantee])) P.push(`${table} ACL: ${grantee} verbs {${verbs}} != {${expected[grantee]}}`);
  }
  for (const grantee of Object.keys(expected)) if (!byGrantee.has(grantee)) P.push(`${table} ACL: ${grantee} missing`);
  return P;
}

export async function verifyFunction(q, fn) {
  const meta = await one(q, "select p.oid, p.prosecdef sd, p.proconfig cfg, pg_get_function_result(p.oid) ret, r.rolname owner, (p.proacl is null) noacl from pg_proc p join pg_roles r on r.oid=p.proowner where p.oid = to_regprocedure($1)", [fn.sig]);
  if (!meta) return [`function ${fn.sig} absent`];
  const P = [];
  if (!!meta.sd !== !!fn.secdef) P.push(`${fn.sig} security definer ${meta.sd} != ${fn.secdef}`);
  const cfg = Array.isArray(meta.cfg) ? meta.cfg : [];
  if (!cfg.some((c) => norm(c) === `search_path=${fn.searchPath}`)) P.push(`${fn.sig} search_path ${JSON.stringify(cfg)} != ${fn.searchPath}`);
  if (fn.ret && norm(meta.ret) !== norm(fn.ret)) P.push(`${fn.sig} return ${meta.ret} != ${fn.ret}`);
  if (meta.noacl) { P.push(`${fn.sig} has DEFAULT acl (PUBLIC EXECUTE)`); return P; }
  const acl = await rows(q, "select coalesce(r.rolname,'PUBLIC') grantee, a.privilege_type priv from pg_proc p, aclexplode(p.proacl) a left join pg_roles r on r.oid=a.grantee where p.oid = to_regprocedure($1)", [fn.sig]);
  const nonOwner = acl.filter((g) => g.grantee !== meta.owner);
  if (!nonOwner.some((g) => g.grantee === "service_role" && g.priv.toUpperCase() === "EXECUTE")) P.push(`${fn.sig} service_role EXECUTE missing`);
  for (const g of nonOwner) if (g.grantee !== "service_role") P.push(`${fn.sig} ACL: unexpected grantee ${g.grantee}`);
  return P;
}

async function verifySeed(q, table, seed) {
  const P = [];
  const all = await rows(q, `select ${seed.column} k from public.${table}`, []);
  if (seed.exact && !setEq(all.map((r) => r.k), seed.values)) P.push(`${table} seed set != expected`);
  const have = new Set(all.map((r) => r.k));
  for (const v of seed.values) if (!have.has(v)) P.push(`${table} seed row ${v} missing`);
  if (seed.off) { const bad = await one(q, `select count(*)::int c from public.${table} where ${seed.column} = any($1) and not (${seed.off})`, [seed.values]); if (bad && Number(bad.c) > 0) P.push(`${table} seed not default-off (${bad.c})`); }
  return P;
}

export async function verifyMigrationPresent(q, mig, extraConstraintsByTable = {}, droppedConstraints = []) {
  const P = [];
  const isDropped = (table, name) => droppedConstraints.some((d) => d.table === table && d.name === name);
  for (const t of mig.tables) P.push(...await verifyTable(q, t, extraConstraintsByTable[t.name] || []));
  for (const fn of mig.functions) P.push(...await verifyFunction(q, fn));
  for (const alt of mig.alters || []) {
    for (const [name, type, notnull, def] of alt.addColumns || []) {
      if (!(await columnExists(q, alt.table, name))) { P.push(`${alt.table}.${name} column absent`); continue; }
      const c = await one(q, "select format_type(atttypid,atttypmod) typ, attnotnull nn, pg_get_expr(d.adbin,d.adrelid) def from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum where a.attrelid=$1::regclass and a.attname=$2", [`public.${alt.table}`, name]);
      if (c && norm(c.typ) !== norm(type)) P.push(`${alt.table}.${name} type ${c.typ} != ${type}`);
      if (c && !!c.nn !== !!notnull) P.push(`${alt.table}.${name} notnull ${c.nn} != ${notnull}`);
      if (def == null) { if (c && c.def != null) P.push(`${alt.table}.${name} unexpected default ${c.def}`); }
      else if (c && canonTight(c.def) !== canonTight(def)) P.push(`${alt.table}.${name} default ${c.def} != ${def}`);
    }
    for (const [cname, kind, spec] of alt.addConstraints || []) {
      // A constraint this migration added but a LATER applied migration DROPPED is legitimately absent now.
      if (isDropped(alt.table, cname)) continue;
      const c = await one(q, "select contype, pg_get_constraintdef(oid) def from pg_constraint where conrelid=$1::regclass and conname=$2", [`public.${alt.table}`, cname]);
      if (!c) { P.push(`${alt.table} constraint ${cname} absent`); continue; }
      if (c.contype !== kind) P.push(`${alt.table} constraint ${cname} kind ${c.contype} != ${kind}`);
      checkConstraint(P, alt.table, cname, kind, c.def, spec);
    }
    // A DROPPING migration, once applied, must have REMOVED the named constraint.
    for (const cname of alt.dropConstraints || []) {
      if (await constraintExists(q, alt.table, cname)) P.push(`${alt.table} constraint ${cname} still present but ${mig.file} should have DROPPED it`);
    }
  }
  return P;
}

export async function verifyMigrationAbsent(q, mig) {
  const P = [];
  for (const t of mig.tables) if (await tableExists(q, t.name)) P.push(`table public.${t.name} present but ${mig.file} unapplied`);
  for (const fn of mig.functions) if (fn.createdNew && await funcExists(q, fn.sig)) P.push(`function ${fn.sig} present but ${mig.file} unapplied`);
  for (const alt of mig.alters || []) {
    for (const [name] of alt.addColumns || []) if (await columnExists(q, alt.table, name)) P.push(`${alt.table}.${name} present but ${mig.file} unapplied`);
    for (const [cname] of alt.addConstraints || []) if (await constraintExists(q, alt.table, cname)) P.push(`${alt.table} constraint ${cname} present but ${mig.file} unapplied`);
    // A DROPPING migration is unapplied => the constraint it will drop must STILL be present.
    for (const cname of alt.dropConstraints || []) if (!(await constraintExists(q, alt.table, cname))) P.push(`${alt.table} constraint ${cname} already dropped but ${mig.file} unapplied`);
  }
  return P;
}
