// TRUSTED, DEFERRED operator entrypoint for the ZERO-EXPORT Campaign-Ads publication reconciler.
// Usage (run from sales-dashboard-live/):
//   IMMEDIATE (right after the scheduler's Ads persistence, while full_controls still owns the lease):
//     node scripts/release/ads-publication-reconcile.mjs --bucket=<region> --as-of=YYYY-MM-DD --mode=immediate \
//       --accounts=A,B --live --run-token=<full_controls owner token> --owner-generation=<full_controls generation>
//   PERIODIC (30-min backstop, after safe-close):
//     node scripts/release/ads-publication-reconcile.mjs --bucket=<region> --as-of=YYYY-MM-DD --mode=periodic [--live]
//
// It re-derives + promotes the Ads-dependent canonical live dashboards for accounts whose durable Campaign Ads content
// advanced past (or was same-date corrected relative to) their live snapshots, using ALREADY-SAVED durable Ads rows. It
// NEVER creates a DataDoe export, reserves a token, refreshes a source, or supersedes the daily Ads export -- the
// derive's inner adapter is FORCED to refuse creates. DEFAULT is DRY-RUN (read-only plan; zero writes); LIVE promotion
// requires --live (the workflow sets --live only when the repository variable ADS_RECONCILE_LIVE == 'true').
//
// REPORT-SPECIFIC (Codex blocker 5): SEPARATE single-report reconciler operations. THIS increment ships the
// daily-reporting operation, which re-derives daily-reporting from the FULL durable union (OLI + Product Catalog +
// Campaign Ads) through the SAME reviewed priority release + fenced publisher + content-CAS the OLI reconciler uses --
// so an Ads-triggered daily reconcile is byte-identical to an OLI-triggered one, records the complete OLI/Catalog
// lineage union, and the fenced source_refreshed_at CAS makes concurrent OLI/Ads reconciliation converge on the newest
// valid content (an older derive is a no-op). daily-reporting depends on the CAMPAIGN grain only.
//
// ppc-performance is DELIBERATELY NOT reconciled here (scope decision 2026-09-12). Although ads-dependent-reports.js
// registers it as Ads-dependent (campaign + targeting + search-terms) so its revision isolation is modelled + tested,
// the ppc-performance report is SUPERSEDED (report-materialization-registry.js: "no live publisher -- superseded by the
// Campaign Ads workspace view"); its snapshot is produced only on a MANUAL user refresh, and adding a scheduled
// publisher would contravene that product decision. This entrypoint therefore reconciles ONLY daily-reporting. The
// shared wrapper (buildAdsReportReconciler) still supports a ppc operation (exercised by the behavior test's isolation
// cases), so it can be wired later IF ppc-performance is intentionally un-superseded -- it is NOT wired today. It shares
// the reviewed priority-partial namespace + control-package (immediate RENEWS the scheduler fence; periodic apply/safe-close). A
// Campaign Ads failure NEVER suppresses valid OLI sales: an unavailable Ads grain defers ONLY this Ads operation for
// that account, and daily's re-derive still publishes OLI sales from the durable union. 7-bit ASCII, LF.

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

if (!isRegionScope(bucket)) { console.error("STOP ADS_RECONCILE_REGION_UNSUPPORTED: --bucket must be india|europe-au|us-ca (region-scoped); got " + bucket); process.exit(2); }
if (!DATE_RE.test(String(asOf))) { console.error("STOP ADS_RECONCILE_AS_OF: --as-of=YYYY-MM-DD is required; got " + asOf); process.exit(2); }
if (mode === "immediate" && accountsArg.length === 0) { console.error("STOP ADS_RECONCILE_IMMEDIATE: --mode=immediate requires --accounts=A,B (the accounts whose Ads just saved)."); process.exit(2); }
if (live && mode === "immediate" && !(runToken && Number.isSafeInteger(ownerGeneration) && ownerGeneration > 0)) {
  console.error("STOP ADS_RECONCILE_IMMEDIATE_FENCE: live immediate mode REQUIRES --run-token + --owner-generation (the scheduler's full_controls fence; the reconciler renews it, never re-acquires).");
  process.exit(2);
}
console.log(`ads-reconcile: bucket=${bucket} as-of=${asOf} mode=${mode} ${dryRun ? "DRY-RUN (read-only; zero writes)" : "LIVE"} accounts=${accountsArg.length || "region"}`);

