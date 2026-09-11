-- ============================================================================
-- 20260927_source_listings_raw_snapshot.sql
--
-- *** PREPARED / UNAPPLIED -- APPROVAL-GATED. DO NOT APPLY WITHOUT EXPLICIT SIGN-OFF. ***
-- Apply (only when approved) EXACTLY this one file:
--   MIGRATE_ONLY=20260927_source_listings_raw_snapshot.sql npm run db:migrate
-- (A plain `npm run db:migrate` WOULD apply this unledgered file -- do NOT run it until sign-off.)
--
-- WHY (WORK B, §B): `listings-raw` is likewise storage:"cycle-cache" (source-registry.js) -- no durable store, only
-- fetched_at timestamps, not a content fingerprint. Listings Raw is an OPTIONAL dependency of Listing Health
-- (listing-health optionalRequestKeys listing-health:listings-raw; listing-health-v3 optionalRequestKeys
-- listing-health-v3:listings-raw) -- a degraded policy: raw disabled -> issuesAvailable:false + enable hint, NOT a
-- failure. This adds a SEPARATE durable latest-good pointer for the ALREADY-DOWNLOADED listings-raw payload (NEVER
-- merged with source_listings_snapshot), so the reconciler can compute a DISTINCT raw content revision and a
-- DETERMINISTIC combined Listing-Health-v3 dependency fingerprint keyed on the SAME (org, connection, account, as_of),
-- while raw stays optional (its absence degrades issuesAvailable, never blocks). Populated additively by the normal
-- scheduler ingestion AFTER a validated listings-raw download (zero additional export). Byte-identical CAS + RLS + ACL
-- to source_listings_snapshot (20260926) / source_snapshots (20260820): older evidence can NEVER overwrite newer LKG;
-- equal+conflicting fails closed; bounded row_count=0 is a valid empty. Idempotent. No existing table/row is touched.
-- ============================================================================

create table if not exists public.source_listings_raw_snapshot (
  organization_fingerprint text not null
    constraint source_listings_raw_snapshot_org_nonblank check (char_length(btrim(organization_fingerprint)) > 0),
  connection_id text not null default 'primary'
    constraint source_listings_raw_snapshot_connection_id_check check (connection_id in ('primary', 'dd-secondary')),
  account_id text not null
    constraint source_listings_raw_snapshot_account_nonblank check (char_length(btrim(account_id)) > 0)
    constraint source_listings_raw_snapshot_account_canonical check (account_id = btrim(account_id) and position(':' in account_id) = 0),
  marketplace text not null
    constraint source_listings_raw_snapshot_marketplace_check check (marketplace ~ '^[A-Z]{2}$'),
  source_key text not null default 'listings-raw'
    constraint source_listings_raw_snapshot_source_key_check check (source_key = 'listings-raw'),
  as_of date not null,
  object_path text not null
    constraint source_listings_raw_snapshot_object_path_nonblank check (char_length(btrim(object_path)) > 0),
  payload_sha text not null
    constraint source_listings_raw_snapshot_payload_sha_nonblank check (char_length(btrim(payload_sha)) > 0),
  row_count integer not null
    constraint source_listings_raw_snapshot_row_count_nonneg check (row_count >= 0),
  payload_bytes bigint not null default 0
    constraint source_listings_raw_snapshot_payload_bytes_nonneg check (payload_bytes >= 0),
  source_request_hash text not null
    constraint source_listings_raw_snapshot_hash_nonblank check (char_length(btrim(source_request_hash)) > 0),
  validated_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint source_listings_raw_snapshot_pk primary key (organization_fingerprint, connection_id, account_id)
);

create index if not exists source_listings_raw_snapshot_org_asof_idx
  on public.source_listings_raw_snapshot (organization_fingerprint, connection_id, as_of);

