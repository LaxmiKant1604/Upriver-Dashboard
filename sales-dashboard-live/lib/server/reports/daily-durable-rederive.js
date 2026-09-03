// Trusted ZERO-EXPORT re-derivation of Daily Reporting for the CURRENT live version (daily-reporting-shared-v2).
//
// WHY: the frontend was bumped to request daily-reporting-shared-v2 (ASIN-grain ad sales) before any v2 snapshot
// was published, so serveSharedReport's exact-key read misses and the stale gate refuses the v1 payload (v1 is
// campaign-grain -- never served as v2), leaving "Nothing saved for this account yet" for all 30 accounts even
// though durable OLI history is present. The fix is to RECOMPUTE the v2 payload through the REAL derivation
// contract from already-durable evidence and publish it -- never copying or relabeling a v1 snapshot.
//
// This module makes ZERO DataDoe calls: it reads ONLY durable Supabase evidence (source_oli_daily_history, the
// asin-performance-v1 rows + coverage, the reusable Product Catalog snapshot). No adapter is created, so a create-
// export is structurally impossible here. Campaign Ads is never read; FBA is never touched.
//
// Currency isolation + Ads-unavailable-never-zero come for free: the derivation is the SAME REPORT_DERIVATIONS
// ["daily-reporting"].derive the scheduler uses (byte-parity is proven by durable-live-parity), and its
// resolveDailyAdsAvailability degrades Ads to a typed unavailable/partial state while proven OLI sales + units
// still publish. A named-brand request derives the brand-filtered payload (no ads), exactly like the live route.

import { REPORT_DERIVATIONS } from "../sync/report-derivation.js";
import { dailyReportingReadiness, slicedOliSourceFromHistory, BRAND_VIEW_ADS_GRAIN } from "../sync/durable-dashboards.js";
import { buildDailyAdsCoverage, DAILY_ADS_SOURCE_KEY } from "../sync/daily-ads-loader.js";
import { filterAdRowsToBrand } from "./derivation-core.js";
import { ORGANIZATION_SCOPE_KEY, mergeCoverageWindows } from "../sync/source-durable-model.js";
import { ACTIVE_ADS_SOURCE_KEY, ASIN_ADS_SOURCE_KEY } from "../active-ads-source.js";
import { campaignBrandMap, filterCampaignAdRowsToBrand, campaignMappingRevision } from "./campaign-ads-aggregation.js";
import { brandKey } from "./brand-membership.js";

// SOURCE-AWARE brand attribution for the named-brand Daily ad rows. Before the ASIN->Campaign cutover a brand's ads
// were the raw ASIN rows whose child_asin mapped to the brand via the Product Catalog (filterAdRowsToBrand). AFTER
// the cutover the ACTIVE grain is campaign-performance-v1: campaign rows carry NO child_asin, so they must attribute
// through the account's manual campaign->brand mapping (the SAME map Brand View uses). This is the one place Daily
// resolves a named brand's ad rows, so Daily and Brand View can never diverge. Unmapped/other-brand campaigns are
// excluded from the named brand (they still count in the account-level All-Brands total).
function filterActiveAdRowsToNamedBrand(adRows, { catalogRows, campaignMappingRows, brand }) {
  if (ACTIVE_ADS_SOURCE_KEY === ASIN_ADS_SOURCE_KEY) return filterAdRowsToBrand(adRows, catalogRows, brand);
  const identityBrandMap = campaignBrandMap(campaignMappingRows || [], (m) => m.brandKey);
  return filterCampaignAdRowsToBrand(adRows, identityBrandMap, brandKey(brand));
}

// The CURRENT Daily Reporting identities (kept in lockstep with report-publisher / registry / api / App.jsx).
export const DAILY_V2_LIVE_VERSION = "daily-reporting-shared-v2";
export const DAILY_OLI_SOURCE_KEY = "order-line-items";
export const CATALOG_SOURCE_KEY = "product-catalog";

const S = (v) => (v == null ? "" : String(v));
const isDate = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

/**
 * The latest date <= `ceiling` that the account's proven OLI coverage contiguously covers starting at `from`.
 *
 * WHY: the frontend always requests Daily with to=TODAY, but durable OLI is only proven through the last
 * exported date (per account -- some accounts are a few days behind others, and no new export is authorized).
 * Deriving to the EXACT requested date fails readiness (coverage-incomplete) and blanks the page. Instead we
 * honestly serve the report ENDING at each account's own latest proven date. Returns null when `from` itself
 * is not covered (a genuine gap at the window start -> the report cannot be produced; never a fabricated zero).
 * Malformed coverage evidence fails closed (via mergeCoverageWindows) -> null, never a false "proven".
 */
