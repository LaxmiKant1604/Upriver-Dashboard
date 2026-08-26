// The SHARED source-sync orchestration (scheduler + Data Sync Center + operators): frozen input validation,
// the immutable source->dashboard dependency registry, and the bounded release slice (derive -> consistency ->
// finalize -> preflight-all -> open/publish/ALWAYS-safe-close -> read-back) driven with deterministic doubles.
import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import {
  ORCHESTRATED_SOURCE_KEYS, SOURCE_DASHBOARD_DEPENDENCIES, OPERATION_ORIGINS,
  validateSourceSyncRequest, runReleaseSlice,
} from "../lib/server/sync/source-sync-operation.js";

let passed = 0;
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };
const test = (name, fn) => { try { fn(); passed += 1; out("  ok  " + name); } catch (e) { out("FAIL  " + name); out(String(e && e.stack ? e.stack : e)); process.exitCode = 1; } };
const testAsync = async (name, fn) => { try { await fn(); passed += 1; out("  ok  " + name); } catch (e) { out("FAIL  " + name); out(String(e && e.stack ? e.stack : e)); process.exitCode = 1; } };

test("frozen registries: exactly OLI + ads-asin-date + product-catalog; Campaign Ads / FBA structurally absent; deps immutable", () => {
  assert.deepEqual([...ORCHESTRATED_SOURCE_KEYS].sort(), ["ads-asin-date", "order-line-items", "product-catalog"]);
  assert.ok(!ORCHESTRATED_SOURCE_KEYS.includes("ads-campaign-date"), "Campaign Ads never orchestrated");
  assert.ok(!ORCHESTRATED_SOURCE_KEYS.includes("fba-inventory-health"), "FBA never orchestrated");
  for (const k of ORCHESTRATED_SOURCE_KEYS) {
    const d = SOURCE_DASHBOARD_DEPENDENCIES[k];
    assert.deepEqual([...d.reports], ["daily-reporting", "brand-sales", "brand-inventory"], k + " affects the frozen priority scope");
    assert.ok(Object.isFrozen(d) && Object.isFrozen(d.reports), k + " dependency entry is immutable");
  }
  assert.equal(SOURCE_DASHBOARD_DEPENDENCIES["product-catalog"].membership, true, "catalog changes membership/attribution");
  assert.equal(SOURCE_DASHBOARD_DEPENDENCIES["ads-asin-date"].adsRepublish, true, "ads evidence republishes the ads surfaces");
  assert.ok(Object.isFrozen(ORCHESTRATED_SOURCE_KEYS) && Object.isFrozen(SOURCE_DASHBOARD_DEPENDENCIES) && Object.isFrozen(OPERATION_ORIGINS));
});

test("validateSourceSyncRequest: only reviewed enums pass; every out-of-enum input is a typed 400 (no body pass-through)", () => {
  const ok = validateSourceSyncRequest({ bucket: "non-us", sourceKey: "order-line-items", origin: "admin-manual", asOf: "2026-08-25" });
  assert.equal(ok.bucket, "non-us"); assert.equal(ok.operationKey, "priority-dashboards/scheduled/2026-08-25", "manual + scheduled share the date-scoped catalog key");
  assert.deepEqual([...ok.dependencies.reports], ["daily-reporting", "brand-sales", "brand-inventory"]);
  const bad = [
    [{ bucket: "eu", sourceKey: "order-line-items", origin: "scheduled", asOf: "2026-08-25" }, "SOURCE_SYNC_BAD_BUCKET"],
    [{ bucket: "us", sourceKey: "ads-campaign-date", origin: "scheduled", asOf: "2026-08-25" }, "SOURCE_SYNC_BAD_SOURCE"],
    [{ bucket: "us", sourceKey: "fba-inventory-health", origin: "scheduled", asOf: "2026-08-25" }, "SOURCE_SYNC_BAD_SOURCE"],
    [{ bucket: "us", sourceKey: "order-line-items", origin: "cron", asOf: "2026-08-25" }, "SOURCE_SYNC_BAD_ORIGIN"],
    [{ bucket: "us", sourceKey: "order-line-items", origin: "scheduled", asOf: "yesterday" }, "SOURCE_SYNC_BAD_ASOF"],
  ];
  for (const [input, code] of bad) {
    let threw = null;
    try { validateSourceSyncRequest(input); } catch (e) { threw = e; }
    assert.ok(threw && threw.code === code && threw.status === 400, JSON.stringify(input) + " -> " + code);
  }
});

