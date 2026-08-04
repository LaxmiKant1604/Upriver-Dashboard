-- Shared source-export cache.
--
-- The payload lives in the existing private dashboard-snapshots Storage
-- bucket, not Postgres, because the database was already close to its Free
-- plan quota. Postgres stores only the lookup metadata. No browser policy is
-- added: service-role server functions are the sole reader/writer.

create table if not exists public.source_export_cache (
  request_hash text primary key,
  source_id text not null,
  organization_fingerprint text not null,
  account_scope_hash text not null,
  request_meta jsonb not null default '{}'::jsonb,
  object_path text not null unique,
  row_count integer not null check (row_count >= 0),
  payload_bytes bigint not null check (payload_bytes >= 0),
  fetched_at timestamptz not null default now(),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists source_export_cache_expiry_idx
  on public.source_export_cache (expires_at, fetched_at);

create index if not exists source_export_cache_source_idx
  on public.source_export_cache (source_id, fetched_at desc);

drop trigger if exists source_export_cache_touch_updated_at on public.source_export_cache;
create trigger source_export_cache_touch_updated_at before update on public.source_export_cache
  for each row execute function public.touch_updated_at();

alter table public.source_export_cache enable row level security;

-- Delete expired/old metadata and return the private object paths for the
-- server to remove from Storage. The 512 MiB/512-entry ceiling leaves ample
-- room inside the 1 GiB Free Storage allowance while preventing unbounded
-- growth from custom date ranges.
create or replace function public.prune_source_export_cache(
  p_max_bytes bigint default 536870912,
  p_max_entries integer default 512
)
returns table(object_path text)
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_max_bytes < 1048576 or p_max_entries < 1 then
    raise exception 'Invalid source cache retention limits';
  end if;

  return query
  with ranked as (
    select request_hash,
           source_export_cache.object_path,
           expires_at,
           row_number() over (order by fetched_at desc, request_hash) as row_number,
           sum(payload_bytes) over (order by fetched_at desc, request_hash) as running_bytes
    from public.source_export_cache
  ), doomed as (
    select request_hash
    from ranked
    where expires_at <= now()
       or row_number > p_max_entries
       or running_bytes > p_max_bytes
  )
  delete from public.source_export_cache cache
  using doomed
  where cache.request_hash = doomed.request_hash
  returning cache.object_path;
end;
$$;

revoke all on table public.source_export_cache from public, anon, authenticated;
revoke all on function public.prune_source_export_cache(bigint, integer) from public, anon, authenticated;
grant all on table public.source_export_cache to service_role;
grant execute on function public.prune_source_export_cache(bigint, integer) to service_role;