const { buildAdsReportReconciler } = await import("../../lib/server/sync/ads-publication-reconciler.js");
const { sha256, organizationFingerprint } = await import("../../lib/server/source-identity.js");
const { getDataDoeConnections, classifyDirectoryAccounts, resolveDataDoeAccountIds } = await import("../../lib/server/datadoe-connections.js");
const { adsWorkerKeyForGrain } = await import("../../lib/server/sync/ads-dependent-reports.js");
const { fetchAccounts: fetchDirectory } = await import("../../lib/server/datadoe.js");
const { SCHEDULER_LIVE_SNAPSHOT_CONTRACTS } = await import("../../lib/server/sync/report-publisher.js");
const { REPORT_DERIVATIONS } = await import("../../lib/server/sync/report-derivation.js");
const { paramsHashFor } = await import("../../lib/server/report-store.js");
// DEDICATED daily-reporting-ONLY release (replaces the priority TRIO release, which derived+published daily-reporting
// AND brand-sales AND brand-inventory -- a P0 scope leak). The Ads reconciler now re-derives/saves/publishes/reads-back
// EXACTLY scheduler-v2/daily-reporting; Brand Sales + Brand Inventory get zero writes.
const { buildDailyReportingRelease } = await import("../../lib/server/sync/daily-reporting-release.js");
const { buildSchedulerV2Publisher } = await import("../../lib/server/sync/publisher-composition.js");
const { buildLiveReadback } = await import("../../lib/server/sync/source-priority-release-runner.js");
const { readPartialCycleCapability } = await import("../../lib/server/sync/priority-partial-capability.js");
const { runControlPackageCli } = await import("../../lib/server/sync/source-priority-control-package.js");
const { connectPriorityControlStore } = await import("../../lib/server/sync/priority-control-pg-store.js");
const { CONTROLLED_REPORT_KEYS } = await import("../../lib/server/sync/report-controls.js");
const sb = await import("../../lib/server/supabase.js");

// READ-ONLY control-plane state reconciliation (EVIDENCE-BASED): PROVE the priority publication controls are closed
// from the actual rows, never from a rollback disposition or a lease-not-owner skip. { read, closed, detail }.
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

const connections = getDataDoeConnections() || [];
const primaryConn = connections.find((c) => c.id === "primary");
if (!primaryConn) { console.error("STOP ADS_RECONCILE_NO_PRIMARY_CONNECTION -- fail closed."); process.exit(1); }
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

// STRUCTURAL ZERO EXPORT: the dedicated daily-reporting release (daily-reporting-release.js) reads ONLY durable data
// (source_oli_history + source_snapshots(catalog) + durable Campaign Ads rows/coverage + report_snapshots) and writes
// ONLY the fenced daily-reporting report_snapshots CAS. It takes NO provider export adapter and the whole reconcile path
// imports NO provider export transport, so there is no create / poll / download to reach; zero provider export is
// STRUCTURAL, not a throwing-adapter guard. (The entrypoint guard test asserts this by source-scanning both this file
// and the dedicated release module for transport symbols.)

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

let leaseFence = null;
const OPERATOR = "ads-reconcile:" + bucket + ":" + (runToken || asOf);
const CONTROL_OP_KEY = "ads-reconcile/" + bucket + "/" + asOf;

async function partialNamespacePermitted() {
  const probe = new pg.Client({ connectionString: pgBase, ssl: { rejectUnauthorized: false } });
  try { await probe.connect(); return await readPartialCycleCapability((sql) => probe.query(sql).then((r) => r.rows)); }
  catch (e) { return { permitted: false, reason: "capability-unreadable: " + (e && e.message ? e.message : e) }; }
  finally { try { await probe.end(); } catch { /* ignore */ } }
}

