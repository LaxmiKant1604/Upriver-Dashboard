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
import { buildPriorityControlPackage, PRIORITY_DISPATCH_ENABLED, PRIORITY_PROMOTED_ENABLED } from "../../lib/server/sync/source-priority-control-package.js";
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
const plan = MODE === "rollback" ? pkg.rollback : pkg.apply;

console.log("CONTROL-PACKAGE mode=" + MODE + " accounts=" + pkg.accounts.length + " operator=" + OPERATOR);
console.log("  dispatch enabled: " + PRIORITY_DISPATCH_ENABLED.join(", ") + "; promoted enabled: " + PRIORITY_PROMOTED_ENABLED + "; all_primary=false; unrelated reports paused; no cron.");
console.log("  rollout rows: " + plan.rollout.length + "; report_sync_settings: " + plan.reportSyncSettings.length + "; promoted: " + plan.promoted.length + "; approvals: " + plan.approvals.length);
if (MODE === "dry-run") { console.log("DRY RUN -- no writes. Re-run with --apply (or --rollback) to execute the guarded transaction."); process.exit(0); }

const base = String(process.env.POSTGRES_URL).split("?")[0];
const client = new pg.Client({ connectionString: base, ssl: { rejectUnauthorized: false } });
const q = (t, p) => client.query(t, p);
await client.connect();

async function assertNoCron() {
  const t = await q("select to_regclass('cron.job')::text cron_table");
  if (!t.rows[0].cron_table) return true;
  const n = await q("select count(*)::int n from cron.job where command ilike '%scheduler%' or command ilike '%sync%' or command ilike '%priority%'");
  return n.rows[0].n === 0;
}

let committed = false;
try {
  await q("begin");
  await q("select pg_advisory_xact_lock($1::int, $2::int)", ADV);

  // ---- PRE assertions ----
  const mode = await q("select all_primary from public.scheduler_rollout_mode where id=1");
  if (mode.rows.length !== 1 || mode.rows[0].all_primary !== false) throw new Error("PRE: all_primary must be false");
  if (!(await assertNoCron())) throw new Error("PRE: a scheduler cron exists");
  if (!pkg.accounts.length) throw new Error("PRE: zero discovered primary accounts");

  // ---- WRITES ----
  for (const r of plan.rollout) {
    await q("insert into public.scheduler_account_rollout(account_id,enabled,note) values($1,$2,$3) on conflict(account_id) do update set enabled=excluded.enabled,note=excluded.note", [r.account_id, r.enabled, r.note]);
  }
  for (const s of plan.reportSyncSettings) {
    await q("insert into public.report_sync_settings(report_key,schedule_enabled) values($1,$2) on conflict(report_key) do update set schedule_enabled=excluded.schedule_enabled", [s.report_key, s.schedule_enabled]);
  }
  for (const p of plan.promoted) {
    await q("insert into public.source_promoted_publish_settings(report_key,publish_enabled) values($1,$2) on conflict(report_key) do update set publish_enabled=excluded.publish_enabled", [p.report_key, p.publish_enabled]);
  }
  for (const a of plan.approvals) {
    await q("insert into public.scheduler_publish_approvals(report_key,account_id,approved,approved_by,approved_at) values($1,$2,$3,$4,now()) on conflict(report_key,account_id) do update set approved=excluded.approved,approved_by=excluded.approved_by,approved_at=now()", [a.report_key, a.account_id, a.approved, a.approved_by]);
  }

  // ---- POST assertions (apply mode proves the EXACT target state; rollback proves the reversal) ----
  const post = pkg.post;
  const mode2 = await q("select all_primary from public.scheduler_rollout_mode where id=1");
  if (mode2.rows[0].all_primary !== false) throw new Error("POST: all_primary changed");
  if (!(await assertNoCron())) throw new Error("POST: a scheduler cron appeared");
  if (MODE === "apply") {
    const enabled = (await q("select account_id from public.scheduler_account_rollout where enabled=true order by account_id")).rows.map((r) => r.account_id).filter((a) => post.rolloutEnabled.includes(a));
    if (JSON.stringify(enabled.sort()) !== JSON.stringify([...post.rolloutEnabled].sort())) throw new Error("POST: rollout-enabled set != package accounts");
    const dispatchOn = (await q("select report_key from public.report_sync_settings where schedule_enabled=true order by report_key")).rows.map((r) => r.report_key);
    if (JSON.stringify(dispatchOn.sort()) !== JSON.stringify([...post.dispatchEnabled].sort())) throw new Error("POST: dispatch-enabled set != [daily-reporting, brand-sales] -> " + dispatchOn.join(","));
    const promo = (await q("select publish_enabled from public.source_promoted_publish_settings where report_key=$1", [post.promotedEnabled])).rows[0];
    if (!promo || promo.publish_enabled !== true) throw new Error("POST: brand-inventory promoted control not enabled");
    const appr = (await q("select report_key||'|'||account_id k from public.scheduler_publish_approvals where approved=true and account_id = any($1::text[]) order by k", [post.rolloutEnabled])).rows.map((r) => r.k);
    if (JSON.stringify(appr.sort()) !== JSON.stringify([...post.approvals].sort())) throw new Error("POST: approved set != 3 keys x every account");
  } else {
    const enabled = (await q("select count(*)::int n from public.scheduler_account_rollout where enabled=true and account_id = any($1::text[])", [pkg.accounts])).rows[0].n;
    if (enabled !== 0) throw new Error("POST(rollback): some package rollout row still enabled");
    const promo = (await q("select publish_enabled from public.source_promoted_publish_settings where report_key=$1", [PRIORITY_PROMOTED_ENABLED])).rows[0];
    if (promo && promo.publish_enabled === true) throw new Error("POST(rollback): brand-inventory promoted control still enabled");
  }

  await q("commit"); committed = true;
  console.log("COMMITTED control package (" + MODE + ") for " + pkg.accounts.length + " accounts");
} catch (e) {
  try { await q("rollback"); } catch { /* ignore */ }
  console.error("ROLLBACK control package (" + MODE + "): " + (e && e.message));
} finally {
  try { await client.end(); } catch { /* ignore */ }
}
process.exit(committed ? 0 : 1);
