// Scheduler v2 Phase 1f -- STATIC migration <-> wrapper compatibility audit (SHADOW MODE, no I/O of its own).
//
// This is the executable compatibility matrix the runtime preflight consumes for "migration readiness".
// It declares, per UNAPPLIED Scheduler-v2 migration, the tables / RPCs / key columns / unique constraints it
// must provide AND the lib/server/supabase.js wrappers that depend on them, then STATICALLY verifies the
// migration SQL and the wrapper source AGREE. It reads text through an INJECTED `readFile` (the caller passes
// fs.readFileSync in production; tests pass in-memory fixtures), so this module performs no I/O by itself and
// never touches the database, DataDoe, or a secret. A missing / renamed / mismatched contract is reported as a
// TYPED, SAFE blocker (never a raw SQL/exception string), so the audit fails closed rather than guessing that
// an absent table or a drifted column is fine.
//
// It NEVER applies or edits a migration; it only compares the committed SQL against the committed wrappers.

// The four unapplied Scheduler-v2 migrations this phase audits, each mapped to the schema objects it provides
// and the wrappers that call them. `unique` lists the on-conflict / lookup keys wrappers rely on (each must be
// backed by a PRIMARY KEY or UNIQUE constraint). `keyColumns` are the columns the wrappers read/write.
export const SCHEDULER_V2_SCHEMA_CONTRACT = Object.freeze([
  {
    migration: "20260807_scheduler_v2.sql",
    tables: [
      {
        name: "sync_cycles",
        unique: [["bucket", "cycle_date"]],
        namedConstraints: [{ name: "sync_cycles_bucket_date_unique", kind: "unique", columns: ["bucket", "cycle_date"] }],
        keyColumns: ["id", "bucket", "cycle_date", "trigger", "status", "scheduled_at", "started_at", "finished_at",
          "source_total", "source_succeeded", "source_failed", "report_total", "report_succeeded", "report_failed", "counts"],
      },
      {
        name: "sync_source_jobs",
        unique: [["cycle_id", "request_hash"]],
        // The one-attempt invariant the rollout token budget relies on (DB-level "one create-export per
        // (cycle, request_hash)") + the dedup unique. Audited by name, KIND, and (for the CHECK) body tokens.
        namedConstraints: [
          { name: "sync_source_jobs_cycle_hash_unique", kind: "unique", columns: ["cycle_id", "request_hash"] },
          // EXACT one-attempt semantics: only (count=0 AND attempted_at IS NULL) OR (count=1 AND attempted_at IS
          // NOT NULL). Compared as an exact canonical token sequence, so AND<->OR, an operand/operator reorder,
          // or an extra clause fails.
          { name: "sync_source_jobs_one_attempt", kind: "check", canonical: "(create_export_count = 0 and attempted_at is null) or (create_export_count = 1 and attempted_at is not null)" },
        ],
        keyColumns: ["cycle_id", "request_hash", "source_id", "source_key", "organization_fingerprint", "connection_id",
          "account_scope_hash", "request_meta", "bucket", "fetch_status", "attempted_at", "create_export_count",
          "export_id", "error_stage", "error_code", "error_message", "terminal", "row_count", "payload_bytes", "cache_object_path"],
      },
      {
        name: "sync_report_jobs",
        unique: [["cycle_id", "report_key", "account_id"]],
        namedConstraints: [{ name: "sync_report_jobs_cycle_report_account_unique", kind: "unique", columns: ["cycle_id", "report_key", "account_id"] }],
        keyColumns: ["cycle_id", "report_key", "report_version", "account_id", "connection_id", "bucket", "depends_on",
          "fetch_status", "derive_status", "save_status", "validated", "error_stage", "error_code", "latest_data_date", "snapshot_params_hash"],
      },
    ],
    rpcs: [
      { name: "open_sync_cycle", params: ["p_bucket", "p_cycle_date", "p_scheduled_at", "p_trigger"] },
      { name: "claim_sync_cycle", params: ["p_cycle_id"] },
      { name: "claim_source_export_attempt", params: ["p_cycle_id", "p_request_hash"] },
    ],
    wrappers: ["openSyncCycle", "claimSyncCycle", "getSyncCycle", "updateSyncCycleCounts", "claimSourceExportAttempt",
      "upsertSyncSourceJob", "getSyncSourceJobs", "recordSyncSourceSuccess", "recordSyncSourceExportCreated",
      "recordSyncSourceFailure", "getSyncReportJobs", "upsertSyncReportJob", "claimReportDeriveAttempt",
      "recordSyncReportBlocked", "recordSyncReportFailure", "recordSyncReportSuccess"],
  },
  {
    migration: "20260810_ads_sync_coverage.sql",
    tables: [
      {
        name: "ads_sync_coverage",
        unique: [["account_id", "source_key", "covered_from", "covered_to"]],
        keyColumns: ["account_id", "source_key", "covered_from", "covered_to", "status", "source_refreshed_at"],
      },
    ],
    rpcs: [],
    wrappers: ["getDailyAdsCoverage", "recordAdsCoverageWindows"],
  },
  {
    // The file is named "report_sync_controls" but the table it creates is report_sync_settings; the wrapper
    // reads that table. The audit pins the ACTUAL table name so a future rename of one but not the other fails.
    migration: "20260810_report_sync_controls.sql",
    tables: [
      { name: "report_sync_settings", unique: [["report_key"]], keyColumns: ["report_key", "schedule_enabled", "updated_at"] },
    ],
    rpcs: [],
    wrappers: ["getReportSyncSettings"],
    note: "Migration filename says 'controls'; the table is report_sync_settings (getReportSyncSettings reads it).",
  },
  {
    migration: "20260811_sync_source_job_owners.sql",
    tables: [
      {
        name: "sync_source_job_owners",
        unique: [["cycle_id", "request_hash", "owner_id"]],
        // The composite FK to the canonical source-job identity + the owner identity/connection invariants
        // the rollout relies on (a malformed owner row must fail the migration, never route to primary).
        // Audited by name, KIND, columns, FK target, and CHECK body tokens -- scoped to THIS table.
        namedConstraints: [
          { name: "sync_source_job_owners_unique", kind: "unique", columns: ["cycle_id", "request_hash", "owner_id"] },
          { name: "sync_source_job_owners_source_fk", kind: "foreign key", columns: ["cycle_id", "request_hash"], references: { table: "sync_source_jobs", columns: ["cycle_id", "request_hash"] } },
          // EXACTLY the two allowed connection ids -- no extra value (e.g. 'evil') can slip in.
          { name: "sync_source_job_owners_connection_id_check", kind: "check", canonical: "connection_id in ('primary', 'dd-secondary')" },
          // EVERY owner identity field non-empty, joined with AND (an AND->OR weakening fails).
          { name: "sync_source_job_owners_identity_nonempty", kind: "check", canonical: "char_length(report_key) > 0 and char_length(account_id) > 0 and char_length(request_key) > 0 and char_length(organization_fingerprint) > 0 and char_length(account_scope_hash) > 0" },
        ],
        keyColumns: ["cycle_id", "request_hash", "owner_id", "request_key", "report_key", "account_id",
          "connection_id", "organization_fingerprint", "account_scope_hash", "owner_status", "error_code"],
      },
    ],
    rpcs: [],
    wrappers: ["upsertSyncSourceJobOwners", "getSyncSourceJobOwners", "getSyncSourceJobsForOwners", "recordSyncSourceJobOwnerStale"],
  },
  {
    // Cycle finalization (Blocker 1). Adds NO table/column (sync_cycles already carries status / finished_at /
    // source_* / report_* from 20260807); provides the guarded finalize RPC + the append-after-terminal triggers
    // the dispatcher-owned finalization depends on. The RPC takes ONLY p_cycle_id (no expect-status param).
    migration: "20260815_sync_cycle_finalize.sql",
    tables: [],
    rpcs: [
      { name: "finalize_sync_cycle", params: ["p_cycle_id"] },
    ],
    triggers: [
      { name: "sync_source_jobs_no_append_terminal", table: "sync_source_jobs" },
      { name: "sync_source_job_owners_no_append_terminal", table: "sync_source_job_owners" },
      { name: "sync_report_jobs_no_append_terminal", table: "sync_report_jobs" },
    ],
    // The guard function whose critical behavior is structurally proven (cycle_id immutable, FOR SHARE lock,
    // terminal-parent reject, missing-parent fail-closed).
    guardFunctions: ["reject_append_to_terminal_cycle"],
    wrappers: ["finalizeSyncCycle"],
    note: "Guarded finalize_sync_cycle RPC + reject_append_to_terminal_cycle triggers on the 3 child tables (PREPARED, UNAPPLIED).",
  },
  {
    // Gate-7 ACCOUNT ROLLOUT control plane: the durable, fail-closed ACCOUNT gate (allowlist + deliberate
    // all-primary switch) and the per-(report, account) publish approvals. ADDITIVE only -- no existing table
    // is touched; report_sync_settings / report-level readiness are NOT weakened (the account gate is an
    // additional, independent gate).
    migration: "20260816_account_rollout.sql",
    tables: [
      {
        name: "scheduler_account_rollout",
        unique: [["account_id"]],
        // DB-enforced identity integrity, audited by EXACT canonical CHECK bodies scoped to THIS table: a
        // blank id, a NONCANONICAL id (leading/trailing whitespace), or a dd-secondary-prefixed id can never
        // be stored (the reader/resolver also reject them at read time -- defense in depth, both layers proven).
        namedConstraints: [
          { name: "scheduler_account_rollout_account_id_nonblank", kind: "check", canonical: "char_length(btrim(account_id)) > 0" },
          { name: "scheduler_account_rollout_account_id_canonical", kind: "check", canonical: "account_id = btrim(account_id)" },
          { name: "scheduler_account_rollout_account_id_primary_only", kind: "check", canonical: "account_id not like 'dd-secondary:%'" },
        ],
        // Least-privilege service_role ACL: REVOKE ALL from service_role (strip the Supabase default-privilege
        // ALL grant) THEN grant exactly select/insert/update -- no delete/truncate/references/trigger/maintain.
        serviceRoleAcl: { revokeAll: true, grants: ["select", "insert", "update"] },
        keyColumns: ["account_id", "enabled", "note", "created_at", "updated_at"],
      },
      {
        name: "scheduler_rollout_mode",
        unique: [["id"]],
        namedConstraints: [
          { name: "scheduler_rollout_mode_singleton", kind: "check", canonical: "id = 1" },
        ],
        serviceRoleAcl: { revokeAll: true, grants: ["select", "insert", "update"] },
        keyColumns: ["id", "all_primary", "updated_at"],
      },
      {
        name: "scheduler_publish_approvals",
        unique: [["report_key", "account_id"]],
        // Every publish DECISION row (approval or revocation) must be genuinely auditable AND canonically
        // identified: nonblank + CANONICAL (btrim-equal) report_key/account_id, primary-only account
        // identity, a DB-required canonical nonblank approved_by, and a non-null approved_at. An
        // unaudited/blank/noncanonical decision row fails this contract.
        namedConstraints: [
          { name: "scheduler_publish_approvals_report_key_nonblank", kind: "check", canonical: "char_length(btrim(report_key)) > 0" },
          { name: "scheduler_publish_approvals_report_key_canonical", kind: "check", canonical: "report_key = btrim(report_key)" },
          { name: "scheduler_publish_approvals_account_id_nonblank", kind: "check", canonical: "char_length(btrim(account_id)) > 0" },
          { name: "scheduler_publish_approvals_account_id_canonical", kind: "check", canonical: "account_id = btrim(account_id)" },
          { name: "scheduler_publish_approvals_account_id_primary_only", kind: "check", canonical: "account_id not like 'dd-secondary:%'" },
          { name: "scheduler_publish_approvals_approved_by_canonical", kind: "check", canonical: "approved_by = btrim(approved_by)" },
          { name: "scheduler_publish_approvals_audited", kind: "check", canonical: "char_length(btrim(approved_by)) > 0 and approved_at is not null" },
        ],
        serviceRoleAcl: { revokeAll: true, grants: ["select", "insert", "update"] },
        keyColumns: ["report_key", "account_id", "approved", "approved_by", "approved_at", "created_at", "updated_at"],
      },
    ],
    rpcs: [],
    wrappers: ["getSchedulerAccountRollout", "getSchedulerPublishApproval", "publishLiveSnapshotIfNewer"],
    note: "Durable account rollout (allowlist + all-primary switch) + audited publish approvals (PREPARED, UNAPPLIED).",
  },
  {
    // Atomic, cache-validated reuse adoption + claim mutual-exclusion (Blocker 2 + senior review). Adds the new
    // adopt CAS and REPLACES claim_source_export_attempt (the fetch_status='pending' guard). No new table.
    migration: "20260817_scheduler_v2_reuse_cas.sql",
    tables: [],
    rpcs: [
      // EXACT 8-param adoption CAS: the caller's identity/integrity fields are EXPECTATIONS the RPC validates
      // against the ACTUAL locked cache row before adopting the job with the DB row's own values.
      { name: "adopt_source_export_cache", params: ["p_cycle_id", "p_request_hash", "p_expected_source_id", "p_expected_organization_fingerprint", "p_expected_account_scope_hash", "p_expected_object_path", "p_expected_row_count", "p_expected_payload_bytes"] },
      { name: "claim_source_export_attempt", params: ["p_cycle_id", "p_request_hash"] },
    ],
    // STRUCTURAL body proof (senior review gap 4c): the adoption CAS must LOCK the real cache row FOR UPDATE,
    // gate on the DB expiry, compare the FULL identity/integrity set against the caller's expectations, write
    // the DB row's OWN values, and CAS only a still pending/unattempted/count=0 job. Removing any is a blocker.
    provenFunctions: [{ name: "adopt_source_export_cache", proof: "adopt-cache" }],
    wrappers: ["adoptSourceExportCache", "claimSourceExportAttempt"],
    note: "Atomic cache-validated adoption CAS + claim mutual-exclusion (REPLACES 20260807 claim; PREPARED, UNAPPLIED).",
  },
  {
    // STABLE <=5-account source batch membership (Blocker 4). One table + one transactional assignment RPC.
    migration: "20260817_source_batch_membership.sql",
    tables: [
      {
        name: "source_batch_membership",
        unique: [["batch_family", "account_id"]],
        namedConstraints: [
          { name: "source_batch_membership_pk", kind: "primary key", columns: ["batch_family", "account_id"] },
          { name: "source_batch_membership_batch_index_nonneg", kind: "check", canonical: "batch_index >= 0" },
          { name: "source_batch_membership_connection_id_check", kind: "check", canonical: "connection_id in ('primary', 'dd-secondary')" },
        ],
        // Finding 4: least-privilege ACL -- REVOKE ALL from service_role then GRANT SELECT ONLY. All writes go
        // through assign_source_account_batch (SECURITY DEFINER), so no direct service-role write can bypass <=5.
        serviceRoleAcl: { revokeAll: true, grants: ["select"] },
        // Gap 4a: the required index is proven by NAME *and* EXACT columns/order -- a wrong-column index fails.
        requiredIndexes: [{ name: "source_batch_membership_family_idx", columns: ["batch_family", "batch_index"] }],
        rlsEnabled: true,
        // Gap 4b: the touch trigger is proven STRUCTURALLY -- BEFORE UPDATE, FOR EACH ROW, executing exactly
        // public.touch_updated_at(). An AFTER/DELETE/statement-level/wrong-function trigger fails.
        requiredTriggers: [{ name: "source_batch_membership_touch", timing: "before", events: ["update"], level: "row", function: "touch_updated_at" }],
        keyColumns: ["batch_family", "account_id", "batch_index", "connection_id", "organization_fingerprint"],
      },
    ],
    rpcs: [
      { name: "assign_source_account_batch", params: ["p_batch_family", "p_account_id", "p_connection_id", "p_organization_fingerprint", "p_max"] },
    ],
    // STRUCTURAL body proof (senior review gap 4d): the assignment RPC must take the per-family advisory xact
    // lock, hard-cap the maximum to 5, and REJECT an existing membership whose connection/organization scope
    // differs (no silent re-home). The direct-write ban is proven separately by the SELECT-only service_role ACL.
    provenFunctions: [{ name: "assign_source_account_batch", proof: "assign-batch" }],
    wrappers: ["assignSourceAccountBatch", "listSourceBatchMembership"],
    note: "Stable <=5-account batch membership + transactional assign RPC (PREPARED, UNAPPLIED).",
  },
  {
    // Blocker 4d: FROZEN per-(cycle,tranche) create-export + AI-token budget (standard=2, premium=5 tokens per
    // unique hash) + the ATOMIC pre-POST reservation RPC. Two tables + two RPCs; additive only.
    migration: "20260818_source_tranche_budget.sql",
    tables: [
      {
        name: "source_tranche_budget",
        unique: [["cycle_id", "tranche_key"]],
        namedConstraints: [
          { name: "source_tranche_budget_pk", kind: "primary key", columns: ["cycle_id", "tranche_key"] },
          { name: "source_tranche_budget_fingerprint_nonblank", kind: "check", canonical: "char_length(btrim(plan_fingerprint)) > 0" },
          { name: "source_tranche_budget_max_creates_nonneg", kind: "check", canonical: "max_creates >= 0" },
          { name: "source_tranche_budget_max_tokens_nonneg", kind: "check", canonical: "max_tokens >= 0" },
          // The DB-level ceilings the token budget relies on: spent may never exceed max (AND-joined, so an
          // AND->OR weakening or a dropped bound fails).
          { name: "source_tranche_budget_spent_creates_bounded", kind: "check", canonical: "spent_creates >= 0 and spent_creates <= max_creates" },
          { name: "source_tranche_budget_spent_tokens_bounded", kind: "check", canonical: "spent_tokens >= 0 and spent_tokens <= max_tokens" },
        ],
        serviceRoleAcl: { revokeAll: true, grants: ["select"] },
        rlsEnabled: true,
        requiredTriggers: [{ name: "source_tranche_budget_touch", timing: "before", events: ["update"], level: "row", function: "touch_updated_at" }],
        keyColumns: ["cycle_id", "tranche_key", "plan_fingerprint", "max_creates", "max_tokens", "spent_creates", "spent_tokens"],
      },
      {
        name: "source_tranche_budget_hash",
        unique: [["cycle_id", "tranche_key", "request_hash"]],
        namedConstraints: [
          { name: "source_tranche_budget_hash_pk", kind: "primary key", columns: ["cycle_id", "tranche_key", "request_hash"] },
          // EXACTLY the two allowed per-hash token costs (standard 2, premium 5) -- no other value can slip in.
          { name: "source_tranche_budget_hash_cost_check", kind: "check", canonical: "token_cost in (2, 5)" },
          { name: "source_tranche_budget_hash_budget_fk", kind: "foreign key", columns: ["cycle_id", "tranche_key"], references: { table: "source_tranche_budget", columns: ["cycle_id", "tranche_key"] } },
        ],
        serviceRoleAcl: { revokeAll: true, grants: ["select"] },
        requiredIndexes: [{ name: "source_tranche_budget_hash_budget_idx", columns: ["cycle_id", "tranche_key"] }],
        rlsEnabled: true,
        keyColumns: ["cycle_id", "tranche_key", "request_hash", "token_cost"],
      },
    ],
    rpcs: [
      { name: "persist_source_tranche_budget", params: ["p_cycle_id", "p_tranche_key", "p_plan_fingerprint", "p_max_creates", "p_max_tokens", "p_hashes"] },
      { name: "reserve_source_export_create", params: ["p_cycle_id", "p_tranche_key", "p_request_hash", "p_plan_fingerprint"] },
    ],
    // STRUCTURAL body proof: the reservation RPC must take the per-(cycle,tranche) advisory lock, lock the
    // budget row FOR UPDATE, reject a drifted plan fingerprint + a hash outside the frozen plan, refuse to
    // exceed EITHER ceiling, CLAIM only a still pending/unattempted job (mutual exclusion with adoption), and
    // reserve the create + token cost. Removing any is a blocker.
    provenFunctions: [{ name: "reserve_source_export_create", proof: "reserve-create" }],
    wrappers: ["persistSourceTrancheBudget", "reserveSourceExportCreate", "getSourceTrancheBudget", "getSourceTrancheBudgetHashes"],
    note: "Frozen per-(cycle,tranche) create/token budget + atomic pre-POST reservation RPC (PREPARED, UNAPPLIED).",
  },
  {
    // DURABLE SOURCE MODEL: canonical OLI history (idempotent full-grain PK so corrections REPLACE), proven
    // coverage windows (succeeded-only; completed coverage is never re-exported), source-level controls
    // (pause + schedule_enabled default FALSE), the per-(source, bucket) operator status card, and the
    // latest-VALIDATED snapshot pointer. ADDITIVE only; five new tables; no RPC; all writes via wrappers.
    migration: "20260820_source_durable_model.sql",
    tables: [
      {
        name: "source_oli_daily_history",
        unique: [["organization_fingerprint", "connection_id", "account_id", "sale_date", "sku", "child_asin", "currency"]],
        namedConstraints: [
          { name: "source_oli_daily_history_pk", kind: "primary key", columns: ["organization_fingerprint", "connection_id", "account_id", "sale_date", "sku", "child_asin", "currency"] },
          { name: "source_oli_daily_history_connection_id_check", kind: "check", canonical: "connection_id in ('primary', 'dd-secondary')" },
          { name: "source_oli_daily_history_currency_check", kind: "check", canonical: "currency ~ '^[A-Z]{3}$'" },
          { name: "source_oli_daily_history_hash_nonblank", kind: "check", canonical: "char_length(btrim(source_request_hash)) > 0" },
        ],
        requiredIndexes: [
          { name: "source_oli_daily_history_account_date_idx", columns: ["account_id", "sale_date"] },
          { name: "source_oli_daily_history_org_date_idx", columns: ["organization_fingerprint", "sale_date"] },
        ],
        rlsEnabled: true,
        // Finding 9 + 5: history is written ONLY through the atomic replace_oli_history_window RPC --
        // service_role keeps SELECT alone, so no direct write can bypass the replacement + coverage ack.
        serviceRoleAcl: { revokeAll: true, grants: ["select"] },
        requiredPolicies: [],
        authenticatedAcl: { grants: [] },
        requiredTriggers: [{ name: "source_oli_daily_history_touch", timing: "before", events: ["update"], level: "row", function: "touch_updated_at" }],
        keyColumns: ["organization_fingerprint", "connection_id", "account_id", "seller_or_vendor_id", "sale_date",
          "sku", "child_asin", "currency", "sales_amount", "units", "source_request_hash"],
      },
      {
        name: "source_coverage",
        unique: [["organization_fingerprint", "connection_id", "account_id", "source_key", "covered_from", "covered_to"]],
        namedConstraints: [
          { name: "source_coverage_pk", kind: "primary key", columns: ["organization_fingerprint", "connection_id", "account_id", "source_key", "covered_from", "covered_to"] },
          // ONLY proven successes exist (mirrors ads_sync_coverage) -- coverage can never record a failure.
          { name: "source_coverage_status_check", kind: "check", canonical: "status in ('succeeded')" },
          { name: "source_coverage_window_check", kind: "check", canonical: "covered_from <= covered_to" },
        ],
        requiredIndexes: [{ name: "source_coverage_lookup_idx", columns: ["account_id", "source_key", "covered_from"] }],
        serviceRoleAcl: { revokeAll: true, grants: ["select", "insert", "update"] },
        rlsEnabled: true,
                requiredPolicies: [{ name: "source_coverage_admin_read", command: "select", role: "authenticated", using: "public.is_dashboard_admin()" }],
        authenticatedAcl: { grants: ["select"] },
        requiredTriggers: [{ name: "source_coverage_touch", timing: "before", events: ["update"], level: "row", function: "touch_updated_at" }],
        keyColumns: ["organization_fingerprint", "connection_id", "account_id", "source_key", "covered_from", "covered_to", "status", "source_refreshed_at"],
      },
      {
        name: "source_controls",
        unique: [["source_key"]],
        namedConstraints: [
          { name: "source_controls_source_key_nonblank", kind: "check", canonical: "char_length(btrim(source_key)) > 0" },
        ],
        serviceRoleAcl: { revokeAll: true, grants: ["select", "insert", "update"] },
        rlsEnabled: true,
                requiredPolicies: [{ name: "source_controls_admin_read", command: "select", role: "authenticated", using: "public.is_dashboard_admin()" }],
        authenticatedAcl: { grants: ["select"] },
        requiredTriggers: [{ name: "source_controls_touch", timing: "before", events: ["update"], level: "row", function: "touch_updated_at" }],
        keyColumns: ["source_key", "paused", "schedule_enabled", "updated_at"],
      },
      {
        name: "source_run_status",
        unique: [["source_key", "bucket"]],
        namedConstraints: [
          { name: "source_run_status_pk", kind: "primary key", columns: ["source_key", "bucket"] },
          { name: "source_run_status_bucket_check", kind: "check", canonical: "bucket in ('us', 'non-us')" },
          { name: "source_run_status_last_status_check", kind: "check", canonical: "last_status in ('never', 'running', 'succeeded', 'partial', 'failed', 'paused')" },
        ],
        serviceRoleAcl: { revokeAll: true, grants: ["select", "insert", "update"] },
        rlsEnabled: true,
                requiredPolicies: [{ name: "source_run_status_admin_read", command: "select", role: "authenticated", using: "public.is_dashboard_admin()" }],
        authenticatedAcl: { grants: ["select"] },
        requiredTriggers: [{ name: "source_run_status_touch", timing: "before", events: ["update"], level: "row", function: "touch_updated_at" }],
        keyColumns: ["source_key", "bucket", "last_status", "last_attempt_at", "last_success_at", "safe_error_code", "safe_error_stage",
          "covered_from", "covered_to", "accounts_completed", "accounts_failed", "accounts_total", "batch_count",
          "creates_spent", "tokens_spent", "creates_ceiling", "tokens_ceiling"],
      },
      {
        name: "source_snapshots",
        unique: [["organization_fingerprint", "connection_id", "source_key", "scope_key"]],
        namedConstraints: [
          { name: "source_snapshots_pk", kind: "primary key", columns: ["organization_fingerprint", "connection_id", "source_key", "scope_key"] },
          { name: "source_snapshots_connection_id_check", kind: "check", canonical: "connection_id in ('primary', 'dd-secondary')" },
          { name: "source_snapshots_payload_sha_nonblank", kind: "check", canonical: "char_length(btrim(payload_sha)) > 0" },
          { name: "source_snapshots_object_path_nonblank", kind: "check", canonical: "char_length(btrim(object_path)) > 0" },
          { name: "source_snapshots_row_count_nonneg", kind: "check", canonical: "row_count >= 0" },
        ],
        serviceRoleAcl: { revokeAll: true, grants: ["select"] },
        rlsEnabled: true,
        requiredPolicies: [],
        authenticatedAcl: { grants: [] },
        requiredTriggers: [{ name: "source_snapshots_touch", timing: "before", events: ["update"], level: "row", function: "touch_updated_at" }],
        keyColumns: ["organization_fingerprint", "connection_id", "source_key", "scope_key", "object_path", "payload_sha", "row_count", "payload_bytes", "source_request_hash", "validated_at"],
      },
    ],
    rpcs: [
      // Finding 5: the ATOMIC rolling-window replacement + coverage acknowledgement (one transaction).
      { name: "replace_oli_history_window", params: ["p_organization_fingerprint", "p_connection_id", "p_account_id", "p_covered_from", "p_covered_to", "p_rows", "p_source_refreshed_at"] },
      // Round-4 finding 8: the ATOMIC newer-or-equal-identical snapshot pointer CAS.
      { name: "record_source_snapshot", params: ["p_organization_fingerprint", "p_connection_id", "p_source_key", "p_scope_key", "p_object_path", "p_payload_sha", "p_row_count", "p_payload_bytes", "p_source_request_hash", "p_validated_at"] },
    ],
    // Round-4 finding 9: the canonical-identity constraint added to the (frozen-elsewhere) membership table.
    requiredStatements: [
      { label: "source_batch_membership_account_canonical CHECK (canonical, nonblank, unprefixed account ids)", pattern: String.raw`add\s+constraint\s+source_batch_membership_account_canonical\s+check\s*\(account_id\s*=\s*btrim\(account_id\)\s+and\s+char_length\(account_id\)\s*>\s*0\s+and\s+position\([\s\S]{1,8}?\s+in\s+account_id\)\s*=\s*0\)` },
    ],
    // STRUCTURAL body proof: the RPC must validate every row fail-closed BEFORE mutating, DELETE the
    // account's window rows, INSERT the corrected rows, and UPSERT the coverage acknowledgement in the SAME
    // function body (one transaction). Removing any is a blocker.
    provenFunctions: [
      { name: "replace_oli_history_window", proof: "replace-oli" },
      { name: "record_source_snapshot", proof: "snapshot-cas" },
    ],
    wrappers: ["upsertSourceOliHistoryRows", "getSourceOliHistoryRows", "getSourceCoverageWindows", "recordSourceCoverageWindows",
      "getSourceControls", "setSourceControl", "getSourceRunStatuses", "upsertSourceRunStatus",
      "getSourceSnapshot", "recordSourceSnapshot",
      "replaceOliHistoryWindow", "saveSourceSnapshotPayload", "getSourceSnapshotPayload"],
    note: "Durable source model: OLI history + coverage + controls + run status + validated snapshots (PREPARED, UNAPPLIED).",
  },
  {
    // Round-6 blocker 2: the SEPARATE durable control for SOURCE-PROMOTED publication (brand-inventory). An
    // additive operator-surface table (mirrors source_controls): admin-read RLS + least-privilege
    // service_role ACL (select,insert,update; REVOKE ALL strips PG17 MAINTAIN). NEVER feeds dispatcher
    // selection -- the promoted key is not in CONTROLLED_REPORT_KEYS -- so enabling publish_enabled can
    // never dispatch a DataDoe export.
    migration: "20260821_source_promoted_publish_controls.sql",
    tables: [
      {
        name: "source_promoted_publish_settings",
        unique: [["report_key"]],
        namedConstraints: [
          { name: "source_promoted_publish_settings_report_key_nonblank", kind: "check", canonical: "char_length(btrim(report_key)) > 0" },
        ],
        serviceRoleAcl: { revokeAll: true, grants: ["select", "insert", "update"] },
        rlsEnabled: true,
        requiredPolicies: [{ name: "source_promoted_publish_settings_admin_read", command: "select", role: "authenticated", using: "public.is_dashboard_admin()" }],
        authenticatedAcl: { grants: ["select"] },
        requiredTriggers: [{ name: "source_promoted_publish_settings_touch", timing: "before", events: ["update"], level: "row", function: "touch_updated_at" }],
        keyColumns: ["report_key", "publish_enabled", "updated_at"],
      },
    ],
    rpcs: [],
    wrappers: ["getSourcePromotedPublishSettings", "setSourcePromotedPublishControl"],
    note: "Source-promoted publication control (brand-inventory); default OFF; PREPARED, UNAPPLIED.",
  },
]);

