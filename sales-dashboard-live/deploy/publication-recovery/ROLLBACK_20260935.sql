-- ROLLBACK (contract) for supabase/migrations/20260935_report_publication_writer_fence.sql.
--
-- >>> THIS RE-ENABLES UNFENCED WRITERS FOR EVERY KEY THAT WAS FENCED. It is NEVER part of a code rollback: a code
-- >>> rollback (git revert / redeploy of an older release) leaves the DB fence ON, so a reverted legacy writer fails
-- >>> closed (REPORT_WRITER_FENCED, last-known-good preserved). Run this file ONLY as a separate, explicitly-approved DB
-- >>> change, recorded as "re-enabling unfenced writers", AFTER confirming that no known-unsafe writer of a fenced key is
-- >>> deployed or running (gh run list --status in_progress; the writer inventory in scripts/report-writer-fence.test.js).
--
-- DELIBERATELY NOT in supabase/migrations/: the ledger-driven runner (scripts/apply-supabase-migrations.mjs) applies every
-- *.sql file there, so a rollback must never live in that directory. Paste it into the Supabase SQL editor (never put the
-- connection string on a command line: argv is visible to other processes and shell history).
--
-- Order: (1) restore public.cas_report_snapshot_if_newer_fenced EXACTLY as 20260919 defined it (no set_config; pinned
-- byte-identical by scripts/report-writer-fence.test.js and proven by scripts/worker/report-writer-fence-selftest.mjs),
-- (2) drop the two triggers, the trigger function and the fence table (and its touch trigger), (3) remove the ledger row.
-- It touches no report snapshot, control-plane lease, source table or other RPC.
--
-- A narrower, equally-approved alternative re-opens ONE key only (it too re-enables unfenced writers of that key):
--   update public.report_publication_writer_fence set fenced_only = false, updated_by = '<approver>' where report_key = '<key>';
--
-- lock_timeout: dropping the triggers needs an exclusive lock on report_snapshots; if a long transaction holds the
-- table this fails fast after 10 s (nothing half-applied: one transaction) instead of queueing every writer behind it.
--
-- RE-APPLY AFTER A ROLLBACK. supabase/migrations/20260935_report_publication_writer_fence.sql STAYS in the repository
-- and this file deletes its ledger row, so a later FULL `npm run db:migrate` (no MIGRATE_ONLY) re-applies it. That is
-- behaviour-neutral: the table is re-created with every key fenced_only = false (a key with no row or a false row is
-- written exactly as before), the trigger then refuses nothing, and the fenced CAS only regains its transaction-local
-- mark. Fencing a key again after that is, as always, a separate owner-approved per-key flip.

begin;
set local lock_timeout = '10s';
create or replace function public.cas_report_snapshot_if_newer_fenced(
  p_report_key text, p_account_id text, p_params_hash text,
  p_params jsonb, p_payload jsonb, p_payload_storage_path text,
  p_payload_bytes bigint, p_source_refreshed_at timestamptz,
  p_owner_token text, p_generation bigint
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lease public.control_plane_lease%rowtype;
  v_token text := coalesce(btrim(p_owner_token), '');
  -- STALE-CLOCK FIX: the write-boundary expiry check must use the post-lock WALL clock, so a lease that expired
  -- while THIS fenced write waited on the advisory / FOR UPDATE lock is rejected (ZERO rows), never written under
  -- a stale transaction_timestamp.
  v_now timestamptz;
begin
  -- FENCE (same transaction as the write): a blank token OR an invalid generation is fail-closed with ZERO
  -- rows -- never an unfenced write. Round-10: the generation is MANDATORY (positive bigint); NULL / <= 0 is
  -- 'lease-lost'.
  if v_token = '' then
    return jsonb_build_object('disposition', 'lease-lost', 'reason', 'no-fence');
  end if;
  if p_generation is null or p_generation <= 0 then
    return jsonb_build_object('disposition', 'lease-lost', 'reason', 'invalid-generation');
  end if;
  perform pg_advisory_xact_lock(hashtext('control-plane-lease'));
  select * into v_lease from public.control_plane_lease where id = 1 for update;
  v_now := clock_timestamp(); -- post-lock wall clock (never the stale transaction_timestamp)
  if not found then
    return jsonb_build_object('disposition', 'lease-lost', 'reason', 'no-lease');
  end if;
  if v_lease.owner_token <> v_token then
    return jsonb_build_object('disposition', 'lease-lost', 'reason', 'owner-changed', 'owner_token', v_lease.owner_token, 'generation', v_lease.generation);
  end if;
  -- EXACT equality (never `is not null and`): a superseded generation writes ZERO rows.
  if v_lease.generation <> p_generation then
    return jsonb_build_object('disposition', 'lease-lost', 'reason', 'generation-superseded', 'generation', v_lease.generation);
  end if;
  if v_lease.expires_at is null or v_lease.expires_at <= v_now then
    return jsonb_build_object('disposition', 'lease-lost', 'reason', 'expired');
  end if;
  -- FENCE HELD -> delegate to the reviewed atomic CAS in THIS SAME transaction (single-sourced semantics).
  return public.cas_report_snapshot_if_newer(
    p_report_key, p_account_id, p_params_hash, p_params, p_payload, p_payload_storage_path,
    p_payload_bytes, p_source_refreshed_at);
end;
$$;

revoke all on function public.cas_report_snapshot_if_newer_fenced(text, text, text, jsonb, jsonb, text, bigint, timestamptz, text, bigint) from public, anon, authenticated;
grant execute on function public.cas_report_snapshot_if_newer_fenced(text, text, text, jsonb, jsonb, text, bigint, timestamptz, text, bigint) to service_role;
drop trigger if exists report_snapshots_zz_writer_fence_truncate on public.report_snapshots;
drop trigger if exists report_snapshots_zz_writer_fence on public.report_snapshots;
drop function if exists public.enforce_report_publication_writer_fence();
drop table if exists public.report_publication_writer_fence;
delete from public.app_schema_migrations where filename = '20260935_report_publication_writer_fence.sql';
commit;
