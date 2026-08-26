// TRUSTED ZERO-EXPORT backfill of the CURRENT live Daily Reporting version (daily-reporting-shared-v2) for a set
// of primary accounts, from ALREADY-DURABLE evidence only. This is the deterministic, verifiable publisher the
// mission needs: it does NOT depend on a browser page visit (the read-path self-heal), it discovers nothing on
// its own beyond the accounts it is handed, and it is structurally incapable of creating a DataDoe export -- it
// is never given an adapter, only durable Supabase readers (OLI history + coverage, ASIN Ads + coverage, the
// reusable Product Catalog snapshot).
//
// HONESTY: each account is published ENDING at its OWN latest proven OLI date (<= the reviewed asOf ceiling), via
// latestProvenDailyTo. No new export is authorized, so an account whose durable OLI is a few days behind is
// published for the window it can actually prove -- never padded to the ceiling, never a fabricated zero. The
// saved snapshot's params carry the effective { from, to, brand } and its params_hash is provenance-checked to
// equal paramsHashFor(reportVersion, effectiveParams) (a mismatch is refused). The derivation is the REAL
// contract (rederiveDailyV2Payload), so a v1 (campaign-grain) payload is never copied or relabelled.
//
// IDEMPOTENT: a valid v2 snapshot already saved at the effective identity is left untouched (skipped as
// "existing") -- a replay performs ZERO writes. A single account's failure is isolated (typed) and never
// overwrites that account's last-known-good snapshot. Each identity is serialized through the shared refresh
// lock so two concurrent runs never double-derive the same account.

import {
  DAILY_V2_LIVE_VERSION, DAILY_OLI_SOURCE_KEY,
  gatherDailyDurableEvidence, latestProvenDailyTo, rederiveDailyV2Payload, durableRefreshedAt,
} from "./daily-durable-rederive.js";
import { REPORT_DERIVATIONS } from "../sync/report-derivation.js";

export const DAILY_V2_REPORT_KEY = "daily-reporting";
const DAILY = REPORT_DERIVATIONS["daily-reporting"];

const S = (v) => (v == null ? "" : String(v));
const isDate = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

const freshAdsStatus = (payload) => (payload && payload.adsAvailability ? payload.adsAvailability.status : null);

// A stable fingerprint of the ADS state a derived Daily v2 payload carries: the availability status, the proven
// covered window, the latest metric date, and how many rows actually carry ad metrics. Two derivations with the
// same fingerprint have IDENTICAL Ads evidence, so the live snapshot need not be rewritten; a change (e.g. Ads
// went from "failed" with no ad rows to "partial" with N ad rows) flips the fingerprint and triggers a republish.
export function adsProvenanceOf(payload) {
  const a = payload && payload.adsAvailability ? payload.adsAvailability : null;
  const adRows = (payload && Array.isArray(payload.rows) ? payload.rows : []).filter(
    (r) => r && (("ad_sales" in r) || ("ad_spend" in r) || ("ad_clicks" in r)),
  ).length;
  return JSON.stringify({
    status: a ? a.status ?? null : null,
    coveredFrom: a ? a.coveredFrom ?? null : null,
    coveredTo: a ? a.coveredTo ?? null : null,
    latestMetricDate: a ? a.latestMetricDate ?? null : null,
    adRows,
  });
}

// A stable fingerprint of the SALES a derived Daily v2 payload carries: the row count + the summed total_sales /
// total_units (rounded). A correction that removes cancelled or zero-priced units from the durable rollup shifts
// these totals, so this flips even when the Ads evidence is unchanged -> the corrected Daily is republished.
export function salesProvenanceOf(payload) {
  const rows = payload && Array.isArray(payload.rows) ? payload.rows : [];
  let sales = 0; let units = 0;
  for (const r of rows) { sales += Number(r && r.total_sales != null ? r.total_sales : 0) || 0; units += Number(r && r.total_units != null ? r.total_units : 0) || 0; }
  return JSON.stringify({ rows: rows.length, sales: Math.round(sales * 100), units: Math.round(units) });
}

/**
 * Wrap a raw snapshot saver with a PROVENANCE guard: the row is written ONLY when its params_hash equals
 * paramsHashFor(reportVersion, { from, to, brand }) recomputed from the params being written. A mismatch is
 * refused (thrown) so a snapshot can never be persisted under a forged or stale identity -- the exact-key read
 * that later serves it is keyed by that hash, so an inconsistent hash would silently serve the wrong scope.
 */
