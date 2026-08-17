-- ===========================================================================
-- Scheduler v2 — ATOMIC, cache-validated reuse adoption + claim mutual-exclusion
-- ===========================================================================
--
-- ADDITIVE + IDEMPOTENT. Adds ONE new RPC and REPLACES one existing RPC with a
-- strictly SAFER predicate. Changes NO table/column/constraint; stores no secret.
--
-- WHY (Blocker 2 + senior review): the durable source-cache reuse path must adopt
-- a cached export into a source job ATOMICALLY and only against the ACTUAL current
-- cache row. adopt_source_export_cache re-reads and LOCKS the real
-- source_export_cache row inside the same transaction and validates its full
-- identity + integrity against the caller's EXPECTATIONS (the caller's values are
-- expectations, NEVER authority — the adoption writes the DB row's OWN values).
--
-- DEADLOCK-SAFE LOCK ORDER: adopt_source_export_cache locks
--   (1) public.source_export_cache  (parent identity, keyed by request_hash) FOR UPDATE, THEN
--   (2) public.sync_source_jobs      (the per-cycle child) via the conditional UPDATE's row lock.
-- It is the ONLY function that locks BOTH tables in one transaction:
--   * claim_source_export_attempt locks ONLY sync_source_jobs;
--   * the JS save path (atomicSaveSourcePayload) writes the two tables in SEPARATE
--     statements/transactions, never holding both row locks at once;
--   * prune_source_export_cache locks ONLY source_export_cache rows.
-- With this single consistent order there is no lock cycle, so no deadlock.
--
-- MUTUAL EXCLUSION with claim_source_export_attempt: both transition the SAME
-- sync_source_jobs row away from fetch_status='pending' and both require
-- fetch_status='pending' in their WHERE, so exactly ONE wins and there are ZERO
-- unnecessary create-export POSTs. The one-attempt invariant is preserved: an
-- adopted row keeps create_export_count=0 and attempted_at=NULL and export_id=NULL.

-- ---------------------------------------------------------------------------
-- adopt_source_export_cache — the ATOMIC, cache-validated adoption CAS. Returns a
-- TYPED acknowledgement:
--   'adopted'       this caller won the pending->succeeded transition from a current,
--                   exactly-matching, unexpired cache row (zero DataDoe);
--   'not-adopted'   the cache matched but the source job was no longer pending
--                   (concurrently claimed/succeeded/failed) — the caller MUST NOT create;
--   'cache-changed' no current cache row for this request_hash, OR the row's identity/
--                   integrity (source_id / organization_fingerprint / account_scope_hash /
--                   object_path / row_count / payload_bytes) does NOT match the caller's
--                   expectations (it was replaced/pruned) — the caller MUST NOT reuse;
--   'cache-expired' the current cache row exists but expires_at <= now().
-- ---------------------------------------------------------------------------
create or replace function public.adopt_source_export_cache(
  p_cycle_id uuid,
  p_request_hash text,
  p_expected_source_id text,
  p_expected_organization_fingerprint text,
  p_expected_account_scope_hash text,
  p_expected_object_path text,
  p_expected_row_count integer,
  p_expected_payload_bytes bigint
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cache public.source_export_cache%rowtype;
  v_updated integer;
begin
  -- (0) Reject a structurally invalid expectation set up front (never a silent pass).
  if coalesce(btrim(p_request_hash), '') = '' then
    raise exception 'adopt_source_export_cache requires a non-blank request_hash';
  end if;
  if coalesce(btrim(p_expected_object_path), '') = '' then
    raise exception 'adopt_source_export_cache requires a non-blank expected object_path';
  end if;
  if p_expected_row_count is null or p_expected_row_count < 0 then
    raise exception 'adopt_source_export_cache requires a non-negative expected row_count';
  end if;
  if p_expected_payload_bytes is null or p_expected_payload_bytes < 0 then
    raise exception 'adopt_source_export_cache requires a non-negative expected payload_bytes';
  end if;

  -- (1) LOCK the ACTUAL current cache row FIRST (deadlock-safe order). A missing row => the cache was
  --     pruned/replaced/never-saved between the caller's read and now.
  select * into v_cache
    from public.source_export_cache
   where request_hash = p_request_hash
   for update;
  if not found then
    return 'cache-changed';
  end if;

  -- (2) Expiry gate on the AUTHORITATIVE db value (not the caller's).
  if v_cache.expires_at <= now() then
    return 'cache-expired';
  end if;

  -- (3) The caller's values are EXPECTATIONS. The db row is authority: ANY identity/integrity mismatch
  --     means the cache we would adopt is not the one the caller validated => refuse (cache-changed).
  if v_cache.source_id is distinct from p_expected_source_id
     or v_cache.organization_fingerprint is distinct from p_expected_organization_fingerprint
     or v_cache.account_scope_hash is distinct from p_expected_account_scope_hash
     or v_cache.object_path is distinct from p_expected_object_path
     or v_cache.row_count is distinct from p_expected_row_count
     or v_cache.payload_bytes is distinct from p_expected_payload_bytes then
    return 'cache-changed';
  end if;

  -- (4) CAS the source job, writing the CACHE ROW'S OWN values (never the caller's). Adopts only while
  --     still pending/unattempted/create_export_count=0; the one-attempt invariant is preserved.
  update public.sync_source_jobs
     set fetch_status = 'succeeded',
         succeeded_at = now(),
         export_id = null,
         row_count = v_cache.row_count,
         payload_bytes = v_cache.payload_bytes,
         cache_object_path = v_cache.object_path,
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
-- claim_source_export_attempt — UNCHANGED except the added `fetch_status='pending'`
-- guard, making it mutually exclusive with adopt_source_export_cache and refusing
-- to (re)attempt a row that is no longer pending. Strictly safer; a genuinely
-- pending job always has fetch_status='pending' AND attempted_at IS NULL.
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

revoke all on function public.adopt_source_export_cache(uuid, text, text, text, text, text, integer, bigint) from public, anon, authenticated;
grant execute on function public.adopt_source_export_cache(uuid, text, text, text, text, text, integer, bigint) to service_role;
-- Re-assert the existing grant for the replaced claim RPC (idempotent).
revoke all on function public.claim_source_export_attempt(uuid, text) from public, anon, authenticated;
grant execute on function public.claim_source_export_attempt(uuid, text) to service_role;
