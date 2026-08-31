-- ===========================================================================
-- Scheduler v2 -- OLI SALES ESTIMATES: canonical MARKETPLACE enforcement (Migration 19)
-- ===========================================================================
--
-- >>> ADDITIVE + IDEMPOTENT. Apply forward via the tracked db:migrate runner (public.app_schema_migrations); it
-- >>> edits NO prior migration (20260908 is untouched). Repeated execution is safe.
--
-- WHY: 20260908 put marketplace_country_code in the estimate grain/PK and required it nonblank. This migration makes
-- the stored value CANONICAL and fail-closed at the DATABASE, so a non-canonical marketplace can never be persisted
-- even by a future/buggy caller:
--   * marketplace_country_code must be TRIMMED and UPPERCASE (no padding, no lowercase);
--   * it must be exactly two A-Z letters (a real marketplace/country code);
--   * 'UK' must NEVER be stored -- the canonical marketplace is 'GB' (normalized upstream in the estimator).
-- Enforced two ways: (1) a CHECK constraint on the column (durable guard on every write); (2) the atomic replace RPC
-- rejects blank/lowercase/whitespace-padded/UK/malformed marketplace values BEFORE any delete/insert, so one
-- malformed row causes ZERO mutation (the whole window is refused, exactly like the existing row validation).
--
-- Existing production estimate rows are IN/US (already canonical), so the CHECK constraint validates with no
-- rewrite. The marketplace-inclusive PK, RLS, least-privilege grants, security-definer, and atomic window
-- replacement from 20260908 are all preserved. No raw OLI evidence is touched.

-- (1) Durable column-level canonical guard (idempotent: drop + add).
alter table public.source_oli_sales_estimates
  drop constraint if exists source_oli_est_marketplace_canonical;
alter table public.source_oli_sales_estimates
  add constraint source_oli_est_marketplace_canonical
  check (
    marketplace_country_code = upper(btrim(marketplace_country_code)) -- trimmed AND uppercase (no padding/lowercase)
    and marketplace_country_code ~ '^[A-Z]{2}$'                       -- exactly two A-Z letters
    and marketplace_country_code <> 'UK'                              -- canonical GB only; UK is never stored
  );

-- (2) Redefine the atomic replace to ALSO reject a non-canonical marketplace fail-closed before any mutation.
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
  v_mkt text;
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
  -- positive quantity + unit price, non-negative estimate, known method, and a CANONICAL marketplace (nonblank,
  -- trimmed, uppercase, exactly two A-Z letters, never 'UK'). One malformed row => zero mutation.
  for v_row in select * from jsonb_array_elements(p_estimate_rows) loop
    v_mkt := coalesce(v_row->>'marketplace_country_code', '');
    if coalesce(btrim(v_row->>'seller_or_vendor_id'), '') = ''
      or btrim(v_mkt) = ''
      or v_mkt <> upper(btrim(v_mkt))          -- reject lowercase or whitespace-padded
      or upper(btrim(v_mkt)) = 'UK'            -- reject UK (canonical is GB)
      or upper(btrim(v_mkt)) !~ '^[A-Z]{2}$'   -- reject malformed (not exactly two A-Z letters)
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
    upper(btrim(e->>'marketplace_country_code')), -- store the CANONICAL marketplace (validated above)
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
  group by upper(btrim(e->>'marketplace_country_code')), (e->>'sale_date')::date, coalesce(e->>'sku', ''), coalesce(e->>'child_asin', ''), e->>'currency';
  get diagnostics v_inserted = row_count;

  return jsonb_build_object('estimatesReplaced', v_deleted, 'estimatesInserted', v_inserted);
end;
$$;

-- Preserve RLS + EXACT least-privilege ACLs (idempotent re-assert; mirror 20260908).
alter table public.source_oli_sales_estimates enable row level security;

revoke all on table public.source_oli_sales_estimates from public, anon, authenticated, service_role;
grant select on table public.source_oli_sales_estimates to service_role;

revoke all on function public.replace_oli_sales_estimates_window(text, text, text, date, date, jsonb) from public, anon, authenticated;
grant execute on function public.replace_oli_sales_estimates_window(text, text, text, date, date, jsonb) to service_role;
