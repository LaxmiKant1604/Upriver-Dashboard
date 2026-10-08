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
//   inventory  `brand-inventory` compact snapshot (else the saved fba-plan payload): per account, the validated
//                             saved Listings inventory, else the account's LAST SAVED durable FBA Inventory Health
//                             snapshot as a dated, read-only, temporary BRIDGE (Listings inventory CUTOVER: no Health
//                             export exists any more; the bridge drives figures only while its snapshot date is within
//                             HEALTH_BRIDGE_MAX_AGE_DAYS of the report as-of), else Unavailable
//                             (lib/server/inventory-source.js selectAccountInventory). Listings has no date -- its
//                             freshness is the Listings fetch time; the bridge carries its snapshot date.
//
// WHAT IS SAVED
//   One compact snapshot per (account, brand, as-of). The SKU/ASIN dimension is
//   aggregated away, so payload size is bounded by (countries x days) and is
//   independent of how many thousands of SKUs an account has.

// The canonical ASIN-Ads primitives (the SINGLE reusable advertising source, shared with Daily Reporting):
// asinOf canonicalizes child_asin; asinAdsMetricsFromRow extracts ONLY the metrics the contract supplied
// (a present ad_spend counts, an absent one is never invented as 0). Both reports derive ASIN Ads identically.
import { asinOf, asinAdsMetricsFromRow } from "./asin-ads-aggregation.js";
import { campaignIdentityOfRow, campaignAdsMetricsFromRow, campaignBrandMap } from "./campaign-ads-aggregation.js";
import { brandKey } from "./brand-membership.js";
import { ACTIVE_ADS_SOURCE_KEY, ASIN_ADS_SOURCE_KEY } from "../active-ads-source.js";
import { brandCountryInventory, canonicalMarketplace, LISTINGS_INVENTORY_MODEL } from "../listings-inventory.js";
import {
  selectAccountInventory, selectionFoldView, HEALTH_BRIDGE_MAX_AGE_DAYS,
  INVENTORY_SOURCE_LISTINGS, INVENTORY_SOURCE_HEALTH_FALLBACK, INVENTORY_SOURCE_UNAVAILABLE,
} from "../inventory-source.js";
// The pan-European FBA pool marketplaces for the EU all-market rule (euPoolAllMarketRule). The web line reads this list
// from Product Reporting (brand-reporting.js PAN_EU_POOL_MARKETPLACES), which this line does not carry, so the SAME
// list is defined here: DataDoe reports one seller's pooled Pan-EU units in every pool marketplace; the UK left the
// pool in 2021 and keeps separate stock.
const PAN_EU_POOL_MARKETPLACES = Object.freeze(["BE", "DE", "ES", "FR", "IE", "IT", "NL", "PL", "SE"]);

// ---------------------------------------------------------------- identifiers

export const BRAND_VIEW_REPORT_KEY = "brand-view";
// Bump when a formula or the payload shape changes, so a snapshot saved by an
// older definition can never be presented as this one.
// v2: ASIN->Campaign cutover -- ad columns now come from the campaign grain, attributed via the campaign->brand
// mapping (empty until campaigns are mapped). Bumped so ASIN-based v1 snapshots re-derive instead of serving stale.
export const BRAND_VIEW_VERSION = "brand-view-account-scoped-v2";

export const BRAND_VIEW_BRANDS_REPORT_KEY = "brand-view-brands";
export const BRAND_VIEW_BRANDS_VERSION = "brand-view-brands-v1";

// The cross-account report. Same payload shape, same calculations, same tables
// and same exports as the single-account one — only the set of accounts differs.
export const BRAND_VIEW_PORTFOLIO_REPORT_KEY = "brand-view-portfolio";
export const BRAND_VIEW_PORTFOLIO_VERSION = "brand-view-portfolio-v1";
// How many account slices the portfolio rebuild reads at once. Small enough to hold only a few saved payloads
// in memory at a time, large enough to cut a dozen-account rebuild from ~37s to well under the route deadline.
export const PORTFOLIO_SLICE_CONCURRENCY = 4;

// The compact per-account FBA inventory snapshot Brand View prefers: a minimal roll-up of the account's selected
// inventory source folded to (country, brand). v2 (Listings inventory cutover): built from selectAccountInventory --
// validated saved Listings, else the last SAVED FBA Inventory Health snapshot (the dated read-only bridge, within its
// threshold of the as-of), else Unavailable -- and it records WHICH source it used (inventorySource), so a Health value
// is never presented as a Listings one.
export const BRAND_INVENTORY_SNAPSHOT_KEY = "brand-inventory";
export const BRAND_INVENTORY_REPORT_VERSION = "brand-inventory-shared-v2";
// The production v1 compact (folded from FBA Inventory Health, before phase 2). It is never produced again, but it is
// still SERVED during the transition (web deployed before the scheduler) as a legacy Health-sourced snapshot labelled
// with its Health date -- production stock is never hidden in that window.
export const BRAND_INVENTORY_LEGACY_REPORT_VERSION = "brand-inventory-shared-v1";
// The versions a brand-inventory candidate read SERVES (phase-2 transition): the newest AVAILABLE compact among both, so
// the web (deployed before the scheduler) still finds the production v1 Health compact. Selection prefers v2.
export const BRAND_INVENTORY_SERVE_VERSIONS = Object.freeze([BRAND_INVENTORY_REPORT_VERSION, BRAND_INVENTORY_LEGACY_REPORT_VERSION]);
// The inventory source of a legacy (pre-phase-2) Health payload: the v1 compact or an old Health-shaped fba-plan.
export const INVENTORY_SOURCE_HEALTH_LEGACY = "health-legacy";

// The ACTIVE durable Ads grain maintained by the scheduled worker. After the ASIN->Campaign cutover this is the
// campaign grain (campaign-performance-v1), attributed to brands via the manual campaign->brand mapping; rollback
// flips ACTIVE_ADS_SOURCE_KEY back to asin-performance-v1 (attributed via the ASIN->brand catalog map).
export const BRAND_VIEW_ADS_SOURCE_KEY = ACTIVE_ADS_SOURCE_KEY;

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

// (The former Listing Health v1 / rows-only fba-plan account-level inventory fallbacks are removed by the Listings
// inventory cutover: an undated, unlabelled value is never presented as current inventory. The saved fba-plan is used
// only in its phase-2 shape or its old Health shape, labelled with its Health date.)

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

// STRICT: a real UTC calendar date that round-trips. `parseDateStr` only checks the
// YYYY-MM-DD shape, so it accepts impossible dates (2025-02-30, 2025-13-40). This
// rebuilds the date in UTC and confirms every field is unchanged, so an impossible or
// normalized date is rejected while a genuine leap day (2024-02-29) is accepted.
export function isStrictCalendarDate(value) {
  const parts = parseDateStr(value);
  if (!parts) return false;
  const dt = new Date(Date.UTC(parts.y, parts.m - 1, parts.d));
  return dt.getUTCFullYear() === parts.y
    && dt.getUTCMonth() + 1 === parts.m
    && dt.getUTCDate() === parts.d;
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
    // Typed missing-order-value evidence (dormant in Brand View -- carried, never rendered as a warning). A legacy
    // payload's `unpriced_units` is intentionally NOT read, so a stale snapshot contributes 0 here.
    entry.x += Number(row?.missing_order_value_units) || 0;
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
    const asin = asinOf(row);
    if (!asin || asinBrand.get(asin) !== brand) continue;
    matchedRows += 1;
    const key = seriesKey(country, date);
    // Spend via the shared canonical extractor: a present ad_spend (0 included) counts; an absent metric is
    // omitted (never invented as 0), then treated as no contribution in this additive (country,date) fold.
    const spend = asinAdsMetricsFromRow(row).spend;
    spendByKey.set(key, (spendByKey.get(key) || 0) + (spend || 0));
  }

  return { spendByKey, adCountries: [...adCountries], coverageByCountry, matchedRows };
}

