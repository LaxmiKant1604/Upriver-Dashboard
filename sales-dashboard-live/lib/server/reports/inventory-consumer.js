// Phase 2 of the Listings inventory cutover -- the CONSUMER glue shared by Product Reporting, Listing Health v3, Sales
// Movers, Buy Box Loss and Listing Health v1 over the ONE per-account source decision (lib/server/inventory-source.js
// selectAccountInventory). PURE (no I/O, no transport). 7-bit ASCII, LF.
//
// Each consumer hands over the account's canonical Listings rows (or why it could not load them) and the account's LAST
// SAVED FBA Inventory Health snapshot (source_snapshots 'fba-inventory-health', read-only -- no Health export is created
// any more: Listings inventory CUTOVER, owner decision 2026-10-08) plus the report's as-of; this module returns the core
// selection plus:
//   * skus   -- the SELECTED source's per-SKU figures (Listings: the shared fold's SKUs; Health bridge: the latest
//               Health date's SKUs, with the FNSKU each row carries, and a Listings-only merchant-fulfilled SKU as
//               mfn-only; unavailable: none). A consumer never mixes the two sources inside one account.
//   * label  -- "Listings refreshed <time>" | "FBA Inventory Health snapshot <date> (saved, no longer refreshed --
//               temporary bridge: <reasons>)" | "FBA inventory unavailable".
//   * healthRowsAtDate -- the bridge's own latest-date rows (only when the bridge is the source), for IDENTITY evidence
//               only (e.g. the selling-partner id of the pan-EU count-once rule). Health-only METRICS (days of supply,
//               units shipped t30, competitive prices, unfulfillable, Health reserved / inbound buckets) are REMOVED from
//               every consumer: they are never shown from a stale bridge.
// The bridge drives figures only while its snapshot date >= asOf - HEALTH_BRIDGE_MAX_AGE_DAYS (the core decides; without
// an asOf it is refused). Unknown stays null (never 0); a Health cell that is present but not a finite number >= 0 is
// unknown, never negative.

import {
  HEALTH_BRIDGE_MAX_AGE_DAYS,
  INVENTORY_SOURCE_HEALTH_FALLBACK,
  INVENTORY_SOURCE_LISTINGS,
  INVENTORY_SOURCE_UNAVAILABLE,
  foldHealthInventory,
  inventorySourceLabel,
  selectAccountInventory,
} from "../inventory-source.js";
import { canonicalMarketplace, listingsAsin } from "../listings-inventory.js";

// The payload model a phase-2 consumer stamps on its inventory fields: the per-account source decision (validated
// Listings, else the dated read-only FBA Inventory Health bridge, else Unavailable). A payload without it predates phase 2.
export const INVENTORY_SOURCE_MODEL = "inventory-source-v1";
export { HEALTH_BRIDGE_MAX_AGE_DAYS, INVENTORY_SOURCE_HEALTH_FALLBACK, INVENTORY_SOURCE_LISTINGS, INVENTORY_SOURCE_UNAVAILABLE };

const S = (v) => (v == null ? "" : String(v));
const HEALTH_QTY_FIELDS = Object.freeze(["available", "inbound_working", "inbound_shipped", "inbound_received"]);

