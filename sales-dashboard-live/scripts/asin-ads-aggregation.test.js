// Canonical ASIN Ads aggregation -- account-level + brand-level, currency isolation, unmapped separation, dedup.
import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import {
  aggregateAccountAsinAds, aggregateBrandAsinAds, aggregateAsinAdsDailyRows, asinAdsMetricsFromRow,
  normalizeAdsCurrency, asinAdsNaturalKey, UNKNOWN_CURRENCY, UNMAPPED_BRAND, ASIN_ADS_METRIC_KEYS,
} from "../lib/server/reports/asin-ads-aggregation.js";

let passed = 0;
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };
const test = (name, fn) => { try { fn(); passed += 1; out("  ok  " + name); } catch (e) { out("FAIL  " + name); out(String(e && e.stack ? e.stack : e)); process.exitCode = 1; } };

// A row builder. metrics defaults supply all six fields; pass metrics:{...} to omit/override.
let dimSeq = 0;
const row = (over = {}) => ({
  account_id: over.account_id || "acct-1",
  marketplace_country_code: over.country || "US",
  metric_date: over.date || "2026-08-20",
  dimension_key: over.dim || ("dim-" + (dimSeq += 1)),
  child_asin: over.asin === undefined ? "ASIN1" : over.asin,
  currency: over.currency == null ? "USD" : over.currency,
  updated_at: over.updated_at || "2026-08-21T00:00:00Z",
  metrics: over.metrics || { ad_impressions: 100, ad_clicks: 10, ad_spend: 5, ad_sales_same_sku: 40, ad_orders_same_sku: 4, ad_units_sold_same_sku: 6 },
});

test("metric extraction supplies ONLY present fields (never invents a missing metric as 0)", () => {
  const full = asinAdsMetricsFromRow(row());
  assert.deepEqual(Object.keys(full).sort(), [...ASIN_ADS_METRIC_KEYS].sort());
  const partial = asinAdsMetricsFromRow(row({ metrics: { ad_impressions: 12, ad_clicks: 3 } }));
  assert.deepEqual(partial, { impressions: 12, clicks: 3 });
  assert.ok(!("spend" in partial) && !("attributedUnits" in partial), "absent metrics stay absent");
  // non-finite / missing -> omitted
  assert.deepEqual(asinAdsMetricsFromRow(row({ metrics: { ad_spend: "x", ad_clicks: null } })), {});
});

test("currency normalization: lowercase/canonical fold to ONE identity; blank -> typed UNKNOWN", () => {
  assert.equal(normalizeAdsCurrency("usd"), "USD");
  assert.equal(normalizeAdsCurrency("  Usd "), "USD");
  assert.equal(normalizeAdsCurrency(""), UNKNOWN_CURRENCY);
  assert.equal(normalizeAdsCurrency(null), UNKNOWN_CURRENCY);
});

test("account-level: folds EVERY ASIN (mapped + unmapped) into per-currency totals; currencies never combine", () => {
  const rows = [
    row({ asin: "ASIN1", metrics: { ad_spend: 5, ad_impressions: 100 } }),
    row({ asin: "ASIN2", metrics: { ad_spend: 3, ad_impressions: 50 } }),
    row({ asin: "ASIN9", currency: "EUR", metrics: { ad_spend: 7, ad_impressions: 70 } }), // different currency
    row({ asin: "ASINX", currency: "", metrics: { ad_spend: 2, ad_impressions: 20 } }),     // blank currency
  ];
  const a = aggregateAccountAsinAds(rows);
  assert.deepEqual(a.currencies, ["EUR", "UNKNOWN", "USD"]);
  assert.equal(a.multiCurrency, true);
  assert.equal(a.byCurrency.USD.spend, 8); assert.equal(a.byCurrency.USD.impressions, 150);
  assert.equal(a.byCurrency.EUR.spend, 7);
  assert.equal(a.byCurrency.UNKNOWN.spend, 2);
  // USD and EUR never summed together
  assert.ok(a.byCurrency.USD.spend !== 15, "USD/EUR not combined");
});

