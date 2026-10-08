// Pieces every insight report needs: the ASIN/brand map, honest source
// freshness, and the account's SAVED inventory evidence -- its saved Listings
// rows and its last SAVED FBA Inventory Health snapshot (the dated read-only
// bridge) -- the two inputs of the per-account stock-source decision
// (derivation-core insightInventory: validated Listings, else the bridge within
// its freshness threshold, else Unavailable). Listings inventory CUTOVER: no
// FBA Inventory Health export is requested here (the former
// fetchInventorySnapshot is removed; lib/server/datadoe.js refuses the source).

import {
  addDaysStr,
  fetchExportRows,
  fetchExportRowsStrict,
  isDateStr,
  num,
} from "../datadoe.js";
import { getSourceListingsSnapshot, getSourceSnapshotPayload } from "../supabase.js";
import { organizationFingerprint as orgFingerprintOf } from "../source-identity.js";
import { readSavedHealthBridge } from "./health-bridge.js";
import {
  PRODUCT_CATALOG,
  ROW_LIMITS,
  SALES_TRAFFIC,
} from "./sources.js";

export const CATALOG_COLUMNS = ["child_asin", "parent_asin", "product_name", "product_brand"];

export function brandLabel(value) {
  return String(value || "").trim() || "Unassigned";
}

/**
 * ASIN -> { name, brand } for the selected account, plus the distinct brand
 * list the shared header selector needs.
 *
 * Product Catalog by ASIN has no date column, so no from/to is sent and the
 * export orders by child_asin.
 */
export async function fetchCatalog(apiKey, ids) {
  // Strict: a truncated catalog would silently drop product names and, worse,
  // brands — which would make the shared header brand filter hide real rows.
  const rows = await fetchExportRowsStrict(
    apiKey, PRODUCT_CATALOG.id, CATALOG_COLUMNS, ids, null, null, ROW_LIMITS.catalog,
    { orderByColumn: "child_asin", orderByDirection: "ASC" },
    "Product catalog export"
  );
  const byAsin = new Map();
  const brands = new Set();
  for (const row of rows) {
    const asin = String(row.child_asin || "").trim();
    if (!asin) continue;
    const brand = String(row.product_brand || "").trim();
    if (brand) brands.add(brand);
    if (!byAsin.has(asin)) {
      byAsin.set(asin, {
        name: String(row.product_name || "").trim() || null,
        brand: brand || null,
        parentAsin: String(row.parent_asin || "").trim() || null,
      });
    }
  }
  return {
    byAsin,
    catalogBrands: [...brands].sort((a, b) => a.localeCompare(b)),
  };
}

/**
 * The latest date on which Sales & Traffic actually reported units for this
 * account. The source can emit a newer row with zero sales before its data
 * lands, so anchoring on that placeholder would silently understate a window.
 * Returns null when nothing was reported, and the caller must then say so
 * instead of showing zeroes.
 */
export async function fetchSalesTrafficLatestDate(apiKey, ids, from, to) {
  const rows = await fetchExportRows(
    apiKey, SALES_TRAFFIC.id, ["date"], ids, from, to, ROW_LIMITS.dateRollup,
    {
      groupBy: ["date"],
      aggregations: [{ column: "total_units", aggregation: "sum", alias: "units_sum" }],
      orderByColumn: "date",
      orderByDirection: "ASC",
    }
  );
  let latest = null;
  for (const row of rows) {
    if (num(row.units_sum) > 0 && row.date && (!latest || row.date > latest)) latest = row.date;
  }
  return latest;
}

/* ---------------------------------------------------------------- saved Listings (zero export) */

// The insight reports read the account's SAVED durable Listings snapshot (the source_listings_snapshot pointer + its
// content-addressed payload, written by the scheduled Listings run) as the PREFERRED FBA stock source; the per-account
// decision (derivation-core insightInventory) uses it only when it validates, else the account's last SAVED FBA
// Inventory Health snapshot as the dated read-only bridge (within its threshold), else Unavailable. ZERO DataDoe exports.
// Freshness: the pointer's as_of is the scheduled cycle (D-1) that saved it. It is accepted only when that cycle is no
// more than INSIGHT_LISTINGS_MAX_CYCLE_LAG_DAYS before the report's as-of (the browser's as-of is the viewer's local date
// and each region's cycle runs once a day); anything older means a scheduled Listings run was missed, and Listings is
// not used (the bridge may be, labelled) rather than shown as current.
export const INSIGHT_LISTINGS_MAX_CYCLE_LAG_DAYS = 2;

/**
 * The account's saved Listings rows for the stock-source decision. NEVER throws: every failure is
 * { rows: null, unavailableReason } so the report falls back to the saved Health bridge (or Unavailable), never 0.
 *   accountId -- the account's RAW DataDoe seller id (the durable pointer's account_id). connectionId -- "primary" |
 *   "dd-secondary". asOf -- the report's as-of. readPointer / readPayload -- injectable (tests); default to the
 *   read-only Supabase readers.
 * Returns { rows, unavailableReason, refreshedAt, marketplace }.
 */
