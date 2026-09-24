// Publication recovery worker -- integration/adversarial scenarios. Drives the REAL orchestrator (lib/server/recovery/
// worker.js) against the in-memory store (mirrors the 20260934 RPC semantics) and a fake reconciler WORLD that models what
// each existing zero-export reconciler CLI reports per (family, region, account). ZERO network/DB/DataDoe. 7-bit ASCII, LF.
import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { createRecoveryWorker } from "../lib/server/recovery/worker.js";
import { createMemoryStore } from "../lib/server/recovery/memory-store.js";
import { RECOVERY_FAMILIES } from "../lib/server/recovery/registry.js";
import { buildReconcileArgs } from "../lib/server/recovery/runner.js";

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); passed += 1; writeSync(1, `  ok ${n}\n`); };
writeSync(1, "publication-recovery-worker\n");

const DAY = 86400000;
const T0 = Date.parse("2026-09-24T10:00:00Z");
const ASOF = "2026-09-23";

// ---- fake reconciler world -------------------------------------------------------------------------------------
// account behaviour per (family, region, account):
//   current | stale | missing | stale+defer:<reason> | stale+fail:<STATE>:<reason> | stale+mismatch | stale+timeout |
//   stale+spend | stale+timeout-landed (the live child is killed AFTER its publish landed)
function makeWorld() {
  const w = { acc: new Map(), calls: [], liveRuns: 0 };
  const key = (f, r, a) => `${f}|${r}|${a}`;
  w.set = (f, r, a, st) => w.acc.set(key(f, r, a), st);
  w.get = (f, r, a) => w.acc.get(key(f, r, a));
  w.scope = (f, r) => [...w.acc.keys()].filter((k) => k.startsWith(`${f}|${r}|`)).map((k) => k.split("|")[2]);
  const states = (f, st, kind) => {
    const keys = RECOVERY_FAMILIES[f].reportKeys();
    const one = (s, r = null) => Object.fromEntries(keys.map((k) => [k, { s, r }]));
    if (st === "current") return one("PUBLICATION_NOT_REQUIRED");
    if (st === "missing") return one("DEFERRED_PROVENANCE", "oli-provenance-missing");
    if (kind !== "live") return one("STALE", "live-refresh-differs");
    return null;
  };
  w.run = async ({ family, region, asOf, kind, accounts, runToken }) => {
    // the runner boundary is exercised for real: it throws on any forbidden/unsafe argv
    buildReconcileArgs({ family, region, asOf, accounts, kind, runToken });
    w.calls.push({ family, region, kind, accounts: accounts ? [...accounts] : null, runToken: runToken || null });
    if (kind === "cleanup") return { exitCode: 0, timedOut: false, result: { mode: "cleanup", cleaned: true }, targets: null, durationMs: 1 };
    const scope = accounts || w.scope(family, region);
    // saved-data-reconciler fail(): the WHOLE run fails before any per-account result (outcome failed, perAccount []).
    if (scope.some((a) => w.get(family, region, a) === "runfail")) {
      const targets = { v: 1, family, bucket: region, requestedAsOf: asOf, dryRun: kind !== "live", outcome: "failed", code: "DURABLE_ADS_UNREADABLE", dataDoeCreates: 0, dataDoeTokens: 0, controlCleanupUnresolved: false, accounts: [] };
      return { exitCode: 1, timedOut: false, result: { ok: false, outcome: "failed", code: "DURABLE_ADS_UNREADABLE", dataDoeCreates: 0, dataDoeTokens: 0 }, targets, durationMs: 1000 };
    }
    const out = [];
    let timedOut = false, spend = scope.some((a) => w.get(family, region, a) === "spend-dry");
    if (kind === "live") w.liveRuns += 1;
    for (const a of scope) {
      const st = w.get(family, region, a) || "missing";
      let reports = states(family, st, kind);
      if (!reports) {
        const keys = RECOVERY_FAMILIES[family].reportKeys();
        const all = (s, r = null) => Object.fromEntries(keys.map((k) => [k, { s, r }]));
        if (st === "stale") { reports = all("READBACK_VERIFIED"); w.set(family, region, a, "current"); }
        else if (st.startsWith("stale+defer:")) reports = all("DEFERRED_DEPENDENCY", st.slice("stale+defer:".length));
        else if (st.startsWith("stale+fail:")) { const [, stt, r] = st.split(":"); reports = all(stt, st.split(":").slice(2).join(":") || r); }
        else if (st === "stale+mismatch") reports = all("READBACK_VERIFIED");
        else if (st === "stale+timeout") timedOut = true;
        else if (st === "stale+timeout-landed") { timedOut = true; w.set(family, region, a, "current"); }
        else if (st === "stale+spend") { spend = true; reports = all("READBACK_VERIFIED"); }
        else reports = all("STALE", "unexpected");
      }
      if (reports) out.push({ id: a, eligible: st !== "missing", rev: "rev-" + a, status: "nonempty", reports });
    }
    if (timedOut) return { exitCode: null, signal: "SIGTERM", timedOut: true, result: null, targets: null, durationMs: 420000 };
    const targets = { v: 1, family, bucket: region, requestedAsOf: asOf, dryRun: kind !== "live", outcome: "complete", code: "OK", dataDoeCreates: spend ? 1 : 0, dataDoeTokens: spend ? 2 : 0, controlCleanupUnresolved: false, accounts: out };
    return { exitCode: 0, timedOut: false, result: { ok: true, dataDoeCreates: targets.dataDoeCreates, dataDoeTokens: targets.dataDoeTokens }, targets, durationMs: 1000 };
  };
  return w;
}

