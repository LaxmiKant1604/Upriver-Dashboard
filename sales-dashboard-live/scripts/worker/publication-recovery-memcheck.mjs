// Publication recovery worker -- repeatable MEMORY / THROUGHPUT check for the 1 GB Oracle Micro (WP12 route design).
//
//   node scripts/worker/publication-recovery-memcheck.mjs [--iterations=40000]        # SYNTHETIC: the worker loop, all 10 routes
//   node scripts/worker/publication-recovery-memcheck.mjs --real [--regions=india,europe-au,us-ca] [--routes=<ids>]
//        [--child-max-old-space-mb=448] [--sql-only]                                   # REAL: ON THE VM, before ANY live route
//
// SYNTHETIC: an in-memory store + a fake route-CLI world for ALL 10 routes x 3 regions; re-runs itself under the unit's
// --max-old-space-size=160 with --expose-gc and judges the RETAINED heap after GC over ~9 simulated days (tier-1 every 10
// minutes, deep sweeps, batches, epoch rollovers). PASS: steady-state drift < 5 MB, end heap < 64 MB, RSS peak < 240 MB.
//
// REAL (read-only: zero writes, zero DataDoe creates / tokens; one zero-token account-directory GET per legacy child):
//   (1) the TIER-1 metadata pass exactly as the worker runs it -- every route's evidence SQL per region (per-statement
//       timings: the ONE shared ads_daily digest scan of brand-view + the portfolio, the legacy GLOBAL evidence SQL, fba-plan /
//       returns / sku-movement statements), the served-row write scan, the global scheduler gate, the writer fence and
//       the report-key universe. This is ALSO the pre-live "every route's evidence SQL read-only once" check;
//   (2) the two foreign-job lineage statements (FBA_PLAN_FOREIGN_JOB_SQL, LISTING_HEALTH_V3_FOREIGN_JOB_SQL) once per
//       region, read-only (the pre-live check);
//   (3) unless --sql-only: one READ-ONLY child per (region, route) exactly as the deep sweep runs it (--verify-exact for
//       a route CLI; the legacy CLIs' dry-run) -- per-child peak RSS + duration (the fba-plan extra lineage reads and the
//       brand-view per-unit reads are inside those children; the per-account figure is printed).
// PASS thresholds (plan WP12): max child peak <= 448 MB; worker + child + OS <= 85% of 1024 MB; tier-1 <= 60 s; the
// per-epoch deep sweep <= 4 h. Otherwise it prints the measured value and the REQUIRED change. A FAIL means: do NOT
// activate the affected route(s) on the Micro with the current settings.

import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadReleaseEnv } from "../release/env-bootstrap.mjs";
loadReleaseEnv();

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, "..", "..");
const argOf = (n) => { const a = process.argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.split("=").slice(1).join("=") : null; };
const MB = (b) => Math.round((b / 1048576) * 10) / 10;
const VM_TOTAL_MB = 1024, OS_RESERVE_MB = 250; // Ubuntu 24.04 minimal + sshd + journald headroom on the Micro
const MAX_CHILD_MB = 448, TIER1_MAX_S = 60, DEEP_SWEEP_MAX_S = 4 * 3600;
// The worker's RSS envelope under the unit's --max-old-space-size=160: V8 lets garbage accumulate in old space up to
// the cap before a major GC (heapTotal ~145 MB while the RETAINED heap stays ~13 MB), plus the young generation + code.
// The synthetic tight loop (all 10 routes, no idle) peaks ~220 MB; the real budget uses this conservative ceiling.
const WORKER_RSS_CEILING_MB = 240;

function rssOfPid(pid) {
  try {
    if (process.platform === "linux") { const m = readFileSync(`/proc/${pid}/status`, "utf8").match(/VmRSS:\s+(\d+)\s+kB/); return m ? Number(m[1]) * 1024 : 0; }
    if (process.platform === "win32") { const out = execFileSync("powershell", ["-NoProfile", "-Command", `(Get-Process -Id ${pid}).WorkingSet64`], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); return Number(out) || 0; }
    const out = execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); return (Number(out) || 0) * 1024;
  } catch { return 0; }
}

if (!process.argv.includes("--real") && !global.gc) {
  // Re-run under the SAME heap cap the systemd unit uses, with --expose-gc so retained heap can be measured exactly.
  const { spawnSync } = await import("node:child_process");
  const r = spawnSync(process.execPath, ["--expose-gc", "--max-old-space-size=160", fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: "inherit" });
  process.exit(r.status == null ? 1 : r.status);
}

