// Scheduler v2 -- FBA Shipment Plan durable OLI + Catalog derived-context loader.
//
// The report worker's `loadDerivedContext` for fba-plan. fba-plan's Order Line Items sales + Product Catalog are
// DERIVED durable dependencies (REPORT_DERIVED_SOURCE_KEYS["fba-plan"]): instead of owning OLI/catalog DataDoe
// exports, fba-plan reads the ALREADY-persisted durable evidence the OLI/catalog scheduler maintains --
// source_oli_daily_history (per account) + the org Product Catalog snapshot -- so opening/refreshing/publishing
// fba-plan spends ZERO tokens on OLI/catalog. All I/O is injected (offline-testable, ZERO DataDoe).
//
// FAIL CLOSED (per account) -- Correction 2: the OLI dependency is bound to EXACT account-scoped durable coverage.
// Unless the account's durable OLI coverage proves the WHOLE derive window [completed[0].from .. asOf] (start <=
// completed[0].from AND end >= asOf), this loader returns {} for OLI, so the durable input arrives absent and the
// fba-plan derive throws -> derive-invalid -> last-known-good preserved. It NEVER fabricates zero-sales tail days
// from short coverage. Provenance: the durable history rows carry source_request_hash; the catalog snapshot carries
// validated_at; the effective as-of is the planned asOf the account must independently prove.
//
// Listings inventory cutover (2026-10-08): no FBA Inventory Health export is created any more, so the loader also reads
// the account's LAST SAVED durable Health snapshot (source_snapshots 'fba-inventory-health', scope = the account)
// READ-ONLY as the temporary BRIDGE (fbaPlanHealthBridge; fba-plan-health-bridge.js). It is SOFT: a missing / unreadable
// bridge never blocks (the derive uses validated Listings or shows inventory Unavailable, never 0).

import { resolveDataDoeAccountIds } from "../datadoe-connections.js";
import { organizationFingerprint as organizationFingerprintOf } from "../source-identity.js";
import { planMonthWindows } from "../date-windows.js";
import { slicedOliSourceFromHistory } from "./durable-dashboards.js";
import { FBA_PLAN_HEALTH_BRIDGE_SOURCE_KEY, fbaPlanHealthBridgeFromSnapshot, fbaPlanHealthBridgeUnavailable } from "./fba-plan-health-bridge.js";

const S = (v) => (v == null ? "" : String(v));
const isDate = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const OLI_SOURCE_KEY = "order-line-items";
const CATALOG_SOURCE_KEY = "product-catalog";
const ORGANIZATION_SCOPE_KEY = "__organization";

// Durable connection identity ("primary" | "dd-secondary") from the resolved DataDoe connection id. The
// scheduler-v2 durable tables are written with these exact connection ids.
function durableConnectionId(connection) {
  return connection && connection.id === "secondary" ? "dd-secondary" : "primary";
}

/**
 * PURE: does the account's durable OLI coverage prove the ENTIRE window [from .. to]? Coverage windows are
 * { from, to } (getSourceCoverageWindows maps covered_from/covered_to). The proven span must start at or before
 * `from` and end at or after `to`. Interior daily continuity is guaranteed by the D-1 OLI scheduler; a genuinely
 * short window (start after `from` OR end before `to`) fails so a completed month or a recent day is never a
 * fabricated 0.
 */
export function oliCoverageProvesWindow(oliWindows, from, to) {
  const wFrom = (w) => S(w && (w.from ?? w.covered_from ?? w.coveredFrom));
  const wTo = (w) => S(w && (w.to ?? w.covered_to ?? w.coveredTo));
  const wins = (Array.isArray(oliWindows) ? oliWindows : []).filter((w) => w && isDate(wFrom(w)) && isDate(wTo(w)));
  if (!wins.length || !isDate(from) || !isDate(to)) return false;
  const minFrom = wins.map(wFrom).reduce((m, f) => (f < m ? f : m));
  const maxTo = wins.map(wTo).reduce((m, t) => (t > m ? t : m));
  return minFrom <= from && maxTo >= to;
}

/**
 * Build the durable OLI derived-source object (the { available, rows, fragments } shape the fba-plan derive's
 * slicedFragmentRows validates) from the account's durable history rows, bridged into the canonical sliced
 * fragments (slicedOliSourceFromHistory -- proven byte-identical to a fetched OLI slice payload). Pure.
 */