test("brand-level: two brands in one account stay strictly separated; account total = brandA + brandB + unmapped", () => {
  const map = new Map([["ASIN1", "BrandA"], ["ASIN2", "BrandA"], ["ASIN3", "BrandB"]]); // ASIN4 unmapped
  const rows = [
    row({ asin: "ASIN1", metrics: { ad_spend: 5 } }),
    row({ asin: "ASIN2", metrics: { ad_spend: 3 } }),
    row({ asin: "ASIN3", metrics: { ad_spend: 9 } }),
    row({ asin: "ASIN4", metrics: { ad_spend: 2 } }),
  ];
  const A = aggregateBrandAsinAds(rows, map, "BrandA");
  const B = aggregateBrandAsinAds(rows, map, "BrandB");
  const acct = aggregateAccountAsinAds(rows);
  assert.equal(A.byCurrency.USD.spend, 8, "BrandA = ASIN1+ASIN2");
  assert.equal(A.matchedRows, 2);
  assert.equal(B.byCurrency.USD.spend, 9, "BrandB = ASIN3 only (no leak from BrandA)");
  assert.equal(B.matchedRows, 1);
  // unmapped is the SAME typed bucket in both (ASIN4), never assigned to a brand
  assert.equal(A.unmapped.byCurrency.USD.spend, 2);
  assert.equal(B.unmapped.byCurrency.USD.spend, 2);
  // ASIN3 (BrandB) is NOT unmapped when viewing BrandA -- it is a different brand, excluded, not unmapped
  assert.equal(A.unmapped.byCurrency.USD.spend, 2, "BrandA unmapped is only ASIN4, not ASIN3");
  // account total = brandA(8) + brandB(9) + unmapped(2) = 19
  assert.equal(acct.byCurrency.USD.spend, 19);
  assert.equal(A.byCurrency.USD.spend + B.byCurrency.USD.spend + A.unmapped.byCurrency.USD.spend, acct.byCurrency.USD.spend);
});

test("unknown / blank / ambiguous ASIN never leaks into a brand (stays in the typed unmapped amount)", () => {
  const map = new Map([["ASIN1", "BrandA"]]);
  const rows = [
    row({ asin: "ASIN1", metrics: { ad_spend: 5 } }),
    row({ asin: "", metrics: { ad_spend: 3 } }),       // blank ASIN
    row({ asin: "UNKNOWNASIN", metrics: { ad_spend: 4 } }), // not in map
  ];
  const A = aggregateBrandAsinAds(rows, map, "BrandA");
  assert.equal(A.byCurrency.USD.spend, 5, "only the mapped ASIN is attributed to BrandA");
  assert.equal(A.unmapped.byCurrency.USD.spend, 7, "blank + unknown ASINs go to unmapped, never BrandA");
});

test("dedup by the natural grain: duplicate (account,market,date,dimension_key) counts once (last updated_at wins)", () => {
  const shared = { account_id: "a", country: "US", date: "2026-08-20", dim: "same-dim", asin: "ASIN1", currency: "USD" };
  const rows = [
    row({ ...shared, updated_at: "2026-08-20T00:00:00Z", metrics: { ad_spend: 5 } }),
    row({ ...shared, updated_at: "2026-08-21T00:00:00Z", metrics: { ad_spend: 9 } }), // newer -> wins
  ];
  assert.equal(asinAdsNaturalKey(rows[0]), asinAdsNaturalKey(rows[1]));
  const a = aggregateAccountAsinAds(rows);
  assert.equal(a.rows, 1, "deduped to one row");
  assert.equal(a.byCurrency.USD.spend, 9, "the newer row wins (not summed 5+9)");
});

test("empty input -> empty byCurrency (the caller decides unavailable-vs-genuine-zero from coverage)", () => {
  const a = aggregateAccountAsinAds([]);
  assert.deepEqual(a.byCurrency, {}); assert.deepEqual(a.currencies, []); assert.equal(a.rows, 0);
});