if (!process.argv.includes("--real")) {
  // ---------------- SYNTHETIC: the orchestrator itself over ALL 10 routes (fake store + fake route-CLI world) ----------
  // Retention is judged on heapUsed AFTER a full GC (what the worker keeps alive), sampled across the second half of the
  // run once the store's prune / compaction reached steady state. RSS is reported too (V8 returns pages lazily and lets
  // garbage accumulate up to the old-space cap, so RSS is judged against WORKER_RSS_CEILING_MB, not as a leak signal).
  const { createMemoryStore } = await import("../../lib/server/recovery/memory-store.js");
  const { createRecoveryWorker, yesterdayUtc } = await import("../../lib/server/recovery/worker.js");
  const { PUBLICATION_ROUTES, routeById } = await import("../../lib/server/recovery/routes.js");
  const clk = { t: Date.parse("2026-09-24T10:00:00Z") };
  const store = createMemoryStore({ clock: () => clk.t });
  const REGIONS = ["india", "europe-au", "us-ca"], COUNTRY = { india: "IN", "europe-au": "DE", "us-ca": "US" };
  const ACCOUNTS = Array.from({ length: 81 }, (_, i) => ({ accountId: `acct-${String(i).padStart(3, "0")}`, country: COUNTRY[REGIONS[i % 3]] })); // > the 77-row directory
  store.env.directoryAccounts = ACCOUNTS;
  const byRegion = Object.fromEntries(REGIONS.map((g) => [g, ACCOUNTS.filter((a) => a.country === COUNTRY[g]).map((a) => a.accountId)]));
  const tok = new Map(); // `${route}|${region}|${target}` -> token
  const targetsOf = (route, region) => (route.grain === "region" ? ["region:" + region] : byRegion[region]);
  for (const r of PUBLICATION_ROUTES) for (const g of REGIONS) {
    for (const t of targetsOf(r, g)) tok.set(`${r.id}|${g}|${t}`, `${r.id}-${t}-0`);
    store.env.evidence.set(`${r.id}|${g}`, () => new Map(targetsOf(r, g).map((t) => [t, { token: tok.get(`${r.id}|${g}|${t}`), owners: r.grain === "region" ? byRegion[g] : [t], region: g, alerts: [] }])));
  }
  let flip = 0;
  const run = async ({ route, region, asOf, kind, targets }) => {
    const r = routeById(route);
    const scope = targets || targetsOf(r, region);
    const live = kind === "live" || kind === "repair";
    const stale = !live && kind !== "cleanup" && (flip++ % 3 === 0);
    const units = r.unit === "none" ? ["-"] : ["b1", "b2", "b3"];
    const payloadTargets = scope.map((id) => {
      const rows = units.flatMap((u) => r.publisherKeys.map((rk) => ({ u, rk, s: live ? "PUBLISHED_LIVE" : (stale ? "STALE" : "PUBLICATION_NOT_REQUIRED"), r: stale ? "live-refresh-differs" : null, asOf, h: "h" + u, sra: "2026-09-24T09:00:00.000Z", served: { id: "x", h: "h" + u, sra: "2026-09-24T09:00:00.000Z" } })));
      return r.kind === "route-cli" ? { id, owners: r.grain === "region" ? byRegion[region] : [id], tok: tok.get(`${route}|${region}|${id}`), units: rows }
        : { id, eligible: true, rev: "r", status: "nonempty", reports: Object.fromEntries(rows.map((x) => [x.rk, { s: x.s, r: x.r }])) };
    });
    if (kind === "cleanup") return { exitCode: 0, timedOut: false, result: { cleaned: true }, targets: null, zeroExport: { blocked: 0 }, stderrTail: [], durationMs: 1 };
    const common = { dryRun: !live, outcome: "complete", code: "OK", dataDoeCreates: 0, dataDoeTokens: 0, controlCleanupUnresolved: false };
    const payload = r.kind === "route-cli" ? { v: 2, route, bucket: region, epoch: asOf, ...common, targets: payloadTargets } : { v: 1, family: route, bucket: region, requestedAsOf: asOf, ...common, accounts: payloadTargets };
    return { exitCode: 0, timedOut: false, result: { ok: true, dataDoeCreates: 0, dataDoeTokens: 0 }, targets: payload, zeroExport: { blocked: 0 }, stderrTail: [], durationMs: 1 };
  };
  const config = {
    workerId: "memcheck", host: "local", pollSeconds: 20, scanIntervalSeconds: 600, scanLeaseSeconds: 3600, batch: 5, leaseSeconds: 2700, maxAttempts: 6, maxClaims: 8, maxRearms: 12,
    childMaxOldSpaceMb: 448, keepDays: 14, stopGraceSeconds: 1, schedulerCooldownSeconds: 900, schedulerWindows: [], deepSweepHours: 6, awaitMaxMinutes: 120,
    liveRoutes: PUBLICATION_ROUTES.map((r) => r.id), regions: REGIONS, concurrency: 1, attestations: { skuMovementServeToken: true, fbaPlanRouteFence: true, lhv3ServeGate: true },
  };
  // In production every job / state / observation row lives in Postgres, never in the worker's heap. Compact the
  // in-memory stand-in (finished jobs; rows of epochs before yesterday) so the retained heap measured is the WORKER's.
  const compactFakeDb = () => {
    for (let k = store.jobs.length - 1; k >= 0; k -= 1) if (["verified", "superseded", "dead"].includes(store.jobs[k].status)) store.jobs.splice(k, 1);
    const floor = yesterdayUtc(clk.t - 86400000);
    for (const m of [store.state, store.observations]) for (const [key, r] of m) if (r.requested_as_of < floor) m.delete(key);
  };
  const worker = createRecoveryWorker({ store, run, config, clock: () => clk.t, sleep: async (ms) => { clk.t += ms; }, randomUUID: (() => { let n = 0; return () => `c-${++n}`; })(), version: "memcheck", organizationFingerprint: "org-memcheck" });
  const ITER = Number(argOf("iterations")) || 40000; // 20 s/tick -> ~9.3 simulated days, several epoch rollovers
  const heapMb = () => { global.gc(); global.gc(); return MB(process.memoryUsage().heapUsed); };
  const heap0 = heapMb();
  const rss0 = process.memoryUsage().rss;
  let peak = rss0; const t0 = Date.now();
  const samples = [];
  for (let i = 0; i < ITER; i += 1) {
    if (i % 50 === 0) for (const r of PUBLICATION_ROUTES) for (const g of REGIONS) for (const t of targetsOf(r, g).slice(0, 4)) tok.set(`${r.id}|${g}|${t}`, `${r.id}-${t}-${i}`);
    await worker.tick();
    clk.t += 20000;
    if (i % 50 === 0) compactFakeDb();
    if (i % 100 === 0) { const r = process.memoryUsage().rss; if (r > peak) peak = r; }
    if (i > 0 && i % Math.max(1, Math.floor(ITER / 20)) === 0) samples.push({ tick: i, heapMb: heapMb(), rssAfterGcMb: MB(process.memoryUsage().rss), heapTotalMb: MB(process.memoryUsage().heapTotal), externalMb: MB(process.memoryUsage().external), jobs: store.jobs.length, state: store.state.size, observations: store.observations.size });
  }
  const secs = (Date.now() - t0) / 1000;
  const heap1 = heapMb();
  const rss1 = process.memoryUsage().rss;
  const tail = samples.slice(Math.floor(samples.length / 2)); // steady-state half
  const tailMin = Math.min(...tail.map((s) => s.heapMb)), tailMax = Math.max(...tail.map((s) => s.heapMb));
  const steadyDrift = Math.round((tailMax - tailMin) * 10) / 10;
  const st = worker.stats;
  const res = { mode: "synthetic", routes: PUBLICATION_ROUTES.length, regions: REGIONS.length, flags: process.execArgv, iterations: ITER, simulatedDays: Math.round((ITER * 20) / 8640) / 10, wallSeconds: Math.round(secs * 10) / 10, ticksPerSecond: Math.round(ITER / secs), heapAfterGcStartMb: heap0, heapAfterGcEndMb: heap1, steadyStateHeapDriftMb: steadyDrift, rssStartMb: MB(rss0), rssPeakMb: MB(peak), rssEndMb: MB(rss1), samples, stats: { tier1Scans: st.tier1Scans, deepSweeps: st.deepSweeps, deepSteps: st.deepSteps, batches: st.batches, childRuns: st.childRuns, verified: st.verified, repaired: st.repaired, dependencyEnqueued: st.dependencyEnqueued, rearmed: st.rearmed } };
  const exercised = st.tier1Scans > 100 && st.deepSweeps > 5 && st.verified > 100;
  const verdict = steadyDrift < 5 && heap1 < 64 && res.rssPeakMb < WORKER_RSS_CEILING_MB && exercised ? "PASS" : "FAIL";
  console.log(JSON.stringify(res, null, 1));
  console.log(`VERDICT synthetic worker memory (all ${PUBLICATION_ROUTES.length} routes x ${REGIONS.length} regions): ${verdict} (steady-state retained-heap drift ${steadyDrift} MB < 5 MB; end heap ${heap1} MB < 64 MB; RSS peak ${res.rssPeakMb} MB < ${WORKER_RSS_CEILING_MB} MB under --max-old-space-size=160; ${ITER} ticks ~ ${res.simulatedDays} simulated days; tier-1 ${st.tier1Scans}, deep sweeps ${st.deepSweeps}, verified ${st.verified}${exercised ? "" : " -- NOT EXERCISED ENOUGH"})`);
  process.exit(verdict === "PASS" ? 0 : 1);
}