/**
 * CAMPAIGN-grain equivalent of aggregateBrandAds for the ASIN->Campaign cutover: attribute each campaign row to a
 * brand via the campaign identity -> brand-key map (campaign_brand_mapping) instead of child_asin -> brand, and fold
 * the matched brand's ad_spend per (country, date). Same return shape as aggregateBrandAds. `brandKeyWanted` is the
 * canonical key of the selected brand.
 *
 * A campaign mapped to ANOTHER brand is attributed elsewhere and creates no uncertainty for this brand. But an
 * UNMAPPED campaign (absent from the map) with real spend is UNKNOWN attribution -- that spend could belong to ANY
 * brand, including the selected one -- so a 0 for this brand where such spend exists is NOT a proven zero. We record
 * those (country|date) keys in `unattributedByKey`; the assembler emits them as an `au` flag so the read path shows an
 * em dash (Unavailable) rather than a fabricated 0. A genuine 0 remains only where the marketplace's campaign spend is
 * FULLY attributed for the range.
 */
export function aggregateBrandCampaignAdsSpend(adRows, campaignIdentityBrandKey, brandKeyWanted) {
  const spendByKey = new Map();
  const adCountries = new Set();
  const coverageByCountry = new Map();
  const unattributedByKey = new Set();
  let matchedRows = 0;
  const map = campaignIdentityBrandKey instanceof Map ? campaignIdentityBrandKey : new Map();
  for (const row of adRows || []) {
    const date = trimmed(row?.metric_date);
    if (!parseDateStr(date)) continue;
    const country = trimmed(row?.marketplace_country_code).toUpperCase();
    adCountries.add(country);
    const coverage = coverageByCountry.get(country) || { from: date, to: date };
    if (date < coverage.from) coverage.from = date;
    if (date > coverage.to) coverage.to = date;
    coverageByCountry.set(country, coverage);
    const id = campaignIdentityOfRow(row);
    if (!id) continue; // no campaign identity -> cannot attribute or count (unchanged)
    const key = seriesKey(country, date);
    const mappedBrand = map.get(id);
    if (mappedBrand === brandKeyWanted) {
      matchedRows += 1;
      const spend = campaignAdsMetricsFromRow(row).spend;
      spendByKey.set(key, (spendByKey.get(key) || 0) + (spend || 0));
    } else if (mappedBrand === undefined) {
      // Unmapped campaign (attributed to no brand). ONLY real spend creates attribution uncertainty for this brand.
      const spend = campaignAdsMetricsFromRow(row).spend;
      if (Number(spend) > 0) unattributedByKey.add(key);
    }
  }
  return { spendByKey, adCountries: [...adCountries], coverageByCountry, matchedRows, unattributedByKey };
}

/* ------------------------------------------- EU all-market rule (Brand View) */

// The plain reason shown wherever the rule withholds an all-market figure (server notes, client cells / KPI hints).
export const EU_POOL_ALL_MARKET_WITHHELD_REASON = "Withheld: two or more pan-EU marketplaces report positive FBA stock for this brand; pooled EU stock cannot be counted once from brand totals.";

/**
 * The EU ALL-MARKET rule (owner requirement 2026-10-08) -- ONE definition shared by the server merge and the client
 * (src/lib/brand-view.js re-exports it; the tables, the portfolio KPI and FBA Cover apply it).
 *
 * Per-marketplace FBA figures keep per-market semantics ("available in this marketplace"). The ALL-MARKET physical
 * total for a brand is WITHHELD when TWO OR MORE pan-EU pool marketplaces (PAN_EU_POOL_MARKETPLACES above)
 * report POSITIVE FBA stock for that brand: a Pan-European FBA seller's pooled units are reported in EVERY pool
 * marketplace, so adding the marketplaces could count the same physical units several times. Why no count-once fix:
 * brand x country totals carry no FNSKU, so a per-FNSKU count-once rule cannot be applied
 * here; and Listings rows carry no selling-partner identity, so pooled stock cannot be told apart from separate stock.
 * No max / heuristic is substituted. Non-pool marketplaces (GB/UK, US, IN, AU, CA, ...) add normally; ONE positive pool
 * marketplace (plus any non-pool ones) is summed; a pool marketplace with 0 (or unknown) stock does not trigger it.
 *
 * `entries` -- an iterable of [country, fbaAvailable] pairs (a Map works) or { country, fbaAvailable } objects.
 * Returns { withheld, poolMarkets:[the positive pool marketplaces, sorted], reason|null }.
 */
export function euPoolAllMarketRule(entries) {
  const pool = new Set(PAN_EU_POOL_MARKETPLACES);
  const positive = new Set();
  for (const entry of entries || []) {
    const country = Array.isArray(entry) ? entry[0] : entry && entry.country;
    const raw = Array.isArray(entry) ? entry[1] : entry && entry.fbaAvailable;
    const code = canonicalMarketplace(country);
    const value = raw === null || raw === undefined || raw === "" ? NaN : Number(raw);
    if (pool.has(code) && Number.isFinite(value) && value > 0) positive.add(code);
  }
  const poolMarkets = [...positive].sort();
  const withheld = poolMarkets.length >= 2;
  return { withheld, poolMarkets, reason: withheld ? EU_POOL_ALL_MARKET_WITHHELD_REASON : null };
}

/* ------------------------------------------------- inventory payload reading */

// SERVE-time bridge freshness (Listings inventory cutover). A Brand View request's `asOf` is the marketplace's TODAY,
// whose report day (the scheduler cycle's as-of the compact was built for) is the day before it; a saved FBA Inventory
// Health figure (the bridge, a legacy v1 compact, or an old Health-shaped fba-plan) is shown only while its snapshot
// date >= that report day - HEALTH_BRIDGE_MAX_AGE_DAYS -- the SAME threshold the build applied (FBA Inventory Health is
// no longer refreshed, so an older saved figure would otherwise resurface forever). null when asOf is not a date (no
// serve-time check: the build-time threshold still applied).
export function brandViewHealthBridgeFloor(asOf) {
  const d = trimmed(asOf).slice(0, 10);
  return isStrictCalendarDate(d) ? addDays(d, -(HEALTH_BRIDGE_MAX_AGE_DAYS + 1)) : null;
}

const V2_INVENTORY_SOURCES = new Set([INVENTORY_SOURCE_LISTINGS, INVENTORY_SOURCE_HEALTH_FALLBACK, INVENTORY_SOURCE_UNAVAILABLE]);
const instantOf = (value) => { const s = trimmed(value); return s && Number.isFinite(Date.parse(s)) ? s : null; };
const dateOf = (value) => { const s = trimmed(value).slice(0, 10); return isStrictCalendarDate(s) ? s : null; };

/**
 * Classify a saved inventory payload (a compact brand-inventory payload or a saved fba-plan payload) into the ONE
 * evidence shape Brand View consumes. PURE.
 *   - PHASE-2 shape (inventorySource is "listings" | "health-fallback" | "unavailable"; inventoryModel, when present,
 *     must be "listings-v1"): the source it records; available only when inventoryAvailable === true and the source is
 *     not "unavailable". Listings -> listingsRefreshedAt (the fetch time); Health fallback -> its snapshot date.
 *   - LEGACY Health shape (no inventorySource, no inventoryModel -- the production v1 compact or a pre-phase-2 fba-plan):
 *     "health-legacy", available only with inventoryAvailable === true AND a strict Health snapshot date (inventoryDate,
 *     else inventorySnapshotDate) -- labelled with that date, never presented as Listings.
 *   - anything else (an unknown model, no buckets): unavailable.
 * `asOf` (optional, the Brand View as-of): a Health-sourced figure (bridge / legacy) older than
 * brandViewHealthBridgeFloor(asOf) is unavailable (health-bridge-stale:<date>) -- never a stale saved Health figure.
 * Returns { available, inventorySource, buckets, listingsRefreshedAt, healthDate, listingsReasons, unavailableReason }.
 */
