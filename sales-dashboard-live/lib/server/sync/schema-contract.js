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
        namedConstraints: ["sync_cycles_bucket_date_unique"],
        keyColumns: ["id", "bucket", "cycle_date", "trigger", "status", "scheduled_at", "started_at", "finished_at",
          "source_total", "source_succeeded", "source_failed", "report_total", "report_succeeded", "report_failed", "counts"],
      },
      {
        name: "sync_source_jobs",
        unique: [["cycle_id", "request_hash"]],
        // The one-attempt invariant the rollout token budget relies on (DB-level "one create-export per
        // (cycle, request_hash)") + the dedup unique. Both are NAMED and audited by name.
        namedConstraints: ["sync_source_jobs_cycle_hash_unique", "sync_source_jobs_one_attempt"],
        keyColumns: ["cycle_id", "request_hash", "source_id", "source_key", "organization_fingerprint", "connection_id",
          "account_scope_hash", "request_meta", "bucket", "fetch_status", "attempted_at", "create_export_count",
          "export_id", "error_stage", "error_code", "error_message", "terminal", "row_count", "payload_bytes", "cache_object_path"],
      },
      {
        name: "sync_report_jobs",
        unique: [["cycle_id", "report_key", "account_id"]],
        namedConstraints: ["sync_report_jobs_cycle_report_account_unique"],
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
        namedConstraints: ["sync_source_job_owners_unique", "sync_source_job_owners_source_fk",
          "sync_source_job_owners_connection_id_check", "sync_source_job_owners_identity_nonempty"],
        keyColumns: ["cycle_id", "request_hash", "owner_id", "request_key", "report_key", "account_id",
          "connection_id", "organization_fingerprint", "account_scope_hash", "owner_status", "error_code"],
      },
    ],
    rpcs: [],
    wrappers: ["upsertSyncSourceJobOwners", "getSyncSourceJobOwners", "getSyncSourceJobsForOwners", "recordSyncSourceJobOwnerStale"],
  },
]);

// ---- pure SQL/text probes (the SQL is our own committed migration; parsing is comment-stripped) ----

