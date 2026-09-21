-- ===========================================================================
-- P0 convergence -- DR4 WATCHDOG: resume a stalled cycle's Catalog job (FAILED or PENDING)
-- ===========================================================================
--
-- ADDITIVE + IDEMPOTENT. CREATE OR REPLACE of resume_stalled_catalog_job (added in 20260930,
-- which stays applied + untouched). Changes NO table/column/constraint; stores no secret.
--
-- WHY (extends 20260930). A stalled scheduled cycle blocks in TWO shapes, both zero-token:
--   (A) FAILED catalog: the create was refused (e.g. cross-bucket carrier-hash race) ->
--       fetch_status='failed', export_id NULL. (20260930 handled this.)
--   (B) PENDING catalog: a "case-c" legacy/frozen cycle whose Catalog family was frozen into
--       the plan but NEVER executed (fetch_status='pending', attempted_at NULL, cec=0) -- so the
--       cycle can never drain via a strict continuation and is a permanent running zombie.
-- Both are satisfiable from the VALIDATED durable org Catalog snapshot with ZERO exports, so this
-- unifies them: the watchdog calls resume_stalled_catalog_job(cycle_id, stale_before) and the RPC
-- adopts the org snapshot for whichever shape the Catalog job is in.
--
-- The fence now allows the Catalog job itself to be the (pending) open job, but still refuses when
-- ANY NON-catalog source job is open (pending/attempted) -- that is a genuinely mid-flight OLI/FBA
-- fetch this operator must not disturb (returns 'has-open-jobs'). Everything else is unchanged from
-- 20260930: status='running' + stale fence, export_id IS NULL + cec<=1 (a create that spent NO
-- tokens), a VALIDATED durable org snapshot with a content object, atomic failed/pending->succeeded
-- with adoption_kind='durable_snapshot' (no pending window), idempotent, service_role only.

create or replace function public.resume_stalled_catalog_job(
  p_cycle_id uuid,
  p_stale_before timestamptz
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cycle public.sync_cycles;
  v_job public.sync_source_jobs;
  v_snap public.source_snapshots%rowtype;
  v_open_noncat int;
  v_updated integer;
begin
  if p_stale_before is null then
    raise exception 'resume_stalled_catalog_job requires a non-null p_stale_before staleness fence';
  end if;

  -- (1) A genuinely STALLED running cycle (fenced against a live/fresh cycle).
  select * into v_cycle from public.sync_cycles where id = p_cycle_id for update;
  if not found then
    return 'cycle-not-found';
  end if;
  if v_cycle.status <> 'running' or v_cycle.updated_at > p_stale_before then
    return 'not-stalled';
  end if;

  -- No OPEN (pending/attempted) NON-catalog source job -> the cycle is not actively fetching OLI/FBA.
  -- (A pending Catalog job IS allowed here -- it is exactly what we adopt below.)
  select count(*) into v_open_noncat from public.sync_source_jobs
    where cycle_id = p_cycle_id and source_key <> 'product-catalog'
      and fetch_status in ('pending', 'attempted');
  if v_open_noncat > 0 then
    return 'has-open-jobs';
  end if;

  -- (2) The product-catalog job that never produced a real export (FAILED or still PENDING; export_id NULL,
  --     create spent NO tokens). A job that made a real export is never reset.
  select * into v_job from public.sync_source_jobs
    where cycle_id = p_cycle_id and source_key = 'product-catalog'
      and fetch_status in ('failed', 'pending') and export_id is null and create_export_count <= 1
    limit 1;
  if not found then
    return 'not-eligible';
  end if;

  -- (3) A VALIDATED durable org Catalog snapshot for the job's EXACT tenant/source/scope (locked first).
  select * into v_snap from public.source_snapshots
    where organization_fingerprint = v_job.organization_fingerprint
      and connection_id = v_job.connection_id
      and source_key = 'product-catalog'
      and scope_key = '__organization'
    for update;
  if not found
     or v_snap.validated_at is null
     or coalesce(btrim(v_snap.object_path), '') = ''
     or coalesce(btrim(v_snap.payload_sha), '') = '' then
    return 'no-snapshot';
  end if;

  -- (4) ATOMIC failed/pending -> succeeded via the durable snapshot (no pending window). Snapshot's OWN
  --     values + EXPLICIT provenance; export_id stays NULL and create_export_count resets to 0.
  update public.sync_source_jobs
     set fetch_status = 'succeeded',
         succeeded_at = now(),
         adoption_kind = 'durable_snapshot',
         export_id = null,
         create_export_count = 0,
         attempted_at = null,
         failed_at = null,
         terminal = false,
         row_count = v_snap.row_count,
         payload_bytes = v_snap.payload_bytes,
         cache_object_path = v_snap.object_path,
         last_good_fetched_at = coalesce(v_snap.validated_at, now()),
         error_stage = null,
         error_code = null,
         error_message = null,
         updated_at = now()
   where id = v_job.id
     and fetch_status in ('failed', 'pending')
     and export_id is null;

  get diagnostics v_updated = row_count;
  if v_updated = 1 then
    return 'resumed';
  end if;
  return 'not-eligible';
end;
$$;

-- Least privilege: service_role only; never callable by the browser (anon/authenticated) or public.
revoke all on function public.resume_stalled_catalog_job(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.resume_stalled_catalog_job(uuid, timestamptz) to service_role;