export function inventoryEvidenceOf(payload, { asOf = null } = {}) {
  const floor = brandViewHealthBridgeFloor(asOf);
  const none = (unavailableReason, extra = {}) => ({ available: false, inventorySource: INVENTORY_SOURCE_UNAVAILABLE, buckets: [], listingsRefreshedAt: null, healthDate: null, listingsReasons: [], unavailableReason, ...extra });
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return none("no-inventory-snapshot");
  const buckets = Array.isArray(payload.inventoryByBrandCountry) ? payload.inventoryByBrandCountry : null;
  const listingsReasons = Array.isArray(payload.inventoryListingsReasons) ? payload.inventoryListingsReasons.map(String) : [];
  if (payload.inventorySource !== undefined && payload.inventorySource !== null) {
    const source = String(payload.inventorySource);
    if (!V2_INVENTORY_SOURCES.has(source) || (payload.inventoryModel != null && payload.inventoryModel !== LISTINGS_INVENTORY_MODEL)) return none("inventory-source-unrecognized");
    if (source === INVENTORY_SOURCE_UNAVAILABLE || payload.inventoryAvailable !== true || !buckets) {
      return none(trimmed(payload.inventoryUnavailableReason) || "inventory-unavailable", { listingsReasons });
    }
    if (source === INVENTORY_SOURCE_LISTINGS) {
      return { available: true, inventorySource: source, buckets, listingsRefreshedAt: instantOf(payload.listingsRefreshedAt), healthDate: null, listingsReasons: [], unavailableReason: null };
    }
    const healthDate = dateOf(payload.inventoryHealthDate) || dateOf(payload.inventoryDate);
    if (!healthDate) return none("health-fallback-date-missing", { listingsReasons });
    if (floor && healthDate < floor) return none(`health-bridge-stale:${healthDate}`, { listingsReasons });
    return { available: true, inventorySource: source, buckets, listingsRefreshedAt: null, healthDate, listingsReasons, unavailableReason: null };
  }
  if (payload.inventoryModel !== undefined && payload.inventoryModel !== null) return none("inventory-source-unrecognized");
  // LEGACY Health shape.
  const healthDate = dateOf(payload.inventoryDate) || dateOf(payload.inventorySnapshotDate);
  if (payload.inventoryAvailable !== true || !buckets) return none("inventory-unavailable");
  if (!healthDate) return none("health-snapshot-date-missing");
  if (floor && healthDate < floor) return none(`health-bridge-stale:${healthDate}`);
  return { available: true, inventorySource: INVENTORY_SOURCE_HEALTH_LEGACY, buckets, listingsRefreshedAt: null, healthDate, listingsReasons: [], unavailableReason: null };
}

/**
 * Per-country FBA available units for ONE brand, from a saved inventory payload (the compact brand-inventory snapshot,
 * else the saved fba-plan payload -- see inventoryEvidenceOf). `origin` names which saved report it came from.
 *
 * A payload that is unavailable (or an unrecognized shape) is "unavailable" -- never a stale value. A bucket whose
 * fbaAvailable is unknown (null / malformed: a conflicting or unknown SKU) makes that country null and the account total
 * null (`unknown`), never a partial sum. An `unattributed` marker (Listings stock on SKUs with no ASIN) makes its
 * marketplace unknown for EVERY brand. A brand absent from the buckets has no FBA figure (an empty map; scope stays
 * "country"). The account total also obeys the EU all-market rule (allMarketWithheld). `asOf` applies the serve-time
 * bridge freshness (inventoryEvidenceOf).
 */
export function brandInventory(payload, brand, accountCountry, origin = BRAND_INVENTORY_SNAPSHOT_KEY, { asOf = null } = {}) {
  const byCountry = new Map();
  const evidence = inventoryEvidenceOf(payload, { asOf });
  const base = {
    inventorySource: evidence.inventorySource, listingsRefreshedAt: evidence.listingsRefreshedAt, healthDate: evidence.healthDate,
    listingsReasons: evidence.listingsReasons, unavailableReason: evidence.unavailableReason,
  };
  if (!evidence.available) {
    return { byCountry, accountTotal: null, scope: "unavailable", source: null, unknown: false, allMarketWithheld: false, ...base };
  }
  const fallbackCountry = trimmed(accountCountry).toUpperCase();
  let unknown = false;
  for (const entry of evidence.buckets) {
    const country = trimmed(entry && entry.country).toUpperCase() || fallbackCountry;
    // An `unattributed` marker (Listings stock on SKUs with no ASIN, e.g. DataDoe's "__EMPTY__") makes the marketplace
    // Unavailable for EVERY brand: that stock may be this brand's, so no figure there is complete.
    if (entry && entry.unattributed === true) { byCountry.set(country, null); unknown = true; continue; }
    if (trimmed(entry && entry.brand) !== brand) continue;
    const raw = entry ? entry.fbaAvailable : null;
    const available = raw === null || raw === undefined || raw === "" ? NaN : Number(raw);
    if (!Number.isFinite(available) || available < 0) { byCountry.set(country, null); unknown = true; continue; }
    if (byCountry.has(country) && byCountry.get(country) === null) continue;
    byCountry.set(country, (byCountry.get(country) || 0) + available);
  }
  const eu = euPoolAllMarketRule(byCountry);
  let accountTotal = null;
  if (!unknown && !eu.withheld && byCountry.size) accountTotal = [...byCountry.values()].reduce((t, v) => t + v, 0);
  return { byCountry, accountTotal, scope: "country", source: origin, unknown, allMarketWithheld: eu.withheld, ...base };
}

/* ---------------------------------------------- compact Brand View inventory */

// The compact Brand View inventory snapshot (reportKey "brand-inventory"). It is a minimal, per-account roll-up of the
// account's SELECTED inventory source (validated saved Listings, else the last valid FBA Inventory Health snapshot,
// else Unavailable) folded to (marketplace country, brand), so a Brand View portfolio can show FBA Available and FBA
// Cover without the full FBA Shipment Plan build. These functions are PURE (no I/O), so the whole fold -- including the
// cap and the "unknown is unavailable, never zero" rule -- is unit-testable.

// The saved brand-sales snapshot carries an additive `asinBrand` map ({asin: brand}).
// It is the ONLY brand map a Brand View inventory refresh uses, so the refresh never
// spends a Product Catalog export. Returns a Map; an absent/malformed map yields an
// empty Map (the caller then fails BEFORE the FBA export instead of fetching catalog).
export function asinBrandFromSalesPayload(salesPayload) {
  const map = new Map();
  const src = salesPayload?.asinBrand;
  if (src && typeof src === "object" && !Array.isArray(src)) {
    for (const [asin, brand] of Object.entries(src)) {
      const a = trimmed(asin);
      const b = trimmed(brand);
      if (a && b && !map.has(a)) map.set(a, b);
    }
  }
  return map;
}

// A refusal the browser may see verbatim: it is a fixed, admin-safe string and never
// carries a raw DataDoe/Supabase response. Its presence (`brandInventorySafe`) lets the
// API layer distinguish a validated refusal from an unexpected upstream error.
function safeInventoryError(message) {
  const error = new Error(message);
  error.brandInventorySafe = true;
  return error;
}

