-- ============================================================================
-- Migration 23 (2026-09-08): PRESERVE NOTES through the bulk ASIN lead-time import.
--
-- Audit finding: the FBA Shipment Plan lead-time TEMPLATE carries a `note` column and the SINGLE-row
-- record_fba_asin_lead_time RPC persists notes, but record_fba_asin_lead_time_bulk (migration 20260907)
-- never read `note` from p_rows -- so a bulk import silently dropped every note (new rows defaulted to '',
-- existing rows kept their old note, the imported note was ignored). This recreates ONLY that function so a
-- bulk import writes notes with the SAME blank-as-clear semantics as the single path and every other field.
--
-- SAFETY / SCOPE:
--   * Function body is byte-identical to migration 20260907 EXCEPT: it now reads v_note from each row, writes
--     it on INSERT and on the ON CONFLICT UPDATE, and records it in the audit row. The signature is UNCHANGED
--     (text, text, text, jsonb, uuid, text) so the existing GRANT/REVOKE still applies -- re-asserted below.
--   * A row that omits `note` (or sends blank) writes '' (clear), consistent with the single-row RPC's
--     coalesce(p_note,'') and with the day/eta blank-as-clear rule. The client always sends note now, so a
--     round-tripped template preserves it losslessly.
--   * Forward/backward compatible: the wrapper already sends a `note` key; the PRE-migration function ignored
--     it (note unchanged), the POST-migration function applies it. No table/column change (the note column has
--     existed since 20260907). No data backfill. Idempotent (CREATE OR REPLACE).
--
-- APPROVAL-GATED: added to the tree but NOT applied to production in this session (no unapproved migration).
-- ============================================================================

create or replace function public.record_fba_asin_lead_time_bulk(
  p_organization_fingerprint text,
  p_connection_id text,
  p_account_id text,
  p_rows jsonb,
  p_updated_by uuid,
  p_updated_by_email text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row jsonb;
  v_asin text;
  v_prod smallint; v_ship smallint; v_awd smallint; v_safety smallint;
  v_eta date;
  v_note text;
  v_applied int := 0;
  v_seen text[] := array[]::text[];
begin
  if coalesce(btrim(p_organization_fingerprint), '') = '' or p_connection_id not in ('primary', 'dd-secondary')
     or coalesce(btrim(p_account_id), '') = '' then
    raise exception 'record_fba_asin_lead_time_bulk: blank identity (org/connection/account required)';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'record_fba_asin_lead_time_bulk: p_rows must be a jsonb array';
  end if;
  if jsonb_array_length(p_rows) = 0 then
    raise exception 'record_fba_asin_lead_time_bulk: p_rows is empty';
  end if;
  if jsonb_array_length(p_rows) > 5000 then
    raise exception 'record_fba_asin_lead_time_bulk: too many rows (max 5000)';
  end if;

  for v_row in select * from jsonb_array_elements(p_rows)
  loop
    v_asin := btrim(coalesce(v_row->>'child_asin', ''));
    if v_asin = '' then
      raise exception 'record_fba_asin_lead_time_bulk: a row has a blank child_asin';
    end if;
    if v_asin = any (v_seen) then
      raise exception 'record_fba_asin_lead_time_bulk: duplicate child_asin % in this import', v_asin;
    end if;
    v_seen := array_append(v_seen, v_asin);
    v_prod   := case when (v_row->>'production_days')   is null or btrim(v_row->>'production_days')   = '' then null else (v_row->>'production_days')::smallint end;
    v_ship   := case when (v_row->>'shipping_days')     is null or btrim(v_row->>'shipping_days')     = '' then null else (v_row->>'shipping_days')::smallint end;
    v_awd    := case when (v_row->>'awd_transfer_days') is null or btrim(v_row->>'awd_transfer_days') = '' then null else (v_row->>'awd_transfer_days')::smallint end;
    v_safety := case when (v_row->>'safety_stock_days') is null or btrim(v_row->>'safety_stock_days') = '' then null else (v_row->>'safety_stock_days')::smallint end;
    v_eta    := case when (v_row->>'inbound_eta')       is null or btrim(v_row->>'inbound_eta')       = '' then null else (v_row->>'inbound_eta')::date end;
    -- Note: blank-as-clear (matches the single-row RPC's coalesce(p_note,'') and the day/eta rule). Capped at 500.
    v_note   := left(coalesce(v_row->>'note', ''), 500);
    if (v_prod is not null and (v_prod < 0 or v_prod > 3650))
       or (v_ship is not null and (v_ship < 0 or v_ship > 3650))
       or (v_awd is not null and (v_awd < 0 or v_awd > 3650))
       or (v_safety is not null and (v_safety < 0 or v_safety > 3650)) then
      raise exception 'record_fba_asin_lead_time_bulk: a day value for % is out of range (0..3650)', v_asin;
    end if;

    insert into public.fba_asin_lead_time (
      organization_fingerprint, connection_id, account_id, child_asin,
      production_days, shipping_days, awd_transfer_days, safety_stock_days, inbound_eta, note, updated_by, updated_by_email
    ) values (
      p_organization_fingerprint, p_connection_id, p_account_id, v_asin,
      v_prod, v_ship, v_awd, v_safety, v_eta, v_note, p_updated_by, coalesce(p_updated_by_email, '')
    )
    on conflict (organization_fingerprint, connection_id, account_id, child_asin)
    do update set
      production_days = excluded.production_days, shipping_days = excluded.shipping_days,
      awd_transfer_days = excluded.awd_transfer_days, safety_stock_days = excluded.safety_stock_days,
      inbound_eta = excluded.inbound_eta,  -- explicit ETA import (blank clears); inbound_started_date is left untouched
      note = excluded.note,                -- note is preserved through the import (blank clears)
      updated_by = excluded.updated_by, updated_by_email = excluded.updated_by_email, updated_at = now();

    insert into public.fba_asin_lead_time_audit (
      organization_fingerprint, connection_id, account_id, child_asin,
      production_days, shipping_days, awd_transfer_days, safety_stock_days, inbound_eta, note, action, updated_by, updated_by_email
    ) values (
      p_organization_fingerprint, p_connection_id, p_account_id, v_asin,
      v_prod, v_ship, v_awd, v_safety, v_eta, v_note, 'bulk', p_updated_by, coalesce(p_updated_by_email, '')
    );
    v_applied := v_applied + 1;
  end loop;

  return jsonb_build_object('account_id', p_account_id, 'applied', v_applied);
end;
$$;

-- Signature is unchanged, but re-assert least-privilege ACLs (idempotent; service_role only).
revoke all on function public.record_fba_asin_lead_time_bulk(text, text, text, jsonb, uuid, text) from public, anon, authenticated;
grant execute on function public.record_fba_asin_lead_time_bulk(text, text, text, jsonb, uuid, text) to service_role;