export function makeProvenanceGuardedSave({ paramsHashFor, saveSnapshot }) {
  if (typeof paramsHashFor !== "function" || typeof saveSnapshot !== "function") {
    throw new Error("makeProvenanceGuardedSave requires paramsHashFor + saveSnapshot (fail closed).");
  }
  return async ({ reportKey, reportVersion, accountId, paramsHash, params, payload, sourceRefreshedAt }) => {
    const expected = paramsHashFor(reportVersion, { from: params.from, to: params.to, brand: params.brand });
    if (paramsHash !== expected) {
      throw new Error(`daily-v2-backfill: refusing to save ${accountId} under params_hash ${paramsHash} != provenance ${expected} (wrong-hash refused).`);
    }
    if (params.reportVersion && params.reportVersion !== reportVersion) {
      throw new Error(`daily-v2-backfill: refusing to save ${accountId} with params.reportVersion ${params.reportVersion} != ${reportVersion} (wrong-version refused).`);
    }
    return saveSnapshot({ reportKey, accountId, paramsHash, params, payload, sourceRefreshedAt });
  };
}

/**
 * Backfill v2 Daily snapshots for `accounts` from durable evidence only. ZERO DataDoe.
 *
 * @param {object} opts
 * @param {Array<{accountId:string, rawSellerId?:string, currency?:any}>} opts.accounts  the exact accounts to publish
 * @param {string} opts.from          canonical 5-month window start (e.g. "2026-03-01")
 * @param {string} opts.asOfCeiling   reviewed, FROZEN latest date (never exceeded; e.g. "2026-08-24")
 * @param {string} opts.organizationFingerprint
 * @param {string} [opts.connectionId="primary"]
 * @param {string} [opts.brand="ALL"]
 * @param {object} opts.readers       durable readers (getSourceOliHistoryRows, getSourceCoverageWindows, ...). NO adapter.
 * @param {object} opts.store         { paramsHashFor, claimLock, releaseLock, getExisting, save, validatePayload? }
 * @param {(r:object)=>void} [opts.onAccount]  progress callback per account
 * @returns {Promise<{results:object[], summary:object}>}
 */
