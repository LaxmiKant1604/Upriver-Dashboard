// Listings-based FBA inventory: the ONE pure fold every inventory consumer uses (FBA Shipment Plan, Brand View
// inventory, Product Reporting, Listing Health v3, the insight reports). It replaces the retired FBA Inventory Health
// source. PURE (no I/O). 7-bit ASCII, LF.
//
// The source is the shared canonical DataDoe "Listings" export (LISTINGS_CANONICAL_COLUMNS). Listings is a CURRENT
// per-listing snapshot with NO date column: its values are as of the export's fetch time, never a dated day.
//
// Rules (owner decisions 2026-10-07):
//   * A quantity is a finite number >= 0; null / undefined / "" is UNKNOWN (null) and anything else is invalid (null,
//     reported). Unknown is never read as 0.
//   * Listings carries one row per LISTING, not per SKU: the same SKU can appear on several listings. Rows of one
//     seller + marketplace + SKU are decided as a GROUP and never summed:
//       - identical (ASIN, channel, FNSKU, every FBA / AWD quantity) -> counted ONCE;
//       - QUANTITY conflict (FNSKU or any quantity differs) -> unresolved: the SKU's quantities are unknown;
//       - IDENTITY conflict (only the ASIN and/or channel differ; FNSKU + every quantity agree, i.e. one physical stock
//         reported on several listings) -> resolved ONLY by account-local evidence:
//           R2 ASIN: asinForSku(sku) (the account's own sales, exactly one ASIN) is one of the rows' ASINs;
//           R3 channel: every row reports fba_quantity_available > 0 (Amazon holds FBA stock for the FNSKU) -> FBA;
//         otherwise unresolved (quantities unknown). Resolutions are reported in resolvedConflicts, never silent.
//       A row with a MISSING ASIN (blank / "__EMPTY__") is not a different identity: it takes the group's single real
//       ASIN, else the same account-local sales resolution, else the SKU is unattributed.
//   * listing_fulfillment_channel DEFAULT (merchant-fulfilled) rows are NOT excluded: a DEFAULT row with positive FBA
//     stock keeps it. An ASIN is "mfn-only" when every one of its SKUs is DEFAULT and every FBA quantity is a known 0 --
//     a merchant-fulfilled product, which a consumer must never present as an FBA stockout.
//   * AWD quantities are read only for an AWD-eligible marketplace (the caller decides); otherwise null (not applicable:
//     consumers contribute 0 and display "N/A"). OWNER DECISION 2026-10-08 (an UNVERIFIED business assumption, accepted
//     by the owner): on an AWD-eligible marketplace a BLANK AWD cell is ASSUMED 0 for dashboard calculations. It is
//     flagged per SKU (awdAssumedZero) and per ASIN, and counted per account (awdAssumedZeroSkus), so the UI can say
//     "AWD blank treated as 0" -- never presented as an explicit DataDoe 0. The saved source rows keep the blank. A row
//     WITHOUT the AWD column (not requested) stays unknown. An invalid AWD value is a conflict.
//   * child_asin is an identity, not a quantity: DataDoe's "__EMPTY__" placeholder (seen on whole FR accounts) or a blank
//     is a MISSING ASIN -- never a product key. A caller may pass asinForSku(sku) (an in-account, unambiguous SKU -> ASIN
//     resolver, e.g. the account's own sales history); a SKU that still has no ASIN is reported in `unattributed`
//     (its stock cannot be placed on a product, so a consumer must not present a product / brand total as complete).
//   * Rows from another marketplace are excluded and counted (foreignRows); a consumer treats any as an integrity failure.

export const LISTINGS_INVENTORY_MODEL = "listings-v1";
// The three fields added to the canonical Listings request for inventory (fba_quantity_available and the two AWD
// fields were already requested). fba_inventory_supply_at_fba is deliberately NOT requested.
export const LISTINGS_INVENTORY_FIELDS = Object.freeze(["fba_quantity_inbound", "fba_quantity_reserved", "fba_quantity_fc_transfer"]);
const FBA_FIELDS = Object.freeze(["fba_quantity_available", ...LISTINGS_INVENTORY_FIELDS]);
const AWD_FIELDS = Object.freeze(["awd_available_distributable_quantity", "awd_total_inbound_quantity"]);
// Output keys, in the same order as FBA_FIELDS / AWD_FIELDS.
const FBA_OUT = Object.freeze(["fbaAvailable", "fbaInbound", "fbaReserved", "fbaFcTransfer"]);
const AWD_OUT = Object.freeze(["awdAvailable", "awdInbound"]);

