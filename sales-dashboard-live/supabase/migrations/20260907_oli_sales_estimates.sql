-- ===========================================================================
-- Scheduler v2 -- OLI SALES ESTIMATES: fill missing/zero-price sales from same-product historical prices (Migration 17)
-- ===========================================================================
--
-- >>> PREPARED. Apply forward via the tracked db:migrate runner (public.app_schema_migrations); it edits no prior
-- >>> migration. ADDITIVE + IDEMPOTENT: adds ONE table and ONE standalone atomic replace RPC. Repeated execution is safe.
--
-- WHY: source_oli_daily_history (the priced rollup every dashboard reads) counts ONLY non-cancelled units with a
-- present, strictly-positive item_price_value. Non-cancelled units whose item_price_value is MISSING (pending
-- itemization) or ZERO carry real sales DataDoe has not itemized yet -- they live in source_oli_operational_units as
-- explicit_zero_units + pending_units. This ADDITIVE, INTERNAL audit layer stores an ESTIMATE of those units' sales,
-- computed from a valid historical unit price for the SAME product (same account/seller/marketplace/currency/ASIN,
-- and same SKU unless the target SKU is blank), within a 7-day backward look-back. It NEVER modifies the raw OLI
-- evidence (dimensional / rollup / operational / order-audit are untouched). The estimate covers EXACTLY the still-
-- unpriced quantity, so when DataDoe itemizes on the normal 7-day refresh the actual value automatically supersedes
-- it with zero double-counting (priced_units grows -> the missing quantity shrinks -> the estimate shrinks; fully
-- itemized -> the estimate row is deleted by the window replace).
--
-- The estimate is a pure function of the current durable truth (operational units + dimensional references), so a
-- replay writes byte-identical rows. No DataDoe export, no token: it is recomputed from already-fetched evidence.

-- ---------------------------------------------------------------------------
-- 1. source_oli_sales_estimates -- one estimate per (account, sale_date, sku, child_asin, currency) grain (the SAME
--    grain as source_oli_daily_history / source_oli_operational_units, so it reconciles 1:1 with the rollup). Only
--    grains with unresolved missing units AND a trustworthy reference get a row; genuinely-unresolved grains get NONE
--    (they remain in the operational-units missing-value breakdown). Every amount is non-negative; provenance is full.
-- ---------------------------------------------------------------------------
create table if not exists public.source_oli_sales_estimates (
  organization_fingerprint text not null,
  connection_id text not null default 'primary'
    constraint source_oli_est_connection_id_check check (connection_id in ('primary', 'dd-secondary')),
  account_id text not null
    constraint source_oli_est_account_nonblank check (char_length(btrim(account_id)) > 0),
  seller_or_vendor_id text not null
    constraint source_oli_est_seller_nonblank check (char_length(btrim(seller_or_vendor_id)) > 0),
  sale_date date not null,
  sku text not null,
  child_asin text not null,
  currency text not null
    constraint source_oli_est_currency_check check (currency ~ '^[A-Z]{3}$'),
  target_quantity numeric not null
    constraint source_oli_est_qty_pos check (target_quantity > 0),
  estimated_sales numeric not null
    constraint source_oli_est_sales_nonneg check (estimated_sales >= 0),
  reference_date date not null
    constraint source_oli_est_refdate_not_future check (reference_date <= sale_date),
  reference_unit_price numeric not null
    constraint source_oli_est_unit_price_pos check (reference_unit_price > 0),
  matching_method text not null
    constraint source_oli_est_method_check check (matching_method in ('sku-exact', 'asin-fallback')),
  reference_source_request_hash text not null default '',
  target_source_request_hash text not null default '',
  calculated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint source_oli_est_pk
    primary key (organization_fingerprint, connection_id, account_id, sale_date, sku, child_asin, currency)
);

create index if not exists source_oli_est_account_date_idx
  on public.source_oli_sales_estimates (account_id, sale_date);
create index if not exists source_oli_est_org_date_idx
  on public.source_oli_sales_estimates (organization_fingerprint, sale_date);

