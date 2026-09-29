// SKU MOVEMENT -- the ZERO-EXPORT durable re-derivation. Reads ONLY already-saved evidence through injected readers
// (defaults are the production Supabase wrappers, wired by the caller): the account's Order Line Items daily rollup
// (source_oli_daily_history) + coverage windows + the org Product Catalog snapshot. NO DataDoe adapter is ever
// imported here, so a derive/serve/reload/account-change/brand-change CAN NOT create an export or spend a token.
// The pure movement math + windows live in sku-movement-core.js; this module is the I/O + honest-date boundary.
//
// STRICT MODE (publication recovery WP6; opt-in { strict: true }, default OFF -> the serve / materializer / backfill
// output is BYTE-IDENTICAL): the fail-soft reads below degrade a failed optional read to an empty input (the report then
// renders a brandless ALL, an empty named brand, or priced-only units). That is acceptable for a read-only serve, but a
// PUBLISHER must never promote it over a last-known-good row (C8). In strict mode every durable read that fails --
// coverage read != 'ok', an OLI history throw, an operational-units throw (or a missing reader), a SKU->ASIN resolver
// failure (a missing reader, a throw, or an account whose marketplace is not uniquely proven), a catalog read != 'ok'
// or a payload-load failure -- returns a TYPED notReady 'evidence-read-failed:<coverage|oli|opunits|resolver|catalog>',
// an ABSENT org catalog pointer returns notReady 'catalog-missing', and a catalog payload that hydrates to ZERO rows
// returns notReady 'catalog-empty' (it would render an all-'Unmapped' ALL and 0-row named brands over the last-known-
// good). Never a guess, never a fabricated zero.
//
// The account's evidence is loaded ONCE and shared by every brand unit (loadSkuMovementAccountEvidence, memoisable by
// the caller) and each (account, brand) payload is built from it by the pure buildSkuMovementUnit.

import { monthBackStr } from "../date-windows.js";
import { skuMovementPayload } from "./sku-movement-core.js";
import { mergeOrderedOliHistory, buildSkuAsinResolver, resolveUniqueMarketplaceByAccount, authoritativeMarketplace } from "../sync/oli-sales-estimate.js";

const S = (v) => (v == null ? "" : String(v));
const isDate = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const OLI_SOURCE_KEY = "order-line-items";
const CATALOG_SOURCE_KEY = "product-catalog";
const ORGANIZATION_SCOPE_KEY = "__organization";
const OPUNITS_SOURCE_KEY = "oli-operational-units";
const RESOLVER_SOURCE_KEY = "oli-sku-asin-resolution";

// The typed strict-mode notReady reasons (the part after 'evidence-read-failed:' names the durable source that failed).
export const SKU_EVIDENCE_READ_FAILED = "evidence-read-failed";
export const SKU_CATALOG_MISSING = "catalog-missing";
export const SKU_CATALOG_EMPTY = "catalog-empty";
const readFailed = (source, sourceKey, accountId) => ({
  notReady: SKU_EVIDENCE_READ_FAILED + ":" + source,
  blockedBy: [{ sourceKey, reason: SKU_EVIDENCE_READ_FAILED, accountId: S(accountId), blocksSales: true }],
});

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
// STRICT: a missing reader, a throw or a non-array result is { failed:true } (the caller returns the typed notReady).
async function readOperationalUnits(readOliOperationalUnits, { organizationFingerprint, connectionId, accountId, from, to }, strict = false) {
  if (typeof readOliOperationalUnits !== "function") return strict ? { failed: true } : [];
  try {
    const rows = await readOliOperationalUnits({ organizationFingerprint, connectionId, accountIds: [S(accountId)], from, to, additiveOnly: true });
    if (strict && !Array.isArray(rows)) return { failed: true };
    return Array.isArray(rows) ? rows : [];
  } catch (_e) {
    return strict ? { failed: true } : [];
  }
}

// Build the account-scoped SKU->ASIN resolver (same server-side resolver the estimator + Brand View use) so a
// pending unit's blank child_asin resolves to its unique ASIN -- SO SKU Movement's named-brand attribution matches
// Brand View exactly (no divergence). Fail-soft: no directory/resolution reader, unknown marketplace, or a read
// error -> a null resolver (blank-ASIN pending units stay under their SKU as Unmapped, exactly as before).
// STRICT: every one of those fail-soft branches is { failed:true } instead (never a silently-degraded attribution).
async function buildAccountResolver({ readDirectory, readOliSkuAsinResolution }, { organizationFingerprint, connectionId, accountId }, strict = false) {
  const soft = () => (strict ? { failed: true } : null);
  if (typeof readDirectory !== "function" || typeof readOliSkuAsinResolution !== "function") return soft();
  try {
    const accounts = await readDirectory();
    const resolution = resolveUniqueMarketplaceByAccount(Array.isArray(accounts) ? accounts : []);
    const mkt = authoritativeMarketplace(resolution, accountId);
    if (!mkt) return soft();
    const resRows = await readOliSkuAsinResolution({ organizationFingerprint, connectionId, accountId });
    if (strict && !Array.isArray(resRows)) return { failed: true };
    return buildSkuAsinResolver({ accountMarketplace: mkt, historyRows: Array.isArray(resRows) ? resRows : [], catalogRows: [] });
  } catch (_e) {
    return soft();
  }
}

