// Publication recovery WP15 -- the DB-ENFORCED REPORT WRITER FENCE: migration contract, fenced-CAS byte identity,
// rollback identity, the error classifier + read-only fence reader, and the EXHAUSTIVE, FAIL-CLOSED WRITER INVENTORY.
//
//   A  20260935 is expand-only + idempotent + PREPARED-not-applied: the fence table (RLS, least privilege, seed = the 10
//      route-owned keys, all fenced_only=false, shadow keys forbidden), the SECURITY DEFINER trigger function (pinned
//      search_path, dedicated SQLSTATE RWF01, 'REPORT_WRITER_FENCED:<key>', OLD + NEW key, DELETE + TRUNCATE covered),
//      the triggers (the row trigger fires LAST among report_snapshots' BEFORE triggers);
//   B  the fenced CAS in 20260935 is the LATEST prior definition BYTE-IDENTICAL except ONE added transaction-local
//      set_config, placed after every lease check and immediately before the delegation; ROLLBACK_20260935 restores
//      that prior definition byte-identically and drops the fence objects; the rollback is outside supabase/migrations;
//   C  every SQL function in supabase/migrations that writes report_snapshots is enumerated and classified; nothing but
//      the fenced CAS sets the mark;
//   D  lib/server/sync/report-writer-fence.js: classifier (pg + REST + cause chains), reader (ok / absent / unreadable /
//      invalid, fail-closed), summaries, constants == the migration;
//   E  the WRITER INVENTORY: a static taint analysis of lib/, api/, scripts/ (incl. scripts/release/, scripts/worker/,
//      scripts/test-*.mjs; only the offline *.test.js / *.test.mjs suites are excluded) from the auto-discovered
//      supabase.js sinks + direct SQL / REST / RPC / supabase-js writes (also through joined literal fragments
//      "a" + "b", ${"lit"} and folded string consts, "public"."report_snapshots" quoting, a method passed in an options
//      object), through wrappers (import-aware), namespaces (member or whole value) and dynamic imports, with SOUND
//      call-site REPORT-KEY PROOFS (a write proven to target an unfenced key or the scheduler-v2/* shadow namespace needs
//      no entry; a shadow proof must span the WHOLE key expression -- `scheduler-v2/${k}`.slice(13) or a ternary is
//      unproven; shadowing parameters, duplicate keys, spreads, multi-line initialisers and out-of-scope consts are
//      unproven), DI-forwarder proofs over every call site of the DI name (ANY non-call reference -- member read, value
//      pass, .call/.apply, aliasing, a string naming it -- keeps it tainted), and three MANUAL clears whose evidence is
//      machine-checked. Every remaining writer file must be listed with its exact tainted declarations + reached sinks
//      and a class (fenced-publisher-path | shadow-only | unfenced-keys-only | blocked-by-fence | offline-test); a new
//      unlisted writer, a new writing function or a new sink kind FAILS. A COARSE TRIPWIRE backs it: every file whose
//      comment-free code names report_snapshot* (after joining fragments, lower-casing, %5F-decoding) or performs a
//      non-GET REST call with a computed path, a computed-table .from(...).insert/upsert/update/delete, a computed
//      .rpc(...), computed-target SQL DML or a computed import()/require() specifier must be listed with its exact hit
//      signature (class read-only when it only reads). Canaries (K) prove both layers catch every known evasion
//      (incl. \x5f / %5F escapes, require(), a re-exported DI forwarder, quoted / computed / accessor reportKey keys);
//   F  mark hygiene: no application file, workflow or deploy config names or pre-sets the setting (PGOPTIONS / -c);
//      the fenced CAS has no pg-direct caller.
// The static scan is a REVIEW AID for honest mistakes, not a security boundary: the DB trigger is authoritative.
// Pure static text analysis + in-memory fakes: ZERO network / DB. The REAL SQL behaviour is proven by
// scripts/worker/report-writer-fence-selftest.mjs (PGlite). 7-bit ASCII, LF.
//
// PER-KEY READINESS GATE (cutover step 2, before flipping a key):
//   REPORT_WRITER_FENCE_READY_KEY=<key>[,<key>...] node scripts/report-writer-fence.test.js
// runs the whole suite and then FAILS unless NO inventory entry other than a fenced-publisher-path lists that key (a
// blocked-by-fence writer, or any non-fenced writer, still able to write it unfenced).
//
// Bootstrapping aids: REPORT_WRITER_FENCE_DUMP=1 prints the computed writer map (+ REPORT_WRITER_FENCE_DUMP_WHY=1 the
// proofs); REPORT_WRITER_FENCE_DUMP=trip prints the tripwire signatures; REPORT_WRITER_FENCE_DUMP=readiness prints the
// per-key readiness of every seeded key.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync, statSync, writeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import * as W from "../lib/server/sync/report-writer-fence.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rel = (f) => path.relative(ROOT, f).split(path.sep).join("/");
const abs = (p) => path.join(ROOT, ...p.split("/"));
const src = (p) => readFileSync(abs(p), "utf8").replace(/\r\n/g, "\n");
let passed = 0;
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };
const ok = (name, cond) => { assert.ok(cond, name); passed += 1; out("  ok  " + name); };
out("report-writer-fence");

const MIG_FILE = "20260935_report_publication_writer_fence.sql";
const MIG = src("supabase/migrations/" + MIG_FILE);
const ROLLBACK = src("deploy/publication-recovery/ROLLBACK_20260935.sql");
const sqlCode = (sql) => sql.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
const MIG_CODE = sqlCode(MIG);
const ADDED_LINE = "  perform set_config('app.report_publication_fenced', 'on', true);";
const SEEDED = ["brand-sales", "daily-reporting", "brand-inventory", "listing-health-v3", "fba-plan", "sku-movement", "returns-leakage", "brand-view", "brand-view-portfolio", "brand-view-brands"];

