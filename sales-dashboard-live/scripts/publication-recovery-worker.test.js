// Publication recovery worker (WP12 route design) -- integration / adversarial scenarios. Drives the REAL orchestrator
// (lib/server/recovery/worker.js) over the REAL route registry (routes.js) against the in-memory store (mirrors the
// 20260934 RPC semantics; the SQL self-test proves the real SQL agrees) and a fake route-CLI WORLD that models what each
// route CLI reports per (route, region, target, unit) -- TARGETS v2 for a route CLI, v1 for the four legacy CLIs. Every
// child argv is built through the REAL runner (buildRouteArgs: it throws on any unsafe argv). Plus static pins: the
// migration seed == the route registry, the scheduler-gate bucket grammar == the sync_cycles CHECK, the worker durable
// directory == the route CLI's, the store's SQL never sends a statement_timeout startup parameter. ZERO network / DB /
// DataDoe. 7-bit ASCII, LF.
import assert from "node:assert/strict";
import { writeSync, readFileSync } from "node:fs";
import { createRecoveryWorker, buildHandoffMatrix, compactVerifiedRows, servedConfirmedFromUnits, hasStaleUnit, handoffFor, TOKEN_CHANGE_ONLY_SWEEP_ROUTES } from "../lib/server/recovery/worker.js";
import { createMemoryStore } from "../lib/server/recovery/memory-store.js";
import {
  cycleBucketKind, evaluateSchedulerGate, upstreamBlockersFrom, reaperCandidates, buildWorkerDirectory, likeToRegExp, liveWriteBatches, recoveryPoolConfig,
  SCHEDULER_FIXED_CYCLE_BUCKETS, PAID_STALE_SECONDS, GATE_IN_FLIGHT_SECONDS, STRANDED_PARTIAL_SECONDS, SCHEDULER_GATE_SQL, DIRECTORY_SQL, SCHEDULER_GATE_ROW_LIMIT,
} from "../lib/server/recovery/store-pg.js";
import { PUBLICATION_ROUTES, routeById, utcDMinus1, sweepMemoQuery, ADS_CHANGE_PROBE_FIELDS } from "../lib/server/recovery/routes.js";
import { buildRouteArgs } from "../lib/server/recovery/runner.js";
import { CLASSES, HANDOFF_CLASSES } from "../lib/server/recovery/classify.js";
import { ROUTE_LIVE_ATTESTATIONS, missingLiveAttestation } from "../lib/server/recovery/config.js";
import { buildDurableDirectory } from "../lib/server/sync/route-publication-release.js";
import { FBA_PLAN_STALE_IN_FLIGHT_MS } from "../lib/server/sync/fba-plan-dependency-bundle.js";
import { marketplaceToday } from "../lib/marketplaces.js";

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); passed += 1; writeSync(1, `  ok ${n}\n`); };
const src = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const J = (x) => JSON.stringify(x);
writeSync(1, "publication-recovery-worker\n");

const T0 = Date.parse("2026-09-24T10:00:00Z");
const EPOCH = "2026-09-23";
const COUNTRY = { india: "IN", "europe-au": "DE", "us-ca": "US" };
const UNIT_ROUTES = new Set(["brand-view", "sku-movement", "brand-view-portfolio"]);
const S = (v) => (v == null ? "" : String(v));

// ---- the fake route-CLI world ------------------------------------------------------------------------------------
// target behaviour per (route, region, target): current | current-unserved | stale | stale-manifest | missing |
// stale+integrity-unit | stale+mismatch | stale+timeout | stale+timeout-landed | stale+spend | stale+zeroexport |
// writer-fenced | runfail
function makeWorld() {
  const w = { st: new Map(), tok: new Map(), asOf: new Map(), calls: [], hooks: {} };
  const key = (r, g, t) => `${r}|${g}|${t}`;
  w.set = (r, g, t, s, tok) => { w.st.set(key(r, g, t), s); if (tok !== undefined) w.tok.set(key(r, g, t), tok); };
  w.get = (r, g, t) => w.st.get(key(r, g, t));
  w.setTok = (r, g, t, tok) => w.tok.set(key(r, g, t), tok);
  w.scope = (r, g) => [...w.st.keys()].filter((k) => k.startsWith(`${r}|${g}|`)).map((k) => k.split("|").slice(2).join("|"));
  const H = (r, t, u) => `h-${r}-${t}-${u}`.replace(/[^A-Za-z0-9._:-]/g, "");
  w.run = async ({ route, region, asOf, targets, kind, runToken, now }) => {
    // The REAL runner argv builder: throws on anything unsafe (full-region live, missing run token, forbidden script...).
    buildRouteArgs({ route, region, asOf, targets, kind, runToken, now: typeof now === "function" ? now() : now });
    const r = routeById(route);
    w.calls.push({ route, region, kind, targets: targets ? [...targets].sort() : null, runToken: runToken || null });
    if (w.hooks.onRun) await w.hooks.onRun({ route, region, kind, targets });
    const base = { route, kind, spawnError: null, capacityExceeded: null, oom: false, stop: null, stderrTail: [], durationMs: 1000 };
    if (kind === "cleanup") return { ...base, exitCode: 0, timedOut: false, result: { mode: "cleanup", cleaned: true }, targets: null, zeroExport: { blocked: 0 } };
    const scope = targets || w.scope(route, region);
    const live = kind === "live" || kind === "repair";
    if (scope.some((t) => w.get(route, region, t) === "runfail")) {
      const payload = r.kind === "route-cli" ? { v: 2, route, bucket: region, epoch: asOf, dryRun: !live, outcome: "failed", code: "DURABLE_SOURCE_UNREADABLE", dataDoeCreates: 0, dataDoeTokens: 0, controlCleanupUnresolved: false, targets: [] }
        : { v: 1, family: route, bucket: region, requestedAsOf: asOf, dryRun: !live, outcome: "failed", code: "DURABLE_SOURCE_UNREADABLE", dataDoeCreates: 0, dataDoeTokens: 0, controlCleanupUnresolved: false, accounts: [] };
      return { ...base, exitCode: 1, timedOut: false, result: { ok: false, outcome: "failed", code: "DURABLE_SOURCE_UNREADABLE" }, targets: payload, zeroExport: { blocked: 0 } };
    }
    let timedOut = false, spend = false, blocked = 0;
    const out = [];
    for (const t of scope) {
      const st = w.get(route, region, t) || "missing";
      const tok = w.tok.get(key(route, region, t)) ?? `tok-${route}-${t}`;
      const unitAsOf = w.asOf.get(key(route, region, t)) || asOf;
      const units = UNIT_ROUTES.has(route) ? ["b1", "b2"] : ["-"];
      const rows = [];
      let next = st;
      for (const u of units) {
        let s, rs = null, served = true;
        const cur = () => { s = "PUBLICATION_NOT_REQUIRED"; };
        if (st === "current") cur();
        else if (st === "current-unserved") { cur(); served = false; }
        else if (st === "missing") { s = "DEFERRED_PROVENANCE"; rs = "catalog-missing"; }
        else if (st === "writer-fenced") { if (live) { s = "FAILED_PUBLISH"; rs = "REPORT_WRITER_FENCED:brand-sales"; } else { s = "STALE"; rs = "live-refresh-differs"; } }
        else if (st === "stale+integrity-unit" && u === "b2") { s = "DEFERRED_PROVENANCE"; rs = "portfolio-scope-id-too-long"; }
        else if (st === "stale-manifest") {
          if (kind === "repair") { s = "PUBLISHED_LIVE"; next = "current"; }
          else if (kind === "verify") { s = "STALE"; rs = "manifest-differs"; }
          else cur();
        } else if (st.startsWith("stale") || st === "stale+integrity-unit") {
          if (!live) { s = "STALE"; rs = "live-refresh-differs"; }
          else if (st === "stale+timeout") timedOut = true;
          else if (st === "stale+timeout-landed") { timedOut = true; next = "current"; }
          else if (st === "stale+zeroexport") { blocked = 1; s = "PUBLISHED_LIVE"; next = "current"; }
          else if (st === "stale+spend") { spend = true; s = "PUBLISHED_LIVE"; next = "current"; }
          else if (st === "stale+mismatch") { s = "PUBLISHED_LIVE"; }
          else { s = "PUBLISHED_LIVE"; next = st === "stale+integrity-unit" ? "stale+integrity-unit:done" : "current"; }
        } else if (st === "stale+integrity-unit:done") { if (u === "b2") { s = "DEFERRED_PROVENANCE"; rs = "portfolio-scope-id-too-long"; } else cur(); }
        else { s = "STALE"; rs = "unexpected"; }
        for (const rk of r.publisherKeys) {
          const h = H(route, t, u);
          rows.push({ u, rk, s, r: rs, asOf: unitAsOf, h: s === "PUBLICATION_NOT_REQUIRED" ? h : null, sra: s === "PUBLICATION_NOT_REQUIRED" ? "2026-09-24T09:00:00.000Z" : null, served: s === "PUBLICATION_NOT_REQUIRED" && served ? { id: "row-" + u, h, sra: "2026-09-24T09:00:00.000Z" } : null });
        }
      }
      if (next !== st) w.st.set(key(route, region, t), next);
      if (timedOut) continue;
      const owners = r.grain === "region" ? (w.members || []) : [t];
      if (r.kind === "route-cli") out.push({ id: t, owners, tok, units: rows });
      else out.push({ id: t, eligible: st !== "missing", rev: "rev-" + t, status: "nonempty", reports: Object.fromEntries(rows.map((x) => [x.rk, { s: x.s, r: x.r }])) });
    }
    if (live && w.hooks.afterLive) await w.hooks.afterLive({ route, region, targets: scope });
    if (timedOut) return { ...base, exitCode: null, signal: "SIGTERM", timedOut: true, result: null, targets: null, zeroExport: { blocked: 0 }, durationMs: 420000 };
    const common = { dryRun: !live, outcome: "complete", code: "OK", dataDoeCreates: spend ? 1 : 0, dataDoeTokens: spend ? 2 : 0, controlCleanupUnresolved: false };
    const payload = r.kind === "route-cli" ? { v: 2, route, bucket: region, epoch: asOf, ...common, targets: out } : { v: 1, family: route, bucket: region, requestedAsOf: asOf, ...common, accounts: out };
    return { ...base, exitCode: 0, timedOut: false, result: { ok: true, dataDoeCreates: common.dataDoeCreates, dataDoeTokens: common.dataDoeTokens }, targets: payload, zeroExport: { blocked } };
  };
  return w;
}

