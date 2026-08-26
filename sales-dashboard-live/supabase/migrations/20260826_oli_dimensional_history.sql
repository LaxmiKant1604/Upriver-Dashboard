-- ===========================================================================
-- Scheduler v2 — OLI DIMENSIONAL HISTORY: order-status / fulfillment / state / city
-- ===========================================================================
--
-- >>> PREPARED, UNAPPLIED. DO NOT APPLY via a bulk apply. Applied ONLY via the
-- >>> reviewed single-file Gate after approval. Earlier migrations are FROZEN.
--
-- ADDITIVE + IDEMPOTENT. Adds ONE table + ONE SECURITY DEFINER RPC; changes no
-- existing table; stores no secret. Repeated execution is safe.
--
-- WHY: the canonical Order Line Items export is extended (once) to also carry
-- amazon_order_status, fulfillment_channel, address_state and address_city
-- (proven present in the DataDoe source schema; address_country + amazon_order_id
-- are deliberately NOT requested). The existing source_oli_daily_history PK has no
-- room for those dimensions, so this migration adds an ADDITIVE dimensional table
-- at the full grain (raw amazon_order_status kept for audit, including cancelled
-- rows) and a single atomic RPC that, in ONE transaction:
--   1. replaces the account's dimensional rows in [from,to] (ALL rows, cancelled
--      included — cancelled evidence stays queryable for audit);
--   2. replaces the NON-CANCELLED daily rollup in source_oli_daily_history (what
--      every dashboard already reads), so cancelled orders contribute ZERO to
--      sales/units/orders/trends/Daily/Brand View; and
--   3. upserts the proven order-line-items coverage window.
-- All three either commit together or roll back together. A row that violates the
-- authoritative order rules (missing status; a non-cancelled positive-unit row
-- with a missing/zero order value) raises fail-closed BEFORE any mutation, so the
-- previous last-known-good survives untouched.