export function latestProvenDailyTo({ oliWindows, from, ceiling }) {
  if (!isDate(from) || !isDate(ceiling) || from > ceiling) return null;
  let merged;
  try { merged = mergeCoverageWindows(oliWindows || []); } catch (_e) { return null; }
  const containing = merged.find((w) => w.from <= from && w.to >= from);
  if (!containing) return null;
  const effectiveTo = containing.to < ceiling ? containing.to : ceiling;
  return effectiveTo >= from ? effectiveTo : null;
}

/**
 * PURE: derive the daily-reporting/v2e-1 payload for ONE account from already-read durable evidence, through the
 * REAL derivation contract. Returns { payload, version, latestDataDate } on success, or { notReady, blockedBy? }
 * when the durable evidence cannot honestly produce the report (never a fabricated zero). No I/O, no DataDoe.
 *
 * evidence: {
 *   historyRows,          // source_oli_daily_history rows for this account (any superset window)
 *   oliWindows,           // proven OLI coverage windows [{from,to}] for this account
 *   catalogSnapshot,      // { validated_at, ... } pointer (readiness needs validated_at)
 *   catalogRows,          // hydrated Product Catalog rows (reused durable snapshot payload)
 *   asinAdRows,           // asin-performance-v1 rows for this account/window (ALL-brand only)
 *   asinMetricsRead,      // "ok" | "limit-exceeded" | "read-failed"
 *   asinCoverageState,    // { windows, status, latestMetricDate, read } from ads_sync_coverage
 *   asinCoverageRead,     // coverage read outcome
 *   asinWindows,          // proven ASIN coverage windows (readiness, non-blocking)
 * }
 */
export function rederiveDailyV2Payload({ accountId, rawSellerId, currency, from, to, brand = "ALL" }, evidence = {}) {
  const daily = REPORT_DERIVATIONS["daily-reporting"];
  const wantBrand = S(brand).trim() || "ALL";
  const {
    historyRows = [], oliWindows = [], catalogSnapshot = null, catalogRows = null,
    asinAdRows = [], asinMetricsRead = "ok", asinCoverageState = null, asinCoverageRead = "ok", asinWindows = [],
    campaignMappingRows = [],
  } = evidence;
  if (!isDate(from) || !isDate(to) || from > to) return { notReady: "window-invalid" };
  if (!Array.isArray(catalogRows)) return { notReady: "catalog-rows-unavailable" };

  // Readiness through the REAL contract: OLI coverage must PROVE the window + a validated Catalog snapshot must
  // exist (both block sales). ASIN Ads coverage is checked but NEVER blocks sales (its gap only withholds ads).
  const readiness = dailyReportingReadiness({
    accounts: [S(accountId)],
    oliCoverageByAccountId: { [accountId]: oliWindows },
    catalogSnapshot,
    asinAds: { grain: BRAND_VIEW_ADS_GRAIN, read: asinCoverageRead === "ok" ? "ok" : "read-failed", windowsByAccountId: { [accountId]: asinWindows } },
    from, to,
  });
  if (!readiness.ready) return { notReady: "not-ready", blockedBy: readiness.blockedBy };

  const source = slicedOliSourceFromHistory({ historyRows, accountId, rawSellerId, from, to });
  const context = { from, to, brand: wantBrand, accountId, rawSellerId, currency: currency ?? null };
  // BOTH payload modes carry ads. buildDailyAdsCoverage + resolveDailyAdsAvailability decide
  // validated/partial/stale/unavailable/failed; a failed/absent read shows sales with Ads typed unavailable.
  // A NAMED brand gets BRAND-SCOPED ad rows via the ACTIVE ads source's attribution: post-cutover the campaign grain
  // attributes each campaign row through the account's manual campaign->brand mapping (the SAME map Brand View uses);
  // pre-cutover the ASIN grain attributes via the catalog child_asin -> product_brand map. Unmapped/other-brand
  // campaigns are excluded from the named brand but still count in the account-level All-Brands total (conservation).
  // Account-level coverage windows apply unchanged: a covered window with no ad rows for this brand is an HONEST zero,
  // while missing coverage stays typed unavailable (never zero).
  const usableAdRows = asinMetricsRead === "ok" ? asinAdRows : [];
  context.adsCoverage = buildDailyAdsCoverage({
    accountId, rawSellerId, currency: currency ?? null, from, to,
    metricRows: wantBrand === "ALL" ? usableAdRows : filterActiveAdRowsToNamedBrand(usableAdRows, { catalogRows, campaignMappingRows, brand: wantBrand }),
    metricsRead: asinMetricsRead,
    coverageState: asinCoverageState || { windows: [], status: "missing", latestMetricDate: null, read: "read-failed" },
  });
  let payload;
  try {
    payload = daily.derive({
      sources: { "daily-reporting:oli-sales": source, "daily-reporting:catalog": { rows: catalogRows } },
      context,
    });
  } catch (e) {
    return { notReady: "derive-failed", error: e && e.message ? e.message : String(e) };
  }
  if (!daily.validatePayload(payload)) return { notReady: "invalid-payload" };
  // Record the campaign-mapping revision this NAMED-brand payload attributed under, so a serve can detect a stale
  // attribution (a later assign/clear) and re-derive. ALL never carries it (account totals never depend on mappings).
  if (wantBrand !== "ALL" && ACTIVE_ADS_SOURCE_KEY !== ASIN_ADS_SOURCE_KEY) {
    payload.campaignMappingRev = campaignMappingRevision(campaignMappingRows);
  }
  return { payload, version: daily.snapshotVersion, latestDataDate: daily.latestDataDate(payload) };
}