// A saved brand-inventory snapshot is a COMPACT (authoritative) snapshot only when it is genuinely the compact report:
//   - v2 (BRAND_INVENTORY_REPORT_VERSION): the phase-2 shape -- inventoryModel "listings-v1" + a recognized
//     inventorySource + the compact buckets;
//   - v1 (BRAND_INVENTORY_LEGACY_REPORT_VERSION): the production FBA Inventory Health compact (no inventorySource /
//     inventoryModel) -- served during the transition as a LEGACY Health-sourced snapshot, labelled with its date.
// A wrong-version or malformed snapshot is "no valid compact snapshot", so a version bump never strands Brand View on an
// unreadable payload, and (once valid) a compact is used exclusively so stale FBA Plan values cannot resurface.
export function isCompactInventorySnapshot(snapshot) {
  if (!snapshot || !snapshot.payload || !Array.isArray(snapshot.payload.inventoryByBrandCountry)) return false;
  const version = snapshot.params?.reportVersion;
  const p = snapshot.payload;
  if (version === BRAND_INVENTORY_REPORT_VERSION) return p.inventoryModel === LISTINGS_INVENTORY_MODEL && V2_INVENTORY_SOURCES.has(String(p.inventorySource));
  if (version === BRAND_INVENTORY_LEGACY_REPORT_VERSION) return p.inventorySource == null && p.inventoryModel == null;
  return false;
}

// The freshness a compact claims, comparable across sources: the Listings fetch time (ISO instant) for Listings, the
// Health snapshot date (YYYY-MM-DD) for a Health fallback / a legacy v1 compact ("" when none). A Listings fetch on day
// X+1 sorts after a Health snapshot dated X (a longer string with the same prefix sorts later).
function compactFreshness(s) {
  const p = (s && s.payload) || {};
  return String(p.listingsRefreshedAt || p.inventoryHealthDate || p.inventoryDate || p.inventorySnapshotDate || "");
}

// SERVE SELECTION (Round-4 Defect 2, phase 2): pick the AUTHORITATIVE compact brand-inventory snapshot for an account
// from a set of recent brand-inventory rows, instead of blindly trusting the latest-by-updated_at row. The priority run
// can republish an inventoryAvailable:false PLACEHOLDER (newest updated_at) while the zero-export rebuild publishes a
// REAL available compact at another identity; a latest-by-updated_at read would let the placeholder SHADOW it. So:
//   1. an AVAILABLE v2 compact (newest freshness -- Listings fetch time / Health snapshot date; updated_at breaks a tie);
//   2. else an AVAILABLE legacy v1 (FBA Inventory Health) compact -- the transition window before the phase-2 scheduler
//      publishes v2 (production stock is never hidden; it is labelled with its Health date);
//   3. else the newest compact (an honest unavailable placeholder).
// Pure LKG preference -- it never fabricates freshness and never rewrites. Returns the selected row or null when the set
// holds no valid compact (the caller then uses the saved fba-plan fallback). (Listings inventory cutover: a selected
// compact whose saved Health figure is past the bridge threshold is still made Unavailable at READ time --
// brandInventory(..., { asOf }) -- so the selection stays the one shared function the dependency fingerprint uses.)
export function selectAuthoritativeInventorySnapshot(rows) {
  const compacts = (Array.isArray(rows) ? rows : []).filter(isCompactInventorySnapshot);
  if (!compacts.length) return null;
  const available = compacts.filter((s) => s.payload.inventoryAvailable === true);
  const availableV2 = available.filter((s) => s.params.reportVersion === BRAND_INVENTORY_REPORT_VERSION);
  const pool = availableV2.length ? availableV2 : available.length ? available : compacts;
  const timeOf = (s) => String(s.source_refreshed_at || s.updated_at || "");
  return pool.slice().sort((a, b) => {
    const da = compactFreshness(a); const db = compactFreshness(b);
    if (da !== db) return da < db ? 1 : -1;
    const ta = timeOf(a); const tb = timeOf(b);
    return ta < tb ? 1 : (ta > tb ? -1 : 0);
  })[0];
}

// Health rows as production persists them (the account's LAST SAVED durable FBA Inventory Health snapshot, isolated to
// its seller + marketplace -- read-only; no Health export exists any more). They feed ONLY the dated bridge, so a
// malformed Health row never refuses a validated
// Listings compact (the Health evidence is simply not used); when the account DEPENDS on Health (Listings not
// validated) the payload is refused exactly like production (previous compact preserved). Returns null or a typed reason.
function healthRowsProblem(rows, { country, to }) {
  const limitDate = dateOf(to);
  for (const row of rows) {
    const date = trimmed(row.date);
    if (!isStrictCalendarDate(date)) return "health-row-date-invalid";
    if (limitDate && date > limitDate) return "health-row-date-after-requested-day";
    if (!trimmed(row.child_asin)) return "health-row-asin-missing";
    const mkt = canonicalMarketplace(row.marketplace_country_code);
    if (mkt && country && mkt !== country) return "health-foreign-marketplace-rows";
    const available = row.available;
    // A blank available stays UNKNOWN in the shared fold (inventory-source.js, never 0); a PRESENT value must already
    // be a finite non-negative number (no coercion of "5", NaN, Infinity or a negative).
    if (available !== null && available !== undefined && !(typeof available === "number" && Number.isFinite(available) && available >= 0)) return "health-row-available-invalid";
  }
  return null;
}

/**
 * PURE fold of ONE account's saved inventory evidence into the compact brand-inventory payload (v2, phase 2).
 *   listingsRows  -- the account's isolated rows of the saved canonical Listings snapshot (may be empty / absent);
 *   healthRows    -- the account's LAST SAVED durable FBA Inventory Health rows, exactly as production persists them (may
 *                    be empty) -- the read-only bridge; `invRows` is accepted as the former name of the same input;
 *   brandByAsin   -- Map (or {asin: brand}); accountCountry -- the account's marketplace (required);
 *   listingsRefreshedAt -- the Listings fetch time (the saved pointer's validated_at); `refreshedAt` is an alias;
 *   to            -- the requested report day: a Health row dated after it rejects the Health evidence, AND the bridge's
 *                    as-of (the bridge drives figures only while its snapshot date >= to - HEALTH_BRIDGE_MAX_AGE_DAYS;
 *                    without `to` / `asOf` it is refused -- health-bridge-as-of-missing);
 *   asOf          -- optional explicit bridge as-of (defaults to `to`);
 *   listingsUnavailableReason -- optional: why the caller could not use the account's saved Listings at all (e.g. a
 *                    stale pointer); it replaces the generic Listings reason when Listings is not the source;
 *   rowLimit      -- the Health cap (a list at/over it may be truncated -> refused); listingsRowLimit -- the Listings
 *                    cap (default rowLimit; the per-account Listings rows include merchant-fulfilled / inactive ones).
 * The source is decided by lib/server/inventory-source.js selectAccountInventory (validated Listings, else the saved
 * Health bridge within its threshold, else unavailable) and rolled up with the shared brandCountryInventory over
 * selectionFoldView (an unknown SKU -> a null bucket; an mfn-only ASIN -> no bucket; an `unattributed` marker when
 * Listings stock has no ASIN). asinForSku is null: no in-account SKU->ASIN map is cheaply available here.
 *
 * Structural problems REFUSE the whole payload (throws an admin-safe error; the previous snapshot is preserved): a
 * non-array input, a non-object row, a list at the row cap, no account marketplace -- or a malformed Health snapshot
 * (impossible / future date, blank ASIN, another marketplace's row, a present non-numeric / negative available) when the
 * account has no validated Listings (it would depend on that Health snapshot).
 *
 * Payload (version brand-inventory-shared-v2): { accountId, inventoryModel:"listings-v1", inventorySource,
 * inventoryListingsReasons, inventoryHealthDate, listingsRefreshedAt (Listings source only), inventoryDate (the Health
 * date for the fallback, null for Listings), inventoryAvailable, inventoryUnavailableReason, inventoryConflicts (count),
 * inventoryByBrandCountry }.
 */
