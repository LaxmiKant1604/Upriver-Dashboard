// Scheduler v2 -- cycle finalization PRODUCTION WIRING + strict acknowledgement + exact Migration-5 audit
// (deterministic OFFLINE). Proves: the REAL composed store exposes finalizeCycle; the wrapper STRICTLY validates
// the finalize acknowledgement (fail closed on any contradictory/malformed shape, per disposition); the static
// audit/preflight fail closed when Migration 5 / the RPC / the wrapper / the triggers are missing OR malformed;
// the trigger audit is a BOUNDED STRUCTURAL proof (timing/events/level/function/table + no create-then-drop);
// and the guard FUNCTION's critical behavior (cycle_id immutable, FOR SHARE lock, terminal reject, missing
// parent fail-closed) is proven against the ACTUAL SQL with each condition BOUND to a DIRECT, UNCONDITIONAL
// RAISE on its OWN IF block's initial true branch (an unrelated/moved/commented/stringified raise, or one nested
// in an inner IF / ELSE / ELSIF, never satisfies it). finished_at is validated as a strict RFC3339 timestamptz
// (Z or +/-HH:MM only). No network/DataDoe/Supabase (global fetch is mocked).
//
// 7-bit ASCII, LF. Run: node scripts/cycle-finalize-wiring.test.js

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { writeSync } from "node:fs";

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };

process.env.SUPABASE_URL = "https://finalize-test.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-svc-role";
process.env.DATADOE_API_KEY = "test-primary";

let buildSchedulerV2Runtime, auditSchemaContract, REQUIRED_WRAPPER_EXPORTS, finalizeSyncCycle;

const realMigration = (n) => readFileSync(new URL(`../supabase/migrations/${n}`, import.meta.url), "utf8");
const realSupabase = () => readFileSync(new URL("../lib/server/supabase.js", import.meta.url), "utf8");
const M5 = "20260815_sync_cycle_finalize.sql";
const M5_SQL = realMigration(M5);
const readFileWith = (over = {}) => (name) => {
  if (name in over) { if (over[name] == null) throw new Error("missing"); return over[name]; }
  return name === "supabase.js" ? realSupabase() : realMigration(name);
};

// ---- fetch-mock helper: the next finalize RPC returns `body` (object) ----
async function withRpc(body, fn) {
  const orig = global.fetch;
  global.fetch = async () => new Response(JSON.stringify(body), { status: 200 });
  try { return await fn(); } finally { global.fetch = orig; }
}
const goodTerminal = (id, over = {}) => ({ id, bucket: "us", cycle_date: "2026-08-14", status: "succeeded", finished_at: "2026-08-14T09:31:57.861Z", source_total: 2, source_succeeded: 2, source_failed: 0, report_total: 1, report_succeeded: 1, report_failed: 0, ...over });
const goodRunning = (id, over = {}) => ({ id, status: "running", finished_at: null, source_total: 2, source_succeeded: 1, source_failed: 0, report_total: 0, report_succeeded: 0, report_failed: 0, ...over });

// ============================= production wiring =============================
test("(wiring) the composed production store exposes finalizeCycle; finalizeSyncCycle is a REQUIRED wrapper", () => {
  const rt = buildSchedulerV2Runtime({ connections: [{ id: "primary", apiKey: "k" }] });
  assert.equal(typeof rt.store.finalizeCycle, "function");
  assert.ok(REQUIRED_WRAPPER_EXPORTS.includes("finalizeSyncCycle"));
});

// ============================= strict acknowledgement (Finding 1) =============================
test("(wrapper) valid controls: finalized, already-terminal, and open-work all round-trip", async () => {
  await withRpc({ disposition: "finalized", cycle: goodTerminal("c1") }, async () => {
    const r = await finalizeSyncCycle("c1"); assert.equal(r.disposition, "finalized"); assert.equal(r.cycle.status, "succeeded");
  });
  await withRpc({ disposition: "already-terminal", cycle: goodTerminal("c1", { status: "partial" }) }, async () => {
    assert.equal((await finalizeSyncCycle("c1")).disposition, "already-terminal");
  });
  await withRpc({ disposition: "open-work", cycle: goodRunning("c1") }, async () => {
    const r = await finalizeSyncCycle("c1"); assert.equal(r.disposition, "open-work"); assert.equal(r.cycle.status, "running");
  });
  // not-found / invalid-status with a null cycle are valid
  await withRpc({ disposition: "not-found", cycle: null }, async () => { assert.equal((await finalizeSyncCycle("c1")).disposition, "not-found"); });
  await withRpc({ disposition: "invalid-status", cycle: null }, async () => { assert.equal((await finalizeSyncCycle("c1")).disposition, "invalid-status"); });
  // exact RPC param
  const seen = [];
  const orig = global.fetch;
  try { global.fetch = async (u, o) => { seen.push({ u: String(u), b: o.body }); return new Response(JSON.stringify({ disposition: "finalized", cycle: goodTerminal("c1") }), { status: 200 }); };
    await finalizeSyncCycle("c1"); assert.match(seen[0].u, /\/rpc\/finalize_sync_cycle$/); assert.deepEqual(JSON.parse(seen[0].b), { p_cycle_id: "c1" });
  } finally { global.fetch = orig; }
});

