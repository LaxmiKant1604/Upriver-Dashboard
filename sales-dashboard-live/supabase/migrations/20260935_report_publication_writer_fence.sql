-- ===========================================================================
-- DB-ENFORCED REPORT WRITER FENCE -- report_publication_writer_fence + a BEFORE trigger on report_snapshots
-- (publication recovery WP15)
-- ===========================================================================
--
-- PREPARED, NOT APPLIED. EXPAND-ONLY + IDEMPOTENT. A SEPARATE sign-off from 20260934 (the worker queue). Adds ONE table
-- (with an updated_at touch trigger), ONE trigger function and TWO triggers on public.report_snapshots, and re-creates
-- public.cas_report_snapshot_if_newer_fenced with its body BYTE-IDENTICAL to 20260919 except ONE added transaction-local
-- statement. Changes no column, constraint, policy, grant or data of any existing table. Apply (only after sign-off)
-- EXACTLY this one file:
--   MIGRATE_ONLY=20260935_report_publication_writer_fence.sql npm run db:migrate
-- Rollback (contract): sales-dashboard-live/deploy/publication-recovery/ROLLBACK_20260935.sql (restores the 20260919
-- function body exactly and drops ONLY these objects; it is deliberately NOT in supabase/migrations so the ledger-driven
-- runner can never apply it). The rollback RE-ENABLES unfenced writers -- see that file's header.
--
-- APPLYING IT ENABLES NOTHING. Every fence row is seeded fenced_only = false, and a key with no row (or a false row) is
-- written exactly as today. Enabling the fence for a key is a SEPARATE, owner-approved UPDATE per key, done only after
-- the deployed code's ONLY writer of that key is the fenced publisher path (procedure:
-- deploy/publication-recovery/README.md, section "Writer fence cutover").
--
-- WHY. An unconditional code cutover does not stop an ALREADY-RUNNING old scheduler job (or any stale code path: a
-- refresh=1 builder, a backfill script, the retired brand-inventory rebuild, a reverted deploy) from writing a route-owned
-- live key. This fence is enforced by the DATABASE, independent of which code is deployed: once fenced_only = true, the
-- NEXT write of that key by anything other than the fenced CAS fails closed -- on every connection, instantly -- with
-- SQLSTATE RWF01 and message 'REPORT_WRITER_FENCED:<key>', and the live row stays byte-identical (last-known-good).
--
-- HOW.
--   * public.report_publication_writer_fence(report_key PK, fenced_only, updated_at, updated_by): one row per fenced key.
--     A CHECK forbids scheduler-v2/* shadow keys (the unfenced shadow CAS must keep working) and non-canonical keys.
--   * public.enforce_report_publication_writer_fence(): SECURITY DEFINER, search_path pinned (public, pg_temp), every
--     relation schema-qualified. A write is allowed when the transaction carries the fenced mark
--     current_setting('app.report_publication_fenced', true) = 'on'; otherwise ONE primary-key lookup of the row's
--     NEW.report_key and OLD.report_key (an UPDATE that moves a row INTO or OUT OF a fenced key is refused either way)
--     and, if either is fenced_only, RAISE RWF01. A DELETE of a fenced key is refused too: the fenced publisher never
--     deletes a live row (the guarded route-shadow prune deletes only scheduler-v2/* rows, which can never be fenced), so
--     a stale retention/prune could only DESTROY last-known-good. A statement-level BEFORE TRUNCATE trigger refuses a
--     TRUNCATE while ANY key is fenced (row triggers do not fire on TRUNCATE).
--       - ONE exemption: an UPDATE whose ONLY change is created_by going to NULL (the auth.users ON DELETE SET NULL
--         action when a dashboard user is deleted; every other column compared whole-row) is allowed, and the
--         trigger restores updated_at, so deleting a user never fails on a fenced key and never changes content.
--       - INSERT ... ON CONFLICT DO UPDATE fires the BEFORE INSERT row trigger first (and BEFORE UPDATE on conflict);
--         INSERT ... ON CONFLICT DO NOTHING fires BEFORE INSERT for the proposed row; COPY FROM and MERGE fire the same
--         row triggers -- all covered.
--       - The trigger is named report_snapshots_zz_writer_fence so it fires LAST among the table's BEFORE row triggers
--         (PostgreSQL fires same-event triggers in name order): it sees the final NEW.report_key (today the only other
--         one is report_snapshots_touch_updated_at, which never changes report_key). ASSUMPTION, verified at apply
--         time (README "Writer fence cutover" step 1): report_snapshots carries EXACTLY the touch trigger + these two,
--         all tgenabled = 'O'; a future BEFORE trigger that sorts after 'report_snapshots_zz_writer_fence' and rewrites
--         report_key would bypass it.
--   * A FLIP IS SEEN BY EVERY NEW STATEMENT at once (READ COMMITTED takes a fresh snapshot per statement, and the
--     trigger's lookup runs inside the VOLATILE trigger function). A REPEATABLE READ / SERIALIZABLE transaction that
--     began before the flip keeps its old snapshot until it ends -- the cutover waits for every pre-flip transaction
--     to finish (README, the flip barrier).
--   * public.cas_report_snapshot_if_newer_fenced (the RPC behind supabase.js publishLiveSnapshotFencedIfNewer; the Gate-7
--     publisher's ONLY live write): re-created with its 20260919 body byte-identical plus ONE statement,
--     perform set_config('app.report_publication_fenced', 'on', true), executed only AFTER every lease check passed
--     (token, generation, unexpired) and immediately before it delegates to cas_report_snapshot_if_newer in the SAME
--     transaction. The unfenced CAS (publishLiveSnapshotIfNewer's REST insert/patch, saveShadowSnapshotIfNewer's direct
--     cas_report_snapshot_if_newer RPC, saveReportSnapshot, the v1 prune RPC) never sets it -> refused on fenced keys.
--
-- SQL FUNCTIONS THAT WRITE report_snapshots (every definition in supabase/migrations, classified; pinned by
-- scripts/report-writer-fence.test.js):
--   cas_report_snapshot_if_newer_fenced (20260919, re-created here) -- THE fenced path: sets the mark after the fence.
--   cas_report_snapshot_if_newer        (20260822) -- unfenced CAS: allowed for shadow/unfenced keys, REFUSED on a fenced
--                                                    key unless called from inside the fenced CAS's transaction.
--   prune_scheduled_report_snapshots    (20260805) -- scheduler-v1 DELETE of syncManaged rows: REFUSED on a fenced key.
--
-- THE MARK CANNOT LEAK. set_config(..., true) is TRANSACTION-LOCAL: COMMIT/ROLLBACK reverts it, so a later transaction
-- on the same session -- including a pooled (PgBouncer / Supavisor transaction mode) connection handed to another client
-- -- starts without it and is fenced again. Inside the fenced CAS's OWN transaction the mark stays set after it returns;
-- its only caller is the single-statement PostgREST RPC (supabase.js publishLiveSnapshotFencedIfNewer), so no other
-- statement runs in that transaction (pinned by the test: no pg-direct caller of the fenced CAS, and no code outside
-- this contract sets the setting). Not a defence against a privileged operator: a superuser can disable triggers or set
-- the mark by hand; the fence guards against stale APPLICATION writers.
--
-- STORAGE. The fence covers report_snapshots rows only. The fenced publisher writes inline payloads (payload_storage_path
-- null), and no current code writes a report-snapshot payload object to Storage.

-- A long-running transaction holding report_snapshots must not queue every writer behind this DDL: fail fast instead.
set local lock_timeout = '10s';

-- 1) THE FENCE TABLE (one row per route-owned live key; fenced_only defaults false = no effect).
create table if not exists public.report_publication_writer_fence (
  report_key text primary key
    constraint rpwf_key_canonical check (char_length(btrim(report_key)) > 0 and report_key = btrim(report_key) and char_length(report_key) <= 200)
    constraint rpwf_key_not_shadow check (report_key not like 'scheduler-v2/%'),
  fenced_only boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by text
    constraint rpwf_updated_by_len check (updated_by is null or char_length(updated_by) <= 200)
);
comment on table public.report_publication_writer_fence is
  'WP15 writer fence: fenced_only=true => only cas_report_snapshot_if_newer_fenced may insert/update/delete report_snapshots rows of this report_key (others fail with SQLSTATE RWF01 REPORT_WRITER_FENCED:<key>, live row unchanged). Flip per key only with owner approval.';

drop trigger if exists report_publication_writer_fence_touch on public.report_publication_writer_fence;
create trigger report_publication_writer_fence_touch before update on public.report_publication_writer_fence
  for each row execute function public.touch_updated_at();

-- Seed the ROUTE-OWNED live keys, every one DISABLED. ON CONFLICT DO NOTHING: a re-apply never resets a flipped key.
insert into public.report_publication_writer_fence (report_key, fenced_only, updated_by) values
  ('brand-sales', false, 'migration:20260935'),
  ('daily-reporting', false, 'migration:20260935'),
  ('brand-inventory', false, 'migration:20260935'),
  ('listing-health-v3', false, 'migration:20260935'),
  ('fba-plan', false, 'migration:20260935'),
  ('sku-movement', false, 'migration:20260935'),
  ('returns-leakage', false, 'migration:20260935'),
  ('brand-view', false, 'migration:20260935'),
  ('brand-view-portfolio', false, 'migration:20260935'),
  ('brand-view-brands', false, 'migration:20260935')
on conflict (report_key) do nothing;

-- Least privilege: RLS on, no policy; only service_role may READ (the worker status); nobody but the owner may write.
alter table public.report_publication_writer_fence enable row level security;
revoke all on table public.report_publication_writer_fence from public, anon, authenticated, service_role;
grant select on table public.report_publication_writer_fence to service_role;

-- 2) THE TRIGGER FUNCTION.
create or replace function public.enforce_report_publication_writer_fence()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_new text;
  v_old text;
  v_key text;
begin
  -- The FENCED CAS marks its OWN transaction (transaction-local), only after its lease/generation fence passed.
  if current_setting('app.report_publication_fenced', true) is not distinct from 'on' then
    if tg_op = 'TRUNCATE' then
      return null;
    elsif tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;
  if tg_op = 'TRUNCATE' then
    if exists (select 1 from public.report_publication_writer_fence f where f.fenced_only) then
      raise exception using
        errcode = 'RWF01',
        message = 'REPORT_WRITER_FENCED:*',
        detail = 'TRUNCATE of report_snapshots is refused while any report_key is fenced; no row was removed.',
        hint = 'Only public.cas_report_snapshot_if_newer_fenced may write a fenced report_key.';
    end if;
    return null;
  end if;
  if tg_op = 'INSERT' then
    v_new := new.report_key;
  elsif tg_op = 'UPDATE' then
    v_new := new.report_key;
    v_old := old.report_key;
  else
    v_old := old.report_key;
  end if;
  -- ONE primary-key lookup (at most two keys: the row's key before and after the write).
  select f.report_key into v_key
    from public.report_publication_writer_fence f
   where f.fenced_only
     and f.report_key in (v_new, v_old)
   order by (f.report_key is distinct from v_new)
   limit 1;
  -- The ONE exempt write: the auth.users ON DELETE SET NULL referential action on created_by (deleting a dashboard
  -- user). Allowed only when created_by goes from a user to NULL and EVERY other column except updated_at is unchanged
  -- (a WHOLE-ROW comparison: id, report_key, account_id, params_hash, params, payload, payload_storage_path,
  -- payload_bytes, source_refreshed_at, created_at and any future column). updated_at is RESTORED (the touch trigger
  -- fired first), so the row stays byte-identical except created_by: no content change and no "latest row" reordering.
  if v_key is not null and tg_op = 'UPDATE' then
    if old.created_by is not null and new.created_by is null
       and (to_jsonb(new) - 'created_by' - 'updated_at') = (to_jsonb(old) - 'created_by' - 'updated_at') then
      new.updated_at := old.updated_at;
      return new;
    end if;
  end if;
  if v_key is not null then
    raise exception using
      errcode = 'RWF01',
      message = 'REPORT_WRITER_FENCED:' || v_key,
      detail = 'report_publication_writer_fence.fenced_only is true for this report_key; the write was refused and the live row is unchanged (last-known-good preserved).',
      hint = 'Only public.cas_report_snapshot_if_newer_fenced (the four-gate fenced publisher under the control-plane lease) may write a fenced report_key.';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;
revoke all on function public.enforce_report_publication_writer_fence() from public, anon, authenticated, service_role;

-- 3) THE TRIGGERS (named to fire LAST among report_snapshots' BEFORE triggers).
drop trigger if exists report_snapshots_zz_writer_fence on public.report_snapshots;
create trigger report_snapshots_zz_writer_fence
  before insert or update or delete on public.report_snapshots
  for each row execute function public.enforce_report_publication_writer_fence();
drop trigger if exists report_snapshots_zz_writer_fence_truncate on public.report_snapshots;
create trigger report_snapshots_zz_writer_fence_truncate
  before truncate on public.report_snapshots
  for each statement execute function public.enforce_report_publication_writer_fence();

-- 4) THE FENCED CAS: the 20260919 definition, byte-identical except the ONE set_config line before the delegation.
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
  perform set_config('app.report_publication_fenced', 'on', true);
  return public.cas_report_snapshot_if_newer(
    p_report_key, p_account_id, p_params_hash, p_params, p_payload, p_payload_storage_path,
    p_payload_bytes, p_source_refreshed_at);
end;
$$;

revoke all on function public.cas_report_snapshot_if_newer_fenced(text, text, text, jsonb, jsonb, text, bigint, timestamptz, text, bigint) from public, anon, authenticated;
grant execute on function public.cas_report_snapshot_if_newer_fenced(text, text, text, jsonb, jsonb, text, bigint, timestamptz, text, bigint) to service_role;
