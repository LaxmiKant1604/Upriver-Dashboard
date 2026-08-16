-- ===========================================================================
-- Scheduler v2 — ATOMIC cache-reuse adoption + claim mutual-exclusion (SHADOW)
-- ===========================================================================
--
-- ADDITIVE + IDEMPOTENT. Adds ONE new RPC and REPLACES one existing RPC with a
-- strictly SAFER (more restrictive) predicate. Changes NO table, no column, no
-- constraint, and stores no secret. Repeated execution is safe.
--
-- WHY (Blocker 2): the durable source-cache reuse path previously read the cache
-- entry and then UNCONDITIONALLY patched the source job to 'succeeded'. Between
-- the read and the patch a concurrent worker could win claim_source_export_attempt
-- and create a real export — the unconditional patch would then clobber that
-- in-flight 'attempted' row (dropping its export_id) OR two workers could both
-- "adopt". The fix is an ATOMIC compare-and-set that adopts a cache entry ONLY
-- while the source job is still pending, unattempted, and create_export_count = 0,
-- returning a typed acknowledgement so the worker knows whether it won.
--
-- MUTUAL EXCLUSION: claim_source_export_attempt and adopt_source_export_cache both
-- transition the SAME sync_source_jobs row away from fetch_status='pending'. The
-- row's UPDATE lock serialises them, and each requires fetch_status='pending' in
-- its WHERE, so exactly ONE wins:
--   * claim wins first  -> row becomes 'attempted'  -> adopt's WHERE (pending) misses -> 'not-adopted'
--   * adopt wins first  -> row becomes 'succeeded'  -> claim's WHERE (pending) misses -> claim returns false
-- Either way there is ONE winner and ZERO unnecessary create-export POSTs.
--
-- ONE-ATTEMPT INVARIANT PRESERVED: adoption keeps create_export_count = 0 and
-- attempted_at = NULL (it never touches the claim counter), so the existing
-- sync_source_jobs_one_attempt check ((0/NULL) or (1/NOT NULL)) still holds. A
-- reused row is distinguishable ONLY by (export_id IS NULL AND cache_object_path
-- IS NOT NULL AND fetch_status='succeeded').

-- ---------------------------------------------------------------------------
-- adopt_source_export_cache — the ATOMIC cache-adoption CAS. Returns a typed
-- acknowledgement: 'adopted' (this caller won the pending->succeeded transition
-- from a durable cache entry, zero DataDoe) or 'not-adopted' (the job was already
-- attempted/succeeded/failed/absent — the caller MUST NOT create a new export and
-- MUST fall through to the ordinary resume/skip path).
-- ---------------------------------------------------------------------------
create or replace function public.adopt_source_export_cache(
  p_cycle_id uuid,
  p_request_hash text,
  p_row_count integer,
  p_payload_bytes bigint,
  p_object_path text
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_updated integer;
begin
  if p_object_path is null or char_length(btrim(p_object_path)) = 0 then
    raise exception 'adopt_source_export_cache requires a non-blank object_path';
  end if;
  if p_row_count is null or p_row_count < 0 then
    raise exception 'adopt_source_export_cache requires a non-negative row_count';
  end if;
  if p_payload_bytes is null or p_payload_bytes < 0 then
    raise exception 'adopt_source_export_cache requires a non-negative payload_bytes';
  end if;

  update public.sync_source_jobs
     set fetch_status = 'succeeded',
         succeeded_at = now(),
         export_id = null,                 -- reuse: NO fabricated export id (create_export_count stays 0)
         row_count = p_row_count,
         payload_bytes = p_payload_bytes,
         cache_object_path = p_object_path,
         last_good_fetched_at = now(),
         error_stage = null,
         error_code = null,
         error_message = null,
         updated_at = now()
   where cycle_id = p_cycle_id
     and request_hash = p_request_hash
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

-- ---------------------------------------------------------------------------
-- claim_source_export_attempt — UNCHANGED semantics except the added
-- `fetch_status = 'pending'` guard, which (a) makes it mutually exclusive with
-- adopt_source_export_cache and (b) refuses to (re)attempt any row that is no
-- longer pending (an already-succeeded reuse, or an unattempted terminal failure
-- — which must never be retried). A genuinely pending job always has
-- fetch_status='pending' AND attempted_at IS NULL, so this is strictly safer and
-- changes nothing for the normal first-attempt path.
-- ---------------------------------------------------------------------------
create or replace function public.claim_source_export_attempt(
  p_cycle_id uuid,
  p_request_hash text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.sync_source_jobs
     set attempted_at = now(),
         create_export_count = create_export_count + 1,
         fetch_status = 'attempted',
         updated_at = now()
   where cycle_id = p_cycle_id
     and request_hash = p_request_hash
     and attempted_at is null
     and fetch_status = 'pending';

  return found;
end;
$$;

revoke all on function public.adopt_source_export_cache(uuid, text, integer, bigint, text) from public, anon, authenticated;
grant execute on function public.adopt_source_export_cache(uuid, text, integer, bigint, text) to service_role;
-- Re-assert the existing grant for the replaced claim RPC (idempotent).
revoke all on function public.claim_source_export_attempt(uuid, text) from public, anon, authenticated;
grant execute on function public.claim_source_export_attempt(uuid, text) to service_role;
