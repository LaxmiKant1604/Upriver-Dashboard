-- ===========================================================================
-- P0 convergence -- RECLAIM STALE priority-partial CATALOG jobs (DR1/DR4 self-heal)
-- ===========================================================================
--
-- ADDITIVE + IDEMPOTENT. Adds ONE new RPC. Changes NO existing table/column/
-- constraint/RPC; stores no secret. Backward compatible.
--
-- WHY. The zero-export publication reconciler runs each stale account in its OWN
-- dedicated `priority-partial-<bucket>-<hash>` cycle. Before DR1 durable-catalog
-- adoption shipped (migration 20260928), a cold 24h Catalog export cache left that
-- cycle's org product-catalog job FAILED (the noExport adapter refuses `create`, so
-- the fetch could never succeed -> fetch_status='failed', error SOURCE_READINESS_PENDING
-- or EXPORT_ERROR, export_id NULL, no tokens spent). adopt_durable_catalog_snapshot
-- only adopts a job that is still fetch_status='pending' (the one-attempt invariant),
-- so a job left FAILED by a PRE-fix pass is stuck: the reconciler re-reads it, sees a
-- terminal failure, and fast-defers the whole bucket FOREVER -- even though the durable
-- org Catalog snapshot is VALIDATED and DR1 could adopt it if the job were re-adoptable.
--
-- This RPC RECLAIMS those stale-failed catalog jobs back to a re-adoptable state
-- (pending / unattempted / count=0 / cleared error / no adoption), so the NEXT reconciler
-- pass adopts them from the durable snapshot (DR1) and the bucket converges with ZERO
-- exports. It is the AUDITED, snapshot-gated form of the manual "reset failed catalog jobs
-- to pending" recovery -- never an ad-hoc delete, never a blind reset.
--
-- SAFETY (never enables a double spend, never discards real evidence):
--   * SCOPED to `priority-partial-<bucket>-%` cycles only -- the reconciler's OWN ephemeral
--     per-account cycle namespace. The scheduled full-region cycles are NEVER touched.
--   * Only fetch_status='failed' product-catalog jobs with export_id IS NULL (NO real export
--     was ever created -> zero tokens were spent -> resetting cannot orphan a paid export).
--   * GATED on a VALIDATED durable org Catalog snapshot existing for the job's EXACT
--     (organization_fingerprint, connection_id, source_key='product-catalog',
--     scope_key='__organization') with a content object (object_path + payload_sha). A job
--     with no recovery evidence is left FAILED (never reset into a state that would just
--     re-fail or, worse, attempt a create).
--   * IDEMPOTENT: re-running reclaims nothing once the jobs are pending/succeeded (the
--     fetch_status='failed' predicate no longer matches).
--   * Reversible kill-switch at the call site (DURABLE_CATALOG_ADOPTION=off -> the reconciler
--     never calls this) WITHOUT dropping the migration.

create or replace function public.reclaim_stale_priority_catalog_jobs(p_bucket text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  if coalesce(btrim(p_bucket), '') = '' then
    raise exception 'reclaim_stale_priority_catalog_jobs requires a non-blank bucket';
  end if;

  -- Reset ONLY stale-failed, no-real-export product-catalog jobs in THIS bucket's priority-partial
  -- cycle namespace that HAVE a validated durable org Catalog snapshot to recover from. The JOIN to
  -- source_snapshots is the recovery-evidence gate: a job with no adoptable snapshot is left failed.
  update public.sync_source_jobs j
     set fetch_status = 'pending',
         attempted_at = null,
         create_export_count = 0,
         terminal = false,
         adoption_kind = null,
         export_id = null,
         error_stage = null,
         error_code = null,
         error_message = null,
         updated_at = now()
    from public.sync_cycles c,
         public.source_snapshots s
   where j.cycle_id = c.id
     and c.bucket like 'priority-partial-' || p_bucket || '-%'
     and j.source_key = 'product-catalog'
     and j.fetch_status = 'failed'
     and j.export_id is null
     and s.organization_fingerprint = j.organization_fingerprint
     and s.connection_id = j.connection_id
     and s.source_key = 'product-catalog'
     and s.scope_key = '__organization'
     and s.validated_at is not null
     and coalesce(btrim(s.object_path), '') <> ''
     and coalesce(btrim(s.payload_sha), '') <> '';

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Least privilege: service_role only; never callable by the browser (anon/authenticated) or public.
revoke all on function public.reclaim_stale_priority_catalog_jobs(text) from public, anon, authenticated;
grant execute on function public.reclaim_stale_priority_catalog_jobs(text) to service_role;
