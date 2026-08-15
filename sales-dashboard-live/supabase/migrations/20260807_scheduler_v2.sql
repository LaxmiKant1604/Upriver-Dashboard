-- 20260807_scheduler_v2.sql
-- Scheduler v2 — the source-first dependency graph.
--
-- ADDITIVE ONLY. Creates three new tables and two helper RPCs; never alters or
-- drops an existing table, and never touches historical Ads data. Reuses the
-- helpers from earlier migrations: touch_updated_at(), is_dashboard_admin(), and
-- the canonical identity already produced by lib/server/datadoe.js
-- (source_export_cache.request_hash from 20260806_shared_source_export_cache.sql).
--
-- Rollout: this migration is the backend FOUNDATION. It can be applied while
-- production keeps serving existing last-known-good snapshots (Scheduler v2 runs
-- in shadow mode). The pg_cron/pg_net kickoff and its Vault secret are a SEPARATE
-- migration (20260808_scheduler_v2_kickoff.sql) applied only after the secrets are
-- loaded into Supabase Vault. NO secret value appears in any migration file.
--
-- Model (why three tables):
--   sync_cycles       one idempotent row per (bucket, cycle_date). The single
--                     user-visible sync cycle. Kickoff opens exactly one.
--   sync_source_jobs  one row per UNIQUE canonical DataDoe source per cycle
--                     (unique(cycle_id, request_hash)). A single cycle can contain
--                     many source exports because DataDoe cannot combine unrelated
--                     sources; token saving comes from fetching each canonical
--                     request_hash only ONCE and reusing it across every report
--                     that needs it. attempted_at is the durable guard that a
--                     second create-export POST never runs for the same request
--                     hash in the same cycle, across separate worker invocations.
--   sync_report_jobs  one row per (cycle, report_key, account scope). Each report
--                     DERIVES from already-fetched source rows; it declares which
--                     request_hashes it depends on and records fetch/save/derive
--                     status separately so a Supabase save failure is never
--                     confused with a DataDoe fetch failure.
--
-- "One attempt" is defined precisely: one DataDoe POST create-export call per
-- (cycle_id, request_hash). Polling and downloading an already-created export may
-- continue, but create-export never runs again during the same cycle. A failed or
-- timed-out source waits for the next scheduled cycle; the last-known-good source
-- rows and report snapshots are preserved and never overwritten with empty,
-- partial, truncated, or failed data.

-- ---------------------------------------------------------------------------
-- 1. sync_cycles — one idempotent cycle per (bucket, cycle_date).
-- ---------------------------------------------------------------------------
create table if not exists public.sync_cycles (
  id uuid primary key default gen_random_uuid(),
  bucket text not null check (bucket in ('us', 'non-us')),
  cycle_date date not null,
  trigger text not null default 'pg_cron'
    check (trigger in ('pg_cron', 'github', 'vercel', 'manual')),
  status text not null default 'pending'
    check (status in ('pending', 'running', 'succeeded', 'partial', 'failed')),
  scheduled_at timestamptz,               -- the exact 02:00 / 10:30 UTC target
  started_at timestamptz,                 -- actual worker start
  finished_at timestamptz,                -- actual drain/finish
  source_total integer not null default 0,
  source_succeeded integer not null default 0,
  source_failed integer not null default 0,
  report_total integer not null default 0,
  report_succeeded integer not null default 0,
  report_failed integer not null default 0,
  counts jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sync_cycles_bucket_date_unique unique (bucket, cycle_date)
);
create index if not exists sync_cycles_bucket_date_idx
  on public.sync_cycles (bucket, cycle_date desc);

