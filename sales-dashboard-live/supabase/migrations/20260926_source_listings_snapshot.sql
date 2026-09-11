-- ============================================================================
-- 20260926_source_listings_snapshot.sql
--
-- *** PREPARED / UNAPPLIED -- APPROVAL-GATED. DO NOT APPLY WITHOUT EXPLICIT SIGN-OFF. ***
-- Apply (only when approved) EXACTLY this one file:
--   MIGRATE_ONLY=20260926_source_listings_snapshot.sql npm run db:migrate
-- (A plain `npm run db:migrate` WOULD apply this unledgered file -- do NOT run it until sign-off.)
--
-- WHY (WORK B of the saved-data reconciler extension): the `listings` source is storage:"cycle-cache" only
-- (source-registry.js) -- its rows live in the TTL-bounded, pruned source_export_cache, with a DATE-FREE stable
-- request_hash and NO byte-stable content revision. A zero-export Listings reconciler therefore has no durable input
-- to re-derive from and no content revision to compare. This adds ONE durable, CONTENT-ADDRESSED latest-good pointer
-- per (organization, connection, account) for the ALREADY-DOWNLOADED listings payload, so the reconciler can rebuild
-- Listing Health v3 from saved rows and detect a same-date correction via a byte-stable payload_sha. It is populated
-- ADDITIVELY by the normal scheduler ingestion AFTER a validated listings download (zero additional DataDoe export);
-- until applied, the writer degrades fail-soft (isSchemaMissingError) and the reconciler defers (LISTINGS unavailable).
--
-- Mirrors public.source_snapshots (20260820) EXACTLY: immutable content-addressed object path (the object name embeds
-- payload_sha = sha256 of the canonical rows JSON, so metadata + hydrated payload provably belong to the same save),
-- organization/connection ISOLATED identity, and the record_* RPC is a STRICTLY-NEWER-OR-EQUAL-IDENTICAL CAS
-- (older -> 'stale-save', equal+identical -> 'unchanged', equal+conflicting -> 'conflict', strictly-newer -> 'replaced')
-- so OLDER evidence can NEVER overwrite newer LKG. Adds marketplace + as_of + source_key to the identity (Listings is
-- account+marketplace+D-1 scoped). A bounded single-day row_count=0 payload is a VALID EMPTY (issuesAvailable:false),
-- never a fabricated zero -- the reconciler treats it as covered-empty; missing/unbounded/malformed evidence is
-- unavailable. Idempotent (create ... if not exists). RLS + ACL match source_snapshots (RLS on; direct writes revoked;
-- service_role SELECT only; the SECURITY DEFINER RPC is the sole write path). No existing table/policy/row is touched.
-- ============================================================================

create table if not exists public.source_listings_snapshot (
  organization_fingerprint text not null
    constraint source_listings_snapshot_org_nonblank check (char_length(btrim(organization_fingerprint)) > 0),
  connection_id text not null default 'primary'
    constraint source_listings_snapshot_connection_id_check check (connection_id in ('primary', 'dd-secondary')),
  account_id text not null
    constraint source_listings_snapshot_account_nonblank check (char_length(btrim(account_id)) > 0)
    constraint source_listings_snapshot_account_canonical check (account_id = btrim(account_id) and position(':' in account_id) = 0),
  marketplace text not null
    constraint source_listings_snapshot_marketplace_check check (marketplace ~ '^[A-Z]{2}$'),
  source_key text not null default 'listings'
    constraint source_listings_snapshot_source_key_check check (source_key = 'listings'),
  as_of date not null,
  object_path text not null
    constraint source_listings_snapshot_object_path_nonblank check (char_length(btrim(object_path)) > 0),
  payload_sha text not null
    constraint source_listings_snapshot_payload_sha_nonblank check (char_length(btrim(payload_sha)) > 0),
  row_count integer not null
    constraint source_listings_snapshot_row_count_nonneg check (row_count >= 0),
  payload_bytes bigint not null default 0
    constraint source_listings_snapshot_payload_bytes_nonneg check (payload_bytes >= 0),
  source_request_hash text not null
    constraint source_listings_snapshot_hash_nonblank check (char_length(btrim(source_request_hash)) > 0),
  validated_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint source_listings_snapshot_pk primary key (organization_fingerprint, connection_id, account_id)
);