export function buildBrandInventoryPayload({
  accountId, listingsRows = null, healthRows = undefined, invRows = undefined, brandByAsin, accountCountry,
  listingsRefreshedAt = undefined, refreshedAt = null, to = null, asOf = undefined, rowLimit = null, listingsRowLimit = undefined,
  listingsUnavailableReason = null,
}) {
  const health = healthRows !== undefined ? healthRows : (invRows !== undefined ? invRows : null);
  const lists = [
    ["Listings", listingsRows == null ? [] : listingsRows, listingsRowLimit !== undefined ? listingsRowLimit : rowLimit],
    ["FBA Inventory Health", health == null ? [] : health, rowLimit],
  ];
  for (const [label, rows, cap] of lists) {
    if (!Array.isArray(rows)) {
      throw safeInventoryError(`Brand View inventory (${label}) returned an unexpected shape and was not saved; the previous snapshot is preserved.`);
    }
    if (cap && rows.length >= cap) {
      throw safeInventoryError(`The ${label} inventory reached its ${cap.toLocaleString("en-US")}-row cap, so it may be truncated. The compact Brand View inventory was not saved; the previous snapshot is preserved.`);
    }
    if (rows.some((row) => !row || typeof row !== "object" || Array.isArray(row))) {
      throw safeInventoryError(`Brand View inventory (${label}) contained a malformed row and was not saved; the previous snapshot is preserved.`);
    }
  }
  const country = canonicalMarketplace(accountCountry);
  if (!country) {
    throw safeInventoryError("Brand View inventory has no account marketplace; it was not saved and the previous snapshot is preserved.");
  }
  const lRows = lists[0][1];
  let hRows = lists[1][1];
  const healthProblem = hRows.length ? healthRowsProblem(hRows, { country, to }) : null;
  if (healthProblem) hRows = [];
  const brandOf = brandByAsin instanceof Map ? brandByAsin : new Map(Object.entries(brandByAsin || {}));
  // The bridge threshold is measured against the report day (`asOf`, default `to`); no as-of => the bridge is refused.
  const bridgeAsOf = dateOf(asOf !== undefined ? asOf : to);
  const sel = selectAccountInventory({ listingsRows: lRows, healthRows: hRows, marketplace: country, awdEligible: false, asinForSku: null, asOf: bridgeAsOf });
  // A malformed Health snapshot is corruption: when the account would DEPEND on it (no validated Listings), refuse the
  // whole payload exactly like production did (typed, admin-safe; the previous compact / LKG is preserved and the
  // reconciler defers) -- never an "unavailable" compact that hides the integrity failure as an ordinary gap.
  if (healthProblem && sel.source !== INVENTORY_SOURCE_LISTINGS) {
    throw safeInventoryError(`Brand View inventory: the saved FBA Inventory Health snapshot failed validation (${healthProblem}) and this account's Listings inventory is not validated, so nothing was saved; the previous snapshot is preserved.`);
  }
  const fetchedAt = instantOf(listingsRefreshedAt !== undefined ? listingsRefreshedAt : refreshedAt);
  const isListings = sel.source === INVENTORY_SOURCE_LISTINGS;
  const isFallback = sel.source === INVENTORY_SOURCE_HEALTH_FALLBACK;
  const available = isListings || isFallback;
  // Why neither source drives figures: no validated Listings + the bridge's typed refusal (stale / no as-of / foreign
  // rows) when a saved Health snapshot existed, else no saved Health snapshot at all.
  const bridgeWhy = hRows.length && Array.isArray(sel.healthReasons) && sel.healthReasons.length ? sel.healthReasons.join(",") : "no-fba-inventory-health-snapshot";
  const unavailableReason = available ? null : `no-validated-listings;${bridgeWhy}`;
  return {
    accountId: String(accountId),
    inventoryModel: LISTINGS_INVENTORY_MODEL,
    inventorySource: sel.source,
    inventoryListingsReasons: !isListings && trimmed(listingsUnavailableReason) ? [trimmed(listingsUnavailableReason)] : [...(sel.listingsReasons || [])],
    inventoryHealthDate: isFallback ? sel.healthDate : null,
    listingsRefreshedAt: isListings ? fetchedAt : null,
    inventoryDate: isFallback ? sel.healthDate : null,
    inventoryAvailable: available,
    inventoryUnavailableReason: unavailableReason,
    inventoryConflicts: Array.isArray(sel.conflicts) ? sel.conflicts.length : 0,
    inventoryByBrandCountry: available
      ? brandCountryInventory(selectionFoldView(sel), { country, brandOf: (asin) => brandOf.get(asin) || null })
      : [],
  };
}

/**
 * Orchestrate one account's compact brand-inventory build with INJECTED readers (offline-testable; no network call).
 *
 *  - ASIN->brand comes ONLY from the saved brand-sales snapshot's `asinBrand` map. If the map is missing this FAILS
 *    BEFORE reading inventory (no live catalog fallback; zero Catalog exports by construction).
 *  - `fetchInventoryRows` returns the account's LAST SAVED durable FBA Inventory Health rows (the read-only bridge, as
 *    production persists them; zero export -- no Health export exists any more); `fetchListingsRows` (optional) returns
 *    the account's SAVED Listings rows; `listingsRefreshedAt` is that Listings snapshot's fetch time. `from` is
 *    accepted for call-site compatibility; `to` bounds the Health dates AND is the bridge's as-of (threshold).
 *  - Returns { payload, asinBrandCount }.
 */
export async function buildBrandInventorySnapshot({
  accountId, accountCountry, from = null, to = null, rowLimit = null, listingsRowLimit = undefined,
  getSnapshot, fetchInventoryRows, fetchListingsRows = null, listingsRefreshedAt = null, listingsUnavailableReason = null,
}) {
  void from;
  if (typeof getSnapshot !== "function") throw new Error("A snapshot reader is required.");
  if (typeof fetchInventoryRows !== "function") throw new Error("An inventory reader is required.");

  const salesSnapshot = await getSnapshot({ reportKey: "brand-sales", accountId });
  const brandByAsin = asinBrandFromSalesPayload(salesSnapshot?.payload);
  if (!brandByAsin.size) {
    // FAIL CLOSED before any inventory read: no live catalog fetch.
    throw safeInventoryError("Brand View inventory needs this account's saved Brand Sales brand map, which is not available. Refresh Brand Sales successfully for this account first.");
  }

  const healthRows = await fetchInventoryRows();
  const listingsRows = typeof fetchListingsRows === "function" ? await fetchListingsRows() : [];
  const payload = buildBrandInventoryPayload({ accountId, listingsRows, healthRows, brandByAsin, accountCountry, listingsRefreshedAt, to, rowLimit, listingsRowLimit, listingsUnavailableReason });
  return { payload, asinBrandCount: brandByAsin.size };
}

