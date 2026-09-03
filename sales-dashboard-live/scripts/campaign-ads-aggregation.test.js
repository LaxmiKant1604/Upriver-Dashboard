// Campaign Ads aggregation regressions (pure, offline). Proves the campaign grain reproduces the ASIN aggregation
// SHAPES (drop-in for Daily/Brand/Dashboard) while reading the CAMPAIGN metric set + attributing to brands via the
// campaign->brand mapping: per-(date,currency) daily rows, per-currency account totals, brand vs unmapped conservation,
// strict currency isolation, absent-metric never invented, NaN poisons (fail closed). 7-bit ASCII, LF.
import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import {
  CAMPAIGN_ADS_METRIC_FIELDS, aggregateCampaignAdsDailyRows, aggregateAccountCampaignAds,
  aggregateBrandCampaignAds, campaignBrandMap, resolveCampaignRowCurrency, campaignIdentityOfRow,
  filterCampaignAdRowsToBrand, campaignMappingRevision,
} from "../lib/server/reports/campaign-ads-aggregation.js";

let passed = 0;
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// Real campaign durable row shape: top-level marketplace_country_code/campaign_id/currency/metric_date/account_id +
// dimensions{amazon_ads_profile_id, ad_campaign_name, ad_campaign_budget_currency} + metrics{...}.
const row = (o) => ({
  account_id: o.acct || "A", marketplace_country_code: o.mkt, campaign_id: o.cid, currency: o.cur,
  metric_date: o.date, dimension_key: o.dk || `${o.mkt}|${o.prof || ""}|${o.cid}|${o.date}`,
  dimensions: { amazon_ads_profile_id: o.prof || "", ad_campaign_name: o.name || "C", ad_campaign_budget_currency: o.budgetCur },
  metrics: o.m, updated_at: o.upd || "t1",
});

test("MF1. attributedSales maps to ad_sales (campaign total, NOT same-SKU)", () => {
  assert.equal(CAMPAIGN_ADS_METRIC_FIELDS.attributedSales, "ad_sales");
  assert.equal(CAMPAIGN_ADS_METRIC_FIELDS.spend, "ad_spend");
  assert.equal(CAMPAIGN_ADS_METRIC_FIELDS.attributedUnits, "ad_units_sold");
  passed += 1;
});

test("DL1. per-(date,currency) daily rows sum campaign metrics; currencies never combined", () => {
  const rows = [
    row({ mkt: "US", cid: "C1", cur: "USD", date: "2026-08-10", m: { ad_sales: 100, ad_spend: 40, ad_clicks: 5 } }),
    row({ mkt: "US", cid: "C2", cur: "USD", date: "2026-08-10", m: { ad_sales: 50, ad_spend: 10, ad_clicks: 2 } }),
    row({ mkt: "US", cid: "C1", cur: "USD", date: "2026-08-11", m: { ad_sales: 20, ad_spend: 5, ad_clicks: 1 } }),
    row({ mkt: "GB", cid: "C4", cur: "GBP", date: "2026-08-10", m: { ad_sales: 300, ad_spend: 90, ad_clicks: 9 } }),
  ];
  const daily = aggregateCampaignAdsDailyRows(rows, { rawSellerId: "raw-1" });
  const d10usd = daily.find((r) => r.date === "2026-08-10" && r.currency === "USD");
  assert.deepEqual({ sales: d10usd.ad_sales, spend: d10usd.ad_spend, clicks: d10usd.ad_clicks }, { sales: 150, spend: 50, clicks: 7 });
  assert.equal(d10usd.seller_or_vendor_id, "raw-1", "authoritative seller id stamped, never from a row");
  const d10gbp = daily.find((r) => r.currency === "GBP");
  assert.equal(d10gbp.ad_sales, 300, "GBP isolated, never merged with USD");
  assert.ok(daily.every((r) => r.currency === "USD" || r.currency === "GBP"));
  passed += 1;
});

