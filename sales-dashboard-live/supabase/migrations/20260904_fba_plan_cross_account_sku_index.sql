-- ===========================================================================
-- FBA Shipment Plan -- index for cross-account SKU-ownership lookups (Migration 19)
-- ===========================================================================
--
-- Apply forward via the tracked db:migrate runner (public.app_schema_migrations); it edits no prior migration.
-- ADDITIVE + IDEMPOTENT: adds ONE index. Changes no table, no data, no RLS.
--
-- WHY: trusted server-side warehouse-write validation must reject a "new manual SKU" that is already proven under
-- ANOTHER account (lib/server/supabase.js#getSkusOwnedByOtherAccounts queries source_oli_daily_history by
-- organization_fingerprint + sku, excluding the writing account). The existing index is (account_id, sale_date), so a
-- by-SKU lookup would scan; this composite index makes the ownership check a cheap indexed probe.
--
-- Safe to apply any time (concurrent-safe create is avoided so it runs inside the migration transaction like the rest).

create index if not exists source_oli_daily_history_org_sku_idx
  on public.source_oli_daily_history (organization_fingerprint, sku);