function makeRig({ families = ["oli", "fba", "ads", "listings"], control, regions = ["india"], workerId = "w1", world, store, clockRef } = {}) {
  const clk = clockRef || { t: T0 };
  const st = store || createMemoryStore({ clock: () => clk.t, control: control || { enabled: true, liveFamilies: ["oli", "fba", "ads", "listings"] } });
  const wd = world || makeWorld();
  let n = 0;
  const cfg = { workerId, host: "test", pollSeconds: 20, scanIntervalSeconds: 600, scanLeaseSeconds: 3600, batch: 5, leaseSeconds: 1500, maxAttempts: 4, maxClaims: 5, childMaxOldSpaceMb: 256, keepDays: 14, stopGraceSeconds: 1, liveFamilies: families, regions, concurrency: 1 };
  const worker = createRecoveryWorker({ store: st, run: wd.run, config: cfg, clock: () => clk.t, sleep: async (ms) => { clk.t += ms; }, randomUUID: () => `${workerId}-claim-${++n}`, version: "test" });
  return { clk, store: st, world: wd, worker, cfg };
}
const runScanToEnd = async (rig) => { let guard = 0; do { await rig.worker.scanStep(); guard += 1; } while (rig.store.scanRow.holder && guard < 50); };
const jobsOf = (store, f) => store.jobs.filter((j) => !f || j.family === f);
const seed = (world, fams, accounts, st = "current") => { for (const f of fams) for (const a of accounts) world.set(f, "india", a, st); };
const tokens = (store, f, map) => { for (const [a, t] of Object.entries(map)) store.env.tokens[f].set(a, t); };

// ---- 1. normal save (fast watermark path) --------------------------------------------------------------------------
{
  const rig = makeRig();
  seed(rig.world, ["oli", "fba", "ads", "listings"], ["A1", "A2"]);
  for (const f of ["oli", "fba", "ads", "listings"]) tokens(rig.store, f, { A1: `${f}-t1`, A2: `${f}-t1` });
  await runScanToEnd(rig);
  ok("1a: first scan establishes the reconciler-scoped baseline (all current, zero jobs)", jobsOf(rig.store).length === 0 && rig.store.state.size === 8 && [...rig.store.state.values()].every((s) => s.verified_token));
  // a new OLI save for A1: evidence token advances + the reconciler now reports the account STALE
  tokens(rig.store, "oli", { A1: "oli-t2" }); rig.world.set("oli", "india", "A1", "stale");
  rig.world.calls.length = 0;
  await rig.worker.tick();
  const j = jobsOf(rig.store, "oli")[0];
  const kinds = rig.world.calls.map((c) => c.kind);
  ok("1b: watermark enqueued exactly the changed account; job VERIFIED only after dry-run -> live -> verify", j && j.status === "verified" && j.origin === "watermark" && JSON.stringify(kinds) === JSON.stringify(["dry-run", "live", "dry-run"]));
  ok("1c: the live pass targeted ONLY the stale account with a unique run token (never immediate mode)", rig.world.calls[1].accounts.join(",") === "A1" && /^prw-w1-oli-india-/.test(rig.world.calls[1].runToken));
  ok("1d: state records the proven token, so the same evidence is never re-enqueued", rig.store.state.get(`oli|india|A1|${ASOF}`).verified_token === "oli-t2" && (await rig.store.enqueue({ family: "oli", region: "india", accountId: "A1", asOf: ASOF, token: "oli-t2", origin: "watermark" })) === "already-verified");
}

