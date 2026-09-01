-- ===========================================================================
-- Returns & Refund Leakage -- DURABLE per-account history (Migration 20260914)
-- ===========================================================================
--
-- >>> PREPARED. Apply forward via the tracked db:migrate runner (public.app_schema_migrations); it edits no prior
-- >>> migration. ADDITIVE + IDEMPOTENT: adds TWO standalone durable tables and TWO standalone atomic replace RPCs.
-- >>> Repeated execution is safe. It touches NO existing table, RPC, report, or scheduler.
--
-- WHY: the Returns & Refund Leakage report previously derived from an EPHEMERAL per-cycle source cache. This migration
-- gives it its OWN durable, narrowly-scoped history so a dedicated Returns cycle can atomically replace a rolling
-- window WITHOUT re-fetching, so the advanced page can slice 7/14/30/60-day windows + trends from saved history with
-- ZERO refetch, and so a failed account/bucket never erases its last-known-good.
--
-- Two sources, each in its own table, each used ONLY for what it can prove:
--   1. source_returns_history      -- Returns (FBA & FBM). One SOURCE row = one returned item; there is NO order/refund
--                                     currency column (only cogs_currency), so a durable row NEVER carries a settlement
--                                     currency -- the report attributes currency later via ordered/settlement evidence.
--                                     We store COUNTS by (return_date, sku, child_asin, reason, channel, request_status,
--                                     label_payer) -- counting rows, NOT inventing a quantity field. FBM-only refunded
--                                     amount + seller-borne label cost are summed SEPARATELY (never an FBA authority).
--   2. source_settlement_history   -- Settlements & P&L Components. THE monetary authority for refunds/taxes/fees/
--                                     commission recovery/restocking/FBA customer-return fees/COGS, keyed by
--                                     (settlement_date, sku, child_asin, currency, settlement_type) so money NEVER
--                                     crosses currencies and ORDER vs REFUND stay separable.
--
-- Order Line Items (the ordered-unit / ordered-sales denominators) and Product Catalog are REUSED from their existing
-- durable homes -- this migration creates ZERO returns-owned OLI/Catalog storage.
--
-- Provenance is immutable per row: source_request_hash (the DataDoe request identity that produced it) + refreshed_at
-- (the export fetched-at) + calculated_at. Both replace RPCs validate EVERY row fail-closed BEFORE any mutation, so a
-- malformed payload rolls back and preserves last-known-good; they DELETE the account's window then re-insert the new
-- set, so rows no longer returned are removed and a replay writes byte-identical rows (idempotent).

-- ---------------------------------------------------------------------------
-- 1. source_returns_history -- day-grain aggregate of returned items.
--    Grain / PK: (org, connection, account, return_date, sku, child_asin, amazon_return_reason,
--    fulfillment_channel, request_status, label_payer). return_count is the number of SOURCE rows (returned items)
--    at that grain. detailed_disposition is a representative (max) descriptor, not part of the key.
-- ---------------------------------------------------------------------------
create table if not exists public.source_returns_history (
  organization_fingerprint text not null,
  connection_id text not null default 'primary'
    constraint source_returns_hist_connection_id_check check (connection_id in ('primary', 'dd-secondary')),
  account_id text not null
    constraint source_returns_hist_account_nonblank check (char_length(btrim(account_id)) > 0),
  seller_or_vendor_id text not null
    constraint source_returns_hist_seller_nonblank check (char_length(btrim(seller_or_vendor_id)) > 0),
  marketplace_country_code text not null default '',
  return_date date not null,
  sku text not null default '',
  child_asin text not null default '',
  amazon_return_reason text not null default '',
  fulfillment_channel text not null default '',
  request_status text not null default '',
  label_payer text not null default '',
  detailed_disposition text not null default '',
  return_count integer not null
    constraint source_returns_hist_count_pos check (return_count > 0),
  fbm_refunded_amount numeric not null default 0
    constraint source_returns_hist_fbm_refund_nonneg check (fbm_refunded_amount >= 0),
  fbm_seller_label_cost numeric not null default 0
    constraint source_returns_hist_fbm_label_nonneg check (fbm_seller_label_cost >= 0),
  cogs_total_value numeric not null default 0,
  source_request_hash text not null
    constraint source_returns_hist_hash_nonblank check (char_length(btrim(source_request_hash)) > 0),
  refreshed_at timestamptz,
  calculated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint source_returns_hist_pk primary key
    (organization_fingerprint, connection_id, account_id, return_date, sku, child_asin,
     amazon_return_reason, fulfillment_channel, request_status, label_payer)
);

