-- ===========================================================================
-- Scheduler v2 — normalized MANY-TO-MANY source-job ownership (SHADOW MODE)
-- ===========================================================================
--
-- Additive migration. Safe on a fresh database AND on one already migrated by
-- 20260807_scheduler_v2.sql: every statement is idempotent (create ... if not
-- exists, drop policy if exists / create policy). It changes NO existing table.
--
-- WHY: buildDependencyPlan() intentionally collapses identical canonical source
-- requests (same request_hash) needed by several reports into ONE sync_source_jobs
-- row = ONE DataDoe export. Different report contracts can carry DIFFERENT request
-- keys while sharing the SAME request_hash (the documented shared catalog / inventory
-- groups). A single sync_source_jobs.request_key could therefore never be the
-- authoritative owner of a deduplicated canonical source — it would break source
-- reuse and future admin report-wise / manual sync.
--
-- MODEL:
--   sync_source_jobs        one row per canonical (cycle_id, request_hash): one DataDoe
--                           export attempt, one fetch/save lifecycle. NO report-specific
--                           ownership authority. (unchanged by this migration.)
--   sync_source_job_owners  MANY memberships per canonical row: which staged driver /
--                           report / account / organization scopes may process, resume,
--                           or read that canonical source. unique(cycle_id, request_hash,
--                           owner_id). Composite FK to the canonical row's identity.
--
-- owner_id is a deterministic, NON-SECRET identity (see lib/server/source-identity.js
-- sourceJobOwnerId): it distinguishes report/workflow family + connection/organization
-- boundary + organization fingerprint + account scope. The same report/account/org across
-- staged rounds resolves to the same owner_id; different accounts or organizations never
-- share an owner_id; different reports may hold different owner_ids for the same
-- request_hash. No DataDoe/Supabase key, token, or other secret is ever stored here.
-- ---------------------------------------------------------------------------

create table if not exists public.sync_source_job_owners (
  id uuid primary key default gen_random_uuid(),
  cycle_id uuid not null references public.sync_cycles (id) on delete cascade,
  request_hash text not null,                 -- canonical source identity (== sync_source_jobs.request_hash)
  owner_id text not null,                      -- deterministic non-secret owner identity (sourceJobOwnerId)
  request_key text not null,                   -- report source alias for THIS membership (diagnostic, never sole authority)
  report_key text not null,                    -- report / workflow family (e.g. 'keyword-rank', 'brand-sales')
  account_id text not null,                    -- SAFE public account scope (e.g. 'A1', 'dd-secondary:B1') — never a raw secret
  connection_id text not null default 'primary'
    check (connection_id in ('primary', 'dd-secondary')), -- part of owner identity; typed org/connection boundary
  organization_fingerprint text not null,      -- non-reversible org fingerprint (never the api key)
  account_scope_hash text not null,            -- non-reversible account-scope hash (never raw ids)
  owner_status text not null default 'active'
    check (owner_status in ('active', 'stale')),   -- 'stale' = this owner's plan no longer needs the hash
  error_code text,                             -- SAFE owner-level code only (e.g. 'STALE_PLAN'); never a secret
  error_message text,                          -- SAFE operator string only; never a secret or raw key
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- The identity columns that participate in owner_id (report_key/connection_id/organization_fingerprint/
  -- account_scope_hash) plus the safe scope labels (account_id/request_key) must be non-empty: an
  -- ambiguous owner identity is never persisted.
  constraint sync_source_job_owners_identity_nonempty check (
    char_length(report_key) > 0 and char_length(account_id) > 0 and char_length(request_key) > 0
    and char_length(organization_fingerprint) > 0 and char_length(account_scope_hash) > 0
  ),
  -- One membership per (cycle, canonical hash, owner). Two owners of the same hash => two rows.
  constraint sync_source_job_owners_unique unique (cycle_id, request_hash, owner_id),
  -- Composite FK to the canonical source-job identity: a membership can only exist for a real
  -- canonical row, and is removed with it. (References sync_source_jobs_cycle_hash_unique.)
  constraint sync_source_job_owners_source_fk
    foreign key (cycle_id, request_hash)
    references public.sync_source_jobs (cycle_id, request_hash) on delete cascade
);

-- Additive/idempotent guard so a database that already created an earlier version of this (unapplied)
-- table still gains connection_id (part of owner identity) without a destructive rewrite.
alter table public.sync_source_job_owners
  add column if not exists connection_id text not null default 'primary';

create index if not exists sync_source_job_owners_owner_idx
  on public.sync_source_job_owners (cycle_id, owner_id);
create index if not exists sync_source_job_owners_hash_idx
  on public.sync_source_job_owners (cycle_id, request_hash);

-- updated_at trigger (reuse the shared touch_updated_at() from 20260728_shared_dashboard.sql).
drop trigger if exists sync_source_job_owners_touch on public.sync_source_job_owners;
create trigger sync_source_job_owners_touch before update on public.sync_source_job_owners
  for each row execute function public.touch_updated_at();

-- RLS: service-role writes (bypass RLS, as for sync_source_jobs); admin-only reads. No secrets stored.
alter table public.sync_source_job_owners enable row level security;
drop policy if exists "admins read sync source job owners" on public.sync_source_job_owners;
create policy "admins read sync source job owners" on public.sync_source_job_owners
  for select to authenticated using (public.is_dashboard_admin());
