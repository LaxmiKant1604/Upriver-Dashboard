-- ===========================================================================
-- "Publish from saved data" -- the durable USER-REQUEST queue (one exact report scope per request)
-- ===========================================================================
--
-- ADDITIVE + IDEMPOTENT. Adds ONE control row, ONE request table and SIX SECURITY DEFINER RPCs. Changes NO existing
-- table / column / constraint / RPC / trigger / writer fence, and stores no secret. With the control row DISABLED
-- (the default at apply) nothing can be enqueued or claimed: the dashboard shows no working action and no worker
-- publishes -- so applying this migration changes NO production behaviour on its own.
--
-- WHY A NEW TABLE (not a reuse). The two existing queues have the wrong grain and are claimed by live consumers:
--   - report_publication_outbox (20260932) is SOURCE-grained (org, connection, account, source_key) and its claim has
--     no kind filter -- the LIVE OLI outbox drain would claim a Brand View request as OLI work;
--   - publication_recovery_jobs (20260934) coalesces by (route, region, target, as_of) for the observer, supersedes any
--     as_of older than UTC D-1, and its claim has no origin filter -- the recovery worker and this worker would claim
--     each other's jobs. Reusing either needs a semantic change to a LIVE claim RPC; this table needs none.
--
-- FLOW. The dashboard (Vercel, a SHORT request) authorizes the user for the exact scope, checks the dashboard-served
-- row, and calls enqueue_publish_request (deduplicated). ONE executor process claims ONE request at a time with a
-- lease (claim_publish_request), renews it while it works (renew_publish_request), runs the EXISTING zero-export
-- route release + fenced publisher for exactly that scope, reads the served row back, and records the outcome
-- (finish_publish_request, bound to its claim token). A crashed executor's lease expires and the request is re-claimed
-- (attempt + 1); the release's own resume/already-current proofs make a re-run safe. The executor never holds a
-- lease row here while idle; the global control-plane lease is a SEPARATE object with its own short TTL.
--
-- SECURITY. RLS on, no policies; ALL privileges revoked from public / anon / authenticated / service_role, then
-- SELECT only to service_role (the dashboard reads a request's status server-side). Every write goes through the
-- SECURITY DEFINER RPCs (fixed search_path), EXECUTE granted to service_role only. The browser never talks to this
-- table: the Vercel endpoint authorizes the account + brand first.

-- 1) CONTROL (single row). enabled=false at apply. report_keys = the reports activated for requests; a NON-EMPTY
--    canary_scope_keys restricts requests to exactly those scopes (the one-scope-first rollout). Disable = one UPDATE.
create table if not exists public.publish_request_control (
  id boolean primary key default true constraint publish_request_control_singleton check (id = true),
  enabled boolean not null default false,
  report_keys text[] not null default '{}'::text[] constraint prc_report_keys_bound check (cardinality(report_keys) <= 16),
  canary_scope_keys text[] not null default '{}'::text[] constraint prc_canary_bound check (cardinality(canary_scope_keys) <= 50),
  max_active integer not null default 20 constraint prc_max_active_check check (max_active between 1 and 200),
  per_user_hourly integer not null default 20 constraint prc_per_user_check check (per_user_hourly between 1 and 500),
  worker_seen_at timestamptz,
  worker_state text constraint prc_worker_state_len check (worker_state is null or char_length(worker_state) <= 120),
  note text constraint prc_note_len check (note is null or char_length(note) <= 240),
  updated_at timestamptz not null default now()
);
insert into public.publish_request_control (id, enabled) values (true, false) on conflict (id) do nothing;

