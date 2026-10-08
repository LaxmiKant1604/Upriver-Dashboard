// The READ-ONLY FBA Inventory Health BRIDGE reader shared by the non-FBA-Plan inventory consumers (Sales Movers, Buy Box
// Loss, Listing Health v1, Listing Health v3, Brand View, Product Reporting). Listings inventory CUTOVER (owner decision
// 2026-10-08): no FBA Inventory Health export is created by ANY path any more (lib/server/datadoe.js refuses the source);
// an account whose saved Listings cannot be validated may still show the LAST SAVED durable Health snapshot --
// public.source_snapshots(source_key 'fba-inventory-health', scope_key = the account) -- as a dated, clearly labelled,
// temporary bridge. Whether the bridge may drive figures is decided ONLY by lib/server/inventory-source.js
// selectAccountInventory (validated Listings first; the bridge only while its snapshot date >= the report as-of -
// HEALTH_BRIDGE_MAX_AGE_DAYS; else Unavailable, never 0) -- every consumer must pass its report as-of.
//
// This module proves the saved pointer + rows belong to THIS account (source key / scope key / organization / connection /
// row count / no row of another seller) and dates the snapshot (its latest row date). It never writes, never exports and
// never throws: every failure is { rows:null, unavailableReason }. 7-bit ASCII, LF.

import { getSourceSnapshot, getSourceSnapshotPayload } from "../supabase.js";
import { organizationFingerprint as orgFingerprintOf } from "../source-identity.js";

export const HEALTH_BRIDGE_SOURCE_KEY = "fba-inventory-health";

const S = (v) => (v == null ? "" : String(v));
const nb = (v) => S(v).trim() !== "";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (v) => typeof v === "string" && DATE_RE.test(v) && new Date(v + "T00:00:00Z").toISOString().slice(0, 10) === v;

/** The saved Health snapshot's DATE: its latest valid YYYY-MM-DD row date (null when none). */
export function healthBridgeSnapshotDate(rows) {
  let d = null;
  for (const r of Array.isArray(rows) ? rows : []) {
    const x = S(r && r.date).slice(0, 10);
    if (isDate(x) && (!d || x > d)) d = x;
  }
  return d;
}

/** A bridge that cannot be used: { rows:null, unavailableReason, snapshotDate:null, savedAt:null }. */
export function healthBridgeUnavailable(reason) {
  return { rows: null, unavailableReason: S(reason) || "health-snapshot-missing", snapshotDate: null, savedAt: null };
}

/**
 * PURE proof of one account's saved Health pointer + its hydrated rows.
 *   snapshot   -- the source_snapshots row (or null when the account has none);
 *   rows       -- the hydrated payload rows (content-hash verified by the reader), or null when unreadable;
 *   accountId  -- the pointer's expected scope_key (this account);
 *   rawSellerId -- this account's raw DataDoe seller id: a row carrying ANOTHER seller id refuses the bridge;
 *   organizationFingerprint / connectionId -- when given, a pointer carrying other values is refused.
 * -> { rows, unavailableReason:null, snapshotDate, savedAt } | healthBridgeUnavailable(reason) with reason one of
 *    health-snapshot-missing | health-snapshot-identity-mismatch | health-payload-unreadable |
 *    health-payload-row-count-mismatch | health-payload-malformed | health-foreign-seller-rows.
 */
export function healthBridgeFromSnapshot({ snapshot = null, rows = null, accountId, rawSellerId = null, organizationFingerprint = null, connectionId = null } = {}) {
  if (!snapshot || typeof snapshot !== "object" || !nb(snapshot.object_path)) return healthBridgeUnavailable("health-snapshot-missing");
  if (snapshot.source_key != null && S(snapshot.source_key) !== HEALTH_BRIDGE_SOURCE_KEY) return healthBridgeUnavailable("health-snapshot-identity-mismatch");
  if (snapshot.scope_key != null && S(snapshot.scope_key) !== S(accountId)) return healthBridgeUnavailable("health-snapshot-identity-mismatch");
  if (organizationFingerprint != null && snapshot.organization_fingerprint != null && S(snapshot.organization_fingerprint) !== S(organizationFingerprint)) return healthBridgeUnavailable("health-snapshot-identity-mismatch");
  if (connectionId != null && snapshot.connection_id != null && S(snapshot.connection_id) !== S(connectionId)) return healthBridgeUnavailable("health-snapshot-identity-mismatch");
  if (!Array.isArray(rows)) return healthBridgeUnavailable("health-payload-unreadable");
  if (snapshot.row_count != null && Number(snapshot.row_count) !== rows.length) return healthBridgeUnavailable("health-payload-row-count-mismatch");
  if (rows.some((r) => !r || typeof r !== "object" || Array.isArray(r))) return healthBridgeUnavailable("health-payload-malformed");
  const seller = S(rawSellerId).trim();
  if (seller && rows.some((r) => { const v = S(r.seller_or_vendor_id).trim(); return !!v && v !== seller; })) return healthBridgeUnavailable("health-foreign-seller-rows");
  return { rows, unavailableReason: null, snapshotDate: healthBridgeSnapshotDate(rows), savedAt: nb(snapshot.validated_at) ? S(snapshot.validated_at) : null };
}

/**
 * Read ONE account's last saved FBA Inventory Health snapshot (READ-ONLY; zero DataDoe; never throws).
 *   organizationFingerprint (or apiKey to derive it), connectionId ("primary" | "dd-secondary"), accountId (the durable
 *   scope_key), rawSellerId (defaults to accountId), readPointer / readPayload -- injectable (tests); default to the
 *   read-only Supabase readers (getSourceSnapshot + the content-hash-verifying getSourceSnapshotPayload).
 * Returns the healthBridgeFromSnapshot shape (+ health-identity-unavailable / health-snapshot-read-failed).
 */
export async function readSavedHealthBridge({
  apiKey = null, organizationFingerprint = null, connectionId = "primary", accountId, rawSellerId = null,
  readPointer = getSourceSnapshot, readPayload = getSourceSnapshotPayload, signal = null,
} = {}) {
  let org = organizationFingerprint ? S(organizationFingerprint) : null;
  if (!org && apiKey) {
    try { org = orgFingerprintOf(apiKey); } catch { org = null; }
  }
  const account = S(accountId).trim();
  if (!org || !account) return healthBridgeUnavailable("health-identity-unavailable");
  const conn = connectionId === "dd-secondary" ? "dd-secondary" : "primary";
  let snapshot;
  try {
    const read = await readPointer({ organizationFingerprint: org, connectionId: conn, sourceKey: HEALTH_BRIDGE_SOURCE_KEY, scopeKey: account, signal });
    if (!read || read.read !== "ok") return healthBridgeUnavailable(read && read.read === "schema-missing" ? "health-snapshot-missing" : "health-snapshot-read-failed");
    snapshot = read.snapshot || null;
  } catch {
    return healthBridgeUnavailable("health-snapshot-read-failed");
  }
  if (!snapshot || !nb(snapshot.object_path)) return healthBridgeUnavailable("health-snapshot-missing");
  let rows = null;
  try {
    const payload = await readPayload(S(snapshot.object_path), { signal });
    rows = Array.isArray(payload) ? payload : (payload && Array.isArray(payload.rows) ? payload.rows : null);
  } catch {
    rows = null;
  }
  return healthBridgeFromSnapshot({ snapshot, rows, accountId: account, rawSellerId: rawSellerId == null ? account : rawSellerId, organizationFingerprint: org, connectionId: conn });
}