// ---------------- REAL (on the VM; read-only) ----------------
const { runRoute } = await import("../../lib/server/recovery/runner.js");
const { topoOrder, utcDMinus1, buildEvidenceContext, liveRowScopesFor, tier1Target, supportsVerifyExact, routeById } = await import("../../lib/server/recovery/routes.js");
const { createRecoveryStore } = await import("../../lib/server/recovery/store-pg.js");
const { primaryOrganizationFingerprint } = await import("../../lib/server/datadoe-connections.js");
if (!String(process.env.POSTGRES_URL || "").trim()) { console.error("STOP POSTGRES_URL not set (value never printed)"); process.exit(2); }
const orgFp = primaryOrganizationFingerprint();
if (!orgFp) { console.error("STOP the primary DataDoe connection is not configured"); process.exit(2); }
const regions = (argOf("regions") || "india,europe-au,us-ca").split(",").filter(Boolean);
const routeIds = (argOf("routes") || topoOrder().join(",")).split(",").filter(Boolean);
for (const id of routeIds) routeById(id); // unknown id -> throws (fail closed)
const childCap = Number(argOf("child-max-old-space-mb")) || 448;
const now = Date.now();
const asOf = argOf("as-of") || utcDMinus1(now);
const store = createRecoveryStore({ connectionString: process.env.POSTGRES_URL, max: 1 });
const out = (o) => console.log(JSON.stringify(o));

