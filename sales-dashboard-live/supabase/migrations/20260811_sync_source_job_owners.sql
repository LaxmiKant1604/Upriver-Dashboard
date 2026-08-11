-- ===========================================================================
-- Scheduler v2 — normalized MANY-TO-MANY source-job ownership (SHADOW MODE)
-- ===========================================================================
--
-- Additive + IDEMPOTENT migration that CONVERGES to one final schema whether it runs on:
--   (a) a fresh database (no table), or
--   (b) a database that already has an EARLIER shape of this (unapplied) table -- e.g. one
--       without connection_id, or with blank identity defaults.
-- Every column/constraint is established by idempotent statements that run on BOTH paths, so
-- the same schema results regardless of prior state. It changes NO other table, alters neither
-- request_hash nor owner_id, and stores NO secret. Repeated execution is safe.
--
-- WHY: buildDependencyPlan() intentionally collapses identical canonical source requests (same
-- request_hash) needed by several reports into ONE sync_source_jobs row = ONE DataDoe export.
-- Different report contracts can carry DIFFERENT request keys while sharing the SAME request_hash
-- (the documented shared catalog / inventory groups). A single sync_source_jobs.request_key could
-- therefore never be the authoritative owner of a deduplicated canonical source.
--
-- MODEL:
--   sync_source_jobs        one row per canonical (cycle_id, request_hash): one export attempt, one
--                           fetch/save lifecycle. NO report-specific ownership. (unchanged here.)
--   sync_source_job_owners  MANY memberships per canonical row. unique(cycle_id, request_hash, owner_id).
--                           Composite FK to the canonical row's identity.
--
-- owner_id (lib/server/source-identity.js sourceJobOwnerId) is a deterministic, NON-SECRET identity
-- over report/workflow family + connection/organization boundary + organization fingerprint + account
-- scope. connection_id participates in owner identity and MUST match the account scope (dormant
-- dd-secondary: prefix => dd-secondary; otherwise primary). No api key / token / secret is stored.
-- ---------------------------------------------------------------------------

-- 1) Base table (fresh path). Identity columns are NOT NULL with NO blank defaults; connection_id is
--    created without a value here and finalized by the convergence block below (identical on both paths).
--    The typed-connection and non-empty-identity checks are NAMED and added idempotently below so a
--    freshly-created table and an upgraded earlier-shape table end with the exact same constraints.
create table if not exists public.sync_source_job_owners (
  id uuid primary key default gen_random_uuid(),
  cycle_id uuid not null references public.sync_cycles (id) on delete cascade,
  request_hash text not null,                 -- canonical source identity (== sync_source_jobs.request_hash); NEVER altered here
  owner_id text not null,                      -- deterministic non-secret owner identity (sourceJobOwnerId); NEVER altered here
  request_key text not null,                   -- report source alias for THIS membership (diagnostic, never sole authority)
  report_key text not null,                    -- report / workflow family (e.g. 'keyword-rank', 'brand-sales')
  account_id text not null,                    -- SAFE public account scope (e.g. 'A1', 'dd-secondary:B1') — never a raw secret
  connection_id text,                          -- part of owner identity; backfilled + constrained by the convergence block
  organization_fingerprint text not null,      -- non-reversible org fingerprint (never the api key)
  account_scope_hash text not null,            -- non-reversible account-scope hash (never raw ids)
  owner_status text not null default 'active'
    check (owner_status in ('active', 'stale')),   -- 'stale' = this owner's plan no longer needs the hash
  error_code text,                             -- SAFE owner-level code only (e.g. 'STALE_PLAN'); never a secret
  error_message text,                          -- SAFE operator string only; never a secret or raw key
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- One membership per (cycle, canonical hash, owner). Two owners of the same hash => two rows.
  constraint sync_source_job_owners_unique unique (cycle_id, request_hash, owner_id),
  -- Composite FK to the canonical source-job identity (references sync_source_jobs_cycle_hash_unique).
  constraint sync_source_job_owners_source_fk
    foreign key (cycle_id, request_hash)
    references public.sync_source_jobs (cycle_id, request_hash) on delete cascade
);

-- ============ CONVERGENCE (runs on BOTH paths; no-ops where already satisfied) ============

-- 2) connection_id must exist (nullable) before we can backfill it -- covers an earlier table that
--    predates the column.
alter table public.sync_source_job_owners add column if not exists connection_id text;

-- 3) DETERMINISTIC backfill from the SAFE public account scope. A dormant dd-secondary: prefix implies
--    the secondary connection; everything else is primary. This fills NULLs and CORRECTS an earlier
--    path that could have mislabeled a secondary membership as primary. It NEVER rewrites a secondary
--    account as a primary account (the two updates below can only set/keep 'dd-secondary' for a
--    dd-secondary: account, and only fill NULLs -- never downgrade -- for others).
update public.sync_source_job_owners
   set connection_id = 'dd-secondary'
 where account_id like 'dd-secondary:%' and coalesce(connection_id, 'primary') = 'primary';
update public.sync_source_job_owners
   set connection_id = 'primary'
 where account_id not like 'dd-secondary:%' and connection_id is null;

-- 4) FAIL CLOSED on malformed existing identity rows rather than silently accepting or inventing
--    ownership: a blank owner-identity field, or a connection_id that is still null / not a supported
--    typed value after backfill, aborts the migration with a clear message.
do $$
begin
  if exists (
    select 1 from public.sync_source_job_owners
    where coalesce(report_key, '') = '' or coalesce(account_id, '') = '' or coalesce(request_key, '') = ''
       or coalesce(organization_fingerprint, '') = '' or coalesce(account_scope_hash, '') = ''
       or connection_id is null or connection_id not in ('primary', 'dd-secondary')
  ) then
    raise exception 'sync_source_job_owners contains rows with a blank/invalid owner identity (report_key/account_id/request_key/organization_fingerprint/account_scope_hash/connection_id); refusing to migrate -- repair or remove them first.';
  end if;
end $$;

-- 5) Remove unsafe blank defaults and finalize NOT NULL + the connection_id default (only AFTER the
--    safe backfill above). Idempotent: dropping an absent default and re-asserting NOT NULL are no-ops.
alter table public.sync_source_job_owners
  alter column report_key drop default,
  alter column account_id drop default,
  alter column organization_fingerprint drop default,
  alter column account_scope_hash drop default,
  alter column report_key set not null,
  alter column account_id set not null,
  alter column organization_fingerprint set not null,
  alter column account_scope_hash set not null,
  alter column connection_id set not null,
  alter column connection_id set default 'primary';

-- 6) Idempotently add the NAMED typed-connection and non-empty-identity constraints. Added the same way
--    on both paths, so a fresh table and an upgraded earlier-shape table end with equivalent constraints.
do $$
begin
  if not exists (select 1 from pg_constraint
                 where conname = 'sync_source_job_owners_connection_id_check'
                   and conrelid = 'public.sync_source_job_owners'::regclass) then
    alter table public.sync_source_job_owners
      add constraint sync_source_job_owners_connection_id_check check (connection_id in ('primary', 'dd-secondary'));
  end if;
  if not exists (select 1 from pg_constraint
                 where conname = 'sync_source_job_owners_identity_nonempty'
                   and conrelid = 'public.sync_source_job_owners'::regclass) then
    alter table public.sync_source_job_owners
      add constraint sync_source_job_owners_identity_nonempty check (
        char_length(report_key) > 0 and char_length(account_id) > 0 and char_length(request_key) > 0
        and char_length(organization_fingerprint) > 0 and char_length(account_scope_hash) > 0
      );
  end if;
end $$;

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
