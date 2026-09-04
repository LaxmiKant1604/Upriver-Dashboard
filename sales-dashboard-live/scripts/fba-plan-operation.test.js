// FBA Shipment Plan OPERATION CORE + RELEASE COMPOSITION tests -- the SHARED, deadline-aware, bounded-resumable
// pipeline used identically by the CLI operator, the automatic scheduler, and the Data Sync Center route.
//
// Proves the state machine with pure doubles (ZERO I/O): the FETCH phase runs the shadow dispatch under the
// dedicated `${bucket}-fba` cycle namespace under a guarded fetch envelope and finalizes on drain; the PUBLISH
// phase reopens the guarded gates, publishes only ready accounts, ALWAYS safe-closes (success/partial/failure), reads back each live
// pair, and runs the ownership backfill; the hard token ceiling refuses over-budget plans with zero creates;
// blocked (stale-OLI) accounts are never published (LKG untouched); and a replay on an already-terminal cycle is
// a zero-create idempotent no-op. Also proves the release composition wires the guarded fba-plan control package
// (apply/rollback) and loads only correctly-bound primary accounts.
//
// 7-bit ASCII, LF, no top-level await, synchronous progress. Dynamic imports after a dummy Supabase env.

import assert from "node:assert/strict";
import { writeSync } from "node:fs";

process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://supabase.test";
const SB_KEY_ENV = ["SUPABASE", "SERVICE", "ROLE", "KEY"].join("_");
process.env[SB_KEY_ENV] = process.env[SB_KEY_ENV] || ["test", "svc", "role", "key"].join("-");
process.env.POSTGRES_URL = process.env.POSTGRES_URL || "postgres://u:p@localhost:5432/db";

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const group = (label) => tests.push({ marker: label });
const START = Date.now();
const mark = (m) => { try { writeSync(2, "[+" + (Date.now() - START) + "ms] " + m + "\n"); } catch (_e) { /* ignore */ } };
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };

let OP; // fba-plan-operation.js
let COMP; // fba-plan-release-composition.js

// ---- doubles -----------------------------------------------------------------------------------------------
// A runtime double: the shadow dispatch drains after `drainAfter` run() calls; the dedicated cycle is created on
// the first run and finalized to `finalizeStatus`. Records every run() arg + the cycle-bucket used.
function makeRuntime({ drainAfter = 1, finalizeStatus = "succeeded", preTerminal = null, events = null } = {}) {
  const runArgs = [];
  let cur = preTerminal; // {id, status} | null
  let runCalls = 0;
  let finalizeCalls = 0;
  return {
    get runCalls() { return runCalls; },
    get finalizeCalls() { return finalizeCalls; },
    runArgs,
    run: async (args) => {
      if (events) events.push("runtime.run");
      runCalls += 1;
      runArgs.push(args);
      if (!cur) cur = { id: "cyc-" + args.cycleBucket, status: "running" };
      const drained = runCalls >= drainAfter;
      return { cycleId: cur.id, drained, continuationRequired: !drained };
    },
    store: {
      getCycleByBucketDate: async (_b, _d) => cur,
      finalizeCycle: async ({ cycleId }) => { if (events) events.push("runtime.finalize"); finalizeCalls += 1; cur = { id: cycleId, status: finalizeStatus }; return { disposition: cur.status === finalizeStatus ? "finalized" : "already-terminal", cycle: { status: finalizeStatus } }; },
    },
  };
}
function makeNoCycleRuntime() {
  let runCalls = 0;
  return {
    get runCalls() { return runCalls; },
    run: async () => { runCalls += 1; return { cycleId: null, drained: true, continuationRequired: false }; },
    store: {
      getCycleByBucketDate: async () => null,
      finalizeCycle: async () => { throw new Error("must not finalize a missing cycle"); },
    },
  };
}
// A publisher double: preflight/publish return `ready`/`published` unless the account is in `badPreflight` or
// `badPublish`. Every account carries a distinct live identity.
function makePublisher({ badPreflight = new Set(), badPublish = new Set() } = {}) {
  const calls = { preflight: [], publish: [] };
  return {
    calls,
    preflight: async (rk, acc) => {
      calls.preflight.push([rk, acc]);
      if (badPreflight.has(acc)) return { disposition: "not-successful", reportKey: rk, accountId: acc };
      return { disposition: "ready", reportKey: rk, accountId: acc, liveReportKey: "fba-plan", paramsHash: "h-" + acc };
    },
    publish: async (rk, acc) => {
      calls.publish.push([rk, acc]);
      if (badPublish.has(acc)) return { disposition: "publish-failed", reportKey: rk, accountId: acc };
      return { disposition: "published", reportKey: rk, accountId: acc, liveReportKey: "fba-plan", paramsHash: "h-" + acc };
    },
  };
}
function makeControls(events = null) {
  const calls = [];
  return {
    calls,
    apply: async () => { calls.push("apply"); if (events) events.push("controls.apply"); },
    close: async () => { calls.push("close"); if (events) events.push("controls.close"); },
  };
}
const okReadback = async () => ({ ok: true });