const S = (v) => (v == null ? "" : String(v));
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
export const canonicalMarketplace = (v) => { const m = S(v).trim().toUpperCase(); return m === "UK" ? "GB" : m; };

// A quantity cell -> { value, invalid }. null / undefined / "" -> unknown (null). A finite number >= 0 (or a numeric
// string of one) -> the number. Anything else -> invalid (null).
export function listingsQuantity(v) {
  if (v === null || v === undefined || (typeof v === "string" && v.trim() === "")) return { value: null, invalid: false };
  const n = typeof v === "number" ? v : (typeof v === "string" && /^\s*\d+(\.\d+)?\s*$/.test(v) ? Number(v) : NaN);
  if (!Number.isFinite(n) || n < 0) return { value: null, invalid: true };
  return { value: n, invalid: false };
}

// True when this Listings row carries the expanded inventory fields (present as own keys; a value may be null).
export function listingsRowExpanded(row) {
  return !!row && typeof row === "object" && FBA_FIELDS.every((f) => has(row, f));
}

// True when the rows are a NON-EMPTY expanded Listings payload (every row carries the expanded fields). An old
// 15-column Listings snapshot (fetched before the cutover) is not expanded, so its inventory stays Unavailable.
export function listingsRowsExpanded(rows) {
  return Array.isArray(rows) && rows.length > 0 && rows.every(listingsRowExpanded);
}

const isMfnChannel = (c) => S(c).trim().toUpperCase() === "DEFAULT";

// A Listings child_asin -> the ASIN, or "" when it is missing (blank or DataDoe's "__EMPTY__" placeholder).
export function listingsAsin(v) {
  const a = S(v).trim().toUpperCase();
  return a === "" || a === "__EMPTY__" ? "" : a;
}

/**
 * Fold one account's Listings rows into per-SKU and per-ASIN inventory.
 *   rows        -- the account's isolated Listings rows (one seller).
 *   marketplace -- the account's marketplace (UK/GB tolerated). Rows of another marketplace are excluded + counted.
 *   awdEligible -- whether AWD applies to this marketplace (US + EU5); otherwise AWD values are null.
 *   asinForSku  -- optional (sku) => ASIN | null: resolves a MISSING Listings ASIN from an in-account, unambiguous source.
 * Returns {
 *   expanded, rowCount, foreignRows, invalidRows,
 *   skus:  Map(sku -> { sku, asin, fnsku, channel, fbaAvailable, fbaInbound, fbaReserved, fbaFcTransfer, awdAvailable,
 *                       awdInbound, duplicates, conflict:null|[reason] }),
 *   byAsin: Map(asin -> { asin, skus:[sku], fbaContext:"fba"|"mfn-only", conflict:boolean, <the six quantities> }),
 *   conflicts: [{ sku, asins:[...], reasons:[...] }]   (sorted by sku)
 *   unattributed: { skus, skusWithStock, fbaAvailable|null, sample:[sku] }  -- SKUs with no (resolvable) ASIN; a SKU
 *                  "with stock" holds positive or UNKNOWN FBA available / inbound (or AWD where eligible)
 *   asinResolved: number of SKUs whose missing ASIN came from asinForSku
 *   resolvedConflicts: [{ sku, asin, channel, rules:["R2-sales-asin"|"R3-fba-stock-channel"], asins, channels }]
 *   blankFbaRows: FBA-channel SKUs with a blank (unknown) available or inbound
 * }
 * An ASIN quantity is null when ANY of its SKUs has that quantity unknown (or the SKU is a conflict).
 */
