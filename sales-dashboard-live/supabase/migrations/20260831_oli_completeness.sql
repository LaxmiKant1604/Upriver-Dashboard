-- ===========================================================================
-- Scheduler v2 -- DURABLE per-(account, sale_date) OLI COMPLETENESS metadata (Migration 15)
-- for the PROVISIONAL / FINAL two-layer D-1 report model.
-- ===========================================================================
--
-- ADDITIVE + IDEMPOTENT. Adds ONE table and ONE RPC. Changes no existing table, stores no
-- secret, stores no customer identifier (only aggregate counts + a redacted export id list).
-- Repeated execution is safe.
--
-- WHY: DataDoe's Order Line Items source (89b27535d2) is REAL TIME, but Amazon populates the
-- per-line item detail (item_status / item_price_value) over ~1-2 days AFTER an order is placed.
-- On the D+1 run a fraction of D-1 orders are itemized (priced); the rest are order-level shells
-- (item_status blank, item_price_value null). The BUSINESS DECISION is to PUBLISH the real
-- itemized D-1 data immediately, labelled PROVISIONAL, never fabricating a missing value, and
-- promote it to FINAL when itemization completes. This table stores, per account + sale_date, the
-- completeness the report surfaces + the provenance needed for a provenance-checked promotion CAS.
--
-- INVARIANTS (enforced by the CAS RPC, the ONLY write path):
--   - FINAL never regresses to provisional for the same (account, sale_date);
--   - a STALE export (older refreshed_at) never overwrites newer evidence;
--   - completeness_status in (provisional | final | source-defect);
--   - counts are non-negative; itemization_percent in [0,100]; null is never coerced.

create table if not exists public.source_oli_completeness (
  organization_fingerprint text not null,
  connection_id text not null
    constraint source_oli_completeness_conn_check check (connection_id in ('primary', 'dd-secondary')),
  account_id text not null,
  bucket text not null
    constraint source_oli_completeness_bucket_check check (bucket in ('us', 'non-us')),
  sale_date date not null,
  completeness_status text not null
    constraint source_oli_completeness_status_check check (completeness_status in ('provisional', 'final', 'source-defect')),
  itemized_order_count integer not null default 0
    constraint source_oli_completeness_iorders_check check (itemized_order_count >= 0),
  pending_order_count integer not null default 0
    constraint source_oli_completeness_porders_check check (pending_order_count >= 0),
  itemized_unit_count numeric not null default 0
    constraint source_oli_completeness_iunits_check check (itemized_unit_count >= 0),
  pending_unit_count numeric not null default 0
    constraint source_oli_completeness_punits_check check (pending_unit_count >= 0),
  defect_count integer not null default 0
    constraint source_oli_completeness_defect_check check (defect_count >= 0),
  itemization_percent numeric not null default 0
    constraint source_oli_completeness_pct_check check (itemization_percent >= 0 and itemization_percent <= 100),
  requested_as_of date,
  proven_export_through date,
  source_request_hashes jsonb not null default '[]'::jsonb,
  source_export_ids jsonb not null default '[]'::jsonb,
  refreshed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint source_oli_completeness_pk primary key (organization_fingerprint, connection_id, account_id, sale_date)
);