// The shared gather core. NON-strict is the original body statement-for-statement (same reads, same arguments, same
// order, same exceptions propagating); strict adds only the typed fail-closed branches. Returns { ev, oliWindows }.
async function gatherCore({ accountId, organizationFingerprint, connectionId = "primary", ceiling }, readers, strict) {
  const { readOliHistory, readOliCoverage, readCatalogSnapshot, loadCatalogPayload, readOliOperationalUnits, readOliSkuAsinResolution, readDirectory } = readers;
  let cov;
  if (strict) {
    try { cov = await readOliCoverage({ organizationFingerprint, connectionId, accountId, sourceKey: OLI_SOURCE_KEY }); }
    catch (_e) { return { ev: readFailed("coverage", OLI_SOURCE_KEY, accountId) }; }
    if (!cov || cov.read !== "ok") return { ev: readFailed("coverage", OLI_SOURCE_KEY, accountId) };
  } else {
    cov = await readOliCoverage({ organizationFingerprint, connectionId, accountId, sourceKey: OLI_SOURCE_KEY });
  }
  const oliWindows = cov && cov.read === "ok" ? (cov.windows || []) : [];
  const { effectiveAsOf, coverageFrom } = skuMovementProvenDates(oliWindows, ceiling);
  if (!effectiveAsOf) {
    return { ev: { notReady: "not-ready", blockedBy: [{ sourceKey: OLI_SOURCE_KEY, reason: "coverage-incomplete", accountId: S(accountId), blocksSales: true }] }, oliWindows };
  }
  // The three completed months + MTD + the last-10 days all live within [start of the -3 month, effectiveAsOf].
  const from = monthBackStr(effectiveAsOf, 3);
  let pricedRows;
  if (strict) {
    try { pricedRows = await readOliHistory({ organizationFingerprint, connectionId, accountIds: [S(accountId)], from, to: effectiveAsOf }); }
    catch (_e) { return { ev: readFailed("oli", OLI_SOURCE_KEY, accountId), oliWindows }; }
    if (!Array.isArray(pricedRows)) return { ev: readFailed("oli", OLI_SOURCE_KEY, accountId), oliWindows };
  } else {
    pricedRows = await readOliHistory({ organizationFingerprint, connectionId, accountIds: [S(accountId)], from, to: effectiveAsOf });
  }
  // ORDERED UNITS: add the units the PRICED rollup deliberately excludes -- explicit-zero (value===0) and pending
  // (null price) units -- through the ONE canonical mergeOrderedOliHistory (the SAME seam Daily + Brand View use),
  // resolving a blank ASIN to its unique ASIN so attribution matches Brand View and can NEVER diverge. estimateRows
  // is [] (SKU Movement is units-only: no estimated dollars), so priced sales stay byte-identical; units become
  // ordered (priced + explicit-zero + pending). A SKU-less unit is dropped downstream by skuMovementRows.
  const operationalRows = await readOperationalUnits(readOliOperationalUnits, { organizationFingerprint, connectionId, accountId, from, to: effectiveAsOf }, strict);
  if (strict && operationalRows && operationalRows.failed === true) return { ev: readFailed("opunits", OPUNITS_SOURCE_KEY, accountId), oliWindows };
  const resolver = await buildAccountResolver({ readDirectory, readOliSkuAsinResolution }, { organizationFingerprint, connectionId, accountId }, strict);
  if (strict && resolver && resolver.failed === true) return { ev: readFailed("resolver", RESOLVER_SOURCE_KEY, accountId), oliWindows };
  const historyRows = mergeOrderedOliHistory({ historyRows: Array.isArray(pricedRows) ? pricedRows : [], operationalRows, estimateRows: [], skuAsinResolver: resolver });
  let catRead;
  if (strict) {
    try { catRead = await readCatalogSnapshot({ organizationFingerprint, connectionId, sourceKey: CATALOG_SOURCE_KEY, scopeKey: ORGANIZATION_SCOPE_KEY }); }
    catch (_e) { return { ev: readFailed("catalog", CATALOG_SOURCE_KEY, accountId), oliWindows }; }
  } else {
    catRead = await readCatalogSnapshot({ organizationFingerprint, connectionId, sourceKey: CATALOG_SOURCE_KEY, scopeKey: ORGANIZATION_SCOPE_KEY });
  }
  const catalogSnapshot = catRead && typeof catRead === "object" && "snapshot" in catRead ? catRead.snapshot : catRead;
  const catalogReadOk = !catRead || typeof catRead !== "object" || !("read" in catRead) || catRead.read === "ok";
  let catalogRows = [];
  if (strict) {
    // C8: a catalog that could not be read (or whose payload cannot be loaded) never yields a brandless ALL / an empty
    // named brand; an ABSENT org catalog pointer is its own typed reason.
    if (!catRead || typeof catRead !== "object" || !catalogReadOk) return { ev: readFailed("catalog", CATALOG_SOURCE_KEY, accountId), oliWindows };
    if (!catalogSnapshot || !catalogSnapshot.object_path) {
      return { ev: { notReady: SKU_CATALOG_MISSING, blockedBy: [{ sourceKey: CATALOG_SOURCE_KEY, reason: SKU_CATALOG_MISSING, accountId: S(accountId), blocksSales: true }] }, oliWindows };
    }
    let payload;
    try { payload = await loadCatalogPayload(catalogSnapshot.object_path); }
    catch (_e) { return { ev: readFailed("catalog", CATALOG_SOURCE_KEY, accountId), oliWindows }; }
    if (!Array.isArray(payload) && !(payload && Array.isArray(payload.rows))) return { ev: readFailed("catalog", CATALOG_SOURCE_KEY, accountId), oliWindows };
    catalogRows = Array.isArray(payload) ? payload : payload.rows;
    // A catalog that hydrates to ZERO rows attributes nothing: a publisher must never promote the resulting all-
    // 'Unmapped' ALL / 0-row named payloads over the last-known-good (typed; retried once the catalog carries rows).
    if (catalogRows.length === 0) {
      return { ev: { notReady: SKU_CATALOG_EMPTY, blockedBy: [{ sourceKey: CATALOG_SOURCE_KEY, reason: SKU_CATALOG_EMPTY, accountId: S(accountId), blocksSales: true }] }, oliWindows };
    }
  } else if (catalogReadOk && catalogSnapshot && catalogSnapshot.object_path) {
    const payload = await loadCatalogPayload(catalogSnapshot.object_path);
    catalogRows = Array.isArray(payload) ? payload : (payload && Array.isArray(payload.rows) ? payload.rows : []);
  }
  return { ev: { effectiveAsOf, coverageFrom, from, historyRows: Array.isArray(historyRows) ? historyRows : [], catalogRows, catalogSnapshot }, oliWindows };
}

