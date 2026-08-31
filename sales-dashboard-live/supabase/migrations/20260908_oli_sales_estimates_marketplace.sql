-- ===========================================================================
-- Scheduler v2 -- OLI SALES ESTIMATES: durable MARKETPLACE isolation (Migration 18)
-- ===========================================================================
--
-- >>> PREPARED. Apply forward via the tracked db:migrate runner (public.app_schema_migrations); it edits no prior
-- >>> migration. Repeated execution is safe.
--
-- WHY: account + currency do NOT identify a marketplace (BE/DE/ES/FR/IT/NL all use EUR), so a same-seller,
-- same-ASIN/SKU EUR reference from another country could theoretically have been used. The estimate matching key +
-- provenance must carry the canonical marketplace, and it must be part of the estimate grain so a grain in one
-- marketplace can never be confused with the same product in another. source_oli_sales_estimates is a DERIVED
-- cache (recomputed from durable truth by replace_oli_sales_estimates_window after every OLI persist + the
-- zero-token backfill), so it is dropped + recreated with marketplace_country_code added to the grain/PK; the
-- recompute/backfill repopulates it. No raw evidence is touched.
--
-- marketplace_country_code is CANONICAL (UK -> GB done upstream in the estimator/backfill) and REQUIRED to be
-- nonblank: the estimator only writes an estimate when the account's authoritative marketplace is known, so a blank
-- marketplace can never reach this table (an account with no authoritative marketplace stays unresolved, never
-- estimated -- fail closed).

drop table if exists public.source_oli_sales_estimates;

create table public.source_oli_sales_estimates (
  organization_fingerprint text not null,
  connection_id text not null default 'primary'
    constraint source_oli_est_connection_id_check check (connection_id in ('primary', 'dd-secondary')),
  account_id text not null
    constraint source_oli_est_account_nonblank check (char_length(btrim(account_id)) > 0),
  seller_or_vendor_id text not null
    constraint source_oli_est_seller_nonblank check (char_length(btrim(seller_or_vendor_id)) > 0),
  marketplace_country_code text not null
    constraint source_oli_est_marketplace_nonblank check (char_length(btrim(marketplace_country_code)) > 0),
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
  -- marketplace_country_code is part of the PK: a grain is isolated PER MARKETPLACE, so the same
  -- account/date/sku/ASIN/currency in two marketplaces can never collapse into one estimate row.
  constraint source_oli_est_pk
    primary key (organization_fingerprint, connection_id, account_id, marketplace_country_code, sale_date, sku, child_asin, currency)
);

create index if not exists source_oli_est_account_date_idx
  on public.source_oli_sales_estimates (account_id, sale_date);
create index if not exists source_oli_est_org_date_idx
  on public.source_oli_sales_estimates (organization_fingerprint, sale_date);

drop trigger if exists source_oli_est_touch on public.source_oli_sales_estimates;
create trigger source_oli_est_touch
  before update on public.source_oli_sales_estimates
  for each row execute function public.touch_updated_at();

-- Redefine the atomic replace to carry marketplace_country_code (validated nonblank + canonical) through the grain.
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
  -- positive quantity + unit price, non-negative estimate, known method, and a NONBLANK CANONICAL marketplace.
  for v_row in select * from jsonb_array_elements(p_estimate_rows) loop
    if coalesce(btrim(v_row->>'seller_or_vendor_id'), '') = ''
      or coalesce(btrim(v_row->>'marketplace_country_code'), '') = ''
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
    organization_fingerprint, connection_id, account_id, seller_or_vendor_id, marketplace_country_code,
    sale_date, sku, child_asin, currency,
    target_quantity, estimated_sales, reference_date, reference_unit_price,
    matching_method, reference_source_request_hash, target_source_request_hash, calculated_at
  )
  select
    p_organization_fingerprint, p_connection_id, p_account_id,
    max(btrim(e->>'seller_or_vendor_id')),
    btrim(e->>'marketplace_country_code'),
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
  group by btrim(e->>'marketplace_country_code'), (e->>'sale_date')::date, coalesce(e->>'sku', ''), coalesce(e->>'child_asin', ''), e->>'currency';
  get diagnostics v_inserted = row_count;

  return jsonb_build_object('estimatesReplaced', v_deleted, 'estimatesInserted', v_inserted);
end;
$$;

-- RLS + EXACT LEAST-PRIVILEGE ACLs (mirror the prior definition).
alter table public.source_oli_sales_estimates enable row level security;

revoke all on table public.source_oli_sales_estimates from public, anon, authenticated, service_role;
grant select on table public.source_oli_sales_estimates to service_role;

revoke all on function public.replace_oli_sales_estimates_window(text, text, text, date, date, jsonb) from public, anon, authenticated;
grant execute on function public.replace_oli_sales_estimates_window(text, text, text, date, date, jsonb) to service_role;
