// TRUSTED production wiring for the FBA-aware Brand View materializer (Phase 3 Completion). Binds the pure operator
// (report-materialization-brandview-operation.js) to the EXACT builders + readers the serve path uses, so the scheduler
// can never drift from the browser: buildBrandViewSnapshot / buildBrandViewPortfolioSnapshot with getLatestReportSnapshotHydrated
// + getAdsDailySourceRows + the org product-catalog reader + campaign->brand mappings, and the SAME provenance
// (getLatestSourceProvenance over brand-sales) the serve's contributingProvenanceAt compares. Construction does NO I/O;
// every collaborator is injectable. There is NO DataDoe adapter -- it is structurally incapable of an export/token.

import { getDataDoeConnections } from "../datadoe-connections.js";
import { organizationFingerprint } from "../source-identity.js";
import { marketplaceToday } from "../../marketplaces.js";
import { makeProductionDiscoverAccounts } from "./runtime-composition.js";
import { discoverPrimaryAccountIds } from "./priority-control-pg-store.js";
import { accountInScope, REGION_SCOPES } from "./scheduler-scope.js";
import {
  buildBrandViewSnapshot, buildBrandViewPortfolioSnapshot, buildBrandViewBrandDirectory, brandNamesFromPayload,
  BRAND_VIEW_VERSION, BRAND_VIEW_PORTFOLIO_VERSION, BRAND_INVENTORY_REPORT_VERSION, selectAuthoritativeInventorySnapshot,
} from "../reports/brand-view.js";
import { paramsHashFor } from "../report-store.js";
import { collectBrandViewDependencyFingerprint } from "../reports/brand-view-dependency-fingerprint.js";
import { campaignMappingRevision } from "../reports/campaign-ads-aggregation.js";
import { ACTIVE_ADS_SOURCE_KEY } from "../active-ads-source.js";
import { getCampaignBrandMappings } from "../supabase.js";
import {
  getLatestReportSnapshot, getLatestReportSnapshotHydrated, getReportSnapshot, getLatestReportSnapshotMeta,
  getInventorySnapshotCandidates,
  getLatestSourceProvenance, getAdsDailySourceRows, getDailyAdsCoverage, getSourceSnapshot, getSourceSnapshotPayload,
  saveReportSnapshot, publishSnapshotUpdate, claimRefreshLock, releaseRefreshLock,
} from "../supabase.js";

const BRAND_INVENTORY_LIVE_REPORT_KEY = "brand-inventory";

const BRAND_SALES_REPORT_KEY = "brand-sales";

