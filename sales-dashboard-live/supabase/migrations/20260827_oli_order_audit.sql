-- Scheduler v2 -- FUTURE-ONLY Amazon Order ID capture (additive; NO historical re-export, NO backfill).
--
-- Starting with the first OLI sync after this migration, the OLI export ALSO requests amazon_order_id (proven
-- present in the source schema). The dimensional business grain (source_oli_dimensional_history) and the rollup
-- (source_oli_daily_history) STAY BYTE-IDENTICAL: amazon_order_id is folded AWAY for both -- the persister passes the
-- SAME folded p_rows to the existing dimensional/rollup inserts. amazon_order_id is carried in a SEPARATE array
-- (p_order_rows) and written to a NEW order-level audit table in the SAME transaction, so Order IDs are persisted
-- atomically with the OLI evidence and a commit-unknown can never report success while leaving them absent.
--
-- Order-level natural identity (deterministic surrogate md5 key): account + sale_date + canonical amazon_order_id +
-- seller + sku + child_asin + currency + order status + fulfilment channel + state + city. A blank Order ID is
-- NEVER used as a valid identity -- it is stored as '' with order_id_available=false and hashed with the rest of the
-- grain, so distinct grains never merge and a missing ID never masquerades as a real one. address_country and
-- amazon_order_id are never joined into the business grain.
--
-- Apply forward via the tracked db:migrate runner (public.app_schema_migrations); it edits no prior migration.

-- ---------------------------------------------------------------------------
-- (1) The order-level audit table.
-- ---------------------------------------------------------------------------
create table if not exists public.source_oli_order_audit (
  organization_fingerprint text not null,
  connection_id text not null default 'primary'
    constraint source_oli_order_audit_connection_id_check check (connection_id in ('primary', 'dd-secondary')),
  account_id text not null
    constraint source_oli_order_audit_account_nonblank check (char_length(btrim(account_id)) > 0),
  order_grain_hash text not null
    constraint source_oli_order_audit_hash_len check (char_length(order_grain_hash) = 32),
  seller_or_vendor_id text not null
    constraint source_oli_order_audit_seller_nonblank check (char_length(btrim(seller_or_vendor_id)) > 0),
  sale_date date not null,
  amazon_order_id text not null default '',
  order_id_available boolean not null,
  sku text not null,
  child_asin text not null,
  currency text not null
    constraint source_oli_order_audit_currency_check check (currency ~ '^[A-Z]{3}$'),
  amazon_order_status text not null
    constraint source_oli_order_audit_status_nonblank check (char_length(btrim(amazon_order_status)) > 0),
  status_normalized text not null,
  is_cancelled boolean not null,
  fulfillment_channel text not null default '',
  address_state text not null default '',
  address_city text not null default '',
  total_sales_sum numeric,
  total_units_sum numeric not null,
  source_request_hash text not null
    constraint source_oli_order_audit_reqhash_nonblank check (char_length(btrim(source_request_hash)) > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- order_id_available must EXACTLY reflect a non-blank captured Order ID (never fabricated).
  constraint source_oli_order_audit_orderid_available_ck check (order_id_available = (char_length(btrim(amazon_order_id)) > 0)),
  constraint source_oli_order_audit_pk
    primary key (organization_fingerprint, connection_id, account_id, order_grain_hash)
);

drop trigger if exists source_oli_order_audit_touch on public.source_oli_order_audit;
create trigger source_oli_order_audit_touch
  before update on public.source_oli_order_audit
  for each row execute function public.touch_updated_at();

create index if not exists source_oli_order_audit_account_date_idx
  on public.source_oli_order_audit (account_id, sale_date);
create index if not exists source_oli_order_audit_account_order_idx
  on public.source_oli_order_audit (account_id, amazon_order_id) where order_id_available;
create index if not exists source_oli_order_audit_org_date_idx
  on public.source_oli_order_audit (organization_fingerprint, sale_date);

-- ---------------------------------------------------------------------------
-- (2) Replace the persist RPC: SAME dimensional + rollup + coverage (byte-identical), PLUS an atomic order-audit
--     replace from a SEPARATE p_order_rows array. p_order_rows defaults to '[]' so the 7-arg historical callers
--     (oli-dimensional-replacement.mjs) keep working unchanged and write NO order rows.
-- ---------------------------------------------------------------------------
drop function if exists public.replace_oli_dimensional_window(text, text, text, date, date, jsonb, timestamptz);

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
      (o->>'sale_date'),
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

-- ---------------------------------------------------------------------------
-- (3) RLS + EXACT LEAST-PRIVILEGE ACLs (mirror source_oli_dimensional_history): service-role-only, written ONLY
--     through the SECURITY DEFINER RPC. REVOKE ALL clears PostgreSQL 17's MAINTAIN. No policy, no anon/authenticated.
-- ---------------------------------------------------------------------------
alter table public.source_oli_order_audit enable row level security;

revoke all on table public.source_oli_order_audit from public, anon, authenticated, service_role;
grant select on table public.source_oli_order_audit to service_role;

revoke all on function public.replace_oli_dimensional_window(text, text, text, date, date, jsonb, timestamptz, jsonb) from public, anon, authenticated;
grant execute on function public.replace_oli_dimensional_window(text, text, text, date, date, jsonb, timestamptz, jsonb) to service_role;
