-- ===========================================================================
-- Scheduler v2 — FROZEN per-(cycle, tranche) create-export + AI-token budget
-- ===========================================================================
--
-- ADDITIVE + IDEMPOTENT. Adds TWO tables and TWO RPCs. Changes no existing table,
-- stores no secret. Repeated execution is safe. PREPARED, UNAPPLIED.
--
-- WHY (Blocker 4d): a tranche's create-export count AND AI-token cost must be FROZEN
-- before any DataDoe POST and enforced ATOMICALLY. A standard source export costs 2
-- AI tokens, a premium one 5 (never a blanket exports*2). Every create-export first
-- reserves against the durable budget: only the reservation winner may POST, the
-- ceilings can never be exceeded even by concurrent workers, and a continuation loads
-- the SAME frozen budget and rejects any plan/pricing drift.
--
-- LEAST PRIVILEGE: service_role may only SELECT both tables. ALL writes go through the
-- two SECURITY DEFINER RPCs, so no direct service-role write can bypass the ceilings.
--
-- DEADLOCK-SAFE LOCK ORDER: reserve_source_export_create locks
--   (1) public.source_tranche_budget (the budget row) FOR UPDATE, THEN
--   (2) public.sync_source_jobs      (the per-cycle source job) via the conditional UPDATE's row lock.
-- It is the ONLY function locking BOTH; the single consistent order means no lock cycle.

create table if not exists public.source_tranche_budget (
  cycle_id uuid not null,
  tranche_key text not null,
  plan_fingerprint text not null
    constraint source_tranche_budget_fingerprint_nonblank check (char_length(btrim(plan_fingerprint)) > 0),
  max_creates integer not null
    constraint source_tranche_budget_max_creates_nonneg check (max_creates >= 0),
  max_tokens integer not null
    constraint source_tranche_budget_max_tokens_nonneg check (max_tokens >= 0),
  spent_creates integer not null default 0
    constraint source_tranche_budget_spent_creates_bounded check (spent_creates >= 0 and spent_creates <= max_creates),
  spent_tokens integer not null default 0
    constraint source_tranche_budget_spent_tokens_bounded check (spent_tokens >= 0 and spent_tokens <= max_tokens),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint source_tranche_budget_pk primary key (cycle_id, tranche_key)
);

drop trigger if exists source_tranche_budget_touch on public.source_tranche_budget;
create trigger source_tranche_budget_touch before update on public.source_tranche_budget
  for each row execute function public.touch_updated_at();

create table if not exists public.source_tranche_budget_hash (
  cycle_id uuid not null,
  tranche_key text not null,
  request_hash text not null,
  token_cost integer not null
    constraint source_tranche_budget_hash_cost_check check (token_cost in (2, 5)),
  constraint source_tranche_budget_hash_pk primary key (cycle_id, tranche_key, request_hash),
  constraint source_tranche_budget_hash_budget_fk foreign key (cycle_id, tranche_key)
    references public.source_tranche_budget (cycle_id, tranche_key)
);
create index if not exists source_tranche_budget_hash_budget_idx
  on public.source_tranche_budget_hash (cycle_id, tranche_key);

-- ---------------------------------------------------------------------------
-- persist_source_tranche_budget — freeze the budget for (cycle, tranche) ONCE.
-- Idempotent: an existing row for the same (cycle, tranche) MUST carry the SAME
-- plan_fingerprint / max_creates / max_tokens, else a continuation drifted the plan
-- and it raises PLAN_BUDGET_MISMATCH (no mutation). A fresh (cycle, tranche) inserts
-- the budget + its per-hash costs from p_hashes (a jsonb array of
-- { "request_hash": text, "token_cost": int }). Returns 'created' | 'exists'.
-- ---------------------------------------------------------------------------
create or replace function public.persist_source_tranche_budget(
  p_cycle_id uuid,
  p_tranche_key text,
  p_plan_fingerprint text,
  p_max_creates integer,
  p_max_tokens integer,
  p_hashes jsonb
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.source_tranche_budget%rowtype;
begin
  if coalesce(btrim(p_tranche_key), '') = '' or coalesce(btrim(p_plan_fingerprint), '') = '' then
    raise exception 'persist_source_tranche_budget requires a non-blank tranche_key and plan_fingerprint';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_cycle_id::text || '|' || p_tranche_key));

  select * into v_row
    from public.source_tranche_budget
   where cycle_id = p_cycle_id and tranche_key = p_tranche_key
   for update;
  if found then
    if v_row.plan_fingerprint is distinct from p_plan_fingerprint
       or v_row.max_creates is distinct from p_max_creates
       or v_row.max_tokens is distinct from p_max_tokens then
      raise exception 'PLAN_BUDGET_MISMATCH: frozen tranche budget for cycle % tranche % differs from the continuation plan; refusing (no mutation)', p_cycle_id, p_tranche_key;
    end if;
    return 'exists';
  end if;

  insert into public.source_tranche_budget
    (cycle_id, tranche_key, plan_fingerprint, max_creates, max_tokens)
  values
    (p_cycle_id, p_tranche_key, p_plan_fingerprint, p_max_creates, p_max_tokens);

  insert into public.source_tranche_budget_hash (cycle_id, tranche_key, request_hash, token_cost)
  select p_cycle_id, p_tranche_key, (h->>'request_hash'), (h->>'token_cost')::integer
    from jsonb_array_elements(coalesce(p_hashes, '[]'::jsonb)) as h;

  return 'created';
