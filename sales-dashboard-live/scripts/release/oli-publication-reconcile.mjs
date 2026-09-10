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
const { runPriorityDashboardsRelease, buildLiveReadback } = await import("../../lib/server/sync/source-priority-release-runner.js");
const { readPartialCycleCapability } = await import("../../lib/server/sync/priority-partial-capability.js");
const { runControlPackageCli } = await import("../../lib/server/sync/source-priority-control-package.js");
const { connectPriorityControlStore } = await import("../../lib/server/sync/priority-control-pg-store.js");
const sb = await import("../../lib/server/supabase.js");

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
// missing durable dependency becomes a typed derive failure (DEFERRED_DEPENDENCY), never a create.
const makeNoExportInnerAdapter = () => ({
  create: async () => { throw new Error("OLI_RECONCILER_NO_EXPORT: the reconciler never creates a DataDoe export (fail closed)."); },
  poll: async () => { throw new Error("OLI_RECONCILER_NO_EXPORT: the reconciler never polls a DataDoe export (fail closed)."); },
  download: async () => { throw new Error("OLI_RECONCILER_NO_EXPORT: the reconciler never downloads a DataDoe export (fail closed)."); },
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
  try {
    const r = await runControlPackageCli({ mode: "rollback", operator: OPERATOR, connectStore: connectPriorityControlStore, ownerToken: leaseFence.ownerToken, ownerGeneration: leaseFence.generation, operationKey: CONTROL_OP_KEY, log: (m) => console.log("oli-reconcile safe-close: " + m) });
    leaseFence = null;
    if (r && r.skipped === "lease-not-owner") return { ok: true };
    if (!r || r.committed !== true) return { ok: false, reason: "safe-close did not commit (code " + (r && r.code) + ")" };
    return { ok: true };
  } catch (e) { leaseFence = null; return { ok: false, reason: "safe-close-error:" + (e && e.message ? e.message : e) }; }
}
const verifyLease = async () => {
  if (!leaseFence) return { ok: false, reason: "no-fence" };
  try { const r = await sb.renewControlPlaneLease({ ownerToken: leaseFence.ownerToken, generation: leaseFence.generation, ttlSeconds: 900 }); return { ok: !!(r && r.disposition === "renewed"), reason: r && (r.reason || r.disposition) }; }
  catch (e) { return { ok: false, reason: "renew-error:" + (e && e.message ? e.message : e) }; }
};

// PER-ACCOUNT release execution: each stale account derives + finalizes + publishes + reads back in ITS OWN dedicated
// priority-partial cycle (deterministic 16-hex over {accountId, revisionId}) with the no-export adapter + the captured
// fence. strictD1 keeps a lagged account on its LKG. The three OLI-dependent dashboards publish account-atomically.
async function runReleaseForAccount({ bucket: b, accountId, requestedAsOf, revisionId }) {
  const cycleBucket = "priority-partial-" + b + "-" + sha256(JSON.stringify([accountId, revisionId || ""])).slice(0, 16);
  const fetchOne = async (apiKey) => ((await fetchDirectory(apiKey)) || []).filter((r) => String((r && (r.accountId ?? r.account_id ?? r.id)) || "").trim() === accountId);
  const release = buildPriorityDashboardsRelease({
    asOfOverride: requestedAsOf, operationKey: "priority-dashboards/scheduled/" + requestedAsOf,
    getCycleByBucketDate: sb.getBaseSyncCycleByBucketDate, getControlFence: () => leaseFence,
    makeInnerAdapter: makeNoExportInnerAdapter, fetchAccounts: fetchOne, cycleBucket,
  });
  const result = await runPriorityDashboardsRelease({ release, reconcile, readbackLive, assertNoCron, bucket: b, strictD1: true, verifyLease, log: () => {} });
  return { code: result.code, ok: result.ok, stage: result.stage, problems: result.problems || [], published: result.publishedIdentities || [] };
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

const reconciler = buildOliPublicationReconciler({
  resolveOrg: async () => ({ organizationFingerprint: orgFp, connectionId: "primary" }),
  bucketAccounts,
  oliStart,
  readPositiveHistory: (args) => sb.getSourceOliHistoryRows(args),
  readZeroRowProof: (args) => sb.getSourceOliZeroRowProof(args),
  readLatestLiveSnapshot: (args) => sb.getLatestReportSnapshot(args),
  readLatestJobLineage: ({ reportKey, accountId }) => sb.getLatestReportJobLineage(reportKey, accountId),
  readbackLive,
  runReleaseForAccount,
  rebuildBrandViewMembership,
  openControls: dryRun ? (async () => ({ ok: true })) : openControls,
  closeControls: dryRun ? (async () => ({ ok: true })) : closeControls,
  reportKeys: oliDependentLiveReportKeys(),
  withTimeout,
  log: (m) => console.log("oli-reconcile: " + m),
});

if (!dryRun) {
  const cron = await assertNoCron();
  if (!cron.ok) { console.error("STOP OLI_RECONCILE: " + cron.reason + " -- fail closed."); process.exit(1); }
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
