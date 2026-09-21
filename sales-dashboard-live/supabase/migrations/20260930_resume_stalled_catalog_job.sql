-- ===========================================================================
-- P0 convergence -- DR4 WATCHDOG: resume a stalled SCHEDULED cycle's Catalog job
-- ===========================================================================
--
-- ADDITIVE + IDEMPOTENT. Adds ONE new RPC. Changes NO existing table/column/
-- constraint/RPC; stores no secret. Backward compatible.
--
-- WHY. A scheduled full-region sync cycle stalls in status='running' FOREVER when its
-- REQUIRED org product-catalog job fails terminally at create-export -- e.g. the
-- cross-bucket carrier-hash race: the sibling region wins the shared per-day catalog
-- reservation with a DIFFERENT canonical carrier hash, so THIS region's create is refused
-- PRIORITY_CATALOG_HASH_MISMATCH (error_code EXPORT_ERROR, export_id NULL, ZERO tokens
-- spent). The failed REQUIRED job makes runBucketSourceSync stop REQUIRED_SOURCE_FAILED ->
-- globalDrained=false -> the derive is skipped -> ZERO sync_report_jobs -> finalize refuses
-- (not every source job succeeded) -> the cycle never finalizes. A strict continuation only
-- retries OPEN (pending/attempted) jobs, never a terminal-FAILED one, so every resume
-- re-computes the same failure and the cycle is a permanent zombie. oli-refresh-d1 only
-- supersedes a TERMINAL cycle, never a running one, so nothing escapes without this operator.
--
-- This RPC lets the DR4 watchdog RESUME such a cycle with ZERO DataDoe exports by satisfying
-- its failed Catalog job from the VALIDATED durable org Catalog snapshot (the SAME snapshot
-- the sibling's successful export refreshed, and exactly what the derive reads). It transitions
-- the job failed -> succeeded ATOMICALLY (no intervening 'pending' window in which the daily
-- cron could fire a PAID re-export), records EXPLICIT provenance (adoption_kind='durable_snapshot'),
-- and clears the create attempt so the cycle drains -> derives -> finalizes -> publishes.
--
-- SAFETY (never a paid export, never fabricated evidence, never a live cycle):
--   * Fenced on the parent cycle being status='running' AND stale (updated_at <= p_stale_before)
--     AND having NO OPEN (pending/attempted) source job -- so a cycle still actively fetching, or
--     a fresh/live cycle, is never touched (returns 'not-stalled').
--   * The Catalog job MUST be fetch_status='failed' with export_id IS NULL and create_export_count<=1
--     -- i.e. a create that FAILED and spent NO tokens; a job that made a real export is never reset.
--   * GATED on a VALIDATED durable org Catalog snapshot for the job's EXACT (org, connection,
--     'product-catalog', '__organization') with a content object (object_path + payload_sha).
--     No snapshot -> 'no-snapshot' (the cycle stays failed; the watchdog then finalizes it partial).
--   * The write uses the SNAPSHOT ROW'S OWN values (never a caller's), adoption_kind='durable_snapshot',
--     export_id stays NULL, create_export_count=0 -- byte-consistent with adopt_durable_catalog_snapshot.
--   * IDEMPOTENT + CAS: only the first failed->succeeded transition applies (re-run -> 'not-eligible').
--   * Reversible kill-switch at the call site (the watchdog is DRY-RUN unless SCHEDULER_WATCHDOG_LIVE).
--
-- DEADLOCK-SAFE LOCK ORDER: locks (1) the durable source_snapshots parent FOR UPDATE, then (2) the
-- sync_cycles parent FOR UPDATE, then (3) the sync_source_jobs child via the conditional UPDATE's row
-- lock (the BEFORE-trigger reject_append_to_terminal_cycle takes FOR SHARE on the SAME cycle row, which
-- this holds FOR UPDATE, so the child update serializes safely; the cycle is 'running' so the trigger
-- permits it). No other RPC locks source_snapshots then sync_cycles, so there is no lock cycle.

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
  v_open int;
  v_updated integer;
begin
  if p_stale_before is null then
    raise exception 'resume_stalled_catalog_job requires a non-null p_stale_before staleness fence';
  end if;

  -- (1) The cycle must be a genuinely STALLED running cycle (fenced against a live/fresh cycle).
  select * into v_cycle from public.sync_cycles where id = p_cycle_id for update;
  if not found then
    return 'cycle-not-found';
  end if;
  if v_cycle.status <> 'running' or v_cycle.updated_at > p_stale_before then
    return 'not-stalled';
  end if;

  -- No OPEN (pending/attempted) source job -> the cycle is DONE fetching and stuck (not mid-flight).
  select count(*) into v_open from public.sync_source_jobs
    where cycle_id = p_cycle_id and fetch_status in ('pending', 'attempted');
  if v_open > 0 then
    return 'has-open-jobs';
  end if;

  -- (2) Exactly the failed, no-real-export product-catalog job (a create that spent NO tokens).
  select * into v_job from public.sync_source_jobs
    where cycle_id = p_cycle_id and source_key = 'product-catalog'
      and fetch_status = 'failed' and export_id is null and create_export_count <= 1
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

  -- (4) ATOMIC failed -> succeeded via the durable snapshot (no pending window). Writes the SNAPSHOT's
  --     OWN values + EXPLICIT provenance; export_id stays NULL and create_export_count resets to 0.
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
     and fetch_status = 'failed'
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
