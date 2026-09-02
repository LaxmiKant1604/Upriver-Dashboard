// Production wiring for the SINGLE sanctioned brand-sales derivation (corrected durable rollup only, ZERO DataDoe
// export). This is the ONLY brand-sales publisher the live admin refresh route and the scheduler adapter may use --
// they must NEVER call the raw ORDER_SALES buildBrandSalesPayload, which folds item_price_value without excluding
// cancelled/zero-value rows and creates a legacy Brand Sales OLI export.
//
// deriveCorrectedBrandSalesForAccount: resolve the account's seller name + marketplace country from the persisted
// current-primary account directory (never invented; a non-primary/dd-secondary/absent account fails typed), then
// derive brand-sales from source_oli_daily_history via deriveBrandSalesFromDurable.
//
// refreshCorrectedBrandSalesForAccount: an explicit admin refresh -- publish the corrected snapshot through the
// CAS-guarded backfill saver (idempotent on the sales fingerprint; never overwrites a strictly-newer corrected
// LKG), then read the saved snapshot back for serving. Zero DataDoe export, zero tokens.

import * as sb from "../supabase.js";
import { paramsHashFor } from "../report-store.js";
import { REPORT_DERIVATIONS } from "../sync/report-derivation.js";
import { getDataDoeConnections } from "../datadoe-connections.js";
import { organizationFingerprint } from "../source-identity.js";
import { isPrimaryAccountId } from "./brand-membership.js";
import { getEnrichedOliHistoryRows } from "../sync/oli-enriched-history.js";
import {
  backfillBrandSalesV1, deriveBrandSalesFromDurable,
  BRAND_SALES_REPORT_KEY, BRAND_SALES_LIVE_VERSION,
} from "./brand-sales-backfill.js";

const S = (v) => (v == null ? "" : String(v));

// Durable-ONLY readers (no DataDoe adapter -> a create-export is structurally impossible here).
const DURABLE_READERS = {
  // Enriched OLI history: priced rollup + internal missing/zero-price sales estimates (same canonical calculation
  // the scheduler-published Brand Sales snapshot uses), so the live refresh serves the SAME Total Sales.
  readOliHistory: getEnrichedOliHistoryRows,
  readOliCoverage: sb.getSourceCoverageWindows,
  readAsinAds: sb.getActiveAdsDailyRows,
  readAdsCoverage: sb.getDailyAdsCoverage,
  readCatalogSnapshot: sb.getSourceSnapshot,
  loadCatalogPayload: sb.getSourceSnapshotPayload,
};

function primaryOrgFingerprint() {
  const primary = getDataDoeConnections().find((c) => c && c.id === "primary" && S(c.apiKey).trim());
  if (!primary) return null;
  return primary.organizationFingerprint || organizationFingerprint(primary.apiKey);
}

// The account's { accountId, name, country } from the persisted current-primary account directory, or null when the
// id is not a current primary account (dd-secondary, retired, absent, or missing name/country). Seller name +
// marketplace are read from the directory, NEVER invented.
async function primaryDirectoryAccount(accountId) {
  const id = S(accountId).trim();
  if (!isPrimaryAccountId(id)) return null;
  const dir = await sb.getLatestReportSnapshot({ reportKey: "account-directory", accountId: "__account-directory__" }).catch(() => null);
  const rec = (dir?.payload?.accounts || []).find((a) => S(a.id) === id && a.active !== false && !S(a.id).includes(":"));
  if (!rec || !S(rec.name).trim() || !S(rec.country).trim()) return null;
  return { accountId: id, name: S(rec.name), country: S(rec.country) };
}

/**
 * Derive the CORRECTED brand-sales payload for one account from durable evidence (zero export). Returns
 * { payload, to, sourceRefreshedAt } or { notReady: <reason> }. Never a raw ORDER_SALES fold.
 */
export async function deriveCorrectedBrandSalesForAccount({ accountId, from, to }) {
  const account = await primaryDirectoryAccount(accountId);
  if (!account) return { notReady: "account-not-in-primary-directory" };
  const organizationFingerprint = primaryOrgFingerprint();
  if (!organizationFingerprint) return { notReady: "no-primary-connection" };
  return deriveBrandSalesFromDurable({ account, from, to, organizationFingerprint, connectionId: "primary", readers: DURABLE_READERS });
}

// The CAS-guarded production store shared with backfill-brand-sales.mjs -- refuses to overwrite a strictly-newer
// corrected LKG, idempotent on the sales fingerprint, never any DataDoe adapter.
function productionStore() {
  return {
    paramsHashFor,
    claimLock: sb.claimRefreshLock,
    releaseLock: sb.releaseRefreshLock,
    getExisting: sb.getReportSnapshot,
    validatePayload: (p) => REPORT_DERIVATIONS["brand-sales"].validatePayload(p),
    save: async ({ reportKey, accountId, paramsHash, params, payload, sourceRefreshedAt }) => {
      const payloadBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
      const saved = await sb.saveReportSnapshot({ reportKey, accountId, paramsHash, params, payload, payloadBytes, sourceRefreshedAt: sourceRefreshedAt || new Date().toISOString() });
      if (saved?.id) await sb.publishSnapshotUpdate({ reportKey, accountId, paramsHash, snapshotId: saved.id }).catch(() => {});
      return { id: saved?.id || null, payload_bytes: payloadBytes };
    },
  };
}

/**
 * Explicit admin refresh of ONE account's brand-sales from the corrected durable rollup (zero export). Publishes
 * through the CAS-guarded backfill saver, then reads the saved snapshot back for serving. Returns { payload,
 * status } or { notReady: <reason> }. A raw/legacy payload can never be produced or published here.
 */
export async function refreshCorrectedBrandSalesForAccount({ accountId, from, to }) {
  const account = await primaryDirectoryAccount(accountId);
  if (!account) return { notReady: "account-not-in-primary-directory" };
  const organizationFingerprint = primaryOrgFingerprint();
  if (!organizationFingerprint) return { notReady: "no-primary-connection" };
  const { results } = await backfillBrandSalesV1({
    accounts: [account], from, asOfCeiling: to, organizationFingerprint, readers: DURABLE_READERS, store: productionStore(),
  });
  const r = results[0] || { status: "failed", reason: "no-result" };
  if (r.status === "failed") return { notReady: r.reason || "derive-failed" };
  // Read the (now corrected) live snapshot back, storage-first, to serve. A skipped-locked/idempotent result still
  // has a valid saved snapshot to serve.
  const snap = await sb.getLatestReportSnapshotHydrated({ reportKey: BRAND_SALES_REPORT_KEY, accountId: account.accountId }).catch(() => null);
  return { payload: snap?.payload || null, status: r.status, reportVersion: BRAND_SALES_LIVE_VERSION };
}
