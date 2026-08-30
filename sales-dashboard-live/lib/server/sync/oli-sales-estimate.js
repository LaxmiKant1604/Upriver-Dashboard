// The ONE canonical, PURE (zero-I/O) engine that estimates missing/zero-price OLI sales from same-product
// historical prices, and enriches the durable OLI sales rows with those estimates. Shared by the recompute
// orchestration (after every OLI persist -- scheduler / manual sync / force-latest / self-heal / backfill) and by
// the derive read seam (so every OLI-derived sales surface inherits the estimate through ONE calculation).
//
// WHY: source_oli_daily_history (the priced rollup every dashboard reads) counts ONLY non-cancelled units with a
// present, strictly-positive item_price_value. Non-cancelled units with a MISSING (pending itemization) or ZERO
// item_price_value carry real sales that DataDoe has not itemized yet -- they live in source_oli_operational_units
// as explicit_zero_units + pending_units. This engine estimates those units' sales from a valid historical unit
// price for the SAME product, adds it to the existing Total Sales, and -- because the estimate always covers
// EXACTLY the still-unpriced quantity -- the actual value automatically supersedes it on the next 7-day refresh
// with zero double-counting (as itemization arrives, priced_units grows, the missing quantity shrinks, the
// estimate shrinks; fully itemized => zero estimate).
//
// RAW DataDoe evidence is NEVER modified: the estimate is a separate durable audit layer merged only at read.

import { addDaysStr } from "../date-windows.js";

const S = (v) => (v == null ? "" : String(v));
const N = (v) => (v == null || v === "" ? NaN : Number(v));
const isDateStr = (v) => /^\d{4}-\d{2}-\d{2}$/.test(S(v));

// The default look-back horizon (calendar days, inclusive of the target date). Never searches a FUTURE date.
export const OLI_ESTIMATE_LOOKBACK_DAYS = 7;
export const MATCH_SKU_EXACT = "sku-exact";
export const MATCH_ASIN_FALLBACK = "asin-fallback";

// The group identity every OLI sales surface aggregates by (matches the source_oli_daily_history rollup grain).
export function oliGroupKey({ accountId, saleDate, sku, childAsin, currency }) {
  return [S(accountId), S(saleDate), S(sku), S(childAsin), S(currency)].join("");
}

// Round a COMPLETE line amount to a currency's minor units (default 2). Applied only AFTER unit-price x quantity,
// per the spec ("appropriate currency precision only after calculating the complete target-line amount").
function roundMoney(amount, precision = 2) {
  if (!Number.isFinite(amount)) return null;
  const p = Number.isInteger(precision) && precision >= 0 ? precision : 2;
  const f = 10 ** p;
  // Round-half-up on the scaled integer, guarding binary-float drift with a tiny epsilon.
  return Math.round((amount + Number.EPSILON) * f) / f;
}

