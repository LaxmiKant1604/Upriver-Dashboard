// Canonical durable ASIN Ads (asin-performance-v1) aggregation -- the SINGLE reusable advertising source for
// Daily Reporting + Brand View (and future dashboards). ONE saved dataset (public.ads_daily_source_rows, source
// "asin-performance-v1") feeds both. Invariants: NEVER combine currencies; NEVER invent a metric the contract did
// not supply; deduplicate by the canonical natural grain before summing; keep UNMAPPED ASINs as a typed separate
// amount (never silently assigned or dropped). Campaign Ads (campaign-performance-v1) is NEVER summed here.

// The ONLY metrics the ASIN Ads contract supplies (confirmed against the live rows). A field ABSENT from a row's
// metrics stays absent -- it is never materialized as 0.
export const ASIN_ADS_METRIC_FIELDS = Object.freeze({
  impressions: "ad_impressions",
  clicks: "ad_clicks",
  spend: "ad_spend",
  attributedSales: "ad_sales_same_sku",
  attributedOrders: "ad_orders_same_sku",
  attributedUnits: "ad_units_sold_same_sku",
});
export const ASIN_ADS_METRIC_KEYS = Object.freeze(Object.keys(ASIN_ADS_METRIC_FIELDS));

// A blank/absent currency becomes this TYPED unknown group -- never merged with a real currency, never dropped.
export const UNKNOWN_CURRENCY = "UNKNOWN";
// A child_asin with no proven unique brand is kept under this typed key -- never assigned to a real brand.
export const UNMAPPED_BRAND = "__unmapped";

const S = (v) => (v == null ? "" : String(v));
// A present numeric value (0 included) counts; null/undefined/non-numeric is "not supplied" -> absent (never 0).
const numOrNull = (v) => { if (v == null || v === "") return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
export function normalizeAdsCurrency(v) { const t = S(v).trim().toUpperCase(); return t || UNKNOWN_CURRENCY; }
export function asinOf(row) { return S(row && row.child_asin).trim().toUpperCase(); }

// The canonical dedup grain: one row per (account, marketplace, date, dimension_key). Rows are already unique by
// the table PK, but overlapping reads are deduped here so a metric is counted exactly once.
export function asinAdsNaturalKey(row) {
  return [S(row.account_id), S(row.marketplace_country_code).toUpperCase(), S(row.metric_date), S(row.dimension_key)].join("|");
}

// Extract ONLY the metrics the row actually supplies (present + finite). Returns a partial object over
// ASIN_ADS_METRIC_KEYS -- absent/non-finite fields are omitted, never zero-filled.
export function asinAdsMetricsFromRow(row) {
  const m = row && row.metrics && typeof row.metrics === "object" && !Array.isArray(row.metrics) ? row.metrics : {};
  const out = {};
  for (const key of ASIN_ADS_METRIC_KEYS) {
    const field = ASIN_ADS_METRIC_FIELDS[key];
    if (Object.prototype.hasOwnProperty.call(m, field)) { const v = numOrNull(m[field]); if (v != null) out[key] = v; }
  }
  return out;
}

// Add the present metrics of `m` into the accumulator `acc` (creating a field only when a value is present, so a
// currency group that never saw `attributedUnits` reports no attributedUnits rather than a fabricated 0).
function addMetrics(acc, m) {
  for (const key of ASIN_ADS_METRIC_KEYS) if (key in m) acc[key] = (acc[key] || 0) + m[key];
}

// Deduplicate rows by the natural grain (last updated_at wins on a collision) and drop malformed rows (no date).
function dedupeRows(rows) {
  const byKey = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || !S(row.metric_date)) continue;
    const k = asinAdsNaturalKey(row);
    const prev = byKey.get(k);
    if (!prev || S(row.updated_at) >= S(prev.updated_at)) byKey.set(k, row);
  }
  return [...byKey.values()];
}

/**
 * ACCOUNT-LEVEL aggregation (Daily Reporting): fold EVERY ASIN's ASIN-Ads rows for the account into per-CURRENCY
 * metric totals (never combining currencies). Unmapped ASINs still count -- they belong to the account. Returns
 * { byCurrency: { <currency>: {impressions?,clicks?,spend?,attributedSales?,attributedOrders?,attributedUnits?} },
 *   currencies: [<currency>...], multiCurrency: bool, rows: <deduped row count> }. An EMPTY input yields
 * byCurrency:{} (the caller, not this helper, decides unavailable-vs-genuine-zero from coverage).
 */
export function aggregateAccountAsinAds(rows) {
  const deduped = dedupeRows(rows);
  const byCurrency = {};
  for (const row of deduped) {
    const cur = normalizeAdsCurrency(row.currency);
    (byCurrency[cur] = byCurrency[cur] || {});
    addMetrics(byCurrency[cur], asinAdsMetricsFromRow(row));
  }
  const currencies = Object.keys(byCurrency).sort();
  return { byCurrency, currencies, multiCurrency: currencies.length > 1, rows: deduped.length };
}

