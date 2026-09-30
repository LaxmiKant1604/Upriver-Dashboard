// "Publish from saved data" -- the ONE definition of "the Brand View the dashboard serves for this exact scope is
// current", shared by the dashboard endpoint (the pre-enqueue 'Already current' answer) and the executor (the final
// read-back that alone may mark a request published / already current).
//
// It is EXACTLY the serve's own rule (api/datadoe.js brand-view -> report-store.js serveSharedReport):
//   - the serve reads the EXACT row at report_key 'brand-view', account_id brandViewScopeId(account, brand),
//     params_hash paramsHashFor(BRAND_VIEW_VERSION, { accountId, brand, asOf }) -- anything else is a stale-scope
//     fallback the page labels as an older report;
//   - that row is fresh (no 'updating' flag) when its stored params.depFingerprint EQUALS the dependency fingerprint the
//     serve computes now with collectBrandViewDependencyFingerprint over the SAME readers (brandViewDepFingerprintReaders).
// So current <=> exact row present AND stored fingerprint present AND equal to the freshly computed one. A fingerprint
// that cannot be computed, or a row without a stored fingerprint, is NEVER current (unknown -> the executor decides).
// Reads only row IDENTITY (+ the payload's small coverage object), never the payload. Pure over injected readers.

import { BRAND_VIEW_VERSION, brandViewScopeId } from "../reports/brand-view.js";
import { collectBrandViewDependencyFingerprint } from "../reports/brand-view-dependency-fingerprint.js";
import { paramsHashFor } from "../report-params-hash.js";

const S = (v) => (v == null ? "" : String(v));

/** The exact serve identity of a Brand View scope (PURE). */
export function brandViewServeIdentity({ accountId, brand, asOf }) {
  return {
    reportKey: "brand-view",
    liveAccountId: brandViewScopeId(S(accountId), S(brand)),
    paramsHash: paramsHashFor(BRAND_VIEW_VERSION, { accountId: S(accountId), brand: S(brand), asOf: S(asOf) }),
  };
}

/**
 * -> { current: boolean, reason, served: { id, paramsHash, sourceRefreshedAt, updatedAt, storedFingerprint, salesLatestDate } | null,
 *      fingerprint: string | null }
 * reason: 'current' | 'no-exact-row' | 'exact-row-without-payload' | 'served-read-failed' | 'fingerprint-unavailable' |
 *         'no-stored-fingerprint' | 'fingerprint-differs'
 * readers: { readSnapshotIdentity({ reportKey, accountId, paramsHash }), fingerprintReaders (makeBrandViewDepReaders shape) }
 */
export async function brandViewServedCurrency({ accountId, brand, asOf, readSnapshotIdentity, fingerprintReaders }) {
  const id = brandViewServeIdentity({ accountId, brand, asOf });
  let row = null;
  try { row = await readSnapshotIdentity({ reportKey: id.reportKey, accountId: id.liveAccountId, paramsHash: id.paramsHash }); }
  catch { return { current: false, reason: "served-read-failed", served: null, fingerprint: null }; }
  let fingerprint = null;
  try {
    fingerprint = await collectBrandViewDependencyFingerprint({
      scope: "account", brand: S(brand), accountIds: [S(accountId)], reportVersion: BRAND_VIEW_VERSION, readers: fingerprintReaders,
    });
  } catch { fingerprint = null; }
  if (typeof fingerprint !== "string" || !/^[0-9a-f]{40}$/.test(fingerprint)) fingerprint = null;
  const served = row ? {
    id: S(row.id), paramsHash: S(row.params_hash), sourceRefreshedAt: row.source_refreshed_at == null ? null : S(row.source_refreshed_at),
    updatedAt: row.updated_at == null ? null : S(row.updated_at),
    storedFingerprint: row.params && row.params.depFingerprint ? S(row.params.depFingerprint) : null,
    salesLatestDate: row.coverage && row.coverage.salesLatestDate ? S(row.coverage.salesLatestDate) : null,
  } : null;
  if (!served || S(row.params_hash) !== id.paramsHash) return { current: false, reason: "no-exact-row", served: null, fingerprint };
  // The serve answers the exact row only with an inline payload; every Brand View payload carries `coverage`
  // (brand-view.js assembleBrandViewPayload), so its absence means the serve would fall back (never current).
  if (!row.coverage || typeof row.coverage !== "object") return { current: false, reason: "exact-row-without-payload", served, fingerprint };
  if (!fingerprint) return { current: false, reason: "fingerprint-unavailable", served, fingerprint };
  if (!served.storedFingerprint) return { current: false, reason: "no-stored-fingerprint", served, fingerprint };
  if (served.storedFingerprint !== fingerprint) return { current: false, reason: "fingerprint-differs", served, fingerprint };
  return { current: true, reason: "current", served, fingerprint };
}