function median(sortedOrUnsorted) {
  const xs = sortedOrUnsorted.filter((x) => Number.isFinite(x)).slice().sort((a, b) => a - b);
  if (!xs.length) return NaN;
  const mid = xs.length >> 1;
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

// Normalize a durable OPERATIONAL-UNIT row (snake or camel) to the fields the engine needs.
function normOperational(r, defaultAccountId) {
  return {
    accountId: S(r.accountId ?? r.account_id ?? defaultAccountId),
    sellerId: S(r.sellerOrVendorId ?? r.seller_or_vendor_id ?? ""),
    date: S(r.saleDate ?? r.sale_date ?? ""),
    sku: S(r.sku ?? ""),
    childAsin: S(r.childAsin ?? r.child_asin ?? ""),
    currency: S(r.currency ?? ""),
    explicitZeroUnits: Math.max(0, N(r.explicitZeroUnits ?? r.explicit_zero_units) || 0),
    pendingUnits: Math.max(0, N(r.pendingUnits ?? r.pending_units) || 0),
    sourceRequestHash: S(r.sourceRequestHash ?? r.source_request_hash ?? ""),
  };
}

// Normalize a durable DIMENSIONAL reference row (the finest durable priced grain) to the fields the engine needs.
function normReference(r, defaultAccountId) {
  return {
    accountId: S(r.accountId ?? r.account_id ?? defaultAccountId),
    sellerId: S(r.sellerOrVendorId ?? r.seller_or_vendor_id ?? ""),
    date: S(r.saleDate ?? r.sale_date ?? ""),
    sku: S(r.sku ?? ""),
    childAsin: S(r.childAsin ?? r.child_asin ?? ""),
    currency: S(r.currency ?? ""),
    isCancelled: (r.isCancelled ?? r.is_cancelled) === true,
    sales: N(r.totalSalesSum ?? r.total_sales_sum),
    units: N(r.totalUnitsSum ?? r.total_units_sum),
    sourceRequestHash: S(r.sourceRequestHash ?? r.source_request_hash ?? ""),
  };
}

// The reference-eligibility gate (spec "REFERENCE ROW ELIGIBILITY"): non-cancelled, positive finite value, positive
// quantity. (Dimensional rows are RAW source evidence -- never estimated -- and pending/missing-value rows are not
// stored there at all, so "not itself estimated" + "itemized/complete" hold by construction.)
function referenceEligible(ref) {
  return ref.isCancelled !== true
    && Number.isFinite(ref.sales) && ref.sales > 0
    && Number.isFinite(ref.units) && ref.units > 0
    && isDateStr(ref.date)
    && /^[A-Z]{3}$/.test(ref.currency);
}

// The identity key for a reference lookup. SKU-exact binds account+seller+currency+ASIN+SKU (same account and same
// currency PROVE the same marketplace/country, so no separate marketplace field is needed). The ASIN-fallback key
// drops ONLY the SKU and is used ONLY when the TARGET row has no SKU.
function skuExactKey(accountId, sellerId, currency, childAsin, sku) {
  return ["k", accountId, sellerId, currency, childAsin, sku].join("");
}
function asinFallbackKey(accountId, sellerId, currency, childAsin) {
  return ["a", accountId, sellerId, currency, childAsin].join("");
}

/**
 * Compute the estimated sales for every eligible missing/zero-price operational grain of ONE account.
 *
 * @param {object} args
 * @param {string} args.accountId            - the account these rows belong to (references are per-account).
 * @param {object[]} args.operationalRows     - source_oli_operational_units rows (targets carry explicit_zero/pending).
 * @param {object[]} args.referenceRows        - source_oli_dimensional_history rows within [minDate-lookback, maxDate].
 * @param {number} [args.maxLookbackDays=7]    - inclusive calendar-day look-back (never a future date).
 * @param {number} [args.precision=2]          - currency minor units for the final line amount.
 * @param {string} [args.calculatedAt]         - ISO stamp for provenance (defaults to now); pin it for byte-identical tests.
 * @returns {{estimates: object[], unresolved: object[]}} estimates (with full provenance) + genuinely-unresolved grains.
 */
export function computeOliSalesEstimates({ accountId, operationalRows = [], referenceRows = [], maxLookbackDays = OLI_ESTIMATE_LOOKBACK_DAYS, precision = 2, calculatedAt = null } = {}) {
  const stamp = calculatedAt || new Date().toISOString();
  // Build reference indexes: key -> Map(date -> { prices:number[], hash:string }). Two indexes: SKU-exact + ASIN.
  const skuIndex = new Map();
  const asinIndex = new Map();
  const addTo = (index, key, date, unitPrice, hash) => {
    let byDate = index.get(key);
    if (!byDate) { byDate = new Map(); index.set(key, byDate); }
    let bucket = byDate.get(date);
    if (!bucket) { bucket = { prices: [], hash: "" }; byDate.set(date, bucket); }
    bucket.prices.push(unitPrice);
    if (!bucket.hash && hash) bucket.hash = hash; // keep one representative reference request hash for that date
  };
  for (const raw of referenceRows) {
    const ref = normReference(raw, accountId);
    if (!referenceEligible(ref)) continue;
    const unitPrice = ref.sales / ref.units; // per-reference-row unit price = item_price_value / quantity
    if (!Number.isFinite(unitPrice) || unitPrice <= 0) continue;
    addTo(skuIndex, skuExactKey(ref.accountId, ref.sellerId, ref.currency, ref.childAsin, ref.sku), ref.date, unitPrice, ref.sourceRequestHash);
    addTo(asinIndex, asinFallbackKey(ref.accountId, ref.sellerId, ref.currency, ref.childAsin), ref.date, unitPrice, ref.sourceRequestHash);
  }

  const estimates = [];
  const unresolved = [];
  for (const raw of operationalRows) {
    const t = normOperational(raw, accountId);
    const targetQty = t.explicitZeroUnits + t.pendingUnits; // the non-cancelled units with no positive price
    if (!(targetQty > 0) || !isDateStr(t.date) || !/^[A-Z]{3}$/.test(t.currency)) continue;

    // The SKU-fallback rule: use the ASIN-only key ONLY when the target SKU is genuinely blank; never otherwise.
    const usingFallback = S(t.sku) === "";
    const index = usingFallback ? asinIndex : skuIndex;
    const key = usingFallback
      ? asinFallbackKey(t.accountId, t.sellerId, t.currency, t.childAsin)
      : skuExactKey(t.accountId, t.sellerId, t.currency, t.childAsin, t.sku);
    const byDate = index.get(key);

    let referenceDate = null;
    let unitPrice = NaN;
    let referenceHash = "";
    if (byDate) {
      // Search the SAME date first, then D-1, D-2, ... up to maxLookbackDays back. Never a future date. Stop at the
      // NEAREST date that has trustworthy matches; the median of that date's unit prices is used.
      for (let back = 0; back <= maxLookbackDays; back += 1) {
        const d = back === 0 ? t.date : addDaysStr(t.date, -back);
        const bucket = byDate.get(d);
        if (bucket && bucket.prices.length) {
          referenceDate = d;
          unitPrice = median(bucket.prices);
          referenceHash = bucket.hash;
          break;
        }
      }
    }

    if (referenceDate && Number.isFinite(unitPrice) && unitPrice > 0) {
      const estimatedSales = roundMoney(unitPrice * targetQty, precision);
      estimates.push({
        accountId: t.accountId,
        sellerOrVendorId: t.sellerId,
        saleDate: t.date,
        sku: t.sku,
        childAsin: t.childAsin,
        currency: t.currency,
        targetQuantity: targetQty,
        estimatedSales,
        referenceDate,
        referenceUnitPrice: unitPrice,
        matchingMethod: usingFallback ? MATCH_ASIN_FALLBACK : MATCH_SKU_EXACT,
        referenceSourceRequestHash: referenceHash,
        calculatedAt: stamp,
      });
    } else {
      unresolved.push({
        accountId: t.accountId, sellerOrVendorId: t.sellerId, saleDate: t.date,
        sku: t.sku, childAsin: t.childAsin, currency: t.currency, targetQuantity: targetQty,
      });
    }
  }
  return { estimates, unresolved };
}

/**
 * Merge estimated sales into durable OLI history rows at the (account, date, sku, ASIN, currency) grain. Additive:
 * an existing priced row's sales grows by its estimate; a grain that is ENTIRELY unpriced (no history row) gets a
 * SYNTHETIC row carrying only the estimated sales (units stay 0 -- this feature NEVER changes unit counts). Every
 * consumer that reads these rows (Daily / Brand View / Sales Dashboard / SKU-level) inherits the enriched Total
 * Sales through this one calculation. Returns a NEW array; inputs are never mutated.
 */
export function enrichOliHistoryRowsWithEstimates(historyRows = [], estimateRows = []) {
  const estByGroup = new Map();
  for (const e of estimateRows) {
    const key = oliGroupKey({ accountId: e.accountId ?? e.account_id, saleDate: e.saleDate ?? e.sale_date, sku: e.sku, childAsin: e.childAsin ?? e.child_asin, currency: e.currency });
    const add = Number(e.estimatedSales ?? e.estimated_sales ?? 0) || 0;
    estByGroup.set(key, (estByGroup.get(key) || 0) + add);
  }
  const out = [];
  const consumed = new Set();
  for (const r of historyRows) {
    const accountId = r.account_id ?? r.accountId;
    const saleDate = r.sale_date ?? r.saleDate;
    const sku = r.sku ?? "";
    const childAsin = r.child_asin ?? r.childAsin ?? "";
    const currency = r.currency;
    const key = oliGroupKey({ accountId, saleDate, sku, childAsin, currency });
    const delta = estByGroup.get(key) || 0;
    if (delta) {
      consumed.add(key);
      const base = Number(r.sales_amount ?? r.salesAmount ?? 0) || 0;
      out.push({ ...r, sales_amount: base + delta });
    } else {
      out.push(r);
    }
  }
  // Synthetic rows for fully-unpriced grains (an estimate with no matching priced history row). Units stay 0.
  for (const e of estimateRows) {
    const accountId = e.accountId ?? e.account_id;
    const saleDate = e.saleDate ?? e.sale_date;
    const sku = e.sku ?? "";
    const childAsin = e.childAsin ?? e.child_asin ?? "";
    const currency = e.currency;
    const key = oliGroupKey({ accountId, saleDate, sku, childAsin, currency });
    if (consumed.has(key)) continue;
    consumed.add(key);
    const delta = estByGroup.get(key) || 0;
    if (!delta) continue;
    out.push({
      account_id: accountId, seller_or_vendor_id: e.sellerOrVendorId ?? e.seller_or_vendor_id ?? "",
      sale_date: saleDate, sku, child_asin: childAsin, currency,
      sales_amount: delta, units: 0,
      source_request_hash: e.referenceSourceRequestHash ?? e.reference_source_request_hash ?? "",
    });
  }
  return out;
}

// The set of (account, date, sku, ASIN, currency) group keys that a set of estimate rows RESOLVES -- used by the
// missing-value breakdown to stop showing resolved grains while genuinely-unresolved grains remain.
export function resolvedEstimateGroupKeys(estimateRows = []) {
  const set = new Set();
  for (const e of estimateRows) {
    set.add(oliGroupKey({ accountId: e.accountId ?? e.account_id, saleDate: e.saleDate ?? e.sale_date, sku: e.sku, childAsin: e.childAsin ?? e.child_asin, currency: e.currency }));
  }
  return set;
}
