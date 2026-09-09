// Release-safety regression: the SHARED partial-cycle schema capability check (lib/server/sync/priority-partial-
// capability.js). Verifies the EXACT open_sync_cycle signature by OID (to_regprocedure -- NAME-agnostic) + the named
// sync_cycles_bucket_check constraint (NOT "any pg_proc whose text contains priority-partial"), that missing /
// comment-only / ambiguous / UNREADABLE capability all FAIL CLOSED (permitted:false), and that "function missing" is
// DISTINGUISHED from "function found, capability absent". A dedicated case covers NAMED PostgreSQL arguments. Offline,
// pure (an injected fake query; ZERO network). The exact OID lookup is ALSO verified read-only against the live
// database out-of-band (see the run report), not only this stub. 7-bit ASCII, LF.
import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import {
  PARTIAL_CYCLE_CAPABILITY_PATTERN,
  OPEN_SYNC_CYCLE_REGPROCEDURE,
  partialCycleCapabilityQueries,
  evaluatePartialCycleCapability,
  readPartialCycleCapability,
} from "../lib/server/sync/priority-partial-capability.js";

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); passed += 1; writeSync(1, `  ok ${n}\n`); };
writeSync(1, "priority-partial-capability\n");

// A realistic open_sync_cycle body AFTER migration 20260924 (contains the exact regex in the guard). NAMED args.
const FN_WITH = "CREATE OR REPLACE FUNCTION public.open_sync_cycle(p_bucket text, p_cycle_date date, p_scheduled_at timestamp with time zone, p_trigger text)\n RETURNS uuid\n LANGUAGE plpgsql\nAS $function$ begin if not ( p_bucket in ('india','us-ca') or p_bucket ~ '" + PARTIAL_CYCLE_CAPABILITY_PATTERN + "' ) then raise exception 'Invalid bucket %', p_bucket; end if; end $function$";
// The SAME function BEFORE the migration (bootstrap regex only; no priority-partial). Also NAMED args.
const FN_WITHOUT = "CREATE OR REPLACE FUNCTION public.open_sync_cycle(p_bucket text, p_cycle_date date, p_scheduled_at timestamp with time zone, p_trigger text)\n RETURNS uuid\nAS $function$ begin if not ( p_bucket in ('india','us-ca') or p_bucket ~ '^bootstrap(-fba)?-(india|europe-au|us-ca)-[0-9a-f]{16}$' ) then raise exception 'x'; end if; end $function$";
const CK_WITH = "CHECK ((bucket = ANY (ARRAY['india'::text,'us-ca'::text])) OR (bucket ~ '^bootstrap(-fba)?-(india|europe-au|us-ca)-[0-9a-f]{16}$'::text) OR (bucket ~ '" + PARTIAL_CYCLE_CAPABILITY_PATTERN + "'::text))";
const CK_WITHOUT = "CHECK ((bucket = ANY (ARRAY['india'::text,'us-ca'::text])) OR (bucket ~ '^bootstrap(-fba)?-(india|europe-au|us-ca)-[0-9a-f]{16}$'::text))";

/* ---------------- the queries resolve the EXACT function by OID + the constraint by name ---------------- */
const q = partialCycleCapabilityQueries();
ok("the function query resolves the EXACT signature by OID via to_regprocedure (NAME-agnostic), NOT a textual pg_get_function_identity_arguments comparison",
  q.functionDef.includes("to_regprocedure('" + OPEN_SYNC_CYCLE_REGPROCEDURE + "')") && !q.functionDef.includes("pg_get_function_identity_arguments"));
ok("the function query returns present(bool) + def, so 'function missing' is distinguishable from 'capability absent'",
  /r\.oid is not null as present/.test(q.functionDef) && /pg_get_functiondef\(r\.oid\)/.test(q.functionDef));
ok("the constraint query targets EXACTLY public.sync_cycles / sync_cycles_bucket_check",
  q.constraintDef.includes("t.relname = 'sync_cycles'") && q.constraintDef.includes("c.conname = 'sync_cycles_bucket_check'") && q.constraintDef.includes("n.nspname = 'public'"));

/* ---------------- pure evaluator ---------------- */
ok("PERMITTED: exact-signature function present + its guard contains the regex, and one constraint containing it",
  evaluatePartialCycleCapability({ functionPresent: true, functionDef: FN_WITH, constraintDefs: [CK_WITH] }).permitted === true);