test("DL2. absent metric contributes 0 to a SUM (not invented); a non-finite value poisons -> NaN (fail closed)", () => {
  const ok = aggregateCampaignAdsDailyRows([row({ mkt: "US", cid: "C1", cur: "USD", date: "2026-08-10", m: { ad_spend: 10 } })]);
  assert.equal(ok[0].ad_spend, 10); assert.equal(ok[0].ad_sales, 0, "absent ad_sales -> additive identity 0 in the group total");
  const bad = aggregateCampaignAdsDailyRows([row({ mkt: "US", cid: "C1", cur: "USD", date: "2026-08-10", m: { ad_sales: "boom", ad_spend: 10 } })]);
  assert.ok(Number.isNaN(bad[0].ad_sales), "a corrupt metric poisons the group total to NaN (coverage validator fails closed)");
  passed += 1;
});

test("AC1. account totals fold every campaign per currency (unmapped still counts -- belongs to the account)", () => {
  const rows = [
    row({ mkt: "US", cid: "C1", cur: "USD", date: "2026-08-10", m: { ad_sales: 100, ad_spend: 40, ad_orders: 4, ad_units_sold: 5, ad_impressions: 1000, ad_clicks: 50 } }),
    row({ mkt: "US", cid: "C2", cur: "USD", date: "2026-08-10", m: { ad_sales: 60, ad_spend: 20, ad_orders: 2, ad_units_sold: 3, ad_impressions: 500, ad_clicks: 25 } }),
  ];
  const a = aggregateAccountCampaignAds(rows);
  assert.equal(a.byCurrency.USD.spend, 60); assert.equal(a.byCurrency.USD.attributedSales, 160);
  assert.deepEqual(a.currencies, ["USD"]); assert.equal(a.multiCurrency, false);
  passed += 1;
});

test("CM1. campaignBrandMap keys identity -> brandKey; only assigned (non-blank) mappings included", () => {
  const maps = [
    { marketplace: "US", ads_profile_id: "P1", ad_campaign_id: "C1", canonical_brand_key: "acme", brand_display_name: "Acme" },
    { marketplace: "US", ads_profile_id: "P1", ad_campaign_id: "C9", canonical_brand_key: "", brand_display_name: "" }, // cleared -> excluded
  ];
  const m = campaignBrandMap(maps);
  const id = campaignIdentityOfRow(row({ mkt: "US", prof: "P1", cid: "C1", cur: "USD", date: "2026-08-10", m: {} }));
  assert.equal(m.get(id), "acme");
  const id9 = campaignIdentityOfRow(row({ mkt: "US", prof: "P1", cid: "C9", cur: "USD", date: "2026-08-10", m: {} }));
  assert.ok(!m.has(id9), "a cleared mapping is not in the map");
  passed += 1;
});

test("BR1. brand aggregation: matched to the brand vs typed unmapped; strict currency isolation + conservation", () => {
  const rows = [
    row({ mkt: "US", prof: "P1", cid: "C1", cur: "USD", date: "2026-08-10", m: { ad_sales: 100, ad_spend: 40 } }), // -> acme
    row({ mkt: "US", prof: "P1", cid: "C2", cur: "USD", date: "2026-08-10", m: { ad_sales: 50, ad_spend: 20 } }),  // -> bravo (other brand)
    row({ mkt: "US", prof: "P1", cid: "C3", cur: "USD", date: "2026-08-10", m: { ad_sales: 30, ad_spend: 10 } }),  // -> unmapped
  ];
  const map = campaignBrandMap([
    { marketplace: "US", ads_profile_id: "P1", ad_campaign_id: "C1", canonical_brand_key: "acme" },
    { marketplace: "US", ads_profile_id: "P1", ad_campaign_id: "C2", canonical_brand_key: "bravo" },
  ]);
  const acme = aggregateBrandCampaignAds(rows, map, "acme");
  assert.equal(acme.byCurrency.USD.spend, 40); assert.equal(acme.matchedRows, 1);
  assert.equal(acme.unmapped.byCurrency.USD.spend, 10, "C3 unmapped kept separate, never assigned"); assert.equal(acme.unmappedRows, 1);
  assert.ok(!("USD" in (acme.byCurrency.USD || {}) && acme.byCurrency.USD.spend === 60), "bravo's C2 excluded from acme (strict separation)");
  passed += 1;
});

