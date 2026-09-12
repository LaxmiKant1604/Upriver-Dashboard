// TRUSTED, DEFERRED operator entrypoint for the ZERO-EXPORT listing-health-v3 publication reconciler.
// Usage (run from sales-dashboard-live/):
//   IMMEDIATE (right after this region's Listing Health v3 shadow ingestion, while the run's lease still owns):
//     node scripts/release/listing-health-v3-reconcile.mjs --bucket=<region> --as-of=YYYY-MM-DD --mode=immediate \
//       --accounts=A,B --live --run-token=<owner token> --owner-generation=<generation>
//   PERIODIC (30-min backstop, and the scheduler's self-owned-lease immediate hook):
//     node scripts/release/listing-health-v3-reconcile.mjs --bucket=<region> --as-of=YYYY-MM-DD --mode=periodic [--live]
//
// It re-derives + promotes the Listings-dependent canonical live dashboard(s) -- today EXACTLY "listing-health-v3" --
// for accounts whose durable Listings + Listings-Raw snapshots (source_listings_snapshot / source_listings_raw_snapshot)
// advanced past (or were never promoted to) their live snapshot, using ALREADY-SAVED durable Listings/Listings-Raw plus
// durable OLI + Product Catalog + reuse-only durable FBA inventory. It NEVER creates a DataDoe export, reserves a token,
// refreshes a source, or supersedes any export -- the release reads only durable data (zero export, structurally).
// DEFAULT is DRY-RUN (read-only plan; zero writes); LIVE promotion requires --live (the workflow sets --live only when
// the repository variable LISTINGS_RECONCILE_LIVE == 'true').
//
// It shares the SAME reviewed execution seam as the OLI + FBA reconcilers: the priority-partial-<region>-<16hex> cycle
// namespace (deterministic over {accountId, Listings revisionId}, permitted by migration 20260924), the control-package
// apply/publish/safe-close, the DEDICATED listing-health-v3-ONLY release (which re-derives EXACTLY listing-health-v3
// from the HYDRATED durable Listings/Raw rows + durable OLI/Catalog + reuse-only FBA inventory -- NEVER any sibling
// report), and the shared publisher-grade live read-back. The GLOBAL control-plane lease serializes this against the
// OLI + FBA reconcilers + the scheduler, and the publisher's content CAS makes a redundant re-publish an idempotent
// no-op. 7-bit ASCII, LF.

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

if (!isRegionScope(bucket)) { console.error("STOP LISTINGS_RECONCILE_REGION_UNSUPPORTED: --bucket must be india|europe-au|us-ca (region-scoped); got " + bucket); process.exit(2); }
if (!DATE_RE.test(String(asOf))) { console.error("STOP LISTINGS_RECONCILE_AS_OF: --as-of=YYYY-MM-DD is required; got " + asOf); process.exit(2); }
if (mode === "immediate" && accountsArg.length === 0) { console.error("STOP LISTINGS_RECONCILE_IMMEDIATE: --mode=immediate requires --accounts=A,B (the accounts whose Listings/Raw just saved)."); process.exit(2); }
if (live && mode === "immediate" && !(runToken && Number.isSafeInteger(ownerGeneration) && ownerGeneration > 0)) {
  console.error("STOP LISTINGS_RECONCILE_IMMEDIATE_FENCE: live immediate mode REQUIRES --run-token + --owner-generation (the scheduler's fence; the reconciler renews it, never re-acquires).");
  process.exit(2);
}
console.log(`listing-health-v3-reconcile: bucket=${bucket} as-of=${asOf} mode=${mode} ${dryRun ? "DRY-RUN (read-only; zero writes)" : "LIVE"} accounts=${accountsArg.length || "region"}`);

