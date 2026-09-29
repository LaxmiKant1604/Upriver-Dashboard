// Production wiring for the SINGLE sanctioned brand-sales derivation (corrected durable rollup only, ZERO DataDoe
// export). The scheduler adapter derives through it -- it must NEVER call the raw ORDER_SALES buildBrandSalesPayload,
// which folds item_price_value without excluding cancelled/zero-value rows and creates a legacy Brand Sales OLI export.
//
// deriveCorrectedBrandSalesForAccount: resolve the account's seller name + marketplace country from the persisted
// current-primary account directory (never invented; a non-primary/dd-secondary/absent account fails typed), then
// derive brand-sales from source_oli_daily_history via deriveBrandSalesFromDurable. READ-ONLY: it returns a payload and
// writes nothing.
//
// PUBLICATION RECOVERY WP10b: the former refreshCorrectedBrandSalesForAccount (the api/datadoe.js brand-sales refresh=1
// writer: an UNFENCED saveReportSnapshot of the route-owned live key "brand-sales" through a CAS-guarded backfill store)
// is REMOVED. brand-sales refresh=1 is now read-only (it serves the latest published row) and the live key is written
// only through the fenced publisher (scheduler / zero-export OLI reconciler / the admin Data Sync Center paid sync). This
// module therefore imports NO snapshot writer.

import * as sb from "../supabase.js";
import { getDataDoeConnections } from "../datadoe-connections.js";
import { organizationFingerprint } from "../source-identity.js";
import { isPrimaryAccountId } from "./brand-membership.js";
import { getEnrichedOliHistoryRows } from "../sync/oli-enriched-history.js";
import { deriveBrandSalesFromDurable } from "./brand-sales-backfill.js";

const S = (v) => (v == null ? "" : String(v));

// Durable-ONLY readers (no DataDoe adapter -> a create-export is structurally impossible here).
const DURABLE_READERS = {
  // Enriched OLI history: priced rollup + internal missing/zero-price sales estimates (same canonical calculation
  // the scheduler-published Brand Sales snapshot uses), so the derive serves the SAME Total Sales.
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
 * Derive the CORRECTED brand-sales payload for one account from durable evidence (zero export, zero writes). Returns
 * { payload, to, sourceRefreshedAt } or { notReady: <reason> }. Never a raw ORDER_SALES fold.
 */
export async function deriveCorrectedBrandSalesForAccount({ accountId, from, to }) {
  const account = await primaryDirectoryAccount(accountId);
  if (!account) return { notReady: "account-not-in-primary-directory" };
  const organizationFingerprint = primaryOrgFingerprint();
  if (!organizationFingerprint) return { notReady: "no-primary-connection" };
  return deriveBrandSalesFromDurable({ account, from, to, organizationFingerprint, connectionId: "primary", readers: DURABLE_READERS });
}
