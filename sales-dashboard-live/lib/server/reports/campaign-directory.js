// Campaign directory — a PURE, offline-testable reader that summarizes the account's durable campaign-performance
// history (public.ads_daily_source_rows, source_key 'campaign-performance-v1') into one row per distinct campaign
// identity, joined to its current user-managed brand mapping. It reads EXISTING durable data only; it never fabricates
// a campaign and never calls DataDoe. An account with no campaign rows returns an empty directory.
//
// CAMPAIGN IDENTITY (never the campaign NAME, which changes): marketplace (canonical) + normalized nullable Ads
// profile + ad_campaign_id. The organization/connection/account are fixed server-side by the caller and are the query
// scope, so they are not part of the per-row key here.

import { brandKey } from "./brand-membership.js";
// Reuse the project's canonical marketplace helper (UK<->GB equivalence -> "GB", the value Amazon's ads rows carry),
// not a new ad-hoc normalization, so a mapping identity always matches its durable campaign row.
import { normalizeMarketplace } from "../sync/oli-sales-estimate.js";

export const CAMPAIGN_SOURCE_KEY = "campaign-performance-v1";

const S = (v) => (v == null ? "" : String(v));

// The nullable Ads profile normalized for deterministic uniqueness: null/blank -> "" (exactly one identity for a
// campaign with no profile). Never invents a profile.
export function normalizeAdsProfile(v) {
  return S(v).trim();
}

export function canonicalMarketplace(v) {
  return normalizeMarketplace(v);
}

// The stable identity key for one campaign within an already account-scoped query. A JSON array so no field value can
// collide into another field.
export function campaignIdentityKey({ marketplace, adsProfileId, campaignId }) {
  return JSON.stringify([canonicalMarketplace(marketplace), normalizeAdsProfile(adsProfileId), S(campaignId).trim()]);
}

function pick(...vals) {
  for (const v of vals) { const s = S(v).trim(); if (s) return s; }
  return "";
}

// Reduce raw durable rows to a per-identity record { key, campaignId, marketplace, adsProfileId, firstObservedDate,
// lastObservedDate, campaignName, campaignType, campaignStatus, budgetAmount, budgetCurrency }. Metadata is taken from
// the LATEST observed date (so a rename/status change surfaces the current value) while the daily rows themselves are
// left untouched at daily campaign grain.
function reduceDurableRows(durableRows) {
  const byId = new Map();
  for (const r of Array.isArray(durableRows) ? durableRows : []) {
    const d = r && r.dimensions && typeof r.dimensions === "object" && !Array.isArray(r.dimensions) ? r.dimensions : {};
    const campaignId = pick(r && r.campaign_id, d.ad_campaign_id);
    if (!campaignId) continue;
    const marketplace = canonicalMarketplace(pick(r && r.marketplace_country_code, d.marketplace_country_code));
    if (!marketplace) continue;
    const adsProfileId = normalizeAdsProfile(d.amazon_ads_profile_id);
    const key = campaignIdentityKey({ marketplace, adsProfileId, campaignId });
    const date = S(pick(r && r.metric_date, d.date)).slice(0, 10);

    let e = byId.get(key);
    if (!e) {
      e = {
        key, campaignId, marketplace, adsProfileId,
        firstObservedDate: date || null, lastObservedDate: date || null, latestDate: date || "",
        campaignName: pick(d.ad_campaign_name), campaignType: pick(r && r.campaign_type, d.ad_campaign_type),
        campaignStatus: pick(d.ad_campaign_status),
        budgetAmount: budget(d.ad_campaign_budget_amount), budgetCurrency: pick(d.ad_campaign_budget_currency, r && r.currency),
      };
      byId.set(key, e);
      continue;
    }
    if (date) {
      if (!e.firstObservedDate || date < e.firstObservedDate) e.firstObservedDate = date;
      if (!e.lastObservedDate || date > e.lastObservedDate) e.lastObservedDate = date;
    }
    // Latest-observed metadata wins (>= so the last row on a tie is kept deterministically).
    if (!e.latestDate || (date && date >= e.latestDate)) {
      e.latestDate = date || e.latestDate;
      e.campaignName = pick(d.ad_campaign_name, e.campaignName);
      e.campaignType = pick(r && r.campaign_type, d.ad_campaign_type, e.campaignType);
      e.campaignStatus = pick(d.ad_campaign_status, e.campaignStatus);
      const amt = budget(d.ad_campaign_budget_amount);
      if (amt != null) e.budgetAmount = amt;
      e.budgetCurrency = pick(d.ad_campaign_budget_currency, r && r.currency, e.budgetCurrency);
    }
  }
  return byId;
}

function budget(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// The set of campaign identity keys PROVEN by the account's durable history. The api/ layer validates every write
// identity against this set, so an unknown / cross-marketplace / cross-profile campaign is rejected before any DB
// mutation.
export function buildCampaignAuthority(durableRows) {
  return new Set([...reduceDurableRows(durableRows).keys()]);
}

// Index raw mapping rows by campaign identity key.
export function indexMappings(mappingRows) {
  const byKey = new Map();
  for (const m of Array.isArray(mappingRows) ? mappingRows : []) {
    const key = campaignIdentityKey({ marketplace: m.marketplace, adsProfileId: m.ads_profile_id, campaignId: m.ad_campaign_id });
    byKey.set(key, {
      brandKey: S(m.canonical_brand_key), brandDisplay: S(m.brand_display_name),
      mappingSource: S(m.mapping_source), mappingUpdatedAt: m.updated_at || null,
    });
  }
  return byKey;
}

// Build the full campaign directory (existing durable info only), each row joined to its current saved brand mapping.
// A campaign with no mapping is Unmapped (brandKey ""). Never fabricates campaigns; empty history -> [].
export function buildCampaignDirectory({ durableRows = [], mappingRows = [] } = {}) {
  const reduced = reduceDurableRows(durableRows);
  const mappings = indexMappings(mappingRows);
  const out = [];
  for (const e of reduced.values()) {
    const m = mappings.get(e.key) || null;
    out.push({
      campaignId: e.campaignId,
      campaignName: e.campaignName,
      campaignType: e.campaignType,
      campaignStatus: e.campaignStatus,
      marketplace: e.marketplace,
      adsProfileId: e.adsProfileId,
      budgetAmount: e.budgetAmount,
      budgetCurrency: e.budgetCurrency,
      firstObservedDate: e.firstObservedDate,
      lastObservedDate: e.lastObservedDate,
      brandKey: m ? m.brandKey : "",
      brandDisplay: m ? m.brandDisplay : "",
      mappingSource: m ? m.mappingSource : "",
      mappingUpdatedAt: m ? m.mappingUpdatedAt : null,
      mapped: !!m,
    });
  }
  out.sort((a, b) => (a.campaignName || "").localeCompare(b.campaignName || "") || a.campaignId.localeCompare(b.campaignId));
  return out;
}

// Resolve a user-supplied brand (display or key) against the account's TRUSTED membership. Returns { key, display }
// for a valid brand, { clear:true } for a blank (explicit clear), or null for an unknown brand. `trusted` is the
// [{key, display}] list from getTrustedAccountBrands.
export function resolveTrustedBrand(input, trusted) {
  const raw = S(input).trim();
  if (raw === "") return { clear: true };
  const wantKey = brandKey(raw);
  if (!wantKey) return { clear: true };
  for (const b of Array.isArray(trusted) ? trusted : []) {
    if (b && brandKey(b.key) === wantKey) return { key: b.key, display: b.display || b.key };
  }
  return null; // unknown brand -> caller rejects, fail closed
}
