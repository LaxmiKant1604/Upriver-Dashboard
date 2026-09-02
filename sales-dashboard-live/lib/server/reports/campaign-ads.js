// Campaign Ads view model -- PURE, offline-testable. Aggregates the account's durable campaign-performance rows
// (ads_daily_source_rows, source_key 'campaign-performance-v1') into per-campaign metrics + KPIs over a date range,
// joined to the saved campaign->brand mapping, with STRICT currency isolation and EXACT mapped/Unmapped conservation.
// Reads existing durable data only; never fabricates a campaign, never calls DataDoe. Empty history -> empty view.
//
// CONSERVATION RULE: for each currency, the account total (all campaigns) == sum(brand-mapped campaigns) + Unmapped.
// Unmapped spend/sales is never silently assigned to a brand and never dropped.

import { brandKey } from "./brand-membership.js";
import { normalizeMarketplace } from "../sync/oli-sales-estimate.js";
import { campaignIdentityKey, normalizeAdsProfile, indexMappings } from "./campaign-directory.js";

const S = (v) => (v == null ? "" : String(v));
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const pick = (...vals) => { for (const v of vals) { const s = S(v).trim(); if (s) return s; } return ""; };
const budget = (v) => { if (v == null || v === "") return null; const n = Number(v); return Number.isFinite(n) ? n : null; };

// The six real Campaign metrics (invalid-traffic fields are intentionally ignored: not requested this phase).
export const CAMPAIGN_METRICS = ["ad_spend", "ad_sales", "ad_orders", "ad_units_sold", "ad_impressions", "ad_clicks"];
const zero = () => Object.fromEntries(CAMPAIGN_METRICS.map((k) => [k, 0]));

// KPIs computed from SUMMED metrics (never averaged); an undefined ratio is null (an em dash), never a fabricated 0.
export function campaignKpis(m) {
  const spend = m.ad_spend, sales = m.ad_sales, orders = m.ad_orders, units = m.ad_units_sold, impressions = m.ad_impressions, clicks = m.ad_clicks;
  return {
    spend, sales, orders, units, impressions, clicks,
    ctr: impressions > 0 ? clicks / impressions : null,      // click-through rate
    cpc: clicks > 0 ? spend / clicks : null,                 // cost per click
    cvr: clicks > 0 ? orders / clicks : null,                // conversion rate
    roas: spend > 0 ? sales / spend : null,                  // return on ad spend
    acos: sales > 0 ? spend / sales : null,                  // advertising cost of sale
  };
}

// Aggregate durable rows -> one row per campaign identity (metrics summed over [from,to]) with latest metadata,
// currency, and the current saved brand mapping.
export function buildCampaignAdsView({ durableRows = [], mappingRows = [], from = null, to = null } = {}) {
  const mappings = indexMappings(mappingRows);
  const byId = new Map();
  for (const r of Array.isArray(durableRows) ? durableRows : []) {
    const d = r && r.dimensions && typeof r.dimensions === "object" && !Array.isArray(r.dimensions) ? r.dimensions : {};
    const campaignId = pick(r && r.campaign_id, d.ad_campaign_id);
    if (!campaignId) continue;
    const marketplace = normalizeMarketplace(pick(r && r.marketplace_country_code, d.marketplace_country_code));
    if (!marketplace) continue;
    const date = S(pick(r && r.metric_date, d.date)).slice(0, 10);
    if (from && date && date < from) continue;
    if (to && date && date > to) continue;
    const adsProfileId = normalizeAdsProfile(d.amazon_ads_profile_id);
    const currency = S(pick(r && r.currency, d.ad_campaign_budget_currency)).trim().toUpperCase();
    const key = campaignIdentityKey({ marketplace, adsProfileId, campaignId });
    let e = byId.get(key);
    if (!e) {
      e = { key, campaignId, marketplace, adsProfileId, currency, latestDate: date,
        campaignName: pick(d.ad_campaign_name), campaignType: pick(r && r.campaign_type, d.ad_campaign_type),
        campaignStatus: pick(d.ad_campaign_status), budgetAmount: budget(d.ad_campaign_budget_amount),
        budgetCurrency: pick(d.ad_campaign_budget_currency, currency), m: zero() };
      byId.set(key, e);
    }
    if (!e.latestDate || (date && date >= e.latestDate)) {
      e.latestDate = date || e.latestDate;
      e.campaignName = pick(d.ad_campaign_name, e.campaignName);
      e.campaignStatus = pick(d.ad_campaign_status, e.campaignStatus);
      e.campaignType = pick(r && r.campaign_type, d.ad_campaign_type, e.campaignType);
      const b = budget(d.ad_campaign_budget_amount); if (b != null) e.budgetAmount = b;
      if (!e.currency && currency) e.currency = currency;
    }
    const met = r && r.metrics && typeof r.metrics === "object" ? r.metrics : {};
    for (const k of CAMPAIGN_METRICS) e.m[k] += num(met[k]);
  }
  const campaigns = [...byId.values()].map((e) => {
    const map = mappings.get(e.key) || null;
    return {
      campaignId: e.campaignId, campaignName: e.campaignName, campaignType: e.campaignType, campaignStatus: e.campaignStatus,
      marketplace: e.marketplace, adsProfileId: e.adsProfileId, currency: e.currency,
      budgetAmount: e.budgetAmount, budgetCurrency: e.budgetCurrency,
      brandKey: map ? map.brandKey : "", brandDisplay: map ? map.brandDisplay : "", mapped: !!map,
      ...campaignKpis(e.m), _m: e.m,
    };
  });
  campaigns.sort((a, b) => (b.spend || 0) - (a.spend || 0) || a.campaignId.localeCompare(b.campaignId));
  return { campaigns: campaigns.map(({ _m, ...c }) => c), _internal: campaigns };
}

