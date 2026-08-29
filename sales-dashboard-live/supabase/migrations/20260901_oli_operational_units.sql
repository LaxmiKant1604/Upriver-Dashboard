-- ===========================================================================
-- Scheduler v2 -- OLI OPERATIONAL UNITS: retain & classify EVERY observed unit (Migration 16)
-- ===========================================================================
--
-- >>> PREPARED. Apply forward via the tracked db:migrate runner (public.app_schema_migrations);
-- >>> it edits no prior migration. ADDITIVE + IDEMPOTENT: adds ONE table and ONE standalone RPC, and
-- >>> DROP/CREATEs the authoritative replace RPC to gain a 9th arg (p_unit_rows). Repeated execution is safe.
--
-- WHY: the priced sales rollup (source_oli_daily_history) intentionally counts ONLY non-cancelled units with a
-- valid item_price_value > 0, so revenue and every financial ratio stay correct. But OPERATIONAL unit reporting
-- (Units Sold + SKU Movement) must also see the units that carry NO positive price: explicit zero-priced units
-- (item_price_value === 0) and pending-itemization units (item_price_value NULL). Those units are NEVER fabricated
-- into revenue; they are retained here, at the SAME (account, sale_date, sku, child_asin, currency) grain as the
-- rollup, split into per-class columns so the dashboard can show a transparent breakdown and SKU Movement can count
-- every non-cancelled unit that carries a canonical SKU/ASIN. Cancelled units are retained (audit) but excluded
-- from every non-cancelled total. From the SAME OLI export -- no second export, no extra token.
--
-- The unit-observation write RIDES the existing atomic replace_oli_dimensional_window transaction (so the priced
-- rollup, the dimensional evidence, the order audit, the coverage ack AND the operational units all commit or roll
-- back together). p_unit_rows defaults to NULL: a legacy caller that supplies no unit rows (e.g. a historical
-- dimensional replacement) SKIPS the operational-units block entirely and never disturbs it; a units-aware caller
-- always supplies the array (an EMPTY [] legitimately clears a now-inactive account/window).

