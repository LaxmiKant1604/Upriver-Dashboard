-- ===========================================================================
-- P0 convergence -- DR2 TRANSACTIONAL OUTBOX: enqueue publication work on source persist
-- ===========================================================================
--
-- ADDITIVE + IDEMPOTENT. Adds ONE gate table, ONE outbox table, ONE trigger, and THREE RPCs.
-- Changes NO existing table/column/constraint/RPC; stores no secret. Backward compatible: with the
-- gate DISABLED (default) the trigger is a no-op and nothing enqueues, so the healthy scheduled
-- persist path is byte-identical; the periodic poll reconciler remains the sole publisher.
--
-- WHY. Publication is POLL-driven today: the once-daily zero-export reconciler examines EVERY account
-- and re-derives+publishes those whose durable OLI advanced past their live snapshot. There is NO
-- transactional OUTBOX -- a persisted advance waits for the next poll and relies on the poll's staleness
-- scan. DR2: atomically ENQUEUE publication work for an account WHEN its OLI source persists, in the SAME
-- DB transaction as the durable write, so an advance is enqueued IFF it commits (never lost, never phantom)
-- and can be drained with LOW LATENCY by the existing reconciler.
--
-- THE ATOMIC SEAM. replace_oli_dimensional_window (the SECURITY DEFINER RPC that replaces the OLI
-- dimensional history + daily rollup + order audit + operational units AND upserts source_coverage) writes
-- source_coverage EXACTLY ONCE per (org, connection, account, 'order-line-items', window) inside its one
-- transaction. An AFTER INSERT OR UPDATE trigger on source_coverage therefore enqueues in that SAME
-- transaction -- a TRUE transactional outbox with ZERO change to the persist RPC.
--
-- SOURCE-GRAINED (one live row per (org,conn,account,source)) matches the reconciler's ACCOUNT-ATOMIC
-- derive (it re-derives all 3 OLI-dependent dashboards for the account in one pass). The drain runs the
-- SAME reconciler for the enqueued account; the report_snapshots freshness CAS makes a re-drain of an
-- already-current account a no-op, so the outbox is at-least-once + idempotent.
--
-- SAFETY: fail-soft trigger (any defect -> NOT enqueued, NEVER rolls back the persist); GATED (default
-- OFF) for expand-first rollout; SECURITY DEFINER + fixed search_path + service_role only + RLS; the
-- claim is a FOR UPDATE SKIP LOCKED lease (concurrency-safe, at-least-once, crash-reclaimed); a poison row
-- dead-letters after a max attempt cap; NEVER a paid DataDoe export (the drain reuses the zero-export reconciler).

-- 1) GATE (expand-first kill-switch). Single row; enabled=false at first apply. UPDATE ... enabled=true to
--    turn the outbox ON after canary validation; back to false = instant revert to poll-only (trigger no-ops).
create table if not exists public.publication_outbox_control (
  id boolean primary key default true constraint publication_outbox_control_singleton check (id = true),
  enabled boolean not null default false,
  updated_at timestamptz not null default now()
);
insert into public.publication_outbox_control (id, enabled) values (true, false)
  on conflict (id) do nothing;

-- 2) OUTBOX table. Exactly ONE live (un-drained, un-dead-lettered) row per (org,conn,account,source_key),
--    coalescing bursts of persists via the partial unique index.
create table if not exists public.report_publication_outbox (
  id uuid primary key default gen_random_uuid(),
  organization_fingerprint text not null constraint rpo_org_nonblank check (char_length(btrim(organization_fingerprint)) > 0),
  connection_id text not null default 'primary' constraint rpo_conn_check check (connection_id in ('primary','dd-secondary')),
  account_id text not null constraint rpo_account_nonblank check (char_length(btrim(account_id)) > 0),
  source_key text not null constraint rpo_source_nonblank check (char_length(btrim(source_key)) > 0),
  requested_as_of date not null,             -- = source_coverage.covered_to of the persisted window
  source_refreshed_at timestamptz,           -- persist freshness watermark (ordering + observability)
  status text not null default 'pending' constraint rpo_status_check check (status in ('pending','claimed','done','dead-letter')),
  attempts integer not null default 0 constraint rpo_attempts_nonneg check (attempts >= 0),
  claim_token text,
  claimed_at timestamptz,
  drained_at timestamptz,
  dead_lettered_at timestamptz,
  last_error text,
  enqueued_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- IDEMPOTENCY: one LIVE row per account+source (a repeat persist coalesces via upsert, never a duplicate backlog).
create unique index if not exists report_publication_outbox_live_uq
  on public.report_publication_outbox (organization_fingerprint, connection_id, account_id, source_key)
  where status in ('pending','claimed');
-- Cheap drain scan: claimable rows, oldest first.
create index if not exists report_publication_outbox_claimable_idx
  on public.report_publication_outbox (enqueued_at)
  where status in ('pending','claimed');

-- 3) ENQUEUE trigger -- fires INSIDE the persist transaction. FAIL-SOFT: any defect degrades to "not
--    enqueued" (the periodic poll backstop still converges) and can NEVER roll back the persist.
create or replace function public.enqueue_report_publication_on_coverage()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_enabled boolean;
begin
  begin
    -- GATE: only when explicitly enabled, and ONLY the OLI source (the sole source that writes this table
    -- and whose advance drives the live OLI-dependent dashboards). Other coverage writers are unaffected.
    if NEW.source_key <> 'order-line-items' then return null; end if;
    select enabled into v_enabled from public.publication_outbox_control where id = true;
    if v_enabled is not true then return null; end if;

    insert into public.report_publication_outbox
      (organization_fingerprint, connection_id, account_id, source_key, requested_as_of, source_refreshed_at, status, enqueued_at, updated_at)
    values (NEW.organization_fingerprint, NEW.connection_id, NEW.account_id, NEW.source_key, NEW.covered_to, NEW.source_refreshed_at, 'pending', now(), now())
    on conflict (organization_fingerprint, connection_id, account_id, source_key) where status in ('pending','claimed')
    do update set
      requested_as_of = greatest(public.report_publication_outbox.requested_as_of, excluded.requested_as_of),
      source_refreshed_at = greatest(coalesce(public.report_publication_outbox.source_refreshed_at, excluded.source_refreshed_at), excluded.source_refreshed_at),
      status = 'pending',                    -- re-arm a claimed row: a newer persist must be re-drained
      claim_token = null, claimed_at = null,
      enqueued_at = now(), updated_at = now();
  exception when others then
    -- FAIL-SOFT: never propagate -> never roll back the durable OLI persist. The backstop poll converges.
    return null;
  end;
  return null;
