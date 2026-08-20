-- Scheduler v2 -- DURABLE report-derive LEASE + guarded recovery (PREPARED -- UNAPPLIED).
--
-- >>> DO NOT APPLY via `npm run db:migrate` or any bulk apply. This migration is PREPARED for Codex review
-- >>> and is applied ONLY via a reviewed single-file Gate after approval, exactly like the other Scheduler-v2
-- >>> migrations. Migrations 1-6, 20260820 and 20260821 are FROZEN and are NOT modified or reapplied here.
--
-- WHY: the source-first report lineage upserts a sync_report_jobs row pending, claims it pending->running,
-- then shadow-saves + records success. If the shadow-save or the success write times out with commitUnknown,
-- the row is left 'running' and the previous one-attempt claim (a bare PATCH ... WHERE derive_status =
-- 'pending') could NEVER re-acquire it: a fresh invocation saw 'running', lost the claim, and the job stayed
-- open forever (finalize_sync_cycle returned 'open-work' permanently). This adds a durable, concurrency-safe
-- LEASE so a fresh invocation can safely tell pending/running-held/running-stale/complete apart, RECOVER an
-- abandoned claim WITHOUT stealing a live worker's, and RECONCILE to success from the EXACT durable snapshot
-- (no new DataDoe export, no fabricated success):
--   * derive_lease_token / derive_lease_expires_at / derive_attempt_count columns (additive; the
--     20260807-frozen sync_report_jobs is only ALTERed here, never recreated).
--   * claim_report_derive_lease -- a GUARDED, atomic pending|stale-running -> running(with a fresh token)
--     transition under FOR UPDATE. It NEVER steals an unexpired lease ('held'), reports an already-complete
--     job ('already-complete'), and treats failed/skipped as terminal-for-cycle. updated_at is NEVER used as
--     an ownership token -- the lease token + expiry are the sole ownership proof.
--   * reconcile_report_derive_success -- a GUARDED running -> succeeded transition that (a) requires the
--     caller to hold the CURRENT lease token, and (b) requires the EXACT durable shadow snapshot
--     (report_snapshots row for scheduler-v2/<report_key>, this account, this params_hash) to already exist,
--     so a malformed / wrong-account / wrong-hash reconciliation can NEVER authorize success.
-- Adds NO table/RLS/policy (sync_report_jobs is service-role-only from 20260807) and no schedule/cron;
-- SECURITY DEFINER + service_role only, matching the existing Scheduler-v2 RPCs. Applying it enables nothing.

-- ---------------------------------------------------------------------------
-- 1. Additive lease columns on the (frozen-elsewhere) sync_report_jobs table.
-- ---------------------------------------------------------------------------
alter table public.sync_report_jobs
  add column if not exists derive_lease_token uuid,
  add column if not exists derive_lease_expires_at timestamptz,
  add column if not exists derive_attempt_count integer not null default 0;