/**
 * PURE zero-export adapter: the compact brand-inventory payload from an ALREADY-VALIDATED saved fba-plan payload in the
 * PHASE-2 shape (inventorySource recorded; the fba-plan derive folds the SAME per-account selection to the SAME compact
 * buckets via the shared brandCountryInventory, so there is ONE inventory definition and no second export).
 *
 * The priority run publishes the compact BEFORE the FBA job runs, so it is inventoryAvailable:false; the FBA-aware
 * materialize-inventory job (which runs AFTER fba) uses this adapter to REBUILD the compact from the fresh fba-plan,
 * making Brand View's exclusive-compact consumer serve real inventory the SAME day.
 *
 * Returns null (never a fabricated zero) when the plan is not the phase-2 shape (a pre-phase-2 Health plan never becomes
 * a v2 compact -- the source decision was never made for it), carries no available inventory, lacks its freshness (a
 * Listings plan without a parseable fetch time / a fallback without a Health date) or has a malformed bucket -- the
 * caller then leaves the existing compact untouched. A bucket whose fbaAvailable is null (unknown) stays null, never 0.
 * `reportAsOf` (optional, the cycle's report day): a plan whose Health BRIDGE date is older than reportAsOf -
 * HEALTH_BRIDGE_MAX_AGE_DAYS never becomes an available compact (the saved Health snapshot is no longer refreshed).
 */
