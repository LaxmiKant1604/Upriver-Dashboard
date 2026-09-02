// SCHEDULER V2 -- previous-day (D-1) FRESHNESS + force-latest regression suite (Phase: D-1 guarantee). Deterministic
// + OFFLINE (no network, no DB, no real .env.local). Proves: a stale D-2 cache cannot satisfy a D-1 run; a fresh D-1
// export publishes; DataDoe-only-D-2 -> DATADOE_D1_NOT_READY with the LKG retained (never a false publish); run_id
// idempotency (same run_id = zero extra creates, a new run_id re-attempts only the missing window); one batch failure
// is never full-bucket success; ambiguous create / COMMIT_UNKNOWN never retries; bucket isolation 66/24; ads-
// disconnected non-blocking; Campaign/FBA never forced; the summary distinguishes D-1 success from lagged LKG; the
// schedules are unchanged; and force-latest cannot be activated by a scheduled event or an ordinary read.

import assert from "node:assert/strict";
import { writeSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

process.env.SUPABASE_URL = process.env.SUPABASE_URL || "https://example.supabase.co";
process.env.VITE_SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "dummy";
process.env.POSTGRES_URL = process.env.POSTGRES_URL || "postgres://u:p@localhost:5432/db";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKFLOW = resolve(HERE, "..", "..", ".github", "workflows", "scheduler-v2.yml");
const RELEASE_DIR = resolve(HERE, "release");

let passed = 0;
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const group = (label) => tests.push({ marker: label });

async function main() {
  const P = await import("../lib/server/sync/source-scheduled-prerequisites.js");
  const F = await import("../lib/server/sync/source-oli-freshness.js");
  const FL = await import("../lib/server/sync/source-oli-force-latest.js");
  const { runPriorityDashboardsRelease } = await import("../lib/server/sync/source-priority-release-runner.js");
  const { SCHEDULED_ENABLED_SOURCE_KEYS } = await import("../lib/server/sync/source-scheduled-oli.js");

  const yml = readFileSync(WORKFLOW, "utf8");
  const FROM = "2025-01-01";
  const D1 = "2026-08-26"; // requestedAsOf
  const D2 = "2026-08-25";
  const discN = (n, pfx = "N") => Array.from({ length: n }, (_, i) => ({ accountId: pfx + String(i + 1).padStart(2, "0") }));
  const covAll = (accounts, to) => { const c = {}, p = {}; accounts.forEach((a) => { c[a.accountId] = [{ from: FROM, to }]; p[a.accountId] = false; }); return { c, p }; };
  const gate = (accounts, cov, over = {}) => P.assessBucketPublishReadiness({ bucket: "non-us", requestedAsOf: D1, from: FROM, discoveredAccounts: accounts, coverageByAccountId: cov.c, provenanceBlankByAccountId: cov.p, cyclePresent: true, cycleOliAssessment: { ok: true, problems: [] }, requireD1: true, ...over });

  /* ---- 1: a stale D-2 cache cannot satisfy a D-1 force-latest run ---- */
  group("D-1 strict gate + fresh-fetch policy");

  test("1. a stale D-2 cache/coverage cannot satisfy a D-1 run -> DATADOE_D1_NOT_READY (never accepted as D-1)", () => {
    const accounts = discN(22);
    const r = gate(accounts, covAll(accounts, D2)); // every account proven only through D-2 (the stale-cache result)
    assert.equal(r.ok, false); assert.equal(r.status, "DATADOE_D1_NOT_READY");
    assert.equal(r.effectiveAsOf, null, "D-2 is never published as D-1");
    assert.equal(r.provenThrough, D2);
    // and force-latest bypasses the stale cache at the worker: forceFreshOli is authorized ONLY for OLI (below, #11).
  });

  test("2. a fresh D-1 export (every account gapless through D-1) -> D-1 SUCCESS (publishable)", () => {
    const accounts = discN(22);
    const r = gate(accounts, covAll(accounts, D1));
    assert.equal(r.ok, true); assert.equal(r.status, "exact"); assert.equal(r.effectiveAsOf, D1); assert.equal(r.d1.reason, "d1-proven");
  });

  test("3. DataDoe returns only D-2/unsettled -> DATADOE_D1_NOT_READY, ZERO false publication, LKG retained", () => {
    const accounts = discN(22);
    const cov = covAll(accounts, D1); // most at D-1...
    cov.c[accounts[0].accountId] = [{ from: FROM, to: D2 }]; // ...but one account still only D-2
    const r = gate(accounts, cov);
    assert.equal(r.ok, false); assert.equal(r.status, "DATADOE_D1_NOT_READY"); assert.equal(r.effectiveAsOf, null, "no publish");
    assert.equal(r.d1.missingCount, 1); assert.deepEqual(r.d1.missingAccounts, [accounts[0].accountId.slice(0, 8)]);
  });

  test("6. ONE seller-batch account behind D-1 is NEVER reported as full-bucket D-1 success", () => {
    const accounts = discN(8, "U");
    const cov = covAll(accounts, D1);
    cov.c[accounts[4].accountId] = [{ from: FROM, to: D2 }]; // one of the US 8 lags
    const r = P.assessBucketPublishReadiness({ bucket: "us", requestedAsOf: D1, from: FROM, discoveredAccounts: accounts, coverageByAccountId: cov.c, provenanceBlankByAccountId: cov.p, cyclePresent: true, cycleOliAssessment: { ok: true, problems: [] }, requireD1: true });
    assert.equal(r.ok, false); assert.equal(r.status, "DATADOE_D1_NOT_READY"); assert.equal(r.d1.missingCount, 1);
  });

  test("10. ads-disconnected accounts are typed unavailable + NON-BLOCKING for the D-1 OLI publish", () => {
    const accounts = discN(22);
    const cov = covAll(accounts, D1);
    const adsUnavailable = {}, adsCovered = {};
    accounts.forEach((a, i) => { adsUnavailable[a.accountId] = i < 5; adsCovered[a.accountId] = i >= 5; });
    const r = P.assessBucketPublishReadiness({ bucket: "non-us", requestedAsOf: D1, from: FROM, discoveredAccounts: accounts, coverageByAccountId: cov.c, provenanceBlankByAccountId: cov.p, adsCoveredByAccountId: adsCovered, adsUnavailableByAccountId: adsUnavailable, cyclePresent: true, cycleOliAssessment: { ok: true, problems: [] }, requireD1: true });
    assert.equal(r.ok, true, "5 ads-disconnected never block a fully-settled D-1 OLI publish");
    assert.ok((r.notes || []).some((n) => /ads-unavailable-note:5/.test(n)));
  });

  /* ---- force-latest reservation semantics ---- */
  group("force-latest reservation: run_id idempotency, missing-only, no ambiguous retry");

  const fetchDeps = (state, over = {}) => ({
    reserve: over.reserve || (async (h) => (state.recorded[h] ? { disposition: "exists", exportId: state.recorded[h] } : { disposition: "reserved" })),
    reopenJob: over.reopenJob || (async () => ({ reopened: true })),
    runFreshOli: over.runFreshOli || (async () => { state.runs += 1; }),
    readJobExport: over.readJobExport || (async (h) => ({ status: "succeeded", exportId: "exp-" + h })),
    record: over.record || (async (h, e) => { state.recorded[h] = e; return { disposition: "recorded" }; }),
  });

  test("4. SAME github.run_id replay creates ZERO additional exports (adopts its own recorded attempts)", async () => {
    const state = { recorded: {}, runs: 0 };
    const opKey = F.freshnessOperationKey({ mode: "force-latest", bucket: "non-us", requestedAsOf: D1, runId: "R1" });
    const batches = [{ requestHash: "h1" }, { requestHash: "h2" }];
    const r1 = await FL.runOliForceLatest({ operationKey: opKey, batches, deps: fetchDeps(state) });
    assert.equal(r1.creates, 2); assert.equal(r1.tokens, 4);
    // replay the SAME run_id (same operationKey): reservations now 'exists'+id -> adopt, ZERO new creates.
    const r2 = await FL.runOliForceLatest({ operationKey: opKey, batches, deps: fetchDeps(state) });
    assert.equal(r2.creates, 0, "no new exports on a same-run replay"); assert.equal(r2.adopted, 2);
  });

  test("5. a NEW authorized run_id re-attempts ONLY the still-missing D-1 window (a fresh operationKey creates)", async () => {
    const state = { recorded: {}, runs: 0 };
    const batches = [{ requestHash: "h1" }, { requestHash: "h2" }];
    // Model per-operation reservation state (each operationKey is a fresh namespace).
    const byOp = {};
    const deps = {
      reserve: async (h) => { const k = deps._op; byOp[k] = byOp[k] || {}; return byOp[k][h] ? { disposition: "exists", exportId: byOp[k][h] } : { disposition: "reserved" }; },
      reopenJob: async () => ({ reopened: true }), runFreshOli: async () => { state.runs += 1; },
      readJobExport: async (h) => ({ status: "succeeded", exportId: "exp-" + h }),
      record: async (h, e) => { byOp[deps._op][h] = e; return { disposition: "recorded" }; },
    };
    deps._op = F.freshnessOperationKey({ mode: "force-latest", bucket: "non-us", requestedAsOf: D1, runId: "R1" });
    const r1 = await FL.runOliForceLatest({ operationKey: deps._op, batches, deps });
    assert.equal(r1.creates, 2);
    // A NEW run_id + ONLY the still-missing batch (planForceLatestBatches scopes to missing accounts).
    deps._op = F.freshnessOperationKey({ mode: "force-latest", bucket: "non-us", requestedAsOf: D1, runId: "R2" });
    const stillMissing = FL.planForceLatestBatches({ missingAccounts: ["N06"], oliJobs: [{ request_hash: "h2" }], owners: [{ request_hash: "h2", account_id: "N06" }] });
    assert.deepEqual(stillMissing.map((b) => b.requestHash), ["h2"], "only the still-missing batch is re-fetched");
    const r2 = await FL.runOliForceLatest({ operationKey: deps._op, batches: stillMissing, deps });
    assert.equal(r2.creates, 1, "the new run_id makes exactly one more forced create -- only the missing window");
  });

  test("7. an AMBIGUOUS create (reserved-but-unrecorded) is NEVER retried (fail closed, zero create)", async () => {
    const state = { recorded: {}, runs: 0 };
    const opKey = F.freshnessOperationKey({ mode: "force-latest", bucket: "non-us", requestedAsOf: D1, runId: "R9" });
    // reserve returns 'exists' with NO export_id -> a create is in flight / commit-unknown.
    const r = await FL.runOliForceLatest({ operationKey: opKey, batches: [{ requestHash: "hX" }], deps: fetchDeps(state, { reserve: async () => ({ disposition: "exists", exportId: null }) }) });
    assert.equal(r.creates, 0); assert.equal(r.ambiguous, 1); assert.equal(state.runs, 0, "no forced pass on an ambiguous reservation");
    assert.ok(r.problems.some((p) => /ambiguous-reserved-unrecorded/.test(p)));
    // a forced fetch that does NOT end succeeded is left UNRECORDED (reservation stays reserved -> next replay is ambiguous).
    const state2 = { recorded: {}, runs: 0 };
    const r2 = await FL.runOliForceLatest({ operationKey: opKey, batches: [{ requestHash: "hY" }], deps: fetchDeps(state2, { readJobExport: async () => ({ status: "failed", exportId: null }) }) });
    assert.equal(r2.creates, 0, "a non-succeeded forced fetch records nothing"); assert.ok(r2.problems.some((p) => /fetch-not-succeeded/.test(p)));
  });

  /* ---- runner: bucket isolation + strict D-1 (no clamped publish) ---- */
  group("runner: strict D-1 publish vs DATADOE_D1_NOT_READY, bucket isolation 66/24");

  const THREE = ["daily-reporting", "brand-sales", "brand-inventory"];
  const idR = (a, d) => THREE.map((rk) => ({ reportKey: rk, disposition: d, liveReportKey: rk, paramsHash: "ph_" + rk + "_" + a }));
  const NONUS = Array.from({ length: 22 }, (_, i) => "N" + String(i + 1).padStart(2, "0"));
  const US = Array.from({ length: 8 }, (_, i) => "U" + String(i + 1).padStart(2, "0"));
  const rollupD1 = (n, clamped) => ({ rollup: { stopped: false, derived: { skipped: null, daily: { ready: true, saved: n }, brandView: { ready: true, saved: n }, brandInventory: { saved: n }, lineage: Array.from({ length: 3 * n }, (_, i) => i), effectivePublishAsOf: clamped ? D2 : D1, refreshAsOf: D1, asOfClamped: clamped === true } } });
  const rel = (bucket, clamped, calls) => ({
    publishOrder: THREE, reportKeys: THREE,
    deriveBucket: async (b) => { calls.derive.push(b); return rollupD1((b === "us" ? US : NONUS).length, clamped); },
    finalizeBucket: async (b) => { calls.finalize.push(b); return { disposition: "finalized", cycleStatus: "succeeded", accounts: b === "us" ? US : NONUS }; },
    preflightAccount: async (a) => ({ accountId: a, results: idR(a, "ready") }),
    publishAccount: async (a) => { calls.publish.push(a); return { accountId: a, results: idR(a, "published") }; },
    catalogReservation: async () => ({ tokensSpent: 2, status: "created" }),
  });
  const deps = (bucket, r) => ({ release: r, reconcile: async () => ({ ok: true }), readbackLive: async () => ({ ok: true }), assertNoCron: async () => ({ ok: true }), bucket, strictD1: true });

  test("8./9. a D-1-proven derive publishes EXACTLY 22x3=66 (non-us) / 8x3=24 (us) and never touches the other bucket", async () => {
    let c = { derive: [], finalize: [], publish: [] };
    const rn = await runPriorityDashboardsRelease(deps("non-us", rel("non-us", false, c)));
    assert.equal(rn.code, 0); assert.equal(rn.evidence.published, 66);
    assert.ok(c.publish.every((a) => NONUS.includes(a)) && c.publish.every((a) => !US.includes(a)), "non-us run never publishes a US account");
    assert.ok(!c.derive.includes("us") && !c.finalize.includes("us"), "non-us run never enters the US bucket");
    c = { derive: [], finalize: [], publish: [] };
    const ru = await runPriorityDashboardsRelease(deps("us", rel("us", false, c)));
    assert.equal(ru.code, 0); assert.equal(ru.evidence.published, 24);
    assert.ok(c.publish.every((a) => US.includes(a)) && c.publish.every((a) => !NONUS.includes(a)), "us run never publishes a Non-US account");
  });

  test("9./strict. a CLAMPED (D-2) derive under --strict-d1 FAILS CLOSED (DATADOE_D1_NOT_READY) with ZERO publish", async () => {
    const c = { derive: [], finalize: [], publish: [] };
    const r = await runPriorityDashboardsRelease(deps("non-us", rel("non-us", true, c)));
    assert.equal(r.code, 1); assert.equal(r.status, "DATADOE_D1_NOT_READY"); assert.match(r.stage, /d1-not-ready/);
    assert.equal(c.publish.length, 0, "nothing published when the derive clamps below D-1 (LKG retained)");
    assert.equal(c.finalize.length, 0, "never finalized/published a clamped bucket");
  });

  /* ---- structural: campaign/fba, summary distinction, schedules, activation guard ---- */
  group("structural: no campaign/fba, D-1-vs-lag summary, schedules, activation guard");

  test("11. force-fetch (forceFreshOli) is OLI-only: Campaign Ads (the active source) + FBA are never force-fetched; retired ASIN Ads is not schedule-enabled", () => {
    assert.ok(!SCHEDULED_ENABLED_SOURCE_KEYS.includes("ads-asin-date"), "ASIN Ads retired (not schedule-enabled)");
    assert.ok(!SCHEDULED_ENABLED_SOURCE_KEYS.some((k) => /fba/i.test(k)));
    // the runtime authorizes forceFreshOli ONLY for order-line-items (guarded in runSourceCardAction).
    const rt = readFileSync(resolve(HERE, "..", "lib", "server", "sync", "source-bucket-sync-runtime.js"), "utf8");
    assert.match(rt, /forceFreshOli === true && sourceKey === "order-line-items"/, "forceFreshOli gated to OLI only");
    const wk = readFileSync(resolve(HERE, "..", "lib", "server", "sync", "source-worker.js"), "utf8");
    assert.match(wk, /forceFreshOli && job\.sourceKey === "order-line-items"/, "cache-adoption skip gated to OLI only");
  });

  test("12./13. the readiness CLI writes D1_PROVISIONAL / D1_FINAL vs DATADOE_D1_NOT_READY summaries; safe-close is always()", () => {
    const cli = readFileSync(resolve(RELEASE_DIR, "verify-bucket-readiness.mjs"), "utf8");
    assert.match(cli, /D1_PROVISIONAL/, "a provisional D-1 success summary (published, not held)");
    assert.match(cli, /D1_FINAL/, "a fully-itemized D-1 success summary");
    assert.match(cli, /DATADOE_D1_NOT_READY/, "a distinct lagged/gapped-LKG summary still exists for interior gaps");
    assert.match(cli, /requireD1:\s*true/, "the CLI still gates the NON-defect accounts strictly on the D-1 window");
    assert.match(yml, /if:\s*always\(\) && steps\.guard\.outputs\.run_required == 'true'\n\s*run:\s*node scripts\/release\/priority-control-package\.mjs --rollback/, "safe-close ALWAYS for a pipeline execution");
  });

  test("14. schedules: the three regional primaries; each cron deterministically maps to one region; SHA/event/cron in the summary", () => {
    const crons = [...yml.matchAll(/- cron:\s*"([^"]+)"/g)].map((m) => m[1]).sort();
    assert.deepEqual(crons, ["0 3 * * *", "30 16 * * *", "30 8 * * *"].sort());
    assert.match(yml, /"0 3 \* \* \*"\)\s*region="india"/); assert.match(yml, /"30 8 \* \* \*"\)\s*region="europe-au"/);
    assert.match(yml, /"30 16 \* \* \*"\)\s*region="us-ca"/); assert.doesNotMatch(yml, /30 10 \* \* \*/);
    // the summary prints immutable metadata (SHA + event + cron) for provenance.
    assert.match(yml, /head\/workflow SHA/); assert.match(yml, /github\.sha/); assert.match(yml, /github\.event\.schedule/);
  });

  test("15. force-latest cannot be activated by a scheduled event or an ordinary read (dispatch-only + run_id required + typed key)", () => {
    // scheduled events are pinned to normal in the workflow.
    assert.match(yml, /mode="normal"/); assert.match(yml, /A SCHEDULED event is ALWAYS normal/);
    // the force-latest operation identity REQUIRES a github.run_id -- a normal run can never mint one.
    assert.throws(() => F.freshnessOperationKey({ mode: "force-latest", bucket: "non-us", requestedAsOf: D1 }), /requires a valid github\.run_id/);
    assert.throws(() => F.freshnessOperationKey({ mode: "normal", bucket: "non-us", requestedAsOf: D1, runId: "R1" }), /must NOT carry a run_id/);
    // a scheduled/normal key and a manual-force key are DISTINCT durable namespaces.
    assert.equal(F.freshnessOperationKey({ mode: "normal", bucket: "us", requestedAsOf: D1 }), "scheduled-fresh/us/2026-08-26");
    assert.equal(F.parseFreshnessOperationKey("manual-force/us/2026-08-26/42").mode, "force-latest");
    assert.throws(() => F.parseFreshnessOperationKey("manual-force/us/2026-08-26"), /fail closed/); // missing run_id
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
