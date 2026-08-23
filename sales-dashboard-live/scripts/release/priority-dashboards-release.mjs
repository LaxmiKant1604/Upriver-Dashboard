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

const { buildPriorityDashboardsRelease, PRIORITY_DASHBOARDS, assertPriorityPublishReportKey } = await import("../../lib/server/sync/source-priority-dashboards.js");
const { runPriorityDashboardsRelease } = await import("../../lib/server/sync/source-priority-release-runner.js");
const { SCHEDULER_LIVE_SNAPSHOT_CONTRACTS } = await import("../../lib/server/sync/report-publisher.js");
const { REPORT_DERIVATIONS } = await import("../../lib/server/sync/report-derivation.js");
const sb = await import("../../lib/server/supabase.js");

const release = buildPriorityDashboardsRelease();

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

// Read-prove the four durable publication gates for one (report, account) -- NO write.
async function readPublishGate(reportKey, accountId) {
  assertPriorityPublishReportKey(reportKey);
  if (reportKey === "brand-inventory") {
    const promoted = (await sb.getSourcePromotedPublishSettings()) || [];
    const row = promoted.find((r) => String(r.report_key ?? r.reportKey) === reportKey);
    if (!row || row.publish_enabled !== true) return { ready: false, reason: "promoted-publish-disabled" };
  } else {
    const settings = (await sb.getReportSyncSettings()) || [];
    const row = settings.find((r) => String(r.report_key ?? r.reportKey) === reportKey);
    if (!row || row.schedule_enabled !== true) return { ready: false, reason: "report-disabled" };
  }
  const approval = await sb.getSchedulerPublishApproval(reportKey, accountId);
  if (!approval || approval.read !== "ok" || approval.approved !== true) return { ready: false, reason: "not-approved" };
  return { ready: true };
}

// Read back the exact LIVE identity and prove the frontend payload contract (REPORT_DERIVATIONS.validatePayload).
async function readbackLive(reportKey, accountId) {
  const contract = SCHEDULER_LIVE_SNAPSHOT_CONTRACTS[reportKey];
  if (!contract) return { ok: false, reason: "no live contract" };
  const snap = await sb.getReportSnapshot({ reportKey: contract.liveReportKey, accountId });
  if (!snap || snap.payload == null || String(snap.source_refreshed_at || "").trim() === "") return { ok: false, reason: "no live snapshot" };
  const entry = REPORT_DERIVATIONS[reportKey];
  if (!entry || entry.validatePayload(snap.payload) !== true) return { ok: false, reason: "payload contract failed" };
  return { ok: true };
}

const result = await runPriorityDashboardsRelease({
  release, reconcile, readPublishGate, readbackLive, assertNoCron,
  log: (m) => console.log("priority-release: " + m),
});
console.log("RESULT " + JSON.stringify({ ok: result.ok, stage: result.stage, evidence: result.evidence || null, problems: result.problems || null, reports: [...PRIORITY_DASHBOARDS.publishOrder] }));
process.exit(result.code);
