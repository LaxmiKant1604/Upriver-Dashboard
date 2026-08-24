// TRUSTED, DEFERRED control-package operator for the Daily Reporting + Brand View priority go-live.
// Usage (run from sales-dashboard-live/, AFTER Codex sign-off):
//   node scripts/release/priority-control-package.mjs            -> DRY RUN: print the exact package (NO writes)
//   node scripts/release/priority-control-package.mjs --apply    -> apply the package in ONE guarded transaction
//   node scripts/release/priority-control-package.mjs --rollback -> reverse the package in ONE guarded transaction
//
// It opens the publication gates for EXACTLY daily-reporting + brand-sales (dispatch) + brand-inventory (promoted)
// for ALL freshly discovered PRIMARY accounts, with an audited approval for every (key, account); all_primary
// STAYS false; every unrelated controlled report is paused; no cron is created. Everything happens in ONE
// advisory-locked transaction with exact PRE and POST assertions -- any failure ROLLS BACK the whole package.
// The default (no flag) is a DRY RUN that writes nothing.

import { readFileSync } from "node:fs";
import pg from "pg";
import { buildPriorityControlPackage, runControlPackageTransaction, PRIORITY_DISPATCH_ENABLED, PRIORITY_PROMOTED_ENABLED } from "../../lib/server/sync/source-priority-control-package.js";
import { CONTROLLED_REPORT_KEYS } from "../../lib/server/sync/report-controls.js";
import { getDataDoeConnections, classifyDirectoryAccounts } from "../../lib/server/datadoe-connections.js";
import { fetchAccounts as fetchDataDoeAccounts } from "../../lib/server/datadoe.js";

const repoRoot = "C:/Users/laxmi/Documents/Codex/2026-07-01/can/Upriver-Dashboard";
for (const line of readFileSync(repoRoot + "/.env.local", "utf8").split(/\r?\n/)) {
  const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line); if (!m) continue;
  let v = m[2].trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  if (process.env[m[1]] === undefined) process.env[m[1]] = v;
}
process.env.SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;

const MODE = process.argv.includes("--apply") ? "apply" : process.argv.includes("--rollback") ? "rollback" : "dry-run";
const OPERATOR = process.env.PRIORITY_OPERATOR || "laxmikant@superboring.in";
const ADV = [20260825, 2]; // a dedicated advisory-lock pair for the priority control package

// Fresh PRIMARY discovery -- the exact account set the publisher's rollout resolves against.
const connections = getDataDoeConnections();
const primaryConn = connections.find((c) => c.id === "primary");
const rows = (await fetchDataDoeAccounts(primaryConn.apiKey)) || [];
const { active } = classifyDirectoryAccounts(rows, connections);
const accounts = active.map((a) => String((a && (a.accountId ?? a.id)) || "").trim()).filter((a) => a && !a.startsWith("dd-secondary:"));
const pkg = buildPriorityControlPackage({ accounts, operator: OPERATOR });

console.log("CONTROL-PACKAGE mode=" + MODE + " accounts=" + pkg.accounts.length + " operator=" + OPERATOR);
console.log("  dispatch enabled: " + PRIORITY_DISPATCH_ENABLED.join(", ") + "; promoted enabled: " + PRIORITY_PROMOTED_ENABLED + "; all_primary=false; unrelated reports paused; no cron.");
console.log("  APPLY target: rollout enabled=" + pkg.post.rolloutEnabled.length + "; dispatch enabled=" + pkg.post.dispatchEnabled.length + " (paused=" + pkg.post.dispatchPaused.length + "); promoted enabled=1; approvals=" + pkg.post.approvals.length + ".");
console.log("  ROLLBACK is a SAFE-CLOSE: disables EVERY rollout row, pauses ALL " + CONTROLLED_REPORT_KEYS.length + " controlled settings, disables EVERY promoted control, revokes EVERY approval (NOT a restoration).");
if (MODE === "dry-run") { console.log("DRY RUN -- no writes. Re-run with --apply (or --rollback) to execute the guarded transaction."); process.exit(0); }

const base = String(process.env.POSTGRES_URL).split("?")[0];
const client = new pg.Client({ connectionString: base, ssl: { rejectUnauthorized: false } });
const q = (t, p) => client.query(t, p);
await client.connect();