-- 2) REQUESTS. scope_key = the exact report scope WITHOUT the date ('brand-view|<account>|<brand key>'); as_of = the
--    identity date the dashboard serves. At most ONE active (queued / publishing) request per (report, scope, as_of).
create table if not exists public.publish_requests (
  id uuid primary key default gen_random_uuid(),
  report_key text not null constraint pr_report_key_check check (report_key ~ '^[a-z][a-z0-9-]{1,39}$'),
  scope_key text not null constraint pr_scope_key_check check (char_length(scope_key) between 3 and 400),
  account_id text not null constraint pr_account_check check (account_id ~ '^[A-Za-z0-9._-]{1,120}$'),
  brand text constraint pr_brand_check check (brand is null or char_length(brand) between 1 and 200),
  as_of date not null,
  status text not null default 'queued'
    constraint pr_status_check check (status in ('queued','publishing','published','already_current','missing_evidence','failed')),
  reason text constraint pr_reason_len check (reason is null or char_length(reason) <= 240),
  requested_by text not null constraint pr_requested_by_check check (char_length(requested_by) between 1 and 120),
  request_count integer not null default 1 constraint pr_request_count_check check (request_count >= 1),
  last_requested_by text constraint pr_last_requested_by_check check (last_requested_by is null or char_length(last_requested_by) <= 120),
  last_requested_at timestamptz not null default now(),
  attempts integer not null default 0 constraint pr_attempts_check check (attempts >= 0),
  max_attempts integer not null default 6 constraint pr_max_attempts_check check (max_attempts between 1 and 20),
  claim_token uuid,
  claimed_by text constraint pr_claimed_by_len check (claimed_by is null or char_length(claimed_by) <= 120),
  claimed_at timestamptz,
  lease_expires_at timestamptz,
  next_attempt_at timestamptz not null default now(),
  run_token text constraint pr_run_token_check check (run_token is null or run_token ~ '^[A-Za-z0-9._:-]{8,150}$'),
  prior_run_token text constraint pr_prior_run_token_check check (prior_run_token is null or prior_run_token ~ '^[A-Za-z0-9._:-]{8,150}$'),
  result jsonb constraint pr_result_size check (result is null or octet_length(result::text) <= 4096),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz,
  constraint pr_claim_consistent check ((status = 'publishing') = (claim_token is not null and lease_expires_at is not null))
);
create unique index if not exists publish_requests_active_uq on public.publish_requests (report_key, scope_key, as_of)
  where status in ('queued','publishing');
create index if not exists publish_requests_scope_idx on public.publish_requests (report_key, scope_key, created_at desc);
create index if not exists publish_requests_due_idx on public.publish_requests (next_attempt_at) where status = 'queued';
create index if not exists publish_requests_lease_idx on public.publish_requests (lease_expires_at) where status = 'publishing';
create index if not exists publish_requests_user_idx on public.publish_requests (requested_by, created_at desc);

alter table public.publish_request_control enable row level security;
alter table public.publish_requests enable row level security;
revoke all on table public.publish_request_control from public, anon, authenticated, service_role;
revoke all on table public.publish_requests from public, anon, authenticated, service_role;
grant select on table public.publish_request_control to service_role;
grant select on table public.publish_requests to service_role;

-- 3) ENQUEUE (deduplicated). -> jsonb { outcome, id?, status? }. outcome:
--    'enqueued' | 'deduplicated' (an active request for the exact scope + date exists: its request_count is bumped
--    and ITS id is returned -- every viewer follows the same request) | 'disabled' | 'report-not-enabled' |
--    'scope-not-enabled' (canary list non-empty and the scope is not in it) | 'rate-limited' | 'queue-full'.
create or replace function public.enqueue_publish_request(
  p_report_key text, p_scope_key text, p_account_id text, p_brand text, p_as_of date, p_requested_by text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  c public.publish_request_control%rowtype;
  existing public.publish_requests%rowtype;
  new_id uuid;
  recent integer;
  active integer;
begin
  if p_report_key is null or p_scope_key is null or p_account_id is null or p_as_of is null or p_requested_by is null
     or char_length(btrim(p_requested_by)) = 0 then
    raise exception 'enqueue_publish_request: missing argument';
  end if;
  perform pg_advisory_xact_lock(hashtext('publish_requests|' || p_report_key || '|' || p_scope_key || '|' || p_as_of::text));
  select * into c from public.publish_request_control where id = true;
  if not found or c.enabled is not true then return jsonb_build_object('outcome', 'disabled'); end if;
  if not (p_report_key = any (c.report_keys)) then return jsonb_build_object('outcome', 'report-not-enabled'); end if;
  if cardinality(c.canary_scope_keys) > 0 and not (p_scope_key = any (c.canary_scope_keys)) then
    return jsonb_build_object('outcome', 'scope-not-enabled');
  end if;
  select * into existing from public.publish_requests
    where report_key = p_report_key and scope_key = p_scope_key and as_of = p_as_of and status in ('queued','publishing')
    for update;
  if found then
    update public.publish_requests
       set request_count = request_count + 1, last_requested_by = p_requested_by, last_requested_at = now(), updated_at = now()
     where id = existing.id;
    return jsonb_build_object('outcome', 'deduplicated', 'id', existing.id, 'status', existing.status);
  end if;
  select count(*) into recent from public.publish_requests
    where requested_by = p_requested_by and created_at > now() - interval '1 hour';
  if recent >= c.per_user_hourly then return jsonb_build_object('outcome', 'rate-limited'); end if;
  select count(*) into active from public.publish_requests where status in ('queued','publishing');
  if active >= c.max_active then return jsonb_build_object('outcome', 'queue-full'); end if;
  insert into public.publish_requests (report_key, scope_key, account_id, brand, as_of, requested_by, last_requested_by)
    values (p_report_key, p_scope_key, p_account_id, nullif(btrim(coalesce(p_brand, '')), ''), p_as_of, p_requested_by, p_requested_by)
    returning id into new_id;
  return jsonb_build_object('outcome', 'enqueued', 'id', new_id, 'status', 'queued');
end;
$$;

-- 4) CLAIM exactly ONE due request (or none). A request whose lease EXPIRED is re-claimed (crash resume); a request that
--    has used max_attempts is closed 'failed' ('attempts-exhausted') instead of being claimed again. Returns the
--    claimed row as jsonb, or null. Also stamps control.worker_seen_at (at most once a minute) so the dashboard can say
--    honestly when no executor is running.
create or replace function public.claim_publish_request(p_worker text, p_claim_token uuid, p_lease_seconds integer)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  c public.publish_request_control%rowtype;
  r public.publish_requests%rowtype;