// ---- the bounded release slice, driven with deterministic doubles ----
const ACCTS = ["A1", "A2", "A3"];
const readyPre = (accountId) => ({ accountId, results: ["daily-reporting", "brand-sales", "brand-inventory"].map((reportKey) => ({ reportKey, disposition: "ready", liveReportKey: "live-" + reportKey, paramsHash: "h-" + reportKey })) });
const goodPublish = (accountId, disposition = "published") => ({ accountId, results: ["daily-reporting", "brand-sales", "brand-inventory"].map((reportKey) => ({ reportKey, disposition, liveReportKey: "live-" + reportKey, paramsHash: "h" })) });
const goodRollup = (n = 3) => ({ stopped: false, continuationRequired: false, globalDrained: true, alreadyComplete: false, derived: { skipped: null, daily: { ready: true, saved: n }, brandView: { ready: true, saved: n }, brandInventory: { ready: true, saved: n }, lineage: Array.from({ length: n * 3 }, (_, i) => ({ i })) } });
function makeDeps(over = {}) {
  const calls = { apply: 0, close: 0, publishes: [], readbacks: 0 };
  const deps = {
    bucket: "non-us",
    release: {
      deriveBucket: async () => ({ rollup: goodRollup() }),
      catalogReservation: async () => ({ tokensSpent: 2 }),
      finalizeBucket: async () => ({ disposition: "finalized", cycleStatus: "succeeded", accounts: ACCTS }),
      preflightAccount: async (a) => readyPre(a),
      publishAccount: async (a) => { calls.publishes.push(a); return goodPublish(a); },
      ...(over.release || {}),
    },
    controls: { apply: async () => { calls.apply += 1; }, close: async () => { calls.close += 1; }, ...(over.controls || {}) },
    readbackLive: over.readbackLive || (async () => { calls.readbacks += 1; return { ok: true }; }),
    outOfTime: over.outOfTime || (() => false),
    log: () => {},
  };
  return { deps, calls };
}

await testAsync("happy path: derive -> finalize -> preflight-all -> open/publish-all/safe-close -> read-back -> complete", async () => {
  const { deps, calls } = makeDeps();
  const r = await runReleaseSlice(deps);
  assert.equal(r.phase, "complete"); assert.equal(r.ok, true);
  assert.equal(r.published, 3); assert.equal(r.readback, 9, "3 accounts x 3 reports read back");
  assert.equal(calls.apply, 1); assert.equal(calls.close, 1, "controls opened once, safe-closed once");
  assert.deepEqual(calls.publishes, ACCTS);
});

await testAsync("a resumable derive (continuationRequired) returns a CONTINUATION -- no finalize, no controls, no publish", async () => {
  const { deps, calls } = makeDeps({ release: { deriveBucket: async () => ({ rollup: { stopped: false, continuationRequired: true, globalDrained: false } }) } });
  const r = await runReleaseSlice(deps);
  assert.equal(r.phase, "derive"); assert.equal(r.continuationRequired, true);
  assert.equal(calls.apply, 0, "controls never opened before the derive completes");
});

await testAsync("a ready=false / saved=0 derive is NOT 'derive ok' (the runner-grade assertion holds in the shared path)", async () => {
  const bad = goodRollup(); bad.derived.daily = { ready: false, saved: 0 }; bad.derived.lineage = [];
  const { deps, calls } = makeDeps({ release: { deriveBucket: async () => ({ rollup: bad }) } });
  const r = await runReleaseSlice(deps);
  assert.equal(r.phase, "derive"); assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => /not ready|saved report jobs = 0/.test(p)));
  assert.equal(calls.apply, 0, "no controls / publish after a failed derive (LKG intact)");
});