-- ---------------------------------------------------------------------------
-- 2. sync_source_jobs — one row per unique canonical source per cycle.
--    unique(cycle_id, request_hash) deduplicates a source needed by many
--    reports into a single DataDoe export.
-- ---------------------------------------------------------------------------
create table if not exists public.sync_source_jobs (
  id uuid primary key default gen_random_uuid(),
  cycle_id uuid not null references public.sync_cycles (id) on delete cascade,
  request_hash text not null,             -- == lib/server/datadoe.js sourceRequestIdentity
  source_id text not null,
  source_key text not null default '',    -- human contract key, e.g. 'order-line-items'
  organization_fingerprint text not null default '',
  connection_id text not null default 'primary',  -- 'primary' | 'dd-secondary' (org isolation)
  account_scope_hash text not null default '',
  request_meta jsonb not null default '{}'::jsonb, -- columns, grain, aggregations, window, limit, ordering
  bucket text not null check (bucket in ('us', 'non-us')),
  fetch_status text not null default 'pending'
    check (fetch_status in ('pending', 'attempted', 'succeeded', 'failed', 'skipped')),
  attempted_at timestamptz,               -- set once, on the first create-export POST
  create_export_count integer not null default 0 check (create_export_count >= 0),
  export_id text,                         -- the DataDoe export id, so poll/download can resume
  succeeded_at timestamptz,
  failed_at timestamptz,
  error_stage text                        -- 'create-export' | 'poll' | 'download' | 'validate' | 'persist'
    check (error_stage is null or error_stage in ('create-export', 'poll', 'download', 'validate', 'persist')),
  error_code text,                        -- SAFE code only: 'HTTP_402' | 'HTTP_404' | 'TIMEOUT' | 'TRUNCATED' | ...
  error_message text,                     -- SAFE operator message; never a secret or raw key
  terminal boolean not null default false,-- 402/404/truncated => terminal for this source+cycle
  row_count integer,
  payload_bytes bigint,
  duration_ms integer,
  cache_object_path text,                 -- last-known-good source payload in Storage (source_export_cache)
  last_good_fetched_at timestamptz,       -- previous successful fetch preserved on failure
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sync_source_jobs_cycle_hash_unique unique (cycle_id, request_hash),
  -- The database itself caps create-export at ONE per source job and keeps the
  -- counter and attempted_at consistent, so a direct service-role write or a
  -- future worker bug cannot record a second create-export. The only legal states
  -- are: not-yet-attempted (0 / NULL) and attempted-once (1 / NOT NULL).
  constraint sync_source_jobs_one_attempt check (
    (create_export_count = 0 and attempted_at is null)
    or (create_export_count = 1 and attempted_at is not null)
  )
);
create index if not exists sync_source_jobs_cycle_idx
  on public.sync_source_jobs (cycle_id, fetch_status);
create index if not exists sync_source_jobs_pending_idx
  on public.sync_source_jobs (cycle_id) where fetch_status = 'pending';