export function foldListingsInventory(rows, { marketplace = "", awdEligible = false, asinForSku = null } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const mkt = canonicalMarketplace(marketplace);
  const out = { expanded: listingsRowsExpanded(list), rowCount: list.length, foreignRows: 0, invalidRows: 0, skus: new Map(), byAsin: new Map(), conflicts: [],
    unattributed: { skus: 0, skusWithStock: 0, fbaAvailable: 0, sample: [] }, asinResolved: 0, resolvedConflicts: [], blankFbaRows: 0, awdAssumedZeroSkus: 0 };
  const resolvedSkus = new Set();
  const conflictReasons = new Map(); // sku -> Set(reason)
  const conflictAsins = new Map();   // sku -> Set(asin)
  const markConflict = (sku, reason, asins) => {
    if (!conflictReasons.has(sku)) conflictReasons.set(sku, new Set());
    conflictReasons.get(sku).add(reason);
    if (!conflictAsins.has(sku)) conflictAsins.set(sku, new Set());
    for (const a of asins) if (a) conflictAsins.get(sku).add(a);
  };

  // 1) Read + group every row of this marketplace by SKU (never summed).
  const groups = new Map(); // sku -> [{ asin, channel, fnsku, q, invalid }]
  for (const r of list) {
    if (!r || typeof r !== "object") { out.invalidRows += 1; continue; }
    const rowMkt = canonicalMarketplace(r.marketplace_country_code);
    if (mkt && rowMkt && rowMkt !== mkt) { out.foreignRows += 1; continue; }
    const sku = S(r.sku).trim();
    if (!sku) { out.invalidRows += 1; continue; }
    const q = {};
    let invalid = false;
    FBA_FIELDS.forEach((f, i) => { const p = listingsQuantity(r[f]); q[FBA_OUT[i]] = p.value; invalid = invalid || p.invalid; });
    AWD_FIELDS.forEach((f, i) => {
      // A row WITHOUT the AWD column (not requested / not returned) is unknown, never 0.
      if (!awdEligible || !has(r, f)) { q[AWD_OUT[i]] = null; return; }
      const p = listingsQuantity(r[f]);
      // Owner decision: a BLANK AWD cell on an AWD-eligible marketplace is an ASSUMED 0 (flagged, counted).
      if (p.value === null && !p.invalid) { q[AWD_OUT[i]] = 0; q.awdAssumedZero = true; }
      else q[AWD_OUT[i]] = p.value;
      invalid = invalid || p.invalid;
    });
    const row = { asin: listingsAsin(r.child_asin), channel: S(r.listing_fulfillment_channel).trim().toUpperCase() || null, fnsku: S(r.fnsku).trim() || null, q, invalid };
    if (!groups.has(sku)) groups.set(sku, []);
    groups.get(sku).push(row);
  }
  const salesAsin = (sku) => (typeof asinForSku === "function" ? listingsAsin(asinForSku(sku)) : "");

  // 2) Decide each SKU group.
  for (const [sku, rows] of groups) {
    const first = rows[0];
    const realAsins = [...new Set(rows.map((x) => x.asin).filter(Boolean))].sort();
    const channels = [...new Set(rows.map((x) => x.channel))];
    const qtyKeys = [...FBA_OUT, ...AWD_OUT];
    const sameFnsku = new Set(rows.map((x) => x.fnsku)).size === 1;
    const sameQty = rows.every((x) => qtyKeys.every((k) => x.q[k] === first.q[k]) && (x.q.awdAssumedZero === true) === (first.q.awdAssumedZero === true));
    const entry = { sku, asin: "", fnsku: first.fnsku, channel: first.channel, ...first.q, awdAssumedZero: rows.some((x) => x.q.awdAssumedZero === true), duplicates: rows.length - 1, conflict: null };
    out.skus.set(sku, entry);
    if (rows.some((x) => x.invalid)) { markConflict(sku, "invalid-quantity", realAsins); continue; }
    if (!sameFnsku) markConflict(sku, "duplicate-different-fnsku", realAsins);
    if (!sameQty) markConflict(sku, "duplicate-different-quantities", realAsins);
    if (!sameFnsku || !sameQty) continue; // QUANTITY conflict: never resolved
    const rules = [];
    // ASIN: one real ASIN -> it; several -> R2 (account-local sales, must be one of them); none -> sales, else missing.
    if (realAsins.length === 1) entry.asin = realAsins[0];
    else if (realAsins.length > 1) {
      const m = salesAsin(sku);
      if (m && realAsins.includes(m)) { entry.asin = m; rules.push("R2-sales-asin"); }
      else markConflict(sku, "duplicate-different-asin", realAsins);
    } else {
      const m = salesAsin(sku);
      if (m) { entry.asin = m; resolvedSkus.add(sku); }
    }
    // Channel: one -> it; several -> R3 (positive FBA stock on every row = Amazon FBA inventory for the FNSKU).
    if (channels.length > 1) {
      if (rows.every((x) => x.q.fbaAvailable !== null && x.q.fbaAvailable > 0)) {
        entry.channel = channels.find((c) => c && !isMfnChannel(c)) || entry.channel;
        rules.push("R3-fba-stock-channel");
      } else markConflict(sku, "duplicate-different-fulfillment-channel", realAsins);
    }
    if (rules.length && !conflictReasons.has(sku)) out.resolvedConflicts.push({ sku, asin: entry.asin, channel: entry.channel, rules, asins: realAsins, channels: channels.filter(Boolean).sort() });
  }

  // Conflicting / invalid SKUs: every quantity unknown (Unavailable), reported.
  for (const [sku, reasons] of conflictReasons) {
    const e = out.skus.get(sku);
    if (e) { for (const k of [...FBA_OUT, ...AWD_OUT]) e[k] = null; e.conflict = [...reasons].sort(); }
    out.conflicts.push({ sku, asins: [...(conflictAsins.get(sku) || [])].filter(Boolean).sort(), reasons: [...reasons].sort() });
  }
  out.conflicts.sort((a, b) => a.sku.localeCompare(b.sku));
  out.resolvedConflicts.sort((a, b) => a.sku.localeCompare(b.sku));
  out.asinResolved = resolvedSkus.size;
  for (const e of out.skus.values()) if (!e.conflict && !isMfnChannel(e.channel) && (e.fbaAvailable === null || e.fbaInbound === null)) out.blankFbaRows += 1;
  for (const e of out.skus.values()) if (e.awdAssumedZero === true && !e.conflict) out.awdAssumedZeroSkus += 1;

  // SKUs with no ASIN (after resolution): their stock cannot be placed on a product. Reported, never dropped silently.
  for (const e of out.skus.values()) {
    if (e.asin || e.conflict) continue; // a conflict SKU is reported as a conflict (attached to its candidate ASINs), not twice
    out.unattributed.skus += 1;
    if (out.unattributed.sample.length < 20) out.unattributed.sample.push(e.sku);
    const stockOrUnknown = (v) => v === null || v > 0;
    const supplyKeys = ["fbaAvailable", "fbaInbound", ...(awdEligible ? ["awdAvailable"] : [])];
    if (!(isMfnChannel(e.channel) && FBA_OUT.every((k) => e[k] === 0)) && supplyKeys.some((k) => stockOrUnknown(e[k]))) out.unattributed.skusWithStock += 1;
    out.unattributed.fbaAvailable = (out.unattributed.fbaAvailable === null || e.fbaAvailable === null) ? null : out.unattributed.fbaAvailable + e.fbaAvailable;
  }

  // Per-ASIN aggregate (null-propagating) + fulfillment context. A conflicting SKU seen under SEVERAL ASINs attaches to
  // EVERY one of them (its quantities are unknown), so no ASIN silently reads as "absent" and none keeps a guessed stock.
  for (const e of out.skus.values()) {
    const asins = new Set([e.asin, ...(e.conflict ? (conflictAsins.get(e.sku) || []) : [])].filter(Boolean));
    for (const asin of asins) {
      let a = out.byAsin.get(asin);
      if (!a) {
        a = { asin, skus: [], conflict: false, allMfnZero: true };
        for (const k of [...FBA_OUT, ...AWD_OUT]) a[k] = 0;
        out.byAsin.set(asin, a);
      }
      a.skus.push(e.sku);
      if (e.conflict) a.conflict = true;
      if (e.awdAssumedZero === true && !e.conflict) a.awdAssumedZero = true;
      for (const k of [...FBA_OUT, ...AWD_OUT]) a[k] = (a[k] === null || e[k] === null) ? null : a[k] + e[k];
      const fbaKnownZero = FBA_OUT.every((k) => e[k] === 0);
      if (!(isMfnChannel(e.channel) && fbaKnownZero)) a.allMfnZero = false;
    }
  }
  for (const a of out.byAsin.values()) {
    a.skus.sort((x, y) => x.localeCompare(y));
    a.fbaContext = a.allMfnZero ? "mfn-only" : "fba";
    delete a.allMfnZero;
  }
  return out;
}

