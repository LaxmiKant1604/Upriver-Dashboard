-- ===========================================================================
-- SKU MOVEMENT -- persistent per-(org, account, marketplace, ASIN) manual IDENTIFIER + user recent-window pref
-- ===========================================================================
--
-- >>> ADDITIVE + IDEMPOTENT. Apply forward via the tracked db:migrate runner (public.app_schema_migrations); it
-- >>> edits NO prior migration. Repeated execution is safe (create table if not exists / create or replace).
--
-- Mirrors the reviewed FBA seller-warehouse pattern EXACTLY: an account-scoped table, a single-row atomic
-- upsert-or-clear RPC, an all-or-nothing bulk RPC, an append-only audit table, account-scoped RLS SELECT, and
-- writes ONLY through the service role (the api/ layer authorizes account access + audits). The identifier is
-- manual metadata: it NEVER touches any source-derived table, and a report re-derive never reads or writes it.
--
-- Also adds a `prefs jsonb` column to the EXISTING (reviewed, user-scoped) fba_plan_column_prefs table so SKU
-- Movement can persist the user's chosen recent-window N there (report_key = 'sku-movement') -- additive, and FBA's
-- own use of that table (hidden_columns only) is byte-unchanged.

-- ---------------------------------------------------------------------------
-- 1) sku_movement_identifier -- one manual identifier per (org, connection, account, marketplace, child_asin).
--    Per-ACCOUNT (the same ASIN may carry different identifiers in different accounts). Never inferred.
-- ---------------------------------------------------------------------------
create table if not exists public.sku_movement_identifier (
  organization_fingerprint text not null,
  connection_id text not null default 'primary'
    constraint sku_mv_ident_conn_check check (connection_id in ('primary', 'dd-secondary')),
  account_id text not null
    constraint sku_mv_ident_account_nonblank check (char_length(btrim(account_id)) > 0),
  marketplace text not null
    constraint sku_mv_ident_marketplace_nonblank check (char_length(btrim(marketplace)) > 0),
  child_asin text not null
    constraint sku_mv_ident_asin_nonblank check (char_length(btrim(child_asin)) > 0),
  identifier text not null
    constraint sku_mv_ident_len check (char_length(identifier) <= 120)
    constraint sku_mv_ident_no_control check (identifier !~ '[[:cntrl:]]'),
  updated_by uuid references auth.users (id) on delete set null,
  updated_by_email text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sku_mv_ident_pk primary key (organization_fingerprint, connection_id, account_id, marketplace, child_asin)
);
create index if not exists sku_mv_ident_account_idx on public.sku_movement_identifier (account_id);
drop trigger if exists sku_mv_ident_touch on public.sku_movement_identifier;
create trigger sku_mv_ident_touch before update on public.sku_movement_identifier
  for each row execute function public.touch_updated_at();

