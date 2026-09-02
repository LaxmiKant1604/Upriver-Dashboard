// Canonical durable Campaign Ads (campaign-performance-v1) aggregation -- the SINGLE active advertising source for
// Daily Reporting + Brand View + the Dashboard after the ASIN->Campaign cutover. ONE saved dataset
// (public.ads_daily_source_rows, source "campaign-performance-v1") feeds them. It mirrors the shapes the reports
// already consume from asin-ads-aggregation.js (so it is a drop-in), but reads the CAMPAIGN metric set and attributes
// to brands via the manual campaign->brand mapping (campaign_brand_mapping), NOT the ASIN->brand catalog map.
//
// Invariants (identical to the ASIN aggregation): NEVER combine currencies; NEVER invent a metric the contract did
// not supply; deduplicate by the canonical natural grain before summing; keep UNMAPPED campaigns as a typed separate
// amount (never silently assigned to a brand, never dropped). The ASIN grain is NEVER summed here (the grains overlap).

import { marketplaceProfile } from "../../marketplaces.js";
import { normalizeMarketplace } from "../sync/oli-sales-estimate.js";
import { campaignIdentityKey, normalizeAdsProfile, indexMappings } from "./campaign-directory.js";

// The Campaign contract metrics (from ads-sync.js ADS_SOURCES campaign-performance-v1). ad_sales here is the TOTAL
// campaign ad sales (NOT same-SKU) -- the honest, only attributed-sales value the campaign grain supplies.
export const CAMPAIGN_ADS_METRIC_FIELDS = Object.freeze({
  impressions: "ad_impressions",
  clicks: "ad_clicks",
  spend: "ad_spend",
  attributedSales: "ad_sales",
  attributedOrders: "ad_orders",
  attributedUnits: "ad_units_sold",
});
export const CAMPAIGN_ADS_METRIC_KEYS = Object.freeze(Object.keys(CAMPAIGN_ADS_METRIC_FIELDS));

export const UNKNOWN_CURRENCY = "UNKNOWN";
export const UNMAPPED_BRAND = "__unmapped";

const S = (v) => (v == null ? "" : String(v));
const numOrNull = (v) => { if (v == null || v === "") return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const pick = (...vals) => { for (const v of vals) { const s = S(v).trim(); if (s) return s; } return ""; };
export function normalizeAdsCurrency(v) { const t = S(v).trim().toUpperCase(); return t || UNKNOWN_CURRENCY; }

// A campaign row's dimensions JSONB (the campaign/profile/budget dims live here).
function dimsOf(row) { return row && row.dimensions && typeof row.dimensions === "object" && !Array.isArray(row.dimensions) ? row.dimensions : {}; }

/**
 * The AUTHORITATIVE currency of a Campaign-Ads row: explicit row currency, else the campaign budget currency, else the
 * MARKETPLACE currency (a blank persist was a gap, not real ambiguity). A foreign-marketplace row resolves to its
 * (foreign) currency so per-account currency isolation still catches cross-marketplace/account contamination. Returns
 * "" only when neither an explicit currency nor a known marketplace is present (caller fails it closed).
 */
export function resolveCampaignRowCurrency(row) {
  const d = dimsOf(row);
  const explicit = S(row && row.currency).trim().toUpperCase() || S(d.ad_campaign_budget_currency).trim().toUpperCase();
  if (explicit) return explicit;
  const mkt = marketplaceProfile(S((row && row.marketplace_country_code) || d.marketplace_country_code)).currency;
  return mkt ? S(mkt).trim().toUpperCase() : "";
}

// The canonical campaign identity of a row (marketplace-normalized, profile-normalized, campaign id) -- the join key
// to the campaign->brand mapping and the per-campaign dedup dimension.
export function campaignIdentityOfRow(row) {
  const d = dimsOf(row);
  const marketplace = normalizeMarketplace(pick(row && row.marketplace_country_code, d.marketplace_country_code));
  const campaignId = pick(row && row.campaign_id, d.ad_campaign_id);
  const adsProfileId = normalizeAdsProfile(d.amazon_ads_profile_id);
  if (!marketplace || !campaignId) return "";
  return campaignIdentityKey({ marketplace, adsProfileId, campaignId });
}

// The canonical dedup grain: one row per (account, marketplace, date, dimension_key). dimension_key already keys the
// table PK; overlapping reads are deduped here so a metric is counted exactly once.
export function campaignAdsNaturalKey(row) {
  const d = dimsOf(row);
  return [S(row.account_id), S((row.marketplace_country_code) || d.marketplace_country_code).toUpperCase(), S((row.metric_date) || d.date), S(row.dimension_key) || campaignIdentityOfRow(row)].join("|");
}

// Extract ONLY the metrics the row supplies (present + finite). Absent/non-finite fields are omitted, never zero-filled.
export function campaignAdsMetricsFromRow(row) {
  const m = row && row.metrics && typeof row.metrics === "object" && !Array.isArray(row.metrics) ? row.metrics : {};
  const out = {};
  for (const key of CAMPAIGN_ADS_METRIC_KEYS) {
    const field = CAMPAIGN_ADS_METRIC_FIELDS[key];
    if (Object.prototype.hasOwnProperty.call(m, field)) { const v = numOrNull(m[field]); if (v != null) out[key] = v; }
  }
  return out;
}

function addMetrics(acc, m) { for (const key of CAMPAIGN_ADS_METRIC_KEYS) if (key in m) acc[key] = (acc[key] || 0) + m[key]; }

function dedupeRows(rows) {
  const byKey = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const d = dimsOf(row);
    if (!row || !S((row.metric_date) || d.date)) continue;
    const k = campaignAdsNaturalKey(row);
    const prev = byKey.get(k);
    if (!prev || S(row.updated_at) >= S(prev.updated_at)) byKey.set(k, row);
  }
  return [...byKey.values()];
}

