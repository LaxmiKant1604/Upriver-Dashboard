-- Scheduler v2 -- cycle FINALIZATION primitives (PREPARED -- UNAPPLIED).
--
-- >>> DO NOT APPLY via `npm run db:migrate` or any bulk apply. This migration is PREPARED for Codex review
-- >>> and is applied ONLY via a reviewed single-file Gate after approval, exactly like migrations 1-4 were.
-- >>> Migrations 1-4 (20260807 / 20260810 x2 / 20260811) are FROZEN and are NOT modified or reapplied here.
--
-- WHY: the canonical dispatcher (runSchedulerV2Shadow) computes drained/continuationRequired but there is no
-- guarded way to mark a genuinely-drained cycle terminal: `updateSyncCycleCounts` is an UNGUARDED PATCH and
-- never sets finished_at, so a Gate-5-style drained cycle stays status='running' with finished_at null and no
-- persisted report counters. This adds the two DB primitives the fix needs:
--   1. finalize_sync_cycle(cycle_id) -- a GUARDED, atomic running->terminal transition that recomputes the
--      authoritative source AND report counters, stamps finished_at, and picks the terminal status from the
--      documented state table (lib/server/sync/cycle-lifecycle.js). It finalizes ONLY a 'running' cycle that
--      has ZERO open source/report jobs, so a manual subset, a concurrent continuation that appended open
--      work, or a stale finalizer can never prematurely close a cycle -- and a replay against an already
--      terminal cycle is a no-op (returns null).
--   2. reject_append_to_terminal_cycle -- a BEFORE INSERT/UPDATE trigger on the three child tables that blocks
--      adding/altering any source/report/owner row once the parent cycle is terminal, so a concurrent
--      invocation cannot add work after terminalization.
-- The finalize UPDATE takes FOR UPDATE on the cycle row and the trigger takes FOR SHARE, so the two orderings
-- serialize: if an append commits first, finalize sees the open job and declines; if finalize commits first,
-- the append's trigger sees the terminal status and raises. Adds NO table/column (sync_cycles already has
-- status/finished_at/source_*/report_* from 20260807) and no schedule/cron; SECURITY DEFINER + service_role
-- only, matching the existing RPCs.

-- ---------------------------------------------------------------------------
-- 1. finalize_sync_cycle -- guarded, atomic running->terminal finalization.
-- ---------------------------------------------------------------------------
create or replace function public.finalize_sync_cycle(
  p_cycle_id uuid,
  p_expect_status text default 'running'
)
returns public.sync_cycles
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cycle public.sync_cycles;
  v_src_total int; v_src_ok int; v_src_fail int; v_src_open int;
  v_rep_total int; v_rep_ok int; v_rep_fail int; v_rep_open int;
  v_status text;
  v_row public.sync_cycles;
begin
  -- Lock the cycle row so a concurrent finalize / append serializes on it.
  select * into v_cycle from public.sync_cycles where id = p_cycle_id for update;
  if not found then
    return null;                          -- unknown cycle
  end if;
  if v_cycle.status is distinct from p_expect_status then
    return null;                          -- already terminal / not running: idempotent no-op (row 9)
  end if;

  -- Authoritative source counters. OPEN = pending/attempted (mid create-export/poll/download, resumable).
  select count(*),
         count(*) filter (where fetch_status = 'succeeded'),
         count(*) filter (where fetch_status = 'failed'),
         count(*) filter (where fetch_status in ('pending', 'attempted'))
    into v_src_total, v_src_ok, v_src_fail, v_src_open
    from public.sync_source_jobs where cycle_id = p_cycle_id;

  -- Authoritative report counters. FINISHED mirrors report-worker.reportJobFinished:
  --   blocked | (derive succeeded AND save succeeded) | derive failed/skipped | save failed.
  -- SUCCESS = derive succeeded AND save succeeded. OPEN = not finished.
  select count(*),
         count(*) filter (where derive_status = 'succeeded' and save_status = 'succeeded'),
         count(*) filter (where (fetch_status = 'blocked'
                             or derive_status in ('failed', 'skipped')
                             or save_status = 'failed')
                            and not (derive_status = 'succeeded' and save_status = 'succeeded')),
         count(*) filter (where not (fetch_status = 'blocked'
                             or (derive_status = 'succeeded' and save_status = 'succeeded')
                             or derive_status in ('failed', 'skipped')
                             or save_status = 'failed'))
    into v_rep_total, v_rep_ok, v_rep_fail, v_rep_open
    from public.sync_report_jobs where cycle_id = p_cycle_id;

  -- GUARD: finalize ONLY when the WHOLE cycle is drained. Any open source/report job means a continuation
  -- (this run's or a concurrent owner's) can still append/advance work -> leave the cycle running (rows 7-8).
  if v_src_open > 0 or v_rep_open > 0 then
    return null;
  end if;

  -- Terminal status from the state table: succeeded (nothing failed) | failed (nothing succeeded) | partial.
  if v_src_fail = 0 and v_rep_fail = 0 then
    v_status := 'succeeded';
  elsif v_src_ok = 0 and v_rep_ok = 0 then
    v_status := 'failed';
  else
    v_status := 'partial';
  end if;

  update public.sync_cycles
     set status = v_status,
         finished_at = now(),
         source_total = v_src_total, source_succeeded = v_src_ok, source_failed = v_src_fail,
         report_total = v_rep_total, report_succeeded = v_rep_ok, report_failed = v_rep_fail
   where id = p_cycle_id and status = p_expect_status   -- race guard: a concurrent finalizer that already flipped loses here
   returning * into v_row;
  return v_row;                            -- null when the WHERE lost the race
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. reject_append_to_terminal_cycle -- block new/changed child work once terminal.
-- ---------------------------------------------------------------------------
create or replace function public.reject_append_to_terminal_cycle()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
begin
  -- FOR SHARE serializes against finalize_sync_cycle's FOR UPDATE: if a finalize is committing, this blocks
  -- until it commits and then sees the terminal status.
  select status into v_status from public.sync_cycles where id = NEW.cycle_id for share;
  if v_status in ('succeeded', 'partial', 'failed') then
    raise exception 'sync cycle % is terminal (%); refusing to append/alter child work', NEW.cycle_id, v_status
      using errcode = 'raise_exception';
  end if;
  return NEW;
end;
$$;

drop trigger if exists sync_source_jobs_no_append_terminal on public.sync_source_jobs;
create trigger sync_source_jobs_no_append_terminal
  before insert or update on public.sync_source_jobs
  for each row execute function public.reject_append_to_terminal_cycle();

drop trigger if exists sync_source_job_owners_no_append_terminal on public.sync_source_job_owners;
create trigger sync_source_job_owners_no_append_terminal
  before insert or update on public.sync_source_job_owners
  for each row execute function public.reject_append_to_terminal_cycle();

drop trigger if exists sync_report_jobs_no_append_terminal on public.sync_report_jobs;
create trigger sync_report_jobs_no_append_terminal
  before insert or update on public.sync_report_jobs
  for each row execute function public.reject_append_to_terminal_cycle();

-- ---------------------------------------------------------------------------
-- Grants -- service_role only, matching the existing Scheduler-v2 RPCs.
-- ---------------------------------------------------------------------------
revoke all on function public.finalize_sync_cycle(uuid, text) from public, anon, authenticated;
grant execute on function public.finalize_sync_cycle(uuid, text) to service_role;