export function buildDurableOli({ historyRows, accountId, rawSellerId, from, to }) {
  const bridged = slicedOliSourceFromHistory({ historyRows: Array.isArray(historyRows) ? historyRows : [], accountId, rawSellerId, from, to });
  return { available: true, rows: bridged.rows, fragments: bridged.fragments };
}

/**
 * Wrap the org Product Catalog rows as the single-account fragment the fba-plan derive expects
 * (singleAccountFragmentRows over [from .. to], sellerOrVendorIds === [rawSellerId]). Pure.
 */
export function buildDurableCatalog({ catalogRows, rawSellerId, from, to }) {
  const rows = Array.isArray(catalogRows) ? catalogRows : [];
  return { available: true, rows, fragments: [{ from, to, sellerOrVendorIds: [S(rawSellerId)], rows }] };
}

/**
 * Read the account's READ-ONLY FBA Inventory Health BRIDGE (Listings inventory cutover): its LAST SAVED durable
 * snapshot source_snapshots(fba-inventory-health, scope = the account) + its content-verified rows. NEVER an export,
 * never a write. Every failure is SOFT (fbaPlanHealthBridgeFromSnapshot's typed { available:false, reason }) -- the
 * derive then uses validated Listings or shows inventory Unavailable. The snapshot DATE travels with it; the 2-day
 * freshness rule is applied by the derive (selectAccountInventory with the plan's inventory as-of).
 */
export async function readFbaPlanHealthBridge({ getSnapshot, loadPayload, organizationFingerprint, connectionId, accountId, rawSellerId }) {
  if (typeof getSnapshot !== "function" || typeof loadPayload !== "function") return fbaPlanHealthBridgeUnavailable("health-bridge-reader-missing");
  let read;
  try {
    read = await getSnapshot({ organizationFingerprint, connectionId, sourceKey: FBA_PLAN_HEALTH_BRIDGE_SOURCE_KEY, scopeKey: S(accountId) });
  } catch (_e) {
    return fbaPlanHealthBridgeUnavailable("health-bridge-read-failed");
  }
  const snapshot = read && typeof read === "object" && "snapshot" in read ? read.snapshot : read;
  if (read && typeof read === "object" && "read" in read && read.read !== "ok") return fbaPlanHealthBridgeUnavailable("health-bridge-read-failed");
  if (!snapshot || !snapshot.object_path) return fbaPlanHealthBridgeUnavailable("health-snapshot-missing");
  let rows = null;
  try {
    const payload = await loadPayload(snapshot.object_path);
    rows = Array.isArray(payload) ? payload : (payload && Array.isArray(payload.rows) ? payload.rows : null);
  } catch (_e) {
    rows = null;
  }
  return fbaPlanHealthBridgeFromSnapshot({ snapshot, rows, accountId: S(accountId), rawSellerId, organizationFingerprint, connectionId });
}

/**
 * Make the report-worker `loadDerivedContext` callback for fba-plan. For every OTHER report it returns {}.
 * For fba-plan it resolves the authoritative durable identity (org fingerprint + connection + raw seller id)
 * from account metadata, checks the account's durable OLI coverage proves the whole derive window (else {} ->
 * fail closed), reads the durable OLI history + org catalog snapshot + the READ-ONLY FBA Inventory Health bridge, and
 * returns { fbaPlanDurableOli, fbaPlanDurableCatalog, fbaPlanHealthBridge }. Injected (all Supabase, cache-only; NEVER
 * a DataDoe export):
 *   connections        -- DataDoe connections (for resolveDataDoeAccountIds); default is production.
 *   getOliCoverage     -- ({organizationFingerprint, connectionId, accountId, sourceKey}) -> { read, windows }.
 *   getOliHistory      -- ({organizationFingerprint, connectionId, accountIds, from, to}) -> durable OLI rows.
 *   getCatalogSnapshot -- ({organizationFingerprint, connectionId, sourceKey, scopeKey}) -> { snapshot, read }.
 *   loadCatalogPayload -- (objectPath) -> { rows } (durable catalog storage payload).
 *   getHealthSnapshot  -- the same pointer reader for the bridge (default getCatalogSnapshot: both are
 *                         supabase getSourceSnapshot); loadHealthPayload -- its payload reader (default
 *                         loadCatalogPayload: getSourceSnapshotPayload, content-hash verified).
 * The bridge is SOFT: a missing / unreadable / foreign bridge arrives as { available:false, reason } and never blocks.
 */
