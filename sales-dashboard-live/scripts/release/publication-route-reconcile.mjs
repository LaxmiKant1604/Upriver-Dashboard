// TRUSTED, DEFERRED operator entrypoint for the ZERO-EXPORT publication RECOVERY ROUTES (publication recovery WP4).
// Usage (run from sales-dashboard-live/):
//   DRY-RUN (default; read-only plan, zero writes):
//     node scripts/release/publication-route-reconcile.mjs --route=<id>[,<id>...] --bucket=<region> --as-of=YYYY-MM-DD \
//       [--targets=A,B] [--mode=periodic] [--emit-targets] [--verify-exact] [--deadline-seconds=N]
//   LIVE (the recovery worker: explicit targets + a unique run token; the scheduler: --mode=scheduler, whole region). A
//   live run and any --mode=scheduler run REQUIRE a UNIQUE --run-token (the control lease owner is derived from it, so two
//   live runs of one bucket/date never share a lease-owner identity):
//     ... --live --targets=A,B --run-token=<token> [--prune-shadows] [--verify-exact]
//     ... --live --mode=scheduler --run-token=<token> [--lease-wait-seconds=600]
//   --live --verify-exact is a LIVE EXACT pass: the served check also compares the manifest, and a 'manifest-differs'
//   unit is re-derived into a NEW content-addressed shadow and published through the fenced path.
//   CLEANUP after an abnormal exit (evidence-based control safe-close for the SAME run token):
//     ... --cleanup --run-token=<token>
//
// For each route (in `awaits` order) it loads the route's TWO declared modules -- lib/server/sync/routes/<id>.release.js
// (CLI side) and lib/server/recovery/routes/<id>.route.js (worker side) -- validates both + their pairing FAIL-CLOSED
// (route-contract.js; a missing module is a STOP), builds the route runtime over DURABLE readers only, and runs the
// SHARED saved-data reconciler core in its two-phase mode: phase 1 prepares every stale unit (derive + lineage + shadow
// + finalize) with NO control lease; phase 2 publishes in bounded control windows through the generic route release
// (route-publication-release.js) -> the reviewed fenced four-gate publisher -> the shared live read-back -> the served-
// row check. Routes run in order and the run STOPS at the first route that leaves the control plane unproven (the
// remaining routes are reported deferred 'controls-unresolved', exit 1). It NEVER creates a DataDoe export, reserves a
// token, refreshes a source, or supersedes any export:
//   - the RUNTIME zero-export guard (lib/server/recovery/zero-export-guard.mjs) is the FIRST import -- every DataDoe
//     request except the pinned accounts-list GET throws before any I/O, and the RESULT fails on any block;
//   - the account directory is the DURABLE account-directory snapshot (getAccountDirectorySnapshotAccounts) + the LOCAL
//     raw-seller mapping -- ZERO DataDoe calls on the derive path; the only DataDoe read left is the publisher's GATE-3
//     accounts GET (the fenced publisher composition, unchanged);
//   - Postgres is reached ONLY through lib/server/pg-tls.js verifiedPgConfig (pinned root CA + hostname check).
// The lifecycle is cloned from listing-health-v3-reconcile.mjs: readControlPlaneClosed (evidence-based closure proof),
// assertNoCron before a live run, partialNamespacePermitted before opening controls, apply/rollback through
// runControlPackageCli with the dedicated ROUTE control package (every dispatch paused; only the publisher keys' promoted
// gates + approvals + the window's owner rollout), verifyLease via renewControlPlaneLease, START_RESERVE deadline,
// deadlineRace + awaitSettled, and --cleanup reclaim with the same run token. Machine output: one `TARGETS {v:2}` line
// per route (--emit-targets) and ONE final `RESULT {...}` line. 7-bit ASCII, LF.

