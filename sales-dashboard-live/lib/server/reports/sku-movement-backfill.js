// TRUSTED ZERO-EXPORT backfill of the CURRENT live SKU Movement version (sku-movement/v1) for a set of primary
// accounts, from ALREADY-DURABLE evidence only. Mirrors backfillDailyV2: deterministic, verifiable, and structurally
// incapable of creating a DataDoe export -- it is NEVER given an adapter, only durable Supabase readers (OLI history +
// coverage, the reusable Product Catalog snapshot). It discovers nothing beyond the accounts it is handed.
//
// HONESTY: each account is published AS OF its OWN latest proven OLI date (<= the reviewed asOf ceiling), computed by
// skuMovementProvenDates inside rederiveSkuMovement. No new export is authorized, so an account whose durable OLI is a
// few days behind is published for the date it can actually prove -- never padded to the ceiling, never a fabricated
// zero. The saved params carry { asOf, brand } and its params_hash is provenance-checked to equal
// paramsHashFor(reportVersion, { asOf, brand }) (a mismatch is refused).
//
// IDEMPOTENT: a valid snapshot already saved at the effective identity whose units-provenance matches is left
// untouched (skipped as "existing") -- a replay performs ZERO writes. A units correction (interior date re-stated)
// flips the fingerprint and republishes. A single account's failure is isolated (typed) and never overwrites its
// last-known-good. Each identity is serialized through the shared refresh lock.

import { rederiveSkuMovement } from "./sku-movement-durable-rederive.js";
import { REPORT_DERIVATIONS } from "../sync/report-derivation.js";

export const SKU_MOVEMENT_REPORT_KEY = "sku-movement";
export const SKU_MOVEMENT_VERSION = "sku-movement/v2";
const SKU_MOVEMENT_OLI_SOURCE_KEY = "order-line-items";
const SKU = REPORT_DERIVATIONS["sku-movement"];

const S = (v) => (v == null ? "" : String(v));
const isDate = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

// A stable fingerprint of the UNITS a derived SKU Movement payload carries: the row count + the summed units across
// EVERY window bucket (completed months + MTD + last-5 + prev-5), rounded. A cancelled/zero-value correction that
// re-states an interior date shifts this even when effectiveAsOf is unchanged -> the corrected report is republished.
export function skuMovementUnitsProvenanceOf(payload) {
  const rows = payload && Array.isArray(payload.rows) ? payload.rows : [];
  let units = 0;
  for (const r of rows) {
    for (const m of (r && Array.isArray(r.months) ? r.months : [])) units += Number(m && m.units != null ? m.units : 0) || 0;
    units += Number(r && r.mtdUnits != null ? r.mtdUnits : 0) || 0;
    units += Number(r && r.last5Total != null ? r.last5Total : 0) || 0;
    units += Number(r && r.prev5Total != null ? r.prev5Total : 0) || 0;
  }
  return JSON.stringify({ rows: rows.length, units: Math.round(units), asOf: payload && payload.effectiveAsOf ? String(payload.effectiveAsOf) : null });
}

// Wrap a raw snapshot saver with a PROVENANCE guard: the row is written ONLY when its params_hash equals
// paramsHashFor(reportVersion, { asOf, brand }) recomputed from the params being written. A mismatch is refused so a
// snapshot can never be persisted under a forged or stale identity (the exact-key read is keyed by that hash).
export function makeSkuMovementProvenanceGuardedSave({ paramsHashFor, saveSnapshot }) {
  if (typeof paramsHashFor !== "function" || typeof saveSnapshot !== "function") {
    throw new Error("makeSkuMovementProvenanceGuardedSave requires paramsHashFor + saveSnapshot (fail closed).");
  }
  return async ({ reportKey, reportVersion, accountId, paramsHash, params, payload, sourceRefreshedAt }) => {
    const expected = paramsHashFor(reportVersion, { asOf: params.asOf, brand: params.brand });
    if (paramsHash !== expected) {
      throw new Error(`sku-movement-backfill: refusing to save ${accountId} under params_hash ${paramsHash} != provenance ${expected} (wrong-hash refused).`);
    }
    if (params.reportVersion && params.reportVersion !== reportVersion) {
      throw new Error(`sku-movement-backfill: refusing to save ${accountId} with params.reportVersion ${params.reportVersion} != ${reportVersion} (wrong-version refused).`);
    }
    return saveSnapshot({ reportKey, accountId, paramsHash, params, payload, sourceRefreshedAt });
  };
}

/**
 * Backfill sku-movement/v1 snapshots for `accounts` from durable evidence only. ZERO DataDoe.
 *
 * @param {object} opts
 * @param {Array<{accountId:string}>} opts.accounts   the exact accounts to publish (All Brands per account by default)
 * @param {string} opts.asOfCeiling                   reviewed, FROZEN latest date (D-1; never exceeded)
 * @param {string} opts.organizationFingerprint
 * @param {string} [opts.connectionId="primary"]
 * @param {string} [opts.brand="ALL"]
 * @param {object} opts.readers   durable readers (readOliHistory, readOliCoverage, readCatalogSnapshot, loadCatalogPayload). NO adapter.
 * @param {object} opts.store     { paramsHashFor, claimLock, releaseLock, getExisting, save, validatePayload? }
 * @param {(r:object)=>void} [opts.onAccount]
 * @returns {Promise<{results:object[], summary:object}>}
 */