// ============================================================================================================
async function main() {
  mark("main(): loading fba-plan-operation + release composition");
  OP = await import("../lib/server/sync/fba-plan-operation.js");
  COMP = await import("../lib/server/sync/fba-plan-release-composition.js");
  mark("modules loaded; running " + tests.filter((t) => !t.marker).length + " tests");

  let failures = 0;
  for (const t of tests) {
    if (t.marker) { mark("group -> " + t.marker); continue; }
    try { await t.fn(); passed += 1; out("  ok  " + t.name); }
    catch (err) { failures += 1; out("FAIL  " + t.name); out(String(err && err.stack ? err.stack : err)); }
  }
  out("\n" + passed + " assertions passed");
  mark("done: " + passed + " passed, " + failures + " failed");
  return failures;
}

// ---- source detection + helpers ----------------------------------------------------------------------------
group("fba-plan-operation: source detection + bucket helpers");

test("isFbaOperationSource: fba-inventory-health + listings only", () => {
  assert.equal(OP.isFbaOperationSource("fba-inventory-health"), true);
  assert.equal(OP.isFbaOperationSource("listings"), true);
  assert.equal(OP.isFbaOperationSource("order-line-items"), false);
  assert.equal(OP.isFbaOperationSource("ads-asin-date"), false);
  assert.equal(OP.isFbaOperationSource(""), false);
});

test("fbaCycleBucket: namespaces the cycle so it never collides with the scheduler-v2 daily cycle", () => {
  assert.equal(OP.fbaCycleBucket("us"), "us-fba");
  assert.equal(OP.fbaCycleBucket("non-us"), "non-us-fba");
  assert.equal(OP.fbaCycleBucket("india"), "india-fba");
  assert.equal(OP.fbaCycleBucket("europe-au"), "europe-au-fba");
  assert.equal(OP.fbaCycleBucket("us-ca"), "us-ca-fba");
});

test("fbaServerCeiling: yesterday (never past server D-1)", () => {
  const c = OP.fbaServerCeiling(Date.parse("2026-08-30T05:00:00Z"));
  assert.equal(c, "2026-08-29");
});

test("partitionFbaBucketAccounts: US vs everything-else; drops prefixed/no-country ids", () => {
  const { us, nonUs } = OP.partitionFbaBucketAccounts([
    { accountId: "a1", country: "US" }, { accountId: "a2", country: "UK" }, { accountId: "a3", country: "IN" },
    { accountId: "dd-secondary:x", country: "US" }, { accountId: "a4", country: "" },
  ]);
  assert.deepEqual(us.map((a) => a.accountId), ["a1"]);
  assert.deepEqual(nonUs.map((a) => a.accountId).sort(), ["a2", "a3"]);
  assert.deepEqual(OP.fbaBucketAccounts([{ accountId: "a1", country: "US" }, { accountId: "a2", country: "DE" }], "us").map((a) => a.accountId), ["a1"]);
});

