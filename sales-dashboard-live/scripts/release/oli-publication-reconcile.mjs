// TRUSTED, DEFERRED operator entrypoint for the ZERO-EXPORT OLI publication reconciler (WORK 4/6/7/9).
// Usage (run from sales-dashboard-live/):
//   node scripts/release/oli-publication-reconcile.mjs --bucket=india|europe-au|us-ca --as-of=YYYY-MM-DD [--mode=periodic|immediate] [--accounts=A,B] [--live]
//
// It re-derives + promotes the OLI-dependent canonical live dashboards (daily-reporting / brand-sales / brand-inventory)
// for accounts whose durable OLI advanced past (or was never promoted to) their live snapshots, using ALREADY-SAVED
// durable OLI. It NEVER creates a DataDoe export, reserves a token, refreshes a source, or supersedes the daily export
// -- the derive's inner adapter is FORCED to refuse creates (zero export, structurally), and this file references no
// export/token symbol. DEFAULT is DRY-RUN (read-only plan; zero writes); LIVE promotion requires an explicit --live.
//
// It WIRES production collaborators into the reviewed, offline-tested core (buildOliPublicationReconciler) + the
// reviewed release/runner/publisher primitives (buildPriorityDashboardsRelease / runPriorityDashboardsRelease /
// buildLiveReadback). To avoid racing the daily scheduler it acquires the SAME control-plane lease and DEFERS (never
// steals) when another owner holds it. 7-bit ASCII, LF.

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
const ghOut = (k, v) => { const f = process.env.GITHUB_OUTPUT; if (f) { try { appendFileSync(f, k + "=" + v + "\n"); } catch { /* ignore */ } } };

if (!isRegionScope(bucket)) { console.error("STOP OLI_RECONCILE_REGION_UNSUPPORTED: --bucket must be india|europe-au|us-ca (region-scoped); got " + bucket); process.exit(2); }
if (!DATE_RE.test(String(asOf))) { console.error("STOP OLI_RECONCILE_AS_OF: --as-of=YYYY-MM-DD is required; got " + asOf); process.exit(2); }
if (mode === "immediate" && accountsArg.length === 0) { console.error("STOP OLI_RECONCILE_IMMEDIATE: --mode=immediate requires --accounts=A,B (the accounts whose OLI just saved)."); process.exit(2); }
console.log(`oli-reconcile: bucket=${bucket} as-of=${asOf} mode=${mode} ${dryRun ? "DRY-RUN (read-only; zero writes)" : "LIVE"} accounts=${accountsArg.length || "region"}`);

const { buildOliPublicationReconciler } = await import("../../lib/server/sync/oli-publication-reconciler.js");
const { oliDependentLiveReportKeys } = await import("../../lib/server/sync/oli-dependent-reports.js");
const { sourceRegistryEntry } = await import("../../lib/server/sync/source-registry.js");
const { organizationFingerprint } = await import("../../lib/server/source-identity.js");
const { getDataDoeConnections, classifyDirectoryAccounts } = await import("../../lib/server/datadoe-connections.js");
const { fetchAccounts: fetchDirectory } = await import("../../lib/server/datadoe.js");
const { SCHEDULER_LIVE_SNAPSHOT_CONTRACTS } = await import("../../lib/server/sync/report-publisher.js");
const { REPORT_DERIVATIONS } = await import("../../lib/server/sync/report-derivation.js");
const { paramsHashFor } = await import("../../lib/server/report-store.js");
const sb = await import("../../lib/server/supabase.js");

const OLI = "order-line-items";
const oliStart = sourceRegistryEntry(OLI).initialBackfill.start;
const connections = getDataDoeConnections() || [];
const primaryConn = connections.find((c) => c.id === "primary");
if (!primaryConn) { console.error("STOP OLI_RECONCILE_NO_PRIMARY_CONNECTION -- fail closed."); process.exit(1); }
const orgFp = primaryConn.organizationFingerprint || organizationFingerprint(primaryConn.apiKey);

const withTimeout = (p, label) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(label + " timed out after 120000ms")), 120000))]);

