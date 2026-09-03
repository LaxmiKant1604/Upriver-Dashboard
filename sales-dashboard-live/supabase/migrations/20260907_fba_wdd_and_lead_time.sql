-- ===========================================================================
-- FBA Shipment Plan -- ADDITIVE Weighted Daily Demand (WDD) weights + per-ASIN lead-time / reorder inputs (Migration 22)
-- ===========================================================================
--
-- Apply forward via the tracked db:migrate runner (public.app_schema_migrations); it edits no prior migration.
-- ADDITIVE + IDEMPOTENT: adds THREE config tables (WDD weights, ASIN lead-times, and the lead-time audit) and THREE
-- SECURITY DEFINER write RPCs. Changes NO existing table, column, RPC, RLS policy or grant; stores NO DataDoe evidence;
-- NEVER mutates any source-derived Amazon inventory or the existing fba_planning_settings / fba_seller_warehouse rows.
-- Every value a seller enters is their OWN operational planning data. The existing Planning Horizon / Forecast Method /
-- warehouse planning is completely untouched; these tables power the NEW columns that sit side by side with the old ones.
--
-- WHY: the FBA Shipment Plan gains a WDD (7/30/60-day weighted demand) + lead-time + inventory-cover + reorder model.
--  * fba_wdd_weights      -- per (org, connection, account, canonical brand key) the 7D/30D/60D blend weights (each
--                            0..100, summing to EXACTLY 100). brand_key = '' is the ACCOUNT-DEFAULT record used by
--                            unmapped ASINs; a nonblank key is one canonical brand. One brand's weights are NEVER
--                            inferred from another's.
--  * fba_asin_lead_time   -- per (org, connection, account, child ASIN) the manual Production / Shipping / AWD-transfer
--                            / Safety-stock day inputs + an explicitly started/imported Inbound ETA. Values are NEVER
--                            decremented by any scheduled write; Days-to-Inbound is derived live on read from the ETA
--                            and the marketplace-local current date. A missing field stays NULL ("Not configured"),
--                            never a fabricated 0. Editing day-values does NOT restart a countdown; only an explicit
--                            'start' action (or an imported ETA) sets/So resets the ETA.
--  * fba_asin_lead_time_audit / fba_wdd_weights_audit -- append-only history of every write, written in the SAME
--                            transaction as the change (atomic audit).
--
-- ISOLATION: RLS restricts every read to a user who holds account_permissions for that account_id (admins see all) --
-- the SAME rule the existing FBA config tables use. All WRITES go through the service role via the RPCs (the api/ layer
-- validates account + canonical brand + ASIN ownership BEFORE calling); browsers get SELECT only. Audit tables are
-- service-role-only. Least-privilege ACLs; PostgreSQL 17 MAINTAIN cleared by REVOKE ALL.

-- ---------------------------------------------------------------------------
-- 1) fba_wdd_weights -- one row per (org, connection, account, brand_key). brand_key '' == the account-default blend.
-- ---------------------------------------------------------------------------
create table if not exists public.fba_wdd_weights (
  organization_fingerprint text not null,
  connection_id text not null default 'primary'
    constraint fba_wdd_weights_conn_check check (connection_id in ('primary', 'dd-secondary')),
  account_id text not null
    constraint fba_wdd_weights_account_nonblank check (char_length(btrim(account_id)) > 0),
  brand_key text not null default '',  -- '' == account-default (unmapped ASINs); otherwise ONE canonical brand key
  weight_7d numeric not null
    constraint fba_wdd_w7_range check (weight_7d >= 0 and weight_7d <= 100),
  weight_30d numeric not null
    constraint fba_wdd_w30_range check (weight_30d >= 0 and weight_30d <= 100),
  weight_60d numeric not null
    constraint fba_wdd_w60_range check (weight_60d >= 0 and weight_60d <= 100),
  updated_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint fba_wdd_weights_pk primary key (organization_fingerprint, connection_id, account_id, brand_key),
  -- The three weights MUST total EXACTLY 100 (rounded to 6 dp to absorb float noise).
  constraint fba_wdd_weights_sum100 check (round((weight_7d + weight_30d + weight_60d)::numeric, 6) = 100)
);
drop trigger if exists fba_wdd_weights_touch on public.fba_wdd_weights;
create trigger fba_wdd_weights_touch before update on public.fba_wdd_weights
  for each row execute function public.touch_updated_at();

