// Scheduler v2 -- cycle finalization PRODUCTION WIRING (deterministic OFFLINE).
//
// Proves Blocker-1 wiring #1/#2/#4: the REAL composed production runtime exposes finalizeCycle; the static
// audit/preflight FAIL CLOSED when Migration 5 / the RPC / the wrapper / the triggers are missing; the
// finalizeSyncCycle wrapper POSTs the exact RPC parameter and returns the TOTAL typed disposition (and fails
// closed on transport/malformed responses); and Migration 5's ACTUAL SQL carries the hardened guards
// (no p_expect_status, cycle_id immutable, terminal-parent rejection, deadlock-safe FOR UPDATE/FOR SHARE).
// No network, DataDoe, or Supabase I/O (global fetch is mocked).
//
// 7-bit ASCII, LF. Run: node scripts/cycle-finalize-wiring.test.js

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { writeSync } from "node:fs";

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };

// Supabase config captured at module load -> set BEFORE importing supabase.js (done via dynamic import in main).
process.env.SUPABASE_URL = "https://finalize-test.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-svc-role";
process.env.DATADOE_API_KEY = "test-primary";

let buildSchedulerV2Runtime, auditSchemaContract, REQUIRED_WRAPPER_EXPORTS, finalizeSyncCycle;

const realMigration = (n) => readFileSync(new URL(`../supabase/migrations/${n}`, import.meta.url), "utf8");
const realSupabase = () => readFileSync(new URL("../lib/server/supabase.js", import.meta.url), "utf8");
const M5 = "20260815_sync_cycle_finalize.sql";
const M5_SQL = realMigration(M5);
// A readFile that returns real files, with optional per-name overrides (null => "missing").
const readFileWith = (over = {}) => (name) => {
  if (name in over) { if (over[name] == null) throw new Error("missing"); return over[name]; }
  return name === "supabase.js" ? realSupabase() : realMigration(name);
};

// ---- 1) the REAL production composed store exposes finalizeCycle ----
test("(wiring) buildSchedulerV2Runtime's composed production store contains finalizeCycle", () => {
  const rt = buildSchedulerV2Runtime({ connections: [{ id: "primary", apiKey: "k" }] });
  assert.equal(typeof rt.store.finalizeCycle, "function", "the composed store exposes finalizeCycle");
  assert.ok(REQUIRED_WRAPPER_EXPORTS.includes("finalizeSyncCycle"), "finalizeSyncCycle is a REQUIRED wrapper");
});

// ---- 2) preflight/audit fail closed if Migration 5 / RPC / wrapper / triggers are missing ----
test("(preflight) the full contract audit passes with the real files", () => {
  const a = auditSchemaContract({ readFile: readFileWith() });
  assert.equal(a.ok, true, "real files -> audit passes"); assert.equal(a.blockers.length, 0);
  assert.equal(a.requiredWrappers.ok, true);
  const m5 = a.matrix.find((r) => r.migration === M5);
  assert.ok(m5.rpcs.find((r) => r.name === "finalize_sync_cycle" && r.declared && r.paramsMatch && r.referencedByWrapper));
  assert.equal(m5.triggers.filter((t) => t.declared).length, 3, "all 3 append-guard triggers declared");
});

test("(preflight fail-closed) a MISSING Migration 5 file -> MIGRATION_MISSING", () => {
  const a = auditSchemaContract({ readFile: readFileWith({ [M5]: null }) });
  assert.equal(a.ok, false);
  assert.ok(a.blockers.some((b) => b.code === "MIGRATION_MISSING" && b.migration === M5));
});

test("(preflight fail-closed) Migration 5 without the RPC / triggers -> RPC_MISSING + TRIGGER_MISSING x3", () => {
  const a = auditSchemaContract({ readFile: readFileWith({ [M5]: "-- no objects declared here" }) });
  assert.equal(a.ok, false);
  const codes = a.blockers.filter((b) => b.migration === M5).map((b) => b.code).sort();
  assert.ok(codes.includes("RPC_MISSING"), "RPC missing detected");
  assert.equal(codes.filter((c) => c === "TRIGGER_MISSING").length, 3, "all 3 triggers detected missing");
});

