// TRUSTED, DEFERRED operator entrypoint for the ZERO-EXPORT OLI publication reconciler.
// Usage (run from sales-dashboard-live/):
//   IMMEDIATE (right after the scheduler's publish, while full_controls still owns the lease):
//     node scripts/release/oli-publication-reconcile.mjs --bucket=<region> --as-of=YYYY-MM-DD --mode=immediate \
//       --accounts=A,B --live --run-token=<full_controls owner token> --owner-generation=<full_controls generation>
//   PERIODIC (30-min backstop, after safe-close):
//     node scripts/release/oli-publication-reconcile.mjs --bucket=<region> --as-of=YYYY-MM-DD --mode=periodic [--live]
//
// It re-derives + promotes the OLI-dependent canonical live dashboards for accounts whose durable OLI advanced past
// (or was never promoted to) their live snapshots, using ALREADY-SAVED durable OLI. It NEVER creates a DataDoe export,
// reserves a token, refreshes a source, or supersedes the daily export -- the derive's inner adapter is FORCED to
// refuse creates. DEFAULT is DRY-RUN (read-only plan; zero writes); LIVE promotion requires --live.
//
// CYCLE NAMESPACE (blocker 1): it publishes into the REVIEWED priority-partial-<region>-<16hex> cycle namespace
// (migration 20260924), verified by a read-only exact capability preflight; the 16-hex identity is deterministic over
// {accountId, durable OLI revisionId}. CONTROL/LEASE (blocker 2): IMMEDIATE mode RENEWS the scheduler's exact
// (owner_token, generation) fence -- never re-acquires, never safe-closes (the scheduler's safe-close owns it).
// PERIODIC mode runs the reviewed control-package transaction: apply (open controls for exactly the stale accounts +
// acquire the lease + capture the generation) -> publish with that fence -> ALWAYS safe-close with the same
// owner/generation. It never acquires a standalone lease without opening the corresponding controls. 7-bit ASCII, LF.

import pg from "pg";
import { appendFileSync } from "node:fs";
import { loadReleaseEnv } from "./env-bootstrap.mjs";
import { isRegionScope, accountInScope } from "../../lib/server/sync/scheduler-scope.js";

loadReleaseEnv();

const argOf = (name) => { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.split("=").slice(1).join("=") : null; };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const bucket = argOf("bucket");
const asOf = argOf("as-of");
const mode = argOf("mode") === "immediate" ? "immediate" : "periodic";
const live = process.argv.includes("--live");
const dryRun = !live;
const accountsArg = (argOf("accounts") || "").split(",").map((s) => s.trim()).filter(Boolean);
const runToken = (argOf("run-token") || "").trim();
const rawOwnerGen = (argOf("owner-generation") || "").trim();
const ownerGeneration = /^\d+$/.test(rawOwnerGen) ? Number(rawOwnerGen) : NaN;
const ghOut = (k, v) => { const f = process.env.GITHUB_OUTPUT; if (f) { try { appendFileSync(f, k + "=" + v + "\n"); } catch { /* ignore */ } } };

if (!isRegionScope(bucket)) { console.error("STOP OLI_RECONCILE_REGION_UNSUPPORTED: --bucket must be india|europe-au|us-ca (region-scoped); got " + bucket); process.exit(2); }
if (!DATE_RE.test(String(asOf))) { console.error("STOP OLI_RECONCILE_AS_OF: --as-of=YYYY-MM-DD is required; got " + asOf); process.exit(2); }
if (mode === "immediate" && accountsArg.length === 0) { console.error("STOP OLI_RECONCILE_IMMEDIATE: --mode=immediate requires --accounts=A,B (the accounts whose OLI just saved)."); process.exit(2); }
if (live && mode === "immediate" && !(runToken && Number.isSafeInteger(ownerGeneration) && ownerGeneration > 0)) {
  console.error("STOP OLI_RECONCILE_IMMEDIATE_FENCE: live immediate mode REQUIRES --run-token + --owner-generation (the scheduler's full_controls fence; the reconciler renews it, never re-acquires).");
  process.exit(2);
}
console.log(`oli-reconcile: bucket=${bucket} as-of=${asOf} mode=${mode} ${dryRun ? "DRY-RUN (read-only; zero writes)" : "LIVE"} accounts=${accountsArg.length || "region"}`);