// CONTROLS: both modes require the priority-partial namespace + a fence. Immediate RENEWS the scheduler's exact fence
// (no apply, no safe-close). Periodic runs the reviewed control-package apply/safe-close. Identical to the OLI/FBA
// reconcilers (the GLOBAL control-plane lease serializes this against them).
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
  if (!staleAccountIds || staleAccountIds.length === 0) return { ok: false, reason: "no-stale-accounts" };
  try {
    const r = await runControlPackageCli({
      mode: "apply", operator: OPERATOR,
      discoverAccounts: async () => [...staleAccountIds],
      connectStore: connectPriorityControlStore,
      ownerToken: OPERATOR, operationKey: CONTROL_OP_KEY, leaseTtlSeconds: 900,
      log: (m) => console.log("ads-reconcile controls: " + m),
    });
    if (r && Number(r.code) === 3) return { ok: false, commitUnknown: true, reason: "control-apply COMMIT_UNKNOWN (code 3) -- read-only reconciliation required (NO rollback/retry)" };
    if (!r || r.committed !== true) return { ok: false, reason: "controls apply did not commit (code " + (r && r.code) + (r && r.problem ? "/" + r.problem : "") + ")" };
    const gen = Number(r.leaseGeneration);
    if (!(Number.isSafeInteger(gen) && gen > 0)) return { ok: false, reason: "controls apply returned no valid fencing generation (" + String(r.leaseGeneration) + ")" };
    leaseFence = { ownerToken: r.ownerToken || OPERATOR, generation: gen };
    return { ok: true };
  } catch (e) { return { ok: false, reason: "controls-apply-error:" + (e && e.message ? e.message : e) }; }
}
async function closeControls() {
  if (mode === "immediate") { leaseFence = null; return { ok: true }; }
  if (!leaseFence) return { ok: true };
  const fence = leaseFence;
  try {
    const r = await runControlPackageCli({ mode: "rollback", operator: OPERATOR, connectStore: connectPriorityControlStore, ownerToken: fence.ownerToken, ownerGeneration: fence.generation, operationKey: CONTROL_OP_KEY, log: (m) => console.log("ads-reconcile safe-close: " + m) });
    leaseFence = null;
    if (r && Number(r.code) === 3) return { ok: false, commitUnknown: true, reason: "safe-close COMMIT_UNKNOWN (code 3) -- read-only reconciliation required" };
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

// PER-ACCOUNT release: the DEDICATED daily-reporting-ONLY release (daily-reporting-release.js) re-derives + publishes
// EXACTLY scheduler-v2/daily-reporting for this account over its own priority-partial cycle -- NEVER brand-sales or
// brand-inventory. It reproduces the hot path's daily derive byte-for-byte (durable OLI + Catalog + Campaign Ads, the
// same enrichment + the ONE canonical REPORT_DERIVATIONS["daily-reporting"].derive), binds the SAME OLI/Catalog
// depends_on + the Campaign Ads content token, and publishes through the reviewed FENCED publisher + canonical readback.
// The publisher is fenced on THIS op's control fence (aborted -> null fence -> the CAS writes zero rows); verifyLease
// heartbeats before publish. Concurrency with the OLI reconciler is safe: the fenced content-CAS (source_refreshed_at)
// makes an older source combination a no-op, and daily's lineage is byte-identical so the OLI reconciler still sees it
// covered. Zero provider export, STRUCTURALLY (the release imports no export transport).
async function runReleaseForAccount({ bucket: b, accountId, requestedAsOf, revisionId, signal }) {
  const aborted = () => !!(signal && signal.aborted);
  if (aborted()) return { code: 1, ok: false, stage: "reconcile", status: "DEADLINE_ABORTED", leaseLost: false, reason: "deadline-aborted", aborted: true, blockerCodes: [], problems: ["deadline-aborted before start (no work performed)"] };
  const cycleBucket = "priority-partial-" + b + "-" + sha256(JSON.stringify([accountId, revisionId || ""])).slice(0, 16);
  const publisher = buildSchedulerV2Publisher({ getControlFence: () => (aborted() ? null : leaseFence) });
  const verifyLeaseForOp = async () => (aborted() ? { ok: false, reason: "deadline-aborted" } : verifyLease());
  const release = buildDailyReportingRelease({
    resolveOrg: async () => ({ organizationFingerprint: orgFp, connectionId: "primary" }),
    resolveAccountMeta,
    // Every supported durable collaborator forwards the release's { signal } (2nd arg) to the Supabase transport, so an
    // observed abort stops any in-flight read/write; the release rechecks abort after each phase + before each write.
    openCycle: (args, opt) => sb.openSyncCycle(args, opt),
    getCycleByBucketDate: (bk, date, opt) => sb.getBaseSyncCycleByBucketDate(bk, date, opt),
    finalizeCycle: ({ cycleId }, opt) => sb.finalizeSyncCycle(cycleId, opt),
    readOliHistory: (args) => sb.getSourceOliHistoryRows(args),
    readOliCoverage: (args) => sb.getSourceCoverageWindows(args),
    readOliZeroProof: (args) => sb.getSourceOliZeroRowProof(args),
    readCatalogSnapshot: (args) => sb.getSourceSnapshot(args),
    loadCatalogPayload: (path, opt) => sb.getSourceSnapshotPayload(path, opt),
    readActiveAdsRows: (a, from, to, opt) => sb.getActiveAdsDailyRows(a, from, to, opt),
    readAdsCoverage: (a, workerKey, opt) => sb.getDailyAdsCoverage(a, workerKey, opt),
    upsertReportJob: (job, opt) => sb.upsertSyncReportJob(job, opt),
    claimLease: (cycleId, reportKey, a, opts) => sb.claimReportDeriveLease(cycleId, reportKey, a, opts),
    saveShadow: (args, opt) => sb.saveShadowSnapshotIfNewer(args, opt),
    reconcileSuccess: (args, opt) => sb.reconcileReportDeriveSuccess(args, opt),
    computeHash: paramsHashFor,
    liveContracts: SCHEDULER_LIVE_SNAPSHOT_CONTRACTS,
    reportDerivations: REPORT_DERIVATIONS,
    publisher, readbackLive, verifyLease: verifyLeaseForOp,
    log: () => {},
  });
  const result = await release.runForAccount({ accountId, requestedAsOf, cycleBucket, signal });
  return { code: result.code, ok: result.ok, stage: result.stage, status: result.status || null, leaseLost: result.leaseLost === true, reason: result.reason || null, blockerCodes: result.blockerCodes || [], problems: result.problems || [] };
}

async function bucketAccounts(b) {
  const rows = (await fetchDirectory(primaryConn.apiKey)) || [];
  const { active } = classifyDirectoryAccounts(rows, connections);
  const out = []; const seen = new Set();
  for (const a of active) {
    const id = String((a && (a.accountId ?? a.id)) || "").trim();
    const country = String((a && a.country) || "").toUpperCase();
    if (!id || id.includes(":") || seen.has(id) || !accountInScope(b, country)) continue;
    seen.add(id); out.push({ accountId: id });
  }
  return out;
}

// Durable per-account, per-grain Ads coverage + content_rev reader (getDailyAdsCoverage). The reconciler passes the
// REGISTRY grain key (ads-campaign-date | ads-targeting-date | ads-search-terms-date); ads_sync_coverage/ads_sync_state
// are keyed by the DURABLE WORKER key (campaign-performance-v1, ...), so translate registry->worker for the READ ONLY
// (adsWorkerKeyForGrain, fail-closed). The revision's content-provenance token stays REGISTRY-keyed (grains[sourceKey]),
// so it matches the hot-derive binding's token; reading under the registry key would filter to zero rows -> every
// account defers -> a green no-op that never reconciles. Marketplace resolves from the authoritative primary directory.
const readAdsCoverageState = ({ accountId, sourceKey }) => sb.getDailyAdsCoverage(accountId, adsWorkerKeyForGrain(sourceKey));
// Directory metadata (accountId -> { country, rawSellerId, currency }) for the region, from the authoritative primary
// directory (read-only accounts GET, never an export). country -> the reconciler's marketplace + the Ads content token;
// rawSellerId + currency -> the dedicated release's daily derive (slicedOliSourceFromHistory + the daily context, so the
// payload is byte-identical to the scheduler's). dd-secondary/colon-prefixed ids + accounts without a country excluded.
let directoryMeta = null;
async function loadDirectoryMeta() {
  if (directoryMeta) return directoryMeta;
  const rows = (await fetchDirectory(primaryConn.apiKey)) || [];
  const { active } = classifyDirectoryAccounts(rows, connections);
  directoryMeta = new Map();
  for (const a of active) {
    const id = String((a && (a.accountId ?? a.id)) || "").trim();
    const country = String((a && a.country) || "").trim().toUpperCase();
    if (!id || id.includes(":") || !country) continue;
    let rawSellerId = "";
    try { const res = resolveDataDoeAccountIds([id], connections); rawSellerId = res && res.rawAccountIds && res.rawAccountIds.length === 1 ? String(res.rawAccountIds[0]) : ""; } catch { rawSellerId = ""; }
    // currency normalized EXACTLY as the hot path's bindPrimaryBucketAccounts (source-bucket-sync-runtime.js): a blank
    // currency becomes null (never ""), so the dedicated release's daily context.currency is byte-identical.
    directoryMeta.set(id, { country, rawSellerId, currency: String((a && a.currency) || "") || null });
  }
  return directoryMeta;
}
async function resolveMarketplace(accountId) { const m = (await loadDirectoryMeta()).get(String(accountId)); return m ? m.country : ""; }
// The dedicated release's per-account identity: rawSellerId (OLI history slice + derive context), currency (derive
// context), marketplace (the Ads content token). Blank rawSellerId -> the release defers (never derives a bad slice).
async function resolveAccountMeta(accountId) {
  const m = (await loadDirectoryMeta()).get(String(accountId));
  return m ? { rawSellerId: m.rawSellerId, currency: m.currency ?? null, marketplace: m.country } : { rawSellerId: "", currency: null, marketplace: "" };
}

const deadlineSec = Number(argOf("deadline-seconds")) || 0;
const runStartMs = Date.now();
const outOfTime = () => deadlineSec > 0 && (Date.now() - runStartMs) / 1000 > deadlineSec;
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

// The daily-reporting Ads reconciliation operation (report-specific, blocker 5). ppc-performance is DELIBERATELY NOT
// wired (superseded -- see the header); the shared collaborators below would be identical for it if ever un-superseded.
function buildOperation(reportKey, runRelease) {
  return buildAdsReportReconciler({
    reportKey,
    resolveOrg: async () => ({ organizationFingerprint: orgFp, connectionId: "primary" }),
    bucketAccounts,
    readAdsCoverageState,
    resolveMarketplace,
    readLatestReportJob: ({ reportKey: rk, accountId }) => sb.getLatestReportJobLineage(rk, accountId),
    readShadowSnapshot: (args) => sb.getReportSnapshot(args),
    readLiveSnapshot: (args) => sb.getReportSnapshot(args),
    loadStoragePayload: (path) => sb.getReportSnapshotStoragePayload(path),
    verifyLiveReadback: readbackLive,
    liveContracts: SCHEDULER_LIVE_SNAPSHOT_CONTRACTS,
    computeHash: paramsHashFor,
    reportDerivations: REPORT_DERIVATIONS,
    runReleaseForAccount: runRelease,
    openControls: dryRun ? (async () => ({ ok: true })) : openControls,
    closeControls: dryRun ? (async () => ({ ok: true })) : closeControls,
    outOfTime, deadlineRace,
    makeAbortController: () => new AbortController(), awaitSettled,
    withTimeout,
    log: (m) => console.log("ads-reconcile[" + reportKey + "]: " + m),
  });
}

// ABNORMAL-TERMINATION CLEANUP: a distinct invocation the periodic cleanup JOB runs (always(), needs: reconcile) to
// prove the priority control plane is closed after a killed/timed-out reconcile. EVIDENCE-BASED reclaim.
if (process.argv.includes("--cleanup")) {
  const before = await readControlPlaneClosed();
  if (before.read === "ok" && before.closed === true) { console.log("RESULT " + JSON.stringify({ mode: "cleanup", bucket, requestedAsOf: asOf, cleaned: true, disposition: "already-closed" })); process.exit(0); }
  let reclaim = null;
  try { reclaim = await runControlPackageCli({ mode: "reclaim", operator: OPERATOR, connectStore: connectPriorityControlStore, ownerToken: OPERATOR, operationKey: CONTROL_OP_KEY, log: (m) => console.log("ads-reconcile cleanup: " + m) }); }
  catch (e) { reclaim = { committed: false, code: 1, error: e && e.message ? e.message : String(e) }; }
  if (reclaim && Number(reclaim.code) === 3) { console.error("STOP ADS_RECONCILE_CLEANUP_COMMIT_UNKNOWN -- read-only reconciliation required; controls NOT proven closed."); process.exit(1); }
  const after = await readControlPlaneClosed();
  const cleaned = after.read === "ok" && after.closed === true;
  console.log("RESULT " + JSON.stringify({ mode: "cleanup", bucket, requestedAsOf: asOf, cleaned, reclaim: reclaim && (reclaim.skipped || (reclaim.committed ? "committed" : "refused-or-held")), before: before.detail || before.read, after: after.detail || after.read }));
  if (!cleaned) console.error("STOP ADS_RECONCILE_CLEANUP_UNVERIFIED: controls NOT proven closed (a live owner is left untouched; retry after the lease expires).");
  process.exit(cleaned ? 0 : 1);
}

if (!dryRun) {
  const cron = await assertNoCron();
  if (!cron.ok) { console.error("STOP ADS_RECONCILE: " + cron.reason + " -- fail closed."); process.exit(1); }
}

// Run the daily-reporting operation ONLY. (ppc-performance is intentionally NOT reconciled -- superseded; see header.)
const daily = buildOperation("daily-reporting", runReleaseForAccount);
const out = await daily.run({ bucket, requestedAsOf: asOf, accountIds: accountsArg.length ? accountsArg : null, mode, dryRun });

ghOut("outcome", out.outcome || "unknown");
ghOut("published_count", String(out.counts ? out.counts.targetsPublished : 0));
ghOut("failed_count", String(out.counts ? out.counts.targetsFailed : 0));
console.log("RESULT " + JSON.stringify({
  ok: out.ok, outcome: out.outcome, code: out.code || "OK", bucket, requestedAsOf: asOf, mode, dryRun, operation: "daily-reporting",
  dataDoeCreates: 0, dataDoeTokens: 0,
  accountsExamined: out.accountsExamined || 0,
  counts: out.counts || null,
}));
process.exit(out.ok === false ? 1 : 0);
