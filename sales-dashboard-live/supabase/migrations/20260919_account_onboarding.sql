-- ===========================================================================
-- PRIMARY DataDoe automatic account onboarding -- durable onboarding state (Migration 20260919)
-- ===========================================================================
--
-- ADDITIVE + IDEMPOTENT. Adds ONE table and ONE RPC. Changes no existing table, stores no secret
-- (no API key, no token, no auth material -- only public account/marketplace identity + typed status).
-- Repeated execution is safe. PREPARED, UNAPPLIED (requires explicit approval before db:migrate).
--
-- WHY: the PRIMARY DataDoe directory returns readiness/progress evidence per account
-- (sellerCentralConnection.initialLoadComplete + rowCount), but the app kept no durable onboarding
-- state: a still-loading account was indistinguishable from a ready one, so scheduled runs created
-- paid export attempts that DataDoe rejects with HTTP 400 (proven 2026-09-06: europe-au + us-ca),
-- and a newly-ready account had no owned path from "appears in DataDoe" to "visible + bootstrapped".
--
-- This table is the ONE durable ledger of each PRIMARY account's onboarding lifecycle:
--   discovered            first seen; not yet classified against readiness
--   waiting_for_datadoe   DataDoe initial load still in progress (ZERO paid exports allowed)
--   ready_for_bootstrap   DataDoe readiness proven; awaiting the atomic bootstrap claim
--   bootstrapping         claimed (operation_id set); the regional scheduler backfills its sources
--   partially_ready       some sources bootstrapped + serving; others still pending
--   ready                 fully bootstrapped; a normal scheduled account
--   blocked               cannot proceed (e.g. unsupported/unassigned marketplace); never silently routed
--
-- WRITES: service-role only (the 15-minute discovery worker + release operators). The ATOMIC bootstrap
-- claim goes through the SECURITY DEFINER RPC claim_account_bootstrap so repeated polls, concurrent
-- workers, restarts and watchdogs converge on EXACTLY ONE operation per account claim -- never two.
-- READS: dashboard admins may SELECT (read-only visibility of "Setting up" accounts); anon never.

create table if not exists public.account_onboarding (
  account_id text primary key
    constraint account_onboarding_account_nonblank check (char_length(btrim(account_id)) > 0)
    -- PRIMARY connection only: a raw primary seller id never carries a connection prefix.
    constraint account_onboarding_primary_only check (position(':' in account_id) = 0),
  connection_id text not null default 'primary'
    constraint account_onboarding_connection_primary check (connection_id = 'primary'),
  name text not null default '',
  marketplace_country_code text not null default '',
  marketplace_id text not null default '',
  region text not null default 'unassigned'
    constraint account_onboarding_region_check check (region in ('india', 'europe-au', 'us-ca', 'unassigned')),
  status text not null default 'discovered'
    constraint account_onboarding_status_check check (status in (
      'discovered', 'waiting_for_datadoe', 'ready_for_bootstrap', 'bootstrapping',
      'partially_ready', 'ready', 'blocked')),
  -- DataDoe readiness/progress evidence (preserved, never dropped):
  datadoe_ready boolean not null default false,          -- sellerCentralConnection.initialLoadComplete
  datadoe_row_count bigint,                              -- account-level rowCount (progress proxy)
  seller_central_row_count bigint,                       -- sellerCentralConnection.rowCount
  ads_connected boolean not null default false,          -- amazonAdsConnection present
  ads_ready boolean not null default false,              -- amazonAdsConnection.initialLoadComplete
  ads_row_count bigint,                                  -- amazonAdsConnection.rowCount
  -- Per-source bootstrap status snapshot, e.g. {"oli":{"status":"covered","coveredFrom":"2025-01-01",
  -- "coveredTo":"2026-09-05","checkedAt":"..."}, "campaignAds":{...}, ...}. Typed data only; never a secret.
  sources jsonb not null default '{}'::jsonb,
  failure_code text,                                     -- SAFE typed code only (e.g. UNSUPPORTED_MARKETPLACE)
  operation_id text,                                     -- the claimed bootstrap operation: account-bootstrap/<id>/<date>
  first_discovered_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  ready_at timestamptz,                                  -- when DataDoe readiness was first proven
  bootstrap_started_at timestamptz,
  bootstrap_completed_at timestamptz,
  last_attempt_at timestamptz,
  next_retry_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- A claimed bootstrap MUST carry its operation identity (and vice versa the claim RPC is the only
  -- transition into 'bootstrapping').
  constraint account_onboarding_claim_coherent check (
    (status <> 'bootstrapping') or (operation_id is not null and char_length(btrim(operation_id)) > 0)
  )
);

create index if not exists account_onboarding_status_idx on public.account_onboarding (status, region);

