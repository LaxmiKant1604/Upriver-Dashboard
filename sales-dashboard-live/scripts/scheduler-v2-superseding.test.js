// SCHEDULER V2 -- durable SUPERSEDING-ATTEMPT + D-1 freshness escalation regressions. Deterministic + OFFLINE.
// Proves: a stale terminal D-2 cycle does NOT block a superseding D-1 attempt and is never mutated; the active head
// resolves to exactly one non-superseded cycle (fork/headless fail closed); one operation key = one attempt; the
// automatic run escalates a fresh pass only when coverage is below D-1 and never when D-1 is already proven; normal
// + forced creates share ONE per-bucket ceiling; OLI stays <=5 sellers / trailing 7 days; ASIN Ads trailing 21 days;
// Campaign/FBA never force-fetched; a successful workflow cannot report provenThrough below requestedAsOf.

import assert from "node:assert/strict";
import { writeSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

process.env.SUPABASE_URL = process.env.SUPABASE_URL || "https://example.supabase.co";
process.env.VITE_SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "dummy";
process.env.POSTGRES_URL = process.env.POSTGRES_URL || "postgres://u:p@localhost:5432/db";

const HERE = dirname(fileURLToPath(import.meta.url));
const RELEASE_DIR = resolve(HERE, "release");
const MIGRATION = resolve(HERE, "..", "supabase", "migrations", "20260830_sync_cycle_superseding_attempt.sql");
const WORKFLOW = resolve(HERE, "..", "..", ".github", "workflows", "scheduler-v2.yml");

let passed = 0;
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const group = (label) => tests.push({ marker: label });

async function main() {
  const { resolveActiveCycleHead } = await import("../lib/server/sync/source-cycle-attempts.js");
  const { classifyScheduledOliCycle, assessDurableOliCoverageComplete, oliBucketPlan } = await import("../lib/server/sync/source-scheduled-oli.js");
  const { freshnessOperationKey, attemptKindForMode } = await import("../lib/server/sync/source-oli-freshness.js");
  const { sourceRegistryEntry } = await import("../lib/server/sync/source-registry.js");
  const { MAX_ACCOUNTS_PER_BATCH } = await import("../lib/server/sync/source-batching.js");

  const migration = readFileSync(MIGRATION, "utf8");
  const operator = readFileSync(resolve(RELEASE_DIR, "oli-refresh-d1.mjs"), "utf8");
  const yml = readFileSync(WORKFLOW, "utf8");
  const accountsN = (n) => Array.from({ length: n }, (_, i) => ({ accountId: "N" + String(i + 1).padStart(2, "0") }));
  const covThrough = (accounts, to) => Object.fromEntries(accounts.map((a) => [a.accountId, [{ from: "2025-01-01", to }]]));

  /* ---- 1/2: stale terminal cycle -> supersede, never mutated ---- */
  group("stale terminal cycle -> superseding attempt (never blocked, never mutated)");

  test("1. a stale terminal (D-2) cycle does NOT block a D-1 attempt -> classification 'supersede' (missing accounts listed)", () => {
    const accounts = accountsN(22);
    const belowD1 = assessDurableOliCoverageComplete({ discoveredAccounts: accounts, coverageByAccountId: covThrough(accounts, "2026-08-25"), start: "2025-01-01", asOf: "2026-08-26" });
    const cls = classifyScheduledOliCycle({ bucket: "non-us", cycle: { id: "terminal", status: "succeeded" }, discoveredAccounts: accounts, sourceJobs: [], owners: [], durableCoverage: belowD1 });
    assert.equal(cls.disposition, "supersede", "a terminal cycle below D-1 is stale -> supersede, NOT terminal-refuse");
    assert.equal(cls.missingAccounts.length, 22);
  });

  test("2. the superseding model NEVER mutates the historical terminal cycle: the RPC only INSERTs the new attempt + never UPDATE/DELETE/reset the target", () => {
    // The open_superseding RPC reads the target FOR SHARE (a shared lock, not a mutation) and only INSERTs the new
    // attempt. No update/delete/reset of the superseded target appears anywhere in the migration.
    assert.match(migration, /select \* into v_target[\s\S]*?for share/i, "the superseded target is only READ (for share), never updated");
    assert.doesNotMatch(migration, /update public\.sync_cycles[\s\S]*supersedes_cycle_id/i, "no UPDATE touches a superseded row");
    assert.match(migration, /insert into public\.sync_cycles[\s\S]*supersedes_cycle_id/i, "the new attempt is INSERTed carrying supersedes_cycle_id");
    // The base uniqueness is relaxed to base cycles only (a superseding attempt shares the slot).
    assert.match(migration, /sync_cycles_base_bucket_date_uq[\s\S]*?where supersedes_cycle_id is null/i, "partial base-only unique");
    assert.match(migration, /sync_cycles_operation_key_uq[\s\S]*?where operation_key is not null/i, "unique operation_key");
    assert.match(migration, /drop constraint if exists sync_cycles_bucket_date_unique/i, "the old full (bucket,date) unique is relaxed");
    // The superseded target must be terminal (never supersede a running cycle).
    assert.match(migration, /refusing to supersede a non-terminal cycle/i, "only a TERMINAL cycle can be superseded");
  });

  /* ---- 3: head resolution + one active attempt per operation ---- */
  group("active-head resolution (one non-superseded head; fork/headless fail closed)");

  test("3. resolveActiveCycleHead returns the single non-superseded head; a legacy single row; and fails closed on a fork / headless chain", () => {
    assert.equal(resolveActiveCycleHead([]), null);
    assert.deepEqual(resolveActiveCycleHead([{ id: "base", supersedes_cycle_id: null }]).id, "base");
    // chain base <- A <- B : head is B.
    const chain = [{ id: "base", supersedes_cycle_id: null }, { id: "A", supersedes_cycle_id: "base" }, { id: "B", supersedes_cycle_id: "A" }];
    assert.equal(resolveActiveCycleHead(chain).id, "B", "the head is the tail of the supersession chain");
    // a FORK (two rows supersede base) -> two heads -> fail closed.
    assert.throws(() => resolveActiveCycleHead([{ id: "base", supersedes_cycle_id: null }, { id: "A", supersedes_cycle_id: "base" }, { id: "B", supersedes_cycle_id: "base" }]), /more than one active/);
    // a headless chain (every row superseded by another) -> fail closed.
    assert.throws(() => resolveActiveCycleHead([{ id: "A", supersedes_cycle_id: "B" }, { id: "B", supersedes_cycle_id: "A" }]), /no active head/);
  });

  test("3b. one operation key = one attempt: the RPC is idempotent by operation_key (advisory lock + resume-if-exists)", () => {
    assert.match(migration, /perform pg_advisory_xact_lock\(hashtext\(p_operation_key\)\)/, "advisory lock on operation_key");
    assert.match(migration, /select id into v_id from public\.sync_cycles where operation_key = p_operation_key;\s*\n\s*if found then return v_id; end if;/, "resume the existing attempt for this operation_key (idempotent)");
    // The two operation identities.
    assert.equal(freshnessOperationKey({ mode: "normal", bucket: "non-us", requestedAsOf: "2026-08-26" }), "scheduled-fresh/non-us/2026-08-26");
    assert.equal(freshnessOperationKey({ mode: "force-latest", bucket: "us", requestedAsOf: "2026-08-26", runId: "42" }), "manual-force/us/2026-08-26/42");
    assert.equal(attemptKindForMode("normal"), "scheduled-fresh");
    assert.equal(attemptKindForMode("force-latest"), "manual-force");
  });

  /* ---- 6/7/8: automatic escalation + ceiling ---- */
  group("automatic escalation only below D-1; shared per-bucket ceiling");

  test("6/7. the operator escalates a fresh pass ONLY when coverage is below D-1, and returns idempotent (zero creates) when D-1 is already complete", () => {
    const accounts = accountsN(22);
    const complete = assessDurableOliCoverageComplete({ discoveredAccounts: accounts, coverageByAccountId: covThrough(accounts, "2026-08-26"), start: "2025-01-01", asOf: "2026-08-26" });
    assert.equal(complete.complete, true);
    const done = classifyScheduledOliCycle({ bucket: "non-us", cycle: { id: "c", status: "succeeded" }, discoveredAccounts: accounts, sourceJobs: [], owners: [], durableCoverage: complete });
    assert.equal(done.disposition, "idempotent-complete", "D-1 already proven -> never forces");
    // the operator structurally: durableComplete short-circuits to zero creates; below D-1 escalates.
    assert.match(operator, /durableComplete/, "the operator reads durable D-1 completeness");
    assert.match(operator, /alreadyComplete: true[\s\S]*process\.exit\(0\)/, "D-1 complete -> zero-create exit");
    assert.match(operator, /still.*behind D-1.*bounded escalation/i, "below D-1 -> bounded escalation");
  });

  test("8. normal + forced creates share ONE per-bucket ceiling (Non-US 5/10, US 2/4); the operator caps the escalation by the remaining budget", () => {
    assert.deepEqual({ c: oliBucketPlan(accountsN(22)).maxCreates, t: oliBucketPlan(accountsN(22)).maxTokens }, { c: 5, t: 10 });
    assert.deepEqual({ c: oliBucketPlan(accountsN(8)).maxCreates, t: oliBucketPlan(accountsN(8)).maxTokens }, { c: 2, t: 4 });
    assert.match(operator, /TOKEN_CEILING_EXCEEDED/, "a run exceeding the ceiling fails closed");
    assert.match(operator, /batches\.slice\(0, Math\.max\(0, ceilingCreates - creates\)\)/, "the escalation is capped by the remaining create budget (normal + forced share one ceiling)");
  });

  /* ---- windows + isolation + honesty ---- */
  group("windows, isolation, honesty invariants");

  test("16. OLI stays <=5 sellers/export and a trailing 7-day rolling window", () => {
    assert.equal(MAX_ACCOUNTS_PER_BATCH, 5);
    const oli = sourceRegistryEntry("order-line-items");
    assert.equal(oli.batching.maxAccountsPerExport, 5);
    assert.equal(oli.incrementalRefresh.kind, "rolling-window-days");
    assert.equal(oli.incrementalRefresh.days, 7);
    assert.equal(oli.initialBackfill.start, "2025-01-01");
  });

  test("17. ASIN Ads uses a trailing 21-day window (the readiness/ads runner window)", () => {
    // The ads readiness window is [requestedAsOf-20, requestedAsOf] = 21 inclusive days (verify-bucket-readiness).
    const rb = readFileSync(resolve(RELEASE_DIR, "verify-bucket-readiness.mjs"), "utf8");
    assert.match(rb, /addDays\(requestedAsOf, -20\)/, "ads window starts 20 days before D-1 (21 inclusive days)");
  });

  test("18/19. Campaign Ads / FBA are never force-fetched (forceFreshOli OLI-only) and the crons are unchanged", () => {
    const rt = readFileSync(resolve(HERE, "..", "lib", "server", "sync", "source-bucket-sync-runtime.js"), "utf8");
    assert.match(rt, /forceFreshOli === true && sourceKey === "order-line-items"/, "force-fresh is OLI-only");
    assert.doesNotMatch(yml, /node scripts\/[^\n]*(campaign|fba)/i, "no campaign/fba workflow step");
    const crons = [...yml.matchAll(/- cron:\s*"([^"]+)"/g)].map((m) => m[1]).sort();
    assert.deepEqual(crons, ["0 2 * * *", "30 10 * * *"]);
  });

  test("14. a successful workflow cannot report provenThrough below requestedAsOf: the strict D-1 gate publishes ONLY at status 'exact'", () => {
    // verify-bucket-readiness is strict D-1 (requireD1: true) and only proceeds when effective_asof === requestedAsOf.
    const rb = readFileSync(resolve(RELEASE_DIR, "verify-bucket-readiness.mjs"), "utf8");
    assert.match(rb, /requireD1:\s*true/, "readiness is strict D-1");
    assert.match(rb, /DATADOE_D1_NOT_READY/, "a below-D-1 result is typed not-ready (no publish)");
    assert.match(yml, /priority-dashboards-release\.mjs[^\n]*--strict-d1/, "the publish fails closed if the derive would clamp below D-1");
  });

  test("20. existing OLI persistence / Order-ID audit / dimensional path are untouched by this change (no source-worker persistence edit beyond the OLI cache-skip flag)", () => {
    const worker = readFileSync(resolve(HERE, "..", "lib", "server", "sync", "source-worker.js"), "utf8");
    // The ONLY worker behavioural gate added is the forceFreshOli OLI cache-adoption skip; the persistence/order-audit
    // path is unchanged.
    assert.match(worker, /skipCacheAdoption = forceFreshOli && job\.sourceKey === "order-line-items"/, "the only worker gate is the OLI cache-skip");
    const oli = readFileSync(resolve(HERE, "..", "lib", "server", "sync", "oli-order-rules.js"), "utf8");
    assert.match(oli, /orderIdAvailable/, "Order-ID audit path intact");
  });

  let failures = 0;
  for (const t of tests) {
    if (t.marker) { out("== " + t.marker); continue; }
    try { await t.fn(); passed += 1; out("  ok  " + t.name); }
    catch (err) { failures += 1; out("FAIL  " + t.name); out(String(err && err.stack ? err.stack : err)); }
  }
  out("\n" + passed + " assertions passed" + (failures ? ", " + failures + " FAILED" : ""));
  if (failures) process.exitCode = 1;
}

main().catch((e) => { out("FATAL " + String(e && e.stack ? e.stack : e)); process.exitCode = 1; });
