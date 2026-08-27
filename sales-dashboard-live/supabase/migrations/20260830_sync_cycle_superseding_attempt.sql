-- ===========================================================================
-- Scheduler v2 -- DURABLE SUPERSEDING-ATTEMPT model for sync_cycles (Migration 14)
-- ===========================================================================
--
-- ADDITIVE + IDEMPOTENT. Adds 3 columns + 1 RPC to the EXISTING cycle model and relaxes ONE
-- uniqueness constraint. Changes no existing row, stores no secret. Repeated execution is safe.
-- PREPARED, UNAPPLIED (Codex review).
--
-- WHY: cycle completion and source freshness were incorrectly COUPLED. A cycle finalized (terminal)
-- while its durable OLI coverage is still below the previous day (D-1) blocked any new D-1 attempt on
-- the same calendar slot: the UNIQUE (bucket, cycle_date) constraint refuses a second cycle, and the
-- terminal-append guard refuses new child jobs -- so neither the automatic run nor a manual force-latest
-- could obtain D-1. DataDoe is real-time (a fresh export proves D-1 rows exist), so this is a scheduler
-- defect, not a data-source lag.
--
-- FIX (forward-only, the historical terminal cycle stays IMMUTABLE): a new RUNNING cycle may SUPERSEDE
-- the stale terminal one on the same (bucket, cycle_date). The old cycle is preserved unchanged (never
-- reopened / reset / deleted / re-dated / mutated); the new attempt carries its OWN child jobs (every
-- child uniqueness is cycle_id-prefixed) and a durable operation identity:
--   scheduled-fresh/<bucket>/<requestedAsOf>            (automatic escalation)
--   manual-force/<bucket>/<requestedAsOf>/<github.run_id> (manual force-latest)
-- Exactly one attempt per operation_key (idempotent resume). Exactly one BASE cycle per (bucket, date).
-- A superseding attempt is exempt from the (bucket, date) uniqueness. Cycle READERS resolve the ACTIVE
-- (non-superseded) head; ambiguity fails closed.

alter table public.sync_cycles
  add column if not exists operation_key text,
  add column if not exists supersedes_cycle_id uuid references public.sync_cycles(id),
  add column if not exists attempt_kind text;

alter table public.sync_cycles drop constraint if exists sync_cycles_attempt_kind_check;
alter table public.sync_cycles add constraint sync_cycles_attempt_kind_check
  check (attempt_kind is null or attempt_kind in ('base', 'scheduled-fresh', 'manual-force'));

-- A superseding attempt must actually point at another cycle (never itself, never a self-loop at insert).
alter table public.sync_cycles drop constraint if exists sync_cycles_supersede_not_self;
alter table public.sync_cycles add constraint sync_cycles_supersede_not_self
  check (supersedes_cycle_id is null or supersedes_cycle_id <> id);

-- Relax the (bucket, cycle_date) uniqueness to BASE cycles only (supersedes_cycle_id IS NULL). A superseding
-- attempt (supersedes_cycle_id set) shares the slot; it is disambiguated by the unique operation_key + by the
-- head resolution in the readers. Every pre-existing row has supersedes_cycle_id NULL and was already unique
-- per slot, so building the partial index cannot fail.
alter table public.sync_cycles drop constraint if exists sync_cycles_bucket_date_unique;
create unique index if not exists sync_cycles_base_bucket_date_uq
  on public.sync_cycles (bucket, cycle_date) where supersedes_cycle_id is null;
create unique index if not exists sync_cycles_operation_key_uq
  on public.sync_cycles (operation_key) where operation_key is not null;
create index if not exists sync_cycles_supersedes_idx
  on public.sync_cycles (supersedes_cycle_id) where supersedes_cycle_id is not null;

-- open_sync_cycle: BASE-cycle create-or-find, UNCHANGED behaviour. The conflict target is now the partial
-- base index (a superseding attempt never goes through this RPC). Legacy callers are byte-identical.
create or replace function public.open_sync_cycle(
  p_bucket text,
  p_cycle_date date,
  p_scheduled_at timestamptz default null,
  p_trigger text default 'pg_cron'
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if p_bucket not in ('us', 'non-us') then
    raise exception 'Invalid bucket %', p_bucket;
  end if;

  insert into public.sync_cycles (bucket, cycle_date, scheduled_at, trigger, status, attempt_kind)
  values (p_bucket, p_cycle_date, p_scheduled_at, coalesce(p_trigger, 'pg_cron'), 'pending', 'base')
  on conflict (bucket, cycle_date) where supersedes_cycle_id is null do update set updated_at = now()
  returning id into v_id;

  return v_id;
end;
$$;

-- open_superseding_sync_cycle: the ATOMIC create-or-resume of a SUPERSEDING attempt, keyed to operation_key.
-- Under an advisory lock on operation_key it returns the existing attempt for that key (idempotent resume) or
-- inserts a fresh RUNNING-eligible 'pending' row that supersedes p_supersedes_cycle_id. It NEVER mutates the
-- superseded cycle. The superseded target must exist, be terminal, and share the (bucket, cycle_date). Returns
-- the attempt id.
create or replace function public.open_superseding_sync_cycle(
  p_bucket text,
  p_cycle_date date,
  p_operation_key text,
  p_supersedes_cycle_id uuid,
  p_attempt_kind text,
  p_scheduled_at timestamptz default null,
  p_trigger text default 'manual'
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_target public.sync_cycles%rowtype;
begin
  if p_bucket not in ('us', 'non-us') then raise exception 'Invalid bucket %', p_bucket; end if;
  if coalesce(btrim(p_operation_key), '') = '' then raise exception 'open_superseding_sync_cycle requires a non-blank operation_key'; end if;
  if p_attempt_kind not in ('scheduled-fresh', 'manual-force') then raise exception 'open_superseding_sync_cycle attempt_kind must be scheduled-fresh|manual-force (got %)', p_attempt_kind; end if;
  if p_supersedes_cycle_id is null then raise exception 'open_superseding_sync_cycle requires a supersedes_cycle_id (the stale terminal cycle)'; end if;

  perform pg_advisory_xact_lock(hashtext(p_operation_key));

  -- Idempotent resume: this operation already has an attempt.
  select id into v_id from public.sync_cycles where operation_key = p_operation_key;
  if found then return v_id; end if;

  -- The superseded target must exist, be terminal, and share the exact slot (never supersede a running cycle).
  select * into v_target from public.sync_cycles where id = p_supersedes_cycle_id for share;
  if not found then raise exception 'open_superseding_sync_cycle: supersedes target % not found', p_supersedes_cycle_id; end if;
  if v_target.bucket <> p_bucket or v_target.cycle_date <> p_cycle_date then raise exception 'open_superseding_sync_cycle: supersedes target is a different (bucket, cycle_date)'; end if;
  if v_target.status not in ('succeeded', 'partial', 'failed') then raise exception 'open_superseding_sync_cycle: refusing to supersede a non-terminal cycle (status %)', v_target.status; end if;

  insert into public.sync_cycles (bucket, cycle_date, scheduled_at, trigger, status, operation_key, supersedes_cycle_id, attempt_kind)
  values (p_bucket, p_cycle_date, p_scheduled_at, coalesce(p_trigger, 'manual'), 'pending', p_operation_key, p_supersedes_cycle_id, p_attempt_kind)
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.open_superseding_sync_cycle(text, date, text, uuid, text, timestamptz, text) from public, anon, authenticated;
grant execute on function public.open_superseding_sync_cycle(text, date, text, uuid, text, timestamptz, text) to service_role;