/**
 * DAILY REPORTING projection (account-level, per-DATE): fold the account's ASIN-Ads rows into per-(date,
 * currency) canonical Ads rows shaped for the EXISTING Daily merge/coverage contract:
 *   { date, seller_or_vendor_id, currency, ad_sales, ad_spend, ad_clicks }.
 * attributedSales (ad_sales_same_sku) becomes ad_sales -- the ONLY attributed-sales value the ASIN contract
 * supplies (same-SKU; no campaign halo). Currency is UPPERCASED and a blank stays blank -> null (NOT the
 * UNKNOWN group): the Daily per-account contract validates every row against ONE authoritative account currency
 * and treats a null currency on a zero row as safe, so we must preserve the raw (blank->null) currency shape
 * rather than the account-level helper's typed UNKNOWN bucket. `rawSellerId` is stamped from account metadata
 * (never read from a row) so every canonical row carries the authoritative partition key the coverage validator
 * checks. In a per-(date,currency) SUM an absent metric contributes 0 (the additive identity) -- this is not an
 * invented value: the group's total is exactly the sum of the metrics the contract actually supplied.
 */
export function aggregateAsinAdsDailyRows(rows, { rawSellerId = null } = {}) {
  const deduped = dedupeRows(rows);
  const byKey = new Map();
  for (const row of deduped) {
    const date = S(row.metric_date);
    if (!date) continue;
    const cur = S(row.currency).trim().toUpperCase(); // blank stays "" (NOT the UNKNOWN group)
    const k = date + "|" + cur;
    let g = byKey.get(k);
    if (!g) { g = { date, currency: cur, sales: undefined, spend: undefined, clicks: undefined }; byKey.set(k, g); }
    const m = row && row.metrics && typeof row.metrics === "object" && !Array.isArray(row.metrics) ? row.metrics : {};
    // Strict per-metric fold for the coverage-VALIDATED Daily path: an ABSENT metric (missing key / null)
    // contributes nothing (never invented as 0), a present NUMBER adds, but a present NON-FINITE value is
    // corrupt -- it poisons the group's total to NaN so resolveDailyAdsAvailability BLOCKS the whole account's
    // Ads (fail closed; sales still survive), never a coerced-to-zero total.
    g.sales = foldDailyMetric(g.sales, m[ASIN_ADS_METRIC_FIELDS.attributedSales]);
    g.spend = foldDailyMetric(g.spend, m[ASIN_ADS_METRIC_FIELDS.spend]);
    g.clicks = foldDailyMetric(g.clicks, m[ASIN_ADS_METRIC_FIELDS.clicks]);
  }
  return [...byKey.values()]
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.currency < b.currency ? -1 : a.currency > b.currency ? 1 : 0))
    .map((g) => ({
      date: g.date,
      seller_or_vendor_id: rawSellerId,
      currency: g.currency || null,
      ad_sales: g.sales === undefined ? 0 : g.sales,
      ad_spend: g.spend === undefined ? 0 : g.spend,
      ad_clicks: g.clicks === undefined ? 0 : g.clicks,
    }));
}

// Fold one raw metric value into a running daily total. undefined accumulator = "no value seen yet".
// null/undefined value = absent (no contribution). A finite number adds. A present non-finite value returns
// NaN, which -- once summed -- keeps the total NaN so the coverage validator rejects the corrupt Ads data.
function foldDailyMetric(acc, value) {
  if (value == null) return acc;
  const n = Number(value);
  const add = Number.isFinite(n) ? n : NaN;
  return acc === undefined ? add : acc + add;
}

/**
 * BRAND-LEVEL aggregation (Brand View + brand-scoped Daily): map each row's child_asin -> brand via
 * `asinBrandMap` (a Map child_asin(UPPER) -> brand); fold ONLY the selected brand's rows into per-currency
 * totals, and keep every UNMAPPED row's metrics in a SEPARATE typed per-currency `unmapped` amount (never
 * assigned to the brand, never dropped). Two brands in one account stay strictly separated (each call filters to
 * one brand). Returns { byCurrency, unmapped:{byCurrency}, currencies, matchedRows, unmappedRows }.
 */
export function aggregateBrandAsinAds(rows, asinBrandMap, brand) {
  const deduped = dedupeRows(rows);
  const map = asinBrandMap instanceof Map ? asinBrandMap : new Map(Object.entries(asinBrandMap || {}));
  const wanted = S(brand).trim();
  const byCurrency = {}; const unmappedByCurrency = {};
  let matchedRows = 0; let unmappedRows = 0;
  for (const row of deduped) {
    const asin = asinOf(row);
    const mapped = asin ? map.get(asin) : undefined;
    const cur = normalizeAdsCurrency(row.currency);
    const metrics = asinAdsMetricsFromRow(row);
    if (mapped != null && S(mapped).trim() === wanted) {
      (byCurrency[cur] = byCurrency[cur] || {}); addMetrics(byCurrency[cur], metrics); matchedRows += 1;
    } else if (mapped == null || S(mapped).trim() === "") {
      // no PROVEN unique brand for this ASIN -> a typed unmapped amount (never attributed to a brand).
      (unmappedByCurrency[cur] = unmappedByCurrency[cur] || {}); addMetrics(unmappedByCurrency[cur], metrics); unmappedRows += 1;
    }
    // else: a row mapped to a DIFFERENT brand -> excluded from this brand (strict separation), not "unmapped".
  }
  const currencies = [...new Set([...Object.keys(byCurrency), ...Object.keys(unmappedByCurrency)])].sort();
  return { byCurrency, unmapped: { byCurrency: unmappedByCurrency }, currencies, matchedRows, unmappedRows };
}
