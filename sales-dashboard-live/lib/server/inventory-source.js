// Phase 2 of the Listings inventory cutover: ONE per-account inventory-source decision shared by every consumer
// (FBA Shipment Plan, Brand View, Product Reporting, Listing Health v3, Sales Movers, Buy Box Loss). PURE (no I/O).
// 7-bit ASCII, LF.
//
// FBA Inventory Health keeps running in phase 2. An account uses its validated Listings snapshot
// (lib/server/listings-inventory.js listingsValidation); otherwise its LAST VALID FBA Inventory Health snapshot as a
// clearly labelled fallback; otherwise inventory is Unavailable. Health creates stop only in phase 3, when no account
// needs the fallback.
//
// The fallback never re-labels Health values as Listings ones:
//   fbaAvailable = Health available; fbaInbound = working + shipped + received (Health's inbound buckets; the
//   2026-10-07 canary measured it equal to Listings fba_quantity_inbound on 1,933 of 1,938 SKUs);
//   fbaReserved / fbaFcTransfer = null (Health's reserved buckets have different definitions -- Health fc_transfer
//   includes inbound units -- so they are shown as unavailable, never as Listings figures);
//   AWD = the account's Listings AWD fields when the marketplace is AWD-eligible (a blank stays unknown).
// Identity for a SOLD ASIN that Health does not list: the Listings fold says merchant-fulfilled-only -> "mfn-only";
// otherwise "absent" (unknown). Health rows are the latest snapshot date only.

import { foldListingsInventory, listingsValidation, canonicalMarketplace } from "./listings-inventory.js";

export const INVENTORY_SOURCE_LISTINGS = "listings";
export const INVENTORY_SOURCE_HEALTH_FALLBACK = "health-fallback";
export const INVENTORY_SOURCE_UNAVAILABLE = "unavailable";
// The saved FBA Inventory Health snapshot is a READ-ONLY BRIDGE once Health exports stop (owner decision 2026-10-08):
// it may drive figures (and replenishment) only while its snapshot date is no older than this many days before the
// report's as-of -- the SAME validated lag the insight reports already apply to a saved Listings snapshot
// (lib/server/reports/common.js INSIGHT_LISTINGS_MAX_CYCLE_LAG_DAYS = 2). Older -> inventory unavailable, never 0.
export const HEALTH_BRIDGE_MAX_AGE_DAYS = 2;
const addDaysIso = (d, n) => { const t = Date.parse(String(d).slice(0, 10) + "T00:00:00Z"); return Number.isFinite(t) ? new Date(t + n * 86400000).toISOString().slice(0, 10) : null; };