test("(wrapper strict) finalized/already-terminal FAIL CLOSED on null cycle / wrong id / running status / bad finished_at / bad+incoherent counters", async () => {
  for (const d of ["finalized", "already-terminal"]) {
    await withRpc({ disposition: d, cycle: null }, async () => { await assert.rejects(() => finalizeSyncCycle("c1"), /without a cycle object/); });
    await withRpc({ disposition: d, cycle: goodTerminal("WRONG") }, async () => { await assert.rejects(() => finalizeSyncCycle("c1"), /different cycle id/); });
    await withRpc({ disposition: d, cycle: goodTerminal("c1", { status: "running" }) }, async () => { await assert.rejects(() => finalizeSyncCycle("c1"), /not terminal/); });
    await withRpc({ disposition: d, cycle: goodTerminal("c1", { finished_at: null }) }, async () => { await assert.rejects(() => finalizeSyncCycle("c1"), /valid finished_at/); });
    await withRpc({ disposition: d, cycle: goodTerminal("c1", { finished_at: "" }) }, async () => { await assert.rejects(() => finalizeSyncCycle("c1"), /valid finished_at/); });
    await withRpc({ disposition: d, cycle: goodTerminal("c1", { finished_at: "not-a-time" }) }, async () => { await assert.rejects(() => finalizeSyncCycle("c1"), /valid finished_at/); });
    // counter mutations: negative, string, fractional, unsafe, missing, incoherent
    for (const over of [{ source_total: -1 }, { source_succeeded: "2" }, { report_total: 1.5 }, { source_total: 2 ** 53 }, { report_failed: undefined }, { source_succeeded: 2, source_failed: 1, source_total: 2 }]) {
      await withRpc({ disposition: d, cycle: goodTerminal("c1", over) }, async () => { await assert.rejects(() => finalizeSyncCycle("c1"), /counters are missing\/unsafe\/incoherent/); });
    }
  }
});

test("(wrapper strict) open-work FAIL CLOSED on missing cycle / wrong id / non-running status / finished_at set / bad counters", async () => {
  await withRpc({ disposition: "open-work", cycle: null }, async () => { await assert.rejects(() => finalizeSyncCycle("c1"), /without a cycle object/); });
  await withRpc({ disposition: "open-work", cycle: goodRunning("WRONG") }, async () => { await assert.rejects(() => finalizeSyncCycle("c1"), /different cycle id/); });
  await withRpc({ disposition: "open-work", cycle: goodRunning("c1", { status: "succeeded" }) }, async () => { await assert.rejects(() => finalizeSyncCycle("c1"), /not running/); });
  await withRpc({ disposition: "open-work", cycle: goodRunning("c1", { finished_at: "2026-08-14T00:00:00Z" }) }, async () => { await assert.rejects(() => finalizeSyncCycle("c1"), /has a finished_at/); });
  await withRpc({ disposition: "open-work", cycle: goodRunning("c1", { source_succeeded: 3, source_failed: 0, source_total: 2 }) }, async () => { await assert.rejects(() => finalizeSyncCycle("c1"), /counters are missing\/unsafe\/incoherent/); });
});

