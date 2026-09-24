-- ===========================================================================
-- Independent PUBLICATION RECOVERY WORKER -- durable job queue, state, heartbeat, scan lease, control gate
-- ===========================================================================
--
-- PREPARED, NOT APPLIED. EXPAND-ONLY + IDEMPOTENT. Adds SIX new tables and TWELVE new RPCs. Changes NO existing
-- table/column/constraint/trigger/RPC and stores no secret. Apply (only after sign-off) EXACTLY this one file:
--   MIGRATE_ONLY=20260934_publication_recovery_worker.sql npm run db:migrate
-- Rollback (contract): sales-dashboard-live/deploy/publication-recovery/ROLLBACK_20260934.sql (drops ONLY these objects;
-- it is deliberately NOT in supabase/migrations so the ledger-driven runner can never apply it).
--
-- WHY. The worker (scripts/worker/publication-recovery-worker.mjs) detects saved source evidence that has not reached
-- its applicable live dashboard report and invokes the EXISTING zero-export reconciler CLIs to publish + verify it.
-- No existing table can hold its multi-family work safely: report_publication_outbox is OLI-enqueued and its claim is
-- not source/region-filtered (the OLI drain would complete foreign rows); control_plane_lease is THE single global
-- publication lock; sync_targets/sync_runs belong to the legacy sync path. So the worker gets its OWN namespace.
--
-- SAFETY. The worker NEVER writes a dashboard snapshot itself: every live write still goes through the reconcilers'
-- fenced CAS under the global control-plane lease. These tables only coordinate WHICH (family, region, account, as-of)
-- to hand to a reconciler and record what the reconciler's own exact read-back binding proved. The control row
-- defaults to DISABLED with NO live families (observe-only); going live is a separate, signed-off UPDATE.
-- SECURITY DEFINER + fixed search_path + service_role-only EXECUTE + RLS on every table (no anon/authenticated access).

-- 1) CONTROL GATE (production sign-off switch). Single row; enabled=false, live_families={} at first apply. The worker
--    publishes a family ONLY when enabled AND the family is in live_families AND its own env allow-list includes it.
create table if not exists public.publication_recovery_control (
  id boolean primary key default true constraint prc_singleton check (id = true),
  enabled boolean not null default false,
  live_families text[] not null default '{}'::text[]
    constraint prc_families_known check (live_families <@ array['oli','fba','ads','listings']::text[]),
  updated_at timestamptz not null default now(),
  updated_by text
);
insert into public.publication_recovery_control (id, enabled, live_families) values (true, false, '{}'::text[])
  on conflict (id) do nothing;