end;
$$;

-- ---------------------------------------------------------------------------
-- reserve_source_export_create — the ATOMIC pre-POST reservation. Immediately before
-- a create-export POST, in ONE transaction it: locks the tranche budget row FOR UPDATE
-- (deadlock-safe order), proves the plan fingerprint matches (no drift), proves this
-- request_hash belongs to the frozen plan (and reads its token cost), proves
-- spent_creates+1 <= max_creates AND spent_tokens+cost <= max_tokens, then CLAIMS the
-- still pending/unattempted source job (mutually exclusive with cache adoption) and
-- reserves the create + token cost. Only the winner ('reserved') may POST. Returns a
-- TYPED acknowledgement: 'reserved' | 'not-pending' | 'plan-mismatch' | 'budget-exceeded'.
-- No reservation is ever released after the job has been claimed (the POST is committed
-- to happen). Cache adoption and a saved-export_id resume spend ZERO here (they never call it).
-- ---------------------------------------------------------------------------
create or replace function public.reserve_source_export_create(
  p_cycle_id uuid,
  p_tranche_key text,
  p_request_hash text,
  p_plan_fingerprint text
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_budget public.source_tranche_budget%rowtype;
  v_cost integer;
  v_updated integer;
begin
  perform pg_advisory_xact_lock(hashtext(p_cycle_id::text || '|' || p_tranche_key));

  -- (1) LOCK the budget row FIRST (deadlock-safe order).
  select * into v_budget
    from public.source_tranche_budget
   where cycle_id = p_cycle_id and tranche_key = p_tranche_key
   for update;
  if not found then
    raise exception 'reserve_source_export_create: no frozen budget for cycle % tranche %', p_cycle_id, p_tranche_key;
  end if;

  -- (2) Plan-fingerprint match (no drift) and (3) request_hash belongs to the frozen plan (+ its cost).
  if v_budget.plan_fingerprint is distinct from p_plan_fingerprint then
    return 'plan-mismatch';
  end if;
  select token_cost into v_cost
    from public.source_tranche_budget_hash
   where cycle_id = p_cycle_id and tranche_key = p_tranche_key and request_hash = p_request_hash;
  if not found then
    return 'plan-mismatch';
  end if;

  -- (4) Ceilings: neither the create count nor the token cost may be exceeded.
  if v_budget.spent_creates + 1 > v_budget.max_creates
     or v_budget.spent_tokens + v_cost > v_budget.max_tokens then
    return 'budget-exceeded';
  end if;

  -- (5) CLAIM the source job (still pending/unattempted/count=0) -- mutually exclusive with adoption and the
  --     legacy claim; only ONE transition off 'pending' can win. NO create is reserved if the claim is lost.
  update public.sync_source_jobs
     set attempted_at = now(),
         create_export_count = create_export_count + 1,
         fetch_status = 'attempted',
         updated_at = now()
   where cycle_id = p_cycle_id
     and request_hash = p_request_hash
     and fetch_status = 'pending'
     and attempted_at is null
     and create_export_count = 0;
  get diagnostics v_updated = row_count;
  if v_updated <> 1 then
    return 'not-pending';
  end if;

  -- (6) RESERVE the create + token cost. Never released after the claim above.
  update public.source_tranche_budget
     set spent_creates = spent_creates + 1,
         spent_tokens = spent_tokens + v_cost,
         updated_at = now()
   where cycle_id = p_cycle_id and tranche_key = p_tranche_key;

  return 'reserved';
end;
$$;

alter table public.source_tranche_budget enable row level security;
drop policy if exists "admins read source tranche budget" on public.source_tranche_budget;
create policy "admins read source tranche budget" on public.source_tranche_budget
  for select to authenticated using (public.is_dashboard_admin());
alter table public.source_tranche_budget_hash enable row level security;
drop policy if exists "admins read source tranche budget hash" on public.source_tranche_budget_hash;
create policy "admins read source tranche budget hash" on public.source_tranche_budget_hash
  for select to authenticated using (public.is_dashboard_admin());

-- Least-privilege ACL: strip the Supabase default-privilege ALL grant, then grant SELECT ONLY to
-- service_role. Every write goes through the SECURITY DEFINER RPCs, so no direct service-role write can
-- bypass the frozen ceilings.
revoke all on table public.source_tranche_budget from public, anon, authenticated, service_role;
grant select on table public.source_tranche_budget to service_role;
revoke all on table public.source_tranche_budget_hash from public, anon, authenticated, service_role;
grant select on table public.source_tranche_budget_hash to service_role;
revoke all on function public.persist_source_tranche_budget(uuid, text, text, integer, integer, jsonb) from public, anon, authenticated;
grant execute on function public.persist_source_tranche_budget(uuid, text, text, integer, integer, jsonb) to service_role;
revoke all on function public.reserve_source_export_create(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.reserve_source_export_create(uuid, text, text, text) to service_role;