/**
 * ACCOUNT-LEVEL aggregation (Dashboard / account totals): fold EVERY campaign's rows for the account into per-CURRENCY
 * metric totals (never combining currencies). Unmapped campaigns still count -- they belong to the account. Returns
 * { byCurrency, currencies, multiCurrency, rows }. Mirrors aggregateAccountAsinAds.
 */
export function aggregateAccountCampaignAds(rows) {
  const deduped = dedupeRows(rows);
  const byCurrency = {};
  for (const row of deduped) {
    const cur = resolveCampaignRowCurrency(row) || UNKNOWN_CURRENCY;
    (byCurrency[cur] = byCurrency[cur] || {});
    addMetrics(byCurrency[cur], campaignAdsMetricsFromRow(row));
  }
  const currencies = Object.keys(byCurrency).sort();
  return { byCurrency, currencies, multiCurrency: currencies.length > 1, rows: deduped.length };
}

function foldDailyMetric(acc, value) {
  if (value == null) return acc;
  const n = Number(value);
  const add = Number.isFinite(n) ? n : NaN;
  return acc === undefined ? add : acc + add;
}

/**
 * DAILY REPORTING projection (account-level, per-DATE): fold the account's Campaign-Ads rows into per-(date, currency)
 * canonical Ads rows shaped for the EXISTING Daily merge/coverage contract:
 *   { date, seller_or_vendor_id, currency, ad_sales, ad_spend, ad_clicks }.
 * ad_sales is the campaign contract's total ad sales. `rawSellerId` is stamped from account metadata (never a row) so
 * every row carries the authoritative partition key the coverage validator checks. Identical shape + fold semantics to
 * aggregateAsinAdsDailyRows (a present non-finite metric poisons the group to NaN -> the coverage validator fails the
 * account's Ads closed, never a coerced 0).
 */
export function aggregateCampaignAdsDailyRows(rows, { rawSellerId = null } = {}) {
  const deduped = dedupeRows(rows);
  const byKey = new Map();
  for (const row of deduped) {
    const d = dimsOf(row);
    const date = S((row.metric_date) || d.date).slice(0, 10);
    if (!date) continue;
    const cur = resolveCampaignRowCurrency(row);
    const k = date + "|" + cur;
    let g = byKey.get(k);
    if (!g) { g = { date, currency: cur, sales: undefined, spend: undefined, clicks: undefined }; byKey.set(k, g); }
    const m = row && row.metrics && typeof row.metrics === "object" && !Array.isArray(row.metrics) ? row.metrics : {};
    g.sales = foldDailyMetric(g.sales, m[CAMPAIGN_ADS_METRIC_FIELDS.attributedSales]);
    g.spend = foldDailyMetric(g.spend, m[CAMPAIGN_ADS_METRIC_FIELDS.spend]);
    g.clicks = foldDailyMetric(g.clicks, m[CAMPAIGN_ADS_METRIC_FIELDS.clicks]);
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

/**
 * Build the campaign identity -> brand map from the saved campaign->brand mapping rows (getCampaignBrandMappings).
 * `brandOf(map)` selects which brand identifier the caller compares against (default: the canonical brand key). Returns
 * a Map campaignIdentityKey -> brand identifier. Only ASSIGNED (non-blank brand) mappings are included.
 */
export function campaignBrandMap(mappingRows, brandOf = (m) => m.brandKey) {
  const idx = indexMappings(mappingRows); // Map identityKey -> { brandKey, brandDisplay, ... }
  const out = new Map();
  for (const [key, m] of idx.entries()) { const b = S(brandOf(m)).trim(); if (b) out.set(key, b); }
  return out;
}

/**
 * BRAND-LEVEL aggregation (Brand View + brand-scoped Daily): map each row's CAMPAIGN identity -> brand via
 * `identityBrandMap` (a Map campaignIdentityKey -> brand identifier); fold ONLY the selected brand's rows into
 * per-currency totals, and keep every UNMAPPED campaign's metrics in a SEPARATE typed per-currency `unmapped` amount
 * (never assigned to the brand, never dropped). Mirrors aggregateBrandAsinAds exactly (same return shape). Two brands
 * in one account stay strictly separated (each call filters to one brand).
 */
export function aggregateBrandCampaignAds(rows, identityBrandMap, brand) {
  const deduped = dedupeRows(rows);
  const map = identityBrandMap instanceof Map ? identityBrandMap : new Map(Object.entries(identityBrandMap || {}));
  const wanted = S(brand).trim();
  const byCurrency = {}; const unmappedByCurrency = {};
  let matchedRows = 0; let unmappedRows = 0;
  for (const row of deduped) {
    const id = campaignIdentityOfRow(row);
    const mapped = id ? map.get(id) : undefined;
    const cur = resolveCampaignRowCurrency(row) || UNKNOWN_CURRENCY;
    const metrics = campaignAdsMetricsFromRow(row);
    if (mapped != null && S(mapped).trim() === wanted) {
      (byCurrency[cur] = byCurrency[cur] || {}); addMetrics(byCurrency[cur], metrics); matchedRows += 1;
    } else if (mapped == null || S(mapped).trim() === "") {
      (unmappedByCurrency[cur] = unmappedByCurrency[cur] || {}); addMetrics(unmappedByCurrency[cur], metrics); unmappedRows += 1;
    }
    // else: a campaign mapped to a DIFFERENT brand -> excluded from this brand (strict separation), not "unmapped".
  }
  const currencies = [...new Set([...Object.keys(byCurrency), ...Object.keys(unmappedByCurrency)])].sort();
  return { byCurrency, unmapped: { byCurrency: unmappedByCurrency }, currencies, matchedRows, unmappedRows };
}