import { zeroExportGuardState } from "../../lib/server/recovery/zero-export-guard.mjs"; // FIRST: the runtime zero-export guard (installed on import, before any other module)
import pg from "pg";
import { appendFileSync, existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { verifiedPgConfig } from "../../lib/server/pg-tls.js";
import { loadReleaseEnv, APP_ROOT } from "./env-bootstrap.mjs";
import { accountInScope } from "../../lib/server/sync/scheduler-scope.js";

// FAIL CLOSED: the runtime zero-export proof requires the guard to be live in THIS process before anything else runs.
if (!zeroExportGuardState()) { console.error("STOP ZERO_EXPORT_GUARD_MISSING: the runtime zero-export guard is not installed -- fail closed, zero work."); process.exit(2); }

loadReleaseEnv();

const ghOut = (k, v) => { const f = process.env.GITHUB_OUTPUT; if (f) { try { appendFileSync(f, k + "=" + v + "\n"); } catch { /* ignore */ } } };
const S = (v) => (v == null ? "" : String(v));
const errMsg = (e) => S(e && e.message ? e.message : e).replace(/[^\x20-\x7e]/g, "").slice(0, 200);

const rel = await import("../../lib/server/sync/route-publication-release.js");
const parsed = rel.parseRouteCliArgs(process.argv.slice(2));
if (!parsed.ok) { console.error("STOP " + parsed.code + ": " + parsed.message); process.exit(2); }
const A = parsed.args;
const { bucket, asOf } = A;
const dryRun = A.dryRun;
console.log(`publication-route-reconcile: routes=${A.routes.join(",")} bucket=${bucket} epoch=${asOf} mode=${A.mode} ${dryRun ? (A.verifyExact ? "VERIFY-EXACT (read-only; zero writes)" : "DRY-RUN (read-only; zero writes)") : (A.verifyExact ? "LIVE VERIFY-EXACT" : "LIVE")} targets=${A.targets ? A.targets.length : "region"}`);

const { getDataDoeConnections, resolveDataDoeAccountIds } = await import("../../lib/server/datadoe-connections.js");
const { organizationFingerprint } = await import("../../lib/server/source-identity.js");
const { SCHEDULER_LIVE_SNAPSHOT_CONTRACTS } = await import("../../lib/server/sync/report-publisher.js");
const { REPORT_DERIVATIONS } = await import("../../lib/server/sync/report-derivation.js");
const { paramsHashFor } = await import("../../lib/server/report-store.js");
const { normalizeMarketplace } = await import("../../lib/server/sync/oli-sales-estimate.js");
const { buildSavedDataReconciler } = await import("../../lib/server/sync/saved-data-reconciler.js");
const { formatTargetsLine, TARGETS_UNITS_EMPTY } = await import("../../lib/server/sync/reconcile-targets-output.js");
const { buildSchedulerV2Publisher } = await import("../../lib/server/sync/publisher-composition.js");
const { readPartialCycleCapability } = await import("../../lib/server/sync/priority-partial-capability.js");
const { runControlPackageCli, buildRouteControlPackage } = await import("../../lib/server/sync/source-priority-control-package.js");
const { connectPriorityControlStore } = await import("../../lib/server/sync/priority-control-pg-store.js");
const { CONTROLLED_REPORT_KEYS } = await import("../../lib/server/sync/report-controls.js");
const selectors = await import("../../lib/server/recovery/serve-selectors.js");
const { validateRouteModule, validateRoutePair, routeTopoOrder, isReadOnlyEvidenceSql } = await import("../../lib/server/recovery/route-contract.js");
const { marketplaceToday } = await import("../../lib/marketplaces.js");
const sb = await import("../../lib/server/supabase.js");
// The route RUNTIME only ever sees READERS (get* / list* + pure helpers): no supabase writer reaches a route module.
const sbRead = rel.readOnlySupabase(sb);

const liveContracts = SCHEDULER_LIVE_SNAPSHOT_CONTRACTS;
const reportDerivations = REPORT_DERIVATIONS;

// Verified TLS: chain pinned to the Supabase root CA + hostname checked (lib/server/pg-tls.js). The ONLY pg config here.
const pgConfig = () => verifiedPgConfig(process.env.POSTGRES_URL);
const makePgClient = () => new pg.Client(pgConfig());

const OPERATOR = rel.routeCliOperator({ bucket, runToken: A.runToken, asOf });
const CONTROL_OP_KEY = "publication-route-reconcile/" + A.routes.join("+") + "/" + bucket + "/" + asOf;

// READ-ONLY control-plane state reconciliation (EVIDENCE-BASED closure): PROVE the priority publication controls are
// closed from the actual rows, never from a rollback disposition or a lease-not-owner skip. { read, closed, detail }.
const readControlPlaneClosed = () => rel.readRouteControlPlaneClosed({ connectStore: connectPriorityControlStore, controlledReportKeys: CONTROLLED_REPORT_KEYS });

// ABNORMAL-TERMINATION CLEANUP (evidence-based): inspect -> reclaim only a free/expired lease -> re-inspect + require
// proven closed. A live owner blocks reclaim (zero writes). Needs no route module and no directory.
if (A.cleanup) {
  const before = await readControlPlaneClosed();
  if (before.read === "ok" && before.closed === true) { console.log("RESULT " + JSON.stringify({ mode: "cleanup", routes: A.routes, bucket, epoch: asOf, cleaned: true, disposition: "already-closed", dataDoeCreates: 0, dataDoeTokens: 0 })); process.exit(0); }
  let reclaim = null;
  try { reclaim = await runControlPackageCli({ mode: "reclaim", operator: OPERATOR, connectStore: connectPriorityControlStore, ownerToken: OPERATOR, operationKey: CONTROL_OP_KEY, log: (m) => console.log("publication-route-reconcile cleanup: " + m) }); }
  catch (e) { reclaim = { committed: false, code: 1, error: errMsg(e) }; }
  if (reclaim && Number(reclaim.code) === 3) { console.error("STOP ROUTE_CLEANUP_COMMIT_UNKNOWN -- read-only reconciliation required; controls NOT proven closed."); process.exit(1); }
  const after = await readControlPlaneClosed();
  const cleaned = after.read === "ok" && after.closed === true;
  console.log("RESULT " + JSON.stringify({ mode: "cleanup", routes: A.routes, bucket, epoch: asOf, cleaned, reclaim: reclaim && (reclaim.skipped || (reclaim.committed ? "committed" : "refused-or-held")), before: before.detail || before.read, after: after.detail || after.read, dataDoeCreates: 0, dataDoeTokens: 0 }));
  if (!cleaned) console.error("STOP ROUTE_CLEANUP_UNVERIFIED: controls NOT proven closed (a live owner is left untouched; retry after the lease expires).");
  process.exit(cleaned ? 0 : 1);
}

// ---- route modules: dynamic import ONLY after the id passed the route-id regex; a missing module is a STOP ----------
async function loadRoute(id) {
  const cliPath = path.join(APP_ROOT, "lib", "server", "sync", "routes", id + ".release.js");
  const workerPath = path.join(APP_ROOT, "lib", "server", "recovery", "routes", id + ".route.js");
  if (!existsSync(cliPath) || !existsSync(workerPath)) { console.error(`STOP ROUTE_MODULE_MISSING: route '${id}' needs lib/server/sync/routes/${id}.release.js AND lib/server/recovery/routes/${id}.route.js -- fail closed.`); process.exit(2); }
  try {
    const cliRoute = validateRouteModule(await import(pathToFileURL(cliPath).href), { side: "cli", liveContracts, reportDerivations });
    const workerRoute = validateRouteModule(await import(pathToFileURL(workerPath).href), { side: "worker" });
    validateRoutePair(workerRoute, cliRoute, { liveContracts });
    return { id, cliRoute, workerRoute };
  } catch (e) { console.error(`STOP ROUTE_MODULE_INVALID: route '${id}': ${errMsg(e)}`); process.exit(2); }
}
const loaded = [];
for (const id of A.routes) loaded.push(await loadRoute(id));
let order;
try { order = routeTopoOrder(loaded.map((r) => r.workerRoute)); }
catch (e) { console.error("STOP ROUTE_AWAITS_CYCLE: " + errMsg(e)); process.exit(2); }

const connections = getDataDoeConnections() || [];
const primaryConn = connections.find((c) => c.id === "primary");
if (!primaryConn) { console.error("STOP ROUTE_NO_PRIMARY_CONNECTION -- fail closed."); process.exit(1); }
const orgFp = primaryConn.organizationFingerprint || organizationFingerprint(primaryConn.apiKey);

const withTimeout = (p, label) => { let t; return Promise.race([Promise.resolve(p).finally(() => clearTimeout(t)), new Promise((_, rej) => { t = setTimeout(() => rej(new Error(label + " timed out after 120000ms")), 120000); })]); };

// ---- the DURABLE account directory (no DataDoe discovery) -----------------------------------------------------------
let directory;
try {
  const rows = await withTimeout(sb.getAccountDirectorySnapshotAccounts(), "account directory");
  const resolveRawSellerId = (id) => { const r = resolveDataDoeAccountIds([id], connections); return r && Array.isArray(r.rawAccountIds) && r.rawAccountIds.length === 1 ? String(r.rawAccountIds[0]) : ""; };
  const built = rel.buildDurableDirectory({ rows, resolveRawSellerId, normalizeMarketplace });
  directory = built.directory;
  if (built.excluded.length) console.log(`publication-route-reconcile: durable directory excluded ${built.excluded.length} row(s) (${[...new Set(built.excluded.map((x) => x.reason))].join(",")})`);
} catch (e) {
  console.error("STOP ROUTE_DIRECTORY_UNREADABLE: the durable account directory could not be read (" + errMsg(e) + ") -- fail closed, zero writes.");
  process.exit(1);
}
if (!directory || directory.size === 0) { console.error("STOP ROUTE_DIRECTORY_EMPTY: the durable account directory is empty -- fail closed, zero writes."); process.exit(1); }

// A READ-ONLY verified pg query for route evidence reads (a single SELECT/WITH inside a READ ONLY transaction).
let roClient = null;
async function pgReadOnly(text, values = []) {
  if (!isReadOnlyEvidenceSql(text)) throw new Error("pgReadOnly refuses a non-read-only statement (fail closed)");
  if (!roClient) { roClient = makePgClient(); await roClient.connect(); }
  await roClient.query("begin transaction read only");
  try { const r = await roClient.query(text, values); await roClient.query("commit"); return r.rows; }
  catch (e) { try { await roClient.query("rollback"); } catch { /* ignore */ } throw e; }
}
async function closeReadOnly() { if (roClient) { try { await roClient.end(); } catch { /* ignore */ } roClient = null; } }

// ---- control lifecycle (cloned from listing-health-v3-reconcile.mjs) -------------------------------------------------
async function assertNoCron() {
  let client = null;
  try {
    client = makePgClient();
    await client.connect();
    const t = await client.query("select to_regclass('cron.job')::text cron_table");
    if (!t.rows[0].cron_table) return { ok: true };
    const n = await client.query("select count(*)::int n from cron.job where command ilike '%scheduler%' or command ilike '%sync%' or command ilike '%priority%'");
    return n.rows[0].n === 0 ? { ok: true } : { ok: false, reason: "scheduler cron present (" + n.rows[0].n + ")" };
  } catch (e) { return { ok: false, reason: "cron read failed: " + errMsg(e) }; }
  finally { try { await client.end(); } catch { /* ignore */ } }
}
async function partialNamespacePermitted() {
  let probe = null;
  try { probe = makePgClient(); await probe.connect(); return await readPartialCycleCapability((sql) => probe.query(sql).then((r) => r.rows)); }
  catch (e) { return { permitted: false, reason: "capability-unreadable: " + errMsg(e) }; }
  finally { try { await probe.end(); } catch { /* ignore */ } }
}

// ---- deadline machinery (cloned from listing-health-v3-reconcile.mjs) -----------------------------------------------
const deadlineSec = A.deadlineSeconds;
const runStartMs = Date.now();
const START_RESERVE_SEC = rel.ROUTE_CLI_START_RESERVE_SECONDS;
const startCutoffSec = deadlineSec > 0 ? Math.max(Math.floor(deadlineSec / 2), deadlineSec - START_RESERVE_SEC) : 0;
const outOfTime = () => deadlineSec > 0 && (Date.now() - runStartMs) / 1000 > startCutoffSec;
const deadlineRace = (p, _signal) => {
  if (deadlineSec <= 0) return p;
  const remainingMs = Math.max(0, deadlineSec * 1000 - (Date.now() - runStartMs));
  let t; const timer = new Promise((resolve) => { t = setTimeout(() => resolve({ __deadline: true }), remainingMs); });
  return Promise.race([Promise.resolve(p).then((v) => { clearTimeout(t); return v; }), timer]);
};
const SETTLE_GRACE_MS = 8000;
const awaitSettled = (p) => {
  let t; const grace = new Promise((resolve) => { t = setTimeout(() => resolve({ settled: false }), SETTLE_GRACE_MS); });
  return Promise.race([Promise.resolve(p).then(() => { clearTimeout(t); return { settled: true }; }, () => { clearTimeout(t); return { settled: true }; }), grace]);
};

// ---- the control windows: the SHARED route CLI control lifecycle (route-publication-release.js buildRouteCliControls)
// over the real control store. openControls applies the dedicated ROUTE package (EXACTLY the window's owner rollout +
// the publisher keys' PROMOTED gates + approvals, EVERY controlled dispatch paused, asserted in the same transaction);
// the bounded lease-wait runs ONLY in scheduler mode (default 0 == the single attempt) and is CAPPED at the remaining
// deadline minus START_RESERVE (never waits past the deadline); closeControls = rollback + the evidence-based closure.
const controls = rel.buildRouteCliControls({
  runControlPackageCli, connectStore: connectPriorityControlStore, buildRouteControlPackage, partialNamespacePermitted, readControlPlaneClosed,
  operator: OPERATOR, operationKey: CONTROL_OP_KEY, leaseTtlSeconds: 900,
  leaseWaitSeconds: A.mode === "scheduler" ? A.leaseWaitSeconds : 0,
  deadlineSeconds: deadlineSec, runStartMs, startReserveSeconds: START_RESERVE_SEC,
  log: (m) => console.log("publication-route-reconcile controls: " + m),
  closeLog: (m) => console.log("publication-route-reconcile safe-close: " + m),
});
const openControls = controls.openControls;
const closeControls = controls.closeControls;
const verifyLease = async ({ signal = null } = {}) => {
  if (signal && signal.aborted) return { ok: false, reason: "deadline-aborted" };
  const leaseFence = controls.fence();
  if (!leaseFence) return { ok: false, reason: "no-fence" };
  try { const r = await sb.renewControlPlaneLease({ ownerToken: leaseFence.ownerToken, generation: leaseFence.generation, ttlSeconds: 900 }); return { ok: !!(r && r.disposition === "renewed"), reason: r && (r.reason || r.disposition) }; }
  catch (e) { return { ok: false, reason: "renew-error:" + errMsg(e) }; }
};

// ONE fenced publisher for the run (one memoized GATE-3 discovery); its fence is the CURRENT window's lease, and an
// aborted op's fence is null (the fenced CAS then writes zero rows).
let activeOpSignal = null;
let runPublisher = null;
const publisherFor = (signal) => {
  activeOpSignal = signal || null;
  if (!runPublisher) runPublisher = buildSchedulerV2Publisher({ getControlFence: () => (activeOpSignal && activeOpSignal.aborted ? null : controls.fence()) });
  return runPublisher;
};
const readbackLive = rel.buildRouteLiveReadback({
  getReportSnapshot: sb.getReportSnapshot, loadStoragePayload: sb.getReportSnapshotStoragePayload,
  liveContracts, reportDerivations, computeHash: paramsHashFor,
});

if (!dryRun) {
  const cron = await assertNoCron();
  if (!cron.ok) { console.error("STOP ROUTE_RECONCILE: " + cron.reason + " -- fail closed."); process.exit(1); }
}

// ---- run every route in awaits order; STOP at the first route that leaves the control plane unproven ------------------
const byId = new Map(loaded.map((r) => [r.id, r]));
const routeResults = [];
const totals = { targetsExamined: 0, targetsStale: 0, targetsPublished: 0, targetsAlreadyCurrent: 0, targetsDeferred: 0, targetsFailed: 0, targetsUnitsEmpty: 0 };
let anyControlUnresolved = false;
async function runRoute(id) {
  const { cliRoute } = byId.get(id);
  const log = (m) => console.log(`publication-route-reconcile[${id}]: ${m}`);
  let runtime;
  try {
    runtime = cliRoute.build(Object.freeze({
      bucket, epoch: asOf, directory, orgFp, connectionId: "primary", primaryConnection: primaryConn, connections,
      sb: sbRead, pgReadOnly, selectors, computeHash: paramsHashFor, liveContracts, reportDerivations, marketplaceToday, normalizeMarketplace,
      now: () => Date.now(), strict: true, log,
    }));
  } catch (e) { console.error(`STOP ROUTE_BUILD_FAILED: route '${id}': ${errMsg(e)}`); process.exit(2); }
  let release, adapter;
  try {
    release = rel.buildRoutePublicationRelease({
      route: cliRoute, runtime,
      deps: {
        openCycle: (args, opt) => sb.openSyncCycle(args, opt),
        getCycleByBucketDate: (bk, date, opt) => sb.getBaseSyncCycleByBucketDate(bk, date, opt),
        claimCycle: (cycleId, opt) => sb.claimSyncCycle(cycleId, opt),
        readCycle: (cycleId, opt) => sb.getSyncCycle(cycleId, opt),
        upsertReportJob: (job, opt) => sb.upsertSyncReportJob(job, opt),
        claimLease: (cycleId, reportKey, a, opts) => sb.claimReportDeriveLease(cycleId, reportKey, a, opts),
        saveShadow: (args, opt) => sb.saveShadowSnapshotIfNewer(args, opt),
        reconcileSuccess: (args, opt) => sb.reconcileReportDeriveSuccess(args, opt),
        finalizeCycle: ({ cycleId }, opt) => sb.finalizeSyncCycle(cycleId, opt),
        readLatestJob: (reportKey, a, opt) => sb.getLatestReportJobLineage(reportKey, a, opt),
        readSnapshot: (args, opt) => sb.getReportSnapshot(args, opt),
        loadStoragePayload: (p, opt) => sb.getReportSnapshotStoragePayload(p, opt),
        publisherFor, verifyLease, readbackLive,
        liveContracts, reportDerivations, computeHash: paramsHashFor,
        // The publish-time evidence re-read uses the SAME scan-level inputs the adapter hands readScopeEvidence.
        evidenceContext: { directory, organizationFingerprint: orgFp, connectionId: "primary" },
        publishSnapshotUpdate: (args) => sb.publishSnapshotUpdate(args),
        pruneShadows: (args, opt) => sb.deleteRouteShadowSnapshots(args, opt), prune: A.pruneShadows === true,
        log,
      },
    });
    adapter = rel.buildRouteReconcileAdapter({ route: cliRoute, runtime, bucket, directory, liveContracts, readLatestJob: (rk, a) => sb.getLatestReportJobLineage(rk, a), verifyExact: A.verifyExact });
  } catch (e) { console.error(`STOP ROUTE_RELEASE_INVALID: route '${id}': ${errMsg(e)}`); process.exit(2); }

  // Scope: the route's own scope targets (default: the region's durable-directory accounts). An explicit --targets list
  // must lie inside it (never an out-of-region / unknown target).
  let scope;
  try { scope = typeof runtime.scopeTargets === "function" ? await runtime.scopeTargets({ directory, bucket, epoch: asOf }) : rel.regionAccountIds(directory, bucket, accountInScope); }
  catch (e) { console.error(`STOP ROUTE_SCOPE_UNRESOLVED: route '${id}': ${errMsg(e)}`); process.exit(1); }
  scope = [...new Set((Array.isArray(scope) ? scope : []).map(S).filter(Boolean))].sort();
  if (A.targets) {
    const outside = A.targets.filter((t) => !scope.includes(t));
    if (outside.length) { console.error(`STOP ROUTE_TARGET_OUT_OF_SCOPE: route '${id}': ${outside.length} target(s) are not in the ${bucket} scope -- fail closed.`); process.exit(2); }
  }

  const reconciler = buildSavedDataReconciler({
    resolveOrg: async () => ({ organizationFingerprint: orgFp, connectionId: "primary" }),
    bucketAccounts: async () => scope.map((accountId) => ({ accountId })),
    adapter,
    readLatestReportJob: ({ reportKey, accountId }) => sb.getLatestReportJobLineage(reportKey, accountId),
    readShadowSnapshot: (args) => sb.getReportSnapshot(args),
    readLiveSnapshot: (args) => sb.getReportSnapshot(args),
    loadStoragePayload: (p) => sb.getReportSnapshotStoragePayload(p),
    verifyLiveReadback: readbackLive,
    liveContracts, computeHash: paramsHashFor, reportDerivations,
    runPrepareForUnit: (args) => release.prepareForUnit(args),
    runPublishForUnit: (args) => release.publishForUnit(args),
    openControls: dryRun ? (async () => ({ ok: true })) : openControls,
    closeControls: dryRun ? (async () => ({ ok: true })) : closeControls,
    outOfTime, deadlineRace,
    makeAbortController: () => new AbortController(), awaitSettled,
    reportKeys: [cliRoute.publisherKey],
    withTimeout, log, family: id,
    // LEASE FAIRNESS (WP13 verifier P2-1): a live run leaves the global lease free between its control windows.
    interWindowPauseMs: dryRun ? 0 : rel.ROUTE_CLI_INTER_WINDOW_PAUSE_MS,
  });
  const out = await reconciler.run({ bucket, requestedAsOf: asOf, accountIds: A.targets, mode: A.mode, dryRun });
  // An EMPTY unit list proves NOTHING current: such a target is never counted complete.
  const unitsEmpty = (out.perAccount || []).filter((r) => r && r.unitsReason === TARGETS_UNITS_EMPTY).length;
  const outcome = out.outcome === "complete" && unitsEmpty > 0 ? "partial" : out.outcome;
  if (out.controlCleanupUnresolved === true) anyControlUnresolved = true;
  const counts = { ...(out.counts || {}), targetsUnitsEmpty: unitsEmpty };
  for (const k of Object.keys(totals)) totals[k] += Number(counts[k] || 0);
  routeResults.push({ id, ok: out.ok === true, outcome, code: out.code || "OK", counts });
  if (A.emitTargets) console.log(formatTargetsLine({ v: 2, route: id, summary: { ...out, bucket, requestedAsOf: asOf, dryRun } }));
  return out;
}
// A route whose run left the control plane UNPROVEN (safe-close / apply COMMIT_UNKNOWN, a failed or unverified
// safe-close, an unconfirmed deadline termination) STOPS the sequence: no later route opens a control window over it.
// Every remaining route is reported DEFERRED 'controls-unresolved' (RESULT + a target-less TARGETS line) and the run
// exits 1 with CONTROL_CLEANUP_UNRESOLVED -- the same unresolved-control exit as the LHv3 CLI.
const seq = await rel.runRouteCliSequence({ order, runRoute, log: (m) => console.log("publication-route-reconcile: " + m) });
for (const run of seq.runs.filter((r) => r.skipped)) {
  routeResults.push(rel.routeCliSkippedRoute(run.id));
  if (A.emitTargets) console.log(formatTargetsLine({ v: 2, route: run.id, summary: rel.routeCliSkippedTargetsSummary({ bucket, asOf, dryRun }) }));
}
if (seq.stoppedBy) anyControlUnresolved = true;
await closeReadOnly();

const guard = zeroExportGuardState() || { blocked: 0 };
const zeroExportViolation = Number(guard.blocked) > 0;
const verdict = rel.routeCliOutcome({ routeResults, zeroExportViolation, anyControlUnresolved });
ghOut("outcome", verdict.outcome);
ghOut("published_count", String(totals.targetsPublished));
ghOut("failed_count", String(totals.targetsFailed));
console.log("RESULT " + JSON.stringify({
  ok: verdict.ok, outcome: verdict.outcome, code: verdict.code, routes: routeResults, bucket, epoch: asOf, mode: A.mode, dryRun, verifyExact: A.verifyExact,
  ...(seq.stoppedBy ? { stoppedBy: seq.stoppedBy } : {}),
  dataDoeCreates: 0, dataDoeTokens: 0, zeroExport: { blocked: Number(guard.blocked) || 0 },
  counts: totals,
}));
process.exit(verdict.exitCode);