// Remove SQL comments so a constraint/param/table mentioned ONLY in a comment can never satisfy a contract
// check (blocker 3). Block comments first, then line comments. Our migrations carry no "--"/"/*" inside a
// string/dollar-quoted literal, so this naive strip is exact for them; it replaces each comment with a space
// to preserve token boundaries. All structural parsing below runs on the stripped text.
function stripSqlComments(sql) {
  return String(sql).replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

// Extract the body between the balanced parentheses that immediately follow `header` (a compiled regex whose
// match ends at the opening "("), or null. Runs on comment-stripped text so parens inside comments never
// unbalance the walk.
function balancedBody(cleanSql, header) {
  const m = header.exec(cleanSql);
  if (!m) return null;
  let depth = 0;
  for (let i = m.index + m[0].length - 1; i < cleanSql.length; i += 1) {
    const ch = cleanSql[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") { depth -= 1; if (depth === 0) return cleanSql.slice(m.index + m[0].length, i); }
  }
  return null;
}

// The `create table if not exists public.<name> ( ... )` body (comment-stripped), or null. Scoped so a column
// / constraint check for one table never matches text belonging to another table in the same migration file.
function tableBody(cleanSql, name) {
  return balancedBody(cleanSql, new RegExp(`create\\s+table\\s+if\\s+not\\s+exists\\s+public\\.${name}\\s*\\(`, "i"));
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

// A NAMED constraint (inline `constraint <name> ...` OR `alter table ... add constraint <name> ...`) present
// anywhere in the comment-stripped migration. Audits the critical rollout invariants by NAME.
function namedConstraintPresent(cleanSql, name) {
  return new RegExp(`\\bconstraint\\s+${name}\\b`, "i").test(cleanSql);
}

// The RPC's declared parameter NAMES in signature order (comment-stripped), or null if the function is absent.
// Each parameter's name is the first token before its type; defaults (`default ...`) are ignored.
function rpcParamNames(cleanSql, name) {
  const body = balancedBody(cleanSql, new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${name}\\s*\\(`, "i"));
  if (body == null) return null;
  const trimmed = body.trim();
  if (!trimmed) return [];
  return trimmed.split(",").map((p) => p.trim()).filter(Boolean).map((p) => p.split(/\s+/)[0].toLowerCase());
}

function arraysEqual(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);
}

function wrapperExported(source, name) {
  return new RegExp(`export\\s+async\\s+function\\s+${name}\\s*\\(`).test(source);
}

function sourceReferencesTable(source, table) {
  return source.includes(`/rest/v1/${table}?`) || source.includes(`/rest/v1/${table}"`) || source.includes(`/rest/v1/${table}\``);
}

function sourceReferencesRpc(source, rpc) {
  return source.includes(`/rest/v1/rpc/${rpc}`);
}

// The COMPLETE set of Supabase wrappers the composed Scheduler-v2 runtime depends on. The audit proves EVERY
// one is exported from the wrapper source, so wrapper availability is never claimed vacuously (blocker 3) --
// even the readers whose tables live in earlier migrations outside this phase's four (source_export_cache,
// ads_sync_state, report_snapshots). Kept in sync with runtime-composition.REQUIRED_WRAPPERS (re-exported there).
export const REQUIRED_WRAPPER_EXPORTS = Object.freeze([
  "openSyncCycle", "claimSyncCycle", "getSyncCycle", "updateSyncCycleCounts", "claimSourceExportAttempt",
  "upsertSyncSourceJob", "getSyncSourceJobs", "recordSyncSourceSuccess", "recordSyncSourceExportCreated",
  "recordSyncSourceFailure", "getSyncReportJobs", "upsertSyncReportJob", "claimReportDeriveAttempt",
  "recordSyncReportBlocked", "recordSyncReportFailure", "recordSyncReportSuccess",
  "upsertSyncSourceJobOwners", "getSyncSourceJobOwners", "getSyncSourceJobsForOwners", "recordSyncSourceJobOwnerStale",
  "getSourceExportCache", "getDailyAdsCoverage", "recordAdsCoverageWindows", "getReportSyncSettings",
  "getAdDailyMetrics", "getAdsDailySourceRows", "getAdsSyncStates", "saveReportSnapshot",
]);

/**
 * STATICALLY audit the declared Scheduler-v2 schema contract against the committed migration SQL and the
 * committed wrapper source. Returns `{ ok, matrix, blockers }`:
 *   - `matrix`: one row per migration -> { present, tables:[{name, declared, backedUniques, missingColumns,
 *       referencedByWrapper}], rpcs:[{name, declared, referencedByWrapper}], wrappers:[{name, exported}] };
 *   - `blockers`: typed SAFE codes (MIGRATION_MISSING / TABLE_MISSING / CONSTRAINT_MISSING / COLUMN_MISSING /
 *       RPC_MISSING / RPC_WRAPPER_MISSING / TABLE_WRAPPER_MISSING / WRAPPER_MISSING) -- never a raw SQL line.
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
    // Without the wrapper source we cannot prove any contract; fail closed rather than pass vacuously.
    return { ok: false, matrix: [], blockers: [{ code: "WRAPPER_SOURCE_MISSING", target: wrapperSourceName, message: "wrapper source file could not be read" }] };
  }

  const matrix = [];
  for (const entry of SCHEDULER_V2_SCHEMA_CONTRACT) {
    const raw = safeRead(entry.migration);
    const row = { migration: entry.migration, present: raw != null, note: entry.note || null, tables: [], rpcs: [], wrappers: [], namedConstraints: [] };
    if (raw == null) {
      blockers.push({ code: "MIGRATION_MISSING", migration: entry.migration, message: `migration ${entry.migration} not found` });
      matrix.push(row);
      continue;
    }
    const sql = stripSqlComments(raw); // ALL structural checks run on the comment-stripped SQL (blocker 3).
    for (const t of entry.tables) {
      const body = tableBody(sql, t.name);
      const declared = body != null;
      const backedUniques = (t.unique || []).filter((cols) => keyIsBacked(body, cols));
      const missingColumns = declared ? (t.keyColumns || []).filter((c) => !bodyDeclaresColumn(body, c)) : (t.keyColumns || []);
      const missingNamed = (t.namedConstraints || []).filter((n) => !namedConstraintPresent(sql, n));
      const referencedByWrapper = sourceReferencesTable(wrapperSource, t.name);
      if (!declared) blockers.push({ code: "TABLE_MISSING", migration: entry.migration, table: t.name, message: `table public.${t.name} is not created by ${entry.migration}` });
      if (declared && backedUniques.length !== (t.unique || []).length) {
        blockers.push({ code: "CONSTRAINT_MISSING", migration: entry.migration, table: t.name, message: `table public.${t.name} is missing an expected primary-key/unique constraint the wrappers upsert on` });
      }
      if (missingNamed.length) blockers.push({ code: "NAMED_CONSTRAINT_MISSING", migration: entry.migration, table: t.name, constraints: missingNamed, message: `table public.${t.name} is missing required named constraint(s): ${missingNamed.join(", ")}` });
      if (missingColumns.length) blockers.push({ code: "COLUMN_MISSING", migration: entry.migration, table: t.name, columns: missingColumns, message: `table public.${t.name} is missing wrapper-required column(s): ${missingColumns.join(", ")}` });
      if (!referencedByWrapper) blockers.push({ code: "TABLE_WRAPPER_MISSING", migration: entry.migration, table: t.name, message: `no wrapper references table public.${t.name}` });
      row.tables.push({ name: t.name, declared, backedUniques: backedUniques.map((c) => c.join(",")), namedConstraints: (t.namedConstraints || []).filter((n) => !missingNamed.includes(n)), missingColumns, referencedByWrapper });
    }
    for (const r of entry.rpcs) {
      const actualParams = rpcParamNames(sql, r.name);
      const declared = actualParams != null;
      const expectedParams = (r.params || []).map((p) => p.toLowerCase());
      const paramsMatch = declared && arraysEqual(actualParams, expectedParams);
      const referencedByWrapper = sourceReferencesRpc(wrapperSource, r.name);
      if (!declared) blockers.push({ code: "RPC_MISSING", migration: entry.migration, rpc: r.name, message: `RPC public.${r.name} is not created by ${entry.migration}` });
      // The exact parameter names + order MUST match what the wrapper POSTs, or the live call would fail.
      if (declared && !paramsMatch) blockers.push({ code: "RPC_PARAM_MISMATCH", migration: entry.migration, rpc: r.name, expected: expectedParams, message: `RPC public.${r.name} parameters do not match the expected names/order [${expectedParams.join(", ")}]` });
      if (!referencedByWrapper) blockers.push({ code: "RPC_WRAPPER_MISSING", migration: entry.migration, rpc: r.name, message: `no wrapper calls RPC ${r.name}` });
      row.rpcs.push({ name: r.name, declared, paramsMatch, referencedByWrapper });
    }
    for (const w of entry.wrappers) {
      const exported = wrapperExported(wrapperSource, w);
      if (!exported) blockers.push({ code: "WRAPPER_MISSING", migration: entry.migration, wrapper: w, message: `wrapper ${w}() is not exported from the wrapper source` });
      row.wrappers.push({ name: w, exported });
    }
    matrix.push(row);
  }

  // Prove EVERY required wrapper export exists -- not only the per-migration subset -- so the preflight never
  // claims wrapper availability that the migration matrix did not actually cover (blocker 3).
  const missingRequired = REQUIRED_WRAPPER_EXPORTS.filter((w) => !wrapperExported(wrapperSource, w));
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
