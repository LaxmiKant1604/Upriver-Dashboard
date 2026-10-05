-- ===========================================================================
-- RETURNS (FBA & FBM) EVENT SOURCE -- one durable row per source return event + the derived history (Migration 20260942)
-- ===========================================================================
--
-- >>> PREPARED, NOT APPLIED. ADDITIVE + IDEMPOTENT. Apply forward ONLY through the tracked db:migrate runner
-- >>> (public.app_schema_migrations), exactly this one file, outside the regional scheduler windows:
-- >>>   MIGRATE_ONLY=20260942_returns_event_source.sql npm run db:migrate
-- >>> No BEGIN/COMMIT here: the runner wraps the file in ONE transaction. It edits no prior migration; repeated execution
-- >>> is safe. APPLYING IT SPENDS NOTHING AND ENABLES NOTHING: it writes no row and switches no schedule on.
-- >>> Rollback: Tier 1 (default) = code + schedule only, NO database change (older code ignores every new table and RPC;
-- >>> the fenced legacy writer below keeps refusing every account the event source owns until that account is released
-- >>> with returns-schedule-switch --release-fence, schedule OFF, or Tier 2 runs).
-- >>> Tier 2 = deploy/returns-event-source-rollback.sql (owner-approved, DESTRUCTIVE; deliberately NOT in
-- >>> supabase/migrations, so the ledger runner can never apply it). Neither tier ever drops returned_units.
--
-- WHY. The daily, region-wise "Returns (FBA & FBM)"-only source (design: scratchpad run/returns/DESIGN-v2.md, section 1)
-- keeps EVERY source row of the Returns export as one durable EVENT (no dedupe, no collapse: identity is unproven until
-- validated on real FBA + FBM rows), re-derives the dashboard's existing source_returns_history aggregates from those
-- events in the SAME transaction, and acknowledges the window in source_coverage -- all-or-nothing, so a failed or
-- malformed window never erases last-known-good. The daily run re-reads a 14-day rolling window; the first load per
-- account reads 60 days. Settlements, Order Line Items and every other source are untouched.
--
-- OBJECTS (all new except the fenced legacy RPC and the one added column):
--   1.1  source_returns_events          one row per source row: PK (org, connection, account, return_date, event_key,
--                                       occurrence). order_owner self|other|unknown is computed HERE from
--                                       source_oli_order_audit (pan-EU evidence). license_plate_number is server-side only.
--   1.2  source_returns_account_state   per-account initial-load / last-attempt state, legacy fence, identity hold.
--   1.3  source_returns_refresh_log     append-only audit (counts, hashes, export ids, typed codes; never a row value).
--   1.4  source_returns_create_budget   the DB-enforced per-(region, UTC claim day) create ceiling (claim before every POST).
--   1.4b source_returns_run_lease       one run lease per region (owner token + monotonic generation, DB clock).
--   RPCs (SECURITY DEFINER, search_path pinned, EXECUTE for service_role only):
--     replace_returns_events_window      validate EVERYTHING -> per-account advisory lock -> lease -> state guards ->
--                                        sudden-empty guard -> replace events -> re-derive history -> compact coverage ->
--                                        in-transaction verify -> state 'replaced' -> log.
--     confirm_returns_events_window      the post-commit, zero-token read-back (separate transaction, same lock).
--     record_returns_window_failure      state last_* + log only (never events / history / coverage; a state whose replace
--                                        still awaits its confirm is left untouched -- only the log row is written).
--     rebuild_returns_history_from_events  zero-export re-derive of a covered window (e.g. after an attribution change).
--     claim_returns_create_slot / acquire_ / renew_ / release_returns_run_lease
--     release_returns_legacy_fence / release_returns_identity_hold   owner-approved handbacks.
--   replace_returns_history_window (20260914) is RE-CREATED with its body byte-identical except ONE marked block: the same
--   per-account advisory lock and a refusal while the event source owns the account (legacy_fence and initial_status
--   loaded|complete). Its grants are re-stated. The separate Settlements RPC is not touched.
--   source_returns_history gains returned_units (integer, NULL = units unavailable) -- the LAST statement, so the
--   ACCESS EXCLUSIVE lock it takes is held for the shortest possible time before the runner commits.
--
-- AGGREGATE PARITY (1.6g). History rows group the window's attributed events by (return_date, sku, child_asin,
-- amazon_return_reason, fulfillment_channel, request_status, coalesce(label_paid_by, '')) -- the legacy key set:
-- return_count = count(*) (rows, as before); returned_units only when EVERY event of the group has quantity >= 1;
-- money = coalesce(sum(abs(coalesce(x, 0))), 0) as exact numerics (the legacy JS fold, without float drift);
-- seller label cost only where the payer matches 'seller' (case-insensitive); detailed_disposition = the deterministic
-- min under collation "C" (the payload never reads it). Attribution 'exclude-other-owner' drops order_owner 'other'.
--
-- FIXED ERROR STRINGS. Every RAISE is the literal '<rpc name>: <CODE>': it never interpolates a parameter or an event
-- value, and numeric / date fields are regex-checked (and day-of-month bounded) BEFORE any cast, so no cast error can echo
-- a value either. lib/server/supabase.js parses <CODE> into Error.returnsCode. The codes:
--   RETURNS_PARAM_INVALID          malformed scalar parameter (identity, mode, region, run key, attribution, ttl, ...)
--   RETURNS_BINDING_MISMATCH       primary: account = seller; dd-secondary: account = 'dd-secondary:' || seller
--   RETURNS_WINDOW_INVALID         from / to missing, from > to, or more than 62 days
--   RETURNS_EVIDENCE_INVALID       request hashes (non-empty, 64-hex), export ids (1..128), fragment rows (0..49999)
--   RETURNS_IDENTITY_INVALID       identity status not clear|ambiguous, or identity detail not a flat COUNTS-ONLY object
--                                  (keys ^[A-Za-z][A-Za-z0-9_]{0,63}$, values non-negative integers, <= 4096 bytes)
--   RETURNS_EVENTS_INVALID         p_events not a jsonb array, or its length <> p_expected_count
--   RETURNS_EVENT_INVALID          an event is not an object, carries an unknown key, or a field fails its shape rule
--   RETURNS_SELLER_MISMATCH | RETURNS_MARKETPLACE_MISMATCH | RETURNS_ROW_OUTSIDE_WINDOW   per-event ownership / window
--   RETURNS_EVENT_DUPLICATE        two events share (return_date, event_key, occurrence)
--   RETURNS_UNITS_MISMATCH         sum of the non-null quantities <> p_expected_units
--   RETURNS_IDENTITY_MISMATCH      p_identity_status 'clear' while the events show a keyed collision or identical unkeyed rows
--   RETURNS_LEASE_LOST             the region's run lease is not held, unexpired, by (owner token, generation)
--   RETURNS_NOT_INITIALIZED        rolling replace / rebuild on an account whose initial load is not complete
--   RETURNS_ACCOUNT_HELD           replace for an account under an identity hold (only the owner's release clears it)
--   RETURNS_ACCOUNT_SUDDEN_EMPTY   zero events for a window that already holds events or history (unless allow-shrink)
--   RETURNS_VERIFY_MISMATCH        the in-transaction read-back disagrees (the whole transaction rolls back)
--   RETURNS_CONFIRM_PENDING        rebuild / identity-hold release while a replace still awaits its post-commit confirm
--   RETURNS_COVERAGE_MISSING       rebuild of a window the account's 'returns' coverage does not prove
--   RETURNS_WINDOW_OWNED_BY_EVENT_SOURCE   (replace_returns_history_window only) the legacy writer is fenced off
--
-- LOCKS. Account-level RPCs take pg_advisory_xact_lock(hashtextextended('returns-events|' || org || '|' || connection ||
-- '|' || account, 0)) -- the fenced legacy writer takes the same key, so the two writers serialize per account. The
-- lease RPCs serialize per region on 'returns-run-lease|' || region. Lock order is always account lock -> lease row, and
-- nothing takes them the other way round (no deadlock cycle). All times come from the database clock.
--
-- RULE 9 (PROJECT_GUIDANCE.md): the only setting below is the transaction-scoped SET LOCAL; nothing here issues a
-- session-level SET. Pinned by scripts/returns-event-migration-audit.test.js; executed end-to-end by
-- scripts/worker/returns-event-source-selftest.mjs (PGlite). 7-bit ASCII, LF.

-- A long transaction holding source_returns_history / source_coverage must not queue writers behind this DDL: fail fast.
set local lock_timeout = '10s';

-- ---------------------------------------------------------------------------
-- 1.1 source_returns_events -- ONE ROW PER SOURCE ROW, never collapsed. Text is stored trimmed (normalized in JS; the
--     replace RPC re-checks x = btrim(x)). occurrence numbers identical source rows 1..n (same event_key).
-- ---------------------------------------------------------------------------
create table if not exists public.source_returns_events (
  organization_fingerprint text not null
    constraint source_returns_events_org_nonblank check (char_length(btrim(organization_fingerprint)) > 0),
  connection_id text not null default 'primary'
    constraint source_returns_events_connection_id_check check (connection_id in ('primary', 'dd-secondary')),
  account_id text not null
    constraint source_returns_events_account_nonblank check (char_length(btrim(account_id)) > 0),
  seller_or_vendor_id text not null
    constraint source_returns_events_seller_nonblank check (char_length(btrim(seller_or_vendor_id)) > 0),
  marketplace_country_code text not null
    constraint source_returns_events_marketplace_check check (marketplace_country_code ~ '^[A-Z]{2}$'),
  return_date date not null,
  order_date date,
  sku text not null default '',
  child_asin text not null default '',
  fnsku text,
  amazon_order_id text not null
    constraint source_returns_events_order_id_check check (char_length(btrim(amazon_order_id)) > 0 and char_length(amazon_order_id) <= 64),
  quantity integer
    constraint source_returns_events_quantity_check check (quantity is null or quantity >= 0),
  amazon_return_reason text not null default '',
  fulfillment_channel text not null
    constraint source_returns_events_channel_check check (fulfillment_channel in ('FBA', 'FBM')),
  request_status text not null default '',
  detailed_disposition text,
  rma_id text,
  seller_rma_id text,
  label_paid_by text,
  refunded_amount numeric,
  label_cost numeric,
  cogs_item_value numeric,
  cogs_shipping_value numeric,
  cogs_total_value numeric,
  cogs_currency text
    constraint source_returns_events_cogs_currency_check check (cogs_currency is null or cogs_currency ~ '^[A-Z]{3}$'),
  cogs_present boolean not null,
  license_plate_number text,
  order_owner text not null
    constraint source_returns_events_order_owner_check check (order_owner in ('self', 'other', 'unknown')),
  event_key text not null
    constraint source_returns_events_event_key_check check (event_key ~ '^[0-9a-f]{64}$'),
  occurrence integer not null
    constraint source_returns_events_occurrence_check check (occurrence >= 1),
  source_request_hash text not null
    constraint source_returns_events_request_hash_check check (source_request_hash ~ '^[0-9a-f]{64}$'),
  export_id text
    constraint source_returns_events_export_id_check check (export_id is null or char_length(export_id) between 1 and 128),
  refreshed_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint source_returns_events_pk primary key
    (organization_fingerprint, connection_id, account_id, return_date, event_key, occurrence)
);

create index if not exists source_returns_events_account_date_idx
  on public.source_returns_events (account_id, return_date);
create index if not exists source_returns_events_account_order_idx
  on public.source_returns_events (account_id, amazon_order_id);
create index if not exists source_returns_events_org_date_idx
  on public.source_returns_events (organization_fingerprint, return_date);

-- ---------------------------------------------------------------------------
-- 1.2 source_returns_account_state -- one row per (org, connection, account). initial_status: pending -> loaded (replace
--     committed) -> complete (confirm verified, identity clear). hold_reason excludes the account from every paid plan
--     until release_returns_identity_hold. identity_detail is COUNTS ONLY.
-- ---------------------------------------------------------------------------
create table if not exists public.source_returns_account_state (
  organization_fingerprint text not null
    constraint source_returns_state_org_nonblank check (char_length(btrim(organization_fingerprint)) > 0),
  connection_id text not null default 'primary'
    constraint source_returns_state_connection_id_check check (connection_id in ('primary', 'dd-secondary')),
  account_id text not null
    constraint source_returns_state_account_nonblank check (char_length(btrim(account_id)) > 0),
  marketplace_country_code text not null
    constraint source_returns_state_marketplace_check check (marketplace_country_code ~ '^[A-Z]{2}$'),
  initial_status text not null default 'pending'
    constraint source_returns_state_initial_status_check check (initial_status in ('pending', 'loaded', 'complete')),
  initial_window_from date,
  initial_window_to date,
  initial_loaded_at timestamptz,
  initial_verified_at timestamptz,
  last_mode text
    constraint source_returns_state_last_mode_check check (last_mode is null or last_mode in ('initial', 'rolling')),
  last_window_from date,
  last_window_to date,
  last_status text
    constraint source_returns_state_last_status_check check (last_status is null or last_status in ('replaced', 'succeeded', 'failed')),
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  last_event_count integer,
  last_unit_sum bigint,
  last_request_hashes text[] not null default '{}',
  last_export_ids text[] not null default '{}',
  last_error_code text
    constraint source_returns_state_error_code_check check (last_error_code is null or last_error_code ~ '^[A-Z0-9_]{1,64}$'),
  last_run_key text
    constraint source_returns_state_run_key_check check (last_run_key is null or char_length(last_run_key) between 1 and 200),
  last_region text
    constraint source_returns_state_region_check check (last_region is null or last_region in ('india', 'europe-au', 'us-ca')),
  legacy_fence boolean not null default true,
  identity_status text not null default 'clear'
    constraint source_returns_state_identity_status_check check (identity_status in ('clear', 'ambiguous')),
  hold_reason text
    constraint source_returns_state_hold_reason_check check (hold_reason is null or hold_reason ~ '^[A-Z0-9_]{1,64}$'),
  identity_detail jsonb not null default '{}'
    constraint source_returns_state_identity_detail_check check (jsonb_typeof(identity_detail) = 'object' and pg_column_size(identity_detail) <= 4096),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint source_returns_state_initial_window_check check (initial_window_from is null or initial_window_to is null or initial_window_from <= initial_window_to),
  constraint source_returns_state_last_window_check check (last_window_from is null or last_window_to is null or last_window_from <= last_window_to),
  constraint source_returns_state_pk primary key (organization_fingerprint, connection_id, account_id)
);

drop trigger if exists source_returns_state_touch on public.source_returns_account_state;
create trigger source_returns_state_touch
  before update on public.source_returns_account_state
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- 1.3 source_returns_refresh_log -- append-only audit; detail carries counts, typed codes and dates only.
-- ---------------------------------------------------------------------------
create table if not exists public.source_returns_refresh_log (
  id bigint generated always as identity primary key,
  logged_at timestamptz not null default now(),
  organization_fingerprint text not null,
  connection_id text not null,
  account_id text not null,
  run_key text not null
    constraint source_returns_log_run_key_check check (char_length(run_key) between 1 and 200),
  region text not null
    constraint source_returns_log_region_check check (region in ('india', 'europe-au', 'us-ca')),
  mode text not null
    constraint source_returns_log_mode_check check (mode in ('initial', 'rolling', 'operator')),
  window_from date not null,
  window_to date not null,
  status text not null
    constraint source_returns_log_status_check check (status in ('replaced', 'verified', 'verify-failed', 'failed', 'fence-released', 'hold-released')),
  event_count integer,
  unit_sum bigint,
  request_hashes text[] not null default '{}',
  export_ids text[] not null default '{}',
  fragment_rows integer[] not null default '{}',
  error_code text
    constraint source_returns_log_error_code_check check (error_code is null or error_code ~ '^[A-Z0-9_]{1,64}$'),
  detail jsonb not null default '{}'
    constraint source_returns_log_detail_check check (jsonb_typeof(detail) = 'object' and pg_column_size(detail) <= 8192)
);

create index if not exists source_returns_log_account_idx
  on public.source_returns_refresh_log (account_id, logged_at);

-- ---------------------------------------------------------------------------
-- 1.4 source_returns_create_budget -- the per-(region, UTC claim day) create ceiling. Every create POST claims a slot
--     FIRST (an ambiguous POST therefore counts), and overlapping invocations of one region share the ceiling. The day is
--     the DATABASE's UTC date at claim time, never the caller's as-of: two runs of a region with different --as-of
--     values on the same UTC day share ONE counter. as_of_values lists the as-of of each granted claim (evidence only).
-- ---------------------------------------------------------------------------
create table if not exists public.source_returns_create_budget (
  region text not null
    constraint source_returns_budget_region_check check (region in ('india', 'europe-au', 'us-ca')),
  claim_date date not null,
  creates_claimed integer not null default 0
    constraint source_returns_budget_claimed_nonneg check (creates_claimed >= 0),
  first_claim_at timestamptz,
  last_claim_at timestamptz,
  last_run_key text,
  as_of_values date[] not null default '{}',
  request_hashes text[] not null default '{}',
  constraint source_returns_budget_pk primary key (region, claim_date)
);

-- ---------------------------------------------------------------------------
-- 1.4b source_returns_run_lease -- one live run per region. A grant happens only when no row exists or the row expired
--      (generation + 1); release deletes only the owner's row. Owner tokens are per-run UUIDs, so (token, generation)
--      never repeats even though a fresh row restarts at generation 1.
-- ---------------------------------------------------------------------------
create table if not exists public.source_returns_run_lease (
  region text primary key
    constraint source_returns_lease_region_check check (region in ('india', 'europe-au', 'us-ca')),
  owner_token text not null
    constraint source_returns_lease_owner_check check (char_length(btrim(owner_token)) > 0 and char_length(owner_token) <= 200),
  generation bigint not null
    constraint source_returns_lease_generation_check check (generation >= 1),
  acquired_at timestamptz not null,
  renewed_at timestamptz not null,
  expires_at timestamptz not null,
  run_key text
);

-- ---------------------------------------------------------------------------
-- 1.6 replace_returns_events_window -- the ONE atomic writer of an account window (events + history + coverage + state
--     + log). Every check runs BEFORE any change; any failure RAISES and the whole transaction rolls back (LKG intact).
-- ---------------------------------------------------------------------------
create or replace function public.replace_returns_events_window(
  p_organization_fingerprint text,
  p_connection_id text,
  p_account_id text,
  p_seller_or_vendor_id text,
  p_marketplace_country_code text,
  p_covered_from date,
  p_covered_to date,
  p_mode text,
  p_events jsonb,
  p_expected_count integer,
  p_expected_units bigint,
  p_request_hashes text[],
  p_export_ids text[],
  p_fragment_rows integer[],
  p_source_refreshed_at timestamptz,
  p_attribution text,
  p_allow_shrink boolean,
  p_identity_status text,
  p_identity_detail jsonb,
  p_owner_token text,
  p_generation bigint,
  p_run_key text,
  p_region text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lease public.source_returns_run_lease%rowtype;
  v_state public.source_returns_account_state%rowtype;
  v_has_state boolean;
  v_window_dates text[];
  v_old_count bigint := 0;
  v_old_rows bigint := 0;
  v_old_events bigint := 0;
  v_ev_deleted integer := 0;
  v_ev_inserted integer := 0;
  v_units_inserted bigint := 0;
  v_owner_self integer := 0;
  v_owner_other integer := 0;
  v_owner_unknown integer := 0;
  v_units_unavailable integer := 0;
  v_agg_deleted integer := 0;
  v_agg_inserted integer := 0;
  v_cov_from date;
  v_cov_to date;
  v_next_from date;
  v_next_to date;
  v_check_count bigint;
  v_check_units bigint;
  v_check_attr bigint;
  v_check_hist bigint;
  v_check_cov boolean;
  v_initial_status text;
begin
  -- (a) parameters. Every predicate is written so that a NULL fails closed.
  if not coalesce(char_length(btrim(p_organization_fingerprint)) > 0 and p_organization_fingerprint = btrim(p_organization_fingerprint)
      and p_connection_id in ('primary', 'dd-secondary')
      and char_length(btrim(p_account_id)) > 0 and p_account_id = btrim(p_account_id) and char_length(p_account_id) <= 200
      and char_length(btrim(p_seller_or_vendor_id)) > 0 and p_seller_or_vendor_id = btrim(p_seller_or_vendor_id) and char_length(p_seller_or_vendor_id) <= 200
      and p_marketplace_country_code ~ '^[A-Z]{2}$'
      and p_mode in ('initial', 'rolling')
      and p_attribution in ('as-delivered', 'exclude-other-owner')
      and p_region in ('india', 'europe-au', 'us-ca')
      and char_length(p_run_key) between 1 and 200
      and p_source_refreshed_at is not null
      and p_allow_shrink is not null
      and p_expected_count >= 0 and p_expected_units >= 0, false) then
    raise exception 'replace_returns_events_window: RETURNS_PARAM_INVALID';
  end if;
  if not coalesce((p_connection_id = 'primary' and p_account_id = p_seller_or_vendor_id)
      or (p_connection_id = 'dd-secondary' and p_account_id = 'dd-secondary:' || p_seller_or_vendor_id), false) then
    raise exception 'replace_returns_events_window: RETURNS_BINDING_MISMATCH';
  end if;
  if not coalesce(p_covered_from <= p_covered_to and (p_covered_to - p_covered_from) + 1 <= 62, false) then
    raise exception 'replace_returns_events_window: RETURNS_WINDOW_INVALID';
  end if;
  if not coalesce(cardinality(p_request_hashes) >= 1 and array_ndims(p_request_hashes) = 1
      and not exists (select 1 from unnest(p_request_hashes) h where h is null or h !~ '^[0-9a-f]{64}$')
      and p_export_ids is not null and coalesce(array_ndims(p_export_ids), 1) = 1
      and not exists (select 1 from unnest(p_export_ids) x where x is null or char_length(x) not between 1 and 128 or x <> btrim(x))
      and p_fragment_rows is not null and coalesce(array_ndims(p_fragment_rows), 1) = 1
      and not exists (select 1 from unnest(p_fragment_rows) n where n is null or n < 0 or n > 49999), false) then
    raise exception 'replace_returns_events_window: RETURNS_EVIDENCE_INVALID';
  end if;
  if not coalesce(p_identity_status in ('clear', 'ambiguous')
      and jsonb_typeof(p_identity_detail) = 'object' and pg_column_size(p_identity_detail) <= 4096, false) then
    raise exception 'replace_returns_events_window: RETURNS_IDENTITY_INVALID';
  end if;
  if exists (select 1 from jsonb_each(p_identity_detail) kv
              where kv.key !~ '^[A-Za-z][A-Za-z0-9_]{0,63}$' or jsonb_typeof(kv.value) <> 'number' or kv.value::text !~ '^[0-9]{1,12}$') then
    raise exception 'replace_returns_events_window: RETURNS_IDENTITY_INVALID';
  end if;
  if p_events is null or jsonb_typeof(p_events) <> 'array' then
    raise exception 'replace_returns_events_window: RETURNS_EVENTS_INVALID';
  end if;
  if jsonb_array_length(p_events) <> p_expected_count then
    raise exception 'replace_returns_events_window: RETURNS_EVENTS_INVALID';
  end if;

  -- (b) EVERY event, before any change. Objects only, known keys only (order_owner is accepted and IGNORED: the RPC
  --     computes it).
  if exists (select 1 from jsonb_array_elements(p_events) e where jsonb_typeof(e) <> 'object') then
    raise exception 'replace_returns_events_window: RETURNS_EVENT_INVALID';
  end if;
  if exists (select 1 from jsonb_array_elements(p_events) e cross join lateral jsonb_object_keys(e) k
              where k <> all (array['seller_or_vendor_id', 'marketplace_country_code', 'return_date', 'order_date', 'sku',
                'child_asin', 'fnsku', 'amazon_order_id', 'quantity', 'amazon_return_reason', 'fulfillment_channel',
                'request_status', 'detailed_disposition', 'rma_id', 'seller_rma_id', 'label_paid_by', 'refunded_amount',
                'label_cost', 'cogs_item_value', 'cogs_shipping_value', 'cogs_total_value', 'cogs_currency', 'cogs_present',
                'license_plate_number', 'order_owner', 'event_key', 'occurrence', 'source_request_hash', 'export_id'])) then
    raise exception 'replace_returns_events_window: RETURNS_EVENT_INVALID';
  end if;
  if exists (select 1 from jsonb_array_elements(p_events) e
              where jsonb_typeof(e->'seller_or_vendor_id') is distinct from 'string' or (e->>'seller_or_vendor_id') is distinct from p_seller_or_vendor_id) then
    raise exception 'replace_returns_events_window: RETURNS_SELLER_MISMATCH';
  end if;
  if exists (select 1 from jsonb_array_elements(p_events) e
              where jsonb_typeof(e->'marketplace_country_code') is distinct from 'string' or (e->>'marketplace_country_code') is distinct from p_marketplace_country_code) then
    raise exception 'replace_returns_events_window: RETURNS_MARKETPLACE_MISMATCH';
  end if;
  if exists (select 1 from jsonb_array_elements(p_events) e
              where not coalesce(jsonb_typeof(e->'return_date') = 'string' and (e->>'return_date') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$', false)) then
    raise exception 'replace_returns_events_window: RETURNS_EVENT_INVALID';
  end if;
  -- The window's days as canonical text: membership proves format, calendar validity and window bounds with NO cast of
  -- an event value (rendered through timestamp without time zone, so the session TimeZone can never shift a day).
  select array_agg(to_char((p_covered_from + d)::timestamp, 'YYYY-MM-DD') order by d) into v_window_dates
    from generate_series(0, p_covered_to - p_covered_from) d;
  if exists (select 1 from jsonb_array_elements(p_events) e where not coalesce((e->>'return_date') = any (v_window_dates), false)) then
    raise exception 'replace_returns_events_window: RETURNS_ROW_OUTSIDE_WINDOW';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_events) e
     where not coalesce(
        (coalesce(jsonb_typeof(e->'order_date'), 'null') = 'null'
          or (jsonb_typeof(e->'order_date') = 'string'
              and case when (e->>'order_date') ~ '^(19|20)[0-9]{2}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'
                    then substr(e->>'order_date', 9, 2)::integer
                         <= extract(day from (make_date(substr(e->>'order_date', 1, 4)::integer, substr(e->>'order_date', 6, 2)::integer, 1) + interval '1 month - 1 day'))::integer
                    else false end))
        and jsonb_typeof(e->'sku') = 'string' and (e->>'sku') = btrim(e->>'sku') and char_length(e->>'sku') <= 512
        and jsonb_typeof(e->'child_asin') = 'string' and (e->>'child_asin') = btrim(e->>'child_asin') and char_length(e->>'child_asin') <= 512
        and (coalesce(jsonb_typeof(e->'fnsku'), 'null') = 'null'
          or (jsonb_typeof(e->'fnsku') = 'string' and (e->>'fnsku') = btrim(e->>'fnsku') and char_length(e->>'fnsku') <= 512))
        and jsonb_typeof(e->'amazon_order_id') = 'string' and char_length(btrim(e->>'amazon_order_id')) > 0
          and (e->>'amazon_order_id') = btrim(e->>'amazon_order_id') and char_length(e->>'amazon_order_id') <= 64
        and (coalesce(jsonb_typeof(e->'quantity'), 'null') = 'null' or (e->>'quantity') ~ '^[0-9]{1,9}$')
        and jsonb_typeof(e->'amazon_return_reason') = 'string' and (e->>'amazon_return_reason') = btrim(e->>'amazon_return_reason') and char_length(e->>'amazon_return_reason') <= 512
        and jsonb_typeof(e->'fulfillment_channel') = 'string' and (e->>'fulfillment_channel') in ('FBA', 'FBM')
        and jsonb_typeof(e->'request_status') = 'string' and (e->>'request_status') = btrim(e->>'request_status') and char_length(e->>'request_status') <= 512
        and (coalesce(jsonb_typeof(e->'detailed_disposition'), 'null') = 'null'
          or (jsonb_typeof(e->'detailed_disposition') = 'string' and (e->>'detailed_disposition') = btrim(e->>'detailed_disposition') and char_length(e->>'detailed_disposition') <= 512))
        and (coalesce(jsonb_typeof(e->'rma_id'), 'null') = 'null'
          or (jsonb_typeof(e->'rma_id') = 'string' and (e->>'rma_id') = btrim(e->>'rma_id') and char_length(e->>'rma_id') <= 512))
        and (coalesce(jsonb_typeof(e->'seller_rma_id'), 'null') = 'null'
          or (jsonb_typeof(e->'seller_rma_id') = 'string' and (e->>'seller_rma_id') = btrim(e->>'seller_rma_id') and char_length(e->>'seller_rma_id') <= 512))
        and (coalesce(jsonb_typeof(e->'label_paid_by'), 'null') = 'null'
          or (jsonb_typeof(e->'label_paid_by') = 'string' and (e->>'label_paid_by') = btrim(e->>'label_paid_by') and char_length(e->>'label_paid_by') <= 512))
        and (coalesce(jsonb_typeof(e->'license_plate_number'), 'null') = 'null'
          or (jsonb_typeof(e->'license_plate_number') = 'string' and (e->>'license_plate_number') = btrim(e->>'license_plate_number') and char_length(e->>'license_plate_number') <= 512))
        and (coalesce(jsonb_typeof(e->'refunded_amount'), 'null') = 'null' or (e->>'refunded_amount') ~ '^-?[0-9]{1,24}(\.[0-9]{1,30})?$')
        and (coalesce(jsonb_typeof(e->'label_cost'), 'null') = 'null' or (e->>'label_cost') ~ '^-?[0-9]{1,24}(\.[0-9]{1,30})?$')
        and (coalesce(jsonb_typeof(e->'cogs_item_value'), 'null') = 'null' or (e->>'cogs_item_value') ~ '^-?[0-9]{1,24}(\.[0-9]{1,30})?$')
        and (coalesce(jsonb_typeof(e->'cogs_shipping_value'), 'null') = 'null' or (e->>'cogs_shipping_value') ~ '^-?[0-9]{1,24}(\.[0-9]{1,30})?$')
        and (coalesce(jsonb_typeof(e->'cogs_total_value'), 'null') = 'null' or (e->>'cogs_total_value') ~ '^-?[0-9]{1,24}(\.[0-9]{1,30})?$')
        and (coalesce(jsonb_typeof(e->'cogs_currency'), 'null') = 'null'
          or (jsonb_typeof(e->'cogs_currency') = 'string' and (e->>'cogs_currency') ~ '^[A-Z]{3}$'))
        and jsonb_typeof(e->'cogs_present') = 'boolean'
        and jsonb_typeof(e->'event_key') = 'string' and (e->>'event_key') ~ '^[0-9a-f]{64}$'
        and (e->>'occurrence') ~ '^[1-9][0-9]{0,8}$'
        and jsonb_typeof(e->'source_request_hash') = 'string' and (e->>'source_request_hash') = any (p_request_hashes)
        and (coalesce(jsonb_typeof(e->'export_id'), 'null') = 'null'
          or (jsonb_typeof(e->'export_id') = 'string' and (e->>'export_id') = any (p_export_ids))),
      false)) then
    raise exception 'replace_returns_events_window: RETURNS_EVENT_INVALID';
  end if;
  if exists (select 1 from jsonb_array_elements(p_events) e
              group by e->>'return_date', e->>'event_key', e->>'occurrence' having count(*) > 1) then
    raise exception 'replace_returns_events_window: RETURNS_EVENT_DUPLICATE';
  end if;
  if (select coalesce(sum((e->>'quantity')::bigint), 0) from jsonb_array_elements(p_events) e where (e->>'quantity') is not null)
     <> p_expected_units then
    raise exception 'replace_returns_events_window: RETURNS_UNITS_MISMATCH';
  end if;

  -- (b2) IDENTITY CROSS-CHECK: a runner can never mark an ambiguous window clear. Rule (a): a non-blank physical key
  --      (FBA: order, sku, LPN / FBM: order, sku, RMA -- channel-tagged) on 2+ events; rule (c): 2+ events with the same
  --      event_key and no physical key.
  if p_identity_status = 'clear' and (
       exists (select 1 from jsonb_array_elements(p_events) e
                where (e->>'fulfillment_channel' = 'FBA' and char_length(btrim(coalesce(e->>'license_plate_number', ''))) > 0)
                   or (e->>'fulfillment_channel' = 'FBM' and char_length(btrim(coalesce(e->>'rma_id', ''))) > 0)
                group by e->>'fulfillment_channel', e->>'amazon_order_id', e->>'sku',
                  case when e->>'fulfillment_channel' = 'FBA' then e->>'license_plate_number' else e->>'rma_id' end
                having count(*) > 1)
    or exists (select 1 from jsonb_array_elements(p_events) e
                where not ((e->>'fulfillment_channel' = 'FBA' and char_length(btrim(coalesce(e->>'license_plate_number', ''))) > 0)
                        or (e->>'fulfillment_channel' = 'FBM' and char_length(btrim(coalesce(e->>'rma_id', ''))) > 0))
                group by e->>'event_key' having count(*) > 1)) then
    raise exception 'replace_returns_events_window: RETURNS_IDENTITY_MISMATCH';
  end if;

  -- (c) the per-account lock (shared with confirm / failure / rebuild / releases and the fenced legacy writer).
  perform pg_advisory_xact_lock(hashtextextended('returns-events|' || p_organization_fingerprint || '|' || p_connection_id || '|' || p_account_id, 0));

  -- the live run lease of p_region, held (FOR SHARE) by (p_owner_token, p_generation) and unexpired on the post-lock clock.
  select * into v_lease from public.source_returns_run_lease where region = p_region for share;
  if not found or not coalesce(v_lease.owner_token = p_owner_token and v_lease.generation = p_generation
      and v_lease.expires_at > clock_timestamp(), false) then
    raise exception 'replace_returns_events_window: RETURNS_LEASE_LOST';
  end if;

  select * into v_state from public.source_returns_account_state
   where organization_fingerprint = p_organization_fingerprint and connection_id = p_connection_id and account_id = p_account_id
   for update;
  v_has_state := found;
  if p_mode = 'rolling' and not (v_has_state and v_state.initial_status = 'complete') then
    raise exception 'replace_returns_events_window: RETURNS_NOT_INITIALIZED';
  end if;
  if v_has_state and v_state.hold_reason is not null then
    raise exception 'replace_returns_events_window: RETURNS_ACCOUNT_HELD';
  end if;

  -- (d) SUDDEN-EMPTY GUARD (narrow): returns inside an unchanged window cannot legitimately vanish. A window with no saved
  --     rows at all accepts zero events as proven-empty.
  if p_expected_count = 0 and not p_allow_shrink and (
       exists (select 1 from public.source_returns_events
                where organization_fingerprint = p_organization_fingerprint and connection_id = p_connection_id
                  and account_id = p_account_id and return_date between p_covered_from and p_covered_to)
    or exists (select 1 from public.source_returns_history
                where organization_fingerprint = p_organization_fingerprint and connection_id = p_connection_id
                  and account_id = p_account_id and return_date between p_covered_from and p_covered_to)) then
    raise exception 'replace_returns_events_window: RETURNS_ACCOUNT_SUDDEN_EMPTY';
  end if;

  -- The window's saved rows BEFORE the deletes (two range counts of one account; under the lock nothing else writes
  -- them): (i) requires each delete's row_count to equal its pre-count, so a delete that reached a day outside
  -- [from, to] or another account can never commit.
  select coalesce(sum(return_count), 0), count(*) into v_old_count, v_old_rows from public.source_returns_history
   where organization_fingerprint = p_organization_fingerprint and connection_id = p_connection_id
     and account_id = p_account_id and return_date between p_covered_from and p_covered_to;
  select count(*) into v_old_events from public.source_returns_events
   where organization_fingerprint = p_organization_fingerprint and connection_id = p_connection_id
     and account_id = p_account_id and return_date between p_covered_from and p_covered_to;

  -- (e) + (f) replace the window's events; order_owner from the order-level OLI audit (one hash join over the window's
  --     distinct order ids): self = this account's order, other = another account's, unknown = not in saved OLI.
  delete from public.source_returns_events
   where organization_fingerprint = p_organization_fingerprint and connection_id = p_connection_id
     and account_id = p_account_id and return_date between p_covered_from and p_covered_to;
  get diagnostics v_ev_deleted = row_count;

  with ev as (
    select e from jsonb_array_elements(p_events) e
  ), ids as (
    select distinct e->>'amazon_order_id' as order_id from ev
  ), owners as (
    select a.amazon_order_id as order_id,
           bool_or(a.account_id = p_account_id) as is_self,
           bool_or(a.account_id <> p_account_id) as is_other
      from public.source_oli_order_audit a
      join ids on ids.order_id = a.amazon_order_id
     where a.organization_fingerprint = p_organization_fingerprint and a.connection_id = p_connection_id
       and a.order_id_available
     group by a.amazon_order_id
  ), ins as (
    insert into public.source_returns_events (
      organization_fingerprint, connection_id, account_id, seller_or_vendor_id, marketplace_country_code,
      return_date, order_date, sku, child_asin, fnsku, amazon_order_id, quantity, amazon_return_reason,
      fulfillment_channel, request_status, detailed_disposition, rma_id, seller_rma_id, label_paid_by,
      refunded_amount, label_cost, cogs_item_value, cogs_shipping_value, cogs_total_value, cogs_currency,
      cogs_present, license_plate_number, order_owner, event_key, occurrence, source_request_hash, export_id,
      refreshed_at
    )
    select p_organization_fingerprint, p_connection_id, p_account_id, ev.e->>'seller_or_vendor_id', ev.e->>'marketplace_country_code',
           (ev.e->>'return_date')::date, (ev.e->>'order_date')::date, ev.e->>'sku', ev.e->>'child_asin', ev.e->>'fnsku',
           ev.e->>'amazon_order_id', (ev.e->>'quantity')::integer, ev.e->>'amazon_return_reason',
           ev.e->>'fulfillment_channel', ev.e->>'request_status', ev.e->>'detailed_disposition', ev.e->>'rma_id',
           ev.e->>'seller_rma_id', ev.e->>'label_paid_by',
           (ev.e->>'refunded_amount')::numeric, (ev.e->>'label_cost')::numeric, (ev.e->>'cogs_item_value')::numeric,
           (ev.e->>'cogs_shipping_value')::numeric, (ev.e->>'cogs_total_value')::numeric, ev.e->>'cogs_currency',
           (ev.e->>'cogs_present')::boolean, ev.e->>'license_plate_number',
           case when o.is_self then 'self' when o.is_other then 'other' else 'unknown' end,
           ev.e->>'event_key', (ev.e->>'occurrence')::integer, ev.e->>'source_request_hash', ev.e->>'export_id',
           p_source_refreshed_at
      from ev left join owners o on o.order_id = ev.e->>'amazon_order_id'
    returning order_owner, quantity
  )
  select count(*), coalesce(sum(quantity), 0),
         count(*) filter (where order_owner = 'self'), count(*) filter (where order_owner = 'other'),
         count(*) filter (where order_owner = 'unknown'), count(*) filter (where quantity is null or quantity < 1)
    into v_ev_inserted, v_units_inserted, v_owner_self, v_owner_other, v_owner_unknown, v_units_unavailable
    from ins;

  -- (g) re-derive the window's history from its events (attribution 'exclude-other-owner' drops order_owner 'other').
  delete from public.source_returns_history
   where organization_fingerprint = p_organization_fingerprint and connection_id = p_connection_id
     and account_id = p_account_id and return_date between p_covered_from and p_covered_to;
  get diagnostics v_agg_deleted = row_count;

  insert into public.source_returns_history (
    organization_fingerprint, connection_id, account_id, seller_or_vendor_id, marketplace_country_code,
    return_date, sku, child_asin, amazon_return_reason, fulfillment_channel, request_status, label_payer,
    detailed_disposition, return_count, returned_units, fbm_refunded_amount, fbm_seller_label_cost, cogs_total_value,
    source_request_hash, refreshed_at, calculated_at
  )
  select p_organization_fingerprint, p_connection_id, p_account_id, p_seller_or_vendor_id, p_marketplace_country_code,
         e.return_date, e.sku, e.child_asin, e.amazon_return_reason, e.fulfillment_channel, e.request_status,
         coalesce(e.label_paid_by, ''),
         coalesce(min(nullif(e.detailed_disposition, '') collate "C"), ''),
         count(*),
         case when bool_and(e.quantity is not null and e.quantity >= 1) then sum(e.quantity) end,
         coalesce(sum(abs(coalesce(e.refunded_amount, 0))), 0),
         coalesce(sum(abs(coalesce(e.label_cost, 0))) filter (where coalesce(e.label_paid_by, '') ~* 'seller'), 0),
         coalesce(sum(abs(coalesce(e.cogs_total_value, 0))), 0),
         min(e.source_request_hash), p_source_refreshed_at, now()
    from public.source_returns_events e
   where e.organization_fingerprint = p_organization_fingerprint and e.connection_id = p_connection_id
     and e.account_id = p_account_id and e.return_date between p_covered_from and p_covered_to
     and (p_attribution = 'as-delivered' or e.order_owner <> 'other')
   group by e.return_date, e.sku, e.child_asin, e.amazon_return_reason, e.fulfillment_channel, e.request_status,
            coalesce(e.label_paid_by, '');
  get diagnostics v_agg_inserted = row_count;

  -- (h) coverage, COMPACTED: every 'returns' row overlapping or touching the window (transitively) merges into ONE row.
  v_cov_from := p_covered_from;
  v_cov_to := p_covered_to;
  loop
    select least(v_cov_from, min(c.covered_from)), greatest(v_cov_to, max(c.covered_to)) into v_next_from, v_next_to
      from public.source_coverage c
     where c.organization_fingerprint = p_organization_fingerprint and c.connection_id = p_connection_id
       and c.account_id = p_account_id and c.source_key = 'returns'
       and c.covered_from <= v_cov_to + 1 and c.covered_to >= v_cov_from - 1;
    exit when v_next_from = v_cov_from and v_next_to = v_cov_to;
    v_cov_from := v_next_from;
    v_cov_to := v_next_to;
  end loop;
  delete from public.source_coverage c
   where c.organization_fingerprint = p_organization_fingerprint and c.connection_id = p_connection_id
     and c.account_id = p_account_id and c.source_key = 'returns'
     and c.covered_from <= v_cov_to + 1 and c.covered_to >= v_cov_from - 1;
  insert into public.source_coverage (
    organization_fingerprint, connection_id, account_id, source_key, covered_from, covered_to, status, source_refreshed_at
  ) values (
    p_organization_fingerprint, p_connection_id, p_account_id, 'returns', v_cov_from, v_cov_to, 'succeeded', p_source_refreshed_at
  );

  -- (i) IN-TRANSACTION VERIFY: any disagreement rolls the whole transaction back. Recounts inside the window + coverage,
  --     and each delete removed EXACTLY the window's pre-counted rows (nothing outside [from, to] or the account).
  select count(*), coalesce(sum(quantity), 0), count(*) filter (where p_attribution = 'as-delivered' or order_owner <> 'other')
    into v_check_count, v_check_units, v_check_attr
    from public.source_returns_events
   where organization_fingerprint = p_organization_fingerprint and connection_id = p_connection_id
     and account_id = p_account_id and return_date between p_covered_from and p_covered_to;
  select coalesce(sum(return_count), 0) into v_check_hist from public.source_returns_history
   where organization_fingerprint = p_organization_fingerprint and connection_id = p_connection_id
     and account_id = p_account_id and return_date between p_covered_from and p_covered_to;
  select exists (select 1 from public.source_coverage c
                  where c.organization_fingerprint = p_organization_fingerprint and c.connection_id = p_connection_id
                    and c.account_id = p_account_id and c.source_key = 'returns'
                    and c.covered_from <= p_covered_from and c.covered_to >= p_covered_to) into v_check_cov;
  if not coalesce(v_check_count = p_expected_count and v_check_units = p_expected_units and v_check_hist = v_check_attr
      and v_check_cov and v_ev_deleted = v_old_events and v_agg_deleted = v_old_rows, false) then
    raise exception 'replace_returns_events_window: RETURNS_VERIFY_MISMATCH';
  end if;

  -- (j) state: initial -> 'loaded' (complete only after the post-commit confirm); last_* = this attempt; ambiguous ->
  --     identity hold (no further paid refresh until the owner releases it).
  insert into public.source_returns_account_state as s (
    organization_fingerprint, connection_id, account_id, marketplace_country_code,
    initial_status, initial_window_from, initial_window_to, initial_loaded_at, initial_verified_at,
    last_mode, last_window_from, last_window_to, last_status, last_attempt_at,
    last_event_count, last_unit_sum, last_request_hashes, last_export_ids, last_error_code, last_run_key, last_region,
    legacy_fence, identity_status, hold_reason, identity_detail
  ) values (
    p_organization_fingerprint, p_connection_id, p_account_id, p_marketplace_country_code,
    'loaded', p_covered_from, p_covered_to, now(), null,
    p_mode, p_covered_from, p_covered_to, 'replaced', now(),
    p_expected_count, p_expected_units, p_request_hashes, p_export_ids, null, p_run_key, p_region,
    true, p_identity_status, case when p_identity_status = 'ambiguous' then 'RETURNS_IDENTITY_AMBIGUOUS' end, p_identity_detail
  )
  on conflict (organization_fingerprint, connection_id, account_id) do update set
    marketplace_country_code = excluded.marketplace_country_code,
    initial_status = case when p_mode = 'initial' then 'loaded' else s.initial_status end,
    initial_window_from = case when p_mode = 'initial' then p_covered_from else s.initial_window_from end,
    initial_window_to = case when p_mode = 'initial' then p_covered_to else s.initial_window_to end,
    initial_loaded_at = case when p_mode = 'initial' then now() else s.initial_loaded_at end,
    initial_verified_at = case when p_mode = 'initial' then null else s.initial_verified_at end,
    last_mode = excluded.last_mode,
    last_window_from = excluded.last_window_from,
    last_window_to = excluded.last_window_to,
    last_status = 'replaced',
    last_attempt_at = now(),
    last_event_count = excluded.last_event_count,
    last_unit_sum = excluded.last_unit_sum,
    last_request_hashes = excluded.last_request_hashes,
    last_export_ids = excluded.last_export_ids,
    last_error_code = null,
    last_run_key = excluded.last_run_key,
    last_region = excluded.last_region,
    legacy_fence = true,
    identity_status = excluded.identity_status,
    hold_reason = case when p_identity_status = 'ambiguous' then 'RETURNS_IDENTITY_AMBIGUOUS' else s.hold_reason end,
    identity_detail = excluded.identity_detail,
    updated_at = now()
  returning s.initial_status into v_initial_status;

  -- (k) audit.
  insert into public.source_returns_refresh_log (
    organization_fingerprint, connection_id, account_id, run_key, region, mode, window_from, window_to, status,
    event_count, unit_sum, request_hashes, export_ids, fragment_rows, error_code, detail
  ) values (
    p_organization_fingerprint, p_connection_id, p_account_id, p_run_key, p_region, p_mode, p_covered_from, p_covered_to,
    'replaced', p_expected_count, p_expected_units, p_request_hashes, p_export_ids, p_fragment_rows, null,
    jsonb_build_object('oldCount', v_old_count, 'newCount', p_expected_count, 'attribution', p_attribution,
      'ownerSelf', v_owner_self, 'ownerOther', v_owner_other, 'ownerUnknown', v_owner_unknown,
      'unitsUnavailable', v_units_unavailable, 'identityStatus', p_identity_status,
      'eventsDeleted', v_ev_deleted, 'aggregatesDeleted', v_agg_deleted, 'aggregatesInserted', v_agg_inserted)
  );

  return jsonb_build_object('eventsDeleted', v_ev_deleted, 'eventsInserted', v_ev_inserted, 'unitsInserted', v_units_inserted,
    'aggregatesDeleted', v_agg_deleted, 'aggregatesInserted', v_agg_inserted,
    'ownerSelf', v_owner_self, 'ownerOther', v_owner_other, 'ownerUnknown', v_owner_unknown,
    'oldCount', v_old_count, 'initialStatus', v_initial_status);
