// Returns & Refund Leakage -- durable PUBLISH (ZERO DataDoe). Reads ONLY already-saved evidence through injected
// readers: the durable Returns + Settlement history (this report's own tables), the reused durable Order Line Items
// ordered evidence (canonical priced + explicit-zero + pending), and the org Product Catalog snapshot. NO DataDoe
// adapter is imported here, so a publish/re-derive can NEVER create an export or spend a token. The pure advanced
// math lives in returns-advanced.js; this module is the durable I/O + honest-window boundary. Mirrors
// sku-movement-durable-rederive.js.

import { createHash } from "node:crypto";
import { buildReturnsAdvancedPayload, RETURNS_GRACE_DAYS, RETURNS_ADVANCED_VERSION } from "./returns-advanced.js";
import { returnsWindow, reshapeOrderedRows } from "../sync/returns-source-refresh.js";
import { RETURNS, SETTLEMENTS, ORDER_LINE_ITEMS } from "./sources.js";
import { mergeOrderedOliHistory, buildSkuAsinResolver, resolveUniqueMarketplaceByAccount, authoritativeMarketplace } from "../sync/oli-sales-estimate.js";

const S = (v) => (v == null ? "" : String(v));
const isDate = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const OLI_SOURCE_KEY = "order-line-items";
const CATALOG_SOURCE_KEY = "product-catalog";
const ORGANIZATION_SCOPE_KEY = "__organization";
const maxDate = (rows, field) => (Array.isArray(rows) ? rows : []).reduce((m, r) => { const d = S(r && r[field]); return isDate(d) && (!m || d > m) ? d : m; }, null);
const minDate = (rows, field) => (Array.isArray(rows) ? rows : []).reduce((m, r) => { const d = S(r && r[field]); return isDate(d) && (!m || d < m) ? d : m; }, null);
const maxTs = (rows, field) => (Array.isArray(rows) ? rows : []).reduce((m, r) => { const t = r && r[field]; return t && (!m || String(t) > String(m)) ? t : m; }, null);

async function readOperationalUnits(readOliOperationalUnits, args) {
  if (typeof readOliOperationalUnits !== "function") return [];
  try { const rows = await readOliOperationalUnits({ ...args, additiveOnly: true }); return Array.isArray(rows) ? rows : []; }
  catch (_e) { return []; }
}

// The OPTIONAL Returns event-source coverage read: readers.readReturnsCoverage({ organizationFingerprint, connectionId,
// accountId }) -> the getSourceCoverageWindows shape for source_key 'returns' (the caller binds the key). It feeds
// payload.returnsCoveredThrough / returnsCoverageWindows / returnsLegacyCoveredThrough and is NEVER a failure: an absent
// reader, a throw, or anything but { read:'ok', windows:[...] } -> null (the payload is built exactly as without it). A
// legacy-only account (no 'returns' coverage row) reads ok with zero windows.
// READ ORDER: the coverage is read BEFORE the history rows. The event source writes rows + coverage in ONE transaction,
// so a load landing between the two reads can only make the rows NEWER than the coverage read first -- the coverage
// then UNDERSTATES the rows (a loaded day shows unavailable until the next derive), never the reverse (a day claimed
// covered while its rows were read before the load: a fabricated zero).
async function readReturnsCoverageSoft(readReturnsCoverage, { organizationFingerprint, connectionId, accountId }) {
  if (typeof readReturnsCoverage !== "function") return null;
  let cov;
  try { cov = await readReturnsCoverage({ organizationFingerprint, connectionId, accountId: S(accountId) }); } catch (_e) { return null; }
  return cov && typeof cov === "object" && cov.read === "ok" && Array.isArray(cov.windows) ? { read: "ok", windows: cov.windows } : null;
}

// The materializer's idempotency fingerprint (report-materialization-core.js depFingerprint): the report version + the
// PURE payload (no wall-clock field), so ANY content change -- a coverage-only day with no new return date, returned
// units, the ordered denominator, catalog names -- republishes, and an identical derive stays a zero-write replay.
export function returnsPayloadFingerprint(payload) {
  return createHash("sha256").update(JSON.stringify({ v: RETURNS_ADVANCED_VERSION, payload })).digest("hex").slice(0, 40);
}

async function buildAccountResolver({ readDirectory, readOliSkuAsinResolution }, { organizationFingerprint, connectionId, accountId }) {
  if (typeof readDirectory !== "function" || typeof readOliSkuAsinResolution !== "function") return null;
  try {
    const accounts = await readDirectory();
    const resolution = resolveUniqueMarketplaceByAccount(Array.isArray(accounts) ? accounts : []);
    const mkt = authoritativeMarketplace(resolution, accountId);
    if (!mkt) return null;
    const resRows = await readOliSkuAsinResolution({ organizationFingerprint, connectionId, accountId });
    return buildSkuAsinResolver({ accountMarketplace: mkt, historyRows: Array.isArray(resRows) ? resRows : [], catalogRows: [] });
  } catch (_e) { return null; }
}

