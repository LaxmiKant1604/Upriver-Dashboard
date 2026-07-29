-- Durable storage and state for automated DataDoe Amazon Ads refreshes.
-- Each source keeps its own native daily grain in dimensions/metrics JSON;
-- dimension_key makes the upsert idempotent without mixing campaign, ASIN, and
-- keyword-targeting rows.

create table public.ads_daily_source_rows (
  source_key text not null,
  account_id text not null,
  marketplace_country_code text not null default '',
  metric_date date not null,
  dimension_key text not null,
  campaign_id text not null default '',
  campaign_type text not null default '',
  child_asin text not null default '',
  targeting_id text not null default '',
  currency text not null default '',
  dimensions jsonb not null default '{}'::jsonb,
  metrics jsonb not null default '{}'::jsonb,
  source_refreshed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (source_key, account_id, marketplace_country_code, metric_date, dimension_key)
);

create index ads_daily_source_rows_lookup_idx
  on public.ads_daily_source_rows (account_id, source_key, metric_date desc);
create index ads_daily_source_rows_campaign_idx
  on public.ads_daily_source_rows (account_id, metric_date desc, campaign_id);

create table public.ads_sync_state (
  account_id text not null,
  source_key text not null,
  initial_seeded_at timestamptz,
  last_daily_sync_at timestamptz,
  last_monthly_sync_at timestamptz,
  latest_metric_date date,
  last_status text not null default 'pending' check (last_status in ('pending', 'running', 'succeeded', 'failed')),
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (account_id, source_key)
);

create trigger ads_daily_source_rows_touch_updated_at before update on public.ads_daily_source_rows
  for each row execute function public.touch_updated_at();
create trigger ads_sync_state_touch_updated_at before update on public.ads_sync_state
  for each row execute function public.touch_updated_at();

alter table public.ads_daily_source_rows enable row level security;
alter table public.ads_sync_state enable row level security;

create policy "Users can read allowed Ads rows" on public.ads_daily_source_rows
  for select to authenticated using (
    exists (select 1 from public.account_permissions p where p.user_id = auth.uid() and p.account_id = ads_daily_source_rows.account_id)
  );