const { buildOliPublicationReconciler } = await import("../../lib/server/sync/oli-publication-reconciler.js");
const { oliDependentLiveReportKeys } = await import("../../lib/server/sync/oli-dependent-reports.js");
const { sourceRegistryEntry } = await import("../../lib/server/sync/source-registry.js");
const { organizationFingerprint, sha256 } = await import("../../lib/server/source-identity.js");
const { getDataDoeConnections, classifyDirectoryAccounts } = await import("../../lib/server/datadoe-connections.js");
const { fetchAccounts: fetchDirectory } = await import("../../lib/server/datadoe.js");
const { SCHEDULER_LIVE_SNAPSHOT_CONTRACTS } = await import("../../lib/server/sync/report-publisher.js");
const { REPORT_DERIVATIONS } = await import("../../lib/server/sync/report-derivation.js");
const { paramsHashFor } = await import("../../lib/server/report-store.js");
const { buildPriorityDashboardsRelease } = await import("../../lib/server/sync/source-priority-dashboards.js");
const { isSharedCatalogColdDefer, buildCatalogColdFastDefer } = await import("../../lib/server/sync/oli-catalog-cold-latch.js");
const { runPriorityDashboardsRelease, buildLiveReadback } = await import("../../lib/server/sync/source-priority-release-runner.js");
const { readPartialCycleCapability } = await import("../../lib/server/sync/priority-partial-capability.js");
const { runControlPackageCli } = await import("../../lib/server/sync/source-priority-control-package.js");
const { connectPriorityControlStore } = await import("../../lib/server/sync/priority-control-pg-store.js");
const { CONTROLLED_REPORT_KEYS } = await import("../../lib/server/sync/report-controls.js");
const sb = await import("../../lib/server/supabase.js");

// READ-ONLY control-plane state reconciliation (blocker 4): PROVE the priority publication controls are closed --
// rollout disabled, controlled dispatch paused, promoted disabled, approvals revoked -- from the actual rows, never
// from a rollback disposition or a lease-not-owner skip. { read, closed, detail }. Connects + always ends its client.
async function readControlPlaneClosed() {
  let store = null;
  try {
    store = await connectPriorityControlStore();
    const [rollout, dispatch, promoted, approvals] = await Promise.all([store.rolloutRows(), store.dispatchRows(), store.promotedRows(), store.approvalRows()]);
    const controlled = new Set(CONTROLLED_REPORT_KEYS);
    const enabledRollout = (rollout || []).filter((r) => r.enabled === true).length;
    const enabledDispatch = (dispatch || []).filter((r) => r.schedule_enabled === true && controlled.has(String(r.report_key))).length;
    const enabledPromoted = (promoted || []).filter((r) => r.publish_enabled === true).length;
    const approved = (approvals || []).filter((r) => r.approved === true).length;
    const detail = { enabledRollout, enabledDispatch, enabledPromoted, approved };
    return { read: "ok", closed: enabledRollout + enabledDispatch + enabledPromoted + approved === 0, detail };
  } catch (e) { return { read: "read-failed", closed: false, error: e && e.message ? e.message : String(e) }; }
  finally { if (store && typeof store.end === "function") { try { await store.end(); } catch { /* ignore */ } } }
}

const OLI = "order-line-items";
const oliStart = sourceRegistryEntry(OLI).initialBackfill.start;
const connections = getDataDoeConnections() || [];
const primaryConn = connections.find((c) => c.id === "primary");
if (!primaryConn) { console.error("STOP OLI_RECONCILE_NO_PRIMARY_CONNECTION -- fail closed."); process.exit(1); }
const orgFp = primaryConn.organizationFingerprint || organizationFingerprint(primaryConn.apiKey);

const withTimeout = (p, label) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(label + " timed out after 120000ms")), 120000))]);
const pgBase = String(process.env.POSTGRES_URL || "").split("?")[0];
const makePgReadOnly = () => new pg.Client({ connectionString: pgBase, ssl: { rejectUnauthorized: false } });