// Gather one account's durable Returns evidence + build the advanced payload. ZERO DataDoe. Returns
// { payload, latestDataDate, sourceRefreshedAt, depFingerprint } or { notReady }. readers.readReturnsCoverage is
// OPTIONAL (readReturnsCoverageSoft above).
export async function gatherReturnsEvidence({ accountId, organizationFingerprint, connectionId = "primary", asOf, graceDays = RETURNS_GRACE_DAYS }, readers) {
  const {
    readReturnsHistory, readSettlementHistory, readOliHistory, readOliCoverage, readOliOperationalUnits,
    readCatalogSnapshot, loadCatalogPayload, readOliSkuAsinResolution, readDirectory, readReturnsCoverage,
  } = readers;
  if (!isDate(asOf)) return { notReady: "invalid-asof" };
  const win = returnsWindow(asOf);
  const from = win.from;
  const acctIds = [S(accountId)];

  // The OPTIONAL 'returns' coverage FIRST (see READ ORDER above): it may only understate the rows read after it.
  const returnsCoverage = await readReturnsCoverageSoft(readReturnsCoverage, { organizationFingerprint, connectionId, accountId });
  const durableReturnRows = await readReturnsHistory({ organizationFingerprint, connectionId, accountIds: acctIds, from, to: asOf });
  const durableSettlementRows = await readSettlementHistory({ organizationFingerprint, connectionId, accountIds: acctIds, from, to: asOf });

  // ORDERED denominator: the reused durable OLI, folded with the canonical priced + explicit-zero + pending rule.
  let orderedRows = [];
  try {
    const pricedRows = await readOliHistory({ organizationFingerprint, connectionId, accountIds: acctIds, from, to: asOf });
    const operationalRows = await readOperationalUnits(readOliOperationalUnits, { organizationFingerprint, connectionId, accountIds: acctIds, from, to: asOf });
    const resolver = await buildAccountResolver({ readDirectory, readOliSkuAsinResolution }, { organizationFingerprint, connectionId, accountId });
    const merged = mergeOrderedOliHistory({ historyRows: Array.isArray(pricedRows) ? pricedRows : [], operationalRows, estimateRows: [], skuAsinResolver: resolver });
    orderedRows = reshapeOrderedRows(merged);
  } catch (_e) { orderedRows = []; }

  // Catalog (org snapshot) for product name + brand.
  let catalogRows = [];
  let catalogSnapshot = null;
  try {
    const catRead = await readCatalogSnapshot({ organizationFingerprint, connectionId, sourceKey: CATALOG_SOURCE_KEY, scopeKey: ORGANIZATION_SCOPE_KEY });
    catalogSnapshot = catRead && typeof catRead === "object" && "snapshot" in catRead ? catRead.snapshot : catRead;
    const ok = !catRead || typeof catRead !== "object" || !("read" in catRead) || catRead.read === "ok";
    if (ok && catalogSnapshot && catalogSnapshot.object_path && typeof loadCatalogPayload === "function") {
      const payload = await loadCatalogPayload(catalogSnapshot.object_path);
      catalogRows = Array.isArray(payload) ? payload : (payload && Array.isArray(payload.rows) ? payload.rows : []);
    }
  } catch (_e) { catalogRows = []; }

  const returnsRefreshedAt = maxTs(durableReturnRows, "refreshed_at");
  const settlementsRefreshedAt = maxTs(durableSettlementRows, "refreshed_at");
  const payload = buildReturnsAdvancedPayload({
    accountId: S(accountId), asOf, from, windowDays: 60, graceDays,
    returnsSourceLabel: RETURNS.label, moneySourceLabel: SETTLEMENTS.label, rateSourceLabel: ORDER_LINE_ITEMS.label,
    rateSourceLagDays: ORDER_LINE_ITEMS.lagDays ?? 0, returnHistoryDays: RETURNS.historyDays ?? 60,
    durableReturnRows, durableSettlementRows, orderedRows, catalogRows,
    returnsRefreshedAt, settlementsRefreshedAt,
    returnsCoveredFrom: minDate(durableReturnRows, "return_date"), returnsCoveredTo: maxDate(durableReturnRows, "return_date"),
    settlementsCoveredFrom: minDate(durableSettlementRows, "settlement_date"), settlementsCoveredTo: maxDate(durableSettlementRows, "settlement_date"),
    returnsCoverage,
  });

  // A provenance-faithful source_refreshed_at (never wall-clock): the freshest of the source refresh stamps + the
  // catalog validated_at + the latest observed data date -- so the publish CAS never lets a staler snapshot win.
  const cands = [returnsRefreshedAt, settlementsRefreshedAt, catalogSnapshot && catalogSnapshot.validated_at,
    isDate(payload.latestDataDate) ? payload.latestDataDate + "T00:00:00.000Z" : null].filter(Boolean).map(String).sort();
  const sourceRefreshedAt = cands.length ? cands[cands.length - 1] : null;
  return { payload, latestDataDate: payload.latestDataDate, sourceRefreshedAt, depFingerprint: returnsPayloadFingerprint(payload) };
}

// Factory: build the operator's `publishAccount({ account, asOf })` from durable readers + an injected saveSnapshot.
// saveSnapshot({ reportKey, accountId, connectionId, organizationFingerprint, payload, latestDataDate, sourceRefreshedAt, asOf })
// -> { published: boolean, outcome }.
export function buildReturnsPublishAccount({ readers, saveSnapshot, graceDays = RETURNS_GRACE_DAYS }) {
  return async function publishAccount({ account, asOf }) {
    const accountId = S(account.accountId).trim();
    const organizationFingerprint = account.organizationFingerprint;
    const connectionId = account.connectionId || "primary";
    const ev = await gatherReturnsEvidence({ accountId, organizationFingerprint, connectionId, asOf, graceDays }, readers);
    if (ev.notReady) return { published: false, outcome: ev.notReady };
    const saved = await saveSnapshot({
      reportKey: "returns-leakage", accountId, connectionId, organizationFingerprint,
      payload: ev.payload, latestDataDate: ev.latestDataDate, sourceRefreshedAt: ev.sourceRefreshedAt, asOf,
    });
    return { published: !!(saved && saved.published), outcome: saved && saved.outcome, latestDataDate: ev.latestDataDate };
  };
}
