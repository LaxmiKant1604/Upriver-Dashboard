// The durable ACCOUNT-SKU OWNERSHIP authority. For each account we persist, per canonical (marketplace, SKU), the
// trusted evidence that the SKU belongs to that account: the validated fba-plan/v2d-5 directory (which already
// aggregates FBA Inventory Health + US Listings/AWD + OLI sales, each with provenance) PLUS the account's own
// seller-warehouse identities. This is the queryable, indexed source the cross-account ownership check uses instead of
// scanning one OLI table -- so a SKU proven ONLY through inventory, AWD, operational/pending OLI, or another account's
// warehouse is still recognised as owned. The org-wide Product Catalog is NEVER used as ownership proof.
//
// Ownership is CANONICAL-MARKETPLACE scoped (GB==UK): the same SKU text in a different legitimate marketplace is a
// different ownership row, never a false conflict.

import { canonMkt, ownershipKey } from "./warehouse-validation.js";

const S = (v) => String(v == null ? "" : v).trim();

// Build the ownership rows for ONE account from its published v2d-5 snapshot payload + its own warehouse rows.
// Returns [{ marketplace, sku, child_asin, sources }] deduped by canonical (marketplace, sku). `sources` is a sorted
// comma-joined provenance set (inventory/awd/sales/directory/warehouse) for audit -- it never affects the ownership
// decision (presence of the row is what matters).
export function buildOwnershipRows(payload, existingWarehouseRows = []) {
  const p = payload && typeof payload === "object" ? payload : {};
  const marketCountry = canonMkt(p.marketCountry);
  const byKey = new Map(); // canonical "mkt sku" -> { marketplace, sku, child_asin, sources:Set }
  const put = (mktRaw, skuRaw, asinRaw, source) => {
    const sku = S(skuRaw);
    const marketplace = canonMkt(mktRaw) || marketCountry;
    if (!sku || !marketplace) return;
    const key = ownershipKey(marketplace, sku);
    let e = byKey.get(key);
    if (!e) { e = { marketplace, sku, child_asin: "", sources: new Set() }; byKey.set(key, e); }
    const asin = S(asinRaw);
    if (asin && !e.child_asin) e.child_asin = asin; // first proven ASIN wins; blank never overwrites
    if (source) e.sources.add(source);
  };

  for (const entry of Array.isArray(p.accountSkuDirectory) ? p.accountSkuDirectory : []) {
    if (!entry || !entry.sku) continue;
    // The directory entry's provenance (inventory/awd/sales) is the trusted evidence class.
    put(entry.marketplace, entry.sku, entry.childAsin, S(entry.provenance) || "directory");
  }
  for (const w of Array.isArray(existingWarehouseRows) ? existingWarehouseRows : []) {
    if (!w || !w.sku) continue;
    put(w.marketplace ?? w.marketplace_country_code, w.sku, w.child_asin, "warehouse");
  }

  return [...byKey.values()].map((e) => ({
    marketplace: e.marketplace, sku: e.sku, child_asin: e.child_asin,
    sources: [...e.sources].sort().join(","),
  })).sort((a, b) => (a.marketplace + " " + a.sku).localeCompare(b.marketplace + " " + b.sku));
}