export async function backfillDailyV2({
  accounts, from, asOfCeiling, organizationFingerprint, connectionId = "primary", brand = "ALL",
  readers, store, onAccount = () => {},
}) {
  if (!isDate(from) || !isDate(asOfCeiling) || from > asOfCeiling) {
    throw new Error(`backfillDailyV2: invalid window from=${from} asOfCeiling=${asOfCeiling} (fail closed).`);
  }
  if (!Array.isArray(accounts) || !accounts.length) throw new Error("backfillDailyV2: no accounts (fail closed).");
  if (!store || typeof store.paramsHashFor !== "function" || typeof store.save !== "function") {
    throw new Error("backfillDailyV2: store must supply paramsHashFor + save (fail closed).");
  }
  const wantBrand = S(brand).trim() || "ALL";
  const validate = typeof store.validatePayload === "function" ? store.validatePayload : (p) => DAILY.validatePayload(p);
  const claimLock = typeof store.claimLock === "function" ? store.claimLock : async () => true;
  const releaseLock = typeof store.releaseLock === "function" ? store.releaseLock : async () => {};
  const getExisting = typeof store.getExisting === "function" ? store.getExisting : async () => null;

  const results = [];
  // A stable per-account serialize key (the canonical ceiling identity) -- NOT the effective identity, which is
  // only known after reading coverage. This makes two concurrent backfill runs mutually exclusive per account.
  for (const acct of accounts) {
    const accountId = S(acct && acct.accountId);
    const rawSellerId = S(acct && (acct.rawSellerId ?? acct.accountId)) || accountId;
    const currency = acct && acct.currency != null ? acct.currency : null;
    if (!accountId) { const r = { accountId: "", status: "failed", reason: "missing-account-id", creates: 0 }; results.push(r); onAccount(r); continue; }

    const lockHash = store.paramsHashFor(DAILY_V2_LIVE_VERSION, { from, to: asOfCeiling, brand: wantBrand });
    const locked = await claimLock({ reportKey: DAILY_V2_REPORT_KEY, accountId, paramsHash: lockHash });
    if (!locked) { const r = { accountId, status: "skipped-locked", reason: "another-backfill-in-flight", creates: 0 }; results.push(r); onAccount(r); continue; }

    let result;
    try {
      const evidence = await gatherDailyDurableEvidence({ accountId, from, to: asOfCeiling, brand: wantBrand, organizationFingerprint, connectionId }, readers);
      const effectiveTo = latestProvenDailyTo({ oliWindows: evidence.oliWindows, from, ceiling: asOfCeiling });
      if (!effectiveTo) {
        result = { accountId, status: "failed", reason: "oli-coverage-incomplete", blockedBy: [{ sourceKey: DAILY_OLI_SOURCE_KEY, reason: "coverage-incomplete" }], creates: 0 };
      } else {
        const effectiveParams = { from, to: effectiveTo, brand: wantBrand };
        const paramsHash = store.paramsHashFor(DAILY_V2_LIVE_VERSION, effectiveParams);

        // Always re-derive (read-only, ZERO export) so a change in the durable ADS evidence is detected -- an
        // existing v2 snapshot published while Ads were unavailable must NOT be skipped just because its identity
        // exists. The idempotency key is the derived ADS PROVENANCE (availability + covered window + ad-row count),
        // NOT merely the snapshot's presence, because source_refreshed_at is dominated by the catalog timestamp and
        // would not move when only Ads change.
        const derived = rederiveDailyV2Payload({ accountId, rawSellerId, currency, from, to: effectiveTo, brand: wantBrand }, evidence);
        if (!derived.payload) {
          // Fail this account exactly, WITHOUT overwriting its last-known-good snapshot.
          result = { accountId, status: "failed", reason: derived.notReady || "derive-failed", blockedBy: derived.blockedBy || [], creates: 0 };
        } else {
          const sourceRefreshedAt = durableRefreshedAt(evidence, derived.latestDataDate) || null;
          const freshProv = adsProvenanceOf(derived.payload);
          const freshSalesProv = salesProvenanceOf(derived.payload);
          const existing = await getExisting({ reportKey: DAILY_V2_REPORT_KEY, accountId, paramsHash });
          const existingValid = existing && existing.payload && existing.params && existing.params.reportVersion === DAILY_V2_LIVE_VERSION && validate(existing.payload);
          if (existingValid && adsProvenanceOf(existing.payload) === freshProv && salesProvenanceOf(existing.payload) === freshSalesProv && S(existing.params.to) === effectiveTo) {
            // No Ads AND no SALES change vs the live snapshot -> leave it untouched (idempotent, ZERO write). A
            // cancelled/zero-value correction shifts the sales fingerprint and therefore DOES republish.
            result = { accountId, status: "existing", to: effectiveTo, paramsHash, adsAvailability: freshAdsStatus(derived.payload), creates: 0 };
          } else if (existingValid && S(existing.source_refreshed_at) > S(sourceRefreshedAt) && S(sourceRefreshedAt) !== "") {
            // Freshness CAS: the live snapshot is STRICTLY NEWER than this re-derivation's evidence -> never
            // overwrite it (a concurrent newer publish wins). Report, do not write.
            result = { accountId, status: "newer-live", to: effectiveTo, paramsHash, creates: 0 };
          } else {
            // New publish, or a republish because the Ads evidence changed (and we are not staler than the live row).
            const republish = !!existingValid;
            const saved = await store.save({
              reportKey: DAILY_V2_REPORT_KEY, reportVersion: DAILY_V2_LIVE_VERSION, accountId,
              paramsHash, params: { reportVersion: DAILY_V2_LIVE_VERSION, ...effectiveParams },
              payload: derived.payload, sourceRefreshedAt,
            });
            result = {
              accountId, status: republish ? "republished" : "published", to: effectiveTo, paramsHash,
              latestDataDate: derived.latestDataDate, bytes: saved && saved.payload_bytes ? saved.payload_bytes : null,
              adsAvailability: freshAdsStatus(derived.payload),
              creates: 0,
            };
          }
        }
      }
    } catch (e) {
      result = { accountId, status: "failed", reason: "exception", error: e && e.message ? e.message : String(e), creates: 0 };
    } finally {
      await releaseLock({ reportKey: DAILY_V2_REPORT_KEY, accountId, paramsHash: lockHash }).catch(() => {});
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
  // A successful outcome = a live v2 snapshot exists for the account (freshly published, republished with newer
  // Ads, already-current, or a strictly-newer live snapshot we correctly refused to overwrite).
  summary.successfulOrExisting = summary.published + summary.republished + summary.existing + summary.newerLive;
  return { results, summary };
}