const readbackLive = buildLiveReadback({
  getReportSnapshot: sb.getReportSnapshot,
  loadStoragePayload: sb.getReportSnapshotStoragePayload,
  liveContracts: SCHEDULER_LIVE_SNAPSHOT_CONTRACTS,
  reportDerivations: REPORT_DERIVATIONS,
  computeHash: paramsHashFor,
});

// NO-EXPORT inner adapter: the reconciler derives ONLY from already-saved durable OLI. Any create/poll/download from
// inside the derive fails closed here, so the reconciler can never touch a DataDoe export transport -- a genuinely
// missing/not-yet-materialized durable dependency becomes a typed RETRYABLE derive DEFERRAL, never a create.
// The refusal carries a STABLE code (NO_EXPORT_REQUIRED) so the source worker classifies it as the retryable
// SOURCE_READINESS_PENDING (the durable source is not adoptable THIS pass -> defer to the next natural cycle) instead
// of a generic EXPORT_ERROR that would collapse into a HARD REQUIRED_SOURCE_FAILED. It is set ONLY here (the reconciler
// path); the scheduled full-region path uses the real DataDoe adapter and never emits this code, so its behavior is
// byte-identical. This is why a routine "the org Product Catalog carrier is not warm this pass" defers instead of
// hard-failing every account and stranding the global lease (the incident this fixes).
const makeNoExportInnerAdapter = () => ({
  // The `noExport` flag lets makeDurableCatalogGuard refuse a Catalog create BEFORE it reserves (see below): a reserve
  // followed by this refusal would leave an orphaned "reserved"/no-export-id reservation that EVERY subsequent account
  // in the operation reads as AMBIGUOUS and HARD-fails on. Refusing pre-reserve makes the whole operation defer cleanly.
  noExport: true,
  create: async () => { const e = new Error("OLI_RECONCILER_NO_EXPORT: the reconciler never creates a DataDoe export (fail closed)."); e.code = "NO_EXPORT_REQUIRED"; throw e; },
  poll: async () => { const e = new Error("OLI_RECONCILER_NO_EXPORT: the reconciler never polls a DataDoe export (fail closed)."); e.code = "NO_EXPORT_REQUIRED"; throw e; },
  download: async () => { const e = new Error("OLI_RECONCILER_NO_EXPORT: the reconciler never downloads a DataDoe export (fail closed)."); e.code = "NO_EXPORT_REQUIRED"; throw e; },
});

async function assertNoCron() {
  const client = makePgReadOnly();
  try {
    await client.connect();
    const t = await client.query("select to_regclass('cron.job')::text cron_table");
    if (!t.rows[0].cron_table) return { ok: true };
    const n = await client.query("select count(*)::int n from cron.job where command ilike '%scheduler%' or command ilike '%sync%' or command ilike '%priority%'");
    return n.rows[0].n === 0 ? { ok: true } : { ok: false, reason: "scheduler cron present (" + n.rows[0].n + ")" };
  } catch (e) { return { ok: false, reason: "cron read failed: " + (e && e.message) }; }
  finally { try { await client.end(); } catch { /* ignore */ } }
}
async function reconcile() {
  const cron = await assertNoCron();
  if (!cron.ok) return { ok: false, problems: [cron.reason] };
  return { ok: true };
}

// The captured control fence (owner_token + generation). Immediate mode reuses the scheduler's; periodic mode captures
// it from the control-package apply. Declared BEFORE the release so getControlFence reads the current value.
let leaseFence = null;
const OPERATOR = "oli-reconcile:" + bucket + ":" + (runToken || asOf);
const CONTROL_OP_KEY = "oli-reconcile/" + bucket + "/" + asOf;

