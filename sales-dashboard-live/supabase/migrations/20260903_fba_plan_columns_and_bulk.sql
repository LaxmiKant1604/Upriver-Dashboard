-- ===========================================================================
-- FBA Shipment Plan -- per-user column preferences + atomic seller-warehouse BULK apply (Migration 18)
-- ===========================================================================
--
-- Apply forward via the tracked db:migrate runner (public.app_schema_migrations); it edits no prior migration.
-- ADDITIVE + IDEMPOTENT: adds ONE table (per-user column visibility prefs) and ONE SECURITY DEFINER RPC
-- (a single-transaction bulk warehouse upsert). Changes no existing table; stores no DataDoe evidence.
--
-- WHY:
--  * fba_plan_column_prefs -- the grouped column chooser saves each USER's show/hide choices server-side so they
--    survive logout, device changes, deploys and reloads. Scoped to the authenticated user (never account data);
--    a user reads/writes ONLY their own row.
--  * record_fba_seller_warehouse_bulk -- the CSV/XLSX importer applies MANY validated (marketplace, sku) rows for
--    ONE account in a SINGLE transaction (all-or-nothing), appending a 'bulk' audit row per line in the same
--    transaction. Re-uses the exact identity + validation rules of the single-row RPC. If ANY row is invalid the
--    whole apply rolls back, so a partial import can never happen.
--
-- ISOLATION: RLS restricts column-pref reads to the owning user. The bulk RPC runs as the service role only (the
-- api/ layer validates account access + records the audit). Least-privilege ACLs; PostgreSQL 17 MAINTAIN cleared.

-- ---------------------------------------------------------------------------
-- 1) fba_plan_column_prefs -- one row per (user, report_key): the columns that user has HIDDEN. Absence of a row
--    (or an empty array) means "all defaults visible". Stored as a jsonb array of stable column ids.
-- ---------------------------------------------------------------------------
create table if not exists public.fba_plan_column_prefs (
  user_id uuid not null references auth.users (id) on delete cascade,
  report_key text not null default 'fba-plan'
    constraint fba_plan_col_prefs_report_check check (char_length(btrim(report_key)) > 0),
  hidden_columns jsonb not null default '[]'::jsonb
    constraint fba_plan_col_prefs_hidden_is_array check (jsonb_typeof(hidden_columns) = 'array'),
  updated_at timestamptz not null default now(),
  constraint fba_plan_col_prefs_pk primary key (user_id, report_key)
);
drop trigger if exists fba_plan_col_prefs_touch on public.fba_plan_column_prefs;
create trigger fba_plan_col_prefs_touch before update on public.fba_plan_column_prefs
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- 2) record_fba_seller_warehouse_bulk -- atomic multi-row warehouse apply for ONE account. p_rows is a jsonb array
--    of { marketplace, sku, child_asin?, qty, note? }. Every row is validated up-front; ANY invalid row aborts the
--    whole transaction (no partial apply). qty null is NOT allowed here (bulk import sets quantities; clears go
--    through the single-row RPC). Each applied row appends a 'bulk' audit entry in the same transaction.
-- ---------------------------------------------------------------------------
create or replace function public.record_fba_seller_warehouse_bulk(
  p_organization_fingerprint text,
  p_connection_id text,
  p_account_id text,
  p_rows jsonb,
  p_updated_by uuid,
  p_updated_by_email text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row jsonb;
  v_marketplace text;
  v_sku text;
  v_child_asin text;
  v_qty numeric;
  v_note text;
  v_applied int := 0;
begin
  if coalesce(btrim(p_organization_fingerprint), '') = '' or p_connection_id not in ('primary', 'dd-secondary')
     or coalesce(btrim(p_account_id), '') = '' then
    raise exception 'record_fba_seller_warehouse_bulk: blank identity (org/connection/account required)';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'record_fba_seller_warehouse_bulk: p_rows must be a jsonb array';
  end if;
  if jsonb_array_length(p_rows) = 0 then
    raise exception 'record_fba_seller_warehouse_bulk: p_rows is empty';
  end if;
  if jsonb_array_length(p_rows) > 5000 then
    raise exception 'record_fba_seller_warehouse_bulk: too many rows (max 5000)';
  end if;

  for v_row in select * from jsonb_array_elements(p_rows)
  loop
    v_marketplace := btrim(coalesce(v_row->>'marketplace', ''));
    v_sku := btrim(coalesce(v_row->>'sku', ''));
    v_child_asin := btrim(coalesce(v_row->>'child_asin', ''));
    v_note := coalesce(v_row->>'note', '');
    if v_marketplace = '' or v_sku = '' then
      raise exception 'record_fba_seller_warehouse_bulk: a row has a blank marketplace or sku';
    end if;
    if (v_row->>'qty') is null then
      raise exception 'record_fba_seller_warehouse_bulk: row %/% has a null qty', v_marketplace, v_sku;
    end if;
    v_qty := (v_row->>'qty')::numeric;
    if v_qty < 0 or v_qty <> trunc(v_qty) then
      raise exception 'record_fba_seller_warehouse_bulk: row %/% qty must be a nonnegative whole number (got %)', v_marketplace, v_sku, v_qty;
    end if;

    insert into public.fba_seller_warehouse (
      organization_fingerprint, connection_id, account_id, marketplace, sku, child_asin, qty, note, updated_by, updated_by_email
    ) values (
      p_organization_fingerprint, p_connection_id, p_account_id, v_marketplace, v_sku,
      v_child_asin, v_qty, v_note, p_updated_by, coalesce(p_updated_by_email, '')
    )
    on conflict (organization_fingerprint, connection_id, account_id, marketplace, sku)
    do update set qty = excluded.qty, note = excluded.note, child_asin = excluded.child_asin,
                  updated_by = excluded.updated_by, updated_by_email = excluded.updated_by_email, updated_at = now();

    insert into public.fba_seller_warehouse_audit (
      organization_fingerprint, connection_id, account_id, marketplace, sku, child_asin, qty, note, action, updated_by, updated_by_email
    ) values (
      p_organization_fingerprint, p_connection_id, p_account_id, v_marketplace, v_sku,
      v_child_asin, v_qty, v_note, 'bulk', p_updated_by, coalesce(p_updated_by_email, '')
    );
    v_applied := v_applied + 1;
  end loop;

  return jsonb_build_object('account_id', p_account_id, 'applied', v_applied);
end;
$$;

-- ---------------------------------------------------------------------------
-- RLS + LEAST-PRIVILEGE ACLs.
-- ---------------------------------------------------------------------------
alter table public.fba_plan_column_prefs enable row level security;

drop policy if exists fba_plan_col_prefs_read on public.fba_plan_column_prefs;
create policy fba_plan_col_prefs_read on public.fba_plan_column_prefs for select to authenticated
  using (user_id = auth.uid());

revoke all on table public.fba_plan_column_prefs from public, anon, authenticated, service_role;
grant select on table public.fba_plan_column_prefs to authenticated;
grant select, insert, update, delete on table public.fba_plan_column_prefs to service_role;

revoke all on function public.record_fba_seller_warehouse_bulk(text, text, text, jsonb, uuid, text) from public, anon, authenticated;
grant execute on function public.record_fba_seller_warehouse_bulk(text, text, text, jsonb, uuid, text) to service_role;
