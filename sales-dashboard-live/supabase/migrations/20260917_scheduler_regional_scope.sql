-- ===========================================================================
-- Scheduler regional SCOPE widening (Migration 20260917)
-- ===========================================================================
--
-- ADDITIVE + FORWARD-ONLY + IDEMPOTENT. The scheduler is moving from the two revenue buckets (us / non-us) to the
-- three operational REGIONS (india / europe-au / us-ca), each with a decoupled FBA cycle-namespace twin (-fba). This
-- migration widens every bucket/scope CHECK + every bucket-validating RPC to ACCEPT the region values IN ADDITION to
-- the legacy ones. It changes NO existing row, renames/deletes NO table, rewrites NO history, and deletes NO snapshot
-- or source data. Legacy us / non-us (and us-fba / non-us-fba) rows stay valid historical records + one-flag rollback.
-- Repeated execution is safe (each CHECK is dropped-and-re-added by a dynamic DO-block; each RPC is create-or-replace).
--
-- Canonical widened allow-list (matches lib/server/sync/scheduler-scope.js ALL_SCOPES):
--   us, non-us, us-fba, non-us-fba,                 -- legacy revenue buckets + their FBA twins (retained)
--   india, europe-au, us-ca,                        -- the three active regions
--   india-fba, europe-au-fba, us-ca-fba             -- the regions' decoupled FBA cycle-namespace twins
-- account_directory.sync_bucket additionally keeps 'unknown' (its pre-classification default).
--
-- Precedent: 20260906_fba_cycle_bucket_namespace.sql used the same dynamic drop-and-re-add pattern to add the -fba
-- twins to sync_cycles + open_sync_cycle; this migration generalizes that to every scheduler scope object.

-- ---------------------------------------------------------------------------
-- 1. CHECK constraints -- one idempotent DO-block per table. Each drops ANY existing CHECK that mentions the scope
--    column, then re-adds the widened one under a stable explicit name. The `not ilike '%trigger%'/'%status%'`
--    guards (from 20260906) keep the unrelated trigger/status checks intact where a table has them.
-- ---------------------------------------------------------------------------

-- sync_cycles.bucket (namespace column -- carries the -fba twins). Preserves the base-cycle partial-unique behaviour.
do $$
declare cname text;
begin
  for cname in
    select conname from pg_constraint
     where conrelid = 'public.sync_cycles'::regclass and contype = 'c'
       and pg_get_constraintdef(oid) ilike '%bucket%'
       and pg_get_constraintdef(oid) not ilike '%trigger%'
       and pg_get_constraintdef(oid) not ilike '%status%'
       and pg_get_constraintdef(oid) not ilike '%attempt_kind%'
       and pg_get_constraintdef(oid) not ilike '%supersede%'
  loop
    execute format('alter table public.sync_cycles drop constraint %I', cname);
  end loop;
  alter table public.sync_cycles
    add constraint sync_cycles_bucket_check
    check (bucket in ('us','non-us','us-fba','non-us-fba','india','europe-au','us-ca','india-fba','europe-au-fba','us-ca-fba'));
end $$;

-- sync_source_jobs.bucket (stores the REAL account scope -- region or legacy; never an -fba twin, but the twin is
-- allowed harmlessly so the allow-list stays uniform).
do $$
declare cname text;
begin
  for cname in
    select conname from pg_constraint
     where conrelid = 'public.sync_source_jobs'::regclass and contype = 'c'
       and pg_get_constraintdef(oid) ilike '%bucket%'
  loop
    execute format('alter table public.sync_source_jobs drop constraint %I', cname);
  end loop;
  alter table public.sync_source_jobs
    add constraint sync_source_jobs_bucket_check
    check (bucket in ('us','non-us','us-fba','non-us-fba','india','europe-au','us-ca','india-fba','europe-au-fba','us-ca-fba'));
end $$;

-- sync_report_jobs.bucket
do $$
declare cname text;
begin
  for cname in
    select conname from pg_constraint
     where conrelid = 'public.sync_report_jobs'::regclass and contype = 'c'
       and pg_get_constraintdef(oid) ilike '%bucket%'
  loop
    execute format('alter table public.sync_report_jobs drop constraint %I', cname);
  end loop;
  alter table public.sync_report_jobs
    add constraint sync_report_jobs_bucket_check
    check (bucket in ('us','non-us','us-fba','non-us-fba','india','europe-au','us-ca','india-fba','europe-au-fba','us-ca-fba'));