export async function readSavedListingsRows({
  apiKey = null, organizationFingerprint = null, connectionId = "primary", accountId, asOf,
  readPointer = getSourceListingsSnapshot, readPayload = getSourceSnapshotPayload,
} = {}) {
  const unavailable = (reason) => ({ rows: null, unavailableReason: reason, refreshedAt: null, marketplace: null });
  let org = organizationFingerprint ? String(organizationFingerprint) : null;
  if (!org && apiKey) {
    try { org = orgFingerprintOf(apiKey); } catch { org = null; }
  }
  const account = String(accountId || "").trim();
  if (!org || !account || account.includes(":") || !isDateStr(asOf)) return unavailable("listings-identity-unavailable");
  let pointer;
  try {
    const read = await readPointer({ organizationFingerprint: org, connectionId, accountId: account });
    if (!read || read.read !== "ok") return unavailable(read && read.read === "schema-missing" ? "listings-snapshot-missing" : "listings-snapshot-read-failed");
    pointer = read.snapshot;
  } catch {
    return unavailable("listings-snapshot-read-failed");
  }
  if (!pointer || !pointer.object_path) return unavailable("listings-snapshot-missing");
  const cycle = String(pointer.as_of || "").slice(0, 10);
  if (!isDateStr(cycle) || cycle < addDaysStr(asOf, -INSIGHT_LISTINGS_MAX_CYCLE_LAG_DAYS)) return unavailable("listings-snapshot-stale");
  let rows;
  try {
    const payload = await readPayload(String(pointer.object_path));
    rows = payload && Array.isArray(payload.rows) ? payload.rows : null;
  } catch {
    rows = null;
  }
  if (!rows) return unavailable("listings-payload-unreadable");
  if (pointer.row_count != null && Number(pointer.row_count) !== rows.length) return unavailable("listings-payload-row-count-mismatch");
  return { rows, unavailableReason: null, refreshedAt: pointer.validated_at || null, marketplace: String(pointer.marketplace || "") || null };
}

/**
 * BOTH saved inventory inputs of one insight report (READ-ONLY; zero DataDoe; never throws): the account's saved
 * Listings rows (readSavedListingsRows, keyed by the RAW seller id) and its last SAVED durable FBA Inventory Health
 * snapshot (lib/server/reports/health-bridge.js readSavedHealthBridge -- the dated read-only bridge). The SAME function
 * feeds the manual refresh builders and the scheduled derive's context loader, so both decide the stock source on
 * identical evidence.
 *   ids      -- [raw seller id] (exactly one account).
 *   to       -- the report as-of (the Listings lag + the bridge threshold are measured against it).
 *   listings -- { organizationFingerprint, connectionId, readPointer, readPayload } for the Listings pointer, plus
 *               healthScopeKey (the durable Health scope_key; default the raw seller id) and readHealthPointer /
 *               readHealthPayload (injectable; default the read-only Supabase readers).
 * Returns { listings: { rows, unavailableReason, refreshedAt, marketplace }, healthBridge: { rows, unavailableReason,
 *   snapshotDate, savedAt } }.
 */
export async function readInsightInventoryEvidence({ apiKey = null, ids, to, listings = {} } = {}) {
  const opt = listings && typeof listings === "object" ? listings : {};
  const rawSellerId = String((Array.isArray(ids) ? ids[0] : ids) || "").trim();
  const savedListings = await readSavedListingsRows({
    apiKey, accountId: rawSellerId, asOf: to,
    ...(opt.organizationFingerprint ? { organizationFingerprint: opt.organizationFingerprint } : {}),
    ...(opt.connectionId ? { connectionId: opt.connectionId } : {}),
    ...(typeof opt.readPointer === "function" ? { readPointer: opt.readPointer } : {}),
    ...(typeof opt.readPayload === "function" ? { readPayload: opt.readPayload } : {}),
  });
  const healthBridge = await readSavedHealthBridge({
    apiKey,
    organizationFingerprint: opt.organizationFingerprint || null,
    connectionId: opt.connectionId || "primary",
    accountId: String(opt.healthScopeKey || "").trim() || rawSellerId,
    rawSellerId,
    ...(typeof opt.readHealthPointer === "function" ? { readPointer: opt.readHealthPointer } : {}),
    ...(typeof opt.readHealthPayload === "function" ? { readPayload: opt.readHealthPayload } : {}),
  });
  return { listings: savedListings, healthBridge };
}

/** Sum helper for grouped exports that return `<alias>` or the raw column. */
export function sumField(row, alias, column) {
  return num(row[alias] ?? row[column]);
}

export { fetchExportRowsStrict };
