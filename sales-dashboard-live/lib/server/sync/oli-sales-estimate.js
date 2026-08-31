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
// with zero double-counting.
//
// MARKETPLACE ISOLATION (hardened): a reference price MUST come from the exact same marketplace/country. account +
// currency do NOT identify a marketplace (BE/DE/ES/FR/IT/NL all use EUR), so the matching key carries a canonical
// marketplace, every account has ONE authoritative marketplace, and any row (target or reference) whose marketplace
// does not match the account's authoritative marketplace is REJECTED (fail closed) -- a same-seller, same-ASIN/SKU
// EUR reference from another country can never be used. UK and GB normalize to one canonical marketplace.
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

// Canonical marketplace: UK and GB are the SAME Amazon marketplace (the account directory says "UK", Amazon's rows
// say "GB"), so both normalize to "GB". Everything else is trimmed + upper-cased. Blank stays "" (a fail-closed
// signal -- an account or row with no marketplace can never be estimated).
export function normalizeMarketplace(v) {
  const m = S(v).trim().toUpperCase();
  return m === "UK" ? "GB" : m;
}

// The group identity every OLI sales surface aggregates by (matches the source_oli_daily_history rollup grain).
// JSON array => an unambiguous key no field value can collide into.
export function oliGroupKey({ accountId, saleDate, sku, childAsin, currency }) {
  return JSON.stringify([S(accountId), S(saleDate), S(sku), S(childAsin), S(currency)]);
}

// The ONE shared authority for an account's canonical marketplace, used by BOTH the runtime and the backfill so
// they can NEVER diverge. It groups EVERY directory row by canonical account id and collects the SET of canonical
// marketplaces (UK->GB) -- NEVER last-write-wins. Marketplace is read ONLY from the directory's own marketplace/
// country field; it is NEVER inferred from currency, seller id, ASIN, SKU, connection, or bucket. Result per account:
//   { status: "unique",    marketplace }  -- exactly one distinct nonblank canonical marketplace;
//   { status: "missing",   marketplace: null } -- no nonblank marketplace at all;
//   { status: "ambiguous", marketplace: null, count } -- more than one distinct canonical marketplace.
// Only "unique" is safe to estimate under; missing/ambiguous fail closed (the estimator never picks one).
export function resolveUniqueMarketplaceByAccount(directoryAccounts = []) {
  const canonicalByAccount = new Map(); // accountId -> Set(canonical marketplace)
  for (const a of (Array.isArray(directoryAccounts) ? directoryAccounts : [])) {
    const id = S(a && (a.accountId ?? a.account_id ?? a.id)).trim();
    if (!id) continue;
    const mkt = normalizeMarketplace(a && (a.country ?? a.marketCountry ?? a.marketplace ?? a.marketplace_country_code));
    let set = canonicalByAccount.get(id);
    if (!set) { set = new Set(); canonicalByAccount.set(id, set); }
    if (mkt) set.add(mkt); // only nonblank canonical marketplaces count toward uniqueness
  }
  const byAccount = new Map();
  for (const [id, set] of canonicalByAccount) {
    if (set.size === 0) byAccount.set(id, { status: "missing", marketplace: null });
    else if (set.size === 1) byAccount.set(id, { status: "unique", marketplace: [...set][0] });
    else byAccount.set(id, { status: "ambiguous", marketplace: null, count: set.size });
  }
  return byAccount;
}

// The account's authoritative canonical marketplace ONLY when it is uniquely proven; "" (fail closed) otherwise.
export function authoritativeMarketplace(resolutionMap, accountId) {
  const r = resolutionMap instanceof Map ? resolutionMap.get(S(accountId).trim()) : null;
  return r && r.status === "unique" && r.marketplace ? r.marketplace : "";
}

// Redacted diagnostics for telemetry: counts + the SHORT-hashed account ids of the missing/ambiguous accounts
// (never any unrelated account detail). Safe to log.
export function summarizeMarketplaceResolution(resolutionMap) {
  let unique = 0; let missing = 0; let ambiguous = 0;
  const missingAccounts = []; const ambiguousAccounts = [];
  if (resolutionMap instanceof Map) {
    for (const [id, r] of resolutionMap) {
      if (r.status === "unique") unique += 1;
      else if (r.status === "missing") { missing += 1; missingAccounts.push(S(id).slice(0, 8)); }
      else { ambiguous += 1; ambiguousAccounts.push(S(id).slice(0, 8)); }
    }
  }
  return { unique, missing, ambiguous, missingAccounts, ambiguousAccounts };
}

// Typed diagnostic codes for a fail-closed marketplace authority (never silently swallowed).
export const OLI_ESTIMATE_MARKETPLACE_MISSING = "OLI_ESTIMATE_MARKETPLACE_MISSING";
export const OLI_ESTIMATE_MARKETPLACE_AMBIGUOUS = "OLI_ESTIMATE_MARKETPLACE_AMBIGUOUS";

