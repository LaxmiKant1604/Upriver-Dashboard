-- ===========================================================================
-- Scheduler v2 -- DURABLE one-Catalog-export / two-token reservation for the
-- Daily Reporting + Brand View PRIORITY release
-- ===========================================================================
--
-- ADDITIVE + IDEMPOTENT. Adds ONE table and TWO RPCs. Changes no existing table,
-- stores no secret. Repeated execution is safe. PREPARED, UNAPPLIED (Codex review).
--
-- WHY: the priority release derives Daily Reporting + Brand View from durable OLI +
-- Catalog and is authorized to spend AT MOST ONE Catalog export (2 AI tokens) across
-- BOTH buckets (US + Non-US), retries, process restarts, concurrent invocations, and
-- commit-unknown outcomes. A process-local counter cannot survive a restart or two
-- concurrent processes, so the ceiling is made DURABLE: a reservation keyed to the
-- frozen priority operation and the EXACT canonical Catalog request hash. The Catalog
-- is organization-scoped, so both buckets resolve the SAME request hash and thus the
-- SAME reservation row -- one create total.
--
-- FLOW (the create guard, immediately before a Catalog POST):
--   reserve_priority_catalog_create -> 'reserved' : this caller WON; it (and only it)
--       may POST once, then record the export id + tokens.
--   reserve_priority_catalog_create -> 'exists' WITH an export_id : the one create
--       already happened; the caller ADOPTS that export id (poll/download only) -- ZERO
--       new create/tokens.
--   reserve_priority_catalog_create -> 'exists' WITHOUT an export_id : a create is
--       in flight / its commit is unknown -- AMBIGUOUS. The guard fails closed and NEVER
--       falls back to a second create.
--
-- LEAST PRIVILEGE: service_role may only SELECT. Both writes go through the two SECURITY
-- DEFINER RPCs; no direct service-role write can bypass the one-create ceiling.

create table if not exists public.source_priority_catalog_reservation (
  operation_key text not null
    constraint source_priority_catalog_reservation_op_nonblank check (char_length(btrim(operation_key)) > 0),
  catalog_request_hash text not null
    constraint source_priority_catalog_reservation_hash_nonblank check (char_length(btrim(catalog_request_hash)) > 0),
  export_id text,
  tokens_spent integer not null default 0
    constraint source_priority_catalog_reservation_tokens_check check (tokens_spent in (0, 2)),
  status text not null default 'reserved'
    constraint source_priority_catalog_reservation_status_check check (status in ('reserved', 'created')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint source_priority_catalog_reservation_pk primary key (operation_key, catalog_request_hash),
  -- A 'created' reservation MUST carry an export id + 2 tokens; a 'reserved' one carries neither yet.
  constraint source_priority_catalog_reservation_created_coherent check (
    (status = 'reserved' and export_id is null and tokens_spent = 0)
    or (status = 'created' and export_id is not null and char_length(btrim(export_id)) > 0 and tokens_spent = 2)
  )
);

drop trigger if exists source_priority_catalog_reservation_touch on public.source_priority_catalog_reservation;
create trigger source_priority_catalog_reservation_touch before update on public.source_priority_catalog_reservation
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- reserve_priority_catalog_create -- the ATOMIC pre-POST reservation. Under an advisory
-- lock keyed to (operation_key, catalog_request_hash) it either INSERTs a fresh
-- 'reserved' row ('reserved' winner) or reads the existing row ('exists', echoing its
-- export_id/status/tokens_spent so the caller can adopt or fail closed). Returns jsonb:
--   { disposition:'reserved' } | { disposition:'exists', export_id, status, tokens_spent }.
-- ---------------------------------------------------------------------------
create or replace function public.reserve_priority_catalog_create(
  p_operation_key text,
  p_catalog_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.source_priority_catalog_reservation%rowtype;
begin
  if coalesce(btrim(p_operation_key), '') = '' or coalesce(btrim(p_catalog_request_hash), '') = '' then
    raise exception 'reserve_priority_catalog_create requires a non-blank operation_key and catalog_request_hash';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_operation_key || '|' || p_catalog_request_hash));

  select * into v_row
    from public.source_priority_catalog_reservation
   where operation_key = p_operation_key and catalog_request_hash = p_catalog_request_hash
   for update;
  if found then
    return jsonb_build_object(
      'disposition', 'exists',
      'export_id', v_row.export_id,
      'status', v_row.status,
      'tokens_spent', v_row.tokens_spent
    );
  end if;

  insert into public.source_priority_catalog_reservation (operation_key, catalog_request_hash)
  values (p_operation_key, p_catalog_request_hash);

  return jsonb_build_object('disposition', 'reserved');
end;
$$;

-- ---------------------------------------------------------------------------
-- record_priority_catalog_export -- record the ONE export id + 2 tokens after the winner's
-- create commits. Idempotent: recording the SAME export id again is 'already-recorded'; a
-- DIFFERENT export id for an already-created reservation is 'conflict' (never overwritten);
-- a missing reservation is 'not-reserved'. Returns jsonb { disposition, export_id }.
-- ---------------------------------------------------------------------------
create or replace function public.record_priority_catalog_export(
  p_operation_key text,
  p_catalog_request_hash text,
  p_export_id text,
  p_tokens integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.source_priority_catalog_reservation%rowtype;
begin
  if coalesce(btrim(p_export_id), '') = '' then
    raise exception 'record_priority_catalog_export requires a non-blank export_id';
  end if;
  if p_tokens is distinct from 2 then
    raise exception 'record_priority_catalog_export: a Catalog export costs exactly 2 tokens (got %)', p_tokens;
  end if;

  perform pg_advisory_xact_lock(hashtext(p_operation_key || '|' || p_catalog_request_hash));

  select * into v_row
    from public.source_priority_catalog_reservation
   where operation_key = p_operation_key and catalog_request_hash = p_catalog_request_hash
   for update;
  if not found then
    return jsonb_build_object('disposition', 'not-reserved');
  end if;
  if v_row.export_id is not null then
    if v_row.export_id = p_export_id then
      return jsonb_build_object('disposition', 'already-recorded', 'export_id', v_row.export_id);
    end if;
    return jsonb_build_object('disposition', 'conflict', 'export_id', v_row.export_id);
  end if;

  update public.source_priority_catalog_reservation
     set export_id = p_export_id, status = 'created', tokens_spent = 2, updated_at = now()
   where operation_key = p_operation_key and catalog_request_hash = p_catalog_request_hash;

  return jsonb_build_object('disposition', 'recorded', 'export_id', p_export_id);
end;
$$;

alter table public.source_priority_catalog_reservation enable row level security;
drop policy if exists "admins read priority catalog reservation" on public.source_priority_catalog_reservation;
create policy "admins read priority catalog reservation" on public.source_priority_catalog_reservation
  for select to authenticated using (public.is_dashboard_admin());

-- Least-privilege ACL: strip the Supabase default-privilege ALL grant, then grant SELECT ONLY to
-- service_role. Every write goes through the two SECURITY DEFINER RPCs, so no direct service-role write can
-- bypass the one-create / two-token ceiling.
revoke all on table public.source_priority_catalog_reservation from public, anon, authenticated, service_role;
grant select on table public.source_priority_catalog_reservation to service_role;
revoke all on function public.reserve_priority_catalog_create(text, text) from public, anon, authenticated;
grant execute on function public.reserve_priority_catalog_create(text, text) to service_role;
revoke all on function public.record_priority_catalog_export(text, text, text, integer) from public, anon, authenticated;
grant execute on function public.record_priority_catalog_export(text, text, text, integer) to service_role;
