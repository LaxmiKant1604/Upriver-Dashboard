-- ===========================================================================
-- Scheduler v2 -- OLI SKU->ASIN RESOLUTION: covering index + statement-timeout guard (Migration 21)
-- ===========================================================================
--
-- >>> ADDITIVE + IDEMPOTENT + READ-ONLY. Apply forward via the tracked db:migrate runner; it edits no prior
-- >>> migration and adds NO table/column/constraint/write path. Repeated execution is safe.
--
-- WHY: resolve_oli_sku_asin (20260910) groups ALL non-cancelled dimensional history per account by
-- (seller_or_vendor_id, currency, sku) with count(distinct child_asin). For the largest account (~155k rows) the
-- planner had to Sort 155k rows to disk (external merge) before the GroupAggregate -- ~1.7s directly, and OVER the
-- PostgREST statement_timeout when called through the REST RPC (the resolver's production path), so it failed with
-- "canceling statement due to statement timeout". This migration:
--   (1) adds a covering PARTIAL index that presents the rows ALREADY in group order (org, connection, account,
--       seller, currency, sku, child_asin) WHERE is_cancelled = false, so the RPC runs an Index-Only Scan +
--       GroupAggregate with NO sort (the distinct child_asin per group dedupes adjacent index tuples). This turns a
--       ~1.7s disk-sort into a sub-100ms grouped scan, well within any statement_timeout.
--   (2) pins statement_timeout = 30s on the function itself as a belt-and-suspenders margin (the function's own
--       execution is capped; it never inherits an over-short role timeout mid-aggregation).
-- No raw OLI evidence, grain, or write path is touched.

-- (1) Covering partial index in GROUP-BY order (non-cancelled only) -- eliminates the external-merge sort.
create index if not exists source_oli_dim_history_sku_asin_resolution_idx
  on public.source_oli_dimensional_history
     (organization_fingerprint, connection_id, account_id, seller_or_vendor_id, currency, sku, child_asin)
  where is_cancelled = false;

-- (2) Re-declare the resolver identically to 20260910 but with a pinned per-function statement_timeout (safety
--     margin). Body, isolation, grouping, HAVING, and least-privilege are byte-for-byte the same.
create or replace function public.resolve_oli_sku_asin(
  p_organization_fingerprint text,
  p_connection_id text,
  p_account_id text
) returns table (
  seller_or_vendor_id text,
  currency text,
  sku text,
  asin_count integer,
  child_asin text
)
language sql
security definer
set search_path = public
set statement_timeout to '30s'
stable
as $$
  select
    seller_or_vendor_id,
    currency,
    sku,
    count(distinct child_asin) filter (where btrim(child_asin) <> '')::int as asin_count,
    max(child_asin) filter (where btrim(child_asin) <> '') as child_asin
  from public.source_oli_dimensional_history
  where organization_fingerprint = p_organization_fingerprint
    and connection_id = p_connection_id
    and account_id = p_account_id
    and is_cancelled = false
    and char_length(btrim(sku)) > 0
  group by seller_or_vendor_id, currency, sku
  having count(distinct child_asin) filter (where btrim(child_asin) <> '') >= 1;
$$;

revoke all on function public.resolve_oli_sku_asin(text, text, text) from public, anon, authenticated;
grant execute on function public.resolve_oli_sku_asin(text, text, text) to service_role;