end;
$$;

-- ---------------------------------------------------------------------------
-- 1.7 confirm_returns_events_window -- the POST-COMMIT, zero-token read-back (its own transaction, same lock). Superseded
--     (the state no longer describes this replace) -> no change. Otherwise every recount must agree: events (count, units),
--     history (return count == attributed events, rows == groups, null-unit rows, unit sum -- recomputed from the events
--     with the attribution the replace logged) and coverage proving [from, to].
--     verified: last_status 'succeeded'; an initial completes ('complete') ONLY when the replace's OWN 'replaced' log row
--     says identityStatus 'clear' AND hold_reason is null -- never the state's current identity_status, which a write
--     between the replace and this confirm may have changed. Otherwise verified but HELD: initial stays 'loaded' and
--     [from, to] leaves the coverage (rows kept, load NOT complete).
--     mismatch: last_status 'failed' + RETURNS_VERIFY_MISMATCH; initial -> 'pending'; [from, to] leaves the coverage.
-- ---------------------------------------------------------------------------
create or replace function public.confirm_returns_events_window(
  p_organization_fingerprint text,
  p_connection_id text,
  p_account_id text,
  p_covered_from date,
  p_covered_to date,
  p_mode text,
  p_expected_count integer,
  p_expected_units bigint,
  p_request_hashes text[],
  p_run_key text,
  p_region text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_state public.source_returns_account_state%rowtype;
  v_cov record;
  v_attribution text;
  v_identity text;
  v_ev_count bigint;
  v_ev_units bigint;
  v_ev_attr bigint;
  v_exp_groups bigint;
  v_exp_null_groups bigint;
  v_exp_units bigint;
  v_hist_count bigint;
  v_hist_rows bigint;
  v_hist_null_rows bigint;
  v_hist_units bigint;
  v_cov_proven boolean;
  v_ok boolean;
  v_held boolean;
  v_complete boolean;
  v_remove boolean;
  v_initial_status text;
  v_counts jsonb;
begin
  if not coalesce(char_length(btrim(p_organization_fingerprint)) > 0 and p_organization_fingerprint = btrim(p_organization_fingerprint)
      and p_connection_id in ('primary', 'dd-secondary')
      and char_length(btrim(p_account_id)) > 0 and p_account_id = btrim(p_account_id) and char_length(p_account_id) <= 200
      and p_mode in ('initial', 'rolling')
      and p_region in ('india', 'europe-au', 'us-ca')
      and char_length(p_run_key) between 1 and 200
      and p_expected_count >= 0 and p_expected_units >= 0, false) then
    raise exception 'confirm_returns_events_window: RETURNS_PARAM_INVALID';
  end if;
  if not coalesce((p_connection_id = 'primary' and position(':' in p_account_id) = 0)
      or (p_connection_id = 'dd-secondary' and p_account_id like 'dd-secondary:_%'), false) then
    raise exception 'confirm_returns_events_window: RETURNS_BINDING_MISMATCH';
  end if;
  if not coalesce(p_covered_from <= p_covered_to and (p_covered_to - p_covered_from) + 1 <= 62, false) then
    raise exception 'confirm_returns_events_window: RETURNS_WINDOW_INVALID';
  end if;
  if not coalesce(cardinality(p_request_hashes) >= 1 and array_ndims(p_request_hashes) = 1
      and not exists (select 1 from unnest(p_request_hashes) h where h is null or h !~ '^[0-9a-f]{64}$'), false) then
    raise exception 'confirm_returns_events_window: RETURNS_EVIDENCE_INVALID';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('returns-events|' || p_organization_fingerprint || '|' || p_connection_id || '|' || p_account_id, 0));

  select * into v_state from public.source_returns_account_state
   where organization_fingerprint = p_organization_fingerprint and connection_id = p_connection_id and account_id = p_account_id
   for update;
  if not found
     or v_state.last_status is distinct from 'replaced'
     or v_state.last_mode is distinct from p_mode
     or v_state.last_window_from is distinct from p_covered_from
     or v_state.last_window_to is distinct from p_covered_to
     or v_state.last_request_hashes is distinct from p_request_hashes then
    return jsonb_build_object('verified', false, 'reason', 'superseded', 'counts', '{}'::jsonb,
      'initialStatus', case when found then v_state.initial_status end);
  end if;

  -- The attribution AND the identity status THIS replace used: its own 'replaced' log row (written in the replace's
  -- transaction). A missing row / key leaves them NULL: the recount below then fails closed (no attribution) and the
  -- load can never complete (no 'clear').
  select l.detail->>'attribution', l.detail->>'identityStatus' into v_attribution, v_identity
    from public.source_returns_refresh_log l
   where l.organization_fingerprint = p_organization_fingerprint and l.connection_id = p_connection_id
     and l.account_id = p_account_id and l.status = 'replaced'
     and l.window_from = p_covered_from and l.window_to = p_covered_to and l.request_hashes = p_request_hashes
   order by l.id desc
   limit 1;

  select count(*), coalesce(sum(e.quantity), 0),
         count(*) filter (where v_attribution = 'as-delivered' or (v_attribution = 'exclude-other-owner' and e.order_owner <> 'other'))
    into v_ev_count, v_ev_units, v_ev_attr
    from public.source_returns_events e
   where e.organization_fingerprint = p_organization_fingerprint and e.connection_id = p_connection_id
     and e.account_id = p_account_id and e.return_date between p_covered_from and p_covered_to;
  select count(*), count(*) filter (where not g.all_units), coalesce(sum(g.units) filter (where g.all_units), 0)
    into v_exp_groups, v_exp_null_groups, v_exp_units
    from (select bool_and(e.quantity is not null and e.quantity >= 1) as all_units, sum(e.quantity) as units
            from public.source_returns_events e
           where e.organization_fingerprint = p_organization_fingerprint and e.connection_id = p_connection_id
             and e.account_id = p_account_id and e.return_date between p_covered_from and p_covered_to
             and (v_attribution = 'as-delivered' or (v_attribution = 'exclude-other-owner' and e.order_owner <> 'other'))
           group by e.return_date, e.sku, e.child_asin, e.amazon_return_reason, e.fulfillment_channel, e.request_status,
                    coalesce(e.label_paid_by, '')) g;
  select coalesce(sum(h.return_count), 0), count(*), count(*) filter (where h.returned_units is null),
         coalesce(sum(h.returned_units), 0)
    into v_hist_count, v_hist_rows, v_hist_null_rows, v_hist_units
    from public.source_returns_history h
   where h.organization_fingerprint = p_organization_fingerprint and h.connection_id = p_connection_id
     and h.account_id = p_account_id and h.return_date between p_covered_from and p_covered_to;
  select exists (select 1 from public.source_coverage c
                  where c.organization_fingerprint = p_organization_fingerprint and c.connection_id = p_connection_id
                    and c.account_id = p_account_id and c.source_key = 'returns'
                    and c.covered_from <= p_covered_from and c.covered_to >= p_covered_to) into v_cov_proven;

  v_ok := coalesce(v_attribution in ('as-delivered', 'exclude-other-owner')
    and v_ev_count = p_expected_count and v_ev_units = p_expected_units
    and v_hist_count = v_ev_attr and v_hist_rows = v_exp_groups
    and v_hist_null_rows = v_exp_null_groups and v_hist_units = v_exp_units
    and v_cov_proven, false);
  v_counts := jsonb_build_object('events', v_ev_count, 'units', v_ev_units, 'attributedEvents', v_ev_attr,
    'expectedCount', p_expected_count, 'expectedUnits', p_expected_units,
    'historyReturnCount', v_hist_count, 'historyRows', v_hist_rows, 'expectedHistoryRows', v_exp_groups,
    'historyNullUnitRows', v_hist_null_rows, 'expectedNullUnitRows', v_exp_null_groups,
    'historyUnits', v_hist_units, 'expectedHistoryUnits', v_exp_units, 'coverageProven', v_cov_proven);
  -- HELD unless the replace logged 'clear' and no hold is set; an INITIAL completes only when verified and not held, any
  -- other initial (held or failed) leaves the coverage.
  v_held := v_state.hold_reason is not null or v_identity is distinct from 'clear';
  v_complete := v_ok and p_mode = 'initial' and not v_held;
  v_remove := (not v_ok) or (p_mode = 'initial' and not v_complete);

  if v_ok then
    update public.source_returns_account_state
       set last_status = 'succeeded', last_success_at = now(), last_error_code = null,
           initial_status = case when v_complete then 'complete' else initial_status end,
           initial_verified_at = case when v_complete then now() else initial_verified_at end,
           updated_at = now()
     where organization_fingerprint = p_organization_fingerprint and connection_id = p_connection_id and account_id = p_account_id
    returning initial_status into v_initial_status;
  else
    update public.source_returns_account_state
       set last_status = 'failed', last_error_code = 'RETURNS_VERIFY_MISMATCH',
           initial_status = case when p_mode = 'initial' then 'pending' else initial_status end,
           updated_at = now()
     where organization_fingerprint = p_organization_fingerprint and connection_id = p_connection_id and account_id = p_account_id
    returning initial_status into v_initial_status;
  end if;

  -- Remove [from, to] from the account's 'returns' coverage: each overlapping row is deleted and its parts outside the
  -- window re-inserted with that row's own source_refreshed_at (the DELETE completes before the loop body runs).
  if v_remove then
    for v_cov in
      delete from public.source_coverage c
       where c.organization_fingerprint = p_organization_fingerprint and c.connection_id = p_connection_id
         and c.account_id = p_account_id and c.source_key = 'returns'
         and c.covered_from <= p_covered_to and c.covered_to >= p_covered_from
      returning c.covered_from, c.covered_to, c.source_refreshed_at
    loop
      if v_cov.covered_from < p_covered_from then
        insert into public.source_coverage (
          organization_fingerprint, connection_id, account_id, source_key, covered_from, covered_to, status, source_refreshed_at
        ) values (
          p_organization_fingerprint, p_connection_id, p_account_id, 'returns', v_cov.covered_from, p_covered_from - 1, 'succeeded', v_cov.source_refreshed_at
        ) on conflict (organization_fingerprint, connection_id, account_id, source_key, covered_from, covered_to) do nothing;
      end if;
      if v_cov.covered_to > p_covered_to then
        insert into public.source_coverage (
          organization_fingerprint, connection_id, account_id, source_key, covered_from, covered_to, status, source_refreshed_at
        ) values (
          p_organization_fingerprint, p_connection_id, p_account_id, 'returns', p_covered_to + 1, v_cov.covered_to, 'succeeded', v_cov.source_refreshed_at
        ) on conflict (organization_fingerprint, connection_id, account_id, source_key, covered_from, covered_to) do nothing;
      end if;
    end loop;
  end if;

  insert into public.source_returns_refresh_log (
    organization_fingerprint, connection_id, account_id, run_key, region, mode, window_from, window_to, status,
    event_count, unit_sum, request_hashes, error_code, detail
  ) values (
    p_organization_fingerprint, p_connection_id, p_account_id, p_run_key, p_region, p_mode, p_covered_from, p_covered_to,
    case when v_ok then 'verified' else 'verify-failed' end, v_ev_count, v_ev_units, p_request_hashes,
    case when v_ok then null else 'RETURNS_VERIFY_MISMATCH' end,
    v_counts || jsonb_build_object('held', v_held, 'coverageRemoved', v_remove, 'attribution', v_attribution, 'identityStatus', v_identity)
  );

  return jsonb_build_object('verified', v_ok,
    'reason', case when not v_ok then 'mismatch' when v_held then 'held' else 'verified' end,
    'counts', v_counts, 'initialStatus', v_initial_status);
