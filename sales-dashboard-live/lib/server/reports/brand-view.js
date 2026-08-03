// Account-scoped Brand View.
//
// This is a NEW module. It does not share state, cache keys, report keys or
// builders with the older portfolio "Brand View" (`brand-portfolio`) or with the
// Account View dashboard, and it never modifies either.
//
// THE SCOPE RULE THAT MATTERS MOST
//   Every function here takes exactly ONE `accountId` and reads only that
//   account's saved snapshots and that account's saved Ads rows. There is no
//   code path that iterates accounts, so one account's brands, sales, ads or
//   inventory cannot appear under another account. Account permission is
//   asserted by api/datadoe.js before anything here runs.
//
// SOURCES (all already-saved shared Supabase snapshots — never a DataDoe call)
//   sales      `brand-sales`  snapshot: Order Line Items joined to Product
//                             Catalog, already folded to
//                             (date, country, currency, product_brand).
//   ads        `ads_daily_source_rows` rows with source_key
//                             `asin-performance-v1`, written by the scheduled
//                             Ads worker. Joined to this account's ASIN->brand
//                             map so brand TACoS never carries whole-account
//                             spend.
//   inventory  `fba-plan`     snapshot: latest FBA Inventory Health values.
//
// WHAT IS SAVED
//   One compact snapshot per (account, brand, as-of). The SKU/ASIN dimension is
//   aggregated away, so payload size is bounded by (countries x days) and is
//   independent of how many thousands of SKUs an account has.

// ---------------------------------------------------------------- identifiers

export const BRAND_VIEW_REPORT_KEY = "brand-view";
// Bump when a formula or the payload shape changes, so a snapshot saved by an
// older definition can never be presented as this one.
export const BRAND_VIEW_VERSION = "brand-view-account-scoped-v1";

export const BRAND_VIEW_BRANDS_REPORT_KEY = "brand-view-brands";
export const BRAND_VIEW_BRANDS_VERSION = "brand-view-brands-v1";

// The cross-account report. Same payload shape, same calculations, same tables
// and same exports as the single-account one — only the set of accounts differs.
export const BRAND_VIEW_PORTFOLIO_REPORT_KEY = "brand-view-portfolio";
export const BRAND_VIEW_PORTFOLIO_VERSION = "brand-view-portfolio-v1";

// The ASIN-level Ads history maintained by the scheduled worker.
export const BRAND_VIEW_ADS_SOURCE_KEY = "asin-performance-v1";

// Saved snapshots that carry a usable brand name for one account, in preference
// order. `brand-sales` is first because it is the only one whose brands are
// proven by actual order value in this account.
export const BRAND_SOURCE_SNAPSHOT_KEYS = ["brand-sales", "fba-plan", "sku-pl"];

// Snapshots that carry an ASIN together with its catalog brand. Needed to make
// ASIN-level Ads rows brand-scoped.
//
// Order is preference order, and first mapping wins. `fba-plan` and `sku-pl`
// come from a direct Product Catalog join, so they lead; the insight reports
// carry the same joined brand and are what make brand TACoS usable on accounts
// that have never refreshed a shipment plan. `brand-sales` is deliberately
// absent: it is folded to brand grain and has no ASIN at all.
export const ASIN_BRAND_SNAPSHOT_KEYS = [
  "fba-plan", "sku-pl", "listing-health", "sales-movers",
  "returns-leakage", "buy-box-loss", "listing-optimizer",
];

// Listing Health enumerates the whole listing catalogue with the same FBA
// Inventory Health `fbaAvailable` field the shipment plan uses, so it is a
// sound fallback when no FBA Shipment Plan has been saved. It carries no
// marketplace dimension, so it can only ever produce an account-level total.
const INVENTORY_FALLBACK_SNAPSHOT_KEY = "listing-health";

// `orderSalesByBrand` labels ASINs with no catalog brand as "Unassigned". That
// is real sales but not a brand, so it must not appear in a brand selector.
export const UNASSIGNED_BRAND = "Unassigned";

// A design guard, not a truncation point. Countries x days for one brand cannot
// legitimately reach this, so hitting it means an upstream grain changed.
const MAX_SERIES_ROWS = 80000;
// Ads rows are read for the reporting window only (six months), never the whole
// history, so a large account cannot blow the serverless memory budget.
const ADS_MAX_ROWS = 120000;