// Read-only exact capability preflight: the priority-partial cycle namespace is permitted ONLY once migration 20260924
// widened open_sync_cycle + sync_cycles_bucket_check. Fail closed (defer) if not.
async function partialNamespacePermitted() {
  const probe = new pg.Client({ connectionString: pgBase, ssl: { rejectUnauthorized: false } });
  try { await probe.connect(); const cap = await readPartialCycleCapability((sql) => probe.query(sql).then((r) => r.rows)); return cap; }
  catch (e) { return { permitted: false, reason: "capability-unreadable: " + (e && e.message ? e.message : e) }; }
  finally { try { await probe.end(); } catch { /* ignore */ } }
}

// CONTROLS (blocker 2). Both modes require the priority-partial namespace + a fence. Immediate RENEWS the scheduler's
// exact fence (no apply, no safe-close). Periodic runs the reviewed control-package apply/safe-close.
async function openControls(staleAccountIds) {
  const cap = await partialNamespacePermitted();
  if (!cap || cap.permitted !== true) return { ok: false, reason: "PRIORITY_PARTIAL_MIGRATION_PENDING (" + String(cap && cap.reason) + ")" };
  if (mode === "immediate") {
    try {
      const r = await sb.renewControlPlaneLease({ ownerToken: runToken, generation: ownerGeneration, ttlSeconds: 900 });
      if (!r || r.disposition !== "renewed") return { ok: false, reason: "CONTROL_LEASE_LOST: could not renew the scheduler fence (" + String(r && (r.reason || r.disposition)) + ")" };
      leaseFence = { ownerToken: runToken, generation: ownerGeneration };
      return { ok: true };
    } catch (e) { return { ok: false, reason: "renew-error:" + (e && e.message ? e.message : e) }; }
  }
  // periodic: open publication controls for EXACTLY the stale accounts + capture the fencing generation.
  if (!staleAccountIds || staleAccountIds.length === 0) return { ok: false, reason: "no-stale-accounts" };
  try {
    const r = await runControlPackageCli({
      mode: "apply", operator: OPERATOR,
      discoverAccounts: async () => [...staleAccountIds],
      connectStore: connectPriorityControlStore,
      ownerToken: OPERATOR, operationKey: CONTROL_OP_KEY, leaseTtlSeconds: 900,
      log: (m) => console.log("oli-reconcile controls: " + m),
    });
    // APPLY COMMIT_UNKNOWN (code 3, blocker 4): the apply's commit ack was lost. NOT a zero-write deferral; the caller
    // must NOT blind-rollback/retry (read-only reconciliation required). Surface it typed so the run exits nonzero.
    if (r && Number(r.code) === 3) return { ok: false, commitUnknown: true, reason: "control-apply COMMIT_UNKNOWN (code 3) -- read-only reconciliation required (NO rollback/retry)" };
    if (!r || r.committed !== true) return { ok: false, reason: "controls apply did not commit (code " + (r && r.code) + (r && r.problem ? "/" + r.problem : "") + ")" };
    const gen = Number(r.leaseGeneration);
    if (!(Number.isSafeInteger(gen) && gen > 0)) return { ok: false, reason: "controls apply returned no valid fencing generation (" + String(r.leaseGeneration) + ")" };
    leaseFence = { ownerToken: r.ownerToken || OPERATOR, generation: gen };
    return { ok: true };
  } catch (e) { return { ok: false, reason: "controls-apply-error:" + (e && e.message ? e.message : e) }; }
}
async function closeControls() {
  if (mode === "immediate") { leaseFence = null; return { ok: true }; } // the scheduler's safe-close owns the lease
  if (!leaseFence) return { ok: true };
  const fence = leaseFence;
  try {
    const r = await runControlPackageCli({ mode: "rollback", operator: OPERATOR, connectStore: connectPriorityControlStore, ownerToken: fence.ownerToken, ownerGeneration: fence.generation, operationKey: CONTROL_OP_KEY, log: (m) => console.log("oli-reconcile safe-close: " + m) });
    leaseFence = null;
    // SAFE-CLOSE COMMIT_UNKNOWN (code 3, blocker 4): the close commit ack was lost -> ONLY read-only reconciliation is
    // permitted here (no reclaim/rollback until a read establishes the state). Report control-cleanup-unresolved.
    if (r && Number(r.code) === 3) return { ok: false, commitUnknown: true, reason: "safe-close COMMIT_UNKNOWN (code 3) -- read-only reconciliation required" };
    // EVIDENCE-BASED (blocker 4): NEVER trust `committed` or a lease-not-owner skip as proof controls are closed. READ
    // the control-plane state and require it PROVEN closed (rollout/dispatch/promoted/approvals all closed).
    const state = await readControlPlaneClosed();
    if (state.read !== "ok") return { ok: false, reason: "control state UNREADABLE after safe-close (" + String(state.error) + ") -- cleanup unverified" };
    if (!state.closed) return { ok: false, reason: "controls NOT proven closed after safe-close " + JSON.stringify(state.detail) };
    return { ok: true };
  } catch (e) { leaseFence = null; return { ok: false, reason: "safe-close-error:" + (e && e.message ? e.message : e) }; }
}
const verifyLease = async () => {
  if (!leaseFence) return { ok: false, reason: "no-fence" };
  try { const r = await sb.renewControlPlaneLease({ ownerToken: leaseFence.ownerToken, generation: leaseFence.generation, ttlSeconds: 900 }); return { ok: !!(r && r.disposition === "renewed"), reason: r && (r.reason || r.disposition) }; }
  catch (e) { return { ok: false, reason: "renew-error:" + (e && e.message ? e.message : e) }; }
};