const { buildListingHealthV3PublicationReconciler } = await import("../../lib/server/sync/listing-health-v3-reconciler.js");
const { listingsDependentLiveReportKeys } = await import("../../lib/server/sync/listing-health-v3-dependent-reports.js");
const { FBA_INVENTORY_SOURCE_KEY } = await import("../../lib/server/sync/source-durable-model.js");
const { resolvedFbaSnapshot } = await import("../../lib/server/sync/source-bucket-sync.js");
const { organizationFingerprint, sha256 } = await import("../../lib/server/source-identity.js");
const { getDataDoeConnections, classifyDirectoryAccounts, resolveDataDoeAccountIds } = await import("../../lib/server/datadoe-connections.js");
const { fetchAccounts: fetchDirectory } = await import("../../lib/server/datadoe.js");
const { SCHEDULER_LIVE_SNAPSHOT_CONTRACTS } = await import("../../lib/server/sync/report-publisher.js");
const { REPORT_DERIVATIONS, deriveReportSnapshot } = await import("../../lib/server/sync/report-derivation.js");
const { paramsHashFor } = await import("../../lib/server/report-store.js");
const { buildListingHealthV3Release } = await import("../../lib/server/sync/listing-health-v3-release.js");
const { makeListingHealthV3DurableContextLoader } = await import("../../lib/server/sync/listing-health-v3-durable-loader.js");
const { buildSchedulerV2Publisher } = await import("../../lib/server/sync/publisher-composition.js");
const { buildLiveReadback } = await import("../../lib/server/sync/source-priority-release-runner.js");
const { readPartialCycleCapability } = await import("../../lib/server/sync/priority-partial-capability.js");
const { runControlPackageCli, buildListingHealthV3ControlPackage } = await import("../../lib/server/sync/source-priority-control-package.js");
const { connectPriorityControlStore } = await import("../../lib/server/sync/priority-control-pg-store.js");
const { CONTROLLED_REPORT_KEYS } = await import("../../lib/server/sync/report-controls.js");
const sb = await import("../../lib/server/supabase.js");

// READ-ONLY control-plane state reconciliation (EVIDENCE-BASED closure): PROVE the priority publication controls are
// closed from the actual rows, never from a rollback disposition or a lease-not-owner skip. { read, closed, detail }.
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
if (!primaryConn) { console.error("STOP LISTINGS_RECONCILE_NO_PRIMARY_CONNECTION -- fail closed."); process.exit(1); }
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

// STRUCTURAL ZERO EXPORT: the dedicated listing-health-v3 release (listing-health-v3-release.js) reads ONLY durable
// data (source_listings_snapshot + source_listings_raw_snapshot + source_snapshots + source_oli_daily_history +
// report_snapshots) + writes ONLY the fenced report_snapshots CAS. It takes NO provider export adapter and the whole
// reconcile path imports NO provider export transport, so there is no create / poll / download to reach.

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
const OPERATOR = "listing-health-v3-reconcile:" + bucket + ":" + (runToken || asOf);
const CONTROL_OP_KEY = "listing-health-v3-reconcile/" + bucket + "/" + asOf;

async function partialNamespacePermitted() {
  const probe = new pg.Client({ connectionString: pgBase, ssl: { rejectUnauthorized: false } });
  try { await probe.connect(); const cap = await readPartialCycleCapability((sql) => probe.query(sql).then((r) => r.rows)); return cap; }
  catch (e) { return { permitted: false, reason: "capability-unreadable: " + (e && e.message ? e.message : e) }; }
  finally { try { await probe.end(); } catch { /* ignore */ } }
}

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
      // The DEDICATED listing-health-v3 control package: enables EXACTLY the listing-health-v3 promoted publish control
      // + per-account approvals + rollout for the stale accounts, with every controlled dispatch paused (it is
      // source-promoted, not dispatched). The default buildPriorityControlPackage would enable brand-inventory's
      // promoted control instead, so publisher GATE 2/4 for listing-health-v3 would fail-closed (report-disabled /
      // publish-not-approved) and every promotion would hardFail; this package opens exactly the gates this reconciler
      // publishes through. The global safe-close (--rollback) still disables every promoted control incl. this one.
      buildApplyPackage: buildListingHealthV3ControlPackage,
      ownerToken: OPERATOR, operationKey: CONTROL_OP_KEY, leaseTtlSeconds: 900,
      log: (m) => console.log("listing-health-v3-reconcile controls: " + m),
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
    const r = await runControlPackageCli({ mode: "rollback", operator: OPERATOR, connectStore: connectPriorityControlStore, ownerToken: fence.ownerToken, ownerGeneration: fence.generation, operationKey: CONTROL_OP_KEY, log: (m) => console.log("listing-health-v3-reconcile safe-close: " + m) });
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