/**
 * Is this account's Listings snapshot VALIDATED inventory evidence (phase 2: else the consumer uses the labelled Health
 * fallback)? Returns { ok, reasons:[...] }. Every condition is evidence-based; nothing is inferred:
 *   listings-empty / listings-foreign-marketplace-rows / listings-not-expanded (the three new fields were not requested
 *   or not saved) / listings-invalid-rows:N / listings-unresolved-conflicts:N / listings-unattributed-stock:N /
 *   listings-blank-fba-fields:N (an FBA-channel SKU with a blank available or inbound).
 */
export function listingsValidation(rows, fold) {
  const reasons = [];
  if (!Array.isArray(rows) || rows.length === 0) return { ok: false, reasons: ["listings-empty"] };
  if (fold.foreignRows > 0) reasons.push("listings-foreign-marketplace-rows");
  if (!fold.expanded) reasons.push("listings-not-expanded");
  if (fold.invalidRows > 0) reasons.push(`listings-invalid-rows:${fold.invalidRows}`);
  if (fold.conflicts.length > 0) reasons.push(`listings-unresolved-conflicts:${fold.conflicts.length}`);
  if (fold.unattributed.skusWithStock > 0) reasons.push(`listings-unattributed-stock:${fold.unattributed.skusWithStock}`);
  if (fold.expanded && fold.blankFbaRows > 0) reasons.push(`listings-blank-fba-fields:${fold.blankFbaRows}`);
  return { ok: reasons.length === 0, reasons };
}