// ---- 2. missed GitHub trigger: live stale but NO evidence-token change -> the 10-min scan (safety net) finds it --------
{
  const rig = makeRig();
  seed(rig.world, ["fba"], ["B1"]); tokens(rig.store, "fba", { B1: "fba-t1" });
  await runScanToEnd(rig);
  rig.world.set("fba", "india", "B1", "stale"); // e.g. the scheduler's reconcile never ran; evidence unchanged
  await rig.worker.tick();
  ok("2a: watermark alone sees nothing (token unchanged) and the scan is not yet due", jobsOf(rig.store).length === 0);
  rig.clk.t += 601 * 1000;
  await runScanToEnd(rig);
  const j = jobsOf(rig.store, "fba")[0];
  ok("2b: the next full scan detects the STALE binding and enqueues it (origin scan)", j && j.origin === "scan" && j.status === "pending");
  await rig.worker.processOneBatch();
  ok("2c: recovered + verified without any GitHub involvement", jobsOf(rig.store, "fba")[0].status === "verified");
}

// ---- 3. timeout -> cleanup (same run token) -> retry with backoff -> success ----------------------------------------
{
  const rig = makeRig();
  seed(rig.world, ["oli"], ["C1"], "stale+timeout"); tokens(rig.store, "oli", { C1: "t1" });
  await rig.store.enqueue({ family: "oli", region: "india", accountId: "C1", asOf: ASOF, token: "t1", origin: "scan" });
  await rig.worker.processOneBatch();
  const live = rig.world.calls.find((c) => c.kind === "live"), clean = rig.world.calls.find((c) => c.kind === "cleanup");
  const j = jobsOf(rig.store)[0];
  ok("3a: a timed-out live child is followed by --cleanup with the SAME run token", clean && clean.runToken === live.runToken);
  ok("3b: the job is retried with backoff (attempts=1), not verified", j.status === "pending" && j.attempts === 1 && j.next_attempt_at > rig.clk.t && j.last_class === "timeout");
  rig.world.set("oli", "india", "C1", "stale"); rig.clk.t = j.next_attempt_at + 1;
  await rig.worker.processOneBatch();
  ok("3c: the retry publishes + verifies", jobsOf(rig.store)[0].status === "verified");
}

// ---- 4. worker crash while holding a claim -> lease expiry -> another worker reclaims -------------------------------
{
  const clockRef = { t: T0 };
  const store = createMemoryStore({ clock: () => clockRef.t });
  const world = makeWorld();
  seed(world, ["oli"], ["D1"], "stale"); tokens(store, "oli", { D1: "t1" });
  await store.enqueue({ family: "oli", region: "india", accountId: "D1", asOf: ASOF, token: "t1", origin: "scan" });
  const crashed = await store.claim({ workerId: "wA", claimToken: "dead-token", limit: 5, leaseSeconds: 1500, maxClaims: 5 }); // wA dies here
  const b = makeRig({ store, world, clockRef, workerId: "wB" });
  ok("4a: while wA's lease is live, wB cannot claim the job", crashed.length === 1 && (await b.worker.processOneBatch()) === false);
  clockRef.t += 1501 * 1000;
  await b.worker.processOneBatch();
  const j = store.jobs[0];
  ok("4b: after lease expiry wB reclaims and completes it (its owner finish resets the consecutive-claim count)", j.status === "verified" && /^prw-wB-/.test(j.last_run_token) && j.claims === 0);
  ok("4c: wA's stale claim token can no longer finish the job", (await store.finish({ id: j.id, claimToken: "dead-token", outcome: "retry" })) === "not-owner");
}

// ---- 5. crash AFTER a successful publish -> reclaim -> pre-check proves current -> no second publish -----------------
{
  const clockRef = { t: T0 };
  const store = createMemoryStore({ clock: () => clockRef.t });
  const world = makeWorld();
  world.set("oli", "india", "E1", "current"); // wA's live publish landed, then wA crashed before finish()
  await store.enqueue({ family: "oli", region: "india", accountId: "E1", asOf: ASOF, token: "t1", origin: "scan" });
  await store.claim({ workerId: "wA", claimToken: "wA-tok", limit: 5 });
  clockRef.t += 1501 * 1000;
  const b = makeRig({ store, world, clockRef, workerId: "wB" });
  await b.worker.processOneBatch();
  ok("5: reclaimed job is VERIFIED by the pre-check alone -- zero additional live runs", store.jobs[0].status === "verified" && world.liveRuns === 0);
}