// SHARED-CATALOG COLD-CACHE LATCH (throughput / lease-strand fix): the Catalog carrier is org-scoped + date-independent,
// so once ANY account this pass proves it not adoptable (SOURCE_READINESS_PENDING), every remaining account WILL defer
// identically. Fast-defer them with the byte-identical typed outcome instead of paying a full per-account preflight +
// derive each -- which, across N accounts, crosses the cooperative deadline and strands the global lease so the other
// regions defer on CONTROL_LEASE_HELD. Reset per process (each workflow run is one region). See oli-catalog-cold-latch.js.
let sharedCatalogColdThisRun = false;

// PER-ACCOUNT release execution: each stale account derives + finalizes + publishes + reads back in ITS OWN dedicated
// priority-partial cycle (deterministic 16-hex over {accountId, revisionId}) with the no-export adapter + the captured
// fence. strictD1 keeps a lagged account on its LKG. The three OLI-dependent dashboards publish account-atomically.
async function runReleaseForAccount({ bucket: b, accountId, requestedAsOf, revisionId, signal }) {
  // TERMINATION BOUNDARY (defect 1): a deadline ABORT invalidates THIS op's control fence so no further publication
  // write can land. The runner calls verifyLease() immediately before each account publish, and the report_snapshots
  // CAS fences on the live control fence; once aborted, verifyLease returns not-owned AND getControlFence returns null,
  // so the publish STOPS at the contention gate (before publishAccount) or the CAS writes ZERO rows. An op aborted
  // before it starts does no work at all. The parent-owned module lease (leaseFence) is untouched -- only THIS op's
  // view of it is revoked -- so the safe-close still releases the exact fence.
  const aborted = () => !!(signal && signal.aborted);
  if (aborted()) return { code: 1, ok: false, stage: "reconcile", status: "DEADLINE_ABORTED", leaseLost: false, reason: "deadline-aborted", aborted: true, blockerCodes: [], problems: ["deadline-aborted before start (no work performed)"] };
  // FAST-DEFER: a peer account already proved the SHARED org Catalog carrier not adoptable this pass -> this account
  // would defer identically. Skip its full preflight+derive and return the byte-identical typed deferral (zero data
  // risk; keeps the pass inside the deadline so the lease safe-closes and the next region proceeds).
  if (sharedCatalogColdThisRun) {
    console.log("oli-reconcile: fast-defer " + String(accountId).slice(0, 8) + " (shared Catalog carrier cold this pass; a peer account already deferred SOURCE_READINESS_PENDING)");
    return buildCatalogColdFastDefer(b);
  }
  const cycleBucket = "priority-partial-" + b + "-" + sha256(JSON.stringify([accountId, revisionId || ""])).slice(0, 16);
  const fetchOne = async (apiKey) => ((await fetchDirectory(apiKey)) || []).filter((r) => String((r && (r.accountId ?? r.account_id ?? r.id)) || "").trim() === accountId);
  const release = buildPriorityDashboardsRelease({
    asOfOverride: requestedAsOf, operationKey: "priority-dashboards/scheduled/" + requestedAsOf,
    getCycleByBucketDate: sb.getBaseSyncCycleByBucketDate,
    getControlFence: () => (aborted() ? null : leaseFence), // aborted -> NO fence -> the write-boundary CAS writes zero rows
    makeInnerAdapter: makeNoExportInnerAdapter, fetchAccounts: fetchOne, cycleBucket,
  });
  const verifyLeaseForOp = async () => (aborted() ? { ok: false, reason: "deadline-aborted" } : verifyLease());
  const result = await runPriorityDashboardsRelease({ release, reconcile, readbackLive, assertNoCron, bucket: b, strictD1: true, verifyLease: verifyLeaseForOp, log: () => {} });
  // Preserve the runner's TYPED classification fields (status, leaseLost, stage, reason, blockerCodes) so the reconciler
  // classifies retryable-vs-integrity WITHOUT text matching (blocker 3).
  const mapped = { code: result.code, ok: result.ok, stage: result.stage, status: result.status || null, leaseLost: result.leaseLost === true, reason: result.reason || null, blockerCodes: result.blockerCodes || [], problems: result.problems || [] };
  // Latch the shared-Catalog cold-cache signal so the remaining accounts fast-defer (see the top-of-function guard).
  if (isSharedCatalogColdDefer(mapped)) sharedCatalogColdThisRun = true;
  return mapped;
}