-- ---------------------------------------------------------------------------
-- 1. source_oli_dimensional_history — full-grain OLI evidence incl. cancelled.
--    status_normalized (trim+lower; CANCELED == CANCELLED) and is_cancelled are
--    DERIVED, non-PK columns; the RAW amazon_order_status stays in the grain so
--    audit never loses a raw status variant. Blank fulfillment/state/city are
--    stored as '' (unavailable) — never invented geography, never a block.
-- ---------------------------------------------------------------------------
create table if not exists public.source_oli_dimensional_history (
  organization_fingerprint text not null,
  connection_id text not null default 'primary'
    constraint source_oli_dim_history_connection_id_check check (connection_id in ('primary', 'dd-secondary')),
  account_id text not null
    constraint source_oli_dim_history_account_nonblank check (char_length(btrim(account_id)) > 0),
  seller_or_vendor_id text not null
    constraint source_oli_dim_history_seller_nonblank check (char_length(btrim(seller_or_vendor_id)) > 0),
  sale_date date not null,
  sku text not null,
  child_asin text not null,
  currency text not null
    constraint source_oli_dim_history_currency_check check (currency ~ '^[A-Z]{3}$'),
  amazon_order_status text not null
    constraint source_oli_dim_history_status_nonblank check (char_length(btrim(amazon_order_status)) > 0),
  status_normalized text not null,
  is_cancelled boolean not null,
  fulfillment_channel text not null default '',
  address_state text not null default '',
  address_city text not null default '',
  total_sales_sum numeric,
  total_units_sum numeric not null,
  source_request_hash text not null
    constraint source_oli_dim_history_hash_nonblank check (char_length(btrim(source_request_hash)) > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint source_oli_dim_history_pk
    primary key (organization_fingerprint, connection_id, account_id, sale_date, seller_or_vendor_id, sku, child_asin, currency, amazon_order_status, fulfillment_channel, address_state, address_city)
);

create index if not exists source_oli_dim_history_account_date_idx
  on public.source_oli_dimensional_history (account_id, sale_date);
create index if not exists source_oli_dim_history_org_date_idx
  on public.source_oli_dimensional_history (organization_fingerprint, sale_date);
-- Read helpers for future fulfillment / state / city contribution slices (non-cancelled).
create index if not exists source_oli_dim_history_fulfillment_idx
  on public.source_oli_dimensional_history (account_id, is_cancelled, fulfillment_channel);
create index if not exists source_oli_dim_history_state_idx
  on public.source_oli_dimensional_history (account_id, is_cancelled, address_state);

drop trigger if exists source_oli_dim_history_touch on public.source_oli_dimensional_history;
create trigger source_oli_dim_history_touch
  before update on public.source_oli_dimensional_history
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- 2. replace_oli_dimensional_window — ATOMIC dimensional replacement + the
--    non-cancelled daily rollup + coverage acknowledgement, in ONE transaction.
--
-- AUTHORITATIVE ORDER RULES enforced fail-closed BEFORE any mutation:
--   - missing amazon_order_status => invalid (cancellation cannot be classified);
--   - status normalized by trim + lower-case; 'canceled' == 'cancelled';
--   - a NON-cancelled row with total_units_sum > 0 MUST carry total_sales_sum
--     PRESENT (not null/blank), else OLI_NON_CANCELLED_VALUE_MISSING (the whole
--     window is refused; the previous LKG is preserved by the rollback). A
--     PRESENT-but-zero value is a REAL zero-priced unit: it is kept for audit and
--     contributes ZERO to the rollup (like a cancelled row), never refusing;
--   - a missing order value is NEVER coerced to 0 before this check;
--   - blank state/city is allowed (stored '') and never blocks a valid sale.
-- An EMPTY p_rows is valid evidence (a zero-sales window): delete + ack only.
-- ---------------------------------------------------------------------------
create or replace function public.replace_oli_dimensional_window(
  p_organization_fingerprint text,
  p_connection_id text,
  p_account_id text,
  p_covered_from date,
  p_covered_to date,
  p_rows jsonb,
  p_source_refreshed_at timestamptz default now()
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

  -- Validate EVERY row fail-closed BEFORE any mutation.
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
    -- Missing order status is invalid: cancellation cannot be classified (rule 9).
    if coalesce(btrim(v_row->>'amazon_order_status'), '') = '' then
      raise exception 'OLI_ORDER_STATUS_MISSING: a row has no amazon_order_status; cancellation cannot be classified (account=%, date=%)', p_account_id, v_row->>'sale_date';
    end if;
    v_status_norm := lower(btrim(v_row->>'amazon_order_status'));
    v_is_cancelled := v_status_norm in ('cancelled', 'canceled');
    v_units := (v_row->>'total_units_sum')::numeric;
    -- The order value is checked WITHOUT coercing a missing value to zero first.
    v_sales_present := (v_row ? 'total_sales_sum') and (v_row->>'total_sales_sum') is not null and btrim(v_row->>'total_sales_sum') <> '';
    v_sales := case when v_sales_present then (v_row->>'total_sales_sum')::numeric else null end;
    -- A non-cancelled positive-unit row with a MISSING (null/blank) value is refused. A PRESENT-but-zero value
    -- is a REAL zero-priced unit -- kept for audit, excluded from the rollup below -- and NEVER refuses.
    if (not v_is_cancelled) and v_units > 0 and (not v_sales_present) then
      raise exception 'OLI_NON_CANCELLED_VALUE_MISSING: non-cancelled row with units>0 has a MISSING order value (account=%, date=%, status=%)', p_account_id, v_row->>'sale_date', v_row->>'amazon_order_status';
    end if;
  end loop;

  -- (a) Replace the account's DIMENSIONAL rows in the window (audit-complete, cancelled included).
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

  -- (b) Replace the account's daily rollup in source_oli_daily_history (the grain every dashboard reads). A row
  --     contributes ONLY when it is not cancelled AND carries a present, strictly-positive value. Cancelled rows
  --     AND real zero-priced non-cancelled units are excluded entirely (zero sales AND units) -- they live only in
  --     the dimensional table for audit. The rollup re-aggregates to (date, sku, child_asin, currency).
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

  -- (c) The coverage ACKNOWLEDGEMENT commits in the SAME transaction.
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
    'rollupReplaced', v_roll_deleted, 'rollupInserted', v_roll_inserted
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- RLS + EXACT LEAST-PRIVILEGE ACLs (mirror source_oli_daily_history):
-- service-role-only surface, written ONLY through the SECURITY DEFINER RPC.
-- No policy and no authenticated grant (both stay absent together).
-- ---------------------------------------------------------------------------
alter table public.source_oli_dimensional_history enable row level security;

revoke all on table public.source_oli_dimensional_history from public, anon, authenticated, service_role;
grant select on table public.source_oli_dimensional_history to service_role;

revoke all on function public.replace_oli_dimensional_window(text, text, text, date, date, jsonb, timestamptz) from public, anon, authenticated;
grant execute on function public.replace_oli_dimensional_window(text, text, text, date, date, jsonb, timestamptz) to service_role;
