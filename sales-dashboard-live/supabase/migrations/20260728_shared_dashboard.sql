-- Upriver shared dashboard foundation.
-- Apply this migration through the Supabase SQL editor or Supabase CLI only
-- after the Vercel Marketplace resource has been provisioned. Browser clients
-- never receive SUPABASE_SECRET_KEY; server functions use it for writes.

create extension if not exists pgcrypto;

create type public.dashboard_role as enum ('admin', 'editor', 'viewer');

create table public.user_profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  role public.dashboard_role not null default 'viewer',
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.account_permissions (
  user_id uuid not null references auth.users (id) on delete cascade,
  account_id text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, account_id)
);

-- A snapshot represents one validated DataDoe response for a report scope.
-- Large payloads may be placed in the private dashboard-snapshots bucket and
-- referenced through payload_storage_path; this avoids broadcasting a large
-- reconciliation payload through Realtime.
create table public.report_snapshots (
  id uuid primary key default gen_random_uuid(),
  report_key text not null,
  account_id text not null,
  params_hash text not null,
  params jsonb not null default '{}'::jsonb,
  payload jsonb,
  payload_storage_path text,
  payload_bytes bigint not null default 0 check (payload_bytes >= 0),
  source_refreshed_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (payload is not null or payload_storage_path is not null),
  unique (report_key, account_id, params_hash)
);

create index report_snapshots_scope_idx
  on public.report_snapshots (report_key, account_id, updated_at desc);

-- Only a tiny row is replicated. The browser uses it as a signal to ask the
-- server for the current saved snapshot, never as a report-payload transport.
create table public.dashboard_events (
  id bigint generated always as identity primary key,
  report_key text not null,
  account_id text not null,
  params_hash text not null,
  snapshot_id uuid not null references public.report_snapshots (id) on delete cascade,
  occurred_at timestamptz not null default now()
);

create index dashboard_events_scope_idx
  on public.dashboard_events (report_key, account_id, occurred_at desc);

-- A database lock prevents two serverless instances from spending DataDoe
-- tokens on the same account/report scope at the same time.
create table public.report_refresh_locks (
  report_key text not null,
  account_id text not null,
  params_hash text not null,
  locked_until timestamptz not null,
  owner_id uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (report_key, account_id, params_hash)
);

-- Persisted COGS replaces the current browser-local override dictionary.
create table public.cogs_overrides (
  account_id text not null,
  currency text not null,
  sku text not null default '',
  asin text not null default '',
  per_unit_cost numeric(18, 6) not null check (per_unit_cost >= 0),
  updated_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (account_id, currency, sku, asin)
);

-- Historical campaign grain for Ads. Re-fetching a rolling window must upsert
-- this key so late Amazon attribution corrects existing values rather than
-- being double-counted.
create table public.ad_daily_metrics (
  account_id text not null,
  metric_date date not null,
  campaign_id text not null,
  campaign_type text not null default '',
  currency text not null default '',
  ad_sales numeric(18, 4) not null default 0,
  ad_spend numeric(18, 4) not null default 0,
  ad_clicks bigint not null default 0,
  source_refreshed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (account_id, metric_date, campaign_id, campaign_type, currency)
);

create index ad_daily_metrics_account_date_idx
  on public.ad_daily_metrics (account_id, metric_date desc);

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger user_profiles_touch_updated_at before update on public.user_profiles
  for each row execute function public.touch_updated_at();
create trigger report_snapshots_touch_updated_at before update on public.report_snapshots
  for each row execute function public.touch_updated_at();
create trigger report_refresh_locks_touch_updated_at before update on public.report_refresh_locks
  for each row execute function public.touch_updated_at();
create trigger cogs_overrides_touch_updated_at before update on public.cogs_overrides
  for each row execute function public.touch_updated_at();
create trigger ad_daily_metrics_touch_updated_at before update on public.ad_daily_metrics
  for each row execute function public.touch_updated_at();

-- The server uses the secret key, but this function remains safe if called by
-- an authenticated editor: a lock is granted only when absent or expired.
create or replace function public.claim_report_refresh_lock(
  p_report_key text,
  p_account_id text,
  p_params_hash text,
  p_lock_seconds integer default 120
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  lock_granted boolean := false;
begin
  if p_lock_seconds < 1 or p_lock_seconds > 600 then
    raise exception 'Lock duration must be between 1 and 600 seconds';
  end if;

  insert into public.report_refresh_locks (report_key, account_id, params_hash, locked_until, owner_id)
  values (p_report_key, p_account_id, p_params_hash, now() + make_interval(secs => p_lock_seconds), auth.uid())
  on conflict (report_key, account_id, params_hash) do update
    set locked_until = excluded.locked_until,
        owner_id = excluded.owner_id
    where public.report_refresh_locks.locked_until <= now()
  returning true into lock_granted;

  return coalesce(lock_granted, false);
end;
$$;

alter table public.user_profiles enable row level security;
alter table public.account_permissions enable row level security;
alter table public.report_snapshots enable row level security;
alter table public.dashboard_events enable row level security;
alter table public.report_refresh_locks enable row level security;
alter table public.cogs_overrides enable row level security;
alter table public.ad_daily_metrics enable row level security;

-- Direct browser access is intentionally read-only and only for a signed-in
-- user granted access to the underlying Amazon account. Writes go through the
-- Vercel API with SUPABASE_SECRET_KEY after future Auth/role checks.
create policy "Users can read their profile" on public.user_profiles
  for select to authenticated using (user_id = auth.uid());
create policy "Users can read their account assignments" on public.account_permissions
  for select to authenticated using (user_id = auth.uid());
create policy "Users can read allowed snapshots" on public.report_snapshots
  for select to authenticated using (
    exists (select 1 from public.account_permissions p where p.user_id = auth.uid() and p.account_id = report_snapshots.account_id)
  );
create policy "Users can read allowed events" on public.dashboard_events
  for select to authenticated using (
    exists (select 1 from public.account_permissions p where p.user_id = auth.uid() and p.account_id = dashboard_events.account_id)
  );
create policy "Users can read allowed COGS overrides" on public.cogs_overrides
  for select to authenticated using (
    exists (select 1 from public.account_permissions p where p.user_id = auth.uid() and p.account_id = cogs_overrides.account_id)
  );
create policy "Users can read allowed ad history" on public.ad_daily_metrics
  for select to authenticated using (
    exists (select 1 from public.account_permissions p where p.user_id = auth.uid() and p.account_id = ad_daily_metrics.account_id)
  );

-- The only table published to Realtime has no report payload column.
do $$
begin
  alter publication supabase_realtime add table public.dashboard_events;
exception
  when duplicate_object then null;
end;
$$;

insert into storage.buckets (id, name, public)
values ('dashboard-snapshots', 'dashboard-snapshots', false)
on conflict (id) do nothing;