// Brand View membership: the directory self-heals from the promoted bare brand-sales at read time
// (serveSelfHealingBrandDirectory). This callback NEVER claims a verified rebuild without readback evidence -- it
// reports self_heal_pending so the reconciler's status is honest.
async function rebuildBrandViewMembership({ accountIds }) {
  console.log("oli-reconcile: brand-sales promoted for " + accountIds.length + " account(s); Brand View directory self-heals from the now-current brand-sales on next serve.");
  return { ok: true, rebuilt: false, readbackVerified: false, mode: "self_heal_pending", accounts: accountIds };
}

async function bucketAccounts(b) {
  const rows = (await fetchDirectory(primaryConn.apiKey)) || [];
  const { active } = classifyDirectoryAccounts(rows, connections);
  const out = []; const seen = new Set();
  for (const a of active) {
    const id = String((a && (a.accountId ?? a.id)) || "").trim();
    const country = String((a && a.country) || "").toUpperCase();
    if (!id || id.includes(":") || seen.has(id)) continue;
    if (!accountInScope(b, country)) continue;
    seen.add(id); out.push({ accountId: id });
  }
  return out;
}

// COOPERATIVE DEADLINE (blocker 5): the periodic workflow hard-kills a region after a fixed cap; --deadline-seconds
// (set below that cap, reserving cleanup time) makes the reconciler stop publishing NEW accounts once elapsed, so the
// ALWAYS safe-close runs before the kill. A separate --cleanup invocation (below) handles an ABNORMAL termination.
const deadlineSec = Number(argOf("deadline-seconds")) || 0;
const runStartMs = Date.now();
const outOfTime = () => deadlineSec > 0 && (Date.now() - runStartMs) / 1000 > deadlineSec;
// Bound the IN-FLIGHT account operation: race the release against the remaining budget so a stuck account cannot hang
// past the reserve (it resolves the DEADLINE_HIT sentinel; the reconciler then ABORTS the op, AWAITS its confirmed
// settlement, and safe-closes). The `signal` arg is unused here (the reconciler owns the AbortController); it keeps the
// injected contract explicit. The timer is INTENTIONALLY REF'D (never unreferenced): it is a REQUIRED handle that must
// keep the Node event loop alive while the reconciler awaits the deadline -- an unreferenced timer that is the only
// pending handle lets Node exit (code 13, unsettled top-level await) before the deadline fires + cleanup runs. It is
// always clearTimeout'd once the op wins, and self-completes when it fires, so it never lingers.
const deadlineRace = (p, _signal) => {
  if (deadlineSec <= 0) return p;
  const remainingMs = Math.max(0, deadlineSec * 1000 - (Date.now() - runStartMs));
  let t; const timer = new Promise((resolve) => { t = setTimeout(() => resolve({ __deadline: true }), remainingMs); });
  return Promise.race([Promise.resolve(p).then((v) => { clearTimeout(t); return v; }), timer]);
};
// After a deadline abort, AWAIT the op's CONFIRMED settlement (defect 1), bounded by a short grace. A cooperative op
// settles promptly once its fence is revoked -> { settled:true } (a resolve OR a rejection both mean the op STOPPED). A
// non-cooperative op that will not stop within the grace -> { settled:false }; the reconciler then leaves the lease held
// + reports the run non-green (the separate cleanup job reclaims after TTL). Like the deadline timer, the grace timer is
// INTENTIONALLY REF'D (never unreferenced): it must keep the loop alive so the settled/unsettled decision (and the
// finally cleanup) is reached instead of Node exiting early on an otherwise-empty loop. It never resolves settled:true.
const SETTLE_GRACE_MS = 8000;
const awaitSettled = (p) => {
  let t; const grace = new Promise((resolve) => { t = setTimeout(() => resolve({ settled: false }), SETTLE_GRACE_MS); });
  return Promise.race([
    Promise.resolve(p).then(() => { clearTimeout(t); return { settled: true }; }, () => { clearTimeout(t); return { settled: true }; }),
    grace,
  ]);
};

