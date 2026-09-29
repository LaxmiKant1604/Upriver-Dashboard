-- ===========================================================================
-- Independent PUBLICATION RECOVERY WORKER -- route registry, durable job queue, unit-level state, heartbeat,
-- scan lease (tier-1 cadence + deep sweep), control gate, status alerts (ROUTE DESIGN, WP12)
-- ===========================================================================
--
-- PREPARED, NOT APPLIED. EXPAND-ONLY + IDEMPOTENT. Adds SEVEN new tables and TWELVE new RPCs. Changes NO existing
-- table/column/constraint/trigger/RPC, reads no existing table, and stores no secret.
--
-- SIGN-OFF GATE (separate from 20260935, the writer fence -- each migration has its OWN owner sign-off):
--   1. Owner approval recorded for "apply 20260934" (it enables NOTHING: the control row is created DISABLED and every
--      route row live_enabled=false with no live region).
--   2. Apply EXACTLY this one file:  MIGRATE_ONLY=20260934_publication_recovery_worker.sql npm run db:migrate
--   3. Verify read-only (deploy/publication-recovery/README.md "Gate A").
-- Rollback (contract): sales-dashboard-live/deploy/publication-recovery/ROLLBACK_20260934.sql (drops EXACTLY the objects
-- below; deliberately NOT in supabase/migrations so the ledger-driven runner can never apply it).
--
-- This file was REDESIGNED IN PLACE while unapplied (the earlier family-based revision was never applied anywhere). The
-- guard in step 0 refuses to run over that earlier shape if it was ever applied to a scratch database.
--
-- WHY. The worker (scripts/worker/publication-recovery-worker.mjs) finds saved source evidence that has not reached its
-- live dashboard report and invokes ONLY the allow-listed zero-export publication-route CLIs (the four legacy
-- reconcilers + scripts/release/publication-route-reconcile.mjs) to publish + verify it. report_publication_outbox is
-- OLI-enqueued and not source/region-filtered; control_plane_lease is THE single global publication lock; sync_targets /
-- sync_runs belong to the legacy path. So the worker keeps its OWN namespace.
--
-- SAFETY. The worker NEVER writes a dashboard snapshot itself: every live write still goes through the route CLI's
-- fenced four-gate publisher (fenced CAS under the global control-plane lease). These tables only coordinate WHICH
-- (route, region, target, as-of) to hand to a route CLI and record what that CLI's own exact binding + served-row read-back
-- proved. publication_recovery_routes is the per-route canary switch (live_enabled + live_regions, all OFF at apply);
-- publication_recovery_control is the global kill switch (enabled=false at apply). Going live is a separate, signed-off
-- UPDATE. SECURITY DEFINER + fixed search_path + service_role-only EXECUTE + RLS on every table (no anon/authenticated).

-- 0) GUARD: never run over the earlier (family-based, never applied) prepared revision of this file.
do $$
begin
  if to_regclass('public.publication_recovery_jobs') is not null
     and not exists (select 1 from information_schema.columns
                      where table_schema = 'public' and table_name = 'publication_recovery_jobs' and column_name = 'route_id') then
    raise exception '20260934: an earlier family-based publication_recovery_jobs exists; roll that revision back first (fail closed)';
  end if;
  if to_regclass('public.publication_recovery_control') is not null
     and exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'publication_recovery_control' and column_name = 'live_families') then
    raise exception '20260934: an earlier family-based publication_recovery_control exists; roll that revision back first (fail closed)';
  end if;
end;
$$;

-- 1) ROUTE REGISTRY (reference + per-route CANARY switch). One row per publication route of lib/server/recovery/routes.js
--    (pinned equal by scripts/publication-recovery-worker.test.js). A route may publish ONLY when control.enabled AND
--    live_enabled AND the region is in live_regions AND the worker env PRW_LIVE_ROUTES names it. Seeded all DISABLED.
create table if not exists public.publication_recovery_routes (
  route_id text primary key constraint prr_route_id_check check (route_id ~ '^[a-z][a-z0-9-]{1,39}$'),
  grain text not null constraint prr_grain_check check (grain in ('account','region')),
  live_report_keys text[] not null default '{}'::text[]
    constraint prr_live_report_keys_check check (cardinality(live_report_keys) between 1 and 16 and array_position(live_report_keys, null) is null),
  live_enabled boolean not null default false,
  live_regions text[] not null default '{}'::text[]
    constraint prr_live_regions_check check (live_regions <@ array['india','europe-au','us-ca']::text[]),
  updated_at timestamptz not null default now(),
  updated_by text constraint prr_updated_by_len check (updated_by is null or char_length(updated_by) <= 200)
);
insert into public.publication_recovery_routes (route_id, grain, live_report_keys) values
  ('oli', 'account', array['brand-inventory','brand-sales','daily-reporting']),
  ('listings', 'account', array['listing-health-v3']),
  ('fba-plan', 'account', array['fba-plan']),
  ('returns-v3', 'account', array['returns-leakage']),
  ('ads', 'account', array['daily-reporting']),
  ('fba', 'account', array['brand-inventory']),
  ('brand-view-brands', 'account', array['brand-view-brands']),
  ('sku-movement', 'account', array['sku-movement']),
  ('brand-view', 'account', array['brand-view']),
  ('brand-view-portfolio', 'region', array['brand-view-portfolio'])
  on conflict (route_id) do nothing;

-- 2) GLOBAL CONTROL GATE (kill switch). Single row; enabled=false at first apply.
create table if not exists public.publication_recovery_control (
  id boolean primary key default true constraint prc_singleton check (id = true),
  enabled boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by text constraint prc_updated_by_len check (updated_by is null or char_length(updated_by) <= 200)
);
insert into public.publication_recovery_control (id, enabled) values (true, false)
  on conflict (id) do nothing;

