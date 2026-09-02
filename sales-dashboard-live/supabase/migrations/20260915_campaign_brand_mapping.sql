-- ===========================================================================
-- CAMPAIGN -> BRAND mapping -- user-managed, durable, region-independent (Migration 20260915)
-- ===========================================================================
--
-- >>> PREPARED / DORMANT FOUNDATION. Apply forward via the tracked db:migrate runner (public.app_schema_migrations);
-- >>> it edits NO prior migration. ADDITIVE + IDEMPOTENT (create ... if not exists / create or replace). Repeated
-- >>> execution is safe. It touches NO existing table, RPC, report, scheduler, contract, or authorization row.
--
-- WHY: a future "Ad Performance by Campaign" page will let permitted seller users map each campaign to a brand. The
-- campaign PERFORMANCE source of truth is the EXISTING durable Ads history (public.ads_daily_source_rows, source_key
-- 'campaign-performance-v1') which already captures campaign name/status/type/budget/profile at daily campaign grain
-- (ads-sync.js) -- so this migration adds ONLY the user-managed mapping layer, mirroring the reviewed SKU Movement
-- identifier + FBA seller-warehouse pattern EXACTLY: an account-scoped mapping table, a single-row atomic
-- assign/change/clear RPC, an all-or-nothing bulk RPC, an append-only audit table, and an explicit per-account
-- capability. Mappings carry NO report metrics; re-syncing campaign performance never touches them.
--
-- CAMPAIGN IDENTITY (never the campaign NAME): (organization_fingerprint, connection_id, account_id, marketplace,
-- ads_profile_id, ad_campaign_id). The Ads profile is NULLABLE upstream; it is normalized to '' so a blank profile
-- has deterministic uniqueness (exactly one identity per campaign with no profile). Marketplace is canonicalized by
-- the api/ layer via the project's canonical helper (GB->UK) before it reaches here.
--
-- REGION-INDEPENDENT: marketplace is part of every identity; there are NO schedule times, buckets, or US/EU/IN
-- assumptions in this schema. A future scheduler can pass account sets grouped by region WITHOUT any change here.

-- ---------------------------------------------------------------------------
-- 1) campaign_brand_mapping -- ONE current brand per exact campaign identity. A row ALWAYS carries a non-blank brand;
--    a CLEAR deletes the row (blank brand can never accidentally overwrite). Carries NO metrics.
-- ---------------------------------------------------------------------------
create table if not exists public.campaign_brand_mapping (
  organization_fingerprint text not null
    constraint cbm_org_nonblank check (char_length(btrim(organization_fingerprint)) > 0),
  connection_id text not null default 'primary'
    constraint cbm_conn_check check (connection_id in ('primary', 'dd-secondary')),
  account_id text not null
    constraint cbm_account_nonblank check (char_length(btrim(account_id)) > 0),
  marketplace text not null
    constraint cbm_marketplace_nonblank check (char_length(btrim(marketplace)) > 0),
  -- Normalized nullable Ads profile: '' = no profile (deterministic uniqueness). Bounded, no control chars.
  ads_profile_id text not null default ''
    constraint cbm_profile_len check (char_length(ads_profile_id) <= 128)
    constraint cbm_profile_no_control check (ads_profile_id !~ '[[:cntrl:]]'),
  ad_campaign_id text not null
    constraint cbm_campaign_nonblank check (char_length(btrim(ad_campaign_id)) > 0)
    constraint cbm_campaign_len check (char_length(ad_campaign_id) <= 128)
    constraint cbm_campaign_no_control check (ad_campaign_id !~ '[[:cntrl:]]'),
  canonical_brand_key text not null
    constraint cbm_brand_key_nonblank check (char_length(btrim(canonical_brand_key)) > 0)
    constraint cbm_brand_key_len check (char_length(canonical_brand_key) <= 160)
    constraint cbm_brand_key_no_control check (canonical_brand_key !~ '[[:cntrl:]]'),
  brand_display_name text not null default ''
    constraint cbm_brand_display_len check (char_length(brand_display_name) <= 200)
    constraint cbm_brand_display_no_control check (brand_display_name !~ '[[:cntrl:]]'),
  mapping_source text not null
    constraint cbm_source_check check (mapping_source in ('MANUAL', 'BULK')),
  note text not null default ''
    constraint cbm_note_len check (char_length(note) <= 500)
    constraint cbm_note_no_control check (note !~ '[[:cntrl:]]'),
  mapped_by uuid references auth.users (id) on delete set null,
  mapped_by_email text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint campaign_brand_mapping_pk
    primary key (organization_fingerprint, connection_id, account_id, marketplace, ads_profile_id, ad_campaign_id)
);
-- Account-scoped campaign listing + mapping joins; brand-wise listing for a future brand-Ads rollup.
create index if not exists campaign_brand_mapping_account_idx
  on public.campaign_brand_mapping (organization_fingerprint, connection_id, account_id);