begin
  if p_worker is null or char_length(btrim(p_worker)) = 0 or char_length(p_worker) > 120 or p_claim_token is null then
    raise exception 'claim_publish_request: missing argument';
  end if;
  if p_lease_seconds is null or p_lease_seconds < 30 or p_lease_seconds > 900 then
    raise exception 'claim_publish_request: lease must be 30..900 seconds';
  end if;
  update public.publish_request_control set worker_seen_at = now()
    where id = true and (worker_seen_at is null or worker_seen_at < now() - interval '60 seconds');
  select * into c from public.publish_request_control where id = true;
  if not found or c.enabled is not true then return null; end if;
  -- Crash-loop guard: an expired lease on a request that already used every attempt is closed, never re-claimed.
  update public.publish_requests
     set status = 'failed', reason = left('attempts-exhausted:' || case when reason is null or reason like 'waiting:%' then 'lease-expired' else reason end, 240),
         claim_token = null, lease_expires_at = null, finished_at = now(), updated_at = now()
   where status = 'publishing' and lease_expires_at < now() and attempts >= max_attempts;
  -- ONE executor at a time, enforced here (a deploy overlap or an operator --once never runs a second job concurrently).
  if exists (select 1 from public.publish_requests where status = 'publishing' and lease_expires_at >= now()) then return null; end if;
  select * into r from public.publish_requests
   where ((status = 'queued' and next_attempt_at <= now()) or (status = 'publishing' and lease_expires_at < now()))
     and report_key = any (c.report_keys)
   order by (status = 'publishing') desc, next_attempt_at, created_at
   limit 1
   for update skip locked;
  if not found then return null; end if;
  update public.publish_requests
     set status = 'publishing', claim_token = p_claim_token, claimed_by = p_worker, claimed_at = now(),
         lease_expires_at = now() + make_interval(secs => p_lease_seconds), attempts = attempts + 1,
         prior_run_token = run_token,
         run_token = 'psr-' || replace(id::text, '-', '') || '-' || (attempts + 1)::text,
         updated_at = now()
   where id = r.id
   returning * into r;
  return to_jsonb(r);
end;
$$;