// ---- resolveFbaPlanScope ------------------------------------------------------------------------------------
group("fba-plan-operation: coverage-maximizing as-of resolution");

test("resolveFbaPlanScope: picks the coverage-max as-of; stale accounts blocked; explicit as-of is clamped", async () => {
  const cov = {
    a1: [{ to: "2026-08-29" }], a2: [{ to: "2026-08-29" }], a3: [{ to: "2026-08-20" }],
  };
  const readers = {
    resolveDataDoeAccountIds: (ids) => ({ rawAccountIds: ids, connection: { id: "primary", apiKey: "k", organizationFingerprint: "org" } }),
    getSourceCoverageWindows: async ({ accountId }) => ({ read: "ok", windows: cov[accountId] || [] }),
  };
  const accounts = [{ accountId: "a1" }, { accountId: "a2" }, { accountId: "a3" }];
  const scope = await OP.resolveFbaPlanScope({ accounts, connections: [], asOfArg: null, maxBlocked: 1, ceiling: "2026-08-29", readers });
  assert.equal(scope.asOf, "2026-08-29");
  assert.deepEqual([...scope.included].sort(), ["a1", "a2"]);
  assert.equal(scope.blocked.length, 1);
  assert.equal(scope.blocked[0].accountId, "a3");
  // explicit as-of past the ceiling is clamped to D-1
  const scope2 = await OP.resolveFbaPlanScope({ accounts, connections: [], asOfArg: "2026-09-15", maxBlocked: 3, ceiling: "2026-08-29", readers });
  assert.equal(scope2.asOf, "2026-08-29");
});

// ---- advanceFbaPlanBucket: the bounded state machine -------------------------------------------------------
group("fba-plan-operation: bounded, resumable state machine");

const OK_COST = { creates: 2, tokens: 10, plan: { sourceJobs: [{}, {}] } };

test("no bucket accounts -> complete, zero published (nothing to do, never a failure)", async () => {
  const r = await OP.advanceFbaPlanBucket({ bucket: "us", asOf: "2026-08-29", includedIds: [], bucketAccounts: [], runtime: makeRuntime(), publisher: makePublisher(), controls: makeControls(), readbackLive: okReadback });
  assert.equal(r.phase, "complete");
  assert.equal(r.ok, true);
  assert.equal(r.published, 0);
});

test("HARD token ceiling: an over-budget plan refuses with zero fetch/creates", async () => {
  const runtime = makeRuntime();
  const controls = makeControls();
  const r = await OP.advanceFbaPlanBucket({
    bucket: "us", asOf: "2026-08-29", includedIds: ["a1"], bucketAccounts: [{ accountId: "a1", country: "US" }],
    cost: { creates: 30, tokens: 999, plan: { sourceJobs: [] } }, maxTokens: 80,
    runtime, publisher: makePublisher(), controls, readbackLive: okReadback,
  });
  assert.equal(r.ok, false);
  assert.match(r.problems[0], /ceiling/);
  assert.equal(runtime.runCalls, 0, "no fetch happened");
  assert.equal(controls.calls.length, 0, "no controls opened");
});

