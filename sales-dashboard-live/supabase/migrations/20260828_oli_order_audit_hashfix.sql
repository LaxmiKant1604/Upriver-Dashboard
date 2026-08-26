-- Scheduler v2 -- HASHFIX for the 20260827 order-audit RPC (forward-only; additive; NO data change).
--
-- The order-audit INSERT's md5(concat_ws(...)) surrogate key referenced (o->>'sale_date') as TEXT while the same
-- SELECT's GROUP BY grouped on (o->>'sale_date')::date -- an ungrouped column reference that raises SQLSTATE 42803
-- at RUNTIME the first time a non-empty p_order_rows is persisted (caught by a rolled-back end-to-end check BEFORE
-- any real sync ran; source_oli_order_audit was still EMPTY). This CREATE OR REPLACE changes ONLY that md5 date
-- argument to (o->>'sale_date')::date so it matches the GROUP BY. Same 8-arg signature; the dimensional / rollup /
-- coverage / order-audit behaviour is otherwise byte-identical to 20260827. No table/column/constraint/index change.

create or replace function public.replace_oli_dimensional_window(
  p_organization_fingerprint text,
  p_connection_id text,
  p_account_id text,
  p_covered_from date,
  p_covered_to date,
  p_rows jsonb,
  p_source_refreshed_at timestamptz default now(),
  p_order_rows jsonb default '[]'::jsonb
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

  -- (b) ROLLUP replace (UNCHANGED).
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

  -- (c) ORDER-AUDIT replace (NEW): the SAME account/window, at order-level grain WITH amazon_order_id. Aggregated by
  --     the deterministic order-level identity so a duplicate p_order_row can never break the PK; the md5 surrogate
  --     key includes a blank ('') Order ID so distinct grains stay distinct and a missing ID never merges rows.
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

  -- (d) The coverage ACKNOWLEDGEMENT commits in the SAME transaction (UNCHANGED).
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
    'orderAuditReplaced', v_audit_deleted, 'orderAuditInserted', v_audit_inserted
  );
end;
$$;

revoke all on function public.replace_oli_dimensional_window(text, text, text, date, date, jsonb, timestamptz, jsonb) from public, anon, authenticated;
grant execute on function public.replace_oli_dimensional_window(text, text, text, date, date, jsonb, timestamptz, jsonb) to service_role;