// Directory metadata (accountId -> { rawSellerId, country }) for the region, resolved from the authoritative primary
// directory (read-only accounts GET, never an export). Used for the fragment owner id + the FBA-inventory D-1
// request-hash recompute. dd-secondary/colon-prefixed ids + accounts without a marketplace country are excluded.
let directoryMeta = null;
async function loadDirectoryMeta() {
  if (directoryMeta) return directoryMeta;
  const rows = (await fetchDirectory(primaryConn.apiKey)) || [];
  const { active } = classifyDirectoryAccounts(rows, connections);
  directoryMeta = new Map();
  for (const a of active) {
    const id = String((a && (a.accountId ?? a.id)) || "").trim();
    const country = String((a && a.country) || "").trim();
    if (!id || id.includes(":") || !country) continue;
    let rawSellerId = "";
    try { const res = resolveDataDoeAccountIds([id], connections); rawSellerId = res && res.rawAccountIds && res.rawAccountIds.length === 1 ? String(res.rawAccountIds[0]) : ""; } catch { rawSellerId = ""; }
    directoryMeta.set(id, { accountId: id, country, rawSellerId });
  }
  return directoryMeta;
}

async function bucketAccounts(b) {
  const meta = await loadDirectoryMeta();
  const out = [];
  for (const [id, m] of meta) { if (accountInScope(b, String(m.country).toUpperCase())) out.push({ accountId: id }); }
  return out;
}

// Durable Listings / Listings-Raw pointer readers (per account). read!='ok' or a missing snapshot is a PER-ACCOUNT defer
// inside the reconciler adapter (LKG preserved), never a whole-run failure. D-1 is proven by snapshot.as_of.
const readListingsSnapshot = ({ organizationFingerprint: org, connectionId, accountId, signal = null }) =>
  sb.getSourceListingsSnapshot({ organizationFingerprint: org, connectionId, accountId, signal });
const readListingsRawSnapshot = ({ organizationFingerprint: org, connectionId, accountId, signal = null }) =>
  sb.getSourceListingsRawSnapshot({ organizationFingerprint: org, connectionId, accountId, signal });
// Reuse-only durable FBA inventory snapshot (per account). OPTIONAL to the derive.
const readInventorySnapshot = ({ organizationFingerprint: org, connectionId, accountId, signal = null }) =>
  sb.getSourceSnapshot({ organizationFingerprint: org, connectionId, sourceKey: FBA_INVENTORY_SOURCE_KEY, scopeKey: accountId, signal });

// The recomputed D-1 request hash for EXACTLY the single-day FBA inventory export -- the identity the durable FBA
// snapshot's source_request_hash must equal to prove it is the requested-D-1 inventory. Blank when the account is
// unresolvable (no rawSellerId / no marketplace country) -> inventory unavailable (never blocks; on-hand falls back).
async function resolveExpectedInventoryRequestHash({ accountId, requestedAsOf }) {
  const meta = await loadDirectoryMeta();
  const m = meta.get(String(accountId));
  if (!m || !m.rawSellerId || !m.country) return "";
  try {
    const identity = resolvedFbaSnapshot({ apiKey: primaryConn.apiKey, account: { rawSellerId: m.rawSellerId, country: m.country }, asOf: requestedAsOf, bucket });
    return String(identity && (identity.requestHash ?? identity.request_hash) || "");
  } catch { return ""; }
}
async function resolveAccountRawSellerId(accountId) {
  const meta = await loadDirectoryMeta();
  const m = meta.get(String(accountId));
  return m ? String(m.rawSellerId) : "";
}