end;
$$;

-- ---------------------------------------------------------------------------
-- 1.8 record_returns_window_failure -- upserts ONLY the state's last_* (+ an unconfirmed initial 'loaded' -> 'pending'
--     unless the account is held) and logs 'failed'. Never touches events, history or coverage. A state whose
--     last_status is 'replaced' (a committed replace still awaiting its confirm) is left ENTIRELY untouched -- every
--     last_* field, the hashes, the counts and initial_status are the zero-token re-verify evidence, and a failure
--     reported by a caller that could not see the replace's outcome must never erase them; the 'failed' log row is
--     still written and the result says stateKept.
-- ---------------------------------------------------------------------------
create or replace function public.record_returns_window_failure(
  p_organization_fingerprint text,
  p_connection_id text,
  p_account_id text,
  p_marketplace_country_code text,
  p_mode text,
  p_covered_from date,
  p_covered_to date,
  p_error_code text,
  p_detail jsonb,
  p_run_key text,
  p_region text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_state public.source_returns_account_state%rowtype;
  v_initial_status text;
  v_kept boolean := false;
begin
  if not coalesce(char_length(btrim(p_organization_fingerprint)) > 0 and p_organization_fingerprint = btrim(p_organization_fingerprint)
      and p_connection_id in ('primary', 'dd-secondary')
      and char_length(btrim(p_account_id)) > 0 and p_account_id = btrim(p_account_id) and char_length(p_account_id) <= 200
      and p_marketplace_country_code ~ '^[A-Z]{2}$'
      and p_mode in ('initial', 'rolling')
      and p_region in ('india', 'europe-au', 'us-ca')
      and char_length(p_run_key) between 1 and 200
      and p_error_code ~ '^[A-Z0-9_]{1,64}$'
      and jsonb_typeof(p_detail) = 'object' and pg_column_size(p_detail) <= 8192, false) then
    raise exception 'record_returns_window_failure: RETURNS_PARAM_INVALID';
  end if;
  if not coalesce((p_connection_id = 'primary' and position(':' in p_account_id) = 0)
      or (p_connection_id = 'dd-secondary' and p_account_id like 'dd-secondary:_%'), false) then
    raise exception 'record_returns_window_failure: RETURNS_BINDING_MISMATCH';
  end if;
  if not coalesce(p_covered_from <= p_covered_to and (p_covered_to - p_covered_from) + 1 <= 62, false) then
    raise exception 'record_returns_window_failure: RETURNS_WINDOW_INVALID';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('returns-events|' || p_organization_fingerprint || '|' || p_connection_id || '|' || p_account_id, 0));

  -- Under the lock: a replace awaiting its confirm keeps its state row byte-identical (no update, no updated_at touch).
  select * into v_state from public.source_returns_account_state
   where organization_fingerprint = p_organization_fingerprint and connection_id = p_connection_id and account_id = p_account_id
   for update;
  if found and v_state.last_status = 'replaced' then
    v_kept := true;
    v_initial_status := v_state.initial_status;
  else
    insert into public.source_returns_account_state as s (
      organization_fingerprint, connection_id, account_id, marketplace_country_code,
      last_mode, last_window_from, last_window_to, last_status, last_attempt_at, last_error_code, last_run_key, last_region
    ) values (
      p_organization_fingerprint, p_connection_id, p_account_id, p_marketplace_country_code,
      p_mode, p_covered_from, p_covered_to, 'failed', now(), p_error_code, p_run_key, p_region
    )
    on conflict (organization_fingerprint, connection_id, account_id) do update set
      marketplace_country_code = excluded.marketplace_country_code,
      initial_status = case when p_mode = 'initial' and s.initial_status = 'loaded' and s.hold_reason is null then 'pending' else s.initial_status end,
      last_mode = excluded.last_mode,
      last_window_from = excluded.last_window_from,
      last_window_to = excluded.last_window_to,
      last_status = 'failed',
      last_attempt_at = now(),
      last_event_count = null,
      last_unit_sum = null,
      last_request_hashes = '{}',
      last_export_ids = '{}',
      last_error_code = excluded.last_error_code,
      last_run_key = excluded.last_run_key,
      last_region = excluded.last_region,
      updated_at = now()
    returning s.initial_status into v_initial_status;
  end if;

  insert into public.source_returns_refresh_log (
    organization_fingerprint, connection_id, account_id, run_key, region, mode, window_from, window_to, status, error_code, detail
  ) values (
    p_organization_fingerprint, p_connection_id, p_account_id, p_run_key, p_region, p_mode, p_covered_from, p_covered_to,
    'failed', p_error_code, p_detail
  );

  return jsonb_build_object('recorded', true, 'initialStatus', v_initial_status, 'stateKept', v_kept);