async function hasSchedulerCron() {
  const t = await q("select to_regclass('cron.job')::text cron_table");
  if (!t.rows[0].cron_table) return false;
  const n = await q("select count(*)::int n from cron.job where command ilike '%scheduler%' or command ilike '%sync%' or command ilike '%priority%'");
  return n.rows[0].n > 0;
}

// The pg-backed store implementing the runControlPackageTransaction contract. Every WRITE reconciles to an
// EXACT target (apply) or safe-closes (rollback); every READ returns the COMPLETE current rows for the global
// POST assertions. begin() opens the transaction under a dedicated advisory lock so two operators cannot race.
const store = {
  begin: async () => { await q("begin"); await q("select pg_advisory_xact_lock($1::int, $2::int)", ADV); },
  commit: async () => { await q("commit"); },
  rollback: async () => { await q("rollback"); },
  readAllPrimary: async () => { const r = await q("select all_primary from public.scheduler_rollout_mode where id=1"); return r.rows.length === 1 ? r.rows[0].all_primary : null; },
  hasCron: hasSchedulerCron,
  setRolloutEnabled: async (accountIds) => {
    for (const a of accountIds) await q("insert into public.scheduler_account_rollout(account_id,enabled,note) values($1,true,$2) on conflict(account_id) do update set enabled=true,note=excluded.note", [a, "priority dashboards go-live"]);
    await q("update public.scheduler_account_rollout set enabled=false where enabled=true and not (account_id = any($1::text[]))", [accountIds]);
  },
  disableAllRollout: async () => { await q("update public.scheduler_account_rollout set enabled=false where enabled=true"); },
  setDispatchEnabled: async (enabledKeys, controlled) => {
    for (const rk of controlled) await q("insert into public.report_sync_settings(report_key,schedule_enabled) values($1,$2) on conflict(report_key) do update set schedule_enabled=excluded.schedule_enabled", [rk, enabledKeys.includes(rk)]);
  },
  pauseAllDispatch: async (controlled) => {
    for (const rk of controlled) await q("insert into public.report_sync_settings(report_key,schedule_enabled) values($1,false) on conflict(report_key) do update set schedule_enabled=false", [rk]);
  },
  setPromotedEnabled: async (enabledKeys) => {
    for (const rk of enabledKeys) await q("insert into public.source_promoted_publish_settings(report_key,publish_enabled) values($1,true) on conflict(report_key) do update set publish_enabled=true", [rk]);
    await q("update public.source_promoted_publish_settings set publish_enabled=false where publish_enabled=true and not (report_key = any($1::text[]))", [enabledKeys]);
  },
  disableAllPromoted: async () => { await q("update public.source_promoted_publish_settings set publish_enabled=false where publish_enabled=true"); },
  setApprovalsApproved: async (pairs, operator) => {
    for (const p of pairs) { const [rk, aid] = p.split("|"); await q("insert into public.scheduler_publish_approvals(report_key,account_id,approved,approved_by,approved_at) values($1,$2,true,$3,now()) on conflict(report_key,account_id) do update set approved=true,approved_by=excluded.approved_by,approved_at=now()", [rk, aid, operator]); }
    await q("update public.scheduler_publish_approvals set approved=false where approved=true and not ((report_key||'|'||account_id) = any($1::text[]))", [pairs]);
  },
  revokeAllApprovals: async () => { await q("update public.scheduler_publish_approvals set approved=false where approved=true"); },
  rolloutRows: async () => (await q("select account_id, enabled from public.scheduler_account_rollout")).rows,
  dispatchRows: async () => (await q("select report_key, schedule_enabled from public.report_sync_settings")).rows,
  promotedRows: async () => (await q("select report_key, publish_enabled from public.source_promoted_publish_settings")).rows,
  approvalRows: async () => (await q("select report_key, account_id, approved from public.scheduler_publish_approvals")).rows,
};

let result = { committed: false };
try {
  result = await runControlPackageTransaction({ store, pkg, mode: MODE, controlledReportKeys: CONTROLLED_REPORT_KEYS });
  if (result.committed) console.log("COMMITTED control package (" + MODE + ") for " + pkg.accounts.length + " accounts");
  else console.error("ROLLBACK control package (" + MODE + "): " + (result.problem || (result.problems || []).join("; ")));
} catch (e) {
  try { await q("rollback"); } catch { /* ignore */ }
  console.error("ROLLBACK control package (" + MODE + "): " + (e && e.message));
} finally {
  try { await client.end(); } catch { /* ignore */ }
}
process.exit(result.committed ? 0 : 1);
