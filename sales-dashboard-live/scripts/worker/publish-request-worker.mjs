// "Publish from saved data" -- the EXECUTOR entrypoint (one long-running Node process; the proposed host is ONE Render
// Background Worker). Queue-driven: it claims ONE user request at a time from public.publish_requests
// (supabase/migrations/20260936_publish_requests.sql) and publishes exactly that scope from durable saved evidence
// through the EXISTING zero-export route release + fenced publisher (lib/server/publish-request/brand-view-executor.js).
// It never scans report tables, never touches GitHub, never creates a DataDoe export.
//
// Usage (run from sales-dashboard-live/):
//   node scripts/worker/publish-request-worker.mjs                 # the executor loop (SIGTERM = finish the job, exit)
//   node scripts/worker/publish-request-worker.mjs --once          # one iteration, then exit
//   node scripts/worker/publish-request-worker.mjs --check-config  # env + read-only probes (control row, lease, cron)
//   node scripts/worker/publish-request-worker.mjs --measure --account=<id> --brand=<exact brand>
//        READ-ONLY canary measurement of ONE Brand View unit: evidence SQL, bundle, derive, served currency + the
//        auth / dashboard-read latency before and after. ZERO writes, ZERO queue access, ZERO DataDoe.
// Env: POSTGRES_URL, SUPABASE_URL (or VITE_SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY, DATADOE_API_KEY (the fenced
// publisher's GATE-3 accounts-list GET only -- every other DataDoe request is refused in-process by the zero-export
// guard). Optional: PSR_WORKER_ID, PSR_LEASE_SECONDS (120), PSR_CONTROL_LEASE_SECONDS (90), PSR_DEADLINE_SECONDS (300),
// PSR_SLOW_DB_MS (1500), PSR_SLOW_AUTH_MS (2500), PSR_PAUSE_DURING_SCHEDULER ('true'), PSR_ENV_FILE (a local .env path
// for operator measurement only). 7-bit ASCII, LF.

import { zeroExportGuardState } from "../../lib/server/recovery/zero-export-guard.mjs"; // FIRST: the runtime zero-export guard
import pg from "pg";
import { randomUUID } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import os from "node:os";

if (!zeroExportGuardState()) { console.error("STOP ZERO_EXPORT_GUARD_MISSING -- fail closed, zero work."); process.exit(2); }

const argv = process.argv.slice(2);
const flag = (name) => { const a = argv.find((x) => x === "--" + name || x.startsWith("--" + name + "=")); if (!a) return null; const i = a.indexOf("="); return i < 0 ? true : a.slice(i + 1); };
const S = (v) => (v == null ? "" : String(v));
const errMsg = (e) => S(e && e.message ? e.message : e).replace(/[^\x20-\x7e]/g, "").slice(0, 200);

// Operator measurement from a workstation may point at a local env file; a hosted worker gets injected env only.
if (process.env.PSR_ENV_FILE && existsSync(process.env.PSR_ENV_FILE)) {
  for (const line of readFileSync(process.env.PSR_ENV_FILE, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
  }
}
const { loadReleaseEnv } = await import("../release/env-bootstrap.mjs");
loadReleaseEnv();
for (const v of ["POSTGRES_URL", "SUPABASE_SERVICE_ROLE_KEY"]) if (!process.env[v]) { console.error("STOP missing env " + v); process.exit(2); }
if (!process.env.SUPABASE_URL && !process.env.VITE_SUPABASE_URL) { console.error("STOP missing env SUPABASE_URL"); process.exit(2); }

const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };
const CFG = Object.freeze({
  workerId: S(process.env.PSR_WORKER_ID) || ("psr-" + os.hostname().replace(/[^A-Za-z0-9._-]/g, "").slice(0, 40)),
  leaseSeconds: num(process.env.PSR_LEASE_SECONDS, 120),
  controlLeaseSeconds: num(process.env.PSR_CONTROL_LEASE_SECONDS, 90),
  deadlineSeconds: num(process.env.PSR_DEADLINE_SECONDS, 300),
  slowDbMs: num(process.env.PSR_SLOW_DB_MS, 1500),
  slowAuthMs: num(process.env.PSR_SLOW_AUTH_MS, 2500),
  pauseDuringScheduler: S(process.env.PSR_PAUSE_DURING_SCHEDULER || "true") !== "false",
});

