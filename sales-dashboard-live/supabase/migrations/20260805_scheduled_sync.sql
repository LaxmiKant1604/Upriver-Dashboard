-- 20260805_scheduled_sync.sql
-- Foundation for the website-wide, registry-driven scheduled DataDoe sync.
-- ADDITIVE ONLY: creates new tables; never alters existing ones. Reuses the
-- helpers created by 20260728_shared_dashboard.sql / 20260729_dashboard_auth_and_access.sql:
--   touch_updated_at(), is_dashboard_admin(), report_refresh_locks +
--   claim_report_refresh_lock() (the scheduled sync reuses those locks, so no new
--   lock table and no heartbeat RPC are introduced).
-- Idempotent: create table if not exists + drop/create policy (Postgres has no
-- "create policy if not exists").

-- 1. account_directory -- durable record of every DataDoe account across BOTH
-- connections and its scheduling bucket. The public (connection-scoped) id is the
-- PK, so a secondary-org account is stored as 'dd-secondary:<raw>' and can never
-- collide with a primary id.
create table if not exists public.account_directory (
  account_id text primary key,
  connection_id text not null default 'primary',
  marketplace_country_code text not null default '',
  currency text not null default '',
  name text not null default '',
  sync_bucket text not null default 'unknown'
    check (sync_bucket in ('us', 'non-us', 'unknown')),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists account_directory_bucket_idx
  on public.account_directory (sync_bucket, connection_id);

-- 2. sync_runs -- one row per orchestrator invocation.
create table if not exists public.sync_runs (
  id uuid primary key default gen_random_uuid(),
  bucket text not null check (bucket in ('us', 'non-us')),
  trigger text not null default 'cron',
  status text not null default 'running'
    check (status in ('running', 'succeeded', 'partial', 'failed')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  counts jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists sync_runs_bucket_started_idx
  on public.sync_runs (bucket, started_at desc);

-- 3. sync_targets -- per-(report_key, account_id) checkpoint that makes the
-- orchestrator resumable and idempotent across the 60s function cap. Ads sources
-- use account_id = '__bucket:<bucket>' (coarse, one per source/bucket).
-- RLS is enabled with NO policy: service-role only. Users read freshness only
-- through the account-scoped sync-status endpoint, so sync internals stay private.
create table if not exists public.sync_targets (
  report_key text not null,
  account_id text not null,
  last_run_id uuid references public.sync_runs (id) on delete set null,
  last_status text not null default 'pending'
    check (last_status in ('pending', 'running', 'succeeded', 'failed', 'skipped', 'deferred')),
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  source_refreshed_at timestamptz,
  latest_data_date date,
  attempts integer not null default 0,
  next_eligible_at timestamptz not null default now(),
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (report_key, account_id)
);
create index if not exists sync_targets_eligibility_idx
  on public.sync_targets (next_eligible_at);

-- 4. sync_errors -- append-only failure log, admin-read.
create table if not exists public.sync_errors (
  id uuid primary key default gen_random_uuid(),
  run_id uuid references public.sync_runs (id) on delete cascade,
  report_key text not null default '',
  account_id text not null default '',
  phase text not null,
  message text not null,
  occurred_at timestamptz not null default now()
);
create index if not exists sync_errors_run_idx
  on public.sync_errors (run_id, occurred_at desc);

-- 5. audit_log -- admin/sync/account-assignment trail, admin-read.
create table if not exists public.audit_log (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid references auth.users (id) on delete set null,
  action text not null,
  target jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);
create index if not exists audit_log_actor_idx
  on public.audit_log (actor_user_id, occurred_at desc);

-- updated_at triggers (reuse the existing touch_updated_at() function).
drop trigger if exists account_directory_touch on public.account_directory;
create trigger account_directory_touch before update on public.account_directory
  for each row execute function public.touch_updated_at();
drop trigger if exists sync_runs_touch on public.sync_runs;
create trigger sync_runs_touch before update on public.sync_runs
  for each row execute function public.touch_updated_at();
drop trigger if exists sync_targets_touch on public.sync_targets;
create trigger sync_targets_touch before update on public.sync_targets
  for each row execute function public.touch_updated_at();

-- RLS. Service-role (secret key) bypasses RLS for all writes; these policies only
-- govern browser (anon/authenticated) reads.
alter table public.account_directory enable row level security;
alter table public.sync_runs enable row level security;
alter table public.sync_targets enable row level security;   -- no policy: service-role only
alter table public.sync_errors enable row level security;
alter table public.audit_log enable row level security;

drop policy if exists "read allowed directory rows" on public.account_directory;
create policy "read allowed directory rows" on public.account_directory
  for select to authenticated using (
    public.is_dashboard_admin()
    or exists (
      select 1 from public.account_permissions p
      where p.user_id = auth.uid() and p.account_id = account_directory.account_id
    )
  );

drop policy if exists "admins read sync runs" on public.sync_runs;
create policy "admins read sync runs" on public.sync_runs
  for select to authenticated using (public.is_dashboard_admin());

drop policy if exists "admins read sync errors" on public.sync_errors;
create policy "admins read sync errors" on public.sync_errors
  for select to authenticated using (public.is_dashboard_admin());

drop policy if exists "admins read audit log" on public.audit_log;
create policy "admins read audit log" on public.audit_log
  for select to authenticated using (public.is_dashboard_admin());