// A Health quantity cell: null / undefined / "" stay as they are (unknown); a finite number >= 0 (or a numeric string)
// is kept; anything else (negative, non-numeric) becomes null -- unknown, never a negative stock.
function cleanHealthQuantity(v) {
  if (v === null || v === undefined || v === "") return v;
  const n = typeof v === "number" ? v : (typeof v === "string" && /^\s*\d+(\.\d+)?\s*$/.test(v) ? Number(v) : NaN);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * The account's Health rows made safe for the core fold: rows of another marketplace are dropped (counted), a
 * present-but-invalid quantity cell is unknown (null), and duplicate rows of one SKU on one date are kept ONCE when
 * every quantity agrees -- otherwise that SKU's quantities are unknown (duplicates are never summed).
 * Returns { rows, foreignRows, duplicateConflicts }.
 */
export function sanitizeHealthRows(healthRows, marketplace = "") {
  const mkt = canonicalMarketplace(marketplace);
  const list = Array.isArray(healthRows) ? healthRows : [];
  let foreignRows = 0;
  const kept = [];
  const seen = new Map(); // date|sku -> index in kept
  const conflicted = new Set();
  for (const r of list) {
    if (!r || typeof r !== "object") continue;
    const rowMkt = canonicalMarketplace(r.marketplace_country_code);
    if (mkt && rowMkt && rowMkt !== mkt) { foreignRows += 1; continue; }
    const clean = { ...r };
    for (const f of HEALTH_QTY_FIELDS) if (Object.prototype.hasOwnProperty.call(clean, f)) clean[f] = cleanHealthQuantity(clean[f]);
    const sku = S(clean.sku).trim();
    const key = `${S(clean.date).slice(0, 10)}|${sku}`;
    if (sku && seen.has(key)) {
      const prev = kept[seen.get(key)];
      const same = HEALTH_QTY_FIELDS.every((f) => (prev[f] ?? null) === (clean[f] ?? null))
        && S(prev.child_asin).trim().toUpperCase() === S(clean.child_asin).trim().toUpperCase();
      if (!same) conflicted.add(key);
      continue;
    }
    if (sku) seen.set(key, kept.length);
    kept.push(clean);
  }
  for (const key of conflicted) {
    const row = kept[seen.get(key)];
    for (const f of HEALTH_QTY_FIELDS) row[f] = null;
  }
  return { rows: kept, foreignRows, duplicateConflicts: conflicted.size };
}

/**
 * An in-account, UNAMBIGUOUS SKU -> ASIN resolver from the account's own rows (e.g. its sales): a SKU seen with exactly
 * one real ASIN resolves to it; a SKU seen with several ASINs (or none) resolves to null. Feeds the core fold's R2 /
 * missing-ASIN resolution. Returns (sku) => asin | null.
 */
export function asinForSkuFrom(rows, { skuKey = "sku", asinKey = "child_asin" } = {}) {
  const map = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r) continue;
    const sku = S(r[skuKey]).trim();
    const asin = listingsAsin(r[asinKey]);
    if (!sku || !asin) continue;
    if (!map.has(sku)) map.set(sku, new Set());
    map.get(sku).add(asin);
  }
  return (sku) => {
    const set = map.get(S(sku).trim());
    return set && set.size === 1 ? [...set][0] : null;
  };
}

/**
 * The per-account consumer selection.
 *   listingsRows              -- the account's canonical Listings rows (saved snapshot / fragment), may be empty.
 *   listingsUnavailableReason -- set when the consumer could not load the account's Listings at all (no pointer, an
 *                                unreadable payload, a pointer of another marketplace, not loaded by this derive, ...):
 *                                Listings is then empty and this reason REPLACES the core's generic "listings-empty".
 *   listingsRefreshedAt       -- the Listings fetch time (shown only when Listings is the source).
 *   healthRows                -- the account's LAST SAVED FBA Inventory Health rows (the read-only bridge; never a new
 *                                Health export).
 *   healthUnavailableReason   -- why there are no Health rows (reported only when the result is unavailable).
 *   asOf                      -- the report's as-of (YYYY-MM-DD). REQUIRED for the bridge: it drives figures only while
 *                                its snapshot date >= asOf - HEALTH_BRIDGE_MAX_AGE_DAYS; without it the bridge is refused.
 *   marketplace, awdEligible (default false), asinForSku -- as for the core.
 * Returns the core selection plus { skus, label, listingsRefreshedAt, healthRowsAtDate, unavailableReasons, foreignHealthRows }.
 *   skus: Map(sku -> { sku, asin|null, fnsku|null, channel|null, fbaContext:"fba"|"mfn-only", fbaAvailable, fbaInbound,
 *                      conflict:boolean })
 *   unavailableReasons (source unavailable): the Listings reasons + why the bridge was not used (the core's typed reason,
 *                      e.g. health-bridge-stale:<date> / health-bridge-as-of-missing, else healthUnavailableReason).
 */
