-- ===========================================================================
-- FBA Shipment Plan -- durable PLANNING configuration + seller-owned warehouse inventory (Migration 17)
-- ===========================================================================
--
-- Apply forward via the tracked db:migrate runner (public.app_schema_migrations); it edits no prior migration.
-- ADDITIVE + IDEMPOTENT: adds four tables (planning settings, SKU horizon overrides, seller warehouse + its audit)
-- and one SECURITY DEFINER warehouse-write RPC. Changes no existing table; stores no DataDoe evidence; NEVER mutates
-- source-derived Amazon inventory. Every quantity a seller enters is their OWN operational data.
--
-- WHY: the FBA Shipment Plan becomes a configurable planner. Each seller/account gets a durable planning HORIZON
-- (1/2/3-month preset or 1..365 custom days), a FORECAST method (three-month / mtd / higher / weighted), a SAFETY-day
-- buffer, optional per-SKU horizon overrides, and a manually-maintained SELLER WAREHOUSE quantity per (marketplace,
-- SKU). All of this is SAVED SERVER-SIDE and isolated by organization + account, so it survives logout, device
-- changes, deploys, scheduler runs and reloads -- never browser localStorage. The report re-derives the plan from
-- (the existing durable fba-plan snapshot + these settings + the warehouse qty) on the CLIENT with ZERO DataDoe.
--
-- ISOLATION: RLS restricts every read to a user who has account_permissions for that account_id (admins see all).
-- All WRITES go through the service role (the api/ layer validates account access + records an audit) -- browsers get
-- SELECT only. Least-privilege ACLs; PostgreSQL 17 MAINTAIN is cleared by REVOKE ALL.

-- ---------------------------------------------------------------------------
-- shared reusable CHECK: a horizon is EITHER a 1/2/3-month preset OR a 1..365-day custom window, never both.
-- (Inlined per-table since Postgres has no shared column-check macro.)
-- ---------------------------------------------------------------------------

-- 1) fba_planning_settings -- one row per (org, connection, account): the account-default planning config.
create table if not exists public.fba_planning_settings (
  organization_fingerprint text not null,
  connection_id text not null default 'primary'
    constraint fba_planning_settings_conn_check check (connection_id in ('primary', 'dd-secondary')),
  account_id text not null
    constraint fba_planning_settings_account_nonblank check (char_length(btrim(account_id)) > 0),
  horizon_kind text not null default 'months'
    constraint fba_planning_settings_hkind_check check (horizon_kind in ('months', 'days')),
  horizon_months smallint
    constraint fba_planning_settings_hmonths_check check (horizon_months is null or horizon_months in (1, 2, 3)),
  horizon_days smallint
    constraint fba_planning_settings_hdays_check check (horizon_days is null or (horizon_days between 1 and 365)),
  forecast_method text not null default 'higher'
    constraint fba_planning_settings_method_check check (forecast_method in ('three-month', 'mtd', 'higher', 'weighted')),
  forecast_weights jsonb,
  safety_days smallint not null default 14
    constraint fba_planning_settings_safety_check check (safety_days between 0 and 365),
  updated_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint fba_planning_settings_pk primary key (organization_fingerprint, connection_id, account_id),
  -- Exactly one horizon shape is populated, matching horizon_kind.
  constraint fba_planning_settings_horizon_shape check (
    (horizon_kind = 'months' and horizon_months in (1, 2, 3) and horizon_days is null)
    or (horizon_kind = 'days' and horizon_days between 1 and 365 and horizon_months is null)
  ),
  -- weighted forecast requires a 4-number weights array; other methods store null.
  constraint fba_planning_settings_weights_shape check (
    (forecast_method = 'weighted' and jsonb_typeof(forecast_weights) = 'array' and jsonb_array_length(forecast_weights) = 4)
    or (forecast_method <> 'weighted' and forecast_weights is null)
  )
);
drop trigger if exists fba_planning_settings_touch on public.fba_planning_settings;
create trigger fba_planning_settings_touch before update on public.fba_planning_settings
  for each row execute function public.touch_updated_at();