const { verifiedPgConfig } = await import("../../lib/server/pg-tls.js");
const sb = await import("../../lib/server/supabase.js");
const rel = await import("../../lib/server/sync/route-publication-release.js");
const { getDataDoeConnections, resolveDataDoeAccountIds } = await import("../../lib/server/datadoe-connections.js");
const { organizationFingerprint } = await import("../../lib/server/source-identity.js");
const { SCHEDULER_LIVE_SNAPSHOT_CONTRACTS } = await import("../../lib/server/sync/report-publisher.js");
const { REPORT_DERIVATIONS } = await import("../../lib/server/sync/report-derivation.js");
const { paramsHashFor } = await import("../../lib/server/report-store.js");
const { normalizeMarketplace } = await import("../../lib/server/sync/oli-sales-estimate.js");
const { buildSchedulerV2Publisher } = await import("../../lib/server/sync/publisher-composition.js");
const { readPartialCycleCapability } = await import("../../lib/server/sync/priority-partial-capability.js");
const { runControlPackageCli, buildRouteControlPackage } = await import("../../lib/server/sync/source-priority-control-package.js");
const { connectPriorityControlStore } = await import("../../lib/server/sync/priority-control-pg-store.js");
const { CONTROLLED_REPORT_KEYS } = await import("../../lib/server/sync/report-controls.js");
const selectors = await import("../../lib/server/recovery/serve-selectors.js");
const { validateRouteModule, validateRoutePair, isReadOnlyEvidenceSql } = await import("../../lib/server/recovery/route-contract.js");
const { marketplaceToday } = await import("../../lib/marketplaces.js");
const { makeBrandViewDepReaders } = await import("../../lib/server/sync/brand-view-dependency-readers.js");
const cliModule = await import("../../lib/server/sync/routes/brand-view.release.js");
const workerModule = await import("../../lib/server/recovery/routes/brand-view.route.js");
const { runBrandViewUnitPublish, measureBrandViewUnit, resolveJobScope } = await import("../../lib/server/publish-request/brand-view-executor.js");
const { brandViewServedCurrency } = await import("../../lib/server/publish-request/brand-view-currency.js");
const { createPublishRequestWorker } = await import("../../lib/server/publish-request/worker-core.js");

const liveContracts = SCHEDULER_LIVE_SNAPSHOT_CONTRACTS;
const reportDerivations = REPORT_DERIVATIONS;
const cliRoute = validateRouteModule(cliModule, { side: "cli", liveContracts, reportDerivations });
validateRoutePair(validateRouteModule(workerModule, { side: "worker" }), cliRoute, { liveContracts });
const sbRead = rel.readOnlySupabase(sb);
const connections = getDataDoeConnections() || [];
const primaryConn = connections.find((c) => c.id === "primary");
if (!primaryConn) { console.error("STOP no primary DataDoe connection -- fail closed."); process.exit(1); }
const orgFp = primaryConn.organizationFingerprint || organizationFingerprint(primaryConn.apiKey);

// ---- Postgres (verified TLS, read-only evidence reads with a statement timeout) --------------------------------------
const pgConfig = () => verifiedPgConfig(process.env.POSTGRES_URL, { statement_timeout: 60000, query_timeout: 65000 });
let roClient = null;
async function pgReadOnly(text, values = []) {
  if (!isReadOnlyEvidenceSql(text)) throw new Error("pgReadOnly refuses a non-read-only statement (fail closed)");
  if (!roClient) { roClient = new pg.Client(pgConfig()); roClient.on("error", () => { roClient = null; }); await roClient.connect(); }
  const c = roClient;
  await c.query("begin transaction read only");
  try { const r = await c.query(text, values); await c.query("commit"); return r.rows; }
  catch (e) { try { await c.query("rollback"); } catch { roClient = null; } throw e; }
}
async function closeReadOnly() { if (roClient) { try { await roClient.end(); } catch { /* ignore */ } roClient = null; } }
async function withPg(fn) {
  const c = new pg.Client(pgConfig());
  await c.connect();
  try { return await fn(c); } finally { try { await c.end(); } catch { /* ignore */ } }
}
const partialNamespacePermitted = async () => {
  try { return await withPg((c) => readPartialCycleCapability((sql) => c.query(sql).then((r) => r.rows))); }
  catch (e) { return { permitted: false, reason: "capability-unreadable: " + errMsg(e) }; }
};
async function assertNoCron() {
  try {
    return await withPg(async (c) => {
      const t = await c.query("select to_regclass('cron.job')::text cron_table");
      if (!t.rows[0].cron_table) return { ok: true };
      const n = await c.query("select count(*)::int n from cron.job where command ilike '%scheduler%' or command ilike '%sync%' or command ilike '%priority%'");
      return n.rows[0].n === 0 ? { ok: true } : { ok: false, reason: "scheduler cron present" };
    });
  } catch (e) { return { ok: false, reason: "cron read failed: " + errMsg(e) }; }
}
const readControlPlaneClosed = () => rel.readRouteControlPlaneClosed({ connectStore: connectPriorityControlStore, controlledReportKeys: CONTROLLED_REPORT_KEYS });