create index if not exists sync_source_jobs_source_idx
  on public.sync_source_jobs (source_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 3. sync_report_jobs — one row per (cycle, report_key, account scope).
--    Derives from already-fetched sources. fetch/save/derive statuses are
--    recorded separately so a Supabase save failure is never reported as a
--    DataDoe failure.
-- ---------------------------------------------------------------------------
create table if not exists public.sync_report_jobs (
  id uuid primary key default gen_random_uuid(),
  cycle_id uuid not null references public.sync_cycles (id) on delete cascade,
  report_key text not null,
  report_version text not null default '',
  account_id text not null,               -- connection-scoped id, or '__bucket:<bucket>:<scope>' for per-bucket
  connection_id text not null default 'primary',
  bucket text not null check (bucket in ('us', 'non-us')),
  depends_on jsonb not null default '[]'::jsonb,  -- array of request_hash this report needs
  fetch_status text not null default 'pending'    -- rollup of the source deps
    check (fetch_status in ('pending', 'ready', 'blocked', 'failed')),
  derive_status text not null default 'pending'
    check (derive_status in ('pending', 'running', 'succeeded', 'failed', 'skipped')),
  save_status text not null default 'pending'
    check (save_status in ('pending', 'succeeded', 'failed', 'skipped')),
  validated boolean not null default false, -- success REQUIRES fetch + derive + save + validation
  error_stage text                          -- 'fetch' | 'derive' | 'validate' | 'save'
    check (error_stage is null or error_stage in ('fetch', 'derive', 'validate', 'save')),
  error_code text,                          -- SAFE code only
  error_message text,                       -- SAFE operator message; never a secret
  row_count integer,
  payload_bytes bigint,
  duration_ms integer,
  latest_data_date date,                    -- actual latest data date in the derived payload
  snapshot_params_hash text,                -- the saved report_snapshots key (this cycle's snapshot)
  last_good_snapshot_at timestamptz,        -- previous successful snapshot preserved on failure
  succeeded_at timestamptz,
  failed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sync_report_jobs_cycle_report_account_unique unique (cycle_id, report_key, account_id)
);
create index if not exists sync_report_jobs_cycle_idx
  on public.sync_report_jobs (cycle_id, derive_status, save_status);
create index if not exists sync_report_jobs_report_idx
  on public.sync_report_jobs (report_key, account_id, created_at desc);

-- ---------------------------------------------------------------------------
-- updated_at triggers (reuse the existing touch_updated_at() function).
-- ---------------------------------------------------------------------------
drop trigger if exists sync_cycles_touch on public.sync_cycles;
create trigger sync_cycles_touch before update on public.sync_cycles
  for each row execute function public.touch_updated_at();
drop trigger if exists sync_source_jobs_touch on public.sync_source_jobs;
create trigger sync_source_jobs_touch before update on public.sync_source_jobs
  for each row execute function public.touch_updated_at();
drop trigger if exists sync_report_jobs_touch on public.sync_report_jobs;
create trigger sync_report_jobs_touch before update on public.sync_report_jobs
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- open_sync_cycle — idempotent kickoff/ENQUEUE primitive. Multiple triggers
-- (pg_cron, GitHub watchdog, Vercel watchdog) for the same (bucket, cycle_date)
-- resolve to ONE cycle row. It creates the cycle as 'pending' with started_at
-- LEFT NULL: kickoff does not pretend execution began. Repeated calls return the
-- existing cycle unchanged (only updated_at is touched), never a duplicate and
-- never a status/timing reset. scheduled_at (the 02:00/10:30 target) is recorded
-- here; the real start time is stamped later by claim_sync_cycle.
-- ---------------------------------------------------------------------------
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
  if p_bucket not in ('us', 'non-us') then
    raise exception 'Invalid bucket %', p_bucket;
  end if;

  insert into public.sync_cycles (bucket, cycle_date, scheduled_at, trigger, status)
  values (p_bucket, p_cycle_date, p_scheduled_at, coalesce(p_trigger, 'pg_cron'), 'pending')
  on conflict (bucket, cycle_date) do update set updated_at = now()
  returning id into v_id;

  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- claim_sync_cycle — the worker START transition. Atomically moves a PENDING
-- cycle to RUNNING and stamps started_at exactly when worker processing begins.
-- Returns TRUE only for the caller that won the transition; a cycle already
-- running or finished matches nothing and returns FALSE, so it can never be
-- claimed twice or restarted. Because scheduled_at is set at kickoff and
-- started_at only here, the Admin Data Sync Center can report truthful timings.
-- ---------------------------------------------------------------------------
create or replace function public.claim_sync_cycle(p_cycle_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.sync_cycles
     set status = 'running',
         started_at = now(),
         updated_at = now()
   where id = p_cycle_id
     and status = 'pending';

  -- FOUND is true only if this caller performed the single pending -> running
  -- transition. A concurrent/repeated caller finds status <> 'pending' and gets
  -- FALSE; started_at is never overwritten.
  return found;
end;
$$;

-- ---------------------------------------------------------------------------
-- claim_source_export_attempt — the durable one-attempt guard. Atomically marks
-- a source job as attempted and returns TRUE only for the caller that made the
-- first (and only) DataDoe create-export POST for this (cycle, request_hash).
-- Every later caller — including a retrying or parallel worker — gets FALSE and
-- MUST NOT create a new export. It may still poll/download the existing
-- export_id. This enforces "one create-export per request_hash per cycle" even
-- across separate serverless invocations, where the in-process caches in
-- datadoe.js cannot.
-- ---------------------------------------------------------------------------
create or replace function public.claim_source_export_attempt(
  p_cycle_id uuid,
  p_request_hash text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.sync_source_jobs
     set attempted_at = now(),
         create_export_count = create_export_count + 1,
         fetch_status = 'attempted',
         updated_at = now()
   where cycle_id = p_cycle_id
     and request_hash = p_request_hash
     and attempted_at is null;

  -- FOUND is true only if the update affected the row, i.e. this caller won the
  -- single attempt. A second caller finds attempted_at already set and gets FALSE.
  return found;
end;
$$;

-- ---------------------------------------------------------------------------
-- RLS. Service-role (secret key) bypasses RLS for all writes. Browser reads are
-- admin-only: the Admin Data Sync Center reads these through an admin API, and no
-- sync internals are exposed to ordinary users.
-- ---------------------------------------------------------------------------
alter table public.sync_cycles enable row level security;
alter table public.sync_source_jobs enable row level security;
alter table public.sync_report_jobs enable row level security;

drop policy if exists "admins read sync cycles" on public.sync_cycles;
create policy "admins read sync cycles" on public.sync_cycles
  for select to authenticated using (public.is_dashboard_admin());

drop policy if exists "admins read sync source jobs" on public.sync_source_jobs;
create policy "admins read sync source jobs" on public.sync_source_jobs
  for select to authenticated using (public.is_dashboard_admin());

drop policy if exists "admins read sync report jobs" on public.sync_report_jobs;
create policy "admins read sync report jobs" on public.sync_report_jobs
  for select to authenticated using (public.is_dashboard_admin());

revoke all on function public.open_sync_cycle(text, date, timestamptz, text) from public, anon, authenticated;
revoke all on function public.claim_sync_cycle(uuid) from public, anon, authenticated;
revoke all on function public.claim_source_export_attempt(uuid, text) from public, anon, authenticated;
grant execute on function public.open_sync_cycle(text, date, timestamptz, text) to service_role;
grant execute on function public.claim_sync_cycle(uuid) to service_role;
grant execute on function public.claim_source_export_attempt(uuid, text) to service_role;