create index if not exists source_returns_hist_account_date_idx
  on public.source_returns_history (account_id, return_date);
create index if not exists source_returns_hist_org_date_idx
  on public.source_returns_history (organization_fingerprint, return_date);

drop trigger if exists source_returns_hist_touch on public.source_returns_history;
create trigger source_returns_hist_touch
  before update on public.source_returns_history
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- 2. source_settlement_history -- day-grain aggregate of settlement money.
--    Grain / PK: (org, connection, account, settlement_date, sku, child_asin, currency, settlement_type).
--    settlement_type is ORDER / REFUND / OTHER. Raw SIGNED sums are stored (Amazon posts money-out negative);
--    the report takes absolute values at read so reconciliation can still see the raw sign. refund_event_count is
--    the number of REFUND source rows aggregated at that grain (the report's refundEvents).
-- ---------------------------------------------------------------------------
create table if not exists public.source_settlement_history (
  organization_fingerprint text not null,
  connection_id text not null default 'primary'
    constraint source_settle_hist_connection_id_check check (connection_id in ('primary', 'dd-secondary')),
  account_id text not null
    constraint source_settle_hist_account_nonblank check (char_length(btrim(account_id)) > 0),
  seller_or_vendor_id text not null
    constraint source_settle_hist_seller_nonblank check (char_length(btrim(seller_or_vendor_id)) > 0),
  marketplace_country_code text not null default '',
  settlement_date date not null,
  sku text not null default '',
  child_asin text not null default '',
  currency text not null
    constraint source_settle_hist_currency_check check (currency ~ '^[A-Z]{3}$'),
  settlement_type text not null
    constraint source_settle_hist_type_check check (settlement_type in ('ORDER', 'REFUND', 'OTHER')),
  quantity numeric not null default 0,
  item_price numeric not null default 0,
  refunded_amount numeric not null default 0,
  refund_tax numeric not null default 0,
  refunded_referral_fee numeric not null default 0,
  refund_commission numeric not null default 0,
  refund_restocking_fee numeric not null default 0,
  fba_customer_return_per_unit_fee numeric not null default 0,
  fba_customer_return_fee numeric not null default 0,
  customer_return_hrr_unit_fee numeric not null default 0,
  cogs_total_value numeric not null default 0,
  refund_event_count integer not null default 0
    constraint source_settle_hist_refund_events_nonneg check (refund_event_count >= 0),
  source_request_hash text not null
    constraint source_settle_hist_hash_nonblank check (char_length(btrim(source_request_hash)) > 0),
  refreshed_at timestamptz,
  calculated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint source_settle_hist_pk primary key
    (organization_fingerprint, connection_id, account_id, settlement_date, sku, child_asin, currency, settlement_type)
);

create index if not exists source_settle_hist_account_date_idx
  on public.source_settlement_history (account_id, settlement_date);
create index if not exists source_settle_hist_org_date_idx
  on public.source_settlement_history (organization_fingerprint, settlement_date);

drop trigger if exists source_settle_hist_touch on public.source_settlement_history;
create trigger source_settle_hist_touch
  before update on public.source_settlement_history
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- 3. replace_returns_history_window -- STANDALONE atomic replace of ONLY the returns window for one account
--    (delete + insert by exact account / return_date window). p_return_rows is REQUIRED (a non-null array; an EMPTY
--    [] legitimately clears the window). Validates every row fail-closed BEFORE any mutation.
-- ---------------------------------------------------------------------------
create or replace function public.replace_returns_history_window(
  p_organization_fingerprint text,
  p_connection_id text,
  p_account_id text,
  p_covered_from date,
  p_covered_to date,
  p_return_rows jsonb
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
    raise exception 'replace_returns_history_window: blank organization fingerprint';
  end if;
  if p_connection_id is null or p_connection_id not in ('primary', 'dd-secondary') then
    raise exception 'replace_returns_history_window: invalid connection id';
  end if;
  if p_account_id is null or char_length(btrim(p_account_id)) = 0 then
    raise exception 'replace_returns_history_window: blank account id';
  end if;
  if p_covered_from is null or p_covered_to is null or p_covered_from > p_covered_to then
    raise exception 'replace_returns_history_window: invalid coverage window';
  end if;
  if p_return_rows is null or jsonb_typeof(p_return_rows) <> 'array' then
    raise exception 'replace_returns_history_window: p_return_rows must be a jsonb array';
  end if;

  -- Validate EVERY row fail-closed BEFORE any mutation: nonblank seller + hash, in-window return_date, positive count,
  -- non-negative FBM money.
  for v_row in select * from jsonb_array_elements(p_return_rows) loop
    if coalesce(btrim(v_row->>'seller_or_vendor_id'), '') = ''
      or coalesce(v_row->>'return_date', '') = ''
      or (v_row->>'return_date')::date < p_covered_from
      or (v_row->>'return_date')::date > p_covered_to
      or (v_row->>'return_count') is null or (v_row->>'return_count')::integer <= 0
      or coalesce((v_row->>'fbm_refunded_amount')::numeric, 0) < 0
      or coalesce((v_row->>'fbm_seller_label_cost')::numeric, 0) < 0
      or coalesce(btrim(v_row->>'source_request_hash'), '') = '' then
      raise exception 'replace_returns_history_window: malformed return row; refusing the whole window';
    end if;
  end loop;

  delete from public.source_returns_history
    where organization_fingerprint = p_organization_fingerprint
      and connection_id = p_connection_id
      and account_id = p_account_id
      and return_date between p_covered_from and p_covered_to;
  get diagnostics v_deleted = row_count;

  insert into public.source_returns_history (
    organization_fingerprint, connection_id, account_id, seller_or_vendor_id, marketplace_country_code,
    return_date, sku, child_asin, amazon_return_reason, fulfillment_channel, request_status, label_payer,
    detailed_disposition, return_count, fbm_refunded_amount, fbm_seller_label_cost, cogs_total_value,
    source_request_hash, refreshed_at, calculated_at
  )
  select
    p_organization_fingerprint, p_connection_id, p_account_id,
    max(btrim(e->>'seller_or_vendor_id')),
    coalesce(max(e->>'marketplace_country_code'), ''),
    (e->>'return_date')::date,
    coalesce(e->>'sku', ''),
    coalesce(e->>'child_asin', ''),
    coalesce(e->>'amazon_return_reason', ''),
    coalesce(e->>'fulfillment_channel', ''),
    coalesce(e->>'request_status', ''),
    coalesce(e->>'label_payer', ''),
    coalesce(max(e->>'detailed_disposition'), ''),
    sum((e->>'return_count')::integer),
    coalesce(sum((e->>'fbm_refunded_amount')::numeric), 0),
    coalesce(sum((e->>'fbm_seller_label_cost')::numeric), 0),
    coalesce(sum((e->>'cogs_total_value')::numeric), 0),
    max(e->>'source_request_hash'),
    max((e->>'refreshed_at')::timestamptz),
    coalesce(max((e->>'calculated_at')::timestamptz), now())
  from jsonb_array_elements(p_return_rows) as e
  group by (e->>'return_date')::date, coalesce(e->>'sku', ''), coalesce(e->>'child_asin', ''),
    coalesce(e->>'amazon_return_reason', ''), coalesce(e->>'fulfillment_channel', ''),
    coalesce(e->>'request_status', ''), coalesce(e->>'label_payer', '');
  get diagnostics v_inserted = row_count;

  return jsonb_build_object('returnsReplaced', v_deleted, 'returnsInserted', v_inserted);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. replace_settlement_history_window -- STANDALONE atomic replace of ONLY the settlement window for one account
--    (delete + insert by exact account / settlement_date window). Rejects blank/invalid currency fail-closed so no
--    money is ever attributed without a currency.
-- ---------------------------------------------------------------------------
create or replace function public.replace_settlement_history_window(
  p_organization_fingerprint text,
  p_connection_id text,
  p_account_id text,
  p_covered_from date,
  p_covered_to date,
  p_settlement_rows jsonb
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
    raise exception 'replace_settlement_history_window: blank organization fingerprint';
  end if;
  if p_connection_id is null or p_connection_id not in ('primary', 'dd-secondary') then
    raise exception 'replace_settlement_history_window: invalid connection id';
  end if;
  if p_account_id is null or char_length(btrim(p_account_id)) = 0 then
    raise exception 'replace_settlement_history_window: blank account id';
  end if;
  if p_covered_from is null or p_covered_to is null or p_covered_from > p_covered_to then
    raise exception 'replace_settlement_history_window: invalid coverage window';
  end if;
  if p_settlement_rows is null or jsonb_typeof(p_settlement_rows) <> 'array' then
    raise exception 'replace_settlement_history_window: p_settlement_rows must be a jsonb array';
  end if;

  -- Validate EVERY row fail-closed BEFORE any mutation: nonblank seller + hash, in-window settlement_date, a valid
  -- 3-letter currency, and a known settlement_type.
  for v_row in select * from jsonb_array_elements(p_settlement_rows) loop
    if coalesce(btrim(v_row->>'seller_or_vendor_id'), '') = ''
      or coalesce(v_row->>'settlement_date', '') = ''
      or (v_row->>'settlement_date')::date < p_covered_from
      or (v_row->>'settlement_date')::date > p_covered_to
      or coalesce(v_row->>'currency', '') !~ '^[A-Z]{3}$'
      or coalesce(v_row->>'settlement_type', '') not in ('ORDER', 'REFUND', 'OTHER')
      or coalesce(btrim(v_row->>'source_request_hash'), '') = '' then
      raise exception 'replace_settlement_history_window: malformed settlement row; refusing the whole window';
    end if;
  end loop;

  delete from public.source_settlement_history
    where organization_fingerprint = p_organization_fingerprint
      and connection_id = p_connection_id
      and account_id = p_account_id
      and settlement_date between p_covered_from and p_covered_to;
  get diagnostics v_deleted = row_count;

  insert into public.source_settlement_history (
    organization_fingerprint, connection_id, account_id, seller_or_vendor_id, marketplace_country_code,
    settlement_date, sku, child_asin, currency, settlement_type,
    quantity, item_price, refunded_amount, refund_tax, refunded_referral_fee, refund_commission,
    refund_restocking_fee, fba_customer_return_per_unit_fee, fba_customer_return_fee, customer_return_hrr_unit_fee,
    cogs_total_value, refund_event_count, source_request_hash, refreshed_at, calculated_at
  )
  select
    p_organization_fingerprint, p_connection_id, p_account_id,
    max(btrim(e->>'seller_or_vendor_id')),
    coalesce(max(e->>'marketplace_country_code'), ''),
    (e->>'settlement_date')::date,
    coalesce(e->>'sku', ''),
    coalesce(e->>'child_asin', ''),
    e->>'currency',
    e->>'settlement_type',
    coalesce(sum((e->>'quantity')::numeric), 0),
    coalesce(sum((e->>'item_price')::numeric), 0),
    coalesce(sum((e->>'refunded_amount')::numeric), 0),
    coalesce(sum((e->>'refund_tax')::numeric), 0),
    coalesce(sum((e->>'refunded_referral_fee')::numeric), 0),
    coalesce(sum((e->>'refund_commission')::numeric), 0),
    coalesce(sum((e->>'refund_restocking_fee')::numeric), 0),
    coalesce(sum((e->>'fba_customer_return_per_unit_fee')::numeric), 0),
    coalesce(sum((e->>'fba_customer_return_fee')::numeric), 0),
    coalesce(sum((e->>'customer_return_hrr_unit_fee')::numeric), 0),
    coalesce(sum((e->>'cogs_total_value')::numeric), 0),
    coalesce(sum((e->>'refund_event_count')::integer), 0),
    max(e->>'source_request_hash'),
    max((e->>'refreshed_at')::timestamptz),
    coalesce(max((e->>'calculated_at')::timestamptz), now())
  from jsonb_array_elements(p_settlement_rows) as e
  group by (e->>'settlement_date')::date, coalesce(e->>'sku', ''), coalesce(e->>'child_asin', ''),
    e->>'currency', e->>'settlement_type';
  get diagnostics v_inserted = row_count;

  return jsonb_build_object('settlementsReplaced', v_deleted, 'settlementsInserted', v_inserted);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. RLS + EXACT LEAST-PRIVILEGE ACLs (mirror source_oli_sales_estimates): service-role-only surface, written ONLY
--    through the SECURITY DEFINER RPCs. REVOKE ALL clears PostgreSQL 17's MAINTAIN. No policy, no anon/authenticated.
-- ---------------------------------------------------------------------------
alter table public.source_returns_history enable row level security;
revoke all on table public.source_returns_history from public, anon, authenticated, service_role;
grant select on table public.source_returns_history to service_role;

alter table public.source_settlement_history enable row level security;
revoke all on table public.source_settlement_history from public, anon, authenticated, service_role;
grant select on table public.source_settlement_history to service_role;

revoke all on function public.replace_returns_history_window(text, text, text, date, date, jsonb) from public, anon, authenticated;
grant execute on function public.replace_returns_history_window(text, text, text, date, date, jsonb) to service_role;

revoke all on function public.replace_settlement_history_window(text, text, text, date, date, jsonb) from public, anon, authenticated;
grant execute on function public.replace_settlement_history_window(text, text, text, date, date, jsonb) to service_role;