drop trigger if exists source_oli_est_touch on public.source_oli_sales_estimates;
create trigger source_oli_est_touch
  before update on public.source_oli_sales_estimates
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- 2. replace_oli_sales_estimates_window -- a STANDALONE atomic replace of ONLY the estimate window for one account
--    (delete + insert by exact account/window). Recomputed from durable truth after every OLI persist and by the
--    zero-token backfill. p_estimate_rows is REQUIRED (a non-null array; an EMPTY [] legitimately clears the window
--    once every grain resolves). Validates every row fail-closed BEFORE any mutation, so a bad payload preserves LKG.
-- ---------------------------------------------------------------------------
create or replace function public.replace_oli_sales_estimates_window(
  p_organization_fingerprint text,
  p_connection_id text,
  p_account_id text,
  p_covered_from date,
  p_covered_to date,
  p_estimate_rows jsonb
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
    raise exception 'replace_oli_sales_estimates_window: blank organization fingerprint';
  end if;
  if p_connection_id is null or p_connection_id not in ('primary', 'dd-secondary') then
    raise exception 'replace_oli_sales_estimates_window: invalid connection id';
  end if;
  if p_account_id is null or char_length(btrim(p_account_id)) = 0 then
    raise exception 'replace_oli_sales_estimates_window: blank account id';
  end if;
  if p_covered_from is null or p_covered_to is null or p_covered_from > p_covered_to then
    raise exception 'replace_oli_sales_estimates_window: invalid coverage window';
  end if;
  if p_estimate_rows is null or jsonb_typeof(p_estimate_rows) <> 'array' then
    raise exception 'replace_oli_sales_estimates_window: p_estimate_rows must be a jsonb array';
  end if;

  -- Validate EVERY row fail-closed BEFORE any mutation: canonical grain, in-window sale_date, non-future reference,
  -- positive quantity + unit price, non-negative estimate, known method.
  for v_row in select * from jsonb_array_elements(p_estimate_rows) loop
    if coalesce(btrim(v_row->>'seller_or_vendor_id'), '') = ''
      or coalesce(v_row->>'sale_date', '') = ''
      or (v_row->>'sale_date')::date < p_covered_from
      or (v_row->>'sale_date')::date > p_covered_to
      or coalesce(v_row->>'currency', '') !~ '^[A-Z]{3}$'
      or coalesce(v_row->>'reference_date', '') = ''
      or (v_row->>'reference_date')::date > (v_row->>'sale_date')::date
      or (v_row->>'target_quantity') is null or (v_row->>'target_quantity')::numeric <= 0
      or (v_row->>'estimated_sales') is null or (v_row->>'estimated_sales')::numeric < 0
      or (v_row->>'reference_unit_price') is null or (v_row->>'reference_unit_price')::numeric <= 0
      or coalesce(v_row->>'matching_method', '') not in ('sku-exact', 'asin-fallback') then
      raise exception 'replace_oli_sales_estimates_window: malformed estimate row; refusing the whole window';
    end if;
  end loop;

  delete from public.source_oli_sales_estimates
    where organization_fingerprint = p_organization_fingerprint
      and connection_id = p_connection_id
      and account_id = p_account_id
      and sale_date between p_covered_from and p_covered_to;
  get diagnostics v_deleted = row_count;

  insert into public.source_oli_sales_estimates (
    organization_fingerprint, connection_id, account_id, seller_or_vendor_id,
    sale_date, sku, child_asin, currency,
    target_quantity, estimated_sales, reference_date, reference_unit_price,
    matching_method, reference_source_request_hash, target_source_request_hash, calculated_at
  )
  select
    p_organization_fingerprint, p_connection_id, p_account_id,
    max(btrim(e->>'seller_or_vendor_id')),
    (e->>'sale_date')::date,
    coalesce(e->>'sku', ''),
    coalesce(e->>'child_asin', ''),
    e->>'currency',
    max((e->>'target_quantity')::numeric),
    max((e->>'estimated_sales')::numeric),
    max((e->>'reference_date')::date),
    max((e->>'reference_unit_price')::numeric),
    max(e->>'matching_method'),
    coalesce(max(e->>'reference_source_request_hash'), ''),
    coalesce(max(e->>'target_source_request_hash'), ''),
    coalesce(max((e->>'calculated_at')::timestamptz), now())
  from jsonb_array_elements(p_estimate_rows) as e
  group by (e->>'sale_date')::date, coalesce(e->>'sku', ''), coalesce(e->>'child_asin', ''), e->>'currency';
  get diagnostics v_inserted = row_count;

  return jsonb_build_object('estimatesReplaced', v_deleted, 'estimatesInserted', v_inserted);
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. RLS + EXACT LEAST-PRIVILEGE ACLs (mirror source_oli_operational_units): service-role-only surface, written ONLY
--    through the SECURITY DEFINER RPC. REVOKE ALL clears PostgreSQL 17's MAINTAIN. No policy, no anon/authenticated.
-- ---------------------------------------------------------------------------
alter table public.source_oli_sales_estimates enable row level security;

revoke all on table public.source_oli_sales_estimates from public, anon, authenticated, service_role;
grant select on table public.source_oli_sales_estimates to service_role;

revoke all on function public.replace_oli_sales_estimates_window(text, text, text, date, date, jsonb) from public, anon, authenticated;
grant execute on function public.replace_oli_sales_estimates_window(text, text, text, date, date, jsonb) to service_role;
