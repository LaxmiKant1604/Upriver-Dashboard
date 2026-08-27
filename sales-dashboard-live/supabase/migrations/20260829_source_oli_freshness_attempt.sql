-- ===========================================================================
-- Scheduler v2 -- DURABLE per-operation OLI FRESHNESS-ATTEMPT reservation (Migration 13)
-- for the previous-day (D-1) "force latest" fresh-fetch guarantee.
-- ===========================================================================
--
-- ADDITIVE + IDEMPOTENT. Adds ONE table and TWO RPCs. Changes no existing table,
-- stores no secret. Repeated execution is safe. PREPARED, UNAPPLIED (Codex review).
--
-- WHY: a same-day re-attempt of the trailing OLI rolling window has the SAME canonical
-- request_hash (the hash carries no date/nonce), so the worker adopts the earlier cached
-- payload (20h TTL) and never refetches -- silently reusing stale D-2 evidence. The manual
-- "force latest" mode must make a GENUINE fresh DataDoe attempt for the missing D-1 window.
-- To keep that bounded + idempotent WITHOUT corrupting the canonical request_hash, the
-- FRESHNESS-ATTEMPT identity is a SEPARATE durable key:
--   scheduled-fresh/<bucket>/<requestedAsOf>            (automatic normal run)
--   manual-force/<bucket>/<requestedAsOf>/<github.run_id> (manual force-latest)
-- One (operation_key, request_hash) authorizes AT MOST ONE fresh create. The same GitHub
-- run_id (same operation_key) is idempotent (adopt its own recorded export, ZERO new create);
-- a DIFFERENT authorized run_id (new operation_key) may make another bounded attempt for the
-- still-missing window.
--
-- FLOW (immediately before a forced OLI POST for one <=5-seller batch's request_hash):
--   reserve_oli_freshness_create -> 'reserved'     : this operation WON for this hash; it (and
--       only it) may force ONE fresh create, then record the export id + 2 tokens.
--   reserve_oli_freshness_create -> 'exists' + id  : this operation already forced this hash;
--       adopt the recorded export id (poll/download only) -- ZERO create.
--   reserve_oli_freshness_create -> 'exists' no id : a forced create is in flight / its commit
--       is unknown -- AMBIGUOUS; fail closed, NEVER a second create, NEVER a COMMIT_UNKNOWN retry.
--
-- NO reset / delete / reopen route exists in these RPCs: they never DELETE, only advance status
-- reserved -> created (never back); service_role has SELECT only, so every write goes through the
-- SECURITY DEFINER RPCs. A fresh create for the SAME (operation_key, request_hash) can never happen
-- twice.

create table if not exists public.source_oli_freshness_attempt (
  operation_key text not null
    constraint source_oli_freshness_attempt_op_nonblank check (char_length(btrim(operation_key)) > 0),
  request_hash text not null
    constraint source_oli_freshness_attempt_hash_nonblank check (char_length(btrim(request_hash)) > 0),
  export_id text,
  tokens_spent integer not null default 0
    constraint source_oli_freshness_attempt_tokens_check check (tokens_spent in (0, 2)),
  status text not null default 'reserved'
    constraint source_oli_freshness_attempt_status_check check (status in ('reserved', 'created')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- (operation, request_hash) identity: one operation authorizes at most ONE fresh create PER batch hash.
  constraint source_oli_freshness_attempt_pk primary key (operation_key, request_hash),
  -- A 'created' attempt MUST carry an export id + 2 tokens; a 'reserved' one carries neither yet.
  constraint source_oli_freshness_attempt_created_coherent check (
    (status = 'reserved' and export_id is null and tokens_spent = 0)
    or (status = 'created' and export_id is not null and char_length(btrim(export_id)) > 0 and tokens_spent = 2)
  )
);

drop trigger if exists source_oli_freshness_attempt_touch on public.source_oli_freshness_attempt;
create trigger source_oli_freshness_attempt_touch before update on public.source_oli_freshness_attempt
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- reserve_oli_freshness_create -- the ATOMIC pre-POST reservation for ONE forced OLI batch export,
-- keyed to (operation_key, request_hash). Under an advisory lock it either INSERTs a fresh 'reserved'
-- row (the winner) or reads the existing row for this exact pair. Every response echoes operation_key +
-- request_hash for strict wrapper validation. Returns jsonb:
--   { disposition:'reserved', operation_key, request_hash, export_id:null, status:'reserved', tokens_spent:0 }
--   { disposition:'exists', operation_key, request_hash, export_id, status, tokens_spent }
-- ---------------------------------------------------------------------------
create or replace function public.reserve_oli_freshness_create(
  p_operation_key text,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.source_oli_freshness_attempt%rowtype;
begin
  if coalesce(btrim(p_operation_key), '') = '' or coalesce(btrim(p_request_hash), '') = '' then
    raise exception 'reserve_oli_freshness_create requires a non-blank operation_key and request_hash';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_operation_key || '|' || p_request_hash));

  select * into v_row
    from public.source_oli_freshness_attempt
   where operation_key = p_operation_key and request_hash = p_request_hash
   for update;
  if found then
    return jsonb_build_object(
      'disposition', 'exists',
      'operation_key', p_operation_key,
      'request_hash', p_request_hash,
      'export_id', v_row.export_id,
      'status', v_row.status,
      'tokens_spent', v_row.tokens_spent
    );
  end if;

  insert into public.source_oli_freshness_attempt (operation_key, request_hash)
  values (p_operation_key, p_request_hash);

  return jsonb_build_object(
    'disposition', 'reserved',
    'operation_key', p_operation_key,
    'request_hash', p_request_hash,
    'export_id', null,
    'status', 'reserved',
    'tokens_spent', 0
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- record_oli_freshness_export -- record the ONE export id + 2 tokens after the winner's forced create
-- commits. Idempotent: the SAME export id is 'already-recorded'; a DIFFERENT export id for an
-- already-created attempt is 'conflict' (never overwritten). A missing reservation is 'not-reserved'.
-- status only advances reserved -> created. Returns jsonb echoing operation_key + request_hash.
-- ---------------------------------------------------------------------------
create or replace function public.record_oli_freshness_export(
  p_operation_key text,
  p_request_hash text,
  p_export_id text,
  p_tokens integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.source_oli_freshness_attempt%rowtype;
begin
  if coalesce(btrim(p_export_id), '') = '' then
    raise exception 'record_oli_freshness_export requires a non-blank export_id';
  end if;
  if p_tokens is distinct from 2 then
    raise exception 'record_oli_freshness_export: a standard OLI export costs exactly 2 tokens (got %)', p_tokens;
  end if;

  perform pg_advisory_xact_lock(hashtext(p_operation_key || '|' || p_request_hash));

  select * into v_row
    from public.source_oli_freshness_attempt
   where operation_key = p_operation_key and request_hash = p_request_hash
   for update;
  if not found then
    return jsonb_build_object('disposition', 'not-reserved', 'operation_key', p_operation_key, 'request_hash', p_request_hash);
  end if;
  if v_row.export_id is not null then
    return jsonb_build_object(
      'disposition', case when v_row.export_id = p_export_id then 'already-recorded' else 'conflict' end,
      'operation_key', p_operation_key,
      'request_hash', p_request_hash,
      'export_id', v_row.export_id,
      'status', v_row.status,
      'tokens_spent', v_row.tokens_spent
    );
  end if;

  update public.source_oli_freshness_attempt
     set export_id = p_export_id, status = 'created', tokens_spent = 2, updated_at = now()
   where operation_key = p_operation_key and request_hash = p_request_hash;

  return jsonb_build_object(
    'disposition', 'recorded',
    'operation_key', p_operation_key,
    'request_hash', p_request_hash,
    'export_id', p_export_id,
    'status', 'created',
    'tokens_spent', 2
  );
end;
$$;

alter table public.source_oli_freshness_attempt enable row level security;
drop policy if exists source_oli_freshness_attempt_admin_read on public.source_oli_freshness_attempt;
create policy source_oli_freshness_attempt_admin_read on public.source_oli_freshness_attempt
  for select to authenticated using (public.is_dashboard_admin());

-- Least-privilege ACL: strip the Supabase default-privilege ALL grant, then grant SELECT ONLY to
-- service_role. Every write goes through the two SECURITY DEFINER RPCs, so no direct service-role write
-- can bypass the one-create-per-(operation,hash) ceiling.
revoke all on table public.source_oli_freshness_attempt from public, anon, authenticated, service_role;
grant select on table public.source_oli_freshness_attempt to authenticated;
grant select on table public.source_oli_freshness_attempt to service_role;
revoke all on function public.reserve_oli_freshness_create(text, text) from public, anon, authenticated;
grant execute on function public.reserve_oli_freshness_create(text, text) to service_role;
revoke all on function public.record_oli_freshness_export(text, text, text, integer) from public, anon, authenticated;
grant execute on function public.record_oli_freshness_export(text, text, text, integer) to service_role;