test("(wrapper strict, Finding 2) finished_at requires a full RFC3339 timestamptz -- accepts Z and +/-HH:MM, rejects everything else", async () => {
  // ACCEPT: valid Z/z and STRICT +HH:MM/-HH:MM offsets (with and without fractional seconds).
  for (const ts of ["2026-08-14T09:31:57.861Z", "2026-08-14T09:31:57Z", "2026-08-14T09:31:57z", "2026-08-14T09:31:57.861+00:00", "2026-08-14T09:31:57+00:00", "2026-08-14T09:31:57+05:30", "2026-08-14T04:01:57-05:30"]) {
    await withRpc({ disposition: "finalized", cycle: goodTerminal("c1", { finished_at: ts }) }, async () => {
      assert.equal((await finalizeSyncCycle("c1")).disposition, "finalized", `must accept ${ts}`);
    });
  }
  // REJECT: colon-less / truncated numeric offsets (+0530/-0530/+05/-05), bare integers, date-only,
  // timezone-less, impossible calendar dates, out-of-range time/offset components, blanks, and non-strings.
  const bad = ["2026-08-14T09:31:57+0530", "2026-08-14T09:31:57-0530", "2026-08-14T09:31:57+05", "2026-08-14T09:31:57-05", "0", "1", "2026-08-14", "2026-08-14T09:31:57", "2026-02-30T00:00:00Z", "2026-13-01T00:00:00Z", "2026-08-14T25:00:00Z", "2026-08-14T09:60:00Z", "2026-08-14T09:31:61Z", "2026-08-14T09:31:57+25:00", "2026-08-14T09:31:57+00:70", "", "   ", 1723627917861, ["2026-08-14T09:31:57Z"], { at: "2026-08-14T09:31:57Z" }];
  for (const ts of bad) {
    await withRpc({ disposition: "finalized", cycle: goodTerminal("c1", { finished_at: ts }) }, async () => {
      await assert.rejects(() => finalizeSyncCycle("c1"), /valid finished_at/, `must reject ${JSON.stringify(ts)}`);
    });
  }
});

test("(wrapper strict) not-found/invalid-status carrying a cycle, and unknown/malformed dispositions, FAIL CLOSED", async () => {
  await withRpc({ disposition: "not-found", cycle: goodTerminal("c1") }, async () => { await assert.rejects(() => finalizeSyncCycle("c1"), /must not carry a cycle/); });
  await withRpc({ disposition: "invalid-status", cycle: goodRunning("c1") }, async () => { await assert.rejects(() => finalizeSyncCycle("c1"), /must not carry a cycle/); });
  await withRpc({ disposition: "weird", cycle: null }, async () => { await assert.rejects(() => finalizeSyncCycle("c1"), /unknown finalize disposition/); });
  await withRpc({ nope: 1 }, async () => { await assert.rejects(() => finalizeSyncCycle("c1"), /unknown finalize disposition/); });
  await withRpc([{ disposition: "finalized", cycle: goodTerminal("c1") }], async () => { assert.equal((await finalizeSyncCycle("c1")).disposition, "finalized"); }); // array-wrapped ok
  // transport failure throws (request() on non-OK)
  const orig = global.fetch;
  try { global.fetch = async () => new Response(JSON.stringify({ message: "boom" }), { status: 500 }); await assert.rejects(() => finalizeSyncCycle("c1"), /Supabase request failed/); } finally { global.fetch = orig; }
});

// ============================= audit: real files pass; contract fail-closed =============================
test("(audit) the real files pass; Migration 5 triggers valid=3 and the guard function proven", () => {
  const a = auditSchemaContract({ readFile: readFileWith() });
  assert.equal(a.ok, true); assert.equal(a.blockers.length, 0); assert.equal(a.requiredWrappers.ok, true);
  const m5 = a.matrix.find((r) => r.migration === M5);
  assert.ok(m5.rpcs.find((r) => r.name === "finalize_sync_cycle" && r.declared && r.paramsMatch && r.referencedByWrapper));
  assert.equal(m5.triggers.filter((t) => t.valid).length, 3);
  assert.deepEqual(m5.guardFunctions, [{ name: "reject_append_to_terminal_cycle", ok: true, problems: [] }]);
});

test("(audit fail-closed) missing Migration 5 / no objects / RPC_PARAM_MISMATCH / missing wrapper", () => {
  assert.ok(auditSchemaContract({ readFile: readFileWith({ [M5]: null }) }).blockers.some((b) => b.code === "MIGRATION_MISSING"));
  const empty = auditSchemaContract({ readFile: readFileWith({ [M5]: "-- nothing here" }) }).blockers.filter((b) => b.migration === M5).map((b) => b.code);
  assert.ok(empty.includes("RPC_MISSING"));
  assert.equal(empty.filter((c) => c === "TRIGGER_INVALID").length, 3);
  assert.ok(empty.includes("GUARD_FUNCTION_MISSING"));
  const bad = M5_SQL.replace("finalize_sync_cycle(p_cycle_id uuid)", "finalize_sync_cycle(p_cycle_id uuid, p_expect_status text default 'running')");
  assert.ok(auditSchemaContract({ readFile: readFileWith({ [M5]: bad }) }).blockers.some((b) => b.code === "RPC_PARAM_MISMATCH"));
  const strip = realSupabase().replace(/export async function finalizeSyncCycle/g, "async function finalizeSyncCycle_disabled");
  assert.ok(auditSchemaContract({ readFile: readFileWith({ "supabase.js": strip }) }).blockers.some((b) => b.code === "REQUIRED_WRAPPER_MISSING" && b.wrapper === "finalizeSyncCycle"));
});