test("BR2. ALL-UNMAPPED reality (no mappings yet): every brand is empty; all spend sits in unmapped (honest, never fabricated)", () => {
  const rows = [
    row({ mkt: "US", prof: "P1", cid: "C1", cur: "USD", date: "2026-08-10", m: { ad_sales: 100, ad_spend: 40 } }),
    row({ mkt: "US", prof: "P1", cid: "C2", cur: "USD", date: "2026-08-10", m: { ad_sales: 50, ad_spend: 20 } }),
  ];
  const emptyMap = campaignBrandMap([]);
  const anyBrand = aggregateBrandCampaignAds(rows, emptyMap, "acme");
  assert.deepEqual(anyBrand.byCurrency, {}, "no brand attribution until campaigns are mapped");
  assert.equal(anyBrand.unmapped.byCurrency.USD.spend, 60, "all spend honestly in unmapped");
  passed += 1;
});

test("CU1. currency resolves explicit -> budget currency -> marketplace-derived; blank stays '' (fail closed)", () => {
  assert.equal(resolveCampaignRowCurrency(row({ mkt: "US", cid: "C1", cur: "USD", date: "d", m: {} })), "USD");
  assert.equal(resolveCampaignRowCurrency(row({ mkt: "US", cid: "C1", cur: "", budgetCur: "CAD", date: "d", m: {} })), "CAD");
  assert.equal(resolveCampaignRowCurrency(row({ mkt: "GB", cid: "C1", cur: "", date: "d", m: {} })), "GBP", "derived from marketplace");
  assert.equal(resolveCampaignRowCurrency(row({ mkt: "ZZ", cid: "C1", cur: "", date: "d", m: {} })), "", "unknown marketplace + no currency -> blank (caller fails closed)");
  passed += 1;
});

// mapping row helper (matches indexMappings input: marketplace/ads_profile_id/ad_campaign_id/canonical_brand_key)
const mrow = (mkt, prof, cid, brand) => ({ marketplace: mkt, ads_profile_id: prof, ad_campaign_id: cid, canonical_brand_key: brand, brand_display_name: brand });

test("ATTR1. named-brand DAILY attribution: only the brand's mapped campaigns fold in; mapped+unmapped == account (conservation, per metric)", () => {
  const rows = [
    row({ mkt: "IN", prof: "P1", cid: "C1", cur: "INR", date: "2026-09-01", m: { ad_sales: 100, ad_spend: 40, ad_clicks: 5 } }),
    row({ mkt: "IN", prof: "P1", cid: "C2", cur: "INR", date: "2026-09-01", m: { ad_sales: 60, ad_spend: 20, ad_clicks: 3 } }),
    row({ mkt: "IN", prof: "P1", cid: "C3", cur: "INR", date: "2026-09-01", m: { ad_sales: 30, ad_spend: 10, ad_clicks: 1 } }), // unmapped
  ];
  const map = campaignBrandMap([mrow("IN", "P1", "C1", "acme"), mrow("IN", "P1", "C2", "acme")]);
  const brandRows = filterCampaignAdRowsToBrand(rows, map, "acme");
  const brandDaily = aggregateCampaignAdsDailyRows(brandRows, { rawSellerId: "raw" });
  const acct = aggregateAccountCampaignAds(rows).byCurrency.INR;
  const bAgg = aggregateBrandCampaignAds(rows, map, "acme");
  assert.equal(brandDaily.reduce((s, r) => s + r.ad_sales, 0), 160, "acme = C1+C2 (100+60), C3 excluded");
  for (const k of ["spend", "attributedSales", "clicks"]) {
    const b = (bAgg.byCurrency.INR || {})[k] || 0;
    const u = (bAgg.unmapped.byCurrency.INR || {})[k] || 0;
    assert.equal(b + u, acct[k] || 0, `conservation for ${k}: mapped + unmapped == account`);
  }
  passed += 1;
});