// ---- SQL-aware lexical layer -----------------------------------------------------------------------------
//
// The blocker: comments AND quoted/dollar-quoted STRINGS must never satisfy structural discovery (CREATE
// TABLE, ALTER TABLE ADD/DROP CONSTRAINT, RPC, table, constraint), yet a real CHECK body's string literals
// must be preserved so their exact values are validated. `lexSql` produces TWO length-aligned views:
//   - `clean`  : comments removed (blanked to spaces), string/dollar-quoted contents PRESERVED;
//   - `masked` : comments removed AND every string literal / dollar-quoted STRING blanked -- but dollar-quoted
//                CODE bodies (a `$tag$...$tag$` preceded by `do`/`as`, i.e. a DO block or function body) are
//                KEPT, with their inner single-quoted strings still blanked (so a real ALTER ... ADD CONSTRAINT
//                inside a DO block IS discovered, while `... add constraint ...` text living only inside a
//                quoted string is NOT).
// Both are the SAME LENGTH as the input, so an index located in `masked` maps to the real text in `clean`.
// ALL structural discovery runs on `masked`; only a structurally-located CHECK body is read from `clean`.

const blankLine = (str) => String(str).replace(/[^\n]/g, " "); // length-preserving blank (keep newlines)

function dollarTagAt(s, i) {
  if (s[i] !== "$") return null;
  const m = /^\$([a-zA-Z_][a-zA-Z0-9_]*)?\$/.exec(s.slice(i));
  return m ? m[0] : null;
}