test("(preflight fail-closed) an RPC with a WRONG parameter (p_expect_status re-added) -> RPC_PARAM_MISMATCH", () => {
  const bad = M5_SQL.replace("finalize_sync_cycle(p_cycle_id uuid)", "finalize_sync_cycle(p_cycle_id uuid, p_expect_status text default 'running')");
  const a = auditSchemaContract({ readFile: readFileWith({ [M5]: bad }) });
  assert.ok(a.blockers.some((b) => b.code === "RPC_PARAM_MISMATCH" && b.rpc === "finalize_sync_cycle"),
    "the contract pins params to [p_cycle_id] only -> re-adding p_expect_status fails closed");
});

test("(preflight fail-closed) a wrapper source missing finalizeSyncCycle -> REQUIRED_WRAPPER_MISSING + WRAPPER_MISSING", () => {
  const strippedSupabase = realSupabase().replace(/export async function finalizeSyncCycle/g, "async function finalizeSyncCycle_disabled");
  const a = auditSchemaContract({ readFile: readFileWith({ "supabase.js": strippedSupabase }) });
  assert.equal(a.requiredWrappers.ok, false);
  assert.ok(a.blockers.some((b) => b.code === "REQUIRED_WRAPPER_MISSING" && b.wrapper === "finalizeSyncCycle"));
  assert.ok(a.blockers.some((b) => b.code === "WRAPPER_MISSING" && b.wrapper === "finalizeSyncCycle"));
});

// ---- 3) the finalizeSyncCycle wrapper: exact RPC param, typed ack, safe failure (fetch-mocked) ----
test("(wrapper) finalizeSyncCycle POSTs exactly { p_cycle_id } to /rpc/finalize_sync_cycle and returns the typed disposition", async () => {
  const seen = [];
  const orig = global.fetch;
  try {
    global.fetch = async (url, opts = {}) => { seen.push({ url: String(url), method: opts.method, body: opts.body }); return new Response(JSON.stringify({ disposition: "finalized", cycle: { id: "c1", status: "succeeded" } }), { status: 200 }); };
    const r = await finalizeSyncCycle("c1");
    assert.deepEqual(r, { disposition: "finalized", cycle: { id: "c1", status: "succeeded" } });
    assert.match(seen[0].url, /\/rest\/v1\/rpc\/finalize_sync_cycle$/, "calls the finalize RPC endpoint");
    assert.equal(seen[0].method, "POST");
    assert.deepEqual(JSON.parse(seen[0].body), { p_cycle_id: "c1" }, "exact single RPC param p_cycle_id (no expect-status)");
  } finally { global.fetch = orig; }
});

test("(wrapper) each typed disposition round-trips; PostgREST array-wrapping is unwrapped", async () => {
  const orig = global.fetch;
  try {
    for (const d of ["finalized", "already-terminal", "open-work", "not-found", "invalid-status"]) {
      global.fetch = async () => new Response(JSON.stringify({ disposition: d, cycle: null }), { status: 200 });
      assert.equal((await finalizeSyncCycle("c")).disposition, d);
    }
    global.fetch = async () => new Response(JSON.stringify([{ disposition: "finalized", cycle: { id: "c" } }]), { status: 200 });
    assert.equal((await finalizeSyncCycle("c")).disposition, "finalized", "array-wrapped rows[0] handled");
  } finally { global.fetch = orig; }
});