end;
$$;

-- ---------------------------------------------------------------------------
-- 1.9 rebuild_returns_history_from_events -- ZERO-EXPORT repair / attribution re-derive of a window the account's
--     'returns' coverage proves (so every day in it was written by the replace above, never by the legacy writer). Same
--     lock; requires a complete initial load and no replace awaiting its confirm; same aggregate SQL + an in-transaction
--     verify (history recount + the delete removed exactly the window's pre-counted rows). Seller / marketplace / refreshed_at come from the stored events (identical to the replace's parameters).
-- ---------------------------------------------------------------------------
create or replace function public.rebuild_returns_history_from_events(
  p_organization_fingerprint text,
  p_connection_id text,
  p_account_id text,
  p_covered_from date,
  p_covered_to date,
  p_attribution text,
  p_run_key text,
  p_region text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_state public.source_returns_account_state%rowtype;
  v_old_rows bigint := 0;
  v_agg_deleted integer := 0;
  v_agg_inserted integer := 0;
  v_events bigint;
  v_attr bigint;
  v_hist bigint;
begin
  if not coalesce(char_length(btrim(p_organization_fingerprint)) > 0 and p_organization_fingerprint = btrim(p_organization_fingerprint)
      and p_connection_id in ('primary', 'dd-secondary')
      and char_length(btrim(p_account_id)) > 0 and p_account_id = btrim(p_account_id) and char_length(p_account_id) <= 200
      and p_attribution in ('as-delivered', 'exclude-other-owner')
      and p_region in ('india', 'europe-au', 'us-ca')
      and char_length(p_run_key) between 1 and 200, false) then
    raise exception 'rebuild_returns_history_from_events: RETURNS_PARAM_INVALID';
  end if;
  if not coalesce((p_connection_id = 'primary' and position(':' in p_account_id) = 0)
      or (p_connection_id = 'dd-secondary' and p_account_id like 'dd-secondary:_%'), false) then
    raise exception 'rebuild_returns_history_from_events: RETURNS_BINDING_MISMATCH';
  end if;
  if not coalesce(p_covered_from <= p_covered_to and (p_covered_to - p_covered_from) + 1 <= 62, false) then
    raise exception 'rebuild_returns_history_from_events: RETURNS_WINDOW_INVALID';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('returns-events|' || p_organization_fingerprint || '|' || p_connection_id || '|' || p_account_id, 0));

  select * into v_state from public.source_returns_account_state
   where organization_fingerprint = p_organization_fingerprint and connection_id = p_connection_id and account_id = p_account_id
   for update;
  if not found or v_state.initial_status <> 'complete' then
    raise exception 'rebuild_returns_history_from_events: RETURNS_NOT_INITIALIZED';
  end if;
  if v_state.last_status = 'replaced' then
    raise exception 'rebuild_returns_history_from_events: RETURNS_CONFIRM_PENDING';
  end if;
  if not exists (select 1 from public.source_coverage c
                  where c.organization_fingerprint = p_organization_fingerprint and c.connection_id = p_connection_id
                    and c.account_id = p_account_id and c.source_key = 'returns'
                    and c.covered_from <= p_covered_from and c.covered_to >= p_covered_to) then
    raise exception 'rebuild_returns_history_from_events: RETURNS_COVERAGE_MISSING';
  end if;

  -- The window's history rows BEFORE the delete: the verify requires the delete's row_count to equal it (as in 1.6i).
  select count(*) into v_old_rows from public.source_returns_history
   where organization_fingerprint = p_organization_fingerprint and connection_id = p_connection_id
     and account_id = p_account_id and return_date between p_covered_from and p_covered_to;
  delete from public.source_returns_history
   where organization_fingerprint = p_organization_fingerprint and connection_id = p_connection_id
     and account_id = p_account_id and return_date between p_covered_from and p_covered_to;
  get diagnostics v_agg_deleted = row_count;

  insert into public.source_returns_history (
    organization_fingerprint, connection_id, account_id, seller_or_vendor_id, marketplace_country_code,
    return_date, sku, child_asin, amazon_return_reason, fulfillment_channel, request_status, label_payer,
    detailed_disposition, return_count, returned_units, fbm_refunded_amount, fbm_seller_label_cost, cogs_total_value,
    source_request_hash, refreshed_at, calculated_at
  )
  select p_organization_fingerprint, p_connection_id, p_account_id, min(e.seller_or_vendor_id), min(e.marketplace_country_code),
         e.return_date, e.sku, e.child_asin, e.amazon_return_reason, e.fulfillment_channel, e.request_status,
         coalesce(e.label_paid_by, ''),
         coalesce(min(nullif(e.detailed_disposition, '') collate "C"), ''),
         count(*),
         case when bool_and(e.quantity is not null and e.quantity >= 1) then sum(e.quantity) end,
         coalesce(sum(abs(coalesce(e.refunded_amount, 0))), 0),
         coalesce(sum(abs(coalesce(e.label_cost, 0))) filter (where coalesce(e.label_paid_by, '') ~* 'seller'), 0),
         coalesce(sum(abs(coalesce(e.cogs_total_value, 0))), 0),
         min(e.source_request_hash), max(e.refreshed_at), now()
    from public.source_returns_events e
   where e.organization_fingerprint = p_organization_fingerprint and e.connection_id = p_connection_id
     and e.account_id = p_account_id and e.return_date between p_covered_from and p_covered_to
     and (p_attribution = 'as-delivered' or e.order_owner <> 'other')
   group by e.return_date, e.sku, e.child_asin, e.amazon_return_reason, e.fulfillment_channel, e.request_status,
            coalesce(e.label_paid_by, '');
  get diagnostics v_agg_inserted = row_count;

  select count(*), count(*) filter (where p_attribution = 'as-delivered' or order_owner <> 'other') into v_events, v_attr
    from public.source_returns_events
   where organization_fingerprint = p_organization_fingerprint and connection_id = p_connection_id
     and account_id = p_account_id and return_date between p_covered_from and p_covered_to;
  select coalesce(sum(return_count), 0) into v_hist from public.source_returns_history
   where organization_fingerprint = p_organization_fingerprint and connection_id = p_connection_id
     and account_id = p_account_id and return_date between p_covered_from and p_covered_to;
  if not coalesce(v_hist = v_attr and v_agg_deleted = v_old_rows, false) then
    raise exception 'rebuild_returns_history_from_events: RETURNS_VERIFY_MISMATCH';
  end if;

  return jsonb_build_object('aggregatesDeleted', v_agg_deleted, 'aggregatesInserted', v_agg_inserted,
    'events', v_events, 'attributedEvents', v_attr, 'attribution', p_attribution);