export function makeFbaPlanDurableContextLoader({ connections, getOliCoverage, getOliHistory, getCatalogSnapshot, loadCatalogPayload, getHealthSnapshot = getCatalogSnapshot, loadHealthPayload = loadCatalogPayload }) {
  return async ({ reportKey, accountId, planned }) => {
    if (reportKey !== "fba-plan") return {};
    const context = (planned && planned.context) || {};
    const asOf = context.to != null ? String(context.to) : "";
    if (!isDate(asOf)) return {}; // no authoritative asOf -> derive fails closed

    // Authoritative durable identity from account metadata (never from a row).
    let resolved;
    try {
      resolved = resolveDataDoeAccountIds([accountId], connections);
    } catch (_e) {
      return {}; // unresolvable/cross-connection account -> fail closed
    }
    if (!resolved || resolved.rawAccountIds.length !== 1) return {};
    const rawSellerId = S(resolved.rawAccountIds[0]);
    const connectionId = durableConnectionId(resolved.connection);
    const orgFingerprint = resolved.connection && resolved.connection.organizationFingerprint
      ? resolved.connection.organizationFingerprint
      : organizationFingerprintOf(resolved.connection && resolved.connection.apiKey);
    if (!orgFingerprint) return {};

    // The exact fba-plan OLI/catalog window [completed[0].from .. current.to], recomputed from asOf (never trusted).
    const { completed, current } = planMonthWindows(asOf);
    const from = completed[0].from;
    const to = current.to;

    // 1) OLI coverage MUST prove the whole window, else fail closed (no fabricated tail days / empty months).
    let cov;
    try {
      cov = await getOliCoverage({ organizationFingerprint: orgFingerprint, connectionId, accountId, sourceKey: OLI_SOURCE_KEY });
    } catch (_e) {
      return {};
    }
    const windows = cov && cov.read === "ok" ? (cov.windows || []) : [];
    if (!oliCoverageProvesWindow(windows, from, to)) return {}; // fail closed for THIS account

    let historyRows;
    try {
      historyRows = await getOliHistory({ organizationFingerprint: orgFingerprint, connectionId, accountIds: [S(accountId)], from, to });
    } catch (_e) {
      return {}; // a durable read failure must never silently fabricate -> fail closed
    }
    const fbaPlanDurableOli = buildDurableOli({ historyRows, accountId: S(accountId), rawSellerId, from, to });

    // 2) Org Product Catalog snapshot (soft over the catalog itself is NOT allowed here: fba-plan needs catalog
    //    identity, so an unreadable/missing catalog fails closed -> derive blocks -> last-known-good preserved).
    let catRead;
    try {
      catRead = await getCatalogSnapshot({ organizationFingerprint: orgFingerprint, connectionId, sourceKey: CATALOG_SOURCE_KEY, scopeKey: ORGANIZATION_SCOPE_KEY });
    } catch (_e) {
      return { fbaPlanDurableOli }; // OLI present, catalog missing -> derive blocks on catalog (fail closed)
    }
    const catalogSnapshot = catRead && typeof catRead === "object" && "snapshot" in catRead ? catRead.snapshot : catRead;
    const catalogReadOk = !catRead || typeof catRead !== "object" || !("read" in catRead) || catRead.read === "ok";
    if (!catalogReadOk || !catalogSnapshot || !catalogSnapshot.object_path) {
      return { fbaPlanDurableOli }; // catalog absent -> fail closed at derive
    }
    let catalogRows = [];
    try {
      const payload = await loadCatalogPayload(catalogSnapshot.object_path);
      catalogRows = Array.isArray(payload) ? payload : (payload && Array.isArray(payload.rows) ? payload.rows : []);
    } catch (_e) {
      return { fbaPlanDurableOli }; // catalog payload unreadable -> fail closed at derive
    }
    const fbaPlanDurableCatalog = buildDurableCatalog({ catalogRows, rawSellerId, from, to });

    // 3) The READ-ONLY FBA Inventory Health bridge (the account's last saved snapshot; soft -- never blocks).
    const fbaPlanHealthBridge = await readFbaPlanHealthBridge({ getSnapshot: getHealthSnapshot, loadPayload: loadHealthPayload, organizationFingerprint: orgFingerprint, connectionId, accountId: S(accountId), rawSellerId });

    return { fbaPlanDurableOli, fbaPlanDurableCatalog, fbaPlanHealthBridge };
  };
}