// ---- 6. duplicate workers: disjoint claims, single-flight scan, each job published at most once ----------------------
{
  const clockRef = { t: T0 };
  const store = createMemoryStore({ clock: () => clockRef.t });
  const world = makeWorld();
  const accs = ["F1", "F2", "F3", "F4", "F5", "F6", "F7"];
  seed(world, ["oli"], accs, "stale");
  for (const a of accs) await store.enqueue({ family: "oli", region: "india", accountId: a, asOf: ASOF, token: "t-" + a, origin: "scan" });
  const A = makeRig({ store, world, clockRef, workerId: "wA" });
  const B = makeRig({ store, world, clockRef, workerId: "wB" });
  const c1 = await store.claim({ workerId: "probeA", claimToken: "pa", limit: 5 });
  const c2 = await store.claim({ workerId: "probeB", claimToken: "pb", limit: 5 });
  ok("6a: two concurrent claims never overlap", c1.length === 5 && c2.length === 2 && !c1.some((x) => c2.some((y) => y.id === x.id)));
  for (const x of [...c1, ...c2]) await store.finish({ id: x.id, claimToken: x.claim_token, outcome: "released" });
  await Promise.all([A.worker.processOneBatch(), B.worker.processOneBatch()]);
  await A.worker.processOneBatch(); await B.worker.processOneBatch();
  ok("6b: every job verified exactly once across both workers", store.jobs.every((j) => j.status === "verified") && world.calls.filter((c) => c.kind === "live").reduce((n, c) => n + c.accounts.length, 0) === accs.length);
  const sa = await store.tryBeginScan({ holder: "wA", leaseSeconds: 3600, minIntervalSeconds: 600 });
  const sb = await store.tryBeginScan({ holder: "wB", leaseSeconds: 3600, minIntervalSeconds: 600 });
  ok("6c: the full scan is single-flight across workers", sa === true && sb === false);
}

// ---- 7. dependency ordering: OLI (brand-sales) before FBA (brand-inventory) for the same account ---------------------
{
  const rig = makeRig();
  seed(rig.world, ["oli", "fba"], ["G1"], "stale");
  await rig.store.enqueue({ family: "fba", region: "india", accountId: "G1", asOf: ASOF, token: "f1", origin: "scan", priority: 4 });
  await rig.store.enqueue({ family: "oli", region: "india", accountId: "G1", asOf: ASOF, token: "o1", origin: "scan", priority: 1 });
  await rig.worker.processOneBatch();
  ok("7a: the OLI job is claimed + completed first (priority), FBA untouched", jobsOf(rig.store, "oli")[0].status === "verified" && jobsOf(rig.store, "fba")[0].status === "pending" && rig.world.calls.every((c) => c.family === "oli"));
  await rig.worker.processOneBatch();
  ok("7b: FBA then publishes after OLI is verified", jobsOf(rig.store, "fba")[0].status === "verified");
  const rig2 = makeRig();
  rig2.world.set("fba", "india", "G2", "stale");
  await rig2.store.enqueue({ family: "oli", region: "india", accountId: "G2", asOf: ASOF, token: "o1", origin: "scan" });
  const blk = await rig2.store.claim({ workerId: "other", claimToken: "x", limit: 1 }); // OLI in flight elsewhere
  await rig2.store.enqueue({ family: "fba", region: "india", accountId: "G2", asOf: ASOF, token: "f1", origin: "scan", priority: 4 });
  await rig2.worker.processOneBatch();
  const fj = jobsOf(rig2.store, "fba")[0];
  ok("7c: FBA is DEFERRED (no attempt burned) while the account's OLI job is still open", blk.length === 1 && fj.status === "deferred" && fj.attempts === 0 && /awaiting-oli/.test(fj.last_reason) && rig2.world.liveRuns === 0);
}

// ---- 8. missing upstream evidence -> reported, never fetched, never a live run -------------------------------------
{
  const rig = makeRig();
  rig.world.set("oli", "india", "H1", "missing");
  await rig.store.enqueue({ family: "oli", region: "india", accountId: "H1", asOf: ASOF, token: "t", origin: "scan" });
  await rig.worker.processOneBatch();
  const j = jobsOf(rig.store)[0];
  ok("8: missing evidence -> deferred 'missing-evidence' (no attempt, no live run)", j.status === "deferred" && j.last_class === "missing-evidence" && j.attempts === 0 && rig.world.liveRuns === 0);
}

