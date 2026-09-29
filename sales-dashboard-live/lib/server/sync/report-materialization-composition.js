// TRUSTED production wiring for the scheduler-owned report materialization operator (Phase 3, Increment 1). The ONE
// place the reviewed production collaborators are bound to the pure operator core (report-materialization-operation.js),
// mirroring buildFbaPlanRelease / buildListingHealthV3IngestionRelease. It reuses the EXACT standalone, zero-export
// derive functions the browser self-heal path already calls -- rederiveSkuMovement, gatherReturnsEvidence,
// buildBrandViewBrandDirectory -- with the SAME Supabase readers, and writes each snapshot under the SAME identity
// (paramsHashFor + report version) the serve reads. So the scheduler can NEVER drift from the serve, and no derive
// logic is duplicated. Construction performs NO I/O; every collaborator is injectable so the composition is
// offline-testable. There is NO DataDoe adapter, no export cache, no token balance and no cycle/budget on this path:
// it is structurally incapable of creating an export or spending a token.
//
// PUBLICATION RECOVERY WP13 -- RETIRED AS A WRITER. This composition used to bind persistSnapshot to the UNFENCED
// saveReportSnapshot (+ publishSnapshotUpdate and the refresh locks), so the scheduler's legacy materializer wrote the
// live brand-view-brands / sku-movement / returns-leakage rows outside the four-gate publisher and the fenced CAS. Those
// keys are now published ONLY by the fenced zero-export route CLI (publication-route-reconcile.mjs --route=
// brand-view-brands,sku-movement,returns-v3). It now binds NO writer, NO lock and NO publish -- only the durable READERS
// the zero-export derives use -- so scripts/release/report-materialization.mjs is a read-only dry-run plan, and the
// operator core (runReportMaterialization) refuses a live run for want of a persistSnapshot (fail closed). Its former
// directory derive also used the NON-hydrated brand-sales reader (a reduced directory for an out-of-line account that
// the hydrated brand-view-brands route would overwrite back and forth): that conflict is gone with the write path.

import { getDataDoeConnections } from "../datadoe-connections.js";
import { organizationFingerprint } from "../source-identity.js";
import { makeProductionDiscoverAccounts } from "./runtime-composition.js";
import { discoverPrimaryAccountIds } from "./priority-control-pg-store.js";
import { accountInScope, REGION_SCOPES } from "./scheduler-scope.js";
import { rederiveSkuMovement } from "../reports/sku-movement-durable-rederive.js";
import { gatherReturnsEvidence } from "../reports/returns-publish.js";
import { buildBrandViewBrandDirectory } from "../reports/brand-view.js";
import {
  getSourceOliHistoryRows, getSourceCoverageWindows, getSourceSnapshot, getSourceSnapshotPayload,
  getSourceOliOperationalUnitRows, getOliSkuAsinResolutionRows, getAccountDirectorySnapshotAccounts,
  getReturnsHistoryRows, getSettlementHistoryRows,
  getReportSnapshot, getLatestReportSnapshot,
} from "../supabase.js";

/**
 * Build the READ-ONLY report-materialization collaborators the operator core consumes (dry-run plan only). `overrides` is
 * a BUILD-TIME test seam only (production passes nothing). Returns { operator, connections, hasPrimary, discoverAccounts,
 * deriveBrandViewBrands, deriveSkuMovement, deriveReturns, readSnapshot } -- NO persistSnapshot / claimLock / releaseLock
 * (WP13: the write path is retired; the fenced route CLI is the only writer of these keys).
 */
