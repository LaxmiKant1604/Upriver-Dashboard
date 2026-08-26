// TRUSTED ZERO-EXPORT backfill of the CURRENT live Brand Sales version (brand-sales-shared-v1) for a set of
// primary accounts, from ALREADY-DURABLE evidence only -- the Brand View analog of daily-v2-backfill.
//
// WHY: after the dimensional OLI correction, source_oli_daily_history (the rollup Daily reads) EXCLUDES cancelled
// and zero-value rows, and Daily was re-derived + republished from it. Brand Sales was NOT re-derived, so the live
// brand-sales snapshots still COUNT cancelled + zero-value rows (proven: live brand-sales == corrected rollup +
// cancelled-only, to the cent). The terminal same-day cycle prevents the priority release from re-deriving them.
// This publisher recomputes the brand-sales payload through the REAL derivation contract from the corrected
// durable rollup and republishes it -- so Brand View and Daily reconcile on the SAME cancelled/zero exclusion.
//
// It makes ZERO DataDoe calls: it reuses gatherDailyDurableEvidence (durable OLI history rollup + coverage + the
// reusable Product Catalog snapshot) and orderRowsFromHistory (seller name + marketplace from the primary account
// directory -- never invented). No adapter is created, so a create-export is structurally impossible.
//
// HONESTY: each account is published ENDING at its OWN latest proven OLI date (<= the reviewed ceiling) via
// latestProvenDailyTo -- never padded to the ceiling, never a fabricated zero. IDEMPOTENT: a valid snapshot whose
// SALES fingerprint already matches (cancelled/zero already excluded) is left untouched (zero writes); the
// freshness CAS refuses to overwrite a strictly-newer live snapshot (LKG preserved).

import { REPORT_DERIVATIONS } from "../sync/report-derivation.js";
import { orderRowsFromHistory } from "../sync/durable-dashboards.js";
import { gatherDailyDurableEvidence, latestProvenDailyTo, durableRefreshedAt } from "./daily-durable-rederive.js";

export const BRAND_SALES_LIVE_VERSION = "brand-sales-shared-v1";
export const BRAND_SALES_REPORT_KEY = "brand-sales";
const BRAND_SALES = REPORT_DERIVATIONS["brand-sales"];

const S = (v) => (v == null ? "" : String(v));
const isDate = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

// A stable fingerprint of the SALES a derived brand-sales payload carries: the row count + summed
// total_sales_sum / total_units_sold_sum (rounded). A cancelled/zero-value correction shifts these totals, so this
// flips vs a stale cancelled-inclusive live snapshot -> the corrected brand-sales is republished; an already
// corrected snapshot leaves it untouched (idempotent).
export function brandSalesProvenanceOf(payload) {
  const rows = payload && Array.isArray(payload.rows) ? payload.rows : [];
  let sales = 0; let units = 0;
  for (const r of rows) {
    // The brand-sales derivation output rows carry total_sales / total_units_sold (orderSalesByBrand); the _sum
    // suffix is the INPUT order-line shape. Fall back to it so a legacy/raw payload still fingerprints, but a
    // cancelled/zero-value correction to the OUTPUT totals must flip this so the corrected brand-sales republishes.
    sales += Number((r && (r.total_sales != null ? r.total_sales : r.total_sales_sum)) ?? 0) || 0;
    units += Number((r && (r.total_units_sold != null ? r.total_units_sold : r.total_units_sold_sum)) ?? 0) || 0;
  }
  return JSON.stringify({ rows: rows.length, sales: Math.round(sales * 100), units: Math.round(units) });
}