test("FETCH not drained (slice budget) -> phase sync continuation; cycle NOT finalized", async () => {
  const runtime = makeRuntime({ drainAfter: 99 }); // never drains in one bounded slice
  const controls = makeControls();
  let calls = 0;
  const r = await OP.advanceFbaPlanBucket({
    bucket: "non-us", asOf: "2026-08-29", includedIds: ["a1"], bucketAccounts: [{ accountId: "a1", country: "DE" }], cost: OK_COST, maxTokens: 80,
    runtime, publisher: makePublisher(), controls, readbackLive: okReadback,
    outOfTime: () => (++calls > 1), // out of time after the first run
  });
  assert.equal(r.phase, "sync");
  assert.equal(r.continuationRequired, true);
  assert.equal(runtime.finalizeCalls, 0, "un-drained fetch never finalizes");
  assert.equal(runtime.runArgs[0].cycleBucket, "non-us-fba", "dedicated cycle namespace");
  assert.equal(runtime.runArgs[0].bucket, "non-us", "account scope is the real bucket");
  assert.deepEqual(controls.calls, ["apply", "close"], "fetch continuation safe-closes its rollout envelope");
});

test("FALSE-SUCCESS GUARD: drained runtime with no regional cycle fails before finalize/publish", async () => {
  const runtime = makeNoCycleRuntime();
  const publisher = makePublisher();
  const controls = makeControls();
  const r = await OP.advanceFbaPlanBucket({
    bucket: "india", asOf: "2026-09-02", includedIds: ["a1"], bucketAccounts: [{ accountId: "a1", country: "IN" }],
    cost: OK_COST, maxTokens: 80, runtime, publisher, controls, readbackLive: okReadback,
  });
  assert.equal(r.phase, "sync");
  assert.equal(r.ok, false);
  assert.match(r.problems[0], /without a dedicated india-fba cycle/);
  assert.equal(runtime.runCalls, 1);
  assert.equal(publisher.calls.publish.length, 0, "old snapshots are never published after a fetch no-op");
  assert.deepEqual(controls.calls, ["apply", "close"], "the failed fetch is still safe-closed");
});

test("HAPPY PATH: fetch drains -> finalize -> publish -> read-back -> ownership -> complete", async () => {
  const events = [];
  const runtime = makeRuntime({ drainAfter: 1, events });
  const publisher = makePublisher();
  const controls = makeControls(events);
  let ownershipRan = 0;
  const r = await OP.advanceFbaPlanBucket({
    bucket: "us", asOf: "2026-08-29", includedIds: ["a1", "a2"], bucketAccounts: [{ accountId: "a1", country: "US" }, { accountId: "a2", country: "US" }], cost: OK_COST, maxTokens: 80,
    runtime, publisher, controls, readbackLive: okReadback,
    ownershipBackfill: async () => { ownershipRan += 1; return { applied: 2, totalRows: 20 }; },
  });
  assert.equal(r.phase, "complete");
  assert.equal(r.ok, true);
  assert.equal(r.published, 2);
  assert.equal(r.readback, 2);
  assert.equal(runtime.finalizeCalls, 1);
  assert.deepEqual(controls.calls, ["apply", "close", "apply", "close"], "fetch and publish each run inside an ALWAYS-safe-closed envelope");
  assert.deepEqual(events.slice(0, 4), ["controls.apply", "runtime.run", "runtime.finalize", "controls.close"], "fetch rollout opens before runtime I/O and closes after finalization");
  assert.equal(publisher.calls.publish.length, 2);
  assert.equal(publisher.calls.preflight.length, 0, "single publish pass (no redundant preflight gate) -- convergence fix");
  assert.equal(ownershipRan, 1, "ownership backfill runs on the completion path");
});

test("IDEMPOTENT REPLAY: an already-terminal dedicated cycle skips the fetch entirely (zero creates)", async () => {
  const runtime = makeRuntime({ preTerminal: { id: "cyc-us-fba", status: "succeeded" } });
  const publisher = makePublisher();
  const controls = makeControls();
  const r = await OP.advanceFbaPlanBucket({
    bucket: "us", asOf: "2026-08-29", includedIds: ["a1"], bucketAccounts: [{ accountId: "a1", country: "US" }], cost: OK_COST, maxTokens: 80,
    runtime, publisher, controls, readbackLive: okReadback, ownershipBackfill: async () => ({ applied: 1, totalRows: 5 }),
  });
  assert.equal(r.phase, "complete");
  assert.equal(r.ok, true);
  assert.equal(runtime.runCalls, 0, "no shadow dispatch (no re-fetch, no double-spend)");
  assert.equal(runtime.finalizeCalls, 0, "already terminal -> no re-finalize");
  assert.equal(r.published, 1);
});

