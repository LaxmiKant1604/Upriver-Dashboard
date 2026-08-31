// SKU MOVEMENT -- the ZERO-EXPORT durable re-derivation. Reads ONLY already-saved evidence through injected readers
// (defaults are the production Supabase wrappers, wired by the caller): the account's Order Line Items daily rollup
// (source_oli_daily_history) + coverage windows + the org Product Catalog snapshot. NO DataDoe adapter is ever
// imported here, so a derive/serve/reload/account-change/brand-change CAN NOT create an export or spend a token.
// The pure movement math + windows live in sku-movement-core.js; this module is the I/O + honest-date boundary.

import { monthBackStr } from "../date-windows.js";
import { skuMovementPayload } from "./sku-movement-core.js";
import { mergeOrderedOliHistory, buildSkuAsinResolver, resolveUniqueMarketplaceByAccount, authoritativeMarketplace } from "../sync/oli-sales-estimate.js";

const S = (v) => (v == null ? "" : String(v));
const isDate = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const OLI_SOURCE_KEY = "order-line-items";
const CATALOG_SOURCE_KEY = "product-catalog";
const ORGANIZATION_SCOPE_KEY = "__organization";

// PURE: from an account's durable OLI coverage windows, resolve the honest effectiveAsOf (the LATEST proven OLI date,
// capped at `ceiling` = D-1) + the earliest covered date (coverageFrom, so a completed month entirely before it is
// UNAVAILABLE, never a fabricated 0). Never invents D-1: if coverage proves only an earlier date, THAT is effectiveAsOf.
export function skuMovementProvenDates(oliWindows, ceiling) {
  // getSourceCoverageWindows yields { from, to } (mapped from covered_from/covered_to); accept the raw column names too.
  const wFrom = (w) => S(w && (w.from ?? w.covered_from ?? w.coveredFrom));
  const wTo = (w) => S(w && (w.to ?? w.covered_to ?? w.coveredTo));
  const wins = (Array.isArray(oliWindows) ? oliWindows : []).filter((w) => w && isDate(wFrom(w)) && isDate(wTo(w)));
  if (!wins.length || !isDate(ceiling)) return { effectiveAsOf: null, coverageFrom: null };
  const froms = wins.map(wFrom);
  const tos = wins.map(wTo);
  const maxTo = tos.reduce((m, t) => (t > m ? t : m), tos[0]);
  const minFrom = froms.reduce((m, f) => (f < m ? f : m), froms[0]);
  const effectiveAsOf = maxTo < ceiling ? maxTo : ceiling; // cap at D-1; honest earlier date if that is all that is proven
  return { effectiveAsOf, coverageFrom: minFrom };
}

// Read the raw operational units (all classes) for the window. Advisory + fail-soft: a missing reader or a read
// error yields [] (the report degrades to the priced series). The canonical mergeOrderedOliHistory folds their
// explicit-zero + pending classes into ordered units (resolving a blank ASIN) alongside the priced rollup.
async function readOperationalUnits(readOliOperationalUnits, { organizationFingerprint, connectionId, accountId, from, to }) {
  if (typeof readOliOperationalUnits !== "function") return [];
  try {
    const rows = await readOliOperationalUnits({ organizationFingerprint, connectionId, accountIds: [S(accountId)], from, to, additiveOnly: true });
    return Array.isArray(rows) ? rows : [];
  } catch (_e) {
    return [];
  }
}

// Build the account-scoped SKU->ASIN resolver (same server-side resolver the estimator + Brand View use) so a
// pending unit's blank child_asin resolves to its unique ASIN -- SO SKU Movement's named-brand attribution matches
// Brand View exactly (no divergence). Fail-soft: no directory/resolution reader, unknown marketplace, or a read
// error -> a null resolver (blank-ASIN pending units stay under their SKU as Unmapped, exactly as before).
async function buildAccountResolver({ readDirectory, readOliSkuAsinResolution }, { organizationFingerprint, connectionId, accountId }) {
  if (typeof readDirectory !== "function" || typeof readOliSkuAsinResolution !== "function") return null;
  try {
    const accounts = await readDirectory();
    const resolution = resolveUniqueMarketplaceByAccount(Array.isArray(accounts) ? accounts : []);
    const mkt = authoritativeMarketplace(resolution, accountId);
    if (!mkt) return null;
    const resRows = await readOliSkuAsinResolution({ organizationFingerprint, connectionId, accountId });
    return buildSkuAsinResolver({ accountMarketplace: mkt, historyRows: Array.isArray(resRows) ? resRows : [], catalogRows: [] });
  } catch (_e) {
    return null;
  }
}

