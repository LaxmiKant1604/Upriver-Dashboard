-- 20260922_account_onboarding_reconcile.sql
-- ADDITIVE + IDEMPOTENT. Adds ONE service-role-only SECURITY DEFINER RPC and NOTHING else. It does NOT alter the
-- account_onboarding table, its columns, or the account_onboarding_claim_coherent CHECK constraint (all untouched).
--
-- WHY (P0-D): the discovery worker computes each account's proposed onboarding row from a snapshot read of the
-- durable table. A concurrent claim_account_bootstrap can advance a row ready_for_bootstrap -> bootstrapping AFTER
-- discovery read it, so a plain merge-upsert of discovery's proposed status can REGRESS that row back to a pre-claim
-- status (losing the claim), and it also cannot re-check the CURRENT status under a lock. This RPC reconciles each
-- discovery row against the CURRENT, ROW-LOCKED durable status so:
--   * discovery-owned fields (name/marketplace/region/readiness/counts/ads/sources/failure_code/last_seen_at) are
--     always refreshed;
--   * the status is applied ONLY as a valid FORWARD transition -- CLAIM-OWNED statuses (bootstrapping, partially_ready,
--     ready) never regress; a proposed pre-claim status against a claim-owned current is a stale-read regression and
--     is REJECTED (current kept). A pre-claim current accepts the proposed status (readiness flaps are allowed there);
--   * claim-owned evidence (operation_id, bootstrap_started_at, first_discovered_at) is NEVER written/cleared, and
--     set-once timestamps (ready_at, bootstrap_completed_at) are preserved via COALESCE;
--   * brand-new accounts INSERT with first_discovered_at = now() and the proposed (never 'bootstrapping') status.
-- It is atomic + idempotent (a re-run with the same evidence is a no-op) and validates its input (fail closed).
-- This mirrors classifyOnboardingAccount's in-memory forward-grading, enforced against the locked durable status
-- (see resolveOnboardingForwardStatus in lib/server/sync/account-onboarding.js -- the parity reference).
--
-- Deploy ordering: the application code prefers this RPC and FALLS BACK to the existing grouped merge-upsert when the
-- function is absent, so the code is safe to deploy BEFORE this migration is applied. Applying it activates the
-- atomic path. Nothing here is destructive.

