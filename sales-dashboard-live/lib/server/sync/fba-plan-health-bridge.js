// FBA Shipment Plan -- the READ-ONLY FBA Inventory Health BRIDGE (Listings inventory cutover, owner decision 2026-10-08).
//
// No FBA Inventory Health export is created any more (lib/server/datadoe.js refuses the Health source). The fba-plan
// derive instead receives the account's LAST SAVED durable Health snapshot -- public.source_snapshots(source_key
// 'fba-inventory-health', scope_key = the account) -- READ-ONLY, as a derived dependency (derive context key
// FBA_PLAN_HEALTH_BRIDGE_CONTEXT_KEY), in EVERY path that derives fba-plan: the scheduler (fba-plan-durable-loader.js,
// the report worker's loadDerivedContext), the web publish-from-saved-data bundle and the zero-export recovery route
// (fba-plan-dependency-bundle.js feeds the SAME loader its proven pointer). Nothing here ever writes or exports.
//
// This module only proves that the saved pointer + rows belong to THIS account (organization / connection / source /
// scope / row count / one raw seller on every row) and dates the snapshot (its latest row date). Whether the bridge may
// drive figures is decided by lib/server/inventory-source.js selectAccountInventory (validated Listings first; the bridge
// only while its date >= the plan's inventory as-of - HEALTH_BRIDGE_MAX_AGE_DAYS; else inventory Unavailable, never 0).
//
// Every refusal is SOFT -- { available:false, reason } -- never a block: a plan whose Listings validates never needs the
// bridge, and one that does shows inventory Unavailable with the typed reason. PURE (no I/O). 7-bit ASCII, LF.

// The durable source key of the saved FBA Inventory Health snapshot (source-durable-model.js FBA_INVENTORY_SOURCE_KEY;
// repeated here so this leaf imports nothing).
export const FBA_PLAN_HEALTH_BRIDGE_SOURCE_KEY = "fba-inventory-health";
// The fba-plan derive-context key that carries the bridge (report-derivation.js derivedContextKeys allowlist).
export const FBA_PLAN_HEALTH_BRIDGE_CONTEXT_KEY = "fbaPlanHealthBridge";
// The bridge's typed soft reasons (never route reasons by themselves): no saved snapshot for the account (the same code
// lib/server/inventory-source.js reports) / a saved snapshot with no rows.
export const FBA_PLAN_HEALTH_BRIDGE_MISSING = "health-snapshot-missing";
export const FBA_PLAN_HEALTH_BRIDGE_ROWS_EMPTY = "health-bridge-rows-empty";

const S = (v) => (v == null ? "" : String(v));
const nb = (v) => S(v).trim() !== "";
const isCount = (n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (v) => typeof v === "string" && DATE_RE.test(v) && new Date(v + "T00:00:00Z").toISOString().slice(0, 10) === v;
const isoOrNull = (v) => {
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.toISOString() : null;
  return nb(v) ? S(v) : null;
};

/** A bridge refusal (soft). */
export function fbaPlanHealthBridgeUnavailable(reason) {
  return { available: false, reason: S(reason) || "health-snapshot-missing", rows: [], snapshotDate: null, validatedAt: null, sourceRequestHash: null, payloadSha: null };
}

/** The saved Health snapshot's DATE: the latest valid YYYY-MM-DD row date (null when none). */
export function fbaPlanHealthSnapshotDate(rows) {
  let d = null;
  for (const r of Array.isArray(rows) ? rows : []) {
    const x = S(r && r.date).slice(0, 10);
    if (isDate(x) && (!d || x > d)) d = x;
  }
  return d;
}

/**
 * Build the bridge from the account's durable pointer + its hydrated rows (PURE).
 *   snapshot  -- the source_snapshots row ({ organization_fingerprint, connection_id, source_key, scope_key, object_path,
 *                payload_sha, row_count, source_request_hash, validated_at }) or null;
 *   rows      -- the hydrated payload rows (content-hash verified by the reader) or null when unreadable;
 *   accountId -- THIS account (the pointer's scope_key must equal it -- a cross-account pointer is refused);
 *   rawSellerId -- THIS account's raw DataDoe seller id (every row must carry it);
 *   organizationFingerprint / connectionId -- when given, the pointer must carry exactly them.
 * -> { available:true, rows, snapshotDate, validatedAt, sourceRequestHash, payloadSha }
 *  | { available:false, reason } with reason one of: health-snapshot-missing | health-bridge-pointer-integrity:<why> |
 *    health-bridge-payload-unreadable | health-bridge-rows-invalid:<malformed|cross-account|row-count-mismatch>.
 */
export function fbaPlanHealthBridgeFromSnapshot({ snapshot = null, rows = null, accountId, rawSellerId, organizationFingerprint = null, connectionId = null } = {}) {
  const no = fbaPlanHealthBridgeUnavailable;
  if (!snapshot || typeof snapshot !== "object") return no("health-snapshot-missing");
  // The reader already queried by organization / connection / source (getSourceSnapshot filters on them), so a pointer
  // carrying ANOTHER value is refused; the SCOPE (this account) must always be present and equal.
  if (organizationFingerprint != null && snapshot.organization_fingerprint != null && S(snapshot.organization_fingerprint) !== S(organizationFingerprint)) return no("health-bridge-pointer-integrity:org-mismatch");
  if (connectionId != null && snapshot.connection_id != null && S(snapshot.connection_id) !== S(connectionId)) return no("health-bridge-pointer-integrity:connection-mismatch");
  if (snapshot.source_key != null && S(snapshot.source_key) !== FBA_PLAN_HEALTH_BRIDGE_SOURCE_KEY) return no("health-bridge-pointer-integrity:source-key-mismatch");
  if (!nb(accountId) || S(snapshot.scope_key) !== S(accountId)) return no("health-bridge-pointer-integrity:cross-account-scope");
  if (!Array.isArray(rows)) return no("health-bridge-payload-unreadable");
  if (isCount(snapshot.row_count) && rows.length !== snapshot.row_count) return no("health-bridge-rows-invalid:row-count-mismatch");
  if (rows.some((r) => !r || typeof r !== "object" || Array.isArray(r))) return no("health-bridge-rows-invalid:malformed");
  // One seller: a row carrying ANOTHER seller id refuses the bridge (the pointer's scope_key already binds the account;
  // a row without a seller id is accepted -- the same rule as the shared read-only bridge reader of the other consumers).
  const raw = S(rawSellerId).trim();
  if (!raw) return no("health-bridge-rows-invalid:seller-unresolved");
  if (rows.some((r) => { const v = S(r.seller_or_vendor_id).trim(); return !!v && v !== raw; })) return no("health-bridge-rows-invalid:cross-account");
  return {
    available: true,
    rows,
    snapshotDate: fbaPlanHealthSnapshotDate(rows),
    validatedAt: isoOrNull(snapshot.validated_at),
    sourceRequestHash: nb(snapshot.source_request_hash) ? S(snapshot.source_request_hash) : null,
    payloadSha: nb(snapshot.payload_sha) ? S(snapshot.payload_sha) : null,
  };
}
