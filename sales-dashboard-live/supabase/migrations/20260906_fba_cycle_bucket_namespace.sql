-- FBA Plan cycle-bucket namespace.
--
-- The FBA Shipment Plan go-live/refresh runs its OWN sync cycle through the reviewed shadow dispatcher, AFTER the
-- scheduler-v2 daily (us / non-us, cycle_date) cycle is already terminal. Because sync_cycles is UNIQUE on
-- (bucket, cycle_date), an fba-plan cycle for (us, D-1) would collide with the scheduler-v2's terminal (us, D-1)
-- cycle. This migration lets the fba-plan operator open its cycle under a DEDICATED bucket namespace
-- (us-fba / non-us-fba) so it is fully DECOUPLED -- it never collides with, appends to, or alters the
-- scheduler-v2 daily cycle, and vice-versa. Account discovery/rollout + every bucket validation still use the real
-- us / non-us bucket; ONLY the sync_cycles.bucket NAMESPACE differs.
--
-- Additive + idempotent: it replaces the sync_cycles bucket CHECK with the expanded allow-list. The existing
-- (bucket, cycle_date) unique + every other constraint are untouched; no data is altered.

do $$
declare cname text;
begin
  -- Drop EVERY bucket-only CHECK (the original is auto-named sync_cycles_bucket_check; a prior run of this
  -- migration is named the same) -- identified as a CHECK mentioning `bucket` but NOT trigger/status. The
  -- trigger/status checks are left intact. Idempotent: a re-run drops the expanded check and re-adds it.
  for cname in
    select conname from pg_constraint
     where conrelid = 'public.sync_cycles'::regclass and contype = 'c'
       and pg_get_constraintdef(oid) ilike '%bucket%'
       and pg_get_constraintdef(oid) not ilike '%trigger%'
       and pg_get_constraintdef(oid) not ilike '%status%'
  loop
    execute format('alter table public.sync_cycles drop constraint %I', cname);
  end loop;

  alter table public.sync_cycles
    add constraint sync_cycles_bucket_check
    check (bucket in ('us', 'non-us', 'us-fba', 'non-us-fba'));
end $$;

-- open_sync_cycle also validates the bucket in PL/pgSQL; expand its allow-list to the fba namespaces so the
-- fba-plan operator can open its dedicated cycle. This preserves the 20260830 superseding-aware body EXACTLY
-- (attempt_kind='base' + the partial base index conflict target `where supersedes_cycle_id is null`) and ONLY
-- widens the bucket allow-list -- the scheduler-v2 (us / non-us) path stays byte-identical. (Only sync_cycles.bucket
-- takes the fba namespace; sync_source_jobs.bucket / sync_report_jobs.bucket store the real ACCOUNT bucket.)
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
  if p_bucket not in ('us', 'non-us', 'us-fba', 'non-us-fba') then
    raise exception 'Invalid bucket %', p_bucket;
  end if;

  insert into public.sync_cycles (bucket, cycle_date, scheduled_at, trigger, status, attempt_kind)
  values (p_bucket, p_cycle_date, p_scheduled_at, coalesce(p_trigger, 'pg_cron'), 'pending', 'base')
  on conflict (bucket, cycle_date) where supersedes_cycle_id is null do update set updated_at = now()
  returning id into v_id;

  return v_id;
end;
$$;
