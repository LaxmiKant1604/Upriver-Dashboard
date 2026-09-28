// Returns & Refund Leakage -- durable PUBLISH (ZERO DataDoe). Reads ONLY already-saved evidence through injected
// readers: the durable Returns + Settlement history (this report's own tables), the reused durable Order Line Items
// ordered evidence (canonical priced + explicit-zero + pending), and the org Product Catalog snapshot. NO DataDoe
// adapter is imported here, so a publish/re-derive can NEVER create an export or spend a token. The pure advanced
// math lives in returns-advanced.js; this module is the durable I/O + honest-window boundary. Mirrors
// sku-movement-durable-rederive.js.

import { buildReturnsAdvancedPayload, RETURNS_GRACE_DAYS } from "./returns-advanced.js";
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

// STRICT evidence collection for the zero-export returns-v3 recovery ROUTE (publication recovery WP5). The serve's
// fail-soft reads (a thrown OLI / operational-unit / resolver / catalog read degrades to [] / null and still builds a
// payload) are right for a read-only page, but a PUBLISHED snapshot built that way would be a fabricated-zero rate or a
// brandless catalog. In strict mode every such read either succeeds with well-formed rows or the account is NOT READY
// with a typed reason (the route defers, LKG preserved, never an empty / zero payload):
//   evidence-read-failed:<returns|settlement|oli|opunits|resolver|catalog>  -- a reader threw / is absent / returned a
//                                                                             malformed value (the resolver also when
//                                                                             the account marketplace is not uniquely
//                                                                             proven -- no SKU->ASIN fold is possible);
//   evidence-inconsistent:<returns|settlement>-duplicate -- the paged REST read returned the SAME primary-key tuple
//                               twice (an offset page boundary over a non-total order duplicates one row and skips
//                               another while the row COUNT still matches); with the count already equal to the SQL
//                               count(*) the token bound, "no duplicate key" is what proves the EXACT row set;
//   returns-evidence-missing -- neither a Returns nor a Settlement row in the window (nothing proves the account was
//                               ever acquired), or no dated evidence to bind the { to } identity;
//   catalog-missing          -- the org catalog pointer read is not 'ok', the pointer / its object path is absent, or
//                               the validated snapshot holds ZERO rows (a brandless payload is never published);
//   oli-coverage-short       -- the proven OLI coverage (max covered_to over the succeeded windows OVERLAPPING
//                               [from, asOf] -- exactly the route's L1 'oli' SELECT) ends before min(asOf,
//                               latestDataDate): the ordered denominator would be truncated.
// A strict success ALSO returns `evidence` = the exact hydrated rows the payload was built from (+ the catalog pointer
// sha and the proven OLI covered_to) so the route can digest them into its manifest token. strict=false (the default:
// the serve, the materializer, buildReturnsPublishAccount) is BYTE-IDENTICAL to the pre-WP5 function.
const notReadyStrict = (reason) => ({ notReady: reason });