-- 2) JOBS. At most ONE live (pending/claimed/deferred) job per (family, region, account, requested_as_of), coalescing
--    repeated detections. attempts counts only EXECUTED failures; claims counts CONSECUTIVE claims that never reached
--    an owner finish (reset by every finish except 'released') -- the crash-loop guard.
create table if not exists public.publication_recovery_jobs (
  id uuid primary key default gen_random_uuid(),
  family text not null constraint prj_family_check check (family in ('oli','fba','ads','listings')),
  region text not null constraint prj_region_check check (region in ('india','europe-au','us-ca')),
  account_id text not null constraint prj_account_canonical check (char_length(btrim(account_id)) > 0 and account_id = btrim(account_id)),
  requested_as_of date not null,
  evidence_token text constraint prj_token_len check (evidence_token is null or char_length(evidence_token) <= 512),
  origin text not null constraint prj_origin_check check (origin in ('watermark','scan','manual')),
  status text not null default 'pending'
    constraint prj_status_check check (status in ('pending','claimed','deferred','verified','dead','superseded')),
  priority smallint not null default 5 constraint prj_priority_check check (priority between 1 and 9),
  attempts integer not null default 0 constraint prj_attempts_nonneg check (attempts >= 0),
  claims integer not null default 0 constraint prj_claims_nonneg check (claims >= 0),
  claim_token uuid,
  claimed_by text,
  claimed_at timestamptz,
  lease_expires_at timestamptz,
  next_attempt_at timestamptz not null default now(),
  last_class text constraint prj_class_len check (last_class is null or char_length(last_class) <= 64),
  last_reason text constraint prj_reason_len check (last_reason is null or char_length(last_reason) <= 240),
  last_run_token text constraint prj_run_token_len check (last_run_token is null or char_length(last_run_token) <= 200),
  verified_at timestamptz,
  dead_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists publication_recovery_jobs_live_key
  on public.publication_recovery_jobs (family, region, account_id, requested_as_of)
  where status in ('pending','claimed','deferred');
create index if not exists publication_recovery_jobs_ready_idx
  on public.publication_recovery_jobs (status, priority, next_attempt_at);
create index if not exists publication_recovery_jobs_history_idx
  on public.publication_recovery_jobs (family, region, account_id, requested_as_of, updated_at desc);

-- 3) PER-(family, region, account, as-of) STATE: the last evidence token the reconciler's own read-back binding
--    PROVED current (so an unchanged token is never re-enqueued), the token the latest scan OBSERVED (whatever its
--    class -- so the watermark only reacts to evidence that CHANGED since the scan classified it), plus the latest
--    classification for status.
create table if not exists public.publication_recovery_state (
  family text not null constraint prs_family_check check (family in ('oli','fba','ads','listings')),
  region text not null constraint prs_region_check check (region in ('india','europe-au','us-ca')),
  account_id text not null,
  requested_as_of date not null,
  verified_token text constraint prs_token_len check (verified_token is null or char_length(verified_token) <= 512),
  observed_token text constraint prs_observed_len check (observed_token is null or char_length(observed_token) <= 512),
  verified_at timestamptz,
  last_class text constraint prs_class_len check (last_class is null or char_length(last_class) <= 64),
  last_reason text constraint prs_reason_len check (last_reason is null or char_length(last_reason) <= 240),
  observed_at timestamptz not null default now(),
  primary key (family, region, account_id, requested_as_of)
);

-- 4) PER-REPORT OBSERVATIONS (status/detail panel). family is the reconciler family, or 'detect' for a report with
--    no zero-export publisher (detect-and-report only). Reason CODES only -- never payloads.
create table if not exists public.publication_recovery_observations (
  region text not null constraint pro_region_check check (region in ('india','europe-au','us-ca')),
  account_id text not null,
  report_key text not null constraint pro_report_len check (char_length(report_key) between 1 and 64),
  requested_as_of date not null,
  family text not null constraint pro_family_check check (family in ('oli','fba','ads','listings','detect')),
  state text not null constraint pro_state_len check (char_length(state) between 1 and 64),
  reason_code text constraint pro_reason_len check (reason_code is null or char_length(reason_code) <= 120),
  observed_at timestamptz not null default now(),
  primary key (region, account_id, report_key, requested_as_of, family)
);

-- 5) WORKER HEARTBEATS (one row per worker id). stats holds COUNTS only (bounded size).
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

-- 6) FULL-SCAN SINGLE-FLIGHT LEASE + schedule (DB-durable: the 10-minute cadence survives restarts; two workers can
--    never scan concurrently). Single row.
create table if not exists public.publication_recovery_scan (
  id boolean primary key default true constraint prsc_singleton check (id = true),
  holder text,
  lease_expires_at timestamptz,
  last_started_at timestamptz,
  last_finished_at timestamptz,
  last_outcome text constraint prsc_outcome_len check (last_outcome is null or char_length(last_outcome) <= 64),
  last_summary jsonb not null default '{}'::jsonb constraint prsc_summary_bounded check (pg_column_size(last_summary) <= 16384)
);
insert into public.publication_recovery_scan (id) values (true) on conflict (id) do nothing;

-- ---------------------------------------------------------------------------------------------------------------
-- RPC: enqueue (idempotent coalescing). Returns one of:
--   'enqueued'           a new pending job was created
--   'refreshed'          a live job exists; its evidence token advanced (a deferred job is re-armed to pending)
--   'exists'             a live job with the same token already exists
--   'already-verified'   the reconciler already PROVED this exact token current (watermark origin only)
--   'dead-same-evidence' a job for this exact token already dead-lettered (permanent errors never loop)
create or replace function public.enqueue_publication_recovery_job(
  p_family text, p_region text, p_account_id text, p_requested_as_of date,
  p_evidence_token text, p_origin text, p_priority smallint default 5
) returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_live public.publication_recovery_jobs%rowtype;
  v_verified text;