// Why a fold's inventory is Unavailable for the whole account (null = available). Shared by every consumer so the
// reasons stay identical: no rows, another marketplace's rows (integrity), or a pre-cutover payload (not expanded).
export function listingsInventoryUnavailableReason(rows, fold) {
  if (!Array.isArray(rows) || rows.length === 0) return "listings-empty";
  if (fold && fold.foreignRows > 0) return "listings-foreign-marketplace-rows";
  if (!(fold ? fold.expanded : listingsRowsExpanded(rows))) return "listings-not-expanded";
  return null;
}

/**
 * The (marketplace, brand) roll-up of FBA Available that Brand View consumes, from one account's fold. ONE definition
 * shared by the FBA Shipment Plan payload and the compact brand-inventory snapshot:
 *   - an mfn-only ASIN is not FBA stock and creates no bucket (a merchant-fulfilled brand shows no FBA figure rather
 *     than a 0 that reads like a stockout);
 *   - an ASIN with an UNKNOWN fbaAvailable (conflict / null) makes its bucket null (Unavailable) -- never a partial sum
 *     presented as complete;
 *   - skuCount counts the FBA SKUs in the bucket.
 * `brandOf(asin)` returns the catalog brand or null. Returns [{ country, brand, fbaAvailable|null, skuCount }].
 */
export function brandCountryInventory(fold, { country, brandOf = () => null } = {}) {
  const c = canonicalMarketplace(country) || null;
  const buckets = new Map();
  for (const [asin, a] of (fold && fold.byAsin) || []) {
    if (a.fbaContext === "mfn-only") continue;
    const brand = brandOf(asin) || null;
    const key = `${c || ""}|${brand || ""}`;
    const b = buckets.get(key) || { country: c, brand, fbaAvailable: 0, skus: new Set() };
    b.fbaAvailable = (b.fbaAvailable === null || a.fbaAvailable === null) ? null : b.fbaAvailable + a.fbaAvailable;
    for (const sku of a.skus) b.skus.add(sku);
    buckets.set(key, b);
  }
  // Stock on SKUs with no (resolvable) ASIN belongs to an unknown brand: every brand figure of this marketplace could be
  // understated, so the whole marketplace is Unavailable (null buckets; an unbranded null bucket when there is none).
  // An explicit `unattributed` marker entry tells a brand consumer that this marketplace holds stock of UNKNOWN brand, so
  // even a brand with no bucket here is Unavailable (never "no stock").
  const unattributed = !!(fold && fold.unattributed && fold.unattributed.skusWithStock > 0);
  if (unattributed) for (const b of buckets.values()) b.fbaAvailable = null;
  const out = [...buckets.values()].map(({ skus, ...entry }) => ({ ...entry, skuCount: skus.size }));
  if (unattributed) out.push({ country: c, brand: null, fbaAvailable: null, skuCount: fold.unattributed.skusWithStock, unattributed: true });
  return out;
}