-- 3) JOBS. At most ONE live (pending/claimed/deferred) job per (route, region, target, requested_as_of), coalescing
--    repeated detections. target_key is an account id, or 'region:<r>' for a region-grain route. owner_account_ids are
--    the target's owners (informational for a region target). attempts counts only EXECUTED failures; claims counts
--    CONSECUTIVE claims that never reached an owner finish (reset by every finish except 'released') -- the crash-loop
--    guard. rearms counts EVERY evidence-advanced re-arm of this job (never reset; past the finish RPC's bound the job is
--    alerted 'evidence-rearm-bound' and backs off). published = this job's own live pass published (owner hand-off
--    'repaired' once verified).
create table if not exists public.publication_recovery_jobs (
  id uuid primary key default gen_random_uuid(),
  route_id text not null constraint prj_route_fk references public.publication_recovery_routes (route_id),
  region text not null constraint prj_region_check check (region in ('india','europe-au','us-ca')),
  target_key text not null constraint prj_target_key_check check (target_key ~ '^[A-Za-z0-9._:-]{1,160}$'),
  owner_account_ids text[] not null default '{}'::text[]
    constraint prj_owners_bounded check (cardinality(owner_account_ids) <= 128 and array_position(owner_account_ids, null) is null),
  requested_as_of date not null,
  evidence_token text constraint prj_token_len check (evidence_token is null or char_length(evidence_token) <= 512),
  origin text not null constraint prj_origin_check check (origin in ('watermark','scan','deep-scan','dependency','manual')),
  status text not null default 'pending'
    constraint prj_status_check check (status in ('pending','claimed','deferred','verified','dead','superseded')),
  priority smallint not null default 5 constraint prj_priority_check check (priority between 0 and 100),
  attempts integer not null default 0 constraint prj_attempts_nonneg check (attempts >= 0),
  claims integer not null default 0 constraint prj_claims_nonneg check (claims >= 0),
  rearms integer not null default 0 constraint prj_rearms_nonneg check (rearms >= 0),
  claim_token uuid,
  claimed_by text,
  claimed_at timestamptz,
  lease_expires_at timestamptz,
  next_attempt_at timestamptz not null default now(),
  last_class text constraint prj_class_len check (last_class is null or char_length(last_class) <= 64),
  last_reason text constraint prj_reason_len check (last_reason is null or char_length(last_reason) <= 240),
  last_alert text constraint prj_alert_len check (last_alert is null or char_length(last_alert) <= 120),
  last_run_token text constraint prj_run_token_len check (last_run_token is null or char_length(last_run_token) <= 200),
  published boolean not null default false,
  verified_at timestamptz,
  dead_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists publication_recovery_jobs_live_key
  on public.publication_recovery_jobs (route_id, region, target_key, requested_as_of)
  where status in ('pending','claimed','deferred');
create index if not exists publication_recovery_jobs_ready_idx
  on public.publication_recovery_jobs (status, priority, next_attempt_at);
create index if not exists publication_recovery_jobs_history_idx
  on public.publication_recovery_jobs (route_id, region, target_key, requested_as_of, updated_at desc);

-- 4) PER-(route, region, target, as-of) STATE: the last evidence token the route CLI's exact binding PROVED current
--    (verified_token: an unchanged token is never re-enqueued by the watermark), the token last OBSERVED (whatever its
--    class), the latest class + owner hand-off, when that class began (class_since: the 'missing-evidence > 6 h' alert),
--    and the UNIT-level verified rows [{u, rk, acct, h, sra, upd, asOf}] the tier-1 scan compares against (identity
--    as-of rollover). verified_rows is size-bounded (the worker compacts before sending). served_confirmed = the SERVED
--    read-back of the verified row: a route CLI's units carry the served row (h / sra equal); a legacy family's is the
--    worker's tier-1 served-row check (no live row in scope written after the verification) -- null = not yet proven.
--    The owner hand-off 'already-current' / 'repaired' requires served_confirmed = true. A REVOCATION (false) is STICKY
--    for the verified token: a re-verification of the SAME token without a republish (and without a route CLI's positive
--    unit-level served proof) keeps it false, and a tier-1 confirmation never flips it back; only a NEW verified token or
--    a republish by the worker (finish 'verified' with p_published) resets it.
create table if not exists public.publication_recovery_state (
  route_id text not null constraint prs_route_fk references public.publication_recovery_routes (route_id),
  region text not null constraint prs_region_check check (region in ('india','europe-au','us-ca')),
  target_key text not null constraint prs_target_key_check check (target_key ~ '^[A-Za-z0-9._:-]{1,160}$'),
  requested_as_of date not null,
  owner_account_ids text[] not null default '{}'::text[]
    constraint prs_owners_bounded check (cardinality(owner_account_ids) <= 128 and array_position(owner_account_ids, null) is null),
  verified_token text constraint prs_token_len check (verified_token is null or char_length(verified_token) <= 512),
  observed_token text constraint prs_observed_len check (observed_token is null or char_length(observed_token) <= 512),
  verified_at timestamptz,
  verified_rows jsonb not null default '[]'::jsonb
    constraint prs_verified_rows_bounded check (jsonb_typeof(verified_rows) = 'array' and pg_column_size(verified_rows) <= 8192),
  last_class text constraint prs_class_len check (last_class is null or char_length(last_class) <= 64),
  last_reason text constraint prs_reason_len check (last_reason is null or char_length(last_reason) <= 240),
  last_alert text constraint prs_alert_len check (last_alert is null or char_length(last_alert) <= 120),
  handoff text constraint prs_handoff_check check (handoff is null or handoff in ('repaired','already-current','deferred','missing-source','failed','not-applicable')),
  served_confirmed boolean,
  class_since timestamptz not null default now(),
  observed_at timestamptz not null default now(),
  primary key (route_id, region, target_key, requested_as_of)
);

-- 5) UNIT-LEVEL OBSERVATIONS (status / hand-off detail). tier 1 = the metadata consistency scan (report_key 'tier-1',
--    unit_key '-'); tier 2 = a child's per-(unit, report) verdict. Reason CODES only -- never payloads.
create table if not exists public.publication_recovery_observations (
  route_id text not null constraint pro_route_fk references public.publication_recovery_routes (route_id),
  region text not null constraint pro_region_check check (region in ('india','europe-au','us-ca')),
  target_key text not null constraint pro_target_key_check check (target_key ~ '^[A-Za-z0-9._:-]{1,160}$'),
  unit_key text not null default '-' constraint pro_unit_key_check check (unit_key ~ '^[A-Za-z0-9._:-]{1,64}$'),
  report_key text not null constraint pro_report_len check (char_length(report_key) between 1 and 64),
  requested_as_of date not null,
  target_as_of date,
  tier smallint not null default 2 constraint pro_tier_check check (tier in (1, 2)),
  state text not null constraint pro_state_len check (char_length(state) between 1 and 64),
  reason_code text constraint pro_reason_len check (reason_code is null or char_length(reason_code) <= 120),
  alert text constraint pro_alert_len check (alert is null or char_length(alert) <= 120),
  observed_at timestamptz not null default now(),
  primary key (region, target_key, unit_key, report_key, requested_as_of, route_id)
);

-- 6) WORKER HEARTBEATS (one row per worker id). stats holds COUNTS only (bounded size).
create table if not exists public.publication_recovery_workers (
  worker_id text primary key constraint prw_id_check check (char_length(worker_id) between 1 and 120),
  host text constraint prw_host_len check (host is null or char_length(host) <= 120),
  pid integer,
  version text constraint prw_version_len check (version is null or char_length(version) <= 64),
  mode text constraint prw_mode_len check (mode is null or char_length(mode) <= 32),
  started_at timestamptz,
  last_beat_at timestamptz not null default now(),
  last_error_code text constraint prw_err_len check (last_error_code is null or char_length(last_error_code) <= 120),
  stats jsonb not null default '{}'::jsonb constraint prw_stats_bounded check (pg_column_size(stats) <= 8192)
);