// (1) TIER-1: every route's evidence SQL (per statement) + the served-row scan + the global reads, timed.
const t1Start = Date.now();
const stmtStats = [];
let evidenceFailures = 0;
const directory = await store.readDirectory();
// The worker's tier-1 sweep cache (routes.js sweepMemoQuery): ONE Map for this whole pass, exactly like worker.js
// tier1Scan -- a `shared: true` statement (the Ads digest partials) runs once; its later hits are timed at ~0 ms.
const sweepCache = new Map();
for (const region of regions) {
  const ctx = buildEvidenceContext({ epoch: asOf, now, directory, region, organizationFingerprint: orgFp });
  for (const id of routeIds) {
    const route = routeById(id);
    // One transaction per route evaluation (what the worker does); per-statement timing through a wrapped query.
    const perStmt = [];
    const s0 = Date.now();
    let map = null, err = null;
    try {
      // Time each statement by wrapping its params() -- AND its sweep-mode sharedVariant's (recorded under the statement's
      // own name), so the one real shared Ads scan is attributed to 'ads_daily', never to the statement before it. The
      // wrapped variant keeps the ORIGINAL variant's text + values, so the sweep-cache key (and hits) are unchanged.
      const timed = (q) => ({ name: q.name, t: Date.now() });
      map = await store.readRouteEvidence({
        ...route,
        evidence: { ...route.evidence, sql: route.evidence.sql.map((q) => ({
          ...q,
          params: (c) => { perStmt.push(timed(q)); return q.params(c); },
          ...(q.sharedVariant ? { sharedVariant: { ...q.sharedVariant, params: (c) => { perStmt.push(timed(q)); return q.sharedVariant.params(c); } } } : {}),
        })) },
      }, ctx, { sweepCache });
    } catch (e) { err = String((e && (e.code || e.message)) || "error").slice(0, 120); evidenceFailures += 1; }
    const ms = Date.now() - s0;
    // statement i ran between perStmt[i].t and perStmt[i+1].t (or the end)
    const steps = perStmt.map((p, i) => ({ name: p.name, ms: (i + 1 < perStmt.length ? perStmt[i + 1].t : s0 + ms) - p.t }));
    for (const s of steps) stmtStats.push({ region, route: id, ...s });
    let scopeMs = null;
    if (map) {
      const scopes = [];
      for (const tk of map.keys()) { try { for (const x of liveRowScopesFor(route, tier1Target(route, tk, region))) scopes.push({ key: tk, ...x }); } catch { /* unroutable */ } }
      const w0 = Date.now(); if (scopes.length) await store.readLiveRowWritesSince(scopes); scopeMs = Date.now() - w0;
    }
    out({ tier1: "evidence", region, route: id, ok: !err, error: err, ms, targets: map ? map.size : null, liveRowScanMs: scopeMs, statements: steps });
  }
}
const g0 = Date.now(); const gate = await store.readSchedulerGate({ cooldownSeconds: 900 }); const gateMs = Date.now() - g0;
const f0 = Date.now(); const fence = await store.readFence(); const fenceMs = Date.now() - f0;
const k0 = Date.now(); const keys = await store.readReportKeys(); const keysMs = Date.now() - k0;
const tier1Seconds = Math.round((Date.now() - t1Start) / 100) / 10;
out({ tier1: "global", gateMs, gateBlocked: gate.blocked, gateAlerts: gate.alerts.map((a) => a.code), fenceState: fence.state, fenceMs, reportKeys: keys.length, keysMs });
const pick = (re) => stmtStats.filter((s) => re.test(s.name)).sort((a, b) => b.ms - a.ms)[0] || null;
out({ measure: "ads_daily shared digest scan (brand-view / portfolio; one real scan per pass, the rest sweep-cache hits)", slowest: stmtStats.filter((s) => s.name === "ads_daily").sort((a, b) => b.ms - a.ms).slice(0, 6) });
out({ measure: "legacy GLOBAL evidence SQL (unfiltered by region)", slowest: ["oli_coverage", "oli_completeness", "fba_pointers", "ads_revs", "listings_pointers", "catalog_pointer"].map((n) => pick(new RegExp("^" + n + "$"))).filter(Boolean) });

