// TRUSTED production wiring for the scheduler-owned report materialization operator (Phase 3, Increment 1). The ONE
// place the reviewed production collaborators are bound to the pure operator core (report-materialization-operation.js),
// mirroring buildFbaPlanRelease / buildListingHealthV3IngestionRelease. It reuses the EXACT standalone, zero-export
// derive functions the browser self-heal path already calls -- rederiveSkuMovement, gatherReturnsEvidence,
// buildBrandViewBrandDirectory -- with the SAME Supabase readers, and writes each snapshot under the SAME identity
// (paramsHashFor + report version) the serve reads. So the scheduler can NEVER drift from the serve, and no derive
// logic is duplicated. Construction performs NO I/O; every collaborator is injectable so the composition is
// offline-testable. There is NO DataDoe adapter, no export cache, no token balance and no cycle/budget on this path:
// it is structurally incapable of creating an export or spending a token.

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
  getReportSnapshot, getLatestReportSnapshot, saveReportSnapshot, publishSnapshotUpdate,
  claimRefreshLock, releaseRefreshLock,
} from "../supabase.js";

/**
 * Build the trusted report-materialization collaborators the operator core consumes. `overrides` is a BUILD-TIME
 * test seam only (production passes nothing). Returns { operator, discoverAccounts, deriveBrandViewBrands,
 * deriveSkuMovement, deriveReturns, readSnapshot, persistSnapshot, claimLock, releaseLock }.
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
    saveSnapshot = saveReportSnapshot,
    publishUpdate = publishSnapshotUpdate,
    claimLockFn = claimRefreshLock,
    releaseLockFn = releaseRefreshLock,
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

  const persistSnapshot = async ({ reportKey, reportVersion, accountId, paramsHash, params, payload, sourceRefreshedAt }) => {
    const payloadBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
    const saved = await saveSnapshot({
      reportKey, accountId, paramsHash, params, payload, payloadBytes,
      sourceRefreshedAt: sourceRefreshedAt || new Date().toISOString(),
    });
    if (saved && saved.id) await publishUpdate({ reportKey, accountId, paramsHash, snapshotId: saved.id }).catch(() => {});
    return { savedAt: (saved && (saved.source_refreshed_at || saved.updated_at)) || sourceRefreshedAt || new Date().toISOString(), bytes: payloadBytes };
  };

  const claimLock = ({ reportKey, accountId, paramsHash }) => claimLockFn({ reportKey, accountId, paramsHash, lockSeconds: 300 });
  const releaseLock = ({ reportKey, accountId, paramsHash }) => releaseLockFn({ reportKey, accountId, paramsHash });

  return Object.freeze({
    operator,
    connections,
    hasPrimary: !!primaryApiKey,
    discoverAccounts,
    deriveBrandViewBrands,
    deriveSkuMovement,
    deriveReturns,
    readSnapshot,
    persistSnapshot,
    claimLock,
    releaseLock,
  });
}