begin
  if p_family is null or p_region is null or p_account_id is null or p_requested_as_of is null or p_origin is null then
    raise exception 'enqueue_publication_recovery_job: family/region/account/as-of/origin are required';
  end if;
  perform pg_advisory_xact_lock(hashtext('publication-recovery|' || p_family || '|' || p_region || '|' || p_account_id || '|' || p_requested_as_of::text));
  select * into v_live from public.publication_recovery_jobs
   where family = p_family and region = p_region and account_id = p_account_id and requested_as_of = p_requested_as_of
     and status in ('pending','claimed','deferred')
   for update;
  if found then
    if p_evidence_token is not null and v_live.evidence_token is distinct from p_evidence_token then
      update public.publication_recovery_jobs
         set evidence_token = p_evidence_token,
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
     where family = p_family and region = p_region and account_id = p_account_id and requested_as_of = p_requested_as_of;
    if v_verified is not null and v_verified = p_evidence_token then
      return 'already-verified';
    end if;
  end if;
  if exists (select 1 from public.publication_recovery_jobs
              where family = p_family and region = p_region and account_id = p_account_id
                and requested_as_of = p_requested_as_of and status = 'dead'
                and evidence_token is not distinct from p_evidence_token) then
    return 'dead-same-evidence';
  end if;
  insert into public.publication_recovery_jobs (family, region, account_id, requested_as_of, evidence_token, origin, priority)
  values (p_family, p_region, p_account_id, p_requested_as_of, p_evidence_token, p_origin, coalesce(p_priority, 5));
  return 'enqueued';
end;
$$;

-- RPC: claim a COHERENT batch (same family + region + as-of) of ready jobs under a bounded lease. Ready = pending or
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
  select family, region, requested_as_of into v_head
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
     where family = v_head.family and region = v_head.region and requested_as_of = v_head.requested_as_of
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