// (2) the two foreign-job lineage statements (pre-live read-only check), once per region's first account.
try {
  const { FBA_PLAN_FOREIGN_JOB_SQL } = await import("../../lib/server/sync/routes/fba-plan.release.js");
  const { LISTING_HEALTH_V3_FOREIGN_JOB_SQL } = await import("../../lib/server/sync/listing-health-v3-release.js");
  const pg = (await import("pg")).default;
  const { recoveryPoolConfig } = await import("../../lib/server/recovery/store-pg.js");
  const client = new pg.Client(recoveryPoolConfig(process.env.POSTGRES_URL, { max: 1 }));
  await client.connect();
  for (const region of regions) {
    const acct = [...directory.values()].find((m) => buildEvidenceContext({ epoch: asOf, now, directory: new Map([[m.accountId, m]]), region, organizationFingerprint: orgFp }).accountIds.length === 1);
    if (!acct) continue;
    for (const [name, text, values] of [["FBA_PLAN_FOREIGN_JOB_SQL", FBA_PLAN_FOREIGN_JOB_SQL.text, FBA_PLAN_FOREIGN_JOB_SQL.params(acct.accountId)], ["LISTING_HEALTH_V3_FOREIGN_JOB_SQL", LISTING_HEALTH_V3_FOREIGN_JOB_SQL, ["listing-health-v3", acct.accountId, JSON.stringify(["lhv3-prelive-probe"])]]]) {
      const s0 = Date.now(); let rows = null, err = null;
      try { await client.query("begin transaction read only"); await client.query("set local statement_timeout = '60s'"); rows = (await client.query(text, values)).rows.length; await client.query("commit"); }
      catch (e) { err = String((e && e.code) || "error"); try { await client.query("rollback"); } catch { /* ignore */ } }
      out({ prelive: name, region, ok: !err, error: err, rows, ms: Date.now() - s0 });
    }
  }
  await client.end();
} catch (e) { out({ prelive: "foreign-job-sql", ok: false, error: String((e && (e.code || e.message)) || "error").slice(0, 120) }); }
await store.close();