// EXACT-identity live readback (the reviewed buildLiveReadback wired to production readers) -- used both to verify a
// CURRENT live snapshot during selection and to verify a freshly-promoted one after publish.
const { buildLiveReadback } = await import("../../lib/server/sync/source-priority-release-runner.js");
const readbackLive = buildLiveReadback({
  getReportSnapshot: sb.getReportSnapshot,
  loadStoragePayload: sb.getReportSnapshotStoragePayload,
  liveContracts: SCHEDULER_LIVE_SNAPSHOT_CONTRACTS,
  reportDerivations: REPORT_DERIVATIONS,
  computeHash: paramsHashFor,
});

// NO-EXPORT inner adapter: the reconciler derives ONLY from already-saved durable OLI. Any attempt to CREATE (or
// fetch) a DataDoe export from inside the derive fails closed here, so the reconciler can never issue a paid export --
// a genuinely missing durable dependency becomes a typed derive failure (DEFERRED_DEPENDENCY), never a create.
const makeNoExportInnerAdapter = () => ({
  create: async () => { throw new Error("OLI_RECONCILER_NO_EXPORT: the reconciler never creates a DataDoe export (fail closed)."); },
  poll: async () => { throw new Error("OLI_RECONCILER_NO_EXPORT: the reconciler never polls a DataDoe export (fail closed)."); },
  download: async () => { throw new Error("OLI_RECONCILER_NO_EXPORT: the reconciler never downloads a DataDoe export (fail closed)."); },
});

const pgBase = String(process.env.POSTGRES_URL || "").split("?")[0];
const makePgReadOnly = () => new pg.Client({ connectionString: pgBase, ssl: { rejectUnauthorized: false } });
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
  try {
    const rollout = await sb.getSchedulerAccountRollout();
    if (!rollout || rollout.read !== "ok" || rollout.allPrimary === true) return { ok: false, problems: ["scheduler rollout not read-ok / all_primary=true"] };
    return { ok: true };
  } catch (e) { return { ok: false, problems: ["reconcile read failed: " + (e && e.message)] }; }
}

// LIVE fence: acquire the SAME control-plane lease the scheduler publishes under, but DEFER (never steal) if another
// owner holds an unexpired lease -- so the reconciler can never race/supersede an in-flight daily publish. In dry-run
// no lease is taken (zero writes). The captured { ownerToken, generation } fences every live write, and is renewed
// per account + released at the end.
let leaseFence = null; let controlStore = null;
async function acquireReconcileLease() {
  const held = await sb.readControlPlaneLease();
  if (held && held.held === true && String(held.owner_token) !== "") {
    return { deferred: true, reason: "control-plane lease held by " + String(held.owner_token).slice(0, 12) + " (scheduler active) -- deferring, never stealing" };
  }
  controlStore = await (await import("../../lib/server/sync/priority-control-pg-store.js")).connectPriorityControlStore();
  const ownerToken = "oli-reconcile-" + bucket + "-" + Date.now();
  const opKey = "oli-reconcile/" + bucket + "/" + asOf;
  const acq = await controlStore.acquireControlLease(ownerToken, opKey, 900);
  const generation = acq && (Number.isSafeInteger(acq.generation) ? acq.generation : Number(acq.generation));
  if (!(Number.isSafeInteger(generation) && generation > 0)) return { deferred: true, reason: "could not acquire a fencing generation (" + JSON.stringify(acq) + ")" };
  leaseFence = { ownerToken, generation };
  return { deferred: false };
}
const verifyLease = async () => {
  if (!leaseFence) return { ok: false, reason: "no-fence" };
  try { const r = await sb.renewControlPlaneLease({ ownerToken: leaseFence.ownerToken, generation: leaseFence.generation, ttlSeconds: 900 }); return { ok: !!(r && r.disposition === "renewed"), reason: r && (r.reason || r.disposition) }; }
  catch (e) { return { ok: false, reason: "renew-error:" + (e && e.message ? e.message : e) }; }
};