-- 2) fba_asin_lead_time -- one row per (org, connection, account, child ASIN). Nullable day inputs (NULL = Not
--    configured, never 0). Whole nonnegative days. inbound_started_date + inbound_eta are set ONLY by an explicit
--    countdown start (or an imported ETA); they are never decremented.
create table if not exists public.fba_asin_lead_time (
  organization_fingerprint text not null,
  connection_id text not null default 'primary'
    constraint fba_alt_conn_check check (connection_id in ('primary', 'dd-secondary')),
  account_id text not null
    constraint fba_alt_account_nonblank check (char_length(btrim(account_id)) > 0),
  child_asin text not null
    constraint fba_alt_asin_nonblank check (char_length(btrim(child_asin)) > 0),
  production_days smallint
    constraint fba_alt_prod_check check (production_days is null or (production_days between 0 and 3650)),
  shipping_days smallint
    constraint fba_alt_ship_check check (shipping_days is null or (shipping_days between 0 and 3650)),
  awd_transfer_days smallint
    constraint fba_alt_awd_check check (awd_transfer_days is null or (awd_transfer_days between 0 and 3650)),
  safety_stock_days smallint
    constraint fba_alt_safety_check check (safety_stock_days is null or (safety_stock_days between 0 and 3650)),
  inbound_started_date date,
  inbound_eta date,
  note text not null default '',
  updated_by uuid references auth.users (id) on delete set null,
  updated_by_email text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint fba_alt_pk primary key (organization_fingerprint, connection_id, account_id, child_asin)
);
create index if not exists fba_alt_account_idx on public.fba_asin_lead_time (account_id);
drop trigger if exists fba_alt_touch on public.fba_asin_lead_time;
create trigger fba_alt_touch before update on public.fba_asin_lead_time
  for each row execute function public.touch_updated_at();

