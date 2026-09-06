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

alter table public.account_onboarding enable row level security;
drop policy if exists account_onboarding_admin_read on public.account_onboarding;
create policy account_onboarding_admin_read on public.account_onboarding
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