-- ---------------------------------------------------------------------------
-- 2. claim_report_derive_lease -- guarded pending|stale-running -> running(token); never steals a live lease.
-- ---------------------------------------------------------------------------
create or replace function public.claim_report_derive_lease(
  p_cycle_id uuid, p_report_key text, p_account_id text, p_now timestamptz, p_lease_seconds integer
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.sync_report_jobs;
  v_token uuid;
begin
  if p_now is null or p_lease_seconds is null or p_lease_seconds <= 0 then
    return jsonb_build_object('disposition', 'invalid-lease');
  end if;
  -- Lock the exact (cycle, report, account) row so a concurrent claim/reconcile serializes on it.
  select * into v_job from public.sync_report_jobs
    where cycle_id = p_cycle_id and report_key = p_report_key and account_id = p_account_id
    for update;
  if not found then
    return jsonb_build_object('disposition', 'not-found');
  end if;
  -- Already durably complete: a success/reconcile commit-unknown or an earlier success is OBSERVED, never redone.
  if v_job.validated = true and v_job.derive_status = 'succeeded' and v_job.save_status = 'succeeded' then
    return jsonb_build_object('disposition', 'already-complete', 'snapshot_params_hash', v_job.snapshot_params_hash);
  end if;
  -- Terminal-for-cycle failures/skips are NOT re-claimed within this cycle (a NEW cycle re-derives).
  if v_job.derive_status in ('failed', 'skipped') then
    return jsonb_build_object('disposition', 'terminal', 'derive_status', v_job.derive_status);
  end if;
  if v_job.derive_status = 'pending' then
    v_token := gen_random_uuid();
    update public.sync_report_jobs
      set derive_status = 'running',
          derive_lease_token = v_token,
          derive_lease_expires_at = p_now + make_interval(secs => p_lease_seconds),
          derive_attempt_count = derive_attempt_count + 1
      where cycle_id = p_cycle_id and report_key = p_report_key and account_id = p_account_id;
    return jsonb_build_object('disposition', 'claimed', 'lease_token', v_token);
  end if;
  -- derive_status = 'running': an UNEXPIRED lease is a LIVE worker -- DO NOT STEAL it.
  if v_job.derive_lease_expires_at is not null and v_job.derive_lease_expires_at > p_now then
    return jsonb_build_object('disposition', 'held', 'lease_expires_at', v_job.derive_lease_expires_at);
  end if;
  -- A STALE/expired (or never-set) lease on a running row: GUARDED re-claim with a fresh token.
  v_token := gen_random_uuid();
  update public.sync_report_jobs
    set derive_lease_token = v_token,
        derive_lease_expires_at = p_now + make_interval(secs => p_lease_seconds),
        derive_attempt_count = derive_attempt_count + 1
    where cycle_id = p_cycle_id and report_key = p_report_key and account_id = p_account_id;
  return jsonb_build_object('disposition', 'reclaimed', 'lease_token', v_token, 'attempt', v_job.derive_attempt_count + 1);
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. reconcile_report_derive_success -- guarded running -> succeeded; requires the current lease token AND
--    the EXACT durable shadow snapshot to already exist.
-- ---------------------------------------------------------------------------
create or replace function public.reconcile_report_derive_success(
  p_cycle_id uuid, p_report_key text, p_account_id text, p_snapshot_params_hash text, p_lease_token uuid, p_latest_data_date date
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.sync_report_jobs;
  v_snapshot_exists boolean;
begin
  if p_snapshot_params_hash is null or char_length(btrim(p_snapshot_params_hash)) = 0 then
    return jsonb_build_object('disposition', 'invalid-hash');
  end if;
  if p_lease_token is null then
    return jsonb_build_object('disposition', 'invalid-lease');
  end if;
  select * into v_job from public.sync_report_jobs
    where cycle_id = p_cycle_id and report_key = p_report_key and account_id = p_account_id
    for update;
  if not found then
    return jsonb_build_object('disposition', 'not-found');
  end if;
  -- Idempotent: already reconciled to the EXACT same snapshot identity.
  if v_job.validated = true and v_job.derive_status = 'succeeded' and v_job.save_status = 'succeeded'
     and v_job.snapshot_params_hash = p_snapshot_params_hash then
    return jsonb_build_object('disposition', 'already-complete');
  end if;
  -- BIND reconciliation to the EXACT durable shadow snapshot identity: the report_snapshots row for
  -- scheduler-v2/<report_key>, this account, this params_hash MUST already exist. A malformed /
  -- wrong-account / wrong-hash reconciliation finds no snapshot and can NEVER authorize success.
  select exists (
    select 1 from public.report_snapshots
    where report_key = 'scheduler-v2/' || p_report_key
      and account_id = p_account_id
      and params_hash = p_snapshot_params_hash
  ) into v_snapshot_exists;
  if not v_snapshot_exists then
    return jsonb_build_object('disposition', 'snapshot-absent');
  end if;
  -- Only the CURRENT lease holder may reconcile (guards against a still-active concurrent owner).
  if v_job.derive_lease_token is null or v_job.derive_lease_token <> p_lease_token then
    return jsonb_build_object('disposition', 'lease-lost');
  end if;
  if v_job.derive_status <> 'running' then
    return jsonb_build_object('disposition', 'not-running', 'derive_status', v_job.derive_status);
  end if;
  update public.sync_report_jobs
    set fetch_status = 'ready', derive_status = 'succeeded', save_status = 'succeeded', validated = true,
        snapshot_params_hash = p_snapshot_params_hash,
        latest_data_date = coalesce(p_latest_data_date, latest_data_date),
        last_good_snapshot_at = now(), succeeded_at = now(),
        derive_lease_token = null, derive_lease_expires_at = null,
        error_stage = null, error_code = null, error_message = null
    where cycle_id = p_cycle_id and report_key = p_report_key and account_id = p_account_id;
  return jsonb_build_object('disposition', 'reconciled', 'snapshot_params_hash', p_snapshot_params_hash);
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants -- service_role only, matching the existing Scheduler-v2 RPCs.
-- ---------------------------------------------------------------------------
revoke all on function public.claim_report_derive_lease(uuid, text, text, timestamptz, integer) from public, anon, authenticated;
grant execute on function public.claim_report_derive_lease(uuid, text, text, timestamptz, integer) to service_role;

revoke all on function public.reconcile_report_derive_success(uuid, text, text, text, uuid, date) from public, anon, authenticated;
grant execute on function public.reconcile_report_derive_success(uuid, text, text, text, uuid, date) to service_role;
