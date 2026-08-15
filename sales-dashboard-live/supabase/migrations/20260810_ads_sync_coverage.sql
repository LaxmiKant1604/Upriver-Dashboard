-- Durable successful Ads coverage windows for the Scheduler v2 Daily Reporting derived-context.
--
-- ADDITIVE and NOT YET APPLIED. Nothing in production runs against this table until it is applied
-- and reviewed. `ads_sync_state.latest_metric_date` only marks the newest day that HAS ad activity,
-- so a successfully-synced day with zero advertising (and therefore no `ad_daily_metrics` row) is
-- indistinguishable from an unsynced day. Daily Reporting must prove that an exact [from, to] window
-- was SUCCESSFULLY covered before it may treat empty advertising as a genuine zero, so the Ads sync
-- records one row here per successfully-completed sync window (only successful windows are written).
--
-- The read/write helpers (lib/server/supabase.js getDailyAdsCoverage / recordAdsCoverageWindows) are
-- best-effort and tolerate this table's absence: until the migration is applied, Daily coverage reads
-- return nothing (Daily blocks fail-closed and preserves last-known-good) and the recording write is a
-- silent no-op (the existing Ads sync + its DataDoe export cadence are unchanged).

create table if not exists public.ads_sync_coverage (
  account_id text not null,          -- PUBLIC account id (dd-secondary keeps its "dd-secondary:" prefix)
  source_key text not null,          -- e.g. 'campaign-performance-v1' (feeds ad_daily_metrics)
  covered_from date not null,
  covered_to date not null,
  status text not null default 'succeeded' check (status in ('succeeded')),
  source_refreshed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (account_id, source_key, covered_from, covered_to)
);

create index if not exists ads_sync_coverage_lookup_idx
  on public.ads_sync_coverage (account_id, source_key, covered_from);

-- Reuse the shared trigger function created by 20260728_shared_dashboard.sql.
create trigger ads_sync_coverage_touch_updated_at before update on public.ads_sync_coverage
  for each row execute function public.touch_updated_at();

-- Service-role only (RLS on, no policy): the scheduler writes and the Daily loader reads via the
-- service role. Browsers never read successful-coverage metadata directly.
alter table public.ads_sync_coverage enable row level security;