-- 7) SCAN ROW (single row). The DEEP SWEEP is single-flight through the holder lease (two workers never sweep at once);
--    the TIER-1 consistency scan is claimed per interval through last_tier1_at (DB-durable 10-minute cadence) and records
--    its redacted summary + global alerts in tier1_summary; deep_sweep keeps the per-route sweep progress.
create table if not exists public.publication_recovery_scan (
  id boolean primary key default true constraint prsc_singleton check (id = true),
  holder text,
  lease_expires_at timestamptz,
  last_started_at timestamptz,
  last_finished_at timestamptz,
  last_outcome text constraint prsc_outcome_len check (last_outcome is null or char_length(last_outcome) <= 64),
  last_summary jsonb not null default '{}'::jsonb constraint prsc_summary_bounded check (pg_column_size(last_summary) <= 16384),
  last_tier1_at timestamptz,
  tier1_summary jsonb not null default '{}'::jsonb constraint prsc_tier1_bounded check (pg_column_size(tier1_summary) <= 32768),
  deep_sweep jsonb not null default '{}'::jsonb constraint prsc_deep_sweep_bounded check (pg_column_size(deep_sweep) <= 16384)
);
insert into public.publication_recovery_scan (id) values (true) on conflict (id) do nothing;

-- ---------------------------------------------------------------------------------------------------------------
-- RPC: enqueue (idempotent coalescing). Validates the route exists, the owner cardinality/grammar and the target key
-- for the route's grain. Returns one of:
--   'enqueued'           a new pending job was created
--   'refreshed'          a live job exists; its evidence token advanced (a deferred job is re-armed to pending)
--   'exists'             a live job with the same token already exists
--   'already-verified'   the route CLI already PROVED this exact token current (watermark origin only)
--   'dead-same-evidence' a job for this exact token already dead-lettered (permanent errors never loop)
create or replace function public.enqueue_publication_recovery_job(
  p_route_id text, p_region text, p_target_key text, p_owner_account_ids text[], p_requested_as_of date,
  p_evidence_token text, p_origin text, p_priority smallint default 5
) returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_live public.publication_recovery_jobs%rowtype;
  v_verified text;
  v_grain text;
  v_owners text[] := coalesce(p_owner_account_ids, '{}'::text[]);
begin
  if p_route_id is null or p_region is null or p_target_key is null or p_requested_as_of is null or p_origin is null then
    raise exception 'enqueue_publication_recovery_job: route/region/target/as-of/origin are required';
  end if;
  select grain into v_grain from public.publication_recovery_routes where route_id = p_route_id;
  if not found then
    raise exception 'enqueue_publication_recovery_job: unknown route % (fail closed)', left(p_route_id, 60);
  end if;
  if cardinality(v_owners) > 128 then
    raise exception 'enqueue_publication_recovery_job: % owners exceed the 128 bound (fail closed)', cardinality(v_owners);
  end if;
  if exists (select 1 from unnest(v_owners) o where o is null or o !~ '^[A-Za-z0-9._-]{1,120}$') then
    raise exception 'enqueue_publication_recovery_job: a malformed owner account id (fail closed)';
  end if;
  if v_grain = 'region' and p_target_key <> 'region:' || p_region then
    raise exception 'enqueue_publication_recovery_job: a region-grain target must be region:<region> (fail closed)';
  end if;
  if v_grain = 'account' and p_target_key !~ '^[A-Za-z0-9._-]{1,120}$' then
    raise exception 'enqueue_publication_recovery_job: an account-grain target must be a canonical account id (fail closed)';
  end if;
  perform pg_advisory_xact_lock(hashtext('publication-recovery|' || p_route_id || '|' || p_region || '|' || p_target_key || '|' || p_requested_as_of::text));
  select * into v_live from public.publication_recovery_jobs
   where route_id = p_route_id and region = p_region and target_key = p_target_key and requested_as_of = p_requested_as_of
     and status in ('pending','claimed','deferred')
   for update;
  if found then
    if p_evidence_token is not null and v_live.evidence_token is distinct from p_evidence_token then
      update public.publication_recovery_jobs
         set evidence_token = p_evidence_token,
             owner_account_ids = case when cardinality(v_owners) > 0 then v_owners else owner_account_ids end,
             status = case when status = 'deferred' then 'pending' else status end,
             next_attempt_at = case when status = 'deferred' then now() else next_attempt_at end,
             priority = least(priority, coalesce(p_priority, 5)),
             updated_at = now()
       where id = v_live.id;
      return 'refreshed';
    end if;
    return 'exists';
  end if;
  if p_origin = 'watermark' and p_evidence_token is not null then
    select verified_token into v_verified from public.publication_recovery_state
     where route_id = p_route_id and region = p_region and target_key = p_target_key and requested_as_of = p_requested_as_of;
    if v_verified is not null and v_verified = p_evidence_token then
      return 'already-verified';
    end if;
  end if;
  if exists (select 1 from public.publication_recovery_jobs
              where route_id = p_route_id and region = p_region and target_key = p_target_key
                and requested_as_of = p_requested_as_of and status = 'dead'
                and evidence_token is not distinct from p_evidence_token) then
    return 'dead-same-evidence';
  end if;
  insert into public.publication_recovery_jobs (route_id, region, target_key, owner_account_ids, requested_as_of, evidence_token, origin, priority)
  values (p_route_id, p_region, p_target_key, v_owners, p_requested_as_of, p_evidence_token, p_origin, coalesce(p_priority, 5));
  return 'enqueued';
end;
$$;