function precedingKeyword(s, i) {
  let j = i - 1;
  while (j >= 0 && /\s/.test(s[j])) j -= 1;
  let start = j;
  while (start >= 0 && /[a-zA-Z0-9_]/.test(s[start])) start -= 1;
  return s.slice(start + 1, j + 1).toLowerCase();
}

function lexSql(sql) {
  const s = String(sql);
  let clean = "";
  let masked = "";
  const emit = (c, m) => { clean += c; masked += m; };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "-" && s[i + 1] === "-") { let j = i; while (j < s.length && s[j] !== "\n") j += 1; const seg = s.slice(i, j); emit(blankLine(seg), blankLine(seg)); i = j; continue; }
    if (c === "/" && s[i + 1] === "*") { let j = i + 2; while (j < s.length && !(s[j] === "*" && s[j + 1] === "/")) j += 1; j = Math.min(j + 2, s.length); const seg = s.slice(i, j); emit(blankLine(seg), blankLine(seg)); i = j; continue; }
    if (c === "'") { let j = i + 1; while (j < s.length) { if (s[j] === "'" && s[j + 1] === "'") { j += 2; continue; } if (s[j] === "'") { j += 1; break; } j += 1; } const seg = s.slice(i, j); emit(seg, blankLine(seg)); i = j; continue; }
    const tag = dollarTagAt(s, i);
    if (tag) {
      const endIdx = s.indexOf(tag, i + tag.length);
      const end = endIdx < 0 ? s.length : endIdx + tag.length;
      const kw = precedingKeyword(s, i);
      if (kw === "do" || kw === "as") { // CODE body: keep, but recurse so inner comments/strings are handled.
        const innerStart = i + tag.length;
        const innerEnd = endIdx < 0 ? s.length : endIdx;
        emit(s.slice(i, innerStart), s.slice(i, innerStart));
        const inner = lexSql(s.slice(innerStart, innerEnd));
        emit(inner.clean, inner.masked);
        emit(s.slice(innerEnd, end), s.slice(innerEnd, end));
      } else { const seg = s.slice(i, end); emit(seg, blankLine(seg)); } // dollar-quoted STRING literal
      i = end; continue;
    }
    emit(c, c); i += 1;
  }
  return { clean, masked };
}

// { open, close } indices of the balanced parens starting at `text[openIdx] === "("`, or null.
function balancedRange(text, openIdx) {
  if (openIdx < 0 || text[openIdx] !== "(") return null;
  let depth = 0;
  for (let i = openIdx; i < text.length; i += 1) {
    if (text[i] === "(") depth += 1;
    else if (text[i] === ")") { depth -= 1; if (depth === 0) return { open: openIdx, close: i }; }
  }
  return null;
}

// The CREATE TABLE body paren range in `masked` (indices), or null. Scoped so a column/constraint check for one
// table never matches text belonging to another table -- and a CREATE TABLE mentioned only in a comment/string
// is invisible in `masked`.
function tableBodyRange(masked, name) {
  const m = new RegExp(`create\\s+table\\s+if\\s+not\\s+exists\\s+public\\.${name}\\s*\\(`, "i").exec(masked);
  if (!m) return null;
  return balancedRange(masked, masked.indexOf("(", m.index + m[0].length - 1));
}

function tableBody(masked, name) {
  const r = tableBodyRange(masked, name);
  return r ? masked.slice(r.open + 1, r.close) : null;
}

// A column is declared when its name begins a column line inside the (comment-stripped) table body.
function bodyDeclaresColumn(body, column) {
  return new RegExp(`(^|,|\\()\\s*${column}\\s`, "m").test(body);
}

// A (multi-)column key is backed when THIS TABLE'S body declares it as PRIMARY KEY or UNIQUE -- a table
// constraint `primary key (a, b)` / `unique (a, b)` (optionally NAMED `constraint x unique (...)`), or, for a
// single column, an inline `col type primary key`. Matched on the comment-stripped body ONLY (blocker 3), so a
// removed constraint whose text survives only in a comment does NOT count. Column order must match exactly.
function keyIsBacked(body, cols) {
  if (!body) return false;
  const list = cols.map((c) => c.replace(/[^a-z0-9_]/gi, "")).join("\\s*,\\s*");
  const grouped = new RegExp(`(primary\\s+key|unique)\\s*\\(\\s*${list}\\s*\\)`, "i");
  if (grouped.test(body)) return true;
  if (cols.length === 1) {
    return new RegExp(`(^|,)\\s*${cols[0]}\\s+[a-z0-9_]+[^,]*\\bprimary\\s+key\\b`, "im").test(body);
  }
  return false;
}

const normalizeSql = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
const splitCols = (inner) => normalizeSql(inner).split(",").map((c) => c.trim()).filter(Boolean);

// Lex a SQL expression into an EXACT canonical token list: identifiers/keywords/numbers lowercased,
// string literals kept case-sensitively (Postgres string values are case-sensitive), operators (=, <, >, <=,
// >=, <>, !=) and parens/commas as their own tokens. Whitespace is insignificant. Two expressions are
// semantically identical ONLY when their token lists are identical -- so AND<->OR, an operand/operator reorder,
// an extra clause, or an extra IN value all change the token list and fail.
function tokenizeSql(expr) {
  const s = String(expr || "");
  const toks = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i += 1; continue; }
    if (c === "'") { let j = i + 1; let lit = "'"; while (j < s.length) { if (s[j] === "'" && s[j + 1] === "'") { lit += "''"; j += 2; continue; } lit += s[j]; if (s[j] === "'") { j += 1; break; } j += 1; } toks.push(lit); i = j; continue; }
    if (c === "(" || c === ")" || c === ",") { toks.push(c); i += 1; continue; }
    if (c === "<" || c === ">" || c === "=" || c === "!") { const two = c + (s[i + 1] || ""); if (["<=", ">=", "<>", "!="].includes(two)) { toks.push(two); i += 2; } else { toks.push(c); i += 1; } continue; }
    if (/[a-z0-9_]/i.test(c)) { let j = i; let w = ""; while (j < s.length && /[a-z0-9_]/i.test(s[j])) { w += s[j]; j += 1; } toks.push(w.toLowerCase()); i = j; continue; }
    toks.push(c); i += 1;
  }
  return toks;
}