/**
 * I/O: gather one account's durable evidence for the re-derivation. Reads ONLY durable Supabase sources through
 * the injected readers (defaults are the production supabase wrappers, wired by the caller). ZERO DataDoe.
 */
export async function gatherDailyDurableEvidence({ accountId, from, to, brand = "ALL", organizationFingerprint, connectionId = "primary" }, readers) {
  const { readOliHistory, readOliCoverage, readAsinAds, readAdsCoverage, readCatalogSnapshot, loadCatalogPayload, readCampaignMappings } = readers;
  const wantBrand = S(brand).trim() || "ALL";

  const historyRows = await readOliHistory({ organizationFingerprint, connectionId, accountIds: [accountId], from, to });
  const oliCov = await readOliCoverage({ organizationFingerprint, connectionId, accountId, sourceKey: DAILY_OLI_SOURCE_KEY });
  // getSourceSnapshot returns { snapshot: <pointer>, read, error }; a plain pointer (tests / other readers) is
  // used as-is. The pointer carries object_path (payload storage) + validated_at (readiness). Reading the wrapper
  // directly (the previous bug) left catalogRows null -> every account failed "catalog-rows-unavailable".
  const catalogRead = await readCatalogSnapshot({ organizationFingerprint, connectionId, sourceKey: CATALOG_SOURCE_KEY, scopeKey: ORGANIZATION_SCOPE_KEY });
  const catalogSnapshot = catalogRead && typeof catalogRead === "object" && "snapshot" in catalogRead ? catalogRead.snapshot : catalogRead;
  const catalogReadOk = !catalogRead || typeof catalogRead !== "object" || !("read" in catalogRead) || catalogRead.read === "ok";
  let catalogRows = null;
  if (catalogReadOk && catalogSnapshot && catalogSnapshot.object_path) {
    const payload = await loadCatalogPayload(catalogSnapshot.object_path);
    catalogRows = Array.isArray(payload) ? payload : (payload && Array.isArray(payload.rows) ? payload.rows : null);
  }

  // BOTH payload modes carry ads: a named brand attributes the SAME durable ASIN rows through the catalog
  // child_asin -> product_brand mapping (rederiveDailyV2Payload brand-filters them), so the reads run for every
  // brand. `wantBrand` stays part of the gather signature/identity (the caller's scope) even though the reads
  // themselves are account-level.
  let asinAdRows = []; let asinMetricsRead = "ok"; let asinCov;
  try { asinAdRows = await readAsinAds(accountId, from, to); }
  catch (e) { asinMetricsRead = e && e.code === "ADS_ROW_LIMIT_EXCEEDED" ? "limit-exceeded" : "read-failed"; asinAdRows = []; }
  asinCov = await readAdsCoverage(accountId, BRAND_VIEW_ADS_GRAIN);

  // The account's campaign->brand mappings (post-cutover named-brand ad attribution). Read ONLY for a named brand
  // (ALL never filters by brand) and fail-soft to [] (a mapping-read failure withholds a brand's ads, never blocks
  // sales and never mis-attributes). ZERO DataDoe.
  let campaignMappingRows = [];
  if (wantBrand !== "ALL" && typeof readCampaignMappings === "function") {
    try { campaignMappingRows = await readCampaignMappings({ organizationFingerprint, connectionId, accountId }); }
    catch { campaignMappingRows = []; }
  }

  return {
    historyRows: Array.isArray(historyRows) ? historyRows : [],
    oliWindows: oliCov && oliCov.read === "ok" ? (oliCov.windows || []) : [],
    catalogSnapshot, catalogRows,
    asinAdRows, asinMetricsRead,
    asinCoverageState: asinCov,
    asinCoverageRead: asinCov && asinCov.read ? asinCov.read : "read-failed",
    asinWindows: asinCov && asinCov.read === "ok" ? (asinCov.windows || []) : [],
    campaignMappingRows: Array.isArray(campaignMappingRows) ? campaignMappingRows : [],
  };
}