// I/O: gather one account's durable evidence (ZERO DataDoe). `ceiling` = the server-resolved D-1 (previous UTC day).
// { strict } (default false = the original fail-soft behaviour, byte-identical): see STRICT MODE above.
export async function gatherSkuMovementEvidence({ accountId, organizationFingerprint, connectionId = "primary", ceiling }, readers, { strict = false } = {}) {
  const { ev } = await gatherCore({ accountId, organizationFingerprint, connectionId, ceiling }, readers, strict === true);
  return ev;
}

/**
 * The ONE per-account evidence load shared by the ALL unit and every named-brand unit (the caller memoises it per
 * account; the history + catalog are read once, never once per brand). The gathered evidence (exactly
 * gatherSkuMovementEvidence's) plus accountId, the ceiling it was resolved at, and the OLI coverage windows it read
 * (the serve-token digest input). A notReady result is returned as-is.
 */
export async function loadSkuMovementAccountEvidence({ accountId, organizationFingerprint, connectionId = "primary", ceiling }, readers, { strict = false } = {}) {
  const { ev, oliWindows } = await gatherCore({ accountId, organizationFingerprint, connectionId, ceiling }, readers, strict === true);
  if (ev.notReady) return ev;
  return { ...ev, accountId: S(accountId), ceiling, coverageWindows: Array.isArray(oliWindows) ? oliWindows.slice() : [] };
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

/**
 * PURE: build ONE (account, brand) unit from an account's gathered evidence -- the payload + its honest dates +
 * the canonical { asOf, brand } identity + the provenance stamp. `accountId` defaults to evidence.accountId (set by
 * loadSkuMovementAccountEvidence). The SAME tail rederiveSkuMovement always had.
 */
export function buildSkuMovementUnit(evidence, brand = "ALL", { accountId = evidence && evidence.accountId } = {}) {
  const ev = evidence;
  const payload = skuMovementPayload({ oliRows: ev.historyRows, catalogRows: ev.catalogRows, effectiveAsOf: ev.effectiveAsOf, brand, coverageFrom: ev.coverageFrom, accountId });
  return {
    payload,
    latestDataDate: ev.effectiveAsOf,
    latestCompletedDate: ev.effectiveAsOf,
    effectiveParams: { asOf: ev.effectiveAsOf, brand: S(brand).trim() || "ALL" },
    sourceRefreshedAt: skuMovementRefreshedAt(ev),
  };
}

// Gather + re-derive WITHOUT saving (the read-path self-heal saves under the refresh lock, mirroring the daily flow).
// Returns { payload, latestDataDate, latestCompletedDate, effectiveParams: { asOf, brand }, sourceRefreshedAt } or
// { notReady, blockedBy? }. ZERO DataDoe. The snapshot identity is (account, brand, effectiveAsOf, report version).
// { strict } (default false = byte-identical): see STRICT MODE above.
export async function rederiveSkuMovement({ accountId, brand = "ALL", organizationFingerprint, connectionId = "primary", ceiling }, readers, { strict = false } = {}) {
  const ev = await gatherSkuMovementEvidence({ accountId, organizationFingerprint, connectionId, ceiling }, readers, { strict });
  if (ev.notReady) return ev;
  return buildSkuMovementUnit(ev, brand, { accountId });
}