// ---- the durable directory (re-read per request; no DataDoe discovery) ------------------------------------------------
async function loadDirectory() {
  const rows = await sb.getAccountDirectorySnapshotAccounts();
  const resolveRawSellerId = (id) => { const r = resolveDataDoeAccountIds([id], connections); return r && Array.isArray(r.rawAccountIds) && r.rawAccountIds.length === 1 ? String(r.rawAccountIds[0]) : ""; };
  return rel.buildDurableDirectory({ rows, resolveRawSellerId, normalizeMarketplace }).directory;
}

function makeEnv(directory) {
  return {
    cliRoute, directory, orgFp, primaryConnection: primaryConn, connections, sb: sbRead, pgReadOnly, selectors, computeHash: paramsHashFor,
    liveContracts, reportDerivations, marketplaceToday, normalizeMarketplace, now: () => Date.now(),
    leaseTtlSeconds: CFG.controlLeaseSeconds, deadlineSeconds: CFG.deadlineSeconds,
    makeControls: ({ operator, operationKey, leaseTtlSeconds }) => rel.buildRouteCliControls({
      runControlPackageCli, connectStore: connectPriorityControlStore, buildRouteControlPackage, partialNamespacePermitted, readControlPlaneClosed,
      operator, operationKey, leaseTtlSeconds, leaseWaitSeconds: 0, deadlineSeconds: CFG.deadlineSeconds, runStartMs: Date.now(),
      log: (m) => console.log("psr controls: " + m), closeLog: (m) => console.log("psr safe-close: " + m),
    }),
    renewControlLease: (a) => sb.renewControlPlaneLease(a),
    makePublisher: ({ getControlFence }) => buildSchedulerV2Publisher({ getControlFence }),
    readbackLive: rel.buildRouteLiveReadback({ getReportSnapshot: sb.getReportSnapshot, loadStoragePayload: sb.getReportSnapshotStoragePayload, liveContracts, reportDerivations, computeHash: paramsHashFor }),
    lineage: {
      openCycle: (a, o) => sb.openSyncCycle(a, o), getCycleByBucketDate: (b, d, o) => sb.getBaseSyncCycleByBucketDate(b, d, o),
      claimCycle: (id, o) => sb.claimSyncCycle(id, o), readCycle: (id, o) => sb.getSyncCycle(id, o), upsertReportJob: (j, o) => sb.upsertSyncReportJob(j, o),
      claimLease: (c, rk, a, o) => sb.claimReportDeriveLease(c, rk, a, o), saveShadow: (a, o) => sb.saveShadowSnapshotIfNewer(a, o),
      reconcileSuccess: (a, o) => sb.reconcileReportDeriveSuccess(a, o), finalizeCycle: ({ cycleId }, o) => sb.finalizeSyncCycle(cycleId, o),
      readLatestJob: (rk, a, o) => sb.getLatestReportJobLineage(rk, a, o), readSnapshot: (a, o) => sb.getReportSnapshot(a, o),
      loadStoragePayload: (p, o) => sb.getReportSnapshotStoragePayload(p, o), publishSnapshotUpdate: (a) => sb.publishSnapshotUpdate(a),
    },
    log: (m) => console.log("psr: " + m),
  };
}

const fingerprintReaders = () => makeBrandViewDepReaders({
  orgFp,
  readers: { getSnapshotMeta: sb.getLatestReportSnapshotMeta, getAdsCoverageState: sb.getDailyAdsCoverage, getInventoryCandidates: sb.getInventorySnapshotCandidates, getMappings: sb.getCampaignBrandMappings, getSourceSnap: sb.getSourceSnapshot },
});
const currencyOf = ({ accountId, brand, asOf }) => brandViewServedCurrency({ accountId, brand, asOf, readSnapshotIdentity: (a) => sb.getReportSnapshotIdentity(a), fingerprintReaders: fingerprintReaders() });