create index if not exists campaign_brand_mapping_brand_idx
  on public.campaign_brand_mapping (organization_fingerprint, connection_id, account_id, canonical_brand_key);
drop trigger if exists campaign_brand_mapping_touch on public.campaign_brand_mapping;
create trigger campaign_brand_mapping_touch before update on public.campaign_brand_mapping
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- 2) campaign_brand_mapping_audit -- append-only history of every ASSIGN / CHANGE / CLEAR (MANUAL or BULK).
-- ---------------------------------------------------------------------------
create table if not exists public.campaign_brand_mapping_audit (
  id bigint generated always as identity primary key,
  organization_fingerprint text not null,
  connection_id text not null default 'primary',
  account_id text not null,
  marketplace text not null,
  ads_profile_id text not null default '',
  ad_campaign_id text not null,
  previous_brand_key text not null default '',
  previous_brand_display text not null default '',
  new_brand_key text not null default '',
  new_brand_display text not null default '',
  action text not null
    constraint cbm_audit_action_check check (action in ('ASSIGN', 'CHANGE', 'CLEAR')),
  source text not null
    constraint cbm_audit_source_check check (source in ('MANUAL', 'BULK')),
  actor uuid references auth.users (id) on delete set null,
  actor_email text not null default '',
  note text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists campaign_brand_mapping_audit_grain_idx
  on public.campaign_brand_mapping_audit
     (organization_fingerprint, connection_id, account_id, marketplace, ads_profile_id, ad_campaign_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 3) account_campaign_map_grant -- the EXPLICIT per-(user, account) capability to manage campaign->brand mappings.
--    Default false; an existing user gains NO new power. Admins bypass in the api/ layer. Never modifies
--    account_permissions or account_brand_grant, and never grants access to any report, account, or brand.
-- ---------------------------------------------------------------------------
create table if not exists public.account_campaign_map_grant (
  organization_fingerprint text not null
    constraint accmg_org_nonblank check (char_length(btrim(organization_fingerprint)) > 0),
  connection_id text not null default 'primary'
    constraint accmg_conn_check check (connection_id in ('primary', 'dd-secondary')),
  account_id text not null
    constraint accmg_account_nonblank check (char_length(btrim(account_id)) > 0),
  user_id uuid not null references auth.users (id) on delete cascade,
  can_manage_campaign_brand_mapping boolean not null default false,
  granted_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint account_campaign_map_grant_pk
    primary key (organization_fingerprint, connection_id, account_id, user_id)
);
create index if not exists account_campaign_map_grant_user_idx
  on public.account_campaign_map_grant (user_id, account_id);
drop trigger if exists account_campaign_map_grant_touch on public.account_campaign_map_grant;
create trigger account_campaign_map_grant_touch before update on public.account_campaign_map_grant
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- 4) record_campaign_brand_mapping -- the ONLY single-row write path. Atomic upsert (or DELETE when the brand key is
--    blank = CLEAR) that ALSO appends the audit row in the SAME transaction. Deterministic ASSIGN / CHANGE / CLEAR
--    from the prior state. Identity + length + control-char validated. The api/ layer proves the campaign belongs to
--    the account's durable history and that the brand is trusted BEFORE calling this; here we enforce shape + atomicity.
-- ---------------------------------------------------------------------------
create or replace function public.record_campaign_brand_mapping(
  p_organization_fingerprint text,
  p_connection_id text,
  p_account_id text,
  p_marketplace text,
  p_ads_profile_id text,
  p_ad_campaign_id text,
  p_brand_key text,
  p_brand_display text,
  p_source text,
  p_note text,
  p_actor uuid,
  p_actor_email text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_mkt text := btrim(coalesce(p_marketplace, ''));
  v_profile text := btrim(coalesce(p_ads_profile_id, ''));
  v_campaign text := btrim(coalesce(p_ad_campaign_id, ''));
  v_new_key text := btrim(coalesce(p_brand_key, ''));
  v_new_display text := btrim(coalesce(p_brand_display, ''));
  v_note text := btrim(coalesce(p_note, ''));
  v_source text := coalesce(p_source, 'MANUAL');
  v_prev_key text := '';
  v_prev_display text := '';
  v_action text;
begin
  if coalesce(btrim(p_organization_fingerprint), '') = '' or p_connection_id not in ('primary', 'dd-secondary')
     or coalesce(btrim(p_account_id), '') = '' or v_mkt = '' or v_campaign = '' then
    raise exception 'record_campaign_brand_mapping: blank identity (org/connection/account/marketplace/campaign required)';
  end if;
  if v_source not in ('MANUAL', 'BULK') then
    raise exception 'record_campaign_brand_mapping: source must be MANUAL or BULK';
  end if;
  if char_length(v_profile) > 128 or v_profile ~ '[[:cntrl:]]' then
    raise exception 'record_campaign_brand_mapping: invalid ads_profile_id';
  end if;
  if char_length(v_campaign) > 128 or v_campaign ~ '[[:cntrl:]]' then
    raise exception 'record_campaign_brand_mapping: invalid ad_campaign_id';
  end if;
  if char_length(v_new_key) > 160 or v_new_key ~ '[[:cntrl:]]' then
    raise exception 'record_campaign_brand_mapping: invalid brand key';
  end if;
  if char_length(v_new_display) > 200 or v_new_display ~ '[[:cntrl:]]' then
    raise exception 'record_campaign_brand_mapping: invalid brand display';
  end if;
  if char_length(v_note) > 500 or v_note ~ '[[:cntrl:]]' then
    raise exception 'record_campaign_brand_mapping: invalid note';
  end if;

  select canonical_brand_key, brand_display_name into v_prev_key, v_prev_display
    from public.campaign_brand_mapping
    where organization_fingerprint = p_organization_fingerprint and connection_id = p_connection_id
      and account_id = p_account_id and marketplace = v_mkt and ads_profile_id = v_profile and ad_campaign_id = v_campaign;
  v_prev_key := coalesce(v_prev_key, '');
  v_prev_display := coalesce(v_prev_display, '');

  if v_new_key = '' then
    -- CLEAR: an explicit removal only. A no-op when nothing was mapped (no write, no audit).
    if v_prev_key = '' then
      return jsonb_build_object('account_id', p_account_id, 'marketplace', v_mkt, 'ads_profile_id', v_profile,
                                'ad_campaign_id', v_campaign, 'action', 'CLEAR', 'changed', false);
    end if;
    delete from public.campaign_brand_mapping
      where organization_fingerprint = p_organization_fingerprint and connection_id = p_connection_id
        and account_id = p_account_id and marketplace = v_mkt and ads_profile_id = v_profile and ad_campaign_id = v_campaign;
    v_action := 'CLEAR';
  else
    insert into public.campaign_brand_mapping (
      organization_fingerprint, connection_id, account_id, marketplace, ads_profile_id, ad_campaign_id,
      canonical_brand_key, brand_display_name, mapping_source, note, mapped_by, mapped_by_email
    ) values (
      p_organization_fingerprint, p_connection_id, p_account_id, v_mkt, v_profile, v_campaign,
      v_new_key, v_new_display, v_source, v_note, p_actor, coalesce(p_actor_email, '')
    )
    on conflict on constraint campaign_brand_mapping_pk
    do update set canonical_brand_key = excluded.canonical_brand_key, brand_display_name = excluded.brand_display_name,
                  mapping_source = excluded.mapping_source, note = excluded.note,
                  mapped_by = excluded.mapped_by, mapped_by_email = excluded.mapped_by_email, updated_at = now();
    v_action := case when v_prev_key = '' then 'ASSIGN' else 'CHANGE' end;
  end if;

  insert into public.campaign_brand_mapping_audit (
    organization_fingerprint, connection_id, account_id, marketplace, ads_profile_id, ad_campaign_id,
    previous_brand_key, previous_brand_display, new_brand_key, new_brand_display, action, source, actor, actor_email, note
  ) values (
    p_organization_fingerprint, p_connection_id, p_account_id, v_mkt, v_profile, v_campaign,
    v_prev_key, v_prev_display, v_new_key, v_new_display, v_action, v_source, p_actor, coalesce(p_actor_email, ''), v_note
  );

  return jsonb_build_object('account_id', p_account_id, 'marketplace', v_mkt, 'ads_profile_id', v_profile,
                            'ad_campaign_id', v_campaign, 'brand_key', v_new_key, 'action', v_action, 'changed', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5) record_campaign_brand_mapping_bulk -- ALL-OR-NOTHING bulk apply for ONE account. One transaction; any bad row
--    rolls back the whole apply and writes ZERO audit rows. Each row carries its own (marketplace, ads_profile_id,
--    ad_campaign_id, brand_key, brand_display, note); a blank brand_key CLEARS that campaign. Rejects: blank
--    marketplace/campaign, over-long/control-char values, and a DUPLICATE campaign identity carrying CONFLICTING
--    brand keys within the same file. The api/ layer additionally proves every identity against durable history and
--    every brand against the account's trusted membership BEFORE calling this. Idempotent (re-apply = same rows).
-- ---------------------------------------------------------------------------
create or replace function public.record_campaign_brand_mapping_bulk(
  p_organization_fingerprint text,
  p_connection_id text,
  p_account_id text,
  p_rows jsonb,
  p_actor uuid,
  p_actor_email text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row jsonb;
  v_mkt text;
  v_profile text;
  v_campaign text;
  v_new_key text;
  v_new_display text;
  v_note text;
  v_prev_key text;
  v_prev_display text;
  v_action text;
  v_applied int := 0;
begin
  if coalesce(btrim(p_organization_fingerprint), '') = '' or p_connection_id not in ('primary', 'dd-secondary')
     or coalesce(btrim(p_account_id), '') = '' then
    raise exception 'record_campaign_brand_mapping_bulk: blank identity (org/connection/account required)';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'record_campaign_brand_mapping_bulk: p_rows must be a jsonb array';
  end if;
  if jsonb_array_length(p_rows) = 0 then
    raise exception 'record_campaign_brand_mapping_bulk: p_rows is empty';
  end if;
  if jsonb_array_length(p_rows) > 5000 then
    raise exception 'record_campaign_brand_mapping_bulk: too many rows (max 5000)';
  end if;

  -- Reject a duplicate campaign identity carrying CONFLICTING brand keys within the SAME file (before any write).
  if exists (
    select 1 from (
      select btrim(coalesce(r->>'marketplace','')) mkt,
             btrim(coalesce(r->>'ads_profile_id','')) prof,
             btrim(coalesce(r->>'ad_campaign_id','')) camp,
             count(distinct btrim(coalesce(r->>'brand_key',''))) c
      from jsonb_array_elements(p_rows) r group by 1, 2, 3
    ) d where d.c > 1
  ) then
    raise exception 'record_campaign_brand_mapping_bulk: a campaign appears more than once with conflicting brands';
  end if;

  for v_row in select * from jsonb_array_elements(p_rows)
  loop
    v_mkt := btrim(coalesce(v_row->>'marketplace', ''));
    v_profile := btrim(coalesce(v_row->>'ads_profile_id', ''));
    v_campaign := btrim(coalesce(v_row->>'ad_campaign_id', ''));
    v_new_key := btrim(coalesce(v_row->>'brand_key', ''));
    v_new_display := btrim(coalesce(v_row->>'brand_display', ''));
    v_note := btrim(coalesce(v_row->>'note', ''));

    if v_mkt = '' or v_campaign = '' then
      raise exception 'record_campaign_brand_mapping_bulk: a row has a blank marketplace or campaign id';
    end if;
    if char_length(v_profile) > 128 or v_profile ~ '[[:cntrl:]]' then
      raise exception 'record_campaign_brand_mapping_bulk: invalid ads_profile_id for campaign %', v_campaign;
    end if;
    if char_length(v_campaign) > 128 or v_campaign ~ '[[:cntrl:]]' then
      raise exception 'record_campaign_brand_mapping_bulk: invalid ad_campaign_id %', v_campaign;
    end if;
    if char_length(v_new_key) > 160 or v_new_key ~ '[[:cntrl:]]'
       or char_length(v_new_display) > 200 or v_new_display ~ '[[:cntrl:]]'
       or char_length(v_note) > 500 or v_note ~ '[[:cntrl:]]' then
      raise exception 'record_campaign_brand_mapping_bulk: invalid brand/note for campaign %', v_campaign;
    end if;

    select canonical_brand_key, brand_display_name into v_prev_key, v_prev_display
      from public.campaign_brand_mapping
      where organization_fingerprint = p_organization_fingerprint and connection_id = p_connection_id
        and account_id = p_account_id and marketplace = v_mkt and ads_profile_id = v_profile and ad_campaign_id = v_campaign;
    v_prev_key := coalesce(v_prev_key, '');
    v_prev_display := coalesce(v_prev_display, '');

    if v_new_key = '' then
      if v_prev_key = '' then
        continue; -- CLEAR of an unmapped campaign is a no-op (no write, no audit).
      end if;
      delete from public.campaign_brand_mapping
        where organization_fingerprint = p_organization_fingerprint and connection_id = p_connection_id
          and account_id = p_account_id and marketplace = v_mkt and ads_profile_id = v_profile and ad_campaign_id = v_campaign;
      v_action := 'CLEAR';
    else
      insert into public.campaign_brand_mapping (
        organization_fingerprint, connection_id, account_id, marketplace, ads_profile_id, ad_campaign_id,
        canonical_brand_key, brand_display_name, mapping_source, note, mapped_by, mapped_by_email
      ) values (
        p_organization_fingerprint, p_connection_id, p_account_id, v_mkt, v_profile, v_campaign,
        v_new_key, v_new_display, 'BULK', v_note, p_actor, coalesce(p_actor_email, '')
      )
      on conflict on constraint campaign_brand_mapping_pk
      do update set canonical_brand_key = excluded.canonical_brand_key, brand_display_name = excluded.brand_display_name,
                    mapping_source = 'BULK', note = excluded.note,
                    mapped_by = excluded.mapped_by, mapped_by_email = excluded.mapped_by_email, updated_at = now();
      v_action := case when v_prev_key = '' then 'ASSIGN' else 'CHANGE' end;
    end if;

    insert into public.campaign_brand_mapping_audit (
      organization_fingerprint, connection_id, account_id, marketplace, ads_profile_id, ad_campaign_id,
      previous_brand_key, previous_brand_display, new_brand_key, new_brand_display, action, source, actor, actor_email, note
    ) values (
      p_organization_fingerprint, p_connection_id, p_account_id, v_mkt, v_profile, v_campaign,
      v_prev_key, v_prev_display, v_new_key, v_new_display, v_action, 'BULK', p_actor, coalesce(p_actor_email, ''), v_note
    );
    v_applied := v_applied + 1;
  end loop;

  return jsonb_build_object('account_id', p_account_id, 'applied', v_applied);
end;
$$;

-- ---------------------------------------------------------------------------
-- 6) RLS + LEAST-PRIVILEGE ACLs. Mapping + audit are SERVICE-ROLE ONLY: every read and write goes through the
--    capability-gated authenticated api/ layer (no direct authenticated table access). The capability grant table
--    lets a user read ONLY their OWN capability row. No anon/public access anywhere. RPCs execute as service_role only.
-- ---------------------------------------------------------------------------
alter table public.campaign_brand_mapping enable row level security;
alter table public.campaign_brand_mapping_audit enable row level security;
alter table public.account_campaign_map_grant enable row level security;

revoke all on table public.campaign_brand_mapping from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.campaign_brand_mapping to service_role;

revoke all on table public.campaign_brand_mapping_audit from public, anon, authenticated, service_role;
grant select, insert on table public.campaign_brand_mapping_audit to service_role;

revoke all on table public.account_campaign_map_grant from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.account_campaign_map_grant to service_role;
grant select on table public.account_campaign_map_grant to authenticated;
drop policy if exists accmg_read_own on public.account_campaign_map_grant;
create policy accmg_read_own on public.account_campaign_map_grant for select to authenticated
  using (user_id = auth.uid());

revoke all on function public.record_campaign_brand_mapping(text, text, text, text, text, text, text, text, text, text, uuid, text) from public, anon, authenticated;
grant execute on function public.record_campaign_brand_mapping(text, text, text, text, text, text, text, text, text, text, uuid, text) to service_role;
revoke all on function public.record_campaign_brand_mapping_bulk(text, text, text, jsonb, uuid, text) from public, anon, authenticated;
grant execute on function public.record_campaign_brand_mapping_bulk(text, text, text, jsonb, uuid, text) to service_role;