drop trigger if exists account_onboarding_touch on public.account_onboarding;
create trigger account_onboarding_touch before update on public.account_onboarding
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- claim_account_bootstrap -- the ATOMIC once-only bootstrap claim for ONE account.
-- Under an advisory lock it transitions ready_for_bootstrap -> bootstrapping and stamps the ONE
-- operation_id. Repeated polls / concurrent workers / restarts / watchdogs REUSE the recorded
-- operation (idempotent: the same operation_id answers 'already-claimed'); a DIFFERENT operation id
-- while one is held answers 'held' and never overwrites. Returns jsonb:
--   { disposition:'claimed',         account_id, operation_id, status:'bootstrapping' }
--   { disposition:'already-claimed', account_id, operation_id, status }   (same operation; reuse it)
--   { disposition:'held',            account_id, operation_id, status }   (another operation owns it)
--   { disposition:'not-claimable',   account_id, operation_id:null|..., status }  (not ready_for_bootstrap)
--   { disposition:'not-found',       account_id }
-- ---------------------------------------------------------------------------
create or replace function public.claim_account_bootstrap(
  p_account_id text,
  p_operation_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.account_onboarding%rowtype;
begin
  if coalesce(btrim(p_account_id), '') = '' or coalesce(btrim(p_operation_id), '') = '' then
    raise exception 'claim_account_bootstrap requires a non-blank account_id and operation_id';
  end if;

  perform pg_advisory_xact_lock(hashtext('account-bootstrap|' || p_account_id));

  select * into v_row from public.account_onboarding where account_id = p_account_id for update;
  if not found then
    return jsonb_build_object('disposition', 'not-found', 'account_id', p_account_id);
  end if;

  -- Idempotent reuse: the SAME operation already holds this account (any post-claim status).
  if v_row.operation_id is not null and v_row.operation_id = p_operation_id then
    return jsonb_build_object('disposition', 'already-claimed', 'account_id', p_account_id,
      'operation_id', v_row.operation_id, 'status', v_row.status);
  end if;
  -- A DIFFERENT operation holds it: never overwrite, never a second claim.
  if v_row.operation_id is not null then
    return jsonb_build_object('disposition', 'held', 'account_id', p_account_id,
      'operation_id', v_row.operation_id, 'status', v_row.status);
  end if;
  -- Unclaimed: only a readiness-proven account is claimable.
  if v_row.status <> 'ready_for_bootstrap' then
    return jsonb_build_object('disposition', 'not-claimable', 'account_id', p_account_id,
      'operation_id', null, 'status', v_row.status);
  end if;

  update public.account_onboarding
     set operation_id = p_operation_id,
         status = 'bootstrapping',
         bootstrap_started_at = coalesce(bootstrap_started_at, now()),
         last_attempt_at = now(),
         updated_at = now()
   where account_id = p_account_id;

  return jsonb_build_object('disposition', 'claimed', 'account_id', p_account_id,
    'operation_id', p_operation_id, 'status', 'bootstrapping');
end;
$$;

-- ---------------------------------------------------------------------------
-- account_onboarding_dispatch -- the DURABLE, APPEND-ONLY bootstrap-dispatch WAVE ledger.
-- One row per (region, dispatch_id). A WAVE is REGION-LOCAL and IMMUTABLE: its dispatch_id embeds the
-- membership hash of the region's claimed accounts + immutable operation ids, and the row stores that
-- EXACT membership (account_ids + operation_ids + wave_key) as the run's authoritative scope -- the
-- dispatched workflow resolves its account set FROM THIS ROW, never by recomputing membership from
-- current onboarding status. A newly discovered wave is a NEW ROW: it NEVER overwrites a
-- queued/running/failed/completed wave (historical waves are retained; future waves queue behind).
-- AT MOST ONE ACTIVE EXECUTION PER REGION is enforced by a partial unique index over the executing
-- statuses (queued, running) -- multiple historical/awaiting waves may coexist, but only one may run.
-- The lease RPC is the ONLY path into 'queued'; bounded backoff (30m,1h,2h,4h,6h cap) prevents
-- 30-minute dispatch spam while keeping a failed or lease-expired dispatch RETRYABLE.
-- ---------------------------------------------------------------------------
create table if not exists public.account_onboarding_dispatch (
  region text not null
    constraint account_onboarding_dispatch_region_check check (region in ('india', 'europe-au', 'us-ca')),
  dispatch_id text not null
    constraint account_onboarding_dispatch_id_nonblank check (char_length(btrim(dispatch_id)) > 0),
  -- The region-local wave key this dispatch executes (onboarding-wave/<region>/<membership-hash-32>).
  wave_key text not null
    constraint account_onboarding_dispatch_wave_nonblank check (char_length(btrim(wave_key)) > 0),
  -- LIFECYCLE: awaiting-budget (claimed but no authorized wave budget -> the worker NEVER dispatches),
  -- queued (dispatch API accepted; the run has not acknowledged yet), running (the bootstrap run acked
  -- start), failed (the run acked an unsuccessful finish -> retryable after backoff), completed (the run
  -- acked successful scoped publication -- terminal for this dispatch identity).
  status text not null default 'awaiting-budget'
    constraint account_onboarding_dispatch_status_check check (status in ('awaiting-budget', 'queued', 'running', 'failed', 'completed')),
  attempts integer not null default 0 check (attempts >= 0),
  last_attempt_at timestamptz,
  last_error text,                          -- SAFE typed code only (e.g. BOOTSTRAP_DISPATCH_FAILED); never a raw body
  next_retry_at timestamptz,
  -- STALE/LATE-ACK GUARD (Round-5): the running run stamps its OWN run token (github run_id-run_attempt)
  -- here; only that exact token may ack 'completed'/'failed'. A new lease CLEARS it, so a superseded or
  -- expired workflow (whose token was overwritten by a newer running-ack, or cleared by a re-lease) can
  -- never revive/complete the dispatch -- its late ack is a typed 'stale-ack' no-op.
  active_run_token text,
  -- The IMMUTABLE wave scope (trusted evidence, stamped once at creation and NEVER rewritten): the
  -- claimed accounts + their immutable bootstrap operation ids. The bootstrap run loads its exact
  -- account set from here; a mid-run status change (partially_ready/ready) never removes an account.
  account_ids jsonb not null default '[]'::jsonb,
  operation_ids jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (region, dispatch_id)
);

-- AT MOST ONE ACTIVE EXECUTION PER REGION: a second wave can be recorded (awaiting-budget) but can
-- never be queued/running while another wave in the region is.
create unique index if not exists account_onboarding_dispatch_one_active
  on public.account_onboarding_dispatch (region) where status in ('queued', 'running');

drop trigger if exists account_onboarding_dispatch_touch on public.account_onboarding_dispatch;
create trigger account_onboarding_dispatch_touch before update on public.account_onboarding_dispatch
  for each row execute function public.touch_updated_at();

-- mark_onboarding_dispatch_awaiting_budget -- record (durably, idempotently) that a wave is claimed but
-- has NO authorized budget: the worker NEVER leases/dispatches such a wave (zero workflow dispatches,
-- zero DataDoe exports, zero repeated Actions waste). APPEND-ONLY: an existing row for this EXACT
-- (region, dispatch_id) in any later state is left untouched ('unchanged'); rows of OTHER waves are
-- NEVER modified or replaced.
create or replace function public.mark_onboarding_dispatch_awaiting_budget(
  p_region text,
  p_dispatch_id text,
  p_wave_key text,
  p_account_ids jsonb,
  p_operation_ids jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.account_onboarding_dispatch%rowtype;
begin
  if coalesce(btrim(p_region), '') = '' or coalesce(btrim(p_dispatch_id), '') = '' or coalesce(btrim(p_wave_key), '') = '' then
    raise exception 'mark_onboarding_dispatch_awaiting_budget requires a non-blank region, dispatch_id and wave_key';
  end if;
  perform pg_advisory_xact_lock(hashtext('onboarding-dispatch|' || p_region));
  select * into v_row from public.account_onboarding_dispatch
   where region = p_region and dispatch_id = p_dispatch_id for update;
  if found then
    if v_row.status <> 'awaiting-budget' then
      return jsonb_build_object('disposition', 'unchanged', 'status', v_row.status);
    end if;
    return jsonb_build_object('disposition', 'awaiting-budget', 'dispatch_id', p_dispatch_id);
  end if;
  insert into public.account_onboarding_dispatch (region, dispatch_id, wave_key, status, attempts, account_ids, operation_ids)
  values (p_region, p_dispatch_id, p_wave_key, 'awaiting-budget', 0, coalesce(p_account_ids, '[]'::jsonb), coalesce(p_operation_ids, '[]'::jsonb));
  return jsonb_build_object('disposition', 'awaiting-budget', 'dispatch_id', p_dispatch_id);
end;
$$;

-- lease_onboarding_dispatch -- the ATOMIC dispatch lease for ONE region-local wave. Returns jsonb:
--   { disposition:'leased', attempts, dispatch_id }   caller may perform EXACTLY ONE dispatch API call now
--   { disposition:'not-due', status, next_retry_at }  an ACKNOWLEDGED run is queued/running (or a failed
--                                                     one's backoff has not elapsed) -- NEVER redispatch
--   { disposition:'completed', dispatch_id }          this wave already completed; never dispatch again
--   { disposition:'region-busy', active_dispatch_id } ANOTHER wave is queued/running in this region
--                                                     within its lease horizon -- at most one active
--                                                     execution per region; this wave waits
-- A lease is granted ONLY for: a new/awaiting-budget wave (no other active execution), a 'failed' ack
-- whose backoff elapsed, or THIS wave's queued/running row whose lease horizon EXPIRED (a hung run).
-- The stored wave scope (wave_key/account_ids/operation_ids) is IMMUTABLE: a lease on an existing row
-- validates and never rewrites it; a membership change is a NEW (region, dispatch_id) row. Backoff:
-- least(30min * 2^(attempts-1), 6h) from now.
create or replace function public.lease_onboarding_dispatch(
  p_region text,
  p_dispatch_id text,
  p_wave_key text,
  p_account_ids jsonb,
  p_operation_ids jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.account_onboarding_dispatch%rowtype;
  v_row_found boolean;
  v_active public.account_onboarding_dispatch%rowtype;
  v_backoff interval;
begin
  if coalesce(btrim(p_region), '') = '' or coalesce(btrim(p_dispatch_id), '') = '' or coalesce(btrim(p_wave_key), '') = '' then
    raise exception 'lease_onboarding_dispatch requires a non-blank region, dispatch_id and wave_key';
  end if;
  perform pg_advisory_xact_lock(hashtext('onboarding-dispatch|' || p_region));

  select * into v_row from public.account_onboarding_dispatch
   where region = p_region and dispatch_id = p_dispatch_id for update;
  v_row_found := found;

  if v_row_found and v_row.status = 'completed' then
    return jsonb_build_object('disposition', 'completed', 'dispatch_id', v_row.dispatch_id);
  end if;
  -- THIS wave acknowledged/queued within its horizon, or failed inside its backoff: not due.
  if v_row_found and v_row.status in ('queued', 'running', 'failed') and v_row.next_retry_at is not null and v_row.next_retry_at > now() then
    return jsonb_build_object('disposition', 'not-due', 'dispatch_id', v_row.dispatch_id,
      'status', v_row.status, 'attempts', v_row.attempts, 'next_retry_at', v_row.next_retry_at);
  end if;
  -- ONE ACTIVE EXECUTION PER REGION: another wave queued/running within its horizon blocks this one.
  -- (An EXPIRED foreign lease does not block -- but it is marked failed first so the partial unique
  -- index never sees two queued/running rows.)
  select * into v_active from public.account_onboarding_dispatch
   where region = p_region and dispatch_id <> p_dispatch_id and status in ('queued', 'running')
   order by updated_at desc limit 1 for update;
  if found then
    if v_active.next_retry_at is not null and v_active.next_retry_at > now() then
      return jsonb_build_object('disposition', 'region-busy', 'dispatch_id', p_dispatch_id,
        'active_dispatch_id', v_active.dispatch_id, 'active_status', v_active.status);
    end if;
    -- The other wave's lease horizon expired (hung/never-acknowledged run): close it out as failed
    -- (typed, historical -- its own ack can still land later as history) so this wave may execute.
    update public.account_onboarding_dispatch
       set status = 'failed', last_error = 'LEASE_EXPIRED_SUPERSEDED', updated_at = now()
     where region = p_region and dispatch_id = v_active.dispatch_id;
  end if;

  if v_row_found then
    -- THIS wave's row exists and is due (awaiting-budget, failed past backoff, or expired lease).
    -- IMMUTABILITY: the stored scope must match the caller's (the id embeds the membership hash);
    -- account_ids/operation_ids are NEVER rewritten on a lease.
    if v_row.wave_key <> p_wave_key then
      return jsonb_build_object('disposition', 'refused', 'reason', 'WAVE_IDENTITY_MISMATCH', 'dispatch_id', p_dispatch_id);
    end if;
    v_backoff := least(interval '30 minutes' * power(2, v_row.attempts)::int, interval '6 hours');
    -- A new lease is a NEW attempt: CLEAR active_run_token so the prior (possibly still-running,
    -- superseded) workflow's token can no longer ack completed/failed.
    update public.account_onboarding_dispatch
       set attempts = v_row.attempts + 1, status = 'queued', last_attempt_at = now(), next_retry_at = now() + v_backoff,
           active_run_token = null, updated_at = now()
     where region = p_region and dispatch_id = p_dispatch_id;
    return jsonb_build_object('disposition', 'leased', 'dispatch_id', p_dispatch_id, 'attempts', v_row.attempts + 1);
  end if;

  -- A brand-new wave: APPEND a new row at attempt 1 (never touches any other wave's row).
  insert into public.account_onboarding_dispatch (region, dispatch_id, wave_key, status, attempts, last_attempt_at, last_error, next_retry_at, active_run_token, account_ids, operation_ids)
  values (p_region, p_dispatch_id, p_wave_key, 'queued', 1, now(), null, now() + interval '30 minutes', null,
          coalesce(p_account_ids, '[]'::jsonb), coalesce(p_operation_ids, '[]'::jsonb));
  return jsonb_build_object('disposition', 'leased', 'dispatch_id', p_dispatch_id, 'attempts', 1);
end;
$$;

-- ack_onboarding_dispatch -- the scheduler-v2 BOOTSTRAP run's durable acknowledgement, keyed by the
-- EXACT (region, dispatch_id) it was dispatched with. 'running' extends the lease horizon (a live run
-- is never preempted by an expiring lease); 'completed' is TERMINAL and requires the run's scoped
-- publication + read-backs to have succeeded (the workflow acks completed only after the verify
-- operator proves every wave account live -- never on mere absence of work); 'failed' makes the wave
-- retryable after the bounded backoff. Other waves' rows are NEVER touched.
-- STALE/LATE-ACK GUARD (Round-5): p_run_token is the acking workflow's own run token. 'running' STAMPS
-- it (the run taking ownership). 'completed'/'failed' are honored ONLY when the row is currently
-- 'running' AND its active_run_token equals p_run_token -- so a SUPERSEDED or EXPIRED workflow (whose
-- token was overwritten by a newer running-ack, or cleared by a re-lease) can never revive or complete
-- the dispatch: its late ack returns a typed 'stale-ack' no-op.
create or replace function public.ack_onboarding_dispatch(
  p_region text,
  p_dispatch_id text,
  p_phase text,
  p_note text,
  p_run_token text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.account_onboarding_dispatch%rowtype;
  v_backoff interval;
  v_token text;
begin
  if p_phase not in ('running', 'completed', 'failed') then
    raise exception 'ack_onboarding_dispatch phase must be running | completed | failed';
  end if;
  v_token := coalesce(btrim(p_run_token), '');
  if v_token = '' then
    raise exception 'ack_onboarding_dispatch requires a non-blank run_token (stale-ack guard)';
  end if;
  perform pg_advisory_xact_lock(hashtext('onboarding-dispatch|' || p_region));
  select * into v_row from public.account_onboarding_dispatch
   where region = p_region and dispatch_id = p_dispatch_id for update;
  if not found then
    return jsonb_build_object('disposition', 'not-found', 'region', p_region);
  end if;
  if v_row.status = 'completed' then
    return jsonb_build_object('disposition', 'already-completed', 'dispatch_id', v_row.dispatch_id);
  end if;
  if p_phase = 'running' then
    -- CLAIM: only a QUEUED wave (or a RUNNING wave whose token is unset) may be claimed -- the claimer
    -- STAMPS its token and extends the horizon.
    if v_row.status = 'queued' or (v_row.status = 'running' and coalesce(v_row.active_run_token, '') = '') then
      update public.account_onboarding_dispatch
         set status = 'running', active_run_token = v_token, next_retry_at = now() + interval '3 hours', updated_at = now()
       where region = p_region and dispatch_id = p_dispatch_id;
      return jsonb_build_object('disposition', 'acked', 'status', 'running');
    end if;
    -- IDEMPOTENT: the SAME owner re-acking running just refreshes the horizon (token unchanged).
    if v_row.status = 'running' and coalesce(v_row.active_run_token, '') = v_token then
      update public.account_onboarding_dispatch
         set next_retry_at = now() + interval '3 hours', updated_at = now()
       where region = p_region and dispatch_id = p_dispatch_id;
      return jsonb_build_object('disposition', 'acked', 'status', 'running', 'idempotent', true);
    end if;
    -- LEASE-OWNED: a DIFFERENT run holds the running lease -- NEVER overwrite its token (no lease steal).
    -- Only an explicit expired-lease transaction (lease_onboarding_dispatch clearing the token on a new
    -- attempt) may reassign ownership.
    if v_row.status = 'running' then
      return jsonb_build_object('disposition', 'stale-ack', 'reason', 'lease-owned', 'status', v_row.status);
    end if;
    -- Any other state (failed/awaiting-budget): a re-lease must re-queue it first.
    return jsonb_build_object('disposition', 'stale-ack', 'reason', 'not-active', 'status', v_row.status);
  end if;
  -- completed | failed: ONLY the run that currently owns the running lease may finish it.
  if v_row.status <> 'running' or coalesce(v_row.active_run_token, '') <> v_token then
    return jsonb_build_object('disposition', 'stale-ack', 'reason', 'superseded-or-not-owner', 'status', v_row.status);
  end if;
  if p_phase = 'completed' then
    update public.account_onboarding_dispatch
       set status = 'completed', last_error = null, updated_at = now()
     where region = p_region and dispatch_id = p_dispatch_id;
    return jsonb_build_object('disposition', 'acked', 'status', 'completed');
  end if;
  v_backoff := least(interval '30 minutes' * power(2, greatest(v_row.attempts, 1) - 1)::int, interval '6 hours');
  update public.account_onboarding_dispatch
     set status = 'failed', last_error = left(coalesce(p_note, ''), 300), next_retry_at = now() + v_backoff, active_run_token = null, updated_at = now()
   where region = p_region and dispatch_id = p_dispatch_id;
  return jsonb_build_object('disposition', 'acked', 'status', 'failed');
end;
$$;

-- record_onboarding_dispatch_error -- record the SAFE typed error of a failed dispatch API call (the lease's
-- backoff already schedules the bounded retry; this only annotates it). Never resets attempts/backoff.
create or replace function public.record_onboarding_dispatch_error(
  p_region text,
  p_dispatch_id text,
  p_error text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  perform pg_advisory_xact_lock(hashtext('onboarding-dispatch|' || p_region));
  update public.account_onboarding_dispatch
     set last_error = left(coalesce(p_error, ''), 300), updated_at = now()
   where region = p_region and dispatch_id = p_dispatch_id;
  return jsonb_build_object('disposition', case when found then 'recorded' else 'not-found' end);
end;
$$;

-- complete_onboarding_dispatch -- mark ONE wave COMPLETED (every account it covers has GRADUATED to
-- partially_ready/ready on durable snapshot evidence -- the worker's graduation completion; the run's
-- own 'completed' ack is the primary path). Terminal for that (region, dispatch_id).
create or replace function public.complete_onboarding_dispatch(
  p_region text,
  p_dispatch_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  perform pg_advisory_xact_lock(hashtext('onboarding-dispatch|' || p_region));
  update public.account_onboarding_dispatch
     set status = 'completed', updated_at = now()
   where region = p_region and dispatch_id = p_dispatch_id;
  return jsonb_build_object('disposition', case when found then 'completed' else 'not-found' end);
end;
$$;

-- ---------------------------------------------------------------------------
-- account_onboarding_budget -- the DURABLE, ENFORCED paid ceiling for EXACTLY ONE REGION-LOCAL wave.
-- The budget_key embeds the region + the wave's canonical MEMBERSHIP hash (sorted account ids +
-- immutable operation ids + region), so an authorization is bound to exactly those accounts/operations
-- in exactly that region: a newly claimed account changes that region's membership -> a different wave
-- key -> the old authorization can NEVER cover it, and another region's claims never touch this wave.
-- One INSERT per wave (the approval operator; service_role INSERT is granted, so no migration/manual
-- SQL is needed for a future wave), and closing one wave never blocks a separately approved future
-- wave (distinct keys). plan_fingerprint is MANDATORY + non-blank -- the exact fingerprint the
-- dry-run planner generated -- and approved_plan stores that plan's per-step entries
-- ({ step, region, accountSetHash, stepPlanHash, planAsOf, inventoryAsOf, sourceKeys, windows,
--    requestHashes, batchMembership, plannedCreates, plannedTokens }): stepPlanHash binds the FULL
-- approved work (dates, windows, sources, request-plan hashes, batch membership, wave accounts +
-- operation ids), so a reservation with ANY changed parameter -- even at identical token counts -- is
-- refused as PLAN_DRIFT before any create POST.
-- RETRY-SAFE RESERVATIONS: exactly ONE reservation per stable ref (= step/region/stepPlanHash
-- identity) at the APPROVED step ceiling. A retry -- same-day, next-day, after a crash -- reuses that
-- one reservation; CUMULATIVE actual creates/tokens are tracked and a new attempt is refused BEFORE
-- any POST when cumulative actuals + the attempt's plan would exceed the approved step ceiling.
-- ---------------------------------------------------------------------------
create table if not exists public.account_onboarding_budget (
  budget_key text primary key
    constraint account_onboarding_budget_key_nonblank check (char_length(btrim(budget_key)) > 0),
  region text not null
    constraint account_onboarding_budget_region_check check (region in ('india', 'europe-au', 'us-ca')),
  authorized_tokens integer not null check (authorized_tokens > 0),
  plan_fingerprint text not null
    constraint account_onboarding_budget_fp_nonblank check (char_length(btrim(plan_fingerprint)) > 0),
  -- The approved wave membership (audit + validation): sorted account ids / immutable operation ids.
  wave_accounts jsonb not null default '[]'::jsonb,
  wave_operations jsonb not null default '[]'::jsonb,
  -- The approved per-step plan (see the header above; stepPlanHash is the binding validated on reserve).
  approved_plan jsonb not null default '[]'::jsonb,
  status text not null default 'authorized'
    constraint account_onboarding_budget_status_check check (status in ('authorized', 'closed')),
  reserved_tokens integer not null default 0 check (reserved_tokens >= 0),
  spent_tokens integer not null default 0 check (spent_tokens >= 0),
  -- { "<ref>": { "stepType", "region", "accountSetHash", "stepPlanHash", "tokens", "creates",
  --              "actualTokens", "actualCreates" } } -- tokens/creates are the APPROVED step ceiling;
  -- actualTokens/actualCreates ACCUMULATE across every attempt of the step.
  reservations jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint account_onboarding_budget_reserved_within check (reserved_tokens <= authorized_tokens)
);

drop trigger if exists account_onboarding_budget_touch on public.account_onboarding_budget;
create trigger account_onboarding_budget_touch before update on public.account_onboarding_budget
  for each row execute function public.touch_updated_at();

-- reserve_onboarding_spend -- the ATOMIC, DRIFT-VALIDATED pre-POST reservation for ONE bootstrap step.
-- Every reservation carries + validates: wave/budget key, step type + region, the exact account-set
-- hash, the approved plan fingerprint, AND the per-step plan hash (which binds the FULL approved work:
-- dates, windows, source keys, request-plan hashes, batch membership, wave accounts + operation ids).
-- p_tokens/p_creates are THIS ATTEMPT's planned worst-case; the reservation itself holds the APPROVED
-- STEP CEILING (from the approved plan entry), and CUMULATIVE actuals are tracked across attempts.
-- Returns jsonb:
--   { disposition:'reserved',          ref, ceiling_tokens, reserved_tokens, authorized_tokens }
--   { disposition:'already-reserved',  ref, ceiling_tokens, remaining_tokens }   a retry (same-day,
--         next-day, post-crash) REUSES the one reservation -- as long as this attempt's plan fits the
--         remaining headroom (ceiling - cumulative actuals); NO second reservation is ever added.
--   { disposition:'refused', reason:'PLAN_DRIFT'|'BUDGET_EXCEEDED'|'BUDGET_NOT_AUTHORIZED'|'BUDGET_CLOSED' }
-- PLAN_DRIFT (refused BEFORE any POST) when: the fingerprint differs; the (step, region) has no
-- approved entry; the account set differs from the approved entry's; the STEP PLAN HASH differs from the
-- approved entry's (a different date/window/source/batch/membership -- EVEN at identical token counts);
-- or an existing ref is re-reserved with a changed step/region/account-set/stepPlanHash.
-- BUDGET_EXCEEDED (before any POST) when: reserving this step's ceiling would exceed the authorization,
-- OR this attempt's planned spend added to the step's CUMULATIVE actuals would exceed the approved
-- step ceiling (retry-safe: the ceiling is the hard bound, never exceeded across all attempts).
create or replace function public.reserve_onboarding_spend(
  p_budget_key text,
  p_ref text,
  p_step_type text,
  p_region text,
  p_account_set_hash text,
  p_plan_fingerprint text,
  p_step_plan_hash text,
  p_tokens integer,
  p_creates integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.account_onboarding_budget%rowtype;
  v_existing jsonb;
  v_entry jsonb;
  v_ceiling_tokens integer;
  v_ceiling_creates integer;
  v_actual_tokens integer;
  v_actual_creates integer;
begin
  if coalesce(btrim(p_budget_key), '') = '' or coalesce(btrim(p_ref), '') = ''
     or coalesce(btrim(p_step_type), '') = '' or coalesce(btrim(p_region), '') = ''
     or coalesce(btrim(p_account_set_hash), '') = '' or coalesce(btrim(p_plan_fingerprint), '') = ''
     or coalesce(btrim(p_step_plan_hash), '') = '' then
    raise exception 'reserve_onboarding_spend requires non-blank budget_key, ref, step_type, region, account_set_hash, plan_fingerprint and step_plan_hash';
  end if;
  if p_tokens is null or p_tokens < 0 or p_creates is null or p_creates < 0 then
    raise exception 'reserve_onboarding_spend requires non-negative tokens and creates';
  end if;
  perform pg_advisory_xact_lock(hashtext('onboarding-budget|' || p_budget_key));

  select * into v_row from public.account_onboarding_budget where budget_key = p_budget_key for update;
  if not found then
    return jsonb_build_object('disposition', 'refused', 'reason', 'BUDGET_NOT_AUTHORIZED', 'ref', p_ref);
  end if;
  if v_row.status <> 'authorized' then
    return jsonb_build_object('disposition', 'refused', 'reason', 'BUDGET_CLOSED', 'ref', p_ref);
  end if;
  if v_row.plan_fingerprint <> p_plan_fingerprint then
    return jsonb_build_object('disposition', 'refused', 'reason', 'PLAN_DRIFT', 'detail', 'plan-fingerprint-mismatch', 'ref', p_ref);
  end if;

  -- The APPROVED plan entry for (step, region) is the authoritative ceiling + binding. Required always.
  select entry into v_entry
    from jsonb_array_elements(v_row.approved_plan) as entry
   where entry ->> 'step' = p_step_type and entry ->> 'region' = p_region
   limit 1;
  if v_entry is null then
    return jsonb_build_object('disposition', 'refused', 'reason', 'PLAN_DRIFT', 'detail', 'step-not-in-approved-plan', 'ref', p_ref);
  end if;
  if (v_entry ->> 'accountSetHash') <> p_account_set_hash then
    return jsonb_build_object('disposition', 'refused', 'reason', 'PLAN_DRIFT', 'detail', 'account-set-mismatch', 'ref', p_ref);
  end if;
  -- P0-3: the step plan hash binds the exact dates/windows/sources/batches. ANY change is drift, even at
  -- identical token counts.
  if (v_entry ->> 'stepPlanHash') <> p_step_plan_hash then
    return jsonb_build_object('disposition', 'refused', 'reason', 'PLAN_DRIFT', 'detail', 'step-plan-hash-mismatch', 'ref', p_ref);
  end if;
  v_ceiling_tokens := (v_entry ->> 'plannedTokens')::int;
  v_ceiling_creates := (v_entry ->> 'plannedCreates')::int;
  -- This attempt's plan may never exceed the approved step ceiling (a bigger attempt is drift).
  if p_tokens > v_ceiling_tokens or p_creates > v_ceiling_creates then
    return jsonb_build_object('disposition', 'refused', 'reason', 'PLAN_DRIFT', 'detail', 'exceeds-approved-step-plan', 'ref', p_ref);
  end if;

  v_existing := v_row.reservations -> p_ref;
  if v_existing is not null then
    -- RETRY (same-day / next-day / post-crash): the stable ref reuses ONE reservation. The identity
    -- fields must match exactly; a changed step/region/account-set/stepPlanHash is drift.
    if (v_existing ->> 'stepType') <> p_step_type or (v_existing ->> 'region') <> p_region
       or (v_existing ->> 'accountSetHash') <> p_account_set_hash
       or coalesce(v_existing ->> 'stepPlanHash', '') <> p_step_plan_hash then
      return jsonb_build_object('disposition', 'refused', 'reason', 'PLAN_DRIFT', 'detail', 'existing-ref-field-mismatch', 'ref', p_ref);
    end if;
    v_actual_tokens := coalesce((v_existing ->> 'actualTokens')::int, 0);
    v_actual_creates := coalesce((v_existing ->> 'actualCreates')::int, 0);
    -- CUMULATIVE ceiling: this attempt's plan + everything already spent must stay within the approved
    -- step ceiling (refused BEFORE any POST).
    if v_actual_tokens + p_tokens > v_ceiling_tokens or v_actual_creates + p_creates > v_ceiling_creates then
      return jsonb_build_object('disposition', 'refused', 'reason', 'BUDGET_EXCEEDED', 'ref', p_ref,
        'ceiling_tokens', v_ceiling_tokens, 'actual_tokens', v_actual_tokens, 'attempt_tokens', p_tokens);
    end if;
    return jsonb_build_object('disposition', 'already-reserved', 'ref', p_ref,
      'ceiling_tokens', v_ceiling_tokens, 'remaining_tokens', v_ceiling_tokens - v_actual_tokens,
      'reserved_tokens', v_row.reserved_tokens, 'authorized_tokens', v_row.authorized_tokens);
  end if;

  -- FIRST reservation of this step: reserve the APPROVED CEILING (so the sum of every step's ceiling
  -- can never exceed the authorization). The attempt's plan already fits (checked above).
  if v_row.reserved_tokens + v_ceiling_tokens > v_row.authorized_tokens then
    return jsonb_build_object('disposition', 'refused', 'reason', 'BUDGET_EXCEEDED', 'ref', p_ref,
      'ceiling_tokens', v_ceiling_tokens, 'reserved_tokens', v_row.reserved_tokens, 'authorized_tokens', v_row.authorized_tokens);
  end if;
  update public.account_onboarding_budget
     set reserved_tokens = reserved_tokens + v_ceiling_tokens,
         reservations = reservations || jsonb_build_object(p_ref, jsonb_build_object(
           'stepType', p_step_type, 'region', p_region, 'accountSetHash', p_account_set_hash,
           'stepPlanHash', p_step_plan_hash, 'tokens', v_ceiling_tokens, 'creates', v_ceiling_creates,
           'actualTokens', 0, 'actualCreates', 0)),
         updated_at = now()
   where budget_key = p_budget_key;
  return jsonb_build_object('disposition', 'reserved', 'ref', p_ref, 'ceiling_tokens', v_ceiling_tokens,
    'reserved_tokens', v_row.reserved_tokens + v_ceiling_tokens, 'authorized_tokens', v_row.authorized_tokens);
end;
$$;

-- record_onboarding_spend_actual -- record ONE attempt's ACTUAL creates/tokens after its run. Actuals
-- ACCUMULATE across attempts (crash-after-partial-spend, same-day retry, next-day retry all add into the
-- one reservation's cumulative counters). spent_tokens re-aggregates the cumulative actuals of all refs.
-- Cumulative actuals ABOVE the step ceiling are NEVER silent: still recorded (the truth), but the
-- disposition is 'over-reservation' with the ceiling vs cumulative values so the caller must surface it.
create or replace function public.record_onboarding_spend_actual(
  p_budget_key text,
  p_ref text,
  p_actual_tokens integer,
  p_actual_creates integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.account_onboarding_budget%rowtype;
  v_reservation jsonb;
  v_cum_tokens integer;
  v_cum_creates integer;
  v_spent integer;
  v_over boolean;
begin
  perform pg_advisory_xact_lock(hashtext('onboarding-budget|' || p_budget_key));
  select * into v_row from public.account_onboarding_budget where budget_key = p_budget_key for update;
  if not found then
    return jsonb_build_object('disposition', 'not-found', 'ref', p_ref);
  end if;
  v_reservation := v_row.reservations -> p_ref;
  if v_reservation is null then
    return jsonb_build_object('disposition', 'not-reserved', 'ref', p_ref);
  end if;
  -- ACCUMULATE this attempt's actuals onto the running cumulative (never last-write-wins).
  v_cum_tokens := coalesce((v_reservation ->> 'actualTokens')::int, 0) + coalesce(p_actual_tokens, 0);
  v_cum_creates := coalesce((v_reservation ->> 'actualCreates')::int, 0) + coalesce(p_actual_creates, 0);
  v_over := v_cum_tokens > (v_reservation ->> 'tokens')::int
         or v_cum_creates > (v_reservation ->> 'creates')::int;
  update public.account_onboarding_budget
     set reservations = jsonb_set(reservations, array[p_ref], (reservations -> p_ref)
           || jsonb_build_object('actualTokens', v_cum_tokens, 'actualCreates', v_cum_creates)),
         updated_at = now()
   where budget_key = p_budget_key;
  select coalesce(sum(coalesce((value ->> 'actualTokens')::int, 0)), 0) into v_spent
    from jsonb_each((select reservations from public.account_onboarding_budget where budget_key = p_budget_key));
  update public.account_onboarding_budget set spent_tokens = v_spent, updated_at = now() where budget_key = p_budget_key;
  if v_over then
    return jsonb_build_object('disposition', 'over-reservation', 'ref', p_ref, 'spent_tokens', v_spent,
      'ceiling_tokens', (v_reservation ->> 'tokens')::int, 'ceiling_creates', (v_reservation ->> 'creates')::int,
      'cumulative_tokens', v_cum_tokens, 'cumulative_creates', v_cum_creates);
  end if;
  return jsonb_build_object('disposition', 'recorded', 'ref', p_ref, 'spent_tokens', v_spent,
    'cumulative_tokens', v_cum_tokens, 'cumulative_creates', v_cum_creates);
end;
$$;

alter table public.account_onboarding enable row level security;
drop policy if exists account_onboarding_admin_read on public.account_onboarding;
create policy account_onboarding_admin_read on public.account_onboarding
  for select to authenticated using (public.is_dashboard_admin());

alter table public.account_onboarding_dispatch enable row level security;
drop policy if exists account_onboarding_dispatch_admin_read on public.account_onboarding_dispatch;
create policy account_onboarding_dispatch_admin_read on public.account_onboarding_dispatch
  for select to authenticated using (public.is_dashboard_admin());

alter table public.account_onboarding_budget enable row level security;
drop policy if exists account_onboarding_budget_admin_read on public.account_onboarding_budget;
create policy account_onboarding_budget_admin_read on public.account_onboarding_budget
  for select to authenticated using (public.is_dashboard_admin());

-- Least-privilege ACL: strip default-privilege grants; the discovery worker (service_role) may read +
-- upsert rows, but the bootstrapping transition is RPC-only (no direct service-role UPDATE can create a
-- second claim because the RPC's advisory lock + operation_id guard is the only 'claimed' path we call;
-- direct writes are for discovery/status fields). No DELETE for anyone: onboarding history is retained.
revoke all on table public.account_onboarding from public, anon, authenticated, service_role;
grant select on table public.account_onboarding to authenticated;
grant select, insert, update on table public.account_onboarding to service_role;
revoke all on function public.claim_account_bootstrap(text, text) from public, anon, authenticated;
grant execute on function public.claim_account_bootstrap(text, text) to service_role;

-- Dispatch lifecycle: SELECT for admins + service_role; every WRITE goes through the SECURITY DEFINER
-- RPCs (the lease is the only path into 'queued', so no direct write can mint a second lease; the run's
-- own ack RPC is the only path into 'running'/'completed').
revoke all on table public.account_onboarding_dispatch from public, anon, authenticated, service_role;
grant select on table public.account_onboarding_dispatch to authenticated;
grant select on table public.account_onboarding_dispatch to service_role;
revoke all on function public.lease_onboarding_dispatch(text, text, text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.lease_onboarding_dispatch(text, text, text, jsonb, jsonb) to service_role;
revoke all on function public.mark_onboarding_dispatch_awaiting_budget(text, text, text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.mark_onboarding_dispatch_awaiting_budget(text, text, text, jsonb, jsonb) to service_role;
revoke all on function public.ack_onboarding_dispatch(text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.ack_onboarding_dispatch(text, text, text, text, text) to service_role;
revoke all on function public.record_onboarding_dispatch_error(text, text, text) from public, anon, authenticated;
grant execute on function public.record_onboarding_dispatch_error(text, text, text) to service_role;
revoke all on function public.complete_onboarding_dispatch(text, text) from public, anon, authenticated;
grant execute on function public.complete_onboarding_dispatch(text, text) to service_role;

-- Wave budget: service_role may SELECT and INSERT the authorization row (written only by the explicit
-- approval operator); reservations/actuals go through the two SECURITY DEFINER RPCs, so no direct write
-- can bypass the ceiling. No UPDATE/DELETE grant: a recorded authorization is never silently rewritten.
revoke all on table public.account_onboarding_budget from public, anon, authenticated, service_role;
grant select on table public.account_onboarding_budget to authenticated;
grant select, insert on table public.account_onboarding_budget to service_role;
revoke all on function public.reserve_onboarding_spend(text, text, text, text, text, text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.reserve_onboarding_spend(text, text, text, text, text, text, text, integer, integer) to service_role;
revoke all on function public.record_onboarding_spend_actual(text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.record_onboarding_spend_actual(text, text, integer, integer) to service_role;

-- ---------------------------------------------------------------------------
-- WAVE-BOUND BOOTSTRAP-PUBLICATION CYCLE NAMESPACE (Round-5 correction). A scoped bootstrap publication
-- derives + finalizes the Daily Reporting + Brand View + brand-inventory shadow snapshots for EXACTLY its
-- wave accounts over a DEDICATED, PER-WAVE sync_cycles bucket -- bootstrap-<region>-<membership-hash-16>
-- (the hash is the dispatch identity's own membership hash) -- so:
--   * two DIFFERENT waves in the SAME region on the SAME cycle_date get DISTINCT base cycles (a wave can
--     never adopt or be blocked by another wave's terminal cycle), and
--   * a RETRY of the SAME dispatch reuses ITS OWN cycle (same membership hash => same bucket => the
--     on-conflict base-cycle re-adoption), while a DIFFERENT dispatch never reuses it.
-- The bucket value is NOT arbitrary: it is CHECK-CONSTRAINED to the exact pattern
-- ^bootstrap(-fba)?-(india|europe-au|us-ca)-[0-9a-f]{16}$ (a reviewed schema identity: the plain form
-- for the scoped Daily/Brand publication cycle, the -fba form for the scoped FBA inventory cycle), and
-- open_sync_cycle enforces the same pattern. The natural (region, cycle_date) + <region>-fba daily
-- cycles are never touched.
-- Idempotent (drop-if-exists + replace). NOTE: the ~ regex operator requires the constraint be a plain
-- boolean expression (it is).
-- ---------------------------------------------------------------------------
alter table public.sync_cycles drop constraint if exists sync_cycles_bucket_check;
alter table public.sync_cycles
  add constraint sync_cycles_bucket_check
  check (
    bucket in ('us','non-us','us-fba','non-us-fba','india','europe-au','us-ca','india-fba','europe-au-fba','us-ca-fba','listing-health-v3-india','listing-health-v3-europe-au','listing-health-v3-us-ca')
    or bucket ~ '^bootstrap(-fba)?-(india|europe-au|us-ca)-[0-9a-f]{16}$'
  );

create or replace function public.open_sync_cycle(
  p_bucket text,
  p_cycle_date date,
  p_scheduled_at timestamptz default null,
  p_trigger text default 'pg_cron'
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if not (
    p_bucket in ('us','non-us','us-fba','non-us-fba','india','europe-au','us-ca','india-fba','europe-au-fba','us-ca-fba','listing-health-v3-india','listing-health-v3-europe-au','listing-health-v3-us-ca')
    or p_bucket ~ '^bootstrap(-fba)?-(india|europe-au|us-ca)-[0-9a-f]{16}$'
  ) then
    raise exception 'Invalid bucket %', p_bucket;
  end if;

  insert into public.sync_cycles (bucket, cycle_date, scheduled_at, trigger, status, attempt_kind)
  values (p_bucket, p_cycle_date, p_scheduled_at, coalesce(p_trigger, 'pg_cron'), 'pending', 'base')
  on conflict (bucket, cycle_date) where supersedes_cycle_id is null do update set updated_at = now()
  returning id into v_id;

  return v_id;
end;
$$;
revoke all on function public.open_sync_cycle(text, date, timestamptz, text) from public, anon, authenticated;
grant execute on function public.open_sync_cycle(text, date, timestamptz, text) to service_role;

-- ---------------------------------------------------------------------------
-- (Round-7 blocker 3) The account_onboarding_unavailable table + record_onboarding_unavailable RPC were
-- REMOVED as a dead/misleading path: the fba-plan derivation NEVER self-declares "source unavailable" -- an
-- empty validated D-1 inventory is an HONEST VALID snapshot (inventoryAvailable:false) that PUBLISHES (and so
-- earns a publication-manifest identity like every other report), while a missing/failed/truncated/malformed
-- source THROWS in derive (blocked -> last-known-good preserved -> the wave stays incomplete and retries).
-- Completion is therefore proven ONLY by the publication manifest below (no typed-unavailable fallback).
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- account_onboarding_publication -- the DURABLE MANIFEST of the EXACT live identities a bootstrap wave
-- PRODUCED (Round-6 blocker 7 + Round-7 blocker 2 PROVENANCE). One row per (region, dispatch, account,
-- report_key) with the EXACT live params_hash + coversAsOf AND the ACTUAL durable cycle_id + operation_key
-- + the ACTIVE run_token that produced it. Provenance is CONSTRAINED at the DB boundary (unapplied migration,
-- so it is safe to add FKs/checks):
--   * a FOREIGN KEY to account_onboarding_dispatch (region, dispatch_id) rejects an UNKNOWN dispatch;
--   * the recording RPC rejects blank cycle_id/operation_key/run_token, a cycle_id that is a bucket LABEL
--     (^bootstrap...), an account OUTSIDE the dispatch's frozen membership, and a run_token that is not the
--     dispatch's CURRENT active_run_token (a stale/superseded/foreign attempt can never write or overwrite).
-- The completion proof reads THIS manifest, requires the run_token to equal the dispatch's active token, and
-- re-reads each live snapshot by its EXACT (report_key, account, params_hash) identity -- never the newest.
-- Additive; service-role write; admin read.
-- ---------------------------------------------------------------------------
create table if not exists public.account_onboarding_publication (
  region text not null
    constraint account_onboarding_publication_region_check check (region in ('india', 'europe-au', 'us-ca')),
  dispatch_id text not null
    constraint account_onboarding_publication_dispatch_nonblank check (char_length(btrim(dispatch_id)) > 0),
  account_id text not null
    constraint account_onboarding_publication_account_nonblank check (char_length(btrim(account_id)) > 0),
  report_key text not null
    constraint account_onboarding_publication_report_nonblank check (char_length(btrim(report_key)) > 0),
  params_hash text not null
    constraint account_onboarding_publication_hash_nonblank check (char_length(btrim(params_hash)) > 0),
  covers_asof date not null,
  -- PROVENANCE (Round-8 blocker 3): the ACTUAL durable cycle id is a REAL sync_cycles.id (uuid, FK-enforced --
  -- an arbitrary/nonexistent id can never be stored), the operation identity, and the ACTIVE run token
  -- (github run_id-run_attempt) the recording attempt owned. cycle_id being uuid makes a bucket LABEL
  -- structurally impossible.
  cycle_id uuid not null,
  operation_key text not null default ''
    constraint account_onboarding_publication_operation_nonblank check (char_length(btrim(operation_key)) > 0),
  run_token text not null default ''
    constraint account_onboarding_publication_runtoken_nonblank check (char_length(btrim(run_token)) > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (region, dispatch_id, account_id, report_key),
  -- An UNKNOWN dispatch can never carry a manifest row (the wave identity must exist).
  constraint account_onboarding_publication_dispatch_fk
    foreign key (region, dispatch_id) references public.account_onboarding_dispatch (region, dispatch_id),
  -- The cycle_id MUST be a real durable sync_cycles row (an arbitrary uuid fails the FK).
  constraint account_onboarding_publication_cycle_fk
    foreign key (cycle_id) references public.sync_cycles (id)
);

drop trigger if exists account_onboarding_publication_touch on public.account_onboarding_publication;
create trigger account_onboarding_publication_touch before update on public.account_onboarding_publication
  for each row execute function public.touch_updated_at();

-- record_onboarding_publication -- upsert ONE manifest row (idempotent by identity), but ONLY with proven
-- provenance for the CURRENT dispatch attempt (Round-8 blocker 3). Rejects: blank cycle_id/operation_key/
-- run_token; a p_cycle_id that is not a valid uuid OR does not resolve to a REAL sync_cycles row (arbitrary
-- values fail); a cycle whose BUCKET is not the expected BOOTSTRAP bucket for this region OR whose CYCLE_DATE
-- is not the covered D-1; an unknown dispatch; an account outside the dispatch's frozen membership; a run_token
-- that is not the dispatch's active_run_token. So an arbitrary/foreign/stale cycle or attempt can neither
-- complete nor OVERWRITE the active attempt's manifest.
create or replace function public.record_onboarding_publication(
  p_region text,
  p_dispatch_id text,
  p_account_id text,
  p_report_key text,
  p_params_hash text,
  p_covers_asof date,
  p_cycle_id text,
  p_cycle_bucket text,
  p_operation_key text,
  p_run_token text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.account_onboarding_dispatch%rowtype;
  v_cyc public.sync_cycles%rowtype;
  v_token text := coalesce(btrim(p_run_token), '');
  v_bucket text := coalesce(btrim(p_cycle_bucket), '');
  v_cycle_uuid uuid;
begin
  if coalesce(btrim(p_region), '') = '' or coalesce(btrim(p_dispatch_id), '') = ''
     or coalesce(btrim(p_account_id), '') = '' or coalesce(btrim(p_report_key), '') = ''
     or coalesce(btrim(p_params_hash), '') = '' or p_covers_asof is null then
    raise exception 'record_onboarding_publication requires region, dispatch_id, account_id, report_key, params_hash and covers_asof';
  end if;
  if coalesce(btrim(p_cycle_id), '') = '' or v_bucket = '' or coalesce(btrim(p_operation_key), '') = '' or v_token = '' then
    raise exception 'record_onboarding_publication requires a non-blank cycle_id, cycle_bucket, operation_key and run_token (provenance)';
  end if;
  -- The cycle id must be a valid uuid (arbitrary strings fail here) AND the claimed bucket must be a BOOTSTRAP
  -- bucket for THIS region.
  begin v_cycle_uuid := btrim(p_cycle_id)::uuid; exception when others then
    raise exception 'record_onboarding_publication cycle_id must be a durable cycle uuid (got %)', p_cycle_id; end;
  if v_bucket !~ ('^bootstrap(-fba)?-' || p_region || '-[0-9a-f]{16}$') then
    raise exception 'record_onboarding_publication cycle_bucket must be a bootstrap bucket for region % (got %)', p_region, v_bucket;
  end if;
  -- The cycle must be a REAL sync_cycles row whose bucket + cycle_date match the expected bootstrap bucket/D-1.
  select * into v_cyc from public.sync_cycles where id = v_cycle_uuid;
  if not found then
    raise exception 'record_onboarding_publication cycle % does not exist in sync_cycles', v_cycle_uuid;
  end if;
  if v_cyc.bucket <> v_bucket then
    raise exception 'record_onboarding_publication cycle % belongs to bucket %, not the expected %', v_cycle_uuid, v_cyc.bucket, v_bucket;
  end if;
  if v_cyc.cycle_date <> p_covers_asof then
    raise exception 'record_onboarding_publication cycle % is for date %, not the covered %', v_cycle_uuid, v_cyc.cycle_date, p_covers_asof;
  end if;
  -- Bind to the CURRENT dispatch attempt: the wave must exist, the account must be in its frozen membership,
  -- and the run_token must own the active lease.
  select * into v_row from public.account_onboarding_dispatch where region = p_region and dispatch_id = p_dispatch_id;
  if not found then
    raise exception 'record_onboarding_publication unknown dispatch %/%', p_region, p_dispatch_id;
  end if;
  if not (btrim(p_account_id) in (select jsonb_array_elements_text(v_row.account_ids))) then
    raise exception 'record_onboarding_publication account % is outside the frozen membership of dispatch %/%', p_account_id, p_region, p_dispatch_id;
  end if;
  if coalesce(v_row.active_run_token, '') <> v_token then
    return jsonb_build_object('disposition', 'stale-run-token', 'reason', 'not-active-attempt', 'account_id', p_account_id, 'report_key', p_report_key);
  end if;
  insert into public.account_onboarding_publication (region, dispatch_id, account_id, report_key, params_hash, covers_asof, cycle_id, operation_key, run_token)
  values (p_region, p_dispatch_id, p_account_id, p_report_key, btrim(p_params_hash), p_covers_asof, v_cycle_uuid, left(btrim(p_operation_key), 200), v_token)
  on conflict (region, dispatch_id, account_id, report_key) do update
    set params_hash = excluded.params_hash, covers_asof = excluded.covers_asof,
        cycle_id = excluded.cycle_id, operation_key = excluded.operation_key, run_token = excluded.run_token, updated_at = now();
  return jsonb_build_object('disposition', 'recorded', 'account_id', p_account_id, 'report_key', p_report_key);
end;
$$;

alter table public.account_onboarding_publication enable row level security;
drop policy if exists account_onboarding_publication_admin_read on public.account_onboarding_publication;
create policy account_onboarding_publication_admin_read on public.account_onboarding_publication
  for select to authenticated using (public.is_dashboard_admin());
revoke all on table public.account_onboarding_publication from public, anon, authenticated, service_role;
grant select on table public.account_onboarding_publication to authenticated;
grant select on table public.account_onboarding_publication to service_role;
revoke all on function public.record_onboarding_publication(text, text, text, text, text, date, text, text, text, text) from public, anon, authenticated;
grant execute on function public.record_onboarding_publication(text, text, text, text, text, date, text, text, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- control_plane_lease -- the SINGLE GLOBAL publication CONTROL-PLANE owner lease (Round-7 blocker 1,
-- CONTROL-PLANE RACE). The report publish controls (scheduler_account_rollout / report_sync_settings /
-- source_promoted_publish_settings / scheduler_publish_approvals) are ONE global resource: the guarded
-- transaction reconciles the COMPLETE global set (apply) and safe-CLOSES every control (rollback). With
-- scheduler-v2's PER-REGION concurrency, plus the NON-GitHub Data Sync Center route (api/admin/sources.js)
-- and manual operators, TWO control-plane operations can run at once -- so one region's apply/close would
-- overwrite/close another owner's controls. GitHub concurrency alone is insufficient (it is per-region and
-- does not cover the route/manual callers). This owner-token lease/CAS SERIALIZES the global control plane:
-- every control-plane caller (bootstrap + natural scheduler, FBA + priority publication, retries, watchdogs,
-- manual + route) acquires it before apply and holds it through publish + safe-close; a concurrent/foreign
-- operation cannot acquire, so it can never overwrite or close the owner's controls. A TTL reclaims a crashed
-- owner; only the OWNER (or an expiry) can release. Idempotent owner replay (same token re-acquires/renews).
-- ---------------------------------------------------------------------------
create table if not exists public.control_plane_lease (
  id smallint primary key default 1 constraint control_plane_lease_singleton check (id = 1),
  owner_token text not null default '',
  operation_key text not null default '',
  -- Round-8 blocker 1: a MONOTONIC fencing generation. It increments on every NEW grant (a free/expired lease
  -- reclaimed, or a takeover by a different owner), and is UNCHANGED on an idempotent same-owner renew. A
  -- publisher captures (owner_token, generation) at apply and must renew that EXACT fence before each publish
  -- chunk; once a reclaimed owner's generation is superseded it can NEVER write with stale authorization.
  generation bigint not null default 0,
  acquired_at timestamptz,
  expires_at timestamptz,
  updated_at timestamptz not null default now()
);
insert into public.control_plane_lease (id, owner_token) values (1, '') on conflict (id) do nothing;

drop trigger if exists control_plane_lease_touch on public.control_plane_lease;
create trigger control_plane_lease_touch before update on public.control_plane_lease
  for each row execute function public.touch_updated_at();

-- acquire_control_plane_lease -- CAS acquire/renew. Grants to p_owner_token when the lease is FREE (blank
-- owner) OR EXPIRED OR already owned by p_owner_token (idempotent renew); otherwise returns held-by-another
-- WITHOUT changing ownership. Serialized by a dedicated advisory lock so two acquirers cannot both win.
create or replace function public.acquire_control_plane_lease(
  p_owner_token text,
  p_operation_key text,
  p_ttl_seconds int
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.control_plane_lease%rowtype;
  v_token text := coalesce(btrim(p_owner_token), '');
  v_ttl int := least(greatest(coalesce(p_ttl_seconds, 900), 30), 3600);
  -- STALE-CLOCK FIX: now()/transaction_timestamp() is fixed at transaction start; the advisory + FOR UPDATE
  -- locks below can BLOCK for a long time. Sample v_now from clock_timestamp() ONLY AFTER those locks are held,
  -- so every expiry decision and every new lease timestamp uses the true post-wait wall clock.
  v_now timestamptz;
  v_free boolean;
begin
  if v_token = '' then
    raise exception 'acquire_control_plane_lease requires a non-blank owner_token (fail closed)';
  end if;
  perform pg_advisory_xact_lock(hashtext('control-plane-lease'));
  select * into v_row from public.control_plane_lease where id = 1 for update;
  v_now := clock_timestamp(); -- post-lock wall clock (never the stale transaction_timestamp)
  if not found then
    insert into public.control_plane_lease (id, owner_token, operation_key, generation, acquired_at, expires_at)
    values (1, v_token, left(coalesce(p_operation_key, ''), 200), 1, v_now, v_now + make_interval(secs => v_ttl));
    return jsonb_build_object('disposition', 'acquired', 'owner_token', v_token, 'generation', 1, 'ttl_seconds', v_ttl);
  end if;
  v_free := coalesce(btrim(v_row.owner_token), '') = '' or v_row.expires_at is null or v_row.expires_at <= v_now;
  if v_free or v_row.owner_token = v_token then
    -- NEW GRANT (free/expired reclaim, or a takeover) bumps the fencing generation; an idempotent same-owner
    -- renew of a LIVE lease keeps it (the fence a live owner already captured stays valid).
    declare v_same_owner_live boolean := (v_row.owner_token = v_token and not v_free);
            v_gen bigint := case when v_same_owner_live then v_row.generation else v_row.generation + 1 end;
    begin
      update public.control_plane_lease
         set owner_token = v_token, operation_key = left(coalesce(p_operation_key, ''), 200), generation = v_gen,
             acquired_at = case when v_same_owner_live then v_row.acquired_at else v_now end,
             expires_at = v_now + make_interval(secs => v_ttl), updated_at = v_now
       where id = 1;
      return jsonb_build_object('disposition', 'acquired', 'owner_token', v_token, 'generation', v_gen,
        'ttl_seconds', v_ttl, 'renewed', v_same_owner_live);
    end;
  end if;
  return jsonb_build_object('disposition', 'held', 'owner_token', v_row.owner_token,
    'operation_key', v_row.operation_key, 'generation', v_row.generation, 'expires_at', v_row.expires_at);
end;
$$;

-- renew_control_plane_lease -- the HEARTBEAT (Round-8 blocker 1). Extend the lease ONLY when the caller still
-- holds the EXACT fence it captured at apply: same owner_token, same generation, and NOT YET expired. A lease
-- that already expired is UN-renewable (the owner was too slow -- it must stop and let a reclaim take over);
-- a lease reclaimed by another owner (owner/generation changed) is 'lost'. So a slow/stale owner can never keep
-- writing after losing exclusivity. Callers renew BEFORE expiry and BEFORE each bounded publish chunk.
create or replace function public.renew_control_plane_lease(
  p_owner_token text,
  p_generation bigint,
  p_ttl_seconds int
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.control_plane_lease%rowtype;
  v_token text := coalesce(btrim(p_owner_token), '');
  v_ttl int := least(greatest(coalesce(p_ttl_seconds, 900), 30), 3600);
  -- STALE-CLOCK FIX: sample the clock AFTER the (blocking) advisory + FOR UPDATE locks, so a lease that expired
  -- WHILE THIS RENEW WAITED is correctly seen as expired and rejected (never extended on a stale start-time clock).
  v_now timestamptz;
begin
  if v_token = '' then
    return jsonb_build_object('disposition', 'lost', 'reason', 'blank-token');
  end if;
  -- Round-10: the generation is MANDATORY (a positive bigint). NULL / <= 0 is a fail-closed 'lost' -- never
  -- a bypass of the fence.
  if p_generation is null or p_generation <= 0 then
    return jsonb_build_object('disposition', 'lost', 'reason', 'invalid-generation');
  end if;
  perform pg_advisory_xact_lock(hashtext('control-plane-lease'));
  select * into v_row from public.control_plane_lease where id = 1 for update;
  v_now := clock_timestamp(); -- post-lock wall clock (never the stale transaction_timestamp)
  if not found then
    return jsonb_build_object('disposition', 'lost', 'reason', 'no-lease');
  end if;
  if v_row.owner_token <> v_token then
    return jsonb_build_object('disposition', 'lost', 'reason', 'owner-changed', 'owner_token', v_row.owner_token, 'generation', v_row.generation);
  end if;
  -- EXACT equality (never `is not null and`): a superseded generation is 'lost'.
  if v_row.generation <> p_generation then
    return jsonb_build_object('disposition', 'lost', 'reason', 'generation-superseded', 'generation', v_row.generation);
  end if;
  if v_row.expires_at is null or v_row.expires_at <= v_now then
    return jsonb_build_object('disposition', 'lost', 'reason', 'expired');
  end if;
  update public.control_plane_lease set expires_at = v_now + make_interval(secs => v_ttl), updated_at = v_now where id = 1;
  return jsonb_build_object('disposition', 'renewed', 'owner_token', v_token, 'generation', v_row.generation, 'ttl_seconds', v_ttl);
end;
$$;

-- release_control_plane_lease -- release ONLY if p_owner_token AND p_generation match the current (unexpired)
-- lease (Round-9 P1-C: a stale process using the SAME token but an OLD generation must NEVER release a newer
-- generation's lease). A foreign/stale token OR a superseded generation is a NO-OP that leaves the newer lease
-- intact. An expired lease is treated as already free.
create or replace function public.release_control_plane_lease(
  p_owner_token text,
  p_generation bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.control_plane_lease%rowtype;
  v_token text := coalesce(btrim(p_owner_token), '');
  -- STALE-CLOCK FIX: sample the clock AFTER the (blocking) advisory + FOR UPDATE locks, so a lease that expired
  -- WHILE THIS RELEASE WAITED (and may have been reclaimed by a new generation) is correctly seen as not-current.
  v_now timestamptz;
begin
  if v_token = '' then
    return jsonb_build_object('disposition', 'not-owner', 'reason', 'blank-token');
  end if;
  -- Round-10: the generation is MANDATORY (positive bigint). NULL / <= 0 is fail-closed 'not-owner' -- an
  -- owner-only release is never allowed; a stale process cannot release a newer generation's lease.
  if p_generation is null or p_generation <= 0 then
    return jsonb_build_object('disposition', 'not-owner', 'reason', 'invalid-generation');
  end if;
  perform pg_advisory_xact_lock(hashtext('control-plane-lease'));
  select * into v_row from public.control_plane_lease where id = 1 for update;
  v_now := clock_timestamp(); -- post-lock wall clock (never the stale transaction_timestamp)
  if not found then
    return jsonb_build_object('disposition', 'not-owner', 'reason', 'no-lease');
  end if;
  if v_row.owner_token <> v_token or v_row.expires_at is null or v_row.expires_at <= v_now then
    return jsonb_build_object('disposition', 'not-owner', 'reason', 'not-current-owner', 'owner_token', v_row.owner_token, 'generation', v_row.generation);
  end if;
  -- EXACT equality (never `is not null and`): a superseded generation never releases the newer lease.
  if v_row.generation <> p_generation then
    return jsonb_build_object('disposition', 'not-owner', 'reason', 'generation-superseded', 'generation', v_row.generation);
  end if;
  update public.control_plane_lease set owner_token = '', operation_key = '', expires_at = null, updated_at = v_now where id = 1;
  return jsonb_build_object('disposition', 'released', 'owner_token', v_token, 'generation', v_row.generation);
end;
$$;

-- read_control_plane_lease -- read-only reconciliation of the current owner + whether it is expired.
create or replace function public.read_control_plane_lease()
returns jsonb
language sql
security definer
set search_path = public
as $$
  -- Report expiry/held against the true WALL CLOCK (clock_timestamp()), not the transaction start time, so a
  -- reconciliation read never reports a just-expired lease as still held.
  select jsonb_build_object(
    'owner_token', owner_token, 'operation_key', operation_key, 'generation', generation, 'expires_at', expires_at,
    'expired', (expires_at is null or expires_at <= clock_timestamp()), 'held', (coalesce(btrim(owner_token), '') <> '' and expires_at is not null and expires_at > clock_timestamp()))
  from public.control_plane_lease where id = 1;
$$;

alter table public.control_plane_lease enable row level security;
drop policy if exists control_plane_lease_admin_read on public.control_plane_lease;
create policy control_plane_lease_admin_read on public.control_plane_lease
  for select to authenticated using (public.is_dashboard_admin());
revoke all on table public.control_plane_lease from public, anon, authenticated, service_role;
grant select on table public.control_plane_lease to authenticated;
grant select on table public.control_plane_lease to service_role;
revoke all on function public.acquire_control_plane_lease(text, text, int) from public, anon, authenticated;
grant execute on function public.acquire_control_plane_lease(text, text, int) to service_role;
revoke all on function public.renew_control_plane_lease(text, bigint, int) from public, anon, authenticated;
grant execute on function public.renew_control_plane_lease(text, bigint, int) to service_role;
revoke all on function public.release_control_plane_lease(text, bigint) from public, anon, authenticated;
grant execute on function public.release_control_plane_lease(text, bigint) to service_role;
revoke all on function public.read_control_plane_lease() from public, anon, authenticated;
grant execute on function public.read_control_plane_lease() to service_role;

-- ---------------------------------------------------------------------------
-- cas_report_snapshot_if_newer_fenced -- Round-9 P0-A WRITE-BOUNDARY FENCING. The Round-8 heartbeat proved the
-- fence BEFORE publish, but not ATOMICALLY at the report_snapshots write: an owner could renew gen N, stall,
-- expire, be superseded by gen N+1, then resume and still write the live row. This RPC enforces the EXACT fence
-- {owner_token, generation, unexpired} INSIDE THE SAME TRANSACTION as the CAS write: it row-locks the lease,
-- proves the fence, and ONLY THEN delegates to the reviewed atomic cas_report_snapshot_if_newer (single-sourced
-- CAS: inserted/replaced/newer-live/equal semantics preserved verbatim). On any fence mismatch/expiry it returns
-- 'lease-lost' and writes ZERO rows -- so a stale owner whose lease was reclaimed can never touch the live row.
-- SECURITY DEFINER + service_role, matching the other Scheduler-v2 CAS RPCs.
create or replace function public.cas_report_snapshot_if_newer_fenced(
  p_report_key text, p_account_id text, p_params_hash text,
  p_params jsonb, p_payload jsonb, p_payload_storage_path text,
  p_payload_bytes bigint, p_source_refreshed_at timestamptz,
  p_owner_token text, p_generation bigint
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lease public.control_plane_lease%rowtype;
  v_token text := coalesce(btrim(p_owner_token), '');
  -- STALE-CLOCK FIX: the write-boundary expiry check must use the post-lock WALL clock, so a lease that expired
  -- while THIS fenced write waited on the advisory / FOR UPDATE lock is rejected (ZERO rows), never written under
  -- a stale transaction_timestamp.
  v_now timestamptz;
begin
  -- FENCE (same transaction as the write): a blank token OR an invalid generation is fail-closed with ZERO
  -- rows -- never an unfenced write. Round-10: the generation is MANDATORY (positive bigint); NULL / <= 0 is
  -- 'lease-lost'.
  if v_token = '' then
    return jsonb_build_object('disposition', 'lease-lost', 'reason', 'no-fence');
  end if;
  if p_generation is null or p_generation <= 0 then
    return jsonb_build_object('disposition', 'lease-lost', 'reason', 'invalid-generation');
  end if;
  perform pg_advisory_xact_lock(hashtext('control-plane-lease'));
  select * into v_lease from public.control_plane_lease where id = 1 for update;
  v_now := clock_timestamp(); -- post-lock wall clock (never the stale transaction_timestamp)
  if not found then
    return jsonb_build_object('disposition', 'lease-lost', 'reason', 'no-lease');
  end if;
  if v_lease.owner_token <> v_token then
    return jsonb_build_object('disposition', 'lease-lost', 'reason', 'owner-changed', 'owner_token', v_lease.owner_token, 'generation', v_lease.generation);
  end if;
  -- EXACT equality (never `is not null and`): a superseded generation writes ZERO rows.
  if v_lease.generation <> p_generation then
    return jsonb_build_object('disposition', 'lease-lost', 'reason', 'generation-superseded', 'generation', v_lease.generation);
  end if;
  if v_lease.expires_at is null or v_lease.expires_at <= v_now then
    return jsonb_build_object('disposition', 'lease-lost', 'reason', 'expired');
  end if;
  -- FENCE HELD -> delegate to the reviewed atomic CAS in THIS SAME transaction (single-sourced semantics).
  return public.cas_report_snapshot_if_newer(
    p_report_key, p_account_id, p_params_hash, p_params, p_payload, p_payload_storage_path,
    p_payload_bytes, p_source_refreshed_at);
end;
$$;

revoke all on function public.cas_report_snapshot_if_newer_fenced(text, text, text, jsonb, jsonb, text, bigint, timestamptz, text, bigint) from public, anon, authenticated;
grant execute on function public.cas_report_snapshot_if_newer_fenced(text, text, text, jsonb, jsonb, text, bigint, timestamptz, text, bigint) to service_role;