export function selectConsumerInventory({
  listingsRows = [], listingsUnavailableReason = null, listingsRefreshedAt = null,
  healthRows = [], healthUnavailableReason = null,
  marketplace = "", awdEligible = false, asinForSku = null,
  asOf = null, bridgeMaxAgeDays = HEALTH_BRIDGE_MAX_AGE_DAYS,
} = {}) {
  const lRows = listingsUnavailableReason ? [] : (Array.isArray(listingsRows) ? listingsRows : []);
  const health = sanitizeHealthRows(healthRows, marketplace);
  const sel = selectAccountInventory({ listingsRows: lRows, healthRows: health.rows, marketplace, awdEligible, asinForSku, asOf, bridgeMaxAgeDays });
  const listingsReasons = listingsUnavailableReason && sel.source !== INVENTORY_SOURCE_LISTINGS ? [S(listingsUnavailableReason)] : sel.listingsReasons;
  const skus = new Map();
  let healthRowsAtDate = [];
  if (sel.source === INVENTORY_SOURCE_LISTINGS) {
    for (const e of sel.listingsFold.skus.values()) {
      const conflict = Array.isArray(e.conflict) && e.conflict.length > 0;
      const mfnOnly = !conflict && S(e.channel).toUpperCase() === "DEFAULT"
        && e.fbaAvailable === 0 && e.fbaInbound === 0 && e.fbaReserved === 0 && e.fbaFcTransfer === 0;
      skus.set(e.sku, {
        sku: e.sku, asin: e.asin || null, fnsku: e.fnsku || null, channel: conflict ? null : (e.channel || null),
        fbaContext: mfnOnly ? "mfn-only" : "fba",
        fbaAvailable: mfnOnly ? null : e.fbaAvailable, fbaInbound: mfnOnly ? null : e.fbaInbound, conflict,
      });
    }
  } else if (sel.source === INVENTORY_SOURCE_HEALTH_FALLBACK) {
    // The SAME identity evidence the core used (never Listings rows of another marketplace).
    const identityFold = sel.listingsFold && sel.listingsFold.foreignRows === 0 ? sel.listingsFold : null;
    const h = foldHealthInventory(health.rows, { listingsFold: identityFold, awdEligible });
    healthRowsAtDate = health.rows.filter((r) => S(r.date).slice(0, 10) === h.date);
    const fnskuOf = new Map();
    for (const r of healthRowsAtDate) { const sku = S(r.sku).trim(); if (sku && !fnskuOf.has(sku)) fnskuOf.set(sku, S(r.fnsku).trim() || null); }
    for (const e of h.skus.values()) {
      skus.set(e.sku, { sku: e.sku, asin: e.asin || null, fnsku: fnskuOf.get(e.sku) || null, channel: null, fbaContext: "fba",
        fbaAvailable: e.fbaAvailable, fbaInbound: e.fbaInbound, conflict: false });
    }
    // A Listings-only merchant-fulfilled SKU (no Health record) is mfn-only -- never an FBA zero / stockout.
    if (identityFold) {
      for (const e of identityFold.skus.values()) {
        if (skus.has(e.sku) || (Array.isArray(e.conflict) && e.conflict.length)) continue;
        const mfnOnly = S(e.channel).toUpperCase() === "DEFAULT" && e.fbaAvailable === 0 && e.fbaInbound === 0 && e.fbaReserved === 0 && e.fbaFcTransfer === 0;
        if (mfnOnly) skus.set(e.sku, { sku: e.sku, asin: e.asin || null, fnsku: e.fnsku || null, channel: "DEFAULT", fbaContext: "mfn-only", fbaAvailable: null, fbaInbound: null, conflict: false });
      }
    }
  }
  const refreshedAt = sel.source === INVENTORY_SOURCE_LISTINGS && S(listingsRefreshedAt).trim() ? S(listingsRefreshedAt).trim() : null;
  // Why the bridge was not used: the core's typed refusal when saved Health rows WERE handed over (stale / no as-of /
  // foreign rows / no usable row), else the caller's reason for having none.
  const bridgeWhy = health.rows.length && Array.isArray(sel.healthReasons) && sel.healthReasons.length
    ? sel.healthReasons.map(S)
    : [S(healthUnavailableReason) || "health-snapshot-missing"];
  const unavailableReasons = sel.source === INVENTORY_SOURCE_UNAVAILABLE ? [...listingsReasons, ...bridgeWhy] : [];
  return {
    ...sel,
    listingsReasons,
    skus,
    listingsRefreshedAt: refreshedAt,
    healthRowsAtDate,
    unavailableReasons,
    foreignHealthRows: health.foreignRows,
    label: inventorySourceLabel({ source: sel.source, listingsRefreshedAt: refreshedAt, healthDate: sel.healthDate, listingsReasons }),
  };
}

/**
 * The payload-level inventory fields a single-account phase-2 consumer carries (LHv3, Sales Movers, Buy Box Loss,
 * Listing Health v1). No inventory DATE is claimed for Listings; a Health fallback carries its snapshot date.
 */
export function inventorySourceFields(sel) {
  const s = sel || { source: INVENTORY_SOURCE_UNAVAILABLE, listingsReasons: [], unavailableReasons: [] };
  const source = s.source || INVENTORY_SOURCE_UNAVAILABLE;
  return {
    inventoryModel: INVENTORY_SOURCE_MODEL,
    inventorySource: source,
    inventorySourceLabel: s.label || inventorySourceLabel({ source }),
    inventoryAvailable: source !== INVENTORY_SOURCE_UNAVAILABLE,
    listingsRefreshedAt: source === INVENTORY_SOURCE_LISTINGS ? (s.listingsRefreshedAt || null) : null,
    inventoryHealthDate: source === INVENTORY_SOURCE_HEALTH_FALLBACK ? (s.healthDate || null) : null,
    inventoryFallbackReasons: source === INVENTORY_SOURCE_LISTINGS ? [] : [...(s.listingsReasons || [])],
    inventoryUnavailableReasons: source === INVENTORY_SOURCE_UNAVAILABLE ? [...(s.unavailableReasons || [])] : [],
    inventoryResolvedConflicts: source === INVENTORY_SOURCE_LISTINGS ? (s.resolvedConflicts || []).length : 0,
  };
}
