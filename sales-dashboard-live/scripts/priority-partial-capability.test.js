// Release-safety regression: the SHARED partial-cycle schema capability check (lib/server/sync/priority-partial-
// capability.js). Verifies the EXACT open_sync_cycle signature + the named sync_cycles_bucket_check constraint (NOT
// "any pg_proc whose text contains priority-partial"), and that missing / comment-only / ambiguous / UNREADABLE
// capability all FAIL CLOSED (permitted:false). Offline, pure (an injected fake query; ZERO network). 7-bit ASCII, LF.
import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import {
  PARTIAL_CYCLE_CAPABILITY_PATTERN,
  OPEN_SYNC_CYCLE_IDENTITY_ARGS,
  partialCycleCapabilityQueries,
  evaluatePartialCycleCapability,
  readPartialCycleCapability,
} from "../lib/server/sync/priority-partial-capability.js";

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); passed += 1; writeSync(1, `  ok ${n}\n`); };
writeSync(1, "priority-partial-capability\n");

// A realistic open_sync_cycle body AFTER migration 20260924 (contains the exact regex in the guard).
const FN_WITH = "CREATE OR REPLACE FUNCTION public.open_sync_cycle(p_bucket text, p_cycle_date date, p_scheduled_at timestamp with time zone, p_trigger text)\n RETURNS uuid\n LANGUAGE plpgsql\nAS $function$ begin if not ( p_bucket in ('india','us-ca') or p_bucket ~ '" + PARTIAL_CYCLE_CAPABILITY_PATTERN + "' ) then raise exception 'Invalid bucket %', p_bucket; end if; end $function$";
// The SAME function BEFORE the migration (bootstrap regex only; no priority-partial).
const FN_WITHOUT = "CREATE OR REPLACE FUNCTION public.open_sync_cycle(p_bucket text, p_cycle_date date, p_scheduled_at timestamp with time zone, p_trigger text)\n RETURNS uuid\nAS $function$ begin if not ( p_bucket in ('india','us-ca') or p_bucket ~ '^bootstrap(-fba)?-(india|europe-au|us-ca)-[0-9a-f]{16}$' ) then raise exception 'x'; end if; end $function$";
const CK_WITH = "CHECK ((bucket = ANY (ARRAY['india'::text,'us-ca'::text])) OR (bucket ~ '^bootstrap(-fba)?-(india|europe-au|us-ca)-[0-9a-f]{16}$'::text) OR (bucket ~ '" + PARTIAL_CYCLE_CAPABILITY_PATTERN + "'::text))";
const CK_WITHOUT = "CHECK ((bucket = ANY (ARRAY['india'::text,'us-ca'::text])) OR (bucket ~ '^bootstrap(-fba)?-(india|europe-au|us-ca)-[0-9a-f]{16}$'::text))";

/* ---------------- the queries verify the EXACT signature + constraint name ---------------- */
const q = partialCycleCapabilityQueries();
ok("the function query filters on the EXACT open_sync_cycle identity arguments (text, date, timestamptz, text), not just the name",
  q.functionDef.includes("p.proname = 'open_sync_cycle'") && q.functionDef.includes("pg_get_function_identity_arguments(p.oid) = '" + OPEN_SYNC_CYCLE_IDENTITY_ARGS + "'"));
ok("the constraint query targets EXACTLY public.sync_cycles / sync_cycles_bucket_check",
  q.constraintDef.includes("t.relname = 'sync_cycles'") && q.constraintDef.includes("c.conname = 'sync_cycles_bucket_check'") && q.constraintDef.includes("n.nspname = 'public'"));

/* ---------------- pure evaluator ---------------- */
ok("PERMITTED: exactly one function + one constraint, both containing the exact regex",
  evaluatePartialCycleCapability({ functionDefs: [FN_WITH], constraintDefs: [CK_WITH] }).permitted === true);
ok("MIGRATION ABSENT (function guard lacks the regex): NOT permitted, reason names open_sync_cycle",
  (() => { const r = evaluatePartialCycleCapability({ functionDefs: [FN_WITHOUT], constraintDefs: [CK_WITH] }); return r.permitted === false && r.functionPermits === false && /open_sync_cycle guard/.test(r.reason); })());
ok("MIGRATION ABSENT (constraint lacks the regex): NOT permitted, reason names sync_cycles_bucket_check",
  (() => { const r = evaluatePartialCycleCapability({ functionDefs: [FN_WITH], constraintDefs: [CK_WITHOUT] }); return r.permitted === false && r.constraintPermits === false && /sync_cycles_bucket_check/.test(r.reason); })());
ok("FUNCTION MISSING (0 rows -- e.g. wrong signature filtered out): NOT permitted (exactly one expected)",
  (() => { const r = evaluatePartialCycleCapability({ functionDefs: [], constraintDefs: [CK_WITH] }); return r.permitted === false && r.functionPresent === false && /not found/.test(r.reason); })());
ok("CONSTRAINT MISSING (0 rows): NOT permitted",
  evaluatePartialCycleCapability({ functionDefs: [FN_WITH], constraintDefs: [] }).permitted === false);
ok("AMBIGUOUS (>1 function row): NOT permitted (exactly one expected)",
  evaluatePartialCycleCapability({ functionDefs: [FN_WITH, FN_WITH], constraintDefs: [CK_WITH] }).permitted === false);
// A COMMENT-ONLY mention of 'priority-partial' that is NOT the exact regex must NOT satisfy the check.
const FN_COMMENT_ONLY = "CREATE OR REPLACE FUNCTION public.open_sync_cycle(...) AS $function$ -- priority-partial is coming soon\n begin if not ( p_bucket in ('india') ) then raise exception 'x'; end if; end $function$";
ok("COMMENT-ONLY 'priority-partial' (not the exact regex) does NOT satisfy the capability (never 'any text contains priority-partial')",
  evaluatePartialCycleCapability({ functionDefs: [FN_COMMENT_ONLY], constraintDefs: [CK_WITH] }).permitted === false);

/* ---------------- reader over an injected query ---------------- */
const okReader = async () => {
  const query = async (sql) => (sql === q.functionDef ? [{ def: FN_WITH }] : sql === q.constraintDef ? [{ def: CK_WITH }] : []);
  return (await readPartialCycleCapability(query)).permitted === true;
};
const absentReader = async () => {
  const query = async (sql) => (sql === q.functionDef ? [{ def: FN_WITHOUT }] : [{ def: CK_WITH }]);
  return (await readPartialCycleCapability(query)).permitted === false;
};
const unreadableReader = async () => {
  const query = async () => { throw new Error("permission denied for schema public"); };
  const r = await readPartialCycleCapability(query);
  return r.permitted === false && /capability-unreadable/.test(r.reason);
};
const noQueryReader = async () => (await readPartialCycleCapability(null)).permitted === false;

const run = async () => {
  ok("READER permitted: both defs present + regex -> permitted", await okReader());
  ok("READER migration absent: -> NOT permitted", await absentReader());
  ok("READER UNREADABLE (query throws): -> NOT permitted, reason capability-unreadable (FAIL CLOSED)", await unreadableReader());
  ok("READER no query function: -> NOT permitted (fail closed)", await noQueryReader());
  writeSync(1, `\npriority-partial-capability: ${passed} checks passed\n`);
};
await run();