end $$;

-- source_run_status.bucket
do $$
declare cname text;
begin
  for cname in
    select conname from pg_constraint
     where conrelid = 'public.source_run_status'::regclass and contype = 'c'
       and pg_get_constraintdef(oid) ilike '%bucket%'
  loop
    execute format('alter table public.source_run_status drop constraint %I', cname);
  end loop;
  alter table public.source_run_status
    add constraint source_run_status_bucket_check
    check (bucket in ('us','non-us','us-fba','non-us-fba','india','europe-au','us-ca','india-fba','europe-au-fba','us-ca-fba'));
end $$;

-- source_oli_completeness.bucket (the status/count checks reference other columns, not 'bucket', so the '%bucket%'
-- filter selects only the bucket check).
do $$
declare cname text;
begin
  for cname in
    select conname from pg_constraint
     where conrelid = 'public.source_oli_completeness'::regclass and contype = 'c'
       and pg_get_constraintdef(oid) ilike '%bucket%'
  loop
    execute format('alter table public.source_oli_completeness drop constraint %I', cname);
  end loop;
  alter table public.source_oli_completeness
    add constraint source_oli_completeness_bucket_check
    check (bucket in ('us','non-us','us-fba','non-us-fba','india','europe-au','us-ca','india-fba','europe-au-fba','us-ca-fba'));
end $$;

-- sync_runs.bucket
do $$
declare cname text;
begin
  for cname in
    select conname from pg_constraint
     where conrelid = 'public.sync_runs'::regclass and contype = 'c'
       and pg_get_constraintdef(oid) ilike '%bucket%'
  loop
    execute format('alter table public.sync_runs drop constraint %I', cname);
  end loop;
  alter table public.sync_runs
    add constraint sync_runs_bucket_check
    check (bucket in ('us','non-us','us-fba','non-us-fba','india','europe-au','us-ca','india-fba','europe-au-fba','us-ca-fba'));
end $$;

-- account_directory.sync_bucket -- KEEPS 'unknown' (its pre-classification default). Routing target only (no -fba).
do $$
declare cname text;
begin
  for cname in
    select conname from pg_constraint
     where conrelid = 'public.account_directory'::regclass and contype = 'c'
       and pg_get_constraintdef(oid) ilike '%sync_bucket%'
  loop
    execute format('alter table public.account_directory drop constraint %I', cname);
  end loop;
  alter table public.account_directory
    add constraint account_directory_sync_bucket_check
    check (sync_bucket in ('us','non-us','unknown','india','europe-au','us-ca'));
end $$;

-- ---------------------------------------------------------------------------
-- 2. RPCs -- re-create each with the widened allow-list. Bodies are byte-identical to their current definitions
--    (20260906 open_sync_cycle, 20260830 open_superseding_sync_cycle, 20260831 record_oli_completeness) EXCEPT the
--    p_bucket guard's IN-list. Grants are re-issued per exact signature (grants are signature-scoped).
-- ---------------------------------------------------------------------------

-- open_sync_cycle: BASE-cycle create-or-find. Conflict target is the partial base index (20260830). Widened guard.
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
  if p_bucket not in ('us','non-us','us-fba','non-us-fba','india','europe-au','us-ca','india-fba','europe-au-fba','us-ca-fba') then
    raise exception 'Invalid bucket %', p_bucket;
  end if;

  insert into public.sync_cycles (bucket, cycle_date, scheduled_at, trigger, status, attempt_kind)
  values (p_bucket, p_cycle_date, p_scheduled_at, coalesce(p_trigger, 'pg_cron'), 'pending', 'base')
  on conflict (bucket, cycle_date) where supersedes_cycle_id is null do update set updated_at = now()
  returning id into v_id;

  return v_id;
end;
$$;