const reconciler = buildOliPublicationReconciler({
  resolveOrg: async () => ({ organizationFingerprint: orgFp, connectionId: "primary" }),
  bucketAccounts,
  oliStart,
  readPositiveHistory: (args) => sb.getSourceOliHistoryRows(args),
  readZeroRowProof: (args) => sb.getSourceOliZeroRowProof(args),
  readLatestReportJob: ({ reportKey, accountId }) => sb.getLatestReportJobLineage(reportKey, accountId),
  readShadowSnapshot: (args) => sb.getReportSnapshot(args),
  readLiveSnapshot: (args) => sb.getReportSnapshot(args),
  loadStoragePayload: (path) => sb.getReportSnapshotStoragePayload(path),
  verifyLiveReadback: readbackLive, // the SHARED buildLiveReadback (publisher-grade live validation)
  liveContracts: SCHEDULER_LIVE_SNAPSHOT_CONTRACTS,
  computeHash: paramsHashFor,
  reportDerivations: REPORT_DERIVATIONS,
  runReleaseForAccount,
  rebuildBrandViewMembership,
  openControls: dryRun ? (async () => ({ ok: true })) : openControls,
  closeControls: dryRun ? (async () => ({ ok: true })) : closeControls,
  outOfTime, deadlineRace,
  makeAbortController: () => new AbortController(), awaitSettled,
  reportKeys: oliDependentLiveReportKeys(),
  withTimeout,
  log: (m) => console.log("oli-reconcile: " + m),
});