export async function backfillSkuMovement({
  accounts, asOfCeiling, organizationFingerprint, connectionId = "primary", brand = "ALL",
  readers, store, onAccount = () => {},
}) {
  if (!isDate(asOfCeiling)) throw new Error(`backfillSkuMovement: invalid asOfCeiling=${asOfCeiling} (fail closed).`);
  if (!Array.isArray(accounts) || !accounts.length) throw new Error("backfillSkuMovement: no accounts (fail closed).");
  if (!store || typeof store.paramsHashFor !== "function" || typeof store.save !== "function") {
    throw new Error("backfillSkuMovement: store must supply paramsHashFor + save (fail closed).");
  }
  const wantBrand = S(brand).trim() || "ALL";
  const validate = typeof store.validatePayload === "function" ? store.validatePayload : (p) => SKU.validatePayload(p);
  const claimLock = typeof store.claimLock === "function" ? store.claimLock : async () => true;
  const releaseLock = typeof store.releaseLock === "function" ? store.releaseLock : async () => {};
  const getExisting = typeof store.getExisting === "function" ? store.getExisting : async () => null;

  const results = [];
  for (const acct of accounts) {
    const accountId = S(acct && acct.accountId);
    if (!accountId) { const r = { accountId: "", status: "failed", reason: "missing-account-id", creates: 0 }; results.push(r); onAccount(r); continue; }

    // Stable per-account serialize key (the ceiling identity, NOT the effective one which is known only after read).
    const lockHash = store.paramsHashFor(SKU_MOVEMENT_VERSION, { asOf: asOfCeiling, brand: wantBrand, lock: "sku-movement-backfill" });
    const locked = await claimLock({ reportKey: SKU_MOVEMENT_REPORT_KEY, accountId, paramsHash: lockHash });
    if (!locked) { const r = { accountId, status: "skipped-locked", reason: "another-backfill-in-flight", creates: 0 }; results.push(r); onAccount(r); continue; }

    let result;
    try {
      const derived = await rederiveSkuMovement({ accountId, brand: wantBrand, organizationFingerprint, connectionId, ceiling: asOfCeiling }, readers);
      if (!derived || derived.notReady || !derived.payload) {
        // The only notReady cause is missing/insufficient OLI coverage -> a typed coverage-incomplete failure.
        result = { accountId, status: "failed", reason: "oli-coverage-incomplete",
          blockedBy: (derived && derived.blockedBy) || [{ sourceKey: SKU_MOVEMENT_OLI_SOURCE_KEY, reason: "coverage-incomplete" }], creates: 0 };
      } else if (!validate(derived.payload)) {
        result = { accountId, status: "failed", reason: "payload-invalid", creates: 0 };
      } else {
        const effAsOf = S(derived.effectiveParams.asOf);
        const effectiveParams = { asOf: effAsOf, brand: wantBrand };
        const paramsHash = store.paramsHashFor(SKU_MOVEMENT_VERSION, effectiveParams);
        const sourceRefreshedAt = derived.sourceRefreshedAt || null;
        const freshProv = skuMovementUnitsProvenanceOf(derived.payload);
        const existing = await getExisting({ reportKey: SKU_MOVEMENT_REPORT_KEY, accountId, paramsHash });
        const existingValid = existing && existing.payload && existing.params && existing.params.reportVersion === SKU_MOVEMENT_VERSION && validate(existing.payload);
        if (existingValid && skuMovementUnitsProvenanceOf(existing.payload) === freshProv && S(existing.params.asOf) === effAsOf) {
          result = { accountId, status: "existing", asOf: effAsOf, paramsHash, rows: derived.payload.rows.length, creates: 0 };
        } else if (existingValid && S(existing.source_refreshed_at) > S(sourceRefreshedAt) && S(sourceRefreshedAt) !== "") {
          result = { accountId, status: "newer-live", asOf: effAsOf, paramsHash, creates: 0 };
        } else {
          const republish = !!existingValid;
          const saved = await store.save({
            reportKey: SKU_MOVEMENT_REPORT_KEY, reportVersion: SKU_MOVEMENT_VERSION, accountId,
            paramsHash, params: { reportVersion: SKU_MOVEMENT_VERSION, ...effectiveParams },
            payload: derived.payload, sourceRefreshedAt,
          });
          result = { accountId, status: republish ? "republished" : "published", asOf: effAsOf, paramsHash,
            rows: derived.payload.rows.length, bytes: saved && saved.payload_bytes ? saved.payload_bytes : null, creates: 0 };
        }
      }
    } catch (e) {
      result = { accountId, status: "failed", reason: "exception", error: e && e.message ? e.message : String(e), creates: 0 };
    } finally {
      await releaseLock({ reportKey: SKU_MOVEMENT_REPORT_KEY, accountId, paramsHash: lockHash }).catch(() => {});
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
