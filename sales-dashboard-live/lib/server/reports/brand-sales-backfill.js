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
import { gatherDailyDurableEvidence, latestProvenDailyTo, durableRefreshedAt, DAILY_OLI_SOURCE_KEY } from "./daily-durable-rederive.js";

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
    sales += Number(r && r.total_sales_sum != null ? r.total_sales_sum : 0) || 0;
    units += Number(r && r.total_units_sold_sum != null ? r.total_units_sold_sum : 0) || 0;
  }
  return JSON.stringify({ rows: rows.length, sales: Math.round(sales * 100), units: Math.round(units) });
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
      const evidence = await gatherDailyDurableEvidence({ accountId, from, to: asOfCeiling, organizationFingerprint, connectionId }, readers);
      if (!Array.isArray(evidence.catalogRows)) {
        result = { accountId, status: "failed", reason: "catalog-rows-unavailable", creates: 0 };
      } else {
        const effectiveTo = latestProvenDailyTo({ oliWindows: evidence.oliWindows, from, ceiling: asOfCeiling });
        if (!effectiveTo) {
          result = { accountId, status: "failed", reason: "oli-coverage-incomplete", blockedBy: [{ sourceKey: DAILY_OLI_SOURCE_KEY, reason: "coverage-incomplete" }], creates: 0 };
        } else {
          // orderRowsFromHistory injects seller_or_vendor_name + marketplace_country_code from the directory record
          // (fail closed if either is missing) and reads the CORRECTED non-cancelled rollup -> cancelled + zero-value
          // are already excluded, exactly as Daily. Windowed to the account's proven range.
          const account = { accountId, name: acct.name, country: acct.country };
          const orderRows = orderRowsFromHistory(evidence.historyRows, account).filter((r) => r.date >= from && r.date <= effectiveTo);
          const payload = BRAND_SALES.derive({
            sources: { "brand-sales:order-lines": { rows: orderRows }, "brand-sales:catalog": { rows: evidence.catalogRows } },
          });
          if (!validate(payload)) {
            result = { accountId, status: "failed", reason: "derive-invalid", creates: 0 };
          } else {
            const params = { from, to: effectiveTo };
            const paramsHash = store.paramsHashFor(BRAND_SALES_LIVE_VERSION, params);
            const sourceRefreshedAt = durableRefreshedAt(evidence, effectiveTo) || null;
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
