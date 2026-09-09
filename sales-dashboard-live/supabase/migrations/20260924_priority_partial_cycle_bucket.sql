-- ============================================================================
-- 20260924_priority_partial_cycle_bucket.sql
--
-- *** PREPARED / UNAPPLIED -- APPROVAL-GATED. DO NOT APPLY WITHOUT EXPLICIT SIGN-OFF. ***
-- Apply (only when approved) EXACTLY this one file:
--   MIGRATE_ONLY=20260924_priority_partial_cycle_bucket.sql npm run db:migrate
-- It touches ONLY public.sync_cycles_bucket_check and public.open_sync_cycle -- nothing else. No data is altered.
--
-- WHY: the scheduler now publishes a HEALTHY OLI-eligible SUBSET on a PARTIAL cycle (some accounts readiness/hard-
-- deferred) into a DEDICATED per-eligible-set sync_cycles bucket, so the natural (region, cycle_date) daily cycle is
-- never finalized with a partial set and the deferred accounts' dated last-known-good is untouched. The bucket value
-- is priority-partial-<region>-<membership-hash-16> (region-anchored; the 16-hex is sha256(sorted eligible ids)[:16]).
-- The live sync_cycles bucket CHECK + open_sync_cycle guard (last set by 20260919) permit the fixed regional buckets
-- + the bootstrap regex ONLY, so open_sync_cycle raises 'Invalid bucket priority-partial-...' the first time a partial
-- cycle reaches openCycle. Until this migration is applied, priority-dashboards-release.mjs (subset mode) FAILS CLOSED
-- with a typed PRIORITY_PARTIAL_MIGRATION_PENDING preflight (zero writes, LKG preserved) -- it NEVER disguises a
-- partial cycle as a bootstrap bucket.
--
-- IDENTITY / OWNERSHIP / LIFECYCLE (why this is a DISTINCT namespace, not a reuse of the bootstrap regex):
--   * The priority-partial cycle is owned by the scheduler-v2 priority release (priority-dashboards-release.mjs), NOT
--     by an onboarding dispatch. It has NO account_onboarding_dispatch row, NO onboarding wave budget, and NO
--     onboarding ack/publication lifecycle. record_onboarding_publication (20260919) still requires a bootstrap bucket
--     and is DELIBERATELY LEFT UNTOUCHED here, so a priority-partial cycle can never be mistaken for / adopted by the
--     bootstrap machinery, and a bootstrap cycle can never match the priority-partial pattern.
--   * Same lifecycle as every other priority cycle: opened by open_sync_cycle (base), continued/finalized by the
--     existing finalize_sync_cycle. The dedicated bucket only namespaces sync_cycles.bucket; the account scope + every
--     source/report request identity stays the real region bucket (already permitted) -- exactly the -fba / v3 pattern
--     (20260906 / 20260918), so no other constraint/table needs widening.
--
-- Canonical widened allow-list = the existing 20260919 values (13 fixed + the bootstrap regex), PRESERVED VERBATIM,
-- with ONE new alternative APPENDED: ^priority-partial-(india|europe-au|us-ca)-[0-9a-f]{16}$.
-- Idempotent: the named CHECK is dropped-if-exists then re-added; the RPC is create-or-replace.
-- ============================================================================

-- 1. sync_cycles.bucket CHECK -- drop the EXACT known constraint by name (never a dynamic drop), re-add widened.
alter table public.sync_cycles drop constraint if exists sync_cycles_bucket_check;
alter table public.sync_cycles
  add constraint sync_cycles_bucket_check
  check (
    bucket in ('us','non-us','us-fba','non-us-fba','india','europe-au','us-ca','india-fba','europe-au-fba','us-ca-fba','listing-health-v3-india','listing-health-v3-europe-au','listing-health-v3-us-ca')
    or bucket ~ '^bootstrap(-fba)?-(india|europe-au|us-ca)-[0-9a-f]{16}$'
    or bucket ~ '^priority-partial-(india|europe-au|us-ca)-[0-9a-f]{16}$'
  );

-- 2. open_sync_cycle -- the BASE-cycle create-or-find RPC the priority release calls. Body BYTE-IDENTICAL to 20260919
--    EXCEPT the p_bucket guard's allow-list (now the same list + the priority-partial alternative). Privileges are
--    then re-enforced explicitly (service_role only), matching 20260919.
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
  if not (
    p_bucket in ('us','non-us','us-fba','non-us-fba','india','europe-au','us-ca','india-fba','europe-au-fba','us-ca-fba','listing-health-v3-india','listing-health-v3-europe-au','listing-health-v3-us-ca')
    or p_bucket ~ '^bootstrap(-fba)?-(india|europe-au|us-ca)-[0-9a-f]{16}$'
    or p_bucket ~ '^priority-partial-(india|europe-au|us-ca)-[0-9a-f]{16}$'
  ) then
    raise exception 'Invalid bucket %', p_bucket;
  end if;

  insert into public.sync_cycles (bucket, cycle_date, scheduled_at, trigger, status, attempt_kind)
  values (p_bucket, p_cycle_date, p_scheduled_at, coalesce(p_trigger, 'pg_cron'), 'pending', 'base')
  on conflict (bucket, cycle_date) where supersedes_cycle_id is null do update set updated_at = now()
  returning id into v_id;

  return v_id;
end;
$$;
revoke all on function public.open_sync_cycle(text, date, timestamptz, text) from public, anon, authenticated;
grant execute on function public.open_sync_cycle(text, date, timestamptz, text) to service_role;
