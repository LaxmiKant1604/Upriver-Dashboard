-- ===========================================================================
-- ACCOUNT + BRAND AUTHORIZATION -- explicit per-(user, account) brand scope mode + selected-brand grants + audit
-- ===========================================================================
--
-- >>> ADDITIVE + IDEMPOTENT. Apply forward via the tracked db:migrate runner (public.app_schema_migrations); it
-- >>> edits NO prior migration and touches NO report/source table. Repeated execution is safe (add column if not
-- >>> exists / create table if not exists / create or replace).
--
-- Upgrades authorization from ACCOUNT-ONLY to ACCOUNT + BRAND. An account grant (a public.account_permissions row)
-- now carries an EXPLICIT brand_scope_mode; a SELECTED_BRANDS grant lists its permitted canonical brand keys in the
-- new public.account_brand_grant child table. The mode is NEVER inferred from null / empty / legacy behaviour:
--   * every existing account grant is backfilled to an explicit ALL_BRANDS below (no user loses current access);
--   * the column DEFAULT keeps the existing invite/edit account-write path (which never sets it) granting ALL_BRANDS;
--   * a SELECTED_BRANDS grant is only ever produced by the atomic RPC replace_account_brand_scope.
-- Removing an account grant CASCADES to its brand grants only (never to report/source data). No report data, snapshot,
-- source history, scheduler, or control is touched by this migration.

-- ---------------------------------------------------------------------------
-- 1) account_permissions -- the ACCOUNT GRANT gains an explicit brand scope mode + provenance (additive columns).
-- ---------------------------------------------------------------------------
alter table public.account_permissions
  add column if not exists brand_scope_mode text not null default 'ALL_BRANDS';
alter table public.account_permissions
  add column if not exists organization_fingerprint text;
alter table public.account_permissions
  add column if not exists granted_by uuid references auth.users (id) on delete set null;
alter table public.account_permissions
  add column if not exists updated_at timestamptz not null default now();

-- Valid modes only. Added as NOT VALID first would allow bad legacy rows; here every existing row already has the
-- DEFAULT 'ALL_BRANDS', so the constraint validates immediately. Idempotent (drop-if-exists then add).
alter table public.account_permissions drop constraint if exists account_permissions_brand_scope_mode_check;
alter table public.account_permissions
  add constraint account_permissions_brand_scope_mode_check
  check (brand_scope_mode in ('ALL_BRANDS', 'SELECTED_BRANDS'));

-- EXPLICIT backfill (Phase 10 belt-and-suspenders): make every pre-existing grant's mode a real stored ALL_BRANDS,
-- not merely a column default, and stamp updated_at. Idempotent (only touches rows whose mode is not yet a valid
-- explicit value -- after the first run there are none).
update public.account_permissions
  set brand_scope_mode = 'ALL_BRANDS'
  where brand_scope_mode is null or brand_scope_mode not in ('ALL_BRANDS', 'SELECTED_BRANDS');