-- 2) fba_sku_horizon_overrides -- one row per (org, connection, account, sku): an OPTIONAL per-SKU horizon override.
create table if not exists public.fba_sku_horizon_overrides (
  organization_fingerprint text not null,
  connection_id text not null default 'primary'
    constraint fba_sku_horizon_conn_check check (connection_id in ('primary', 'dd-secondary')),
  account_id text not null
    constraint fba_sku_horizon_account_nonblank check (char_length(btrim(account_id)) > 0),
  sku text not null
    constraint fba_sku_horizon_sku_nonblank check (char_length(btrim(sku)) > 0),
  horizon_kind text not null default 'months'
    constraint fba_sku_horizon_hkind_check check (horizon_kind in ('months', 'days')),
  horizon_months smallint
    constraint fba_sku_horizon_hmonths_check check (horizon_months is null or horizon_months in (1, 2, 3)),
  horizon_days smallint
    constraint fba_sku_horizon_hdays_check check (horizon_days is null or (horizon_days between 1 and 365)),
  updated_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint fba_sku_horizon_pk primary key (organization_fingerprint, connection_id, account_id, sku),
  constraint fba_sku_horizon_shape check (
    (horizon_kind = 'months' and horizon_months in (1, 2, 3) and horizon_days is null)
    or (horizon_kind = 'days' and horizon_days between 1 and 365 and horizon_months is null)
  )
);
drop trigger if exists fba_sku_horizon_touch on public.fba_sku_horizon_overrides;
create trigger fba_sku_horizon_touch before update on public.fba_sku_horizon_overrides
  for each row execute function public.touch_updated_at();

-- 3) fba_seller_warehouse -- seller-OWNED inventory per (org, connection, account, marketplace, sku). NEVER a
--    source-derived Amazon quantity. Nonnegative WHOLE units. Audited (see the audit table + the write RPC).
create table if not exists public.fba_seller_warehouse (
  organization_fingerprint text not null,
  connection_id text not null default 'primary'
    constraint fba_seller_wh_conn_check check (connection_id in ('primary', 'dd-secondary')),
  account_id text not null
    constraint fba_seller_wh_account_nonblank check (char_length(btrim(account_id)) > 0),
  marketplace text not null
    constraint fba_seller_wh_marketplace_nonblank check (char_length(btrim(marketplace)) > 0),
  sku text not null
    constraint fba_seller_wh_sku_nonblank check (char_length(btrim(sku)) > 0),
  child_asin text not null default '',
  qty numeric not null
    constraint fba_seller_wh_qty_nonneg check (qty >= 0)
    constraint fba_seller_wh_qty_whole check (qty = trunc(qty)),
  note text not null default '',
  updated_by uuid references auth.users (id) on delete set null,
  updated_by_email text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint fba_seller_wh_pk primary key (organization_fingerprint, connection_id, account_id, marketplace, sku)
);
create index if not exists fba_seller_wh_account_idx on public.fba_seller_warehouse (account_id);
drop trigger if exists fba_seller_wh_touch on public.fba_seller_warehouse;
create trigger fba_seller_wh_touch before update on public.fba_seller_warehouse
  for each row execute function public.touch_updated_at();