async function probeAuthMs() {
  const base = S(process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL).replace(/\/+$/, "");
  const t = Date.now();
  try {
    const r = await fetch(base + "/auth/v1/health", { headers: { apikey: S(process.env.SUPABASE_SERVICE_ROLE_KEY) }, signal: AbortSignal.timeout(8000) });
    return r.ok ? Date.now() - t : null;
  } catch { return null; }
}

// ---- load gates: CHEAP ones BEFORE a claim (no attempt consumed), the control-plane closure proof AFTER it ----------
let cronCheckedAt = 0;
async function preGates() {
  const t0 = Date.now();
  await sb.getPublishRequestControl();
  const dbMs = Date.now() - t0;
  if (dbMs > CFG.slowDbMs) return { ok: false, reason: "database-slow", load: true };
  const authMs = await probeAuthMs();
  if (authMs == null || authMs > CFG.slowAuthMs) return { ok: false, reason: "auth-slow", load: true };
  if (CFG.pauseDuringScheduler) {
    const since = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
    const rows = await sb.listRunningSchedulerCycles({ sinceDate: since, createdSince: new Date(Date.now() - 3 * 3600000).toISOString() });
    const recent = rows.filter((r) => Date.now() - Date.parse(S(r.created_at)) < 3 * 3600000);
    if (recent.length) return { ok: false, reason: "scheduler-running:" + S(recent[0].bucket).replace(/[^a-z-]/g, ""), waitSeconds: 300 };
  }
  if (Date.now() - cronCheckedAt > 600000) {
    const cron = await assertNoCron();
    if (!cron.ok) return { ok: false, reason: "cron-present", waitSeconds: 600 };
    cronCheckedAt = Date.now();
  }
  const lease = await sb.readControlPlaneLease();
  if (lease && lease.held === true && lease.expired !== true) return { ok: false, reason: "control-lease-held", waitSeconds: 60 };
  return { ok: true };
}
async function gates() {
  const closed = await readControlPlaneClosed();
  if (!closed || closed.read !== "ok") return { ok: false, reason: "control-state-unreadable", load: true };
  if (closed.closed !== true) return { ok: false, reason: "control-plane-open", needsCleanup: true, waitSeconds: 120 };
  return { ok: true };
}

// Evidence-based stale-window cleanup (the route CLI's --cleanup): reclaim only a FREE / EXPIRED lease, safe-close,
// then PROVE closed. A live owner is never touched.
async function cleanupControls({ job, runToken }) {
  const before = await readControlPlaneClosed();
  if (before.read === "ok" && before.closed === true) return { closed: true };
  const operator = rel.routeCliOperator({ bucket: "publish-request", runToken });
  let reclaim = null;
  try { reclaim = await runControlPackageCli({ mode: "reclaim", operator, connectStore: connectPriorityControlStore, ownerToken: operator, operationKey: "publish-request/cleanup/" + S(job && job.id).slice(0, 8), log: (m) => console.log("psr cleanup: " + m) }); }
  catch (e) { return { closed: false, reason: errMsg(e) }; }
  if (reclaim && Number(reclaim.code) === 3) return { closed: false, reason: "commit-unknown" };
  const after = await readControlPlaneClosed();
  return { closed: after.read === "ok" && after.closed === true };
}

// ---- modes ------------------------------------------------------------------------------------------------------------
if (flag("check-config")) {
  const control = await sb.getPublishRequestControl().catch((e) => ({ error: errMsg(e) }));
  const lease = await sb.readControlPlaneLease().catch((e) => ({ error: errMsg(e) }));
  const closed = await readControlPlaneClosed().catch((e) => ({ read: "error", reason: errMsg(e) }));
  const cron = await assertNoCron();
  console.log("CHECK " + JSON.stringify({ worker: CFG.workerId, control, lease: lease && { held: lease.held, expired: lease.expired }, controlPlaneClosed: closed && closed.closed, cron, zeroExport: zeroExportGuardState() }));
  process.exit(0);
}