// =====================================================================================================================
// A. the 20260935 migration contract
// =====================================================================================================================
{
  ok("A1 header: PREPARED, NOT APPLIED, expand-only + idempotent, apply via MIGRATE_ONLY exactly this file, rollback outside the ledger",
    /PREPARED, NOT APPLIED\. EXPAND-ONLY \+ IDEMPOTENT/.test(MIG) && MIG.includes("MIGRATE_ONLY=" + MIG_FILE) && MIG.includes("deploy/publication-recovery/ROLLBACK_20260935.sql")
    && /APPLYING IT ENABLES NOTHING/.test(MIG) && /SEPARATE sign-off from 20260934/.test(MIG));
  ok("A2 no transaction control (the ledger runner wraps it) and no destructive DDL/DML on any existing object",
    !/^\s*(begin|commit|rollback)\s*;/im.test(MIG_CODE) && !/\bdrop\s+(table|function|column|policy|index|view|schema|type)\b/i.test(MIG_CODE)
    && !/\balter\s+table\s+public\.(?!report_publication_writer_fence\b)/i.test(MIG_CODE) && !/\b(delete\s+from|truncate|update)\s+public\.report_snapshots\b/i.test(MIG_CODE)
    && (MIG_CODE.match(/\bdrop\s+trigger\s+if\s+exists\s+(\w+)/gi) || []).every((d) => /report_snapshots_zz_writer_fence|report_publication_writer_fence_touch/.test(d)));
  const table = (MIG_CODE.match(/create table if not exists public\.report_publication_writer_fence \(([\s\S]*?)\n\);/) || [])[1] || "";
  ok("A3 the fence table: report_key PK (canonical, <=200, NOT a scheduler-v2/* shadow key), fenced_only boolean NOT NULL default false, updated_at, updated_by",
    /report_key text primary key/.test(table) && /rpwf_key_not_shadow check \(report_key not like 'scheduler-v2\/%'\)/.test(table) && /char_length\(report_key\) <= 200/.test(table)
    && /fenced_only boolean not null default false/.test(table) && /updated_at timestamptz not null default now\(\)/.test(table) && /updated_by text/.test(table));
  const seedBlock = (MIG_CODE.match(/insert into public\.report_publication_writer_fence \(report_key, fenced_only, updated_by\) values([\s\S]*?)on conflict \(report_key\) do nothing;/) || [])[1] || "";
  const seeded = [...seedBlock.matchAll(/\('([^']+)', (true|false), 'migration:20260935'\)/g)];
  ok("A4 the seed is EXACTLY the 10 route-owned live keys, every one fenced_only=false, ON CONFLICT DO NOTHING (a re-apply never resets a flip)",
    seeded.length === 10 && seeded.every((m) => m[2] === "false") && JSON.stringify(seeded.map((m) => m[1]).sort()) === JSON.stringify([...SEEDED].sort()));
  ok("A5 the seed equals report-writer-fence.js FENCED_WRITER_REPORT_KEYS (single contract)", JSON.stringify([...W.FENCED_WRITER_REPORT_KEYS].sort()) === JSON.stringify(seeded.map((m) => m[1]).sort()));
  ok("A6 RLS on + revoke all from public/anon/authenticated/service_role + grant ONLY select to service_role",
    /alter table public\.report_publication_writer_fence enable row level security;/.test(MIG_CODE)
    && /revoke all on table public\.report_publication_writer_fence from public, anon, authenticated, service_role;/.test(MIG_CODE)
    && (MIG_CODE.match(/grant [^;]* on table public\.report_publication_writer_fence to [^;]*;/g) || []).join() === "grant select on table public.report_publication_writer_fence to service_role;"
    && !/create policy/i.test(MIG_CODE));
  const fn = (MIG_CODE.match(/create or replace function public\.enforce_report_publication_writer_fence\(\)([\s\S]*?)\n\$\$;/) || [])[1] || "";
  ok("A7 the trigger function: plpgsql, SECURITY DEFINER, search_path pinned (public, pg_temp), every relation schema-qualified, EXECUTE revoked",
    /returns trigger\s+language plpgsql\s+security definer\s+set search_path = public, pg_temp\s+as \$\$/.test(fn)
    && (fn.match(/\bfrom public\.report_publication_writer_fence f\b/g) || []).length === 2 && !/\b(from|join|update|into)\s+(report_publication_writer_fence|report_snapshots|control_plane_lease)\b/i.test(fn)
    && /revoke all on function public\.enforce_report_publication_writer_fence\(\) from public, anon, authenticated, service_role;/.test(MIG_CODE));
  ok("A8 the mark check is current_setting('app.report_publication_fenced', true) IS NOT DISTINCT FROM 'on' (missing_ok: never an error), checked FIRST",
    /if current_setting\('app\.report_publication_fenced', true\) is not distinct from 'on' then/.test(fn) && fn.indexOf("current_setting(") < fn.indexOf("select f.report_key into v_key"));
  ok("A9 the rejection: dedicated SQLSTATE RWF01 + message 'REPORT_WRITER_FENCED:' || key (and '*' for TRUNCATE), matching the JS contract",
    /errcode = 'RWF01',\s+message = 'REPORT_WRITER_FENCED:' \|\| v_key,/.test(fn) && /errcode = 'RWF01',\s+message = 'REPORT_WRITER_FENCED:\*',/.test(fn)
    && W.REPORT_WRITER_FENCED_SQLSTATE === "RWF01" && W.REPORT_WRITER_FENCED_PREFIX === "REPORT_WRITER_FENCED:" && W.REPORT_WRITER_FENCE_SETTING === "app.report_publication_fenced");
  ok("A10 ONE primary-key lookup of BOTH the NEW and the OLD key (an UPDATE moving a row into or out of a fenced key is refused), DELETE returns OLD",
    /if tg_op = 'INSERT' then\s+v_new := new\.report_key;\s+elsif tg_op = 'UPDATE' then\s+v_new := new\.report_key;\s+v_old := old\.report_key;\s+else\s+v_old := old\.report_key;/.test(fn)
    && (fn.match(/from public\.report_publication_writer_fence f/g) || []).length === 2 && /and f\.report_key in \(v_new, v_old\)/.test(fn) && /limit 1;/.test(fn)
    && /if tg_op = 'DELETE' then\s+return old;\s+end if;\s+return new;\s+end;$/.test(fn.trim()));
  const trg = [...MIG_CODE.matchAll(/create trigger (\w+)\s+before ([a-z ]+?) on public\.report_snapshots\s+for each (row|statement) execute function public\.enforce_report_publication_writer_fence\(\);/g)];
  ok("A11 two triggers: BEFORE INSERT OR UPDATE OR DELETE (row) + BEFORE TRUNCATE (statement), each dropped-if-exists first (idempotent)",
    trg.length === 2 && trg.some((m) => m[1] === "report_snapshots_zz_writer_fence" && m[2] === "insert or update or delete" && m[3] === "row")
    && trg.some((m) => m[1] === "report_snapshots_zz_writer_fence_truncate" && m[2] === "truncate" && m[3] === "statement")
    && /drop trigger if exists report_snapshots_zz_writer_fence on public\.report_snapshots;/.test(MIG_CODE) && /drop trigger if exists report_snapshots_zz_writer_fence_truncate on public\.report_snapshots;/.test(MIG_CODE));
  // PostgreSQL fires same-event triggers in NAME order: the fence must see the FINAL NEW.report_key.
  const allSnapTriggers = readdirSync(abs("supabase/migrations")).filter((f) => f.endsWith(".sql")).flatMap((f) =>
    [...sqlCode(src("supabase/migrations/" + f)).matchAll(/create (?:or replace )?trigger (\w+)\s+before [^;]*? on public\.report_snapshots\s+for each row/g)].map((m) => m[1]));
  ok("A12 the fence row trigger sorts LAST among EVERY BEFORE row trigger any migration defines on report_snapshots (" + allSnapTriggers.length + ")",
    allSnapTriggers.includes("report_snapshots_zz_writer_fence") && [...allSnapTriggers].sort().pop() === "report_snapshots_zz_writer_fence" && allSnapTriggers.includes("report_snapshots_touch_updated_at"));
  ok("A13 a lock_timeout guards the DDL (a long report_snapshots transaction can never queue every writer behind it)", /^set local lock_timeout = '10s';$/m.test(MIG_CODE));
  ok("A14 the ONE exemption (deleting a dashboard user: the ON DELETE SET NULL of created_by) is exact -- only an UPDATE of a fenced row, created_by non-NULL -> NULL, a WHOLE-ROW comparison of every other column except updated_at, updated_at RESTORED -- and sits before the refusal",
    /if v_key is not null and tg_op = 'UPDATE' then\s+if old\.created_by is not null and new\.created_by is null\s+and \(to_jsonb\(new\) - 'created_by' - 'updated_at'\) = \(to_jsonb\(old\) - 'created_by' - 'updated_at'\) then\s+new\.updated_at := old\.updated_at;\s+return new;\s+end if;\s+end if;\s+if v_key is not null then\s+raise exception using/.test(fn)
    && (fn.match(/to_jsonb/g) || []).length === 2 && (fn.match(/return new;/g) || []).length === 3 && (fn.match(/created_by/g) || []).length === 4
    && /created_by uuid references auth\.users \(id\) on delete set null,/.test(src("supabase/migrations/20260728_shared_dashboard.sql")));
}

// =====================================================================================================================
// B. fenced CAS byte identity + rollback identity
// =====================================================================================================================
const FENCED_START = "create or replace function public.cas_report_snapshot_if_newer_fenced(";
const extractFenced = (sql) => { const a = sql.indexOf(FENCED_START); if (a < 0) return null; const b = sql.indexOf("\n$$;", a); return b < 0 ? null : sql.slice(a, b + 4); };
{
  const migFiles = readdirSync(abs("supabase/migrations")).filter((f) => f.endsWith(".sql")).sort();
  const defining = migFiles.filter((f) => src("supabase/migrations/" + f).includes(FENCED_START));
  const prior = defining.filter((f) => f < MIG_FILE);
  const latestPrior = prior[prior.length - 1];
  const PRIOR = extractFenced(src("supabase/migrations/" + latestPrior));
  const NEW = extractFenced(MIG);
  ok("B1 the latest PRIOR definition of cas_report_snapshot_if_newer_fenced is " + latestPrior + " and 20260935 is the only later one", latestPrior === "20260919_account_onboarding.sql" && JSON.stringify(defining.filter((f) => f >= MIG_FILE)) === JSON.stringify([MIG_FILE]) && !!PRIOR && !!NEW);
  const nl = NEW.split("\n"); const pl = PRIOR.split("\n");
  const added = nl.map((l, i) => [l, i]).filter(([l]) => l === ADDED_LINE);
  const idx = added.length === 1 ? added[0][1] : -1;
  ok("B2 BYTE-IDENTICAL modulo exactly ONE added line: removing the set_config line from the 20260935 statement yields the 20260919 statement byte-for-byte",
    added.length === 1 && nl.length === pl.length + 1 && [...nl.slice(0, idx), ...nl.slice(idx + 1)].join("\n") === PRIOR);
  ok("B3 the added statement is TRANSACTION-LOCAL (is_local=true) and runs only AFTER every lease check (token, generation, unexpired) passed, immediately before the delegation",
    /set_config\('app\.report_publication_fenced', 'on', true\)/.test(ADDED_LINE) && nl[idx + 1] === "  return public.cas_report_snapshot_if_newer("
    && ["'no-fence'", "'invalid-generation'", "'no-lease'", "'owner-changed'", "'generation-superseded'", "'expired'"].every((r) => nl.slice(0, idx).join("\n").includes(r))
    && !nl.slice(idx + 1).some((l) => /lease-lost/.test(l)));
  ok("B4 the fenced CAS keeps its grants (service_role only) in 20260935", MIG.includes("revoke all on function public.cas_report_snapshot_if_newer_fenced(text, text, text, jsonb, jsonb, text, bigint, timestamptz, text, bigint) from public, anon, authenticated;")
    && MIG.includes("grant execute on function public.cas_report_snapshot_if_newer_fenced(text, text, text, jsonb, jsonb, text, bigint, timestamptz, text, bigint) to service_role;"));
  const RB = sqlCode(ROLLBACK);
  ok("B5 ROLLBACK_20260935 restores the 20260919 fenced CAS statement BYTE-IDENTICAL (no set_config)", extractFenced(ROLLBACK) === PRIOR && !RB.includes("set_config"));
  ok("B6 ... then drops ONLY the fence objects (both triggers, the trigger function, the table) and the ledger row, inside one transaction",
    /^begin;$/m.test(RB) && /^commit;$/m.test(RB) && RB.indexOf(FENCED_START) < RB.indexOf("drop trigger")
    && /drop trigger if exists report_snapshots_zz_writer_fence_truncate on public\.report_snapshots;/.test(RB) && /drop trigger if exists report_snapshots_zz_writer_fence on public\.report_snapshots;/.test(RB)
    && /drop function if exists public\.enforce_report_publication_writer_fence\(\);/.test(RB) && /drop table if exists public\.report_publication_writer_fence;/.test(RB)
    && /delete from public\.app_schema_migrations where filename = '20260935_report_publication_writer_fence\.sql';/.test(RB)
    && (RB.match(/\bdrop\s+\w+/g) || []).length === 4 && !/\b(update|delete\s+from|truncate(\s+table)?|insert\s+into)\s+(public\.)?report_snapshots\b/i.test(RB));
  ok("B7 the rollback header says it RE-ENABLES UNFENCED WRITERS and is never part of a code rollback", /THIS RE-ENABLES UNFENCED WRITERS/.test(ROLLBACK) && /NEVER part of a code rollback/.test(ROLLBACK));
  ok("B8 no rollback file lives in supabase/migrations (the ledger runner can never apply it)", !readdirSync(abs("supabase/migrations")).some((f) => /rollback/i.test(f)) && existsSync(abs("deploy/publication-recovery/ROLLBACK_20260935.sql")));
  ok("B9 the rollback sets lock_timeout = '10s' right after BEGIN (fails fast behind a long transaction) and documents that the migration STAYS in supabase/migrations, so a later full db:migrate re-applies it with every key false (behaviour-neutral)",
    /^begin;\nset local lock_timeout = '10s';\ncreate or replace function public\.cas_report_snapshot_if_newer_fenced\(/m.test(ROLLBACK) && (RB.match(/lock_timeout/g) || []).length === 1
    && /RE-APPLY AFTER A ROLLBACK/.test(ROLLBACK) && /full `npm run db:migrate`/i.test(ROLLBACK) && /behaviour-neutral/.test(ROLLBACK) && existsSync(abs("supabase/migrations/" + MIG_FILE)));
}

// =====================================================================================================================
// C. SQL functions that write report_snapshots: enumerated + classified; only the fenced CAS sets the mark
// =====================================================================================================================
const SQL_WRITER_CLASSES = Object.freeze({
  cas_report_snapshot_if_newer_fenced: "fenced-publisher-path (sets the transaction-local mark after its lease/generation fence; the ONLY SQL writer allowed on a fenced key)",
  cas_report_snapshot_if_newer: "blocked-by-fence on fenced keys (the unfenced CAS: saveShadowSnapshotIfNewer's scheduler-v2/* shadow CAS keeps working; on a fenced live key it is refused unless called inside the fenced CAS's transaction)",
  prune_scheduled_report_snapshots: "blocked-by-fence (scheduler-v1 DELETE of syncManaged rows; refused on a fenced key -- the fenced publisher never deletes live rows)",
});
{
  const defs = [];
  for (const f of readdirSync(abs("supabase/migrations")).filter((x) => x.endsWith(".sql")).sort()) {
    for (const m of src("supabase/migrations/" + f).matchAll(/create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?([a-z_0-9]+)\s*\(([\s\S]*?)\n\$\$;/gi)) defs.push({ f, name: m[1], body: sqlCode(m[2]) });
  }
  const DML = /\b(insert\s+into|update|delete\s+from|merge\s+into|truncate(\s+table)?|copy)\s+(only\s+)?(public\.)?"?report_snapshots"?\b/i;
  const writers = new Set();
  for (let changed = true; changed;) {
    changed = false;
    for (const d of defs) {
      if (writers.has(d.name)) continue;
      const noStr = d.body.replace(/'(?:[^']|'')*'/g, "''");
      if (DML.test(d.body) || [...writers].some((w) => new RegExp("\\b" + w + "\\s*\\(").test(noStr))) { writers.add(d.name); changed = true; }
    }
  }
  ok("C1 EVERY SQL function any migration defines that writes report_snapshots (directly or by delegation) is classified: " + [...writers].sort().join(", "),
    JSON.stringify([...writers].sort()) === JSON.stringify(Object.keys(SQL_WRITER_CLASSES).sort()));
  const topLevelDml = readdirSync(abs("supabase/migrations")).filter((f) => f.endsWith(".sql")).filter((f) => {
    const noFns = sqlCode(src("supabase/migrations/" + f)).replace(/create\s+(?:or\s+replace\s+)?function[\s\S]*?\n\$\$;/gi, "");
    return /\b(insert\s+into|update|delete\s+from|merge\s+into|truncate)\s+(public\.)?report_snapshots\b/i.test(noFns);
  });
  ok("C2 no migration runs top-level DML on report_snapshots (only the functions above write it)", topLevelDml.length === 0);
  const setters = readdirSync(abs("supabase/migrations")).filter((f) => f.endsWith(".sql") && /app\.report_publication_fenced/.test(sqlCode(src("supabase/migrations/" + f))));
  ok("C3 ONLY 20260935 names the mark in SQL code (no other function or migration can set it)", JSON.stringify(setters) === JSON.stringify([MIG_FILE])
    && (MIG_CODE.match(/set_config\('app\.report_publication_fenced'/g) || []).length === 1 && !/\bset\s+(local\s+)?app\.report_publication_fenced\b/i.test(MIG_CODE));
}

// =====================================================================================================================
// D. report-writer-fence.js: classifier, reader, summaries
// =====================================================================================================================
{
  const restErr = Object.assign(new Error("Supabase request failed (400): REPORT_WRITER_FENCED:brand-sales"), { status: 400, code: "RWF01" });
  const pgErr = Object.assign(new Error("REPORT_WRITER_FENCED:daily-reporting"), { code: "RWF01", severity: "ERROR" });
  const wrapped = new Error("materialize failed", { cause: new Error("save failed", { cause: pgErr }) });
  const c1 = W.classifyReportWriterError(restErr); const c2 = W.classifyReportWriterError(pgErr); const c3 = W.classifyReportWriterError(wrapped);
  ok("D1 classifier: the REST (supabase.js request) and node-postgres shapes and a cause chain all classify as a typed 'writer-fenced' with the key, LKG preserved, never retryable",
    c1.fenced && c1.event === "writer-fenced" && c1.reportKey === "brand-sales" && c1.sqlstate === "RWF01" && c1.lkgPreserved === true && c1.retryable === false && c1.reason === "writer-fenced:brand-sales"
    && c2.fenced && c2.reportKey === "daily-reporting" && c3.fenced && c3.reportKey === "daily-reporting");
  const onlyCode = W.classifyReportWriterError(Object.assign(new Error("boom"), { code: "RWF01" }));
  const onlyMsg = W.classifyReportWriterError("REPORT_WRITER_FENCED:*");
  const weird = W.classifyReportWriterError(new Error("REPORT_WRITER_FENCED:scheduler-v2/x"));
  ok("D2 classifier: code-only -> fenced with reportKey null; message-only (incl. the TRUNCATE '*') -> fenced; a non-fenceable key text is never echoed as a key",
    onlyCode.fenced && onlyCode.reportKey === null && onlyCode.reason === "writer-fenced:unknown" && onlyMsg.fenced && onlyMsg.reportKey === "*" && onlyMsg.sqlstate === null
    && weird.fenced && weird.reportKey === null);
  const cyc = new Error("x"); cyc.cause = cyc;
  ok("D3 classifier: ordinary failures (23505, 42P01, a timeout, null/undefined, a cyclic cause) are NOT fenced; never throws",
    [Object.assign(new Error("dup"), { code: "23505" }), Object.assign(new Error("missing"), { code: "42P01" }), new Error("timeout"), null, undefined, 42, {}, cyc].every((e) => W.classifyReportWriterError(e).fenced === false)
    && W.isReportWriterFencedError(restErr) && !W.isReportWriterFencedError(new Error("x")));
  const ev = W.writerFencedEvent({ error: restErr, writer: "report-materialization/materializeOne", accountId: "A1" });
  ok("D4 writerFencedEvent: redacted typed event (event, key, writer label, account, sqlstate, lkgPreserved) -- no message body; null for other errors; bad labels dropped",
    ev && ev.event === "writer-fenced" && ev.reportKey === "brand-sales" && ev.writer === "report-materialization/materializeOne" && ev.accountId === "A1" && ev.sqlstate === "RWF01" && ev.lkgPreserved === true
    && !JSON.stringify(ev).includes("Supabase request failed") && W.writerFencedEvent({ error: new Error("x") }) === null
    && W.writerFencedEvent({ error: pgErr, writer: "bad label with spaces" }).writer === null);
  ok("D5 key predicates: shadow keys are never fenceable; canonical keys are", W.isShadowReportKey("scheduler-v2/brand-sales") && !W.isFenceableReportKey("scheduler-v2/brand-sales")
    && W.isFenceableReportKey("brand-sales") && !W.isFenceableReportKey(" brand-sales") && !W.isFenceableReportKey("") && !W.isFenceableReportKey(null) && W.isSeededFenceKey("sku-movement") && !W.isSeededFenceKey("sales-movers"));
}
await (async () => {
  const calls = [];
  const rows = SEEDED.map((k) => ({ report_key: k, fenced_only: k === "brand-sales" || k === "fba-plan", updated_at: "2026-09-26 00:00:00+00", updated_by: "approver" }));
  const r1 = await W.readReportWriterFence(async (sql) => { calls.push(sql); return { rows: [...rows, { report_key: "sales-movers", fenced_only: false, updated_at: null, updated_by: null }] }; });
  ok("D6 reader: exactly ONE read-only statement (dates as text), ok -> fenced/open/missing/extra lists",
    calls.length === 1 && calls[0] === W.REPORT_WRITER_FENCE_READ_SQL && /^select report_key, fenced_only, updated_at::text as updated_at, updated_by from public\.report_publication_writer_fence order by report_key$/.test(calls[0])
    && r1.state === "ok" && JSON.stringify(r1.fencedKeys) === JSON.stringify(["brand-sales", "fba-plan"]) && r1.openKeys.length === 9 && r1.missingKeys.length === 0 && JSON.stringify(r1.extraKeys) === JSON.stringify(["sales-movers"]));
  const r2 = await W.readReportWriterFence(async () => { throw Object.assign(new Error('relation "public.report_publication_writer_fence" does not exist'), { code: "42P01" }); });
  const r3 = await W.readReportWriterFence(async () => { throw Object.assign(new Error("connection reset secret=abc"), { code: "ECONNRESET" }); });
  const r4 = await W.readReportWriterFence(async () => [{ report_key: "brand-sales", fenced_only: "true" }, { report_key: "brand-sales", fenced_only: true }, { report_key: "scheduler-v2/x", fenced_only: true }]);
  const r5 = await W.readReportWriterFence(null);
  ok("D7 reader: missing relation -> 'absent'; transport error -> 'unreadable' with the CODE only (no message); malformed rows -> 'invalid' (fail closed); no query -> unreadable",
    r2.state === "absent" && r3.state === "unreadable" && r3.code === "ECONNRESET" && !JSON.stringify(r3).includes("secret") && r4.state === "invalid" && r4.problems.length === 3 && r4.rows.length === 0 && r5.state === "unreadable");
  const s1 = W.fenceStatusSummary(r1); const s2 = W.fenceStatusSummary(r2); const s4 = W.fenceStatusSummary(r4);
  ok("D8 status summary: per-key fenced/open, allSeededFenced only when every seeded key is proven fenced; absent/invalid -> every key 'unknown' (never claimed open or fenced)",
    s1.perKey["brand-sales"] === "fenced" && s1.perKey["daily-reporting"] === "open" && s1.allSeededFenced === false && s2.state === "absent" && Object.values(s2.perKey).every((v) => v === "unknown") && s2.missingKeys.length === 10
    && s4.state === "invalid" && Object.values(s4.perKey).every((v) => v === "unknown")
    && W.fenceStatusSummary(await W.readReportWriterFence(async () => SEEDED.map((k) => ({ report_key: k, fenced_only: true })))).allSeededFenced === true);
  ok("D9 fenceStateForKey: 'unknown' for a key with no row or a non-ok read", W.fenceStateForKey(r1, "reconciliation") === "unknown" && W.fenceStateForKey(r3, "brand-sales") === "unknown" && W.fenceStateForKey(r1, "fba-plan") === "fenced");
  const r6 = await W.readReportWriterFence(async () => ({ rows: [] }));
  const r7 = await W.readReportWriterFence(async () => []);
  const s6 = W.fenceStatusSummary(r6);
  ok("D10 reader: ZERO visible rows (the seed guarantees 10; e.g. a role without BYPASSRLS under RLS-with-no-policy sees none) is 'invalid' with problem 'no-rows-visible' -- never 'ok' / open; every key 'unknown'",
    W.NO_ROWS_VISIBLE === "no-rows-visible" && r6.state === "invalid" && JSON.stringify(r6.problems) === JSON.stringify(["no-rows-visible"]) && r6.missingKeys.length === 10 && r6.fencedKeys.length === 0
    && r7.state === "invalid" && JSON.stringify(r7.problems) === JSON.stringify(["no-rows-visible"]) && s6.state === "invalid" && Object.values(s6.perKey).every((v) => v === "unknown") && s6.allSeededFenced === false
    && W.fenceStateForKey(r6, "brand-sales") === "unknown");
})();

// =====================================================================================================================
// E. the WRITER INVENTORY -- static taint analysis (fail-closed)
// =====================================================================================================================
const KW = new Set(["return", "typeof", "case", "do", "else", "in", "of", "new", "delete", "void", "throw", "yield", "await", "instanceof"]);
// LENGTH-PRESERVING lexer: comments blanked; with blankStrings, string / template-text / regex CONTENTS blanked too
// (template ${} code kept) -- so offsets + lines align across the raw, comment-free and code-only views.
function lex(text, { blankStrings }) {
  const a = text.split(""); const n = a.length; let i = 0; let lastSig = ""; let lastWord = "";
  const regexOk = () => lastSig === "" || "(,=:[!&|?{};+-*%<>~^".includes(lastSig) || KW.has(lastWord);
  const bl = (k) => { if (k < n && a[k] !== "\n") a[k] = " "; };
  function code(stopAtBrace) {
    let depth = 0;
    while (i < n) {
      const c = a[i]; const d = a[i + 1];
      if (c === "/" && d === "/") { while (i < n && a[i] !== "\n") { bl(i); i++; } continue; }
      if (c === "/" && d === "*") { bl(i); bl(i + 1); i += 2; while (i < n && !(a[i] === "*" && a[i + 1] === "/")) { bl(i); i++; } bl(i); bl(i + 1); i += 2; continue; }
      if (c === "'" || c === '"') { const q = c; i++; while (i < n && a[i] !== q) { if (a[i] === "\\") { if (blankStrings) { bl(i); bl(i + 1); } i += 2; continue; } if (a[i] === "\n") break; if (blankStrings) bl(i); i++; } i++; lastSig = q; lastWord = ""; continue; }
      if (c === "`") { i++; while (i < n && a[i] !== "`") { if (a[i] === "\\") { if (blankStrings) { bl(i); bl(i + 1); } i += 2; continue; } if (a[i] === "$" && a[i + 1] === "{") { i += 2; code(true); continue; } if (blankStrings) bl(i); i++; } i++; lastSig = "`"; lastWord = ""; continue; }
      if (c === "/" && regexOk()) { i++; let cls = false; while (i < n) { const ch = a[i]; if (ch === "\\") { if (blankStrings) { bl(i); bl(i + 1); } i += 2; continue; } if (ch === "[") cls = true; else if (ch === "]") cls = false; else if (ch === "/" && !cls) break; else if (ch === "\n") break; if (blankStrings) bl(i); i++; } i++; while (i < n && /[a-z]/.test(a[i])) i++; lastSig = "/"; lastWord = ""; continue; }
      if (stopAtBrace) { if (c === "{") depth++; else if (c === "}") { if (depth === 0) { i++; return; } depth--; } }
      if (/[A-Za-z0-9_$]/.test(c)) { let w = ""; while (i < n && /[A-Za-z0-9_$]/.test(a[i])) { w += a[i]; i++; } lastWord = w; lastSig = "a"; continue; }
      if (!/\s/.test(c)) { lastSig = c; lastWord = ""; }
      i++;
    }
  }
  code(false);
  return a.join("");
}
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ---- NORMALIZED VIEWS: literal-fragment joining + string-const folding. They only ever ADD detections: every DIRECT test
// runs on the raw comment-free view AND on the normalized one. ------------------------------------------------------------
// joinLiterals: `"a" + "b"` -> `"ab"` for any quote kinds, `${"lit"}` -> `lit` inside a template; to a fixpoint.
function joinLiterals(t) {
  let s = t; let prev;
  do { prev = s; s = s.replace(/(["'`])\s*\+\s*(["'`])/g, "").replace(/\$\{\s*(["'])([^"'`\\\n]*)\1\s*\}/g, "$2"); } while (s !== prev);
  return s;
}
// ASCII escapes decoded (\xHH, \uHHHH, \u{H..}, %HH URL-encoding, SQL U&"\HHHH"), then backslashes dropped: so
// "report\x5fsnapshots", "report%5Fsnapshots" and U&"report\005fsnapshots" all read report_snapshots.
const decodeEscapes = (t) => t.replace(/\\u\{([0-9a-f]{1,6})\}|\\u([0-9a-f]{4})|\\x([0-9a-f]{2})|%([0-9a-f]{2})|\\([0-9a-f]{4})/gi, (m, a, b, c, d, e) => {
  const cp = parseInt(a || b || c || d || e, 16); return cp > 0 && cp < 128 ? String.fromCharCode(cp) : m;
}).replace(/\\/g, "");
// The literal value (after joining) of a const initializer, or null.
function literalOf(v) {
  const j = joinLiterals(String(v).trim()).replace(/;\s*$/, "").trim();
  const m = j.match(/^(["'`])([^"'`\\]*)\1$/);
  return m && !(m[1] === "`" && m[2].includes("${")) ? m[2] : null;
}
// Only consts whose value could name the table, a REST path, a writer RPC or the schema are folded (folding is additive,
// so a narrower set costs precision, never soundness -- the tripwire still sees the literal in the const itself).
const INTERESTING_LITERAL = /report_snapshot|rest\/v1|public|prune_scheduled|cas_report/i;
// NON-GET evidence anywhere in a file: a method key / assignment / shorthand whose value is not the literal GET, a quoted or
// computed "method" key, or a fetch(...) whose options argument is not an object literal (options built elsewhere).
const nonGetEvidence = (t) => /(?<![\w$])method\s*:\s*(?!["'`]GET["'`](?![\w$]))\S/i.test(t)
  || /["'`]method["'`]\s*[:\]]/.test(t) || /\.method\s*=(?![=>])/.test(t) || /[{,]\s*method\s*[,}]/.test(t)
  || /(?<![\w$.])fetch\s*\((?:[^(),]|\([^()]*\))*,\s*(?![\s{])/.test(t);

function makeWriterAnalyzer({ fencedKeys, overrides = new Map(), clears = [] }) {
  const FENCED = new Set(fencedKeys);
  const SUPA = abs("lib/server/supabase.js");
  const DERIV = abs("lib/server/sync/report-derivation.js");
  const SHADOW_PREFIX = "scheduler-v2/";
  function walk(dir) {
    const res = [];
    if (!existsSync(dir)) return res;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules") continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) res.push(...walk(p));
      else if (/\.(m?js|cjs)$/.test(e.name) && !/\.test\.m?js$/.test(e.name)) res.push(p);
    }
    return res;
  }
  const files = [...new Set([...["lib", "api", "scripts"].flatMap((d) => walk(abs(d))), ...overrides.keys()])];
  const readSrc = (f) => (overrides.has(f) ? overrides.get(f) : readFileSync(f, "utf8")).replace(/\r\n/g, "\n");
  const resolveSpec = (fromFile, spec) => {
    if (!spec.startsWith(".")) return null;
    const p = path.resolve(path.dirname(fromFile), spec);
    if (overrides.has(p)) return p;
    if (existsSync(p) && statSync(p).isFile()) return p;
    if (existsSync(p + ".js")) return p + ".js";
    return null;
  };
  // ---- module model: top-level chunks, imports (static / namespace / dynamic), exports, module-level consts ----------
  function parse(file) {
    const raw = readSrc(file);
    const b = lex(raw, { blankStrings: false }); const m = lex(raw, { blankStrings: true });
    const mL = m.split("\n"); const bL = b.split("\n");
    const spans = []; let depth = 0; let cur = null;
    for (let li = 0; li < mL.length; li++) {
      const line = mL[li];
      if (depth === 0 && /^[^\s})\].?:&|+\-*,]/.test(line)) { cur = { start: li, end: li }; spans.push(cur); } else if (cur) cur.end = li;
      for (const ch of line) { if ("{([".includes(ch)) depth++; else if ("})]".includes(ch)) depth--; }
    }
    const mod = { file, m, b, chunks: [], imports: new Map(), ns: new Map(), exportsLocal: new Map(), reexports: new Map(), star: [], depth, consts: new Map() };
    for (const sp of spans) {
      const cm = mL.slice(sp.start, sp.end + 1).join("\n"); const cb = bL.slice(sp.start, sp.end + 1).join("\n");
      const ch = { m: cm, b: cb, line: sp.start + 1, names: [], kind: "stmt", dyn: [], dynNamed: [], dynAlias: new Map(), fnInit: false };
      mod.chunks.push(ch);
      let x;
      if (/^import\b/.test(cm) && !/^import\s*\(/.test(cm)) {
        ch.kind = "import";
        const spec = (cb.match(/from\s*["']([^"']+)["']/) || [])[1] || null; const t = spec ? resolveSpec(file, spec) : null;
        const clause = (cb.match(/^import\s+([\s\S]*?)\s+from\s/) || [])[1] || "";
        const nsM = clause.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/); if (nsM && t) mod.ns.set(nsM[1], t);
        const defM = clause.match(/^([A-Za-z_$][\w$]*)\s*(,|$)/); if (defM && t) mod.imports.set(defM[1], { t, name: "default" });
        const namedM = clause.match(/\{([\s\S]*)\}/);
        if (namedM && t) for (const part of namedM[1].split(",").map((y) => y.trim()).filter(Boolean)) { const [a, bb] = part.split(/\s+as\s+/); mod.imports.set((bb || a).trim(), { t, name: a.trim() }); }
        continue;
      }
      if (/^export\s*\*/.test(cm)) { ch.kind = "reexport"; const spec = (cb.match(/from\s*["']([^"']+)["']/) || [])[1]; const t = spec && resolveSpec(file, spec); const asM = cb.match(/^export\s*\*\s*as\s+([A-Za-z_$][\w$]*)/); if (t) { if (asM) mod.reexports.set(asM[1], { t, name: "*" }); else mod.star.push(t); } continue; }
      if ((x = cm.match(/^export\s*\{([\s\S]*?)\}\s*(from)?/))) {
        ch.kind = "reexport";
        const spec = x[2] ? (cb.match(/from\s*["']([^"']+)["']/) || [])[1] : null; const t = spec && resolveSpec(file, spec);
        for (const part of x[1].split(",").map((y) => y.trim()).filter(Boolean)) { const [a, bb] = part.split(/\s+as\s+/); const e = (bb || a).trim(); if (t) mod.reexports.set(e, { t, name: a.trim() }); else mod.exportsLocal.set(e, a.trim()); }
        continue;
      }
      const exported = /^export\s/.test(cm);
      const body = cm.replace(/^export\s+/, ""); const bodyB = cb.replace(/^export\s+/, "");
      if (/^default\b/.test(body)) { ch.kind = "default"; ch.names = ["default"]; mod.exportsLocal.set("default", "default"); }
      else if ((x = body.match(/^(async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/))) { ch.kind = "function"; ch.names = [x[2]]; }
      else if ((x = body.match(/^class\s+([A-Za-z_$][\w$]*)/))) { ch.kind = "class"; ch.names = [x[1]]; }
      else if ((x = body.match(/^(const|let|var)\s+([\s\S]*?)=/))) {
        ch.kind = "var";
        const pat = x[2].trim();
        ch.names = /^[A-Za-z_$][\w$]*$/.test(pat) ? [pat] : [...pat.matchAll(/([A-Za-z_$][\w$]*)\s*(:)?/g)].filter((y) => !y[2]).map((y) => y[1]);
        const init = body.slice(x[0].length).trim().replace(/\s+/g, " ");
        ch.fnInit = /^(async )?function\b/.test(init) || /^(async )?[A-Za-z_$][\w$]* ?=>/.test(init) || /^(async ?)?\([^()]*(\([^()]*\)[^()]*)*\) ?=>/.test(init.slice(0, 600)) || /^(Object\.freeze\()?\{/.test(init);
        const cv = bodyB.match(/^const\s+([A-Za-z_$][\w$]*)\s*=\s*([\s\S]*?);?\s*$/);
        if (cv && ch.names.length === 1) mod.consts.set(cv[1], cv[2].trim());
        const di = bodyB.match(/^(?:const|let|var)\s+([\s\S]*?)=\s*await\s+import\(\s*["']([^"']+)["']\s*\)\s*;?\s*$/);
        if (di) {
          const t = resolveSpec(file, di[2]); const pat2 = lex(di[1], { blankStrings: true }).trim();
          if (t) {
            if (/^[A-Za-z_$][\w$]*$/.test(pat2)) mod.ns.set(pat2, t);
            else for (const part of pat2.replace(/^\{|\}$/g, "").split(",").map((y) => y.trim()).filter(Boolean)) { const [a, bb] = part.split(":").map((y) => y.trim()); mod.imports.set(bb || a, { t, name: a }); }
          }
          ch.kind = "dynimport"; ch.names = []; ch.bind = true;
        }
      }
      for (const nm of ch.names) if (exported) mod.exportsLocal.set(nm, nm);
      if (!ch.bind) {
        // inner dynamic imports: `const { a, b: c } = await import(x)` (named), `const ns = await import(x)` (alias),
        // `(await import(x)).name` (named); anything else -- incl. every require(x) -- reaches EVERY export of x.
        for (const d of cb.matchAll(/(?<![\w$.])(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g)) {
          const t = resolveSpec(file, d[1]); if (!t) continue;
          const pre = cb.slice(Math.max(0, d.index - 240), d.index); const post = cb.slice(d.index + d[0].length, d.index + d[0].length + 80);
          let y;
          if ((y = pre.match(/(?:const|let|var)\s*\{([^{}]*)\}\s*=\s*await\s*$/))) { for (const part of y[1].split(",").map((z) => z.trim()).filter(Boolean)) { const [a] = part.split(":").map((z) => z.trim()); ch.dynNamed.push({ t, name: a }); } continue; }
          if ((y = pre.match(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s*$/))) { ch.dynAlias.set(y[1], t); continue; }
          if (/\(\s*await\s*$/.test(pre) && (y = post.match(/^\s*\)\s*\.\s*([A-Za-z_$][\w$]*)/))) { ch.dynNamed.push({ t, name: y[1] }); continue; }
          ch.dyn.push(t);
        }
      }
    }
    return mod;
  }
  const mods = new Map(files.map((f) => [f, parse(f)]));

  // ---- SQL writer functions + supabase.js base sinks (AUTO-DISCOVERED; pinned below) --------------------------------
  const sqlWriters = new Set();
  {
    const defs = [];
    for (const f of readdirSync(abs("supabase/migrations")).filter((y) => y.endsWith(".sql")).sort()) {
      for (const mm of src("supabase/migrations/" + f).matchAll(/create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?([a-z_0-9]+)\s*\(([\s\S]*?)\n\$\$;/gi)) defs.push({ name: mm[1], body: sqlCode(mm[2]) });
    }
    const DML = /\b(insert\s+into|update|delete\s+from|merge\s+into|truncate(\s+table)?|copy)\s+(only\s+)?(public\.)?"?report_snapshots"?\b/i;
    for (let changed = true; changed;) {
      changed = false;
      for (const d of defs) {
        if (sqlWriters.has(d.name)) continue;
        const noStr = d.body.replace(/'(?:[^']|'')*'/g, "''");
        if (DML.test(d.body) || [...sqlWriters].some((w) => new RegExp("\\b" + w + "\\s*\\(").test(noStr))) { sqlWriters.add(d.name); changed = true; }
      }
    }
  }
  const supa = mods.get(SUPA);
  const baseSinks = new Set(); const dynamicRest = [];
  for (const ch of supa.chunks) {
    if (!ch.names.length) continue;
    // on the raw AND the joined / escape-decoded view; ANY non-GET evidence in the function (a literal non-GET method, a
    // computed or shorthand method, fetch(url, opts)) makes a report_snapshots REST path a write
    const views = [ch.b, joinLiterals(decodeEscapes(joinLiterals(ch.b)))];
    const restWrite = views.some((v) => /\/rest\/v1\/report_snapshots\b/i.test(v)) && (/method:\s*["'](POST|PATCH|DELETE|PUT)["']/.test(ch.b) || nonGetEvidence(ch.b));
    const rpcWrite = views.some((v) => [...v.matchAll(/\/rest\/v1\/rpc\/([a-z_0-9]+)/gi)].some((y) => sqlWriters.has(y[1].toLowerCase())));
    if (restWrite || rpcWrite) for (const nm of ch.names) baseSinks.add(nm);
    // a REST path whose table / rpc segment is COMPUTED (`${x}` or a literal ending at /rest/v1/ or /rest/v1/rpc/)
    if (views.some((v) => /\/rest\/v1\/(rpc\/)?(\$\{|["'`])/.test(v))) dynamicRest.push(ch.names[0]);
  }
  // deleteRouteShadowSnapshots can only ever delete scheduler-v2/<route publisher key> rows (pinned in E2).
  const SHADOW_ONLY_SINKS = new Set(["deleteRouteShadowSnapshots"]);

  // ---- REPORT-KEY PROOFS at a call site ---------------------------------------------------------------------------
  const closeAt = (s, open) => { let d = 0; for (let k = open; k < s.length; k++) { if ("([{".includes(s[k])) d++; else if (")]}".includes(s[k])) { d--; if (d === 0) return k; } } return s.length - 1; };
  // The reconcilers' injectable default `shadowKeyFor = (rk) => "scheduler-v2/" + rk` is proven ONLY while NO file can
  // override it: every occurrence must be a call, that exact default definition, or a same-name shorthand pass
  // (`{ shadowKeyFor }`) from a chunk whose own binding IS that default; anything else (`shadowKeyFor: x`, an assignment,
  // a local re-declaration, a value pass under another name, a string naming it) counts as an override.
  const SKF_DEFAULT = /^shadowKeyFor\s*=\s*\(\s*rk\s*\)\s*=>\s*"scheduler-v2\/"\s*\+\s*rk\s*[,}\n]/;
  let skfo = null;
  const shadowKeyForOverridden = () => {
    if (skfo !== null) return skfo;
    skfo = false;
    for (const f of files) {
      const mod = mods.get(f);
      if (/["'`]shadowKeyFor["'`]/.test(joinLiterals(decodeEscapes(mod.b)))) { skfo = true; break; }
      for (const ch of mod.chunks) {
        for (const mm of ch.m.matchAll(/(?<![\w$])shadowKeyFor(?![\w$])/g)) {
          const after = ch.m.slice(mm.index + 12); const prevC = ch.m.slice(0, mm.index).replace(/\s+$/, "").slice(-1);
          if (/^\s*\(/.test(after) && prevC !== ".") continue;                                   // a call
          if (SKF_DEFAULT.test(ch.b.slice(mm.index, mm.index + 80)) && prevC !== ".") continue;   // the default itself
          if (/^\s*[,}]/.test(after) && "{,".includes(prevC) && /shadowKeyFor\s*=\s*\(\s*rk\s*\)\s*=>\s*"scheduler-v2\/"\s*\+\s*rk\b/.test(ch.b)) continue;
          skfo = true; break;
        }
        if (skfo) break;
      }
      if (skfo) break;
    }
    return skfo;
  };
  // Is `e` ONE template literal from its first to its last character (nothing after the closing backtick)?
  function wholeTemplate(e) {
    if (e[0] !== "`") return false;
    const mb = lex(e, { blankStrings: true });
    let i = 1; let depth = 0;
    for (; i < e.length; i++) {
      if (depth === 0) { const c = e[i]; if (c === "\\") { i++; continue; } if (c === "`") break; if (c === "$" && e[i + 1] === "{") { depth = 1; i++; } continue; }
      if (mb[i] === "{") depth++; else if (mb[i] === "}") depth--;
    }
    return i === e.length - 1;
  }
  // Is `e` ONE call `name(...)` whose closing parenthesis is its last character?
  const wholeCall = (e, name) => { const mb = lex(e, { blankStrings: true }); const m = mb.match(new RegExp("^" + esc(name) + "\\s*\\(")); return !!m && closeAt(mb, m[0].length - 1) === e.length - 1; };
  // The operands of `e` when NOTHING but binary `+` separates them at depth 0 (no ?:, ||, &&, ??, comparison, comma,
  // arithmetic, assignment, `in`/`instanceof`...); else null. JS `+` is left-associative, so a string first operand
  // makes the whole value start with that operand's text.
  function plusOperands(e) {
    const mb = lex(e, { blankStrings: true });
    const cuts = []; let d = 0; let top = "";
    for (let k = 0; k < mb.length; k++) {
      const c = mb[k];
      if ("([{".includes(c)) { d++; top += " "; continue; }
      if (")]}".includes(c)) { d--; top += " "; if (d < 0) return null; continue; }
      if (d > 0) { top += " "; continue; }
      if (c === "?" && mb[k + 1] === "." && !/[0-9]/.test(mb[k + 2] || "")) { top += "  "; k++; continue; } // optional chaining
      top += c;
      if (c === "+") { if (mb[k + 1] === "+" || mb[k + 1] === "=" || mb[k - 1] === "+") return null; cuts.push(k); continue; }
      if (!/[\s\w$"'`.]/.test(c)) return null;
    }
    if (d !== 0 || /(?<![\w$.])(in|instanceof|typeof|void|delete|new|await|yield)(?![\w$])/.test(top)) return null;
    const ops = []; let s = 0; for (const c of cuts) { ops.push(e.slice(s, c)); s = c + 1; } ops.push(e.slice(s));
    return ops.some((o) => !o.trim()) ? null : ops;
  }
  // The FIRST operand of a `+` chain proves the shadow namespace only when it is EXACTLY one of: a "scheduler-v2/..."
  // string literal, a whole `scheduler-v2/...` template, a whole shadowSnapshotKey(...) call (the report-derivation.js
  // import, not rebound in the chunk), a whole shadowKeyFor(...) call of the never-overridden default, or an identifier
  // that resolves to one of those.
  function shadowOperand(o, mod, chunk, depth, pos) {
    if (/^(["'])scheduler-v2\/[^"'`\\]*\1$/.test(o)) return true;
    if (o.startsWith("`scheduler-v2/") && wholeTemplate(o)) return true;
    const localBind = (id) => !!chunk && (paramBinds(id, chunk.m) || new RegExp("(?<![\\w$.])(const|let|var|function)\\s+" + id + "\\b").test(chunk.m));
    if (/^shadowSnapshotKey\s*\(/.test(o) && wholeCall(o, "shadowSnapshotKey") && !localBind("shadowSnapshotKey")) {
      const im = mod.imports.get("shadowSnapshotKey");
      if ((im && im.t === DERIV && im.name === "shadowSnapshotKey") || mod.file === DERIV) return true;
    }
    if (/^shadowKeyFor\s*\(/.test(o) && wholeCall(o, "shadowKeyFor") && chunk && /shadowKeyFor\s*=\s*\(\s*rk\s*\)\s*=>\s*"scheduler-v2\/"\s*\+\s*rk\b/.test(chunk.b) && !shadowKeyForOverridden()) return true;
    if (/^[A-Za-z_$][\w$]*$/.test(o)) { const r = resolveIdent(o, mod, chunk, depth, pos); return r.kind === "shadow" || (r.kind === "literal" && r.key.startsWith(SHADOW_PREFIX)); }
    return false;
  }
  function resolveExpr(expr, mod, chunk, depth, pos) {
    const e = expr.trim(); let y;
    if (depth > 4) return { kind: "dynamic", why: "depth" };
    if ((y = e.match(/^(["'])([^"'`\\]*)\1$/))) return { kind: "literal", key: y[2] };
    if ((y = e.match(/^`([^`$\\]*)`$/))) return { kind: "literal", key: y[1] };
    const ops = plusOperands(e);
    if (ops && shadowOperand(ops[0].trim(), mod, chunk, depth + 1, pos)) return { kind: "shadow" };
    if ((y = e.match(/^([A-Za-z_$][\w$]*)$/))) return resolveIdent(y[1], mod, chunk, depth, pos);
    return { kind: "dynamic", why: e.slice(0, 50).replace(/\s+/g, " ") };
  }
  // SHADOWING GUARD: any parameter-list / catch / bare-arrow occurrence of `id` in the chunk (or an `if (id) {`-like
  // parenthesised use, conservatively) may bind a different value at the call site -> the identifier is unproven.
  const paramBinds = (id, m) => [...m.matchAll(/\(([^()]*(?:\([^()]*\)[^()]*)*)\)\s*(?:=>|\{)/g)].some((g) => new RegExp("(?<![\\w$.])" + esc(id) + "(?![\\w$])").test(g[1]))
    || new RegExp("(?<![\\w$.])" + esc(id) + "\\s*=>").test(m) || new RegExp("catch\\s*\\(\\s*" + esc(id) + "\\b").test(m);
  function resolveIdent(id, mod, chunk, depth, pos) {
    if (chunk) {
      const decls = [...chunk.m.matchAll(new RegExp("(?<![\\w$.])(const|let|var)\\s+" + esc(id) + "\\s*=", "g"))];
      const destructured = new RegExp("(?<![\\w$.])(const|let|var)\\s*[{[][^=;]*(?<![\\w$.])" + esc(id) + "(?![\\w$])[^=;]*[}\\]]\\s*=").test(chunk.m);
      const assigns = [...chunk.m.matchAll(new RegExp("(?<![\\w$.])" + esc(id) + "\\s*=(?![=>])", "g"))];
      const binds = paramBinds(id, chunk.m) || destructured;
      // chunk-local: exactly ONE `const id = <init>`, no other assignment / binding of id in the chunk, declared BEFORE
      // the call and in a block that ENCLOSES the call (the brace depth never drops below the declaration's between them)
      if (decls.length === 1 && decls[0][1] === "const" && assigns.length === 1 && !binds && typeof pos === "number" && decls[0].index < pos) {
        let dep = 0; let enclosed = true;
        for (const c of chunk.m.slice(decls[0].index, pos)) { if (c === "{") dep++; else if (c === "}") { dep--; if (dep < 0) { enclosed = false; break; } } }
        if (enclosed) {
          const start = decls[0].index + decls[0][0].length; let d = 0, e = start;
          for (; e < chunk.m.length; e++) { const c = chunk.m[e]; if ("{([".includes(c)) d++; else if ("})]".includes(c)) { if (d === 0) break; d--; } else if ((c === ";" || c === "\n" || c === ",") && d === 0) break; }
          // A newline ends the initialiser only when the next line does not CONTINUE the expression (`.slice(13)`,
          // `? a : b`, `|| x`, `+ y`...): a continued multi-line initialiser is unproven.
          if (chunk.m[e] === "\n" && /^\s*([.?:+\-*/%&|^<>=!,([`]|(in|instanceof)(?![\w$]))/.test(chunk.m.slice(e + 1))) return { kind: "dynamic", why: "multi-line initialiser " + id };
          return resolveExpr(chunk.b.slice(start, e), mod, chunk, depth + 1, decls[0].index);
        }
      }
      if (decls.length || assigns.length || binds) return { kind: "dynamic", why: "local " + id };
    }
    if (mod.consts.has(id)) return resolveExpr(mod.consts.get(id), mod, null, depth + 1);
    const im = mod.imports.get(id);
    if (im && im.t && mods.has(im.t)) { const tm = mods.get(im.t); const loc = tm.exportsLocal.get(im.name); if (loc && tm.consts.has(loc)) return resolveExpr(tm.consts.get(loc), tm, null, depth + 1); }
    return { kind: "dynamic", why: "ident " + id };
  }
  // The report key of ONE call: the argument must be an object literal with EXACTLY ONE top-level reportKey property and
  // NO spread (a later duplicate / spread could override a proven key at runtime). `pos` = the call's offset in the chunk.
  // Only KEY positions are scanned (after `{` / `,`, before `:`); a computed key (`[expr]: v`), a quoted key that reads
  // reportKey ("reportKey" / 'reportKey'), an accessor / method named reportKey, or a spread makes it unproven.
  function keyOfCall(argM, argB, mod, chunk, pos) {
    if (!argM.trimStart().startsWith("{")) return { kind: "dynamic", why: "arg not an object literal" };
    const off = argM.indexOf("{"); let d = 0; const found = []; let keyPos = false;
    for (let k = off; k < argM.length; k++) {
      const c = argM[k];
      if (d === 1 && keyPos && c === "[") return { kind: "dynamic", why: "computed key" };
      if (d === 1 && keyPos && /["'`]/.test(c)) {
        let e2 = k + 1; while (e2 < argM.length && argM[e2] !== c) e2++;
        if (decodeEscapes(argB.slice(k + 1, e2)) === "reportKey") return { kind: "dynamic", why: "quoted reportKey" };
        k = e2; continue;
      }
      if ("{([".includes(c)) { d++; if (d === 1) keyPos = true; continue; }
      if ("})]".includes(c)) { d--; continue; }
      if (d !== 1) continue;
      if (c === ",") { keyPos = true; continue; }
      if (c === ":") { keyPos = false; continue; }
      if (c === "." && argM.slice(k, k + 3) === "...") return { kind: "dynamic", why: "spread" };
      if (keyPos && /[A-Za-z_$]/.test(c) && !/[\w$.]/.test(argM[k - 1] || "")) {
        const w = argM.slice(k).match(/^[A-Za-z_$][\w$]*/)[0];
        if (/^(get|set|async|static)$/.test(w) && /^\s*\*?\s*reportKey\b/.test(argM.slice(k + w.length))) return { kind: "dynamic", why: "accessor reportKey" };
        if (w === "reportKey" && /^\s*\(/.test(argM.slice(k + 9))) return { kind: "dynamic", why: "method reportKey" };
        if (w === "reportKey" && /^\s*(:|,|\}|$)/.test(argM.slice(k + 9))) found.push(k);
        k += w.length - 1;
      }
    }
    if (found.length !== 1) return { kind: "dynamic", why: found.length ? "duplicate reportKey" : "no reportKey" };
    const at = found[0];
    const colon = argM.slice(at + 9).match(/^\s*:/);
    if (!colon) return resolveIdent("reportKey", mod, chunk, 0, pos);
    const start = at + 9 + colon[0].length; let dd = 0, e = start;
    for (; e < argM.length; e++) { const c = argM[e]; if ("{([".includes(c)) dd++; else if ("})]".includes(c)) { if (dd === 0) break; dd--; } else if (c === "," && dd === 0) break; }
    return resolveExpr(argB.slice(start, e), mod, chunk, 0, pos);
  }
  const proofClass = (pr) => (pr.kind === "shadow" || (pr.kind === "literal" && pr.key.startsWith(SHADOW_PREFIX)) ? "cleared:shadow"
    : pr.kind === "literal" ? (FENCED.has(pr.key) ? "fenced:" + pr.key : "cleared:" + pr.key) : "unproven");

  // ---- DI forwarders: a sink bound to a DI name (`saveShadow: (a, o) => sb.saveShadowSnapshotIfNewer(a, o)` /
  // `publishLive = publishLiveSnapshotIfNewer`) is proven through EVERY call site of that DI name in the repo. The proof
  // only sees calls THROUGH THE NAME, so every other reference keeps the sink tainted: a member read / alias
  // (`const s = deps.name`), a value pass (`run(deps.name)`, `[..., name]`, `{ name }` in an object literal), `.call` /
  // `.apply` / `.bind`, `typeof`, a spread, an optional call, a string naming it (computed access `deps["name"]`), a
  // rebind of the name to anything but a sink / plain forwarder, a destructuring rename, a generic name, or any unproven
  // call site. Allowed non-call references: the binding itself (`name: <forwarder|sink>` / `name = <forwarder|sink>`) and
  // a same-name DESTRUCTURING PATTERN or PARAMETER (`{ name }` / `({ name }) =>` / `function f(name)`) -- which binds a
  // same-named local whose calls are counted above.
  const GENERIC_DI = new Set(["save", "write", "persist", "store", "publish", "put", "upsert", "set", "update", "remove", "del", "fn", "run", "prune"]);
  const FORWARDER = /^(?:async\s*)?\(\s*([A-Za-z_$][\w$]*)\s*((?:,\s*[A-Za-z_$][\w$]*\s*)*)\)\s*=>\s*(?:[A-Za-z_$][\w$]*\s*\.\s*)?([A-Za-z_$][\w$]*)\s*\(\s*\1\s*((?:,\s*[A-Za-z_$][\w$]*\s*)*)\)\s*$/;
  const isSinkBinding = (val) => {
    const v = val.trim(); let y;
    if ((y = v.match(/^(?:[A-Za-z_$][\w$]*\s*\.\s*)?([A-Za-z_$][\w$]*)$/))) return baseSinks.has(y[1]);
    if ((y = v.match(FORWARDER))) return baseSinks.has(y[3]) && y[2].replace(/\s+/g, "") === y[4].replace(/\s+/g, "");
    return false;
  };
  // The value after `name:` / `name =` at `j` (the ':' / '=' offset): up to the first depth-0 ',', ';', '}', ')' or ']'.
  const valueAt = (m, b, j) => { let d = 0, e = j + 1; for (; e < m.length; e++) { const c = m[e]; if ("{([".includes(c)) d++; else if ("})]".includes(c)) { if (d === 0) break; d--; } else if ((c === "," || c === ";") && d === 0) break; } return b.slice(j + 1, e); };
  // Is offset `at` a binding position of a destructuring pattern or a parameter list (not an object literal / call arg)?
  function inPatternOrParams(m, at) {
    let k = at - 1; let d = 0;
    for (; k >= 0; k--) { const c = m[k]; if (")]}".includes(c)) d++; else if ("([{".includes(c)) { if (d === 0) break; d--; } }
    if (k < 0) return false;
    const close = closeAt(m, k); const after = m.slice(close + 1);
    if (m[k] === "(") {                                                      // a parameter list: arrow / function / method,
      if (/^\s*=>/.test(after)) return true;                                 // never if/for/while/switch/... ( ) {
      const word = (m.slice(0, k).match(/([A-Za-z_$][\w$]*)\s*$/) || [])[1];
      return /^\s*\{/.test(after) && !!word && !/^(if|for|while|switch|with|return|typeof|await|yield|in|of|new|delete|void|do|else|case)$/.test(word);
    }
    if (/^\s*=(?![=>])/.test(after)) return true;                           // `{ name } = x` / `[name] = x` / `({ name } = {})`
    if (/^\s*[,}\]]/.test(after) || /^\s*\)\s*(=>|\{)/.test(after)) return inPatternOrParams(m, k);  // nested pattern
    return false;
  }
  const diCache = new Map();
  function diCleared(name) {
    if (diCache.has(name)) return diCache.get(name);
    let v = { cleared: false, why: "generic-di-name" };
    if (!GENERIC_DI.has(name) && name.length >= 6) {
      const sites = []; const leaks = []; let rebind = false;
      for (const f of files) {
        const mod = mods.get(f);
        for (const ch of mod.chunks) {
          if (ch.kind === "import" || ch.kind === "reexport") {
            // a same-name import / export keeps every call visible under the name; a RENAME (`x as y`) hides them
            for (const mm of ch.m.matchAll(new RegExp("(?<![\\w$])" + esc(name) + "(?![\\w$])", "g"))) {
              if (/^\s+as\b/.test(ch.m.slice(mm.index + name.length)) || /\bas\s+$/.test(ch.m.slice(0, mm.index))) leaks.push(rel(f) + ":" + ch.line + " (renamed import/export)");
            }
            continue;
          }
          if (new RegExp("[\"'`]" + esc(name) + "[\"'`]").test(joinLiterals(decodeEscapes(joinLiterals(ch.b))))) leaks.push(rel(f) + ":" + ch.line + " (string)");
          for (const mm of ch.m.matchAll(new RegExp("(?<![\\w$])" + esc(name) + "(?![\\w$])", "g"))) {
            let j = mm.index + name.length; while (j < ch.m.length && /\s/.test(ch.m[j])) j++;
            const before = ch.m.slice(0, mm.index).replace(/\s+$/, ""); const prevC = before.slice(-1);
            const member = prevC === "." && !before.endsWith("...");
            if (/(?:^|[^\w$.])function\s*\*?$/.test(before)) { rebind = true; continue; }   // a function declared under the name
            if (ch.m[j] === "(") { const e = closeAt(ch.m, j); sites.push({ f, line: ch.line, c: proofClass(keyOfCall(ch.m.slice(j + 1, e), ch.b.slice(j + 1, e), mod, ch, mm.index)) }); continue; }
            if (before.endsWith("...")) { leaks.push(rel(f) + ":" + ch.line + " (spread)"); continue; }
            const decl = /(?:^|[^\w$.])(?:const|let|var|function)$/.test(before);
            if (ch.m[j] === ":" && ch.m[j + 1] !== ":" && !member && prevC !== "?" && !/(?:^|[^\w$])case$/.test(before)) { if (!isSinkBinding(valueAt(ch.m, ch.b, j))) rebind = true; continue; }
            // an assignment / declaration / pattern default (`name = v`, `obj.name = v`, `{ name = v }`): only a sink or a
            // plain forwarder keeps the proof; anything else is a rebind
            if (ch.m[j] === "=" && ch.m[j + 1] !== "=" && ch.m[j + 1] !== ">") { if (!isSinkBinding(valueAt(ch.m, ch.b, j))) rebind = true; continue; }
            if (!member && !decl && /^[,})\]]/.test(ch.m[j] || "") && inPatternOrParams(ch.m, mm.index)) continue;
            leaks.push(rel(f) + ":" + ch.line);
          }
        }
      }
      if (!sites.length) v = { cleared: false, why: "no-call-site" };
      else if (leaks.length) v = { cleared: false, why: "non-call reference(s) " + [...new Set(leaks)].slice(0, 4).join(" ") };
      else if (rebind) v = { cleared: false, why: "rebind" };
      else if (sites.every((s) => s.c.startsWith("cleared:"))) v = { cleared: true, why: sites.length + " call site(s) proven " + [...new Set(sites.map((s) => s.c))].join(",") };
      else v = { cleared: false, why: "unproven call site(s) " + sites.filter((s) => !s.c.startsWith("cleared:")).map((s) => rel(s.f) + ":" + s.line).slice(0, 4).join(" ") };
    }
    diCache.set(name, v);
    return v;
  }

  // ---- per-chunk DIRECT writes (each tested on the raw comment-free chunk AND its normalized view) -------------------
  const foldCache = new Map();
  function moduleFolds(mod) {
    if (foldCache.has(mod)) return foldCache.get(mod);
    const res = new Map();
    for (const [k, v] of mod.consts) { const l = literalOf(v); if (l !== null && INTERESTING_LITERAL.test(l)) res.set(k, l); }
    for (const [loc, im] of mod.imports) {
      const tm = mods.get(im.t); const e = tm && tm.exportsLocal.get(im.name);
      if (e && tm.consts.has(e)) { const l = literalOf(tm.consts.get(e)); if (l !== null && INTERESTING_LITERAL.test(l)) res.set(loc, l); }
    }
    foldCache.set(mod, res);
    return res;
  }
  // joined literals + module / imported / chunk-local string consts folded into `${X}` and bare `X` expression positions.
  function normView(text, mod) {
    const folds = new Map(moduleFolds(mod));
    const j0 = joinLiterals(text);
    for (const mm of j0.matchAll(/(?<![\w$.])(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(["'`])([^"'`\\\n]*)\2/g)) if (INTERESTING_LITERAL.test(mm[3]) && !(mm[2] === "`" && mm[3].includes("${"))) folds.set(mm[1], mm[3]);
    let s = j0;
    for (const [k, v] of folds) {
      const e = esc(k);
      s = s.replace(new RegExp("\\$\\{\\s*" + e + "\\s*\\}", "g"), v).replace(new RegExp("(?<![\\w$.])" + e + "(?![\\w$])(?!\\s*:(?!:))(?!\\s*=(?![=>]))", "g"), JSON.stringify(v));
    }
    return joinLiterals(decodeEscapes(joinLiterals(s)));
  }
  const WRITER_RPC_RE = new RegExp("(\\/rest\\/v1\\/rpc\\/|\\.rpc\\(\\s*[\"'`]|\\b(?:select|perform|call)\\s+(?:\\*\\s+from\\s+)?(?:\"?public\"?\\s*\\.\\s*)?)\"?(" + [...sqlWriters].map(esc).join("|") + ")\\b", "i");
  const DIRECT = [
    // a REST call on the table in a file with ANY non-GET evidence (a literal non-GET method, a computed method, a method
    // in an options object built elsewhere, fetch(url, opts)) -- only a file whose every method is a literal GET is a reader
    [(v, nonGet) => nonGet && /\/rest\/v1\/report_snapshots\b/i.test(v), "rest:report_snapshots"],
    [(v) => /\.from\(\s*["'`]report_snapshots["'`]\s*\)/i.test(v), "client:report_snapshots"],
    [(v) => /\b(insert\s+into|update|delete\s+from|merge\s+into|truncate(\s+table)?|copy)\s+(only\s+)?("?public"?\s*\.\s*)?"?report_snapshots"?\b/i.test(v), "sql:report_snapshots"],
    [(v) => WRITER_RPC_RE.test(v), "rpc:report_snapshots"],
  ];

  // ---- the COARSE TRIPWIRE: a per-file hit signature (t1 = report_snapshot* mentions after joining fragments, lower-casing
  // and %5F-decoding; rest = computed-path REST calls in a file with non-GET evidence; client = computed-table
  // .from(x).insert/upsert/update/delete; rpc = computed .rpc(x); sql = DML whose target is computed) -------------------
  function tripSignature(mod) {
    const j = joinLiterals(mod.b);
    const c = { t1: (joinLiterals(decodeEscapes(j)).toLowerCase().match(/report_snapshot/g) || []).length };
    c.rest = nonGetEvidence(mod.b) || nonGetEvidence(j) ? (j.match(/\/rest\/v1\/(?:rpc\/)?(?=\$\{|["'`])/gi) || []).length : 0;
    c.client = 0; c.rpc = 0;
    for (const mm of mod.m.matchAll(/\.\s*(from|rpc)\s*\(/g)) {
      const open = mm.index + mm[0].length - 1; const close = closeAt(mod.m, open);
      let d = 0, e = open + 1; for (; e < close; e++) { const ch = mod.m[e]; if ("{([".includes(ch)) d++; else if ("})]".includes(ch)) d--; else if (ch === "," && d === 0) break; }
      const first = mod.b.slice(open + 1, e).trim();
      if (/^(["'`])[^"'`\\]*\1$/.test(first) && !first.includes("${")) continue;
      if (mm[1] === "rpc") c.rpc++;
      else if (/^\s*\.\s*(insert|upsert|update|delete)\s*\(/.test(mod.m.slice(close + 1, close + 60))) c.client++;
    }
    c.sql = (j.match(/\b(?:insert\s+into|update|delete\s+from|merge\s+into|truncate(?:\s+table)?|copy)\s+(?:only\s+)?(?:"?public"?\s*\.\s*)?(?:\$\{|["'`]\s*\+)/gi) || []).length;
    // a computed module specifier (import(x) / require(x)): the import analysis cannot follow it
    c.dynimport = 0;
    for (const mm of mod.m.matchAll(/(?<![\w$.])(import|require)\s*\(/g)) {
      const open = mm.index + mm[0].length - 1; const close = closeAt(mod.m, open);
      if (!/^\s*(["'])[^"'`\\$]*\1\s*$/.test(mod.b.slice(open + 1, close))) c.dynimport++;
    }
    return Object.entries(c).filter(([, n]) => n > 0).map(([k, n]) => k + ":" + n).join(",");
  }
  const tripwire = new Map();
  for (const f of files) { if (f === SUPA) continue; const sig = tripSignature(mods.get(f)); if (sig) tripwire.set(rel(f), sig); }

  const baseUse = new Map(); const notes = new Map(); const clearsApplied = [];
  for (const f of files) {
    if (f === SUPA) continue;
    const mod = mods.get(f);
    const fileNonGet = nonGetEvidence(mod.b) || nonGetEvidence(normView(mod.b, mod));
    const localSinks = new Map([...baseSinks].map((nm) => [nm, nm]));
    for (const [loc, im] of mod.imports) if (im.t === SUPA && baseSinks.has(im.name)) localSinks.set(loc, im.name);
    for (const ch of mod.chunks) {
      if (ch.kind === "import" || ch.kind === "reexport" || ch.bind) continue;
      const S = new Set(); const why = [];
      for (const [ln, nm] of localSinks) {
        for (const mm of ch.m.matchAll(new RegExp("(?<![\\w$])" + esc(ln) + "(?![\\w$])", "g"))) {
          if (SHADOW_ONLY_SINKS.has(nm)) { why.push(nm + ": shadow-only sink"); continue; }
          let j = mm.index + ln.length; while (j < ch.m.length && /\s/.test(ch.m[j])) j++;
          const pre = ch.m.slice(Math.max(0, mm.index - 200), mm.index);
          if (ch.m[j] === "(") {
            const e = closeAt(ch.m, j); const argM = ch.m.slice(j + 1, e);
            const pr = keyOfCall(argM, ch.b.slice(j + 1, e), mod, ch, mm.index); const c = proofClass(pr);
            if (c.startsWith("cleared:")) { why.push(nm + ": " + c); continue; }
            if (c.startsWith("fenced:")) { S.add(nm + "@" + c.slice(7)); why.push(nm + ": " + c); continue; }
            const fw = pre.match(/([A-Za-z_$][\w$]*)\s*[:=]\s*(?:async\s*)?\(\s*([A-Za-z_$][\w$]*)\s*(?:,\s*[A-Za-z_$][\w$]*\s*)*\)\s*=>\s*(?:[A-Za-z_$][\w$]*\s*\.\s*)?$/);
            if (fw && new RegExp("^\\s*" + esc(fw[2]) + "\\b").test(argM)) {
              const v = diCleared(fw[1]);
              why.push(nm + ": di-forwarder " + fw[1] + (v.cleared ? " cleared" : "") + " (" + v.why + ")");
              if (!v.cleared) S.add(nm);
              continue;
            }
            S.add(nm); why.push(nm + ": unproven (" + (pr.why || c) + ")");
          } else {
            const bind = pre.match(/([A-Za-z_$][\w$]*)\s*[:=]\s*(?:[A-Za-z_$][\w$]*\s*\.\s*)?$/);
            if (bind && bind[1] !== ln) {
              const v = diCleared(bind[1]);
              why.push(nm + ": di-ref " + bind[1] + (v.cleared ? " cleared" : "") + " (" + v.why + ")");
              if (!v.cleared) S.add(nm);
              continue;
            }
            S.add(nm); why.push(nm + ": ref");
          }
        }
      }
      const views = [ch.b, normView(ch.b, mod)];
      for (const [test, tag] of DIRECT) if (views.some((v) => test(v, fileNonGet))) S.add(tag);
      for (const c of clears) {
        if (rel(f) !== c.file || !ch.names.includes(c.decl)) continue;
        const evidence = c.evidence({ chunk: ch, mods, abs, lex });
        clearsApplied.push({ id: c.id, evidence, hadSink: S.has(c.sink) });
        if (evidence && S.has(c.sink)) { S.delete(c.sink); why.push(c.sink + ": manual clear " + c.id); }
      }
      baseUse.set(ch, S); notes.set(ch, why);
    }
  }

  // ---- propagation: wrappers (import-aware), namespaces (member / whole), dynamic imports, local declarations -----------
  const taint = new Map(files.map((f) => [f, new Map()]));
  for (const nm of baseSinks) taint.get(SUPA).set(nm, new Set(SHADOW_ONLY_SINKS.has(nm) ? [] : [nm]));
  const allExportNames = (file, seen = new Set()) => { if (seen.has(file)) return []; seen.add(file); const mod = mods.get(file); if (!mod) return []; return [...mod.exportsLocal.keys(), ...mod.reexports.keys(), ...mod.star.flatMap((t) => allExportNames(t, seen))]; };
  function exportTaint(file, name, seen = new Set()) {
    const k = file + "#" + name; if (seen.has(k)) return new Set(); seen.add(k);
    const mod = mods.get(file); const res = new Set(); if (!mod) return res;
    const loc = mod.exportsLocal.get(name);
    if (loc != null) {
      for (const y of taint.get(file).get(loc) || []) res.add(y);
      if (mod.imports.has(loc)) { const im = mod.imports.get(loc); for (const y of exportTaint(im.t, im.name, seen)) res.add(y); }
    }
    if (mod.reexports.has(name)) { const re = mod.reexports.get(name); if (re.name === "*") { for (const e of allExportNames(re.t)) for (const y of exportTaint(re.t, e, seen)) res.add(y); } else for (const y of exportTaint(re.t, re.name, seen)) res.add(y); }
    for (const t of mod.star) for (const y of exportTaint(t, name, seen)) res.add(y);
    return res;
  }
  const allTaint = (file) => { const res = new Set(); for (const e of allExportNames(file)) for (const y of exportTaint(file, e)) res.add(y); return res; };
  const provenAtCallSite = (t, name) => t === SUPA && baseSinks.has(name);
  const chunkSinks = new Map();
  const IDENT_RE = /(?<![\w$.])([A-Za-z_$][\w$]*)(\s*\.\s*([A-Za-z_$][\w$]*))?/g;
  for (let changed = true, iter = 0; changed && iter < 80; iter++) {
    changed = false;
    for (const f of files) {
      if (f === SUPA) continue;
      const mod = mods.get(f); const T = taint.get(f);
      for (const ch of mod.chunks) {
        if (ch.kind === "import" || ch.kind === "reexport" || ch.bind) continue;
        const prev = chunkSinks.get(ch) || new Set();
        const S = new Set([...prev, ...(baseUse.get(ch) || [])]);
        for (const mm of ch.m.matchAll(IDENT_RE)) {
          const base = mm[1]; const member = mm[3];
          if (ch.names.includes(base)) continue;
          if (T.has(base)) for (const y of T.get(base)) S.add(y);
          if (mod.imports.has(base)) { const im = mod.imports.get(base); if (!provenAtCallSite(im.t, im.name)) for (const y of exportTaint(im.t, im.name)) S.add(y); }
          const nsT = mod.ns.get(base) || ch.dynAlias.get(base);
          if (nsT) {
            if (member) { if (!provenAtCallSite(nsT, member)) for (const y of exportTaint(nsT, member)) S.add(y); }
            else if (!/^\s*=(?!=)/.test(ch.m.slice(mm.index + base.length))) for (const y of allTaint(nsT)) S.add(y); // a namespace used as a VALUE reaches every export
          }
        }
        for (const dn of ch.dynNamed) if (!provenAtCallSite(dn.t, dn.name)) for (const y of exportTaint(dn.t, dn.name)) S.add(y);
        for (const t of ch.dyn) for (const y of allTaint(t)) S.add(y);
        if (S.size !== prev.size) { chunkSinks.set(ch, S); changed = true; }
        for (const nm of ch.names) { const cur = T.get(nm) || new Set(); const sz = cur.size; for (const y of S) cur.add(y); if (!T.has(nm)) T.set(nm, cur); if (cur.size !== sz) changed = true; }
      }
    }
  }

  // ---- the writer map: per file, its tainted named declarations ('<module>' = top-level statements) + reached sinks ----
  const writers = new Map();
  for (const f of files) {
    if (f === SUPA) continue;
    const mod = mods.get(f); const fns = new Set(); const sinks = new Set(); const why = [];
    for (const ch of mod.chunks) {
      const S = chunkSinks.get(ch);
      if (S && S.size) {
        const named = ch.kind === "function" || ch.kind === "class" || ch.kind === "default" || (ch.kind === "var" && (ch.fnInit || mod.exportsLocal.has(ch.names[0])));
        if (named) for (const nm of ch.names) fns.add(nm); else fns.add("<module>");
        for (const y of S) sinks.add(y);
      }
      for (const w of notes.get(ch) || []) why.push((ch.names[0] || "<module>") + ": " + w);
    }
    if (sinks.size) writers.set(rel(f), { fns: [...fns].sort(), sinks: [...sinks].sort(), why });
  }
  return { files: files.map(rel), sqlWriters, baseSinks, dynamicRest, writers, tripwire, clearsApplied, mods, supaMod: supa, diCleared };
}

// ---- MANUAL CLEARS: a sink reference the call-site proofs cannot see through, with MACHINE-CHECKED evidence --------------
const chunkOf = (mods, file, decl) => { const mod = mods.get(abs(file)); return mod && mod.chunks.find((c) => c.names.includes(decl)); };
const every = (arr, pred) => arr.length > 0 && arr.every(pred);
const CLEARS = [
  {
    id: "C1-unused-unfenced-default", file: "lib/server/sync/publisher-composition.js", decl: "buildSchedulerV2Publisher", sink: "publishLiveSnapshotIfNewer",
    why: "the destructured override default `publishLive = publishLiveSnapshotIfNewer` is never invoked: the composed deps bind publishLive to fencedPublishLive (the ALWAYS-FENCED path)",
    evidence: ({ chunk }) => {
      const uses = [...chunk.m.matchAll(/(?<![\w$.])publishLive(?![\w$])/g)].map((u) => chunk.m.slice(u.index, u.index + 60).replace(/\s+/g, " "));
      return uses.length === 2 && uses.some((u) => /^publishLive = publishLiveSnapshotIfNewer,/.test(u)) && uses.some((u) => /^publishLive: fencedPublishLive,/.test(u))
        && /return publishLiveFenced\(\{ \.\.\.args, ownerToken: fence\.ownerToken, generation: fence\.generation \}, opts\);/.test(chunk.b);
    },
  },
  {
    id: "C2-shadow-saver", file: "lib/server/sync/report-snapshot-store.js", decl: "makeShadowSnapshotSaver", sink: "saveReportSnapshot",
    why: "the saver forwards its caller's reportKey unchanged, and its ONLY consumers pass shadow keys: report-worker.js (reportKey: shadowSnapshotKey(reportKey)) via runtime-composition -> sync-dispatch, and source-bucket-sync-runtime.js (reportKey: snap.reportKey, every snapshot built with shadowSnapshotKey(...))",
    evidence: ({ mods }) => {
      const saver = chunkOf(mods, "lib/server/sync/report-snapshot-store.js", "makeShadowSnapshotSaver");
      const forwards = saver && /return async \(\{ reportKey, accountId, params, payload, payloadBytes, sourceRefreshedAt \}/.test(saver.b) && /await save\(\{ reportKey, accountId, paramsHash, params, payload, payloadBytes: actualBytes, sourceRefreshedAt \}, \{ signal \}\);/.test(saver.b);
      const consumers = [...mods.values()].filter((md) => md.file !== abs("lib/server/sync/report-snapshot-store.js") && /(?<![\w$.])makeShadowSnapshotSaver(?![\w$])/.test(md.m)).map((md) => rel(md.file)).sort();
      const rw = mods.get(abs("lib/server/sync/report-worker.js"));
      const rwCalls = [...rw.m.matchAll(/(?<![\w$.])saveSnapshot\s*\(/g)].map((c) => rw.b.slice(c.index, c.index + 120).replace(/\s+/g, " "));
      const sd = mods.get(abs("lib/server/sync/sync-dispatch.js"));
      const rc = mods.get(abs("lib/server/sync/runtime-composition.js"));
      const bucket = mods.get(abs("lib/server/sync/source-bucket-sync-runtime.js"));
      const saverCalls = [...bucket.m.matchAll(/(?<![\w$.])saver\s*\(/g)].map((c) => bucket.b.slice(c.index, c.index + 80).replace(/\s+/g, " "));
      return !!forwards && JSON.stringify(consumers) === JSON.stringify(["lib/server/sync/runtime-composition.js", "lib/server/sync/source-bucket-sync-runtime.js"])
        && every(rwCalls, (c) => /^saveSnapshot\(\{ reportKey: shadowSnapshotKey\(reportKey\),/.test(c)) && rwCalls.length === 1
        && !/(?<![\w$.])saveSnapshot\s*\(/.test(sd.m) && /const saveSnapshot = snapshotSaverFactory\(\);/.test(rc.b) && !/(?<![\w$.])saveSnapshot\s*\(/.test(rc.m)
        && /const saver = makeShadowSaver\(\);/.test(bucket.b) && every(saverCalls, (c) => /^saver\(\{ reportKey: snap\.reportKey,/.test(c)) && snapshotKeysAreShadow(mods);
    },
  },
  {
    id: "C3-bucket-shadow-cas", file: "lib/server/sync/source-bucket-sync-runtime.js", decl: "buildBucketSourceSyncRuntime", sink: "saveShadowSnapshotIfNewer",
    why: "the bucket runtime's only saveShadowIfNewer call writes reportKey: shadowKey = snap.reportKey, and every derived snapshot is built with reportKey: shadowSnapshotKey(...)",
    evidence: ({ chunk, mods }) => {
      const calls = [...chunk.m.matchAll(/(?<![\w$.])saveShadowIfNewer\s*\(/g)].map((c) => chunk.b.slice(c.index, c.index + 60).replace(/\s+/g, " "));
      return every(calls, (c) => /^saveShadowIfNewer\(\{ reportKey: shadowKey,/.test(c)) && (chunk.b.match(/const shadowKey = snap\.reportKey;/g) || []).length === 1
        && !/(?<![\w$.])shadowKey\s*=(?!=)(?! snap\.reportKey;)/.test(chunk.b.replace(/const shadowKey = snap\.reportKey;/, "")) && snapshotKeysAreShadow(mods);
    },
  },
];
// Every derived snapshot object ({ reportKey, productionReportKey, ... }) the scheduler-v2 bucket runtime saves is keyed
// by shadowSnapshotKey(...): durable-dashboards.js + source-bucket-sync-runtime.js.
function snapshotKeysAreShadow(mods) {
  const keys = ["lib/server/sync/durable-dashboards.js", "lib/server/sync/source-bucket-sync-runtime.js"].flatMap((f) =>
    [...mods.get(abs(f)).b.matchAll(/\{\s*reportKey:\s*([^,]+),\s*productionReportKey:/g)].map((m) => m[1].trim()));
  return keys.length >= 3 && keys.every((k) => /^shadowSnapshotKey\(/.test(k));
}

// ---- THE INVENTORY ------------------------------------------------------------------------------------------------------
// class: fenced-publisher-path  every fenced-key write goes through publishLiveSnapshotFencedIfNewer (the Gate-7 publisher
//                               / fenced CAS); any other sink reached writes only scheduler-v2/* or unfenced keys.
//        shadow-only            writes only scheduler-v2/* shadow keys (never fenced; the table forbids them).
//        unfenced-keys-only     writes only keys outside the fenced set.
//        blocked-by-fence       can write a fenced key WITHOUT the fenced CAS: once that key is fenced its write fails
//                               closed (RWF01 REPORT_WRITER_FENCED, live row unchanged). Retire it (WP10b / WP13) BEFORE
//                               flipping the key -- until then it is exactly the old writer the fence stops, and the
//                               per-key readiness gate (REPORT_WRITER_FENCE_READY_KEY) reports the key NOT ready.
//        offline-test           a test harness / self-test with a fake transport or PGlite; never a real database.
//        read-only              TRIPWIRE-only: names report_snapshot* (or does a computed REST / client / RPC / SQL call)
//                               but the fine-grained analysis finds no write; listed so a new mention is re-reviewed.
// keys: the FENCED keys the file can write (through the fence for fenced-publisher-path; outside it for blocked-by-fence).
// trip: the file's exact TRIPWIRE hit signature (null when it has none); any change FAILS until re-reviewed here.
const FPP = "fenced-publisher-path", BLOCKED = "blocked-by-fence", SHADOW = "shadow-only", UNFENCED = "unfenced-keys-only", TEST = "offline-test", READ = "read-only";
const ALL = [...SEEDED];
const PRIORITY = ["brand-inventory", "brand-sales", "daily-reporting"];
const ROUTE_KEYS = ["brand-view", "brand-view-brands", "brand-view-portfolio", "fba-plan", "returns-leakage", "sku-movement"];
const E = (cls, keys, fns, sinks, note, trip = null) => ({ class: cls, keys: [...keys].sort(), fns, sinks, note, trip });
const R = (trip, note) => ({ class: READ, keys: [], fns: null, sinks: null, note, trip });
const SHADOW_DI_NOTE = " The saveShadow DI forwarder (sb.saveShadowSnapshotIfNewer) stays LISTED under the strict DI rule: the release modules pass the function VALUE into their typeof DI-validation loop ([\"saveShadow\", saveShadow]); every saveShadow CALL writes reportKey SHADOW_KEY = shadowKeyFor(<key>) (scheduler-v2/*).";
const INVENTORY = {
  // ---- the FENCED publisher path (Gate-7 four-gate publisher -> publishLiveSnapshotFencedIfNewer -> fenced CAS) ----------
  "lib/server/sync/publisher-composition.js": E(FPP, ALL, ["buildSchedulerV2Publisher"], ["publishLiveSnapshotFencedIfNewer"],
    "THE trusted Gate-7 publisher composition: every live write is fencedPublishLive -> publishLiveSnapshotFencedIfNewer (lease-lost with no valid fence); the unused unfenced override default is cleared by C1 (machine-checked)."),
  "lib/server/sync/source-priority-dashboards.js": E(FPP, PRIORITY, ["buildPriorityDashboardsRelease"], ["publishLiveSnapshotFencedIfNewer"],
    "priority dashboards release (daily-reporting + brand-sales + brand-inventory): publishes only through buildSchedulerV2Publisher; its shadow saves are proven scheduler-v2/* (C2/C3 + call-site proofs)."),
  "lib/server/sync/fba-plan-release-composition.js": E(FPP, ["fba-plan"], ["buildFbaPlanRelease"], ["publishLiveSnapshotFencedIfNewer"],
    "FBA Plan release (paid go-live / recovery operators): live fba-plan only through the Gate-7 publisher (fenced CAS). Its computed import (tripwire) is the injectable ownershipModulePath, default scripts/backfill-fba-ownership.mjs -- itself scanned and not a writer.", "dynimport:1"),
  "api/admin/sources.js": E(FPP, [...PRIORITY, "fba-plan"], ["default", "handler"], ["publishLiveSnapshotFencedIfNewer"],
    "admin Data Sync Center (the explicit, owner-approved PAID sync action; WP10b: preview -> token estimate -> signed confirmationToken, fail closed without it): publishes only via the shared priority release slice (brand-sales / daily-reporting / brand-inventory) and the fba-plan release (fba-plan) -> fenced publisher."),
  "scripts/release/priority-dashboards-release.mjs": E(FPP, PRIORITY, ["<module>"], ["publishLiveSnapshotFencedIfNewer"], "scheduler-v2 priority publication CLI (fenced publisher; --owner-generation renew-only)."),
  "scripts/release/bootstrap-publish.mjs": E(FPP, PRIORITY, ["<module>"], ["publishLiveSnapshotFencedIfNewer"], "onboarding bootstrap publication CLI (priority release -> fenced publisher)."),
  "scripts/release/manual-source-sync.mjs": E(FPP, PRIORITY, ["<module>"], ["publishLiveSnapshotFencedIfNewer"], "manual source sync operator (priority release -> fenced publisher)."),
  "scripts/release/fba-plan-golive.mjs": E(FPP, ["fba-plan"], ["<module>"], ["publishLiveSnapshotFencedIfNewer"], "paid FBA Plan go-live (scheduler-v2 fba job): buildFbaPlanRelease -> fenced publisher."),
  "scripts/release/fba-inventory-recovery.mjs": E(FPP, ["fba-plan"], ["<module>"], ["publishLiveSnapshotFencedIfNewer"], "FBA inventory recovery operator: buildFbaPlanRelease -> fenced publisher."),
  "scripts/release/fba-durable-source-replay.mjs": E(FPP, ["fba-plan"], ["<module>"], ["publishLiveSnapshotFencedIfNewer"], "FBA durable-source replay operator: buildFbaPlanRelease -> fenced publisher."),
  "scripts/release/oli-publication-reconcile.mjs": E(FPP, ["brand-inventory", "brand-sales", "daily-reporting"], ["<module>", "runReleaseForAccount"], ["publishLiveSnapshotFencedIfNewer"],
    "zero-export OLI reconciler (+ outbox drain): fenced publisher; its shadow saves are proven scheduler-v2/* (call-site proofs + the C2/C3 machine-checked clears)."),
  "scripts/release/ads-publication-reconcile.mjs": E(FPP, ["daily-reporting"], ["<module>", "bucketAccounts", "buildOperation", "runReleaseForAccount"], ["publishLiveSnapshotFencedIfNewer", "saveShadowSnapshotIfNewer"],
    "zero-export Campaign Ads reconciler (daily-reporting only): live rows only through the fenced publisher." + SHADOW_DI_NOTE),
  "scripts/release/fba-publication-reconcile.mjs": E(FPP, ["brand-inventory"], ["<module>", "bucketAccounts", "runReleaseForAccount"], ["publishLiveSnapshotFencedIfNewer", "saveShadowSnapshotIfNewer"],
    "zero-export FBA brand-inventory reconciler: live rows only through the fenced publisher." + SHADOW_DI_NOTE),
  "scripts/release/listing-health-v3-reconcile.mjs": E(FPP, ["listing-health-v3"], ["<module>", "bucketAccounts", "runReleaseForAccount"], ["publishLiveSnapshotFencedIfNewer", "saveShadowSnapshotIfNewer"],
    "zero-export Listing Health v3 reconciler: live rows only through the fenced publisher." + SHADOW_DI_NOTE),
  "scripts/release/publication-route-reconcile.mjs": E(FPP, ROUTE_KEYS,
    ["<module>", "publisherFor", "runRoute"],
    ["casUpdateReportSnapshotByRev", "deleteReportSnapshotByKey", "deleteReportSnapshotsOlderThan", "insertReportSnapshotIfAbsent", "pruneScheduledReportSnapshots", "publishLiveSnapshotFencedIfNewer", "publishLiveSnapshotIfNewer", "saveReportSnapshot", "saveShadowSnapshotIfNewer"],
    "the recovery ROUTE CLI (WP4): live rows ONLY via publisherFor -> buildSchedulerV2Publisher (fenced CAS). The extra sinks are the CONSERVATIVE whole-namespace rule: it hands the supabase.js namespace to the route release modules, which reach no sink by name (none of lib/server/sync/routes/*, lib/server/recovery/routes/*, route-publication-release.js is a writer in this map) -- only saveShadow (proven scheduler-v2/<publisherKey>) and deleteRouteShadowSnapshots (shadow-only by construction). Its two computed imports (tripwire) load exactly those route modules (cliPath / workerPath from the route registry), none of which is a writer.", "dynimport:2"),

  // ---- UNFENCED KEYS ONLY (WP10b: refresh=1 read-only + scheduler-v1 refuses route-owned keys) + BLOCKED BY THE FENCE
  // (writes a fenced key WITHOUT the fenced CAS: retire before flipping that key) ------------------------------------------
  "lib/server/sync/account-onboarding-discovery.js": E(UNFENCED, [], ["buildProductionOnboardingDeps"], ["saveReportSnapshot"],
    "automatic Primary onboarding discovery: its saveDirectorySnapshot DI forwarder (sb.saveReportSnapshot) has ONE call site, reportKey ACCOUNT_DIRECTORY_REPORT_KEY (account-directory, unfenced). Listed because the strict DI rule keeps it tainted: runAccountOnboardingDiscovery validates deps by NAME (\"saveDirectorySnapshot\" string -> typeof d[required])."),
  "scripts/release/account-onboarding-discovery.mjs": E(UNFENCED, [], ["<module>"], ["saveReportSnapshot"],
    "onboarding discovery CLI (account-onboarding.yml): binds buildProductionOnboardingDeps -- account-directory only (see that entry)."),
  "api/datadoe.js": E(UNFENCED, [], ["default", "handleDataDoe", "legacySharedDescriptor"], ["saveReportSnapshot"],
    "dashboard serve (WP10b): refresh=1 of EVERY route-owned key is READ-ONLY by default code (serveSharedReport refresh:false, never beginSharedRefresh; the brand-sales/daily/brand-inventory/fba-plan paid builders are RETIRED behind a typed refusal; brand-sales-live.js refresher removed), and report-store.js refuses route-owned writes structurally (see its entry; proven behaviourally by scripts/refresh-readonly.test.js). The remaining unproven reach is report-store beginSharedRefresh / serveSharedReport for the MANUAL-PAID insight + legacy keys (sales, reconciliation, sku-pl, keyword-rank, content-changes, account-directory, brand-directory, brand-portfolio, sales-movers, listing-health, buy-box-loss, ppc-performance, listing-optimizer) -- all unfenced; account-directory / brand-catalog* direct writes are proven unfenced literal keys."),
  "lib/server/report-store.js": E(UNFENCED, [],
    ["DEFAULT_STORE", "beginSharedRefresh", "persistDerivedSnapshot", "selfHealFromDurable", "serveSharedReport"], ["saveReportSnapshot"],
    "generic shared-snapshot store used by api/datadoe.js. WP10b: every write path REFUSES a route-owned key before any lock/build/save -- beginSharedRefresh + finish + persistDerivedSnapshot throw typed ROUTE_OWNED_REPORT_READ_ONLY, serveSharedReport coerces refresh->false (and asserts before its lock), selfHealFromDurable forces readOnly -- so it can write only unfenced keys (proven behaviourally for all 10 keys by scripts/refresh-readonly.test.js)."),
  // WP13 RETIRED (no longer writers -- the scan proves it, see E9; entries REMOVED, never re-add them as writers):
  //   lib/server/sync/report-materialization-composition.js + scripts/release/report-materialization.mjs (the legacy
  //     'materialize' writer of brand-view-brands / sku-movement / returns-leakage v3): the composition binds NO writer /
  //     lock / publish; the CLI is read-only dry-run tooling and refuses --mode=live (exit 2) before any env load/import.
  //   lib/server/sync/report-materialization-brandview-composition.js + scripts/release/report-materialization-brandview.mjs
  //     (the legacy 'materialize-inventory' writer of brand-view / brand-view-portfolio + the UNFENCED brand-inventory
  //     REBUILD): same -- no writer bound; the rebuild is removed from the CLI; --mode=live / --inventory-as-of exit 2.
  //   scripts/release/backfill-brand-sales.mjs, backfill-daily-v2.mjs, backfill-daily-named-brands.mjs: exit-2 stubs that
  //     import nothing (no I/O) and name the fenced zero-export reconciler CLIs.
  //   The scheduler-v2 materialize / materialize-inventory jobs call the fenced route CLI (scripts/scheduler-v2-route-switch.test.js).
  // Scheduler v1 (run-sync.js + report-adapter.js) keeps its sinks for the MANUAL-PAID (non-route-owned) v1 keys, but the
  // LIBRARY itself now refuses every route-owned key at runtime (WP13) -> unfenced-keys-only (evidence in the notes).
  "lib/server/sync/run-sync.js": E(UNFENCED, [], ["runRetention", "runScheduledSync"], ["deleteReportSnapshotsOlderThan", "pruneScheduledReportSnapshots", "saveReportSnapshot"],
    "scheduler-v1 orchestrator. WP13: the LIBRARY refuses every route-owned key (== the fence seed) on its own: an explicit reportKeys list naming one throws typed ROUTE_OWNED_REPORT_V1_REFUSED before any Supabase read / lock / audit / DataDoe call; schedule-enabled route-owned keys are EXCLUDED from the work list (typed skipped 'route-owned-refused'); runRetention skips route-owned keys; every save / prune goes through runReportAdapter, which refuses them before its build. So it can write only unfenced keys (proven behaviourally for all 10 keys by scripts/scheduler-v2-route-switch.test.js + scripts/test-sync.mjs)."),
  "lib/server/sync/adapters/report-adapter.js": E(UNFENCED, [], ["runReportAdapter"], ["pruneScheduledReportSnapshots", "saveReportSnapshot"],
    "scheduler-v1 report adapter (save / prune under generic DI names). WP13: runReportAdapter's FIRST statement refuses every route-owned key (isRouteOwnedLiveReportKey == the fence seed) with typed ROUTE_OWNED_REPORT_V1_REFUSED -- before the account resolution, the paid build, the save, the syncManaged prune and the publish -- so it writes only unfenced keys (proven behaviourally for all 10 keys by scripts/scheduler-v2-route-switch.test.js + scripts/test-sync.mjs)."),
  "api/sync.js": E(UNFENCED, [], ["DEFAULT_DEPS", "default", "handler", "schedulerV1BucketPlan"], ["deleteReportSnapshotsOlderThan", "pruneScheduledReportSnapshots", "saveReportSnapshot"],
    "admin 'sync now' -> scheduler-v1 runScheduledSync. WP10b: always called with an EXPLICIT allow-list = the schedule-enabled keys MINUS every route-owned key (run-sync saves/prunes/retains only the selected entries); only route-owned keys selected -> typed 409 ROUTE_OWNED_REPORT_V1_REFUSED before audit/lock/DataDoe (scripts/refresh-readonly.test.js)."),
  "api/admin/sync.js": E(UNFENCED, [], ["DEFAULT_DEPS", "default", "handler", "statusPayloadWith"], ["deleteReportSnapshotsOlderThan", "pruneScheduledReportSnapshots", "saveReportSnapshot"],
    "admin manual report sync -> scheduler-v1 runScheduledSync({ reportKeys: [key] }). WP10b: a POST for a route-owned key is refused typed 409 ROUTE_OWNED_REPORT_V1_REFUSED before the rate limiter / audit / dispatch, so it dispatches only non-route-owned (manual-paid) keys (scripts/refresh-readonly.test.js)."),
  "api/cron/sync.js": E(UNFENCED, [], ["DEFAULT_DEPS", "default", "handler"], ["deleteReportSnapshotsOlderThan", "pruneScheduledReportSnapshots", "saveReportSnapshot"],
    "CRON_SECRET scheduled-sync endpoint -> scheduler-v1 (no Vercel cron is configured). WP10b: explicit allow-list = schedule-enabled keys MINUS every route-owned key; only route-owned keys selected -> typed 409 before any lock/DataDoe (scripts/refresh-readonly.test.js)."),

  // ---- offline tests (fake transport / PGlite; never a real database) --------------------------------------------------------
  "scripts/test-brand-view.mjs": E(TEST, [], ["<module>"], ["rest:report_snapshots", "saveReportSnapshot"], "offline Brand View harness: supabase.js against a stubbed fetch (its fake transport matches /rest/v1/report_snapshots URLs + POST).", "t1:7,rest:1"),
  "scripts/test-source-cache.mjs": E(TEST, [], ["<module>"], ["casUpdateReportSnapshotByRev", "insertReportSnapshotIfAbsent"], "offline source-cache / brand-catalog manifest harness with fake stores (its computed imports re-load supabase.js with a cache-busting query).", "dynimport:2"),
  "scripts/test-sync.mjs": E(TEST, [], ["<module>"], ["pruneScheduledReportSnapshots", "saveReportSnapshot"], "offline scheduler-v1 adapter harness with injected fakes."),
  "scripts/worker/publication-recovery-sql-selftest.mjs": E(TEST, [], ["<module>"], ["sql:report_snapshots"],
    "offline PGlite self-test of the worker SQL (20260934 + the WP12 fence read): seeds a minimal report_snapshots in in-process WASM Postgres; its computed import is the PGlite entry. Never a real database.", "t1:2,dynimport:1"),
  "scripts/worker/report-writer-fence-selftest.mjs": E(TEST, [], ["<module>", "fencedCas", "legacyInsertIgnore", "legacyPatch", "legacyUpsert", "unfencedCas"], ["rpc:report_snapshots", "sql:report_snapshots"],
    "THIS package's PGlite self-test: in-process WASM Postgres only (it also runs the README section 9 operator SQL; its computed import is the PGlite entry).", "t1:73,dynimport:1"),

  // ---- READ-ONLY (tripwire only: they name report_snapshots, the fine-grained analysis finds no write) -----------------------
  "lib/server/recovery/registry.js": R("t1:2", "recovery registry: two reason STRINGS that mention report_snapshots (no I/O)."),
  "lib/server/recovery/store-pg.js": R("t1:4", "recovery worker store: read-only status SELECTs (latest source_refreshed_at / updated_at per account and key)."),
  "lib/server/recovery/routes/brand-view-brands.route.js": R("t1:2", "brand-view-brands route evidence SQL: ranked SELECTs of the live source rows (read-only worker pool)."),
  "lib/server/recovery/routes/brand-view-portfolio.route.js": R("t1:5", "brand-view-portfolio route evidence SQL: SELECTs of account-directory / member rows / brand-inventory (read-only)."),
  "lib/server/recovery/routes/brand-view.route.js": R("t1:3", "brand-view route evidence SQL: ranked SELECTs of the source rows (read-only)."),
  "lib/server/recovery/routes/sku-movement.route.js": R("t1:1", "sku-movement route evidence SQL: a SELECT of the live row (read-only)."),
  "lib/server/sync/routes/sku-movement.release.js": R("t1:1", "sku-movement release: a SELECT of the live/served row for its read-back (writes go through the fenced publisher it is handed)."),
  "lib/server/sync/schema-contract.js": R("t1:9", "static schema-contract checker: regexes / RPC signature strings over migration TEXT (no database I/O)."),
  "lib/server/sync/source-archive-collision-cycles.js": R("t1:1", "archival contract: report_snapshots is in PROTECTED_TABLES, whose digests must stay byte-identical (proves it is NOT written)."),
  "scripts/release/archive-collision-cycles.mjs": R("t1:2", "archival operator: read-only md5 digest of report_snapshots identity columns (PROTECTED_TABLES proof)."),
  "scripts/release/digest-diagnostic.mjs": R("t1:2", "read-only digest diagnostic (md5 / count SELECTs)."),
  "scripts/release/fba-golive-dryrun.mjs": R("t1:1", "FBA go-live DRY RUN: SELECTs the account-directory snapshot."),
  "scripts/release/oli-sales-estimate-backfill.mjs": R("t1:1", "OLI estimate backfill: SELECTs the account-directory snapshot (its writes are OLI source tables, not report_snapshots)."),
  "scripts/release/rebuild-brand-membership.mjs": R("t1:2", "brand membership rebuild: SELECTs brand-sales rows inside a REPEATABLE READ READ ONLY transaction."),
  "scripts/release/reconciliation-runner.mjs": R("t1:10,dynimport:1", "read-only reconciliation runner: counts / digests / id lookups on report_snapshots; its computed import helper loads report-derivation.js, report-store.js (paramsHashFor), report-publisher.js (contracts) and supabase.js (getReportSnapshotStoragePayload, a reader)."),
  "scripts/release/release-manifest.mjs": R("t1:1", "release manifest: the cas_report_snapshot_if_newer SIGNATURE string it verifies in the catalog (no call)."),
  "scripts/release/release-state.mjs": R("t1:2", "release state capture: read-only digests of live + shadow snapshots."),
  "scripts/release/verify-us-d1-published.mjs": R("t1:1", "D-1 publication verifier: a SELECT inside a REPEATABLE READ READ ONLY transaction."),
};

// PER-KEY READINESS: every inventory entry that can still write `key` OUTSIDE the fenced CAS -- any class but
// fenced-publisher-path that lists the key. While one exists, flipping the key makes that writer fail closed (the fence
// working), so cutover step 2 requires ZERO for the key: REPORT_WRITER_FENCE_READY_KEY=<key>.
const blockingEntriesFor = (key) => Object.entries(INVENTORY).filter(([, e]) => e.class !== FPP && e.keys.includes(key)).map(([f, e]) => f + " (" + e.class + ")").sort();

const analysis = makeWriterAnalyzer({ fencedKeys: W.FENCED_WRITER_REPORT_KEYS, clears: CLEARS });
if (process.env.REPORT_WRITER_FENCE_DUMP === "1") {
  for (const [f, w] of [...analysis.writers].sort()) {
    out(JSON.stringify(f) + ": { fns: " + JSON.stringify(w.fns) + ", sinks: " + JSON.stringify(w.sinks) + " },");
    if (process.env.REPORT_WRITER_FENCE_DUMP_WHY === "1") for (const y of w.why) out("    // " + y);
  }
  out("clears: " + JSON.stringify(analysis.clearsApplied));
}
if (process.env.REPORT_WRITER_FENCE_DUMP === "inventory") {
  out("INVENTORY " + JSON.stringify(Object.entries(INVENTORY).flatMap(([file, e]) => (e.keys.length ? e.keys : ["-"]).map((key) => ({ file, key, class: e.class })))));
}
if (process.env.REPORT_WRITER_FENCE_DUMP === "trip") {
  for (const [f, sig] of [...analysis.tripwire].sort()) out(JSON.stringify(f) + ": " + JSON.stringify(sig) + (INVENTORY[f] ? "  [" + INVENTORY[f].class + (INVENTORY[f].trip === sig ? "" : " TRIP-DRIFT listed=" + JSON.stringify(INVENTORY[f].trip)) + "]" : "  [UNLISTED]"));
}
if (process.env.REPORT_WRITER_FENCE_DUMP === "readiness") {
  out("READINESS " + JSON.stringify(W.FENCED_WRITER_REPORT_KEYS.map((key) => { const b = blockingEntriesFor(key); return { key, ready: b.length === 0, blockingEntries: b }; })));
}

{
  ok("E1 the SQL writer functions the analyzer uses are exactly the classified set (C1)", JSON.stringify([...analysis.sqlWriters].sort()) === JSON.stringify(Object.keys(SQL_WRITER_CLASSES).sort()));
  const EXPECTED_SINKS = ["casUpdateReportSnapshotByRev", "deleteReportSnapshotByKey", "deleteReportSnapshotsOlderThan", "deleteRouteShadowSnapshots", "insertReportSnapshotIfAbsent",
    "pruneScheduledReportSnapshots", "publishLiveSnapshotFencedIfNewer", "publishLiveSnapshotIfNewer", "saveReportSnapshot", "saveShadowSnapshotIfNewer"];
  ok("E2 supabase.js sinks are AUTO-DISCOVERED (every function whose REST write targets report_snapshots or whose RPC is a SQL writer) and equal the reviewed set of 10",
    JSON.stringify([...analysis.baseSinks].sort()) === JSON.stringify(EXPECTED_SINKS));
  const dr = analysis.supaMod.chunks.find((c) => c.names.includes("deleteRouteShadowSnapshots"));
  ok("E2 deleteRouteShadowSnapshots is shadow-only BY CONSTRUCTION: its ONE DELETE filters report_key eq.scheduler-v2/<one of the 6 route publisher keys>",
    /report_key: `eq\.scheduler-v2\/\$\{key\}`/.test(dr.b) && /if \(!ROUTE_SHADOW_PRUNE_PUBLISHER_KEYS\.includes\(key\)\) throw/.test(dr.b) && (dr.b.match(/method: "DELETE"/g) || []).length === 1);
  const fencedSink = analysis.supaMod.chunks.find((c) => c.names.includes("publishLiveSnapshotFencedIfNewer"));
  ok("E2 publishLiveSnapshotFencedIfNewer is the ONLY supabase.js function reaching cas_report_snapshot_if_newer_fenced; the unfenced CAS RPC is reached only by saveShadowSnapshotIfNewer",
    analysis.supaMod.chunks.filter((c) => /\/rest\/v1\/rpc\/cas_report_snapshot_if_newer_fenced\b/.test(c.b)).length === 1 && /\/rest\/v1\/rpc\/cas_report_snapshot_if_newer_fenced\b/.test(fencedSink.b)
    && JSON.stringify(analysis.supaMod.chunks.filter((c) => /\/rest\/v1\/rpc\/cas_report_snapshot_if_newer"/.test(c.b)).map((c) => c.names[0])) === JSON.stringify(["saveShadowSnapshotIfNewer"]));
  ok("E2 the only DYNAMIC REST paths in supabase.js are the Listings snapshot family helpers (their rpc/table names never reach report_snapshots)",
    JSON.stringify(analysis.dynamicRest.sort()) === JSON.stringify(["getListingsSnapshotFamily", "getListingsSnapshotsByAsOfFamily", "recordListingsSnapshotFamily"])
    && [...src("lib/server/supabase.js").matchAll(/\b(?:rpc|table):\s*"([a-z_]+)"/g)].every((m) => !/report_snapshots/.test(m[1]) && !Object.keys(SQL_WRITER_CLASSES).includes(m[1])));
  ok("E3 every manual clear's machine-checked evidence HOLDS and it removed a sink that was really reached (" + CLEARS.map((c) => c.id).join(", ") + ")",
    CLEARS.every((c) => analysis.clearsApplied.some((a) => a.id === c.id && a.evidence === true && a.hadSink === true)));

  const computed = analysis.writers;
  const writerEntries = Object.keys(INVENTORY).filter((f) => INVENTORY[f].class !== READ);
  const unlisted = [...computed.keys()].filter((f) => !INVENTORY[f] || INVENTORY[f].class === READ).sort();
  const stale = writerEntries.filter((f) => !computed.has(f)).sort();
  const drift = writerEntries.filter((f) => computed.has(f)).filter((f) => JSON.stringify(computed.get(f).fns) !== JSON.stringify(INVENTORY[f].fns) || JSON.stringify(computed.get(f).sinks) !== JSON.stringify(INVENTORY[f].sinks));
  const show = (f) => f + " -> fns " + JSON.stringify((computed.get(f) || {}).fns) + " sinks " + JSON.stringify((computed.get(f) || {}).sinks);
  ok("E4 FAIL-CLOSED: every writer file the analysis finds is in the inventory as a WRITER (a read-only entry that writes fails too)" + (unlisted.length ? " -- UNLISTED WRITERS: " + unlisted.map(show).join(" | ") : ""), unlisted.length === 0);
  ok("E5 ... every writer entry is still a writer (no stale entry)" + (stale.length ? " -- STALE: " + stale.join(", ") : ""), stale.length === 0);
  ok("E6 ... and each entry's tainted declarations + reached sinks are EXACT (a new writing function or a new sink kind fails)" + (drift.length ? " -- DRIFT: " + drift.map(show).join(" | ") : ""), drift.length === 0);
  // THE COARSE TRIPWIRE: every file with a hit signature is listed with EXACTLY that signature; no entry claims a stale one.
  const tw = analysis.tripwire;
  const tripUnlisted = [...tw.keys()].filter((f) => !INVENTORY[f]).sort();
  const tripDrift = [...tw.keys()].filter((f) => INVENTORY[f] && INVENTORY[f].trip !== tw.get(f)).sort();
  const tripStale = Object.keys(INVENTORY).filter((f) => INVENTORY[f].trip != null && !tw.has(f)).sort();
  const tshow = (f) => f + " -> " + JSON.stringify(tw.get(f) || null) + " (listed " + JSON.stringify(INVENTORY[f] ? INVENTORY[f].trip : undefined) + ")";
  ok("E10 TRIPWIRE FAIL-CLOSED: every file naming report_snapshot* (fragments joined, case-folded, %5F-decoded) or doing a computed-path non-GET REST / computed-table client write / computed RPC / computed-target SQL DML is LISTED" + (tripUnlisted.length ? " -- UNLISTED: " + tripUnlisted.map(tshow).join(" | ") : ""), tripUnlisted.length === 0);
  ok("E11 ... with its EXACT hit signature (a new mention in a listed file is re-reviewed), and no entry keeps a stale signature" + (tripDrift.length || tripStale.length ? " -- DRIFT: " + [...tripDrift, ...tripStale].map(tshow).join(" | ") : ""), tripDrift.length === 0 && tripStale.length === 0);
  const CLASSES = new Set([FPP, BLOCKED, SHADOW, UNFENCED, TEST, READ]);
  const bad = Object.entries(INVENTORY).filter(([f, e]) => {
    if (!CLASSES.has(e.class) || typeof e.note !== "string" || e.note.length < 20 || !Array.isArray(e.keys) || !e.keys.every((k) => W.FENCED_WRITER_REPORT_KEYS.includes(k))) return true;
    if (e.trip != null && !/^[a-z0-9]+:[1-9]\d*(,[a-z0-9]+:[1-9]\d*)*$/.test(e.trip)) return true;
    if (/WP10a/.test(e.note)) return true; // read-only refresh=1 is WP10b (WP10a was the serve-contract package)
    if (e.class === READ) return e.keys.length !== 0 || e.fns !== null || e.sinks !== null || !e.trip;
    const sinks = e.sinks; const fencedOnly = sinks.every((s) => s === "publishLiveSnapshotFencedIfNewer");
    const literalFenced = sinks.filter((s) => s.includes("@")).map((s) => s.split("@")[1]);
    if (!literalFenced.every((k) => e.keys.includes(k))) return true;
    if (e.class === FPP) return !sinks.includes("publishLiveSnapshotFencedIfNewer") || e.keys.length === 0;
    if (e.class === BLOCKED) return e.keys.length === 0 || fencedOnly;
    if (e.class === SHADOW || e.class === UNFENCED) return e.keys.length !== 0 || sinks.includes("publishLiveSnapshotFencedIfNewer");
    if (e.class === TEST) return !/^scripts\/(test-[^/]+\.mjs|worker\/[^/]*selftest[^/]*\.mjs)$/.test(f);
    return false;
  }).map(([f]) => f);
  ok("E7 every entry is classified coherently (class vs sinks vs keys vs trip; a literal fenced key a file writes is always declared; read-only = tripwire-only, no keys)" + (bad.length ? " -- BAD: " + bad.join(", ") : ""), bad.length === 0);
  const fencedOnlyFiles = [...computed].filter(([, w]) => w.sinks.every((s) => s === "publishLiveSnapshotFencedIfNewer")).map(([f]) => f);
  ok("E8 a file whose ONLY sink is the fenced CAS is classified fenced-publisher-path", fencedOnlyFiles.every((f) => INVENTORY[f] && INVENTORY[f].class === FPP));
  // DI-only writer CORES (report-materialization-operation.js materializeOne, the brand-inventory rebuild in
  // report-materialization-brandview-operation.js) call an INJECTED persistSnapshot and import no sink: a real write exists
  // only where a composition root binds a sink, and EVERY composition root that binds a sink is in the inventory (E4).
  // WP13 RETIRED both composition roots + their entry scripts as writers (the scheduler materialize jobs call the fenced
  // route CLI instead), so E9 now proves the RETIREMENT -- stricter than the old 'listed blocked-by-fence' pin, never looser:
  // the cores stay DI-only; the roots + entry scripts still wire those cores (the analysis examined the real binding) but
  // reach NO sink (absent from the computed writer map) and are NOT inventoried as writers; each entry script refuses its
  // live mode (exit 2) BEFORE loadReleaseEnv() / any dynamic import; the three retired backfills import nothing at all.
  const DI_CORES = [
    ["lib/server/sync/report-materialization-operation.js", "lib/server/sync/report-materialization-composition.js", "scripts/release/report-materialization.mjs", 'if (requestedMode === "live") {'],
    ["lib/server/sync/report-materialization-brandview-operation.js", "lib/server/sync/report-materialization-brandview-composition.js", "scripts/release/report-materialization-brandview.mjs", 'if (requestedMode === "live" || argOf("inventory-as-of", null) != null) {'],
  ];
  const importsOf = (f, target) => new RegExp("import\\(\\s*[\"'][./]*" + esc(target.replace(/^lib\//, "lib/")) + "[\"']\\s*\\)|from\\s+[\"'][./]*" + esc(target) + "[\"']").test(src(f));
  const notAWriter = (f) => !computed.has(f) && !(INVENTORY[f] && INVENTORY[f].class !== READ);
  const refusesLiveFirst = (entry, guard) => {
    const s = src(entry); const g = s.indexOf(guard), exit2 = s.indexOf("process.exit(2);", g), env = s.indexOf("\nloadReleaseEnv();"), dyn = s.indexOf("await import(");
    return g > 0 && exit2 > g && env > exit2 && dyn > exit2;
  };
  const RETIRED_BACKFILLS = ["scripts/release/backfill-brand-sales.mjs", "scripts/release/backfill-daily-v2.mjs", "scripts/release/backfill-daily-named-brands.mjs", "scripts/release/backfill-sku-movement.mjs"];
  const inertStub = (f) => { const code = src(f).replace(/\/\/[^\n]*/g, ""); return notAWriter(f) && !/\bimport\b|\brequire\s*\(|loadReleaseEnv|process\.env/.test(code) && /process\.exit\(2\);\s*$/.test(code.trim()); };
  ok("E9 WP13 RETIREMENT: materializeOne (returns-leakage v3 + sku-movement + brand-view-brands) and the brand-inventory rebuild stay DI cores (injected persistSnapshot, no sink import); their composition roots + entry scripts still wire them but reach NO sink and are NOT inventoried as writers; each entry refuses --mode=live BEFORE loadReleaseEnv / any dynamic import; the retired backfills are import-free exit-2 stubs",
    DI_CORES.every(([core, root, entry, guard]) => existsSync(abs(core)) && !computed.has(core) && /persistSnapshot/.test(src(core)) && !/from\s+["'][./]*(lib\/server\/)?supabase\.js["']/.test(src(core))
      && notAWriter(root) && notAWriter(entry) && importsOf(entry, core.replace(/^lib\//, "lib/")) && importsOf(entry, root) && refusesLiveFirst(entry, guard))
    && RETIRED_BACKFILLS.every(inertStub));
}

// ---- canaries: the SAME analysis sees every kind of new writer (and clears a proven unfenced / shadow key) ---------------
{
  const C = (name) => abs("scripts/release/__writer_canary_" + name + "__.mjs");
  const canaries = new Map([
    [C("literal"), 'import { saveReportSnapshot } from "../../lib/server/supabase.js";\nawait saveReportSnapshot({ reportKey: "brand-sales", accountId: "A", paramsHash: "h", payload: {} });\n'],
    [C("alias"), 'import { saveReportSnapshot as persist } from "../../lib/server/supabase.js";\nexport async function run(k) { return persist({ reportKey: k, accountId: "A" }); }\n'],
    [C("namespace"), 'import * as sb from "../../lib/server/supabase.js";\nexport const go = (k) => sb.publishLiveSnapshotIfNewer({ reportKey: k });\n'],
    [C("dynamic"), 'const { casUpdateReportSnapshotByRev } = await import("../../lib/server/supabase.js");\nawait casUpdateReportSnapshotByRev({ reportKey: process.argv[2] });\n'],
    [C("inner-dynamic"), 'export async function later(k) { const sb = await import("../../lib/server/supabase.js"); return sb.deleteReportSnapshotByKey({ reportKey: k }); }\n'],
    [C("wrapper"), 'import { beginSharedRefresh } from "../../lib/server/report-store.js";\nexport const w = (o) => beginSharedRefresh(o);\n'],
    [C("sql"), 'import pg from "pg";\nexport async function f(c) { await c.query("update public.report_snapshots set payload = $1 where report_key = $2", [1, 2]); }\n'],
    [C("rest"), 'export async function f(u) { return fetch(u + "/rest/v1/report_snapshots?on_conflict=x", { method: "POST", body: "{}" }); }\n'],
    [C("rpc"), 'export async function f(u) { return fetch(u + "/rest/v1/rpc/cas_report_snapshot_if_newer", { method: "POST" }); }\n'],
    [C("rest-computed"), 'export async function f(u, m) { return fetch(u + "/rest/v1/report_snapshots?id=eq.1", { method: m }); }\n'],
    [C("client"), 'export async function f(client) { return client.from("report_snapshots").upsert({ report_key: "fba-plan" }); }\n'],
    [C("rest-get"), 'export async function f(u) { return fetch(u + "/rest/v1/report_snapshots?select=id", { method: "GET" }); }\n'],
    [C("param-shadow"), 'import { saveReportSnapshot } from "../../lib/server/supabase.js";\nconst KEY = "account-directory";\nexport const f = (KEY) => saveReportSnapshot({ reportKey: KEY, accountId: "A" });\n'],
    [C("dup-key"), 'import { saveReportSnapshot } from "../../lib/server/supabase.js";\nexport const f = (k) => saveReportSnapshot({ reportKey: "account-directory", accountId: "A", reportKey: k });\n'],
    [C("block-scope"), 'import { saveReportSnapshot } from "../../lib/server/supabase.js";\nexport function f(k) {\n  if (k) { const reportKey = "account-directory"; void reportKey; }\n  return saveReportSnapshot({ reportKey, accountId: "A" });\n}\n'],
    [C("local-const"), 'import { saveReportSnapshot } from "../../lib/server/supabase.js";\nexport async function f() {\n  const reportKey = "account-directory";\n  return saveReportSnapshot({ reportKey, accountId: "__account-directory__" });\n}\n'],
    [C("ns-value"), 'import * as sb from "../../lib/server/supabase.js";\nimport { buildX } from "./__nothing__.js";\nexport const x = (build) => build({ sb });\n'],
    [C("unfenced-literal"), 'import { saveReportSnapshot } from "../../lib/server/supabase.js";\nconst KEY = "account-directory";\nawait saveReportSnapshot({ reportKey: KEY, accountId: "__account-directory__", paramsHash: "h", payload: {} });\n'],
    [C("shadow"), 'import { saveShadowSnapshotIfNewer } from "../../lib/server/supabase.js";\nexport const s = (k) => saveShadowSnapshotIfNewer({ reportKey: "scheduler-v2/" + k, accountId: "A" });\n'],
    // -- the WP15 verifier's seven missed evasions (+ one variant): each must be caught by BOTH layers --------------------
    [C("v1-rest-concat"), 'export async function f(u) { return fetch(u + "/rest/v1/" + "report_snapshots", { method: "POST", body: "{}" }); }\n'],
    [C("v2-rest-template-const"), 'const T = "report_snapshots";\nexport async function f(u) { return fetch(`${u}/rest/v1/${T}`, { method: "POST", body: "{}" }); }\n'],
    [C("v3-rest-opts"), 'const OPTS = { method: "PATCH", body: "{}" };\nexport async function f(u) {\n  const url = u + "/rest/v1/report_snapshots?id=eq.1";\n  return fetch(url, OPTS);\n}\n'],
    [C("v3b-rest-opts-assign"), 'export async function f(u) {\n  const opts = {};\n  opts.method = "DELETE";\n  return fetch(u + "/rest/v1/report" + "_snapshots?id=eq.1", opts);\n}\n'],
    [C("v4-sql-concat"), 'export async function f(c) { await c.query("insert into public." + "report_snapshots (report_key, account_id, params_hash, payload) values ($1, $2, $3, $4)", ["brand-sales", "A", "h", "{}"]); }\n'],
    [C("v5-sql-quoted"), 'export async function f(c) { await c.query(\'INSERT INTO "public"."report_snapshots" (report_key) VALUES ($1)\', ["brand-sales"]); }\n'],
    [C("v6-client-const"), 'const TBL = "report_snapshots";\nexport async function f(client) { return client.from(TBL).upsert({ report_key: "fba-plan" }); }\n'],
    [C("v7-rpc-concat"), 'export async function f(u) { return fetch(u + "/rest/v1/rpc/" + "cas_report_snapshot_if_newer", { method: "POST", body: "{}" }); }\n'],
    // -- more normalisation (case, %5F, an IMPORTED fragment-built const) and TRIPWIRE-ONLY computed writes --------------
    [C("tables"), 'export const TBL = "report_" + "snapshots";\n'],
    [C("t-rest-import"), 'import { TBL } from "./__writer_canary_tables__.mjs";\nexport async function f(u) { return fetch(`${u}/rest/v1/${TBL}`, { method: "POST" }); }\n'],
    [C("t-case"), 'export async function f(c) { await c.query("UPDATE PUBLIC.REPORT_SNAPSHOTS SET payload = $1", [1]); }\n'],
    [C("t-pct"), 'export async function f(u) { return fetch(u + "/rest/v1/report%5Fsnapshots", { method: "POST", body: "{}" }); }\n'],
    [C("t-escape"), 'export async function f(c) { await c.query("update public.report\\x5fsnapshots set payload = $1", [1]); }\n'],
    [C("t-rest-computed"), 'export async function f(u, t) { return fetch(u + "/rest/v1/" + t, { method: "PATCH", body: "{}" }); }\n'],
    [C("t-client"), 'export async function f(client, t) { return client.from(t).insert({ report_key: "brand-sales" }); }\n'],
    [C("t-rpc"), 'export async function f(client, name) { return client.rpc(name, { p_report_key: "brand-sales" }); }\n'],
    [C("t-sql"), 'export async function f(c, t) { await c.query(`delete from ${t} where report_key = $1`, ["brand-sales"]); }\n'],
    [C("t-sql-schema"), 'export async function f(c, t) { await c.query("insert into public." + t + " (report_key) values ($1)", ["brand-sales"]); }\n'],
    [C("t-require"), 'const sb = require("../../lib/server/supabase.js");\nexport const f = (k) => sb.saveReportSnapshot({ reportKey: k, accountId: "A" });\n'],
    [C("t-dynimport"), 'export async function f(spec, k) { const m = await import(spec); return m.default({ reportKey: k, accountId: "A" }); }\n'],
    // -- shadow-proof counterexamples: a proof must span the WHOLE key expression ----------------------------------------
    [C("s-slice"), 'import { saveReportSnapshot } from "../../lib/server/supabase.js";\nexport const f = (k) => saveReportSnapshot({ reportKey: `scheduler-v2/${k}`.slice(13), accountId: "A" });\n'],
    [C("s-ternary"), 'import { saveReportSnapshot } from "../../lib/server/supabase.js";\nexport const f = (k) => saveReportSnapshot({ reportKey: "scheduler-v2/" + k ? "brand-sales" : k, accountId: "A" });\n'],
    [C("s-ternary-tpl"), 'import { saveReportSnapshot } from "../../lib/server/supabase.js";\nexport const f = (k) => saveReportSnapshot({ reportKey: `scheduler-v2/${k}` === "x" ? "brand-sales" : `scheduler-v2/${k}`, accountId: "A" });\n'],
    [C("s-fn-slice"), 'import { saveReportSnapshot } from "../../lib/server/supabase.js";\nimport { shadowSnapshotKey } from "../../lib/server/sync/report-derivation.js";\nexport const f = (k) => saveReportSnapshot({ reportKey: shadowSnapshotKey(k).slice(13), accountId: "A" });\n'],
    [C("s-multiline"), 'import { saveReportSnapshot } from "../../lib/server/supabase.js";\nexport function f(k) {\n  const key = `scheduler-v2/${k}`\n    .slice(13);\n  return saveReportSnapshot({ reportKey: key, accountId: "A" });\n}\n'],
    [C("s-local-fn"), 'import { saveReportSnapshot } from "../../lib/server/supabase.js";\nimport { shadowSnapshotKey } from "../../lib/server/sync/report-derivation.js";\nexport function f(k) {\n  const shadowSnapshotKey = (x) => x;\n  return saveReportSnapshot({ reportKey: shadowSnapshotKey(k), accountId: "A" });\n}\n'],
    [C("shadow-template"), 'import { saveReportSnapshot } from "../../lib/server/supabase.js";\nexport const f = (k) => saveReportSnapshot({ reportKey: `scheduler-v2/${k}`, accountId: "A" });\n'],
    [C("shadow-fn"), 'import { saveReportSnapshot } from "../../lib/server/supabase.js";\nimport { shadowSnapshotKey } from "../../lib/server/sync/report-derivation.js";\nexport const f = (k) => saveReportSnapshot({ reportKey: shadowSnapshotKey(k), accountId: "A" });\n'],
    [C("shadow-chain"), 'import { saveReportSnapshot } from "../../lib/server/supabase.js";\nexport const f = (a, b) => saveReportSnapshot({ reportKey: "scheduler-v2/" + a + "/" + b.trim(), accountId: "A" });\n'],
    // -- DI counterexamples (the verifier's attack block + typeof / computed access): any non-call reference taints ------
    [C("di-alias"), 'import * as sb from "../../lib/server/supabase.js";\nexport function mk() { return { saveShadowZq1: (a, o) => sb.saveShadowSnapshotIfNewer(a, o) }; }\nexport async function use(deps) {\n  await deps.saveShadowZq1({ reportKey: "scheduler-v2/x", accountId: "A" });\n  const s = deps.saveShadowZq1;\n  return s({ reportKey: "fba-plan", accountId: "A" });\n}\n'],
    [C("di-pass"), 'import * as sb from "../../lib/server/supabase.js";\nexport function mk() { return { saveShadowZq2: (a, o) => sb.saveShadowSnapshotIfNewer(a, o) }; }\nconst run = (f) => f({ reportKey: "brand-sales", accountId: "A" });\nexport async function use(deps) {\n  await deps.saveShadowZq2({ reportKey: "scheduler-v2/x", accountId: "A" });\n  return run(deps.saveShadowZq2);\n}\n'],
    [C("di-spreadargs"), 'import * as sb from "../../lib/server/supabase.js";\nexport function mk() { return { saveShadowZq3: (a, o) => sb.saveShadowSnapshotIfNewer(a, o) }; }\nexport async function use(deps, extra) {\n  return deps.saveShadowZq3({ reportKey: "scheduler-v2/x", ...extra });\n}\n'],
    [C("di-apply"), 'import * as sb from "../../lib/server/supabase.js";\nexport function mk() { return { saveShadowZq4: (a, o) => sb.saveShadowSnapshotIfNewer(a, o) }; }\nexport async function use(deps) {\n  await deps.saveShadowZq4({ reportKey: "scheduler-v2/x", accountId: "A" });\n  return deps.saveShadowZq4.call(null, { reportKey: "daily-reporting", accountId: "A" });\n}\n'],
    [C("di-typeof"), 'import * as sb from "../../lib/server/supabase.js";\nexport function mk() { return { saveShadowZq5: (a, o) => sb.saveShadowSnapshotIfNewer(a, o) }; }\nexport async function use(deps) {\n  if (typeof deps.saveShadowZq5 !== "function") throw new Error("x");\n  return deps.saveShadowZq5({ reportKey: "scheduler-v2/x", accountId: "A" });\n}\n'],
    [C("di-string"), 'import * as sb from "../../lib/server/supabase.js";\nexport function mk() { return { saveShadowZq6: (a, o) => sb.saveShadowSnapshotIfNewer(a, o) }; }\nexport async function use(deps) {\n  await deps.saveShadowZq6({ reportKey: "scheduler-v2/x", accountId: "A" });\n  return deps["saveShadowZq6"]({ reportKey: "brand-sales", accountId: "A" });\n}\n'],
    [C("di-exp-a"), 'import * as sb from "../../lib/server/supabase.js";\nexport const saveShadowZqE = (a, o) => sb.saveShadowSnapshotIfNewer(a, o);\nexport async function ok1() { return saveShadowZqE({ reportKey: "scheduler-v2/x", accountId: "A" }); }\n'],
    [C("di-exp-b"), 'import { saveShadowZqE as s } from "./__writer_canary_di-exp-a__.mjs";\nexport async function bad() { return s({ reportKey: "brand-sales", accountId: "A" }); }\n'],
    // -- object-key counterexamples: a later quoted / computed / accessor reportKey overrides a proven one ----------------
    [C("k-quoted"), 'import { saveShadowSnapshotIfNewer } from "../../lib/server/supabase.js";\nexport const f = () => saveShadowSnapshotIfNewer({ reportKey: "scheduler-v2/x", "reportKey": "brand-sales", accountId: "A" });\n'],
    [C("k-computed"), 'import { saveShadowSnapshotIfNewer } from "../../lib/server/supabase.js";\nexport const f = () => saveShadowSnapshotIfNewer({ reportKey: "scheduler-v2/x", ["report" + "Key"]: "brand-sales", accountId: "A" });\n'],
    [C("k-accessor"), 'import { saveShadowSnapshotIfNewer } from "../../lib/server/supabase.js";\nexport const f = () => saveShadowSnapshotIfNewer({ accountId: "A", get reportKey() { return "brand-sales"; } });\n'],
    [C("k-value-pos"), 'import { saveReportSnapshot } from "../../lib/server/supabase.js";\nconst reportKey = "account-directory";\nexport const f = (k) => saveReportSnapshot({ reportKey, accountId: "__account-directory__", note: reportKey });\n'],
    [C("di-clean"),'import * as sb from "../../lib/server/supabase.js";\nexport function mk() { return { saveShadowZq9: (a, o) => sb.saveShadowSnapshotIfNewer(a, o) }; }\nexport async function use({ saveShadowZq9 }) {\n  return saveShadowZq9({ reportKey: "scheduler-v2/x", accountId: "A" });\n}\n'],
  ]);
  const ca = makeWriterAnalyzer({ fencedKeys: W.FENCED_WRITER_REPORT_KEYS, overrides: canaries, clears: CLEARS });
  const w = (n) => ca.writers.get(rel(C(n)));
  ok("K1 canary: a literal fenced-key write is flagged WITH its key (saveReportSnapshot@brand-sales)", w("literal") && JSON.stringify(w("literal").sinks) === JSON.stringify(["saveReportSnapshot@brand-sales"]));
  ok("K2 canary: an ALIASED import of a sink with a dynamic key is flagged", w("alias") && w("alias").sinks.includes("saveReportSnapshot") && w("alias").fns.includes("run"));
  ok("K3 canary: a NAMESPACE member call and an INNER dynamic-import alias are flagged", w("namespace") && w("namespace").sinks.includes("publishLiveSnapshotIfNewer") && w("inner-dynamic") && w("inner-dynamic").sinks.includes("deleteReportSnapshotByKey"));
  ok("K4 canary: a DESTRUCTURED top-level dynamic import is flagged", w("dynamic") && w("dynamic").sinks.includes("casUpdateReportSnapshotByRev"));
  ok("K5 canary: a new caller of a WRAPPER (report-store.js beginSharedRefresh) inherits its sink", w("wrapper") && w("wrapper").sinks.includes("saveReportSnapshot"));
  ok("K6 canary: direct SQL DML, a direct REST POST, a REST call with a COMPUTED method, a supabase-js .from() and a direct CAS RPC on report_snapshots are flagged; a literal GET is not",
    w("sql") && w("sql").sinks.includes("sql:report_snapshots") && w("rest") && w("rest").sinks.includes("rest:report_snapshots") && w("rpc") && w("rpc").sinks.includes("rpc:report_snapshots")
    && w("rest-computed") && w("rest-computed").sinks.includes("rest:report_snapshots") && w("client") && w("client").sinks.includes("client:report_snapshots") && !w("rest-get"));
  ok("K7 canary: the supabase.js NAMESPACE passed as a whole VALUE reaches every sink", w("ns-value") && ["saveReportSnapshot", "publishLiveSnapshotIfNewer", "publishLiveSnapshotFencedIfNewer"].every((s) => w("ns-value").sinks.includes(s)));
  ok("K8 canary: a write PROVEN to an unfenced key (module const, or a function-local const in an enclosing block) or to the scheduler-v2/* shadow namespace needs no entry", !w("unfenced-literal") && !w("shadow") && !w("local-const"));
  ok("K10 canary: key proofs are SOUND against shadowing -- a parameter shadowing the const, a duplicate reportKey property and a const in a block that closed before the call are all unproven (flagged)",
    ["param-shadow", "dup-key", "block-scope"].every((n) => w(n) && w(n).sinks.includes("saveReportSnapshot")));
  const t = (n) => ca.tripwire.get(rel(C(n))) || "";
  const V = [["v1-rest-concat", "rest"], ["v2-rest-template-const", "rest"], ["v3-rest-opts", "rest"], ["v3b-rest-opts-assign", "rest"], ["v4-sql-concat", "sql"], ["v5-sql-quoted", "sql"], ["v6-client-const", "client"], ["v7-rpc-concat", "rpc"]];
  const missedFine = V.filter(([n, kind]) => !(w(n) && w(n).sinks.includes(kind + ":report_snapshots"))).map(([n]) => n);
  const missedTrip = V.filter(([n]) => !/(^|,)t1:[1-9]/.test(t(n))).map(([n]) => n);
  ok("K11 canary: the verifier's SEVEN missed evasions (concatenated REST path, templated path with a const table, method via an options object -- declared or assigned, concatenated SQL, \"public\".\"report_snapshots\" quoting, .from(CONST).upsert, concatenated RPC name) are caught by the FINE-GRAINED analysis with the right sink AND by the tripwire"
    + (missedFine.length || missedTrip.length ? " -- MISSED fine " + missedFine.join(",") + " trip " + missedTrip.join(",") : ""), missedFine.length === 0 && missedTrip.length === 0);
  ok("K12 canary: normalisation also sees an UPPER-CASE table, a %5F-encoded path, a \\x5f-escaped name, a table name IMPORTED from a fragment-built const and a require()d sink module; the tripwire alone catches computed writes with NO table literal in the file (computed-path non-GET REST, .from(x).insert, .rpc(x), DML on ${x} or public.\" + x, a computed import(x)) and the const module itself",
    w("t-case") && w("t-case").sinks.includes("sql:report_snapshots") && w("t-pct") && w("t-pct").sinks.includes("rest:report_snapshots") && w("t-rest-import") && w("t-rest-import").sinks.includes("rest:report_snapshots")
    && w("t-require") && w("t-require").sinks.includes("saveReportSnapshot") && w("t-escape") && w("t-escape").sinks.includes("sql:report_snapshots") && t("t-escape") === "t1:1"
    && t("t-rest-import") === "rest:1" && t("t-rest-computed") === "rest:1" && t("t-client") === "client:1" && t("t-rpc") === "rpc:1" && t("t-sql") === "sql:1" && t("t-sql-schema") === "sql:1" && t("tables") === "t1:1" && t("t-dynimport") === "dynimport:1"
    && ["t-rest-computed", "t-client", "t-rpc", "t-sql", "t-sql-schema", "t-dynimport", "tables"].every((n) => !w(n)));
  ok("K13 canary: a shadow proof must span the WHOLE key expression -- `scheduler-v2/${k}`.slice(13), both ternaries, shadowSnapshotKey(k).slice(13), a CONTINUED multi-line initialiser and a locally re-bound shadowSnapshotKey are all UNPROVEN (flagged); a whole template, a whole shadowSnapshotKey(k) call and a pure `+` chain still prove the shadow namespace",
    ["s-slice", "s-ternary", "s-ternary-tpl", "s-fn-slice", "s-multiline", "s-local-fn"].every((n) => w(n) && w(n).sinks.includes("saveReportSnapshot"))
    && ["shadow-template", "shadow-fn", "shadow-chain"].every((n) => !w(n)));
  ok("K14 canary: a DI forwarder stays TAINTED on ANY non-call reference -- an alias, a value pass, a spread argument, .call, typeof, a computed deps[\"name\"] access -- while a DI name used only through proven calls and a same-name destructuring parameter is still cleared",
    ["di-alias", "di-pass", "di-spreadargs", "di-apply", "di-typeof", "di-string", "di-exp-a"].every((n) => w(n) && w(n).sinks.includes("saveShadowSnapshotIfNewer")) && !w("di-clean")
    && w("di-exp-b") && w("di-exp-b").sinks.includes("saveShadowSnapshotIfNewer") && w("di-exp-b").fns.includes("bad")
    && ca.diCleared("saveShadowZq9").cleared === true && ["saveShadowZq1", "saveShadowZq2", "saveShadowZq4", "saveShadowZq5", "saveShadowZq6", "saveShadowZqE"].every((nm) => /non-call reference/.test(ca.diCleared(nm).why)));
  ok("K15 canary: a proven reportKey is overridden at runtime by a later QUOTED key, a COMPUTED key or an ACCESSOR -- all unproven (flagged); a value-position mention of the name is not mistaken for a second key",
    ["k-quoted", "k-computed", "k-accessor"].every((n) => w(n) && w(n).sinks.includes("saveShadowSnapshotIfNewer")) && !w("k-value-pos"));
  const unl = [...ca.writers.keys()].filter((f) => !INVENTORY[f]).sort();
  const unlTrip = [...ca.tripwire.keys()].filter((f) => !INVENTORY[f]).sort();
  const expFine = ["alias", "block-scope", "client", "dup-key", "dynamic", "inner-dynamic", "literal", "namespace", "ns-value", "param-shadow", "rest", "rest-computed", "rpc", "sql", "wrapper",
    ...V.map(([n]) => n), "t-case", "t-pct", "t-escape", "t-rest-import", "t-require", "s-slice", "s-ternary", "s-ternary-tpl", "s-fn-slice", "s-multiline", "s-local-fn",
    "di-alias", "di-pass", "di-spreadargs", "di-apply", "di-typeof", "di-string", "di-exp-a", "di-exp-b", "k-quoted", "k-computed", "k-accessor"].map((n) => rel(C(n))).sort();
  const expTrip = ["sql", "rest", "rpc", "rest-computed", "client", "rest-get", ...V.map(([n]) => n), "tables", "t-rest-import", "t-case", "t-pct", "t-escape", "t-rest-computed", "t-client", "t-rpc", "t-sql", "t-sql-schema", "t-dynimport"].map((n) => rel(C(n))).sort();
  ok("K9 canary: the inventory check itself FAILS on the injected writers (fail-closed) -- E4 on exactly the fine-grained writers, E10 on exactly the tripwire hits -- and only on them"
    + (JSON.stringify(unl) !== JSON.stringify(expFine) ? " -- FINE got " + JSON.stringify(unl.map((f) => f.replace(/^.*__writer_canary_|__\.mjs$/g, ""))) : "")
    + (JSON.stringify(unlTrip) !== JSON.stringify(expTrip) ? " -- TRIP got " + JSON.stringify(unlTrip.map((f) => f.replace(/^.*__writer_canary_|__\.mjs$/g, ""))) : ""),
    JSON.stringify(unl) === JSON.stringify(expFine) && JSON.stringify(unlTrip) === JSON.stringify(expTrip));
}

// =====================================================================================================================
// F. mark hygiene
// =====================================================================================================================
{
  const walkAll = (dir) => (existsSync(abs(dir)) ? readdirSync(abs(dir), { withFileTypes: true }).flatMap((e) => (e.name === "node_modules" ? [] : e.isDirectory() ? walkAll(dir + "/" + e.name) : /\.(m?js|cjs|jsx|ts|tsx)$/.test(e.name) ? [dir + "/" + e.name] : [])) : []);
  const appFiles = ["lib", "api", "scripts", "src"].flatMap(walkAll);
  const ALLOWED = new Set(["lib/server/sync/report-writer-fence.js", "scripts/report-writer-fence.test.js", "scripts/worker/report-writer-fence-selftest.mjs"]);
  const namers = appFiles.filter((f) => !ALLOWED.has(f) && /app\.report_publication_fenced/.test(src(f)));
  ok("F1 NO application file (lib/ api/ scripts/ src/) names the mark except the contract module and its two tests -- no code can set it (session- or transaction-level)" + (namers.length ? ": " + namers.join(", ") : ""), namers.length === 0);
  const setConfig = appFiles.filter((f) => !ALLOWED.has(f) && /\bset_config\s*\(|\bset\s+(local\s+|session\s+)?app\./i.test(lex(src(f), { blankStrings: false })));
  ok("F2 no application code calls set_config / SET app.* at all (a pooled session-level setting could never leak the mark)" + (setConfig.length ? ": " + setConfig.join(", ") : ""), setConfig.length === 0);
  const fencedCallers = appFiles.filter((f) => /cas_report_snapshot_if_newer_fenced/.test(lex(src(f), { blankStrings: false }).replace(/\/\/.*$/gm, "")));
  const nonTest = fencedCallers.filter((f) => !/\.test\.m?js$/.test(f) && !ALLOWED.has(f));
  ok("F3 the fenced CAS is invoked ONLY as a single-statement PostgREST RPC from supabase.js (no pg-direct caller could run another statement in its marked transaction)",
    JSON.stringify(nonTest) === JSON.stringify(["lib/server/supabase.js"]) && (src("lib/server/supabase.js").match(/\/rest\/v1\/rpc\/cas_report_snapshot_if_newer_fenced/g) || []).length === 1);
  ok("F4 the self-test exists and reports SKIPPED (exit 3) -- never a pass -- when PGlite is unavailable", /process\.exit\(3\)/.test(src("scripts/worker/report-writer-fence-selftest.mjs")) && /PRW_PGLITE_DIR/.test(src("scripts/worker/report-writer-fence-selftest.mjs")));
  const browser = walkAll("src").filter((f) => /report_snapshots/.test(src(f)));
  ok("F6 the browser bundle (src/) never names report_snapshots (no client write path; 20260918 revoked every anon/authenticated privilege on it)", browser.length === 0 && /revoke all privileges on table public\.report_snapshots from anon, authenticated;/.test(src("supabase/migrations/20260918_revoke_direct_report_snapshot_reads.sql")));
  // HANDOFF (WP6 verifier): supabase.js upsertSourceOliHistoryRows is a SOURCE-table writer (source_oli_daily_history,
  // bypassing source_coverage) -- NOT a report_snapshots writer, so it is outside this fence. It must stay UNREACHABLE:
  // no caller anywhere (only the schema-contract wrapper registry names it). If it is deleted, this passes too.
  const supaSrc = src("lib/server/supabase.js");
  const hasOliUpsert = /export async function upsertSourceOliHistoryRows\(/.test(supaSrc);
  const oliCallers = appFiles.filter((f) => f !== "lib/server/supabase.js" && !/\.test\.m?js$/.test(f) && new RegExp("(?<![\\w$])upsertSourceOliHistoryRows(?![\\w$])").test(lex(src(f), { blankStrings: true })));
  ok("F7 SOURCE-table writer noted separately: upsertSourceOliHistoryRows (source_oli_daily_history, not report_snapshots) is not a report sink and has NO caller (retired/unreachable)" + (oliCallers.length ? " -- CALLERS: " + oliCallers.join(", ") : ""),
    !analysis.baseSinks.has("upsertSourceOliHistoryRows") && (!hasOliUpsert || (/\/rest\/v1\/source_oli_daily_history\b/.test(supaSrc) && oliCallers.length === 0)));
  // Workflows + deploy configs: nothing may name the mark or pre-set startup options for a writer connection (a PGOPTIONS
  // / options=-c app.report_publication_fenced=on would mark EVERY transaction of that connection).
  const GH = path.join(ROOT, "..", ".github", "workflows");
  const cfgFiles = [...(existsSync(GH) ? readdirSync(GH).filter((f) => /\.ya?ml$/.test(f)).map((f) => path.join(GH, f)) : []),
    ...readdirSync(abs("deploy/publication-recovery")).map((f) => abs("deploy/publication-recovery/" + f))].filter((f) => !/(README\.md|ROLLBACK_20260935\.sql)$/.test(f));
  const cfgBad = cfgFiles.filter((f) => /report_publication_fenced|PGOPTIONS|[?&]options=|options=\s*-c|\s-c\s+app\./i.test(readFileSync(f, "utf8")));
  ok("F8 no workflow or deploy config (VM unit, env template, install/rollback scripts) names the mark or pre-sets connection startup options (PGOPTIONS, ?options=, -c app.*) (" + cfgFiles.length + " files)" + (cfgBad.length ? ": " + cfgBad.map(rel).join(", ") : ""),
    cfgFiles.length >= 10 && cfgBad.length === 0);
  // JS OUTSIDE the scanned trees (the app root, cloudflare/, public/, supabase/, docs/, deploy/ ...; build output, deps and
  // scratch excluded): none may name report_snapshot* or reach the supabase.js sinks -- else the scan must be extended.
  const SCANNED = new Set(["lib", "api", "scripts", "src", "node_modules", "dist", "scratchpad", ".git"]);
  const walkOut = (dir) => (existsSync(abs(dir || ".")) ? readdirSync(abs(dir || "."), { withFileTypes: true }).flatMap((e) => {
    const p = dir ? dir + "/" + e.name : e.name;
    if (e.isDirectory()) return !dir && SCANNED.has(e.name) ? [] : e.name === "node_modules" ? [] : walkOut(p);
    return /\.(m?js|cjs|ts)$/.test(e.name) ? [p] : [];
  }) : []);
  const outside = walkOut("");
  const outsideBad = outside.filter((f) => { const code = joinLiterals(decodeEscapes(lex(src(f), { blankStrings: false }))).toLowerCase(); return /report_snapshot|supabase\.js|savereportsnapshot|publishlivesnapshot|saveshadowsnapshot/.test(code); });
  ok("F11 no JS outside the scanned trees (" + outside.length + " files: app-root scripts, cloudflare/, public/ ...) names report_snapshot* or the supabase.js sinks" + (outsideBad.length ? ": " + outsideBad.join(", ") : ""),
    outside.length >= 1 && outsideBad.length === 0);
  const readme = src("deploy/publication-recovery/README.md");
  const s9 =(readme.match(/\n## 9\. Writer fence cutover\n[\s\S]*?(?=\n## \d+\. |$)/) || [""])[0];
  ok("F5 README section 9 documents the 'Writer fence cutover' (apply -> deploy fenced-only writers -> flip per key -> verify; code rollback never disables the fence)",
    s9.length > 0 && /gh run list --status in_progress/.test(s9) && /fenced_only = true/.test(s9) && /REPORT_WRITER_FENCED/.test(s9) && /ROLLBACK_20260935\.sql/.test(s9));
  ok("F9 README section 9 names WP10b (never WP10a) for read-only refresh=1, and REQUIRES the machine-checked per-key readiness gate before each flip",
    !/WP10a/.test(s9) && /WP10b/.test(s9) && /REPORT_WRITER_FENCE_READY_KEY=<key> node scripts\/report-writer-fence\.test\.js/.test(s9));
  ok("F10 README section 9 gives the exact read-only verification SQL: EXACTLY the three expected triggers, all tgenabled 'O' (+ the trigger-name ordering assumption), the flip barrier on pg_stat_activity xact_start, the per-key RWF01 negative probe inside begin/rollback, the mark check and the PGOPTIONS / options check",
    /report_snapshots_touch_updated_at:O:19:touch_updated_at/.test(s9) && /report_snapshots_zz_writer_fence:O:31:enforce_report_publication_writer_fence/.test(s9) && /report_snapshots_zz_writer_fence_truncate:O:34:enforce_report_publication_writer_fence/.test(s9)
    && /name order/i.test(s9) && /pg_stat_activity/.test(s9) && /xact_start < /.test(s9) && /WRITER_FENCE_NOT_ENFORCED:<key>/.test(s9) && /\n\s*begin;\n/.test(s9) && /\n\s*rollback;\n/.test(s9)
    && /current_setting\('app\.report_publication_fenced', true\)/.test(s9) && /PGOPTIONS/.test(s9) && /authoritative/.test(s9));
}

// =====================================================================================================================
// RK. the PER-KEY READINESS GATE (cutover step 2): REPORT_WRITER_FENCE_READY_KEY=<key>[,<key>...]
// =====================================================================================================================
// A key is READY only when NO inventory entry other than a fenced-publisher-path lists it (no blocked-by-fence writer and
// no other non-fenced writer can still write it). An unknown key or an empty list is never ready (fail closed).
function readinessOf(csv, inv) {
  const keys = String(csv == null ? "" : csv).split(",").map((k) => k.trim()).filter(Boolean);
  const errors = [...(keys.length ? [] : ["no-key"]), ...keys.filter((k) => !W.FENCED_WRITER_REPORT_KEYS.includes(k)).map((k) => "unknown-key:" + k)];
  const results = keys.filter((k) => W.FENCED_WRITER_REPORT_KEYS.includes(k)).map((key) => {
    const blockingEntries = Object.entries(inv).filter(([, e]) => e.class !== FPP && e.keys.includes(key)).map(([f, e]) => f + " (" + e.class + ")").sort();
    return { key, ready: blockingEntries.length === 0, blockingEntries };
  });
  return { ok: keys.length > 0 && errors.length === 0 && results.every((r) => r.ready), errors, results };
}
{
  const inv = { "a.js": E(FPP, ["brand-sales"], ["f"], ["publishLiveSnapshotFencedIfNewer"], "synthetic fenced publisher entry"), "b.js": E(BLOCKED, ["daily-reporting"], ["g"], ["saveReportSnapshot"], "synthetic blocked-by-fence entry"),
    "c.js": R("t1:1", "synthetic read-only tripwire entry"), "d.js": E(TEST, [], ["h"], ["saveReportSnapshot"], "synthetic offline test entry") };
  const r1 = readinessOf("brand-sales", inv); const r2 = readinessOf("daily-reporting", inv); const r3 = readinessOf("brand-sales, daily-reporting", inv);
  ok("RK1 readiness rule: a key written only through the fenced publisher is READY; a key a blocked-by-fence entry lists is NOT (the entry is named); a list is ready only if every key is; an unknown key / an empty list is never ready",
    r1.ok && r1.results[0].ready && !r2.ok && JSON.stringify(r2.results[0].blockingEntries) === JSON.stringify(["b.js (blocked-by-fence)"]) && !r3.ok
    && !readinessOf("sales-movers", inv).ok && readinessOf("sales-movers", inv).errors[0] === "unknown-key:sales-movers" && !readinessOf("", inv).ok && !readinessOf(undefined, inv).ok
    && JSON.stringify(W.FENCED_WRITER_REPORT_KEYS.map((k) => readinessOf(k, INVENTORY).results[0].blockingEntries)) === JSON.stringify(W.FENCED_WRITER_REPORT_KEYS.map(blockingEntriesFor)));
  if (process.env.REPORT_WRITER_FENCE_READY_KEY !== undefined) {
    const r = readinessOf(process.env.REPORT_WRITER_FENCE_READY_KEY, INVENTORY);
    out("READINESS " + JSON.stringify({ requested: process.env.REPORT_WRITER_FENCE_READY_KEY, errors: r.errors, results: r.results }));
    ok("RK2 READY TO FENCE " + JSON.stringify(process.env.REPORT_WRITER_FENCE_READY_KEY) + ": no blocked-by-fence (or other non-fenced) writer still lists it"
      + (r.ok ? "" : " -- NOT READY: " + [...r.errors, ...r.results.filter((x) => !x.ready).map((x) => x.key + " <- " + x.blockingEntries.join(", "))].join(" | ")), r.ok);
  }
}

out(`report-writer-fence: ${passed} passed`);
