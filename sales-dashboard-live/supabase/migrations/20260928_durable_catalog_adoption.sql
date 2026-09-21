-- ===========================================================================
-- P0 convergence -- DURABLE CATALOG EVIDENCE ADOPTION (DR1)
-- ===========================================================================
--
-- ADDITIVE + IDEMPOTENT. Adds ONE nullable column and ONE new RPC. Changes NO
-- existing table/column/constraint/RPC; stores no secret. Backward compatible:
-- old code that never sets adoption_kind and never calls the new RPC is unaffected.
--
-- WHY. The zero-export publication reconciler forces an org Catalog source job so
-- its cycle drains, then re-derives OLI-dependent dashboards off durable evidence.
-- When the 24h source_export_cache Catalog row is COLD (expired/pruned) the noExport
-- reconciler cannot re-export it, the job cannot reach fetch_status='succeeded', and
-- the derive/finalize gate (source-priority-dashboards.js: "EXACTLY ONE succeeded
-- product-catalog job") refuses -> publication defers indefinitely, even though the
-- durable org Catalog snapshot (public.source_snapshots) is VALIDATED and is exactly
-- what the read-path self-heal already derives from.
--
-- This RPC lets a catalog source job be satisfied by that DURABLE snapshot as a TYPED
-- durable-snapshot dependency evidence -- recorded with EXPLICIT provenance
-- (adoption_kind='durable_snapshot'), never an anonymous fake success. The Product Catalog
-- is ORG-SCOPED: there is exactly ONE canonical product-catalog snapshot per (org, connection)
-- at scope_key='__organization', and the derive reads THAT snapshot (evidence.catalogSnapshot),
-- not the job's export. So the snapshot is COMPATIBLE evidence for any product-catalog job of
-- the same (org, connection) -- the export request_hash legitimately differs (it carries the
-- pass's carrier/as-of) and is NOT the equivalence basis. The equivalence proven here is:
-- exact tenant/source/scope (no cross-org/account adoption) + a matching CONTENT hash
-- (object_path + payload_sha the caller validated) + validated freshness. (This is exactly the
-- "if source_snapshots cannot prove EXACT request equivalence, use a typed durable-snapshot
-- evidence type" path.)
--
-- DEADLOCK-SAFE LOCK ORDER: this RPC locks
--   (1) public.source_snapshots (the durable evidence, keyed by the org/conn/source/scope) FOR UPDATE, THEN
--   (2) public.sync_source_jobs  (the per-cycle child) via the conditional UPDATE's row lock.
-- adopt_source_export_cache locks (source_export_cache -> sync_source_jobs); this locks a DIFFERENT parent
-- (source_snapshots) then the same child, and never both parents, so there is no lock cycle.
--
-- MUTUAL EXCLUSION with claim_source_export_attempt + adopt_source_export_cache: all
-- three transition the SAME sync_source_jobs row away from fetch_status='pending' and
-- all require fetch_status='pending' in their WHERE, so exactly ONE wins. A REAL export
-- (or a warm-cache adoption) that already succeeded leaves the job non-pending, so this
-- RPC returns 'not-adopted' and the real evidence WINS. Repeated adoption is idempotent
-- (only the first pending->succeeded transition applies). The one-attempt invariant holds:
-- an adopted row keeps create_export_count=0 and attempted_at=NULL and export_id=NULL.

-- 1) Explicit provenance column (additive, nullable). NULL = a normal export / warm-cache
--    adoption; 'durable_snapshot' = satisfied by a validated durable Catalog snapshot.
alter table public.sync_source_jobs
  add column if not exists adoption_kind text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'sync_source_jobs_adoption_kind_chk'
  ) then
    alter table public.sync_source_jobs
      add constraint sync_source_jobs_adoption_kind_chk
      check (adoption_kind is null or adoption_kind in ('durable_snapshot'));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- adopt_durable_catalog_snapshot -- ATOMIC, snapshot-validated adoption CAS. Typed ack:
--   'adopted'          this caller won the pending->succeeded transition from a validated,
--                      exactly-equivalent, fresh-enough durable Catalog snapshot (zero DataDoe);
--   'not-adopted'      the snapshot matched but the source job was no longer pending
--                      (a real export/cache adoption concurrently won) -- the real evidence WINS;
--   'snapshot-missing' no durable Catalog snapshot exists for this exact org/conn/source/scope;
--   'snapshot-mismatch' a snapshot exists but its identity/integrity (source_request_hash /
--                      object_path / payload_sha / row_count) is NOT exactly equivalent to the
--                      job's canonical request + the caller's validated expectations -> refuse;
--   'snapshot-stale'   the snapshot's validated_at is null or older than the required floor.
-- The caller's values are EXPECTATIONS; the db rows are authority (the write uses the DB row's
-- OWN values). Fails closed on any structurally invalid input or any mismatch.
-- ---------------------------------------------------------------------------
create or replace function public.adopt_durable_catalog_snapshot(
  p_cycle_id uuid,
  p_request_hash text,
  p_expected_organization_fingerprint text,
  p_expected_connection_id text,
  p_expected_source_key text,
  p_expected_scope_key text,
  p_expected_object_path text,
  p_expected_payload_sha text,
  p_min_validated_at timestamptz default null
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_snap public.source_snapshots%rowtype;
  v_updated integer;
begin
  -- (0) Reject a structurally invalid expectation set up front (never a silent pass).
  if coalesce(btrim(p_request_hash), '') = '' then
    raise exception 'adopt_durable_catalog_snapshot requires a non-blank request_hash';
  end if;
  if coalesce(btrim(p_expected_organization_fingerprint), '') = '' then
    raise exception 'adopt_durable_catalog_snapshot requires a non-blank organization_fingerprint';
  end if;
  if coalesce(btrim(p_expected_connection_id), '') = '' or p_expected_connection_id not in ('primary', 'dd-secondary') then
    raise exception 'adopt_durable_catalog_snapshot requires a valid connection_id';
  end if;
  -- ONLY the org-scoped product-catalog family may be satisfied from a durable snapshot (fail closed on anything else).
  if p_expected_source_key is distinct from 'product-catalog' then
    raise exception 'adopt_durable_catalog_snapshot only adopts the product-catalog source (got %)', p_expected_source_key;
  end if;
  if coalesce(btrim(p_expected_scope_key), '') = '' then
    raise exception 'adopt_durable_catalog_snapshot requires a non-blank scope_key';
  end if;
  if coalesce(btrim(p_expected_object_path), '') = '' then
    raise exception 'adopt_durable_catalog_snapshot requires a non-blank expected object_path';
  end if;
  if coalesce(btrim(p_expected_payload_sha), '') = '' then
    raise exception 'adopt_durable_catalog_snapshot requires a non-blank expected payload_sha';
  end if;

  -- (1) LOCK the ACTUAL durable snapshot row FIRST (deadlock-safe order), keyed by the EXACT tenant/source/scope
  --     identity. A missing row => there is no durable Catalog evidence to adopt for this exact scope.
  select * into v_snap
    from public.source_snapshots
   where organization_fingerprint = p_expected_organization_fingerprint
     and connection_id = p_expected_connection_id
     and source_key = p_expected_source_key
     and scope_key = p_expected_scope_key
   for update;
  if not found then
    return 'snapshot-missing';
  end if;

  -- (2) The db row is authority. This is the org's ONE canonical product-catalog snapshot (the WHERE above pinned
  --     the exact tenant/source/scope, so cross-org/account rows can never reach here). The remaining proof is a
  --     CONTENT match: object_path + payload_sha (the content hash) must equal what the caller validated, so a
  --     replaced/re-persisted snapshot is never silently adopted. The export request_hash is NOT compared -- the
  --     org Catalog is date-independent content and the derive reads THIS snapshot, not the job's export; the
  --     job's request_hash (which carries the pass carrier/as-of) is only used to target the exact job to update.
  if v_snap.object_path is distinct from p_expected_object_path
     or v_snap.payload_sha is distinct from p_expected_payload_sha then
    return 'snapshot-mismatch';
  end if;

  -- (3) Freshness: the snapshot must be validated (evidence exists) and meet the caller's floor when one is given.
  if v_snap.validated_at is null then
    return 'snapshot-stale';
  end if;
  if p_min_validated_at is not null and v_snap.validated_at < p_min_validated_at then
    return 'snapshot-stale';
  end if;

  -- (4) CAS the catalog source job, writing the SNAPSHOT ROW'S OWN values (never the caller's) + EXPLICIT
  --     provenance. Adopts only while still pending/unattempted/count=0 and ONLY the product-catalog family, so a
  --     concurrent real export/cache adoption wins and no non-catalog job can ever be marked from a catalog snapshot.
  update public.sync_source_jobs
     set fetch_status = 'succeeded',
         succeeded_at = now(),
         adoption_kind = 'durable_snapshot',
         export_id = null,
         row_count = v_snap.row_count,
         payload_bytes = v_snap.payload_bytes,
         cache_object_path = v_snap.object_path,
         last_good_fetched_at = coalesce(v_snap.validated_at, now()),
         error_stage = null,
         error_code = null,
         error_message = null,
         updated_at = now()
   where cycle_id = p_cycle_id
     and request_hash = p_request_hash
     and source_key = p_expected_source_key
     and organization_fingerprint = p_expected_organization_fingerprint
     and connection_id = p_expected_connection_id
     and fetch_status = 'pending'
     and attempted_at is null
     and create_export_count = 0;

  get diagnostics v_updated = row_count;
  if v_updated = 1 then
    return 'adopted';
  end if;
  return 'not-adopted';
end;
$$;

-- Least privilege: service_role only; never callable by the browser (anon/authenticated) or public.
revoke all on function public.adopt_durable_catalog_snapshot(uuid, text, text, text, text, text, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.adopt_durable_catalog_snapshot(uuid, text, text, text, text, text, text, text, timestamptz) to service_role;