// ---- 9. read-back mismatch: publish claims success but the exact binding still disagrees -> bounded retry -> dead ------
{
  const rig = makeRig();
  rig.world.set("oli", "india", "I1", "stale+mismatch");
  await rig.store.enqueue({ family: "oli", region: "india", accountId: "I1", asOf: ASOF, token: "t", origin: "scan" });
  for (let i = 0; i < 6; i += 1) { await rig.worker.processOneBatch(); rig.clk.t += 4000 * 1000; }
  const j = jobsOf(rig.store)[0];
  ok("9: never verified on a green publish alone; dead-lettered after max attempts (no infinite loop)", j.status === "dead" && /readback-mismatch/.test(j.last_class) && j.attempts === 4 && rig.world.liveRuns === 4);
}

// ---- 10. newer live row from another writer -> terminal for this evidence, never looped; same evidence never re-enqueued.
//      The REAL reconciler contract: NEWER_LIVE -> DEFERRED_DEPENDENCY with publish-newer-live / shadow-newer-live.
for (const reason of ["publish-newer-live", "shadow-newer-live"]) {
  const rig = makeRig();
  rig.world.set("fba", "india", "J1", "stale+defer:" + reason);
  await rig.store.enqueue({ family: "fba", region: "india", accountId: "J1", asOf: ASOF, token: "t", origin: "scan" });
  await rig.worker.processOneBatch();
  const j = jobsOf(rig.store)[0];
  ok(`10: ${reason} (DEFERRED_DEPENDENCY) -> dead 'superseded-newer-live' after ONE live run; re-detection refused`, j.status === "dead" && j.last_class === "superseded-newer-live" && rig.world.liveRuns === 1 && (await rig.store.enqueue({ family: "fba", region: "india", accountId: "J1", asOf: ASOF, token: "t", origin: "scan" })) === "dead-same-evidence");
}

// ---- 11. contention + scheduler window + terminal-cycle + dependency deferrals classify separately ------------------
{
  const rig = makeRig();
  rig.world.set("oli", "india", "K1", "stale");
  await rig.store.enqueue({ family: "oli", region: "india", accountId: "K1", asOf: ASOF, token: "t", origin: "scan" });
  rig.store.env.lease = { held: true, operationKey: "scheduler-v2", expiresAt: null };
  await rig.worker.processOneBatch();
  ok("11a: a held global lease defers without a child run or an attempt", jobsOf(rig.store)[0].status === "deferred" && jobsOf(rig.store)[0].attempts === 0 && rig.world.calls.length === 0);
  rig.store.env.lease = { held: false }; rig.store.env.busyRegions = new Set(["india"]); rig.clk.t += 200 * 1000;
  await rig.worker.processOneBatch();
  ok("11b: an in-flight scheduler cycle defers (scheduler-window) without a child run", jobsOf(rig.store)[0].last_class === "scheduler-window" && rig.world.calls.length === 0);
  rig.store.env.busyRegions = new Set();
  const cases = [["stale+defer:controls-not-opened:CONTROL_LEASE_HELD", "contention", "deferred", 0], ["stale+defer:brand-sales-candidate-to-mismatch", "dependency-deferral", "deferred", 0], ["stale+defer:cycle-not-running:succeeded", "terminal-cycle-stuck", "dead", 0], ["stale+fail:FAILED_DERIVE:payload-malformed", "permanent-integrity", "dead", 0]];
  for (const [st, cls, status, attempts] of cases) {
    const r = makeRig(); r.world.set("oli", "india", "L1", st);
    await r.store.enqueue({ family: "oli", region: "india", accountId: "L1", asOf: ASOF, token: "t", origin: "scan" });
    await r.worker.processOneBatch();
    const j = jobsOf(r.store)[0];
    ok(`11c: ${st} -> ${cls}/${status}`, j.last_class === cls && j.status === status && j.attempts === attempts);
  }
}

