-- ===========================================================================
-- Scheduler v2 — STABLE <=5-account source batch membership (SHADOW MODE)
-- ===========================================================================
--
-- ADDITIVE + IDEMPOTENT. Adds ONE table and ONE RPC. Changes no existing table,
-- stores no secret (only the SAFE public account id + the non-reversible
-- organization fingerprint). Repeated execution is safe.
--
-- WHY: a batchable canonical source (Order Line Items, order-lines) is fetched as
-- ONE DataDoe export over up to FIVE compatible primary accounts' sorted seller
-- ids. Which five accounts group together must be STABLE across cycles: adding a
-- newly discovered/approved account must place ONLY that account (into a non-full
-- or fresh batch) and must NOT reshuffle any existing account (which would
-- invalidate every existing request_hash and cached export). Durable membership is
-- that stable assignment; the five-account maximum is enforced transactionally.

create table if not exists public.source_batch_membership (
  batch_family text not null,                 -- stable compatibility key (lib/server/sync/source-batching.batchFamilyKey)
  account_id text not null,                    -- SAFE public account id (individual account); never a raw secret
  batch_index integer not null check (batch_index >= 0),
  connection_id text not null default 'primary'
    check (connection_id in ('primary', 'dd-secondary')),
  organization_fingerprint text not null,      -- non-reversible org fingerprint (never the api key)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint source_batch_membership_pk primary key (batch_family, account_id)
);
create index if not exists source_batch_membership_family_idx
  on public.source_batch_membership (batch_family, batch_index);

drop trigger if exists source_batch_membership_touch on public.source_batch_membership;
create trigger source_batch_membership_touch before update on public.source_batch_membership
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- assign_source_account_batch — STABLE, transactional <=5 assignment. Returns the
-- (existing or newly assigned) batch_index for (family, account). An account that
-- already has a membership returns its EXISTING index unchanged (never reshuffled).
-- A new account is placed into the SMALLEST-index batch with < p_max members, or a
-- fresh batch when all are full. pg_advisory_xact_lock(hashtext(family)) serialises
-- assignments within a family so two concurrent inserts can never push a batch past
-- the maximum. p_max is hard-capped to 1..5 so no caller can widen the batch size.
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

  select batch_index into v_index
    from public.source_batch_membership
   where batch_family = p_batch_family and account_id = p_account_id;
  if found then
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

alter table public.source_batch_membership enable row level security;
drop policy if exists "admins read source batch membership" on public.source_batch_membership;
create policy "admins read source batch membership" on public.source_batch_membership
  for select to authenticated using (public.is_dashboard_admin());

revoke all on table public.source_batch_membership from public, anon, authenticated;
revoke all on function public.assign_source_account_batch(text, text, text, text, integer) from public, anon, authenticated;
grant all on table public.source_batch_membership to service_role;
grant execute on function public.assign_source_account_batch(text, text, text, text, integer) to service_role;
