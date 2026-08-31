-- ===========================================================================
-- Scheduler v2 -- OLI SALES ESTIMATES: server-side SKU -> child_asin RESOLUTION (Migration 20)
-- ===========================================================================
--
-- >>> ADDITIVE + IDEMPOTENT + READ-ONLY. Apply forward via the tracked db:migrate runner
-- >>> (public.app_schema_migrations); it edits NO prior migration and adds NO table, column, constraint, trigger,
-- >>> or write path. It adds ONE read-only SECURITY DEFINER function. Repeated execution is safe (create or replace).
--
-- WHY: pending-itemization OLI units frequently carry a SKU but a BLANK child_asin (Amazon populates the per-line
-- item detail -- item_status / child_asin / item_price_value -- ~1-2 days AFTER the order is placed). The internal
-- sales estimator matches a reference price at the (account, seller, marketplace, currency, ASIN, SKU) grain, so a
-- target with a blank child_asin can never match a priced reference (which always carries a real ASIN) -- those
-- units returned "no-reference" and their sales stayed unestimated. This function resolves the missing child_asin
-- SERVER-SIDE from the durable, already-fetched dimensional history under the EXACT isolation boundary
-- (organization + connection + account + seller + currency + SKU), accepting ONLY a UNIQUE non-blank ASIN across
-- ALL eligible non-cancelled history. It NEVER crosses account/seller/currency, NEVER invents an ASIN, and returns
-- an ambiguous SKU (more than one distinct non-blank ASIN) so the caller can leave it unresolved (fail closed).
--
-- It reads the SAME service-role-only source_oli_dimensional_history the estimator already reads; the raw OLI
-- evidence is never modified. Marketplace is NOT a column of the dimensional grain (OLI is fetched in
-- multi-marketplace batches); the estimator binds the account's AUTHORITATIVE, reconciliation-proven canonical
-- marketplace, and currency here is a strict additional isolation key (EUR marketplaces never share a resolution).
-- The aggregation runs entirely in the database (source_oli_dimensional_history is ~465k rows) and returns only the
-- compact per-account (seller, currency, sku) resolution set (a few hundred rows), so no raw history is ever paged
-- into the application for this.

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
stable
as $$
  select
    seller_or_vendor_id,
    currency,
    sku,
    count(distinct child_asin) filter (where btrim(child_asin) <> '')::int as asin_count,
    -- The single non-blank ASIN when unique; when ambiguous (asin_count > 1) the caller MUST discard this value
    -- and leave the SKU unresolved. max() is deterministic and only meaningful at asin_count = 1.
    max(child_asin) filter (where btrim(child_asin) <> '') as child_asin
  from public.source_oli_dimensional_history
  where organization_fingerprint = p_organization_fingerprint
    and connection_id = p_connection_id
    and account_id = p_account_id
    and is_cancelled = false            -- cancelled history never contributes an identity
    and char_length(btrim(sku)) > 0     -- only rows with a canonical SKU can resolve a SKU
  group by seller_or_vendor_id, currency, sku
  having count(distinct child_asin) filter (where btrim(child_asin) <> '') >= 1;  -- at least one real ASIN to offer
$$;

-- Least-privilege: the function reads a service-role-only table under SECURITY DEFINER, so only service_role may
-- execute it. REVOKE ALL clears the default PUBLIC execute grant.
revoke all on function public.resolve_oli_sku_asin(text, text, text) from public, anon, authenticated;
grant execute on function public.resolve_oli_sku_asin(text, text, text) to service_role;