// The durable PRIMARY KEY columns each REST reader returns (migration 20260914 source_returns_hist_pk /
// source_settle_hist_pk minus organization_fingerprint + connection_id, which the reads pin with eq filters and do not
// select). scripts/returns-history-reader-order.test.js derives them from the DDL statically.
export const RETURNS_HISTORY_KEY_COLUMNS = Object.freeze(["account_id", "return_date", "sku", "child_asin", "amazon_return_reason", "fulfillment_channel", "request_status", "label_payer"]);
export const SETTLEMENT_HISTORY_KEY_COLUMNS = Object.freeze(["account_id", "settlement_date", "sku", "child_asin", "currency", "settlement_type"]);
/** How many rows repeat an earlier row's key tuple over `columns` (PURE; 0 = every key distinct). */
export function duplicateKeyCount(rows, columns) {
  const seen = new Set();
  let dups = 0;
  for (const r of Array.isArray(rows) ? rows : []) {
    const k = JSON.stringify(columns.map((c) => S(r && r[c])));
    if (seen.has(k)) dups += 1; else seen.add(k);
  }
  return dups;
}
async function strictRead(fn, args, tag) {
  if (typeof fn !== "function") return { failed: notReadyStrict("evidence-read-failed:" + tag) };
  let rows;
  try { rows = await fn(args); } catch (_e) { return { failed: notReadyStrict("evidence-read-failed:" + tag) }; }
  return Array.isArray(rows) ? { rows } : { failed: notReadyStrict("evidence-read-failed:" + tag) };
}
async function strictResolver({ readDirectory, readOliSkuAsinResolution }, { organizationFingerprint, connectionId, accountId }) {
  const fail = { failed: notReadyStrict("evidence-read-failed:resolver") };
  if (typeof readDirectory !== "function" || typeof readOliSkuAsinResolution !== "function") return fail;
  let accounts;
  try { accounts = await readDirectory(); } catch (_e) { return fail; }
  const mkt = authoritativeMarketplace(resolveUniqueMarketplaceByAccount(Array.isArray(accounts) ? accounts : []), accountId);
  if (!mkt) return fail;
  let resRows;
  try { resRows = await readOliSkuAsinResolution({ organizationFingerprint, connectionId, accountId }); } catch (_e) { return fail; }
  if (!Array.isArray(resRows)) return fail;
  return { resolver: buildSkuAsinResolver({ accountMarketplace: mkt, historyRows: resRows, catalogRows: [] }) };
}
async function strictCatalog({ readCatalogSnapshot, loadCatalogPayload }, { organizationFingerprint, connectionId }) {
  let catRead;
  if (typeof readCatalogSnapshot !== "function") return { failed: notReadyStrict("evidence-read-failed:catalog") };
  try { catRead = await readCatalogSnapshot({ organizationFingerprint, connectionId, sourceKey: CATALOG_SOURCE_KEY, scopeKey: ORGANIZATION_SCOPE_KEY }); }
  catch (_e) { return { failed: notReadyStrict("evidence-read-failed:catalog") }; }
  if (!catRead || typeof catRead !== "object") return { failed: notReadyStrict("catalog-missing") };
  if ("read" in catRead && catRead.read !== "ok") return { failed: notReadyStrict("catalog-missing") };
  const snapshot = "snapshot" in catRead ? catRead.snapshot : catRead;
  if (!snapshot || typeof snapshot !== "object" || !S(snapshot.object_path).trim()) return { failed: notReadyStrict("catalog-missing") };
  if (typeof loadCatalogPayload !== "function") return { failed: notReadyStrict("evidence-read-failed:catalog") };
  let payload;
  try { payload = await loadCatalogPayload(snapshot.object_path); } catch (_e) { return { failed: notReadyStrict("evidence-read-failed:catalog") }; }
  const rows = Array.isArray(payload) ? payload : (payload && Array.isArray(payload.rows) ? payload.rows : null);
  if (!rows) return { failed: notReadyStrict("evidence-read-failed:catalog") };
  // A validated-but-EMPTY catalog carries no product name / brand for any ASIN: publishing from it would be the same
  // brandless payload a failed read gives, so it is no catalog proof at all.
  if (rows.length === 0) return { failed: notReadyStrict("catalog-missing") };
  return { snapshot, rows };
}

// Gather one account's durable Returns evidence + build the advanced payload. ZERO DataDoe. Returns
// { payload, latestDataDate, sourceRefreshedAt } or { notReady }. `options.strict` (default false) -- see above.
export async function gatherReturnsEvidence({ accountId, organizationFingerprint, connectionId = "primary", asOf, graceDays = RETURNS_GRACE_DAYS }, readers, { strict = false } = {}) {
  const {
    readReturnsHistory, readSettlementHistory, readOliHistory, readOliCoverage, readOliOperationalUnits,
    readCatalogSnapshot, loadCatalogPayload, readOliSkuAsinResolution, readDirectory,
  } = readers;
  if (!isDate(asOf)) return { notReady: "invalid-asof" };
  const win = returnsWindow(asOf);
  const from = win.from;
  const acctIds = [S(accountId)];

  if (strict === true) return gatherReturnsEvidenceStrict({ accountId, organizationFingerprint, connectionId, asOf, graceDays, from, acctIds }, readers);

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

  return buildReturnsResult({ accountId, asOf, from, graceDays, durableReturnRows, durableSettlementRows, orderedRows, catalogRows, catalogSnapshot });
}