let children = [];
if (!process.argv.includes("--sql-only")) {
  // (3) one READ-ONLY child per (region, route) exactly as the deep sweep runs it.
  for (const region of regions) for (const id of routeIds) {
    const route = routeById(id);
    let peak = 0, timer = null;
    const r = await runRoute({ appRoot, route: id, region, asOf: id === "fba-plan" ? utcDMinus1(Date.now()) : asOf, kind: supportsVerifyExact(route) ? "verify" : "dry-run", targets: null, childMaxOldSpaceMb: childCap,
      onChild: (c) => { timer = setInterval(() => { const v = rssOfPid(c.pid); if (v > peak) peak = v; }, 1000); } });
    if (timer) clearInterval(timer);
    const t = r.targetsV2;
    const step = { region, route: id, kind: supportsVerifyExact(route) ? "verify" : "dry-run", seconds: Math.round(r.durationMs / 100) / 10, childPeakRssMb: MB(peak), heapCapMb: r.heapMb, exit: r.exitCode, timedOut: r.timedOut, oom: r.oom, capacityExceeded: r.capacityExceeded, targets: t ? t.targets.length : null, secondsPerTarget: t && t.targets.length ? Math.round((r.durationMs / 1000 / t.targets.length) * 10) / 10 : null, zeroExportBlocked: r.zeroExport.blocked, dataDoeCreates: t ? t.dataDoeCreates : null, dataDoeTokens: t ? t.dataDoeTokens : null, stderrTail: t ? undefined : r.stderrTail };
    children.push(step);
    out(step);
  }
}

// ---- verdicts ----
const maxChild = Math.max(0, ...children.map((s) => s.childPeakRssMb));
const budget = WORKER_RSS_CEILING_MB + maxChild + OS_RESERVE_MB;
const sweepSeconds = Math.round(children.reduce((s, x) => s + x.seconds, 0));
const zero = children.every((s) => s.zeroExportBlocked === 0 && !s.dataDoeCreates && !s.dataDoeTokens);
const allOk = children.every((s) => s.exit === 0 && !s.timedOut && s.targets != null);
out({ mode: "real", asOf, platform: `${process.platform}/${os.arch()}`, node: process.versions.node, regions, routes: routeIds.length, tier1Seconds, evidenceFailures, children: children.length, deepSweepSeconds: sweepSeconds, maxChildPeakRssMb: maxChild, workerBudgetMb: WORKER_RSS_CEILING_MB, osReserveMb: OS_RESERVE_MB, budgetMb: budget, vmMb: VM_TOTAL_MB, childHeapCapMb: childCap });
const verdicts = [];
verdicts.push([`tier-1 metadata pass = ${tier1Seconds}s <= ${TIER1_MAX_S}s`, tier1Seconds <= TIER1_MAX_S && evidenceFailures === 0, `raise PRW_SCAN_INTERVAL_SECONDS to >= ${Math.ceil(tier1Seconds * 10)} (10x the measured pass) and fix the ${evidenceFailures} failing evidence statement(s) before any live route`]);
if (children.length) {
  verdicts.push([`max child peak = ${maxChild} MB <= ${MAX_CHILD_MB} MB`, maxChild <= MAX_CHILD_MB, `the heaviest route(s) (${children.filter((s) => s.childPeakRssMb > MAX_CHILD_MB).map((s) => s.region + "/" + s.route).join(", ")}) need a larger VM shape (e.g. OCI A1.Flex) -- keep them on the GitHub route until then (capacity-exceeded)`]);
  verdicts.push([`worker ${WORKER_RSS_CEILING_MB} + child ${maxChild} + OS ${OS_RESERVE_MB} = ${budget} MB <= 85% of ${VM_TOTAL_MB} MB`, budget <= VM_TOTAL_MB * 0.85, `lower PRW_CHILD_MAX_OLD_SPACE_MB (routes whose minChildHeapMb exceeds it become capacity-exceeded) or move to a larger shape`]);
  verdicts.push([`per-epoch deep sweep = ${sweepSeconds}s <= ${DEEP_SWEEP_MAX_S}s`, sweepSeconds <= DEEP_SWEEP_MAX_S, `raise PRW_DEEP_SWEEP_HOURS to >= ${Math.ceil((sweepSeconds * 2) / 3600)} and/or restrict PRW_REGIONS, or a larger shape`]);
  verdicts.push(["every read-only child completed", allOk, "inspect the failing children above (timeouts on 1/8 OCPU approach the route deadline)"]);
  verdicts.push(["ZERO DataDoe creates / tokens / blocked requests", zero, "STOP: a zero-export violation -- do not activate anything; report it"]);
}
for (const [label, pass, change] of verdicts) console.log(`VERDICT ${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : " -- REQUIRED CHANGE: " + change}`);
process.exit(verdicts.every(([, p]) => p) ? 0 : 1);