// Round a COMPLETE line amount to a currency's minor units (default 2). Applied only AFTER unit-price x quantity,
// per the spec ("appropriate currency precision only after calculating the complete target-line amount").
function roundMoney(amount, precision = 2) {
  if (!Number.isFinite(amount)) return null;
  const p = Number.isInteger(precision) && precision >= 0 ? precision : 2;
  const f = 10 ** p;
  return Math.round((amount + Number.EPSILON) * f) / f;
}

function median(values) {
  const xs = values.filter((x) => Number.isFinite(x)).slice().sort((a, b) => a - b);
  if (!xs.length) return NaN;
  const mid = xs.length >> 1;
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

// Normalize a durable OPERATIONAL-UNIT row (snake or camel) to the fields the engine needs (incl. marketplace).
function normOperational(r, defaultAccountId) {
  return {
    accountId: S(r.accountId ?? r.account_id ?? defaultAccountId),
    sellerId: S(r.sellerOrVendorId ?? r.seller_or_vendor_id ?? ""),
    marketplace: normalizeMarketplace(r.marketplaceCountryCode ?? r.marketplace_country_code ?? ""),
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
    marketplace: normalizeMarketplace(r.marketplaceCountryCode ?? r.marketplace_country_code ?? ""),
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

// A row's effective canonical marketplace: its own value when present, else the account's authoritative marketplace
// (a transition allowance for durable rows persisted before marketplace was captured -- every such account is
// single-marketplace and its authoritative value is uniquely proven from the directory). A row whose OWN marketplace
// is present but does NOT match the account's authoritative marketplace is contamination and is rejected by callers.
function rowMarketplace(rowMkt, accountMarketplace) {
  return rowMkt ? rowMkt : accountMarketplace;
}

// The reference-eligibility gate (spec "REFERENCE ROW ELIGIBILITY"): non-cancelled, positive finite value, positive
// quantity, canonical date + currency, AND same canonical marketplace as the account's authoritative marketplace.
function referenceEligible(ref, accountMarketplace) {
  return ref.isCancelled !== true
    && Number.isFinite(ref.sales) && ref.sales > 0
    && Number.isFinite(ref.units) && ref.units > 0
    && isDateStr(ref.date)
    && /^[A-Z]{3}$/.test(ref.currency)
    && rowMarketplace(ref.marketplace, accountMarketplace) === accountMarketplace; // never another marketplace
}

// Identity keys carry the canonical marketplace between account and currency (account + currency alone cannot
// isolate a marketplace under a shared currency such as EUR). SKU-exact binds account+seller+MARKETPLACE+currency+
// ASIN+SKU; the ASIN fallback drops ONLY the SKU and is used ONLY when the TARGET row has no SKU.
function skuExactKey(accountId, sellerId, marketplace, currency, childAsin, sku) {
  return JSON.stringify(["k", accountId, sellerId, marketplace, currency, childAsin, sku]);
}
function asinFallbackKey(accountId, sellerId, marketplace, currency, childAsin) {
  return JSON.stringify(["a", accountId, sellerId, marketplace, currency, childAsin]);
}

/**
 * Compute the estimated sales for every eligible missing/zero-price operational grain of ONE account+marketplace.
 *
 * @param {object} args
 * @param {string} args.accountId          - the account these rows belong to (references are per-account).
 * @param {string} args.accountMarketplace - the account's AUTHORITATIVE canonical marketplace (UK->GB). REQUIRED:
 *                                            blank/absent => every grain is unresolved (fail closed; never guessed).
 * @param {object[]} args.operationalRows  - source_oli_operational_units rows (targets carry explicit_zero/pending).
 * @param {object[]} args.referenceRows     - source_oli_dimensional_history rows within [minDate-lookback, maxDate].
 * @param {number} [args.maxLookbackDays=7] - inclusive calendar-day look-back (never a future date).
 * @param {number} [args.precision=2]       - currency minor units for the final line amount.
 * @param {string} [args.calculatedAt]      - ISO stamp for provenance (defaults to now); pin it for byte-identical tests.
 * @returns {{estimates: object[], unresolved: object[]}}
 */
export function computeOliSalesEstimates({ accountId, accountMarketplace, operationalRows = [], referenceRows = [], maxLookbackDays = OLI_ESTIMATE_LOOKBACK_DAYS, precision = 2, calculatedAt = null } = {}) {
  const stamp = calculatedAt || new Date().toISOString();
  const acctMkt = normalizeMarketplace(accountMarketplace);

  // FAIL CLOSED: with no authoritative marketplace we cannot prove same-marketplace isolation -- every
  // missing/zero-price grain stays UNRESOLVED (counted, shown in the breakdown), never estimated across a boundary.
  if (!acctMkt) {
    const unresolved = [];
    for (const raw of operationalRows) {
      const t = normOperational(raw, accountId);
      const qty = t.explicitZeroUnits + t.pendingUnits;
      if (qty > 0 && isDateStr(t.date) && /^[A-Z]{3}$/.test(t.currency)) {
        unresolved.push({ accountId: t.accountId, sellerOrVendorId: t.sellerId, saleDate: t.date, sku: t.sku, childAsin: t.childAsin, currency: t.currency, targetQuantity: qty, reason: "no-authoritative-marketplace" });
      }
    }
    return { estimates: [], unresolved };
  }

  // Build reference indexes (SKU-exact + ASIN), keyed with the canonical marketplace, from ELIGIBLE references only.
  const skuIndex = new Map();
  const asinIndex = new Map();
  const addTo = (index, key, date, unitPrice, hash) => {
    let byDate = index.get(key);
    if (!byDate) { byDate = new Map(); index.set(key, byDate); }
    let bucket = byDate.get(date);
    if (!bucket) { bucket = { prices: [], hash: "" }; byDate.set(date, bucket); }
    bucket.prices.push(unitPrice);
    if (!bucket.hash && hash) bucket.hash = hash;
  };
  for (const raw of referenceRows) {
    const ref = normReference(raw, accountId);
    if (!referenceEligible(ref, acctMkt)) continue; // rejects cancelled / non-positive / wrong-currency / wrong-marketplace
    const unitPrice = ref.sales / ref.units; // per-reference-row unit price = item_price_value / quantity
    if (!Number.isFinite(unitPrice) || unitPrice <= 0) continue;
    addTo(skuIndex, skuExactKey(ref.accountId, ref.sellerId, acctMkt, ref.currency, ref.childAsin, ref.sku), ref.date, unitPrice, ref.sourceRequestHash);
    addTo(asinIndex, asinFallbackKey(ref.accountId, ref.sellerId, acctMkt, ref.currency, ref.childAsin), ref.date, unitPrice, ref.sourceRequestHash);
  }

  const estimates = [];
  const unresolved = [];
  for (const raw of operationalRows) {
    const t = normOperational(raw, accountId);
    const targetQty = t.explicitZeroUnits + t.pendingUnits;
    if (!(targetQty > 0) || !isDateStr(t.date) || !/^[A-Z]{3}$/.test(t.currency)) continue;

    // A target whose OWN marketplace is present but does NOT match the account's authoritative marketplace is
    // contamination -> never estimated under this account (fail closed).
    if (rowMarketplace(t.marketplace, acctMkt) !== acctMkt) {
      unresolved.push({ accountId: t.accountId, sellerOrVendorId: t.sellerId, saleDate: t.date, sku: t.sku, childAsin: t.childAsin, currency: t.currency, targetQuantity: targetQty, reason: "marketplace-mismatch" });
      continue;
    }

    // The SKU-fallback rule: use the ASIN-only key ONLY when the target SKU is genuinely blank; never otherwise.
    const usingFallback = S(t.sku) === "";
    const index = usingFallback ? asinIndex : skuIndex;
    const key = usingFallback
      ? asinFallbackKey(t.accountId, t.sellerId, acctMkt, t.currency, t.childAsin)
      : skuExactKey(t.accountId, t.sellerId, acctMkt, t.currency, t.childAsin, t.sku);
    const byDate = index.get(key);

    let referenceDate = null;
    let unitPrice = NaN;
    let referenceHash = "";
    if (byDate) {
      // Same date first, then D-1 ... up to maxLookbackDays back. Never future. Nearest date with matches; MEDIAN.
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
        marketplaceCountryCode: acctMkt,
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
        accountId: t.accountId, sellerOrVendorId: t.sellerId, marketplaceCountryCode: acctMkt, saleDate: t.date,
        sku: t.sku, childAsin: t.childAsin, currency: t.currency, targetQuantity: targetQty, reason: "no-reference",
      });
    }
  }
  return { estimates, unresolved };
}

/**
 * Merge estimated sales into durable OLI history rows at the (account, date, sku, ASIN, currency) grain. Additive:
 * an existing priced row's sales grows by its estimate; a grain that is ENTIRELY unpriced (no history row) gets a
 * SYNTHETIC row carrying only the estimated sales (units stay 0 -- this feature NEVER changes unit counts). Every
 * consumer that reads these rows inherits the enriched Total Sales through this one calculation. Returns a NEW
 * array; inputs are never mutated.
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

// The set of (account, date, sku, ASIN, currency) group keys a set of estimate rows RESOLVES -- used by the
// missing-value breakdown to stop showing resolved grains while genuinely-unresolved grains remain.
export function resolvedEstimateGroupKeys(estimateRows = []) {
  const set = new Set();
  for (const e of estimateRows) {
    set.add(oliGroupKey({ accountId: e.accountId ?? e.account_id, saleDate: e.saleDate ?? e.sale_date, sku: e.sku, childAsin: e.childAsin ?? e.child_asin, currency: e.currency }));
  }
  return set;
}