if (flag("measure")) {
  const accountId = S(flag("account"));
  const brand = S(flag("brand"));
  if (!accountId || !brand) { console.error("STOP --measure needs --account and --brand"); process.exit(2); }
  const t0 = Date.now();
  let peakRssMb = 0;
  const rssTimer = setInterval(() => { peakRssMb = Math.max(peakRssMb, Math.round(process.memoryUsage().rss / 1048576)); }, 100);
  const authBefore = await probeAuthMs();
  const directory = await loadDirectory();
  const env = makeEnv(directory);
  const scope = resolveJobScope({ account_id: accountId }, { directory, marketplaceToday, nowMs: Date.now() });
  if (!scope.ok) { console.log("MEASURE " + JSON.stringify({ ok: false, reason: scope.reason })); process.exit(1); }
  const job = { id: "measure", account_id: accountId, brand, as_of: scope.identityAsOf, run_token: "psr-measure-0000" };
  const tDash = Date.now();
  await currencyOf({ accountId, brand, asOf: scope.identityAsOf });
  const dashboardPrecheckMs = Date.now() - tDash;
  const m = await measureBrandViewUnit({ job, env, currency: () => currencyOf({ accountId, brand, asOf: scope.identityAsOf }) });
  // --explain: the SERVER-side execution time + buffers of each evidence SQL for this ONE account (EXPLAIN ANALYZE of a
  // read-only SELECT inside a READ ONLY transaction -- the same statement text + params the route runs).
  let explain = null;
  if (flag("explain")) {
    explain = [];
    const ctx = { accountIds: [accountId], directory, organizationFingerprint: orgFp, now: new Date() };
    for (const q of workerModule.default.evidence.sql) {
      try {
        if (!isReadOnlyEvidenceSql(q.text)) throw new Error("not a read-only evidence statement");
        const rows = await withPg(async (c) => {
          await c.query("begin transaction read only");
          try { return (await c.query("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + q.text, q.params(ctx))).rows; }
          finally { await c.query("rollback"); }
        });
        const plan = rows[0] && rows[0]["QUERY PLAN"] ? rows[0]["QUERY PLAN"][0] : null;
        explain.push({ sql: q.name, execMs: plan ? Math.round(plan["Execution Time"] * 10) / 10 : null, sharedHit: plan && plan.Plan ? plan.Plan["Shared Hit Blocks"] : null, sharedRead: plan && plan.Plan ? plan.Plan["Shared Read Blocks"] : null });
      } catch (e) { explain.push({ sql: q.name, error: errMsg(e) }); }
    }
  }
  const authAfter = await probeAuthMs();
  clearInterval(rssTimer);
  await closeReadOnly();
  const guard = zeroExportGuardState() || {};
  console.log("MEASURE " + JSON.stringify({ ...m, totalMs: Date.now() - t0, dashboardPrecheckMs, authHealthMs: { before: authBefore, after: authAfter }, peakRssMb, explain, zeroExport: { blocked: Number(guard.blocked) || 0, allowedAccountsGets: Number(guard.allowedAccountsGets) || 0 }, writes: 0 }));
  process.exit(0);
}

const worker = createPublishRequestWorker({
  workerId: CFG.workerId,
  store: { claim: (a) => sb.claimPublishRequest(a), renew: (a) => sb.renewPublishRequest(a), finish: (a) => sb.finishPublishRequest(a) },
  preGates,
  gates,
  beat: (a) => sb.publishRequestWorkerBeat(a),
  onTrip: ({ reason }) => sb.tripPublishRequestControl({ reason }),
  execute: async ({ job, signal }) => runBrandViewUnitPublish({ job, env: makeEnv(await loadDirectory()), signal }),
  readBack: ({ job }) => currencyOf({ accountId: S(job.account_id), brand: S(job.brand), asOf: S(job.as_of).slice(0, 10) }),
  cleanupControls,
  zeroExportBlocked: () => Number((zeroExportGuardState() || {}).blocked) || 0,
  newClaimToken: () => randomUUID(),
  log: (m) => console.log(new Date().toISOString() + " psr: " + m),
  config: { leaseSeconds: CFG.leaseSeconds },
});
process.on("SIGTERM", () => { console.log("psr: SIGTERM -- finishing the current request, then exiting"); worker.stop(); });
process.on("SIGINT", () => { worker.stop(); });
console.log("psr: executor " + CFG.workerId + " started (one request at a time; zero-export guard live)");
const res = flag("once") ? await worker.loop({ maxIterations: 1 }) : await worker.loop();
await closeReadOnly();
console.log("psr: stopped " + JSON.stringify(res));
if (res.tripped && !flag("once")) {
  // SAFETY STOP: the feature is disabled in the database (trip_publish_request_control) and this process stays IDLE
  // instead of exiting -- a host restart loop can never resume claiming. Only the owner re-enables it.
  console.error("psr: TRIPPED (" + res.tripped + ") -- idle until an operator intervenes; zero further claims.");
  setInterval(() => console.error("psr: TRIPPED (" + res.tripped + ") -- idle"), 3600000);
} else {
  process.exit(res.tripped ? 3 : 0);
}