// PER-ACCOUNT release execution (WORK 5 isolation): each stale account is derived + finalized + published + read back
// in ITS OWN dedicated reconcile cycle bucket (a single-account subset), so one account's failure never blocks another.
// Zero export: makeInnerAdapter is the no-export adapter; the shared per-day catalog operation key adopts the durable
// catalog (no new create). strictD1 keeps a lagged account on its LKG rather than publishing a stale D-1.
const { buildPriorityDashboardsRelease } = await import("../../lib/server/sync/source-priority-dashboards.js");
const { runPriorityDashboardsRelease } = await import("../../lib/server/sync/source-priority-release-runner.js");
async function runReleaseForAccount({ bucket: b, accountId, requestedAsOf }) {
  const { sha256 } = await import("../../lib/server/source-identity.js");
  const cycleBucket = "oli-reconcile-" + b + "-" + sha256(JSON.stringify([accountId])).slice(0, 16);
  const fetchOne = async (apiKey) => ((await fetchDirectory(apiKey)) || []).filter((r) => String((r && (r.accountId ?? r.account_id ?? r.id)) || "").trim() === accountId);
  const release = buildPriorityDashboardsRelease({
    asOfOverride: requestedAsOf, operationKey: "priority-dashboards/scheduled/" + requestedAsOf,
    getCycleByBucketDate: sb.getBaseSyncCycleByBucketDate, getControlFence: () => leaseFence,
    makeInnerAdapter: makeNoExportInnerAdapter, fetchAccounts: fetchOne, cycleBucket,
  });
  const result = await runPriorityDashboardsRelease({ release, reconcile, readbackLive, assertNoCron, bucket: b, strictD1: true, verifyLease, log: () => {} });
  return { code: result.code, ok: result.ok, stage: result.stage, problems: result.problems || [], published: result.publishedIdentities || [] };
}

// Brand View membership/directory refresh AFTER brand-sales promotions. The directory is a READ-TIME self-heal
// (serveSelfHealingBrandDirectory rebuilds from the promoted bare brand-sales snapshots on the next serve, never
// persisting on read), so the reconciler's post-promotion action records that the now-fresh brand-sales will drive the
// rebuild; it never rebuilds from a stale brand-sales (it only runs once those promotions verified).
async function rebuildBrandViewMembership({ accountIds }) {
  console.log("oli-reconcile: brand-sales promoted for " + accountIds.length + " account(s); Brand View membership/directory self-heals from the now-current brand-sales on next serve.");
  return { ok: true, rebuilt: accountIds, mode: "read-time-self-heal" };
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
  readbackLive,
  runReleaseForAccount,
  rebuildBrandViewMembership,
  reportKeys: oliDependentLiveReportKeys(),
  withTimeout,
  log: (m) => console.log("oli-reconcile: " + m),
});

// LIVE promotion needs a fence; acquire-or-defer BEFORE running (dry-run takes no lease). A deferral is a clean no-op.
if (!dryRun) {
  const cron = await assertNoCron();
  if (!cron.ok) { console.error("STOP OLI_RECONCILE: " + cron.reason + " -- fail closed."); process.exit(1); }
  const lease = await acquireReconcileLease();
  if (lease.deferred) { console.log("OLI_RECONCILE_DEFERRED (" + lease.reason + ") -- zero writes; retries next cycle."); process.exit(0); }
}

let out;
try {
  out = await reconciler.run({ bucket, requestedAsOf: asOf, accountIds: accountsArg.length ? accountsArg : null, mode, dryRun });
} finally {
  if (controlStore && leaseFence) { try { await controlStore.releaseControlLease(leaseFence.ownerToken, leaseFence.generation); } catch { /* ignore */ } }
  if (controlStore && typeof controlStore.end === "function") { try { await controlStore.end(); } catch { /* ignore */ } }
}

ghOut("stale_count", String(out.counts ? out.counts.targetsStale + out.counts.targetsPublished : 0));
ghOut("published_count", String(out.counts ? out.counts.targetsPublished : 0));
console.log("RESULT " + JSON.stringify({
  ok: out.ok, code: out.code || "OK", bucket, requestedAsOf: asOf, mode, dryRun,
  dataDoeCreates: 0, dataDoeTokens: 0,
  accountsExamined: out.accountsExamined || 0, brandViewRebuilt: out.brandViewRebuilt || false,
  counts: out.counts || null,
}));
process.exit(out.ok === false ? 1 : 0);
