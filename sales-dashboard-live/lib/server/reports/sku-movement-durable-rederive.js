// SKU MOVEMENT -- the ZERO-EXPORT durable re-derivation. Reads ONLY already-saved evidence through injected readers
// (defaults are the production Supabase wrappers, wired by the caller): the account's Order Line Items daily rollup
// (source_oli_daily_history) + coverage windows + the org Product Catalog snapshot. NO DataDoe adapter is ever
// imported here, so a derive/serve/reload/account-change/brand-change CAN NOT create an export or spend a token.
// The pure movement math + windows live in sku-movement-core.js; this module is the I/O + honest-date boundary.

import { monthBackStr } from "../date-windows.js";
import { skuMovementPayload } from "./sku-movement-core.js";

const S = (v) => (v == null ? "" : String(v));
const isDate = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const OLI_SOURCE_KEY = "order-line-items";
const CATALOG_SOURCE_KEY = "product-catalog";
const ORGANIZATION_SCOPE_KEY = "__organization";

// PURE: from an account's durable OLI coverage windows, resolve the honest effectiveAsOf (the LATEST proven OLI date,
// capped at `ceiling` = D-1) + the earliest covered date (coverageFrom, so a completed month entirely before it is
// UNAVAILABLE, never a fabricated 0). Never invents D-1: if coverage proves only an earlier date, THAT is effectiveAsOf.
export function skuMovementProvenDates(oliWindows, ceiling) {
  const wins = (Array.isArray(oliWindows) ? oliWindows : []).filter((w) => w && isDate(S(w.covered_from ?? w.coveredFrom)) && isDate(S(w.covered_to ?? w.coveredTo)));
  if (!wins.length || !isDate(ceiling)) return { effectiveAsOf: null, coverageFrom: null };
  const froms = wins.map((w) => S(w.covered_from ?? w.coveredFrom));
  const tos = wins.map((w) => S(w.covered_to ?? w.coveredTo));
  const maxTo = tos.reduce((m, t) => (t > m ? t : m), tos[0]);
  const minFrom = froms.reduce((m, f) => (f < m ? f : m), froms[0]);
  const effectiveAsOf = maxTo < ceiling ? maxTo : ceiling; // cap at D-1; honest earlier date if that is all that is proven
  return { effectiveAsOf, coverageFrom: minFrom };
}

// I/O: gather one account's durable evidence (ZERO DataDoe). `ceiling` = the server-resolved D-1 (previous UTC day).
export async function gatherSkuMovementEvidence({ accountId, organizationFingerprint, connectionId = "primary", ceiling }, readers) {
  const { readOliHistory, readOliCoverage, readCatalogSnapshot, loadCatalogPayload } = readers;
  const cov = await readOliCoverage({ organizationFingerprint, connectionId, accountId, sourceKey: OLI_SOURCE_KEY });
  const oliWindows = cov && cov.read === "ok" ? (cov.windows || []) : [];
  const { effectiveAsOf, coverageFrom } = skuMovementProvenDates(oliWindows, ceiling);
  if (!effectiveAsOf) {
    return { notReady: "not-ready", blockedBy: [{ sourceKey: OLI_SOURCE_KEY, reason: "coverage-incomplete", accountId: S(accountId), blocksSales: true }] };
  }
  // The three completed months + MTD + the last-10 days all live within [start of the -3 month, effectiveAsOf].
  const from = monthBackStr(effectiveAsOf, 3);
  const historyRows = await readOliHistory({ organizationFingerprint, connectionId, accountIds: [S(accountId)], from, to: effectiveAsOf });
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
