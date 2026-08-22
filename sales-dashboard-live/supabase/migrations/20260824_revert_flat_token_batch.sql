-- Scheduler v2 -- FORWARD CORRECTION of 20260823. DataDoe hard-caps sellerOrVendorIds at 5 per export and
-- prices exports standard=2 / premium=5 (BOTH empirically confirmed 2026-08-22: a real 8-seller create
-- returned HTTP 400 "sellerOrVendorIds must contain no more than 5 elements"; GET /usage-logs shows the OLI
-- export cost 2 with specificUsageType EXPORTS_API_STANDARD, and FBA Inventory Health is premium=5). The
-- "unlimited sellers / flat 2 tokens" claims behind 20260823 were false. This migration UNDOES 20260823
-- (forward-only; an applied migration is never un-applied):
--   1. drops the additive flat-2 token constraint (the permissive (2,5) constraint from 20260818 remains, so
--      premium exports at 5 tokens are valid again);
--   2. restores the <=5 multi-batch assign_source_account_batch body (identical to 20260817);
--   3. restores the variable-cost persist_source_tranche_budget body (identical to 20260818).
-- Both target objects predate 20260823, so createdNew:false. No table/column changes; protected data untouched.

-- ---------------------------------------------------------------------------
-- Section 1: drop the flat-2 token constraint added by 20260823 (premium exports legitimately cost 5 tokens).
-- ---------------------------------------------------------------------------
alter table public.source_tranche_budget_hash
  drop constraint if exists source_tranche_budget_hash_cost_flat2;

-- ---------------------------------------------------------------------------
-- Section 2: restore the <=5 multi-batch assignment RPC (byte-identical to 20260817). p_max is hard-capped to
-- 1..5; a new account is placed into the smallest-index batch with < p_max members, or a fresh batch when all
-- are full; an existing membership is reused only when its stored connection/organization scope matches.
-- ---------------------------------------------------------------------------
create or replace function public.assign_source_account_batch(
  p_batch_family text,
  p_account_id text,
  p_connection_id text,
  p_organization_fingerprint text,
  p_max integer default 5
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_index integer;
  v_conn text;
  v_org text;
  v_max integer := least(greatest(coalesce(p_max, 5), 1), 5);
begin
  if coalesce(btrim(p_batch_family), '') = '' or coalesce(btrim(p_account_id), '') = '' then
    raise exception 'assign_source_account_batch requires non-blank batch_family and account_id';
  end if;
  if p_connection_id is null or p_connection_id not in ('primary', 'dd-secondary') then
    raise exception 'assign_source_account_batch requires connection_id primary|dd-secondary';
  end if;
  if coalesce(btrim(p_organization_fingerprint), '') = '' then
    raise exception 'assign_source_account_batch requires a non-blank organization_fingerprint';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_batch_family));

  select batch_index, connection_id, organization_fingerprint
    into v_index, v_conn, v_org
    from public.source_batch_membership
   where batch_family = p_batch_family and account_id = p_account_id;
  if found then
    if v_conn is distinct from p_connection_id or v_org is distinct from p_organization_fingerprint then
      raise exception 'assign_source_account_batch: existing membership for account % in family % has a different connection/organization scope; refusing (no mutation)', p_account_id, p_batch_family;
    end if;
    return v_index;
  end if;

  select bi into v_index
    from (
      select batch_index as bi, count(*) as c
        from public.source_batch_membership
       where batch_family = p_batch_family
       group by batch_index
    ) t
   where c < v_max
   order by bi
   limit 1;

  if v_index is null then
    select coalesce(max(batch_index) + 1, 0) into v_index
      from public.source_batch_membership
     where batch_family = p_batch_family;
  end if;

  insert into public.source_batch_membership
    (batch_family, account_id, batch_index, connection_id, organization_fingerprint)
  values
    (p_batch_family, p_account_id, v_index, p_connection_id, p_organization_fingerprint);

  return v_index;
end;
$$;

revoke all on function public.assign_source_account_batch(text, text, text, text, integer) from public, anon, authenticated;
grant execute on function public.assign_source_account_batch(text, text, text, text, integer) to service_role;

-- ---------------------------------------------------------------------------
-- Section 3: restore the variable-cost frozen-budget persist RPC (byte-identical to 20260818). The per-hash
-- token_cost is inserted verbatim (2 for standard, 5 for premium), validated only by the permissive
-- source_tranche_budget_hash_cost_check (token_cost in (2, 5)) constraint.
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

revoke all on function public.persist_source_tranche_budget(uuid, text, text, integer, integer, jsonb) from public, anon, authenticated;
grant execute on function public.persist_source_tranche_budget(uuid, text, text, integer, integer, jsonb) to service_role;
