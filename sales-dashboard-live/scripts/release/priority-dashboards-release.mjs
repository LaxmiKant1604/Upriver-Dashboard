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

import { readFileSync } from "node:fs";
import pg from "pg";

const repoRoot = "C:/Users/laxmi/Documents/Codex/2026-07-01/can/Upriver-Dashboard";
for (const line of readFileSync(repoRoot + "/.env.local", "utf8").split(/\r?\n/)) {
  const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line); if (!m) continue;
  let v = m[2].trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  if (process.env[m[1]] === undefined) process.env[m[1]] = v;
}
process.env.SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;

const { buildPriorityDashboardsRelease, PRIORITY_DASHBOARDS } = await import("../../lib/server/sync/source-priority-dashboards.js");
const { runPriorityDashboardsRelease, buildLiveReadback } = await import("../../lib/server/sync/source-priority-release-runner.js");
const { SCHEDULER_LIVE_SNAPSHOT_CONTRACTS } = await import("../../lib/server/sync/report-publisher.js");
const { REPORT_DERIVATIONS } = await import("../../lib/server/sync/report-derivation.js");
const { paramsHashFor } = await import("../../lib/server/report-store.js");
const sb = await import("../../lib/server/supabase.js");

// Optional --as-of=YYYY-MM-DD: pin the derive window's asOf to the last proven durable-OLI covered_to day when
// the wall clock has drifted past it (NO new OLI fetch; the cycle date stays clock-today). Validated here too.
const asOfArg = (process.argv.find((a) => a.startsWith("--as-of=")) || "").split("=")[1] || null;
if (asOfArg != null && !/^\d{4}-\d{2}-\d{2}$/.test(asOfArg)) { console.error("STOP --as-of must be YYYY-MM-DD (got: " + asOfArg + ")"); process.exit(2); }
if (asOfArg) console.log("priority-release: asOf pinned to " + asOfArg + " (derive window; cycle date stays clock-today).");
const release = buildPriorityDashboardsRelease({ asOfOverride: asOfArg });

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
  log: (m) => console.log("priority-release: " + m),
});
console.log("RESULT " + JSON.stringify({ ok: result.ok, stage: result.stage, evidence: result.evidence || null, problems: result.problems || null, reports: [...PRIORITY_DASHBOARDS.publishOrder] }));
process.exit(result.code);
