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
import { getAccountOnboardingRows, getAccountDirectorySnapshotAccounts } from "../supabase.js";
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
  // readiness-only when the onboarding table is unreadable/empty; loading accounts stay excluded either way).
  // readEstablishedAccountIds RECONCILES accounts already proven established by the durable account-directory
  // snapshot: an empty/partial onboarding table can never exclude an existing DataDoe-ready account, while a
  // brand-new id is still routed through onboarding (never auto-exposed).
  const rows = (await fetchExportEligibleAccounts(primaryConn.apiKey, {
    fetchDetailed: fetchDataDoeAccountsDetailed, readOnboardingRows: getAccountOnboardingRows,
    readEstablishedAccountIds: getAccountDirectorySnapshotAccounts,
  })) || [];
  const { active } = classifyDirectoryAccounts(rows, connections);
  const ids = [];
  for (const a of active) {
    const id = String((a && (a.accountId ?? a.id)) || "").trim();
    if (!id || id.startsWith("dd-secondary:")) continue;
    if (bucket && !accountInScope(bucket, String((a && a.country) || ""))) continue;
    ids.push(id);
  }
  // P1-4: PROPAGATE the typed discovery disposition onto the returned id array (non-enumerable, so every existing
  // caller that iterates/.length/.includes is byte-identical). A caller can read ids.discoveryState / ids.deferred to
  // distinguish a genuine deferral (no-authoritative-scope / all-awaiting-onboarding / empty directory) from an
  // empty-after-routing result, instead of collapsing both into "no accounts".
  Object.defineProperties(ids, {
    discoveryState: { value: rows && rows.discoveryState ? rows.discoveryState : (ids.length ? "eligible" : "no-accounts-discovered"), enumerable: false },
    deferred: { value: !!(rows && rows.deferred), enumerable: false },
    discoveredCount: { value: rows && Number.isFinite(rows.discoveredCount) ? rows.discoveredCount : ids.length, enumerable: false },
    eligibleCount: { value: rows && Number.isFinite(rows.eligibleCount) ? rows.eligibleCount : ids.length, enumerable: false },
  });
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
    // Round-7 blocker 1: the DB-backed control-plane owner lease. Called INSIDE the control transaction (after
    // begin()), so each acquire/release is committed/rolled-back atomically WITH the apply/safe-close it guards.
    // acquire => CAS acquire/renew (returns the fencing generation); release => release only if owner; assert =>
    // is-owner; renew (Round-8 blocker 1) => heartbeat that extends the lease ONLY if the caller still holds the
    // EXACT captured fence (owner_token + generation) and it is unexpired, else 'lost'.
    acquireControlLease: async (ownerToken, operationKey, ttlSeconds) =>
      (await q("select public.acquire_control_plane_lease($1, $2, $3::int) as r", [ownerToken, operationKey || "", Number(ttlSeconds) || 900])).rows[0].r,
    // Round-10: the generation is MANDATORY -- a positive safe integer. renew/release/assert REJECT an
    // invalid generation (NULL/undefined/zero/negative/fractional/NaN/string) BEFORE any SQL, so a stale/missing
    // generation can never renew, release, or be asserted as owner (zero SQL side effects).
    renewControlLease: async (ownerToken, generation, ttlSeconds) => {
      if (!(Number.isSafeInteger(generation) && generation > 0)) return { disposition: "lost", reason: "invalid-generation" };
      return (await q("select public.renew_control_plane_lease($1, $2::bigint, $3::int) as r", [ownerToken, Number(generation), Number(ttlSeconds) || 900])).rows[0].r;
    },
    releaseControlLease: async (ownerToken, generation) => {
      if (!(Number.isSafeInteger(generation) && generation > 0)) return { disposition: "not-owner", reason: "invalid-generation" };
      return (await q("select public.release_control_plane_lease($1, $2::bigint) as r", [ownerToken, Number(generation)])).rows[0].r;
    },
    assertControlLeaseOwner: async (ownerToken, generation) => {
      if (!(Number.isSafeInteger(generation) && generation > 0)) return false; // a missing/invalid generation is NEVER the owner
      const r = (await q("select public.read_control_plane_lease() as r")).rows[0].r;
      return !!r && r.held === true && String(r.owner_token) === String(ownerToken) && Number(r.generation) === Number(generation);
    },
    // Round-11 P0-B: ATOMIC ownership verification for the safe-close. Takes the control-plane advisory lock AND
    // a FOR UPDATE row lock on control_plane_lease IN THE CURRENT TRANSACTION, then verifies exact owner_token +
    // generation + unexpired lease UNDER those locks. Both locks are held until the transaction COMMITs/ROLLBACKs,
    // so no acquire/renew/release/reclaim can take over between this verification and the safe-close writes +
    // release + commit (a concurrent lease op blocks on the SAME advisory lock / row lock). Returns true/false.
    lockAndVerifyControlLease: async (ownerToken, generation) => {
      if (!(Number.isSafeInteger(generation) && generation > 0)) return false;
      await q("select pg_advisory_xact_lock(hashtext('control-plane-lease'))");
      // STALE-CLOCK FIX: `held` is computed against clock_timestamp() (the true WALL clock at the moment the row
      // lock is granted), NOT now()/transaction_timestamp() (fixed at BEGIN). The FOR UPDATE can block behind a
      // concurrent lease op; if the lease expired WHILE we waited, `held` is false and the safe-close refuses.
      const r = await q("select owner_token, generation, (expires_at is not null and expires_at > clock_timestamp()) as held from public.control_plane_lease where id = 1 for update");
      const row = r.rows[0];
      return !!row && row.held === true && String(row.owner_token) === String(ownerToken) && Number(row.generation) === Number(generation);
    },
  };
}
