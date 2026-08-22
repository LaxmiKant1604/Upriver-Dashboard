-- Scheduler v2 -- UNLIMITED one-batch-per-US/Non-US-family assignment (PREPARED -- UNAPPLIED).
--
-- >>> DO NOT APPLY via `npm run db:migrate` or any bulk apply. FROZEN; applied ONLY via the reviewed
-- >>> single-file Gate (apply-one-migration.mjs) after approval, exactly like the other Scheduler-v2 migrations.
--
-- WHY: DataDoe confirmed IN WRITING that any number of sellerOrVendorIds may be included in ONE export (mixed
-- marketplaces safe; only a 5,000,000-row cap). The prior durable assign_source_account_batch RPC hard-capped
-- each family to <=5 accounts (least(greatest(coalesce(p_max,5),1),5)), which would split one bucket into many
-- exports. This ADDITIVE forward migration replaces ONLY that RPC with a one-batch-per-family assignment. It
-- changes no already-recorded migration, stores no secret, and enables nothing by itself. (The flat 2-token
-- cost is enforced in the app -- sourceTokenCost always reserves 2 -- inside the existing permissive
-- source_tranche_budget_hash.token_cost in (2,5) check from 20260818, which is left UNCHANGED so no earlier
-- migration's recorded catalog is disturbed.) Historical source_batch_membership rows created under the old
-- policy live under a DIFFERENT (policy-versioned) family key and are never reinterpreted; this only changes
-- how NEW assignments are shaped.

-- ---------------------------------------------------------------------------
-- 1. assign_source_account_batch -> ONE canonical batch (index 0) per family, no <=5 cap. Same signature
--    (p_max retained for call-site back-compat, now IGNORED). Keeps the per-family advisory lock and the
--    existing-scope (connection/organization) match that rejects a re-home with NO mutation.
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
  v_conn text;
  v_org text;
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

  select connection_id, organization_fingerprint
    into v_conn, v_org
    from public.source_batch_membership
   where batch_family = p_batch_family and account_id = p_account_id;
  if found then
    -- An existing membership is reused ONLY when its stored scope exactly matches the supplied canonical
    -- connection/organization. A mismatch is an identity error, not a silent re-home: raise WITHOUT mutating.
    if v_conn is distinct from p_connection_id or v_org is distinct from p_organization_fingerprint then
      raise exception 'assign_source_account_batch: existing membership for account % in family % has a different connection/organization scope; refusing (no mutation)', p_account_id, p_batch_family;
    end if;
    return 0;
  end if;

  -- ONE batch per family: any number of sellers may share one export, so every compatible account joins the
  -- single canonical batch index 0. (p_max is ignored; there is no <=5 cap and no multi-batch assignment.)
  insert into public.source_batch_membership
    (batch_family, account_id, batch_index, connection_id, organization_fingerprint)
  values
    (p_batch_family, p_account_id, 0, p_connection_id, p_organization_fingerprint);

  return 0;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. DATABASE-ENFORCED flat 2-token cost. The recorded permissive check source_tranche_budget_hash_cost_check
--    in (2, 5) from 20260818 is left UNCHANGED (no earlier migration's catalog is disturbed). Instead an
--    ADDITIVE second named constraint whose intersection with (2,5) requires token_cost = 2 rejects any stale
--    caller or direct service-role insert/update of token_cost = 5. Fail closed FIRST if any existing row
--    already carries token_cost <> 2 (never silently rewrite such a row).
-- ---------------------------------------------------------------------------
do $$
declare v_bad integer;
begin
  select count(*) into v_bad from public.source_tranche_budget_hash where token_cost is distinct from 2;
  if v_bad > 0 then
    raise exception 'FLAT_TOKEN_MIGRATION_BLOCKED: % existing source_tranche_budget_hash row(s) carry token_cost <> 2; refusing to add the flat-2 constraint (no silent rewrite)', v_bad;
  end if;
end $$;

alter table public.source_tranche_budget_hash
  add constraint source_tranche_budget_hash_cost_flat2 check (token_cost = 2);

-- ---------------------------------------------------------------------------
-- 3. Harden persist_source_tranche_budget: reject any caller-supplied per-hash token_cost other than integer 2
--    BEFORE any mutation (defense in depth beside the DB constraint; a stale premium caller can never reserve).
--    Otherwise byte-identical to 20260818 (idempotent freeze; PLAN_BUDGET_MISMATCH on plan/pricing drift).
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
  v_bad integer;
begin
  if coalesce(btrim(p_tranche_key), '') = '' or coalesce(btrim(p_plan_fingerprint), '') = '' then
    raise exception 'persist_source_tranche_budget requires a non-blank tranche_key and plan_fingerprint';
  end if;

  -- FLAT 2-token cost: reject any per-hash token_cost that is not integer 2 BEFORE any mutation.
  select count(*) into v_bad
    from jsonb_array_elements(coalesce(p_hashes, '[]'::jsonb)) as h
   where (h->>'token_cost') is distinct from '2';
  if v_bad > 0 then
    raise exception 'FLAT_TOKEN_COST_REQUIRED: every export costs exactly 2 AI tokens; % supplied per-hash cost(s) are not 2; refusing (no mutation)', v_bad;
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
