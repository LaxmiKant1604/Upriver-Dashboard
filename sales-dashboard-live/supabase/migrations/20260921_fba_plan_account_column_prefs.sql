-- ===========================================================================
-- FBA Shipment Plan -- ACCOUNT-level (shared) column-visibility preferences
-- ===========================================================================
--
-- >>> ADDITIVE + IDEMPOTENT. Apply forward via the tracked db:migrate runner (public.app_schema_migrations); it edits
-- >>> NO prior migration. Repeated execution is safe (create table if not exists / create policy after drop). The
-- >>> runner wraps each migration in a single transaction.
--
-- WHY: the FBA Shipment Plan column chooser now saves each SELECTED ACCOUNT's show/hide layout as a SHARED,
-- account-level display preference. Any dashboard user authorized for the account sees + may update the same layout;
-- each account keeps its own. This is a NEW dedicated table -- the existing per-user public.fba_plan_column_prefs
-- (shared with SKU Movement) is deliberately UNTOUCHED and stays user-scoped.
--
-- IDENTITY is the COMPLETE trusted key (organization_fingerprint, connection_id, account_id, report_key) -- never
-- account_id alone. The api/ layer authenticates the user, authorizes account access, validates the column ids
-- against the canonical registry, and derives the org fingerprint + connection SERVER-SIDE (never from the browser).
--
-- ISOLATION / LEAST PRIVILEGE: RLS restricts reads to a dashboard admin or a holder of account_permissions for the
-- row's account. Writes go ONLY through the service role (the api/ layer authorizes + validates). No public/anon
-- grants; the browser can never write directly. This table stores NO DataDoe evidence and no source-derived data;
-- a report re-derive never reads or writes it.

-- ---------------------------------------------------------------------------
-- 1) fba_plan_account_column_prefs -- one row per (org, connection, account, report_key). hidden_columns is a jsonb
--    array of stable column ids; an absent row (or empty array) means "all defaults visible". Same jsonb-array shape
--    as the reviewed per-user table, so the store code + validation are consistent.
-- ---------------------------------------------------------------------------
create table if not exists public.fba_plan_account_column_prefs (
  organization_fingerprint text not null
    constraint fba_plan_acct_cols_org_nonblank check (char_length(btrim(organization_fingerprint)) > 0),
  connection_id text not null default 'primary'
    constraint fba_plan_acct_cols_conn_check check (connection_id in ('primary', 'dd-secondary')),
  account_id text not null
    constraint fba_plan_acct_cols_account_nonblank check (char_length(btrim(account_id)) > 0),
  report_key text not null default 'fba-plan'
    constraint fba_plan_acct_cols_report_check check (char_length(btrim(report_key)) > 0),
  hidden_columns jsonb not null default '[]'::jsonb
    constraint fba_plan_acct_cols_hidden_is_array check (jsonb_typeof(hidden_columns) = 'array'),
  updated_by uuid references auth.users (id) on delete set null,
  updated_by_email text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint fba_plan_acct_cols_pk primary key (organization_fingerprint, connection_id, account_id, report_key)
);
create index if not exists fba_plan_acct_cols_account_idx on public.fba_plan_account_column_prefs (account_id);
drop trigger if exists fba_plan_acct_cols_touch on public.fba_plan_account_column_prefs;
create trigger fba_plan_acct_cols_touch before update on public.fba_plan_account_column_prefs
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- 2) RLS + LEAST-PRIVILEGE ACLs. Reads are ACCOUNT-SCOPED (dashboard admin OR account_permissions). Writes go ONLY
--    through the service role (the api/ layer authorizes account access + validates + audits). Mirrors the reviewed
--    sku_movement_identifier pattern exactly. PostgreSQL 17 MAINTAIN not granted.
-- ---------------------------------------------------------------------------
alter table public.fba_plan_account_column_prefs enable row level security;

drop policy if exists fba_plan_acct_cols_read on public.fba_plan_account_column_prefs;
create policy fba_plan_acct_cols_read on public.fba_plan_account_column_prefs for select to authenticated
  using (public.is_dashboard_admin() or exists (
    select 1 from public.account_permissions p where p.user_id = auth.uid() and p.account_id = fba_plan_account_column_prefs.account_id
  ));

revoke all on table public.fba_plan_account_column_prefs from public, anon, authenticated, service_role;
grant select on table public.fba_plan_account_column_prefs to authenticated;
grant select, insert, update, delete on table public.fba_plan_account_column_prefs to service_role;
