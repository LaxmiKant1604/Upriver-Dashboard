-- Admin-managed report scheduling controls. Additive and safe while Scheduler
-- v2 remains in shadow mode: every report starts PAUSED, so applying this
-- migration cannot create a DataDoe request by itself.

create table if not exists public.report_sync_settings (
  report_key text primary key,
  schedule_enabled boolean not null default false,
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  constraint report_sync_settings_key_nonempty check (length(trim(report_key)) > 0)
);

insert into public.report_sync_settings (report_key, schedule_enabled)
values
  ('brand-sales', false),
  ('daily-reporting', false),
  ('reconciliation', false),
  ('fba-plan', false),
  ('sku-pl', false),
  ('keyword-rank', false),
  ('content-changes', false),
  ('sales-movers', false),
  ('listing-health', false),
  ('buy-box-loss', false),
  ('returns-leakage', false),
  ('ppc-performance', false),
  ('listing-optimizer', false)
on conflict (report_key) do nothing;

alter table public.report_sync_settings enable row level security;

drop policy if exists "admins read report sync settings" on public.report_sync_settings;
create policy "admins read report sync settings" on public.report_sync_settings
  for select to authenticated using (public.is_dashboard_admin());

-- Browser writes are deliberately absent. The admin API validates readiness,
-- writes with the service role, and records an audit-log entry.