ok("NAMED PostgreSQL ARGUMENTS: a guard rendered with named params (p_bucket text, ...) is accepted (OID resolution is name-agnostic; the def check keys on the regex, not the names)",
  evaluatePartialCycleCapability({ functionPresent: true, functionDef: FN_WITH, constraintDefs: [CK_WITH] }).functionPermits === true);
ok("FUNCTION MISSING (to_regprocedure returned NULL -> present:false): NOT permitted, reason says 'function missing'",
  (() => { const r = evaluatePartialCycleCapability({ functionPresent: false, functionDef: null, constraintDefs: [CK_WITH] }); return r.permitted === false && /function missing/.test(r.reason); })());
ok("FUNCTION FOUND, CAPABILITY ABSENT (present but guard lacks the regex -- pre-migration): NOT permitted, reason DISTINGUISHES it from missing",
  (() => { const r = evaluatePartialCycleCapability({ functionPresent: true, functionDef: FN_WITHOUT, constraintDefs: [CK_WITH] }); return r.permitted === false && r.functionPresent === true && r.functionPermits === false && /function found, capability absent/.test(r.reason); })());
ok("CONSTRAINT capability absent (guard lacks the regex): NOT permitted, reason names sync_cycles_bucket_check",
  (() => { const r = evaluatePartialCycleCapability({ functionPresent: true, functionDef: FN_WITH, constraintDefs: [CK_WITHOUT] }); return r.permitted === false && r.constraintPermits === false && /sync_cycles_bucket_check/.test(r.reason); })());
ok("CONSTRAINT MISSING (0 rows): NOT permitted",
  evaluatePartialCycleCapability({ functionPresent: true, functionDef: FN_WITH, constraintDefs: [] }).permitted === false);
ok("AMBIGUOUS (>1 constraint row -- never expected): NOT permitted",
  evaluatePartialCycleCapability({ functionPresent: true, functionDef: FN_WITH, constraintDefs: [CK_WITH, CK_WITH] }).permitted === false);
// A COMMENT-ONLY mention of 'priority-partial' that is NOT the exact regex must NOT satisfy the check.
const FN_COMMENT_ONLY = "CREATE OR REPLACE FUNCTION public.open_sync_cycle(p_bucket text, p_cycle_date date, p_scheduled_at timestamp with time zone, p_trigger text) AS $function$ -- priority-partial is coming soon\n begin if not ( p_bucket in ('india') ) then raise exception 'x'; end if; end $function$";
ok("COMMENT-ONLY 'priority-partial' (not the exact regex) does NOT satisfy the capability (never 'any text contains priority-partial')",
  evaluatePartialCycleCapability({ functionPresent: true, functionDef: FN_COMMENT_ONLY, constraintDefs: [CK_WITH] }).permitted === false);

/* ---------------- reader over an injected query (present/def row shape) ---------------- */
const fnRow = (present, def) => [{ present, def }];
const okReader = async () => {
  const query = async (sql) => (sql === q.functionDef ? fnRow(true, FN_WITH) : sql === q.constraintDef ? [{ def: CK_WITH }] : []);
  return (await readPartialCycleCapability(query)).permitted === true;
};
const missingReader = async () => {
  const query = async (sql) => (sql === q.functionDef ? fnRow(false, null) : [{ def: CK_WITH }]);
  const r = await readPartialCycleCapability(query);
  return r.permitted === false && r.functionPresent === false && /function missing/.test(r.reason);
};
const absentReader = async () => {
  const query = async (sql) => (sql === q.functionDef ? fnRow(true, FN_WITHOUT) : [{ def: CK_WITH }]);
  const r = await readPartialCycleCapability(query);
  return r.permitted === false && r.functionPresent === true && /capability absent/.test(r.reason);
};
const unreadableReader = async () => {
  const query = async () => { throw new Error("permission denied for schema public"); };
  const r = await readPartialCycleCapability(query);
  return r.permitted === false && /capability-unreadable/.test(r.reason);
};
const noQueryReader = async () => (await readPartialCycleCapability(null)).permitted === false;

const run = async () => {
  ok("READER permitted: function present + regex + constraint -> permitted", await okReader());
  ok("READER function MISSING: -> NOT permitted, reason 'function missing'", await missingReader());
  ok("READER function found, capability absent (pre-migration): -> NOT permitted, reason 'capability absent'", await absentReader());
  ok("READER UNREADABLE (query throws): -> NOT permitted, reason capability-unreadable (FAIL CLOSED)", await unreadableReader());
  ok("READER no query function: -> NOT permitted (fail closed)", await noQueryReader());
  writeSync(1, `\npriority-partial-capability: ${passed} checks passed\n`);
};
await run();