/**
 * The Supabase `account_id` used for a Brand View snapshot.
 *
 * The brand is part of this key rather than only part of `params_hash`, because
 * `getLatestReportSnapshot` (the across-midnight stale-scope fallback) looks up
 * by report key + account id alone. Without the brand in the key, selecting
 * brand A could be served brand B's saved snapshot after a date rollover.
 */
export function brandViewScopeId(accountId, brand) {
  return `brand-view:${String(accountId)}::${String(brand)}`;
}

/** The same key rule for the cross-account report: the account set plus the brand. */
export function brandViewPortfolioScopeId(accountIds, brand) {
  const ids = [...new Set((accountIds || []).map(String))].sort().join(",");
  return `brand-view-portfolio:${ids}::${String(brand)}`;
}

/* ------------------------------------------------------------- date helpers */
// Local, pure, UTC-string arithmetic so this module is unit-testable with no
// imports and no timezone ambiguity.

function pad2(value) { return String(value).padStart(2, "0"); }

export function parseDateStr(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
  if (!match) return null;
  return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
}

export function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function addDays(dateStr, days) {
  const parts = parseDateStr(dateStr);
  if (!parts) return null;
  const time = Date.UTC(parts.y, parts.m - 1, parts.d) + days * 86400000;
  const date = new Date(time);
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

export function monthStart(dateStr) {
  const parts = parseDateStr(dateStr);
  return parts ? `${parts.y}-${pad2(parts.m)}-01` : null;
}

export function monthEnd(dateStr) {
  const parts = parseDateStr(dateStr);
  if (!parts) return null;
  return `${parts.y}-${pad2(parts.m)}-${pad2(daysInMonth(parts.y, parts.m))}`;
}

/** Full calendar month `back` months before the month containing `dateStr`. */
export function monthBack(dateStr, back) {
  const parts = parseDateStr(dateStr);
  if (!parts) return null;
  const total = parts.y * 12 + (parts.m - 1) - back;
  const y = Math.floor(total / 12);
  const m = (((total % 12) + 12) % 12) + 1;
  return { key: `${y}-${pad2(m)}`, from: `${y}-${pad2(m)}-01`, to: `${y}-${pad2(m)}-${pad2(daysInMonth(y, m))}` };
}

/**
 * The same calendar date one year earlier, clamped for 29 February.
 *
 * A "previous-year period" means the equivalent calendar window, not 365 days
 * ago; the two differ across a leap year.
 */
export function shiftYear(dateStr, years) {
  const parts = parseDateStr(dateStr);
  if (!parts) return null;
  const y = parts.y + years;
  const d = Math.min(parts.d, daysInMonth(y, parts.m));
  return `${y}-${pad2(parts.m)}-${pad2(d)}`;
}

/* ------------------------------------------------------- brand-name discovery */

function trimmed(value) {
  return String(value === null || value === undefined ? "" : value).trim();
}

/**
 * Brand names observed in ONE account's saved payloads.
 *
 * Only names that a saved report actually recorded for this account are
 * returned. There is no portfolio-wide list and no catalog call, which is what
 * makes cross-account brand leakage structurally impossible.
 */
export function brandNamesFromPayload(payload) {
  const names = new Set();
  for (const brand of payload?.catalogBrands || []) {
    const name = trimmed(brand);
    if (name && name !== UNASSIGNED_BRAND) names.add(name);
  }
  for (const row of payload?.rows || []) {
    // `brand-sales` uses product_brand; `fba-plan` and `sku-pl` use brand.
    const name = trimmed(row?.product_brand ?? row?.brand);
    if (name && name !== UNASSIGNED_BRAND) names.add(name);
  }
  return [...names];
}

export function sortBrands(names) {
  return [...new Set(names)].sort((a, b) => a.localeCompare(b));
}

/**
 * ASIN -> brand for ONE account, from that account's saved snapshots.
 *
 * The `brand-sales` snapshot is deliberately not used here: it is already folded
 * to brand grain and carries no ASIN, so reading it would silently produce an
 * empty map and make every brand's ad spend look like zero.
 */
export function asinBrandMapFromPayloads(payloads) {
  const map = new Map();
  for (const payload of payloads) {
    // Most reports keep their catalogue under `rows`; Listing Optimizer keeps
    // it under `products`. Both carry the same joined `asin` + `brand`.
    for (const row of [...(payload?.rows || []), ...(payload?.products || [])]) {
      const asin = trimmed(row?.asin ?? row?.child_asin).toUpperCase();
      const brand = trimmed(row?.brand ?? row?.product_brand);
      if (!asin || !brand || brand === UNASSIGNED_BRAND) continue;
      if (!map.has(asin)) map.set(asin, brand);
    }
  }
  return map;
}

/* ------------------------------------------------------------- aggregation */

// "IT|2026-07-27". Neither an ISO country code nor a YYYY-MM-DD date can
// contain a pipe, so the key is unambiguous and safe to split back apart.
function seriesKey(country, date) {
  return `${country}|${date}`;
}

/**
 * Fold one account's brand-scoped sales rows to (country, date).
 *
 * Returns `{ series, countries, minDate, maxDate }` where `series` is a Map of
 * key -> { c, cur, d, s, u, x } (country, currency, date, sales, units,
 * unpriced units) and `countries` is a Map of country -> currency.
 *
 * A country whose rows disagree about currency keeps the first currency seen and
 * records the conflict, because silently mixing two currencies into one number
 * is the single worst thing this report could do.
 */
export function aggregateBrandSales(rows, brand) {
  const series = new Map();
  const countries = new Map();
  const currencyConflicts = new Set();
  let minDate = null;
  let maxDate = null;

  for (const row of rows || []) {
    if (trimmed(row?.product_brand) !== brand) continue;
    const date = trimmed(row?.date);
    if (!parseDateStr(date)) continue;
    const country = trimmed(row?.marketplace_country_code).toUpperCase();
    const currency = trimmed(row?.currency).toUpperCase() || null;

    // Take the first NON-NULL currency, not simply the first row's. Some saved
    // rows carry an empty currency; if one of those happened to come first, the
    // whole marketplace would render as "currency unavailable" even though every
    // other row names it.
    const known = countries.get(country);
    if (known === undefined || known === null) countries.set(country, currency);
    else if (currency && currency !== known) currencyConflicts.add(country);

    const key = seriesKey(country, date);
    const entry = series.get(key) || { c: country, cur: countries.get(country), d: date, s: 0, u: 0, x: 0 };
    entry.s += Number(row?.total_sales) || 0;
    entry.u += Number(row?.total_units_sold) || 0;
    entry.x += Number(row?.unpriced_units) || 0;
    series.set(key, entry);

    if (!minDate || date < minDate) minDate = date;
    if (!maxDate || date > maxDate) maxDate = date;
  }

  return { series, countries, currencyConflicts: [...currencyConflicts], minDate, maxDate };
}

/**
 * Fold this account's saved ASIN-level Ads rows to (country, date) for ONE brand.
 *
 * `adCountries` records every country that has ANY saved ad row in the window,
 * brand-matched or not. That distinction is what lets the UI show `-` for a
 * marketplace whose Ads history has never been synced, while showing a real 0
 * for a synced marketplace where this brand genuinely had no spend.
 */
export function aggregateBrandAds(adRows, asinBrand, brand) {
  const spendByKey = new Map();
  const adCountries = new Set();
  const coverageByCountry = new Map();
  let matchedRows = 0;

  for (const row of adRows || []) {
    const date = trimmed(row?.metric_date);
    if (!parseDateStr(date)) continue;
    const country = trimmed(row?.marketplace_country_code).toUpperCase();
    adCountries.add(country);
    const coverage = coverageByCountry.get(country) || { from: date, to: date };
    if (date < coverage.from) coverage.from = date;
    if (date > coverage.to) coverage.to = date;
    coverageByCountry.set(country, coverage);
    const asin = trimmed(row?.child_asin).toUpperCase();
    if (!asin || asinBrand.get(asin) !== brand) continue;
    matchedRows += 1;
    const key = seriesKey(country, date);
    spendByKey.set(key, (spendByKey.get(key) || 0) + (Number(row?.metrics?.ad_spend) || 0));
  }

  return { spendByKey, adCountries: [...adCountries], coverageByCountry, matchedRows };
}

/**
 * Per-country FBA available units for ONE brand, from the saved fba-plan payload.
 *
 * `inventoryByBrandCountry` is the additive field the FBA Shipment Plan builder
 * now saves. Older snapshots do not have it; in that case the account-level
 * total is still returned so the All Markets row stays truthful and the
 * per-country cells are honestly unavailable rather than guessed.
 */
export function brandInventory(planPayload, brand, accountCountry, fallbackPayload) {
  const byCountry = new Map();
  let accountTotal = null;
  let scope = "unavailable";
  let source = null;

  const detailed = planPayload?.inventoryByBrandCountry;
  if (Array.isArray(detailed) && detailed.length) {
    scope = "country";
    source = "fba-plan";
    for (const entry of detailed) {
      if (trimmed(entry?.brand) !== brand) continue;
      const country = trimmed(entry?.country).toUpperCase() || trimmed(accountCountry).toUpperCase();
      const available = Number(entry?.fbaAvailable);
      if (!Number.isFinite(available)) continue;
      byCountry.set(country, (byCountry.get(country) || 0) + available);
      accountTotal = (accountTotal || 0) + available;
    }
    return { byCountry, accountTotal, scope, source };
  }

  // Per-ASIN rows with no marketplace dimension: an older FBA Shipment Plan
  // payload first, then Listing Health, which carries the same FBA Inventory
  // Health field across the whole listing catalogue. Either can only produce an
  // account-level total, which the caller labels rather than spreading across
  // countries it cannot actually attribute.
  for (const [candidate, candidateSource] of [[planPayload, "fba-plan"], [fallbackPayload, INVENTORY_FALLBACK_SNAPSHOT_KEY]]) {
    let known = false;
    let total = 0;
    for (const row of candidate?.rows || []) {
      if (trimmed(row?.brand) !== brand) continue;
      const available = Number(row?.fbaAvailable);
      if (!Number.isFinite(available)) continue;
      known = true;
      total += available;
    }
    if (known) return { byCountry, accountTotal: total, scope: "account", source: candidateSource };
  }

  return { byCountry, accountTotal, scope, source };
}

/* ------------------------------------------------------------ the two builds */

/**
 * The account-scoped brand directory.
 *
 * Reads only `accountId`'s saved snapshots. Never calls DataDoe: a brand list is
 * a dropdown, and spending a Product Catalog export to fill a dropdown is what
 * previously made this feature fail on catalog credits.
 */
export async function buildBrandViewBrandDirectory({ accountId, getSnapshot }) {
  const sources = [];
  const names = [];

  for (const reportKey of BRAND_SOURCE_SNAPSHOT_KEYS) {
    const snapshot = await getSnapshot({ reportKey, accountId });
    const found = brandNamesFromPayload(snapshot?.payload);
    if (!found.length) continue;
    names.push(...found);
    sources.push({
      reportKey,
      brandCount: found.length,
      savedAt: snapshot?.source_refreshed_at || snapshot?.updated_at || null,
    });
  }

  const brands = sortBrands(names);
  return {
    accountId: String(accountId),
    brands,
    sources,
    message: brands.length
      ? null
      : "No saved report for this account records a brand yet. Open Account View for this account and refresh its Dashboard (or SKU P&L) once; Brand View will then read that saved data without any new export.",
  };
}

/**
 * Everything one account contributes for one brand.
 *
 * This is the single place that reads an account. Both the account-scoped report
 * and the cross-account portfolio report are assembled from these slices, so the
 * two reports can never drift apart in their definitions — the portfolio is
 * literally the sum of the same per-account numbers.
 *
 * Returns null when this account has nothing for the brand, so the portfolio
 * build can skip it without treating it as an error.
 */
export async function buildAccountBrandSlice({ accountId, brand, asOf, account, getSnapshot, getAdsRows, required = true }) {
  const salesSnapshot = await getSnapshot({ reportKey: "brand-sales", accountId });
  const salesPayload = salesSnapshot?.payload;
  if (!salesPayload?.rows?.length) {
    if (!required) return { accountId: String(accountId), skipped: "no-sales-snapshot" };
    throw new Error("This account has no saved Dashboard sales snapshot yet, so a brand report cannot be built from saved data. Open Account View for this account and refresh the Dashboard once; that saved snapshot is shared with every authorised user and Brand View will then use it.");
  }

  const sales = aggregateBrandSales(salesPayload.rows, brand);
  if (!sales.series.size) {
    if (!required) return { accountId: String(accountId), skipped: "brand-not-sold" };
    throw new Error(`The saved sales snapshot for this account records no order value for "${brand}". Confirm the brand is still sold in this account, or refresh Account View for a newer snapshot.`);
  }

  // The requested window of the saved snapshot is the authoritative coverage
  // boundary. Row min/max only show where sales happened, which would make a
  // quiet month look like missing history and wrongly suppress a last-year
  // comparison.
  const salesFrom = parseDateStr(salesSnapshot?.params?.from) ? salesSnapshot.params.from : sales.minDate;
  const salesTo = parseDateStr(salesSnapshot?.params?.to) ? salesSnapshot.params.to : sales.maxDate;

  // Ads and inventory come from this same account only. Each snapshot is read
  // once and reused, so widening the ASIN->brand sources does not multiply reads.
  const payloadByKey = new Map();
  const readOnce = async (reportKey) => {
    if (!payloadByKey.has(reportKey)) payloadByKey.set(reportKey, await getSnapshot({ reportKey, accountId }));
    return payloadByKey.get(reportKey);
  };

  const asinBrandPayloads = [];
  const asinBrandSources = [];
  for (const reportKey of ASIN_BRAND_SNAPSHOT_KEYS) {
    const snapshot = await readOnce(reportKey);
    const payload = snapshot?.payload;
    if (!payload?.rows?.length && !payload?.products?.length) continue;
    asinBrandPayloads.push(payload);
    asinBrandSources.push(reportKey);
  }
  const asinBrand = asinBrandMapFromPayloads(asinBrandPayloads);

  // Six calendar months of ad history is exactly what the Monthly Snapshot
  // needs; the last-year column is sales only, so no ad history is read for it.
  const adsRequestFrom = monthBack(asOf, 5)?.from || monthStart(asOf);
  let adsError = null;
  let adRows = [];
  if (asinBrand.size) {
    try {
      adRows = await getAdsRows({
        accountId,
        sourceKeys: [BRAND_VIEW_ADS_SOURCE_KEY],
        from: adsRequestFrom,
        to: asOf,
        maxRows: ADS_MAX_ROWS,
      });
    } catch (error) {
      adsError = error instanceof Error ? error.message : String(error);
    }
  }
  const ads = aggregateBrandAds(adRows, asinBrand, brand);

  const planSnapshot = await readOnce("fba-plan");
  const inventoryFallbackSnapshot = await readOnce(INVENTORY_FALLBACK_SNAPSHOT_KEY);
  const inventory = brandInventory(
    planSnapshot?.payload,
    brand,
    account?.country,
    inventoryFallbackSnapshot?.payload
  );
  const inventorySnapshot = inventory.source === INVENTORY_FALLBACK_SNAPSHOT_KEY ? inventoryFallbackSnapshot : planSnapshot;

  return {
    accountId: String(accountId),
    accountName: account?.name
      || salesPayload.rows.find((row) => row.seller_or_vendor_name)?.seller_or_vendor_name
      || null,
    accountCountry: trimmed(account?.country).toUpperCase() || null,
    sales,
    salesFrom,
    salesTo,
    salesSavedAt: salesSnapshot?.source_refreshed_at || salesSnapshot?.updated_at || null,
    ads,
    adsError,
    // Ads are only trustworthy for this account when it actually has an
    // ASIN->brand map; without one every spend row would be unattributable.
    adsUsable: Boolean(asinBrand.size) && !adsError,
    asinBrandSources,
    asinBrandCount: asinBrand.size,
    inventory,
    inventoryDate: inventorySnapshot?.payload?.inventoryDate
      || inventorySnapshot?.payload?.inventorySnapshotDate
      || null,
    inventorySavedAt: inventorySnapshot?.source_refreshed_at || inventorySnapshot?.updated_at || null,
  };
}

/**
 * Assemble one or more account slices into the single payload shape both Brand
 * View reports render.
 *
 * MERGE RULES, and why each one is what it is:
 *
 *  - Sales and units for the same marketplace are summed across accounts. Two
 *    accounts selling the brand in India are one India row.
 *  - A marketplace's currency must agree across accounts. A disagreement is
 *    recorded rather than silently resolved, because adding two currencies into
 *    one cell is the worst thing this report could do.
 *  - **Ad spend is available for a marketplace only when EVERY account selling
 *    there has saved Ads coverage for it.** If one of two accounts in India has
 *    no Ads history, the India spend we could compute would be a partial sum,
 *    which understates TACoS. Partial is refused; the cell is unavailable.
 *  - The Ads window for a marketplace is the INTERSECTION across its accounts,
 *    for the same reason.
 *  - Sales coverage is the intersection too (latest start, earliest end), so a
 *    last-year comparison is only offered when every contributing account can
 *    actually answer for that window.
 *  - `salesLatestDate` is the newest date any account populated; accounts that
 *    lag behind it are named in a note rather than quietly dragging a day down.
 */
export function assembleBrandViewPayload({ slices, brand, asOf, scope }) {
  const usable = slices.filter((slice) => slice && !slice.skipped);
  if (!usable.length) {
    throw new Error(`No saved account snapshot records any order value for "${brand}". Refresh the Dashboard once for an account that sells this brand; Brand View then reads that saved data without a new export.`);
  }

  /* ---------- sales ---------- */
  const seriesByKey = new Map();
  const currencyByCountry = new Map();
  const currencyConflicts = new Set();
  const accountsByCountry = new Map();
  let salesFrom = null;
  let salesTo = null;
  let salesLatestDate = null;
  // The newest date EVERY contributing account has populated. Beyond it the
  // combined total is real but incomplete, which is worth stating plainly.
  let salesCompleteThrough = null;

  for (const slice of usable) {
    // Intersection: the window every contributing account can answer for.
    if (!salesFrom || (slice.salesFrom && slice.salesFrom > salesFrom)) salesFrom = slice.salesFrom;
    if (!salesTo || (slice.salesTo && slice.salesTo < salesTo)) salesTo = slice.salesTo;
    if (slice.sales.maxDate && (!salesLatestDate || slice.sales.maxDate > salesLatestDate)) salesLatestDate = slice.sales.maxDate;
    if (slice.sales.maxDate && (!salesCompleteThrough || slice.sales.maxDate < salesCompleteThrough)) salesCompleteThrough = slice.sales.maxDate;

    for (const [country, currency] of slice.sales.countries) {
      const known = currencyByCountry.get(country);
      if (known === undefined || known === null) currencyByCountry.set(country, currency);
      else if (currency && currency !== known) currencyConflicts.add(country);
      if (slice.sales.currencyConflicts.includes(country)) currencyConflicts.add(country);
      const names = accountsByCountry.get(country) || new Set();
      if (slice.accountName) names.add(slice.accountName);
      accountsByCountry.set(country, names);
    }

    for (const entry of slice.sales.series.values()) {
      const key = seriesKey(entry.c, entry.d);
      const merged = seriesByKey.get(key) || { c: entry.c, d: entry.d, s: 0, u: 0, x: 0 };
      merged.s += entry.s;
      merged.u += entry.u;
      merged.x += entry.x;
      seriesByKey.set(key, merged);
    }
  }

  /* ---------- ads ---------- */
  // A marketplace is ads-answerable only when every account selling there has
  // saved Ads coverage for it.
  const adsCoverageByCountry = {};
  const adsCountries = [];
  const spendByKey = new Map();
  let adsMatchedRows = 0;

  for (const country of currencyByCountry.keys()) {
    const contributors = usable.filter((slice) => slice.sales.countries.has(country));
    const covered = contributors.every((slice) => slice.adsUsable && slice.ads.coverageByCountry.has(country));
    if (!contributors.length || !covered) continue;

    let from = null;
    let to = null;
    for (const slice of contributors) {
      const coverage = slice.ads.coverageByCountry.get(country);
      if (!from || coverage.from > from) from = coverage.from;   // intersection
      if (!to || coverage.to < to) to = coverage.to;
    }
    if (!from || !to || from > to) continue;

    adsCountries.push(country);
    adsCoverageByCountry[country] = { from, to };
    for (const slice of contributors) {
      for (const [key, spend] of slice.ads.spendByKey) {
        if (!key.startsWith(`${country}|`)) continue;
        const date = key.slice(country.length + 1);
        if (date < from || date > to) continue;
        spendByKey.set(key, (spendByKey.get(key) || 0) + spend);
        adsMatchedRows += 1;
      }
    }
  }
  const adsBounds = Object.values(adsCoverageByCountry).reduce((current, coverage) => ({
    from: !current.from || coverage.from < current.from ? coverage.from : current.from,
    to: !current.to || coverage.to > current.to ? coverage.to : current.to,
  }), { from: null, to: null });

  /* ---------- inventory ---------- */
  const inventoryByCountry = new Map();
  let inventoryAccountTotal = null;
  let inventoryDate = null;
  const inventoryScopes = new Set();
  const inventorySources = new Set();
  for (const slice of usable) {
    if (slice.inventory.scope === "unavailable") continue;
    inventoryScopes.add(slice.inventory.scope);
    if (slice.inventory.source) inventorySources.add(slice.inventory.source);
    for (const [country, available] of slice.inventory.byCountry) {
      inventoryByCountry.set(country, (inventoryByCountry.get(country) || 0) + available);
    }
    if (slice.inventory.accountTotal !== null) {
      inventoryAccountTotal = (inventoryAccountTotal || 0) + slice.inventory.accountTotal;
    }
    if (slice.inventoryDate && (!inventoryDate || slice.inventoryDate > inventoryDate)) inventoryDate = slice.inventoryDate;
  }
  const inventoryScope = !inventoryScopes.size
    ? "unavailable"
    : inventoryScopes.has("account") && inventoryScopes.has("country") ? "mixed"
      : [...inventoryScopes][0];

  /* ---------- countries ---------- */
  const adsCountrySet = new Set(adsCountries);
  const countries = [];
  for (const [country, currency] of currencyByCountry) {
    countries.push({
      country,
      currency,
      hasSales: true,
      adsAvailable: adsCountrySet.has(country),
      fbaAvailable: inventoryByCountry.has(country) ? inventoryByCountry.get(country) : null,
      currencyConflict: currencyConflicts.has(country),
      accounts: [...(accountsByCountry.get(country) || [])].sort(),
    });
  }
  // A marketplace can hold stock for the brand without selling it in the report
  // window (the reference report calls this "FC only"). It is real inventory and
  // must be shown, with no invented sales.
  for (const [country, available] of inventoryByCountry) {
    if (currencyByCountry.has(country)) continue;
    countries.push({
      country,
      currency: null,
      hasSales: false,
      adsAvailable: adsCountrySet.has(country),
      fbaAvailable: available,
      currencyConflict: false,
      accounts: [],
    });
  }
  countries.sort((a, b) => a.country.localeCompare(b.country));

  /* ---------- series ---------- */
  const series = [];
  for (const entry of seriesByKey.values()) {
    const row = { c: entry.c, cur: currencyByCountry.get(entry.c) ?? null, d: entry.d, s: round4(entry.s), u: entry.u };
    if (entry.x) row.x = entry.x;
    const spend = spendByKey.get(seriesKey(entry.c, entry.d));
    if (spend !== undefined) row.a = round4(spend);
    series.push(row);
  }
  // Days with ad spend but no order value are still real spend days.
  for (const [key, spend] of spendByKey) {
    if (seriesByKey.has(key)) continue;
    const [country, date] = key.split("|");
    series.push({ c: country, cur: currencyByCountry.get(country) ?? null, d: date, s: 0, u: 0, a: round4(spend) });
  }
  if (series.length > MAX_SERIES_ROWS) {
    throw new Error(`Brand View produced ${series.length.toLocaleString("en-US")} country/day rows, above the ${MAX_SERIES_ROWS.toLocaleString("en-US")} design limit. It was not saved. This means an upstream source changed grain; report it rather than narrowing the window.`);
  }
  series.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : a.c.localeCompare(b.c)));

  /* ---------- notes ---------- */
  const notes = [];
  const label = (slice) => slice.accountName || slice.accountId;

  const noAsinMap = usable.filter((slice) => !slice.asinBrandCount);
  if (noAsinMap.length === usable.length) {
    notes.push("Ad spend and TACoS are unavailable because no saved report maps ASINs to a brand yet. Refresh FBA Shipment Plan, SKU P&L, Listing Health or Sales Movers once for these accounts to build that mapping.");
  } else if (noAsinMap.length) {
    notes.push(`These accounts have no saved ASIN-to-brand mapping, so their marketplaces show ad spend as unavailable rather than as zero: ${noAsinMap.map(label).join(", ")}.`);
  }
  const adsFailed = usable.filter((slice) => slice.adsError);
  if (adsFailed.length) {
    notes.push(`Saved Ads history could not be read for ${adsFailed.map(label).join(", ")}: ${adsFailed[0].adsError}`);
  }
  // Only worth saying when Ads DO work somewhere: it tells the reader the gap is
  // specific to these marketplaces rather than the whole report. When nothing
  // has ads at all, the mapping note above already explains why.
  const salesOnlyCountries = [...currencyByCountry.keys()].filter((country) => !adsCountrySet.has(country));
  if (adsCountries.length && salesOnlyCountries.length) {
    notes.push(`No saved same-ASIN advertising covers every account selling in ${salesOnlyCountries.join(", ")}, so ad spend and TACoS there are shown as unavailable rather than as a partial sum.`);
  }
  if (inventoryScope === "unavailable") {
    notes.push("FBA inventory and inventory cover are unavailable because no contributing account has a saved FBA Shipment Plan or Listing Health snapshot yet.");
  } else if (inventoryScope !== "country") {
    const accountLevel = usable.filter((slice) => slice.inventory.scope === "account");
    notes.push(`FBA inventory for ${accountLevel.map(label).join(", ")} is account-level only, because the saved snapshot carries no marketplace dimension. Those units are excluded from the country rows rather than assigned to a marketplace. Refresh the FBA Shipment Plan once for those accounts to split inventory by country.`);
  }
  if (currencyConflicts.size) {
    notes.push(`These marketplaces reported more than one currency across the saved snapshots and are shown in the first currency seen: ${[...currencyConflicts].sort().join(", ")}. Verify the source before relying on their totals.`);
  }
  const lagging = usable.filter((slice) => slice.sales.maxDate && slice.sales.maxDate < salesLatestDate);
  if (lagging.length) {
    notes.push(`Every account is complete only through ${salesCompleteThrough}. These accounts' saved sales stop before ${salesLatestDate}, so the most recent days understate the combined total until they are refreshed: ${lagging.map((slice) => `${label(slice)} (to ${slice.sales.maxDate})`).join(", ")}.`);
  }
  const skipped = slices.filter((slice) => slice?.skipped);
  if (scope === "portfolio" && skipped.length) {
    notes.push(`${skipped.length} account${skipped.length === 1 ? "" : "s"} in scope had no saved order value for this brand and contributed nothing. That is not an error.`);
  }

  return {
    brandViewVersion: BRAND_VIEW_VERSION,
    scope: scope || "account",
    accountId: usable.length === 1 ? usable[0].accountId : null,
    accountName: usable.length === 1 ? usable[0].accountName : null,
    accountCountry: usable.length === 1 ? usable[0].accountCountry : null,
    accounts: usable.map((slice) => ({
      id: slice.accountId,
      name: slice.accountName,
      country: slice.accountCountry,
      latestDate: slice.sales.maxDate,
      salesFrom: slice.salesFrom,
      salesTo: slice.salesTo,
    })),
    brand,
    asOf,
    countries,
    series,
    coverage: {
      salesFrom,
      salesTo,
      salesSavedAt: usable
        .map((slice) => slice.salesSavedAt)
        .filter(Boolean)
        .sort()[0] || null,
      // Latest date the sales source actually populated. Used for MTD elapsed
      // days so a run rate is not diluted by dates the source has not filled.
      salesLatestDate,
      salesCompleteThrough,
      // Observed saved-row bounds, never the requested query bounds. This
      // prevents a partially seeded Ads history from becoming fake zero spend.
      adsFrom: adsBounds.from,
      adsTo: adsBounds.to,
      adsCoverageByCountry,
      adsMatchedRows,
      adsCountries,
      asinBrandSources: [...new Set(usable.flatMap((slice) => slice.asinBrandSources))],
      asinBrandCount: usable.reduce((total, slice) => total + slice.asinBrandCount, 0),
      inventoryScope,
      inventorySource: [...inventorySources].sort().join(", ") || null,
      inventoryAccountTotal,
      inventoryDate,
      inventorySavedAt: usable
        .map((slice) => slice.inventorySavedAt)
        .filter(Boolean)
        .sort()
        .pop() || null,
      accountCount: usable.length,
    },
    sources: {
      sales: "Saved Dashboard snapshots (Order Line Items joined to Product Catalog)",
      ads: "Saved Ad Performance by ASIN & Date rows joined to each account's ASIN-to-brand map",
      inventory: "Saved FBA Shipment Plan snapshots (FBA Inventory Health)",
    },
    notes,
  };
}

