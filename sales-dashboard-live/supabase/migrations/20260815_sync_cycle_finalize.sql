-- Scheduler v2 -- cycle FINALIZATION primitives (PREPARED -- UNAPPLIED).
--
-- >>> DO NOT APPLY via `npm run db:migrate` or any bulk apply. This migration is PREPARED for Codex review
-- >>> and is applied ONLY via a reviewed single-file Gate after approval, exactly like migrations 1-4 were.
-- >>> Migrations 1-4 (20260807 / 20260810 x2 / 20260811) are FROZEN and are NOT modified or reapplied here.
--
-- WHY: the canonical dispatcher computes drained/continuationRequired but there was no guarded way to mark a
-- genuinely-drained cycle terminal (updateSyncCycleCounts is an UNGUARDED PATCH and never sets finished_at), so
-- a drained cycle stayed status='running'. This adds the two DB primitives the fix needs:
--   1. finalize_sync_cycle(cycle_id) -> jsonb -- a GUARDED, atomic running->terminal transition that recomputes
--      the authoritative source AND report counters, stamps finished_at, and picks the terminal status from the
--      documented state table (lib/server/sync/cycle-lifecycle.js). It returns a TOTAL, TYPED disposition (never
--      an ambiguous null): 'finalized' | 'already-terminal' | 'open-work' | 'not-found' | 'invalid-status'. It
--      finalizes ONLY a 'running' cycle with ZERO open source/report jobs; there is NO p_expect_status parameter,
--      so a caller can never smuggle a non-'running' expectation to reopen/re-finalize a terminal cycle. The
--      positive results (finalized / already-terminal) AND open-work carry the full cycle row as evidence
--      (finalized/already-terminal => terminal status + finished_at set; open-work => running + finished_at
--      null); the caller's wrapper strictly validates that evidence and fails closed on any contradiction.
--   2. reject_append_to_terminal_cycle -- a BEFORE INSERT/UPDATE trigger on the three child tables that (a)
--      forbids changing a child row's cycle_id outright, (b) fails closed when the parent cycle is missing, and
--      (c) blocks adding/altering any child row whose (unchanged) parent cycle is terminal -- so a row can never
--      be added to, altered in, or moved out of a terminal cycle.
-- Concurrency: the finalize UPDATE holds FOR UPDATE on the cycle row while it reads the child tables and flips
-- the status; the trigger takes FOR SHARE on the same cycle row. So every child append/update SERIALIZES against
-- an in-flight finalize on the one cycle row -- if a child append commits first, finalize sees the open job and
-- returns 'open-work'; if finalize commits first, the child append's trigger sees the terminal status and
-- raises. Both paths lock ONLY the cycle row, in the same order, so the two orderings are deadlock-safe.
-- Adds NO table/column (sync_cycles already has status/finished_at/source_*/report_* from 20260807) and no
-- schedule/cron; SECURITY DEFINER + service_role only, matching the existing RPCs.

-- ---------------------------------------------------------------------------
-- 1. finalize_sync_cycle -- guarded, atomic running->terminal finalization; TOTAL typed disposition + evidence.
-- ---------------------------------------------------------------------------
create or replace function public.finalize_sync_cycle(p_cycle_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cycle public.sync_cycles;
  v_src_total int; v_src_ok int; v_src_fail int; v_src_open int;
  v_rep_total int; v_rep_ok int; v_rep_fail int; v_rep_open int;
  v_new_status text;
begin
  -- Lock the cycle row so a concurrent finalize / child append serializes on it.
  select * into v_cycle from public.sync_cycles where id = p_cycle_id for update;
  if not found then
    return jsonb_build_object('disposition', 'not-found', 'cycle', null);
  end if;
  if v_cycle.status in ('succeeded', 'partial', 'failed') then
    return jsonb_build_object('disposition', 'already-terminal', 'cycle', to_jsonb(v_cycle)); -- idempotent, complete
  end if;
  if v_cycle.status <> 'running' then
    return jsonb_build_object('disposition', 'invalid-status', 'cycle', null);  -- e.g. 'pending' (never finalized)
  end if;

  -- Authoritative source counters. OPEN = pending/attempted (mid create-export/poll/download, resumable).
  select count(*),
         count(*) filter (where fetch_status = 'succeeded'),
         count(*) filter (where fetch_status = 'failed'),
         count(*) filter (where fetch_status in ('pending', 'attempted'))
    into v_src_total, v_src_ok, v_src_fail, v_src_open
    from public.sync_source_jobs where cycle_id = p_cycle_id;

  -- Authoritative report counters. FINISHED mirrors report-worker.reportJobFinished; SUCCESS = derive+save
  -- succeeded; OPEN = not finished.
  select count(*),
         count(*) filter (where derive_status = 'succeeded' and save_status = 'succeeded'),
         count(*) filter (where (fetch_status = 'blocked' or derive_status in ('failed', 'skipped') or save_status = 'failed')
                            and not (derive_status = 'succeeded' and save_status = 'succeeded')),
         count(*) filter (where not (fetch_status = 'blocked'
                             or (derive_status = 'succeeded' and save_status = 'succeeded')
                             or derive_status in ('failed', 'skipped')
                             or save_status = 'failed'))
    into v_rep_total, v_rep_ok, v_rep_fail, v_rep_open
    from public.sync_report_jobs where cycle_id = p_cycle_id;

  if v_src_open > 0 or v_rep_open > 0 then
    return jsonb_build_object('disposition', 'open-work', 'cycle', to_jsonb(v_cycle));  -- still running; continuation required
  end if;

  if v_src_fail = 0 and v_rep_fail = 0 then
    v_new_status := 'succeeded';
  elsif v_src_ok = 0 and v_rep_ok = 0 then
    v_new_status := 'failed';
  else
    v_new_status := 'partial';
  end if;

  update public.sync_cycles
     set status = v_new_status,
         finished_at = now(),
         source_total = v_src_total, source_succeeded = v_src_ok, source_failed = v_src_fail,
         report_total = v_rep_total, report_succeeded = v_rep_ok, report_failed = v_rep_fail
   where id = p_cycle_id and status = 'running'
   returning * into v_cycle;
  if not found then
    return jsonb_build_object('disposition', 'invalid-status', 'cycle', null);  -- unreachable under FOR UPDATE; fail closed
  end if;
  return jsonb_build_object('disposition', 'finalized', 'cycle', to_jsonb(v_cycle));
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. reject_append_to_terminal_cycle -- forbid cycle_id changes + missing/terminal parents.
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
  -- A child row's cycle_id is IMMUTABLE: forbid moving a row between cycles (so a row can never be moved OUT of
  -- a terminal cycle, nor INTO one). Checked before the parent lookup so a mutation attempt fails outright.
  if TG_OP = 'UPDATE' and NEW.cycle_id is distinct from OLD.cycle_id then
    raise exception 'child row cycle_id is immutable (% -> %); refusing to move it between cycles', OLD.cycle_id, NEW.cycle_id
      using errcode = 'raise_exception';
  end if;
  -- FOR SHARE serializes against finalize_sync_cycle's FOR UPDATE: if a finalize is committing, this blocks
  -- until it commits and then sees the (now terminal) status.
  select status into v_status from public.sync_cycles where id = NEW.cycle_id for share;
  if not found then
    raise exception 'parent sync cycle % not found; refusing to append/alter child work', NEW.cycle_id
      using errcode = 'raise_exception';
  end if;
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
revoke all on function public.finalize_sync_cycle(uuid) from public, anon, authenticated;
grant execute on function public.finalize_sync_cycle(uuid) to service_role;