export function compactInventoryFromFbaPlanPayload(planPayload, accountId, { reportAsOf = null } = {}) {
  if (!planPayload || planPayload.inventorySource == null) return null;
  const evidence = inventoryEvidenceOf(planPayload);
  if (!evidence.available || evidence.inventorySource === INVENTORY_SOURCE_HEALTH_LEGACY) return null;
  const day = dateOf(reportAsOf);
  if (day && evidence.inventorySource === INVENTORY_SOURCE_HEALTH_FALLBACK && evidence.healthDate < addDays(day, -HEALTH_BRIDGE_MAX_AGE_DAYS)) return null;
  if (evidence.inventorySource === INVENTORY_SOURCE_LISTINGS && !evidence.listingsRefreshedAt) return null;
  const inventoryByBrandCountry = [];
  for (const entry of evidence.buckets) {
    const raw = entry ? entry.fbaAvailable : undefined;
    const available = raw === null ? null : Number(raw);
    if (available !== null && (!Number.isFinite(available) || available < 0)) return null; // malformed fold -> preserve previous compact
    const bucket = {
      country: canonicalMarketplace(entry && entry.country) || null,
      brand: (entry && entry.brand != null) ? entry.brand : null,
      fbaAvailable: available,
      skuCount: Number.isFinite(Number(entry && entry.skuCount)) ? Number(entry.skuCount) : 0,
    };
    if (entry && entry.unattributed === true) bucket.unattributed = true;
    inventoryByBrandCountry.push(bucket);
  }
  const isFallback = evidence.inventorySource === INVENTORY_SOURCE_HEALTH_FALLBACK;
  const conflicts = planPayload.inventoryConflicts;
  return {
    accountId: String(accountId),
    inventoryModel: LISTINGS_INVENTORY_MODEL,
    inventorySource: evidence.inventorySource,
    inventoryListingsReasons: [...evidence.listingsReasons],
    inventoryHealthDate: isFallback ? evidence.healthDate : null,
    listingsRefreshedAt: isFallback ? null : evidence.listingsRefreshedAt,
    inventoryDate: isFallback ? evidence.healthDate : null,
    inventoryAvailable: true,
    inventoryUnavailableReason: null,
    inventoryConflicts: Array.isArray(conflicts) ? conflicts.length : (Number.isFinite(Number(conflicts)) ? Number(conflicts) : 0),
    inventoryByBrandCountry,
  };
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
export async function buildAccountBrandSlice({ accountId, brand, asOf, account, getSnapshot, getAdsRows, catalogRows = null, required = true, getCampaignMappings = async () => [], getInventorySnapshots = null }) {
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
  // The reusable Product Catalog (child_asin -> product_brand) is the authoritative ASIN->brand source and the
  // ONLY one many accounts have, so without it their ad ASINs never map and Ads look like zero in Brand View.
  // Appended LAST so any account-specific report snapshot mapping still wins; the Catalog fills the gaps.
  if (Array.isArray(catalogRows) && catalogRows.length) {
    asinBrandPayloads.push({ rows: catalogRows });
    asinBrandSources.push("product-catalog");
  }
  const asinBrand = asinBrandMapFromPayloads(asinBrandPayloads);

  // Six calendar months of ad history is exactly what the Monthly Snapshot
  // needs; the last-year column is sales only, so no ad history is read for it.
  const adsRequestFrom = monthBack(asOf, 5)?.from || monthStart(asOf);
  let adsError = null;
  let adRows = [];
  let ads;
  const readAdRows = async () => {
    try {
      adRows = await getAdsRows({ accountId, sourceKeys: [BRAND_VIEW_ADS_SOURCE_KEY], from: adsRequestFrom, to: asOf, maxRows: ADS_MAX_ROWS });
    } catch (error) { adsError = error instanceof Error ? error.message : String(error); }
  };
  if (ACTIVE_ADS_SOURCE_KEY === "asin-performance-v1") {
    // ASIN grain (rollback): attribute ad rows to a brand via the child_asin -> brand catalog map.
    if (asinBrand.size) await readAdRows();
    ads = aggregateBrandAds(adRows, asinBrand, brand);
  } else {
    // CAMPAIGN grain (post-cutover): attribute via the manual campaign -> brand mapping. The map is empty until
    // campaigns are mapped -> every brand honestly shows 0 spend where campaign data exists, never fabricated,
    // never ASIN. Always read campaign rows so adCountries reflects synced markets (real 0 vs unavailable).
    let campaignMap = new Map();
    try { const mrows = await getCampaignMappings({ accountId }); campaignMap = campaignBrandMap(mrows || [], (m) => m.brandKey); } catch { campaignMap = new Map(); }
    await readAdRows();
    ads = aggregateBrandCampaignAdsSpend(adRows, campaignMap, brandKey(brand));
  }

  // Inventory source: a VALID compact brand-inventory snapshot (v2, or the legacy v1 Health compact during the
  // transition) is AUTHORITATIVE. Once it exists, it is used EXCLUSIVELY, even when its rows are empty or the selected
  // brand is absent -- an empty/unavailable compact snapshot shows unavailable, never resurrecting a stale FBA Plan
  // value. The saved fba-plan is used ONLY while no valid compact snapshot exists yet, and only in its phase-2 shape or
  // its old Health shape (labelled with its Health date); the Listing Health v1 fallback is removed.
  // SERVE SELECTION (Round-4 Defect 2): when a multi-row inventory reader is wired, SELECT the authoritative compact
  // (prefer a genuinely-available compact by newest freshness) across the account's recent brand-inventory
  // rows, so a fresh unavailable placeholder republished this cycle cannot shadow a lagging AVAILABLE compact. Without
  // the reader (legacy/tests) this is byte-identical to the single latest read. Cached under the same key as readOnce.
  const readBrandInventory = async () => {
    if (!payloadByKey.has(BRAND_INVENTORY_SNAPSHOT_KEY)) {
      let selected = null;
      if (typeof getInventorySnapshots === "function") {
        const rows = await getInventorySnapshots({ reportKey: BRAND_INVENTORY_SNAPSHOT_KEY, accountId }).catch(() => null);
        selected = selectAuthoritativeInventorySnapshot(rows);
      }
      if (!selected) selected = await getSnapshot({ reportKey: BRAND_INVENTORY_SNAPSHOT_KEY, accountId });
      payloadByKey.set(BRAND_INVENTORY_SNAPSHOT_KEY, selected);
    }
    return payloadByKey.get(BRAND_INVENTORY_SNAPSHOT_KEY);
  };
  const brandInventorySnapshot = await readBrandInventory();
  const planSnapshot = await readOnce("fba-plan");
  const useCompact = isCompactInventorySnapshot(brandInventorySnapshot);
  // Authoritative compact first (an empty compact or an absent brand resolves to unavailable, never an older value);
  // else the saved fba-plan, read through the SAME evidence classifier (inventoryEvidenceOf).
  // Serve-time bridge freshness (asOf): a saved FBA Inventory Health figure older than its threshold is Unavailable.
  const inventory = useCompact
    ? brandInventory(brandInventorySnapshot.payload, brand, account?.country, BRAND_INVENTORY_SNAPSHOT_KEY, { asOf })
    : brandInventory(planSnapshot?.payload, brand, account?.country, "fba-plan", { asOf });
  const inventorySnapshot = useCompact ? brandInventorySnapshot : planSnapshot;
  const inventoryKnown = inventory.scope !== "unavailable";
  // A Listings compact keys the United Kingdom by its canonical Amazon code (GB) while this account's saved sales may
  // spell it UK: re-key an inventory marketplace onto the sales spelling of the SAME marketplace, so one marketplace
  // is never split into a sales row with no stock plus a phantom "FC only" row.
  for (const [key, value] of [...inventory.byCountry]) {
    const salesKey = [...sales.countries.keys()].find((code) => code !== key && canonicalMarketplace(code) === canonicalMarketplace(key));
    if (!salesKey || inventory.byCountry.has(salesKey)) continue;
    inventory.byCountry.delete(key);
    inventory.byCountry.set(salesKey, value);
  }

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
    // The freshness this account's inventory claims: a Health snapshot DATE (fallback / legacy) or a Listings FETCH
    // TIME (Listings has no date) -- never both, and none when the inventory is unavailable.
    inventoryDate: inventoryKnown ? inventory.healthDate : null,
    inventoryRefreshedAt: inventoryKnown ? inventory.listingsRefreshedAt : null,
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
  // (country|date) keys where UNMAPPED campaign spend exists (union across contributing accounts). Where the brand's
  // mapped spend for a range is 0 but a range day is here, the spend is unknown attribution -> em dash, not a 0.
  const adsUnattributedByKey = new Set();
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
      // Any contributing account with UNMAPPED spend for this (country, date) makes the merged figure uncertain.
      for (const key of (slice.ads.unattributedByKey || new Set())) {
        if (!key.startsWith(`${country}|`)) continue;
        const date = key.slice(country.length + 1);
        if (date < from || date > to) continue;
        adsUnattributedByKey.add(key);
      }
    }
  }
  const adsBounds = Object.values(adsCoverageByCountry).reduce((current, coverage) => ({
    from: !current.from || coverage.from < current.from ? coverage.from : current.from,
    to: !current.to || coverage.to > current.to ? coverage.to : current.to,
  }), { from: null, to: null });

  /* ---------- inventory ---------- */
  // Each account carries its OWN inventory source (validated Listings, the dated saved FBA Inventory Health bridge, a
  // legacy v1 Health compact within the same threshold, or unavailable). A marketplace / total is a COMPLETE sum or null
  // (Unavailable): an unknown contributor never yields a partial sum. Freshness is reported per account
  // (inventoryAccountSources) and, merged, as the OLDEST Health snapshot date (inventoryDate) and the OLDEST Listings
  // fetch time (inventoryRefreshedAt) among the contributing accounts -- never a newer claim than the data supports.
  const inventoryByCountry = new Map();
  let inventoryTotalUnknown = false;
  let inventoryDate = null;
  let inventoryRefreshedAt = null;
  const inventoryScopes = new Set();
  const inventorySources = new Set();
  const inventoryUnknownSlices = [];
  const inventoryMissingSlices = [];
  const inventoryAccountSources = [];
  for (const slice of usable) {
    const inv = slice.inventory;
    inventoryAccountSources.push({
      accountId: slice.accountId,
      accountName: slice.accountName || null,
      source: inv.scope === "unavailable" ? INVENTORY_SOURCE_UNAVAILABLE : (inv.inventorySource || INVENTORY_SOURCE_UNAVAILABLE),
      listingsRefreshedAt: slice.inventoryRefreshedAt || null,
      healthDate: slice.inventoryDate || null,
      listingsReasons: Array.isArray(inv.listingsReasons) ? [...inv.listingsReasons] : [],
      unavailableReason: inv.scope === "unavailable" ? (inv.unavailableReason || "no-inventory-snapshot") : null,
    });
    if (inv.scope === "unavailable") { inventoryMissingSlices.push(slice); continue; }
    inventoryScopes.add(inv.scope);
    if (inv.source) inventorySources.add(inv.source);
    for (const [country, available] of inv.byCountry) {
      const prev = inventoryByCountry.has(country) ? inventoryByCountry.get(country) : 0;
      inventoryByCountry.set(country, prev === null || available === null ? null : prev + available);
    }
    if (inv.unknown) { inventoryTotalUnknown = true; inventoryUnknownSlices.push(slice); }
    if (slice.inventoryDate && (!inventoryDate || slice.inventoryDate < inventoryDate)) inventoryDate = slice.inventoryDate;
    if (slice.inventoryRefreshedAt && (!inventoryRefreshedAt || slice.inventoryRefreshedAt < inventoryRefreshedAt)) inventoryRefreshedAt = slice.inventoryRefreshedAt;
  }
  // An account with NO usable inventory (no compact / fba-plan yet, an unavailable source, a failed read) is UNKNOWN,
  // not zero: when other accounts' inventory is known, every marketplace that account sells in -- and the total -- is
  // Unavailable instead of a partial sum that looks complete. (When NO account has inventory the scope is simply
  // "unavailable" below.)
  if (inventoryScopes.size && inventoryMissingSlices.length) {
    for (const slice of inventoryMissingSlices) {
      for (const [country] of slice.sales.countries) inventoryByCountry.set(country, null);
      inventoryUnknownSlices.push(slice);
    }
    inventoryTotalUnknown = true;
  }
  const inventoryScope = !inventoryScopes.size
    ? "unavailable"
    : inventoryScopes.has("account") && inventoryScopes.has("country") ? "mixed"
      : [...inventoryScopes][0];
  // The ALL-MARKET total: a complete sum of every marketplace, withheld (null) when any marketplace is unknown OR when
  // the EU all-market rule fires (two or more pan-EU pool marketplaces with positive stock -- euPoolAllMarketRule).
  const inventoryEu = euPoolAllMarketRule(inventoryByCountry);
  let inventoryAccountTotal = null;
  if (inventoryScope !== "unavailable" && !inventoryTotalUnknown && !inventoryEu.withheld && inventoryByCountry.size) {
    inventoryAccountTotal = [...inventoryByCountry.values()].reduce((total, value) => total + value, 0);
  }

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
      // true = a contributing account's inventory for this marketplace is UNKNOWN (not merely absent): any total over
      // it is withheld, never a partial sum.
      fbaUnknown: inventoryByCountry.has(country) && inventoryByCountry.get(country) === null,
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
      fbaUnknown: available === null,
      currencyConflict: false,
      accounts: [],
    });
  }
  countries.sort((a, b) => a.country.localeCompare(b.country));

  /* ---------- series ---------- */
  const series = [];
  for (const entry of seriesByKey.values()) {
    const key = seriesKey(entry.c, entry.d);
    const row = { c: entry.c, cur: currencyByCountry.get(entry.c) ?? null, d: entry.d, s: round4(entry.s), u: entry.u };
    if (entry.x) row.x = entry.x;
    const spend = spendByKey.get(key);
    if (spend !== undefined) row.a = round4(spend);
    if (adsUnattributedByKey.has(key)) row.au = true;
    series.push(row);
  }
  // Days with ad spend but no order value are still real spend days.
  for (const [key, spend] of spendByKey) {
    if (seriesByKey.has(key)) continue;
    const [country, date] = key.split("|");
    const row = { c: country, cur: currencyByCountry.get(country) ?? null, d: date, s: 0, u: 0, a: round4(spend) };
    if (adsUnattributedByKey.has(key)) row.au = true;
    series.push(row);
  }
  // Days with ONLY unmapped (unattributed) campaign spend -- no order value AND no mapped brand spend -- still carry
  // the attribution-uncertainty flag for a DISPLAYED marketplace, so a selected range overlapping them shows an em dash
  // (Unavailable), never a fabricated 0.
  for (const key of adsUnattributedByKey) {
    if (seriesByKey.has(key) || spendByKey.has(key)) continue;
    const [country, date] = key.split("|");
    if (!currencyByCountry.has(country)) continue; // not a marketplace the brand sells in -> never displayed
    series.push({ c: country, cur: currencyByCountry.get(country) ?? null, d: date, s: 0, u: 0, au: true });
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
    notes.push("Ad spend and TACoS are unavailable because no saved report maps this account's catalog to a brand yet. Refresh FBA Shipment Plan, SKU P&L, Listing Health or Sales Movers once for these accounts to build that mapping.");
  } else if (noAsinMap.length) {
    notes.push(`These accounts have no saved brand mapping, so their marketplaces show ad spend as unavailable rather than as zero: ${noAsinMap.map(label).join(", ")}.`);
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
    notes.push(`No saved advertising covers every account selling in ${salesOnlyCountries.join(", ")}, so ad spend and TACoS there are shown as unavailable rather than as a partial sum.`);
  }
  if (inventoryScope === "unavailable") {
    notes.push("FBA inventory and inventory cover are unavailable because no contributing account has validated Listings inventory or a recent enough saved FBA Inventory Health snapshot (FBA Inventory Health is no longer refreshed).");
  } else if (inventoryUnknownSlices.length) {
    notes.push(`FBA inventory for ${[...new Set(inventoryUnknownSlices.map(label))].join(", ")} is not fully known (no usable inventory snapshot, or inventory rows that are unknown or conflicting), so the affected marketplaces and totals are shown as unavailable rather than as a partial sum.`);
  }
  // Per-account source labels for anything that is NOT validated Listings (the fallback is always named).
  const fallbackAccounts = inventoryAccountSources.filter((entry) => entry.source === INVENTORY_SOURCE_HEALTH_FALLBACK);
  if (fallbackAccounts.length) {
    notes.push(`FBA inventory for ${fallbackAccounts.map((entry) => `${entry.accountName || entry.accountId} (FBA Inventory Health snapshot ${entry.healthDate})`).join(", ")} comes from the last saved FBA Inventory Health snapshot -- a temporary read-only bridge (no longer refreshed; it may have changed since) -- because that account's Listings inventory is not validated yet.`);
  }
  const legacyAccounts = inventoryAccountSources.filter((entry) => entry.source === INVENTORY_SOURCE_HEALTH_LEGACY);
  if (legacyAccounts.length) {
    notes.push(`FBA inventory for ${legacyAccounts.map((entry) => `${entry.accountName || entry.accountId} (FBA Inventory Health snapshot ${entry.healthDate})`).join(", ")} comes from an FBA Inventory Health snapshot saved before the Listings inventory switch.`);
  }
  if (inventoryEu.withheld) {
    notes.push(`The All Markets FBA inventory total is withheld: ${inventoryEu.poolMarkets.join(", ")} each report positive FBA stock for this brand, and pan-European pooled stock cannot be counted once from brand totals. Each marketplace's own figure is still shown.`);
  }
  if (inventoryScope !== "unavailable" && inventoryScope !== "country") {
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
      // EU all-market rule: true when two or more pan-EU pool marketplaces report positive stock (the total is withheld).
      inventoryAllMarketWithheld: inventoryEu.withheld,
      inventoryAllMarketWithheldReason: inventoryEu.reason,
      inventoryPoolMarketsPositive: inventoryEu.poolMarkets,
      // The OLDEST Health snapshot date among Health-sourced accounts (null when none) and the OLDEST Listings fetch
      // time among Listings-sourced accounts (null when none).
      inventoryDate,
      inventoryRefreshedAt,
      // One entry per contributing account: { accountId, accountName, source, listingsRefreshedAt, healthDate,
      // listingsReasons, unavailableReason } -- source is listings | health-fallback | health-legacy | unavailable.
      inventoryAccountSources,
      inventorySavedAt: usable
        .map((slice) => slice.inventorySavedAt)
        .filter(Boolean)
        .sort()
        .pop() || null,
      accountCount: usable.length,
    },
    sources: {
      sales: "Saved Dashboard snapshots (Order Line Items joined to Product Catalog)",
      // Source-aware: post ASIN->Campaign cutover, Brand View attributes ads via each account's campaign->brand map.
      ads: ACTIVE_ADS_SOURCE_KEY === ASIN_ADS_SOURCE_KEY
        ? "Saved Ad Performance by ASIN & Date rows joined to each account's ASIN-to-brand map"
        : "Saved Ad Performance by Campaign & Date rows attributed via each account's campaign-to-brand map",
      inventory: "Saved per-account inventory: validated Listings, else the last saved FBA Inventory Health snapshot (a dated, read-only, temporary bridge; no longer refreshed), else unavailable",
    },
    notes,
  };
}