// The derived durable context loader (enriched OLI + coverage + completeness + org Product Catalog) -- the SAME loader
// the shadow worker uses. A durable read failure returns {} -> the derive defers (LKG preserved).
const loadDurableContext = makeListingHealthV3DurableContextLoader({
  connections,
  getCatalogSnapshot: (args) => sb.getSourceSnapshot(args),
  loadCatalogPayload: (path) => sb.getSourceSnapshotPayload(path),
});

// PER-ACCOUNT release execution: each stale account derives + finalizes + publishes + reads back in ITS OWN dedicated
// priority-partial cycle (deterministic 16-hex over {accountId, Listings revisionId}) with the captured fence. The
// account's listing-health-v3 is re-derived from the HYDRATED durable Listings/Raw rows + durable OLI/Catalog + reuse-
// only FBA inventory via the CANONICAL deriveReportSnapshot -- NEVER any sibling report. A lagged / unprovable account
// defers on its LKG (zero writes). The deadline AbortSignal is threaded into every supported durable read/write, and
// the publisher is fenced on THIS op's control fence (aborted -> null fence -> the CAS writes zero rows).
async function runReleaseForAccount({ bucket: b, accountId, requestedAsOf, revisionId, signal }) {
  const aborted = () => !!(signal && signal.aborted);
  if (aborted()) return { code: 1, ok: false, stage: "reconcile", status: "DEADLINE_ABORTED", leaseLost: false, reason: "deadline-aborted", aborted: true, blockerCodes: [], problems: ["deadline-aborted before start (no work performed)"] };
  const cycleBucket = "priority-partial-" + b + "-" + sha256(JSON.stringify([accountId, revisionId || ""])).slice(0, 16);
  const publisher = buildSchedulerV2Publisher({ getControlFence: () => (aborted() ? null : leaseFence) });
  const verifyLeaseForOp = async () => (aborted() ? { ok: false, reason: "deadline-aborted" } : verifyLease());
  const release = buildListingHealthV3Release({
    resolveOrg: async () => ({ organizationFingerprint: orgFp, connectionId: "primary" }),
    openCycle: (args, opt) => sb.openSyncCycle(args, opt),
    getCycleByBucketDate: (bk, date, opt) => sb.getBaseSyncCycleByBucketDate(bk, date, opt),
    readListingsSnapshot, readListingsRawSnapshot, readInventorySnapshot,
    loadSnapshotPayload: (path, opt) => sb.getSourceSnapshotPayload(path, opt),
    resolveExpectedInventoryRequestHash, resolveAccountRawSellerId,
    loadDurableContext, deriveSnapshot: deriveReportSnapshot,
    reportDerivations: REPORT_DERIVATIONS,
    computeHash: paramsHashFor,
    liveContracts: SCHEDULER_LIVE_SNAPSHOT_CONTRACTS,
    upsertReportJob: (job, opt) => sb.upsertSyncReportJob(job, opt),
    claimLease: (cycleId, reportKey, a, opts) => sb.claimReportDeriveLease(cycleId, reportKey, a, opts),
    saveShadow: (args, opt) => sb.saveShadowSnapshotIfNewer(args, opt),
    reconcileSuccess: (args, opt) => sb.reconcileReportDeriveSuccess(args, opt),
    finalizeCycle: ({ cycleId }, opt) => sb.finalizeSyncCycle(cycleId, opt),
    publisher, readbackLive, verifyLease: verifyLeaseForOp,
    log: () => {},
  });
  const result = await release.runForAccount({ accountId, requestedAsOf, cycleBucket, signal });
  return { code: result.code, ok: result.ok, stage: result.stage, status: result.status || null, leaseLost: result.leaseLost === true, reason: result.reason || null, blockerCodes: result.blockerCodes || [], problems: result.problems || [] };
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
  return Promise.race([
    Promise.resolve(p).then(() => { clearTimeout(t); return { settled: true }; }, () => { clearTimeout(t); return { settled: true }; }),
    grace,
  ]);
};