await testAsync("a refused finalize is a typed failure BEFORE any control/publish", async () => {
  const { deps, calls } = makeDeps({ release: { finalizeBucket: async () => ({ disposition: "refused", reason: "report-jobs-count" }) } });
  const r = await runReleaseSlice(deps);
  assert.equal(r.phase, "finalize"); assert.equal(r.ok, false);
  assert.equal(calls.apply, 0);
});

await testAsync("ONE not-ready publish gate blocks BEFORE the first live write (all-or-nothing preflight INSIDE the envelope)", async () => {
  // The publish gate consults the temporary publication controls (fail closed: report-disabled when safe-closed),
  // so the preflight runs INSIDE the open->...->safe-close envelope -- but STILL before any publish write.
  const { deps, calls } = makeDeps({ release: { preflightAccount: async (a) => (a === "A2" ? { accountId: a, results: [{ reportKey: "brand-sales", disposition: "blocked" }] } : readyPre(a)) } });
  const r = await runReleaseSlice(deps);
  assert.equal(r.phase, "preflight"); assert.equal(r.ok, false);
  assert.equal(calls.apply, 1, "controls opened for the gate check");
  assert.equal(calls.close, 1, "SAFE-CLOSE ran on the preflight-failure exit");
  assert.deepEqual(calls.publishes, [], "ZERO live writes");
});

await testAsync("slice budget mid-publish: SAFE-CLOSE still runs, progress is reported, continuation resumes idempotently (already-current)", async () => {
  let ticks = 0;
  const { deps, calls } = makeDeps({ outOfTime: () => ticks++ >= 1 }); // allow exactly one publish this slice
  const r1 = await runReleaseSlice(deps);
  assert.equal(r1.phase, "publish"); assert.equal(r1.continuationRequired, true);
  assert.equal(r1.published, 1); assert.equal(r1.total, 3);
  assert.equal(calls.close, 1, "safe-close ran even though the slice paused");
  // The NEXT slice replays: earlier accounts come back already-current (CAS), the rest publish, then read-back.
  const replay = makeDeps({ release: { publishAccount: async (a) => goodPublish(a, a === "A1" ? "already-current" : "published") } });
  const r2 = await runReleaseSlice(replay.deps);
  assert.equal(r2.phase, "complete"); assert.equal(r2.ok, true);
  assert.equal(replay.calls.close, 1, "safe-close on the completing slice too");
});

await testAsync("a publish failure safe-closes and reports honestly (no read-back claimed, LKG preserved)", async () => {
  const { deps, calls } = makeDeps({ release: { publishAccount: async (a) => (a === "A2" ? { accountId: a, results: [{ reportKey: "daily-reporting", disposition: "publish-conflict" }] } : goodPublish(a)) } });
  const r = await runReleaseSlice(deps);
  assert.equal(r.phase, "publish"); assert.equal(r.ok, false);
  assert.equal(calls.close, 1, "safe-close ran on the failure path");
  assert.equal(calls.readbacks, 0, "no read-back is claimed after a failed publish");
});

await testAsync("a failed live read-back fails the slice (never 'dashboards updated' without live proof)", async () => {
  const { deps } = makeDeps({ readbackLive: async (rk) => (rk === "brand-inventory" ? { ok: false, problems: ["payload-dangling"] } : { ok: true }) });
  const r = await runReleaseSlice(deps);
  assert.equal(r.phase, "readback"); assert.equal(r.ok, false);
});

await testAsync("token ceiling from the durable reservation: > maxTokens fails before finalize/controls", async () => {
  const { deps, calls } = makeDeps({ release: { catalogReservation: async () => ({ tokensSpent: 4 }) } });
  const r = await runReleaseSlice(deps);
  assert.equal(r.phase, "token-ceiling"); assert.equal(r.ok, false);
  assert.equal(calls.apply, 0);
});

out("\n" + passed + " assertions passed");