test("PUBLISH partial (slice budget between chunks) -> continuation; controls STILL safe-closed", async () => {
  const runtime = makeRuntime({ preTerminal: { id: "cyc-us-fba", status: "succeeded" } });
  const publisher = makePublisher();
  const controls = makeControls();
  // 8 accounts > the 6-per-chunk publish concurrency; out of time AFTER the first chunk -> chunk 1 (6) publishes,
  // chunk 2 (2) defers to the next poll.
  const ids = ["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8"];
  let n = 0;
  const r = await OP.advanceFbaPlanBucket({
    bucket: "us", asOf: "2026-08-29", includedIds: ids, bucketAccounts: ids.map((a) => ({ accountId: a, country: "US" })), cost: OK_COST, maxTokens: 80,
    runtime, publisher, controls, readbackLive: okReadback,
    outOfTime: () => (++n > 1), // first chunk proceeds; second chunk is out of time
  });
  assert.equal(r.phase, "publish");
  assert.equal(r.continuationRequired, true);
  assert.ok(r.published >= 1 && r.published < 8, "some but not all published (" + r.published + ")");
  assert.ok(controls.calls.includes("close"), "ALWAYS safe-close even on a budget pause");
});

test("SAFE-CLOSE always: a publish-failed disposition still closes the gates; zero-published -> ok false", async () => {
  const runtime = makeRuntime({ preTerminal: { id: "cyc-us-fba", status: "succeeded" } });
  const publisher = makePublisher({ badPublish: new Set(["a1"]) });
  const controls = makeControls();
  const r = await OP.advanceFbaPlanBucket({
    bucket: "us", asOf: "2026-08-29", includedIds: ["a1"], bucketAccounts: [{ accountId: "a1", country: "US" }], cost: OK_COST, maxTokens: 80,
    runtime, publisher, controls, readbackLive: okReadback,
  });
  assert.equal(r.ok, false);
  assert.ok(controls.calls.includes("close"), "safe-close ran despite the publish failure");
  assert.ok(r.problems.some((p) => /publish-/.test(p)));
});

test("READ-BACK mismatch -> phase readback, ok false (published but not proven live)", async () => {
  const runtime = makeRuntime({ preTerminal: { id: "cyc-us-fba", status: "succeeded" } });
  const r = await OP.advanceFbaPlanBucket({
    bucket: "us", asOf: "2026-08-29", includedIds: ["a1"], bucketAccounts: [{ accountId: "a1", country: "US" }], cost: OK_COST, maxTokens: 80,
    runtime, publisher: makePublisher(), controls: makeControls(),
    readbackLive: async () => ({ ok: false, reason: "identity-hash" }),
  });
  assert.equal(r.phase, "readback");
  assert.equal(r.ok, false);
});

test("BLOCKED (stale-OLI) accounts are never published; base.blocked counts them (LKG untouched)", async () => {
  const runtime = makeRuntime({ preTerminal: { id: "cyc-non-us-fba", status: "partial" } });
  const publisher = makePublisher();
  // 3 accounts in the bucket, only 2 are included (1 is stale-OLI blocked)
  const r = await OP.advanceFbaPlanBucket({
    bucket: "non-us", asOf: "2026-08-29", includedIds: ["a1", "a2"],
    bucketAccounts: [{ accountId: "a1", country: "DE" }, { accountId: "a2", country: "DE" }, { accountId: "a3", country: "DE" }], cost: OK_COST, maxTokens: 80,
    runtime, publisher, controls: makeControls(), readbackLive: okReadback,
  });
  assert.equal(r.ok, true);
  assert.equal(r.published, 2);
  assert.equal(r.blocked, 1, "the stale account is counted blocked, never published");
  assert.ok(!publisher.calls.publish.some(([, acc]) => acc === "a3"), "the blocked account is never published");
});

