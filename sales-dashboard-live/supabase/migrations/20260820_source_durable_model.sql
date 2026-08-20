-- ===========================================================================
-- Scheduler v2 — DURABLE SOURCE MODEL: history, coverage, controls, run status
-- ===========================================================================
--
-- >>> PREPARED, UNAPPLIED. DO NOT APPLY via npm run db:migrate or any bulk apply.
-- >>> Applied ONLY via a reviewed single-file Gate after approval. Earlier migrations are FROZEN.
--
-- ADDITIVE + IDEMPOTENT. Adds FIVE tables; changes no existing table; stores no
-- secret. Repeated execution is safe.
--
-- WHY: the 24-hour source_export_cache is a per-cycle reuse cache, NOT permanent
-- history. The source-first model needs durable, queryable evidence:
--   1. source_oli_daily_history  — the canonical Order Line Items sales fragment at
--      account/date/SKU/ASIN/currency grain. PRIMARY KEY = the full canonical grain,
--      so the rolling 7-day refresh UPSERTS idempotently and a late Amazon
--      correction REPLACES its matching row (never duplicates it).
--   2. source_coverage           — proven successful export windows per
--      (organization, connection, account, source). Only status='succeeded' rows
--      exist (mirrors ads_sync_coverage): a synced-but-empty window is proven
--      evidence, and COMPLETED historical coverage is never exported again.
--      Organization-wide sources use account_id = '__organization'.
--   3. source_controls           — SOURCE-level operator controls (Data Sync
--      Center): paused stops NEW source exports only (durable data + LKG snapshots
--      always preserved); schedule_enabled defaults FALSE for every source (the
--      inert scheduler requires a reviewed durable enablement).
--   4. source_run_status         — the per-(source, bucket) operator status card:
--      last attempt/success, safe error, covered window, account/batch counts, and
--      creates/tokens spent vs ceiling. Safe display fields only, never a secret.
--   5. source_snapshots          — the latest VALIDATED current-state payload
--      pointer per (source, scope): catalog / FBA inventory keep their latest-good
--      snapshot durably; a failed refresh never replaces a validated one (the
--      wrapper writes only on validated success; validated_at is NOT NULL).