-- 2) append-only audit of every identifier write (set / clear / bulk).
create table if not exists public.sku_movement_identifier_audit (
  id bigint generated always as identity primary key,
  organization_fingerprint text not null,
  connection_id text not null default 'primary',
  account_id text not null,
  marketplace text not null,
  child_asin text not null,
  identifier text not null default '',
  action text not null
    constraint sku_mv_ident_audit_action_check check (action in ('set', 'clear', 'bulk')),
  updated_by uuid references auth.users (id) on delete set null,
  updated_by_email text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists sku_mv_ident_audit_grain_idx
  on public.sku_movement_identifier_audit (organization_fingerprint, connection_id, account_id, marketplace, child_asin, created_at desc);

-- ---------------------------------------------------------------------------
-- 3) record_sku_movement_identifier -- the ONLY single-row write path: an atomic upsert (or DELETE when the
--    identifier is blank = clear) that ALSO appends the audit row in the SAME transaction. Length + control-char
--    validated. Identity is the exact (org, connection, account, marketplace, child_asin) grain.
-- ---------------------------------------------------------------------------
create or replace function public.record_sku_movement_identifier(
  p_organization_fingerprint text,
  p_connection_id text,
  p_account_id text,
  p_marketplace text,
  p_child_asin text,
  p_identifier text,
  p_updated_by uuid,
  p_updated_by_email text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_mkt text := btrim(coalesce(p_marketplace, ''));
  v_asin text := btrim(coalesce(p_child_asin, ''));
  v_ident text := btrim(coalesce(p_identifier, ''));
  v_action text;
begin
  if coalesce(btrim(p_organization_fingerprint), '') = '' or p_connection_id not in ('primary', 'dd-secondary')
     or coalesce(btrim(p_account_id), '') = '' or v_mkt = '' or v_asin = '' then
    raise exception 'record_sku_movement_identifier: blank identity (org/connection/account/marketplace/asin required)';
  end if;
  if char_length(v_ident) > 120 then
    raise exception 'record_sku_movement_identifier: identifier too long (max 120)';
  end if;
  if v_ident ~ '[[:cntrl:]]' then
    raise exception 'record_sku_movement_identifier: identifier contains control characters';
  end if;

  if v_ident = '' then
    delete from public.sku_movement_identifier
      where organization_fingerprint = p_organization_fingerprint and connection_id = p_connection_id
        and account_id = p_account_id and marketplace = v_mkt and child_asin = v_asin;
    v_action := 'clear';
  else
    insert into public.sku_movement_identifier (
      organization_fingerprint, connection_id, account_id, marketplace, child_asin, identifier, updated_by, updated_by_email
    ) values (
      p_organization_fingerprint, p_connection_id, p_account_id, v_mkt, v_asin, v_ident, p_updated_by, coalesce(p_updated_by_email, '')
    )
    on conflict (organization_fingerprint, connection_id, account_id, marketplace, child_asin)
    do update set identifier = excluded.identifier, updated_by = excluded.updated_by,
                  updated_by_email = excluded.updated_by_email, updated_at = now();
    v_action := 'set';
  end if;

  insert into public.sku_movement_identifier_audit (
    organization_fingerprint, connection_id, account_id, marketplace, child_asin, identifier, action, updated_by, updated_by_email
  ) values (
    p_organization_fingerprint, p_connection_id, p_account_id, v_mkt, v_asin, v_ident, v_action, p_updated_by, coalesce(p_updated_by_email, '')
  );

  return jsonb_build_object('account_id', p_account_id, 'marketplace', v_mkt, 'child_asin', v_asin, 'identifier', v_ident, 'action', v_action);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4) record_sku_movement_identifier_bulk -- ALL-OR-NOTHING bulk apply for ONE account (single canonical
--    marketplace passed by the authorized api/ layer). One transaction; any bad row rolls back the whole apply. A
--    blank identifier CLEARS that ASIN. Rejects: blank asin, over-long / control-char identifier, and a DUPLICATE
--    child_asin carrying CONFLICTING identifiers within the same file. Idempotent (re-apply = same rows).
-- ---------------------------------------------------------------------------
create or replace function public.record_sku_movement_identifier_bulk(
  p_organization_fingerprint text,
  p_connection_id text,
  p_account_id text,
  p_marketplace text,
  p_rows jsonb,
  p_updated_by uuid,
  p_updated_by_email text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_mkt text := btrim(coalesce(p_marketplace, ''));
  v_row jsonb;
  v_asin text;
  v_ident text;
  v_applied int := 0;
begin
  if coalesce(btrim(p_organization_fingerprint), '') = '' or p_connection_id not in ('primary', 'dd-secondary')
     or coalesce(btrim(p_account_id), '') = '' or v_mkt = '' then
    raise exception 'record_sku_movement_identifier_bulk: blank identity (org/connection/account/marketplace required)';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'record_sku_movement_identifier_bulk: p_rows must be a jsonb array';
  end if;
  if jsonb_array_length(p_rows) = 0 then
    raise exception 'record_sku_movement_identifier_bulk: p_rows is empty';
  end if;
  if jsonb_array_length(p_rows) > 5000 then
    raise exception 'record_sku_movement_identifier_bulk: too many rows (max 5000)';
  end if;

  -- Reject a duplicate child_asin that carries CONFLICTING identifiers within the SAME file (before any write).
  if exists (
    select 1 from (
      select btrim(coalesce(r->>'child_asin','')) asin, count(distinct btrim(coalesce(r->>'identifier',''))) c
      from jsonb_array_elements(p_rows) r group by 1
    ) d where d.c > 1
  ) then
    raise exception 'record_sku_movement_identifier_bulk: a child_asin appears more than once with conflicting identifiers';
  end if;

  for v_row in select * from jsonb_array_elements(p_rows)
  loop
    v_asin := btrim(coalesce(v_row->>'child_asin', ''));
    v_ident := btrim(coalesce(v_row->>'identifier', ''));
    if v_asin = '' then
      raise exception 'record_sku_movement_identifier_bulk: a row has a blank child_asin';
    end if;
    if char_length(v_ident) > 120 then
      raise exception 'record_sku_movement_identifier_bulk: identifier too long for asin % (max 120)', v_asin;
    end if;
    if v_ident ~ '[[:cntrl:]]' then
      raise exception 'record_sku_movement_identifier_bulk: identifier for asin % contains control characters', v_asin;
    end if;

    if v_ident = '' then
      delete from public.sku_movement_identifier
        where organization_fingerprint = p_organization_fingerprint and connection_id = p_connection_id
          and account_id = p_account_id and marketplace = v_mkt and child_asin = v_asin;
    else
      insert into public.sku_movement_identifier (
        organization_fingerprint, connection_id, account_id, marketplace, child_asin, identifier, updated_by, updated_by_email
      ) values (
        p_organization_fingerprint, p_connection_id, p_account_id, v_mkt, v_asin, v_ident, p_updated_by, coalesce(p_updated_by_email, '')
      )
      on conflict (organization_fingerprint, connection_id, account_id, marketplace, child_asin)
      do update set identifier = excluded.identifier, updated_by = excluded.updated_by,
                    updated_by_email = excluded.updated_by_email, updated_at = now();
    end if;

    insert into public.sku_movement_identifier_audit (
      organization_fingerprint, connection_id, account_id, marketplace, child_asin, identifier, action, updated_by, updated_by_email
    ) values (
      p_organization_fingerprint, p_connection_id, p_account_id, v_mkt, v_asin, v_ident, 'bulk', p_updated_by, coalesce(p_updated_by_email, '')
    );
    v_applied := v_applied + 1;
  end loop;

  return jsonb_build_object('account_id', p_account_id, 'marketplace', v_mkt, 'applied', v_applied);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5) RLS + LEAST-PRIVILEGE ACLs. Reads are ACCOUNT-SCOPED (account_permissions OR dashboard admin). Writes go ONLY