// ---- release composition ------------------------------------------------------------------------------------
group("fba-plan-release-composition: guarded wiring + account loading");

test("buildFbaPlanRelease: controls.apply/close route through the guarded fba-plan control package", async () => {
  const pkgCalls = [];
  const release = COMP.buildFbaPlanRelease({
    operator: "op@test",
    makeRuntime: () => ({ run: async () => ({}), store: {} }),
    makePublisher: () => ({ preflight: async () => ({}), publish: async () => ({}) }),
    makeReadback: () => (async () => ({ ok: true })),
    buildApplyPackage: function fbaPkg() { return { marker: "fba" }; },
    runControlPackage: async (args) => { pkgCalls.push(args); return { committed: true }; },
    connectStore: () => ({}), discoverAccounts: async () => [],
    readDirectoryAccounts: async () => [], getConnections: () => [{ id: "primary" }],
  });
  await release.controls.apply();
  await release.controls.close();
  assert.equal(pkgCalls[0].mode, "apply");
  assert.equal(pkgCalls[0].buildApplyPackage.name, "fbaPkg", "apply uses the fba-plan control package (not the priority package)");
  assert.equal(pkgCalls[1].mode, "rollback");
});

test("buildFbaPlanRelease: controls.apply throws when the package does not commit (fail closed)", async () => {
  const release = COMP.buildFbaPlanRelease({
    operator: "op@test",
    makeRuntime: () => ({ run: async () => ({}), store: {} }),
    makePublisher: () => ({ preflight: async () => ({}), publish: async () => ({}) }),
    makeReadback: () => (async () => ({ ok: true })),
    runControlPackage: async () => ({ committed: false, code: "NOPE" }),
    connectStore: () => ({}), discoverAccounts: async () => [],
    readDirectoryAccounts: async () => [], getConnections: () => [],
  });
  await assert.rejects(() => release.controls.apply(), /did not commit/);
});

test("buildFbaPlanRelease.loadAccounts: keeps only correctly-bound primaries with a marketplace country", async () => {
  const release = COMP.buildFbaPlanRelease({
    operator: "op@test",
    makeRuntime: () => ({ run: async () => ({}), store: {} }),
    makePublisher: () => ({ preflight: async () => ({}), publish: async () => ({}) }),
    makeReadback: () => (async () => ({ ok: true })),
    runControlPackage: async () => ({ committed: true }),
    connectStore: () => ({}),
    discoverAccounts: async () => ["a1", "a2", "dd-secondary:x", "a4"],
    // The COMPLETE account-directory SNAPSHOT shape (accountId/country), not the lagging account_directory table.
    readDirectoryAccounts: async () => ([
      { accountId: "a1", country: "US", currency: "USD", name: "One" },
      { accountId: "a2", country: "DE", currency: "EUR", name: "Two" },
      { accountId: "dd-secondary:x", country: "US" }, // prefixed -> excluded
      { accountId: "a4", country: "" }, // no country -> excluded
    ]),
    getConnections: () => [{ id: "primary" }],
  });
  const accounts = await release.loadAccounts();
  assert.deepEqual(accounts.map((a) => a.accountId).sort(), ["a1", "a2"]);
  assert.equal(accounts.find((a) => a.accountId === "a1").country, "US");
  // exposes the shared readers the two paths consume
  assert.equal(typeof release.scopeReaders.getSourceCoverageWindows, "function");
  assert.equal(typeof release.getSourceExportCache, "function");
  assert.equal(typeof release.ownershipBackfill, "function");
});

main().then((failures) => { if (failures) process.exitCode = 1; }).catch((err) => { out("FATAL " + String(err && err.stack ? err.stack : err)); process.exitCode = 1; });
