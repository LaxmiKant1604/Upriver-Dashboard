-- Scheduler v2 -- SOURCE-PROMOTED publication control (PREPARED -- UNAPPLIED).
--
-- >>> DO NOT APPLY via `npm run db:migrate` or any bulk apply. This migration is PREPARED for Codex review
-- >>> and is applied ONLY via a reviewed single-file Gate after approval, exactly like the other Scheduler-v2
-- >>> migrations. Migrations 1-6 and 20260820 are FROZEN and are NOT modified or reapplied here.
--
-- WHY (round-6 blocker 2): a SOURCE-PROMOTED report (brand-inventory) is PRODUCED by the source-first durable
-- runtime and PROMOTED to its live identity ONLY through the reviewed publisher. It is DELIBERATELY OUTSIDE
-- CONTROLLED_REPORT_KEYS, so the Scheduler-v2 dispatcher can never select it (it is structurally
-- undispatchable). But the publisher's durable "report enable" gate (gate 2) needed a real durable control
-- for it: report_sync_settings is the DISPATCH control plane -- production seeds/manages ONLY the 13
-- controlled reports there, and the admin sync surface rejects a promoted key -- so there was NO reviewed
-- way to enable/revoke promoted publication (a test had to fabricate the row).
--
-- This adds a SEPARATE, additive control table that gates ONLY source-promoted publication:
--   * source_promoted_publish_settings(report_key, publish_enabled) -- default OFF (seeded false), so
--     applying this migration ENABLES NOTHING and creates no DataDoe request by itself.
--   * It NEVER feeds dispatcher selection (the dispatcher iterates CONTROLLED_REPORT_KEYS, which excludes
--     brand-inventory), so enabling publish_enabled can never dispatch a source export.
--   * Independent of the other three gates: code readiness (SCHEDULER_V2_PUBLISHABLE_REPORT_KEYS), account
--     rollout (scheduler_account_rollout), and the exact audited per-(report, account) publish approval
--     (scheduler_publish_approvals) each still gate every publish.
-- Adds NO cron/schedule. Least-privilege service_role ACL + admin-read RLS, matching the operator surfaces
-- in 20260820. The wrappers getSourcePromotedPublishSettings / setSourcePromotedPublishControl are the only
-- read/write path.

create table if not exists public.source_promoted_publish_settings (
  report_key text primary key
    constraint source_promoted_publish_settings_report_key_nonblank check (char_length(btrim(report_key)) > 0),
  publish_enabled boolean not null default false,
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now()
);

-- Seed the one source-promoted report DISABLED (default OFF). Idempotent.
insert into public.source_promoted_publish_settings (report_key, publish_enabled)
values ('brand-inventory', false)
on conflict (report_key) do nothing;

-- Touch trigger (reuse public.touch_updated_at from 20260728).
drop trigger if exists source_promoted_publish_settings_touch on public.source_promoted_publish_settings;
create trigger source_promoted_publish_settings_touch
  before update on public.source_promoted_publish_settings
  for each row execute function public.touch_updated_at();

-- RLS: enabled; dashboard admins may READ the control surface. Writes go through the service-role wrapper.
alter table public.source_promoted_publish_settings enable row level security;

drop policy if exists source_promoted_publish_settings_admin_read on public.source_promoted_publish_settings;
create policy source_promoted_publish_settings_admin_read on public.source_promoted_publish_settings
  for select to authenticated using (public.is_dashboard_admin());

-- EXACT LEAST-PRIVILEGE ACL, reconciled with the policy intent (mirrors source_controls): dashboard ADMINS
-- READ through PostgREST (table GRANT SELECT to authenticated + the admin-read policy together); the reviewed
-- service-role wrapper writes with exactly SELECT, INSERT, UPDATE (no DELETE -- a control row is never
-- deleted by the application role). Supabase default privileges would otherwise leave service_role with ALL;
-- REVOKE ALL strips that (including PostgreSQL 17's MAINTAIN). anon/public stay fully revoked.
revoke all on table public.source_promoted_publish_settings from public, anon, authenticated, service_role;
grant select, insert, update on table public.source_promoted_publish_settings to service_role;
grant select on table public.source_promoted_publish_settings to authenticated;