// ---- 12. as-of rollover supersedes; observe-only never processes; tripwire; re-arm on evidence advance -----------------
{
  const rig = makeRig();
  await rig.store.enqueue({ family: "oli", region: "india", accountId: "M1", asOf: "2026-09-22", token: "t", origin: "scan" });
  await rig.worker.processOneBatch();
  ok("12a: a job for an older as-of is superseded without running anything", jobsOf(rig.store)[0].status === "superseded" && rig.world.calls.length === 0);

  const obs = makeRig({ control: { enabled: false, liveFamilies: [] } });
  seed(obs.world, ["oli"], ["N1"], "stale"); tokens(obs.store, "oli", { N1: "t" });
  await runScanToEnd(obs);
  ok("12b: observe-only (control disabled): the scan records observations but enqueues nothing and never publishes", obs.store.observations.size > 0 && jobsOf(obs.store).length === 0 && obs.world.liveRuns === 0 && (await obs.worker.processOneBatch()) === false);

  const trip = makeRig();
  trip.world.set("ads", "india", "P1", "stale+spend"); trip.world.set("ads", "india", "P2", "stale");
  await trip.store.enqueue({ family: "ads", region: "india", accountId: "P1", asOf: ASOF, token: "t", origin: "scan", priority: 3 });
  await trip.worker.processOneBatch();
  await trip.store.enqueue({ family: "ads", region: "india", accountId: "P2", asOf: ASOF, token: "t", origin: "scan", priority: 3 });
  const liveBefore = trip.world.liveRuns;
  await trip.worker.processOneBatch();
  ok("12c: a reconciler reporting ANY DataDoe create/token dead-letters the job and trips the family off", jobsOf(trip.store).find((j) => j.account_id === "P1").last_class === "zero-export-violation" && trip.worker.tripped.has("ads") && trip.world.liveRuns === liveBefore);

  const adv = makeRig();
  adv.world.set("oli", "india", "Q1", "stale");
  await adv.store.enqueue({ family: "oli", region: "india", accountId: "Q1", asOf: ASOF, token: "t1", origin: "scan" });
  const origRun = adv.world.run;
  let bumped = false;
  const w2 = createRecoveryWorker({ store: adv.store, run: async (a) => { if (a.kind === "live" && !bumped) { bumped = true; await adv.store.enqueue({ family: "oli", region: "india", accountId: "Q1", asOf: ASOF, token: "t2", origin: "watermark" }); } return origRun(a); }, config: adv.cfg, clock: () => adv.clk.t, sleep: async () => {}, randomUUID: () => "adv-" + Math.random() });
  await w2.processOneBatch();
  const qj = jobsOf(adv.store)[0];
  ok("12d: evidence advancing mid-run re-arms the job (the proof may predate the newer evidence)", qj.status === "pending" && qj.last_class === "evidence-advanced" && qj.evidence_token === "t2");
}

// ---- 13. graceful stop mid-batch releases unexecuted work; crash-loop dead-letters ----------------------------------
{
  const rig = makeRig();
  rig.world.set("oli", "india", "R1", "stale");
  await rig.store.enqueue({ family: "oli", region: "india", accountId: "R1", asOf: ASOF, token: "t", origin: "scan" });
  const orig = rig.world.run;
  const w = createRecoveryWorker({ store: rig.store, run: async (a) => { const r = await orig(a); if (a.kind === "dry-run") w.stop(); return r; }, config: rig.cfg, clock: () => rig.clk.t, sleep: async () => {}, randomUUID: () => "stop-1" });
  await w.processOneBatch();
  const j = jobsOf(rig.store)[0];
  ok("13a: SIGTERM during a batch -> job released (claims restored), no live run started", j.status === "pending" && j.claims === 0 && rig.world.liveRuns === 0);
  const s = createMemoryStore({ clock: () => rig.clk.t });
  await s.enqueue({ family: "oli", region: "india", accountId: "S1", asOf: ASOF, token: "t", origin: "scan" });
  for (let i = 0; i < 5; i += 1) { await s.claim({ workerId: "crasher", claimToken: "c" + i, limit: 1, leaseSeconds: 120, maxClaims: 5 }); rig.clk.t += 121 * 1000; }
  await s.claim({ workerId: "crasher", claimToken: "c-last", limit: 1, leaseSeconds: 120, maxClaims: 5 });
  ok("13b: a job reclaimed max times without ever finishing is dead-lettered as crash-loop", s.jobs[0].status === "dead" && s.jobs[0].last_class === "crash-loop");
}