-- ---------------------------------------------------------------------------
-- 1. source_oli_daily_history — canonical OLI sales rows (durable history).
-- ---------------------------------------------------------------------------
create table if not exists public.source_oli_daily_history (
  organization_fingerprint text not null,
  connection_id text not null default 'primary'
    constraint source_oli_daily_history_connection_id_check check (connection_id in ('primary', 'dd-secondary')),
  account_id text not null
    constraint source_oli_daily_history_account_nonblank check (char_length(btrim(account_id)) > 0),
  seller_or_vendor_id text not null
    constraint source_oli_daily_history_seller_nonblank check (char_length(btrim(seller_or_vendor_id)) > 0),
  sale_date date not null,
  sku text not null,
  child_asin text not null,
  currency text not null
    constraint source_oli_daily_history_currency_check check (currency ~ '^[A-Z]{3}$'),
  sales_amount numeric not null,
  units numeric not null,
  source_request_hash text not null
    constraint source_oli_daily_history_hash_nonblank check (char_length(btrim(source_request_hash)) > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint source_oli_daily_history_pk
    primary key (organization_fingerprint, connection_id, account_id, sale_date, sku, child_asin, currency)
);

create index if not exists source_oli_daily_history_account_date_idx
  on public.source_oli_daily_history (account_id, sale_date);
create index if not exists source_oli_daily_history_org_date_idx
  on public.source_oli_daily_history (organization_fingerprint, sale_date);

-- ---------------------------------------------------------------------------
-- 2. source_coverage — proven successful export windows per account/source.
-- ---------------------------------------------------------------------------
create table if not exists public.source_coverage (
  organization_fingerprint text not null,
  connection_id text not null default 'primary'
    constraint source_coverage_connection_id_check check (connection_id in ('primary', 'dd-secondary')),
  account_id text not null
    constraint source_coverage_account_nonblank check (char_length(btrim(account_id)) > 0),
  source_key text not null
    constraint source_coverage_source_key_nonblank check (char_length(btrim(source_key)) > 0),
  covered_from date not null,
  covered_to date not null,
  status text not null default 'succeeded'
    constraint source_coverage_status_check check (status in ('succeeded')),
  source_refreshed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint source_coverage_window_check check (covered_from <= covered_to),
  constraint source_coverage_pk
    primary key (organization_fingerprint, connection_id, account_id, source_key, covered_from, covered_to)
);

create index if not exists source_coverage_lookup_idx
  on public.source_coverage (account_id, source_key, covered_from);

-- ---------------------------------------------------------------------------
-- 3. source_controls — source-level pause/resume + inert schedule enablement.
-- ---------------------------------------------------------------------------
create table if not exists public.source_controls (
  source_key text primary key
    constraint source_controls_source_key_nonblank check (char_length(btrim(source_key)) > 0),
  paused boolean not null default false,
  schedule_enabled boolean not null default false,
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now()
);

-- Seed every registered source family PAUSED-off and SCHEDULE-off (defaults OFF; a reviewed durable
-- enablement is required before any schedule may run). Idempotent: on conflict do nothing.
insert into public.source_controls (source_key) values
  ('order-line-items'), ('product-catalog'), ('settlements'), ('returns'),
  ('profit-by-sku-date'), ('sales-traffic-asin-date'), ('listings'), ('listings-raw'),
  ('fba-inventory-health'), ('content-changes'), ('sqp-weekly'), ('sqp-monthly'),
  ('ads-campaign-date'), ('ads-asin-date'), ('ads-targeting-date'), ('ads-search-terms-date')
on conflict (source_key) do nothing;

-- ---------------------------------------------------------------------------
-- 4. source_run_status — the per-(source, bucket) operator status card.
-- ---------------------------------------------------------------------------
create table if not exists public.source_run_status (
  source_key text not null
    constraint source_run_status_source_key_nonblank check (char_length(btrim(source_key)) > 0),
  bucket text not null
    constraint source_run_status_bucket_check check (bucket in ('us', 'non-us')),
  last_status text not null default 'never'
    constraint source_run_status_last_status_check check (last_status in ('never', 'running', 'succeeded', 'partial', 'failed', 'paused')),
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  safe_error_code text,
  safe_error_stage text,
  covered_from date,
  covered_to date,
  accounts_completed integer not null default 0
    constraint source_run_status_accounts_completed_nonneg check (accounts_completed >= 0),
  accounts_failed integer not null default 0
    constraint source_run_status_accounts_failed_nonneg check (accounts_failed >= 0),
  accounts_total integer not null default 0
    constraint source_run_status_accounts_total_nonneg check (accounts_total >= 0),
  batch_count integer not null default 0
    constraint source_run_status_batch_count_nonneg check (batch_count >= 0),
  creates_spent integer not null default 0
    constraint source_run_status_creates_spent_nonneg check (creates_spent >= 0),
  tokens_spent integer not null default 0
    constraint source_run_status_tokens_spent_nonneg check (tokens_spent >= 0),
  creates_ceiling integer,
  tokens_ceiling integer,
  updated_at timestamptz not null default now(),
  constraint source_run_status_pk primary key (source_key, bucket)
);

-- ---------------------------------------------------------------------------
-- 5. source_snapshots — latest VALIDATED current-state payload pointer.
-- ---------------------------------------------------------------------------
-- Organization/connection ISOLATED durable identity (senior-review finding 5): two organizations (or the
-- primary vs dd-secondary connection) can never share/overwrite a snapshot pointer. The payload lives at an
-- IMMUTABLE CONTENT-ADDRESSED object path (the object name embeds payload_sha = sha256 of the canonical
-- rows JSON), so the metadata row and the hydrated payload provably belong to the SAME save: hydration
-- re-derives the content hash from the object name and a pointer can never reference another save's bytes.
create table if not exists public.source_snapshots (
  organization_fingerprint text not null
    constraint source_snapshots_org_nonblank check (char_length(btrim(organization_fingerprint)) > 0),
  connection_id text not null default 'primary'
    constraint source_snapshots_connection_id_check check (connection_id in ('primary', 'dd-secondary')),
  source_key text not null
    constraint source_snapshots_source_key_nonblank check (char_length(btrim(source_key)) > 0),
  scope_key text not null
    constraint source_snapshots_scope_key_nonblank check (char_length(btrim(scope_key)) > 0),
  object_path text not null
    constraint source_snapshots_object_path_nonblank check (char_length(btrim(object_path)) > 0),
  payload_sha text not null
    constraint source_snapshots_payload_sha_nonblank check (char_length(btrim(payload_sha)) > 0),
  row_count integer not null
    constraint source_snapshots_row_count_nonneg check (row_count >= 0),
  payload_bytes bigint not null default 0
    constraint source_snapshots_payload_bytes_nonneg check (payload_bytes >= 0),
  source_request_hash text not null
    constraint source_snapshots_hash_nonblank check (char_length(btrim(source_request_hash)) > 0),
  validated_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint source_snapshots_pk primary key (organization_fingerprint, connection_id, source_key, scope_key)
);

-- ---------------------------------------------------------------------------
-- Touch triggers (reuse public.touch_updated_at from 20260728).
-- ---------------------------------------------------------------------------
drop trigger if exists source_oli_daily_history_touch on public.source_oli_daily_history;
create trigger source_oli_daily_history_touch
  before update on public.source_oli_daily_history
  for each row execute function public.touch_updated_at();

drop trigger if exists source_coverage_touch on public.source_coverage;
create trigger source_coverage_touch
  before update on public.source_coverage
  for each row execute function public.touch_updated_at();

drop trigger if exists source_controls_touch on public.source_controls;
create trigger source_controls_touch
  before update on public.source_controls
  for each row execute function public.touch_updated_at();

drop trigger if exists source_run_status_touch on public.source_run_status;
create trigger source_run_status_touch
  before update on public.source_run_status
  for each row execute function public.touch_updated_at();

drop trigger if exists source_snapshots_touch on public.source_snapshots;
create trigger source_snapshots_touch
  before update on public.source_snapshots
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- 6. replace_oli_history_window — ATOMIC rolling-window replacement + coverage
--    acknowledgement in ONE transaction (senior-review finding 5).
--
-- The rolling 7-day refresh must REPLACE the whole (account, window) slice of
-- history: a grain row that DISAPPEARED from the corrected export (cancelled
-- order, re-attributed SKU) must not survive a merge-duplicates upsert. This
-- RPC deletes the account's rows inside [p_covered_from, p_covered_to], inserts
-- the corrected rows, and upserts the proven coverage window ATOMICALLY -- the
-- data replacement and the coverage acknowledgement either both commit or both
-- roll back, so coverage can never claim a window whose rows were not written.
-- An EMPTY p_rows is valid evidence (a zero-sales window): delete + ack only.
-- Every row is validated fail-closed BEFORE any mutation; the table CHECK
-- constraints re-validate at insert.
-- ---------------------------------------------------------------------------
create or replace function public.replace_oli_history_window(
  p_organization_fingerprint text,
  p_connection_id text,
  p_account_id text,
  p_covered_from date,
  p_covered_to date,
  p_rows jsonb,
  p_source_refreshed_at timestamptz default now()
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row jsonb;
  v_deleted integer := 0;
  v_inserted integer := 0;
begin
  if p_organization_fingerprint is null or char_length(btrim(p_organization_fingerprint)) = 0 then
    raise exception 'replace_oli_history_window: blank organization fingerprint';
  end if;
  if p_connection_id is null or p_connection_id not in ('primary', 'dd-secondary') then
    raise exception 'replace_oli_history_window: invalid connection id';
  end if;
  if p_account_id is null or char_length(btrim(p_account_id)) = 0 then
    raise exception 'replace_oli_history_window: blank account id';
  end if;
  if p_covered_from is null or p_covered_to is null or p_covered_from > p_covered_to then
    raise exception 'replace_oli_history_window: invalid coverage window';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'replace_oli_history_window: p_rows must be a jsonb array';
  end if;

  -- Validate EVERY row fail-closed BEFORE any mutation (grain completeness + window membership).
  for v_row in select * from jsonb_array_elements(p_rows) loop
    if coalesce(btrim(v_row->>'seller_or_vendor_id'), '') = ''
      or coalesce(v_row->>'sale_date', '') = ''
      or (v_row->>'sale_date')::date < p_covered_from
      or (v_row->>'sale_date')::date > p_covered_to
      or coalesce(v_row->>'currency', '') !~ '^[A-Z]{3}$'
      or coalesce(btrim(v_row->>'source_request_hash'), '') = ''
      or (v_row->>'sales_amount') is null
      or (v_row->>'units') is null then
      raise exception 'replace_oli_history_window: malformed history row; refusing the whole window';
    end if;
  end loop;

  delete from public.source_oli_daily_history
    where organization_fingerprint = p_organization_fingerprint
      and connection_id = p_connection_id
      and account_id = p_account_id
      and sale_date between p_covered_from and p_covered_to;
  get diagnostics v_deleted = row_count;

  insert into public.source_oli_daily_history (
    organization_fingerprint, connection_id, account_id, seller_or_vendor_id,
    sale_date, sku, child_asin, currency, sales_amount, units, source_request_hash
  )
  select
    p_organization_fingerprint, p_connection_id, p_account_id,
    btrim(r->>'seller_or_vendor_id'),
    (r->>'sale_date')::date,
    coalesce(r->>'sku', ''),
    coalesce(r->>'child_asin', ''),
    r->>'currency',
    (r->>'sales_amount')::numeric,
    (r->>'units')::numeric,
    btrim(r->>'source_request_hash')
  from jsonb_array_elements(p_rows) as r;
  get diagnostics v_inserted = row_count;

  -- The coverage ACKNOWLEDGEMENT commits in the SAME transaction as the replacement above.
  insert into public.source_coverage (
    organization_fingerprint, connection_id, account_id, source_key,
    covered_from, covered_to, status, source_refreshed_at
  ) values (
    p_organization_fingerprint, p_connection_id, p_account_id, 'order-line-items',
    p_covered_from, p_covered_to, 'succeeded', coalesce(p_source_refreshed_at, now())
  )
  on conflict (organization_fingerprint, connection_id, account_id, source_key, covered_from, covered_to)
  do update set source_refreshed_at = excluded.source_refreshed_at, updated_at = now();

  return jsonb_build_object('replaced', v_deleted, 'inserted', v_inserted);
end;
$$;

-- ---------------------------------------------------------------------------
-- RLS: enabled everywhere; dashboard admins may READ the operator surfaces
-- (controls / run status / coverage); history + snapshots are service-role only
-- (no policy). All writes go through the service-role wrappers.
-- ---------------------------------------------------------------------------
alter table public.source_oli_daily_history enable row level security;
alter table public.source_coverage enable row level security;
alter table public.source_controls enable row level security;
alter table public.source_run_status enable row level security;
alter table public.source_snapshots enable row level security;

drop policy if exists source_coverage_admin_read on public.source_coverage;
create policy source_coverage_admin_read on public.source_coverage
  for select to authenticated using (public.is_dashboard_admin());

drop policy if exists source_controls_admin_read on public.source_controls;
create policy source_controls_admin_read on public.source_controls
  for select to authenticated using (public.is_dashboard_admin());

drop policy if exists source_run_status_admin_read on public.source_run_status;
create policy source_run_status_admin_read on public.source_run_status
  for select to authenticated using (public.is_dashboard_admin());

-- ---------------------------------------------------------------------------
-- EXACT LEAST-PRIVILEGE ACLs, RECONCILED WITH THE POLICY INTENT (finding 9).
-- Supabase default privileges would otherwise leave service_role with ALL.
--
-- POLICY <-> ACL RECONCILIATION (explicit):
--   - source_coverage / source_controls / source_run_status: dashboard ADMINS may
--     READ these operator surfaces through PostgREST. That requires BOTH the
--     table-level GRANT SELECT to authenticated AND the RLS admin-read policy
--     (the policy alone is INERT without the grant; the grant alone would expose
--     rows to every authenticated user without the policy). anon/public stay
--     fully revoked.
--   - source_oli_daily_history / source_snapshots: service-role-only surfaces.
--     NO policy exists and NO authenticated grant exists -- both must stay
--     absent together (the audit enforces policy absence AND the revoke).
--   - source_oli_daily_history is written ONLY through replace_oli_history_window
--     (SECURITY DEFINER): service_role keeps SELECT alone, so no direct write can
--     bypass the atomic replacement + coverage acknowledgement.
--   - the other four tables are written by their reviewed service-role wrappers:
--     service_role keeps exactly SELECT, INSERT, UPDATE (no DELETE anywhere --
--     durable evidence is never deleted by the application role).
-- ---------------------------------------------------------------------------
revoke all on table public.source_oli_daily_history from public, anon, authenticated, service_role;
grant select on table public.source_oli_daily_history to service_role;

revoke all on table public.source_coverage from public, anon, authenticated, service_role;
grant select, insert, update on table public.source_coverage to service_role;
grant select on table public.source_coverage to authenticated;

revoke all on table public.source_controls from public, anon, authenticated, service_role;
grant select, insert, update on table public.source_controls to service_role;
grant select on table public.source_controls to authenticated;

revoke all on table public.source_run_status from public, anon, authenticated, service_role;
grant select, insert, update on table public.source_run_status to service_role;
grant select on table public.source_run_status to authenticated;

revoke all on table public.source_snapshots from public, anon, authenticated, service_role;
grant select, insert, update on table public.source_snapshots to service_role;

revoke all on function public.replace_oli_history_window(text, text, text, date, date, jsonb, timestamptz) from public, anon, authenticated;
grant execute on function public.replace_oli_history_window(text, text, text, date, date, jsonb, timestamptz) to service_role;