-- open_superseding_sync_cycle: atomic create-or-resume of a SUPERSEDING attempt keyed to operation_key. Widened guard;
-- body otherwise byte-identical to 20260830 (advisory lock, idempotent resume, terminal-target check).
create or replace function public.open_superseding_sync_cycle(
  p_bucket text,
  p_cycle_date date,
  p_operation_key text,
  p_supersedes_cycle_id uuid,
  p_attempt_kind text,
  p_scheduled_at timestamptz default null,
  p_trigger text default 'manual'
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_target public.sync_cycles%rowtype;
begin
  if p_bucket not in ('us','non-us','us-fba','non-us-fba','india','europe-au','us-ca','india-fba','europe-au-fba','us-ca-fba') then raise exception 'Invalid bucket %', p_bucket; end if;
  if coalesce(btrim(p_operation_key), '') = '' then raise exception 'open_superseding_sync_cycle requires a non-blank operation_key'; end if;
  if p_attempt_kind not in ('scheduled-fresh', 'manual-force') then raise exception 'open_superseding_sync_cycle attempt_kind must be scheduled-fresh|manual-force (got %)', p_attempt_kind; end if;
  if p_supersedes_cycle_id is null then raise exception 'open_superseding_sync_cycle requires a supersedes_cycle_id (the stale terminal cycle)'; end if;

  perform pg_advisory_xact_lock(hashtext(p_operation_key));

  -- Idempotent resume: this operation already has an attempt.
  select id into v_id from public.sync_cycles where operation_key = p_operation_key;
  if found then return v_id; end if;

  -- The superseded target must exist, be terminal, and share the exact slot (never supersede a running cycle).
  select * into v_target from public.sync_cycles where id = p_supersedes_cycle_id for share;
  if not found then raise exception 'open_superseding_sync_cycle: supersedes target % not found', p_supersedes_cycle_id; end if;
  if v_target.bucket <> p_bucket or v_target.cycle_date <> p_cycle_date then raise exception 'open_superseding_sync_cycle: supersedes target is a different (bucket, cycle_date)'; end if;
  if v_target.status not in ('succeeded', 'partial', 'failed') then raise exception 'open_superseding_sync_cycle: refusing to supersede a non-terminal cycle (status %)', v_target.status; end if;

  insert into public.sync_cycles (bucket, cycle_date, scheduled_at, trigger, status, operation_key, supersedes_cycle_id, attempt_kind)
  values (p_bucket, p_cycle_date, p_scheduled_at, coalesce(p_trigger, 'manual'), 'pending', p_operation_key, p_supersedes_cycle_id, p_attempt_kind)
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.open_superseding_sync_cycle(text, date, text, uuid, text, timestamptz, text) from public, anon, authenticated;
grant execute on function public.open_superseding_sync_cycle(text, date, text, uuid, text, timestamptz, text) to service_role;

-- record_oli_completeness: provenance-checked CAS upsert. Widened guard; body otherwise byte-identical to 20260831.
create or replace function public.record_oli_completeness(
  p_organization_fingerprint text,
  p_connection_id text,
  p_account_id text,
  p_bucket text,
  p_sale_date date,
  p_status text,
  p_itemized_order_count integer,
  p_pending_order_count integer,
  p_itemized_unit_count numeric,
  p_pending_unit_count numeric,
  p_defect_count integer,
  p_itemization_percent numeric,
  p_requested_as_of date,
  p_proven_export_through date,
  p_source_request_hashes jsonb,
  p_source_export_ids jsonb,
  p_refreshed_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.source_oli_completeness%rowtype;
  v_refreshed timestamptz := coalesce(p_refreshed_at, now());
  v_disposition text;
begin
  if coalesce(btrim(p_organization_fingerprint), '') = '' or coalesce(btrim(p_connection_id), '') = ''
     or coalesce(btrim(p_account_id), '') = '' or p_sale_date is null then
    raise exception 'record_oli_completeness requires org/connection/account/sale_date';
  end if;
  if p_status is null or p_status not in ('provisional', 'final', 'source-defect') then
    raise exception 'record_oli_completeness: invalid completeness_status %', p_status;
  end if;
  if p_bucket is null or p_bucket not in ('us','non-us','us-fba','non-us-fba','india','europe-au','us-ca','india-fba','europe-au-fba','us-ca-fba') then
    raise exception 'record_oli_completeness: invalid bucket %', p_bucket;
  end if;

  perform pg_advisory_xact_lock(hashtext(p_organization_fingerprint || '|' || p_connection_id || '|' || p_account_id || '|' || p_sale_date::text));

  select * into v_row
    from public.source_oli_completeness
   where organization_fingerprint = p_organization_fingerprint
     and connection_id = p_connection_id
     and account_id = p_account_id
     and sale_date = p_sale_date
   for update;

  if not found then
    insert into public.source_oli_completeness (
      organization_fingerprint, connection_id, account_id, bucket, sale_date, completeness_status,
      itemized_order_count, pending_order_count, itemized_unit_count, pending_unit_count, defect_count,
      itemization_percent, requested_as_of, proven_export_through, source_request_hashes, source_export_ids, refreshed_at
    ) values (
      p_organization_fingerprint, p_connection_id, p_account_id, p_bucket, p_sale_date, p_status,
      coalesce(p_itemized_order_count, 0), coalesce(p_pending_order_count, 0), coalesce(p_itemized_unit_count, 0),
      coalesce(p_pending_unit_count, 0), coalesce(p_defect_count, 0), coalesce(p_itemization_percent, 0),
      p_requested_as_of, p_proven_export_through, coalesce(p_source_request_hashes, '[]'::jsonb),
      coalesce(p_source_export_ids, '[]'::jsonb), v_refreshed
    );
    return jsonb_build_object('disposition', 'inserted', 'account_id', p_account_id, 'sale_date', p_sale_date, 'completeness_status', p_status);
  end if;

  -- FINAL never regresses.
  if v_row.completeness_status = 'final' then
    if p_status = 'final' and v_refreshed > v_row.refreshed_at then
      update public.source_oli_completeness
         set itemized_order_count = coalesce(p_itemized_order_count, itemized_order_count),
             pending_order_count = coalesce(p_pending_order_count, pending_order_count),
             itemized_unit_count = coalesce(p_itemized_unit_count, itemized_unit_count),
             pending_unit_count = coalesce(p_pending_unit_count, pending_unit_count),
             defect_count = coalesce(p_defect_count, defect_count),
             itemization_percent = coalesce(p_itemization_percent, itemization_percent),
             proven_export_through = coalesce(p_proven_export_through, proven_export_through),
             source_request_hashes = coalesce(p_source_request_hashes, source_request_hashes),
             source_export_ids = coalesce(p_source_export_ids, source_export_ids),
             refreshed_at = v_refreshed
       where organization_fingerprint = p_organization_fingerprint and connection_id = p_connection_id
         and account_id = p_account_id and sale_date = p_sale_date;
      v_disposition := 'final-refreshed';
    else
      v_disposition := 'already-final';
    end if;
    return jsonb_build_object('disposition', v_disposition, 'account_id', p_account_id, 'sale_date', p_sale_date, 'completeness_status', 'final');
  end if;

  -- Existing provisional / source-defect: a STALE export never clobbers newer evidence.
  if v_refreshed < v_row.refreshed_at then
    return jsonb_build_object('disposition', 'stale-ignored', 'account_id', p_account_id, 'sale_date', p_sale_date, 'completeness_status', v_row.completeness_status);
  end if;

  update public.source_oli_completeness
     set bucket = p_bucket,
         completeness_status = p_status,
         itemized_order_count = coalesce(p_itemized_order_count, 0),
         pending_order_count = coalesce(p_pending_order_count, 0),
         itemized_unit_count = coalesce(p_itemized_unit_count, 0),
         pending_unit_count = coalesce(p_pending_unit_count, 0),
         defect_count = coalesce(p_defect_count, 0),
         itemization_percent = coalesce(p_itemization_percent, 0),
         requested_as_of = coalesce(p_requested_as_of, requested_as_of),
         proven_export_through = coalesce(p_proven_export_through, proven_export_through),
         source_request_hashes = coalesce(p_source_request_hashes, '[]'::jsonb),
         source_export_ids = coalesce(p_source_export_ids, '[]'::jsonb),
         refreshed_at = v_refreshed
   where organization_fingerprint = p_organization_fingerprint and connection_id = p_connection_id
     and account_id = p_account_id and sale_date = p_sale_date;

  v_disposition := case when p_status = 'final' then 'promoted' else 'updated' end;
  return jsonb_build_object('disposition', v_disposition, 'account_id', p_account_id, 'sale_date', p_sale_date, 'completeness_status', p_status);
end;
$$;

revoke all on function public.record_oli_completeness(text, text, text, text, date, text, integer, integer, numeric, numeric, integer, numeric, date, date, jsonb, jsonb, timestamptz) from public, anon, authenticated;
grant execute on function public.record_oli_completeness(text, text, text, text, date, text, integer, integer, numeric, numeric, integer, numeric, date, date, jsonb, jsonb, timestamptz) to service_role;