// ---- 14. adversarial-review regressions ----------------------------------------------------------------------------
{
  // 14a: many NORMAL claim->finish cycles (gate deferrals) never accumulate toward the crash-loop guard.
  const rig = makeRig();
  rig.world.set("oli", "india", "T1", "stale");
  await rig.store.enqueue({ family: "oli", region: "india", accountId: "T1", asOf: ASOF, token: "t", origin: "scan" });
  rig.store.env.lease = { held: true, operationKey: "scheduler-v2", expiresAt: null };
  for (let i = 0; i < 12; i += 1) { await rig.worker.processOneBatch(); rig.clk.t += 121 * 1000; }
  const mid = { ...jobsOf(rig.store)[0] }; // snapshot (the store row keeps mutating)
  const lost = await rig.store.claim({ workerId: "crashy", claimToken: "lost", limit: 1, leaseSeconds: 120, maxClaims: rig.cfg.maxClaims }); // then crashes
  rig.clk.t += 1600 * 1000; rig.store.env.lease = { held: false };
  await rig.worker.processOneBatch();
  const j = jobsOf(rig.store)[0];
  ok("14a: 12 finished deferrals + one crash do NOT dead-letter as crash-loop (claims count only consecutive unfinished claims)", mid.status === "deferred" && mid.claims === 0 && lost.length === 1 && j.status === "verified");
}
{
  // 14b: evidence refreshed while the job runs, then the OLD evidence fails permanently -> re-armed, not dead-lettered
  // with a token the reconciler never evaluated (and attempts reset for the new evidence).
  const rig = makeRig();
  rig.world.set("oli", "india", "U1", "stale+fail:FAILED_DERIVE:payload-malformed");
  await rig.store.enqueue({ family: "oli", region: "india", accountId: "U1", asOf: ASOF, token: "old", origin: "scan" });
  const orig = rig.world.run;
  let bumped = false;
  const w = createRecoveryWorker({ store: rig.store, run: async (a) => { if (a.kind === "live" && !bumped) { bumped = true; await rig.store.enqueue({ family: "oli", region: "india", accountId: "U1", asOf: ASOF, token: "new", origin: "watermark" }); } return orig(a); }, config: rig.cfg, clock: () => rig.clk.t, sleep: async () => {}, randomUUID: () => "u1-claim" });
  await w.processOneBatch();
  const j = jobsOf(rig.store)[0];
  ok("14b: a permanent failure of OLD evidence re-arms the job for the NEW evidence (never dead-same-evidence on untried evidence)", j.status === "pending" && j.last_class === "evidence-advanced" && j.evidence_token === "new" && j.attempts === 0 && (await rig.store.enqueue({ family: "oli", region: "india", accountId: "U1", asOf: ASOF, token: "new", origin: "scan" })) === "exists");
}
{
  // 14c: a whole-run reconciler failure is a run-level retry (one attempt), and a scan step with it is an ERROR.
  const rig = makeRig();
  rig.world.set("ads", "india", "V1", "runfail");
  await rig.store.enqueue({ family: "ads", region: "india", accountId: "V1", asOf: ASOF, token: "t", origin: "scan", priority: 3 });
  await rig.worker.processOneBatch();
  const j = jobsOf(rig.store)[0];
  const scanRig = makeRig({ families: ["ads"] });
  scanRig.world.set("ads", "india", "V2", "runfail");
  await runScanToEnd(scanRig);
  ok("14c: whole-run failure -> 'run-failed' retry (not 'account-missing'); the scan step is counted as an error (partial)", j.status === "pending" && j.last_class === "run-failed" && j.attempts === 1 && /run-failed:DURABLE_ADS_UNREADABLE/.test(j.last_reason) && scanRig.store.scanRow.lastOutcome === "partial" && scanRig.store.scanRow.lastSummary.errors >= 1);
}
{
  // 14d: the reconciler reserved its deadline for cleanup and never attempted the account -> deferred, no attempt.
  const rig = makeRig();
  rig.world.set("listings", "india", "W1", "stale+defer:deadline-cleanup-reserved");
  await rig.store.enqueue({ family: "listings", region: "india", accountId: "W1", asOf: ASOF, token: "t", origin: "scan", priority: 5 });
  await rig.worker.processOneBatch();
  const j = jobsOf(rig.store)[0];
  ok("14d: deadline-cleanup-reserved -> deferred 'not-attempted' without burning an attempt", j.status === "deferred" && j.last_class === "not-attempted" && j.attempts === 0);
}
{
  // 14e: an exception mid-batch counts as an attempt (bounded) instead of an instant 'released' loop at the queue head.
  const rig = makeRig();
  rig.world.set("oli", "india", "X1", "stale");
  await rig.store.enqueue({ family: "oli", region: "india", accountId: "X1", asOf: ASOF, token: "t", origin: "scan" });
  const realBusy = rig.store.readBusyRegions;
  rig.store.readBusyRegions = async () => { const e = new Error("pooler reset"); e.code = "ECONNRESET"; throw e; };
  let threw = false;
  try { await rig.worker.processOneBatch(); } catch { threw = true; }
  rig.store.readBusyRegions = realBusy;
  const j = jobsOf(rig.store)[0];
  ok("14e: batch exception -> retry with backoff (attempt 1, class transport), never an immediate 'released' re-claim", threw && j.status === "pending" && j.attempts === 1 && j.last_class === "transport" && /batch-exception:ECONNRESET/.test(j.last_reason) && j.next_attempt_at > rig.clk.t);
}
{
  // 14f: a DataDoe create/token reported by a PRE-CHECK dry-run (not only the live run) trips the family.
  const rig = makeRig();
  rig.world.set("fba", "india", "Y1", "spend-dry");
  await rig.store.enqueue({ family: "fba", region: "india", accountId: "Y1", asOf: ASOF, token: "t", origin: "scan", priority: 4 });
  await rig.worker.processOneBatch();
  const j = jobsOf(rig.store)[0];
  ok("14f: zero-export violation from a DRY-RUN child dead-letters the job AND trips the family", j.status === "dead" && j.last_class === "zero-export-violation" && rig.worker.tripped.has("fba") && rig.world.liveRuns === 0);
}
{
  // 14g: the watermark reacts only to CHANGED evidence: an account the scan saw as missing-evidence is not re-enqueued
  // every poll on the same token; a new token enqueues it.
  const rig = makeRig({ families: ["oli"] });
  rig.world.set("oli", "india", "Z1", "missing"); tokens(rig.store, "oli", { Z1: "z-1" });
  await runScanToEnd(rig);
  await rig.worker.watermarkPass();
  const none = jobsOf(rig.store).length;
  tokens(rig.store, "oli", { Z1: "z-2" });
  await rig.worker.watermarkPass();
  ok("14g: missing-evidence on an unchanged token is NOT re-enqueued by the watermark; a changed token is", none === 0 && jobsOf(rig.store).length === 1 && jobsOf(rig.store)[0].evidence_token === "z-2");
}
{
  // 14h: graceful stop never kills a LIVE child (finalize-before-publish window); it does kill a dry-run after grace.
  const rig = makeRig();
  const cfg0 = { ...rig.cfg, stopGraceSeconds: 0 };
  const kills = [];
  const fakeRun = (kindToStopOn) => async (a) => {
    a.onChild({ pid: 1, kill: (sig) => kills.push(`${a.kind}:${sig}`) });
    if (a.kind === kindToStopOn) { w.stop(); await new Promise((r) => setTimeout(r, 20)); }
    return rig.world.run(a);
  };
  rig.world.set("oli", "india", "AA1", "stale");
  await rig.store.enqueue({ family: "oli", region: "india", accountId: "AA1", asOf: ASOF, token: "t", origin: "scan" });
  let w = createRecoveryWorker({ store: rig.store, run: fakeRun("live"), config: cfg0, clock: () => rig.clk.t, sleep: async () => {}, randomUUID: () => "h-1" });
  await w.processOneBatch();
  const liveKilled = kills.some((k) => k.startsWith("live:"));
  const j1 = jobsOf(rig.store)[0];
  kills.length = 0;
  const rig2 = makeRig();
  rig2.world.set("oli", "india", "AB1", "stale");
  await rig2.store.enqueue({ family: "oli", region: "india", accountId: "AB1", asOf: ASOF, token: "t", origin: "scan" });
  w = createRecoveryWorker({ store: rig2.store, run: async (a) => { a.onChild({ pid: 2, kill: (sig) => kills.push(`${a.kind}:${sig}`) }); if (a.kind === "dry-run") { w.stop(); await new Promise((r) => setTimeout(r, 20)); } return rig2.world.run(a); }, config: cfg0, clock: () => rig2.clk.t, sleep: async () => {}, randomUUID: () => "h-2" });
  await w.processOneBatch();
  const j2 = jobsOf(rig2.store)[0];
  ok("14h: stop during LIVE lets it finish (no kill; job handed back for the next pre-check); stop during a dry-run SIGTERMs it and burns no attempt", !liveKilled && j1.status === "pending" && j1.attempts === 0 && kills.includes("dry-run:SIGTERM") && j2.status === "pending" && j2.attempts === 0 && rig2.world.liveRuns === 0);
}
{
  // 14i: scan lease lost to another worker mid-scan -> this worker abandons its scan (single-flight end to end).
  const rig = makeRig({ families: ["oli"] });
  rig.world.set("oli", "india", "AC1", "current");
  await rig.worker.scanStep(); // begin
  rig.store.scanRow.holder = "other-worker"; rig.store.scanRow.leaseExpiresAt = rig.clk.t + 3600 * 1000; // takeover
  const before = rig.world.calls.length;
  await rig.worker.scanStep();
  ok("14i: a scan whose lease was taken over is abandoned before running another step", rig.worker.stats.scansAbandoned === 1 && rig.world.calls.length === before && rig.store.scanRow.holder === "other-worker");
}

writeSync(1, `publication-recovery-worker: ${passed} passed\n`);