// ============================= structural TRIGGER mutations (Finding 2) =============================
const auditCodes = (sql) => auditSchemaContract({ readFile: readFileWith({ [M5]: sql }) }).blockers.filter((b) => b.migration === M5).map((b) => b.code);
const TRIG = "before insert or update on public.sync_source_jobs\n  for each row execute function public.reject_append_to_terminal_cycle()";
test("(SQL trigger mutations) wrong timing / DELETE / INSERT-only / UPDATE-only / statement-level / wrong fn / wrong table / create-then-drop / comment fake all -> TRIGGER_INVALID", () => {
  const cases = {
    "wrong-timing": M5_SQL.replace(TRIG, "after insert or update on public.sync_source_jobs\n  for each row execute function public.reject_append_to_terminal_cycle()"),
    "delete-event": M5_SQL.replace(TRIG, "before insert or update or delete on public.sync_source_jobs\n  for each row execute function public.reject_append_to_terminal_cycle()"),
    "insert-only": M5_SQL.replace(TRIG, "before insert on public.sync_source_jobs\n  for each row execute function public.reject_append_to_terminal_cycle()"),
    "update-only": M5_SQL.replace(TRIG, "before update on public.sync_source_jobs\n  for each row execute function public.reject_append_to_terminal_cycle()"),
    "statement-level": M5_SQL.replace(TRIG, "before insert or update on public.sync_source_jobs\n  for each statement execute function public.reject_append_to_terminal_cycle()"),
    "wrong-function": M5_SQL.replace(TRIG, "before insert or update on public.sync_source_jobs\n  for each row execute function public.some_other_fn()"),
    "wrong-table": M5_SQL.replace(TRIG, "before insert or update on public.sync_report_jobs\n  for each row execute function public.reject_append_to_terminal_cycle()"),
    "create-then-drop": M5_SQL + "\ndrop trigger sync_source_jobs_no_append_terminal on public.sync_source_jobs;\n",
    "comment-fake": M5_SQL.replace(`create trigger sync_source_jobs_no_append_terminal\n  ${TRIG};`, `-- create trigger sync_source_jobs_no_append_terminal ${TRIG};`),
  };
  for (const [label, sql] of Object.entries(cases)) {
    assert.ok(auditCodes(sql).includes("TRIGGER_INVALID"), `${label} must yield TRIGGER_INVALID`);
  }
  // a control: the untouched SQL yields NO trigger blocker
  assert.ok(!auditCodes(M5_SQL).includes("TRIGGER_INVALID"), "the real trigger is valid");
});