-- 5) RENEW the claim (the executor's heartbeat). -> true only while the caller still owns the claim.
create or replace function public.renew_publish_request(p_id uuid, p_claim_token uuid, p_lease_seconds integer)
returns boolean
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if p_lease_seconds is null or p_lease_seconds < 30 or p_lease_seconds > 900 then
    raise exception 'renew_publish_request: lease must be 30..900 seconds';
  end if;
  update public.publish_requests
     set lease_expires_at = now() + make_interval(secs => p_lease_seconds), updated_at = now()
   where id = p_id and status = 'publishing' and claim_token = p_claim_token;
  get diagnostics n = row_count;
  if n = 1 then
    update public.publish_request_control set worker_seen_at = now()
      where id = true and (worker_seen_at is null or worker_seen_at < now() - interval '60 seconds');
  end if;
  return n = 1;
end;
$$;

-- 6) FINISH (bound to the claim token). p_status:
--    terminal 'published' | 'already_current' | 'missing_evidence' | 'failed' -> recorded with reason + result;
--    'retry' -> back to 'queued' after p_retry_seconds (or 'failed' 'attempts-exhausted:<reason>' at max_attempts);
--    'release' -> back to 'queued' after p_retry_seconds WITHOUT consuming the attempt (the executor paused BEFORE any
--    work: disabled / database load / global lease held by another operation).
--    -> jsonb { outcome: 'finished' | 'requeued' | 'not-owner', status }.
create or replace function public.finish_publish_request(
  p_id uuid, p_claim_token uuid, p_status text, p_reason text, p_result jsonb, p_retry_seconds integer
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r public.publish_requests%rowtype;
  wait_s integer := greatest(10, least(coalesce(p_retry_seconds, 60), 3600));
begin
  if p_status not in ('published','already_current','missing_evidence','failed','retry','release') then
    raise exception 'finish_publish_request: bad status %', p_status;
  end if;
  select * into r from public.publish_requests where id = p_id for update;
  if not found or r.status <> 'publishing' or r.claim_token is distinct from p_claim_token then
    return jsonb_build_object('outcome', 'not-owner', 'status', coalesce(r.status, 'missing'));
  end if;
  if p_status in ('published','already_current','missing_evidence','failed') then
    update public.publish_requests
       set status = p_status, reason = left(p_reason, 240), result = p_result, claim_token = null, lease_expires_at = null,
           finished_at = now(), updated_at = now()
     where id = p_id;
    return jsonb_build_object('outcome', 'finished', 'status', p_status);
  end if;
  if p_status = 'retry' and r.attempts >= r.max_attempts then
    update public.publish_requests
       set status = 'failed', reason = left('attempts-exhausted:' || coalesce(p_reason, ''), 240), result = p_result,
           claim_token = null, lease_expires_at = null, finished_at = now(), updated_at = now()
     where id = p_id;
    return jsonb_build_object('outcome', 'finished', 'status', 'failed');
  end if;
  update public.publish_requests
     set status = 'queued', reason = left(p_reason, 240), result = coalesce(p_result, result), claim_token = null,
         lease_expires_at = null, next_attempt_at = now() + make_interval(secs => wait_s),
         attempts = case when p_status = 'release' then greatest(attempts - 1, 0) else attempts end,
         updated_at = now()
   where id = p_id;
  return jsonb_build_object('outcome', 'requeued', 'status', 'queued');
end;
$$;

-- 7) BEAT: the executor's liveness + what it is doing ('ready' | 'paused:<reason>'), written at most once a minute
--    unless the state changed. The dashboard shows it for a queued request (never "offline" while it only waits).
create or replace function public.publish_request_worker_beat(p_worker text, p_state text)
returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.publish_request_control
     set worker_seen_at = now(), worker_state = left(coalesce(p_state, ''), 120)
   where id = true
     and (worker_state is distinct from left(coalesce(p_state, ''), 120) or worker_seen_at is null or worker_seen_at < now() - interval '60 seconds');
end;
$$;

-- 8) TRIP: the executor's DURABLE safety stop (a blocked DataDoe request was attempted). Disables the whole feature;
--    only the owner re-enables it. A restarted executor claims nothing while disabled.
create or replace function public.trip_publish_request_control(p_reason text)
returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.publish_request_control
     set enabled = false, note = left('TRIPPED: ' || coalesce(p_reason, ''), 240), worker_state = 'tripped', updated_at = now()
   where id = true;
end;
$$;

revoke all on function public.enqueue_publish_request(text, text, text, text, date, text) from public, anon, authenticated;
revoke all on function public.claim_publish_request(text, uuid, integer) from public, anon, authenticated;
revoke all on function public.renew_publish_request(uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.finish_publish_request(uuid, uuid, text, text, jsonb, integer) from public, anon, authenticated;
grant execute on function public.enqueue_publish_request(text, text, text, text, date, text) to service_role;
grant execute on function public.claim_publish_request(text, uuid, integer) to service_role;
grant execute on function public.renew_publish_request(uuid, uuid, integer) to service_role;
grant execute on function public.finish_publish_request(uuid, uuid, text, text, jsonb, integer) to service_role;
revoke all on function public.publish_request_worker_beat(text, text) from public, anon, authenticated;
revoke all on function public.trip_publish_request_control(text) from public, anon, authenticated;
grant execute on function public.publish_request_worker_beat(text, text) to service_role;
grant execute on function public.trip_publish_request_control(text) to service_role;