test("(wrapper) safe failure: a malformed/unknown disposition and a transport error both THROW (fail closed)", async () => {
  const orig = global.fetch;
  try {
    global.fetch = async () => new Response(JSON.stringify({ disposition: "weird", cycle: null }), { status: 200 });
    await assert.rejects(() => finalizeSyncCycle("c"), /malformed or unknown finalize disposition/);
    global.fetch = async () => new Response(JSON.stringify({ nope: 1 }), { status: 200 });
    await assert.rejects(() => finalizeSyncCycle("c"), /malformed or unknown finalize disposition/);
    global.fetch = async () => new Response(JSON.stringify({ message: "boom" }), { status: 500 });
    await assert.rejects(() => finalizeSyncCycle("c"), /Supabase request failed/); // request() throws on non-OK
  } finally { global.fetch = orig; }
});

// ---- 4) STATIC mutation tests against the ACTUAL Migration 5 SQL (not only the in-memory model) ----
test("(SQL) finalize_sync_cycle takes ONLY p_cycle_id (no p_expect_status) and internally requires status='running'", () => {
  // The EXACT signature has a single parameter -- proving no p_expect_status can smuggle a non-running
  // expectation (the audit's RPC_PARAM_MISMATCH test also pins the contract params to [p_cycle_id]).
  assert.match(M5_SQL, /create\s+or\s+replace\s+function\s+public\.finalize_sync_cycle\s*\(\s*p_cycle_id\s+uuid\s*\)/i,
    "signature is exactly (p_cycle_id uuid)");
  assert.match(M5_SQL, /where\s+id\s*=\s*p_cycle_id\s+and\s+status\s*=\s*'running'/i, "the UPDATE is guarded on status='running'");
  // the typed dispositions are all present
  for (const d of ["finalized", "already-terminal", "open-work", "not-found", "invalid-status"]) {
    assert.ok(M5_SQL.includes(`'${d}'`), `disposition '${d}' present`);
  }
});

test("(SQL) the append-guard trigger forbids cycle_id changes AND rejects a terminal parent", () => {
  assert.match(M5_SQL, /TG_OP\s*=\s*'UPDATE'\s+and\s+NEW\.cycle_id\s+is\s+distinct\s+from\s+OLD\.cycle_id/i,
    "child row cycle_id is immutable on UPDATE (cannot move a row between cycles / out of a terminal cycle)");
  assert.match(M5_SQL, /v_status\s+in\s*\(\s*'succeeded',\s*'partial',\s*'failed'\s*\)/i, "terminal parent -> reject");
  assert.match(M5_SQL, /raise\s+exception[^;]*terminal/i, "raises on a terminal parent");
});

test("(SQL) deadlock-safe lock ordering: finalize FOR UPDATE, trigger FOR SHARE, both on the cycle row", () => {
  assert.match(M5_SQL, /select\s+status\s+into\s+v_status\s+from\s+public\.sync_cycles\s+where\s+id\s*=\s*p_cycle_id\s+for\s+update/i,
    "finalize locks the cycle row FOR UPDATE");
  assert.match(M5_SQL, /select\s+status\s+into\s+v_status\s+from\s+public\.sync_cycles\s+where\s+id\s*=\s*NEW\.cycle_id\s+for\s+share/i,
    "the trigger locks the same cycle row FOR SHARE");
  // all three child tables carry the trigger
  for (const t of ["sync_source_jobs", "sync_source_job_owners", "sync_report_jobs"]) {
    assert.ok(new RegExp(`create\\s+trigger\\s+${t}_no_append_terminal[^;]*on\\s+public\\.${t}\\b`, "i").test(M5_SQL), `${t} append-guard trigger present`);
  }
});

test("(SQL) migrations 1-4 are NOT touched by this migration (it adds no table/column; sync_cycles pre-exists)", () => {
  assert.doesNotMatch(M5_SQL, /create\s+table/i, "Migration 5 creates no table");
  assert.doesNotMatch(M5_SQL, /alter\s+table\s+public\.sync_cycles\s+add\s+column/i, "Migration 5 adds no sync_cycles column");
  assert.match(M5_SQL, /PREPARED\s*--\s*UNAPPLIED|PREPARED -- UNAPPLIED/i, "clearly marked PREPARED -- UNAPPLIED");
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
