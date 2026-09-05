-- ===========================================================================
-- Listing Health v3 dedicated cycle-bucket namespace (Migration 20260918) -- LEAST PRIVILEGE
-- ===========================================================================
--
-- ADDITIVE + FORWARD-ONLY + IDEMPOTENT. The dedicated Listing Health v3 SHADOW ingestion opens its own per-region
-- cycle under a NAMESPACED bucket -- listing-health-v3-<region> -- so it NEVER collides with the scheduler-v2 daily
-- (region, cycle_date) cycle. That namespace exists ONLY as sync_cycles.bucket (written by open_sync_cycle). The v3
-- source jobs, report jobs, source_run_status, source_oli_completeness and sync_runs all keep the REAL account region
-- bucket (india), which is already allowed -- so this migration touches ONLY public.sync_cycles_bucket_check and
-- public.open_sync_cycle, and nothing else.
--
-- The namespace was implemented in code (listingHealthV3CycleBucket) but the sync_cycles allow-list was never widened,
-- so open_sync_cycle raised 'Invalid bucket listing-health-v3-india' the first time a v3 cycle reached openCycle
-- (earlier canaries deferred on inventory BEFORE openCycle, masking the gap).
--
-- Canonical widened allow-list = the existing 20260917 ten values, PRESERVED, with three v3 cycle namespaces APPENDED:
--   us, non-us, us-fba, non-us-fba, india, europe-au, us-ca, india-fba, europe-au-fba, us-ca-fba   (unchanged)
--   listing-health-v3-india, listing-health-v3-europe-au, listing-health-v3-us-ca                  (appended)
--
-- It changes NO existing row, renames/deletes NO table, rewrites NO history, and deletes NO snapshot or source data.
-- Repeated execution is safe (the named CHECK is dropped-if-exists then re-added; the RPC is create-or-replace). The
-- exact rollback (which first REFUSES if any sync_cycles row still uses a v3 bucket) is documented at the end.

-- ---------------------------------------------------------------------------
-- 1. sync_cycles.bucket ONLY -- drop the EXACT known constraint by name (never a dynamic drop of every bucket CHECK),
--    then re-add it with the three v3 cycle namespaces appended to the preserved ten.
-- ---------------------------------------------------------------------------
alter table public.sync_cycles drop constraint if exists sync_cycles_bucket_check;
alter table public.sync_cycles
  add constraint sync_cycles_bucket_check
  check (bucket in ('us','non-us','us-fba','non-us-fba','india','europe-au','us-ca','india-fba','europe-au-fba','us-ca-fba','listing-health-v3-india','listing-health-v3-europe-au','listing-health-v3-us-ca'));

-- ---------------------------------------------------------------------------
-- 2. open_sync_cycle -- the BASE-cycle create-or-find RPC the v3 ingestion calls. Body BYTE-IDENTICAL to 20260917
--    EXCEPT the p_bucket guard's IN-list (now the same widened thirteen). Privileges are then enforced explicitly
--    (least privilege): executable ONLY by service_role; never by public / anon / authenticated.
-- ---------------------------------------------------------------------------
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
  if p_bucket not in ('us','non-us','us-fba','non-us-fba','india','europe-au','us-ca','india-fba','europe-au-fba','us-ca-fba','listing-health-v3-india','listing-health-v3-europe-au','listing-health-v3-us-ca') then
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

-- ===========================================================================
-- ROLLBACK (MANUAL -- NOT executed by db:migrate; run by an operator only if this migration must be reverted).
-- It REFUSES if any sync_cycles row still uses a listing-health-v3-* bucket (narrowing the CHECK would otherwise
-- fail against live data / silently orphan those rows). Reassign or delete those cycles first, then run this.
-- ===========================================================================
-- do $$
-- begin
--   if exists (select 1 from public.sync_cycles where bucket like 'listing-health-v3-%') then
--     raise exception 'Rollback refused: sync_cycles still has listing-health-v3-* rows; reassign or delete them first';
--   end if;
-- end $$;
--
-- alter table public.sync_cycles drop constraint if exists sync_cycles_bucket_check;
-- alter table public.sync_cycles
--   add constraint sync_cycles_bucket_check
--   check (bucket in ('us','non-us','us-fba','non-us-fba','india','europe-au','us-ca','india-fba','europe-au-fba','us-ca-fba'));
--
-- create or replace function public.open_sync_cycle(
--   p_bucket text,
--   p_cycle_date date,
--   p_scheduled_at timestamptz default null,
--   p_trigger text default 'pg_cron'
-- )
-- returns uuid
-- language plpgsql
-- security definer
-- set search_path = public
-- as $BODY$
-- declare
--   v_id uuid;
-- begin
--   if p_bucket not in ('us','non-us','us-fba','non-us-fba','india','europe-au','us-ca','india-fba','europe-au-fba','us-ca-fba') then
--     raise exception 'Invalid bucket %', p_bucket;
--   end if;
--   insert into public.sync_cycles (bucket, cycle_date, scheduled_at, trigger, status, attempt_kind)
--   values (p_bucket, p_cycle_date, p_scheduled_at, coalesce(p_trigger, 'pg_cron'), 'pending', 'base')
--   on conflict (bucket, cycle_date) where supersedes_cycle_id is null do update set updated_at = now()
--   returning id into v_id;
--   return v_id;
-- end;
-- $BODY$;
-- revoke all on function public.open_sync_cycle(text, date, timestamptz, text) from public, anon, authenticated;
-- grant execute on function public.open_sync_cycle(text, date, timestamptz, text) to service_role;