end;
$$;
drop trigger if exists source_coverage_enqueue_publication on public.source_coverage;
create trigger source_coverage_enqueue_publication
  after insert or update on public.source_coverage
  for each row execute function public.enqueue_report_publication_on_coverage();

-- 4) CLAIM (drain) -- concurrency-safe, at-least-once. FOR UPDATE SKIP LOCKED claims pending rows OR rows
--    whose lease expired (a crashed drainer's rows), bumps attempts, and DEAD-LETTERS a poison row that
--    exceeds p_max_attempts (isolated -- it never blocks the batch). Returns the claimed rows.
create or replace function public.claim_report_publication_outbox(
  p_limit integer,
  p_claim_token text,
  p_lease_seconds integer default 900,
  p_max_attempts integer default 8
)
returns setof public.report_publication_outbox
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(btrim(p_claim_token), '') = '' then
    raise exception 'claim_report_publication_outbox requires a non-blank claim token';
  end if;
  -- Dead-letter poison rows first (attempts already at the cap): isolate them out of the claimable set.
  update public.report_publication_outbox
     set status = 'dead-letter', dead_lettered_at = now(), claim_token = null, claimed_at = null, updated_at = now()
   where status in ('pending','claimed') and attempts >= p_max_attempts;

  return query
  update public.report_publication_outbox o
     set status = 'claimed', claim_token = p_claim_token, claimed_at = now(), attempts = o.attempts + 1, updated_at = now()
   where o.id in (
     select id from public.report_publication_outbox
      where status = 'pending'
         or (status = 'claimed' and claimed_at < now() - make_interval(secs => greatest(60, p_lease_seconds)))
      order by enqueued_at
      for update skip locked
      limit greatest(1, p_limit)
   )
  returning o.*;
end;
$$;

-- 5) COMPLETE -- mark a claimed row done, unless a NEWER persist re-armed it mid-flight (requested_as_of
--    advanced past what was drained) -> leave it pending for another drain. Owner-fenced by claim_token.
create or replace function public.complete_report_publication_outbox(
  p_id uuid,
  p_claim_token text,
  p_done_as_of date
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare v_req date;
begin
  select requested_as_of into v_req from public.report_publication_outbox
    where id = p_id and claim_token = p_claim_token and status = 'claimed' for update;
  if not found then
    return 'not-owner';
  end if;
  if p_done_as_of is not null and v_req > p_done_as_of then
    update public.report_publication_outbox
       set status = 'pending', claim_token = null, claimed_at = null, updated_at = now()
     where id = p_id;
    return 're-armed';
  end if;
  update public.report_publication_outbox
     set status = 'done', drained_at = now(), claim_token = null, claimed_at = null, updated_at = now()
   where id = p_id;
  return 'done';
end;
$$;

-- 6) RELEASE (defer) -- a drain that did NOT publish (deferred/failed this pass) releases its claim so the
--    row is re-claimable next pass (attempts already counted -> eventual dead-letter on a persistent poison).
create or replace function public.release_report_publication_outbox(
  p_id uuid,
  p_claim_token text,
  p_last_error text default null
)
returns text
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.report_publication_outbox
     set status = 'pending', claim_token = null, claimed_at = null,
         last_error = case when p_last_error is null then last_error else left(p_last_error, 500) end, updated_at = now()
   where id = p_id and claim_token = p_claim_token and status = 'claimed';
  if not found then return 'not-owner'; end if;
  return 'released';
end;
$$;

-- Least privilege: RLS on; service_role only for the table + RPCs; never anon/authenticated/public.
alter table public.report_publication_outbox enable row level security;
alter table public.publication_outbox_control enable row level security;
revoke all on table public.report_publication_outbox from public, anon, authenticated;
revoke all on table public.publication_outbox_control from public, anon, authenticated;
grant select, insert, update on table public.report_publication_outbox to service_role;
grant select, update on table public.publication_outbox_control to service_role;
revoke all on function public.enqueue_report_publication_on_coverage() from public, anon, authenticated;
revoke all on function public.claim_report_publication_outbox(integer, text, integer, integer) from public, anon, authenticated;
grant execute on function public.claim_report_publication_outbox(integer, text, integer, integer) to service_role;
revoke all on function public.complete_report_publication_outbox(uuid, text, date) from public, anon, authenticated;
grant execute on function public.complete_report_publication_outbox(uuid, text, date) to service_role;
revoke all on function public.release_report_publication_outbox(uuid, text, text) from public, anon, authenticated;
grant execute on function public.release_report_publication_outbox(uuid, text, text) to service_role;
