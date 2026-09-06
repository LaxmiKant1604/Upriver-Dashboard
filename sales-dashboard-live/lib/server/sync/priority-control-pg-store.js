// The ONE reviewed pg-backed store + primary discovery for the priority control package, shared VERBATIM by the
// CLI operator (scripts/release/priority-control-package.mjs), the manual source-sync operator, and any other
// trusted caller of runControlPackageCli -- one implementation, so the control-write SQL cannot drift. Every
// WRITE reconciles to an EXACT target (apply) or safe-closes (rollback); every READ returns the COMPLETE current
// rows for the global POST assertions. begin() opens the transaction under a dedicated advisory lock so two
// operators cannot race. dyn import note: this module pulls `pg` + DataDoe discovery, so it must only ever be
// imported by trusted server-side operators/routes (never the pure derivation graph).

import pg from "pg";
import { getDataDoeConnections, classifyDirectoryAccounts } from "../datadoe-connections.js";
import { fetchAccountsDetailed as fetchDataDoeAccountsDetailed } from "../datadoe.js";
import { getAccountOnboardingRows } from "../supabase.js";
import { fetchExportEligibleAccounts } from "./account-onboarding.js";
import { accountInScope, isRoutingScope } from "./scheduler-scope.js";

export const PRIORITY_CONTROL_ADVISORY_LOCK = Object.freeze([20260825, 2]);

// Fresh PRIMARY discovery -- the exact account set the publisher's rollout resolves against. Only apply/dry-run
// need it; a rollback (safe-close) is discovery-independent and must work with DataDoe down.
//
// `bucket` (a routing scope: region india|europe-au|us-ca, or legacy us|non-us) restricts discovery to ONLY that
// scope's primary accounts (independent scopes): the control apply then opens controls for exactly that scope, and
// the transaction's exact-set POST reconciles the OTHER scopes' rollout/approvals OFF (transient controls only --
// snapshots are never touched, so every other scope's latest-known-good publication stays byte-identical). Omitted
// => ALL primary accounts (the legacy combined go-live). A bad scope fails closed.
export async function discoverPrimaryAccountIds(bucket = null) {
  if (bucket != null && !isRoutingScope(bucket)) throw new Error(`discoverPrimaryAccountIds bucket must be a routing scope (india|europe-au|us-ca|us|non-us; got "${bucket}") (fail closed).`);
  const connections = getDataDoeConnections();
  const primaryConn = connections.find((c) => c.id === "primary");
  // EXPORT-ELIGIBILITY GATE: controls/rollout open ONLY for export-eligible accounts -- a DataDoe
  // still-loading or not-yet-claimed account never enters a publication scope (fails soft to
  // readiness-only when the onboarding table is unreadable; loading accounts stay excluded either way).
  const rows = (await fetchExportEligibleAccounts(primaryConn.apiKey, {
    fetchDetailed: fetchDataDoeAccountsDetailed, readOnboardingRows: getAccountOnboardingRows,
  })) || [];
  const { active } = classifyDirectoryAccounts(rows, connections);
  const ids = [];
  for (const a of active) {
    const id = String((a && (a.accountId ?? a.id)) || "").trim();
    if (!id || id.startsWith("dd-secondary:")) continue;
    if (bucket && !accountInScope(bucket, String((a && a.country) || ""))) continue;
    ids.push(id);
  }
  return ids;
}

export async function connectPriorityControlStore() {
  const ADV = PRIORITY_CONTROL_ADVISORY_LOCK;
  const base = String(process.env.POSTGRES_URL).split("?")[0];
  const client = new pg.Client({ connectionString: base, ssl: { rejectUnauthorized: false } });
  const q = (t, p) => client.query(t, p);
  await client.connect();
  const hasSchedulerCron = async () => {
    const t = await q("select to_regclass('cron.job')::text cron_table");
    if (!t.rows[0].cron_table) return false;
    const n = await q("select count(*)::int n from cron.job where command ilike '%scheduler%' or command ilike '%sync%' or command ilike '%priority%'");
    return n.rows[0].n > 0;
  };
  return {
    end: async () => { try { await client.end(); } catch { /* ignore */ } },
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
    // Every approval write is AUDITED: approve the target (operator + now()); revoke each EXTRA (operator + now()).
    setApprovalsApproved: async (pairs, operator) => {
      for (const p of pairs) { const [rk, aid] = p.split("|"); await q("insert into public.scheduler_publish_approvals(report_key,account_id,approved,approved_by,approved_at) values($1,$2,true,$3,now()) on conflict(report_key,account_id) do update set approved=true,approved_by=excluded.approved_by,approved_at=now()", [rk, aid, operator]); }
      await q("update public.scheduler_publish_approvals set approved=false,approved_by=$1,approved_at=now() where approved=true and not ((report_key||'|'||account_id) = any($2::text[]))", [operator, pairs]);
    },
    // Safe-close revocation is AUDITED with the validated operator + PostgreSQL now().
    revokeAllApprovals: async (operator) => { await q("update public.scheduler_publish_approvals set approved=false,approved_by=$1,approved_at=now() where approved=true", [operator]); },
    rolloutRows: async () => (await q("select account_id, enabled from public.scheduler_account_rollout")).rows,
    dispatchRows: async () => (await q("select report_key, schedule_enabled from public.report_sync_settings")).rows,
    promotedRows: async () => (await q("select report_key, publish_enabled from public.source_promoted_publish_settings")).rows,
    approvalRows: async () => (await q("select report_key, account_id, approved from public.scheduler_publish_approvals")).rows,
  };
}