const ALL_ATTESTED = { skuMovementServeToken: true, fbaPlanRouteFence: true, lhv3ServeGate: true };
function makeRig({ liveRoutes = PUBLICATION_ROUTES.map((r) => r.id), regions = ["india"], control = null, attestations = ALL_ATTESTED, childMaxOldSpaceMb = 448, workerId = "w1", world, store, clockRef, dir = { india: ["A1", "A2"] }, configExtra = {} } = {}) {
  const clk = clockRef || { t: T0 };
  const st = store || createMemoryStore({ clock: () => clk.t, control });
  if (!store) st.env.directoryAccounts = Object.entries(dir).flatMap(([g, ids]) => ids.map((id) => ({ accountId: id, country: COUNTRY[g], name: "Acct " + id, currency: "INR" })));
  const wd = world || makeWorld();
  wd.members = wd.members || (dir.india || []).slice().sort();
  let n = 0;
  const config = {
    workerId, host: "test", pollSeconds: 20, scanIntervalSeconds: 600, scanLeaseSeconds: 3600, batch: 5, leaseSeconds: 2700, maxAttempts: 4, maxClaims: 5, maxRearms: 12,
    childMaxOldSpaceMb, keepDays: 14, stopGraceSeconds: 1, schedulerCooldownSeconds: 900, schedulerWindows: [], deepSweepHours: 6, awaitMaxMinutes: 120,
    liveRoutes, regions, concurrency: 1, attestations, ...configExtra,
  };
  const logs = [];
  const worker = createRecoveryWorker({ store: st, run: wd.run, config, clock: () => clk.t, sleep: async (ms) => { clk.t += ms; }, randomUUID: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`, version: "test", organizationFingerprint: "org-fp-test", log: (m) => logs.push(m) });
  return { clk, store: st, world: wd, worker, config, logs };
}
// Evidence: the route's compose result for a (route, region) -- { target: token | { token:null, reason } }.
const setEv = (rig, route, region, entries) => rig.store.env.evidence.set(`${route}|${region}`, () => new Map(Object.entries(entries).map(([tk, v]) => {
  const owners = tk.startsWith("region:") ? rig.world.members : [tk];
  return [tk, typeof v === "string" ? { token: v, owners, region, alerts: [] } : { token: null, owners, region, alerts: [], reason: v.reason }];
})));
const jobsOf = (store, route) => store.jobs.filter((j) => !route || j.route_id === route);
const stateOf = (store, route, tk, region = "india", epoch = EPOCH) => store.state.get(`${route}|${region}|${tk}|${epoch}`);
const kindsOf = (world) => world.calls.map((c) => c.kind);
const drain = async (rig, max = 30) => { let i = 0; while (i < max && (await rig.worker.processOneBatch())) i += 1; return i; };

// ======================================================================================================================
// 1. normal save -> watermark -> pre-check STALE -> live -> verify -> verified with a token echo
{
  const rig = makeRig({ liveRoutes: ["returns-v3"] });
  setEv(rig, "returns-v3", "india", { A1: "rt-1", A2: "rt-2" });
  rig.world.set("returns-v3", "india", "A1", "stale", "rt-1"); rig.world.set("returns-v3", "india", "A2", "current", "rt-2");
  const n = await rig.worker.watermarkPass();
  ok("1a: the watermark enqueues every live target with no state row (origin watermark, route priority)", n === 2 && jobsOf(rig.store).every((j) => j.origin === "watermark" && j.priority === routeById("returns-v3").priority && j.evidence_token));
  await rig.worker.processOneBatch();
  const a1 = jobsOf(rig.store).find((j) => j.target_key === "A1"), a2 = jobsOf(rig.store).find((j) => j.target_key === "A2");
  ok("1b: ONE coherent batch: pre-check (--verify-exact) over both -> live for the STALE one only (unique run token) -> verify (--verify-exact)", J(kindsOf(rig.world)) === J(["verify", "live", "verify"]) && J(rig.world.calls[1].targets) === J(["A1"]) && /^prw-w1-returns-v3-india-/.test(rig.world.calls[1].runToken) && J(rig.world.calls[2].targets) === J(["A1"]));
  ok("1c: A1 verified (published) with the token ECHO (the verify child's evaluated token == the job's); A2 verified already-current WITHOUT a publish", a1.status === "verified" && a1.published === true && stateOf(rig.store, "returns-v3", "A1").verified_token === "rt-1" && a2.status === "verified" && a2.published === false);
  ok("1d: the state records the hand-off (repaired / already-current), the served read-back proof and unit verified_rows", stateOf(rig.store, "returns-v3", "A1").handoff === "repaired" && stateOf(rig.store, "returns-v3", "A2").handoff === "already-current" && stateOf(rig.store, "returns-v3", "A1").served_confirmed === true && stateOf(rig.store, "returns-v3", "A1").verified_rows[0].rk === "returns-leakage-v3" && stateOf(rig.store, "returns-v3", "A1").verified_rows[0].asOf === EPOCH);
  rig.world.calls.length = 0;
  await rig.worker.watermarkPass(); rig.clk.t += 700 * 1000; await rig.worker.watermarkPass();
  ok("1e: unchanged evidence is never re-enqueued (verified token == evidence token)", jobsOf(rig.store).length === 2 && rig.world.calls.length === 0 && (await rig.store.enqueue({ route: "returns-v3", region: "india", targetKey: "A1", owners: ["A1"], asOf: EPOCH, token: "rt-1", origin: "watermark" })) === "already-verified");
  // legacy route (TARGETS v1): the four legacy CLIs keep their exact argv; verified on the binding + the worker's own token re-read.
  const lg = makeRig({ liveRoutes: ["oli"] });
  setEv(lg, "oli", "india", { A1: "cov:1" });
  lg.world.set("oli", "india", "A1", "stale");
  await lg.worker.watermarkPass();
  const jobEv = [];
  const origJobRead = lg.store.readRouteEvidence.bind(lg.store);
  lg.store.readRouteEvidence = async (route, ctx, ...rest) => { jobEv.push({ rest }); return origJobRead(route, ctx, ...rest); };
  await lg.worker.processOneBatch();
  lg.store.readRouteEvidence = origJobRead;
  // 1j [tier-1 perf] the per-job token re-read of a legacy settle (settleCurrent -> currentToken) never gets a sweep cache.
  ok("1j [tier-1 perf]: the per-job token re-read of a legacy settle passes NO sweep cache (fresh read)",
    jobEv.length >= 1 && jobEv.every((c) => !(c.rest[0] && c.rest[0].sweepCache)));
  ok("1f: a legacy route runs dry-run -> live -> dry-run with its byte-identical argv; verified (v1 carries no evaluated token: the worker re-read its own)", J(kindsOf(lg.world)) === J(["dry-run", "live", "dry-run"]) && jobsOf(lg.store)[0].status === "verified" && J(buildRouteArgs({ route: "oli", region: "india", asOf: EPOCH, targets: ["A1"], kind: "live", runToken: "prw-w1-oli-india-1-abc" })) === J(["scripts/release/oli-publication-reconcile.mjs", "--bucket=india", `--as-of=${EPOCH}`, "--mode=periodic", "--accounts=A1", "--deadline-seconds=330", "--run-token=prw-w1-oli-india-1-abc", "--emit-targets", "--live"]));
  ok("1g: a legacy verification has NO served proof yet (v1 units carry none) -> the hand-off matrix says deferred:current-unserved", stateOf(lg.store, "oli", "A1").served_confirmed === null && buildHandoffMatrix({ stateRows: (await lg.store.status()).state, directory: await lg.store.readDirectory(), regions: ["india"] }).some((r) => r.accountId === "A1" && r.reportKey === "brand-sales" && r.handoff === "deferred" && r.type === "current-unserved"));
  await lg.worker.tier1Scan();
  ok("1h: the tier-1 served-row check CONFIRMS the legacy served row (no live write since verification) -> repaired in the matrix", stateOf(lg.store, "oli", "A1").served_confirmed === true && buildHandoffMatrix({ stateRows: (await lg.store.status()).state, directory: await lg.store.readDirectory(), regions: ["india"] }).some((r) => r.accountId === "A1" && r.reportKey === "brand-sales" && r.handoff === "repaired"));
  lg.store.env.liveRows.push({ report_key: "brand-sales", account_id: "A1", params: {}, updated_ms: lg.clk.t + 5000 });
  lg.clk.t += 601 * 1000; lg.world.calls.length = 0;
  await lg.worker.tier1Scan();
  const obs = [...lg.store.observations.values()].find((o) => o.route_id === "oli" && o.target_key === "A1" && o.tier === 1);
  ok("1i: a foreign served-row write after verification on a LEGACY family is DETECTION-ONLY (observation + alert, served proof revoked, no enqueue)", obs.state === "served-row-foreign" && obs.alert === "served-row-foreign" && stateOf(lg.store, "oli", "A1").served_confirmed === false && jobsOf(lg.store).length === 1 && lg.store.scanRow.tier1Summary.alerts.some((a) => a.code === "served-row-foreign"));
}

// 2. MISSED GITHUB RUN: the scheduler never runs; tier-1 (token change / identity rollover / foreign write) enqueues
{
  const rig = makeRig({ liveRoutes: ["brand-view", "returns-v3"] });
  setEv(rig, "brand-view", "india", { A1: "bv-1" });
  setEv(rig, "returns-v3", "india", { A1: "rt-1" });
  const inToday = marketplaceToday("IN", new Date(T0));
  rig.world.set("brand-view", "india", "A1", "stale", "bv-1"); rig.world.asOf.set("brand-view|india|A1", inToday);
  rig.world.set("returns-v3", "india", "A1", "current", "rt-1");
  await rig.worker.tier1Scan();
  ok("2a: with NO watermark and NO scheduler, the first tier-1 enqueues every missing target (origin scan)", jobsOf(rig.store).length === 2 && jobsOf(rig.store).every((j) => j.origin === "scan"));
  await drain(rig);
  ok("2b: the worker publishes + verifies them alone (brand-view repaired; returns already-current)", jobsOf(rig.store, "brand-view")[0].status === "verified" && jobsOf(rig.store, "brand-view")[0].published === true && jobsOf(rig.store, "returns-v3")[0].status === "verified" && stateOf(rig.store, "brand-view", "A1").verified_rows.every((v) => v.asOf === inToday));
  // identity rollover: IN midnight passes (UTC 18:30); the epoch (UTC D-1) is unchanged.
  rig.clk.t = Date.parse("2026-09-24T19:00:00Z");
  rig.world.set("brand-view", "india", "A1", "stale"); rig.world.asOf.set("brand-view|india|A1", marketplaceToday("IN", new Date(rig.clk.t)));
  await rig.worker.tier1Scan();
  const roll = jobsOf(rig.store, "brand-view").find((j) => j.status === "pending");
  ok("2c: IDENTITY ROLLOVER (identityAsOf vs verified_rows[].asOf) -> tier-1 enqueues brand-view (origin scan) although its token did not change", utcDMinus1(rig.clk.t) === EPOCH && roll && roll.origin === "scan" && roll.evidence_token === "bv-1");
  await drain(rig);
  ok("2d: ... and the worker republishes it at the new identity as-of", jobsOf(rig.store, "brand-view").filter((j) => j.status === "verified").length === 2 && stateOf(rig.store, "brand-view", "A1").verified_rows.every((v) => v.asOf === "2026-09-25"));
  // token change seen by tier-1 alone (watermark not run)
  setEv(rig, "returns-v3", "india", { A1: "rt-2" }); rig.world.set("returns-v3", "india", "A1", "stale", "rt-2");
  rig.clk.t += 601 * 1000;
  await rig.worker.tier1Scan();
  ok("2e: a TOKEN CHANGE with no watermark is enqueued by tier-1 (origin scan) and republished", jobsOf(rig.store, "returns-v3").some((j) => j.status === "pending" && j.evidence_token === "rt-2" && j.origin === "scan"));
  await drain(rig);
  ok("2f: ... verified for the NEW token", stateOf(rig.store, "returns-v3", "A1").verified_token === "rt-2");
  // a foreign served-row write on a ROUTE is re-checked (enqueue), never ignored
  rig.store.env.liveRows.push({ report_key: "returns-leakage", account_id: "A1", params: {}, updated_ms: rig.clk.t + 1000 });
  rig.clk.t += 601 * 1000;
  await rig.worker.tier1Scan();
  ok("2g: a foreign served-row write on a route-owned key after verification re-enqueues a re-check (origin scan) + revokes the served proof", jobsOf(rig.store, "returns-v3").some((j) => j.status === "pending" && j.origin === "scan") && stateOf(rig.store, "returns-v3", "A1").served_confirmed === false);
  ok("2h: the tier-1 summary records its duration and findings (the metadata-only 10-minute pass)", typeof rig.store.scanRow.tier1Summary.durationMs === "number" && rig.store.scanRow.tier1Summary.findings["served-row-foreign"] >= 1 && rig.worker.stats.tier1Scans === 4);
}

// 3. GLOBAL SCHEDULER GATE
{
  const mk = () => { const r = makeRig({ liveRoutes: ["returns-v3"] }); setEv(r, "returns-v3", "india", { A1: "rt-1" }); r.world.set("returns-v3", "india", "A1", "stale", "rt-1"); return r; };
  const r1 = mk();
  r1.store.env.cycles.push({ bucket: "europe-au-fba", status: "running", started_ms: T0 - 600000, updated_ms: T0 - 60000 });
  await r1.store.enqueue({ route: "returns-v3", region: "india", targetKey: "A1", owners: ["A1"], asOf: EPOCH, token: "rt-1", origin: "scan" });
  await r1.worker.processOneBatch();
  const j1 = jobsOf(r1.store)[0];
  ok("3a: a RUNNING europe-au paid FBA cycle defers an INDIA job (the gate is GLOBAL): deferred scheduler-window-global, NO attempt, NO child, state untouched", j1.status === "deferred" && j1.last_class === "scheduler-window-global" && j1.attempts === 0 && r1.world.calls.length === 0 && !stateOf(r1.store, "returns-v3", "A1") && j1.next_attempt_at - r1.clk.t === 300000);
  const r2 = mk();
  r2.store.env.cycles.push({ bucket: "india", status: "succeeded", started_ms: T0 - 3 * 3600000, updated_ms: T0 - 5 * 60000 });
  await r2.store.enqueue({ route: "returns-v3", region: "india", targetKey: "A1", owners: ["A1"], asOf: EPOCH, token: "rt-1", origin: "scan" });
  await r2.worker.processOneBatch();
  ok("3b: COOLDOWN after the natural cycle finished (updated 5 min ago < 900 s) still defers", jobsOf(r2.store)[0].last_class === "scheduler-window-global" && r2.world.calls.length === 0);
  r2.clk.t += 16 * 60000;
  await r2.worker.processOneBatch();
  ok("3c: ... and once the cooldown passed the job runs", jobsOf(r2.store)[0].status === "verified");
  const r3 = mk();
  r3.store.env.cycles.push({ bucket: "priority-partial-india-0123456789abcdef", status: "running", started_ms: T0 - 60000, updated_ms: T0 - 1000, report_jobs: 1, open_report_jobs: 1 });
  await r3.store.enqueue({ route: "returns-v3", region: "india", targetKey: "A1", owners: ["A1"], asOf: EPOCH, token: "rt-1", origin: "scan" });
  await r3.worker.processOneBatch();
  ok("3d: a running PRIORITY-PARTIAL (route / priority) cycle never blocks", jobsOf(r3.store)[0].status === "verified");
  const g = (rows) => evaluateSchedulerGate(rows, { cooldownSeconds: 900 });
  ok("3e: the Data Sync Center paid FBA sync (legacy us-fba / non-us-fba) and a bootstrap-fba wave block; an UNKNOWN bucket blocks fail-closed + alert; a 5-hour-old idle natural cycle does not", g([{ bucket: "us-fba", status: "running", age_seconds: 60, idle_seconds: 60 }]).blocked && g([{ bucket: "non-us-fba", status: "pending", age_seconds: 60, idle_seconds: 60 }]).blocked && g([{ bucket: "bootstrap-fba-us-ca-0123456789abcdef", status: "running", age_seconds: 60, idle_seconds: 999 }]).blocked && g([{ bucket: "weird-bucket", status: "running", age_seconds: 60, idle_seconds: 60 }]).blocked && g([{ bucket: "weird-bucket", status: "running", age_seconds: 60, idle_seconds: 60 }]).alerts.some((a) => a.code === "unknown-cycle-bucket") && !g([{ bucket: "india", status: "running", age_seconds: 5 * 3600, idle_seconds: 3600 }]).blocked);
  const al = g([
    { bucket: "priority-partial-india-0123456789abcdef", status: "running", age_seconds: STRANDED_PARTIAL_SECONDS + 1, idle_seconds: 9999, report_jobs: 1, open_report_jobs: 1 },
    { bucket: "priority-partial-us-ca-0123456789abcdef", status: "running", age_seconds: STRANDED_PARTIAL_SECONDS + 1, idle_seconds: 9999, report_jobs: 0, source_jobs: 0 },
    { bucket: "india-fba", status: "running", age_seconds: 7 * 3600, idle_seconds: 6 * 3600 + 1, open_fba_plan_age_seconds: 6 * 3600 + 5 },
  ]);
  ok("3f: status alerts -- a running priority-partial cycle > 2 x hard timeout WITH a job is 'stranded-partial-cycle'; a JOB-LESS one is an ignored orphan (never a stall); an open paid fba cycle idle > 6 h is 'paid-cycle-stale-open' + its open fba-plan job 'paid-job-stale-in-flight'", !al.blocked && al.alerts.filter((a) => a.code === "stranded-partial-cycle").length === 1 && al.orphanPartial === 1 && al.alerts.some((a) => a.code === "paid-cycle-stale-open" && a.bucket === "india-fba") && al.alerts.some((a) => a.code === "paid-job-stale-in-flight"));
  const r4 = mk();
  r4.config.schedulerWindows = [{ from: 9 * 60 + 30, to: 10 * 60 + 30 }];
  await r4.store.enqueue({ route: "returns-v3", region: "india", targetKey: "A1", owners: ["A1"], asOf: EPOCH, token: "rt-1", origin: "scan" });
  await r4.worker.processOneBatch();
  ok("3g: a configured PRW_SCHEDULER_WINDOWS window defers without an attempt", jobsOf(r4.store)[0].last_class === "scheduler-window-global" && /scheduler-window-configured/.test(jobsOf(r4.store)[0].last_reason) && jobsOf(r4.store)[0].attempts === 0);
  const orphanRows = [
    { id: "o", bucket: "priority-partial-us-ca-0123456789abcdef", status: "running", cycle_date: "2026-09-22", age_seconds: STRANDED_PARTIAL_SECONDS + 1, idle_seconds: 9999, report_jobs: 0, source_jobs: 0 },
    { id: "oc", bucket: "priority-partial-us-ca-00112233445566ff", status: "running", cycle_date: EPOCH, age_seconds: STRANDED_PARTIAL_SECONDS + 1, idle_seconds: 9999, report_jobs: 0, source_jobs: 0 },
  ];
  const noEpoch = reaperCandidates(orphanRows);
  const withEpoch = reaperCandidates(orphanRows, { epoch: EPOCH });
  ok("3g1: WP12 verifier P2-2 -- the reaper finalizes a job-less orphan priority-partial ONLY of a PAST epoch; a CURRENT-epoch orphan (it resumes on the next run with the same evidence) and ANY orphan with an unknown epoch are 'never'",
    withEpoch.find((x) => x.id === "o").action === "finalize-orphan-partial" && withEpoch.find((x) => x.id === "oc").action === "never" && /CURRENT epoch/.test(withEpoch.find((x) => x.id === "oc").why)
    && noEpoch.every((x) => x.action === "never") && /reaperCandidates\(rows, \{ epoch \}\)/.test(src("scripts/worker/publication-recovery-reaper.mjs")));
  const rp = reaperCandidates([
    orphanRows[0],
    { id: "l", bucket: "priority-partial-india-0123456789abcdef", status: "running", age_seconds: 99999, idle_seconds: 99999, report_jobs: 1, open_report_jobs: 1, failed_report_jobs: 0 },
    { id: "f", bucket: "priority-partial-india-fedcba9876543210", status: "running", age_seconds: 99999, idle_seconds: 99999, report_jobs: 1, open_report_jobs: 0, failed_report_jobs: 1 },
    { id: "d", bucket: "india-fba", status: "running", age_seconds: 99999, idle_seconds: 7 * 3600, report_jobs: 3, open_report_jobs: 0, source_jobs: 2, open_source_jobs: 0 },
    { id: "p", bucket: "us-fba", status: "running", age_seconds: 99999, idle_seconds: 7 * 3600, report_jobs: 3, open_report_jobs: 1 },
    { id: "n", bucket: "india", status: "running", age_seconds: 600, idle_seconds: 60, report_jobs: 3, open_report_jobs: 3 },
  ], { epoch: EPOCH });
  // WP12 verifier P3s -- the gate never opens silently: a truncated read fails CLOSED; a RELAXED open cycle alerts at once.
  // The SQL sorts non-priority-partial rows FIRST: a truncated read ending on a priority-partial row kept every scheduler
  // row (alert only -- stranded priority-partials can never close the gate for good); one ending on a scheduler row may
  // have dropped one (fail CLOSED).
  const ppRows = Array.from({ length: 500 }, (_, i) => ({ id: "pp" + i, bucket: "priority-partial-india-" + String(i).padStart(16, "0"), status: "running", age_seconds: 60, idle_seconds: 60, report_jobs: 1 }));
  const truncatedPp = evaluateSchedulerGate(ppRows, { rowLimit: 500 });
  const schedRows = Array.from({ length: 500 }, (_, i) => ({ id: "s" + i, bucket: i % 2 ? "india" : "india-fba", status: "succeeded", age_seconds: 99999, idle_seconds: 99999, report_jobs: 1 }));
  const truncatedSched = evaluateSchedulerGate(schedRows, { rowLimit: 500 });
  const relaxed = evaluateSchedulerGate([{ id: "r", bucket: "europe-au", status: "running", cycle_date: EPOCH, age_seconds: 5 * 3600, idle_seconds: 1200, report_jobs: 3, open_report_jobs: 1 }]);
  ok("3g3: a gate read truncated on a SCHEDULER row is BLOCKED ('gate-read-truncated'); one truncated on a priority-partial row (the SQL sorts scheduler rows first) only ALERTS scheduler-gate-truncated; an open cycle past the 4 h in-flight bound and the cooldown stops blocking but raises 'scheduler-cycle-relaxed-open' immediately; the SQL orders non-priority-partial first + limit == SCHEDULER_GATE_ROW_LIMIT",
    truncatedSched.blocked === true && truncatedSched.alerts.some((x) => x.code === "scheduler-gate-truncated" && x.blocking === true)
    && truncatedPp.blocked === false && truncatedPp.alerts.some((x) => x.code === "scheduler-gate-truncated" && x.blocking === false)
    && relaxed.blocked === false && relaxed.alerts.some((x) => x.code === "scheduler-cycle-relaxed-open" && x.bucket === "europe-au" && x.kind === "scheduler")
    && SCHEDULER_GATE_SQL.endsWith("order by (c.bucket like 'priority-partial-%'), c.updated_at desc limit " + SCHEDULER_GATE_ROW_LIMIT) && SCHEDULER_GATE_ROW_LIMIT === 500);
  const act = (id) => (rp.find((x) => x.id === id) || {}).action;
  ok("3g2: the REAPER (operator tool, never the worker) finalizes ONLY a job-less orphan priority-partial or a DRAINED stuck cycle; NEVER a priority-partial holding a pending / failed job (the LHv3 salted retry rule) nor a paid cycle with an open job; a fresh cycle is no candidate", act("o") === "finalize-orphan-partial" && act("l") === "never" && act("f") === "never" && act("d") === "finalize-drained" && act("p") === "never" && act("n") === undefined && !/finalize_sync_cycle/.test(src("lib/server/recovery/worker.js") + src("lib/server/recovery/store-pg.js")));
  ok("3h: the gate constants: 4 h in-flight window; paid staleness 6 h == the fba-plan route's FBA_PLAN_STALE_IN_FLIGHT_MS; stranded bound 2 x 840 s", GATE_IN_FLIGHT_SECONDS === 4 * 3600 && PAID_STALE_SECONDS * 1000 === FBA_PLAN_STALE_IN_FLIGHT_MS && STRANDED_PARTIAL_SECONDS === 2 * Math.max(...PUBLICATION_ROUTES.map((r) => r.hardTimeoutSeconds)));
}

// 4. LIVE-STATE AWAITS
{
  const mk = () => {
    const r = makeRig({ liveRoutes: ["fba-plan", "brand-view-brands"] });
    setEv(r, "fba-plan", "india", { A1: "fp-1", A2: "fp-2" }); setEv(r, "brand-view-brands", "india", { A1: "bb-1", A2: "bb-2" });
    r.world.set("brand-view-brands", "india", "A1", "stale", "bb-1"); r.world.set("brand-view-brands", "india", "A2", "stale", "bb-2");
    return r;
  };
  const r1 = mk();
  await r1.store.recordBaseline([{ route_id: "fba-plan", region: "india", target_key: "A1", requested_as_of: EPOCH, owners: ["A1"], token: "fp-1", class: "stale", reason: "live-refresh-differs" }]);
  for (const a of ["A1", "A2"]) await r1.store.enqueue({ route: "brand-view-brands", region: "india", targetKey: a, owners: [a], asOf: EPOCH, token: a === "A1" ? "bb-1" : "bb-2", origin: "scan", priority: 5 });
  await r1.worker.processOneBatch();
  const b1 = jobsOf(r1.store, "brand-view-brands").find((j) => j.target_key === "A1"), b2 = jobsOf(r1.store, "brand-view-brands").find((j) => j.target_key === "A2");
  ok("4a: a STALE upstream state (fba-plan, same owner, this epoch) blocks the owner -- deferred awaiting-upstream:fba-plan, NO attempt; the other owner proceeds", b1.status === "deferred" && /awaiting-upstream:fba-plan/.test(b1.last_reason) && b1.attempts === 0 && b2.status === "verified" && J(r1.world.calls.find((c) => c.kind === "live").targets) === J(["A2"]));
  const r2 = mk();
  await r2.store.enqueue({ route: "fba-plan", region: "india", targetKey: "A1", owners: ["A1"], asOf: EPOCH, token: "fp-1", origin: "scan", priority: 2 });
  const up = r2.store.jobs[0]; up.status = "deferred"; up.last_class = "missing-evidence"; up.next_attempt_at = T0 + 3600000;
  await r2.store.enqueue({ route: "fba-plan", region: "india", targetKey: "A2", owners: ["A2"], asOf: EPOCH, token: "fp-2", origin: "scan", priority: 2 });
  const up2 = r2.store.jobs[1]; up2.status = "dead"; up2.last_class = "permanent-integrity";
  for (const a of ["A1", "A2"]) await r2.store.enqueue({ route: "brand-view-brands", region: "india", targetKey: a, owners: [a], asOf: EPOCH, token: a === "A1" ? "bb-1" : "bb-2", origin: "scan", priority: 5 });
  await r2.worker.processOneBatch();
  ok("4b: a MISSING-EVIDENCE (deferred) upstream and a DEAD upstream do NOT block", jobsOf(r2.store, "brand-view-brands").every((j) => j.status === "verified"));
  const r3 = mk();
  await r3.store.enqueue({ route: "fba-plan", region: "india", targetKey: "A1", owners: ["A1"], asOf: EPOCH, token: "fp-1", origin: "scan", priority: 2 });
  r3.store.jobs[0].next_attempt_at = T0 + 99 * 3600000; // an open upstream the claim will not pick now
  await r3.store.enqueue({ route: "brand-view-brands", region: "india", targetKey: "A1", owners: ["A1"], asOf: EPOCH, token: "bb-1", origin: "scan", priority: 5 });
  await r3.worker.processOneBatch();
  ok("4c: an OPEN upstream job blocks (deferred 180 s, no attempt)", jobsOf(r3.store, "brand-view-brands")[0].status === "deferred" && jobsOf(r3.store, "brand-view-brands")[0].next_attempt_at - r3.clk.t === 180000);
  r3.clk.t += 121 * 60000;
  await r3.worker.processOneBatch();
  const late = jobsOf(r3.store, "brand-view-brands")[0];
  ok("4d: past PRW_AWAIT_MAX_MINUTES since the job's creation it PROCEEDS with alert 'await-timeout'", late.status === "verified" && /await-timeout/.test(late.last_alert || "") && r3.worker.stats.awaitTimeouts === 1);
  ok("4e: upstreamBlockersFrom: a region target (owners null) is blocked by ANY region upstream; an owner by its own only", upstreamBlockersFrom({ jobs: [{ route_id: "oli", target_key: "X", status: "pending" }], owners: null }).length === 1 && upstreamBlockersFrom({ jobs: [{ route_id: "oli", target_key: "X", status: "pending" }], owners: ["A1"] }).length === 0);
}

// 5. DEPENDENCY REPAIR ORDER: fba-plan -> brand-view-brands -> sku-movement (named brands) -> brand-view -> portfolio
{
  const rig = makeRig({ dir: { india: ["A1"] } });
  const tok = { "fba-plan": "fp", "brand-view-brands": "bb", "sku-movement": "sm", "brand-view": "bv" };
  for (const [r, t] of Object.entries(tok)) { setEv(rig, r, "india", { A1: t + "-1" }); rig.world.set(r, "india", "A1", "stale", t + "-1"); }
  setEv(rig, "brand-view-portfolio", "india", { "region:india": "pf-1" }); rig.world.set("brand-view-portfolio", "india", "region:india", "stale", "pf-1");
  await rig.store.enqueue({ route: "fba-plan", region: "india", targetKey: "A1", owners: ["A1"], asOf: EPOCH, token: "fp-1", origin: "scan", priority: 2 });
  const evReads = [];
  const origRead = rig.store.readRouteEvidence.bind(rig.store);
  rig.store.readRouteEvidence = async (route, ctx, ...rest) => { evReads.push({ route: S(route && route.id ? route.id : route), rest }); return origRead(route, ctx, ...rest); };
  await drain(rig);
  // 5d [tier-1 perf] the cascade's dependency reads (enqueueDependents, one per dependent route) never get a sweep cache:
  // they must read fresh, through each route's account-scoped statements.
  ok("5d [tier-1 perf]: every dependency evidence read of the cascade (the 4 dependent routes) passes NO sweep cache (fresh, account-scoped)",
    evReads.length >= 4 && evReads.every((c) => !(c.rest[0] && c.rest[0].sweepCache))
    && J([...new Set(evReads.map((c) => c.route))].sort()) === J(["brand-view", "brand-view-brands", "brand-view-portfolio", "sku-movement"]));
  const order = rig.world.calls.filter((c) => c.kind === "live" || c.kind === "repair").map((c) => c.route);
  ok("5a: a verified fba-plan PUBLISH cascades through the dependents in order fba-plan -> brand-view-brands -> sku-movement -> brand-view -> brand-view-portfolio", J(order) === J(["fba-plan", "brand-view-brands", "sku-movement", "brand-view", "brand-view-portfolio"]));
  ok("5b: dependents are enqueued with origin 'dependency' (owner scope; the portfolio at its REGION target) and every one is verified", ["brand-view-brands", "sku-movement", "brand-view", "brand-view-portfolio"].every((r) => jobsOf(rig.store, r).length === 1 && jobsOf(rig.store, r)[0].origin === "dependency" && jobsOf(rig.store, r)[0].status === "verified") && jobsOf(rig.store, "brand-view-portfolio")[0].target_key === "region:india");
  ok("5c: sku-movement / brand-view carry NAMED brand units (unit keys, never brand text) in their verified_rows", stateOf(rig.store, "sku-movement", "A1").verified_rows.map((v) => v.u).join(",") === "b1,b2" && stateOf(rig.store, "brand-view", "A1").verified_rows.length === 2);
}

// 6. TOKEN RE-ARM
{
  // (a) the evidence advances DURING the live pass: the verify child evaluates the new token -> re-armed, then verified.
  const rig = makeRig({ liveRoutes: ["returns-v3"] });
  setEv(rig, "returns-v3", "india", { A1: "rt-1" });
  rig.world.set("returns-v3", "india", "A1", "stale", "rt-1");
  await rig.store.enqueue({ route: "returns-v3", region: "india", targetKey: "A1", owners: ["A1"], asOf: EPOCH, token: "rt-1", origin: "scan" });
  rig.world.hooks.afterLive = () => { rig.world.setTok("returns-v3", "india", "A1", "rt-2"); setEv(rig, "returns-v3", "india", { A1: "rt-2" }); };
  await rig.worker.processOneBatch();
  const j = jobsOf(rig.store)[0];
  ok("6a: a verify tok MISMATCH (the evidence advanced mid-run) is NOT verified: re-armed (pending now, attempts reset, rearms counted) with the worker's CURRENT token", j.status === "pending" && j.evidence_token === "rt-2" && j.attempts === 0 && j.rearms === 1 && !stateOf(rig.store, "returns-v3", "A1").verified_token);
  rig.world.hooks.afterLive = null;
  await rig.worker.processOneBatch();
  ok("6b: ... and the next pass verifies it for the new token (its pre-check echoes rt-2)", jobsOf(rig.store)[0].status === "verified" && stateOf(rig.store, "returns-v3", "A1").verified_token === "rt-2");
  // (b) an enqueue refreshes the CLAIMED job's token while its children run -> finish re-arms.
  const r2 = makeRig({ liveRoutes: ["returns-v3"] });
  setEv(r2, "returns-v3", "india", { A1: "rt-1" });
  r2.world.set("returns-v3", "india", "A1", "stale", "rt-1");
  await r2.store.enqueue({ route: "returns-v3", region: "india", targetKey: "A1", owners: ["A1"], asOf: EPOCH, token: "rt-1", origin: "scan" });
  r2.world.hooks.afterLive = async () => { await r2.store.enqueue({ route: "returns-v3", region: "india", targetKey: "A1", owners: ["A1"], asOf: EPOCH, token: "rt-9", origin: "watermark" }); };
  await r2.worker.processOneBatch();
  ok("6c: the token changes MID-RUN (another detector refreshed the claimed job): finish(evaluatedToken=rt-1) RE-ARMS instead of verifying old evidence", jobsOf(r2.store)[0].status === "pending" && jobsOf(r2.store)[0].evidence_token === "rt-9" && r2.worker.stats.rearmed === 1);
  // (c) a PERSISTENT worker / CLI token disagreement is a typed deferral + alert, never a hot re-arm loop.
  const r3 = makeRig({ liveRoutes: ["returns-v3"] });
  setEv(r3, "returns-v3", "india", { A1: "rt-1" });
  r3.world.set("returns-v3", "india", "A1", "current", "rt-OTHER");
  await r3.store.enqueue({ route: "returns-v3", region: "india", targetKey: "A1", owners: ["A1"], asOf: EPOCH, token: "rt-1", origin: "scan" });
  await r3.worker.processOneBatch();
  const d = jobsOf(r3.store)[0];
  ok("6d: the worker still reads rt-1 while the CLI evaluated another token -> deferred 'token-disagreement' + alert (1800 s), never verified, never re-armed", d.status === "deferred" && /token-disagreement/.test(d.last_reason) && d.last_alert === "token-disagreement" && d.next_attempt_at - r3.clk.t === 1800000 && r3.worker.stats.tokenDisagreements === 1);
  // (d) the per-job re-arm bound (store support): past maxRearms the job is alerted and backs off.
  const st = createMemoryStore({ clock: () => T0 });
  await st.enqueue({ route: "oli", region: "india", targetKey: "A1", owners: ["A1"], asOf: EPOCH, token: "t0", origin: "scan" });
  let last;
  for (let i = 1; i <= 3; i += 1) { const c = await st.claim({ workerId: "w", claimToken: "c" + i, leaseSeconds: 600 }); await st.enqueue({ route: "oli", region: "india", targetKey: "A1", owners: ["A1"], asOf: EPOCH, token: "t" + i, origin: "watermark" }); last = await st.finish({ id: c[0].id, claimToken: "c" + i, outcome: "verified", cls: "current", evaluatedToken: "t" + (i - 1), maxRearms: 3 }); st.jobs[0].next_attempt_at = T0; }
  ok("6e: re-arms are COUNTED per job; the bound alerts 'evidence-rearm-bound' and backs off 600 s", last === "re-armed" && st.jobs[0].rearms === 3 && st.jobs[0].last_alert === "evidence-rearm-bound");
}

// 7. crash-loop guard, stale claim lease, graceful stop
{
  const clk = { t: T0 };
  const store = createMemoryStore({ clock: () => clk.t });
  store.env.directoryAccounts = [{ accountId: "A1", country: "IN" }];
  await store.enqueue({ route: "returns-v3", region: "india", targetKey: "A1", owners: ["A1"], asOf: EPOCH, token: "rt-1", origin: "scan" });
  const c1 = await store.claim({ workerId: "wA", claimToken: "t1", leaseSeconds: 600, maxClaims: 3 });
  clk.t += 601 * 1000;
  const c2 = await store.claim({ workerId: "wB", claimToken: "t2", leaseSeconds: 600, maxClaims: 3 });
  ok("7a: a crashed worker's STALE claim lease is reclaimed by another worker (claims+1); the crashed token can no longer finish", c1.length === 1 && c2.length === 1 && c2[0].claims === 2 && (await store.finish({ id: c1[0].id, claimToken: "t1", outcome: "verified", evaluatedToken: "rt-1" })) === "not-owner");
  clk.t += 601 * 1000; await store.claim({ workerId: "wC", claimToken: "t3", leaseSeconds: 600, maxClaims: 3 });
  clk.t += 601 * 1000; await store.claim({ workerId: "wD", claimToken: "t4", leaseSeconds: 600, maxClaims: 3 });
  ok("7b: CRASH-LOOP GUARD: a job reclaimed maxClaims times without ever finishing is dead-lettered 'crash-loop'", store.jobs[0].status === "dead" && store.jobs[0].last_class === "crash-loop");
  const rig = makeRig({ liveRoutes: ["returns-v3"] });
  setEv(rig, "returns-v3", "india", { A1: "rt-1" });
  rig.world.set("returns-v3", "india", "A1", "stale", "rt-1");
  await rig.store.enqueue({ route: "returns-v3", region: "india", targetKey: "A1", owners: ["A1"], asOf: EPOCH, token: "rt-1", origin: "scan" });
  rig.world.hooks.onRun = ({ kind }) => { if (kind === "verify") rig.worker.stop(); };
  await rig.worker.processOneBatch();
  const g = jobsOf(rig.store)[0];
  ok("7c: GRACEFUL STOP during the pre-check releases the job (pending, claims restored, NO attempt) and starts no live child", g.status === "pending" && g.claims === 0 && g.attempts === 0 && g.last_class === "released" && !rig.world.calls.some((c) => c.kind === "live"));
}

// 8. capacity-exceeded + route activation attestations (config: never an attempt, never a spawn)
{
  const rig = makeRig({ liveRoutes: ["brand-view-portfolio"], childMaxOldSpaceMb: 256 });
  setEv(rig, "brand-view-portfolio", "india", { "region:india": "pf-1" });
  rig.world.set("brand-view-portfolio", "india", "region:india", "stale", "pf-1");
  await rig.store.enqueue({ route: "brand-view-portfolio", region: "india", targetKey: "region:india", owners: ["A1", "A2"], asOf: EPOCH, token: "pf-1", origin: "scan", priority: 8 });
  await rig.worker.processOneBatch();
  const j = jobsOf(rig.store)[0];
  ok("8a: capacity-exceeded when the route's minChildHeapMb (448) > the configured child heap (256): deferred 21600 s + alert, NO spawn, NO attempt", j.status === "deferred" && j.last_class === CLASSES.CAPACITY_EXCEEDED && j.last_alert === "capacity-exceeded" && j.attempts === 0 && rig.world.calls.length === 0 && j.next_attempt_at - rig.clk.t === 21600 * 1000);
  const r2 = makeRig({ liveRoutes: ["fba-plan"], attestations: { skuMovementServeToken: false, fbaPlanRouteFence: false, lhv3ServeGate: false } });
  setEv(r2, "fba-plan", "india", { A1: "fp-1" }); r2.world.set("fba-plan", "india", "A1", "stale", "fp-1");
  await r2.store.enqueue({ route: "fba-plan", region: "india", targetKey: "A1", owners: ["A1"], asOf: EPOCH, token: "fp-1", origin: "scan", priority: 2 });
  await r2.worker.processOneBatch();
  const f = jobsOf(r2.store)[0];
  ok("8b: fba-plan without FBA_PLAN_ROUTE_FENCE_ATTESTED is route-not-activated (deferred, alert, hand-off deferred -- NOT not-applicable), no attempt, no spawn", f.status === "deferred" && f.last_class === CLASSES.ROUTE_NOT_ACTIVATED && f.attempts === 0 && r2.world.calls.length === 0 && stateOf(r2.store, "fba-plan", "A1").handoff === "deferred" && J(ROUTE_LIVE_ATTESTATIONS) === J({ "fba-plan": "fbaPlanRouteFence", "sku-movement": "skuMovementServeToken", listings: "lhv3ServeGate" }) && missingLiveAttestation({ attestations: ALL_ATTESTED }, "fba-plan") === null && missingLiveAttestation({ attestations: {} }, "oli") === null);
}

// 9. ZERO-EXPORT VIOLATION trips the route and dead-letters its jobs; a writer-fenced event is surfaced
{
  const rig = makeRig({ liveRoutes: ["returns-v3", "oli"] });
  setEv(rig, "returns-v3", "india", { A1: "rt-1", A2: "rt-2" }); setEv(rig, "oli", "india", { A1: "cov:1" });
  rig.world.set("returns-v3", "india", "A1", "stale+zeroexport", "rt-1"); rig.world.set("returns-v3", "india", "A2", "stale", "rt-2");
  rig.world.set("oli", "india", "A1", "stale");
  await rig.store.enqueue({ route: "returns-v3", region: "india", targetKey: "A1", owners: ["A1"], asOf: EPOCH, token: "rt-1", origin: "scan" });
  await rig.worker.processOneBatch();
  ok("9a: a blocked DataDoe request (ZEROEXPORT blocked>0) in the live child dead-letters the batch (zero-export-violation) and TRIPS the route", jobsOf(rig.store, "returns-v3")[0].status === "dead" && jobsOf(rig.store, "returns-v3")[0].last_class === CLASSES.ZERO_EXPORT_VIOLATION && rig.worker.tripped.has("returns-v3"));
  await rig.store.enqueue({ route: "returns-v3", region: "india", targetKey: "A2", owners: ["A2"], asOf: EPOCH, token: "rt-2", origin: "scan" });
  await rig.store.enqueue({ route: "oli", region: "india", targetKey: "A1", owners: ["A1"], asOf: EPOCH, token: "cov:1", origin: "scan", priority: 1 });
  rig.world.calls.length = 0;
  await drain(rig);
  ok("9b: the tripped route's later jobs are dead-lettered without a child; other routes keep publishing", jobsOf(rig.store, "returns-v3").find((j) => j.target_key === "A2").status === "dead" && !rig.world.calls.some((c) => c.route === "returns-v3") && jobsOf(rig.store, "oli")[0].status === "verified");
  const r2 = makeRig({ liveRoutes: ["oli"] });
  setEv(r2, "oli", "india", { A1: "cov:1" }); r2.world.set("oli", "india", "A1", "stale+spend");
  await r2.store.enqueue({ route: "oli", region: "india", targetKey: "A1", owners: ["A1"], asOf: EPOCH, token: "cov:1", origin: "scan", priority: 1 });
  await r2.worker.processOneBatch();
  ok("9c: a REPORTED DataDoe create / token (a legacy CLI's own counters) is a zero-export violation too", jobsOf(r2.store)[0].status === "dead" && r2.worker.tripped.has("oli"));
  const r3 = makeRig({ liveRoutes: ["oli"] });
  setEv(r3, "oli", "india", { A1: "cov:1" }); r3.world.set("oli", "india", "A1", "writer-fenced");
  await r3.store.enqueue({ route: "oli", region: "india", targetKey: "A1", owners: ["A1"], asOf: EPOCH, token: "cov:1", origin: "scan", priority: 1 });
  await r3.worker.processOneBatch();
  r3.store.env.fence = { state: "ok", rows: [{ reportKey: "brand-sales", fencedOnly: true }], fencedKeys: ["brand-sales"], openKeys: [], missingKeys: [], extraKeys: [] };
  await r3.worker.tier1Scan();
  const t1 = r3.store.scanRow.tier1Summary;
  ok("9d: a REPORT_WRITER_FENCED rejection is a typed 'writer-fenced' event (observation alert + tier-1 alert); the tier-1 summary surfaces the fence state PER KEY", [...r3.store.observations.values()].some((o) => o.alert === "writer-fenced") && t1.alerts.some((a) => a.code === "writer-fenced") && t1.fence.state === "ok" && t1.fence.perKey["brand-sales"] === "fenced" && t1.fence.perKey["fba-plan"] === "unknown" && t1.fence.allSeededFenced === false);
}

// 10. ANY stale unit gets the live pass; the worst class decides only the FINAL outcome
{
  const rig = makeRig({ liveRoutes: ["brand-view-portfolio"] });
  setEv(rig, "brand-view-portfolio", "india", { "region:india": "pf-1" });
  rig.world.set("brand-view-portfolio", "india", "region:india", "stale+integrity-unit", "pf-1");
  await rig.store.enqueue({ route: "brand-view-portfolio", region: "india", targetKey: "region:india", owners: ["A1", "A2"], asOf: EPOCH, token: "pf-1", origin: "scan", priority: 8 });
  await rig.worker.processOneBatch();
  const j = jobsOf(rig.store)[0];
  ok("10a: one INTEGRITY unit (portfolio-scope-id-too-long) never blocks the region target's STALE unit from its live pass; the final outcome is the worst class (dead integrity + alert)", rig.world.calls.some((c) => c.kind === "live") && rig.world.get("brand-view-portfolio", "india", "region:india") === "stale+integrity-unit:done" && j.status === "dead" && j.last_class === CLASSES.INTEGRITY && hasStaleUnit({ rows: [{ cls: CLASSES.INTEGRITY }, { cls: CLASSES.STALE }] }));
  const r2 = makeRig({ liveRoutes: ["returns-v3"] });
  setEv(r2, "returns-v3", "india", { A1: "rt-1" }); r2.world.set("returns-v3", "india", "A1", "stale-manifest", "rt-1");
  await r2.store.enqueue({ route: "returns-v3", region: "india", targetKey: "A1", owners: ["A1"], asOf: EPOCH, token: "rt-1", origin: "deep-scan" });
  await r2.worker.processOneBatch();
  ok("10b: a 'manifest-differs' unit gets a REPAIR pass (--live --verify-exact) and verifies", J(kindsOf(r2.world)) === J(["verify", "repair", "verify"]) && jobsOf(r2.store)[0].status === "verified");
}

// 11. DEEP SWEEP (once per epoch after the gate clears; fba-plan + portfolio periodic only on a token change)
{
  const rig = makeRig({ liveRoutes: ["returns-v3"], dir: { india: ["A1"] } });
  for (const r of PUBLICATION_ROUTES) { if (r.grain === "region") setEv(rig, r.id, "india", { "region:india": r.id + "-t" }); else setEv(rig, r.id, "india", { A1: r.id + "-t" }); }
  for (const r of PUBLICATION_ROUTES) rig.world.set(r.id, "india", r.grain === "region" ? "region:india" : "A1", "current", r.id + "-t");
  rig.world.set("returns-v3", "india", "A1", "stale", "returns-v3-t");
  rig.store.env.cycles.push({ bucket: "india", status: "running", started_ms: T0 - 60000, updated_ms: T0 - 1000 });
  ok("11a: the deep sweep does NOT start while the scheduler gate is blocked", (await rig.worker.deepSweepStep()) === false && rig.world.calls.length === 0);
  rig.store.env.cycles.length = 0; rig.clk.t += 3 * 60000;
  const deepEv = [];
  const origDeepRead = rig.store.readRouteEvidence.bind(rig.store);
  rig.store.readRouteEvidence = async (route, ctx, ...rest) => { deepEv.push({ rest }); return origDeepRead(route, ctx, ...rest); };
  let steps = 0; while ((await rig.worker.deepSweepStep()) && steps < 40) steps += 1;
  rig.store.readRouteEvidence = origDeepRead;
  // 11f [tier-1 perf] the deep sweep's evidence reads never get a sweep cache (fresh, account-scoped statements).
  ok("11f [tier-1 perf]: every deep-sweep evidence read passes NO sweep cache (fresh, account-scoped)",
    deepEv.length === 10 && deepEv.every((c) => !(c.rest[0] && c.rest[0].sweepCache)));
  const kinds = rig.world.calls.map((c) => `${c.route}:${c.kind}`);
  ok("11b: once the gate clears, ONE read-only child per (region, route) in topo order (--verify-exact for a route CLI, dry-run for a legacy CLI), full-region (no --targets)", rig.world.calls.length === 10 && kinds[0] === "oli:dry-run" && kinds.includes("returns-v3:verify") && kinds[kinds.length - 1] === "brand-view-portfolio:verify" && rig.world.calls.every((c) => c.targets === null));
  ok("11c: the sweep records the unit baseline (verified_rows for current targets) and enqueues the STALE one (origin deep-scan) for a live route", stateOf(rig.store, "brand-view", "A1").verified_token === "brand-view-t" && stateOf(rig.store, "brand-view", "A1").verified_rows.length === 2 && jobsOf(rig.store, "returns-v3")[0].origin === "deep-scan" && rig.store.scanRow.deepSweep.epoch === EPOCH);
  rig.world.calls.length = 0; rig.clk.t += Math.round(6.2 * 3600000); // same UTC epoch
  await rig.worker.tier1Scan();
  steps = 0; while ((await rig.worker.deepSweepStep()) && steps < 40) steps += 1;
  const swept = [...new Set(rig.world.calls.map((c) => c.route))];
  ok("11d: the PERIODIC sweep (PRW_DEEP_SWEEP_HOURS) skips fba-plan and the portfolio when their tokens did not change", swept.length === 8 && !swept.includes("fba-plan") && !swept.includes("brand-view-portfolio") && J(TOKEN_CHANGE_ONLY_SWEEP_ROUTES) === J(["fba-plan", "brand-view-portfolio"]));
  setEv(rig, "fba-plan", "india", { A1: "fba-plan-t2" });
  rig.world.calls.length = 0; rig.clk.t += Math.round(6.2 * 3600000); // same UTC epoch
  await rig.worker.tier1Scan();
  steps = 0; while ((await rig.worker.deepSweepStep()) && steps < 40) steps += 1;
  ok("11e: ... and sweeps fba-plan once its token changed", rig.world.calls.some((c) => c.route === "fba-plan") && !rig.world.calls.some((c) => c.route === "brand-view-portfolio"));
}

// 12. observe-only, epoch rollover, run failures, retries
{
  const rig = makeRig({ liveRoutes: [], control: { enabled: false, routes: {} } });
  setEv(rig, "returns-v3", "india", { A1: "rt-1" }); rig.world.set("returns-v3", "india", "A1", "stale", "rt-1");
  await rig.worker.tier1Scan();
  ok("12a: OBSERVE-ONLY (every flag off): tier-1 records observations but enqueues nothing, and no batch is ever claimed", jobsOf(rig.store).length === 0 && [...rig.store.observations.values()].some((o) => o.route_id === "returns-v3" && o.state === "target-missing") && (await rig.worker.processOneBatch()) === false && rig.store.calls.claim === 0);
  const r2 = makeRig({ liveRoutes: ["returns-v3"] });
  setEv(r2, "returns-v3", "india", { A1: "rt-1" }); r2.world.set("returns-v3", "india", "A1", "stale", "rt-1");
  await r2.store.enqueue({ route: "returns-v3", region: "india", targetKey: "A1", owners: ["A1"], asOf: "2026-09-22", token: "rt-1", origin: "scan" });
  await r2.worker.processOneBatch();
  ok("12b: an EPOCH ROLLOVER supersedes the older as-of job (no child)", jobsOf(r2.store)[0].status === "superseded" && r2.world.calls.length === 0);
  const r3 = makeRig({ liveRoutes: ["returns-v3"] });
  setEv(r3, "returns-v3", "india", { A1: "rt-1" }); r3.world.set("returns-v3", "india", "A1", "stale+timeout", "rt-1");
  await r3.store.enqueue({ route: "returns-v3", region: "india", targetKey: "A1", owners: ["A1"], asOf: EPOCH, token: "rt-1", origin: "scan" });
  await r3.worker.processOneBatch();
  const live = r3.world.calls.find((c) => c.kind === "live"), clean = r3.world.calls.find((c) => c.kind === "cleanup");
  ok("12c: a timed-out live child is followed by --cleanup with the SAME run token; the job retries with backoff (attempt 1)", clean && clean.runToken === live.runToken && jobsOf(r3.store)[0].status === "pending" && jobsOf(r3.store)[0].attempts === 1 && jobsOf(r3.store)[0].last_class === CLASSES.TIMEOUT);
  const r4 = makeRig({ liveRoutes: ["returns-v3"] });
  setEv(r4, "returns-v3", "india", { A1: "rt-1" }); r4.world.set("returns-v3", "india", "A1", "missing", "rt-1");
  await r4.store.enqueue({ route: "returns-v3", region: "india", targetKey: "A1", owners: ["A1"], asOf: EPOCH, token: "rt-1", origin: "scan" });
  await r4.worker.processOneBatch();
  ok("12d: missing saved evidence is a typed deferral (missing-evidence), never a publish, never an attempt; hand-off missing-source", jobsOf(r4.store)[0].status === "deferred" && jobsOf(r4.store)[0].last_class === CLASSES.MISSING_EVIDENCE && jobsOf(r4.store)[0].attempts === 0 && !r4.world.calls.some((c) => c.kind === "live") && stateOf(r4.store, "returns-v3", "A1").handoff === "missing-source");
  const r5 = makeRig({ liveRoutes: ["returns-v3"] });
  setEv(r5, "returns-v3", "india", { A1: "rt-1" }); r5.world.set("returns-v3", "india", "A1", "stale+mismatch", "rt-1");
  await r5.store.enqueue({ route: "returns-v3", region: "india", targetKey: "A1", owners: ["A1"], asOf: EPOCH, token: "rt-1", origin: "scan" });
  for (let i = 0; i < 6; i += 1) { await r5.worker.processOneBatch(); r5.clk.t += 3600 * 1000; }
  ok("12e: a publish whose verify still disagrees is NEVER verified -- readback-mismatch retries then dead-letters at maxAttempts", jobsOf(r5.store)[0].status === "dead" && /max-attempts:readback-mismatch/.test(jobsOf(r5.store)[0].last_class));
  const r6 = makeRig({ liveRoutes: ["returns-v3"] });
  setEv(r6, "returns-v3", "india", { A1: "rt-1" }); r6.world.set("returns-v3", "india", "A1", "stale+timeout-landed", "rt-1");
  await r6.store.enqueue({ route: "returns-v3", region: "india", targetKey: "A1", owners: ["A1"], asOf: EPOCH, token: "rt-1", origin: "scan" });
  await r6.worker.processOneBatch(); r6.clk.t += 3600 * 1000; r6.world.calls.length = 0;
  await r6.worker.processOneBatch();
  ok("12f: crash-AFTER-publish: the retry's pre-check proves the landed publish -> verified WITHOUT a second live child", jobsOf(r6.store)[0].status === "verified" && !r6.world.calls.some((c) => c.kind === "live"));
}

// 13. the owner hand-off matrix uses EXACTLY the owner classes
{
  const dir = buildWorkerDirectory([{ accountId: "A1", country: "IN" }, { accountId: "A2", country: "IN" }]).directory;
  const row = (route_id, target_key, last_class, handoff, extra = {}) => ({ route_id, region: "india", target_key, last_class, last_reason: extra.reason || null, handoff, served_confirmed: extra.served ?? null });
  const stateRows = [
    row("oli", "A1", "current", "repaired", { served: true }),
    row("ads", "A1", "current", "already-current", { served: true }),
    row("returns-v3", "A1", "missing-evidence", "missing-source", { reason: "returns-evidence-missing" }),
    row("fba", "A1", "missing-evidence", "not-applicable", { reason: "no-evidence-token" }),
    row("fba-plan", "A1", "permanent-integrity", "failed", { reason: "fba-pointer-integrity:x" }),
    row("listings", "A1", "current", "already-current", { served: null }),
    row("brand-view", "A1", "dependency-deferral", "deferred", { reason: "latest-row-ambiguous:brand-sales" }),
    row("returns-v3", "A2", "current", "already-current", { served: true }),
    row("sku-movement", "A1", "missing-evidence", "not-applicable", { reason: "no-evidence-token" }),
  ];
  const m = buildHandoffMatrix({ stateRows, directory: dir, regions: ["india"] });
  const get = (acct, rk) => m.find((r) => r.accountId === acct && r.reportKey === rk);
  const classes = new Set(m.map((r) => r.handoff));
  ok("13a: every matrix row is one of EXACTLY repaired | already-current | deferred | missing-source | failed | not-applicable", [...classes].every((c) => Object.values(HANDOFF_CLASSES).includes(c)) && classes.size === 6);
  ok("13b: daily-reporting combines its two routes worst-first (oli repaired + ads already-current -> repaired); brand-sales repaired (served read-back proven)", get("A1", "daily-reporting").handoff === "repaired" && J(get("A1", "daily-reporting").routes.sort()) === J(["ads", "oli"]) && get("A1", "brand-sales").handoff === "repaired");
  ok("13c0: already-current WITH the served read-back stays already-current", get("A2", "returns-leakage").handoff === "already-current");
  ok("13c: typed classes -- missing-source (returns), failed (fba-plan integrity), deferred (brand-view), current WITHOUT served read-back -> deferred:current-unserved (listing-health-v3), not-yet-evaluated -> deferred", get("A1", "returns-leakage").handoff === "missing-source" && /returns-evidence-missing/.test(get("A1", "returns-leakage").type) && get("A1", "fba-plan").handoff === "failed" && get("A1", "brand-view").handoff === "deferred" && get("A1", "listing-health-v3").handoff === "deferred" && get("A1", "listing-health-v3").type === "current-unserved" && get("A2", "brand-sales").type === "not-yet-evaluated");
  ok("13d: not-applicable is TYPED: manual-paid and read-only-self-heal (one row per region) and source-absent (no evidence token)", m.some((r) => r.reportKey === "sku-pl" && r.handoff === "not-applicable" && r.type === "manual-paid") && m.some((r) => r.reportKey === "brand-directory" && r.type === "read-only-self-heal") && m.filter((r) => r.handoff === "not-applicable").every((r) => ["manual-paid", "read-only-self-heal", "source-absent"].includes(r.type)) && get("A1", "sku-movement").handoff === "not-applicable" && get("A1", "sku-movement").type === "source-absent" && get("A1", "brand-inventory").handoff === "repaired" && handoffFor(CLASSES.MISSING_EVIDENCE, { reason: "no-evidence-token" }) === "not-applicable");
  ok("13e: the portfolio is a REGION row (account '*'); route-not-activated hands off as deferred", m.some((r) => r.accountId === "*" && r.reportKey === "brand-view-portfolio") && handoffFor(CLASSES.ROUTE_NOT_ACTIVATED) === "deferred");
  const t = { id: "A1", tok: "x", units: [{ u: "b1", rk: "brand-view", s: "PUBLICATION_NOT_REQUIRED", h: "h1", sra: "s1", served: { id: "r", h: "h1", sra: "s1" } }, { u: "b2", rk: "brand-view", s: "PUBLICATION_NOT_REQUIRED", h: "h2", sra: "s2", served: { id: "r2", h: "hX", sra: "s2" } }] };
  ok("13f: the route-CLI served read-back proof requires EVERY unit's served row to carry the unit's own h / sra; a v1 unit set has none (null)", servedConfirmedFromUnits(t) === false && servedConfirmedFromUnits({ ...t, units: [t.units[0]] }) === true && servedConfirmedFromUnits({ id: "A", units: [{ u: "-", rk: "x", s: "PUBLICATION_NOT_REQUIRED", h: null, served: null }] }) === null);
}

// 14. static pins: migration seed == registry; gate grammar == sync_cycles CHECK; directory == the CLI's; no startup statement_timeout
{
  const sql = src("supabase/migrations/20260934_publication_recovery_worker.sql");
  const seed = [...sql.matchAll(/\('([a-z0-9-]+)', '(account|region)', array\[([^\]]*)\]\)/g)].map((m) => ({ id: m[1], grain: m[2], keys: m[3].split(",").map((x) => x.trim().replace(/'/g, "")) }));
  ok("14a: the migration seeds EXACTLY the 10 registry routes (id, grain, live report keys), all live_enabled=false by default", seed.length === 10 && PUBLICATION_ROUTES.every((r) => { const s = seed.find((x) => x.id === r.id); return s && s.grain === r.grain && J([...s.keys].sort()) === J([...r.liveReportKeys].sort()); }) && /live_enabled boolean not null default false/.test(sql) && /live_regions text\[\] not null default '\{\}'::text\[\]/.test(sql) && /insert into public\.publication_recovery_control \(id, enabled\) values \(true, false\)/.test(sql));
  const chk = src("supabase/migrations/20260924_priority_partial_cycle_bucket.sql");
  const fixed = (chk.match(/bucket in \(([^)]*)\)/) || [])[1].split(",").map((x) => x.trim().replace(/'/g, ""));
  ok("14b: the gate's bucket grammar is EXHAUSTIVE against sync_cycles_bucket_check (13 fixed + bootstrap(-fba) + priority-partial); every fixed/regex shape classifies; fba shapes are paid-fba", J([...fixed].sort()) === J([...SCHEDULER_FIXED_CYCLE_BUCKETS].sort()) && fixed.every((b) => cycleBucketKind(b) !== "unknown") && chk.includes("'^bootstrap(-fba)?-(india|europe-au|us-ca)-[0-9a-f]{16}$'") && chk.includes("'^priority-partial-(india|europe-au|us-ca)-[0-9a-f]{16}$'") && cycleBucketKind("bootstrap-india-0123456789abcdef") === "scheduler" && cycleBucketKind("bootstrap-fba-india-0123456789abcdef") === "paid-fba" && cycleBucketKind("priority-partial-us-ca-0123456789abcdef") === "priority-partial" && ["us-fba", "non-us-fba", "india-fba", "europe-au-fba", "us-ca-fba"].every((b) => cycleBucketKind(b) === "paid-fba") && cycleBucketKind("bootstrap-india-xyz") === "unknown");
  ok("14c: the gate + paid-cycle sources are cited to the code that opens them (fba-plan-operation.js fbaCycleBucket '-fba'; the DSC us|non-us bucket; account-onboarding bootstrap-fba)", /return S\(bucket\)\.trim\(\) \+ "-fba";/.test(src("lib/server/sync/fba-plan-operation.js")) && /bucket !== "us" && bucket !== "non-us"/.test(src("api/admin/sources.js")) && /return `bootstrap-fba-\$\{r\}-\$\{h\}`;/.test(src("lib/server/sync/account-onboarding.js")));
  const rows = [{ accountId: "A1", country: "IN", name: "a", currency: "INR" }, { id: "A2", marketCountry: "uk" }, { accountId: "dd-secondary:X", country: "US" }, { accountId: "A3", country: "" }, { accountId: "A4", country: "US", settingUp: true }, { accountId: "D", country: "DE" }, { accountId: "D", country: "FR" }];
  const mine = buildWorkerDirectory(rows);
  const cliRows = rows.filter((a) => !(a && a.settingUp === true)).map((a) => ({ accountId: String(a.accountId || a.id || a.account_id || "").trim(), country: String(a.country || a.marketCountry || a.marketplace || "").trim(), currency: a.currency || null, name: a.name || null })).filter((a) => a.accountId);
  const cli = buildDurableDirectory({ rows: cliRows, resolveRawSellerId: (id) => (id.includes(":") ? "" : id), normalizeMarketplace: (c) => { const m = String(c).trim().toUpperCase(); return m === "UK" ? "GB" : m; } });
  ok("14d: the worker's durable directory is IDENTICAL to the route CLI's buildDurableDirectory (same exclusions, UK->GB, raw seller = the primary account id)", J([...mine.directory]) === J([...cli.directory]) && mine.directory.get("A2").marketplace === "GB" && !mine.directory.has("D") && /report_key = 'account-directory' order by updated_at desc limit 1/.test(DIRECTORY_SQL));
  const pc = recoveryPoolConfig("postgresql://u:p@h.pooler.supabase.com:6543/postgres?sslmode=require", { max: 2 });
  const storeSrc = src("lib/server/recovery/store-pg.js");
  ok("14e: NO statement_timeout STARTUP parameter through the pooler: bounded by SET LOCAL inside each (read-only for reads) transaction + a client-side query_timeout", !("statement_timeout" in pc) && !("options" in pc) && pc.query_timeout === 120000 && /set local statement_timeout/.test(storeSrc) && /begin transaction isolation level repeatable read read only/.test(storeSrc));
  ok("14f: every store read is metadata-only SQL (no report payload column is ever selected except the tiny account-directory list) and dates come back as text / epoch-ms", !/select[^;]*\bs\.payload\b/.test(SCHEDULER_GATE_SQL) && /cycle_date::text/.test(SCHEDULER_GATE_SQL) && /::bigint as age_seconds/.test(SCHEDULER_GATE_SQL) && likeToRegExp("brand-view:A\\_1::%").test("brand-view:A_1::x") && !likeToRegExp("brand-view:A\\_1::%").test("brand-view:AB1::x") && J(liveWriteBatches([{ key: "k", reportKey: "brand-view-portfolio", accountIdLike: "brand-view-portfolio:%", paramsEq: { region: "india" } }]).like.pe) === J(['{"region":"india"}']));
  const cv = compactVerifiedRows({ id: "A1", units: Array.from({ length: 400 }, (_, i) => ({ u: "u" + i, rk: "brand-view", h: "h".repeat(40), sra: "2026-09-24T00:00:00.000Z", asOf: "2026-09-24" })) }, { upd: 1 });
  ok("14g: verified_rows are compacted under the 20260934 size bound (units collapse per report + as-of, keeping the as-of set)", JSON.stringify(cv).length < 6000 && cv.length === 1 && cv[0].u === "*400" && cv[0].asOf === "2026-09-24");
}

// 15. WP11 fixer: the ONE evidence ctx reaches the store; the served proof gates verification (route CLI) and the hand-off
//     (legacy); a runner argv refusal (the fba-plan UTC-midnight roll) re-arms without a cleanup child
{
  // 15a [WP6] the worker hands the store EXACTLY the pinned evidence ctx (incl. its ONE `now`); store-pg runs every route's
  // params() + compose() on that SAME object (evaluateRouteEvidence; recovery-registry-completeness R4 proves the object
  // identity for all 10 routes).
  const rig = makeRig({ liveRoutes: ["returns-v3"] });
  const seen = [];
  rig.store.env.evidence.set("returns-v3|india", (ctx) => { seen.push(ctx); return new Map([["A1", { token: "rt-1", owners: ["A1"], region: "india", alerts: [] }]]); });
  await rig.worker.watermarkPass();
  const c = seen[0];
  ok("15a [WP6]: the worker passes the store the ONE pinned evidence ctx -- frozen, exactly { epoch, now, accountIds, directory, region, organizationFingerprint, connectionId }, now === the worker clock (epoch ms), epoch === utcDMinus1(now); worker.js builds it with buildEvidenceContext and store-pg hands that SAME object to evaluateRouteEvidence", !!c && Object.isFrozen(c) && J(Object.keys(c).sort()) === J(["accountIds", "connectionId", "directory", "epoch", "now", "organizationFingerprint", "region"]) && c.now === rig.clk.t && c.epoch === utcDMinus1(c.now) && c.region === "india" && c.connectionId === "primary" && c.organizationFingerprint === "org-fp-test" && J(c.accountIds) === J(["A1", "A2"]) && c.directory instanceof Map && /buildEvidenceContext\(\{ epoch, now, directory, region, organizationFingerprint \}\)/.test(src("lib/server/recovery/worker.js")) && /store\.readRouteEvidence\(route, ctx\)/.test(src("lib/server/recovery/worker.js")) && /evaluateRouteEvidence\(route, q, ctx\)/.test(src("lib/server/recovery/store-pg.js")));
  // 15t [tier-1 performance] ONE sweep cache per tier-1 pass: every route x region evaluation of a pass gets the SAME Map
  // (so a `shared: true` statement -- the Ads digest partials -- runs once per pass); the next pass gets a NEW Map (never
  // a result older than the pass); the watermark pass gets its OWN per-pass Map (never a tier-1 one).
  {
    const rig3 = makeRig({ regions: ["india", "europe-au"], dir: { india: ["A1"], "europe-au": ["E1"] } });
    const calls = [];
    const orig = rig3.store.readRouteEvidence.bind(rig3.store);
    rig3.store.readRouteEvidence = async (route, ctx, ...rest) => { calls.push({ ctx, rest }); return orig(route, ctx, ...rest); };
    await rig3.worker.tier1Scan();
    const p1 = calls.splice(0);
    rig3.clk.t += 700 * 1000;
    await rig3.worker.tier1Scan();
    const p2 = calls.splice(0);
    await rig3.worker.watermarkPass();
    const wm = calls.splice(0);
    const cacheOf = (c) => (c.rest[0] && c.rest[0].sweepCache) || null;
    ok("15t [tier-1 perf]: every route x region evaluation of ONE tier-1 pass shares ONE sweep-cache Map; the next pass gets a NEW Map; the watermark pass gets its OWN per-pass Map (never a tier-1 one)",
      p1.length === PUBLICATION_ROUTES.length * 2 && p1.every((c) => cacheOf(c) instanceof Map && cacheOf(c) === cacheOf(p1[0])) && new Set(p1.map((c) => c.ctx.region)).size === 2
      && p2.length === p1.length && p2.every((c) => cacheOf(c) === cacheOf(p2[0])) && cacheOf(p2[0]) !== cacheOf(p1[0])
      && wm.length > 0 && wm.every((c) => cacheOf(c) instanceof Map && cacheOf(c) === cacheOf(wm[0])) && cacheOf(wm[0]) !== cacheOf(p1[0]) && cacheOf(wm[0]) !== cacheOf(p2[0]));
  }
  // 15u [review P3] tier-1 keeps the evidence error CODE in the alert sample, and a sweep-cache replay of this pass's
  // failed shared read is reported as a REPLAY ('evidence-read-failed-replayed'), never as another independent failure.
  {
    const rig4 = makeRig({ regions: ["india"], dir: { india: ["A1"] } });
    const boom = (code, replay) => () => { const e = new Error("x"); e.code = code; if (replay) e.sweepReplay = true; throw e; };
    rig4.store.env.evidence.set("brand-view|india", boom("08006", false));
    rig4.store.env.evidence.set("brand-view-portfolio|india", boom("08006", true));
    await rig4.worker.tier1Scan();
    const al = (rig4.store.scanRow.tier1Summary && rig4.store.scanRow.tier1Summary.alerts) || [];
    const real = al.find((a) => a.code === "evidence-read-failed"), rep = al.find((a) => a.code === "evidence-read-failed-replayed");
    ok("15u [review P3]: tier-1 records the evidence error CODE ('brand-view/india:08006') and a sweep-cache replay as 'evidence-read-failed-replayed' (one real failure, not two)",
      !!real && real.n === 1 && J(real.samples) === J(["brand-view/india:08006"]) && !!rep && rep.n === 1 && J(rep.samples) === J(["brand-view-portfolio/india:08006"]));
  }
  // 15b [P2d] a route CLI's current binding WITHOUT its served read-back is never verified.
  const r2 = makeRig({ liveRoutes: ["returns-v3"] });
  setEv(r2, "returns-v3", "india", { A1: "rt-1" }); r2.world.set("returns-v3", "india", "A1", "current-unserved", "rt-1");
  await r2.store.enqueue({ route: "returns-v3", region: "india", targetKey: "A1", owners: ["A1"], asOf: EPOCH, token: "rt-1", origin: "scan" });
  await r2.worker.processOneBatch();
  const u = jobsOf(r2.store)[0]; const us = stateOf(r2.store, "returns-v3", "A1");
  ok("15b [P2d]: a route CLI target whose units are PUBLICATION_NOT_REQUIRED but carry NO served row is a typed 'current-unserved' deferral (alert, no attempt, no live child) -- never verified, never already-current (hand-off deferred)", u.status === "deferred" && u.last_class === CLASSES.CURRENT_UNSERVED && u.attempts === 0 && /current-unserved/.test(u.last_alert || "") && !r2.world.calls.some((x) => x.kind === "live") && (!us || (us.verified_token == null && us.handoff === "deferred")));
  // 15c [P2d] a LEGACY verification stores hand-off 'deferred' until the tier-1 served-row check confirms it; the matrix
  // re-derives repaired from the confirmed served proof.
  const lg = makeRig({ liveRoutes: ["oli"] });
  setEv(lg, "oli", "india", { A1: "cov:1" }); lg.world.set("oli", "india", "A1", "stale");
  await lg.worker.watermarkPass(); await lg.worker.processOneBatch();
  const before = { ...stateOf(lg.store, "oli", "A1") };
  await lg.worker.tier1Scan();
  const m = buildHandoffMatrix({ stateRows: (await lg.store.status()).state, directory: await lg.store.readDirectory(), regions: ["india"] });
  ok("15c [P2d]: a legacy target is VERIFIED on its binding (class current -- the anchor of the tier-1 served check) but its stored hand-off is 'deferred' (no served proof yet); once tier-1 confirms the served row the matrix hands it off 'repaired' (published) from that proof", jobsOf(lg.store)[0].status === "verified" && before.last_class === CLASSES.CURRENT && before.handoff === "deferred" && before.served_confirmed == null && before.last_reason === "verified-live-readback" && stateOf(lg.store, "oli", "A1").served_confirmed === true && m.some((r) => r.accountId === "A1" && r.reportKey === "brand-sales" && r.handoff === "repaired"));
  // 15d [P3] the runner refuses the fba-plan LIVE argv because the UTC day rolled after the claim (runRoute argsError):
  // the job is re-armed (evidence-advanced, no attempt) and NO cleanup child runs (no child was ever spawned).
  const w4 = makeWorld(); const kinds = []; const orig = w4.run;
  w4.run = async (args) => { kinds.push(args.kind); if (args.kind === "live") return { route: args.route, kind: "live", exitCode: null, signal: null, timedOut: false, spawnError: null, argsError: "fba-plan-as-of-rolled", capacityExceeded: null, oom: false, stop: null, result: null, targets: null, zeroExport: { blocked: 0 }, stderrTail: [], durationMs: 0 }; return orig(args); };
  const r4 = makeRig({ liveRoutes: ["fba-plan"], world: w4 });
  setEv(r4, "fba-plan", "india", { A1: "fp-1" }); r4.world.set("fba-plan", "india", "A1", "stale", "fp-1");
  await r4.store.enqueue({ route: "fba-plan", region: "india", targetKey: "A1", owners: ["A1"], asOf: EPOCH, token: "fp-1", origin: "scan", priority: 2 });
  await r4.worker.processOneBatch();
  const j4 = jobsOf(r4.store)[0];
  ok("15d [P3]: an fba-plan live argv refused for the UTC-midnight roll (runRoute argsError 'fba-plan-as-of-rolled') re-arms the job (evidence-advanced, NO attempt) and runs NO cleanup child", kinds.includes("live") && !kinds.includes("cleanup") && j4.last_class === CLASSES.EVIDENCE_ADVANCED && j4.attempts === 0 && j4.status !== "dead" && j4.status !== "verified");
}

// 16. WP11 / WP12 verifier round-2 fixes, ported from the verifier probes (wp12v probe-worker P1-P1d / P5 / P6,
//     probe-gatefail, probe-matrix; wp11v2 prw-dev, prw-poison)
{
  // ---- W1 (WP12 P2-1): every gate is RE-CHECKED immediately before the live child ----
  const flipRig = (flip) => {
    const r = makeRig({ liveRoutes: ["returns-v3"] });
    setEv(r, "returns-v3", "india", { A1: "rt-1" }); r.world.set("returns-v3", "india", "A1", "stale", "rt-1");
    let done = false;
    r.world.hooks.onRun = async ({ kind }) => { if (kind === "verify" && !done) { done = true; await flip(r); } };
    return r;
  };
  const cases = {
    "control.enabled=false": (r) => { r.store.controlRow.enabled = false; },
    "route live_enabled=false": (r) => { r.store.controlRow.routes["returns-v3"].liveEnabled = false; },
    "region dropped from live_regions": (r) => { r.store.controlRow.routes["returns-v3"].liveRegions = ["us-ca"]; },
    "natural scheduler cycle opened": (r) => { r.store.env.cycles.push({ bucket: "india", status: "running", started_ms: r.clk.t, updated_ms: r.clk.t }); },
    "control-plane lease taken": (r) => { r.store.env.lease = { held: true, operationKey: "scheduler-v2:india", expiresAt: null }; },
  };
  const want = { "control.enabled=false": ["route-not-live", 600], "route live_enabled=false": ["route-not-live", 600], "region dropped from live_regions": ["route-not-live", 600], "natural scheduler cycle opened": ["scheduler-window-global", 300], "control-plane lease taken": [CLASSES.CONTENTION, 120] };
  const res = {};
  for (const [name, flip] of Object.entries(cases)) {
    const r = flipRig(flip);
    await r.store.enqueue({ route: "returns-v3", region: "india", targetKey: "A1", owners: ["A1"], asOf: EPOCH, token: "rt-1", origin: "scan" });
    await r.worker.processOneBatch();
    const j = jobsOf(r.store)[0];
    res[name] = { kinds: kindsOf(r.world).join(","), status: j.status, cls: j.last_class, attempts: j.attempts, backoff: (j.next_attempt_at - r.clk.t) / 1000, held: r.worker.stats.liveGateHeld };
  }
  ok("16a (W1 / probe-worker P1-P1d): a kill switch / route switch / region / scheduler cycle / control lease that CLOSES during the pre-check child is re-checked right before the live child -> ZERO live child; the job gets the SAME typed deferral as at batch start (route-not-live 600 s / scheduler-window-global 300 s / contention 120 s), NO attempt" + " " + J(res),
    Object.entries(res).every(([n, x]) => x.kinds === "verify" && x.status === "deferred" && x.cls === want[n][0] && x.attempts === 0 && x.backoff === want[n][1] && x.held === 1));
  // P6: the UTC day rolls during the pre-check -> superseded (like step 1), no live child with the OLD as-of.
  const r6 = flipRig((r) => { r.clk.t = Date.parse("2026-09-25T00:05:00Z"); });
  await r6.store.enqueue({ route: "returns-v3", region: "india", targetKey: "A1", owners: ["A1"], asOf: EPOCH, token: "rt-1", origin: "scan" });
  await r6.worker.processOneBatch();
  ok("16b (W1 / P6): the UTC epoch rolling during the pre-check supersedes the job before the live child (never a live pass for the previous as-of)", J(kindsOf(r6.world)) === J(["verify"]) && jobsOf(r6.store)[0].status === "superseded" && jobsOf(r6.store)[0].last_class === "superseded-by-new-as-of");
  // P5: the claim is LOST during the pre-check (lease expired + reclaimed by another worker) -> dropped WITHOUT a finish.
  const r5 = flipRig(async (r) => { r.clk.t += 2800 * 1000; r.stolen = await r.store.claim({ workerId: "w2", claimToken: "00000000-0000-4000-8000-999999999999", limit: 5, leaseSeconds: 2700 }); });
  await r5.store.enqueue({ route: "returns-v3", region: "india", targetKey: "A1", owners: ["A1"], asOf: EPOCH, token: "rt-1", origin: "scan" });
  await r5.worker.processOneBatch();
  const j5 = jobsOf(r5.store)[0];
  ok("16c (W1 / P5): a claim LOST during the pre-check (reclaimed by w2) is dropped from the batch WITHOUT a finish -- no live child, the job stays claimed by w2 with w2's token (w1 never released / finished it)", r5.stolen.length === 1 && J(kindsOf(r5.world)) === J(["verify"]) && j5.status === "claimed" && j5.claimed_by === "w2" && j5.claim_token === "00000000-0000-4000-8000-999999999999" && r5.worker.stats.claimsLost === 1);
  // A gate READ failing only at the re-check defers typed (no attempt, no live child).
  const r7 = flipRig((r) => { r.store.env.failReads.add("readControlLease"); });
  await r7.store.enqueue({ route: "returns-v3", region: "india", targetKey: "A1", owners: ["A1"], asOf: EPOCH, token: "rt-1", origin: "scan" });
  await r7.worker.processOneBatch();
  const j7 = jobsOf(r7.store)[0];
  ok("16d (W1+W2): a lease READ failing at the pre-live re-check defers 'gate-unreadable' (300 s + alert, NO attempt) and starts NO live child", J(kindsOf(r7.world)) === J(["verify"]) && j7.status === "deferred" && j7.last_class === "gate-unreadable" && j7.attempts === 0 && j7.last_alert === "gate-unreadable" && j7.next_attempt_at - r7.clk.t === 300000);

  // ---- W2 (WP12 P3 / probe-gatefail): a gate / lease / blocker / directory READ error never consumes an attempt ----
  const gf = {};
  for (const [failing, route] of [["readSchedulerGate", "returns-v3"], ["readControlLease", "returns-v3"], ["readDirectory", "returns-v3"], ["readUpstreamBlockers", "brand-view-brands"]]) {
    const r = makeRig({ liveRoutes: [route] });
    await r.store.enqueue({ route, region: "india", targetKey: "A1", owners: ["A1"], asOf: EPOCH, token: "t1", origin: "scan" });
    r.store.env.failReads.add(failing);
    for (let i = 0; i < 8; i += 1) { await r.worker.processOneBatch(); r.clk.t += 4000 * 1000; }
    const j = jobsOf(r.store)[0];
    gf[failing] = { status: j.status, cls: j.last_class, attempts: j.attempts, alert: j.last_alert, children: r.world.calls.length, reenqueue: await r.store.enqueue({ route, region: "india", targetKey: "A1", owners: ["A1"], asOf: EPOCH, token: "t1", origin: "scan" }), reason: j.last_reason };
  }
  ok("16e (W2 / probe-gatefail): a scheduler-gate / control-lease / durable-directory / upstream-blocker READ failing on 8 consecutive batches defers 'gate-unreadable' EVERY time -- attempts stay 0 (never dead-lettered), alert 'gate-unreadable', zero children, the job stays live (re-enqueue -> exists)" + " " + J(gf),
    Object.values(gf).every((x) => x.status === "deferred" && x.cls === "gate-unreadable" && x.attempts === 0 && x.alert === "gate-unreadable" && x.children === 0 && x.reenqueue === "exists") && /^scheduler-gate-unreadable:/.test(gf.readSchedulerGate.reason) && /^control-lease-unreadable:/.test(gf.readControlLease.reason) && /^durable-directory-unreadable:/.test(gf.readDirectory.reason) && /^upstream-blockers-unreadable:/.test(gf.readUpstreamBlockers.reason));

  // ---- W3 (WP12 P2-3 / probe-matrix): the hand-off matrix never says repaired / already-current past a newer finding ----
  const rm = makeRig({ liveRoutes: ["returns-v3"] });
  setEv(rm, "returns-v3", "india", { A1: "rt-1", A2: "ra-1" });
  rm.world.set("returns-v3", "india", "A1", "stale", "rt-1"); rm.world.set("returns-v3", "india", "A2", "current", "ra-1");
  await rm.worker.watermarkPass(); await rm.worker.processOneBatch();
  const mrow = async (acct) => buildHandoffMatrix({ stateRows: (await rm.store.status()).state, directory: await rm.store.readDirectory(), regions: ["india"] }).find((x) => x.accountId === acct && x.reportKey === "returns-leakage");
  const m0 = await mrow("A1"), m0b = await mrow("A2");
  setEv(rm, "returns-v3", "india", { A1: "rt-2", A2: "ra-1" }); rm.world.set("returns-v3", "india", "A1", "stale", "rt-2");
  rm.store.env.cycles.push({ bucket: "india", status: "running", started_ms: rm.clk.t, updated_ms: rm.clk.t });
  rm.clk.t += 700 * 1000;
  await rm.worker.tier1Scan();
  await rm.worker.processOneBatch();
  await rm.store.enqueue({ route: "returns-v3", region: "india", targetKey: "A2", owners: ["A2"], asOf: EPOCH, token: "ra-1", origin: "manual" });
  const m1 = await mrow("A1"), m1b = await mrow("A2");
  const obs1 = [...rm.store.observations.values()].find((o) => o.tier === 1 && o.target_key === "A1" && o.route_id === "returns-v3");
  ok("16f (W3 / probe-matrix): after tier-1 saw the evidence token ADVANCE (the re-publish held by the scheduler gate) the matrix says deferred 'evidence-advanced' (not repaired); a verified target with an OPEN job says deferred 'job-open' (not already-current)",
    m0.handoff === "repaired" && m0b.handoff === "already-current" && obs1.state === "token-advanced" && jobsOf(rm.store).some((j) => j.target_key === "A1" && j.status === "deferred" && j.evidence_token === "rt-2")
    && m1.handoff === "deferred" && m1.type === "evidence-advanced" && m1b.handoff === "deferred" && m1b.type === "job-open");
  rm.store.env.cycles.length = 0; rm.clk.t += 16 * 60 * 1000;
  await drain(rm);
  const m2 = await mrow("A1"), m2b = await mrow("A2");
  ok("16g (W3): once the worker verifies the new token (A1 repaired for rt-2) and settles the open job (A2 re-verified), the matrix hands both off green again (the older tier-1 finding no longer counts)", stateOf(rm.store, "returns-v3", "A1").verified_token === "rt-2" && m2.handoff === "repaired" && m2b.handoff === "already-current" && !jobsOf(rm.store).some((j) => ["pending", "claimed", "deferred"].includes(j.status)));

  // ---- W4 (WP11 F1 / prw-dev): a legacy served-proof REVOCATION is STICKY for the verified token ----
  const mx = async (rig) => buildHandoffMatrix({ stateRows: (await rig.store.status()).state, directory: await rig.store.readDirectory(), regions: ["india"] }).find((x) => x.accountId === "A1" && x.reportKey === "brand-sales");
  const lg = makeRig({ liveRoutes: ["oli"] });
  setEv(lg, "oli", "india", { A1: "cov:1" }); lg.world.set("oli", "india", "A1", "current");
  await lg.worker.watermarkPass(); await lg.worker.processOneBatch();
  const d0 = { ...stateOf(lg.store, "oli", "A1") }, x0 = await mx(lg);
  await lg.worker.tier1Scan();
  const d1 = stateOf(lg.store, "oli", "A1").served_confirmed, x1 = await mx(lg);
  lg.store.env.liveRows.push({ report_key: "brand-sales", account_id: "A1", params: {}, updated_ms: lg.clk.t + 5000 });
  lg.clk.t += 601 * 1000; await lg.worker.tier1Scan();
  const d2 = stateOf(lg.store, "oli", "A1").served_confirmed, x2 = await mx(lg);
  lg.clk.t += 3600 * 1000;
  for (let i = 0; i < 80; i += 1) { await lg.worker.deepSweepStep(); lg.clk.t += 70 * 1000; }
  const d3 = { ...stateOf(lg.store, "oli", "A1") }, x3 = await mx(lg);
  lg.clk.t += 601 * 1000; await lg.worker.tier1Scan();
  const d4 = stateOf(lg.store, "oli", "A1").served_confirmed, x4 = await mx(lg);
  ok("16h (W4 / prw-dev): the deep sweep's re-verification of the SAME token (verified_ms re-anchored) no longer undoes a tier-1 revocation: served_confirmed stays false and the matrix stays deferred:current-unserved while the foreign row is still the newest -- before AND after the next tier-1",
    d0.served_confirmed === null && x0.handoff === "deferred" && d1 === true && x1.handoff === "already-current" && d2 === false && x2.type === "current-unserved"
    && lg.worker.stats.deepSweeps >= 1 && d3.verified_ms > d0.verified_ms && d3.last_class === CLASSES.CURRENT && d3.served_confirmed === false && x3.handoff === "deferred" && x3.type === "current-unserved" && d4 === false && x4.handoff === "deferred");
  await lg.store.recordBaseline([{ kind: "served", route_id: "oli", region: "india", target_key: "A1", requested_as_of: EPOCH, served_confirmed: true, token: "cov:OTHER" }, { kind: "served", route_id: "oli", region: "india", target_key: "A1", requested_as_of: EPOCH, served_confirmed: true, token: "cov:1" }]);
  const d5 = stateOf(lg.store, "oli", "A1").served_confirmed;
  setEv(lg, "oli", "india", { A1: "cov:2" }); lg.clk.t += 601 * 1000;
  await lg.worker.watermarkPass(); await lg.worker.processOneBatch();
  const d6 = { ...stateOf(lg.store, "oli", "A1") };
  lg.clk.t += 601 * 1000; await lg.worker.tier1Scan();
  const d7 = stateOf(lg.store, "oli", "A1").served_confirmed;
  ok("16i (W4): a served 'true' never flips a revocation of the same token (nor applies to another verified token); a NEW verified token resets the proof to unproven (null) and the next tier-1 re-checks it against the new verification instant",
    d5 === false && d6.verified_token === "cov:2" && d6.served_confirmed === null && d7 === true);
  const rp = makeRig({ liveRoutes: ["oli"] });
  setEv(rp, "oli", "india", { A1: "cov:1" }); rp.world.set("oli", "india", "A1", "current");
  await rp.worker.watermarkPass(); await rp.worker.processOneBatch(); await rp.worker.tier1Scan();
  rp.store.env.liveRows.push({ report_key: "brand-sales", account_id: "A1", params: {}, updated_ms: rp.clk.t + 5000 });
  rp.clk.t += 601 * 1000; await rp.worker.tier1Scan();
  const p0 = stateOf(rp.store, "oli", "A1").served_confirmed;
  rp.world.set("oli", "india", "A1", "stale"); rp.clk.t += 60 * 1000;
  await rp.store.enqueue({ route: "oli", region: "india", targetKey: "A1", owners: ["A1"], asOf: EPOCH, token: "cov:1", origin: "scan", priority: 1 });
  await rp.worker.processOneBatch();
  const p1 = { ...stateOf(rp.store, "oli", "A1") };
  rp.clk.t += 601 * 1000; await rp.worker.tier1Scan();
  ok("16j (W4): a REPUBLISH by this worker (stale -> live -> verify, published) clears the revocation of the same token (null), and the next tier-1 confirms its OWN newer row -> repaired",
    p0 === false && J(kindsOf(rp.world).slice(-3)) === J(["dry-run", "live", "dry-run"]) && p1.served_confirmed === null && p1.handoff === "deferred" && stateOf(rp.store, "oli", "A1").served_confirmed === true && (await mx(rp)).handoff === "repaired");
  const lb = makeRig({ liveRoutes: ["oli"] });
  setEv(lb, "oli", "india", { A1: "cov:1" }); lb.world.set("oli", "india", "A1", "current");
  lb.store.env.liveRows.push({ report_key: "brand-sales", account_id: "A1", params: {}, updated_ms: lb.clk.t - 1000 });
  await lb.worker.watermarkPass(); await lb.worker.processOneBatch(); await lb.worker.tier1Scan();
  ok("16k (W4, KNOWN LIMIT -- README 8 'Legacy served read-back'): a foreign row written BEFORE the verification is invisible to the metadata-only tier-1 check (the legacy CLIs report no served row identity), so it still confirms; this pin changes only if that limit is closed",
    stateOf(lb.store, "oli", "A1").served_confirmed === true);

  // ---- W5 (WP11 F2 / prw-poison): one stale target never poisons its batch ----
  const pw = makeWorld(); const origRun = pw.run;
  pw.stopFor = "GONE";
  pw.run = async (args) => {
    if (args.targets && args.targets.includes(pw.stopFor)) { pw.calls.push({ route: args.route, kind: args.kind, targets: [...args.targets] }); return { route: args.route, kind: args.kind, exitCode: 2, signal: null, timedOut: false, spawnError: null, argsError: null, capacityExceeded: null, oom: false, stop: { code: "ROUTE_TARGET_OUT_OF_SCOPE" }, result: null, targets: null, zeroExport: { blocked: 0 }, stderrTail: [], durationMs: 10 }; }
    return origRun(args);
  };
  const rw = makeRig({ liveRoutes: ["returns-v3"], world: pw });
  setEv(rw, "returns-v3", "india", { A1: "rt-1", A2: "rt-2" });
  rw.world.set("returns-v3", "india", "A1", "stale", "rt-1"); rw.world.set("returns-v3", "india", "A2", "stale", "rt-2");
  for (const [tk, tok] of [["A1", "rt-1"], ["A2", "rt-2"], ["GONE", "rt-g"]]) await rw.store.enqueue({ route: "returns-v3", region: "india", targetKey: tk, owners: [tk], asOf: EPOCH, token: tok, origin: "scan" });
  await rw.worker.processOneBatch();
  const gone = jobsOf(rw.store).find((j) => j.target_key === "GONE");
  ok("16l (W5a / prw-poison): an account target that is NOT in the region's durable directory is SUPERSEDED before any child ('superseded-target-out-of-scope', alert target-out-of-scope, no attempt, never dead -- the same token can re-open a job), so the CLI never STOPs the batch: A1 + A2 publish and verify",
    gone.status === "superseded" && gone.last_class === "superseded-target-out-of-scope" && gone.last_alert === "target-out-of-scope" && gone.attempts === 0 && !rw.world.calls.some((c) => (c.targets || []).includes("GONE"))
    && jobsOf(rw.store).filter((j) => j.target_key !== "GONE").every((j) => j.status === "verified" && j.published === true) && rw.worker.stats.outOfScope === 1
    && (await rw.store.enqueue({ route: "returns-v3", region: "india", targetKey: "GONE", owners: ["GONE"], asOf: EPOCH, token: "rt-g", origin: "scan" })) === "enqueued");
  // The residual cache race: the worker's directory still lists A3 but the CLI's fresh one does not -> STOP for the batch.
  const pw2 = makeWorld(); const orig2 = pw2.run;
  pw2.run = async (args) => {
    if (args.targets && args.targets.includes("A3")) { pw2.calls.push({ route: args.route, kind: args.kind, targets: [...args.targets] }); return { route: args.route, kind: args.kind, exitCode: 2, signal: null, timedOut: false, spawnError: null, argsError: null, capacityExceeded: null, oom: false, stop: { code: "ROUTE_TARGET_OUT_OF_SCOPE" }, result: null, targets: null, zeroExport: { blocked: 0 }, stderrTail: [], durationMs: 10 }; }
    return orig2(args);
  };
  const rr = makeRig({ liveRoutes: ["returns-v3"], world: pw2, dir: { india: ["A1", "A3"] } });
  setEv(rr, "returns-v3", "india", { A1: "rt-1", A3: "rt-3" }); rr.world.set("returns-v3", "india", "A1", "stale", "rt-1");
  for (const [tk, tok] of [["A1", "rt-1"], ["A3", "rt-3"]]) await rr.store.enqueue({ route: "returns-v3", region: "india", targetKey: tk, owners: [tk], asOf: EPOCH, token: tok, origin: "scan" });
  await rr.worker.processOneBatch();
  const race1 = jobsOf(rr.store).map((j) => [j.target_key, j.status, j.last_class, j.attempts, j.last_alert, (j.next_attempt_at - rr.clk.t) / 1000]);
  rr.store.env.directoryAccounts = rr.store.env.directoryAccounts.filter((a) => a.accountId !== "A3");
  rr.clk.t += 901 * 1000;
  await rr.worker.processOneBatch();
  ok("16m (W5b): the residual directory-cache race (the CLI STOPs ROUTE_TARGET_OUT_OF_SCOPE for a target the worker still saw) defers the batch as a dependency deferral -- NO attempt burned, alert route-target-out-of-scope, 900 s -- and once the worker's directory drops the target it is superseded and A1 publishes" + " " + J(race1),
    race1.every(([, st, cls, att, alert, back]) => st === "deferred" && cls === CLASSES.DEPENDENCY && att === 0 && /route-target-out-of-scope/.test(alert || "") && back === 900)
    && jobsOf(rr.store).find((j) => j.target_key === "A3").status === "superseded" && jobsOf(rr.store).find((j) => j.target_key === "A1").status === "verified");
}

// 17. The fba-plan fill-only deferral is an ACCEPTED STEADY STATE: it never blocks the dependents (WP14 e2e S2c'); the
//     exemption is narrow (only fba-plan, only that class + reason prefix, only a deferred job).
{
  const fpJob = (over) => ({ route_id: "fba-plan", target_key: "A1", status: "deferred", last_class: "dependency-deferral", last_reason: "evidence-instant-not-advanced", ...over });
  const blocks = (j) => upstreamBlockersFrom({ jobs: [j], owners: ["A1"] }).length > 0;
  ok("17a: a deferred fba-plan 'evidence-instant-not-advanced' dependency-deferral does NOT block; another reason, another class, another route, or a pending / claimed job with that reason still BLOCKS",
    !blocks(fpJob({})) && blocks(fpJob({ last_reason: "paid-job-in-flight" })) && blocks(fpJob({ last_class: "evidence-advanced" })) && blocks(fpJob({ route_id: "brand-view-brands" }))
    && blocks(fpJob({ status: "pending" })) && blocks(fpJob({ status: "claimed" })) && /select route_id, target_key, owner_account_ids, status, last_class, last_reason,/.test(src("lib/server/recovery/store-pg.js")));
}

// 18. 'published' is derived from the LIVE child's own units (final review P3-3 / e2e S4c): a live child that found the
//     target already current (a concurrent run published between the pre-check and the live child) -> already-current,
//     never 'repaired'; a live child that published -> repaired; a live child that timed out AFTER landing (no TARGETS
//     evidence) -> counted published (it may have written).
{
  const rig = makeRig({ liveRoutes: ["returns-v3"] });
  setEv(rig, "returns-v3", "india", { A1: "rt-1" });
  rig.world.set("returns-v3", "india", "A1", "stale", "rt-1");
  rig.world.hooks.onRun = ({ kind }) => { if (kind === "live") rig.world.set("returns-v3", "india", "A1", "current"); }; // a concurrent publish
  await rig.worker.watermarkPass(); await rig.worker.processOneBatch();
  const a1 = jobsOf(rig.store).find((j) => j.target_key === "A1");
  const rig2 = makeRig({ liveRoutes: ["returns-v3"] });
  setEv(rig2, "returns-v3", "india", { A1: "rt-1" }); rig2.world.set("returns-v3", "india", "A1", "stale", "rt-1");
  await rig2.worker.watermarkPass(); await rig2.worker.processOneBatch();
  const b1 = jobsOf(rig2.store).find((j) => j.target_key === "A1");
  ok("18a: a live child that found every unit already current -> verified published:false (hand-off already-current, never 'repaired'); a live child that published -> published:true / 'repaired'",
    J(kindsOf(rig.world)) === J(["verify", "live", "verify"]) && a1.status === "verified" && a1.published !== true && stateOf(rig.store, "returns-v3", "A1").handoff !== "repaired"
    && b1.status === "verified" && b1.published === true && stateOf(rig2.store, "returns-v3", "A1").handoff === "repaired");
}

// 19. [tier-1 DB load, 2026-09-29] the observe-only worker starved the production database: CROSS-pass reuse of the
// shared Ads evidence behind the table's change probe (hard cap), the tier-1 CIRCUIT BREAKER, and the deep-sweep PAUSE
// while the scheduler gate is blocked. Detection may be delayed; nothing is ever verified / published on reused data.
{
  const probeRow = (over = {}) => ({ rel_oid: "17626", rel_filenode: "17626", n_ins: "1", n_upd: "2", n_del: "3", db_reset: "2026-07-15T13:16:47.376507Z", fixed_reset: "2026-07-15T13:14:45.039092Z", pm_start: "2026-07-28T08:57:54.589406Z", in_recovery: "false", track_counts: "on", ...over });
  const SHARED = Object.freeze({ name: "ads_daily", text: "select ads-partials", shared: true, reuseTable: "ads_daily_source_rows", params: () => ["campaign-performance-v1", "2026-04-01", "2026-09-29"] });
  const mkReuseRig = (opts = {}) => {
    const rig = makeRig({ regions: ["india", "europe-au"], dir: { india: ["A1"], "europe-au": ["E1"] }, ...opts });
    const env = { probe: probeRow(), scans: 0, fail: null, calls: [], opts: [] };
    rig.store.readAdsChangeProbe = async () => { env.calls.push("probe"); if (env.probe instanceof Error) throw env.probe; return env.probe; };
    const orig = rig.store.readRouteEvidence.bind(rig.store);
    rig.store.readRouteEvidence = async (route, ctx, opt = {}) => {
      env.calls.push("ev:" + route.id + "/" + ctx.region);
      env.opts.push(opt);
      if (env.timeoutAt && env.timeoutAt.has(route.id + "/" + ctx.region)) { const e = new Error("canceling statement due to statement timeout"); e.code = "57014"; throw e; }
      if (route.id === "brand-view" || route.id === "brand-view-portfolio") {
        const base = async () => { env.scans += 1; if (env.fail) { const e = new Error("canceling statement due to statement timeout"); e.code = env.fail; env.fail = null; throw e; } return [{ n: "1" }]; };
        const q = opt && opt.sweepCache ? sweepMemoQuery(base, opt.sweepCache) : base;
        await q(SHARED.text, SHARED.params(), SHARED);
      }
      return orig(route, ctx, opt);
    };
    return { rig, env };
  };
  const pass = async (rig, advanceS) => { rig.clk.t += advanceS * 1000; const ran = await rig.worker.tier1Scan(); return { ran, sum: rig.store.scanRow.tier1Summary }; };

  // (a) an unchanged probe: the second pass REUSES (one scan for two passes); the probe runs BEFORE any evidence read.
  {
    const { rig, env } = mkReuseRig();
    const p1 = await pass(rig, 0);
    const firstEv = env.calls.findIndex((c) => c.startsWith("ev:"));
    const p2 = await pass(rig, 700);
    ok("19a [DB load]: two tier-1 passes with a byte-identical Ads change probe issue ONE shared scan (the 2nd pass is seeded: reason 'reused'); the probe is read before the pass's first evidence read",
      p1.ran && p2.ran && env.scans === 1 && env.calls[0] === "probe" && firstEv > 0 && p1.sum.sharedReuse.reason === "empty" && p1.sum.sharedReuse.scanned === 1 && p2.sum.sharedReuse.reason === "reused" && p2.sum.sharedReuse.seeded === 1 && p2.sum.sharedReuse.scanned === 0 && rig.worker.stats.sharedReuseHits === 1 && rig.worker.stats.sharedReuseScans === 1);
  }
  // (b) ANY single probe field change -> a rescan (and the fresh rows are carried again).
  {
    const moved = [];
    for (const f of ADS_CHANGE_PROBE_FIELDS.filter((x) => x !== "in_recovery" && x !== "track_counts")) {
      const { rig, env } = mkReuseRig();
      await pass(rig, 0);
      env.probe = probeRow({ [f]: f === "db_reset" || f === "fixed_reset" || f === "pm_start" ? "2026-09-29T06:00:00.000000Z" : "999" });
      const p2 = await pass(rig, 700);
      const p3 = await pass(rig, 700);
      moved.push(env.scans === 2 && p2.sum.sharedReuse.reason === "probe-changed" && p3.sum.sharedReuse.reason === "reused" ? f : "FAIL:" + f);
    }
    ok("19b [DB load]: a change of ANY probe field (oid, relfilenode, ins/upd/del counters, db / fixed stats reset, postmaster start) forces a rescan; the fresh rows are carried to the next pass",
      moved.length === 8 && moved.every((m) => !m.startsWith("FAIL")));
  }
  // (c) a probe that cannot vouch (standby, counting off, a blank field, a read error) -> no reuse AND nothing stored.
  {
    const bad = [probeRow({ in_recovery: "true" }), probeRow({ track_counts: "off" }), probeRow({ n_upd: "" }), probeRow({ n_del: null }), null, Object.assign(new Error("x"), { code: "57014" })];
    const res = [];
    for (const b of bad) {
      const { rig, env } = mkReuseRig();
      env.probe = b;
      const p1 = await pass(rig, 0); const p2 = await pass(rig, 700);
      env.probe = probeRow();
      const p3 = await pass(rig, 700);
      res.push(env.scans === 3 && p1.sum.sharedReuse.probe === "unavailable" && p2.sum.sharedReuse.reason === "probe-unavailable" && p3.sum.sharedReuse.reason === "empty");
    }
    ok("19c [DB load]: a probe that cannot vouch (in_recovery, track_counts off, a blank / null field, no row, a read error) disables reuse for that pass and stores NOTHING (every pass scans)", res.length === 6 && res.every(Boolean));
  }
  // (d) the HARD cap counts from the ORIGINAL scan (a reused entry is never re-tagged).
  {
    const { rig, env } = mkReuseRig();
    await pass(rig, 0);
    const p2 = await pass(rig, 3000);
    const p3 = await pass(rig, 700);
    ok("19d [DB load]: reuse at +3000 s, then a RESCAN at +3700 s (the 1 h cap counts from the ORIGINAL scan: a reused entry keeps its sig + time)",
      p2.sum.sharedReuse.reason === "reused" && p3.sum.sharedReuse.reason === "cap" && env.scans === 2);
  }
  // (e) cap 0 = reuse OFF (every pass scans, the probe is never read).
  {
    const { rig, env } = mkReuseRig({ configExtra: { sharedEvidenceReuseSeconds: 0 } });
    await pass(rig, 0); const p2 = await pass(rig, 700);
    ok("19e [DB load]: PRW_SHARED_EVIDENCE_REUSE_SECONDS=0 turns reuse OFF: every pass scans and the probe is never read",
      env.scans === 2 && !env.calls.includes("probe") && p2.sum.sharedReuse.reason === "disabled");
  }
  // (f) the CIRCUIT BREAKER (review round 2): ONE slow statement fails only its own evaluation (the shared Ads scan's
  // replays are instant); a SECOND distinct statement timeout means a starved database -> the rest is not issued.
  const order = [];
  for (const g of ["india", "europe-au"]) for (const id of ["oli", "listings", "fba-plan", "returns-v3", "ads", "fba", "brand-view-brands", "sku-movement", "brand-view", "brand-view-portfolio"]) order.push(id + "/" + g);
  {
    const { rig, env } = mkReuseRig();
    env.timeoutAt = new Set(["oli/india"]);
    const p1 = await pass(rig, 0);
    const evs = env.calls.filter((c) => c.startsWith("ev:"));
    ok("19f [DB load]: ONE statement timeout does NOT open the circuit: only that evaluation fails; all 20 pairs are still evaluated",
      p1.sum.circuit === null && p1.sum.skipped === 0 && p1.sum.errors === 1 && evs.length === 20);
  }
  {
    const { rig, env } = mkReuseRig();
    env.fail = "57014";
    const p1 = await pass(rig, 0);
    const rep = (p1.sum.alerts || []).find((a) => a.code === "evidence-read-failed-replayed");
    ok("19f' [DB load]: a timed-out SHARED Ads scan alone does not open it either (the other Ads evaluations replay at once, errors counted); every pair is evaluated",
      p1.sum.circuit === null && p1.sum.skipped === 0 && env.calls.filter((c) => c.startsWith("ev:")).length === 20 && !!rep && rep.n === 3 && p1.sum.errors === 4);
  }
  {
    const { rig, env } = mkReuseRig();
    env.timeoutAt = new Set(["oli/india", "listings/india"]);
    const outs = []; const finish0 = rig.store.finishScan.bind(rig.store);
    rig.store.finishScan = async (a) => { if (a && a.kind === "tier1") outs.push(a.outcome); return finish0(a); };
    const p1 = await pass(rig, 0);
    const i = env.calls.indexOf("ev:listings/india");
    const after = env.calls.slice(i + 1).filter((c) => c.startsWith("ev:"));
    const al = (p1.sum.alerts || []).find((a) => a.code === "tier1-circuit-open");
    env.timeoutAt = new Set();
    const p2 = await pass(rig, 700);
    ok("19f'' [DB load]: a SECOND distinct statement timeout OPENS the circuit: the other 18 pairs are not issued, each counted ('tier1-circuit-open'), outcome 'partial'; the next pass completes",
      i >= 0 && after.length === 0 && p1.sum.circuit === "57014" && p1.sum.skipped === 18 && p1.sum.errors === 20 && !!al && al.n === 18 && outs[0] === "partial"
      && p2.sum.circuit === null && p2.sum.errors === 0 && outs[1] === "complete" && rig.worker.stats.tier1Skipped === 18);
  }
  // (i) the pass starts at a ROTATING (region, route) offset, so a persistent trip never hides the same pairs every pass.
  {
    const { rig, env } = mkReuseRig();
    const firsts = [];
    for (let k = 0; k < 3; k += 1) { const before = env.calls.length; await pass(rig, k === 0 ? 0 : 700); firsts.push(env.calls.slice(before).find((c) => c.startsWith("ev:"))); }
    ok("19i [DB load]: consecutive tier-1 passes start at a rotating (region, route) offset (oli/india, then listings/india, then fba-plan/india)",
      JSON.stringify(firsts) === JSON.stringify(["ev:" + order[0], "ev:" + order[1], "ev:" + order[2]]));
  }
  // (g) the watermark pass never probes in observe-only (no live pair); tier-1-only reads carry the sweep cache.
  {
    const { rig, env } = mkReuseRig({ liveRoutes: [] });
    await rig.worker.watermarkPass();
    const noProbe = !env.calls.includes("probe");
    await pass(rig, 0);
    ok("19g [DB load]: the watermark pass issues NO probe and no evidence read in observe-only; tier-1 evaluations carry a sweep cache",
      noProbe && env.opts.length > 0 && env.opts.every((o) => o && o.sweepCache instanceof Map));
  }
}
// 19j [review round 2] a FAILED tier-1 live-row read never confirms (or revokes) a served row: the verified legacy target
// stays unproven (served_confirmed null), its tier-1 state is 'served-unknown' (matrix: deferred), the pass is partial.
{
  const lg = makeRig({ liveRoutes: ["oli"] });
  setEv(lg, "oli", "india", { A1: "cov:1" });
  lg.world.set("oli", "india", "A1", "stale");
  await lg.worker.watermarkPass(); await lg.worker.processOneBatch();
  const before = stateOf(lg.store, "oli", "A1");
  lg.store.readLiveRowWritesSince = async () => { const e = new Error("canceling statement due to statement timeout"); e.code = "57014"; throw e; };
  await lg.worker.tier1Scan();
  const sum = lg.store.scanRow.tier1Summary;
  const obs = [...lg.store.observations.values()].find((o) => o.route_id === "oli" && o.target_key === "A1" && o.tier === 1);
  const lr = (sum.alerts || []).find((a) => a.code === "live-row-read-failed");
  const m = buildHandoffMatrix({ stateRows: (await lg.store.status()).state, directory: await lg.store.readDirectory(), regions: ["india"] });
  ok("19j [review round 2]: a FAILED tier-1 live-row read never confirms a legacy served row (served_confirmed stays null): tier-1 state 'served-unknown' (matrix: deferred), alert 'oli/india:57014', the pass counts the error",
    before.served_confirmed == null && stateOf(lg.store, "oli", "A1").served_confirmed == null && !!obs && obs.state === "served-unknown"
    && !!lr && lr.samples.includes("oli/india:57014") && sum.errors >= 1
    && m.some((r) => r.accountId === "A1" && r.reportKey === "brand-sales" && r.handoff === "deferred"));
}
// 19j' [review round 3] the REAL 'served-unknown' case: a legacy target CONFIRMED by an earlier tier-1 pass (matrix
// repaired) whose live-row read then FAILS keeps served_confirmed (no revocation without the read) but the matrix shows
// deferred / 'served-unknown' -- never 'repaired' on a pass that could not re-check it.
{
  const lg = makeRig({ liveRoutes: ["oli"] });
  setEv(lg, "oli", "india", { A1: "cov:1" });
  lg.world.set("oli", "india", "A1", "stale");
  await lg.worker.watermarkPass(); await lg.worker.processOneBatch();
  await lg.worker.tier1Scan();
  const m1 = buildHandoffMatrix({ stateRows: (await lg.store.status()).state, directory: await lg.store.readDirectory(), regions: ["india"] });
  const confirmed = stateOf(lg.store, "oli", "A1").served_confirmed === true && m1.some((r) => r.accountId === "A1" && r.reportKey === "brand-sales" && r.handoff === "repaired");
  lg.store.readLiveRowWritesSince = async () => { const e = new Error("canceling statement due to statement timeout"); e.code = "57014"; throw e; };
  lg.clk.t += 700 * 1000;
  await lg.worker.tier1Scan();
  const m2 = buildHandoffMatrix({ stateRows: (await lg.store.status()).state, directory: await lg.store.readDirectory(), regions: ["india"] });
  const row = m2.find((r) => r.accountId === "A1" && r.reportKey === "brand-sales");
  ok("19j' [review round 3]: a CONFIRMED legacy row whose next live-row read FAILS stays served_confirmed (no revocation without the read) and the matrix shows deferred / 'served-unknown' (was repaired)",
    confirmed && stateOf(lg.store, "oli", "A1").served_confirmed === true && !!row && row.handoff === "deferred" && row.type === "served-unknown");
}
// 19k [review round 3] a route whose LAST region's deep-sweep evidence read keeps failing is still marked swept (no
// re-sweep loop of the other regions' heavy children for the rest of the epoch); its token is not a subset digest.
{
  const rig = makeRig({ liveRoutes: ["returns-v3"], regions: ["india", "europe-au"], dir: { india: ["A1"], "europe-au": ["E1"] } });
  for (const g of ["india", "europe-au"]) {
    const acct = g === "india" ? "A1" : "E1";
    for (const r of PUBLICATION_ROUTES) { if (r.grain === "region") setEv(rig, r.id, g, { ["region:" + g]: r.id + "-t" }); else setEv(rig, r.id, g, { [acct]: r.id + "-t" }); }
    for (const r of PUBLICATION_ROUTES) rig.world.set(r.id, g, r.grain === "region" ? "region:" + g : acct, "current", r.id + "-t");
  }
  const orig = rig.store.readRouteEvidence.bind(rig.store);
  rig.store.readRouteEvidence = async (route, ctx, ...rest) => { if (route.id === "fba-plan" && ctx.region === "europe-au") { const e = new Error("canceling statement due to statement timeout"); e.code = "57014"; throw e; } return orig(route, ctx, ...rest); };
  let steps = 0; while ((await rig.worker.deepSweepStep()) && steps < 80) steps += 1;
  const c1 = rig.world.calls.length;
  const b = (rig.store.scanRow.deepSweep || {}).byRoute || {};
  for (let k = 0; k < 6; k += 1) { rig.clk.t += 5 * 60 * 1000; await rig.worker.deepSweepStep(); }
  ok("19k [review round 3]: a route whose LAST region's deep-sweep evidence read keeps failing is still marked swept (epoch recorded, token not a subset digest) and is NOT re-swept (no loop of the other regions' children)",
    c1 === 19 && !!b["fba-plan"] && b["fba-plan"].epoch === EPOCH && b["fba-plan"].tok === null && rig.world.calls.length === c1);
}
// 19h [DB load] the deep sweep PAUSES while the scheduler gate is blocked (before, the gate was read only at sweep START,
// so a running sweep stepped -- evidence reads + heavy children -- straight through a scheduler cycle); it resumes with
// the step not consumed once the gate clears, and keeps its scan lease meanwhile.
{
  const rig = makeRig({ liveRoutes: ["returns-v3"], dir: { india: ["A1"] } });
  for (const r of PUBLICATION_ROUTES) { if (r.grain === "region") setEv(rig, r.id, "india", { "region:india": r.id + "-t" }); else setEv(rig, r.id, "india", { A1: r.id + "-t" }); }
  for (const r of PUBLICATION_ROUTES) rig.world.set(r.id, "india", r.grain === "region" ? "region:india" : "A1", "current", r.id + "-t");
  const started = await rig.worker.deepSweepStep();
  await rig.worker.deepSweepStep();
  const c1 = rig.world.calls.length;
  rig.store.env.cycles.push({ bucket: "india", status: "running", started_ms: rig.clk.t - 60000, updated_ms: rig.clk.t - 1000 });
  const evBefore = rig.store.readRouteEvidence;
  let evReads = 0;
  rig.store.readRouteEvidence = async (...a) => { evReads += 1; return evBefore.apply(rig.store, a); };
  const paused1 = await rig.worker.deepSweepStep();
  const paused2 = await rig.worker.deepSweepStep();
  const pausedCount = rig.worker.stats.deepPaused;
  rig.store.env.cycles.length = 0; rig.clk.t += 61 * 1000;
  let steps = 0; while ((await rig.worker.deepSweepStep()) && steps < 40) steps += 1;
  ok("19h [DB load]: a deep sweep in progress PAUSES while the scheduler gate is blocked (no evidence read, no child, step not consumed, gate re-read at most every 3 polls) and resumes when it clears (all 10 routes swept exactly once)",
    started === true && c1 === 1 && paused1 === false && paused2 === false && pausedCount === 1 && rig.world.calls.length === 10 && evReads === 9
    && new Set(rig.world.calls.map((c) => c.route)).size === 10);
}

writeSync(1, `publication-recovery-worker: ${passed} passed\n`);
