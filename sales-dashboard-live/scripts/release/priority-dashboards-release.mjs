// TRUSTED, DEFERRED operator runner for the Daily Reporting + Brand View priority release.
// Usage:  node scripts/release/priority-dashboards-release.mjs   (run from sales-dashboard-live/, AFTER Codex
// sign-off AND after migration 20260825 is applied via the guarded release step). It NEVER applies a migration,
// NEVER pushes/deploys, NEVER enables the scheduler/cron, and NEVER touches unrelated reports.
//
// It only WIRES production collaborators into the reviewed, offline-tested orchestrator
// (runPriorityDashboardsRelease): a read-only reconciliation, the trusted composition (derive US then Non-US,
// finalize each exact cycle), a per-(report, account) publication-gate read-proof BEFORE any live write, the
// ordered publish (brand-sales before brand-inventory), and a live-identity read-back with the frontend payload
// contract. It exits NONZERO on every derive/finalize/publish disposition except a proven success.

import pg from "pg";
import { loadReleaseEnv } from "./env-bootstrap.mjs";

loadReleaseEnv(); // portable: loads <repoRoot>/.env.local when present, maps SUPABASE_URL, never overrides CI env

const { buildPriorityDashboardsRelease, PRIORITY_DASHBOARDS } = await import("../../lib/server/sync/source-priority-dashboards.js");
const { runPriorityDashboardsRelease, buildLiveReadback } = await import("../../lib/server/sync/source-priority-release-runner.js");
const { SCHEDULER_LIVE_SNAPSHOT_CONTRACTS } = await import("../../lib/server/sync/report-publisher.js");
const { REPORT_DERIVATIONS } = await import("../../lib/server/sync/report-derivation.js");
const { paramsHashFor } = await import("../../lib/server/report-store.js");
const sb = await import("../../lib/server/supabase.js");

// Optional --as-of=YYYY-MM-DD: pin the derive window's asOf to the last proven durable-OLI covered_to day when
// the wall clock has drifted past it (NO new OLI fetch; the cycle date stays clock-today). Validated here too.
// The SCHEDULER passes the bucket's honestly-proven effectivePublishAsOf here so the published snapshots carry
// that exact coversAsOf; the derive independently re-clamps (belt + suspenders) and will agree.
const asOfArg = (process.argv.find((a) => a.startsWith("--as-of=")) || "").split("=")[1] || null;
if (asOfArg != null && !/^\d{4}-\d{2}-\d{2}$/.test(asOfArg)) { console.error("STOP --as-of must be YYYY-MM-DD (got: " + asOfArg + ")"); process.exit(2); }
if (asOfArg) console.log("priority-release: asOf pinned to " + asOfArg + " (derive window; cycle date stays clock-today).");

// Optional --bucket=us|non-us: publish EXACTLY that one bucket's accounts (Scheduler v2 independent buckets),
// preserving the OTHER bucket's latest-known-good snapshots byte-identically. Omitted => the legacy combined
// US+Non-US release (both buckets published together). The account scope is discovered + verified INTERNALLY by
// the composition (deriveBucket/finalizeBucket) -- never accepted from this flag beyond the bucket name.
const bucketArg = (process.argv.find((a) => a.startsWith("--bucket=")) || "").split("=")[1] || null;
if (bucketArg != null && bucketArg !== "us" && bucketArg !== "non-us") { console.error("STOP --bucket must be us|non-us (got: " + bucketArg + ")"); process.exit(2); }
if (bucketArg) console.log("priority-release: bucket scope = " + bucketArg + " ONLY (the other bucket's snapshots are preserved untouched).");

// --strict-d1: FAIL CLOSED (DATADOE_D1_NOT_READY, never publish) if the derive clamps effectivePublishAsOf below the
// requested D-1 (--as-of). The scheduler passes it so a lagged/regressed bucket keeps its LKG instead of publishing D-2.
const strictD1 = process.argv.includes("--strict-d1");
if (strictD1) console.log("priority-release: --strict-d1 (a derive that clamps below the requested D-1 fails closed; LKG retained).");
// Optional --operation-key: the Catalog reservation key. Default = the historical v2 go-live key; an AUTOMATIC
// scheduled run passes "priority-dashboards/scheduled/YYYY-MM-DD" so each date owns its one-Catalog-create
// reservation. buildPriorityDashboardsRelease validates it STRICTLY (any other shape fails closed).
const opKeyArg = (process.argv.find((a) => a.startsWith("--operation-key=")) || "").split("=").slice(1).join("=") || null;
if (opKeyArg) console.log("priority-release: catalog operation key = " + opKeyArg);
let release;
try {
  // Resolve the BASE cycle (the one that owns the shared Product Catalog job), not the OLI-only superseding HEAD --
  // so the release's Catalog reservation + finalize verification target the cycle that actually carries the catalog.
  release = buildPriorityDashboardsRelease({ asOfOverride: asOfArg, ...(opKeyArg ? { operationKey: opKeyArg } : {}), getCycleByBucketDate: sb.getBaseSyncCycleByBucketDate });
} catch (e) { console.error("STOP " + (e && e.message ? e.message : e)); process.exit(2); }

// A dedicated read-only pg client for the cron proof (never mutates).
const pgBase = String(process.env.POSTGRES_URL).split("?")[0];
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

// READ-ONLY reconciliation: the scheduler must be OFF (all_primary=false) and no cron -- nothing is mutated.
async function reconcile() {
  const cron = await assertNoCron();
  if (!cron.ok) return { ok: false, problems: [cron.reason] };
  try {
    const rollout = await sb.getSchedulerAccountRollout();
    if (!rollout || rollout.read !== "ok" || rollout.allPrimary === true) return { ok: false, problems: ["scheduler rollout not read-ok / all_primary=true"] };
    return { ok: true };
  } catch (e) { return { ok: false, problems: ["reconcile read failed: " + (e && e.message)] }; }
}

// The publication gates are read-proven by the composition's SHARED publisher preflight (release.preflightAccount)
// -- the SAME collaborators + logic as the real publish -- so the CLI duplicates NO gate logic here. The
// EXACT-identity live read-back is the reviewed buildLiveReadback wired to the production readers.
const readbackLive = buildLiveReadback({
  getReportSnapshot: sb.getReportSnapshot,
  loadStoragePayload: sb.getReportSnapshotStoragePayload,
  liveContracts: SCHEDULER_LIVE_SNAPSHOT_CONTRACTS,
  reportDerivations: REPORT_DERIVATIONS,
  computeHash: paramsHashFor,
});

const result = await runPriorityDashboardsRelease({
  release, reconcile, readbackLive, assertNoCron,
  ...(bucketArg ? { bucket: bucketArg } : {}),
  ...(strictD1 ? { strictD1: true } : {}),
  log: (m) => console.log("priority-release: " + m),
});
console.log("RESULT " + JSON.stringify({ ok: result.ok, stage: result.stage, status: result.status || null, bucket: bucketArg || "both", evidence: result.evidence || null, problems: result.problems || null, reports: [...PRIORITY_DASHBOARDS.publishOrder] }));
process.exit(result.code);