test("daily fold: every ASIN folds per (date, currency); currencies never combine; rawSellerId stamped; blank->null", () => {
  const rows = [
    row({ asin: "ASIN1", date: "2026-08-20", metrics: { ad_sales_same_sku: 5, ad_spend: 2, ad_clicks: 3 } }),
    row({ asin: "ASIN2", date: "2026-08-20", metrics: { ad_sales_same_sku: 4, ad_spend: 1, ad_clicks: 2 } }),
    row({ asin: "ASIN9", date: "2026-08-20", currency: "EUR", metrics: { ad_sales_same_sku: 7, ad_spend: 3, ad_clicks: 1 } }),
    row({ asin: "ASINX", date: "2026-08-21", currency: "", metrics: { ad_sales_same_sku: 9, ad_spend: 4, ad_clicks: 6 } }),
  ];
  const out2 = aggregateAsinAdsDailyRows(rows, { rawSellerId: "RAW-1" });
  // 2026-08-20 USD (ASIN1+ASIN2 folded), 2026-08-20 EUR (separate), 2026-08-21 blank->null
  assert.equal(out2.length, 3);
  assert.deepEqual(out2[0], { date: "2026-08-20", seller_or_vendor_id: "RAW-1", currency: "EUR", ad_sales: 7, ad_spend: 3, ad_clicks: 1 });
  assert.deepEqual(out2[1], { date: "2026-08-20", seller_or_vendor_id: "RAW-1", currency: "USD", ad_sales: 9, ad_spend: 3, ad_clicks: 5 });
  assert.deepEqual(out2[2], { date: "2026-08-21", seller_or_vendor_id: "RAW-1", currency: null, ad_sales: 9, ad_spend: 4, ad_clicks: 6 });
  assert.ok(out2.every((r) => r.seller_or_vendor_id === "RAW-1"), "authoritative raw seller stamped on every row");
});

test("daily fold: absent metric -> 0 (additive identity); present -> sum; present-but-corrupt -> NaN (blocks, never 0)", () => {
  // A row with clicks but NO sales key: sales contributes nothing (0), clicks counts. Not an invented value.
  const noSales = aggregateAsinAdsDailyRows([row({ date: "2026-08-20", metrics: { ad_clicks: 4 } })], { rawSellerId: "R" });
  assert.deepEqual(noSales, [{ date: "2026-08-20", seller_or_vendor_id: "R", currency: "USD", ad_sales: 0, ad_spend: 0, ad_clicks: 4 }]);
  // A present-but-corrupt ad_spend poisons that group's ad_spend to NaN so resolveDailyAdsAvailability blocks it.
  const corrupt = aggregateAsinAdsDailyRows([row({ date: "2026-08-20", metrics: { ad_spend: "oops", ad_clicks: 4 } })], { rawSellerId: "R" });
  assert.ok(Number.isNaN(corrupt[0].ad_spend), "corrupt metric -> NaN (fail closed)");
  assert.equal(corrupt[0].ad_clicks, 4, "the clean metric on the same row is unaffected");
});

test("daily fold == account-level fold on the SAME rows (one reusable source: Daily + account helper agree per currency)", () => {
  const rows = [
    row({ asin: "ASIN1", date: "2026-08-20", metrics: { ad_sales_same_sku: 5, ad_spend: 2 } }),
    row({ asin: "ASIN2", date: "2026-08-21", metrics: { ad_sales_same_sku: 4, ad_spend: 1 } }),
    row({ asin: "ASIN9", date: "2026-08-20", currency: "EUR", metrics: { ad_sales_same_sku: 7, ad_spend: 3 } }),
  ];
  const daily = aggregateAsinAdsDailyRows(rows, { rawSellerId: "R" });
  const acct = aggregateAccountAsinAds(rows);
  const dailySumBy = (cur) => daily.filter((r) => (r.currency || "") === cur).reduce((a, r) => a + r.ad_sales, 0);
  assert.equal(dailySumBy("USD"), 9, "USD attributed sales total (5+4 across two dates)");
  assert.equal(dailySumBy("USD"), acct.byCurrency.USD.attributedSales, "Daily USD ad_sales == account-level USD attributedSales");
  assert.equal(dailySumBy("EUR"), acct.byCurrency.EUR.attributedSales, "Daily EUR ad_sales == account-level EUR attributedSales (currencies never merged)");
});

out("\n" + passed + " assertions passed");