export function buildBrandViewMaterializationRelease(overrides = {}) {
  const {
    operator = "operator",
    getConnections = getDataDoeConnections,
    discoverAccountIds = discoverPrimaryAccountIds,
    readDirectoryAccounts = null,
    getSnapshotHydrated = getLatestReportSnapshotHydrated,
    getSnapshotLatest = getLatestReportSnapshot,
    readExactSnapshot = getReportSnapshot,
    getProvenance = getLatestSourceProvenance,
    getAdsRows = getAdsDailySourceRows,
    // Zero-export readers for the dependency FINGERPRINT (Defect B): cheap indexed snapshot meta + ads coverage
    // state, used to fingerprint the COMPLETE contributing dependency set so a changed optional dependency
    // (inventory/Ads/mapping/catalog) rebuilds the report even when brand-sales provenance is unchanged. The SAME
    // readers back the serve's fingerprint (api/datadoe.js), so writer and serve agree by construction.
    getSnapshotMeta = getLatestReportSnapshotMeta,
    getAdsCoverageState = getDailyAdsCoverage,
    getSourceSnap = getSourceSnapshot,
    loadSourcePayload = getSourceSnapshotPayload,
    getMappings = getCampaignBrandMappings,
    saveSnapshot = saveReportSnapshot,
    publishUpdate = publishSnapshotUpdate,
    claimLockFn = claimRefreshLock,
    releaseLockFn = releaseRefreshLock,
    getExactSnapshot = getReportSnapshot,
    getInventoryCandidates = getInventorySnapshotCandidates,
    buildSingle = buildBrandViewSnapshot,
    buildPortfolio = buildBrandViewPortfolioSnapshot,
    buildBrandsDir = buildBrandViewBrandDirectory,
    today = marketplaceToday,
  } = overrides;

  const connections = getConnections();
  const primary = (connections || []).find((c) => c && c.id === "primary" && String(c.apiKey || "").trim()) || null;
  const primaryApiKey = primary ? String(primary.apiKey || "").trim() : null;
  const orgFp = primary ? (primary.organizationFingerprint || organizationFingerprint(primary.apiKey)) : null;

  const discoverAccounts = async (region) => {
    if (!REGION_SCOPES.includes(String(region))) throw new Error(`brand-view-materialization: unknown region "${region}"`);
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

  const getCampaignMappings = async ({ accountId }) => (orgFp ? getMappings({ organizationFingerprint: orgFp, connectionId: "primary", accountId }).catch(() => []) : []);

  // The org Product Catalog validated_at (cheap meta, not the payload) for the dependency fingerprint. A catalog
  // re-validation (new mapping content) advances it, so Brand View rebuilds when the ASIN->brand map changes.
  const getCatalogValidatedAt = orgFp ? async () => {
    const read = await getSourceSnap({ organizationFingerprint: orgFp, connectionId: "primary", sourceKey: "product-catalog", scopeKey: "__organization" });
    const ptr = read && typeof read === "object" && "snapshot" in read ? read.snapshot : read;
    return (ptr && (ptr.validated_at || ptr.payload_sha)) || null;
  } : async () => null;

  // The SHARED dependency-fingerprint readers (zero-export). deriveBrandView / deriveBrandViewPortfolio compute
  // the fingerprint over EXACTLY these dependencies; the serve (api/datadoe.js) computes it over the same ones.
  const depReaders = {
    getSnapshotMeta: ({ reportKey, accountId }) => getSnapshotMeta({ reportKey, accountId }).catch(() => null),
    getAdsCoverage: (accountId) => getAdsCoverageState(accountId, ACTIVE_ADS_SOURCE_KEY).catch(() => null),
    getMappingRev: async (accountId) => campaignMappingRevision(await getCampaignMappings({ accountId }).catch(() => [])),
    getCatalogValidatedAt: () => getCatalogValidatedAt().catch(() => null),
    // Round-4 Defect 2: the inventory dependency identity is the SELECTED authoritative compact (the available LKG
    // the builder actually serves), NOT the latest-by-updated_at row. So a selected-row change (a fresh available
    // compact) flips the fingerprint even when the latest placeholder's metadata is unchanged, and the serve does
    // NOT needlessly rebuild when an unavailable placeholder republishes but the selection is unchanged. Writer +
    // serve use the SAME selection, so they agree.
    getInventorySelected: (accountId) => getInventoryCandidates({ reportKey: BRAND_INVENTORY_LIVE_REPORT_KEY, accountId, reportVersion: BRAND_INVENTORY_REPORT_VERSION })
      .then((rows) => selectAuthoritativeInventorySnapshot(rows)).catch(() => null),
  };

  // The org product-catalog rows (zero-export), read ONCE per portfolio-brand -- mirrors the serve's getBrandViewCatalogRows.
  const getCatalogRows = orgFp ? async () => {
    const read = await getSourceSnap({ organizationFingerprint: orgFp, connectionId: "primary", sourceKey: "product-catalog", scopeKey: "__organization" });
    const ptr = read && typeof read === "object" && "snapshot" in read ? read.snapshot : read;
    if (!ptr || !ptr.object_path) return null;
    const payload = await loadSourcePayload(ptr.object_path);
    return Array.isArray(payload) ? payload : (payload && Array.isArray(payload.rows) ? payload.rows : null);
  } : null;

  // Single brand-view brands = the account's brand-view-brands directory (the SAME dropdown the browser offers).
  const readAccountBrands = async ({ accountId }) => {
    const dir = await buildBrandsDir({ accountId, getSnapshot: getSnapshotLatest });
    return (dir && Array.isArray(dir.brands)) ? dir.brands : [];
  };
  // Portfolio membership evidence = the account's latest brand-sales brand names (storage-first), exactly as the browser
  // directory (sharedSnapshotBrandAccounts) derives it.
  const readAccountSalesBrands = async ({ accountId }) => {
    const snap = await getSnapshotHydrated({ reportKey: BRAND_SALES_REPORT_KEY, accountId });
    return brandNamesFromPayload(snap && snap.payload);
  };

  const deriveBrandView = async ({ accountId, brand, asOf, account }) => {
    // Capture the dependency fingerprint BEFORE building the payload (TOCTOU-safe ordering). The fingerprint over the
    // COMPLETE contributing set is what drives write/serve change-detection (Defect B); sourceRefreshedAt (brand-sales)
    // stays only for ordering/LKG. Computing it FIRST guarantees the stored fingerprint can never be NEWER than the
    // payload it labels: if a contributing dependency advances during the (unlocked) build, the stored fp is then
    // OLDER than the current state, so the serve flags the snapshot stale and the next scheduled materialization sees
    // a differing fingerprint and re-persists the corrected payload (self-heals after one cycle) -- instead of
    // stranding a stale payload behind a newer-looking fingerprint that both serve and writer would treat as fresh.
    const depFingerprint = await collectBrandViewDependencyFingerprint({
      scope: "account", brand, accountIds: [accountId], reportVersion: BRAND_VIEW_VERSION, readers: depReaders,
    }).catch(() => null);
    let payload = null;
    try {
      payload = await buildSingle({ accountId, brand, asOf, account, getSnapshot: getSnapshotHydrated, getAdsRows, getCampaignMappings, getInventorySnapshots });
    } catch (_e) { return { notReady: "brand-view-build-failed" }; } // missing required brand-sales -> LKG preserved
    if (!payload) return { notReady: "brand-view-empty" };
    const sourceRefreshedAt = await getProvenance({ reportKey: BRAND_SALES_REPORT_KEY, accountIds: [accountId] }).catch(() => null);
    return { payload, sourceRefreshedAt: sourceRefreshedAt || null, depFingerprint };
  };

  const deriveBrandViewPortfolio = async ({ accountIds, brand, asOf, region, accountsById }) => {
    // Fingerprint BEFORE the build (TOCTOU-safe -- see deriveBrandView): stored fp is never newer than the payload,
    // so a concurrent dependency advance self-heals on the next cycle rather than stranding a stale payload as fresh.
    const depFingerprint = await collectBrandViewDependencyFingerprint({
      scope: "portfolio", brand, accountIds, reportVersion: BRAND_VIEW_PORTFOLIO_VERSION, readers: depReaders,
    }).catch(() => null);
    let payload = null;
    try {
      payload = await buildPortfolio({ accountIds, brand, asOf, accountsById, getSnapshot: getSnapshotHydrated, getAdsRows, getCatalogRows, deadline: null, getCampaignMappings, getInventorySnapshots });
    } catch (_e) { return { notReady: "portfolio-build-failed" }; }
    if (!payload) return { notReady: "portfolio-empty" };
    const sourceRefreshedAt = await getProvenance({ reportKey: BRAND_SALES_REPORT_KEY, accountIds }).catch(() => null);
    return { payload, sourceRefreshedAt: sourceRefreshedAt || null, depFingerprint };
  };

  const readSnapshot = ({ reportKey, accountId, paramsHash }) => readExactSnapshot({ reportKey, accountId, paramsHash });
  const persistSnapshot = async ({ reportKey, reportVersion, accountId, paramsHash, params, payload, sourceRefreshedAt }) => {
    const payloadBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
    const saved = await saveSnapshot({ reportKey, accountId, paramsHash, params, payload, payloadBytes, sourceRefreshedAt: sourceRefreshedAt || new Date().toISOString() });
    if (saved && saved.id) await publishUpdate({ reportKey, accountId, paramsHash, snapshotId: saved.id }).catch(() => {});
    return { savedAt: (saved && (saved.source_refreshed_at || saved.updated_at)) || sourceRefreshedAt || new Date().toISOString(), bytes: payloadBytes };
  };
  const claimLock = ({ reportKey, accountId, paramsHash }) => claimLockFn({ reportKey, accountId, paramsHash, lockSeconds: 300 });
  const releaseLock = ({ reportKey, accountId, paramsHash }) => releaseLockFn({ reportKey, accountId, paramsHash });

  // Defect A: the FRESH fba-plan snapshot reader + the PER-ACCOUNT authorization signal for the compact
  // brand-inventory rebuild (runBrandInventoryRebuild). Zero-export -- both read durable snapshots only.
  const readFbaPlan = ({ accountId }) => getSnapshotHydrated({ reportKey: "fba-plan", accountId });
  // Round-4 Defect 1: authorization is the priority run's EXACT current-cycle publication -- the brand-inventory row
  // at the identity params {to: cycleAsOf} (paramsHash-exact), NOT the latest-by-updated_at row. Reading the EXACT
  // cycle row decouples publication authorization from the latest DISPLAYED inventory: a lagging available rebuild
  // (a different identity {to: its real inventory date}) can never invalidate authorization for a later fresh update
  // in the same cycle, while a revoked account (no current-cycle publication) fails closed. A missing cycleAsOf ->
  // null (the operator fails closed on it too).
  const readLiveBrandInventory = ({ accountId, cycleAsOf }) => {
    const cycle = cycleAsOf != null ? String(cycleAsOf).trim() : "";
    if (!cycle) return Promise.resolve(null);
    const paramsHash = paramsHashFor(BRAND_INVENTORY_REPORT_VERSION, { to: cycle });
    return getExactSnapshot({ reportKey: BRAND_INVENTORY_LIVE_REPORT_KEY, accountId, paramsHash });
  };
  // Round-4 Defect 2: the inventory-candidate reader the Brand View builds SELECT the authoritative compact from
  // (selectAuthoritativeInventorySnapshot) instead of trusting the latest-by-updated_at row -- two indexed reads
  // (newest AVAILABLE compact + newest overall), NO recent-N cutoff. Zero-export (durable rows only). The SAME
  // reader backs the serve (api/datadoe.js) so writer + serve select identically.
  const getInventorySnapshots = ({ reportKey, accountId }) => getInventoryCandidates({ reportKey, accountId, reportVersion: BRAND_INVENTORY_REPORT_VERSION });

  return Object.freeze({
    operator, connections, hasPrimary: !!primaryApiKey,
    discoverAccounts,
    readAccountBrands, readAccountSalesBrands,
    deriveBrandView, deriveBrandViewPortfolio,
    readSnapshot, persistSnapshot, claimLock, releaseLock,
    readFbaPlan, readLiveBrandInventory, getInventorySnapshots,
    marketplaceToday: today,
  });
}