/**
 * Derive the CORRECTED brand-sales payload for ONE account from durable evidence only (ZERO DataDoe export) --
 * the SINGLE sanctioned brand-sales derivation, reused by the backfill, the live admin refresh route, and the
 * scheduler adapter so Brand Sales business totals ALWAYS come from the corrected rollup (cancelled + zero-value
 * excluded via source_oli_daily_history), never the raw ORDER_SALES projection. `account` = { accountId, name,
 * country } (orderRowsFromHistory refuses an account without its directory name + marketplace country -- never
 * invented). Publishes at the account's OWN latest proven OLI date (<= `to`). Returns
 * { payload, to, sourceRefreshedAt } on success or { notReady: <reason> } (never a fabricated zero).
 */
export async function deriveBrandSalesFromDurable({ account, from, to, organizationFingerprint, connectionId = "primary", readers }) {
  if (!isDate(from) || !isDate(to) || from > to) return { notReady: "bad-window" };
  const accountId = S(account && account.accountId);
  if (!accountId) return { notReady: "missing-account-id" };
  // Seller name + marketplace country are read from the directory, NEVER invented -- fail typed (never throw)
  // when either is missing so a caller can serve the last-known-good instead.
  if (!S(account && account.name).trim() || !S(account && account.country).trim()) return { notReady: "account-metadata-missing" };
  const evidence = await gatherDailyDurableEvidence({ accountId, from, to, organizationFingerprint, connectionId }, readers);
  if (!Array.isArray(evidence.catalogRows)) return { notReady: "catalog-rows-unavailable" };
  const effectiveTo = latestProvenDailyTo({ oliWindows: evidence.oliWindows, from, ceiling: to });
  if (!effectiveTo) return { notReady: "oli-coverage-incomplete" };
  const orderRows = orderRowsFromHistory(evidence.historyRows, { accountId, name: account.name, country: account.country })
    .filter((r) => r.date >= from && r.date <= effectiveTo);
  const payload = BRAND_SALES.derive({
    sources: { "brand-sales:order-lines": { rows: orderRows }, "brand-sales:catalog": { rows: evidence.catalogRows } },
  });
  if (!BRAND_SALES.validatePayload(payload)) return { notReady: "derive-invalid" };
  return { payload, to: effectiveTo, sourceRefreshedAt: durableRefreshedAt(evidence, effectiveTo) || null };
}

/**
 * Publish brand-sales-shared-v1 for a set of primary accounts from durable evidence only (zero export). Mirrors
 * backfillDailyV2. `accounts` MUST carry { accountId, name, country } (orderRowsFromHistory refuses an account
 * without its directory name + marketplace country -- never invented).
 *
 * store: { paramsHashFor, claimLock?, releaseLock?, getExisting?, save, validatePayload? }.
 * Returns { results, summary }.
 */
