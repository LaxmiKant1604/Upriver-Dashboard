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

// BOUNDED PL/pgSQL IF-block proof (Finding 2): does the IF block WHOSE HEADER matches `headerRe` (in the
// function body's `masked` view) itself contain a RAISE EXCEPTION BEFORE its OWN matching END IF? The body is
// bounded by depth-tracking IF openers / `end if` closers, so a raise in ANOTHER block, or moved before/after
// this block, never satisfies it. The raise is proven in `masked` (a comment/string cannot forge it); an
// optional `headerStrRe` requires a specific string literal in the block HEADER (checked in `clean`, so a
// comment cannot forge it, and the masked header code anchors it to the real condition).
function ifBlockRaises(body, { headerRe, headerStrRe }) {
  const h = headerRe.exec(body.masked);
  if (!h) return false;
  if (headerStrRe && !headerStrRe.test(body.clean.slice(h.index, h.index + h[0].length))) return false;
  let depth = 1;
  const re = /\bend\s+if\b|\bif\b/gi;
  re.lastIndex = h.index + h[0].length;                    // start scanning AFTER the header's `then`
  let m, end = -1;
  while ((m = re.exec(body.masked)) !== null) {
    if (m[0].toLowerCase().startsWith("end")) { if (--depth === 0) { end = m.index; break; } }
    else depth += 1;                                        // a nested IF opener
  }
  if (end < 0) return false;
  return /\braise\s+exception\b/i.test(body.masked.slice(h.index + h[0].length, end));
}

// Prove reject_append_to_terminal_cycle's CRITICAL BEHAVIOR (Finding 2), each condition BOUND to its OWN
// rejecting IF block (so removing one block's raise fails even if another block still raises). FOR SHARE is a
// locking clause (not an IF block) and is proven separately in `masked`.
function auditGuardFunction(clean, masked, fnName) {
  const body = functionBodyViews(clean, masked, fnName);
  if (!body) return [{ code: "GUARD_FUNCTION_MISSING", reason: "function body not found" }];
  const problems = [];
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
    const row = { migration: entry.migration, present: raw != null, note: entry.note || null, tables: [], rpcs: [], triggers: [], guardFunctions: [], wrappers: [], namedConstraints: [] };
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
      row.tables.push({ name: t.name, declared, backedUniques: backedUniques.map((c) => c.join(",")), namedConstraints: namedResults.map((r) => ({ name: r.name, proven: r.proven, reason: r.reason })), missingColumns, referencedByWrapper });
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