test("ATTR2. identity isolation: same campaign id under a DIFFERENT profile/marketplace does NOT inherit the mapping", () => {
  const rows = [
    row({ mkt: "IN", prof: "P1", cid: "C1", cur: "INR", date: "2026-09-01", m: { ad_sales: 100 } }),
    row({ mkt: "IN", prof: "P2", cid: "C1", cur: "INR", date: "2026-09-01", m: { ad_sales: 77 } }),
    row({ mkt: "US", prof: "P1", cid: "C1", cur: "USD", date: "2026-09-01", m: { ad_sales: 55 } }),
  ];
  const map = campaignBrandMap([mrow("IN", "P1", "C1", "acme")]);
  const b = aggregateBrandCampaignAds(rows, map, "acme");
  assert.equal((b.byCurrency.INR || {}).attributedSales, 100, "only the exact (IN,P1,C1) identity attributes to acme");
  assert.ok(!(b.byCurrency.USD), "the US same-id campaign is NOT acme (per-account/marketplace identity)");
  passed += 1;
});

test("ATTR3. reassign A->B moves metrics exactly once; clear returns them to Unmapped", () => {
  const rows = [row({ mkt: "IN", prof: "P1", cid: "C1", cur: "INR", date: "2026-09-01", m: { ad_sales: 100 } })];
  const toA = campaignBrandMap([mrow("IN", "P1", "C1", "brand-a")]);
  const toB = campaignBrandMap([mrow("IN", "P1", "C1", "brand-b")]);
  assert.equal((aggregateBrandCampaignAds(rows, toA, "brand-a").byCurrency.INR || {}).attributedSales, 100);
  assert.equal(aggregateBrandCampaignAds(rows, toB, "brand-a").byCurrency.INR, undefined, "A loses it after reassign");
  assert.equal((aggregateBrandCampaignAds(rows, toB, "brand-b").byCurrency.INR || {}).attributedSales, 100, "B gains it exactly once");
  const cleared = aggregateBrandCampaignAds(rows, new Map(), "brand-a");
  assert.equal(cleared.byCurrency.INR, undefined, "cleared -> not under the brand");
  assert.equal((cleared.unmapped.byCurrency.INR || {}).attributedSales, 100, "cleared -> back to Unmapped (still in account total)");
  passed += 1;
});

test("REV1. mapping revision is deterministic + order-independent, and changes on assign/clear/reassign; empty is stable", () => {
  const a = campaignMappingRevision([mrow("IN", "P1", "C1", "acme"), mrow("IN", "P1", "C2", "bravo")]);
  assert.equal(a, campaignMappingRevision([mrow("IN", "P1", "C2", "bravo"), mrow("IN", "P1", "C1", "acme")]), "order-independent");
  assert.notEqual(a, campaignMappingRevision([mrow("IN", "P1", "C1", "acme")]), "clearing C2 changes the revision");
  assert.notEqual(a, campaignMappingRevision([mrow("IN", "P1", "C1", "bravo"), mrow("IN", "P1", "C2", "bravo")]), "reassigning C1 changes the revision");
  assert.equal(campaignMappingRevision([]), campaignMappingRevision([]), "empty is a stable revision");
  assert.notEqual(campaignMappingRevision([]), a);
  passed += 1;
});

let failures = 0;
(async () => {
  out("campaign-ads-aggregation");
  for (const t of tests) { try { await t.fn(); out("  ok  " + t.name); } catch (e) { failures += 1; out("FAIL  " + t.name); out(String((e && e.stack) || e)); } }
  out("\n" + passed + " groups passed" + (failures ? ", " + failures + " FAILED" : ""));
  if (failures) process.exitCode = 1;
})();
