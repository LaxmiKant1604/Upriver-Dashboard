-- ===========================================================================
-- Scheduler v2 -- DURABLE operation-wide one-Catalog-export / two-token reservation
-- for the Daily Reporting + Brand View PRIORITY release (Migration 9)
-- ===========================================================================
--
-- ADDITIVE + IDEMPOTENT. Adds ONE table and TWO RPCs. Changes no existing table,
-- stores no secret. Repeated execution is safe. PREPARED, UNAPPLIED (Codex review).
--
-- WHY: the priority release derives Daily Reporting + Brand View from durable OLI +
-- Catalog and is authorized to spend AT MOST ONE Catalog export (2 AI tokens) for the
-- WHOLE operation -- across BOTH buckets (US + Non-US), retries, restarts, concurrent
-- invocations, commit-unknown outcomes, AND midnight / asOf date drift (which would
-- change the canonical Catalog request hash). A per-hash reservation would let a second
-- export slip through when the hash changed, so the reservation identity is the
-- OPERATION alone; the first canonical Catalog request hash is recorded as IMMUTABLE
-- evidence, and any DIFFERENT hash for the same operation is a typed hash-mismatch that
-- authorizes ZERO creates.
--
-- FLOW (the create guard, immediately before a Catalog POST):
--   reserve_priority_catalog_create -> 'reserved'      : this caller WON; it (and only it)
--       may POST once, then record the export id + 2 tokens.
--   reserve_priority_catalog_create -> 'exists' + hash  : the one create already happened
--       for THIS hash; adopt the recorded export id (poll/download only) -- ZERO create.
--   reserve_priority_catalog_create -> 'exists' no id   : a create is in flight / its commit
--       is unknown -- AMBIGUOUS; fail closed, NEVER a second create.
--   reserve_priority_catalog_create -> 'hash-mismatch'  : a DIFFERENT canonical hash than the
--       one this operation reserved (e.g. date drift) -- authorize ZERO creates, fail closed.
--
-- NO reset / delete / reopen route exists: the two RPCs never DELETE, never change the
-- immutable hash, and only advance status reserved -> created (never back); service_role
-- has SELECT only, so every write goes through the SECURITY DEFINER RPCs.

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
  -- OPERATION-WIDE identity: one operation authorizes at most ONE Catalog create ever.
  constraint source_priority_catalog_reservation_pk primary key (operation_key),
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
-- reserve_priority_catalog_create -- the ATOMIC pre-POST reservation, keyed to the OPERATION
-- alone. Under an advisory lock on operation_key it either INSERTs a fresh 'reserved' row (the
-- winner) or reads the existing row. A DIFFERENT catalog_request_hash than the one the operation
-- first reserved is a typed 'hash-mismatch' (zero creates). Every response echoes operation_key +
-- catalog_request_hash for strict wrapper validation. Returns jsonb:
--   { disposition:'reserved', operation_key, catalog_request_hash, export_id:null, status:'reserved', tokens_spent:0 }
--   { disposition:'exists', operation_key, catalog_request_hash, export_id, status, tokens_spent }
--   { disposition:'hash-mismatch', operation_key, catalog_request_hash, requested_hash }
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

  perform pg_advisory_xact_lock(hashtext(p_operation_key));

  select * into v_row
    from public.source_priority_catalog_reservation
   where operation_key = p_operation_key
   for update;
  if found then
    if v_row.catalog_request_hash is distinct from p_catalog_request_hash then
      return jsonb_build_object(
        'disposition', 'hash-mismatch',
        'operation_key', p_operation_key,
        'catalog_request_hash', v_row.catalog_request_hash,
        'requested_hash', p_catalog_request_hash
      );
    end if;
    return jsonb_build_object(
      'disposition', 'exists',
      'operation_key', p_operation_key,
      'catalog_request_hash', v_row.catalog_request_hash,
      'export_id', v_row.export_id,
      'status', v_row.status,
      'tokens_spent', v_row.tokens_spent
    );
  end if;

  insert into public.source_priority_catalog_reservation (operation_key, catalog_request_hash)
  values (p_operation_key, p_catalog_request_hash);

  return jsonb_build_object(
    'disposition', 'reserved',
    'operation_key', p_operation_key,
    'catalog_request_hash', p_catalog_request_hash,
    'export_id', null,
    'status', 'reserved',
    'tokens_spent', 0
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- record_priority_catalog_export -- record the ONE export id + 2 tokens after the winner's create
-- commits. Idempotent: the SAME export id is 'already-recorded'; a DIFFERENT export id for an
-- already-created reservation is 'conflict' (never overwritten). A DIFFERENT catalog_request_hash is
-- 'hash-mismatch' (never records against a drifted hash). A missing reservation is 'not-reserved'.
-- The immutable catalog_request_hash is never changed; status only advances reserved -> created.
-- Returns jsonb echoing operation_key + catalog_request_hash.
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

  perform pg_advisory_xact_lock(hashtext(p_operation_key));

  select * into v_row
    from public.source_priority_catalog_reservation
   where operation_key = p_operation_key
   for update;
  if not found then
    return jsonb_build_object('disposition', 'not-reserved', 'operation_key', p_operation_key);
  end if;
  if v_row.catalog_request_hash is distinct from p_catalog_request_hash then
    return jsonb_build_object(
      'disposition', 'hash-mismatch',
      'operation_key', p_operation_key,
      'catalog_request_hash', v_row.catalog_request_hash,
      'requested_hash', p_catalog_request_hash
    );
  end if;
  if v_row.export_id is not null then
    return jsonb_build_object(
      'disposition', case when v_row.export_id = p_export_id then 'already-recorded' else 'conflict' end,
      'operation_key', p_operation_key,
      'catalog_request_hash', v_row.catalog_request_hash,
      'export_id', v_row.export_id,
      'status', v_row.status,
      'tokens_spent', v_row.tokens_spent
    );
  end if;

  update public.source_priority_catalog_reservation
     set export_id = p_export_id, status = 'created', tokens_spent = 2, updated_at = now()
   where operation_key = p_operation_key;

  return jsonb_build_object(
    'disposition', 'recorded',
    'operation_key', p_operation_key,
    'catalog_request_hash', v_row.catalog_request_hash,
    'export_id', p_export_id,
    'status', 'created',
    'tokens_spent', 2
  );
end;
$$;

alter table public.source_priority_catalog_reservation enable row level security;
drop policy if exists source_priority_catalog_reservation_admin_read on public.source_priority_catalog_reservation;
create policy source_priority_catalog_reservation_admin_read on public.source_priority_catalog_reservation
  for select to authenticated using (public.is_dashboard_admin());

-- Least-privilege ACL: strip the Supabase default-privilege ALL grant, then grant SELECT ONLY to
-- service_role. Every write goes through the two SECURITY DEFINER RPCs, so no direct service-role write
-- (insert/update/delete) can bypass the operation-wide one-create ceiling or the immutable hash.
revoke all on table public.source_priority_catalog_reservation from public, anon, authenticated, service_role;
grant select on table public.source_priority_catalog_reservation to authenticated;
grant select on table public.source_priority_catalog_reservation to service_role;
revoke all on function public.reserve_priority_catalog_create(text, text) from public, anon, authenticated;
grant execute on function public.reserve_priority_catalog_create(text, text) to service_role;
revoke all on function public.record_priority_catalog_export(text, text, text, integer) from public, anon, authenticated;
grant execute on function public.record_priority_catalog_export(text, text, text, integer) to service_role;