// Parse the constraint declaration whose `constraint <name>` lies in `masked[from..to)`. Returns
// { kind, innerClean, ref }: kind ('unique'|'primary key'|'check'|'foreign key'), innerClean = the FIRST
// balanced (...) after the kind keyword read from `clean` (so a CHECK body keeps its REAL string values), and
// ref (FK only) = the referenced { table, columns }. Located ENTIRELY in `masked`; bodies read from `clean`.
function constraintDeclAt(masked, clean, from, to, name) {
  const re = new RegExp(`\\bconstraint\\s+${name}\\b`, "ig");
  re.lastIndex = Math.max(0, from);
  const nameM = re.exec(masked);
  if (!nameM || nameM.index >= to) return null;
  const kre = /\b(primary\s+key|foreign\s+key|unique|check)\b/ig;
  kre.lastIndex = nameM.index + nameM[0].length;
  const km = kre.exec(masked);
  if (!km || km.index >= to) return { kind: null, innerClean: null, ref: null };
  const kind = km[0].replace(/\s+/g, " ").toLowerCase();
  const range = balancedRange(masked, masked.indexOf("(", km.index + km[0].length));
  if (!range) return { kind, innerClean: null, ref: null };
  const innerClean = clean.slice(range.open + 1, range.close);
  let ref = null;
  if (kind === "foreign key") {
    const rre = /\breferences\s+public\.([a-z0-9_]+)\s*\(/ig;
    rre.lastIndex = range.close;
    const rm = rre.exec(masked);
    // BLOCKER 1: the REFERENCES clause AND its referenced-column list MUST lie inside the SAME bounded
    // declaration [from, to) as the constraint (its CREATE TABLE body or ALTER TABLE statement) -- never a
    // later/unrelated statement. A later `references public.<target>(...)` elsewhere in the file cannot satisfy
    // this FK's target.
    if (rm && rm.index < to) {
      const refRange = balancedRange(masked, masked.indexOf("(", rm.index + rm[0].length - 1));
      if (refRange && refRange.close < to) ref = { table: rm[1].toLowerCase(), columns: splitCols(clean.slice(refRange.open + 1, refRange.close)) };
    }
  }
  return { kind, innerClean, ref };
}

// Locate a named constraint's declaration SCOPED to `table`: inline in that table's CREATE body, OR via a real
// `ALTER TABLE (ONLY)? public.<table> ... ADD CONSTRAINT <name> ...` statement. A constraint on a DIFFERENT
// table, or one whose text lives only in a comment/quoted string (invisible in `masked`), is NOT found.
function namedConstraintScopedDecl(masked, clean, table, name) {
  const bodyRange = tableBodyRange(masked, table);
  if (bodyRange) { const d = constraintDeclAt(masked, clean, bodyRange.open + 1, bodyRange.close, name); if (d) return d; }
  const alterRe = new RegExp(`alter\\s+table\\s+(?:only\\s+)?public\\.${table}\\b`, "ig");
  let am;
  while ((am = alterRe.exec(masked))) {
    const semi = masked.indexOf(";", am.index);
    const stmtEnd = semi < 0 ? masked.length : semi;
    const addRe = new RegExp(`\\badd\\s+constraint\\s+${name}\\b`, "ig");
    addRe.lastIndex = am.index;
    const addM = addRe.exec(masked);
    if (addM && addM.index < stmtEnd) { const d = constraintDeclAt(masked, clean, addM.index, stmtEnd + 1, name); if (d) return d; }
  }
  return null;
}

// A named constraint is PROVEN only when CREATED for the expected table (CREATE body or ALTER ... ADD
// CONSTRAINT), NOT dropped, and matching the expected KIND and: (unique/pk) exact columns; (fk) exact columns +
// reference target; (check) the EXACT canonical expression (token-for-token). A DROP CONSTRAINT of the name (in
// real DDL, not a string), a wrong-table declaration, or a comment/quoted-string-only mention never passes.
function namedConstraintProven(masked, clean, table, expected) {
  const name = expected.name;
  if (new RegExp(`\\bdrop\\s+constraint\\s+(?:if\\s+exists\\s+)?${name}\\b`, "i").test(masked)) return { proven: false, reason: "dropped" };
  const decl = namedConstraintScopedDecl(masked, clean, table, name);
  if (!decl) return { proven: false, reason: "absent-or-wrong-table" };
  if (expected.kind && decl.kind !== expected.kind) return { proven: false, reason: "kind-mismatch" };
  if (expected.columns && !arraysEqual(splitCols(decl.innerClean || ""), expected.columns.map((c) => c.toLowerCase()))) {
    return { proven: false, reason: "columns-mismatch" };
  }
  if (expected.references) {
    const ok = decl.ref && decl.ref.table === expected.references.table && arraysEqual(decl.ref.columns, expected.references.columns.map((c) => c.toLowerCase()));
    if (!ok) return { proven: false, reason: "fk-target-mismatch" };
  }
  if (expected.canonical && !arraysEqual(tokenizeSql(decl.innerClean || ""), tokenizeSql(expected.canonical))) {
    return { proven: false, reason: "check-body-mismatch" };
  }
  return { proven: true, reason: null };
}

// The RPC's declared parameter NAMES in signature order (from `masked`, so a `create ... function public.<name>`
// appearing only in a comment/string is invisible), or null if the function signature is absent. Each
// parameter's name is the first token before its type; a `default '...'` value is blanked in `masked` and
// ignored anyway.
function rpcParamNames(masked, name) {
  const m = new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${name}\\s*\\(`, "i").exec(masked);
  if (!m) return null;
  const range = balancedRange(masked, masked.indexOf("(", m.index + m[0].length - 1));
  if (!range) return null;
  const body = masked.slice(range.open + 1, range.close).trim();
  if (!body) return [];
  return body.split(",").map((p) => p.trim()).filter(Boolean).map((p) => p.split(/\s+/)[0].toLowerCase());
}

function arraysEqual(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);
}

// Round-6 fix 6: the COMPLETE PostgreSQL 17 table-privilege set. PG17 added MAINTAIN (VACUUM/ANALYZE/
// REINDEX/CLUSTER/REFRESH MATERIALIZED VIEW) to ALL, so a GRANT ALL now confers EIGHT privileges -- a
// replay that expanded ALL to only the legacy seven would model "GRANT ALL then REVOKE the seven" as an
// empty final state while the real database still holds MAINTAIN.
const ALL_TABLE_PRIVS = ["select", "insert", "update", "delete", "truncate", "references", "trigger", "maintain"];

// Round-5 blocker 5: the FINAL ACL state for one exact `public.<table>`, computed by replaying EVERY GRANT
// and REVOKE naming that table in SOURCE ORDER (match offset in `masked`), per role. A union of historical
// grants would (a) accept a verb that a later REVOKE removed (grant-then-revoke), (b) miss that a REVOKE
// followed by a re-GRANT leaves the verb held (revoke-then-grant), and (c) flag a forbidden grant that a
// later REVOKE cured -- the replay yields the verb set that actually holds after the migration runs.
// ALL [PRIVILEGES] expands to the full PostgreSQL table-privilege set on GRANT and removes it on REVOKE.
// Both statement regexes are pinned to the exact `public.<table>\b` object and bounded to one statement
// (`[^;]`), so a different table's statements can neither satisfy nor pollute this table's replay.
function finalRoleGrants(masked, table) {
  const events = [];
  let m;
  const reGrant = new RegExp(`\\bgrant\\s+([^;]*?)\\s+on\\s+(?:table\\s+)?public\\.${table}\\b\\s+to\\s+([^;]*)`, "ig");
  while ((m = reGrant.exec(masked))) events.push({ at: m.index, kind: "grant", verbs: m[1], roles: m[2] });
  const reRevoke = new RegExp(`\\brevoke\\s+(?:grant\\s+option\\s+for\\s+)?([^;]*?)\\s+on\\s+(?:table\\s+)?public\\.${table}\\b\\s+from\\s+([^;]*)`, "ig");
  while ((m = reRevoke.exec(masked))) events.push({ at: m.index, kind: "revoke", verbs: m[1], roles: m[2] });
  events.sort((a, b) => a.at - b.at);
  const state = new Map(); // role -> Set(FINAL verbs)
  for (const ev of events) {
    const verbs = ev.verbs.split(",").map((v) => v.trim().toLowerCase().replace(/\s+/g, " ")).filter(Boolean)
      .flatMap((v) => (v === "all" || v === "all privileges") ? [...ALL_TABLE_PRIVS] : [v]);
    for (const role of ev.roles.split(",").map((r) => r.trim().toLowerCase()).filter(Boolean)) {
      if (!state.has(role)) state.set(role, new Set());
      const set = state.get(role);
      for (const v of verbs) { if (ev.kind === "grant") set.add(v); else set.delete(v); }
    }
  }
  return state;
}

// BOUNDED STRUCTURAL proof of the least-privilege `service_role` ACL for ONE table, on `masked` (comments AND
// string CONTENTS blanked, so a comment-only or string-only REVOKE/GRANT can never satisfy it). Because
// Supabase applies project-level DEFAULT PRIVILEGES that grant `service_role` ALL on every new public table,
// the migration MUST both (1) REVOKE ALL [PRIVILEGES] ... ON public.<table> FROM ... service_role (stripping
// that default), and (2) GRANT exactly {select, insert, update} ... ON public.<table> TO ... service_role.
// Each match is pinned to the EXACT `public.<table>` object with a trailing word boundary, so a REVOKE/GRANT
// on a DIFFERENT table can neither satisfy nor pollute THIS table's proof; the privilege portion is bounded to
// a single statement (`[^;]`), so cross-statement bleed is impossible. Returns [] when both hold, else typed
// problems. A GRANT ALL, an added DELETE/TRUNCATE/etc., a missing REVOKE, a wrong-table statement, or
// comment/string-only text each yields a typed blocker.
function auditServiceRoleAcl(masked, table, expected) {
  const problems = [];
  const namesServiceRole = (list) => /\bservice_role\b/i.test(list);

  // (1) REVOKE ALL ... ON public.<table> FROM ... service_role.
  let revoked = false;
  const reRevoke = new RegExp(`\\brevoke\\s+(?:grant\\s+option\\s+for\\s+)?all(?:\\s+privileges)?\\s+on\\s+(?:table\\s+)?public\\.${table}\\b\\s+from\\s+([^;]*)`, "ig");
  let rm;
  while ((rm = reRevoke.exec(masked))) { if (namesServiceRole(rm[1])) { revoked = true; break; } }
  if (expected.revokeAll && !revoked) {
    problems.push({ code: "SERVICE_ROLE_REVOKE_MISSING", reason: `no REVOKE ALL ... ON public.${table} FROM ... service_role (Supabase default privileges would otherwise leave service_role with ALL)` });
  }

  // (2) FINAL verb set (Round-5 blocker 5): replay every GRANT/REVOKE on this exact table in source order
  //     (finalRoleGrants) and require service_role's FINAL set to equal exactly the expected set -- a union
  //     of historical grants would accept a verb a later REVOKE removed. The REVOKE ALL presence check in
  //     (1) stays separate: it strips Supabase's project-level DEFAULT privileges, which exist OUTSIDE this
  //     migration's text, so the replay alone cannot prove those are gone.
  let sawGrant = false;
  const reGrant = new RegExp(`\\bgrant\\s+([^;]*?)\\s+on\\s+(?:table\\s+)?public\\.${table}\\b\\s+to\\s+([^;]*)`, "ig");
  let gm;
  while ((gm = reGrant.exec(masked))) { if (namesServiceRole(gm[2])) { sawGrant = true; break; } }
  const want = [...(expected.grants || [])].map((p) => p.toLowerCase()).sort();
  const got = [...(finalRoleGrants(masked, table).get("service_role") || new Set())].sort();
  // Display only: a final set that IS the complete table-privilege set reads as [all] (the comparison above
  // always runs on the expanded verbs, so a GRANT ALL can never sneak past by matching the label).
  const gotLabel = arraysEqual(got, [...ALL_TABLE_PRIVS].sort()) ? ["all"] : got;
  if (!sawGrant) {
    problems.push({ code: "SERVICE_ROLE_GRANT_MISSING", reason: `no GRANT ... ON public.${table} TO service_role` });
  } else if (!arraysEqual(got, want)) {
    problems.push({ code: "SERVICE_ROLE_GRANT_MISMATCH", reason: `service_role grants on public.${table} are [${gotLabel.join(", ")}] (expected exactly [${want.join(", ")}])` });
  }
  return problems;
}

// BOUNDED presence proofs on `masked` (comments AND string CONTENTS blanked, so a comment/string can never
// satisfy them) for a table's required INDEX / RLS-enablement / generic (non append-guard) TRIGGER. Each is
// pinned to the EXACT public.<table> object with a trailing word boundary (senior-review Finding 3).
function indexPresent(masked, table, indexName) {
  return new RegExp(`create\\s+index\\s+(?:if\\s+not\\s+exists\\s+)?${indexName}\\s+on\\s+public\\.${table}\\b`, "i").test(masked);
}
// The EXACT ordered column list of a `create index <name> on public.<table> [using <m>] (col, ...)` in `masked`
// (comments/strings blanked, so a comment/string can never satisfy it), or null when the index is absent. Index
// columns are plain identifiers, so the masked view preserves them; the order is significant (gap 4a).
function indexColumns(masked, table, indexName) {
  const m = new RegExp(`create\\s+index\\s+(?:if\\s+not\\s+exists\\s+)?${indexName}\\s+on\\s+public\\.${table}\\b\\s*(?:using\\s+[a-z0-9_]+\\s*)?\\(`, "i").exec(masked);
  if (!m) return null;
  const range = balancedRange(masked, masked.indexOf("(", m.index + m[0].length - 1));
  if (!range) return null;
  return splitCols(masked.slice(range.open + 1, range.close));
}
function rlsEnabledFor(masked, table) {
  return new RegExp(`alter\\s+table\\s+public\\.${table}\\s+enable\\s+row\\s+level\\s+security`, "i").test(masked);
}
function triggerPresentFor(masked, table, name) {
  return new RegExp(`create\\s+trigger\\s+${name}\\b[^;]*\\bon\\s+public\\.${table}\\b`, "i").test(masked);
}
// BOUNDED STRUCTURAL proof of a GENERIC (non append-guard) trigger against an expected spec (gap 4b): the EXACT
//   `create trigger <name> <timing> <event[ or event...]> on public.<table> for each {row|statement}
//    execute {function|procedure} public.<fn>()`
// on `masked`. The single regex pins the timing (BEFORE/AFTER), the EXACT event list (order-anchored: `on` must
// immediately follow the last event, so a DELETE/INSERT or an extra event fails), the level (rejects the wrong
// FOR EACH), the table, and the executed function. A `drop trigger` for THIS trigger AFTER the create makes it
// absent at apply time -> invalid.
function genericTriggerValid(masked, table, spec) {
  const events = (spec.events || []).map((e) => String(e).toLowerCase()).join("\\s+or\\s+");
  const level = spec.level === "statement" ? "for\\s+each\\s+statement" : "for\\s+each\\s+row";
  const re = new RegExp(
    `create\\s+trigger\\s+${spec.name}\\s+${spec.timing}\\s+${events}\\s+on\\s+public\\.${table}\\s+${level}\\s+execute\\s+(?:function|procedure)\\s+public\\.${spec.function}\\s*\\(\\s*\\)`,
    "i",
  );
  const m = re.exec(masked);
  if (!m) return { valid: false, reason: `no exact '${spec.timing} ${(spec.events || []).join(" or ")} on public.${table} for each ${spec.level || "row"} execute function public.${spec.function}()'` };
  const dropRe = new RegExp(`drop\\s+trigger\\s+(?:if\\s+exists\\s+)?${spec.name}\\b[^;]*\\bon\\s+public\\.${table}\\b`, "i");
  if (dropRe.test(masked.slice(m.index + m[0].length))) return { valid: false, reason: "a DROP TRIGGER for this trigger appears after the create" };
  return { valid: true, reason: null };
}

// BOUNDED STRUCTURAL proof of an append-guard trigger (Finding 2): an EXACT
//   `create trigger <name> before insert or update on public.<table> for each row
//    execute function public.reject_append_to_terminal_cycle()`
// on `masked` (comments/strings blanked, so a comment/string can never satisfy it). The single regex pins the
// timing (BEFORE), the EXACT events (INSERT OR UPDATE -- not DELETE, not INSERT-only/UPDATE-only, not extra
// events since `on` must immediately follow `update`), the level (FOR EACH ROW -- rejects statement-level),
// the table (public.<table>), and the executed function. A `drop trigger` for THIS trigger/table AFTER the
// create (create-then-drop) makes it absent at apply time -> invalid.
function triggerStructurallyValid(masked, name, table) {
  const re = new RegExp(
    `create\\s+trigger\\s+${name}\\s+before\\s+insert\\s+or\\s+update\\s+on\\s+public\\.${table}\\s+for\\s+each\\s+row\\s+execute\\s+function\\s+public\\.reject_append_to_terminal_cycle\\s*\\(\\s*\\)`,
    "i",
  );
  const m = re.exec(masked);
  if (!m) return { valid: false, reason: "no exact 'before insert or update on public." + table + " for each row execute function public.reject_append_to_terminal_cycle()'" };
  const dropRe = new RegExp(`drop\\s+trigger\\s+(if\\s+exists\\s+)?${name}\\b[^;]*\\bon\\s+public\\.${table}\\b`, "i");
  if (dropRe.test(masked.slice(m.index + m[0].length))) return { valid: false, reason: "a DROP TRIGGER for this trigger appears after the create" };
  return { valid: true, reason: null };
}

// The `$$...$$` body of `create or replace function public.<fnName>()`, in BOTH lexed views (length-aligned),
// or null. The lexer keeps `as $$...$$` CODE bodies in `masked` (inner strings blanked) and preserves them in
// `clean` (strings kept), so structural code is read from `masked` and exact string literals from `clean`.
function functionBodyViews(clean, masked, fnName) {
  const m = new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${fnName}\\s*\\(`, "i").exec(masked);
  if (!m) return null;
  const open = masked.indexOf("$$", m.index);
  if (open < 0) return null;
  const close = masked.indexOf("$$", open + 2);
  if (close < 0) return null;
  return { clean: clean.slice(open + 2, close), masked: masked.slice(open + 2, close) };
}

// PL/pgSQL guard proof: RAISE EXCEPTION must be the FIRST EXECUTABLE STATEMENT on the true path of the IF block
// WHOSE HEADER matches `headerRe` (in the function body's `masked` view). Because `masked` blanks BOTH comments
// and strings to whitespace, the text immediately after the header's THEN -- once leading whitespace/comments are
// skipped -- must begin with exactly `RAISE EXCEPTION`. Any other executable statement first (RETURN, PERFORM,
// NULL, an assignment, a nested IF/CASE/LOOP/BEGIN block), a raise moved after END IF, or a raise forged in a
// comment/string, all fail. An optional `headerStrRe` requires a specific string literal in the block HEADER
// (checked in `clean`, so a comment cannot forge it, and the masked header code anchors it to the real condition).
function ifBlockRaises(body, { headerRe, headerStrRe }) {
  const h = headerRe.exec(body.masked);
  if (!h) return false;
  if (headerStrRe && !headerStrRe.test(body.clean.slice(h.index, h.index + h[0].length))) return false;
  return /^\s*raise\s+exception\b/i.test(body.masked.slice(h.index + h[0].length));
}

// Prove reject_append_to_terminal_cycle's CRITICAL BEHAVIOR, each condition BOUND to its OWN rejecting IF block
// with RAISE EXCEPTION as the FIRST executable statement (so removing/deferring one block's raise fails even if
// another block still raises). FOR SHARE is a locking clause (not an IF block) and is proven separately in
// `masked`; and the whole function must carry NO EXCEPTION handler that could swallow those raises.
function auditGuardFunction(clean, masked, fnName) {
  const body = functionBodyViews(clean, masked, fnName);
  if (!body) return [{ code: "GUARD_FUNCTION_MISSING", reason: "function body not found" }];
  const problems = [];
  // (0) The function must contain NO exception handler that could catch/swallow the guard raises. plpgsql spells
  // a handler section `EXCEPTION WHEN ...`; a `RAISE EXCEPTION` (the raises themselves) is never followed by WHEN,
  // and strings are blanked in `masked`, so this matches only a real handler section -- the approved function has
  // none.
  if (/\bexception\s+when\b/i.test(body.masked)) {
    problems.push({ code: "GUARD_EXCEPTION_HANDLER_PRESENT", reason: "an EXCEPTION handler is present that could catch/swallow the guard raises" });
  }
  // (1) UPDATE cannot change cycle_id -- its OWN IF block raises.
  if (!ifBlockRaises(body, {
    headerRe: /\bif\b[^;]*?\bnew\.cycle_id\s+is\s+distinct\s+from\s+old\.cycle_id\s+then/i,
    headerStrRe: /\btg_op\s*=\s*'update'/i,
  })) {
    problems.push({ code: "GUARD_CYCLE_ID_IMMUTABLE_MISSING", reason: "the TG_OP='UPDATE' AND NEW.cycle_id IS DISTINCT FROM OLD.cycle_id block does not RAISE EXCEPTION before its END IF" });
  }
  // (2) parent sync_cycles row locked FOR SHARE (a lock clause, not an IF block).
  if (!/from\s+public\.sync_cycles\s+where\s+id\s*=\s*new\.cycle_id\s+for\s+share/i.test(body.masked)) {
    problems.push({ code: "GUARD_FOR_SHARE_MISSING", reason: "parent sync_cycles row is not locked FOR SHARE" });
  }
  // (3) missing parent fails closed -- the IF NOT FOUND block raises.
  if (!ifBlockRaises(body, { headerRe: /\bif\s+not\s+found\s+then/i })) {
    problems.push({ code: "GUARD_MISSING_PARENT_NOT_FAILCLOSED", reason: "the IF NOT FOUND block does not RAISE EXCEPTION before its END IF" });
  }
  // (4) terminal succeeded|partial|failed parents rejected -- the v_status IN (...) block raises.
  if (!ifBlockRaises(body, {
    headerRe: /\bif\s+v_status\s+in\s*\([^;]*?\)\s+then/i,
    headerStrRe: /'succeeded'\s*,\s*'partial'\s*,\s*'failed'/i,
  })) {
    problems.push({ code: "GUARD_TERMINAL_REJECT_MISSING", reason: "the v_status IN ('succeeded','partial','failed') block does not RAISE EXCEPTION before its END IF" });
  }
  return problems;
}

// Prove adopt_source_export_cache's CRITICAL behavior (senior review gap 4c). Read from the function body's
// `masked` (structure; string literals blanked) + `clean` (string literals preserved). The adoption CAS must:
//   (1) LOCK the ACTUAL current cache row FOR UPDATE (keyed by request_hash) -- never a stale unlocked read;
//   (2) gate on the DB expiry (v_cache.expires_at <= now()), not the caller's value;
//   (3) compare the FULL identity/integrity set (all six fields) against the caller's expectations;
//   (4) write the DB row's OWN values (row_count / payload_bytes / object_path), never the caller's; and
//   (5) CAS only a still pending / unattempted / create_export_count=0 job (the one-attempt invariant).
function auditAdoptCacheFunction(clean, masked, fnName) {
  const body = functionBodyViews(clean, masked, fnName);
  if (!body) return [{ code: "ADOPT_CACHE_FUNCTION_MISSING", reason: "function body not found" }];
  const problems = [];
  const M = body.masked;
  const C = body.clean;
  // (1) FOR UPDATE lock on the real cache row keyed by request_hash (bounded to the one SELECT statement).
  if (!/from\s+public\.source_export_cache\b[^;]*\bwhere\s+request_hash\s*=\s*p_request_hash\b[^;]*\bfor\s+update\b/i.test(M)) {
    problems.push({ code: "ADOPT_CACHE_ROW_LOCK_MISSING", reason: "does not SELECT ... FROM public.source_export_cache WHERE request_hash = p_request_hash FOR UPDATE" });
  }
  // (2) expiry gate on the AUTHORITATIVE db value.
  if (!/v_cache\.expires_at\s*<=\s*now\s*\(\s*\)/i.test(M)) {
    problems.push({ code: "ADOPT_CACHE_EXPIRY_GATE_MISSING", reason: "does not gate on v_cache.expires_at <= now()" });
  }
  // (3) FULL identity/integrity comparison: every field vs the caller's expectation.
  const idFields = [
    ["source_id", "p_expected_source_id"],
    ["organization_fingerprint", "p_expected_organization_fingerprint"],
    ["account_scope_hash", "p_expected_account_scope_hash"],
    ["object_path", "p_expected_object_path"],
    ["row_count", "p_expected_row_count"],
    ["payload_bytes", "p_expected_payload_bytes"],
  ];
  const missingId = idFields.filter(([f, p]) => !new RegExp(`v_cache\\.${f}\\s+is\\s+distinct\\s+from\\s+${p}\\b`, "i").test(M));
  if (missingId.length) {
    problems.push({ code: "ADOPT_CACHE_IDENTITY_CHECK_MISSING", reason: `missing identity/integrity comparison(s): ${missingId.map(([f]) => f).join(", ")}` });
  }
  // (4) the adoption writes the DB row's OWN values (never the caller's expectations).
  const dbOwned = [["row_count", "v_cache\\.row_count"], ["payload_bytes", "v_cache\\.payload_bytes"], ["cache_object_path", "v_cache\\.object_path"]];
  const missingOwned = dbOwned.filter(([col, val]) => !new RegExp(`\\b${col}\\s*=\\s*${val}\\b`, "i").test(M));
  if (missingOwned.length) {
    problems.push({ code: "ADOPT_CACHE_DB_OWNED_VALUES_MISSING", reason: `adoption does not write DB-owned value(s): ${missingOwned.map(([c]) => c).join(", ")}` });
  }
  // (5) CAS predicate: adopt only a still pending/unattempted/count=0 job. The 'pending' literal is read from
  //     `clean` (it is blanked in `masked`); the structural guards are read from `masked`.
  const casOk = /\bfetch_status\s*=\s*'pending'/i.test(C) && /\battempted_at\s+is\s+null\b/i.test(M) && /\bcreate_export_count\s*=\s*0\b/i.test(M);
  if (!casOk) {
    problems.push({ code: "ADOPT_CACHE_CAS_PREDICATE_MISSING", reason: "the adoption UPDATE is not gated on fetch_status='pending' AND attempted_at IS NULL AND create_export_count = 0" });
  }
  return problems;
}

// Prove assign_source_account_batch's CRITICAL behavior (senior review gap 4d): it (1) serialises assignments
// within a family via a per-family advisory xact lock; (2) hard-caps the per-family maximum to EXACTLY 5 (a
// widened cap fails); and (3) REJECTS an existing membership whose stored connection/organization scope differs
// from the caller's (RAISE EXCEPTION, no silent re-home). The direct-write ban is enforced by the SELECT-only
// service_role ACL, audited separately.
function auditAssignBatchFunction(clean, masked, fnName) {
  const body = functionBodyViews(clean, masked, fnName);
  if (!body) return [{ code: "ASSIGN_BATCH_FUNCTION_MISSING", reason: "function body not found" }];
  const problems = [];
  const M = body.masked;
  const compact = M.replace(/\s+/g, "").toLowerCase();
  // (1) per-family advisory xact lock.
  if (!/pg_advisory_xact_lock\s*\(\s*hashtext\s*\(\s*p_batch_family\s*\)\s*\)/i.test(M)) {
    problems.push({ code: "ASSIGN_BATCH_ADVISORY_LOCK_MISSING", reason: "does not take pg_advisory_xact_lock(hashtext(p_batch_family))" });
  }
  // (2) hard <=5 cap: the effective max is least(greatest(coalesce(p_max, 5), 1), 5). Pins the ceiling to
  //     EXACTLY 5, so widening the outer bound (e.g. ...,6)) fails.
  if (!compact.includes("least(greatest(coalesce(p_max,5),1),5)")) {
    problems.push({ code: "ASSIGN_BATCH_MAX_CAP_MISSING", reason: "the per-family maximum is not hard-capped to 5 via least(greatest(coalesce(p_max,5),1),5)" });
  }
  // (3) an existing membership with a DIFFERENT connection/organization scope is REJECTED with RAISE EXCEPTION.
  if (!ifBlockRaises(body, { headerRe: /\bif\s+v_conn\s+is\s+distinct\s+from\s+p_connection_id\s+or\s+v_org\s+is\s+distinct\s+from\s+p_organization_fingerprint\s+then/i })) {
    problems.push({ code: "ASSIGN_BATCH_SCOPE_MATCH_MISSING", reason: "an existing membership with a different connection/organization scope is not rejected with RAISE EXCEPTION" });
  }
  return problems;
}

// Prove reserve_source_export_create's CRITICAL behavior (Blocker 4d): it (1) takes the per-(cycle,tranche)
// advisory lock; (2) LOCKS the budget row FOR UPDATE (deadlock-safe order); (3) rejects a drifted plan
// fingerprint; (4) reads the hash's cost from the frozen plan (rejecting a hash outside it); (5) refuses to
// exceed EITHER the create ceiling OR the token ceiling; (6) CLAIMS only a still pending/unattempted/count=0
// source job (mutual exclusion with adoption); and (7) reserves the create + token spend. Structure from the
// function body's masked view (string literals blanked); the 'pending' literal from clean.
function auditReserveCreateFunction(clean, masked, fnName) {
  const body = functionBodyViews(clean, masked, fnName);
  if (!body) return [{ code: "RESERVE_FUNCTION_MISSING", reason: "function body not found" }];
  const problems = [];
  const M = body.masked;
  const C = body.clean;
  if (!/pg_advisory_xact_lock\s*\(\s*hashtext\s*\(/i.test(M)) {
    problems.push({ code: "RESERVE_ADVISORY_LOCK_MISSING", reason: "does not take a per-(cycle,tranche) pg_advisory_xact_lock(hashtext(...))" });
  }
  if (!/from\s+public\.source_tranche_budget\b[^;]*\bwhere\s+cycle_id\s*=\s*p_cycle_id\b[^;]*\btranche_key\s*=\s*p_tranche_key\b[^;]*\bfor\s+update\b/i.test(M)) {
    problems.push({ code: "RESERVE_BUDGET_LOCK_MISSING", reason: "does not SELECT ... FROM public.source_tranche_budget ... FOR UPDATE" });
  }
  if (!/v_budget\.plan_fingerprint\s+is\s+distinct\s+from\s+p_plan_fingerprint/i.test(M)) {
    problems.push({ code: "RESERVE_PLAN_FINGERPRINT_CHECK_MISSING", reason: "does not reject a drifted plan_fingerprint" });
  }
  if (!/from\s+public\.source_tranche_budget_hash\b[^;]*\brequest_hash\s*=\s*p_request_hash/i.test(M)) {
    problems.push({ code: "RESERVE_HASH_MEMBERSHIP_MISSING", reason: "does not verify the request_hash belongs to the frozen plan (source_tranche_budget_hash)" });
  }
  const createsCeil = /spent_creates\s*\+\s*1\s*>\s*v_budget\.max_creates/i.test(M);
  const tokensCeil = /spent_tokens\s*\+\s*v_cost\s*>\s*v_budget\.max_tokens/i.test(M);
  if (!createsCeil || !tokensCeil) {
    problems.push({ code: "RESERVE_CEILING_CHECK_MISSING", reason: "does not refuse to exceed BOTH spent_creates+1<=max_creates AND spent_tokens+cost<=max_tokens" });
  }
  const claim = /update\s+public\.sync_source_jobs\b/i.test(M)
    && /\bfetch_status\s*=\s*'pending'/i.test(C)
    && /\battempted_at\s+is\s+null\b/i.test(M)
    && /\bcreate_export_count\s*=\s*0\b/i.test(M);
  if (!claim) {
    problems.push({ code: "RESERVE_JOB_CLAIM_MISSING", reason: "does not CLAIM a still pending/unattempted/count=0 sync_source_jobs row (mutual exclusion with adoption)" });
  }
  const spend = /spent_creates\s*=\s*spent_creates\s*\+\s*1/i.test(M) && /spent_tokens\s*=\s*spent_tokens\s*\+\s*v_cost/i.test(M);
  if (!spend) {
    problems.push({ code: "RESERVE_SPEND_MISSING", reason: "does not reserve the create + token cost (spent_creates+1, spent_tokens+cost)" });
  }
  return problems;
}

// Finding 5 structural proof: the atomic OLI window replacement + coverage acknowledgement. The function
// body must (a) validate every supplied row FAIL-CLOSED before any mutation, (b) DELETE the account's
// history rows inside the window, (c) INSERT the corrected rows, and (d) UPSERT the source_coverage
// acknowledgement -- all in the SAME body (one transaction), so data replacement and coverage can never
// diverge and a grain that disappeared from a corrected export can never survive.
function auditReplaceOliFunction(clean, masked, fnName) {
  const body = functionBodyViews(clean, masked, fnName);
  if (!body) return [{ code: "REPLACE_OLI_FUNCTION_MISSING", reason: "function body not found" }];
  const problems = [];
  const M = body.masked;
  const C = body.clean;
  if (!/raise\s+exception[\s\S]*jsonb_array_elements\s*\(\s*p_rows\s*\)|jsonb_array_elements\s*\(\s*p_rows\s*\)[\s\S]*raise\s+exception/i.test(M)) {
    problems.push({ code: "REPLACE_OLI_VALIDATION_MISSING", reason: "does not validate the supplied rows fail-closed before mutating" });
  }
  if (!/delete\s+from\s+public\.source_oli_daily_history\b[^;]*\baccount_id\s*=\s*p_account_id\b[^;]*\bsale_date\s+between\s+p_covered_from\s+and\s+p_covered_to/i.test(M)) {
    problems.push({ code: "REPLACE_OLI_DELETE_MISSING", reason: "does not DELETE the account's history rows inside the replaced window (a removed grain would survive)" });
  }
  if (!/insert\s+into\s+public\.source_oli_daily_history\b/i.test(M)) {
    problems.push({ code: "REPLACE_OLI_INSERT_MISSING", reason: "does not INSERT the corrected rows" });
  }
  const coverageAck = /insert\s+into\s+public\.source_coverage\b/i.test(M)
    && /on\s+conflict\b[\s\S]*do\s+update\b/i.test(M)
    && /'succeeded'/i.test(C);
  if (!coverageAck) {
    problems.push({ code: "REPLACE_OLI_COVERAGE_ACK_MISSING", reason: "does not UPSERT the succeeded coverage acknowledgement in the same transaction" });
  }
  return problems;
}

// Round-4 finding 8 structural proof: the snapshot pointer CAS must LOCK the existing row FOR UPDATE,
// refuse an OLDER save ('stale-save'), accept an equal-identical save as 'unchanged', refuse equal but
// CONFLICTING evidence ('conflict'), and replace only on a STRICTLY NEWER validated_at.
function auditSnapshotCasFunction(clean, masked, fnName) {
  const body = functionBodyViews(clean, masked, fnName);
  if (!body) return [{ code: "SNAPSHOT_CAS_FUNCTION_MISSING", reason: "function body not found" }];
  const problems = [];
  const M = body.masked;
  const C = body.clean;
  if (!/from\s+public\.source_snapshots\b[\s\S]*?for\s+update/i.test(M)) {
    problems.push({ code: "SNAPSHOT_CAS_LOCK_MISSING", reason: "does not lock the existing pointer row FOR UPDATE" });
  }
  if (!/p_validated_at\s*<\s*v_existing\.validated_at/i.test(M) || !/'stale-save'/i.test(C)) {
    problems.push({ code: "SNAPSHOT_CAS_STALE_GUARD_MISSING", reason: "does not refuse an OLDER concurrent save (stale-save)" });
  }
  if (!/'conflict'/i.test(C) || !/'unchanged'/i.test(C)) {
    problems.push({ code: "SNAPSHOT_CAS_CONFLICT_GUARD_MISSING", reason: "does not distinguish equal-identical (unchanged) from equal-conflicting (conflict) evidence" });
  }
  if (!/update\s+public\.source_snapshots\b/i.test(M)) {
    problems.push({ code: "SNAPSHOT_CAS_REPLACE_MISSING", reason: "does not replace the pointer on a strictly newer save" });
  }
  // Round-5 blocker 6: STRUCTURAL BINDING of the guard ladder. Each guard must sit in its OWN bounded
  // branch (guard -> immediate typed return and nothing else), the replacing UPDATE must be the ONLY
  // pointer write and reachable only AFTER both guards, the racing-insert path must be deterministic (a
  // typed unique_violation handler that re-locks the winner's row and falls through to the SAME guards),
  // and no generic exception handler may swallow a failure into a success acknowledgement. An `IF true`
  // guard, a moved/early UPDATE, a wrong comparison operator, or a `when others` swallow each surfaces as
  // its own typed blocker below (the comparison itself is already pinned by the guard regexes above).
  if (!/if\s+p_validated_at\s*<\s*v_existing\.validated_at\s+then\s+return\s+'stale-save'\s*;\s*end\s+if/i.test(C)) {
    problems.push({ code: "SNAPSHOT_CAS_STALE_BRANCH_UNBOUND", reason: "the stale guard is not bound to its own bounded branch (if p_validated_at < v_existing.validated_at then return 'stale-save'; end if)" });
  }
  if (!/if\s+p_validated_at\s*=\s*v_existing\.validated_at\s+then\s+if\s+v_existing\.payload_sha\s*=\s*p_payload_sha\s+and\s+v_existing\.object_path\s*=\s*p_object_path\s+then\s+return\s+'unchanged'\s*;\s*end\s+if\s*;\s*return\s+'conflict'\s*;\s*end\s+if/i.test(C)) {
    problems.push({ code: "SNAPSHOT_CAS_EQUAL_BRANCH_UNBOUND", reason: "the equal-validated_at guard is not bound to its own bounded branch (equal + identical sha/path -> 'unchanged', equal otherwise -> 'conflict', nothing else)" });
  }
  const updates = [...M.matchAll(/update\s+public\.source_snapshots\b/ig)];
  const staleIdx = M.search(/p_validated_at\s*<\s*v_existing\.validated_at/i);
  const equalIdx = M.search(/if\s+p_validated_at\s*=\s*v_existing\.validated_at/i);
  if (updates.length !== 1 || staleIdx < 0 || equalIdx < 0 || !(staleIdx < equalIdx && equalIdx < updates[0].index)) {
    problems.push({ code: "SNAPSHOT_CAS_WRITE_BEFORE_GUARDS", reason: "the replacing UPDATE must be the single pointer write, placed strictly AFTER the stale guard and the equal-validated_at guard (no write may occur before the guards run)" });
  }
  if (!/exception\s+when\s+unique_violation\s+then[\s\S]*?from\s+public\.source_snapshots\b[\s\S]*?for\s+update/i.test(M)) {
    problems.push({ code: "SNAPSHOT_CAS_CONCURRENT_INSERT_UNPROVEN", reason: "the absent-row insert race is not deterministic: no typed unique_violation handler that re-locks the winning row FOR UPDATE and falls through to the guards" });
  }
  if (/when\s+others\b/i.test(M)) {
    problems.push({ code: "SNAPSHOT_CAS_EXCEPTION_SWALLOWED", reason: "a generic WHEN OTHERS handler could swallow a failed save into a success acknowledgement; only the typed unique_violation handler is reviewed" });
  }
  return problems;
}

// Dispatch a declared RPC-body structural proof by its `proof` tag.
function auditProvenFunction(clean, masked, proof, fnName) {
  if (proof === "adopt-cache") return auditAdoptCacheFunction(clean, masked, fnName);
  if (proof === "assign-batch") return auditAssignBatchFunction(clean, masked, fnName);
  if (proof === "reserve-create") return auditReserveCreateFunction(clean, masked, fnName);
  if (proof === "replace-oli") return auditReplaceOliFunction(clean, masked, fnName);
  if (proof === "snapshot-cas") return auditSnapshotCasFunction(clean, masked, fnName);
  return [{ code: "FUNCTION_PROOF_UNKNOWN", reason: `unknown function proof "${proof}"` }];
}

// ---- JavaScript-aware lexical layer (wrapper source) -----------------------------------------------------
//
// BLOCKER 2 + endpoint-evidence hardening: wrapper-export and endpoint evidence must come from REAL JavaScript
// syntax -- never a comment, template-string text, a regex literal, a property name, OR ordinary code (an
// identifier, a division `a/b`, or a ternary `a ? b : c`). `lexJs` produces TWO length-aligned views (both keep
// newlines AND the input length, so nothing shifts):
//   - `code`: comments, string / template-text / regex-literal CONTENT, and literal delimiters all blanked;
//             ordinary code (including ${...} interpolation code) KEPT. A structural `export async function
//             <name>(` therefore matches ONLY a genuine top-level declaration -- a commented, quoted, template,
//             or regex fake is masked away.
//   - `literals`: ONLY genuine string CONTENT and template QUASI text kept; comments, regex, delimiters, and ALL
//             ordinary code (including interpolation code) blanked. Because delimiters and boundaries are
//             blanked, two adjacent literals -- or a literal spliced with ordinary code -- can NEVER concatenate
//             into fake endpoint evidence, and ordinary `a/rest/v1/x` division / `x ? y : z` ternary code
//             contributes nothing. A genuine nested string literal INSIDE a ${...} is preserved (it is itself a
//             literal); the ordinary interpolation code around it is not.
// Structural export checks read `code`; endpoint checks read ONLY `literals`.

// A '/' begins a regex literal (vs a division operator) when the last significant code char / preceding word is
// in an expression position. A misclassification only ever MASKS MORE (never less) -- real exports/endpoints
// never follow a '/' -- so it can neither hide a genuine export/endpoint nor admit a forged one.
const REGEX_PRECEDING_KEYWORDS = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "do", "else", "case", "yield", "await", "throw",
]);
function regexStartsHere(prevSig, codeSoFar) {
  if (prevSig === "") return true;
  if ("([{,;:=!&|?+-*%<>~^".includes(prevSig)) return true;
  if (/[A-Za-z0-9_$)\]}'"`]/.test(prevSig)) {
    const m = /([A-Za-z_$][A-Za-z0-9_$]*)\s*$/.exec(codeSoFar);
    return !!(m && REGEX_PRECEDING_KEYWORDS.has(m[1]));
  }
  return true;
}
// Skip a '...' / "..." string (s[start] is the quote); return the index AFTER the closer.
function skipJsString(s, start) {
  const q = s[start];
  let i = start + 1;
  while (i < s.length) {
    if (s[i] === "\\") { i += 2; continue; }
    if (s[i] === q) return i + 1;
    if (s[i] === "\n") return i; // unterminated on the line -- stop defensively
    i += 1;
  }
  return i;
}
// Skip a regex literal (s[start] === '/'); return the index AFTER the flags, or null if it is not a well-formed
// single-line regex (then '/' is an ordinary char, i.e. division).
function skipJsRegex(s, start) {
  let i = start + 1;
  let inClass = false;
  while (i < s.length) {
    const c = s[i];
    if (c === "\\") { i += 2; continue; }
    if (c === "\n") return null;
    if (c === "[") { inClass = true; i += 1; continue; }
    if (c === "]") { inClass = false; i += 1; continue; }
    if (c === "/" && !inClass) { i += 1; while (i < s.length && /[a-z]/i.test(s[i])) i += 1; return i; }
    i += 1;
  }
  return null;
}
function lexJs(source) {
  const s = String(source);
  let code = "";
  let lits = "";
  let prevSig = ""; // last significant (non-whitespace) code char
  const both = (seg) => { code += blankLine(seg); lits += blankLine(seg); }; // blank in BOTH: comment / regex / delimiter
  const codeOnly = (seg) => { code += seg; lits += blankLine(seg); };         // real ordinary code -- structural view only
  const litOnly = (seg) => { code += blankLine(seg); lits += seg; };          // genuine string CONTENT / template QUASI text

  // Emit a '...'/"..." string: BOTH delimiters blanked in every view; the CONTENT is kept ONLY in `lits` (so an
  // `export ...` inside a string is masked in `code`, and the delimiter blanking keeps this literal's content
  // from concatenating with an adjacent literal or with surrounding code). Returns the index AFTER the closer.
  function lexString(startI) {
    const q = s[startI];
    const end = skipJsString(s, startI);
    const terminated = end - 1 > startI && s[end - 1] === q;
    both(q);
    if (terminated) { litOnly(s.slice(startI + 1, end - 1)); both(s[end - 1]); }
    else both(s.slice(startI + 1, end)); // unterminated -- blank the remainder in both
    return end;
  }

  // Lex a `...` template: the backtick and ${ } delimiters are blanked in `lits`; QUASI text is kept in `lits`;
  // each ${...} is CODE lexed by lexCode (a genuine nested string literal inside it is preserved via litOnly;
  // ordinary interpolation code is not). Returns the index AFTER the closing backtick.
  function lexTemplate(startI) {
    both("`");
    let i = startI + 1;
    let run = "";
    const flush = () => { if (run) { litOnly(run); run = ""; } };
    while (i < s.length) {
      const c = s[i];
      if (c === "\\") { run += s.slice(i, i + 2); i += 2; continue; }
      if (c === "`") { flush(); both("`"); return i + 1; }
      if (c === "$" && s[i + 1] === "{") { flush(); codeOnly("${"); i = lexCode(i + 2, true); if (s[i] === "}") { codeOnly("}"); i += 1; } continue; }
      run += c; i += 1;
    }
    flush();
    return i;
  }

  // Lex code from index i. When `insideInterp`, stop at (and return the index of) the ${...}-closing `}` -- the
  // one at brace depth 0 -- so object/block braces inside the interpolation are balanced, not mistaken for it.
  // ALL ordinary code goes through codeOnly, so it appears in `code` but NEVER in `lits`.
  function lexCode(i, insideInterp) {
    let depth = 0;
    while (i < s.length) {
      const c = s[i];
      if (insideInterp && c === "}" && depth === 0) return i;
      if (c === "/" && s[i + 1] === "/") { let j = i + 2; while (j < s.length && s[j] !== "\n") j += 1; both(s.slice(i, j)); i = j; continue; }
      if (c === "/" && s[i + 1] === "*") { let j = i + 2; while (j < s.length && !(s[j] === "*" && s[j + 1] === "/")) j += 1; j = Math.min(j + 2, s.length); both(s.slice(i, j)); i = j; continue; }
      if (c === "'" || c === '"') { i = lexString(i); prevSig = c; continue; }
      if (c === "`") { i = lexTemplate(i); prevSig = "`"; continue; }
      if (c === "/" && regexStartsHere(prevSig, code)) { const end = skipJsRegex(s, i); if (end != null) { both(s.slice(i, end)); prevSig = "/"; i = end; continue; } }
      if (c === "{") { depth += 1; codeOnly(c); prevSig = "{"; i += 1; continue; }
      if (c === "}") { depth -= 1; codeOnly(c); prevSig = "}"; i += 1; continue; }
      codeOnly(c); if (!/\s/.test(c)) prevSig = c; i += 1;
    }
    return i;
  }

  lexCode(0, false);
  return { code, literals: lits };
}

// A required wrapper is proven ONLY by a genuine `export async function <name>(` declaration that BEGINS a
// source line (optional leading whitespace only) in the structural `code` view. LINE-ANCHORING is the crux: a
// regex literal cannot contain an unescaped newline, so a regex whose content spells the signature always keeps
// its leading `/` on the SAME line before `export` -- even when the regex is (correctly, per JS grammar)
// classified as division after a `)`/`]` control condition (`if (...) /export async function <name>(x)/`) and
// its content therefore survives in `code`. The `^[ \t]*export` anchor rejects that mid-line `export`, as well
// as an `export` embedded after any other same-line code. Comments / strings / template text / detected regex
// are already blanked in `code`; this additionally defeats the embedded-in-code and mid-line forms without any
// fragile slash-context special-casing. `[ \t]` (never `\s`) between tokens keeps the match on ONE line so a
// newline can never bridge unrelated code into the signature.
function wrapperExported(codeMasked, name) {
  return new RegExp(`^[ \\t]*export[ \\t]+async[ \\t]+function[ \\t]+${name}[ \\t]*\\(`, "m").test(codeMasked);
}

// `litView` is the wrapper source's `literals` view (ONLY genuine string CONTENT + template QUASI text; every
// comment, regex, delimiter, and all ordinary code blanked). A `/rest/v1/<table>` endpoint therefore counts
// ONLY when it appears literally inside a real string/template literal -- never from a comment, a regex, an
// identifier, a division expression, a ternary, or literal-plus-code splicing (boundaries are blank).
function sourceReferencesTable(litView, table) {
  return litView.includes(`/rest/v1/${table}?`) || litView.includes(`/rest/v1/${table}"`) || litView.includes(`/rest/v1/${table}\``);
}

function sourceReferencesRpc(litView, rpc) {
  return litView.includes(`/rest/v1/rpc/${rpc}`);
}

// The COMPLETE set of Supabase wrappers the composed Scheduler-v2 runtime depends on. The audit proves EVERY
// one is exported from the wrapper source, so wrapper availability is never claimed vacuously (blocker 3) --
// even the readers whose tables live in earlier migrations outside this phase's four (source_export_cache,
// ads_sync_state, report_snapshots). Kept in sync with runtime-composition.REQUIRED_WRAPPERS (re-exported there).
export const REQUIRED_WRAPPER_EXPORTS = Object.freeze([
  "openSyncCycle", "claimSyncCycle", "getSyncCycle", "updateSyncCycleCounts", "finalizeSyncCycle", "claimSourceExportAttempt",
  "upsertSyncSourceJob", "getSyncSourceJobs", "recordSyncSourceSuccess", "recordSyncSourceExportCreated",
  "recordSyncSourceFailure", "getSyncReportJobs", "upsertSyncReportJob", "claimReportDeriveAttempt",
  "recordSyncReportBlocked", "recordSyncReportFailure", "recordSyncReportSuccess",
  "upsertSyncSourceJobOwners", "getSyncSourceJobOwners", "getSyncSourceJobsForOwners", "recordSyncSourceJobOwnerStale",
  "getSourceExportCache", "getDailyAdsCoverage", "recordAdsCoverageWindows", "getReportSyncSettings",
  "getAdDailyMetrics", "getAdsDailySourceRows", "getAdsSyncStates", "saveReportSnapshot",
  "getSchedulerAccountRollout", "getSchedulerPublishApproval", "publishLiveSnapshotIfNewer",
  // Gate-7 publisher reads: the exact-identity job row (+ its cycle status), the exact-identity shadow
  // snapshot, and the trusted storage hydration for a storage-backed snapshot payload.
  "getLatestSyncReportJob", "getReportSnapshot", "getReportSnapshotStoragePayload",
  // Blocker 2 + 4 (senior review): the atomic cache-adoption CAS and the stable <=5 batch assignment/read.
  "adoptSourceExportCache", "assignSourceAccountBatch", "listSourceBatchMembership",
  // Blocker 4d: the frozen tranche budget persist + the atomic pre-POST reservation + the budget/hash readers.
  "persistSourceTrancheBudget", "reserveSourceExportCreate", "getSourceTrancheBudget", "getSourceTrancheBudgetHashes",
]);

/**
 * STATICALLY audit the declared Scheduler-v2 schema contract against the committed migration SQL and the
 * committed wrapper source. Returns `{ ok, matrix, blockers }`:
 *   - `matrix`: one row per migration -> { present, tables:[{name, declared, backedUniques, missingColumns,
 *       referencedByWrapper}], rpcs:[{name, declared, referencedByWrapper}], wrappers:[{name, exported}] };
 *   - `blockers`: typed SAFE codes (MIGRATION_MISSING / TABLE_MISSING / CONSTRAINT_MISSING / COLUMN_MISSING /
 *       NAMED_CONSTRAINT_MISSING / SERVICE_ROLE_REVOKE_MISSING / SERVICE_ROLE_GRANT_MISSING /
 *       SERVICE_ROLE_GRANT_MISMATCH / RPC_MISSING / RPC_WRAPPER_MISSING / TABLE_WRAPPER_MISSING /
 *       WRAPPER_MISSING) -- never a raw SQL line.
 * `readFile(relPath)` resolves a migration by basename and the wrapper source by the sentinel
 * "supabase.js"; it MUST throw or return null for an absent file (treated as MIGRATION_MISSING / a fatal
 * WRAPPER_SOURCE_MISSING). Pure given `readFile` (no fs/network/db import here).
 */
export function auditSchemaContract({ readFile, wrapperSourceName = "supabase.js" } = {}) {
  if (typeof readFile !== "function") {
    throw new Error("auditSchemaContract requires an injected readFile(path) reader.");
  }
  const blockers = [];
  const safeRead = (name) => { try { const t = readFile(name); return typeof t === "string" ? t : null; } catch (_e) { return null; } };

  const wrapperSource = safeRead(wrapperSourceName);
  if (wrapperSource == null) {
    // Without the wrapper source we cannot prove any contract; fail closed rather than pass vacuously. The
    // result is still TOTAL -- {ok, matrix, blockers, requiredWrappers} -- so no caller (e.g. the preflight)
    // ever dereferences an undefined field (fix 2). Every required wrapper is reported missing (unprovable).
    return {
      ok: false,
      matrix: [],
      blockers: [{ code: "WRAPPER_SOURCE_MISSING", target: wrapperSourceName, message: "wrapper source file could not be read" }],
      requiredWrappers: { total: REQUIRED_WRAPPER_EXPORTS.length, missing: [...REQUIRED_WRAPPER_EXPORTS], ok: false },
    };
  }
  // JS-aware views of the wrapper source: `wrapperCode` (comments + literal contents + delimiters blanked, real
  // code kept) proves genuine exported async functions; `wrapperLiterals` (ONLY genuine string content + template
  // quasi text kept) proves genuine endpoint URLs. No comment, string/template text, regex, identifier, division,
  // ternary, or literal-plus-code splice can forge structural export OR endpoint evidence (blocker 2 + endpoint).
  const { code: wrapperCode, literals: wrapperLiterals } = lexJs(wrapperSource);

  const matrix = [];
  for (const entry of SCHEDULER_V2_SCHEMA_CONTRACT) {
    const raw = safeRead(entry.migration);
    const row = { migration: entry.migration, present: raw != null, note: entry.note || null, tables: [], rpcs: [], triggers: [], guardFunctions: [], provenFunctions: [], wrappers: [], namedConstraints: [] };
    if (raw == null) {
      blockers.push({ code: "MIGRATION_MISSING", migration: entry.migration, message: `migration ${entry.migration} not found` });
      matrix.push(row);
      continue;
    }
    // SQL-aware lexing: `masked` (comments + quoted/dollar-string CONTENTS blanked) drives ALL structural
    // discovery; `clean` (strings preserved) supplies a real CHECK body once one is structurally located.
    const { clean, masked } = lexSql(raw);
    for (const t of entry.tables) {
      const body = tableBody(masked, t.name);
      const declared = body != null;
      const backedUniques = (t.unique || []).filter((cols) => keyIsBacked(body, cols));
      const missingColumns = declared ? (t.keyColumns || []).filter((c) => !bodyDeclaresColumn(body, c)) : (t.keyColumns || []);
      // Each named constraint must be PROVEN for THIS table (created in its CREATE body or via ALTER TABLE
      // public.<table> ADD CONSTRAINT), not dropped, and matching the expected kind/columns/FK-target/exact
      // CHECK expression. A wrong-table, dropped, or comment/quoted-string-only mention is unproven (fix 1).
      const namedResults = (t.namedConstraints || []).map((c) => ({ name: c.name, ...namedConstraintProven(masked, clean, t.name, c) }));
      const unprovenNamed = namedResults.filter((r) => !r.proven);
      const referencedByWrapper = sourceReferencesTable(wrapperLiterals, t.name);
      if (!declared) blockers.push({ code: "TABLE_MISSING", migration: entry.migration, table: t.name, message: `table public.${t.name} is not created by ${entry.migration}` });
      if (declared && backedUniques.length !== (t.unique || []).length) {
        blockers.push({ code: "CONSTRAINT_MISSING", migration: entry.migration, table: t.name, message: `table public.${t.name} is missing an expected primary-key/unique constraint the wrappers upsert on` });
      }
      if (unprovenNamed.length) blockers.push({ code: "NAMED_CONSTRAINT_MISSING", migration: entry.migration, table: t.name, constraints: unprovenNamed.map((r) => r.name), message: `table public.${t.name} has unproven required named constraint(s): ${unprovenNamed.map((r) => `${r.name} (${r.reason})`).join(", ")}` });
      if (missingColumns.length) blockers.push({ code: "COLUMN_MISSING", migration: entry.migration, table: t.name, columns: missingColumns, message: `table public.${t.name} is missing wrapper-required column(s): ${missingColumns.join(", ")}` });
      if (!referencedByWrapper) blockers.push({ code: "TABLE_WRAPPER_MISSING", migration: entry.migration, table: t.name, message: `no wrapper references table public.${t.name}` });
      // Least-privilege service_role ACL (proven only when declared as a contract requirement for this table).
      const aclProblems = t.serviceRoleAcl ? auditServiceRoleAcl(masked, t.name, t.serviceRoleAcl) : [];
      for (const p of aclProblems) blockers.push({ code: p.code, migration: entry.migration, table: t.name, message: `table public.${t.name} service_role ACL: ${p.reason}` });
      // Required index(es): proven by NAME and (when declared) EXACT columns/order (gap 4a).
      for (const ixSpec of (t.requiredIndexes || [])) {
        const spec = typeof ixSpec === "string" ? { name: ixSpec, columns: null } : ixSpec;
        const cols = indexColumns(masked, t.name, spec.name);
        if (cols == null) {
          if (!indexPresent(masked, t.name, spec.name)) blockers.push({ code: "INDEX_MISSING", migration: entry.migration, table: t.name, index: spec.name, message: `table public.${t.name} is missing required index ${spec.name}` });
          else blockers.push({ code: "INDEX_COLUMNS_MISMATCH", migration: entry.migration, table: t.name, index: spec.name, message: `index ${spec.name} on public.${t.name} has an unreadable column list` });
          continue;
        }
        if (spec.columns && !arraysEqual(cols, spec.columns.map((c) => c.toLowerCase()))) {
          blockers.push({ code: "INDEX_COLUMNS_MISMATCH", migration: entry.migration, table: t.name, index: spec.name, expected: spec.columns, message: `index ${spec.name} on public.${t.name} columns are [${cols.join(", ")}] (expected exactly [${spec.columns.join(", ")}])` });
        }
      }
      const rlsOk = t.rlsEnabled ? rlsEnabledFor(masked, t.name) : true;
      if (t.rlsEnabled && !rlsOk) blockers.push({ code: "RLS_NOT_ENABLED", migration: entry.migration, table: t.name, message: `table public.${t.name} does not ENABLE ROW LEVEL SECURITY` });
      // Required trigger(s): proven STRUCTURALLY when a spec object declares timing/events/level/function (gap
      // 4b), else name-presence only. An absent name is MISSING; a present-but-malformed trigger is INVALID.
      for (const tgSpec of (t.requiredTriggers || [])) {
        const spec = typeof tgSpec === "string" ? { name: tgSpec } : tgSpec;
        if (!triggerPresentFor(masked, t.name, spec.name)) {
          blockers.push({ code: "TABLE_TRIGGER_MISSING", migration: entry.migration, table: t.name, trigger: spec.name, message: `table public.${t.name} is missing required trigger ${spec.name}` });
          continue;
        }
        if (spec.timing || spec.events || spec.level || spec.function) {
          const v = genericTriggerValid(masked, t.name, spec);
          if (!v.valid) blockers.push({ code: "TABLE_TRIGGER_INVALID", migration: entry.migration, table: t.name, trigger: spec.name, message: `trigger ${spec.name} on public.${t.name} is not the required trigger (${v.reason})` });
        }
      }
      // Round-4 finding 2: EXACT + TERMINAL public-scoped POLICY audit. When a table declares
      // `requiredPolicies` (an array, possibly []), the audit ENUMERATES the FINAL declared policy set for
      // that table -- every `create policy` minus any policy DROPPED AFTER its creation (a create-then-drop
      // is its own typed blocker) -- and requires it to EQUAL the declared set exactly: a missing policy is
      // POLICY_MISSING, a weakened/re-scoped/wrong-predicate one is POLICY_MISMATCH, an undeclared final
      // policy is POLICY_UNEXPECTED, and a required policy created then dropped is POLICY_DROPPED.
      if (t.requiredPolicies !== undefined || t.noPoliciesAllowed === true) {
        const createdPolicies = [...masked.matchAll(new RegExp(String.raw`create\s+policy\s+(\w+)\s+on\s+public\.${t.name}\b`, "gi"))]
          .map((m) => ({ name: m[1].toLowerCase(), at: m.index }));
        const droppedPolicies = [...masked.matchAll(new RegExp(String.raw`drop\s+policy\s+(?:if\s+exists\s+)?(\w+)\s+on\s+public\.${t.name}\b`, "gi"))]
          .map((m) => ({ name: m[1].toLowerCase(), at: m.index }));
        const finalPolicies = new Set();
        for (const c of createdPolicies) {
          if (droppedPolicies.some((d) => d.name === c.name && d.at > c.at)) {
            blockers.push({ code: "POLICY_DROPPED", migration: entry.migration, table: t.name, message: `policy ${c.name} on public.${t.name} is CREATED and then DROPPED in the same migration (create-then-drop is refused)` });
          } else {
            finalPolicies.add(c.name);
          }
        }
        const requiredNames = (t.requiredPolicies || []).map((p) => String(p.name).toLowerCase());
        for (const polSpec of (t.requiredPolicies || [])) {
          if (!finalPolicies.has(String(polSpec.name).toLowerCase())) {
            blockers.push({ code: "POLICY_MISSING", migration: entry.migration, table: t.name, message: `table public.${t.name} is missing required policy ${polSpec.name} in its FINAL policy set` });
            continue;
          }
          const usingEscaped = String(polSpec.using).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const shape = new RegExp(
            String.raw`create\s+policy\s+${polSpec.name}\s+on\s+public\.${t.name}\s+for\s+${polSpec.command}\s+to\s+${polSpec.role}\s+using\s*\(\s*${usingEscaped}\s*\)`,
            "i",
          );
          if (!shape.test(masked)) {
            blockers.push({ code: "POLICY_MISMATCH", migration: entry.migration, table: t.name, message: `policy ${polSpec.name} on public.${t.name} does not match the required FOR ${polSpec.command} TO ${polSpec.role} USING (${polSpec.using}) shape` });
          }
        }
        for (const name of finalPolicies) {
          if (!requiredNames.includes(name)) {
            blockers.push({ code: "POLICY_UNEXPECTED", migration: entry.migration, table: t.name, message: `table public.${t.name} carries UNDECLARED policy ${name} (the final policy set must equal the declared set exactly)` });
          }
        }
      }
      // Round-4 finding 2: REQUIRED authenticated grants + FORBIDDEN grants. `authenticatedAcl.grants` is
      // the EXACT verb set authenticated may hold on the table; any extra authenticated verb, or ANY grant
      // to anon/public, is forbidden. (Reconciliation: an admin-read policy without its SELECT grant is
      // inert; a grant without the policy over-exposes -- both audited together.)
      if (t.authenticatedAcl) {
        // Round-5 blocker 5: assert the FINAL verb set from a SOURCE-ORDER replay of every GRANT/REVOKE on
        // this exact table (finalRoleGrants), never the union of historical grants: a verb granted then
        // revoked is NOT held, a verb revoked then re-granted IS, and a forbidden grant that a later
        // REVOKE removed is cured. Any role beyond {authenticated, service_role} whose FINAL set is
        // non-empty -- anon, public, or an arbitrary role -- is forbidden outright.
        const finalGrants = finalRoleGrants(masked, t.name);
        const authGrants = [...(finalGrants.get("authenticated") || new Set())].sort();
        const want = [...(t.authenticatedAcl.grants || [])].map((g) => g.toLowerCase()).sort();
        for (const g of want) {
          if (!authGrants.includes(g)) blockers.push({ code: "AUTH_GRANT_MISSING", migration: entry.migration, table: t.name, message: `table public.${t.name} is missing the required GRANT ${g} TO authenticated in its FINAL ACL state` });
        }
        for (const g of authGrants) {
          if (!want.includes(g)) blockers.push({ code: "AUTH_GRANT_FORBIDDEN", migration: entry.migration, table: t.name, message: `table public.${t.name}'s FINAL ACL state grants FORBIDDEN ${g} to authenticated` });
        }
        for (const [role, set] of finalGrants) {
          if (role === "authenticated" || role === "service_role") continue;
          if (set.size > 0) {
            blockers.push({ code: "AUTH_GRANT_FORBIDDEN", migration: entry.migration, table: t.name, message: `table public.${t.name}'s FINAL ACL state grants privileges to ${role} (forbidden)` });
          }
        }
      }
      row.tables.push({ name: t.name, declared, backedUniques: backedUniques.map((c) => c.join(",")), namedConstraints: namedResults.map((r) => ({ name: r.name, proven: r.proven, reason: r.reason })), missingColumns, referencedByWrapper, serviceRoleAcl: t.serviceRoleAcl ? { ok: aclProblems.length === 0, problems: aclProblems.map((p) => p.code) } : null });
    }
    // Round-4 finding 9: REQUIRED raw statements (e.g. the canonical-identity ALTER on a table another
    // (frozen) migration created). Proven by regex over the masked SQL; absence is a typed blocker.
    for (const st of entry.requiredStatements || []) {
      if (!new RegExp(st.pattern, "i").test(masked)) {
        blockers.push({ code: "STATEMENT_MISSING", migration: entry.migration, message: `required statement missing: ${st.label}` });
      }
    }
    for (const r of entry.rpcs) {
      const actualParams = rpcParamNames(masked, r.name);
      const declared = actualParams != null;
      const expectedParams = (r.params || []).map((p) => p.toLowerCase());
      const paramsMatch = declared && arraysEqual(actualParams, expectedParams);
      const referencedByWrapper = sourceReferencesRpc(wrapperLiterals, r.name);
      if (!declared) blockers.push({ code: "RPC_MISSING", migration: entry.migration, rpc: r.name, message: `RPC public.${r.name} is not created by ${entry.migration}` });
      // The exact parameter names + order MUST match what the wrapper POSTs, or the live call would fail.
      if (declared && !paramsMatch) blockers.push({ code: "RPC_PARAM_MISMATCH", migration: entry.migration, rpc: r.name, expected: expectedParams, message: `RPC public.${r.name} parameters do not match the expected names/order [${expectedParams.join(", ")}]` });
      if (!referencedByWrapper) blockers.push({ code: "RPC_WRAPPER_MISSING", migration: entry.migration, rpc: r.name, message: `no wrapper calls RPC ${r.name}` });
      row.rpcs.push({ name: r.name, declared, paramsMatch, referencedByWrapper });
    }
    for (const tg of entry.triggers || []) {
      const { valid, reason } = triggerStructurallyValid(masked, tg.name, tg.table);
      if (!valid) blockers.push({ code: "TRIGGER_INVALID", migration: entry.migration, trigger: tg.name, table: tg.table, message: `trigger ${tg.name} on public.${tg.table} is not a valid BEFORE INSERT OR UPDATE ... FOR EACH ROW EXECUTE FUNCTION public.reject_append_to_terminal_cycle() (${reason})` });
      row.triggers.push({ name: tg.name, table: tg.table, valid });
    }
    for (const fn of entry.guardFunctions || []) {
      const problems = auditGuardFunction(clean, masked, fn);
      for (const p of problems) blockers.push({ code: p.code, migration: entry.migration, target: fn, message: `guard function public.${fn}: ${p.reason}` });
      row.guardFunctions.push({ name: fn, ok: problems.length === 0, problems: problems.map((p) => p.code) });
    }
    // STRUCTURAL RPC-body proofs (gap 4c/4d): each declared function's critical behavior is proven token-aware
    // in `masked` (structure) + `clean` (string literals). A removed lock / expiry / identity check / DB-owned
    // value / CAS predicate (adopt) or a removed advisory lock / widened cap / removed scope rejection (assign)
    // each surfaces a typed blocker.
    for (const pf of entry.provenFunctions || []) {
      const problems = auditProvenFunction(clean, masked, pf.proof, pf.name);
      for (const p of problems) blockers.push({ code: p.code, migration: entry.migration, target: pf.name, message: `function public.${pf.name}: ${p.reason}` });
      row.provenFunctions.push({ name: pf.name, proof: pf.proof, ok: problems.length === 0, problems: problems.map((p) => p.code) });
    }
    for (const w of entry.wrappers) {
      const exported = wrapperExported(wrapperCode, w);
      if (!exported) blockers.push({ code: "WRAPPER_MISSING", migration: entry.migration, wrapper: w, message: `wrapper ${w}() is not exported from the wrapper source` });
      row.wrappers.push({ name: w, exported });
    }
    matrix.push(row);
  }

  // Prove EVERY required wrapper export exists -- not only the per-migration subset -- so the preflight never
  // claims wrapper availability that the migration matrix did not actually cover (blocker 3).
  const missingRequired = REQUIRED_WRAPPER_EXPORTS.filter((w) => !wrapperExported(wrapperCode, w));
  for (const w of missingRequired) blockers.push({ code: "REQUIRED_WRAPPER_MISSING", wrapper: w, message: `required wrapper ${w}() is not exported from the wrapper source` });
  const requiredWrappers = { total: REQUIRED_WRAPPER_EXPORTS.length, missing: missingRequired, ok: missingRequired.length === 0 };

  return { ok: blockers.length === 0, matrix, blockers, requiredWrappers };
}

// The exact table + RPC names this phase depends on (for the preflight's live/probe checks and telemetry).
export function schedulerV2SchemaObjects() {
  const tables = [];
  const rpcs = [];
  for (const entry of SCHEDULER_V2_SCHEMA_CONTRACT) {
    for (const t of entry.tables) tables.push(t.name);
    for (const r of entry.rpcs) rpcs.push(r.name);
  }
  return { tables, rpcs };
}