const S = (v) => (v == null ? "" : String(v));
const n = (v) => (v === null || v === undefined || v === "" ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
const QTY = ["fbaAvailable", "fbaInbound", "fbaReserved", "fbaFcTransfer", "awdAvailable", "awdInbound"];

/**
 * Fold the latest FBA Inventory Health snapshot (one account) into the SAME per-ASIN shape as the Listings fold.
 *   healthRows   -- the account's Health rows (may span several dates; only the latest date is used).
 *   marketplace  -- the account's marketplace: a row of ANOTHER marketplace is excluded and counted (foreignRows) -- the
 *                   caller treats any as an integrity failure (the Health snapshot is then not used).
 *   listingsFold -- this account's Listings fold (identity / channel / AWD evidence), may be null.
 *   awdEligible  -- AWD-capable marketplace.
 * Rules (never a guessed figure):
 *   - a quantity cell that is blank stays unknown (null); a negative or non-numeric cell is invalid -> null (counted);
 *   - EXCEPTION, evidence-based: a BLANK Health `available` is filled with 0 ONLY when this account's Listings reports an
 *     explicit fba_quantity_available of 0 for the same SKU (measured 2026-10-08: all 55 blank-available Health SKUs that
 *     Listings also lists were an explicit Listings 0 across 10 accounts; the 16 not in Listings stay unknown);
 *   - duplicate rows of one SKU: identical -> once; any difference -> the SKU's quantities unknown (healthConflicts);
 *   - a row without child_asin is not dropped silently: counted in missingAsinRows (+ whether it holds stock);
 *   - AWD per ASIN comes from the Listings fold (eligible marketplace only; blank stays unknown).
 * Returns { date, rowCount, foreignRows, invalidCells, missingAsinRows, missingAsinWithStock, availableFilledFromListings,
 *           healthConflicts:[sku], skus: Map(sku -> { sku, asin, fnsku, channel:null, <qty> }), byAsin: Map(...) }.
 */
export function foldHealthInventory(healthRows, { marketplace = "", listingsFold = null, awdEligible = false } = {}) {
  const rows = Array.isArray(healthRows) ? healthRows : [];
  const mkt = canonicalMarketplace(marketplace);
  const out = { date: null, rowCount: rows.length, foreignRows: 0, invalidCells: 0, missingAsinRows: 0, missingAsinWithStock: 0, availableFilledFromListings: 0, healthConflicts: [], skus: new Map(), byAsin: new Map() };
  for (const r of rows) { const d = S(r && r.date).slice(0, 10); if (d && (!out.date || d > out.date)) out.date = d; }
  const cell = (v) => {
    if (v === null || v === undefined || (typeof v === "string" && v.trim() === "")) return null;
    const x = Number(v);
    if (!Number.isFinite(x) || x < 0) { out.invalidCells += 1; return null; }
    return x;
  };
  const bySku = new Map();
  for (const r of rows) {
    if (!r || S(r.date).slice(0, 10) !== out.date) continue;
    const rowMkt = canonicalMarketplace(r.marketplace_country_code);
    if (mkt && rowMkt && rowMkt !== mkt) { out.foreignRows += 1; continue; }
    const asin = S(r.child_asin).trim().toUpperCase();
    const sku = S(r.sku).trim();
    const inb = [cell(r.inbound_working), cell(r.inbound_shipped), cell(r.inbound_received)];
    let available = cell(r.available);
    const lst = listingsFold && sku ? listingsFold.skus.get(sku) : null;
    if (available === null && (r.available === null || r.available === undefined || S(r.available).trim() === "") && lst && !lst.conflict && lst.fbaAvailable === 0) {
      available = 0; out.availableFilledFromListings += 1;
    }
    const q = { fbaAvailable: available, fbaInbound: inb.some((v) => v === null) ? null : inb.reduce((x, y) => x + y, 0), fbaReserved: null, fbaFcTransfer: null };
    if (!asin) {
      out.missingAsinRows += 1;
      if (q.fbaAvailable === null || q.fbaAvailable > 0 || q.fbaInbound === null || q.fbaInbound > 0) out.missingAsinWithStock += 1;
      continue;
    }
    const key = sku || `asin:${asin}`;
    const prev = bySku.get(key);
    const entry = { sku, asin, fnsku: S(r.fnsku).trim() || null, channel: null, ...q, conflictAsins: [asin] };
    if (!prev) { bySku.set(key, entry); continue; }
    if (prev.asin !== entry.asin || prev.fnsku !== entry.fnsku || ["fbaAvailable", "fbaInbound"].some((k) => prev[k] !== entry[k])) {
      prev.conflict = true; prev.fbaAvailable = null; prev.fbaInbound = null;
      if (!prev.conflictAsins.includes(entry.asin)) prev.conflictAsins.push(entry.asin);
      if (!out.healthConflicts.includes(key)) out.healthConflicts.push(key);
    }
  }
  for (const e of bySku.values()) {
    const lsAsin = listingsFold ? listingsFold.byAsin.get(e.asin) : null;
    e.awdAvailable = awdEligible && lsAsin ? lsAsin.awdAvailable : null;
    e.awdInbound = awdEligible && lsAsin ? lsAsin.awdInbound : null;
    e.awdAssumedZero = !!(awdEligible && lsAsin && lsAsin.awdAssumedZero);
    if (e.sku) out.skus.set(e.sku, e);
    // A conflicting SKU seen under several ASINs attaches (unknown) to EVERY one of them -- no ASIN silently vanishes.
    for (const asin of (e.conflict ? e.conflictAsins : [e.asin])) {
      let a = out.byAsin.get(asin);
      if (!a) {
        const la = listingsFold ? listingsFold.byAsin.get(asin) : null;
        a = { asin, skus: [], fbaContext: "fba", conflict: false, fbaAvailable: 0, fbaInbound: 0, fbaReserved: null, fbaFcTransfer: null,
          awdAvailable: awdEligible && la ? la.awdAvailable : null, awdInbound: awdEligible && la ? la.awdInbound : null, awdAssumedZero: !!(awdEligible && la && la.awdAssumedZero) };
        out.byAsin.set(asin, a);
      }
      if (e.sku) a.skus.push(e.sku);
      if (e.conflict) a.conflict = true;
      for (const k of ["fbaAvailable", "fbaInbound"]) a[k] = (a[k] === null || e[k] === null) ? null : a[k] + e[k];
    }
    delete e.conflictAsins;
  }
  out.healthConflicts.sort();
  for (const a of out.byAsin.values()) a.skus.sort((x, y) => x.localeCompare(y));
  return out;
}

/**
 * The per-account inventory decision.
 *   listingsRows -- the account's isolated canonical Listings rows (saved snapshot), may be empty.
 *   healthRows   -- the account's last valid FBA Inventory Health rows, may be empty.
 *   marketplace, awdEligible, asinForSku -- as for foldListingsInventory.
 * Returns {
 *   source: "listings" | "health-fallback" | "unavailable",
 *   listingsReasons: [why Listings is not validated] (empty when source = listings),
 *   healthReasons: [why the Health fallback is not usable] (when source = unavailable),
 *   byAsin: Map(asin -> { asin, skus, fbaContext:"fba"|"mfn-only", conflict, <six quantities> }),
 *   skus:   Map(sku -> { sku, asin, fnsku, channel, conflict?, <quantities> }) of the SELECTED source,
 *   listingsFold, health (the Health fold, fallback only), healthDate,
 *   conflicts, resolvedConflicts, unattributed   (the Listings fold's reports, always returned for transparency)
 * }
 * A consumer looks up byAsin.get(asin); when absent the ASIN is "absent" (unknown) -- never 0.
 */
export function selectAccountInventory({ listingsRows = [], healthRows = [], marketplace = "", awdEligible = false, asinForSku = null, asOf = null, bridgeMaxAgeDays = HEALTH_BRIDGE_MAX_AGE_DAYS } = {}) {
  const listingsFold = foldListingsInventory(listingsRows || [], { marketplace: canonicalMarketplace(marketplace), awdEligible, asinForSku });
  const validation = listingsValidation(listingsRows || [], listingsFold);
  const reports = { conflicts: listingsFold.conflicts, resolvedConflicts: listingsFold.resolvedConflicts, unattributed: listingsFold.unattributed, awdAssumedZeroSkus: listingsFold.awdAssumedZeroSkus };
  if (validation.ok) {
    return { source: INVENTORY_SOURCE_LISTINGS, listingsReasons: [], healthReasons: [], byAsin: listingsFold.byAsin, skus: listingsFold.skus, listingsFold, health: null, healthDate: null, ...reports };
  }
  // A fallback uses Listings only as identity / channel / AWD evidence of THIS account's marketplace (foreign rows are an
  // integrity failure; the identity map then cannot be trusted either).
  const identityFold = listingsFold.foreignRows === 0 ? listingsFold : null;
  const health = foldHealthInventory(healthRows || [], { marketplace, listingsFold: identityFold, awdEligible });
  const healthReasons = [];
  if (!health.date || health.byAsin.size === 0) healthReasons.push("health-snapshot-missing");
  if (health.foreignRows > 0) healthReasons.push("health-foreign-marketplace-rows");
  // READ-ONLY bridge freshness: a saved Health snapshot older than bridgeMaxAgeDays before the report as-of never drives
  // figures (no Health export refreshes it any more). Without an as-of the bridge cannot be proven fresh -> refused.
  if (health.date && !healthReasons.length) {
    const floor = asOf ? addDaysIso(asOf, -Number(bridgeMaxAgeDays)) : null;
    if (!floor) healthReasons.push("health-bridge-as-of-missing");
    else if (health.date < floor) healthReasons.push(`health-bridge-stale:${health.date}`);
  }
  if (!healthReasons.length) {
    const byAsin = new Map(health.byAsin);
    const skus = new Map(health.skus);
    // A Listings-only merchant-fulfilled product (no Health record) is "mfn-only" -- never an FBA zero / stockout.
    if (identityFold) {
      for (const [asin, a] of identityFold.byAsin) if (!byAsin.has(asin) && a.fbaContext === "mfn-only") byAsin.set(asin, { ...a });
      for (const [sku, e] of identityFold.skus) if (!skus.has(sku) && byAsin.get(e.asin)?.fbaContext === "mfn-only") skus.set(sku, { ...e });
      for (const e of skus.values()) if (e.channel === null && identityFold.skus.get(e.sku)) e.channel = identityFold.skus.get(e.sku).channel;
    }
    return { source: INVENTORY_SOURCE_HEALTH_FALLBACK, listingsReasons: validation.reasons, healthReasons: [], byAsin, skus, listingsFold, health, healthDate: health.date, ...reports };
  }
  return { source: INVENTORY_SOURCE_UNAVAILABLE, listingsReasons: validation.reasons, healthReasons, byAsin: new Map(), skus: new Map(), listingsFold, health, healthDate: null, ...reports };
}

// The consumer-facing label for an account's inventory source (no inventory DATE is claimed for Listings).
export function inventorySourceLabel({ source, listingsRefreshedAt = null, healthDate = null, listingsReasons = [] } = {}) {
  if (source === INVENTORY_SOURCE_LISTINGS) return listingsRefreshedAt ? `Listings refreshed ${listingsRefreshedAt}` : "Listings (refresh time unavailable)";
  if (source === INVENTORY_SOURCE_HEALTH_FALLBACK) return `FBA Inventory Health snapshot ${healthDate || "(date unavailable)"} (saved, no longer refreshed -- temporary bridge: ${listingsReasons.join(", ") || "Listings not validated"})`;
  return "FBA inventory unavailable";
}

/**
 * A fold-shaped view of a selection for the shared roll-ups (listings-inventory.js brandCountryInventory): byAsin of the
 * SELECTED source; the Listings fold's `unattributed` only when Listings is the source (a Health fallback carries real
 * ASINs, so Listings' unplaced SKUs do not apply to it).
 */
export function selectionFoldView(selection) {
  const sel = selection || {};
  const none = { skus: 0, skusWithStock: 0, fbaAvailable: 0, sample: [] };
  return { byAsin: sel.byAsin || new Map(), unattributed: sel.source === INVENTORY_SOURCE_LISTINGS ? (sel.unattributed || none) : none };
}