function sumMetrics(rows) { const t = zero(); for (const r of rows) for (const k of CAMPAIGN_METRICS) t[k] += num(r._m ? r._m[k] : r[k]); return t; }

// Per-currency summary: account total (ALL campaigns), per-brand totals (mapped campaigns), and the Unmapped bucket.
// Currencies are NEVER combined. All-Brands = mapped + Unmapped (exact conservation, asserted by conservationOk).
export function summarizeCampaignAds(view) {
  const rows = (view && view._internal) || [];
  const byCurrency = {};
  for (const r of rows) {
    const cur = r.currency || "";
    if (!byCurrency[cur]) byCurrency[cur] = { currency: cur, all: [], mapped: [], unmapped: [], brands: {} };
    const g = byCurrency[cur];
    g.all.push(r);
    if (r.mapped && r.brandKey) {
      g.mapped.push(r);
      (g.brands[r.brandKey] = g.brands[r.brandKey] || { brandKey: r.brandKey, brandDisplay: r.brandDisplay, rows: [] }).rows.push(r);
    } else {
      g.unmapped.push(r);
    }
  }
  const out = {};
  for (const [cur, g] of Object.entries(byCurrency)) {
    const account = campaignKpis(sumMetrics(g.all));
    const unmapped = campaignKpis(sumMetrics(g.unmapped));
    const brands = Object.values(g.brands).map((b) => ({ brandKey: b.brandKey, brandDisplay: b.brandDisplay, campaignCount: b.rows.length, ...campaignKpis(sumMetrics(b.rows)) }));
    const mappedTotal = sumMetrics(g.mapped);
    const acct = sumMetrics(g.all);
    const unmap = sumMetrics(g.unmapped);
    const conservationOk = CAMPAIGN_METRICS.every((k) => Math.abs(acct[k] - (mappedTotal[k] + unmap[k])) < 1e-6);
    out[cur] = { currency: cur, account: { campaignCount: g.all.length, ...account }, unmapped: { campaignCount: g.unmapped.length, ...unmapped }, brands, conservationOk };
  }
  return { byCurrency: out };
}

// Project a campaign list to a permitted brand scope for a brand-restricted viewer. mode: "ALL" (all campaigns, incl.
// Unmapped), "NAMED" (only campaigns mapped to requestedKey), "ALL_PERMITTED" (campaigns mapped to any permitted key).
// A restricted viewer NEVER sees Unmapped campaigns or campaigns of a non-permitted brand.
export function projectCampaignsForScope(campaigns, { mode = "ALL", permittedKeys = null, requestedKey = null } = {}) {
  const list = Array.isArray(campaigns) ? campaigns : [];
  if (mode === "ALL") return list;
  const allow = new Set((permittedKeys instanceof Set ? [...permittedKeys] : permittedKeys || []).map((k) => brandKey(k)).filter(Boolean));
  if (mode === "NAMED") { const rk = brandKey(requestedKey); return list.filter((c) => c.mapped && brandKey(c.brandKey) === rk); }
  return list.filter((c) => c.mapped && allow.has(brandKey(c.brandKey)));
}