// I/O: gather one account's durable evidence (ZERO DataDoe). `ceiling` = the server-resolved D-1 (previous UTC day).
export async function gatherSkuMovementEvidence({ accountId, organizationFingerprint, connectionId = "primary", ceiling }, readers) {
  const { readOliHistory, readOliCoverage, readCatalogSnapshot, loadCatalogPayload, readOliOperationalUnits, readOliSkuAsinResolution, readDirectory } = readers;
  const cov = await readOliCoverage({ organizationFingerprint, connectionId, accountId, sourceKey: OLI_SOURCE_KEY });
  const oliWindows = cov && cov.read === "ok" ? (cov.windows || []) : [];
  const { effectiveAsOf, coverageFrom } = skuMovementProvenDates(oliWindows, ceiling);
  if (!effectiveAsOf) {
    return { notReady: "not-ready", blockedBy: [{ sourceKey: OLI_SOURCE_KEY, reason: "coverage-incomplete", accountId: S(accountId), blocksSales: true }] };
  }
  // The three completed months + MTD + the last-10 days all live within [start of the -3 month, effectiveAsOf].
  const from = monthBackStr(effectiveAsOf, 3);
  const pricedRows = await readOliHistory({ organizationFingerprint, connectionId, accountIds: [S(accountId)], from, to: effectiveAsOf });
  // ORDERED UNITS: add the units the PRICED rollup deliberately excludes -- explicit-zero (value===0) and pending
  // (null price) units -- through the ONE canonical mergeOrderedOliHistory (the SAME seam Daily + Brand View use),
  // resolving a blank ASIN to its unique ASIN so attribution matches Brand View and can NEVER diverge. estimateRows
  // is [] (SKU Movement is units-only: no estimated dollars), so priced sales stay byte-identical; units become
  // ordered (priced + explicit-zero + pending). A SKU-less unit is dropped downstream by skuMovementRows.
  const operationalRows = await readOperationalUnits(readOliOperationalUnits, { organizationFingerprint, connectionId, accountId, from, to: effectiveAsOf });
  const resolver = await buildAccountResolver({ readDirectory, readOliSkuAsinResolution }, { organizationFingerprint, connectionId, accountId });
  const historyRows = mergeOrderedOliHistory({ historyRows: Array.isArray(pricedRows) ? pricedRows : [], operationalRows, estimateRows: [], skuAsinResolver: resolver });
  const catRead = await readCatalogSnapshot({ organizationFingerprint, connectionId, sourceKey: CATALOG_SOURCE_KEY, scopeKey: ORGANIZATION_SCOPE_KEY });
  const catalogSnapshot = catRead && typeof catRead === "object" && "snapshot" in catRead ? catRead.snapshot : catRead;
  const catalogReadOk = !catRead || typeof catRead !== "object" || !("read" in catRead) || catRead.read === "ok";
  let catalogRows = [];
  if (catalogReadOk && catalogSnapshot && catalogSnapshot.object_path) {
    const payload = await loadCatalogPayload(catalogSnapshot.object_path);
    catalogRows = Array.isArray(payload) ? payload : (payload && Array.isArray(payload.rows) ? payload.rows : []);
  }
  return { effectiveAsOf, coverageFrom, from, historyRows: Array.isArray(historyRows) ? historyRows : [], catalogRows, catalogSnapshot };
}

// A provenance-faithful source_refreshed_at (never wall-clock): the latest of the catalog validated_at + the
// effectiveAsOf date -- so the publish CAS is "as fresh as" the evidence, and a stale D-2 snapshot never overwrites.
export function skuMovementRefreshedAt(evidence) {
  const cands = [];
  if (evidence && evidence.catalogSnapshot && evidence.catalogSnapshot.validated_at) cands.push(String(evidence.catalogSnapshot.validated_at));
  if (evidence && isDate(evidence.effectiveAsOf)) cands.push(evidence.effectiveAsOf + "T00:00:00.000Z");
  cands.sort();
  return cands.length ? cands[cands.length - 1] : null;
}

// Gather + re-derive WITHOUT saving (the read-path self-heal saves under the refresh lock, mirroring the daily flow).
// Returns { payload, latestDataDate, latestCompletedDate, effectiveParams: { asOf, brand }, sourceRefreshedAt } or
// { notReady, blockedBy? }. ZERO DataDoe. The snapshot identity is (account, brand, effectiveAsOf, report version).
export async function rederiveSkuMovement({ accountId, brand = "ALL", organizationFingerprint, connectionId = "primary", ceiling }, readers) {
  const ev = await gatherSkuMovementEvidence({ accountId, organizationFingerprint, connectionId, ceiling }, readers);
  if (ev.notReady) return ev;
  const payload = skuMovementPayload({ oliRows: ev.historyRows, catalogRows: ev.catalogRows, effectiveAsOf: ev.effectiveAsOf, brand, coverageFrom: ev.coverageFrom, accountId });
  return {
    payload,
    latestDataDate: ev.effectiveAsOf,
    latestCompletedDate: ev.effectiveAsOf,
    effectiveParams: { asOf: ev.effectiveAsOf, brand: S(brand).trim() || "ALL" },
    sourceRefreshedAt: skuMovementRefreshedAt(ev),
  };
}