// The strict path (never reached with strict=false). Every read is typed; the payload is built by the SAME builder.
async function gatherReturnsEvidenceStrict({ accountId, organizationFingerprint, connectionId, asOf, graceDays, from, acctIds }, readers) {
  const {
    readReturnsHistory, readSettlementHistory, readOliHistory, readOliCoverage, readOliOperationalUnits,
    readCatalogSnapshot, loadCatalogPayload, readOliSkuAsinResolution, readDirectory,
  } = readers;
  const windowArgs = { organizationFingerprint, connectionId, accountIds: acctIds, from, to: asOf };
  const ret = await strictRead(readReturnsHistory, windowArgs, "returns");
  if (ret.failed) return ret.failed;
  const set = await strictRead(readSettlementHistory, windowArgs, "settlement");
  if (set.failed) return set.failed;
  const durableReturnRows = ret.rows;
  const durableSettlementRows = set.rows;
  // Exact row set (defense in depth over the readers' total primary-key order): a repeated key tuple means a paged
  // read duplicated one row -- and, with a matching count, skipped another. Never build from it.
  if (duplicateKeyCount(durableReturnRows, RETURNS_HISTORY_KEY_COLUMNS) > 0) return notReadyStrict("evidence-inconsistent:returns-duplicate");
  if (duplicateKeyCount(durableSettlementRows, SETTLEMENT_HISTORY_KEY_COLUMNS) > 0) return notReadyStrict("evidence-inconsistent:settlement-duplicate");
  if (durableReturnRows.length === 0 && durableSettlementRows.length === 0) return notReadyStrict("returns-evidence-missing");

  // ORDERED denominator (strict): priced OLI + ADDITIVE operational units + the SKU->ASIN resolver, each proven.
  const priced = await strictRead(readOliHistory, windowArgs, "oli");
  if (priced.failed) return priced.failed;
  const opunits = await strictRead(readOliOperationalUnits, { ...windowArgs, additiveOnly: true }, "opunits");
  if (opunits.failed) return opunits.failed;
  const res = await strictResolver({ readDirectory, readOliSkuAsinResolution }, { organizationFingerprint, connectionId, accountId });
  if (res.failed) return res.failed;
  let orderedRows;
  try {
    orderedRows = reshapeOrderedRows(mergeOrderedOliHistory({ historyRows: priced.rows, operationalRows: opunits.rows, estimateRows: [], skuAsinResolver: res.resolver }));
  } catch (_e) { return notReadyStrict("evidence-read-failed:oli"); }
  if (!Array.isArray(orderedRows)) return notReadyStrict("evidence-read-failed:oli");

  // Proven OLI coverage windows (the readOliCoverage reader: { windows:[{from,to}], read }).
  if (typeof readOliCoverage !== "function") return notReadyStrict("evidence-read-failed:oli");
  let cov;
  try { cov = await readOliCoverage({ organizationFingerprint, connectionId, accountId: S(accountId), sourceKey: OLI_SOURCE_KEY }); }
  catch (_e) { return notReadyStrict("evidence-read-failed:oli"); }
  if (!cov || typeof cov !== "object" || cov.read !== "ok" || !Array.isArray(cov.windows)) return notReadyStrict("evidence-read-failed:oli");
  // ONLY the windows OVERLAPPING [from, asOf] (covered_to >= from and covered_from <= asOf -- the route's L1 'oli'
  // SELECT), so a later window outside this report's window can never move the proven covered_to (the manifest).
  const oliCoveredTo = maxDate(cov.windows.filter((w) => w && isDate(S(w.from)) && isDate(S(w.to)) && S(w.to) >= from && S(w.from) <= asOf), "to");

  // Catalog (org snapshot, strict).
  const cat = await strictCatalog({ readCatalogSnapshot, loadCatalogPayload }, { organizationFingerprint, connectionId });
  if (cat.failed) return cat.failed;

  const out = buildReturnsResult({ accountId, asOf, from, graceDays, durableReturnRows, durableSettlementRows, orderedRows, catalogRows: cat.rows, catalogSnapshot: cat.snapshot });
  // The { to } identity needs a real dated evidence day; the ordered denominator must be proven through it.
  if (!isDate(out.latestDataDate)) return notReadyStrict("returns-evidence-missing");
  const need = out.latestDataDate < asOf ? out.latestDataDate : asOf;
  if (!isDate(oliCoveredTo) || oliCoveredTo < need) return notReadyStrict("oli-coverage-short");
  return {
    ...out,
    evidence: {
      durableReturnRows, durableSettlementRows, orderedRows, catalogRows: cat.rows,
      catalogPayloadSha: S(cat.snapshot.payload_sha), oliCoveredTo,
    },
  };
}

// The payload + provenance stamp from already-gathered rows (shared by both modes; the pre-WP5 tail, unchanged).
function buildReturnsResult({ accountId, asOf, from, graceDays, durableReturnRows, durableSettlementRows, orderedRows, catalogRows, catalogSnapshot }) {
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
  });

  // A provenance-faithful source_refreshed_at (never wall-clock): the freshest of the source refresh stamps + the
  // catalog validated_at + the latest observed data date -- so the publish CAS never lets a staler snapshot win.
  const cands = [returnsRefreshedAt, settlementsRefreshedAt, catalogSnapshot && catalogSnapshot.validated_at,
    isDate(payload.latestDataDate) ? payload.latestDataDate + "T00:00:00.000Z" : null].filter(Boolean).map(String).sort();
  const sourceRefreshedAt = cands.length ? cands[cands.length - 1] : null;
  return { payload, latestDataDate: payload.latestDataDate, sourceRefreshedAt };
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