drop trigger if exists source_oli_completeness_touch on public.source_oli_completeness;
create trigger source_oli_completeness_touch before update on public.source_oli_completeness
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- record_oli_completeness -- the ONLY write path: a provenance-checked CAS upsert for ONE
-- (account, sale_date) completeness record. Under an advisory lock it decides:
--   no existing row               -> INSERT               (disposition 'inserted')
--   existing FINAL, new provisional -> NO-OP              (disposition 'final-preserved'; never regress)
--   existing FINAL, new final       -> refresh iff newer  (disposition 'final-refreshed' / 'already-final')
--   existing provisional, new older -> NO-OP              (disposition 'stale-ignored'; never clobber newer)
--   existing provisional, new >=     -> UPDATE            (disposition 'promoted' when new final, else 'updated')
-- Returns jsonb echoing the identity + the resulting completeness_status for strict wrapper validation.
-- ---------------------------------------------------------------------------
create or replace function public.record_oli_completeness(
  p_organization_fingerprint text,
  p_connection_id text,
  p_account_id text,
  p_bucket text,
  p_sale_date date,
  p_status text,
  p_itemized_order_count integer,
  p_pending_order_count integer,
  p_itemized_unit_count numeric,
  p_pending_unit_count numeric,
  p_defect_count integer,
  p_itemization_percent numeric,
  p_requested_as_of date,
  p_proven_export_through date,
  p_source_request_hashes jsonb,
  p_source_export_ids jsonb,
  p_refreshed_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.source_oli_completeness%rowtype;
  v_refreshed timestamptz := coalesce(p_refreshed_at, now());
  v_disposition text;
begin
  if coalesce(btrim(p_organization_fingerprint), '') = '' or coalesce(btrim(p_connection_id), '') = ''
     or coalesce(btrim(p_account_id), '') = '' or p_sale_date is null then
    raise exception 'record_oli_completeness requires org/connection/account/sale_date';
  end if;
  if p_status is null or p_status not in ('provisional', 'final', 'source-defect') then
    raise exception 'record_oli_completeness: invalid completeness_status %', p_status;
  end if;
  if p_bucket is null or p_bucket not in ('us', 'non-us') then
    raise exception 'record_oli_completeness: invalid bucket %', p_bucket;
  end if;

  perform pg_advisory_xact_lock(hashtext(p_organization_fingerprint || '|' || p_connection_id || '|' || p_account_id || '|' || p_sale_date::text));

  select * into v_row
    from public.source_oli_completeness
   where organization_fingerprint = p_organization_fingerprint
     and connection_id = p_connection_id
     and account_id = p_account_id
     and sale_date = p_sale_date
   for update;

  if not found then
    insert into public.source_oli_completeness (
      organization_fingerprint, connection_id, account_id, bucket, sale_date, completeness_status,
      itemized_order_count, pending_order_count, itemized_unit_count, pending_unit_count, defect_count,
      itemization_percent, requested_as_of, proven_export_through, source_request_hashes, source_export_ids, refreshed_at
    ) values (
      p_organization_fingerprint, p_connection_id, p_account_id, p_bucket, p_sale_date, p_status,
      coalesce(p_itemized_order_count, 0), coalesce(p_pending_order_count, 0), coalesce(p_itemized_unit_count, 0),
      coalesce(p_pending_unit_count, 0), coalesce(p_defect_count, 0), coalesce(p_itemization_percent, 0),
      p_requested_as_of, p_proven_export_through, coalesce(p_source_request_hashes, '[]'::jsonb),
      coalesce(p_source_export_ids, '[]'::jsonb), v_refreshed
    );
    return jsonb_build_object('disposition', 'inserted', 'account_id', p_account_id, 'sale_date', p_sale_date, 'completeness_status', p_status);
  end if;

  -- FINAL never regresses.
  if v_row.completeness_status = 'final' then
    if p_status = 'final' and v_refreshed > v_row.refreshed_at then
      update public.source_oli_completeness
         set itemized_order_count = coalesce(p_itemized_order_count, itemized_order_count),
             pending_order_count = coalesce(p_pending_order_count, pending_order_count),
             itemized_unit_count = coalesce(p_itemized_unit_count, itemized_unit_count),
             pending_unit_count = coalesce(p_pending_unit_count, pending_unit_count),
             defect_count = coalesce(p_defect_count, defect_count),
             itemization_percent = coalesce(p_itemization_percent, itemization_percent),
             proven_export_through = coalesce(p_proven_export_through, proven_export_through),
             source_request_hashes = coalesce(p_source_request_hashes, source_request_hashes),
             source_export_ids = coalesce(p_source_export_ids, source_export_ids),
             refreshed_at = v_refreshed
       where organization_fingerprint = p_organization_fingerprint and connection_id = p_connection_id
         and account_id = p_account_id and sale_date = p_sale_date;
      v_disposition := 'final-refreshed';
    else
      v_disposition := 'already-final';
    end if;
    return jsonb_build_object('disposition', v_disposition, 'account_id', p_account_id, 'sale_date', p_sale_date, 'completeness_status', 'final');
  end if;

  -- Existing provisional / source-defect: a STALE export never clobbers newer evidence.
  if v_refreshed < v_row.refreshed_at then
    return jsonb_build_object('disposition', 'stale-ignored', 'account_id', p_account_id, 'sale_date', p_sale_date, 'completeness_status', v_row.completeness_status);
  end if;

  update public.source_oli_completeness
     set bucket = p_bucket,
         completeness_status = p_status,
         itemized_order_count = coalesce(p_itemized_order_count, 0),
         pending_order_count = coalesce(p_pending_order_count, 0),
         itemized_unit_count = coalesce(p_itemized_unit_count, 0),
         pending_unit_count = coalesce(p_pending_unit_count, 0),
         defect_count = coalesce(p_defect_count, 0),
         itemization_percent = coalesce(p_itemization_percent, 0),
         requested_as_of = coalesce(p_requested_as_of, requested_as_of),
         proven_export_through = coalesce(p_proven_export_through, proven_export_through),
         source_request_hashes = coalesce(p_source_request_hashes, '[]'::jsonb),
         source_export_ids = coalesce(p_source_export_ids, '[]'::jsonb),
         refreshed_at = v_refreshed
   where organization_fingerprint = p_organization_fingerprint and connection_id = p_connection_id
     and account_id = p_account_id and sale_date = p_sale_date;

  v_disposition := case when p_status = 'final' then 'promoted' else 'updated' end;
  return jsonb_build_object('disposition', v_disposition, 'account_id', p_account_id, 'sale_date', p_sale_date, 'completeness_status', p_status);
end;
$$;

alter table public.source_oli_completeness enable row level security;
drop policy if exists source_oli_completeness_admin_read on public.source_oli_completeness;
create policy source_oli_completeness_admin_read on public.source_oli_completeness
  for select to authenticated using (public.is_dashboard_admin());

-- Least-privilege ACL: the ONLY write path is the SECURITY DEFINER CAS RPC. service_role reads
-- (the report derivation + escalation diagnostics read completeness); every write goes through the RPC.
revoke all on table public.source_oli_completeness from public, anon, authenticated, service_role;
grant select on table public.source_oli_completeness to authenticated;
grant select on table public.source_oli_completeness to service_role;
revoke all on function public.record_oli_completeness(text, text, text, text, date, text, integer, integer, numeric, numeric, integer, numeric, date, date, jsonb, jsonb, timestamptz) from public, anon, authenticated;
grant execute on function public.record_oli_completeness(text, text, text, text, date, text, integer, integer, numeric, numeric, integer, numeric, date, date, jsonb, jsonb, timestamptz) to service_role;