-- Lookup by organization + as_of (the reconciler scans a region's accounts for a requested D-1).
create index if not exists source_listings_snapshot_org_asof_idx
  on public.source_listings_snapshot (organization_fingerprint, connection_id, as_of);

-- ATOMIC NEWER-OR-EQUAL-IDENTICAL pointer CAS (identical semantics to record_source_snapshot). Older validated_at ->
-- 'stale-save' (no write); equal validated_at + same payload_sha + object_path -> 'unchanged' (no write); equal but
-- CONFLICTING content -> 'conflict' (no write, fail closed); strictly-newer -> 'replaced'. Deterministic concurrent
-- absent-row inserts: exactly one wins the PK, the loser re-locks + falls through the SAME guard ladder.
create or replace function public.record_source_listings_snapshot(
  p_organization_fingerprint text,
  p_connection_id text,
  p_account_id text,
  p_marketplace text,
  p_as_of date,
  p_object_path text,
  p_payload_sha text,
  p_row_count integer,
  p_payload_bytes bigint,
  p_source_request_hash text,
  p_validated_at timestamptz
) returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing public.source_listings_snapshot%rowtype;
begin
  if p_organization_fingerprint is null or char_length(btrim(p_organization_fingerprint)) = 0
    or p_connection_id not in ('primary', 'dd-secondary')
    or coalesce(btrim(p_account_id), '') = '' or position(':' in coalesce(p_account_id, 'x')) > 0
    or p_marketplace !~ '^[A-Z]{2}$'
    or p_as_of is null
    or coalesce(btrim(p_object_path), '') = '' or coalesce(btrim(p_payload_sha), '') = ''
    or coalesce(btrim(p_source_request_hash), '') = ''
    or p_row_count is null or p_row_count < 0
    or p_payload_bytes is null or p_payload_bytes < 0
    or p_validated_at is null then
    raise exception 'record_source_listings_snapshot: incomplete validated listings snapshot evidence';
  end if;
  select * into v_existing from public.source_listings_snapshot
    where organization_fingerprint = p_organization_fingerprint
      and connection_id = p_connection_id
      and account_id = p_account_id
    for update;
  if not found then
    begin
      insert into public.source_listings_snapshot (
        organization_fingerprint, connection_id, account_id, marketplace, source_key, as_of,
        object_path, payload_sha, row_count, payload_bytes, source_request_hash, validated_at
      ) values (
        p_organization_fingerprint, p_connection_id, p_account_id, p_marketplace, 'listings', p_as_of,
        p_object_path, p_payload_sha, p_row_count, p_payload_bytes, p_source_request_hash, p_validated_at
      );
      return 'replaced';
    exception when unique_violation then
      select * into v_existing from public.source_listings_snapshot
        where organization_fingerprint = p_organization_fingerprint
          and connection_id = p_connection_id
          and account_id = p_account_id
        for update;
      if not found then
        raise exception 'record_source_listings_snapshot: concurrent insert vanished; refusing';
      end if;
    end;
  end if;
  -- An account's marketplace is IMMUTABLE; a different marketplace for the same (org, connection, account) is a
  -- cross-marketplace conflict -> fail closed (never overwrite), independent of dates. (marketplace is intentionally
  -- NOT in the PK; this guard enforces the isolation the PK omits, so the store never claims marketplace isolation it
  -- does not check.)
  if p_marketplace <> v_existing.marketplace then
    return 'conflict';
  end if;
  -- LOGICAL FRESHNESS: as_of (the business evidence date == the D-1 the payload covers) DOMINATES validated_at, so a
  -- DELAYED D-2 save whose validated_at (wall clock) is LATER can NEVER overwrite a D-1 pointer.
  if p_as_of < v_existing.as_of then
    return 'stale-save';
  end if;
  if p_as_of = v_existing.as_of then
    if p_validated_at < v_existing.validated_at then
      return 'stale-save';
    end if;
    if p_validated_at = v_existing.validated_at then
      -- EXACT unchanged: EVERY relevant identity field must be equal, else fail closed as 'conflict' (never a
      -- silent partial overwrite of equal-timestamp conflicting evidence).
      if v_existing.marketplace = p_marketplace and v_existing.as_of = p_as_of
         and v_existing.object_path = p_object_path and v_existing.payload_sha = p_payload_sha
         and v_existing.row_count = p_row_count and v_existing.payload_bytes = p_payload_bytes
         and v_existing.source_request_hash = p_source_request_hash and v_existing.source_key = 'listings' then
        return 'unchanged';
      end if;
      return 'conflict';
    end if;
    -- same as_of, strictly-newer validated_at -> a same-date CORRECTION -> fall through to replace.
  end if;
  -- Reached ONLY when p_as_of > v_existing.as_of (D-1 advanced) OR same as_of with strictly-newer validated_at.
  update public.source_listings_snapshot set
    marketplace = p_marketplace, as_of = p_as_of, object_path = p_object_path, payload_sha = p_payload_sha,
    row_count = p_row_count, payload_bytes = p_payload_bytes, source_request_hash = p_source_request_hash,
    validated_at = p_validated_at, updated_at = now()
    where organization_fingerprint = p_organization_fingerprint
      and connection_id = p_connection_id
      and account_id = p_account_id;
  return 'replaced';
end;
$$;

drop trigger if exists source_listings_snapshot_touch on public.source_listings_snapshot;
create trigger source_listings_snapshot_touch
  before update on public.source_listings_snapshot
  for each row execute function public.touch_updated_at();

-- SECURITY DEFINER FUNCTION ACL: a definer function is EXECUTE-able by PUBLIC by default (a privilege-escalation
-- surface -- it runs as its owner). Revoke EXECUTE from public/anon/authenticated and grant it ONLY to service_role
-- (the sole backend caller). Table ACL alone is INSUFFICIENT for a definer RPC.
revoke all on function public.record_source_listings_snapshot(text, text, text, text, date, text, text, integer, bigint, text, timestamptz) from public, anon, authenticated;
grant execute on function public.record_source_listings_snapshot(text, text, text, text, date, text, text, integer, bigint, text, timestamptz) to service_role;

-- RLS + TABLE ACL: RLS on (default deny), direct table writes revoked from everyone, service_role SELECT only; the sole
-- write path is the SECURITY DEFINER record_source_listings_snapshot RPC (exactly like source_snapshots).
alter table public.source_listings_snapshot enable row level security;
revoke all on table public.source_listings_snapshot from public, anon, authenticated, service_role;
grant select on table public.source_listings_snapshot to service_role;