end;
$$;

-- ---------------------------------------------------------------------------
-- 1.4 claim_returns_create_slot -- the DB-enforced create ceiling. Requires the region's live run lease; claims one slot
--     of (region, the DB's UTC claim day) under FOR UPDATE, or refuses at the ceiling. Every create POST claims FIRST.
--     p_as_of stays a validated parameter (the wrapper contract is unchanged) but only lands in as_of_values.
-- ---------------------------------------------------------------------------
create or replace function public.claim_returns_create_slot(
  p_region text,
  p_as_of date,
  p_max_creates integer,
  p_owner_token text,
  p_generation bigint,
  p_run_key text,
  p_request_hash text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lease public.source_returns_run_lease%rowtype;
  v_budget public.source_returns_create_budget%rowtype;
  v_claimed integer;
  v_claim_date date;
begin
  if not coalesce(p_region in ('india', 'europe-au', 'us-ca')
      and p_as_of is not null
      and p_max_creates between 0 and 60
      and char_length(p_run_key) between 1 and 200
      and p_request_hash ~ '^[0-9a-f]{64}$', false) then
    raise exception 'claim_returns_create_slot: RETURNS_PARAM_INVALID';
  end if;
  select * into v_lease from public.source_returns_run_lease where region = p_region for share;
  if not found or not coalesce(v_lease.owner_token = p_owner_token and v_lease.generation = p_generation
      and v_lease.expires_at > clock_timestamp(), false) then
    raise exception 'claim_returns_create_slot: RETURNS_LEASE_LOST';
  end if;

  -- The ceiling's day: the database's UTC date (timestamptz -> UTC wall time -> date; the session TimeZone never shifts it).
  v_claim_date := (now() at time zone 'utc')::date;
  insert into public.source_returns_create_budget (region, claim_date) values (p_region, v_claim_date)
    on conflict (region, claim_date) do nothing;
  select * into v_budget from public.source_returns_create_budget
   where region = p_region and claim_date = v_claim_date
   for update;
  if v_budget.creates_claimed >= p_max_creates then
    return jsonb_build_object('granted', false, 'claimed', v_budget.creates_claimed, 'max', p_max_creates);
  end if;
  update public.source_returns_create_budget
     set creates_claimed = creates_claimed + 1,
         request_hashes = array_append(request_hashes, p_request_hash),
         as_of_values = case when p_as_of = any (as_of_values) then as_of_values else array_append(as_of_values, p_as_of) end,
         first_claim_at = coalesce(first_claim_at, now()),
         last_claim_at = now(),
         last_run_key = p_run_key
   where region = p_region and claim_date = v_claim_date
  returning creates_claimed into v_claimed;
  return jsonb_build_object('granted', true, 'claimed', v_claimed, 'max', p_max_creates);
end;
$$;

-- ---------------------------------------------------------------------------
-- 1.4b the run lease (control_plane_lease pattern, 20260919): a dedicated advisory lock per region serializes the
--      acquirers; every expiry decision uses the post-lock wall clock.
-- ---------------------------------------------------------------------------
create or replace function public.acquire_returns_run_lease(
  p_region text,
  p_owner_token text,
  p_ttl_seconds integer,
  p_run_key text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.source_returns_run_lease%rowtype;
  v_now timestamptz;
  v_gen bigint;
begin
  if not coalesce(p_region in ('india', 'europe-au', 'us-ca')
      and char_length(btrim(p_owner_token)) > 0 and p_owner_token = btrim(p_owner_token) and char_length(p_owner_token) <= 200
      and p_ttl_seconds between 60 and 1800
      and char_length(p_run_key) between 1 and 200, false) then
    raise exception 'acquire_returns_run_lease: RETURNS_PARAM_INVALID';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('returns-run-lease|' || p_region, 0));
  select * into v_row from public.source_returns_run_lease where region = p_region for update;
  v_now := clock_timestamp();
  if found and v_row.expires_at > v_now then
    return jsonb_build_object('granted', false, 'generation', null, 'expiresAt', v_row.expires_at, 'holderRunKey', v_row.run_key);
  end if;
  if found then
    v_gen := v_row.generation + 1;
    update public.source_returns_run_lease
       set owner_token = p_owner_token, generation = v_gen, acquired_at = v_now, renewed_at = v_now,
           expires_at = v_now + make_interval(secs => p_ttl_seconds), run_key = p_run_key
     where region = p_region;
  else
    v_gen := 1;
    insert into public.source_returns_run_lease (region, owner_token, generation, acquired_at, renewed_at, expires_at, run_key)
    values (p_region, p_owner_token, v_gen, v_now, v_now, v_now + make_interval(secs => p_ttl_seconds), p_run_key);
  end if;
  return jsonb_build_object('granted', true, 'generation', v_gen,
    'expiresAt', v_now + make_interval(secs => p_ttl_seconds), 'holderRunKey', p_run_key);
end;
$$;

create or replace function public.renew_returns_run_lease(
  p_region text,
  p_owner_token text,
  p_generation bigint,
  p_ttl_seconds integer
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.source_returns_run_lease%rowtype;
  v_now timestamptz;
begin
  if not coalesce(p_region in ('india', 'europe-au', 'us-ca')
      and char_length(btrim(p_owner_token)) > 0
      and p_generation >= 1
      and p_ttl_seconds between 60 and 1800, false) then
    raise exception 'renew_returns_run_lease: RETURNS_PARAM_INVALID';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('returns-run-lease|' || p_region, 0));
  select * into v_row from public.source_returns_run_lease where region = p_region for update;
  v_now := clock_timestamp();
  if not found or not coalesce(v_row.owner_token = p_owner_token and v_row.generation = p_generation
      and v_row.expires_at > v_now, false) then
    return jsonb_build_object('renewed', false, 'expiresAt', null);
  end if;
  update public.source_returns_run_lease
     set renewed_at = v_now, expires_at = v_now + make_interval(secs => p_ttl_seconds)
   where region = p_region;
  return jsonb_build_object('renewed', true, 'expiresAt', v_now + make_interval(secs => p_ttl_seconds));
end;
$$;

create or replace function public.release_returns_run_lease(
  p_region text,
  p_owner_token text,
  p_generation bigint
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_released boolean;
begin
  if not coalesce(p_region in ('india', 'europe-au', 'us-ca')
      and char_length(btrim(p_owner_token)) > 0
      and p_generation >= 1, false) then
    raise exception 'release_returns_run_lease: RETURNS_PARAM_INVALID';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('returns-run-lease|' || p_region, 0));
  delete from public.source_returns_run_lease
   where region = p_region and owner_token = p_owner_token and generation = p_generation;
  v_released := found;
  return jsonb_build_object('released', v_released);
end;
$$;

-- ---------------------------------------------------------------------------
-- 1.11 release_returns_legacy_fence -- owner-approved handback of ONE account to the legacy writer: fence off, initial
--      'pending' (a re-enable starts with a fresh initial load), every 'returns' coverage row of the account deleted.
-- ---------------------------------------------------------------------------
create or replace function public.release_returns_legacy_fence(
  p_organization_fingerprint text,
  p_connection_id text,
  p_account_id text,
  p_run_key text,
  p_region text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_state public.source_returns_account_state%rowtype;
  v_deleted bigint;
  v_min date;
  v_max date;
begin
  if not coalesce(char_length(btrim(p_organization_fingerprint)) > 0 and p_organization_fingerprint = btrim(p_organization_fingerprint)
      and p_connection_id in ('primary', 'dd-secondary')
      and char_length(btrim(p_account_id)) > 0 and p_account_id = btrim(p_account_id) and char_length(p_account_id) <= 200
      and p_region in ('india', 'europe-au', 'us-ca')
      and char_length(p_run_key) between 1 and 200, false) then
    raise exception 'release_returns_legacy_fence: RETURNS_PARAM_INVALID';
  end if;
  if not coalesce((p_connection_id = 'primary' and position(':' in p_account_id) = 0)
      or (p_connection_id = 'dd-secondary' and p_account_id like 'dd-secondary:_%'), false) then
    raise exception 'release_returns_legacy_fence: RETURNS_BINDING_MISMATCH';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('returns-events|' || p_organization_fingerprint || '|' || p_connection_id || '|' || p_account_id, 0));

  select * into v_state from public.source_returns_account_state
   where organization_fingerprint = p_organization_fingerprint and connection_id = p_connection_id and account_id = p_account_id
   for update;
  if not found then
    return jsonb_build_object('released', false, 'reason', 'no-state');
  end if;

  with gone as (
    delete from public.source_coverage c
     where c.organization_fingerprint = p_organization_fingerprint and c.connection_id = p_connection_id
       and c.account_id = p_account_id and c.source_key = 'returns'
    returning c.covered_from, c.covered_to
  )
  select count(*), min(covered_from), max(covered_to) into v_deleted, v_min, v_max from gone;

  update public.source_returns_account_state
     set legacy_fence = false, initial_status = 'pending', updated_at = now()
   where organization_fingerprint = p_organization_fingerprint and connection_id = p_connection_id and account_id = p_account_id;

  insert into public.source_returns_refresh_log (
    organization_fingerprint, connection_id, account_id, run_key, region, mode, window_from, window_to, status, detail
  ) values (
    p_organization_fingerprint, p_connection_id, p_account_id, p_run_key, p_region, 'operator',
    coalesce(v_min, v_state.last_window_from, v_state.initial_window_from, current_date),
    greatest(coalesce(v_max, v_state.last_window_to, v_state.initial_window_to, current_date),
             coalesce(v_min, v_state.last_window_from, v_state.initial_window_from, current_date)),
    'fence-released',
    jsonb_build_object('coverageRowsDeleted', v_deleted, 'previousInitialStatus', v_state.initial_status)
  );

  return jsonb_build_object('released', true, 'coverageRowsDeleted', v_deleted, 'initialStatus', 'pending');
end;
$$;

-- ---------------------------------------------------------------------------
-- 1.11b release_returns_identity_hold -- owner-approved after reviewing the identity evidence: hold cleared, identity
--       'clear', initial 'pending' (the next run re-does the 60-day initial load and re-checks identity). REFUSED
--       (RETURNS_CONFIRM_PENDING) while last_status is 'replaced': that replace's confirm must settle it first (the next
--       run's zero-token re-verify does) -- releasing earlier would hand the pending confirm an unheld account.
-- ---------------------------------------------------------------------------
create or replace function public.release_returns_identity_hold(
  p_organization_fingerprint text,
  p_connection_id text,
  p_account_id text,
  p_run_key text,
  p_region text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_state public.source_returns_account_state%rowtype;
begin
  if not coalesce(char_length(btrim(p_organization_fingerprint)) > 0 and p_organization_fingerprint = btrim(p_organization_fingerprint)
      and p_connection_id in ('primary', 'dd-secondary')
      and char_length(btrim(p_account_id)) > 0 and p_account_id = btrim(p_account_id) and char_length(p_account_id) <= 200
      and p_region in ('india', 'europe-au', 'us-ca')
      and char_length(p_run_key) between 1 and 200, false) then
    raise exception 'release_returns_identity_hold: RETURNS_PARAM_INVALID';
  end if;
  if not coalesce((p_connection_id = 'primary' and position(':' in p_account_id) = 0)
      or (p_connection_id = 'dd-secondary' and p_account_id like 'dd-secondary:_%'), false) then
    raise exception 'release_returns_identity_hold: RETURNS_BINDING_MISMATCH';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('returns-events|' || p_organization_fingerprint || '|' || p_connection_id || '|' || p_account_id, 0));

  select * into v_state from public.source_returns_account_state
   where organization_fingerprint = p_organization_fingerprint and connection_id = p_connection_id and account_id = p_account_id
   for update;
  if not found then
    return jsonb_build_object('released', false, 'reason', 'no-state');
  end if;
  if v_state.hold_reason is null then
    return jsonb_build_object('released', false, 'reason', 'no-hold');
  end if;
  if v_state.last_status = 'replaced' then
    raise exception 'release_returns_identity_hold: RETURNS_CONFIRM_PENDING';
  end if;

  update public.source_returns_account_state
     set hold_reason = null, identity_status = 'clear', initial_status = 'pending', updated_at = now()
   where organization_fingerprint = p_organization_fingerprint and connection_id = p_connection_id and account_id = p_account_id;

  insert into public.source_returns_refresh_log (
    organization_fingerprint, connection_id, account_id, run_key, region, mode, window_from, window_to, status, detail
  ) values (
    p_organization_fingerprint, p_connection_id, p_account_id, p_run_key, p_region, 'operator',
    coalesce(v_state.last_window_from, v_state.initial_window_from, current_date),
    greatest(coalesce(v_state.last_window_to, v_state.initial_window_to, current_date),
             coalesce(v_state.last_window_from, v_state.initial_window_from, current_date)),
    'hold-released',
    jsonb_build_object('previousHoldReason', v_state.hold_reason, 'previousInitialStatus', v_state.initial_status)
  );

  return jsonb_build_object('released', true, 'initialStatus', 'pending');
end;
$$;

-- ---------------------------------------------------------------------------
-- RLS + EXACT LEAST-PRIVILEGE ACLs (the 20260914 / 20260941 pattern): service-role-only, written ONLY through the
-- SECURITY DEFINER RPCs. REVOKE ALL also clears PostgreSQL 17's MAINTAIN. No policy, nothing for anon / authenticated.
-- ---------------------------------------------------------------------------
alter table public.source_returns_events enable row level security;
revoke all on table public.source_returns_events from public, anon, authenticated, service_role;
grant select on table public.source_returns_events to service_role;

alter table public.source_returns_account_state enable row level security;
revoke all on table public.source_returns_account_state from public, anon, authenticated, service_role;
grant select on table public.source_returns_account_state to service_role;

alter table public.source_returns_refresh_log enable row level security;
revoke all on table public.source_returns_refresh_log from public, anon, authenticated, service_role;
grant select on table public.source_returns_refresh_log to service_role;

alter table public.source_returns_create_budget enable row level security;
revoke all on table public.source_returns_create_budget from public, anon, authenticated, service_role;
grant select on table public.source_returns_create_budget to service_role;

alter table public.source_returns_run_lease enable row level security;
revoke all on table public.source_returns_run_lease from public, anon, authenticated, service_role;
grant select on table public.source_returns_run_lease to service_role;

revoke all on function public.replace_returns_events_window(text, text, text, text, text, date, date, text, jsonb, integer, bigint, text[], text[], integer[], timestamptz, text, boolean, text, jsonb, text, bigint, text, text) from public, anon, authenticated;
grant execute on function public.replace_returns_events_window(text, text, text, text, text, date, date, text, jsonb, integer, bigint, text[], text[], integer[], timestamptz, text, boolean, text, jsonb, text, bigint, text, text) to service_role;

revoke all on function public.confirm_returns_events_window(text, text, text, date, date, text, integer, bigint, text[], text, text) from public, anon, authenticated;
grant execute on function public.confirm_returns_events_window(text, text, text, date, date, text, integer, bigint, text[], text, text) to service_role;

revoke all on function public.record_returns_window_failure(text, text, text, text, text, date, date, text, jsonb, text, text) from public, anon, authenticated;
grant execute on function public.record_returns_window_failure(text, text, text, text, text, date, date, text, jsonb, text, text) to service_role;

revoke all on function public.rebuild_returns_history_from_events(text, text, text, date, date, text, text, text) from public, anon, authenticated;
grant execute on function public.rebuild_returns_history_from_events(text, text, text, date, date, text, text, text) to service_role;

revoke all on function public.claim_returns_create_slot(text, date, integer, text, bigint, text, text) from public, anon, authenticated;
grant execute on function public.claim_returns_create_slot(text, date, integer, text, bigint, text, text) to service_role;

revoke all on function public.acquire_returns_run_lease(text, text, integer, text) from public, anon, authenticated;
grant execute on function public.acquire_returns_run_lease(text, text, integer, text) to service_role;

revoke all on function public.renew_returns_run_lease(text, text, bigint, integer) from public, anon, authenticated;
grant execute on function public.renew_returns_run_lease(text, text, bigint, integer) to service_role;

revoke all on function public.release_returns_run_lease(text, text, bigint) from public, anon, authenticated;
grant execute on function public.release_returns_run_lease(text, text, bigint) to service_role;

revoke all on function public.release_returns_legacy_fence(text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.release_returns_legacy_fence(text, text, text, text, text) to service_role;

revoke all on function public.release_returns_identity_hold(text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.release_returns_identity_hold(text, text, text, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- 1.10 LEGACY-WRITER FENCE (database, ownership-keyed). public.replace_returns_history_window is the 20260914 statement
--      BYTE-IDENTICAL except the ONE block between the two marker comments: the same per-account advisory lock as the
--      event source, then a refusal while that account's state row says the event source owns its returns
--      (legacy_fence and initial_status loaded|complete). Ownership only -- no schedule switch is consulted. The legacy
--      operator writes Settlements through its own RPC, which is untouched and still commits.
-- ---------------------------------------------------------------------------
create or replace function public.replace_returns_history_window(
  p_organization_fingerprint text,
  p_connection_id text,
  p_account_id text,
  p_covered_from date,
  p_covered_to date,
  p_return_rows jsonb
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
  -- >>> 20260942 legacy-writer fence (BEGIN): the event source's per-account lock, then a refusal while it owns the account.
  perform pg_advisory_xact_lock(hashtextextended('returns-events|' || p_organization_fingerprint || '|' || p_connection_id || '|' || p_account_id, 0));
  if exists (select 1 from public.source_returns_account_state s
              where s.organization_fingerprint = p_organization_fingerprint and s.connection_id = p_connection_id
                and s.account_id = p_account_id and s.legacy_fence and s.initial_status in ('loaded', 'complete')) then
    raise exception 'replace_returns_history_window: RETURNS_WINDOW_OWNED_BY_EVENT_SOURCE';
  end if;
  -- <<< 20260942 legacy-writer fence (END)
  if p_organization_fingerprint is null or char_length(btrim(p_organization_fingerprint)) = 0 then
    raise exception 'replace_returns_history_window: blank organization fingerprint';
  end if;
  if p_connection_id is null or p_connection_id not in ('primary', 'dd-secondary') then
    raise exception 'replace_returns_history_window: invalid connection id';
  end if;
  if p_account_id is null or char_length(btrim(p_account_id)) = 0 then
    raise exception 'replace_returns_history_window: blank account id';
  end if;
  if p_covered_from is null or p_covered_to is null or p_covered_from > p_covered_to then
    raise exception 'replace_returns_history_window: invalid coverage window';
  end if;
  if p_return_rows is null or jsonb_typeof(p_return_rows) <> 'array' then
    raise exception 'replace_returns_history_window: p_return_rows must be a jsonb array';
  end if;

  -- Validate EVERY row fail-closed BEFORE any mutation: nonblank seller + hash, in-window return_date, positive count,
  -- non-negative FBM money.
  for v_row in select * from jsonb_array_elements(p_return_rows) loop
    if coalesce(btrim(v_row->>'seller_or_vendor_id'), '') = ''
      or coalesce(v_row->>'return_date', '') = ''
      or (v_row->>'return_date')::date < p_covered_from
      or (v_row->>'return_date')::date > p_covered_to
      or (v_row->>'return_count') is null or (v_row->>'return_count')::integer <= 0
      or coalesce((v_row->>'fbm_refunded_amount')::numeric, 0) < 0
      or coalesce((v_row->>'fbm_seller_label_cost')::numeric, 0) < 0
      or coalesce(btrim(v_row->>'source_request_hash'), '') = '' then
      raise exception 'replace_returns_history_window: malformed return row; refusing the whole window';
    end if;
  end loop;

  delete from public.source_returns_history
    where organization_fingerprint = p_organization_fingerprint
      and connection_id = p_connection_id
      and account_id = p_account_id
      and return_date between p_covered_from and p_covered_to;
  get diagnostics v_deleted = row_count;

  insert into public.source_returns_history (
    organization_fingerprint, connection_id, account_id, seller_or_vendor_id, marketplace_country_code,
    return_date, sku, child_asin, amazon_return_reason, fulfillment_channel, request_status, label_payer,
    detailed_disposition, return_count, fbm_refunded_amount, fbm_seller_label_cost, cogs_total_value,
    source_request_hash, refreshed_at, calculated_at
  )
  select
    p_organization_fingerprint, p_connection_id, p_account_id,
    max(btrim(e->>'seller_or_vendor_id')),
    coalesce(max(e->>'marketplace_country_code'), ''),
    (e->>'return_date')::date,
    coalesce(e->>'sku', ''),
    coalesce(e->>'child_asin', ''),
    coalesce(e->>'amazon_return_reason', ''),
    coalesce(e->>'fulfillment_channel', ''),
    coalesce(e->>'request_status', ''),
    coalesce(e->>'label_payer', ''),
    coalesce(max(e->>'detailed_disposition'), ''),
    sum((e->>'return_count')::integer),
    coalesce(sum((e->>'fbm_refunded_amount')::numeric), 0),
    coalesce(sum((e->>'fbm_seller_label_cost')::numeric), 0),
    coalesce(sum((e->>'cogs_total_value')::numeric), 0),
    max(e->>'source_request_hash'),
    max((e->>'refreshed_at')::timestamptz),
    coalesce(max((e->>'calculated_at')::timestamptz), now())
  from jsonb_array_elements(p_return_rows) as e
  group by (e->>'return_date')::date, coalesce(e->>'sku', ''), coalesce(e->>'child_asin', ''),
    coalesce(e->>'amazon_return_reason', ''), coalesce(e->>'fulfillment_channel', ''),
    coalesce(e->>'request_status', ''), coalesce(e->>'label_payer', '');
  get diagnostics v_inserted = row_count;

  return jsonb_build_object('returnsReplaced', v_deleted, 'returnsInserted', v_inserted);
end;
$$;

revoke all on function public.replace_returns_history_window(text, text, text, date, date, jsonb) from public, anon, authenticated;
grant execute on function public.replace_returns_history_window(text, text, text, date, date, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- source_returns_history.returned_units (DESIGN-v2 5.1): units of the group's events, NULL when any event lacks a
-- positive quantity (and for every legacy row). LAST statement: its ACCESS EXCLUSIVE lock is held only until commit.
-- ---------------------------------------------------------------------------
alter table public.source_returns_history add column if not exists returned_units integer;