// ABNORMAL-TERMINATION CLEANUP (blockers 4/5): a distinct invocation the periodic cleanup JOB runs (always(), needs:
// reconcile) to prove the priority control plane is closed after a killed/timed-out reconcile. EVIDENCE-BASED protocol:
//   1. INSPECT (read-only) -- already proven closed? -> cleaned, exit 0 (never touch a plane, never reclaim needlessly).
//   2. Otherwise attempt the reviewed RECLAIM (acquire ONLY a free/EXPIRED lease -> safe-close). A LIVE/unexpired owner
//      BLOCKS reclaim (zero writes) -- the plane is left UNTOUCHED.
//   3. RE-INSPECT (read-only) + require PROVEN closed. A live owner (still open) or a COMMIT_UNKNOWN -> UNVERIFIED,
//      non-green -- never reported as "cleaned".
if (process.argv.includes("--cleanup")) {
  const before = await readControlPlaneClosed();
  if (before.read === "ok" && before.closed === true) { console.log("RESULT " + JSON.stringify({ mode: "cleanup", bucket, requestedAsOf: asOf, cleaned: true, disposition: "already-closed" })); process.exit(0); }
  let reclaim = null;
  try { reclaim = await runControlPackageCli({ mode: "reclaim", operator: OPERATOR, connectStore: connectPriorityControlStore, ownerToken: OPERATOR, operationKey: CONTROL_OP_KEY, log: (m) => console.log("oli-reconcile cleanup: " + m) }); }
  catch (e) { reclaim = { committed: false, code: 1, error: e && e.message ? e.message : String(e) }; } // CONTROL_LEASE_HELD (a live/unexpired owner) -> untouched
  if (reclaim && Number(reclaim.code) === 3) { console.error("STOP OLI_RECONCILE_CLEANUP_COMMIT_UNKNOWN -- read-only reconciliation required; controls NOT proven closed."); process.exit(1); }
  const after = await readControlPlaneClosed();
  const cleaned = after.read === "ok" && after.closed === true;
  console.log("RESULT " + JSON.stringify({ mode: "cleanup", bucket, requestedAsOf: asOf, cleaned, reclaim: reclaim && (reclaim.skipped || (reclaim.committed ? "committed" : "refused-or-held")), before: before.detail || before.read, after: after.detail || after.read }));
  if (!cleaned) console.error("STOP OLI_RECONCILE_CLEANUP_UNVERIFIED: controls NOT proven closed (a live owner is left untouched; retry after the lease expires).");
  process.exit(cleaned ? 0 : 1);
}

if (!dryRun) {
  const cron = await assertNoCron();
  if (!cron.ok) { console.error("STOP OLI_RECONCILE: " + cron.reason + " -- fail closed."); process.exit(1); }
}

// DR1/DR4 self-heal PRE-PASS (LIVE only): reclaim stale-failed, no-real-export priority-partial Catalog jobs left
// TERMINAL by a PRE-DR1 cold-cache pass, so THIS pass can ADOPT them from the validated durable snapshot and converge
// with ZERO exports instead of fast-deferring forever on a stuck failed job. The RPC is snapshot-gated and scoped to the
// reconciler's OWN `priority-partial-<bucket>-%` cycle namespace (scheduled cycles are never touched); it is a no-op (0)
// on a clean bucket and IDEMPOTENT. Fail-soft: any error (e.g. the RPC not yet deployed under expand-first rollout) just
// logs and proceeds -- a stuck job simply defers as before. Reversible kill-switch: DURABLE_CATALOG_ADOPTION=off.
if (!dryRun && String(process.env.DURABLE_CATALOG_ADOPTION || "on").toLowerCase() !== "off") {
  try {
    const reclaimed = await sb.reclaimStalePriorityCatalogJobs(bucket);
    if (reclaimed > 0) console.log(`oli-reconcile: reclaimed ${reclaimed} stale-failed priority-partial Catalog job(s) for re-adoption from the durable snapshot (zero exports).`);
  } catch (e) { console.log("oli-reconcile: catalog reclaim pre-pass skipped (" + (e && e.message ? e.message : e) + ") -- proceeding; a stuck job simply defers as before."); }
}

const out = await reconciler.run({ bucket, requestedAsOf: asOf, accountIds: accountsArg.length ? accountsArg : null, mode, dryRun });

ghOut("outcome", out.outcome || "unknown");
ghOut("published_count", String(out.counts ? out.counts.targetsPublished : 0));
ghOut("failed_count", String(out.counts ? out.counts.targetsFailed : 0));
console.log("RESULT " + JSON.stringify({
  ok: out.ok, outcome: out.outcome, code: out.code || "OK", bucket, requestedAsOf: asOf, mode, dryRun,
  dataDoeCreates: 0, dataDoeTokens: 0,
  accountsExamined: out.accountsExamined || 0, brandView: out.brandView || null,
  counts: out.counts || null,
}));
// HONEST EXIT (blocker 5): nonzero when unresolved HARD failures remain (out.ok===false). A partial pass with only
// deferrals (LKG preserved) is ok:true/exit 0 -- honest, retried next cycle.
process.exit(out.ok === false ? 1 : 0);