-- 4) fba_seller_warehouse_audit -- append-only history of every warehouse write (manual edit, clear, or bulk apply).
create table if not exists public.fba_seller_warehouse_audit (
  id bigint generated always as identity primary key,
  organization_fingerprint text not null,
  connection_id text not null default 'primary',
  account_id text not null,
  marketplace text not null,
  sku text not null,
  child_asin text not null default '',
  qty numeric,
  note text not null default '',
  action text not null
    constraint fba_seller_wh_audit_action_check check (action in ('set', 'clear', 'bulk')),
  updated_by uuid references auth.users (id) on delete set null,
  updated_by_email text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists fba_seller_wh_audit_grain_idx
  on public.fba_seller_warehouse_audit (organization_fingerprint, connection_id, account_id, marketplace, sku, created_at desc);

-- ---------------------------------------------------------------------------
-- record_fba_seller_warehouse -- the ONLY write path for a warehouse quantity: an atomic upsert (or delete when
-- p_qty is null) that ALSO appends the audit row in the SAME transaction. Nonnegative whole units enforced. Never
-- touches any source-derived table. Identity is the exact (org, connection, account, marketplace, sku) grain.
-- ---------------------------------------------------------------------------
create or replace function public.record_fba_seller_warehouse(
  p_organization_fingerprint text,
  p_connection_id text,
  p_account_id text,
  p_marketplace text,
  p_sku text,
  p_child_asin text,
  p_qty numeric,
  p_note text,
  p_updated_by uuid,
  p_updated_by_email text,
  p_action text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_action text := coalesce(p_action, 'set');
begin
  if coalesce(btrim(p_organization_fingerprint), '') = '' or p_connection_id not in ('primary', 'dd-secondary')
     or coalesce(btrim(p_account_id), '') = '' or coalesce(btrim(p_marketplace), '') = '' or coalesce(btrim(p_sku), '') = '' then
    raise exception 'record_fba_seller_warehouse: blank identity (org/connection/account/marketplace/sku required)';
  end if;
  if v_action not in ('set', 'clear', 'bulk') then
    raise exception 'record_fba_seller_warehouse: invalid action %', v_action;
  end if;
  if p_qty is not null and (p_qty < 0 or p_qty <> trunc(p_qty)) then
    raise exception 'record_fba_seller_warehouse: qty must be a nonnegative whole number (got %)', p_qty;
  end if;

  if p_qty is null then
    delete from public.fba_seller_warehouse
      where organization_fingerprint = p_organization_fingerprint and connection_id = p_connection_id
        and account_id = p_account_id and marketplace = btrim(p_marketplace) and sku = btrim(p_sku);
    v_action := 'clear';
  else
    insert into public.fba_seller_warehouse (
      organization_fingerprint, connection_id, account_id, marketplace, sku, child_asin, qty, note, updated_by, updated_by_email
    ) values (
      p_organization_fingerprint, p_connection_id, p_account_id, btrim(p_marketplace), btrim(p_sku),
      coalesce(btrim(p_child_asin), ''), p_qty, coalesce(p_note, ''), p_updated_by, coalesce(p_updated_by_email, '')
    )
    on conflict (organization_fingerprint, connection_id, account_id, marketplace, sku)
    do update set qty = excluded.qty, note = excluded.note, child_asin = excluded.child_asin,
                  updated_by = excluded.updated_by, updated_by_email = excluded.updated_by_email, updated_at = now();
  end if;

  insert into public.fba_seller_warehouse_audit (
    organization_fingerprint, connection_id, account_id, marketplace, sku, child_asin, qty, note, action, updated_by, updated_by_email
  ) values (
    p_organization_fingerprint, p_connection_id, p_account_id, btrim(p_marketplace), btrim(p_sku),
    coalesce(btrim(p_child_asin), ''), p_qty, coalesce(p_note, ''), v_action, p_updated_by, coalesce(p_updated_by_email, '')
  );

  return jsonb_build_object('account_id', p_account_id, 'marketplace', btrim(p_marketplace), 'sku', btrim(p_sku), 'qty', p_qty, 'action', v_action);
end;
$$;

-- ---------------------------------------------------------------------------
-- RLS + LEAST-PRIVILEGE ACLs. Reads are ACCOUNT-SCOPED (a user must hold account_permissions for the account, OR be a
-- dashboard admin). Writes go ONLY through the service role (the api/ layer checks account access + audits). The audit
-- table is service-role-only (never browser-readable). PostgreSQL 17 MAINTAIN cleared by REVOKE ALL.
-- ---------------------------------------------------------------------------
alter table public.fba_planning_settings enable row level security;
alter table public.fba_sku_horizon_overrides enable row level security;
alter table public.fba_seller_warehouse enable row level security;
alter table public.fba_seller_warehouse_audit enable row level security;

drop policy if exists fba_planning_settings_read on public.fba_planning_settings;
create policy fba_planning_settings_read on public.fba_planning_settings for select to authenticated
  using (public.is_dashboard_admin() or exists (select 1 from public.account_permissions p where p.user_id = auth.uid() and p.account_id = fba_planning_settings.account_id));
drop policy if exists fba_sku_horizon_read on public.fba_sku_horizon_overrides;
create policy fba_sku_horizon_read on public.fba_sku_horizon_overrides for select to authenticated
  using (public.is_dashboard_admin() or exists (select 1 from public.account_permissions p where p.user_id = auth.uid() and p.account_id = fba_sku_horizon_overrides.account_id));
drop policy if exists fba_seller_wh_read on public.fba_seller_warehouse;
create policy fba_seller_wh_read on public.fba_seller_warehouse for select to authenticated
  using (public.is_dashboard_admin() or exists (select 1 from public.account_permissions p where p.user_id = auth.uid() and p.account_id = fba_seller_warehouse.account_id));

revoke all on table public.fba_planning_settings from public, anon, authenticated, service_role;
grant select on table public.fba_planning_settings to authenticated;
grant select, insert, update, delete on table public.fba_planning_settings to service_role;

revoke all on table public.fba_sku_horizon_overrides from public, anon, authenticated, service_role;
grant select on table public.fba_sku_horizon_overrides to authenticated;
grant select, insert, update, delete on table public.fba_sku_horizon_overrides to service_role;

revoke all on table public.fba_seller_warehouse from public, anon, authenticated, service_role;
grant select on table public.fba_seller_warehouse to authenticated;
grant select, insert, update, delete on table public.fba_seller_warehouse to service_role;

revoke all on table public.fba_seller_warehouse_audit from public, anon, authenticated, service_role;
grant select, insert on table public.fba_seller_warehouse_audit to service_role;

revoke all on function public.record_fba_seller_warehouse(text, text, text, text, text, text, numeric, text, uuid, text, text) from public, anon, authenticated;
grant execute on function public.record_fba_seller_warehouse(text, text, text, text, text, text, numeric, text, uuid, text, text) to service_role;
