-- ===========================================================================
-- FBA Shipment Plan -- durable ACCOUNT-SKU OWNERSHIP authority (Migration 20)
-- ===========================================================================
--
-- Apply forward via the tracked db:migrate runner (public.app_schema_migrations); it edits no prior migration.
-- ADDITIVE + IDEMPOTENT: adds ONE table + ONE SECURITY DEFINER RPC. Changes no existing table; stores no DataDoe
-- evidence beyond the already-derived per-account SKU identity.
--
-- WHY: trusted server-side warehouse-write validation must reject a "new manual SKU" that is already proven under
-- ANOTHER account -- using COMPLETE evidence (FBA Inventory Health + US Listings/AWD + OLI sales, all aggregated in the
-- validated fba-plan/v2d-5 accountSkuDirectory, plus each account's own seller-warehouse identities), not just OLI
-- sales. This table is the queryable, indexed authority; it is populated ATOMICALLY per account from that validated
-- directory evidence (never from the org-wide Product Catalog). Ownership is CANONICAL-MARKETPLACE scoped so the same
-- SKU text in a different legitimate marketplace is a distinct row (no false conflict).
--
-- ISOLATION: RLS lets a user read only ownership rows for accounts they hold (admins all). All WRITES go through the
-- service role via the atomic replace RPC (the api/ layer never lets a browser mutate this). Least-privilege ACLs.

create table if not exists public.fba_account_sku_ownership (
  organization_fingerprint text not null,
  connection_id text not null default 'primary'
    constraint fba_acct_sku_own_conn_check check (connection_id in ('primary', 'dd-secondary')),
  account_id text not null
    constraint fba_acct_sku_own_account_nonblank check (char_length(btrim(account_id)) > 0),
  marketplace text not null
    constraint fba_acct_sku_own_marketplace_nonblank check (char_length(btrim(marketplace)) > 0),
  sku text not null
    constraint fba_acct_sku_own_sku_nonblank check (char_length(btrim(sku)) > 0),
  child_asin text not null default '',
  sources text not null default '',
  updated_at timestamptz not null default now(),
  constraint fba_acct_sku_own_pk primary key (organization_fingerprint, connection_id, account_id, marketplace, sku)
);
-- The cross-account probe: given (org, canonical marketplace, sku) find any row whose account_id differs. Also serves
-- the account-scoped RLS read. child_asin is included so the probe never needs the base table.
create index if not exists fba_acct_sku_own_market_sku_idx
  on public.fba_account_sku_ownership (organization_fingerprint, marketplace, sku, account_id);

drop trigger if exists fba_acct_sku_own_touch on public.fba_account_sku_ownership;
create trigger fba_acct_sku_own_touch before update on public.fba_account_sku_ownership
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- replace_fba_account_sku_ownership -- ATOMICALLY replace ONE account's ownership rows from validated directory
-- evidence: delete the account's existing rows then insert the supplied set, in one transaction. p_rows is a jsonb
-- array of { marketplace, sku, child_asin?, sources? }. Blank marketplace/sku rows are skipped. Returns the count.
-- ---------------------------------------------------------------------------
create or replace function public.replace_fba_account_sku_ownership(
  p_organization_fingerprint text,
  p_connection_id text,
  p_account_id text,
  p_rows jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row jsonb;
  v_market text;
  v_sku text;
  v_count int := 0;
begin
  if coalesce(btrim(p_organization_fingerprint), '') = '' or p_connection_id not in ('primary', 'dd-secondary')
     or coalesce(btrim(p_account_id), '') = '' then
    raise exception 'replace_fba_account_sku_ownership: blank identity (org/connection/account required)';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'replace_fba_account_sku_ownership: p_rows must be a jsonb array';
  end if;

  delete from public.fba_account_sku_ownership
    where organization_fingerprint = p_organization_fingerprint and connection_id = p_connection_id and account_id = p_account_id;

  for v_row in select * from jsonb_array_elements(p_rows)
  loop
    v_market := btrim(upper(coalesce(v_row->>'marketplace', '')));
    v_sku := btrim(coalesce(v_row->>'sku', ''));
    if v_market = '' or v_sku = '' then continue; end if;
    insert into public.fba_account_sku_ownership (
      organization_fingerprint, connection_id, account_id, marketplace, sku, child_asin, sources
    ) values (
      p_organization_fingerprint, p_connection_id, p_account_id, v_market, v_sku,
      coalesce(btrim(v_row->>'child_asin'), ''), coalesce(v_row->>'sources', '')
    )
    on conflict (organization_fingerprint, connection_id, account_id, marketplace, sku)
    do update set child_asin = excluded.child_asin, sources = excluded.sources, updated_at = now();
    v_count := v_count + 1;
  end loop;

  return jsonb_build_object('account_id', p_account_id, 'rows', v_count);
end;
$$;

-- ---------------------------------------------------------------------------
-- RLS + LEAST-PRIVILEGE ACLs. Reads are ACCOUNT-SCOPED (a user must hold account_permissions for the account, OR be a
-- dashboard admin). Writes go ONLY through the service role (the atomic replace RPC).
-- ---------------------------------------------------------------------------
alter table public.fba_account_sku_ownership enable row level security;

drop policy if exists fba_acct_sku_own_read on public.fba_account_sku_ownership;
create policy fba_acct_sku_own_read on public.fba_account_sku_ownership for select to authenticated
  using (public.is_dashboard_admin() or exists (select 1 from public.account_permissions p where p.user_id = auth.uid() and p.account_id = fba_account_sku_ownership.account_id));

revoke all on table public.fba_account_sku_ownership from public, anon, authenticated, service_role;
grant select on table public.fba_account_sku_ownership to authenticated;
grant select, insert, update, delete on table public.fba_account_sku_ownership to service_role;

revoke all on function public.replace_fba_account_sku_ownership(text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.replace_fba_account_sku_ownership(text, text, text, jsonb) to service_role;
