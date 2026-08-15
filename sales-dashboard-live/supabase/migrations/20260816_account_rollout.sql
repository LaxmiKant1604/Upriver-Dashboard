-- Scheduler v2 -- Gate-7 ACCOUNT ROLLOUT control plane (PREPARED -- UNAPPLIED).
--
-- >>> DO NOT APPLY via `npm run db:migrate` or any bulk apply. This migration is PREPARED for Codex review
-- >>> and is applied ONLY via a reviewed single-file Gate after approval, exactly like migrations 1-5 were.
-- >>> Migrations 1-5 are FROZEN and are NOT modified or reapplied here. Everything below is ADDITIVE.
--
-- WHY: Gate-7 needs a DURABLE, fail-closed ACCOUNT gate (independent of -- and additional to -- the
-- report-level readiness in report_sync_settings) so a bounded rollout can enable EXACTLY the proven
-- account(s) while every other account stays untouched, and a later deliberate all-primary switch can let
-- newly connected primary accounts join automatically without a code change. It also needs a durable,
-- auditable per-(report, account) PUBLISH approval for the reviewed shadow-to-live publisher.
--
-- Semantics the trusted wrappers/resolver enforce ON TOP of these tables (documented here for review):
--   - DEFAULT state selects ZERO accounts: no rollout rows + all_primary=false => nothing runs;
--   - allowlist mode selects ONLY rows with enabled=true, matched by EXACT public account id against a
--     FRESHLY DISCOVERED primary account; a stale/unknown row spends zero exports;
--   - all_primary is a SEPARATE deliberate switch (default false); when true, every discovered PRIMARY
--     account participates (dd-secondary is always skipped and never routed through the primary key);
--   - a read/schema failure selects ZERO accounts BEFORE any cycle creation or DataDoe call;
--   - publishing additionally requires approved=true for the exact (report_key, account_id).

-- ---------------------------------------------------------------------------
-- 1. scheduler_account_rollout -- the explicit per-account allowlist (default: no rows => zero accounts).
-- ---------------------------------------------------------------------------
create table if not exists public.scheduler_account_rollout (
  account_id text primary key,
  enabled boolean not null default false,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- DB-enforced identity integrity: a blank id, a NONCANONICAL id (leading/trailing whitespace), or a
  -- dd-secondary-prefixed id can never be stored, so a malformed allowlist row cannot exist to be mis-read
  -- or silently trimmed into another account (the reader/resolver reject them too; defense in depth).
  constraint scheduler_account_rollout_account_id_nonblank check (char_length(btrim(account_id)) > 0),
  constraint scheduler_account_rollout_account_id_canonical check (account_id = btrim(account_id)),
  constraint scheduler_account_rollout_account_id_primary_only check (account_id not like 'dd-secondary:%')
);

-- ---------------------------------------------------------------------------
-- 2. scheduler_rollout_mode -- the SINGLETON deliberate all-primary switch (default false).
-- ---------------------------------------------------------------------------
create table if not exists public.scheduler_rollout_mode (
  id smallint primary key default 1,
  all_primary boolean not null default false,
  updated_at timestamptz not null default now(),
  -- Named singleton constraint so the static schema audit proves it exactly.
  constraint scheduler_rollout_mode_singleton check (id = 1)
);
-- Seed the singleton row so reads are deterministic; never overwrites an existing deliberate value.
insert into public.scheduler_rollout_mode (id, all_primary) values (1, false)
  on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 3. scheduler_publish_approvals -- durable, auditable per-(report, account) publish approval (default: none).
-- ---------------------------------------------------------------------------
create table if not exists public.scheduler_publish_approvals (
  report_key text not null,
  account_id text not null,
  approved boolean not null default false,
  -- EVERY row is an explicit publish DECISION (an approval OR a revocation) and must be auditable: WHO
  -- decided and WHEN are DB-required, so an unaudited/blank decision row can never exist.
  approved_by text not null,
  approved_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (report_key, account_id),
  constraint scheduler_publish_approvals_report_key_nonblank check (char_length(btrim(report_key)) > 0),
  constraint scheduler_publish_approvals_report_key_canonical check (report_key = btrim(report_key)),
  constraint scheduler_publish_approvals_account_id_nonblank check (char_length(btrim(account_id)) > 0),
  constraint scheduler_publish_approvals_account_id_canonical check (account_id = btrim(account_id)),
  constraint scheduler_publish_approvals_account_id_primary_only check (account_id not like 'dd-secondary:%'),
  -- Every publish DECISION is auditable AND canonically attributed: approved_by carries WHO with no
  -- leading/trailing whitespace, approved_at carries WHEN.
  constraint scheduler_publish_approvals_approved_by_canonical check (approved_by = btrim(approved_by)),
  constraint scheduler_publish_approvals_audited check (char_length(btrim(approved_by)) > 0 and approved_at is not null)
);

-- ---------------------------------------------------------------------------
-- updated_at touch trigger (one shared function; BEFORE UPDATE on each table).
-- ---------------------------------------------------------------------------
create or replace function public.scheduler_rollout_touch()
returns trigger
language plpgsql
as $$
begin
  NEW.updated_at = now();
  return NEW;
end;
$$;

drop trigger if exists scheduler_account_rollout_touch on public.scheduler_account_rollout;
create trigger scheduler_account_rollout_touch
  before update on public.scheduler_account_rollout
  for each row execute function public.scheduler_rollout_touch();

drop trigger if exists scheduler_rollout_mode_touch on public.scheduler_rollout_mode;
create trigger scheduler_rollout_mode_touch
  before update on public.scheduler_rollout_mode
  for each row execute function public.scheduler_rollout_touch();

drop trigger if exists scheduler_publish_approvals_touch on public.scheduler_publish_approvals;
create trigger scheduler_publish_approvals_touch
  before update on public.scheduler_publish_approvals
  for each row execute function public.scheduler_rollout_touch();

-- ---------------------------------------------------------------------------
-- RLS + grants -- service_role only (RLS enabled with NO policies: anon/authenticated see nothing;
-- service_role bypasses RLS). Matches the fail-closed posture of the scheduler tables.
-- ---------------------------------------------------------------------------
alter table public.scheduler_account_rollout enable row level security;
alter table public.scheduler_rollout_mode enable row level security;
alter table public.scheduler_publish_approvals enable row level security;

revoke all on public.scheduler_account_rollout from public, anon, authenticated;
revoke all on public.scheduler_rollout_mode from public, anon, authenticated;
revoke all on public.scheduler_publish_approvals from public, anon, authenticated;
grant select, insert, update on public.scheduler_account_rollout to service_role;
grant select, insert, update on public.scheduler_rollout_mode to service_role;
grant select, insert, update on public.scheduler_publish_approvals to service_role;