--    through the service role (the api/ layer authorizes + audits). The audit table is service-role-only.
-- ---------------------------------------------------------------------------
alter table public.sku_movement_identifier enable row level security;
alter table public.sku_movement_identifier_audit enable row level security;

drop policy if exists sku_mv_ident_read on public.sku_movement_identifier;
create policy sku_mv_ident_read on public.sku_movement_identifier for select to authenticated
  using (public.is_dashboard_admin() or exists (select 1 from public.account_permissions p where p.user_id = auth.uid() and p.account_id = sku_movement_identifier.account_id));

revoke all on table public.sku_movement_identifier from public, anon, authenticated, service_role;
grant select on table public.sku_movement_identifier to authenticated;
grant select, insert, update, delete on table public.sku_movement_identifier to service_role;

revoke all on table public.sku_movement_identifier_audit from public, anon, authenticated, service_role;
grant select, insert on table public.sku_movement_identifier_audit to service_role;

revoke all on function public.record_sku_movement_identifier(text, text, text, text, text, text, uuid, text) from public, anon, authenticated;
grant execute on function public.record_sku_movement_identifier(text, text, text, text, text, text, uuid, text) to service_role;
revoke all on function public.record_sku_movement_identifier_bulk(text, text, text, text, jsonb, uuid, text) from public, anon, authenticated;
grant execute on function public.record_sku_movement_identifier_bulk(text, text, text, text, jsonb, uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- 6) Additive: a per-(user, report) `prefs` jsonb on the reviewed user-scoped column-prefs table, so SKU Movement
--    persists the chosen recent-window N (report_key = 'sku-movement'). FBA's use (hidden_columns) is unchanged.
-- ---------------------------------------------------------------------------
alter table public.fba_plan_column_prefs add column if not exists prefs jsonb not null default '{}'::jsonb;