-- RPC: claim a COHERENT batch (same route + region + as-of) of ready jobs under a bounded lease. Ready = pending or
-- deferred whose next_attempt_at has passed, OR claimed whose lease expired (a crashed worker's work is reclaimed).
-- A job reclaimed p_max_claims times without ever finishing is dead-lettered as 'crash-loop' instead of re-claimed.
create or replace function public.claim_publication_recovery_jobs(
  p_worker_id text, p_claim_token uuid, p_limit integer default 5, p_lease_seconds integer default 1500,
  p_max_claims integer default 8
) returns setof public.publication_recovery_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lease integer := greatest(120, least(coalesce(p_lease_seconds, 1500), 7200));
  v_limit integer := greatest(1, least(coalesce(p_limit, 5), 25));
  v_max integer := greatest(2, least(coalesce(p_max_claims, 8), 50));
  v_head record;
begin
  if p_worker_id is null or p_claim_token is null then
    raise exception 'claim_publication_recovery_jobs: worker id and claim token are required';
  end if;
  update public.publication_recovery_jobs
     set status = 'dead', dead_at = now(), last_class = 'crash-loop',
         last_reason = 'claimed ' || claims || ' times without finishing (worker crash loop)',
         claim_token = null, lease_expires_at = null, updated_at = now()
   where status = 'claimed' and lease_expires_at < now() and claims >= v_max;
  select route_id, region, requested_as_of into v_head
    from public.publication_recovery_jobs
   where (status in ('pending','deferred') and next_attempt_at <= now())
      or (status = 'claimed' and lease_expires_at < now())
   order by priority, next_attempt_at, created_at
   limit 1
   for update skip locked;
  if not found then
    return;
  end if;
  return query
  with picked as (
    select id from public.publication_recovery_jobs
     where route_id = v_head.route_id and region = v_head.region and requested_as_of = v_head.requested_as_of
       and ((status in ('pending','deferred') and next_attempt_at <= now())
         or (status = 'claimed' and lease_expires_at < now()))
     order by priority, next_attempt_at, created_at
     limit v_limit
     for update skip locked
  )
  update public.publication_recovery_jobs j
     set status = 'claimed', claims = j.claims + 1, claim_token = p_claim_token, claimed_by = p_worker_id,
         claimed_at = now(), lease_expires_at = now() + make_interval(secs => v_lease), updated_at = now()
    from picked
   where j.id = picked.id
  returning j.*;
end;
$$;

-- RPC: extend the lease of jobs this claim token still holds (long route runs). Returns the number renewed.
create or replace function public.renew_publication_recovery_claim(
  p_ids uuid[], p_claim_token uuid, p_lease_seconds integer default 1500
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_n integer;
begin
  update public.publication_recovery_jobs
     set lease_expires_at = now() + make_interval(secs => greatest(120, least(coalesce(p_lease_seconds, 1500), 7200))),
         updated_at = now()
   where id = any(coalesce(p_ids, '{}'::uuid[])) and status = 'claimed' and claim_token = p_claim_token;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- RPC: finish ONE claimed job. Only the current claim-token holder may finish it. p_evaluated_token is the evidence
-- token the outcome is ABOUT (the token the route CLI evaluated, or the claim-time token). If it differs from the job's
-- CURRENT token (an enqueue refreshed it while the job ran, or the child evaluated other evidence), a 'verified' /
-- 'retry' / 'deferred' / 'dead' outcome describes OTHER evidence, so the job is RE-ARMED instead (pending now, attempts
-- and claims reset) -> returns 're-armed'. A dead-letter or a verification is therefore never stamped with evidence the
-- route CLI did not evaluate. Outcomes:
--   'verified'   the route CLI's exact binding + served read-back proved the live report current for the job's token;
--                the state records verified_token / verified_rows and the hand-off ('repaired' when p_published).
--   'retry'      an executed attempt failed retryably: attempts+1, backoff; dead-letters at p_max_attempts.
--   'deferred'   not executed / legitimately not publishable yet: attempts unchanged, backoff.
--   'released'   handed back unexecuted (graceful shutdown): claims-1, immediately ready.
--   'dead'       terminal for this evidence token: dead-lettered, never retried for it.
--   'superseded' a newer as-of made this job moot (or its account target left the region's durable directory).
-- p_record_state=false (a gate deferral that evaluated nothing) leaves the state row untouched. claims counts
-- CONSECUTIVE claims that never reached an owner finish: every owner finish except 'released' resets it to 0.
create or replace function public.finish_publication_recovery_job(
  p_id uuid, p_claim_token uuid, p_outcome text, p_class text, p_reason text,
  p_backoff_seconds integer default 60, p_max_attempts integer default 6,
  p_run_token text default null, p_evaluated_token text default null,
  p_verified_rows jsonb default null, p_alert text default null, p_published boolean default false,
  p_handoff text default null, p_record_state boolean default true, p_served_confirmed boolean default null,
  p_max_rearms integer default 12
) returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v public.publication_recovery_jobs%rowtype;
  v_backoff integer := greatest(0, least(coalesce(p_backoff_seconds, 60), 86400));
  v_max integer := greatest(1, least(coalesce(p_max_attempts, 6), 50));
  v_class text := left(coalesce(p_class, p_outcome), 64);
  v_reason text := left(p_reason, 240);
  v_alert text := left(p_alert, 120);
  v_state_class text;
  v_handoff text := p_handoff;
  v_max_rearms integer := greatest(1, least(coalesce(p_max_rearms, 12), 1000));
  v_rearm_alert boolean;
begin
  select * into v from public.publication_recovery_jobs where id = p_id for update;
  if not found then return 'not-found'; end if;
  if v.status <> 'claimed' or v.claim_token is distinct from p_claim_token then return 'not-owner'; end if;
  if p_outcome in ('verified','retry','deferred','dead')
     and v.evidence_token is not null and p_evaluated_token is distinct from v.evidence_token then
    v_rearm_alert := v.rearms + 1 >= v_max_rearms;
    update public.publication_recovery_jobs
       set status = 'pending', attempts = 0, claims = 0, rearms = v.rearms + 1,
           next_attempt_at = case when v_rearm_alert then now() + interval '600 seconds' else now() end,
           claim_token = null, claimed_by = null, lease_expires_at = null,
           last_class = 'evidence-advanced', last_reason = left('evidence advanced while the job ran (' || p_outcome || ':' || v_class || '); re-evaluating', 240),
           last_alert = case when v_rearm_alert then 'evidence-rearm-bound' else last_alert end,
           last_run_token = coalesce(left(p_run_token, 200), last_run_token), updated_at = now()
     where id = p_id;
    return 're-armed';
  end if;
  -- An evidence-advanced DEFERRAL is a re-arm too: counted, alerted past the bound (with a longer backoff).
  if p_outcome = 'deferred' and v_class = 'evidence-advanced' then
    if v.rearms + 1 >= v_max_rearms then
      v_alert := coalesce(v_alert, 'evidence-rearm-bound');
      v_backoff := greatest(v_backoff, 600);
    end if;
    update public.publication_recovery_jobs set rearms = v.rearms + 1 where id = p_id;
  end if;
  if p_outcome = 'verified' then
    update public.publication_recovery_jobs
       set status = 'verified', verified_at = now(), claims = 0, claim_token = null, claimed_by = null, lease_expires_at = null,
           last_class = v_class, last_reason = v_reason, last_alert = v_alert, published = coalesce(p_published, false),
           last_run_token = left(p_run_token, 200), updated_at = now()
     where id = p_id;
    insert into public.publication_recovery_state (route_id, region, target_key, requested_as_of, owner_account_ids, verified_token, observed_token, verified_at, verified_rows, last_class, last_reason, last_alert, handoff, served_confirmed, class_since, observed_at)
    values (v.route_id, v.region, v.target_key, v.requested_as_of, v.owner_account_ids, v.evidence_token, v.evidence_token, now(),
            case when jsonb_typeof(p_verified_rows) = 'array' then p_verified_rows else '[]'::jsonb end,
            v_class, v_reason, v_alert, coalesce(v_handoff, case when coalesce(p_published, false) then 'repaired' else 'already-current' end), p_served_confirmed, now(), now())
    on conflict (route_id, region, target_key, requested_as_of) do update
      set owner_account_ids = excluded.owner_account_ids, verified_token = excluded.verified_token, observed_token = excluded.observed_token,
          verified_at = excluded.verified_at, verified_rows = excluded.verified_rows,
          -- STICKY revocation: a positive proof stands; a republish resets to what it proved; else a revocation of the
          -- SAME verified token survives this re-verification.
          served_confirmed = case
            when excluded.served_confirmed is true then true
            when coalesce(p_published, false) then excluded.served_confirmed
            when publication_recovery_state.served_confirmed is false and publication_recovery_state.verified_token is not null
                 and publication_recovery_state.verified_token = excluded.verified_token then false
            else excluded.served_confirmed end,
          class_since = case when publication_recovery_state.last_class is distinct from excluded.last_class then now() else publication_recovery_state.class_since end,
          last_class = excluded.last_class, last_reason = excluded.last_reason, last_alert = excluded.last_alert,
          handoff = excluded.handoff, observed_at = excluded.observed_at;
    return 'verified';
  elsif p_outcome = 'retry' then
    if v.attempts + 1 >= v_max then
      update public.publication_recovery_jobs
         set status = 'dead', dead_at = now(), attempts = v.attempts + 1, claims = 0, claim_token = null, claimed_by = null,
             lease_expires_at = null, last_class = 'max-attempts:' || left(v_class, 50), last_reason = v_reason, last_alert = v_alert,
             last_run_token = left(p_run_token, 200), updated_at = now()
       where id = p_id;
      v_state_class := 'max-attempts:' || left(v_class, 50);
      if coalesce(p_record_state, true) then
        insert into public.publication_recovery_state (route_id, region, target_key, requested_as_of, owner_account_ids, observed_token, last_class, last_reason, last_alert, handoff, class_since, observed_at)
        values (v.route_id, v.region, v.target_key, v.requested_as_of, v.owner_account_ids, v.evidence_token, v_state_class, v_reason, v_alert, coalesce(v_handoff, 'failed'), now(), now())
        on conflict (route_id, region, target_key, requested_as_of) do update
          set owner_account_ids = excluded.owner_account_ids, observed_token = excluded.observed_token,
              class_since = case when publication_recovery_state.last_class is distinct from excluded.last_class then now() else publication_recovery_state.class_since end,
              last_class = excluded.last_class, last_reason = excluded.last_reason, last_alert = excluded.last_alert,
              handoff = excluded.handoff, observed_at = excluded.observed_at;
      end if;
      return 'dead';
    end if;
    update public.publication_recovery_jobs
       set status = 'pending', attempts = v.attempts + 1, claims = 0, next_attempt_at = now() + make_interval(secs => v_backoff),
           claim_token = null, claimed_by = null, lease_expires_at = null, last_class = v_class, last_reason = v_reason, last_alert = v_alert,
           last_run_token = left(p_run_token, 200), updated_at = now()
     where id = p_id;
  elsif p_outcome = 'deferred' then
    update public.publication_recovery_jobs
       set status = 'deferred', claims = 0, next_attempt_at = now() + make_interval(secs => v_backoff),
           claim_token = null, claimed_by = null, lease_expires_at = null, last_class = v_class, last_reason = v_reason, last_alert = v_alert,
           last_run_token = coalesce(left(p_run_token, 200), last_run_token), updated_at = now()
     where id = p_id;
  elsif p_outcome = 'released' then
    update public.publication_recovery_jobs
       set status = 'pending', claims = greatest(v.claims - 1, 0), next_attempt_at = now(),
           claim_token = null, claimed_by = null, lease_expires_at = null, last_class = 'released', updated_at = now()
     where id = p_id;
    return 'released';
  elsif p_outcome = 'dead' then
    update public.publication_recovery_jobs
       set status = 'dead', dead_at = now(), claims = 0, claim_token = null, claimed_by = null, lease_expires_at = null,
           last_class = v_class, last_reason = v_reason, last_alert = v_alert, last_run_token = coalesce(left(p_run_token, 200), last_run_token),
           updated_at = now()
     where id = p_id;
  elsif p_outcome = 'superseded' then
    update public.publication_recovery_jobs
       set status = 'superseded', claims = 0, claim_token = null, claimed_by = null, lease_expires_at = null,
           last_class = v_class, last_reason = v_reason, last_alert = v_alert, updated_at = now()
     where id = p_id;
    return 'superseded';
  else
    raise exception 'finish_publication_recovery_job: unknown outcome %', p_outcome;
  end if;
  -- retry / deferred / dead: the state records the evaluated class (never a verification) unless told not to.
  if coalesce(p_record_state, true) then
    insert into public.publication_recovery_state (route_id, region, target_key, requested_as_of, owner_account_ids, observed_token, last_class, last_reason, last_alert, handoff, class_since, observed_at)
    values (v.route_id, v.region, v.target_key, v.requested_as_of, v.owner_account_ids, v.evidence_token, v_class, v_reason, v_alert, v_handoff, now(), now())
    on conflict (route_id, region, target_key, requested_as_of) do update
      set owner_account_ids = excluded.owner_account_ids, observed_token = excluded.observed_token,
          class_since = case when publication_recovery_state.last_class is distinct from excluded.last_class then now() else publication_recovery_state.class_since end,
          last_class = excluded.last_class, last_reason = excluded.last_reason, last_alert = excluded.last_alert,
          handoff = excluded.handoff, observed_at = excluded.observed_at;
  end if;
  return p_outcome;
end;
$$;

-- RPC: record a child's per-target PROOF (deep sweep / pre-check) or a tier-1 metadata class. Rows: [{kind?: 'baseline',
-- route_id, region, target_key, requested_as_of, owners, token, class, reason, alert, handoff, verified_rows,
-- served_confirmed}] or the tier-1 served-row confirmation [{kind: 'served', route_id, region, target_key,
-- requested_as_of, served_confirmed, token}] (updates an existing verified row only -- and, when token is sent, only
-- the verification it evaluated; a revocation is STICKY: 'true' never overwrites 'false'). A token is recorded as
-- VERIFIED only for class 'current' (the worker sends 'current' only when the child's evaluated token equals the
-- worker's); observed_token is recorded for EVERY class (the watermark then reacts only to evidence that CHANGED). A
-- 'current' baseline of the SAME verified token keeps a revocation (false) unless it carries a positive served proof.
create or replace function public.record_publication_recovery_baseline(p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_n integer; v_m integer;
begin
  -- kind 'served' rows only record the worker's tier-1 served-row confirmation / revocation on an EXISTING verified
  -- state row (of the evaluated verified token); a revocation is sticky for that token.
  update public.publication_recovery_state s
     set served_confirmed = case (r->>'served_confirmed')::boolean
                              when true then s.served_confirmed is not false
                              when false then false
                              else s.served_confirmed end
    from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r
   where r->>'kind' = 'served' and s.route_id = r->>'route_id' and s.region = r->>'region' and s.target_key = r->>'target_key'
     and s.requested_as_of = (r->>'requested_as_of')::date and s.verified_token is not null
     and (nullif(r->>'token', '') is null or s.verified_token = r->>'token');
  get diagnostics v_m = row_count;
  insert into public.publication_recovery_state (route_id, region, target_key, requested_as_of, owner_account_ids, verified_token, observed_token, verified_at, verified_rows, last_class, last_reason, last_alert, handoff, served_confirmed, class_since, observed_at)
  select r->>'route_id', r->>'region', r->>'target_key', (r->>'requested_as_of')::date,
         coalesce((select array_agg(o) from jsonb_array_elements_text(case when jsonb_typeof(r->'owners') = 'array' then r->'owners' else '[]'::jsonb end) o), '{}'::text[]),
         case when r->>'class' = 'current' then nullif(r->>'token', '') else null end,
         left(nullif(r->>'token', ''), 512),
         case when r->>'class' = 'current' then now() else null end,
         case when r->>'class' = 'current' and jsonb_typeof(r->'verified_rows') = 'array' then r->'verified_rows' else '[]'::jsonb end,
         left(r->>'class', 64), left(r->>'reason', 240), left(r->>'alert', 120), r->>'handoff',
         case when r->>'class' = 'current' and jsonb_typeof(r->'served_confirmed') = 'boolean' then (r->>'served_confirmed')::boolean else null end, now(), now()
    from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r
   where coalesce(r->>'kind', 'baseline') = 'baseline'
  on conflict (route_id, region, target_key, requested_as_of) do update
    set owner_account_ids = excluded.owner_account_ids,
        verified_token = case when excluded.last_class = 'current' then excluded.verified_token else publication_recovery_state.verified_token end,
        verified_at = case when excluded.last_class = 'current' then excluded.verified_at else publication_recovery_state.verified_at end,
        verified_rows = case when excluded.last_class = 'current' then excluded.verified_rows else publication_recovery_state.verified_rows end,
        observed_token = excluded.observed_token,
        class_since = case when publication_recovery_state.last_class is distinct from excluded.last_class then now() else publication_recovery_state.class_since end,
        last_class = excluded.last_class, last_reason = excluded.last_reason, last_alert = excluded.last_alert,
        served_confirmed = case when excluded.last_class = 'current' then
                                  case when excluded.served_confirmed is true then true
                                       when publication_recovery_state.served_confirmed is false and publication_recovery_state.verified_token is not null
                                            and publication_recovery_state.verified_token = excluded.verified_token then false
                                       else excluded.served_confirmed end
                                else publication_recovery_state.served_confirmed end,
        handoff = excluded.handoff, observed_at = excluded.observed_at;
  get diagnostics v_n = row_count;
  return v_n + v_m;
end;
$$;

-- RPC: upsert unit-level observations (status / hand-off detail). Rows: [{route_id, region, target_key, unit_key,
-- report_key, requested_as_of, target_as_of, tier, state, reason_code, alert}].
create or replace function public.record_publication_recovery_observations(p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_n integer;
begin
  insert into public.publication_recovery_observations (route_id, region, target_key, unit_key, report_key, requested_as_of, target_as_of, tier, state, reason_code, alert, observed_at)
  select r->>'route_id', r->>'region', r->>'target_key', coalesce(nullif(r->>'unit_key', ''), '-'), r->>'report_key',
         (r->>'requested_as_of')::date, nullif(r->>'target_as_of', '')::date, coalesce((r->>'tier')::smallint, 2),
         left(r->>'state', 64), left(r->>'reason_code', 120), left(r->>'alert', 120), now()
    from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r
  on conflict (region, target_key, unit_key, report_key, requested_as_of, route_id) do update
    set target_as_of = excluded.target_as_of, tier = excluded.tier, state = excluded.state, reason_code = excluded.reason_code,
        alert = excluded.alert, observed_at = excluded.observed_at;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- RPC: worker heartbeat (upsert). stats = COUNTS only.
create or replace function public.beat_publication_recovery_worker(
  p_worker_id text, p_host text, p_pid integer, p_version text, p_mode text, p_started_at timestamptz,
  p_last_error_code text, p_stats jsonb
) returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.publication_recovery_workers (worker_id, host, pid, version, mode, started_at, last_beat_at, last_error_code, stats)
  values (p_worker_id, left(p_host, 120), p_pid, left(p_version, 64), left(p_mode, 32), p_started_at, now(), left(p_last_error_code, 120), coalesce(p_stats, '{}'::jsonb))
  on conflict (worker_id) do update
    set host = excluded.host, pid = excluded.pid, version = excluded.version, mode = excluded.mode,
        started_at = excluded.started_at, last_beat_at = now(), last_error_code = excluded.last_error_code, stats = excluded.stats;
  return now();
end;
$$;

-- RPC: begin a scan. p_kind 'deep': iff no other holder has a live lease AND the last deep sweep finished >=
-- p_min_interval_seconds ago (or never ran, or its holder's lease expired) -> THIS holder owns the sweep. p_kind 'tier1':
-- claims the tier-1 slot iff the last tier-1 began >= p_min_interval_seconds ago (one worker per interval; no holder).
create or replace function public.try_begin_publication_recovery_scan(
  p_holder text, p_lease_seconds integer default 3600, p_min_interval_seconds integer default 600, p_kind text default 'deep'
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare v public.publication_recovery_scan%rowtype; v_n integer;
begin
  if p_kind = 'tier1' then
    update public.publication_recovery_scan
       set last_tier1_at = now()
     where id = true
       and (last_tier1_at is null
            or last_tier1_at <= now() - make_interval(secs => greatest(60, least(coalesce(p_min_interval_seconds, 600), 86400))));
    get diagnostics v_n = row_count;
    return v_n = 1;
  end if;
  if p_kind is distinct from 'deep' then
    raise exception 'try_begin_publication_recovery_scan: unknown kind %', left(p_kind, 20);
  end if;
  select * into v from public.publication_recovery_scan where id = true for update;
  if not found then return false; end if;
  if v.holder is not null and v.lease_expires_at is not null and v.lease_expires_at > now() and v.holder <> p_holder then
    return false;
  end if;
  if v.last_finished_at is not null
     and v.last_finished_at > now() - make_interval(secs => greatest(60, least(coalesce(p_min_interval_seconds, 600), 86400)))
     and not (v.holder is not null and v.lease_expires_at is not null and v.lease_expires_at <= now()) then
    return false;
  end if;
  update public.publication_recovery_scan
     set holder = left(p_holder, 120),
         lease_expires_at = now() + make_interval(secs => greatest(300, least(coalesce(p_lease_seconds, 3600), 14400))),
         last_started_at = now()
   where id = true;
  return true;
end;
$$;

-- RPC: renew the deep-sweep lease (true). Only the holder may renew.
create or replace function public.renew_publication_recovery_scan(p_holder text, p_lease_seconds integer default 3600)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare v_n integer;
begin
  update public.publication_recovery_scan
     set lease_expires_at = now() + make_interval(secs => greatest(300, least(coalesce(p_lease_seconds, 3600), 14400)))
   where id = true and holder = p_holder;
  get diagnostics v_n = row_count;
  return v_n = 1;
end;
$$;

-- RPC: finish a scan. 'deep': only the holder; releases the lease and records the outcome, summary and the per-route
-- sweep progress (p_deep_sweep). 'tier1': records the tier-1 summary (global alerts, fence state, duration).
create or replace function public.finish_publication_recovery_scan(
  p_holder text, p_outcome text, p_summary jsonb, p_kind text default 'deep', p_deep_sweep jsonb default null
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare v_n integer;
begin
  if p_kind = 'tier1' then
    update public.publication_recovery_scan set tier1_summary = coalesce(p_summary, '{}'::jsonb) where id = true;
    get diagnostics v_n = row_count;
    return v_n = 1;
  end if;
  if p_kind is distinct from 'deep' then
    raise exception 'finish_publication_recovery_scan: unknown kind %', left(p_kind, 20);
  end if;
  update public.publication_recovery_scan
     set holder = null, lease_expires_at = null, last_finished_at = now(),
         last_outcome = left(p_outcome, 64), last_summary = coalesce(p_summary, '{}'::jsonb),
         deep_sweep = coalesce(p_deep_sweep, deep_sweep)
   where id = true and holder = p_holder;
  get diagnostics v_n = row_count;
  return v_n = 1;
end;
$$;

-- RPC: bounded retention (finished jobs + old observations / state), so the tables never grow without bound.
create or replace function public.prune_publication_recovery(p_keep_days integer default 14)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_keep interval := make_interval(days => greatest(3, least(coalesce(p_keep_days, 14), 90))); v_n integer; v_m integer; v_o integer;
begin
  delete from public.publication_recovery_jobs where status in ('verified','superseded','dead') and updated_at < now() - v_keep;
  get diagnostics v_n = row_count;
  delete from public.publication_recovery_observations where observed_at < now() - v_keep;
  get diagnostics v_m = row_count;
  delete from public.publication_recovery_state where observed_at < now() - v_keep;
  get diagnostics v_o = row_count;
  return v_n + v_m + v_o;
end;
$$;

-- RPC: redacted operational status: control + per-route switches and counts, heartbeats, scan (tier-1 summary + deep
-- sweep), jobs, ALERTS, problems, last verified, and the latest-epoch state rows the hand-off matrix is built from. NO
-- payloads, NO secrets. p_detail_limit bounds the lists. ALERTS (codes; each { code, n, ... }):
--   dead-letter (per class), missing-evidence-over-6h, served-row-preempted, zero-export-violation, capacity-exceeded,
--   every alert code a job / state / observation carries (source-stale-manual, await-timeout, writer-fenced,
--   served-row-foreign, token-disagreement, ...), scheduler-gate-starvation (a job held by the global scheduler gate for
--   > 12 h), and the tier-1 global alerts (stranded-partial-cycle, paid-cycle-stale-open, paid-job-stale-in-flight,
--   unregistered-live-report-key, writer-fence state, ...).
create or replace function public.publication_recovery_status(p_detail_limit integer default 200)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lim integer := greatest(1, least(coalesce(p_detail_limit, 200), 1000));
  v_epoch date := (select max(requested_as_of) from public.publication_recovery_state);
  v_alerts jsonb;
begin
  v_alerts := coalesce((select jsonb_agg(a order by a->>'code', a->>'class') from (
      select jsonb_build_object('code', 'dead-letter', 'class', coalesce(j.last_class, '-'), 'n', count(*)::int) as a
        from public.publication_recovery_jobs j where j.status = 'dead' group by coalesce(j.last_class, '-')
      union all
      select jsonb_build_object('code', 'missing-evidence-over-6h', 'n', count(*)::int)
        from public.publication_recovery_state s where s.last_class = 'missing-evidence' and s.class_since < now() - interval '6 hours'
       having count(*) > 0
      union all
      select jsonb_build_object('code', s.last_class, 'n', count(*)::int)
        from public.publication_recovery_state s
       where s.last_class in ('served-row-preempted','zero-export-violation','capacity-exceeded') and s.observed_at > now() - interval '24 hours'
       group by s.last_class
      union all
      select jsonb_build_object('code', x.alert, 'n', count(*)::int)
        from (select j.last_alert as alert from public.publication_recovery_jobs j where j.last_alert is not null and j.updated_at > now() - interval '24 hours'
              union all
              select s.last_alert from public.publication_recovery_state s where s.last_alert is not null and s.observed_at > now() - interval '24 hours'
              union all
              select o.alert from public.publication_recovery_observations o where o.alert is not null and o.observed_at > now() - interval '24 hours') x
       group by x.alert
      union all
      select jsonb_build_object('code', 'scheduler-gate-starvation', 'n', count(*)::int)
        from public.publication_recovery_jobs j
       where j.status = 'deferred' and j.last_class = 'scheduler-window-global' and j.created_at < now() - interval '12 hours'
       having count(*) > 0
      union all
      select t.a
        from public.publication_recovery_scan s,
             lateral jsonb_array_elements(case when jsonb_typeof(s.tier1_summary->'alerts') = 'array' then s.tier1_summary->'alerts' else '[]'::jsonb end) as t(a)
       where s.id = true and jsonb_typeof(t.a) = 'object'
    ) q), '[]'::jsonb);
  return jsonb_build_object(
    'generated_at', now(),
    'control', (select to_jsonb(c) - 'id' from public.publication_recovery_control c where c.id = true),
    'routes', coalesce((select jsonb_agg(jsonb_build_object(
        'route_id', r.route_id, 'grain', r.grain, 'live_report_keys', r.live_report_keys, 'live_enabled', r.live_enabled,
        'live_regions', r.live_regions, 'updated_at', r.updated_at, 'updated_by', r.updated_by,
        'jobs', coalesce((select jsonb_object_agg(status, n) from (select j.status, count(*)::int n from public.publication_recovery_jobs j where j.route_id = r.route_id group by j.status) x), '{}'::jsonb),
        'state', coalesce((select jsonb_object_agg(cls, n) from (select coalesce(s.last_class, '-') cls, count(*)::int n from public.publication_recovery_state s where s.route_id = r.route_id and s.requested_as_of = v_epoch group by coalesce(s.last_class, '-')) x), '{}'::jsonb))
        order by r.route_id) from public.publication_recovery_routes r), '[]'::jsonb),
    'scan', (select to_jsonb(s) - 'id' from public.publication_recovery_scan s where s.id = true),
    'workers', coalesce((select jsonb_agg(jsonb_build_object(
        'worker_id', w.worker_id, 'host', w.host, 'version', w.version, 'mode', w.mode, 'started_at', w.started_at,
        'last_beat_at', w.last_beat_at, 'beat_age_seconds', extract(epoch from now() - w.last_beat_at)::int,
        'last_error_code', w.last_error_code, 'stats', w.stats) order by w.last_beat_at desc)
      from public.publication_recovery_workers w), '[]'::jsonb),
    'jobs', jsonb_build_object(
      'by_status', coalesce((select jsonb_object_agg(status, n) from (select status, count(*)::int n from public.publication_recovery_jobs group by status) x), '{}'::jsonb),
      'ready', (select count(*)::int from public.publication_recovery_jobs where status in ('pending','deferred') and next_attempt_at <= now()),
      'retrying', (select count(*)::int from public.publication_recovery_jobs where status = 'pending' and attempts > 0),
      'dead_letter', (select count(*)::int from public.publication_recovery_jobs where status = 'dead'),
      'oldest_open_created_at', (select min(created_at) from public.publication_recovery_jobs where status in ('pending','claimed','deferred')),
      'oldest_open_lag_seconds', (select extract(epoch from now() - min(created_at))::int from public.publication_recovery_jobs where status in ('pending','claimed','deferred')),
      'by_route_region_class', coalesce((select jsonb_agg(to_jsonb(x)) from (
          select route_id, region, status, coalesce(last_class, '-') as class, count(*)::int n
            from public.publication_recovery_jobs where status in ('pending','claimed','deferred','dead')
           group by route_id, region, status, coalesce(last_class, '-') order by route_id, region, status) x), '[]'::jsonb)),
    'alerts', v_alerts,
    'problems', coalesce((select jsonb_agg(to_jsonb(x)) from (
        select route_id, region, target_key, unit_key, report_key, tier, state, reason_code, alert, requested_as_of, target_as_of, observed_at
          from public.publication_recovery_observations
         where state not in ('PUBLICATION_NOT_REQUIRED','current','ok','not-applicable')
         order by observed_at desc limit v_lim) x), '[]'::jsonb),
    'last_verified', coalesce((select jsonb_agg(to_jsonb(x)) from (
        select route_id, region, target_key, requested_as_of, verified_at, last_class, published
          from public.publication_recovery_jobs where status = 'verified'
         order by verified_at desc limit least(v_lim, 50)) x), '[]'::jsonb),
    'state_epoch', v_epoch,
    -- open_job: a pending / claimed / deferred job exists for the target (the worker is re-checking it); tier1_state:
    -- the target's tier-1 finding ONLY when recorded after the verification (e.g. 'token-advanced'). The hand-off matrix
    -- never says repaired / already-current while either says the verification is no longer the latest word.
    'state', coalesce((select jsonb_agg(to_jsonb(x)) from (
        select s.route_id, s.region, s.target_key, s.owner_account_ids, s.last_class, s.last_reason, s.last_alert, s.handoff, s.served_confirmed,
               s.verified_at, s.class_since, s.observed_at,
               exists (select 1 from public.publication_recovery_jobs j
                        where j.route_id = s.route_id and j.region = s.region and j.target_key = s.target_key
                          and j.requested_as_of = s.requested_as_of and j.status in ('pending','claimed','deferred')) as open_job,
               (select o.state from public.publication_recovery_observations o
                 where o.region = s.region and o.target_key = s.target_key and o.unit_key = '-' and o.report_key = 'tier-1'
                   and o.requested_as_of = s.requested_as_of and o.route_id = s.route_id
                   and (s.verified_at is null or o.observed_at > s.verified_at)) as tier1_state
          from public.publication_recovery_state s
         where s.requested_as_of = v_epoch
         order by s.route_id, s.region, s.target_key limit least(v_lim * 10, 5000)) x), '[]'::jsonb)
  );
end;
$$;

-- 8) LEAST PRIVILEGE: RLS on every table (no policies -> no anon/authenticated access), service_role only.
alter table public.publication_recovery_routes enable row level security;
alter table public.publication_recovery_control enable row level security;
alter table public.publication_recovery_jobs enable row level security;
alter table public.publication_recovery_state enable row level security;
alter table public.publication_recovery_observations enable row level security;
alter table public.publication_recovery_workers enable row level security;
alter table public.publication_recovery_scan enable row level security;
revoke all on table public.publication_recovery_routes from public, anon, authenticated, service_role;
revoke all on table public.publication_recovery_control from public, anon, authenticated, service_role;
revoke all on table public.publication_recovery_jobs from public, anon, authenticated, service_role;
revoke all on table public.publication_recovery_state from public, anon, authenticated, service_role;
revoke all on table public.publication_recovery_observations from public, anon, authenticated, service_role;
revoke all on table public.publication_recovery_workers from public, anon, authenticated, service_role;
revoke all on table public.publication_recovery_scan from public, anon, authenticated, service_role;
grant select on table public.publication_recovery_routes to service_role;
grant select on table public.publication_recovery_control to service_role;
grant select on table public.publication_recovery_jobs to service_role;
grant select on table public.publication_recovery_state to service_role;
grant select on table public.publication_recovery_observations to service_role;
grant select on table public.publication_recovery_workers to service_role;
grant select on table public.publication_recovery_scan to service_role;
revoke all on function public.enqueue_publication_recovery_job(text, text, text, text[], date, text, text, smallint) from public, anon, authenticated;
grant execute on function public.enqueue_publication_recovery_job(text, text, text, text[], date, text, text, smallint) to service_role;
revoke all on function public.claim_publication_recovery_jobs(text, uuid, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.claim_publication_recovery_jobs(text, uuid, integer, integer, integer) to service_role;
revoke all on function public.renew_publication_recovery_claim(uuid[], uuid, integer) from public, anon, authenticated;
grant execute on function public.renew_publication_recovery_claim(uuid[], uuid, integer) to service_role;
revoke all on function public.finish_publication_recovery_job(uuid, uuid, text, text, text, integer, integer, text, text, jsonb, text, boolean, text, boolean, boolean, integer) from public, anon, authenticated;
grant execute on function public.finish_publication_recovery_job(uuid, uuid, text, text, text, integer, integer, text, text, jsonb, text, boolean, text, boolean, boolean, integer) to service_role;
revoke all on function public.record_publication_recovery_baseline(jsonb) from public, anon, authenticated;
grant execute on function public.record_publication_recovery_baseline(jsonb) to service_role;
revoke all on function public.record_publication_recovery_observations(jsonb) from public, anon, authenticated;
grant execute on function public.record_publication_recovery_observations(jsonb) to service_role;
revoke all on function public.beat_publication_recovery_worker(text, text, integer, text, text, timestamptz, text, jsonb) from public, anon, authenticated;
grant execute on function public.beat_publication_recovery_worker(text, text, integer, text, text, timestamptz, text, jsonb) to service_role;
revoke all on function public.try_begin_publication_recovery_scan(text, integer, integer, text) from public, anon, authenticated;
grant execute on function public.try_begin_publication_recovery_scan(text, integer, integer, text) to service_role;
revoke all on function public.renew_publication_recovery_scan(text, integer) from public, anon, authenticated;
grant execute on function public.renew_publication_recovery_scan(text, integer) to service_role;
revoke all on function public.finish_publication_recovery_scan(text, text, jsonb, text, jsonb) from public, anon, authenticated;
grant execute on function public.finish_publication_recovery_scan(text, text, jsonb, text, jsonb) to service_role;
revoke all on function public.prune_publication_recovery(integer) from public, anon, authenticated;
grant execute on function public.prune_publication_recovery(integer) to service_role;
revoke all on function public.publication_recovery_status(integer) from public, anon, authenticated;
grant execute on function public.publication_recovery_status(integer) to service_role;
