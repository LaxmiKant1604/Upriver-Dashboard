-- ===========================================================================
-- CAMPAIGN mapping capability -- admin write path + lifecycle cleanup (Migration 20260916)
-- ===========================================================================
--
-- >>> PREPARED / DORMANT. Apply forward via the tracked db:migrate runner (public.app_schema_migrations); it edits NO
-- >>> prior migration (20260915 stays intact). ADDITIVE + IDEMPOTENT + FORWARD-ONLY (do-block guards make repeated
-- >>> execution safe). Touches NO existing table's data, no scheduler, no report, no formula.
--
-- WHY: 20260915 created account_campaign_map_grant (the per-(user,account) campaign-mapping capability). This adds
--   (1) DURABLE LIFECYCLE CLEANUP: a FK (user_id, account_id) -> account_permissions(user_id, account_id) ON DELETE
--       CASCADE, so revoking a user's normal account access AUTOMATICALLY removes any campaign-mapping capability for
--       that account. It exactly matches the existing account_permissions primary key (user_id, account_id) and its
--       org-agnostic model, so it is safe. (Runtime enforcement -- requiring canonical account access AND the
--       capability -- is ALSO enforced in api/campaign-brand-mapping.js and is the mandatory primary guarantee.)
--   (2) an append-only capability AUDIT table.
--   (3) set_campaign_map_capability -- the ONLY capability write path: a SECURITY DEFINER, service-role-only RPC that
--       atomically grants (upsert enabled) or revokes (delete) one (user, account) capability and appends the audit
--       row in the SAME transaction. The admin api/ layer authorizes the caller + validates the target user's account
--       access BEFORE calling this; the RPC does NOT create account or brand access.

-- ---------------------------------------------------------------------------
-- 1) Durable cleanup FK: a capability row cannot outlive the user's account access (idempotent add).
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'accmg_account_access_fk'
      and conrelid = 'public.account_campaign_map_grant'::regclass
  ) then
    alter table public.account_campaign_map_grant
      add constraint accmg_account_access_fk
      foreign key (user_id, account_id) references public.account_permissions (user_id, account_id) on delete cascade;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2) account_campaign_map_grant_audit -- append-only GRANT / REVOKE history.
-- ---------------------------------------------------------------------------
create table if not exists public.account_campaign_map_grant_audit (
  id bigint generated always as identity primary key,
  organization_fingerprint text not null,
  connection_id text not null default 'primary',
  account_id text not null,
  user_id uuid,
  action text not null
    constraint accmg_audit_action_check check (action in ('GRANT', 'REVOKE')),
  enabled boolean not null default false,
  actor uuid references auth.users (id) on delete set null,
  actor_email text not null default '',
  correlation_id text not null default ''
    constraint accmg_audit_corr_len check (char_length(correlation_id) <= 200),
  created_at timestamptz not null default now()
);
create index if not exists account_campaign_map_grant_audit_grain_idx
  on public.account_campaign_map_grant_audit (organization_fingerprint, connection_id, account_id, user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 3) set_campaign_map_capability -- the ONLY capability write path. Atomic grant (upsert enabled=true) or revoke
--    (delete) + audit, in one transaction. Idempotent both ways. It does NOT create account_permissions or
--    account_brand_grant rows (never widens access); the admin api/ layer proves the target user already has account
--    access before granting.
-- ---------------------------------------------------------------------------
create or replace function public.set_campaign_map_capability(
  p_organization_fingerprint text,
  p_connection_id text,
  p_account_id text,
  p_user_id uuid,
  p_enabled boolean,
  p_actor uuid,
  p_actor_email text,
  p_correlation_id text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_action text := case when coalesce(p_enabled, false) then 'GRANT' else 'REVOKE' end;
begin
  if coalesce(btrim(p_organization_fingerprint), '') = '' or p_connection_id not in ('primary', 'dd-secondary')
     or coalesce(btrim(p_account_id), '') = '' or p_user_id is null then
    raise exception 'set_campaign_map_capability: blank identity (org/connection/account/user required)';
  end if;
  if char_length(coalesce(p_correlation_id, '')) > 200 then
    raise exception 'set_campaign_map_capability: correlation id too long';
  end if;

  if coalesce(p_enabled, false) then
    insert into public.account_campaign_map_grant (
      organization_fingerprint, connection_id, account_id, user_id, can_manage_campaign_brand_mapping, granted_by
    ) values (
      p_organization_fingerprint, p_connection_id, p_account_id, p_user_id, true, p_actor
    )
    on conflict on constraint account_campaign_map_grant_pk
    do update set can_manage_campaign_brand_mapping = true, granted_by = excluded.granted_by, updated_at = now();
  else
    delete from public.account_campaign_map_grant
      where organization_fingerprint = p_organization_fingerprint and connection_id = p_connection_id
        and account_id = p_account_id and user_id = p_user_id;
  end if;

  insert into public.account_campaign_map_grant_audit (
    organization_fingerprint, connection_id, account_id, user_id, action, enabled, actor, actor_email, correlation_id
  ) values (
    p_organization_fingerprint, p_connection_id, p_account_id, p_user_id, v_action, coalesce(p_enabled, false),
    p_actor, coalesce(p_actor_email, ''), coalesce(p_correlation_id, '')
  );

  return jsonb_build_object('account_id', p_account_id, 'user_id', p_user_id, 'action', v_action, 'enabled', coalesce(p_enabled, false));
end;
$$;

-- ---------------------------------------------------------------------------
-- 4) RLS + LEAST-PRIVILEGE ACLs for the new audit table + RPC. Audit is service-role-only; the RPC executes as
--    service_role ONLY (the admin api/ layer authorizes before calling it). No anon/public/authenticated write path.
-- ---------------------------------------------------------------------------
alter table public.account_campaign_map_grant_audit enable row level security;
revoke all on table public.account_campaign_map_grant_audit from public, anon, authenticated, service_role;
grant select, insert on table public.account_campaign_map_grant_audit to service_role;

revoke all on function public.set_campaign_map_capability(text, text, text, uuid, boolean, uuid, text, text) from public, anon, authenticated;
grant execute on function public.set_campaign_map_capability(text, text, text, uuid, boolean, uuid, text, text) to service_role;