/**
 * The account-scoped Brand View report snapshot: exactly one account.
 */
export async function buildBrandViewSnapshot({ accountId, brand, asOf, account, getSnapshot, getAdsRows, getCatalogRows = null, getCampaignMappings = async () => [], getInventorySnapshots = null }) {
  const catalogRows = typeof getCatalogRows === "function" ? await getCatalogRows().catch(() => null) : null;
  const slice = await buildAccountBrandSlice({ accountId, brand, asOf, account, getSnapshot, getAdsRows, catalogRows, required: true, getCampaignMappings, getInventorySnapshots });
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
export async function buildBrandViewPortfolioSnapshot({ accountIds, brand, asOf, accountsById, getSnapshot, getAdsRows, getCatalogRows = null, deadline = null, getCampaignMappings = async () => [], getInventorySnapshots = null }) {
  // The reusable Product Catalog is org-scoped, so read it ONCE and reuse across every account slice (child_asin
  // -> product_brand is what maps each account's ad ASINs to this brand).
  const catalogRows = typeof getCatalogRows === "function" ? await getCatalogRows().catch(() => null) : null;
  // Read the accounts in small bounded-concurrency chunks (not one at a time): a dozen sequential multi-hundred-KB
  // reads is what pushed this build to ~37s and produced the intermittent 504. A cap of PORTFOLIO_SLICE_CONCURRENCY
  // holds at most that many payloads at once (memory-safe) while cutting wall time several-fold; slice ORDER is
  // preserved. The route deadline is checked BETWEEN chunks (never inside the swallow-on-missing slice) so a
  // timeout can never be misread as an unavailable account and published as an incomplete portfolio.
  const slices = new Array(accountIds.length);
  for (let i = 0; i < accountIds.length; i += PORTFOLIO_SLICE_CONCURRENCY) {
    if (deadline && typeof deadline.ensureTime === "function") await deadline.ensureTime("brand-view-portfolio-slice");
    const chunk = accountIds.slice(i, i + PORTFOLIO_SLICE_CONCURRENCY);
    const built = await Promise.all(chunk.map((accountId) => buildAccountBrandSlice({
      accountId,
      brand,
      asOf,
      account: accountsById?.[String(accountId)] || null,
      getSnapshot,
      getAdsRows,
      catalogRows,
      required: false,
      getCampaignMappings,
      getInventorySnapshots,
    })));
    for (let j = 0; j < built.length; j += 1) slices[i + j] = built[j];
  }
  return assembleBrandViewPayload({ slices, brand, asOf, scope: "portfolio" });
}

// Money is summed from source values that already carry more precision than a
// currency's minor unit. Four decimals keeps the payload small without changing
// any displayed figure.
function round4(value) {
  return Math.round((Number(value) || 0) * 10000) / 10000;
}