// ============================= structural GUARD FUNCTION mutations (Finding 2) =============================
test("(SQL guard-function mutations) removed cycle_id guard / removed FOR SHARE / weakened terminal set / removed not-found all -> typed guard blocker", () => {
  const removedCycleId = M5_SQL.replace(/if TG_OP = 'UPDATE' and NEW\.cycle_id is distinct from OLD\.cycle_id then[\s\S]*?end if;/i, "-- (cycle_id guard removed)");
  assert.ok(auditCodes(removedCycleId).includes("GUARD_CYCLE_ID_IMMUTABLE_MISSING"), "removed cycle_id guard caught");
  const removedForShare = M5_SQL.replace("where id = NEW.cycle_id for share", "where id = NEW.cycle_id");
  assert.ok(auditCodes(removedForShare).includes("GUARD_FOR_SHARE_MISSING"), "removed FOR SHARE caught");
  const weakenedSet = M5_SQL.replace("v_status in ('succeeded', 'partial', 'failed')", "v_status in ('succeeded', 'partial')");
  assert.ok(auditCodes(weakenedSet).includes("GUARD_TERMINAL_REJECT_MISSING"), "weakened terminal set caught");
  const removedNotFound = M5_SQL.replace(/if not found then\s+raise exception 'parent sync cycle[\s\S]*?end if;/i, "-- (missing-parent guard removed)");
  assert.ok(auditCodes(removedNotFound).includes("GUARD_MISSING_PARENT_NOT_FAILCLOSED"), "removed missing-parent guard caught");
  // a string/comment cannot forge the guard: put the guard code ONLY inside a string literal
  const stringFake = M5_SQL.replace("v_status text;", "v_status text; v_fake text := 'NEW.cycle_id is distinct from OLD.cycle_id for share succeeded partial failed';").replace(/if TG_OP = 'UPDATE' and NEW\.cycle_id is distinct from OLD\.cycle_id then[\s\S]*?end if;/i, "-- removed real guard");
  assert.ok(auditCodes(stringFake).includes("GUARD_CYCLE_ID_IMMUTABLE_MISSING"), "a string literal cannot forge the cycle_id guard");
});

// Each guard condition must RAISE in ITS OWN IF block: a raise in a DIFFERENT block, moved before/after the
// block, or hidden in a comment/string must NOT satisfy it (the bug: a global RAISE regex passed spuriously).
test("(SQL guard-function BOUNDED-IF) each condition must RAISE inside its own block -- an unrelated raise never satisfies it", () => {
  const CYCLE = /if TG_OP = 'UPDATE' and NEW\.cycle_id is distinct from OLD\.cycle_id then[\s\S]*?end if;/;
  const NF = /if not found then\s+raise exception 'parent sync cycle[\s\S]*?end if;/;
  const TERM = /if v_status in \('succeeded', 'partial', 'failed'\) then[\s\S]*?end if;/;
  const cycHead = "if TG_OP = 'UPDATE' and NEW.cycle_id is distinct from OLD.cycle_id then";
  const nfHead = "if not found then";
  const termHead = "if v_status in ('succeeded', 'partial', 'failed') then";
  const block = (head, body) => `${head}\n    ${body}\n  end if;`;
  const has = (sql, code) => auditCodes(sql).includes(code);
  // 1) cycle_id block: raise replaced by NULL / PERFORM; comment + string raise fakes; raise moved AFTER the
  //    block; and the condition+raise split across SEPARATE blocks -- all must fail closed.
  assert.ok(has(M5_SQL.replace(CYCLE, block(cycHead, "null;")), "GUARD_CYCLE_ID_IMMUTABLE_MISSING"), "cycle_id: NULL instead of raise");
  assert.ok(has(M5_SQL.replace(CYCLE, block(cycHead, "perform 1;")), "GUARD_CYCLE_ID_IMMUTABLE_MISSING"), "cycle_id: PERFORM 1 instead of raise");
  assert.ok(has(M5_SQL.replace(CYCLE, block(cycHead, "-- raise exception 'fake';\n    null;")), "GUARD_CYCLE_ID_IMMUTABLE_MISSING"), "cycle_id: comment raise fake");
  assert.ok(has(M5_SQL.replace(CYCLE, block(cycHead, "perform 'raise exception';")), "GUARD_CYCLE_ID_IMMUTABLE_MISSING"), "cycle_id: string-literal raise fake");
  assert.ok(has(M5_SQL.replace(CYCLE, `${block(cycHead, "null;")}\n  raise exception 'moved';`), "GUARD_CYCLE_ID_IMMUTABLE_MISSING"), "cycle_id: raise moved outside the block");
  assert.ok(has(M5_SQL.replace(CYCLE, `${block(cycHead, "null;")}\n  ${block("if true then", "raise exception 'elsewhere';")}`), "GUARD_CYCLE_ID_IMMUTABLE_MISSING"), "cycle_id: condition and raise in separate blocks");
  // 2) missing-parent block: NULL / comment raise fake.
  assert.ok(has(M5_SQL.replace(NF, block(nfHead, "null;")), "GUARD_MISSING_PARENT_NOT_FAILCLOSED"), "not-found: NULL instead of raise");
  assert.ok(has(M5_SQL.replace(NF, block(nfHead, "-- raise exception 'x';\n    null;")), "GUARD_MISSING_PARENT_NOT_FAILCLOSED"), "not-found: comment raise fake");
  // 3) terminal block: PERFORM 1 / NULL.
  assert.ok(has(M5_SQL.replace(TERM, block(termHead, "perform 1;")), "GUARD_TERMINAL_REJECT_MISSING"), "terminal: PERFORM 1 instead of raise");
  assert.ok(has(M5_SQL.replace(TERM, block(termHead, "null;")), "GUARD_TERMINAL_REJECT_MISSING"), "terminal: NULL instead of raise");
  // control: the untouched guard function passes every bound check.
  assert.ok(!auditCodes(M5_SQL).some((c) => c.startsWith("GUARD_")), "the real guard function passes all bound checks");
});

// The rejection must be a DIRECT, UNCONDITIONAL raise on the guard's INITIAL true branch: a raise nested inside
// another IF, or in an ELSE / ELSIF branch, must NOT satisfy it (applied to all three guards).
test("(SQL guard-function BRANCH-AWARE) a raise nested in an inner IF / ELSE / ELSIF never satisfies a guard", () => {
  const CYCLE = /if TG_OP = 'UPDATE' and NEW\.cycle_id is distinct from OLD\.cycle_id then[\s\S]*?end if;/;
  const NF = /if not found then\s+raise exception 'parent sync cycle[\s\S]*?end if;/;
  const TERM = /if v_status in \('succeeded', 'partial', 'failed'\) then[\s\S]*?end if;/;
  const cycHead = "if TG_OP = 'UPDATE' and NEW.cycle_id is distinct from OLD.cycle_id then";
  const nfHead = "if not found then";
  const termHead = "if v_status in ('succeeded', 'partial', 'failed') then";
  const R = "raise exception 'x' using errcode = 'raise_exception';";
  // Each variant hides the raise off the guard's initial true branch.
  const nested = (head) => `${head}\n    if false then\n      ${R}\n    end if;\n  end if;`;   // raise in a nested IF
  const elseR = (head) => `${head}\n    null;\n  else\n    ${R}\n  end if;`;                      // raise in ELSE
  const elsifR = (head) => `${head}\n    null;\n  elsif true then\n    ${R}\n  end if;`;          // raise in ELSIF
  const has = (sql, code) => auditCodes(sql).includes(code);
  for (const [head, re, code] of [[cycHead, CYCLE, "GUARD_CYCLE_ID_IMMUTABLE_MISSING"], [nfHead, NF, "GUARD_MISSING_PARENT_NOT_FAILCLOSED"], [termHead, TERM, "GUARD_TERMINAL_REJECT_MISSING"]]) {
    assert.ok(has(M5_SQL.replace(re, nested(head)), code), `${code}: raise nested in an inner IF must fail`);
    assert.ok(has(M5_SQL.replace(re, elseR(head)), code), `${code}: raise in ELSE must fail`);
    assert.ok(has(M5_SQL.replace(re, elsifR(head)), code), `${code}: raise in ELSIF must fail`);
  }
  // control: the untouched guard function -- a direct unconditional raise on each initial branch -- still passes.
  assert.ok(!auditCodes(M5_SQL).some((c) => c.startsWith("GUARD_")), "the real guard function passes all branch-aware checks");
});

test("(SQL static) signature, running-guard, disposition set, and no-table-added invariants hold", () => {
  assert.match(M5_SQL, /create\s+or\s+replace\s+function\s+public\.finalize_sync_cycle\s*\(\s*p_cycle_id\s+uuid\s*\)/i);
  assert.match(M5_SQL, /where\s+id\s*=\s*p_cycle_id\s+and\s+status\s*=\s*'running'/i);
  for (const d of ["finalized", "already-terminal", "open-work", "not-found", "invalid-status"]) assert.ok(M5_SQL.includes(`'${d}'`));
  assert.doesNotMatch(M5_SQL, /create\s+table/i);
  assert.doesNotMatch(M5_SQL, /alter\s+table\s+public\.sync_cycles\s+add\s+column/i);
  assert.match(M5_SQL, /PREPARED -- UNAPPLIED/i);
});

async function main() {
  ({ buildSchedulerV2Runtime } = await import("../lib/server/sync/runtime-composition.js"));
  ({ auditSchemaContract, REQUIRED_WRAPPER_EXPORTS } = await import("../lib/server/sync/schema-contract.js"));
  ({ finalizeSyncCycle } = await import("../lib/server/supabase.js"));
  for (const t of tests) {
    try { await t.fn(); passed += 1; out("  ok  " + t.name); }
    catch (e) { out("FAIL  " + t.name); out(String(e && e.stack ? e.stack : e)); process.exitCode = 1; return; }
  }
  out("\n" + passed + " assertions passed");
}
main();