create or replace function public.record_source_listings_raw_snapshot(
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
  v_existing public.source_listings_raw_snapshot%rowtype;
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
    raise exception 'record_source_listings_raw_snapshot: incomplete validated listings-raw snapshot evidence';
  end if;
  select * into v_existing from public.source_listings_raw_snapshot
    where organization_fingerprint = p_organization_fingerprint
      and connection_id = p_connection_id
      and account_id = p_account_id
    for update;
  if not found then
    begin
      insert into public.source_listings_raw_snapshot (
        organization_fingerprint, connection_id, account_id, marketplace, source_key, as_of,
        object_path, payload_sha, row_count, payload_bytes, source_request_hash, validated_at
      ) values (
        p_organization_fingerprint, p_connection_id, p_account_id, p_marketplace, 'listings-raw', p_as_of,
        p_object_path, p_payload_sha, p_row_count, p_payload_bytes, p_source_request_hash, p_validated_at
      );
      return 'replaced';
    exception when unique_violation then
      select * into v_existing from public.source_listings_raw_snapshot
        where organization_fingerprint = p_organization_fingerprint
          and connection_id = p_connection_id
          and account_id = p_account_id
        for update;
      if not found then
        raise exception 'record_source_listings_raw_snapshot: concurrent insert vanished; refusing';
      end if;
    end;
  end if;
  -- An account's marketplace is IMMUTABLE; a different marketplace for the same (org, connection, account) is a
  -- cross-marketplace conflict -> fail closed (never overwrite), independent of dates.
  if p_marketplace <> v_existing.marketplace then
    return 'conflict';
  end if;
  -- LOGICAL FRESHNESS: as_of (the D-1 the payload covers) DOMINATES validated_at, so a DELAYED D-2 save whose
  -- validated_at is later can NEVER overwrite a D-1 pointer.
  if p_as_of < v_existing.as_of then
    return 'stale-save';
  end if;
  if p_as_of = v_existing.as_of then
    if p_validated_at < v_existing.validated_at then
      return 'stale-save';
    end if;
    if p_validated_at = v_existing.validated_at then
      -- EXACT unchanged: EVERY relevant identity field equal, else fail closed as 'conflict'.
      if v_existing.marketplace = p_marketplace and v_existing.as_of = p_as_of
         and v_existing.object_path = p_object_path and v_existing.payload_sha = p_payload_sha
         and v_existing.row_count = p_row_count and v_existing.payload_bytes = p_payload_bytes
         and v_existing.source_request_hash = p_source_request_hash and v_existing.source_key = 'listings-raw' then
        return 'unchanged';
      end if;
      return 'conflict';
    end if;
    -- same as_of, strictly-newer validated_at -> a same-date CORRECTION -> fall through to replace.
  end if;
  -- Reached ONLY when p_as_of > v_existing.as_of (D-1 advanced) OR same as_of with strictly-newer validated_at.
  update public.source_listings_raw_snapshot set
    marketplace = p_marketplace, as_of = p_as_of, object_path = p_object_path, payload_sha = p_payload_sha,
    row_count = p_row_count, payload_bytes = p_payload_bytes, source_request_hash = p_source_request_hash,
    validated_at = p_validated_at, updated_at = now()
    where organization_fingerprint = p_organization_fingerprint
      and connection_id = p_connection_id
      and account_id = p_account_id;
  return 'replaced';
end;
$$;

drop trigger if exists source_listings_raw_snapshot_touch on public.source_listings_raw_snapshot;
create trigger source_listings_raw_snapshot_touch
  before update on public.source_listings_raw_snapshot
  for each row execute function public.touch_updated_at();

-- SECURITY DEFINER FUNCTION ACL: revoke EXECUTE from public/anon/authenticated, grant ONLY to service_role (a definer
-- function is EXECUTE-able by PUBLIC by default; table ACL alone is insufficient).
revoke all on function public.record_source_listings_raw_snapshot(text, text, text, text, date, text, text, integer, bigint, text, timestamptz) from public, anon, authenticated;
grant execute on function public.record_source_listings_raw_snapshot(text, text, text, text, date, text, text, integer, bigint, text, timestamptz) to service_role;

alter table public.source_listings_raw_snapshot enable row level security;
revoke all on table public.source_listings_raw_snapshot from public, anon, authenticated, service_role;
grant select on table public.source_listings_raw_snapshot to service_role;