export async function backfillBrandSalesV1({
  accounts, from, asOfCeiling, organizationFingerprint, connectionId = "primary",
  readers, store, onAccount = () => {},
}) {
  if (!isDate(from) || !isDate(asOfCeiling) || from > asOfCeiling) {
    throw new Error(`backfillBrandSalesV1: invalid window from=${from} asOfCeiling=${asOfCeiling} (fail closed).`);
  }
  if (!Array.isArray(accounts) || !accounts.length) throw new Error("backfillBrandSalesV1: no accounts (fail closed).");
  if (!store || typeof store.paramsHashFor !== "function" || typeof store.save !== "function") {
    throw new Error("backfillBrandSalesV1: store must supply paramsHashFor + save (fail closed).");
  }
  const validate = typeof store.validatePayload === "function" ? store.validatePayload : (p) => BRAND_SALES.validatePayload(p);
  const claimLock = typeof store.claimLock === "function" ? store.claimLock : async () => true;
  const releaseLock = typeof store.releaseLock === "function" ? store.releaseLock : async () => {};
  const getExisting = typeof store.getExisting === "function" ? store.getExisting : async () => null;

  const results = [];
  for (const acct of accounts) {
    const accountId = S(acct && acct.accountId);
    if (!accountId) { const r = { accountId: "", status: "failed", reason: "missing-account-id", creates: 0 }; results.push(r); onAccount(r); continue; }

    const lockHash = store.paramsHashFor(BRAND_SALES_LIVE_VERSION, { from, to: asOfCeiling });
    const locked = await claimLock({ reportKey: BRAND_SALES_REPORT_KEY, accountId, paramsHash: lockHash });
    if (!locked) { const r = { accountId, status: "skipped-locked", reason: "another-backfill-in-flight", creates: 0 }; results.push(r); onAccount(r); continue; }

    let result;
    try {
      // The SINGLE sanctioned derivation: corrected rollup only, zero export (shared with the live route + adapter).
      const derived = await deriveBrandSalesFromDurable({
        account: { accountId, name: acct.name, country: acct.country },
        from, to: asOfCeiling, organizationFingerprint, connectionId, readers,
      });
      if (derived.notReady) {
        result = { accountId, status: "failed", reason: derived.notReady, creates: 0 };
      } else {
        {
          const effectiveTo = derived.to;
          const payload = derived.payload;
          {
            const params = { from, to: effectiveTo };
            const paramsHash = store.paramsHashFor(BRAND_SALES_LIVE_VERSION, params);
            const sourceRefreshedAt = derived.sourceRefreshedAt;
            const freshSalesProv = brandSalesProvenanceOf(payload);
            const existing = await getExisting({ reportKey: BRAND_SALES_REPORT_KEY, accountId, paramsHash });
            const existingValid = existing && existing.payload && existing.params && existing.params.reportVersion === BRAND_SALES_LIVE_VERSION && validate(existing.payload);
            if (existingValid && brandSalesProvenanceOf(existing.payload) === freshSalesProv && S(existing.params.to) === effectiveTo) {
              // Already corrected (same sales fingerprint) -> leave untouched (idempotent, ZERO write).
              result = { accountId, status: "existing", to: effectiveTo, paramsHash, creates: 0 };
            } else if (existingValid && S(existing.source_refreshed_at) > S(sourceRefreshedAt) && S(sourceRefreshedAt) !== "") {
              // Freshness CAS: the live snapshot is STRICTLY NEWER than this re-derivation's evidence -> never
              // overwrite it (a concurrent newer publish wins). Report, do not write.
              result = { accountId, status: "newer-live", to: effectiveTo, paramsHash, creates: 0 };
            } else {
              const republish = !!existingValid;
              const saved = await store.save({
                reportKey: BRAND_SALES_REPORT_KEY, reportVersion: BRAND_SALES_LIVE_VERSION, accountId,
                paramsHash, params: { reportVersion: BRAND_SALES_LIVE_VERSION, ...params },
                payload, sourceRefreshedAt,
              });
              result = {
                accountId, status: republish ? "republished" : "published", to: effectiveTo, paramsHash,
                latestDataDate: effectiveTo, bytes: saved && saved.payload_bytes ? saved.payload_bytes : null, creates: 0,
              };
            }
          }
        }
      }
    } catch (e) {
      result = { accountId, status: "failed", reason: "exception", error: e && e.message ? e.message : String(e), creates: 0 };
    } finally {
      await releaseLock({ reportKey: BRAND_SALES_REPORT_KEY, accountId, paramsHash: lockHash }).catch(() => {});
    }
    results.push(result);
    onAccount(result);
  }

  const summary = {
    attempted: results.length,
    published: results.filter((r) => r.status === "published").length,
    republished: results.filter((r) => r.status === "republished").length,
    existing: results.filter((r) => r.status === "existing").length,
    newerLive: results.filter((r) => r.status === "newer-live").length,
    failed: results.filter((r) => r.status === "failed").length,
    skippedLocked: results.filter((r) => r.status === "skipped-locked").length,
    creates: 0, tokens: 0, // structurally: no adapter, so no DataDoe export is possible here.
  };
  summary.successfulOrExisting = summary.published + summary.republished + summary.existing + summary.newerLive;
  return { results, summary };
}