drop trigger if exists account_permissions_touch on public.account_permissions;
create trigger account_permissions_touch before update on public.account_permissions
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- 2) account_brand_grant -- one permitted CANONICAL brand key per (user, account) for a SELECTED_BRANDS grant.
--    A row is meaningful ONLY while the parent account grant is SELECTED_BRANDS (enforced by the RPC, which is the
--    only writer) AND the brand remains in the account's trusted membership (enforced at serve time by the resolver).
--    canonical_brand_key MUST already be canonical (brandKey: trim + collapse whitespace + lowercase; punctuation
--    preserved) -- the constraint rejects a non-canonical or control-character key so a display label can never be
--    stored as an authorization key.
-- ---------------------------------------------------------------------------
create table if not exists public.account_brand_grant (
  organization_fingerprint text not null default '',
  user_id uuid not null,
  account_id text not null
    constraint account_brand_grant_account_nonblank check (char_length(btrim(account_id)) > 0),
  canonical_brand_key text not null
    constraint account_brand_grant_key_nonblank check (char_length(btrim(canonical_brand_key)) > 0)
    constraint account_brand_grant_key_len check (char_length(canonical_brand_key) <= 300)
    constraint account_brand_grant_key_no_control check (canonical_brand_key !~ '[[:cntrl:]]')
    -- canonical form: no leading/trailing space, single interior spaces, lowercase.
    constraint account_brand_grant_key_canonical check (canonical_brand_key = lower(regexp_replace(btrim(canonical_brand_key), '\s+', ' ', 'g'))),
  brand_display text not null default '',
  granted_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint account_brand_grant_pk primary key (user_id, account_id, canonical_brand_key),
  -- Removing the account grant (or the user) atomically removes its brand grants; never touches report/source data.
  constraint account_brand_grant_account_fk foreign key (user_id, account_id)
    references public.account_permissions (user_id, account_id) on delete cascade,
  constraint account_brand_grant_user_fk foreign key (user_id)
    references auth.users (id) on delete cascade
);
create index if not exists account_brand_grant_user_account_idx on public.account_brand_grant (user_id, account_id);
create index if not exists account_brand_grant_account_brand_idx on public.account_brand_grant (account_id, canonical_brand_key);
drop trigger if exists account_brand_grant_touch on public.account_brand_grant;
create trigger account_brand_grant_touch before update on public.account_brand_grant
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- 3) append-only audit of every brand-scope change (who/whom/account/mode transition/brand diff).
-- ---------------------------------------------------------------------------
create table if not exists public.account_brand_grant_audit (
  id bigint generated always as identity primary key,
  actor_user_id uuid,
  actor_email text not null default '',
  target_user_id uuid not null,
  account_id text not null,
  organization_fingerprint text not null default '',
  action text not null
    constraint account_brand_grant_audit_action_check check (action in ('set-all-brands', 'set-selected-brands', 'revoke-account')),
  previous_mode text,
  new_mode text,
  brands_added text[] not null default '{}',
  brands_removed text[] not null default '{}',
  correlation_id text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists account_brand_grant_audit_grain_idx
  on public.account_brand_grant_audit (target_user_id, account_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 4) replace_account_brand_scope -- the ONLY brand-scope write path. Atomic: UPSERT the account grant with the new
--    mode, REPLACE its selected-brand rows (SELECTED_BRANDS) or CLEAR them (ALL_BRANDS), and append the audit row,
--    all in one transaction. Idempotent (re-applying the same mode + brand set yields the same state + an audit row
--    with empty diffs). The api/ layer authorizes the acting admin + validates the brand keys against the account's
--    trusted membership BEFORE calling this; here we enforce structural invariants only.
-- ---------------------------------------------------------------------------
create or replace function public.replace_account_brand_scope(
  p_organization_fingerprint text,
  p_user_id uuid,
  p_account_id text,
  p_mode text,
  p_brand_keys text[],
  p_brand_displays text[],
  p_actor uuid,
  p_actor_email text,
  p_correlation_id text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_acct text := btrim(coalesce(p_account_id, ''));
  v_mode text := upper(btrim(coalesce(p_mode, '')));
  v_org  text := coalesce(p_organization_fingerprint, '');
  v_prev_mode text;
  v_prev_keys text[];
  v_new_keys text[];
  v_added text[];
  v_removed text[];
  v_i int;
  v_j int;
  v_key text;
  v_disp text;
begin
  if p_user_id is null or v_acct = '' then
    raise exception 'replace_account_brand_scope: user_id and account_id are required';
  end if;
  if v_mode not in ('ALL_BRANDS', 'SELECTED_BRANDS') then
    raise exception 'replace_account_brand_scope: mode must be ALL_BRANDS or SELECTED_BRANDS';
  end if;

  -- Canonicalize + de-duplicate the incoming brand keys (defence in depth; the api/ layer already canonicalizes).
  select coalesce(array_agg(distinct k order by k), '{}')
    into v_new_keys
    from (
      select lower(regexp_replace(btrim(x), '\s+', ' ', 'g')) k
      from unnest(coalesce(p_brand_keys, '{}'::text[])) x
      where btrim(coalesce(x, '')) <> ''
    ) s;

  if v_mode = 'SELECTED_BRANDS' and coalesce(array_length(v_new_keys, 1), 0) = 0 then
    raise exception 'replace_account_brand_scope: SELECTED_BRANDS requires at least one brand key';
  end if;

  -- Snapshot the previous state for the audit diff.
  select brand_scope_mode into v_prev_mode from public.account_permissions
    where user_id = p_user_id and account_id = v_acct;
  select coalesce(array_agg(canonical_brand_key order by canonical_brand_key), '{}')
    into v_prev_keys from public.account_brand_grant
    where user_id = p_user_id and account_id = v_acct;

  -- UPSERT the account grant with the new mode (granting the account if it did not exist yet).
  insert into public.account_permissions (user_id, account_id, organization_fingerprint, brand_scope_mode, granted_by)
    values (p_user_id, v_acct, nullif(v_org, ''), v_mode, p_actor)
    on conflict (user_id, account_id) do update
      set brand_scope_mode = excluded.brand_scope_mode,
          organization_fingerprint = coalesce(nullif(v_org, ''), public.account_permissions.organization_fingerprint),
          granted_by = coalesce(excluded.granted_by, public.account_permissions.granted_by),
          updated_at = now();

  -- Replace the selected-brand rows atomically.
  delete from public.account_brand_grant where user_id = p_user_id and account_id = v_acct;
  if v_mode = 'SELECTED_BRANDS' then
    for v_i in 1 .. coalesce(array_length(v_new_keys, 1), 0) loop
      v_key := v_new_keys[v_i];
      -- displays parallel the ORIGINAL p_brand_keys order; fall back to the key. Find a display whose canonical form matches.
      v_disp := v_key;
      if p_brand_displays is not null then
        for v_j in 1 .. coalesce(array_length(p_brand_keys, 1), 0) loop
          if lower(regexp_replace(btrim(coalesce(p_brand_keys[v_j], '')), '\s+', ' ', 'g')) = v_key
             and v_j <= coalesce(array_length(p_brand_displays, 1), 0)
             and btrim(coalesce(p_brand_displays[v_j], '')) <> '' then
            v_disp := regexp_replace(btrim(p_brand_displays[v_j]), '\s+', ' ', 'g');
            exit;
          end if;
        end loop;
      end if;
      insert into public.account_brand_grant (organization_fingerprint, user_id, account_id, canonical_brand_key, brand_display, granted_by)
        values (v_org, p_user_id, v_acct, v_key, v_disp, p_actor);
    end loop;
  end if;

  -- Audit diff (canonical keys only; never a secret).
  select coalesce(array_agg(k order by k), '{}') into v_added from (select unnest(v_new_keys) k except select unnest(v_prev_keys)) a;
  select coalesce(array_agg(k order by k), '{}') into v_removed from (select unnest(v_prev_keys) k except select unnest(v_new_keys)) r;
  insert into public.account_brand_grant_audit (
    actor_user_id, actor_email, target_user_id, account_id, organization_fingerprint, action,
    previous_mode, new_mode, brands_added, brands_removed, correlation_id
  ) values (
    p_actor, coalesce(p_actor_email, ''), p_user_id, v_acct, v_org,
    case when v_mode = 'ALL_BRANDS' then 'set-all-brands' else 'set-selected-brands' end,
    v_prev_mode, v_mode, v_added, v_removed, coalesce(p_correlation_id, '')
  );

  return jsonb_build_object(
    'user_id', p_user_id, 'account_id', v_acct, 'mode', v_mode,
    'brand_keys', to_jsonb(v_new_keys), 'added', to_jsonb(v_added), 'removed', to_jsonb(v_removed)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 5) RLS + LEAST-PRIVILEGE. A user may READ only their own brand grants; an admin may read all. WRITES go ONLY
--    through the service role (the api/ layer authorizes the acting admin + validates brand membership, then calls
--    the RPC). The audit table is service-role-only.
-- ---------------------------------------------------------------------------
alter table public.account_brand_grant enable row level security;
alter table public.account_brand_grant_audit enable row level security;

drop policy if exists account_brand_grant_read_own on public.account_brand_grant;
create policy account_brand_grant_read_own on public.account_brand_grant for select to authenticated
  using (public.is_dashboard_admin() or user_id = auth.uid());

revoke all on table public.account_brand_grant from public, anon, authenticated, service_role;
grant select on table public.account_brand_grant to authenticated;
grant select, insert, update, delete on table public.account_brand_grant to service_role;

revoke all on table public.account_brand_grant_audit from public, anon, authenticated, service_role;
grant select, insert on table public.account_brand_grant_audit to service_role;

revoke all on function public.replace_account_brand_scope(text, uuid, text, text, text[], text[], uuid, text, text) from public, anon, authenticated;
grant execute on function public.replace_account_brand_scope(text, uuid, text, text, text[], text[], uuid, text, text) to service_role;