-- ---------------------------------------------------------------------------
-- 1. source_oli_operational_units -- per-(account, sale_date, sku, child_asin, currency) observed-unit classes.
--    Same grain as source_oli_daily_history, so priced_units reconciles 1:1 with the rollup's units and
--    priced_sales with its sales_amount. Every unit-count column is non-negative; priced_sales is nullable
--    (NULL for a grain with no priced units -- NEVER coerced to 0). Written ONLY through the SECURITY DEFINER RPCs.
-- ---------------------------------------------------------------------------
create table if not exists public.source_oli_operational_units (
  organization_fingerprint text not null,
  connection_id text not null default 'primary'
    constraint source_oli_opunits_connection_id_check check (connection_id in ('primary', 'dd-secondary')),
  account_id text not null
    constraint source_oli_opunits_account_nonblank check (char_length(btrim(account_id)) > 0),
  seller_or_vendor_id text not null
    constraint source_oli_opunits_seller_nonblank check (char_length(btrim(seller_or_vendor_id)) > 0),
  sale_date date not null,
  sku text not null,
  child_asin text not null,
  currency text not null
    constraint source_oli_opunits_currency_check check (currency ~ '^[A-Z]{3}$'),
  priced_units numeric not null default 0
    constraint source_oli_opunits_priced_units_nonneg check (priced_units >= 0),
  priced_sales numeric
    constraint source_oli_opunits_priced_sales_nonneg check (priced_sales is null or priced_sales >= 0),
  explicit_zero_units numeric not null default 0
    constraint source_oli_opunits_zero_units_nonneg check (explicit_zero_units >= 0),
  pending_units numeric not null default 0
    constraint source_oli_opunits_pending_units_nonneg check (pending_units >= 0),
  cancelled_units numeric not null default 0
    constraint source_oli_opunits_cancelled_units_nonneg check (cancelled_units >= 0),
  source_request_hash text not null
    constraint source_oli_opunits_hash_nonblank check (char_length(btrim(source_request_hash)) > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint source_oli_opunits_pk
    primary key (organization_fingerprint, connection_id, account_id, sale_date, sku, child_asin, currency)
);

create index if not exists source_oli_opunits_account_date_idx
  on public.source_oli_operational_units (account_id, sale_date);
create index if not exists source_oli_opunits_org_date_idx
  on public.source_oli_operational_units (organization_fingerprint, sale_date);

drop trigger if exists source_oli_opunits_touch on public.source_oli_operational_units;
create trigger source_oli_opunits_touch
  before update on public.source_oli_operational_units
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- 2. Replace replace_oli_dimensional_window to gain p_unit_rows (9th arg, default NULL). The dimensional / rollup /
--    order-audit / coverage behaviour is BYTE-IDENTICAL to 20260828. The NEW (e) block replaces the account's
--    operational-unit rows in the window from p_unit_rows -- ONLY when p_unit_rows is a supplied array (NULL skips
--    it entirely, preserving existing operational units for legacy callers).
-- ---------------------------------------------------------------------------
drop function if exists public.replace_oli_dimensional_window(text, text, text, date, date, jsonb, timestamptz, jsonb);

create or replace function public.replace_oli_dimensional_window(
  p_organization_fingerprint text,
  p_connection_id text,
  p_account_id text,
  p_covered_from date,
  p_covered_to date,
  p_rows jsonb,
  p_source_refreshed_at timestamptz default now(),
  p_order_rows jsonb default '[]'::jsonb,
  p_unit_rows jsonb default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row jsonb;
  v_status_norm text;
  v_is_cancelled boolean;
  v_sales_present boolean;
  v_sales numeric;
  v_units numeric;
  v_dim_deleted integer := 0;
  v_dim_inserted integer := 0;
  v_roll_deleted integer := 0;
  v_roll_inserted integer := 0;
  v_audit_deleted integer := 0;
  v_audit_inserted integer := 0;
  v_units_deleted integer := 0;
  v_units_inserted integer := 0;
begin
  if p_organization_fingerprint is null or char_length(btrim(p_organization_fingerprint)) = 0 then
    raise exception 'replace_oli_dimensional_window: blank organization fingerprint';
  end if;
  if p_connection_id is null or p_connection_id not in ('primary', 'dd-secondary') then
    raise exception 'replace_oli_dimensional_window: invalid connection id';
  end if;
  if p_account_id is null or char_length(btrim(p_account_id)) = 0 then
    raise exception 'replace_oli_dimensional_window: blank account id';
  end if;
  if p_covered_from is null or p_covered_to is null or p_covered_from > p_covered_to then
    raise exception 'replace_oli_dimensional_window: invalid coverage window';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'replace_oli_dimensional_window: p_rows must be a jsonb array';
  end if;
  if p_order_rows is null or jsonb_typeof(p_order_rows) <> 'array' then
    raise exception 'replace_oli_dimensional_window: p_order_rows must be a jsonb array';
  end if;
  if p_unit_rows is not null and jsonb_typeof(p_unit_rows) <> 'array' then
    raise exception 'replace_oli_dimensional_window: p_unit_rows must be a jsonb array or null';
  end if;

  -- Validate EVERY dimensional row fail-closed BEFORE any mutation (UNCHANGED).
  for v_row in select * from jsonb_array_elements(p_rows) loop
    if coalesce(btrim(v_row->>'seller_or_vendor_id'), '') = ''
      or coalesce(v_row->>'sale_date', '') = ''
      or (v_row->>'sale_date')::date < p_covered_from
      or (v_row->>'sale_date')::date > p_covered_to
      or coalesce(v_row->>'currency', '') !~ '^[A-Z]{3}$'
      or coalesce(btrim(v_row->>'source_request_hash'), '') = ''
      or (v_row->>'total_units_sum') is null then
      raise exception 'replace_oli_dimensional_window: malformed dimensional row; refusing the whole window';
    end if;
    if coalesce(btrim(v_row->>'amazon_order_status'), '') = '' then
      raise exception 'OLI_ORDER_STATUS_MISSING: a row has no amazon_order_status; cancellation cannot be classified (account=%, date=%)', p_account_id, v_row->>'sale_date';
    end if;
    v_status_norm := lower(btrim(v_row->>'amazon_order_status'));
    v_is_cancelled := v_status_norm in ('cancelled', 'canceled');
    v_units := (v_row->>'total_units_sum')::numeric;
    v_sales_present := (v_row ? 'total_sales_sum') and (v_row->>'total_sales_sum') is not null and btrim(v_row->>'total_sales_sum') <> '';
    v_sales := case when v_sales_present then (v_row->>'total_sales_sum')::numeric else null end;
    if (not v_is_cancelled) and v_units > 0 and (not v_sales_present) then
      raise exception 'OLI_NON_CANCELLED_VALUE_MISSING: non-cancelled row with units>0 has a MISSING order value (account=%, date=%, status=%)', p_account_id, v_row->>'sale_date', v_row->>'amazon_order_status';
    end if;
  end loop;

  -- Validate order-audit rows fail-closed too (sale_date in window, status present, units present). Order ID may be
  -- blank (stored '' + order_id_available=false) -- a missing ID is never invented, but it never blocks the window.
  for v_row in select * from jsonb_array_elements(p_order_rows) loop
    if coalesce(btrim(v_row->>'seller_or_vendor_id'), '') = ''
      or coalesce(v_row->>'sale_date', '') = ''
      or (v_row->>'sale_date')::date < p_covered_from
      or (v_row->>'sale_date')::date > p_covered_to
      or coalesce(v_row->>'currency', '') !~ '^[A-Z]{3}$'
      or coalesce(btrim(v_row->>'amazon_order_status'), '') = ''
      or coalesce(btrim(v_row->>'source_request_hash'), '') = ''
      or (v_row->>'total_units_sum') is null then
      raise exception 'replace_oli_dimensional_window: malformed order-audit row; refusing the whole window';
    end if;
  end loop;

  -- Validate operational-unit rows fail-closed too (only when supplied): sale_date in window, currency canonical,
  -- request hash present, every class unit count non-negative. A missing price is NEVER coerced here; the columns
  -- carry pre-classified per-class unit sums (priced / explicit-zero / pending / cancelled) at the grain.
  if p_unit_rows is not null then
    for v_row in select * from jsonb_array_elements(p_unit_rows) loop
      if coalesce(btrim(v_row->>'seller_or_vendor_id'), '') = ''
        or coalesce(v_row->>'sale_date', '') = ''
        or (v_row->>'sale_date')::date < p_covered_from
        or (v_row->>'sale_date')::date > p_covered_to
        or coalesce(v_row->>'currency', '') !~ '^[A-Z]{3}$'
        or coalesce(btrim(v_row->>'source_request_hash'), '') = ''
        or coalesce((v_row->>'priced_units')::numeric, 0) < 0
        or coalesce((v_row->>'explicit_zero_units')::numeric, 0) < 0
        or coalesce((v_row->>'pending_units')::numeric, 0) < 0
        or coalesce((v_row->>'cancelled_units')::numeric, 0) < 0 then
        raise exception 'replace_oli_dimensional_window: malformed operational-unit row; refusing the whole window';
      end if;
    end loop;
  end if;

  -- (a) DIMENSIONAL replace (UNCHANGED -- amazon_order_id folded away upstream).
  delete from public.source_oli_dimensional_history
    where organization_fingerprint = p_organization_fingerprint
      and connection_id = p_connection_id
      and account_id = p_account_id
      and sale_date between p_covered_from and p_covered_to;
  get diagnostics v_dim_deleted = row_count;

  insert into public.source_oli_dimensional_history (
    organization_fingerprint, connection_id, account_id, seller_or_vendor_id,
    sale_date, sku, child_asin, currency,
    amazon_order_status, status_normalized, is_cancelled,
    fulfillment_channel, address_state, address_city,
    total_sales_sum, total_units_sum, source_request_hash
  )
  select
    p_organization_fingerprint, p_connection_id, p_account_id,
    btrim(r->>'seller_or_vendor_id'),
    (r->>'sale_date')::date,
    coalesce(r->>'sku', ''),
    coalesce(r->>'child_asin', ''),
    r->>'currency',
    btrim(r->>'amazon_order_status'),
    lower(btrim(r->>'amazon_order_status')),
    lower(btrim(r->>'amazon_order_status')) in ('cancelled', 'canceled'),
    coalesce(btrim(r->>'fulfillment_channel'), ''),
    coalesce(btrim(r->>'address_state'), ''),
    coalesce(btrim(r->>'address_city'), ''),
    case when (r ? 'total_sales_sum') and (r->>'total_sales_sum') is not null and btrim(r->>'total_sales_sum') <> ''
         then (r->>'total_sales_sum')::numeric else null end,
    (r->>'total_units_sum')::numeric,
    btrim(r->>'source_request_hash')
  from jsonb_array_elements(p_rows) as r;
  get diagnostics v_dim_inserted = row_count;

  -- (b) ROLLUP replace (UNCHANGED) -- only non-cancelled, present, strictly-POSITIVE values become business Sales/Units.
  delete from public.source_oli_daily_history
    where organization_fingerprint = p_organization_fingerprint
      and connection_id = p_connection_id
      and account_id = p_account_id
      and sale_date between p_covered_from and p_covered_to;
  get diagnostics v_roll_deleted = row_count;

  insert into public.source_oli_daily_history (
    organization_fingerprint, connection_id, account_id, seller_or_vendor_id,
    sale_date, sku, child_asin, currency, sales_amount, units, source_request_hash
  )
  select
    p_organization_fingerprint, p_connection_id, p_account_id,
    max(btrim(r->>'seller_or_vendor_id')),
    (r->>'sale_date')::date,
    coalesce(r->>'sku', ''),
    coalesce(r->>'child_asin', ''),
    r->>'currency',
    sum((r->>'total_sales_sum')::numeric),
    sum((r->>'total_units_sum')::numeric),
    max(btrim(r->>'source_request_hash'))
  from jsonb_array_elements(p_rows) as r
  where lower(btrim(r->>'amazon_order_status')) not in ('cancelled', 'canceled')
    and (r ? 'total_sales_sum') and (r->>'total_sales_sum') is not null and btrim(r->>'total_sales_sum') <> ''
    and (r->>'total_sales_sum')::numeric > 0
  group by (r->>'sale_date')::date, coalesce(r->>'sku', ''), coalesce(r->>'child_asin', ''), r->>'currency';
  get diagnostics v_roll_inserted = row_count;

  -- (c) ORDER-AUDIT replace (UNCHANGED).
  delete from public.source_oli_order_audit
    where organization_fingerprint = p_organization_fingerprint
      and connection_id = p_connection_id
      and account_id = p_account_id
      and sale_date between p_covered_from and p_covered_to;
  get diagnostics v_audit_deleted = row_count;

  insert into public.source_oli_order_audit (
    organization_fingerprint, connection_id, account_id, order_grain_hash, seller_or_vendor_id,
    sale_date, amazon_order_id, order_id_available, sku, child_asin, currency,
    amazon_order_status, status_normalized, is_cancelled,
    fulfillment_channel, address_state, address_city,
    total_sales_sum, total_units_sum, source_request_hash
  )
  select
    p_organization_fingerprint, p_connection_id, p_account_id,
    md5(concat_ws('|',
      p_account_id,
      (o->>'sale_date')::date,
      coalesce(btrim(o->>'amazon_order_id'), ''),
      btrim(o->>'seller_or_vendor_id'),
      coalesce(o->>'sku', ''),
      coalesce(o->>'child_asin', ''),
      o->>'currency',
      lower(btrim(o->>'amazon_order_status')),
      coalesce(btrim(o->>'fulfillment_channel'), ''),
      coalesce(btrim(o->>'address_state'), ''),
      coalesce(btrim(o->>'address_city'), '')
    )),
    max(btrim(o->>'seller_or_vendor_id')),
    (o->>'sale_date')::date,
    coalesce(btrim(o->>'amazon_order_id'), ''),
    char_length(coalesce(btrim(o->>'amazon_order_id'), '')) > 0,
    coalesce(o->>'sku', ''),
    coalesce(o->>'child_asin', ''),
    o->>'currency',
    max(btrim(o->>'amazon_order_status')),
    lower(btrim(o->>'amazon_order_status')),
    lower(btrim(o->>'amazon_order_status')) in ('cancelled', 'canceled'),
    coalesce(btrim(o->>'fulfillment_channel'), ''),
    coalesce(btrim(o->>'address_state'), ''),
    coalesce(btrim(o->>'address_city'), ''),
    sum(case when (o ? 'total_sales_sum') and (o->>'total_sales_sum') is not null and btrim(o->>'total_sales_sum') <> ''
             then (o->>'total_sales_sum')::numeric else null end),
    sum((o->>'total_units_sum')::numeric),
    max(btrim(o->>'source_request_hash'))
  from jsonb_array_elements(p_order_rows) as o
  group by
    (o->>'sale_date')::date,
    coalesce(btrim(o->>'amazon_order_id'), ''),
    btrim(o->>'seller_or_vendor_id'),
    coalesce(o->>'sku', ''),
    coalesce(o->>'child_asin', ''),
    o->>'currency',
    lower(btrim(o->>'amazon_order_status')),
    coalesce(btrim(o->>'fulfillment_channel'), ''),
    coalesce(btrim(o->>'address_state'), ''),
    coalesce(btrim(o->>'address_city'), '');
  get diagnostics v_audit_inserted = row_count;

  -- (e) OPERATIONAL-UNIT replace (NEW): the SAME account/window, at the rollup grain, with per-class unit sums.
  --     Only runs when p_unit_rows is supplied (NULL skips it entirely -> a legacy caller never disturbs it). An
  --     EMPTY [] legitimately clears the window (a now-inactive account). Idempotent: a replay writes the same rows.
  if p_unit_rows is not null then
    delete from public.source_oli_operational_units
      where organization_fingerprint = p_organization_fingerprint
        and connection_id = p_connection_id
        and account_id = p_account_id
        and sale_date between p_covered_from and p_covered_to;
    get diagnostics v_units_deleted = row_count;

    insert into public.source_oli_operational_units (
      organization_fingerprint, connection_id, account_id, seller_or_vendor_id,
      sale_date, sku, child_asin, currency,
      priced_units, priced_sales, explicit_zero_units, pending_units, cancelled_units, source_request_hash
    )
    select
      p_organization_fingerprint, p_connection_id, p_account_id,
      max(btrim(u->>'seller_or_vendor_id')),
      (u->>'sale_date')::date,
      coalesce(u->>'sku', ''),
      coalesce(u->>'child_asin', ''),
      u->>'currency',
      sum(coalesce((u->>'priced_units')::numeric, 0)),
      sum(case when (u ? 'priced_sales') and (u->>'priced_sales') is not null and btrim(u->>'priced_sales') <> ''
               then (u->>'priced_sales')::numeric else null end),
      sum(coalesce((u->>'explicit_zero_units')::numeric, 0)),
      sum(coalesce((u->>'pending_units')::numeric, 0)),
      sum(coalesce((u->>'cancelled_units')::numeric, 0)),
      max(btrim(u->>'source_request_hash'))
    from jsonb_array_elements(p_unit_rows) as u
    group by (u->>'sale_date')::date, coalesce(u->>'sku', ''), coalesce(u->>'child_asin', ''), u->>'currency';
    get diagnostics v_units_inserted = row_count;
  end if;

  -- (f) The coverage ACKNOWLEDGEMENT commits in the SAME transaction (UNCHANGED).
  insert into public.source_coverage (
    organization_fingerprint, connection_id, account_id, source_key,
    covered_from, covered_to, status, source_refreshed_at
  ) values (
    p_organization_fingerprint, p_connection_id, p_account_id, 'order-line-items',
    p_covered_from, p_covered_to, 'succeeded', coalesce(p_source_refreshed_at, now())
  )
  on conflict (organization_fingerprint, connection_id, account_id, source_key, covered_from, covered_to)
  do update set source_refreshed_at = excluded.source_refreshed_at, updated_at = now();

  return jsonb_build_object(
    'dimensionalReplaced', v_dim_deleted, 'dimensionalInserted', v_dim_inserted,
    'rollupReplaced', v_roll_deleted, 'rollupInserted', v_roll_inserted,
    'orderAuditReplaced', v_audit_deleted, 'orderAuditInserted', v_audit_inserted,
    'operationalUnitsReplaced', v_units_deleted, 'operationalUnitsInserted', v_units_inserted
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. replace_oli_operational_units_window -- a STANDALONE atomic replace of ONLY the operational-unit window (used by
--    the zero-export backfill that recomputes operational units from source_oli_dimensional_history WITHOUT touching
--    the priced rollup / dimensional / audit / coverage evidence). p_unit_rows is REQUIRED (a non-null array).
-- ---------------------------------------------------------------------------
create or replace function public.replace_oli_operational_units_window(
  p_organization_fingerprint text,
  p_connection_id text,
  p_account_id text,
  p_covered_from date,
  p_covered_to date,
  p_unit_rows jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row jsonb;
  v_deleted integer := 0;
  v_inserted integer := 0;
begin
  if p_organization_fingerprint is null or char_length(btrim(p_organization_fingerprint)) = 0 then
    raise exception 'replace_oli_operational_units_window: blank organization fingerprint';
  end if;
  if p_connection_id is null or p_connection_id not in ('primary', 'dd-secondary') then
    raise exception 'replace_oli_operational_units_window: invalid connection id';
  end if;
  if p_account_id is null or char_length(btrim(p_account_id)) = 0 then
    raise exception 'replace_oli_operational_units_window: blank account id';
  end if;
  if p_covered_from is null or p_covered_to is null or p_covered_from > p_covered_to then
    raise exception 'replace_oli_operational_units_window: invalid coverage window';
  end if;
  if p_unit_rows is null or jsonb_typeof(p_unit_rows) <> 'array' then
    raise exception 'replace_oli_operational_units_window: p_unit_rows must be a jsonb array';
  end if;

  for v_row in select * from jsonb_array_elements(p_unit_rows) loop
    if coalesce(btrim(v_row->>'seller_or_vendor_id'), '') = ''
      or coalesce(v_row->>'sale_date', '') = ''
      or (v_row->>'sale_date')::date < p_covered_from
      or (v_row->>'sale_date')::date > p_covered_to
      or coalesce(v_row->>'currency', '') !~ '^[A-Z]{3}$'
      or coalesce(btrim(v_row->>'source_request_hash'), '') = ''
      or coalesce((v_row->>'priced_units')::numeric, 0) < 0
      or coalesce((v_row->>'explicit_zero_units')::numeric, 0) < 0
      or coalesce((v_row->>'pending_units')::numeric, 0) < 0
      or coalesce((v_row->>'cancelled_units')::numeric, 0) < 0 then
      raise exception 'replace_oli_operational_units_window: malformed operational-unit row; refusing the whole window';
    end if;
  end loop;

  delete from public.source_oli_operational_units
    where organization_fingerprint = p_organization_fingerprint
      and connection_id = p_connection_id
      and account_id = p_account_id
      and sale_date between p_covered_from and p_covered_to;
  get diagnostics v_deleted = row_count;

  insert into public.source_oli_operational_units (
    organization_fingerprint, connection_id, account_id, seller_or_vendor_id,
    sale_date, sku, child_asin, currency,
    priced_units, priced_sales, explicit_zero_units, pending_units, cancelled_units, source_request_hash
  )
  select
    p_organization_fingerprint, p_connection_id, p_account_id,
    max(btrim(u->>'seller_or_vendor_id')),
    (u->>'sale_date')::date,
    coalesce(u->>'sku', ''),
    coalesce(u->>'child_asin', ''),
    u->>'currency',
    sum(coalesce((u->>'priced_units')::numeric, 0)),
    sum(case when (u ? 'priced_sales') and (u->>'priced_sales') is not null and btrim(u->>'priced_sales') <> ''
             then (u->>'priced_sales')::numeric else null end),
    sum(coalesce((u->>'explicit_zero_units')::numeric, 0)),
    sum(coalesce((u->>'pending_units')::numeric, 0)),
    sum(coalesce((u->>'cancelled_units')::numeric, 0)),
    max(btrim(u->>'source_request_hash'))
  from jsonb_array_elements(p_unit_rows) as u
  group by (u->>'sale_date')::date, coalesce(u->>'sku', ''), coalesce(u->>'child_asin', ''), u->>'currency';
  get diagnostics v_inserted = row_count;

  return jsonb_build_object('operationalUnitsReplaced', v_deleted, 'operationalUnitsInserted', v_inserted);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. RLS + EXACT LEAST-PRIVILEGE ACLs (mirror source_oli_dimensional_history): service-role-only surface, written
--    ONLY through the SECURITY DEFINER RPCs. REVOKE ALL clears PostgreSQL 17's MAINTAIN. No policy, no anon/authenticated.
-- ---------------------------------------------------------------------------
alter table public.source_oli_operational_units enable row level security;

revoke all on table public.source_oli_operational_units from public, anon, authenticated, service_role;
grant select on table public.source_oli_operational_units to service_role;

revoke all on function public.replace_oli_dimensional_window(text, text, text, date, date, jsonb, timestamptz, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.replace_oli_dimensional_window(text, text, text, date, date, jsonb, timestamptz, jsonb, jsonb) to service_role;

revoke all on function public.replace_oli_operational_units_window(text, text, text, date, date, jsonb) from public, anon, authenticated;
grant execute on function public.replace_oli_operational_units_window(text, text, text, date, date, jsonb) to service_role;