-- RPC: extend the lease of jobs this claim token still holds (long reconciles). Returns the number renewed.
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
-- token the job carried WHEN IT WAS CLAIMED (the evidence this outcome is about). If an enqueue refreshed the job's
-- evidence while it ran, a 'verified' / 'retry' / 'deferred' / 'dead' outcome describes OLD evidence, so the job is
-- RE-ARMED instead (pending now, attempts and claims reset) -> returns 're-armed'. A dead-letter is therefore never
-- stamped with evidence the reconciler did not evaluate. Outcomes:
--   'verified'   the reconciler's exact read-back binding proved the live report current for p_evaluated_token.
--   'retry'      an executed attempt failed retryably: attempts+1, backoff; dead-letters at p_max_attempts.
--   'deferred'   not executed / legitimately not publishable yet (contention, dependency, missing evidence):
--                attempts unchanged, backoff.
--   'released'   handed back unexecuted (graceful shutdown): claims-1, immediately ready.
--   'dead'       permanent integrity error: dead-lettered, never retried for this evidence token.
--   'superseded' a newer as-of made this job moot.
-- claims counts CONSECUTIVE claims that never reached an owner finish (the crash-loop guard in claim): every owner
-- finish except 'released' resets it to 0, and 'released' undoes its own claim.
create or replace function public.finish_publication_recovery_job(
  p_id uuid, p_claim_token uuid, p_outcome text, p_class text, p_reason text,
  p_backoff_seconds integer default 60, p_max_attempts integer default 6,
  p_run_token text default null, p_evaluated_token text default null
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
begin
  select * into v from public.publication_recovery_jobs where id = p_id for update;
  if not found then return 'not-found'; end if;
  if v.status <> 'claimed' or v.claim_token is distinct from p_claim_token then return 'not-owner'; end if;
  if p_outcome in ('verified','retry','deferred','dead')
     and v.evidence_token is not null and p_evaluated_token is distinct from v.evidence_token then
    update public.publication_recovery_jobs
       set status = 'pending', next_attempt_at = now(), attempts = 0, claims = 0,
           claim_token = null, claimed_by = null, lease_expires_at = null,
           last_class = 'evidence-advanced', last_reason = left('evidence advanced while the job ran (' || p_outcome || ':' || v_class || '); re-evaluating', 240),
           last_run_token = coalesce(left(p_run_token, 200), last_run_token), updated_at = now()
     where id = p_id;
    return 're-armed';
  end if;
  if p_outcome = 'verified' then
    update public.publication_recovery_jobs
       set status = 'verified', verified_at = now(), claims = 0, claim_token = null, claimed_by = null, lease_expires_at = null,
           last_class = v_class, last_reason = v_reason, last_run_token = left(p_run_token, 200), updated_at = now()
     where id = p_id;
    insert into public.publication_recovery_state (family, region, account_id, requested_as_of, verified_token, observed_token, verified_at, last_class, last_reason, observed_at)
    values (v.family, v.region, v.account_id, v.requested_as_of, v.evidence_token, v.evidence_token, now(), v_class, v_reason, now())
    on conflict (family, region, account_id, requested_as_of) do update
      set verified_token = excluded.verified_token, observed_token = excluded.observed_token, verified_at = excluded.verified_at,
          last_class = excluded.last_class, last_reason = excluded.last_reason, observed_at = excluded.observed_at;
    return 'verified';
  elsif p_outcome = 'retry' then
    if v.attempts + 1 >= v_max then
      update public.publication_recovery_jobs
         set status = 'dead', dead_at = now(), attempts = v.attempts + 1, claims = 0, claim_token = null, claimed_by = null,
             lease_expires_at = null, last_class = 'max-attempts:' || left(v_class, 50), last_reason = v_reason,
             last_run_token = left(p_run_token, 200), updated_at = now()
       where id = p_id;
      return 'dead';
    end if;
    update public.publication_recovery_jobs
       set status = 'pending', attempts = v.attempts + 1, claims = 0, next_attempt_at = now() + make_interval(secs => v_backoff),
           claim_token = null, claimed_by = null, lease_expires_at = null, last_class = v_class, last_reason = v_reason,
           last_run_token = left(p_run_token, 200), updated_at = now()
     where id = p_id;
    return 'retry';
  elsif p_outcome = 'deferred' then
    update public.publication_recovery_jobs
       set status = 'deferred', claims = 0, next_attempt_at = now() + make_interval(secs => v_backoff),
           claim_token = null, claimed_by = null, lease_expires_at = null, last_class = v_class, last_reason = v_reason,
           last_run_token = coalesce(left(p_run_token, 200), last_run_token), updated_at = now()
     where id = p_id;
    return 'deferred';
  elsif p_outcome = 'released' then
    update public.publication_recovery_jobs
       set status = 'pending', claims = greatest(v.claims - 1, 0), next_attempt_at = now(),
           claim_token = null, claimed_by = null, lease_expires_at = null, last_class = 'released', updated_at = now()
     where id = p_id;
    return 'released';
  elsif p_outcome = 'dead' then
    update public.publication_recovery_jobs
       set status = 'dead', dead_at = now(), claims = 0, claim_token = null, claimed_by = null, lease_expires_at = null,
           last_class = v_class, last_reason = v_reason, last_run_token = coalesce(left(p_run_token, 200), last_run_token),
           updated_at = now()
     where id = p_id;
    return 'dead';
  elsif p_outcome = 'superseded' then
    update public.publication_recovery_jobs
       set status = 'superseded', claims = 0, claim_token = null, claimed_by = null, lease_expires_at = null,
           last_class = v_class, last_reason = v_reason, updated_at = now()
     where id = p_id;
    return 'superseded';
  end if;
  raise exception 'finish_publication_recovery_job: unknown outcome %', p_outcome;
end;
$$;

-- RPC: record the reconciler dry-run's PROOF that an account family is current for a token (scan baseline), so the
-- watermark poll does not re-enqueue it. Rows: [{family, region, account_id, requested_as_of, token, class, reason}].
create or replace function public.record_publication_recovery_baseline(p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_n integer;
begin
  insert into public.publication_recovery_state (family, region, account_id, requested_as_of, verified_token, observed_token, verified_at, last_class, last_reason, observed_at)
  -- A token is recorded as VERIFIED only when the reconciler's binding proved the family current ('current'); a first
  -- observation of a stale/deferred account must NOT seed verified_token (else the watermark pass would skip it).
  -- observed_token is recorded for EVERY class: the scan already acted on that evidence (enqueued it when stale;
  -- reported it when missing/deferred), so the watermark must react only to a token that differs from it.
  select r->>'family', r->>'region', r->>'account_id', (r->>'requested_as_of')::date,
         case when r->>'class' = 'current' then nullif(r->>'token', '') else null end,
         left(nullif(r->>'token', ''), 512),
         case when r->>'class' = 'current' then now() else null end,
         left(r->>'class', 64), left(r->>'reason', 240), now()
    from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r
  on conflict (family, region, account_id, requested_as_of) do update
    set verified_token = case when excluded.last_class = 'current' then excluded.verified_token else publication_recovery_state.verified_token end,
        verified_at = case when excluded.last_class = 'current' then excluded.verified_at else publication_recovery_state.verified_at end,
        observed_token = excluded.observed_token,
        last_class = excluded.last_class, last_reason = excluded.last_reason, observed_at = excluded.observed_at;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- RPC: upsert per-report observations (status panel). Rows: [{region, account_id, report_key, requested_as_of,
-- family, state, reason_code}].
create or replace function public.record_publication_recovery_observations(p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_n integer;
begin
  insert into public.publication_recovery_observations (region, account_id, report_key, requested_as_of, family, state, reason_code, observed_at)
  select r->>'region', r->>'account_id', r->>'report_key', (r->>'requested_as_of')::date, r->>'family',
         left(r->>'state', 64), left(r->>'reason_code', 120), now()
    from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r
  on conflict (region, account_id, report_key, requested_as_of, family) do update
    set state = excluded.state, reason_code = excluded.reason_code, observed_at = excluded.observed_at;
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

-- RPC: begin a full scan iff no other holder has a live scan lease AND the last scan finished >= p_min_interval_seconds
-- ago (or never ran). Returns true when THIS holder now owns the scan.
create or replace function public.try_begin_publication_recovery_scan(
  p_holder text, p_lease_seconds integer default 3600, p_min_interval_seconds integer default 600
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare v public.publication_recovery_scan%rowtype;
begin
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

-- RPC: renew (true) / finish (outcome) the scan lease. Only the holder may act.
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

create or replace function public.finish_publication_recovery_scan(p_holder text, p_outcome text, p_summary jsonb)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare v_n integer;
begin
  update public.publication_recovery_scan
     set holder = null, lease_expires_at = null, last_finished_at = now(),
         last_outcome = left(p_outcome, 64), last_summary = coalesce(p_summary, '{}'::jsonb)
   where id = true and holder = p_holder;
  get diagnostics v_n = row_count;
  return v_n = 1;
end;
$$;

-- RPC: bounded retention (finished jobs + old observations/state), so the tables never grow without bound.
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

-- RPC: redacted operational status (counts, lag, heartbeats, scan, per-region/account/report reason codes, last
-- verified). NO payloads, NO secrets. p_detail_limit bounds the problem/verified lists.
create or replace function public.publication_recovery_status(p_detail_limit integer default 200)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_lim integer := greatest(1, least(coalesce(p_detail_limit, 200), 1000));
begin
  return jsonb_build_object(
    'generated_at', now(),
    'control', (select to_jsonb(c) - 'id' from public.publication_recovery_control c where c.id = true),
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
      'by_region_family_class', coalesce((select jsonb_agg(to_jsonb(x)) from (
          select region, family, status, coalesce(last_class, '-') as class, count(*)::int n
            from public.publication_recovery_jobs where status in ('pending','claimed','deferred','dead')
           group by region, family, status, coalesce(last_class, '-') order by region, family, status) x), '[]'::jsonb)),
    'problems', coalesce((select jsonb_agg(to_jsonb(x)) from (
        select region, account_id, report_key, family, state, reason_code, requested_as_of, observed_at
          from public.publication_recovery_observations
         where state not in ('PUBLICATION_NOT_REQUIRED','current','not-applicable')
         order by observed_at desc limit v_lim) x), '[]'::jsonb),
    'last_verified', coalesce((select jsonb_agg(to_jsonb(x)) from (
        select region, family, account_id, requested_as_of, verified_at, last_class
          from public.publication_recovery_jobs where status = 'verified'
         order by verified_at desc limit least(v_lim, 50)) x), '[]'::jsonb)
  );
end;
$$;

-- 7) LEAST PRIVILEGE: RLS on every table (no policies -> no anon/authenticated access), service_role only.
alter table public.publication_recovery_control enable row level security;
alter table public.publication_recovery_jobs enable row level security;
alter table public.publication_recovery_state enable row level security;
alter table public.publication_recovery_observations enable row level security;
alter table public.publication_recovery_workers enable row level security;
alter table public.publication_recovery_scan enable row level security;
revoke all on table public.publication_recovery_control from public, anon, authenticated, service_role;
revoke all on table public.publication_recovery_jobs from public, anon, authenticated, service_role;
revoke all on table public.publication_recovery_state from public, anon, authenticated, service_role;
revoke all on table public.publication_recovery_observations from public, anon, authenticated, service_role;
revoke all on table public.publication_recovery_workers from public, anon, authenticated, service_role;
revoke all on table public.publication_recovery_scan from public, anon, authenticated, service_role;
grant select on table public.publication_recovery_control to service_role;
grant select on table public.publication_recovery_jobs to service_role;
grant select on table public.publication_recovery_state to service_role;
grant select on table public.publication_recovery_observations to service_role;
grant select on table public.publication_recovery_workers to service_role;
grant select on table public.publication_recovery_scan to service_role;
revoke all on function public.enqueue_publication_recovery_job(text, text, text, date, text, text, smallint) from public, anon, authenticated;
grant execute on function public.enqueue_publication_recovery_job(text, text, text, date, text, text, smallint) to service_role;
revoke all on function public.claim_publication_recovery_jobs(text, uuid, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.claim_publication_recovery_jobs(text, uuid, integer, integer, integer) to service_role;
revoke all on function public.renew_publication_recovery_claim(uuid[], uuid, integer) from public, anon, authenticated;
grant execute on function public.renew_publication_recovery_claim(uuid[], uuid, integer) to service_role;
revoke all on function public.finish_publication_recovery_job(uuid, uuid, text, text, text, integer, integer, text, text) from public, anon, authenticated;
grant execute on function public.finish_publication_recovery_job(uuid, uuid, text, text, text, integer, integer, text, text) to service_role;
revoke all on function public.record_publication_recovery_baseline(jsonb) from public, anon, authenticated;
grant execute on function public.record_publication_recovery_baseline(jsonb) to service_role;
revoke all on function public.record_publication_recovery_observations(jsonb) from public, anon, authenticated;
grant execute on function public.record_publication_recovery_observations(jsonb) to service_role;
revoke all on function public.beat_publication_recovery_worker(text, text, integer, text, text, timestamptz, text, jsonb) from public, anon, authenticated;
grant execute on function public.beat_publication_recovery_worker(text, text, integer, text, text, timestamptz, text, jsonb) to service_role;
revoke all on function public.try_begin_publication_recovery_scan(text, integer, integer) from public, anon, authenticated;
grant execute on function public.try_begin_publication_recovery_scan(text, integer, integer) to service_role;
revoke all on function public.renew_publication_recovery_scan(text, integer) from public, anon, authenticated;
grant execute on function public.renew_publication_recovery_scan(text, integer) to service_role;
revoke all on function public.finish_publication_recovery_scan(text, text, jsonb) from public, anon, authenticated;
grant execute on function public.finish_publication_recovery_scan(text, text, jsonb) to service_role;
revoke all on function public.prune_publication_recovery(integer) from public, anon, authenticated;
grant execute on function public.prune_publication_recovery(integer) to service_role;
revoke all on function public.publication_recovery_status(integer) from public, anon, authenticated;
grant execute on function public.publication_recovery_status(integer) to service_role;