const reconciler = buildListingHealthV3PublicationReconciler({
  resolveOrg: async () => ({ organizationFingerprint: orgFp, connectionId: "primary" }),
  bucketAccounts,
  readListingsSnapshot, readListingsRawSnapshot,
  readLatestReportJob: ({ reportKey, accountId }) => sb.getLatestReportJobLineage(reportKey, accountId),
  readShadowSnapshot: (args) => sb.getReportSnapshot(args),
  readLiveSnapshot: (args) => sb.getReportSnapshot(args),
  loadStoragePayload: (path) => sb.getReportSnapshotStoragePayload(path),
  verifyLiveReadback: readbackLive,
  liveContracts: SCHEDULER_LIVE_SNAPSHOT_CONTRACTS,
  computeHash: paramsHashFor,
  reportDerivations: REPORT_DERIVATIONS,
  runReleaseForAccount,
  openControls: dryRun ? (async () => ({ ok: true })) : openControls,
  closeControls: dryRun ? (async () => ({ ok: true })) : closeControls,
  outOfTime, deadlineRace,
  makeAbortController: () => new AbortController(), awaitSettled,
  reportKeys: listingsDependentLiveReportKeys(),
  withTimeout,
  log: (m) => console.log("listing-health-v3-reconcile: " + m),
});

// ABNORMAL-TERMINATION CLEANUP: a distinct invocation the periodic cleanup JOB runs (always(), needs: reconcile) to
// prove the priority control plane is closed after a killed/timed-out reconcile. EVIDENCE-BASED: inspect -> reclaim
// only a free/expired lease -> re-inspect + require proven closed. A live owner blocks reclaim (zero writes).
if (process.argv.includes("--cleanup")) {
  const before = await readControlPlaneClosed();
  if (before.read === "ok" && before.closed === true) { console.log("RESULT " + JSON.stringify({ mode: "cleanup", bucket, requestedAsOf: asOf, cleaned: true, disposition: "already-closed" })); process.exit(0); }
  let reclaim = null;
  try { reclaim = await runControlPackageCli({ mode: "reclaim", operator: OPERATOR, connectStore: connectPriorityControlStore, ownerToken: OPERATOR, operationKey: CONTROL_OP_KEY, log: (m) => console.log("listing-health-v3-reconcile cleanup: " + m) }); }
  catch (e) { reclaim = { committed: false, code: 1, error: e && e.message ? e.message : String(e) }; }
  if (reclaim && Number(reclaim.code) === 3) { console.error("STOP LISTINGS_RECONCILE_CLEANUP_COMMIT_UNKNOWN -- read-only reconciliation required; controls NOT proven closed."); process.exit(1); }
  const after = await readControlPlaneClosed();
  const cleaned = after.read === "ok" && after.closed === true;
  console.log("RESULT " + JSON.stringify({ mode: "cleanup", bucket, requestedAsOf: asOf, cleaned, reclaim: reclaim && (reclaim.skipped || (reclaim.committed ? "committed" : "refused-or-held")), before: before.detail || before.read, after: after.detail || after.read }));
  if (!cleaned) console.error("STOP LISTINGS_RECONCILE_CLEANUP_UNVERIFIED: controls NOT proven closed (a live owner is left untouched; retry after the lease expires).");
  process.exit(cleaned ? 0 : 1);
}

if (!dryRun) {
  const cron = await assertNoCron();
  if (!cron.ok) { console.error("STOP LISTINGS_RECONCILE: " + cron.reason + " -- fail closed."); process.exit(1); }
}

const out = await reconciler.run({ bucket, requestedAsOf: asOf, accountIds: accountsArg.length ? accountsArg : null, mode, dryRun });

ghOut("outcome", out.outcome || "unknown");
ghOut("published_count", String(out.counts ? out.counts.targetsPublished : 0));
ghOut("failed_count", String(out.counts ? out.counts.targetsFailed : 0));
console.log("RESULT " + JSON.stringify({
  ok: out.ok, outcome: out.outcome, code: out.code || "OK", bucket, requestedAsOf: asOf, mode, dryRun,
  dataDoeCreates: 0, dataDoeTokens: 0,
  accountsExamined: out.accountsExamined || 0,
  counts: out.counts || null,
}));
process.exit(out.ok === false ? 1 : 0);