create or replace function public.reconcile_account_onboarding_discovery(p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_elem      jsonb;
  v_row       public.account_onboarding%rowtype;
  v_account   text;
  v_proposed  text;
  v_new_status text;
  v_inserted  int := 0;
  v_updated   int := 0;
  v_forward   int := 0;   -- proposed status accepted (claim-owned forward progression)
  v_rejected  int := 0;   -- proposed status REJECTED as a stale-read regression (current kept)
  v_rank_cur  int;
  v_rank_prop int;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'reconcile_account_onboarding_discovery requires a jsonb array of discovery rows';
  end if;

  for v_elem in select * from jsonb_array_elements(p_rows)
  loop
    v_account := btrim(coalesce(v_elem->>'account_id', ''));
    if v_account = '' or position(':' in v_account) > 0 then
      raise exception 'reconcile_account_onboarding_discovery: every row requires a PRIMARY (unprefixed) account_id';
    end if;
    v_proposed := coalesce(v_elem->>'status', '');
    if v_proposed not in ('discovered','waiting_for_datadoe','ready_for_bootstrap','bootstrapping','partially_ready','ready','blocked') then
      raise exception 'reconcile_account_onboarding_discovery: invalid proposed status "%" for %', v_proposed, v_account;
    end if;
    -- Discovery is NEVER the transition into 'bootstrapping' (only claim_account_bootstrap is). Refuse it defensively
    -- so this RPC can never violate account_onboarding_claim_coherent by setting bootstrapping without an operation_id.
    -- (A row ALREADY bootstrapping keeps that status via the forward rule below; that path keeps the existing
    -- operation_id untouched, so the constraint always holds.)
    perform pg_advisory_xact_lock(hashtext('account-onboarding-reconcile|' || v_account));
    select * into v_row from public.account_onboarding where account_id = v_account for update;

    if not found then
      -- Brand-new account. A proposed 'bootstrapping' on an absent row would violate claim coherence (no operation_id)
      -- and can never be a legitimate discovery outcome -> refuse. All other statuses insert cleanly.
      if v_proposed = 'bootstrapping' then
        raise exception 'reconcile_account_onboarding_discovery: refusing to INSERT a bootstrapping row (no claim) for %', v_account;
      end if;
      insert into public.account_onboarding (
        account_id, connection_id, name, marketplace_country_code, marketplace_id, region, status,
        datadoe_ready, datadoe_row_count, seller_central_row_count, ads_connected, ads_ready, ads_row_count,
        sources, failure_code, first_discovered_at, last_seen_at, ready_at, bootstrap_completed_at, updated_at
      ) values (
        v_account, 'primary',
        coalesce(v_elem->>'name', ''),
        coalesce(v_elem->>'marketplace_country_code', ''),
        coalesce(v_elem->>'marketplace_id', ''),
        coalesce(v_elem->>'region', 'unassigned'),
        v_proposed,
        coalesce((v_elem->>'datadoe_ready')::boolean, false),
        nullif(v_elem->>'datadoe_row_count','')::bigint,
        nullif(v_elem->>'seller_central_row_count','')::bigint,
        coalesce((v_elem->>'ads_connected')::boolean, false),
        coalesce((v_elem->>'ads_ready')::boolean, false),
        nullif(v_elem->>'ads_row_count','')::bigint,
        coalesce(v_elem->'sources', '{}'::jsonb),
        v_elem->>'failure_code',
        now(), now(),
        nullif(v_elem->>'ready_at','')::timestamptz,
        nullif(v_elem->>'bootstrap_completed_at','')::timestamptz,
        now()
      );
      v_inserted := v_inserted + 1;
      continue;
    end if;

    -- FORWARD-ONLY status reconciliation against the LOCKED current status.
    if v_row.status in ('bootstrapping','partially_ready','ready') then
      v_rank_cur := case v_row.status when 'bootstrapping' then 3 when 'partially_ready' then 4 when 'ready' then 5 else 0 end;
      v_rank_prop := case v_proposed when 'bootstrapping' then 3 when 'partially_ready' then 4 when 'ready' then 5 else -1 end;
      if v_proposed in ('bootstrapping','partially_ready','ready') and v_rank_prop >= v_rank_cur then
        v_new_status := v_proposed;                 -- forward claim-owned progression
        if v_new_status <> v_row.status then v_forward := v_forward + 1; end if;
      else
        v_new_status := v_row.status;               -- REJECT stale-read regression (keep the claimed status)
        if v_proposed <> v_row.status then v_rejected := v_rejected + 1; end if;
      end if;
    else
      v_new_status := v_proposed;                   -- pre-claim current: discovery decides (readiness flaps allowed)
    end if;

    update public.account_onboarding set
      name = coalesce(v_elem->>'name', name),
      marketplace_country_code = coalesce(v_elem->>'marketplace_country_code', marketplace_country_code),
      marketplace_id = coalesce(v_elem->>'marketplace_id', marketplace_id),
      region = coalesce(v_elem->>'region', region),
      status = v_new_status,
      datadoe_ready = coalesce((v_elem->>'datadoe_ready')::boolean, datadoe_ready),
      datadoe_row_count = coalesce(nullif(v_elem->>'datadoe_row_count','')::bigint, datadoe_row_count),
      seller_central_row_count = coalesce(nullif(v_elem->>'seller_central_row_count','')::bigint, seller_central_row_count),
      ads_connected = coalesce((v_elem->>'ads_connected')::boolean, ads_connected),
      ads_ready = coalesce((v_elem->>'ads_ready')::boolean, ads_ready),
      ads_row_count = coalesce(nullif(v_elem->>'ads_row_count','')::bigint, ads_row_count),
      sources = coalesce(v_elem->'sources', sources),
      failure_code = case when v_elem ? 'failure_code' then v_elem->>'failure_code' else failure_code end,
      -- set-once timestamps: keep the durable value if present, else adopt the proposed one.
      ready_at = coalesce(ready_at, nullif(v_elem->>'ready_at','')::timestamptz),
      bootstrap_completed_at = coalesce(bootstrap_completed_at, nullif(v_elem->>'bootstrap_completed_at','')::timestamptz),
      last_seen_at = now(),
      updated_at = now()
      -- NEVER written here: operation_id, bootstrap_started_at, first_discovered_at (claim-owned);
      -- last_attempt_at, next_retry_at (dispatch-owned).
    where account_id = v_account;
    v_updated := v_updated + 1;
  end loop;

  return jsonb_build_object(
    'disposition', 'reconciled',
    'inserted', v_inserted, 'updated', v_updated,
    'forward', v_forward, 'rejected_regressions', v_rejected
  );
end;
$$;

revoke all on function public.reconcile_account_onboarding_discovery(jsonb) from public, anon, authenticated;
grant execute on function public.reconcile_account_onboarding_discovery(jsonb) to service_role;