// A provenance-faithful source_refreshed_at bound to the DURABLE evidence (never wall-clock): the latest of the
// covered ASIN metric date, the validated catalog timestamp, and the payload's latest sales date. This keeps the
// publishLiveSnapshotIfNewer CAS honest -- a re-derivation is "as fresh as" the evidence it recomputed from.
export function durableRefreshedAt(evidence, latestDataDate) {
  const candidates = [];
  const cov = evidence && evidence.asinCoverageState;
  if (cov && isDate(cov.latestMetricDate)) candidates.push(cov.latestMetricDate + "T00:00:00.000Z");
  if (evidence && evidence.catalogSnapshot && evidence.catalogSnapshot.validated_at) candidates.push(String(evidence.catalogSnapshot.validated_at));
  if (isDate(latestDataDate)) candidates.push(latestDataDate + "T00:00:00.000Z");
  candidates.sort();
  return candidates.length ? candidates[candidates.length - 1] : null;
}

// Gather durable evidence, optionally CLAMP the requested `to` down to the account's latest proven OLI date, then
// re-derive through the pure contract. Returns { evidence, effectiveTo, result } where result is the pure
// rederiveDailyV2Payload output. When clampToProven and `from` is not covered, result is a typed OLI not-ready.
async function gatherClampAndDerive({ accountId, rawSellerId, currency, from, to, brand, organizationFingerprint, connectionId, clampToProven }, readers) {
  const evidence = await gatherDailyDurableEvidence({ accountId, from, to, brand, organizationFingerprint, connectionId }, readers);
  let effectiveTo = to;
  if (clampToProven) {
    effectiveTo = latestProvenDailyTo({ oliWindows: evidence.oliWindows, from, ceiling: to });
    if (!effectiveTo) {
      return {
        evidence, effectiveTo: null,
        result: { notReady: "not-ready", blockedBy: [{ sourceKey: DAILY_OLI_SOURCE_KEY, reason: "coverage-incomplete", accountId: S(accountId), blocksSales: true }] },
      };
    }
  }
  const result = rederiveDailyV2Payload({ accountId, rawSellerId, currency, from, to: effectiveTo, brand }, evidence);
  return { evidence, effectiveTo, result };
}

/**
 * Gather + re-derive WITHOUT saving. For the read-path self-heal (serveSharedReport performs the save under the
 * refresh lock). Returns { payload, sourceRefreshedAt, latestDataDate, latestCompletedDate, effectiveParams } or
 * { notReady, blockedBy? }. ZERO DataDoe. When `clampToProven` is true, the payload ENDS at the account's latest
 * proven OLI date (<= the requested `to`), and effectiveParams carries the honest { from, to, brand } it covers.
 */
export async function rederiveDailyV2({ accountId, rawSellerId, currency, from, to, brand = "ALL", organizationFingerprint, connectionId = "primary", clampToProven = false }, readers) {
  const { evidence, effectiveTo, result } = await gatherClampAndDerive({ accountId, rawSellerId, currency, from, to, brand, organizationFingerprint, connectionId, clampToProven }, readers);
  if (!result.payload) return result; // { notReady, blockedBy? }
  return {
    payload: result.payload,
    latestDataDate: result.latestDataDate,
    latestCompletedDate: effectiveTo,
    effectiveParams: { from, to: effectiveTo, brand: S(brand).trim() || "ALL" },
    sourceRefreshedAt: durableRefreshedAt(evidence, result.latestDataDate) || null,
  };
}

/**
 * Full operation: gather durable evidence + re-derive v2 + hand the payload to the injected `save`. Returns a
 * typed result. `save({ payload, sourceRefreshedAt })` performs the actual persistence (the caller supplies a
 * saver bound to the exact live identity report_key=daily-reporting / params_hash for v2 + the exact params).
 * There is NO DataDoe adapter here, so a create-export cannot occur.
 */
export async function rederiveAndSaveDailyV2({ accountId, rawSellerId, currency, from, to, brand = "ALL", organizationFingerprint, connectionId = "primary", clampToProven = false }, { readers, save }) {
  const { evidence, effectiveTo, result } = await gatherClampAndDerive({ accountId, rawSellerId, currency, from, to, brand, organizationFingerprint, connectionId, clampToProven }, readers);
  if (!result.payload) return { published: false, ...result };
  const sourceRefreshedAt = durableRefreshedAt(evidence, result.latestDataDate) || null;
  const effectiveParams = { from, to: effectiveTo, brand: S(brand).trim() || "ALL" };
  const saved = await save({ payload: result.payload, sourceRefreshedAt, effectiveParams, latestCompletedDate: effectiveTo });
  return { published: true, payload: result.payload, latestDataDate: result.latestDataDate, latestCompletedDate: effectiveTo, effectiveParams, sourceRefreshedAt, saved };
}