-- 3) audit tables (append-only history; service-role only).
create table if not exists public.fba_asin_lead_time_audit (
  id bigint generated always as identity primary key,
  organization_fingerprint text not null,
  connection_id text not null default 'primary',
  account_id text not null,
  child_asin text not null,
  production_days smallint, shipping_days smallint, awd_transfer_days smallint, safety_stock_days smallint,
  inbound_started_date date, inbound_eta date, note text not null default '',
  action text not null
    constraint fba_alt_audit_action_check check (action in ('set', 'start', 'clear', 'bulk')),
  updated_by uuid references auth.users (id) on delete set null,
  updated_by_email text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists fba_alt_audit_grain_idx
  on public.fba_asin_lead_time_audit (organization_fingerprint, connection_id, account_id, child_asin, created_at desc);

create table if not exists public.fba_wdd_weights_audit (
  id bigint generated always as identity primary key,
  organization_fingerprint text not null,
  connection_id text not null default 'primary',
  account_id text not null,
  brand_key text not null default '',
  weight_7d numeric, weight_30d numeric, weight_60d numeric,
  action text not null
    constraint fba_wdd_audit_action_check check (action in ('set', 'clear')),
  updated_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists fba_wdd_audit_grain_idx
  on public.fba_wdd_weights_audit (organization_fingerprint, connection_id, account_id, brand_key, created_at desc);

-- ---------------------------------------------------------------------------
-- record_fba_wdd_weights -- the ONLY write path for a brand's WDD blend: an atomic upsert (or delete when p_action =
-- 'clear') that ALSO appends the audit row in the SAME transaction. The 0..100 range + exact-100 total are enforced by
-- the table CHECKs (a bad total raises, so nothing is written).
-- ---------------------------------------------------------------------------
create or replace function public.record_fba_wdd_weights(
  p_organization_fingerprint text,
  p_connection_id text,
  p_account_id text,
  p_brand_key text,
  p_w7 numeric,
  p_w30 numeric,
  p_w60 numeric,
  p_action text,
  p_updated_by uuid
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_action text := coalesce(p_action, 'set');
  v_brand text := coalesce(p_brand_key, '');
begin
  if coalesce(btrim(p_organization_fingerprint), '') = '' or p_connection_id not in ('primary', 'dd-secondary')
     or coalesce(btrim(p_account_id), '') = '' then
    raise exception 'record_fba_wdd_weights: blank identity (org/connection/account required)';
  end if;
  if v_action not in ('set', 'clear') then
    raise exception 'record_fba_wdd_weights: invalid action %', v_action;
  end if;

  if v_action = 'clear' then
    delete from public.fba_wdd_weights
      where organization_fingerprint = p_organization_fingerprint and connection_id = p_connection_id
        and account_id = p_account_id and brand_key = v_brand;
  else
    if p_w7 is null or p_w30 is null or p_w60 is null then
      raise exception 'record_fba_wdd_weights: all three weights are required';
    end if;
    insert into public.fba_wdd_weights (
      organization_fingerprint, connection_id, account_id, brand_key, weight_7d, weight_30d, weight_60d, updated_by
    ) values (
      p_organization_fingerprint, p_connection_id, p_account_id, v_brand, p_w7, p_w30, p_w60, p_updated_by
    )
    on conflict (organization_fingerprint, connection_id, account_id, brand_key)
    do update set weight_7d = excluded.weight_7d, weight_30d = excluded.weight_30d, weight_60d = excluded.weight_60d,
                  updated_by = excluded.updated_by, updated_at = now();
  end if;

  insert into public.fba_wdd_weights_audit (
    organization_fingerprint, connection_id, account_id, brand_key, weight_7d, weight_30d, weight_60d, action, updated_by
  ) values (
    p_organization_fingerprint, p_connection_id, p_account_id, v_brand,
    case when v_action = 'clear' then null else p_w7 end,
    case when v_action = 'clear' then null else p_w30 end,
    case when v_action = 'clear' then null else p_w60 end,
    v_action, p_updated_by
  );

  return jsonb_build_object('account_id', p_account_id, 'brand_key', v_brand, 'action', v_action);
end;
$$;

-- ---------------------------------------------------------------------------
-- record_fba_asin_lead_time -- ONE ASIN's lead-time write. p_action:
--   'set'   -- upsert the four day inputs (NULLs allowed = Not configured / blank-as-clear); PRESERVES any existing
--              countdown (inbound_started_date / inbound_eta are NOT touched). Editing values never restarts a countdown.
--   'start' -- an explicit countdown start/reset: upsert the day inputs, then set inbound_started_date = p_started_date
--              and inbound_eta = p_started_date + production + shipping + awd (Safety EXCLUDED -- it is a buffer).
--              Requires production/shipping/awd all non-null.
--   'clear' -- delete the ASIN's row entirely.
-- Appends the audit row in the SAME transaction.
-- ---------------------------------------------------------------------------
create or replace function public.record_fba_asin_lead_time(
  p_organization_fingerprint text,
  p_connection_id text,
  p_account_id text,
  p_child_asin text,
  p_production integer,
  p_shipping integer,
  p_awd integer,
  p_safety integer,
  p_note text,
  p_action text,
  p_started_date date,
  p_updated_by uuid,
  p_updated_by_email text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_action text := coalesce(p_action, 'set');
  v_asin text := btrim(coalesce(p_child_asin, ''));
  v_eta date;
  v_started date;
begin
  if coalesce(btrim(p_organization_fingerprint), '') = '' or p_connection_id not in ('primary', 'dd-secondary')
     or coalesce(btrim(p_account_id), '') = '' or v_asin = '' then
    raise exception 'record_fba_asin_lead_time: blank identity (org/connection/account/child_asin required)';
  end if;
  if v_action not in ('set', 'start', 'clear') then
    raise exception 'record_fba_asin_lead_time: invalid action %', v_action;
  end if;

  if v_action = 'clear' then
    delete from public.fba_asin_lead_time
      where organization_fingerprint = p_organization_fingerprint and connection_id = p_connection_id
        and account_id = p_account_id and child_asin = v_asin;
    insert into public.fba_asin_lead_time_audit (
      organization_fingerprint, connection_id, account_id, child_asin, action, updated_by, updated_by_email
    ) values (p_organization_fingerprint, p_connection_id, p_account_id, v_asin, 'clear', p_updated_by, coalesce(p_updated_by_email, ''));
    return jsonb_build_object('account_id', p_account_id, 'child_asin', v_asin, 'action', 'clear');
  end if;

  if v_action = 'start' then
    if p_production is null or p_shipping is null or p_awd is null then
      raise exception 'record_fba_asin_lead_time: production, shipping and AWD transit are all required before starting a countdown';
    end if;
    if p_started_date is null then
      raise exception 'record_fba_asin_lead_time: a start date is required to start a countdown';
    end if;
    v_started := p_started_date;
    v_eta := p_started_date + (coalesce(p_production, 0) + coalesce(p_shipping, 0) + coalesce(p_awd, 0));  -- Safety excluded
  end if;

  insert into public.fba_asin_lead_time (
    organization_fingerprint, connection_id, account_id, child_asin,
    production_days, shipping_days, awd_transfer_days, safety_stock_days,
    inbound_started_date, inbound_eta, note, updated_by, updated_by_email
  ) values (
    p_organization_fingerprint, p_connection_id, p_account_id, v_asin,
    p_production, p_shipping, p_awd, p_safety,
    v_started, v_eta, coalesce(p_note, ''), p_updated_by, coalesce(p_updated_by_email, '')
  )
  on conflict (organization_fingerprint, connection_id, account_id, child_asin)
  do update set
    production_days = excluded.production_days, shipping_days = excluded.shipping_days,
    awd_transfer_days = excluded.awd_transfer_days, safety_stock_days = excluded.safety_stock_days,
    note = excluded.note, updated_by = excluded.updated_by, updated_by_email = excluded.updated_by_email,
    -- 'set' PRESERVES the existing countdown; 'start' overwrites it with the freshly computed values.
    inbound_started_date = case when v_action = 'start' then excluded.inbound_started_date else public.fba_asin_lead_time.inbound_started_date end,
    inbound_eta = case when v_action = 'start' then excluded.inbound_eta else public.fba_asin_lead_time.inbound_eta end,
    updated_at = now();

  insert into public.fba_asin_lead_time_audit (
    organization_fingerprint, connection_id, account_id, child_asin,
    production_days, shipping_days, awd_transfer_days, safety_stock_days, inbound_started_date, inbound_eta, note, action, updated_by, updated_by_email
  ) values (
    p_organization_fingerprint, p_connection_id, p_account_id, v_asin,
    p_production, p_shipping, p_awd, p_safety, v_started, v_eta, coalesce(p_note, ''), v_action, p_updated_by, coalesce(p_updated_by_email, '')
  );

  return jsonb_build_object('account_id', p_account_id, 'child_asin', v_asin, 'action', v_action, 'inbound_eta', v_eta);
end;
$$;

-- ---------------------------------------------------------------------------
-- record_fba_asin_lead_time_bulk -- atomic multi-ASIN import for ONE account. p_rows is a jsonb array of
--   { child_asin, production_days?, shipping_days?, awd_transfer_days?, safety_stock_days?, inbound_eta? }.
-- A MISSING/null field is written as NULL (blank-as-clear, intentional). An explicit inbound_eta is stored verbatim
-- (an explicit action -- it does NOT recompute from day-values and does NOT touch inbound_started_date). Every row is
-- validated up-front; ANY invalid row (blank ASIN, out-of-range day, bad date, duplicate ASIN) aborts the whole
-- transaction -- no partial import. Each applied row appends a 'bulk' audit entry in the same transaction.
-- ---------------------------------------------------------------------------
create or replace function public.record_fba_asin_lead_time_bulk(
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
  v_asin text;
  v_prod smallint; v_ship smallint; v_awd smallint; v_safety smallint;
  v_eta date;
  v_applied int := 0;
  v_seen text[] := array[]::text[];
begin
  if coalesce(btrim(p_organization_fingerprint), '') = '' or p_connection_id not in ('primary', 'dd-secondary')
     or coalesce(btrim(p_account_id), '') = '' then
    raise exception 'record_fba_asin_lead_time_bulk: blank identity (org/connection/account required)';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'record_fba_asin_lead_time_bulk: p_rows must be a jsonb array';
  end if;
  if jsonb_array_length(p_rows) = 0 then
    raise exception 'record_fba_asin_lead_time_bulk: p_rows is empty';
  end if;
  if jsonb_array_length(p_rows) > 5000 then
    raise exception 'record_fba_asin_lead_time_bulk: too many rows (max 5000)';
  end if;

  for v_row in select * from jsonb_array_elements(p_rows)
  loop
    v_asin := btrim(coalesce(v_row->>'child_asin', ''));
    if v_asin = '' then
      raise exception 'record_fba_asin_lead_time_bulk: a row has a blank child_asin';
    end if;
    if v_asin = any (v_seen) then
      raise exception 'record_fba_asin_lead_time_bulk: duplicate child_asin % in this import', v_asin;
    end if;
    v_seen := array_append(v_seen, v_asin);
    v_prod   := case when (v_row->>'production_days')   is null or btrim(v_row->>'production_days')   = '' then null else (v_row->>'production_days')::smallint end;
    v_ship   := case when (v_row->>'shipping_days')     is null or btrim(v_row->>'shipping_days')     = '' then null else (v_row->>'shipping_days')::smallint end;
    v_awd    := case when (v_row->>'awd_transfer_days') is null or btrim(v_row->>'awd_transfer_days') = '' then null else (v_row->>'awd_transfer_days')::smallint end;
    v_safety := case when (v_row->>'safety_stock_days') is null or btrim(v_row->>'safety_stock_days') = '' then null else (v_row->>'safety_stock_days')::smallint end;
    v_eta    := case when (v_row->>'inbound_eta')       is null or btrim(v_row->>'inbound_eta')       = '' then null else (v_row->>'inbound_eta')::date end;
    if (v_prod is not null and (v_prod < 0 or v_prod > 3650))
       or (v_ship is not null and (v_ship < 0 or v_ship > 3650))
       or (v_awd is not null and (v_awd < 0 or v_awd > 3650))
       or (v_safety is not null and (v_safety < 0 or v_safety > 3650)) then
      raise exception 'record_fba_asin_lead_time_bulk: a day value for % is out of range (0..3650)', v_asin;
    end if;

    insert into public.fba_asin_lead_time (
      organization_fingerprint, connection_id, account_id, child_asin,
      production_days, shipping_days, awd_transfer_days, safety_stock_days, inbound_eta, updated_by, updated_by_email
    ) values (
      p_organization_fingerprint, p_connection_id, p_account_id, v_asin,
      v_prod, v_ship, v_awd, v_safety, v_eta, p_updated_by, coalesce(p_updated_by_email, '')
    )
    on conflict (organization_fingerprint, connection_id, account_id, child_asin)
    do update set
      production_days = excluded.production_days, shipping_days = excluded.shipping_days,
      awd_transfer_days = excluded.awd_transfer_days, safety_stock_days = excluded.safety_stock_days,
      inbound_eta = excluded.inbound_eta,  -- explicit ETA import (blank clears); inbound_started_date is left untouched
      updated_by = excluded.updated_by, updated_by_email = excluded.updated_by_email, updated_at = now();

    insert into public.fba_asin_lead_time_audit (
      organization_fingerprint, connection_id, account_id, child_asin,
      production_days, shipping_days, awd_transfer_days, safety_stock_days, inbound_eta, action, updated_by, updated_by_email
    ) values (
      p_organization_fingerprint, p_connection_id, p_account_id, v_asin,
      v_prod, v_ship, v_awd, v_safety, v_eta, 'bulk', p_updated_by, coalesce(p_updated_by_email, '')
    );
    v_applied := v_applied + 1;
  end loop;

  return jsonb_build_object('account_id', p_account_id, 'applied', v_applied);
end;
$$;

-- ---------------------------------------------------------------------------
-- RLS + LEAST-PRIVILEGE ACLs (identical model to the existing FBA config tables).
-- ---------------------------------------------------------------------------
alter table public.fba_wdd_weights enable row level security;
alter table public.fba_asin_lead_time enable row level security;
alter table public.fba_asin_lead_time_audit enable row level security;
alter table public.fba_wdd_weights_audit enable row level security;

drop policy if exists fba_wdd_weights_read on public.fba_wdd_weights;
create policy fba_wdd_weights_read on public.fba_wdd_weights for select to authenticated
  using (public.is_dashboard_admin() or exists (select 1 from public.account_permissions p where p.user_id = auth.uid() and p.account_id = fba_wdd_weights.account_id));
drop policy if exists fba_alt_read on public.fba_asin_lead_time;
create policy fba_alt_read on public.fba_asin_lead_time for select to authenticated
  using (public.is_dashboard_admin() or exists (select 1 from public.account_permissions p where p.user_id = auth.uid() and p.account_id = fba_asin_lead_time.account_id));

revoke all on table public.fba_wdd_weights from public, anon, authenticated, service_role;
grant select on table public.fba_wdd_weights to authenticated;
grant select, insert, update, delete on table public.fba_wdd_weights to service_role;

revoke all on table public.fba_asin_lead_time from public, anon, authenticated, service_role;
grant select on table public.fba_asin_lead_time to authenticated;
grant select, insert, update, delete on table public.fba_asin_lead_time to service_role;

revoke all on table public.fba_asin_lead_time_audit from public, anon, authenticated, service_role;
grant select, insert on table public.fba_asin_lead_time_audit to service_role;

revoke all on table public.fba_wdd_weights_audit from public, anon, authenticated, service_role;
grant select, insert on table public.fba_wdd_weights_audit to service_role;

revoke all on function public.record_fba_wdd_weights(text, text, text, text, numeric, numeric, numeric, text, uuid) from public, anon, authenticated;
grant execute on function public.record_fba_wdd_weights(text, text, text, text, numeric, numeric, numeric, text, uuid) to service_role;

revoke all on function public.record_fba_asin_lead_time(text, text, text, text, integer, integer, integer, integer, text, text, date, uuid, text) from public, anon, authenticated;
grant execute on function public.record_fba_asin_lead_time(text, text, text, text, integer, integer, integer, integer, text, text, date, uuid, text) to service_role;

revoke all on function public.record_fba_asin_lead_time_bulk(text, text, text, jsonb, uuid, text) from public, anon, authenticated;
grant execute on function public.record_fba_asin_lead_time_bulk(text, text, text, jsonb, uuid, text) to service_role;