export function buildReportMaterializationRelease(overrides = {}) {
  const {
    operator = "operator",
    getConnections = getDataDoeConnections,
    discoverAccountIds = discoverPrimaryAccountIds,
    readDirectoryAccounts = null,
    // Injectable durable readers / writers (default: the real Supabase functions). BUILD-TIME test seam only.
    readSkuOliHistory = getSourceOliHistoryRows,
    readOliCoverage = getSourceCoverageWindows,
    readCatalogSnapshot = getSourceSnapshot,
    loadCatalogPayload = getSourceSnapshotPayload,
    readOliOperationalUnits = getSourceOliOperationalUnitRows,
    readOliSkuAsinResolution = getOliSkuAsinResolutionRows,
    readDirectory = getAccountDirectorySnapshotAccounts,
    readReturnsHistory = getReturnsHistoryRows,
    readSettlementHistory = getSettlementHistoryRows,
    getSnapshot = getLatestReportSnapshot,
    readExactSnapshot = getReportSnapshot,
    rederiveSku = rederiveSkuMovement,
    gatherReturns = gatherReturnsEvidence,
    buildBrandViewBrands = buildBrandViewBrandDirectory,
  } = overrides;

  const connections = getConnections();
  const primary = (connections || []).find((c) => c && c.id === "primary" && String(c.apiKey || "").trim()) || null;
  const primaryApiKey = primary ? String(primary.apiKey || "").trim() : null;
  const orgFp = primary ? (primary.organizationFingerprint || organizationFingerprint(primary.apiKey)) : null;

  // Region-scoped primary accounts: the authoritative primary directory (a fresh accounts GET -- never an export),
  // intersected with the authoritative primary id discovery, filtered to the region by marketplace/country. Prefixed
  // (dd-secondary:) ids and country-less accounts are dropped (they can never be region-routed safely).
  const discoverAccounts = async (region) => {
    if (!REGION_SCOPES.includes(String(region))) throw new Error(`report-materialization: unknown region "${region}"`);
    const readAccounts = readDirectoryAccounts || makeProductionDiscoverAccounts({ connections: getConnections });
    const rows = (await readAccounts()) || [];
    const metaById = new Map();
    for (const r of rows) {
      const id = String((r && (r.accountId || r.account_id || r.id)) || "").trim();
      const country = String((r && (r.country || r.marketplace_country_code)) || "").trim();
      if (!id || id.includes(":") || !country) continue;
      if (!accountInScope(region, country)) continue;
      metaById.set(id, { accountId: id, country, currency: (r && r.currency) || null, name: (r && r.name) || null });
    }
    const primaryIds = await discoverAccountIds();
    return primaryIds.map((id) => metaById.get(id)).filter(Boolean);
  };

  const skuReaders = {
    readOliHistory: readSkuOliHistory, readOliCoverage, readCatalogSnapshot, loadCatalogPayload,
    readOliOperationalUnits, readOliSkuAsinResolution, readDirectory,
  };
  const returnsReaders = {
    readReturnsHistory, readSettlementHistory, readOliHistory: readSkuOliHistory, readOliCoverage,
    readOliOperationalUnits, readCatalogSnapshot, loadCatalogPayload, readOliSkuAsinResolution, readDirectory,
  };

  const deriveBrandViewBrands = ({ accountId }) => buildBrandViewBrands({ accountId, getSnapshot });

  const deriveSkuMovement = ({ accountId, brand, ceiling }) =>
    rederiveSku({ accountId, brand, organizationFingerprint: orgFp, connectionId: "primary", ceiling }, skuReaders);

  const deriveReturns = ({ accountId, asOf }) =>
    gatherReturns({ accountId, organizationFingerprint: orgFp, connectionId: "primary", asOf }, returnsReaders);

  const readSnapshot = ({ reportKey, accountId, paramsHash }) => readExactSnapshot({ reportKey, accountId, paramsHash });

  // WP13: NO persistSnapshot / claimLock / releaseLock -- the write path is retired (read-only dry-run plan only).
  return Object.freeze({
    operator,
    connections,
    hasPrimary: !!primaryApiKey,
    discoverAccounts,
    deriveBrandViewBrands,
    deriveSkuMovement,
    deriveReturns,
    readSnapshot,
  });
}