/**
 * The account-scoped Brand View report snapshot: exactly one account.
 */
export async function buildBrandViewSnapshot({ accountId, brand, asOf, account, getSnapshot, getAdsRows }) {
  const slice = await buildAccountBrandSlice({ accountId, brand, asOf, account, getSnapshot, getAdsRows, required: true });
  return assembleBrandViewPayload({ slices: [slice], brand, asOf, scope: "account" });
}

/**
 * The cross-account Brand View report snapshot: one brand across every account
 * it is mapped to.
 *
 * Accounts are read sequentially rather than in parallel on purpose: each read
 * can return a multi-megabyte saved Dashboard payload, and a serverless function
 * holding a dozen of those at once is how this route would run out of memory.
 */
export async function buildBrandViewPortfolioSnapshot({ accountIds, brand, asOf, accountsById, getSnapshot, getAdsRows }) {
  const slices = [];
  for (const accountId of accountIds) {
    slices.push(await buildAccountBrandSlice({
      accountId,
      brand,
      asOf,
      account: accountsById?.[String(accountId)] || null,
      getSnapshot,
      getAdsRows,
      required: false,
    }));
  }
  return assembleBrandViewPayload({ slices, brand, asOf, scope: "portfolio" });
}

// Money is summed from source values that already carry more precision than a
// currency's minor unit. Four decimals keeps the payload small without changing
// any displayed figure.
function round4(value) {
  return Math.round((Number(value) || 0) * 10000) / 10000;
}
