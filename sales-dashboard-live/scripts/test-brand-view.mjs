// Focused tests for the account-scoped Brand View.
//
// These cover the things that would be expensive to get wrong in front of a
// user and are easy to get subtly wrong in code: account scoping, cross-account
// brand leakage, currency maths and total reconciliation, the refusal to combine
// currencies, the FX cache/fallback policy, brand-scoped TACoS, the
// "unavailable is not zero" rule, and the shared-snapshot refresh lock.
//
// Run with: npm run test:brand-view

import assert from "node:assert/strict";

// lib/server/supabase.js reads its configuration once at module load, so the
// environment has to be in place before anything that imports it. Values are
// obvious fakes and the fetch stub below never lets a request leave the process.
process.env.SUPABASE_URL = "https://brand-view-test.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
delete process.env.EXCHANGERATE_API_KEY;

const {
  aggregateBrandAds,
  aggregateBrandSales,
  asinBrandMapFromPayloads,
  brandInventory,
  brandNamesFromPayload,
  brandViewScopeId,
  buildAccountBrandSlice,
  buildBrandViewBrandDirectory,
  buildBrandViewSnapshot,
  buildBrandViewPortfolioSnapshot,
  buildBrandInventoryPayload,
  buildBrandInventorySnapshot,
  asinBrandFromSalesPayload,
  isCompactInventorySnapshot,
  isStrictCalendarDate,
  addDays,
  monthBack,
  shiftYear,
  BRAND_VIEW_VERSION,
  BRAND_INVENTORY_SNAPSHOT_KEY,
  BRAND_INVENTORY_REPORT_VERSION,
} = await import("../lib/server/reports/brand-view.js");

const { assertAdmin, DashboardAccessError } = await import("../lib/server/supabase.js");
const { brandKey: bvBrandKey } = await import("../lib/server/reports/brand-membership.js");

const {
  CURRENCY_OPTIONS,
  ORIGINAL_CURRENCY,
  brandViewModel,
  convertMoney,
  currencyGroups,
  dailySnapshotRows,
  inventoryCoverDays,
  isConvertedMode,
  lastYearWindow,
  monthlySnapshotRows,
  rangeAdSpend,
  sevenDayColumnTotals,
  sevenDayRows,
  shareOf,
  tacos,
  unconvertibleCurrencies,
} = await import("../src/lib/brand-view.js");

const { fxCacheDecision, fxRatesFromProviderPayload, FX_DISPLAY_CURRENCIES } = await import("../lib/server/fx.js");
const { brandViewCsv, brandViewXlsxSheets, exportFilename, metaLines } = await import("../src/lib/brand-view-export.js");
const { buildXlsx, crc32, sanitizeCell, safeSheetName, columnLetter } = await import("../src/lib/xlsx.js");
const { paramsHashFor } = await import("../lib/server/report-store.js");
const { partitionBrandSourceAccounts, refreshBrandSourceAccounts, brandInventoryRefreshParams, brandSalesRefreshParams } = await import("../src/lib/brand-source-refresh.js");

let passed = 0;
function test(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === "function") throw new Error("use asyncTest for an async case");
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    console.error(`FAIL  ${name}`);
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}
async function asyncTest(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    console.error(`FAIL  ${name}`);
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}

console.log("Brand View (account-scoped)");

await asyncTest("temporary Brand View source refresh is primary-only, sequential and never retries", async () => {
  const accounts = [
    { id: "A2", name: "US account", country: "US" },
    { id: "A1", name: "India account", country: "IN" },
    { id: "A1", name: "duplicate", country: "IN" },
    { id: "dd-secondary:OLD", name: "Legacy secondary", country: "GB" },
  ];
  assert.deepEqual(
    partitionBrandSourceAccounts(accounts),
    { eligible: [accounts[0], accounts[1]], skipped: [accounts[3]] }
  );

  const calls = [];
  const progress = [];
  let inFlight = 0;
  const outcome = await refreshBrandSourceAccounts({
    accounts,
    todayForCountry: (country) => (country === "US" ? "2026-08-11" : "2026-08-12"),
    onProgress: (entry) => progress.push(entry),
    refreshReport: async (params) => {
      assert.equal(inFlight, 0, "account refreshes must not overlap");
      inFlight += 1;
      calls.push(params);
      await Promise.resolve();
      inFlight -= 1;
      if (params.ids === "A2") throw new Error("safe fake failure");
      return { body: { ok: true } };
    },
  });

  // Each account runs brand-sales THEN brand-inventory, sequentially, no retry.
  assert.deepEqual(
    calls.map((call) => [call.ids, call.action]),
    [["A2", "brand-sales"], ["A2", "brand-inventory"], ["A1", "brand-sales"], ["A1", "brand-inventory"]],
    "a failed account still attempts its inventory step, then the next account runs"
  );
  assert.deepEqual(calls.find((c) => c.ids === "A1" && c.action === "brand-sales"), {
    action: "brand-sales",
    reportVersion: "brand-sales-shared-v1",
    ids: "A1",
    from: "2025-06-07",
    to: "2026-08-12",
  });
  assert.deepEqual(calls.find((c) => c.ids === "A1" && c.action === "brand-inventory"), {
    action: "brand-inventory",
    reportVersion: "brand-inventory-shared-v1",
    ids: "A1",
    to: "2026-08-12",
  });
  assert.equal(outcome.attempted, 2);
  assert.deepEqual(outcome.salesSucceeded.map((account) => account.id), ["A1"]);
  assert.deepEqual(outcome.inventorySucceeded.map((account) => account.id), ["A1"]);
  assert.deepEqual(outcome.salesFailed.map(({ account }) => account.id), ["A2"]);
  assert.deepEqual(outcome.inventoryFailed.map(({ account }) => account.id), ["A2"]);
  assert.deepEqual(outcome.succeeded.map((account) => account.id), ["A1"], "A1 saved new data, so the portfolio rebuilds");
  assert.deepEqual(outcome.failed.map(({ account }) => account.id), ["A2"], "A2 failed both sources");
  assert.deepEqual(outcome.skipped.map((account) => account.id), ["dd-secondary:OLD"]);
  assert.deepEqual(progress.map((entry) => entry.completed), [0, 1, 2], "one progress tick per account plus the final");
  // No account is retried: exactly one call per (account, source).
  assert.equal(calls.length, 4, "two eligible accounts x two sources, each attempted exactly once");
});

/* ================================================================== fixtures */

// Two accounts with deliberately overlapping shapes but different brands. Every
// scoping test below asserts against this pair.
const ACCOUNT_A = "eu-seller-1";
const ACCOUNT_B = "in-seller-9";

const SNAPSHOTS = {
  [`brand-sales|${ACCOUNT_A}`]: {
    source_refreshed_at: "2026-07-28T04:00:00.000Z",
    params: { from: "2025-05-01", to: "2026-07-27" },
    payload: {
      catalogBrands: ["Bebi Born", "Nordfell", "Unassigned"],
      rows: [
        // Italy, EUR
        { date: "2026-07-27", marketplace_country_code: "IT", currency: "EUR", product_brand: "Bebi Born", total_sales: 210, total_units_sold: 21, seller_or_vendor_name: "Bebi EU" },
        { date: "2026-07-26", marketplace_country_code: "IT", currency: "EUR", product_brand: "Bebi Born", total_sales: 130, total_units_sold: 13 },
        { date: "2025-07-27", marketplace_country_code: "IT", currency: "EUR", product_brand: "Bebi Born", total_sales: 190, total_units_sold: 19 },
        // United Kingdom, GBP
        { date: "2026-07-27", marketplace_country_code: "UK", currency: "GBP", product_brand: "Bebi Born", total_sales: 60, total_units_sold: 6 },
        { date: "2026-07-26", marketplace_country_code: "UK", currency: "GBP", product_brand: "Bebi Born", total_sales: 40, total_units_sold: 4 },
        // Another brand in the same account: must never leak into Bebi Born.
        { date: "2026-07-27", marketplace_country_code: "IT", currency: "EUR", product_brand: "Nordfell", total_sales: 900, total_units_sold: 90 },
        // Unmapped catalog rows.
        { date: "2026-07-27", marketplace_country_code: "IT", currency: "EUR", product_brand: "Unassigned", total_sales: 12, total_units_sold: 1 },
      ],
    },
  },
  [`fba-plan|${ACCOUNT_A}`]: {
    source_refreshed_at: "2026-07-28T05:00:00.000Z",
    payload: {
      inventoryDate: "2026-07-28",
      rows: [
        { asin: "B00BEBI001", brand: "Bebi Born", fbaAvailable: 700 },
        { asin: "B00BEBI002", brand: "Bebi Born", fbaAvailable: 195 },
        { asin: "B00NORD001", brand: "Nordfell", fbaAvailable: 500 },
      ],
      inventoryByBrandCountry: [
        { country: "IT", brand: "Bebi Born", fbaAvailable: 883, skuCount: 4 },
        { country: "UK", brand: "Bebi Born", fbaAvailable: 912, skuCount: 3 },
        // Stock with no sales in the window: the "FC only" case.
        { country: "PL", brand: "Bebi Born", fbaAvailable: 368, skuCount: 2 },
        { country: "IT", brand: "Nordfell", fbaAvailable: 4000, skuCount: 9 },
      ],
    },
  },
  [`sku-pl|${ACCOUNT_A}`]: {
    source_refreshed_at: "2026-07-20T05:00:00.000Z",
    payload: {
      rows: [
        { asin: "B00BEBI001", brand: "Bebi Born" },
        { asin: "B00BEBI002", brand: "Bebi Born" },
        { asin: "B00NORD001", brand: "Nordfell" },
      ],
    },
  },
  // A completely different account with a completely different brand.
  [`brand-sales|${ACCOUNT_B}`]: {
    source_refreshed_at: "2026-07-28T04:00:00.000Z",
    params: { from: "2025-05-01", to: "2026-07-27" },
    payload: {
      catalogBrands: ["Beeline"],
      rows: [
        { date: "2026-07-27", marketplace_country_code: "IN", currency: "INR", product_brand: "Beeline", total_sales: 41000, total_units_sold: 120 },
      ],
    },
  },
};

// Records every account a lookup touched, so a scoping test can prove that no
// other account was ever read.
const touchedAccounts = new Set();
function fakeGetSnapshot({ reportKey, accountId }) {
  touchedAccounts.add(String(accountId));
  return Promise.resolve(SNAPSHOTS[`${reportKey}|${accountId}`] || null);
}

const AD_ROWS = [
  // Brand ASINs.
  { metric_date: "2026-07-27", marketplace_country_code: "UK", child_asin: "B00BEBI001", currency: "GBP", metrics: { ad_spend: 0.54 } },
  { metric_date: "2026-07-26", marketplace_country_code: "UK", child_asin: "B00BEBI002", currency: "GBP", metrics: { ad_spend: 3.18 } },
  // Another brand's ASIN in the same account and marketplace: must be excluded.
  { metric_date: "2026-07-27", marketplace_country_code: "UK", child_asin: "B00NORD001", currency: "GBP", metrics: { ad_spend: 500 } },
  // A marketplace with ad rows but none for this brand: a real zero, not a gap.
  { metric_date: "2026-07-27", marketplace_country_code: "IT", child_asin: "B00NORD001", currency: "EUR", metrics: { ad_spend: 25 } },
];

// Post ASIN->Campaign cutover, Brand View reads the durable CAMPAIGN grain and attributes to a brand via the manual
// campaign->brand mapping (NOT the child_asin->brand catalog map). Same spend/marketplaces as AD_ROWS above, but
// keyed by campaign identity + a mapping fixture. (AD_ROWS stays for the retained aggregateBrandAds unit test.)
const CAMPAIGN_AD_ROWS = [
  { metric_date: "2026-07-27", marketplace_country_code: "UK", campaign_id: "CBEBI1", currency: "GBP", metrics: { ad_spend: 0.54 } },
  { metric_date: "2026-07-26", marketplace_country_code: "UK", campaign_id: "CBEBI2", currency: "GBP", metrics: { ad_spend: 3.18 } },
  { metric_date: "2026-07-27", marketplace_country_code: "UK", campaign_id: "CNORD1", currency: "GBP", metrics: { ad_spend: 500 } }, // Nordfell -> excluded from Bebi Born
  { metric_date: "2026-07-27", marketplace_country_code: "IT", campaign_id: "CNORD2", currency: "EUR", metrics: { ad_spend: 25 } },  // IT has ads but none for Bebi Born -> a real zero
];
// The saved campaign->brand mapping rows (getCampaignBrandMappings shape). Both sides normalize the marketplace the
// same way, so "UK" here matches "UK" on the rows.
const CAMPAIGN_MAPPINGS = [
  { marketplace: "UK", ads_profile_id: "", ad_campaign_id: "CBEBI1", canonical_brand_key: bvBrandKey("Bebi Born"), brand_display_name: "Bebi Born" },
  { marketplace: "UK", ads_profile_id: "", ad_campaign_id: "CBEBI2", canonical_brand_key: bvBrandKey("Bebi Born"), brand_display_name: "Bebi Born" },
  { marketplace: "UK", ads_profile_id: "", ad_campaign_id: "CNORD1", canonical_brand_key: bvBrandKey("Nordfell"), brand_display_name: "Nordfell" },
  { marketplace: "IT", ads_profile_id: "", ad_campaign_id: "CNORD2", canonical_brand_key: bvBrandKey("Nordfell"), brand_display_name: "Nordfell" },
];
const getCampaignMappingsFake = async () => CAMPAIGN_MAPPINGS;

function fakeGetAdsRows() {
  return Promise.resolve(CAMPAIGN_AD_ROWS);
}

/* =================================================== 1. account-scoped brands */

await asyncTest("the brand list contains only brands recorded for the selected account", async () => {
  const directory = await buildBrandViewBrandDirectory({ accountId: ACCOUNT_A, getSnapshot: fakeGetSnapshot });
  assert.deepEqual(directory.brands, ["Bebi Born", "Nordfell"]);
  assert.equal(directory.accountId, ACCOUNT_A);
  // "Unassigned" is real sales but not a brand, so it must not be selectable.
  assert.ok(!directory.brands.includes("Unassigned"));
});

await asyncTest("no brand leakage: another account's brands are never read or returned", async () => {
  touchedAccounts.clear();
  const directory = await buildBrandViewBrandDirectory({ accountId: ACCOUNT_A, getSnapshot: fakeGetSnapshot });
  assert.ok(!directory.brands.includes("Beeline"), "account B's brand appeared under account A");
  assert.deepEqual([...touchedAccounts], [ACCOUNT_A], "a snapshot outside the selected account was read");

  touchedAccounts.clear();
  const other = await buildBrandViewBrandDirectory({ accountId: ACCOUNT_B, getSnapshot: fakeGetSnapshot });
  assert.deepEqual(other.brands, ["Beeline"]);
  assert.ok(!other.brands.includes("Bebi Born"));
  assert.deepEqual([...touchedAccounts], [ACCOUNT_B]);
});

await asyncTest("an account with no saved brand data returns an actionable message, not an error", async () => {
  const directory = await buildBrandViewBrandDirectory({ accountId: "never-refreshed", getSnapshot: fakeGetSnapshot });
  assert.deepEqual(directory.brands, []);
  assert.match(directory.message, /refresh its Dashboard/i);
});

test("a Brand View snapshot key isolates one brand from another", () => {
  assert.notEqual(brandViewScopeId(ACCOUNT_A, "Bebi Born"), brandViewScopeId(ACCOUNT_A, "Nordfell"));
  assert.notEqual(brandViewScopeId(ACCOUNT_A, "Bebi Born"), brandViewScopeId(ACCOUNT_B, "Bebi Born"));
  // The across-midnight fallback looks up by report key + this id alone, so the
  // brand being inside it is what stops one brand serving another's snapshot.
  assert.ok(brandViewScopeId(ACCOUNT_A, "Bebi Born").includes("Bebi Born"));
});

test("the snapshot params hash separates account, brand and as-of date", () => {
  const base = { accountId: ACCOUNT_A, brand: "Bebi Born", asOf: "2026-07-28" };
  const hash = paramsHashFor(BRAND_VIEW_VERSION, base);
  assert.notEqual(hash, paramsHashFor(BRAND_VIEW_VERSION, { ...base, brand: "Nordfell" }));
  assert.notEqual(hash, paramsHashFor(BRAND_VIEW_VERSION, { ...base, accountId: ACCOUNT_B }));
  assert.notEqual(hash, paramsHashFor(BRAND_VIEW_VERSION, { ...base, asOf: "2026-07-29" }));
  assert.equal(hash, paramsHashFor(BRAND_VIEW_VERSION, { ...base }));
});

/* ============================================== 2. aggregation and TACoS scope */

test("sales aggregation keeps only the selected brand and never mixes currencies", () => {
  const result = aggregateBrandSales(SNAPSHOTS[`brand-sales|${ACCOUNT_A}`].payload.rows, "Bebi Born");
  assert.deepEqual([...result.countries.entries()].sort(), [["IT", "EUR"], ["UK", "GBP"]]);
  assert.deepEqual(result.currencyConflicts, []);
  const italyToday = result.series.get("IT|2026-07-27");
  // 900 (Nordfell) and 12 (Unassigned) must not be in this number.
  assert.equal(italyToday.s, 210);
  assert.equal(italyToday.u, 21);
});

test("TACoS uses brand-scoped ad spend: another brand's spend is excluded", () => {
  const asinBrand = asinBrandMapFromPayloads([SNAPSHOTS[`fba-plan|${ACCOUNT_A}`].payload]);
  assert.equal(asinBrand.get("B00BEBI001"), "Bebi Born");
  assert.equal(asinBrand.get("B00NORD001"), "Nordfell");

  const ads = aggregateBrandAds(AD_ROWS, asinBrand, "Bebi Born");
  assert.equal(ads.spendByKey.get("UK|2026-07-27"), 0.54, "the other brand's £500 leaked into this brand");
  assert.equal(ads.spendByKey.get("UK|2026-07-26"), 3.18);
  assert.equal(ads.spendByKey.get("IT|2026-07-27"), undefined, "Italy had no spend for this brand");
  // Italy still counts as an ads-covered marketplace, which is what makes its
  // zero a real zero rather than an unavailable value.
  assert.deepEqual(ads.adCountries.sort(), ["IT", "UK"]);
  assert.deepEqual(ads.coverageByCountry.get("UK"), { from: "2026-07-26", to: "2026-07-27" });
  assert.equal(ads.matchedRows, 2);
});

test("the ASIN-to-brand map ignores brand-grain snapshots that carry no ASIN", () => {
  // brand-sales rows are already folded to brand and have no child_asin. Reading
  // them here would silently produce an empty map and zero every brand's spend.
  const map = asinBrandMapFromPayloads([SNAPSHOTS[`brand-sales|${ACCOUNT_A}`].payload]);
  assert.equal(map.size, 0);
});

test("brand names are read from catalogBrands and from row brands alike", () => {
  assert.deepEqual(brandNamesFromPayload({ catalogBrands: ["A", "Unassigned", " "] }).sort(), ["A"]);
  assert.deepEqual(brandNamesFromPayload({ rows: [{ brand: "B" }, { product_brand: "C" }] }).sort(), ["B", "C"]);
});

test("inventory is per marketplace when the saved plan has it, and account-wide otherwise", () => {
  const detailed = brandInventory(SNAPSHOTS[`fba-plan|${ACCOUNT_A}`].payload, "Bebi Born", "IT");
  assert.equal(detailed.scope, "country");
  assert.equal(detailed.byCountry.get("IT"), 883);
  assert.equal(detailed.byCountry.get("PL"), 368);
  assert.equal(detailed.byCountry.get("DE"), undefined);
  assert.equal(detailed.accountTotal, 883 + 912 + 368);

  const legacy = brandInventory({ rows: [{ brand: "Bebi Born", fbaAvailable: 40 }] }, "Bebi Born", "IT");
  assert.equal(legacy.scope, "account");
  assert.equal(legacy.accountTotal, 40);
  assert.equal(legacy.byCountry.size, 0, "a legacy payload must not invent a country");

  const none = brandInventory(null, "Bebi Born", "IT");
  assert.equal(none.scope, "unavailable");
  assert.equal(none.accountTotal, null);
});

/* ============================== 2b. compact Brand View FBA inventory bridge ==============================
   The temporary admin Brand View inventory refresh: a minimal FBA Inventory Health fold with STRICT row
   validation, an AUTHORITATIVE compact snapshot, and NO live Product Catalog fallback. Window is asOf-10d..asOf.
*/

const INV_TO = "2026-07-28";
const INV_FROM = "2026-07-18"; // asOf - 10 days (PLAN_INVENTORY_LOOKBACK_DAYS)

// Raw FBA Inventory Health rows for one account. Two marketplaces, a genuine zero,
// a Nordfell row that must never leak into Bebi Born, and an OLDER (in-window) date
// row that the "latest validated date only" rule must ignore.
const INV_BRAND_BY_ASIN = new Map([
  ["B00BEBI001", "Bebi Born"], ["B00BEBI002", "Bebi Born"],
  ["B00BEBI003", "Bebi Born"], ["B00NORD001", "Nordfell"],
]);
const INV_ROWS = () => [
  { date: "2026-07-28", marketplace_country_code: "IT", child_asin: "B00BEBI001", sku: "IT-1", available: 600 },
  { date: "2026-07-28", marketplace_country_code: "IT", child_asin: "B00BEBI002", sku: "IT-2", available: 283 },
  { date: "2026-07-28", marketplace_country_code: "UK", child_asin: "B00BEBI001", sku: "UK-1", available: 912 },
  { date: "2026-07-28", marketplace_country_code: "DE", child_asin: "B00BEBI003", sku: "DE-1", available: 0 },
  { date: "2026-07-28", marketplace_country_code: "IT", child_asin: "B00NORD001", sku: "IT-9", available: 4000 },
  { date: "2026-07-27", marketplace_country_code: "IT", child_asin: "B00BEBI001", sku: "IT-old", available: 99999 },
];
const buildInv = (over = {}) => buildBrandInventoryPayload({
  accountId: ACCOUNT_A, invRows: INV_ROWS(), brandByAsin: INV_BRAND_BY_ASIN,
  accountCountry: "IT", from: INV_FROM, to: INV_TO, rowLimit: 15000, ...over,
});

/* ---- BLOCKER 1: strict FBA inventory row validation ---- */

test("6/9/10. exact-window boundaries + available=0 accepted; folds ONLY the latest date, by country and exact brand", () => {
  const p = buildInv();
  assert.equal(p.inventoryDate, "2026-07-28", "latest snapshot date only");
  assert.equal(p.inventoryAvailable, true);
  const cell = (country, brand) => p.inventoryByBrandCountry.find((e) => e.country === country && e.brand === brand);
  assert.equal(cell("IT", "Bebi Born").fbaAvailable, 883, "IT Bebi Born = 600 + 283, never the 99999 older-date row");
  assert.equal(cell("IT", "Bebi Born").skuCount, 2);
  assert.equal(cell("UK", "Bebi Born").fbaAvailable, 912);
  assert.equal(cell("DE", "Bebi Born").fbaAvailable, 0, "available=0 is accepted as a genuine value");
  assert.equal(cell("IT", "Nordfell").fbaAvailable, 4000, "Nordfell is a separate bucket, never folded into Bebi Born");
  // Rows exactly ON each window boundary are accepted.
  const boundary = [
    { date: INV_FROM, marketplace_country_code: "IT", child_asin: "B00BEBI001", sku: "F", available: 3 },
    { date: INV_TO, marketplace_country_code: "IT", child_asin: "B00BEBI001", sku: "T", available: 7 },
  ];
  const bp = buildInv({ invRows: boundary });
  assert.equal(bp.inventoryDate, INV_TO);
  assert.equal(bp.inventoryByBrandCountry.find((e) => e.country === "IT").fbaAvailable, 7, "only the latest boundary date folds");
  assert.equal(isStrictCalendarDate("2024-02-29"), true, "a real leap day round-trips");
});

test("1/2/3. impossible, future, malformed and out-of-window dates are rejected (whole payload refused)", () => {
  const one = (date) => () => buildInv({ invRows: [{ date, marketplace_country_code: "IT", child_asin: "B00BEBI001", sku: "S", available: 1 }] });
  const safe = (e) => e.brandInventorySafe === true;
  assert.throws(one("2099-01-01"), safe, "future date");
  assert.throws(one("2025-02-30"), safe, "impossible calendar date");
  assert.throws(one("2026-13-40"), safe, "malformed date");
  assert.throws(one("not-a-date"), safe, "non-date string");
  assert.throws(one(addDays(INV_FROM, -1)), safe, "one day BEFORE the window");
  assert.throws(one(addDays(INV_TO, 1)), safe, "one day AFTER the window");
  assert.equal(isStrictCalendarDate("2025-02-30"), false, "the strict validator rejects the impossible date directly");
  assert.equal(isStrictCalendarDate("2099-01-01"), true, "2099-01-01 is a valid CALENDAR date; the window check is what rejects it");
});

test("4/5. missing ASIN, non-object rows, and non-finite/malformed/negative available are rejected (never zeroed)", () => {
  const row = (over) => [{ date: INV_TO, marketplace_country_code: "IT", child_asin: "B00BEBI001", sku: "S", available: 1, ...over }];
  const safe = (e) => e.brandInventorySafe === true;
  assert.throws(() => buildInv({ invRows: "not-an-array" }), safe, "invRows must be an array");
  assert.throws(() => buildInv({ invRows: [null] }), safe, "a non-object row");
  assert.throws(() => buildInv({ invRows: [["array-row"]] }), safe, "an array row");
  assert.throws(() => buildInv({ invRows: row({ child_asin: "" }) }), safe, "missing ASIN");
  assert.throws(() => buildInv({ invRows: row({ child_asin: "   " }) }), safe, "blank ASIN");
  assert.throws(() => buildInv({ invRows: row({ available: -1 }) }), safe, "negative available");
  assert.throws(() => buildInv({ invRows: row({ available: "5" }) }), safe, "a numeric STRING is not converted, it is rejected");
  assert.throws(() => buildInv({ invRows: row({ available: null }) }), safe, "null available is not converted to zero");
  assert.throws(() => buildInv({ invRows: row({ available: undefined }) }), safe, "missing available");
  assert.throws(() => buildInv({ invRows: row({ available: NaN }) }), safe, "NaN available");
  assert.throws(() => buildInv({ invRows: row({ available: Infinity }) }), safe, "non-finite available");
});

test("8. an FBA inventory result exactly at the row cap is refused as truncated and not saved", () => {
  const atCap = new Array(15000).fill(0).map((_, i) => ({ date: INV_TO, marketplace_country_code: "IT", child_asin: "B00BEBI001", sku: `S${i}`, available: 1 }));
  assert.throws(() => buildInv({ invRows: atCap }), (error) => error.brandInventorySafe === true && /row cap/i.test(error.message));
  assert.equal(buildInv({ invRows: atCap.slice(0, 14999) }).inventoryAvailable, true, "just under the cap is accepted");
});

test("11(z)/12. validated zero is a genuine zero; an absent brand or empty snapshot stays unavailable", () => {
  const p = buildInv();
  const inv = brandInventory(p, "Bebi Born", "IT", null);
  assert.equal(inv.byCountry.get("DE"), 0, "the covered DE marketplace reports a validated zero, not a blank");
  assert.equal(inv.accountTotal, 883 + 912 + 0);
  assert.equal(brandInventory(p, "Brand Not In Snapshot", "IT", null).accountTotal, null, "no invented zero for an absent brand");
  const empty = buildBrandInventoryPayload({ accountId: ACCOUNT_A, invRows: [], brandByAsin: INV_BRAND_BY_ASIN, accountCountry: "IT", from: INV_FROM, to: INV_TO, rowLimit: 15000 });
  assert.deepEqual([empty.inventoryAvailable, empty.inventoryDate, empty.inventoryByBrandCountry], [false, null, []]);
});

/* ---- BLOCKER 3: no second Product Catalog export; missing map fails before the FBA export ---- */

await asyncTest("13. successful refresh spends exactly ONE FBA export and ZERO Catalog exports (<= 3 per account)", async () => {
  let invCalls = 0;
  const { payload, asinBrandCount } = await buildBrandInventorySnapshot({
    accountId: ACCOUNT_A, accountCountry: "IT", from: INV_FROM, to: INV_TO, rowLimit: 15000,
    getSnapshot: async ({ reportKey }) => (reportKey === "brand-sales"
      ? { payload: { asinBrand: { B00BEBI001: "Bebi Born", B00BEBI002: "Bebi Born" } }, params: { to: INV_TO } } : null),
    fetchInventoryRows: async () => { invCalls += 1; return INV_ROWS(); },
    // buildBrandInventorySnapshot has NO catalog fetcher parameter -> zero catalog exports by construction.
  });
  assert.equal(invCalls, 1, "exactly one FBA Inventory Health export");
  assert.ok(asinBrandCount >= 1, "the saved brand-sales asinBrand map is reused");
  assert.equal(payload.inventoryByBrandCountry.find((e) => e.country === "IT" && e.brand === "Bebi Born").fbaAvailable, 883);
});

await asyncTest("11/12. a missing asinBrand (e.g. Brand Sales catalog just failed) fails BEFORE the FBA export: zero exports", async () => {
  let invCalls = 0;
  await assert.rejects(
    () => buildBrandInventorySnapshot({
      accountId: ACCOUNT_A, accountCountry: "IT", from: INV_FROM, to: INV_TO, rowLimit: 15000,
      getSnapshot: async ({ reportKey }) => (reportKey === "brand-sales" ? { payload: { rows: [{ product_brand: "Bebi Born" }] } } : null), // no asinBrand map
      fetchInventoryRows: async () => { invCalls += 1; return INV_ROWS(); },
    }),
    (error) => error.brandInventorySafe === true && /Brand Sales/i.test(error.message)
  );
  assert.equal(invCalls, 0, "no FBA Inventory export is spent when the brand map is missing; no catalog fetcher exists at all");
});

await asyncTest("7. an inventory DataDoe failure throws (nothing is saved) so a prior good snapshot survives", async () => {
  await assert.rejects(
    () => buildBrandInventorySnapshot({
      accountId: ACCOUNT_A, accountCountry: "IT", from: INV_FROM, to: INV_TO, rowLimit: 15000,
      getSnapshot: async () => ({ payload: { asinBrand: { B00BEBI001: "Bebi Born" } } }),
      fetchInventoryRows: async () => { throw new Error("simulated DataDoe outage"); },
    }),
    /simulated DataDoe outage/
  );
});

test("15. the source-fetch action is admin-only on the SERVER, not merely hidden in the UI", () => {
  assert.throws(() => assertAdmin({ role: "member" }), (error) => error instanceof DashboardAccessError && error.status === 403);
  assert.throws(() => assertAdmin({ role: "viewer" }), DashboardAccessError);
  assert.doesNotThrow(() => assertAdmin({ role: "admin" }));
});

test("16. primary and legacy dd-secondary IDs never mix in the inventory refresh params", () => {
  const { eligible, skipped } = partitionBrandSourceAccounts([
    { id: "A1", country: "IN" }, { id: "dd-secondary:LEG", country: "GB" },
  ]);
  assert.deepEqual(eligible.map((a) => a.id), ["A1"]);
  assert.deepEqual(skipped.map((a) => a.id), ["dd-secondary:LEG"]);
  assert.deepEqual(brandInventoryRefreshParams({ id: "A1" }, "2026-08-12"), {
    action: "brand-inventory", reportVersion: "brand-inventory-shared-v1", ids: "A1", to: "2026-08-12",
  }, "the public id is used verbatim; a dd-secondary account is never stripped onto the primary key");
});

/* ---- BLOCKER 2: a valid compact snapshot is authoritative; no stale FBA Plan resurrection ---- */

// A getSnapshot that layers a compact brand-inventory snapshot over the shared fixtures.
function getSnapshotWithInventory(extra) {
  return ({ reportKey, accountId }) => {
    const key = `${reportKey}|${accountId}`;
    if (Object.prototype.hasOwnProperty.call(extra, key)) return Promise.resolve(extra[key]);
    return fakeGetSnapshot({ reportKey, accountId });
  };
}
const compactSnap = (inventoryByBrandCountry, over = {}) => ({
  [`${BRAND_INVENTORY_SNAPSHOT_KEY}|${ACCOUNT_A}`]: {
    source_refreshed_at: "2026-07-29T06:00:00.000Z",
    params: { reportVersion: BRAND_INVENTORY_REPORT_VERSION, to: "2026-07-28" },
    payload: { accountId: ACCOUNT_A, inventoryDate: "2026-07-29", inventoryAvailable: inventoryByBrandCountry.length > 0, inventoryByBrandCountry },
    ...over,
  },
});
const sliceFor = (getSnapshot) => buildAccountBrandSlice({
  accountId: ACCOUNT_A, brand: "Bebi Born", asOf: "2026-07-28",
  account: { name: "Bebi EU", country: "IT" }, getSnapshot, getAdsRows: fakeGetAdsRows, getCampaignMappings: getCampaignMappingsFake,
});

test("isCompactInventorySnapshot validates the report version + compact shape", () => {
  assert.equal(isCompactInventorySnapshot(compactSnap([])[`${BRAND_INVENTORY_SNAPSHOT_KEY}|${ACCOUNT_A}`]), true);
  assert.equal(isCompactInventorySnapshot({ params: { reportVersion: "some-old-version" }, payload: { inventoryByBrandCountry: [] } }), false, "wrong version is not authoritative");
  assert.equal(isCompactInventorySnapshot({ params: { reportVersion: BRAND_INVENTORY_REPORT_VERSION }, payload: {} }), false, "no compact shape");
  assert.equal(isCompactInventorySnapshot(null), false);
});

await asyncTest("13(auth). a valid compact snapshot is AUTHORITATIVE and wins over the fba-plan snapshot", async () => {
  const slice = await sliceFor(getSnapshotWithInventory(compactSnap([
    { country: "IT", brand: "Bebi Born", fbaAvailable: 1234, skuCount: 5 },
    { country: "DE", brand: "Bebi Born", fbaAvailable: 0, skuCount: 1 },
  ])));
  assert.equal(slice.inventory.byCountry.get("IT"), 1234, "compact wins over the fba-plan value (883)");
  assert.equal(slice.inventory.byCountry.get("DE"), 0, "a validated zero is preserved");
  assert.equal(slice.inventoryDate, "2026-07-29", "inventoryDate comes from the compact snapshot");
});

await asyncTest("8(b). an EMPTY valid compact snapshot shows unavailable, NOT a stale FBA Plan value", async () => {
  const slice = await sliceFor(getSnapshotWithInventory(compactSnap([])));
  assert.equal(slice.inventory.accountTotal, null, "empty compact => unavailable");
  assert.equal(slice.inventory.byCountry.size, 0);
  assert.notEqual(slice.inventory.byCountry.get("IT"), 883, "the stale fba-plan IT value (883) is NOT resurrected");
});

await asyncTest("9(b). a compact snapshot WITHOUT the selected brand stays unavailable, not stale legacy data", async () => {
  const slice = await sliceFor(getSnapshotWithInventory(compactSnap([
    { country: "IT", brand: "Nordfell", fbaAvailable: 5000, skuCount: 9 }, // present, but not Bebi Born
  ])));
  assert.equal(slice.inventory.accountTotal, null, "absent brand in a valid compact snapshot => unavailable");
  assert.notEqual(slice.inventory.byCountry.get("IT"), 883, "no fallback to the stale fba-plan value");
});

await asyncTest("10. with NO compact snapshot the temporary legacy fba-plan fallback is still allowed", async () => {
  const slice = await sliceFor(fakeGetSnapshot); // fixtures have an fba-plan snapshot, no brand-inventory
  assert.equal(slice.inventory.byCountry.get("IT"), 883, "no compact snapshot => legacy fba-plan value is used");
  // A wrong-version compact snapshot is treated as no valid compact snapshot -> legacy fallback.
  const wrongVersion = { [`${BRAND_INVENTORY_SNAPSHOT_KEY}|${ACCOUNT_A}`]: { params: { reportVersion: "brand-inventory-OLD" }, payload: { inventoryByBrandCountry: [{ country: "IT", brand: "Bebi Born", fbaAvailable: 1 }] } } };
  const slice2 = await sliceFor(getSnapshotWithInventory(wrongVersion));
  assert.equal(slice2.inventory.byCountry.get("IT"), 883, "a wrong-version compact snapshot is not authoritative; legacy fallback applies");
});

await asyncTest("Campaign->brand mapping drives Brand View ad attribution (not the catalog); brand isolation holds", async () => {
  // Post ASIN->Campaign cutover, Brand View ad attribution is via the manual campaign->brand mapping, NOT the
  // child_asin->brand catalog. With NO mapping every brand is honestly empty (never fabricated); with the mapping
  // only THIS brand's campaigns attribute, and another brand's campaign spend is excluded (brand isolation).
  const salesOnly = ({ reportKey, accountId }) => Promise.resolve(reportKey === "brand-sales" ? (SNAPSHOTS[`brand-sales|${accountId}`] || null) : null);
  const common = { accountId: ACCOUNT_A, brand: "Bebi Born", asOf: "2026-07-28", account: { name: "Bebi EU", country: "IT" }, getSnapshot: salesOnly, getAdsRows: fakeGetAdsRows, required: false };
  const noMap = await buildAccountBrandSlice(common); // default getCampaignMappings -> [] (all campaigns unmapped)
  assert.equal(noMap.ads.matchedRows, 0, "with NO campaign->brand mapping, Ads cannot attribute (matchedRows 0; honest empty)");
  const withMap = await buildAccountBrandSlice({ ...common, getCampaignMappings: getCampaignMappingsFake });
  assert.equal(withMap.ads.matchedRows, 2, "the mapping attributes the two Bebi Born campaigns -> Ads attributed");
  let spend = 0; for (const v of withMap.ads.spendByKey.values()) spend += v;
  assert.ok(Math.abs(spend - 3.72) < 1e-9, "only Bebi Born campaign spend (0.54+3.18); Nordfell's 500 is excluded (brand isolation via the mapping)");
});

await asyncTest("14. a Brand View portfolio rebuild reads only saved snapshots (zero DataDoe exports)", async () => {
  let snapshotReads = 0;
  const getSnapshot = getSnapshotWithInventory(compactSnap([{ country: "IT", brand: "Bebi Born", fbaAvailable: 1234, skuCount: 5 }]));
  const countingGetSnapshot = ({ reportKey, accountId }) => { snapshotReads += 1; return getSnapshot({ reportKey, accountId }); };
  // The portfolio build has NO DataDoe fetcher parameter, so a successful build proves
  // a normal load/refresh spends zero DataDoe exports.
  const portfolio = await buildBrandViewPortfolioSnapshot({
    accountIds: [ACCOUNT_A], brand: "Bebi Born", asOf: "2026-07-28",
    accountsById: { [ACCOUNT_A]: { name: "Bebi EU", country: "IT" } },
    getSnapshot: countingGetSnapshot, getAdsRows: fakeGetAdsRows,
  });
  assert.ok(snapshotReads > 0, "the rebuild read saved snapshots");
  assert.ok(portfolio.series.find((row) => row.c === "IT"), "the shared portfolio renders the country series from saved data");
});

/* ================================================= 3. the built snapshot shape */

const SNAPSHOT = await buildBrandViewSnapshot({
  accountId: ACCOUNT_A,
  brand: "Bebi Born",
  asOf: "2026-07-28",
  account: { name: "Bebi EU", country: "IT" },
  getSnapshot: fakeGetSnapshot,
  getAdsRows: fakeGetAdsRows,
  getCampaignMappings: getCampaignMappingsFake,
});

test("the built snapshot is compact, brand-scoped and records its own coverage", () => {
  assert.equal(SNAPSHOT.brand, "Bebi Born");
  assert.equal(SNAPSHOT.accountId, ACCOUNT_A);
  assert.equal(SNAPSHOT.coverage.salesFrom, "2025-05-01");
  assert.equal(SNAPSHOT.coverage.salesLatestDate, "2026-07-27");
  assert.equal(SNAPSHOT.coverage.inventoryScope, "country");
  // Poland holds stock but made no sales, and is present without invented sales.
  const poland = SNAPSHOT.countries.find((entry) => entry.country === "PL");
  assert.equal(poland.hasSales, false);
  assert.equal(poland.fbaAvailable, 368);
  assert.ok(!SNAPSHOT.series.some((row) => row.c === "PL"));
  // No other brand's marketplaces or figures are present.
  assert.ok(!SNAPSHOT.series.some((row) => row.s === 900));
});

await asyncTest("building a brand with no saved sales fails loudly instead of saving an empty report", async () => {
  await assert.rejects(
    () => buildBrandViewSnapshot({
      accountId: ACCOUNT_A, brand: "Brand That Does Not Sell", asOf: "2026-07-28",
      getSnapshot: fakeGetSnapshot, getAdsRows: fakeGetAdsRows,
    }),
    /records no order value/i
  );
  await assert.rejects(
    () => buildBrandViewSnapshot({
      accountId: "never-refreshed", brand: "Anything", asOf: "2026-07-28",
      getSnapshot: fakeGetSnapshot, getAdsRows: fakeGetAdsRows,
    }),
    /no saved Dashboard sales snapshot/i
  );
});

/* ================================================ 4. client model and formulas */

const MODEL = brandViewModel(SNAPSHOT);

test("the client model reproduces the per-country daily series", () => {
  const italy = MODEL.countries.find((entry) => entry.country === "IT");
  assert.equal(italy.currency, "EUR");
  assert.equal(italy.byDate.get("2026-07-27").sales, 210);
  assert.equal(MODEL.latestDate, "2026-07-27");
});

test("last-year sales appear only when the saved window fully covers them", () => {
  // Coverage starts 2025-05-01, so a 2026-07-27 day has a complete 2025-07-27.
  const complete = lastYearWindow(MODEL, "2026-07-27", "2026-07-27");
  assert.deepEqual(complete, { from: "2025-07-27", to: "2025-07-27" });
  // A window whose previous-year equivalent starts before coverage must be null.
  assert.equal(lastYearWindow(MODEL, "2026-01-01", "2026-01-31"), null);
  const rows = dailySnapshotRows(MODEL, { from: "2026-07-27", to: "2026-07-27" }).rows;
  assert.equal(rows.find((row) => row.country === "IT").lySales, 190);
  const noLy = dailySnapshotRows(MODEL, { from: "2026-01-01", to: "2026-01-31" }).rows;
  assert.ok(noLy.every((row) => row.lySales === null), "a partial last-year window must render unavailable");
});

test("29 February shifts to a real previous-year date", () => {
  assert.equal(shiftYear("2028-02-29", -1), "2027-02-28");
  assert.equal(shiftYear("2026-07-27", -1), "2025-07-27");
});

test("missing Ads data is unavailable, never zero, but a covered marketplace can be a real zero", () => {
  const rows = dailySnapshotRows(MODEL, { from: "2026-07-27", to: "2026-07-27" }).rows;
  const uk = rows.find((row) => row.country === "UK");
  const italy = rows.find((row) => row.country === "IT");
  const poland = rows.find((row) => row.country === "PL");
  assert.equal(uk.adSpend, 0.54);
  // Italy has saved ad rows but none for this brand -> a genuine 0.
  assert.equal(italy.adSpend, 0);
  // Poland has no saved ad rows at all -> unavailable.
  assert.equal(poland.adSpend, null);
  assert.equal(tacos(null, 100), null, "TACoS must be unavailable when spend is unavailable");
  assert.equal(tacos(0, 100), 0);
  assert.equal(tacos(5, 0), null, "TACoS has no meaning without a sales base");
});

test("ad spend is unavailable for a range the saved Ads window does not fully cover", () => {
  const uk = MODEL.countries.find((entry) => entry.country === "UK");
  assert.equal(typeof rangeAdSpend(MODEL, uk, "2026-07-26", "2026-07-27"), "number");
  // The saved rows begin on 26 July. A seven-day total must not present the
  // two saved days as a complete week of zero spend before that.
  assert.equal(rangeAdSpend(MODEL, uk, "2026-07-21", "2026-07-27"), null);
  assert.equal(rangeAdSpend(MODEL, uk, "2025-06-01", "2026-07-27"), null);
});

test("country-specific Ads coverage refuses a partially seeded month", () => {
  const uk = MODEL.countries.find((entry) => entry.country === "UK");
  const partial = brandViewModel({
    ...SNAPSHOT,
    coverage: {
      ...SNAPSHOT.coverage,
      adsCoverageByCountry: { UK: { from: "2026-07-26", to: "2026-07-27" } },
    },
  });
  assert.equal(rangeAdSpend(partial, uk, "2026-07-01", "2026-07-27"), null);
  assert.equal(typeof rangeAdSpend(partial, uk, "2026-07-26", "2026-07-27"), "number");
});

test("missing FBA inventory renders unavailable rather than zero", () => {
  const rows = dailySnapshotRows(MODEL, { from: "2026-07-27", to: "2026-07-27" }).rows;
  assert.equal(rows.find((row) => row.country === "IT").fbaAvailable, 883);
  const noInventory = brandViewModel({
    ...SNAPSHOT,
    countries: SNAPSHOT.countries.map((entry) => ({ ...entry, fbaAvailable: null })),
  });
  const bare = dailySnapshotRows(noInventory, { from: "2026-07-27", to: "2026-07-27" }).rows;
  assert.ok(bare.every((row) => row.fbaAvailable === null));
  assert.ok(bare.every((row) => row.coverDays === null));
});

test("inventory cover divides available units by the selected-range daily run rate", () => {
  // 883 available, 34 MTD units over 27 elapsed days -> 883 / (34/27) days.
  assert.equal(inventoryCoverDays(883, 34, 27), 883 / (34 / 27));
  assert.equal(inventoryCoverDays(883, 0, 27), null, "a zero run rate has no cover, not infinite cover");
  assert.equal(inventoryCoverDays(null, 34, 27), null);
  assert.equal(inventoryCoverDays(883, 34, 0), null);
});

test("the Daily Snapshot cover uses the selected date range, not a cross-month MTD pace", () => {
  const daily = dailySnapshotRows(MODEL, { from: "2026-07-26", to: "2026-07-27" });
  const italy = daily.rows.find((row) => row.country === "IT");
  assert.equal(daily.selectedRangeDays, 2);
  assert.equal(italy.coverDays, 883 / (italy.coverUnits / 2));
});

test("the current-month run rate is actual / elapsed days x days in month", () => {
  const monthly = monthlySnapshotRows(MODEL, "2026-07-27");
  assert.equal(monthly.columns.completed.length, 5);
  assert.equal(monthly.columns.completed[0].key, monthBack("2026-07-27", 5).key);
  assert.equal(monthly.columns.current.elapsedDays, 27);
  assert.equal(monthly.columns.current.daysInMonth, 31);
  const italy = monthly.rows.find((row) => row.country === "IT");
  assert.equal(italy.currentActual, 340); // 210 + 130
  assert.equal(italy.runRate, (340 / 27) * 31);
});

test("monthly and 7-day tables honour their supplied report anchor", () => {
  const monthly = monthlySnapshotRows(MODEL, "2026-06-30");
  assert.equal(monthly.columns.current.key, "2026-06");
  const weekly = sevenDayRows(MODEL, "2026-07-27");
  assert.equal(weekly.dates.length, 7);
  assert.equal(weekly.dates[0], "2026-07-21");
  assert.equal(weekly.dates[6], "2026-07-27");
  const italy = weekly.rows.find((row) => row.country === "IT");
  assert.equal(italy.byDate["2026-07-27"].units, 21);
  assert.equal(italy.byDate["2026-07-25"].units, 0);
});

/* ============================================== 5. the currency system */

const RATES = { USD: 1, EUR: 0.866698, GBP: 0.741656, INR: 95.48025, JPY: 158.015481, AED: 3.6725, CAD: 1.401293, AUD: 1.420321 };

test("the currency selector offers Original plus the eight display currencies", () => {
  assert.equal(CURRENCY_OPTIONS[0].value, ORIGINAL_CURRENCY);
  const offered = CURRENCY_OPTIONS.slice(1).map((option) => option.value);
  assert.deepEqual(offered.sort(), [...FX_DISPLAY_CURRENCIES].sort());
  assert.equal(isConvertedMode(ORIGINAL_CURRENCY), false);
  assert.equal(isConvertedMode("USD"), true);
});

test("cross-rate conversion goes through the base and is reversible", () => {
  assert.equal(convertMoney(100, "EUR", "EUR", RATES), 100);
  const usd = convertMoney(100, "EUR", "USD", RATES);
  assert.ok(Math.abs(usd - 100 / 0.866698) < 1e-9);
  const gbp = convertMoney(100, "EUR", "GBP", RATES);
  assert.ok(Math.abs(gbp - (100 / 0.866698) * 0.741656) < 1e-9);
  // Round-tripping must return the original value at full internal precision.
  assert.ok(Math.abs(convertMoney(gbp, "GBP", "EUR", RATES) - 100) < 1e-9);
});

test("a currency with no rate is unavailable, never a substituted static rate", () => {
  assert.equal(convertMoney(100, "PLN", "USD", RATES), null);
  assert.equal(convertMoney(100, "USD", "PLN", RATES), null);
  assert.equal(convertMoney(null, "EUR", "USD", RATES), null);
  assert.equal(convertMoney(100, "EUR", "USD", { EUR: 0 }), null);
  assert.deepEqual(unconvertibleCurrencies(["EUR", "GBP", "PLN"], "USD", RATES), ["PLN"]);
  assert.deepEqual(unconvertibleCurrencies(["EUR", "PLN"], ORIGINAL_CURRENCY, RATES), []);
});

test("Original marketplace currency mode groups by currency and never combines them", () => {
  const rows = dailySnapshotRows(MODEL, { from: "2026-07-27", to: "2026-07-27" }).rows;
  const groups = currencyGroups(rows, ORIGINAL_CURRENCY, RATES, ["sales", "lySales", "adSpend"]);
  const currencies = groups.map((group) => group.currency).sort();
  // EUR (Italy), GBP (UK) and the Poland row whose currency is unknown because
  // it only holds stock. Three groups, and not one combined money total.
  assert.ok(currencies.includes("EUR") && currencies.includes("GBP"));
  assert.ok(groups.every((group) => group.converted === false));
  const eur = groups.find((group) => group.currency === "EUR");
  const gbp = groups.find((group) => group.currency === "GBP");
  assert.equal(eur.totals.sales, 210);
  assert.equal(gbp.totals.sales, 60);
  assert.ok(!groups.some((group) => group.totals.sales === 270), "EUR and GBP were summed together");
});

test("converted totals are the sum of the converted country values, exactly", () => {
  const rows = dailySnapshotRows(MODEL, { from: "2026-07-27", to: "2026-07-27" }).rows;
  const groups = currencyGroups(rows, "USD", RATES, ["sales", "lySales", "adSpend"]);
  assert.equal(groups.length, 1, "a converted report has exactly one money group");
  const group = groups[0];
  assert.equal(group.currency, "USD");
  const summed = group.rows.reduce((total, row) => total + (row.sales === null ? 0 : row.sales), 0);
  // Exact equality, not a tolerance: the total is produced by summing these very
  // values, so any drift would mean the total was computed a different way.
  assert.equal(group.totals.sales, summed);
  const expected = convertMoney(210, "EUR", "USD", RATES) + convertMoney(60, "GBP", "USD", RATES);
  assert.equal(group.totals.sales, expected);
});

test("an unconvertible row marks its group instead of quietly shrinking the total", () => {
  const rows = [
    { key: "IT", country: "IT", currency: "EUR", sales: 100, units: 1, fbaAvailable: null },
    { key: "PL", country: "PL", currency: "PLN", sales: 500, units: 2, fbaAvailable: null },
  ];
  const [group] = currencyGroups(rows, "USD", RATES, ["sales"]);
  assert.equal(group.unconvertible, true);
  assert.equal(group.rows.find((row) => row.country === "PL").sales, null);
  assert.equal(group.totals.sales, convertMoney(100, "EUR", "USD", RATES));
  // Units are counts and are never converted, so they still add up in full.
  assert.equal(group.units, 3);
});

test("unit counts and inventory units are never converted", () => {
  const rows = dailySnapshotRows(MODEL, { from: "2026-07-27", to: "2026-07-27" }).rows;
  const original = currencyGroups(rows, ORIGINAL_CURRENCY, RATES, ["sales"]);
  const usd = currencyGroups(rows, "USD", RATES, ["sales"]);
  const originalUnits = original.reduce((total, group) => total + group.units, 0);
  const usdUnits = usd.reduce((total, group) => total + group.units, 0);
  assert.equal(originalUnits, usdUnits);
  assert.equal(usdUnits, 27); // Italy 21 + UK 6
  const originalFba = original.reduce((total, group) => total + (group.fbaAvailable || 0), 0);
  const usdFba = usd.reduce((total, group) => total + (group.fbaAvailable || 0), 0);
  assert.equal(originalFba, usdFba);
});

test("a 7-day column total sums already-converted values", () => {
  const weekly = sevenDayRows(MODEL, "2026-07-27");
  const [group] = currencyGroups(weekly.rows, "USD", RATES, ["sales", "adSpend"]);
  const totals = sevenDayColumnTotals(group, weekly.dates, "USD", RATES);
  const expected = convertMoney(210, "EUR", "USD", RATES) + convertMoney(60, "GBP", "USD", RATES);
  assert.equal(totals["2026-07-27"].sales, expected);
  assert.equal(totals["2026-07-27"].units, 27);
});

test("share of total is null against a zero or unavailable base", () => {
  assert.equal(shareOf(25, 100), 0.25);
  assert.equal(shareOf(25, 0), null);
  assert.equal(shareOf(null, 100), null);
});

/* ================================== 6. FX cache, refresh interval and fallback */

test("the FX cache is only refreshed once the provider's own cycle has elapsed", () => {
  const now = "2026-08-03T12:00:00.000Z";
  // Fresh: the provider says the next table is not due yet.
  const fresh = fxCacheDecision({
    cached: { rates: { USD: 1 }, fetched_at: "2026-08-03T06:00:00.000Z", provider_next_update_at: "2026-08-04T00:26:00.000Z" },
    nowIso: now,
  });
  assert.equal(fresh.shouldFetch, false);
  assert.equal(fresh.stale, false);

  // Provider is due AND the minimum spacing has passed.
  const due = fxCacheDecision({
    cached: { rates: { USD: 1 }, fetched_at: "2026-08-02T00:30:00.000Z", provider_next_update_at: "2026-08-03T00:26:00.000Z" },
    nowIso: now,
  });
  assert.equal(due.shouldFetch, true);

  // Provider is due but the last fetch was only two hours ago: do not hammer it.
  const tooSoon = fxCacheDecision({
    cached: { rates: { USD: 1 }, fetched_at: "2026-08-03T10:00:00.000Z", provider_next_update_at: "2026-08-03T00:26:00.000Z" },
    nowIso: now,
  });
  assert.equal(tooSoon.shouldFetch, false);

  // Nothing cached: fetching is the only option.
  assert.equal(fxCacheDecision({ cached: null, nowIso: now }).shouldFetch, true);
  // Older than one provider cycle: still served, but flagged stale.
  assert.equal(fxCacheDecision({
    cached: { rates: { USD: 1 }, fetched_at: "2026-08-01T00:00:00.000Z" }, nowIso: now,
  }).stale, true);
});

test("a provider payload missing a required currency is rejected rather than half-saved", () => {
  const good = fxRatesFromProviderPayload({
    result: "success",
    base_code: "USD",
    time_last_update_utc: "Mon, 03 Aug 2026 00:02:32 +0000",
    time_next_update_utc: "Tue, 04 Aug 2026 00:26:22 +0000",
    rates: { USD: 1, EUR: 0.8667, GBP: 0.7417, INR: 95.48, CAD: 1.4013, AUD: 1.4203, JPY: 158.02, AED: 3.6725, ZZZ: "x" },
  });
  assert.equal(good.rates.AED, 3.6725);
  assert.equal(good.rates.ZZZ, undefined, "a non-numeric rate must be dropped");
  assert.equal(good.rateDate, "2026-08-03");
  assert.ok(good.providerNextUpdateAt.startsWith("2026-08-04"));

  assert.throws(() => fxRatesFromProviderPayload({ rates: { USD: 1, EUR: 0.86 } }), /missing required currencies/i);
  assert.throws(() => fxRatesFromProviderPayload({ rates: { EUR: 0.86 } }), /base currency/i);
  assert.throws(() => fxRatesFromProviderPayload({}), /no rate table/i);
});

/* ==================== 7. shared snapshot, refresh lock and FX fallback (IO) === */
//
// These drive the real server modules with a stubbed `fetch`, so the Supabase
// contract (lock -> build -> save -> release) and the FX fallback path are
// exercised end to end rather than described in a comment.

function makeRes() {
  return {
    code: null,
    body: null,
    status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function installFetchStub(handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const request = { url: String(url), method: options.method || "GET", body: options.body ? JSON.parse(options.body) : null };
    calls.push(request);
    const result = await handler(request);
    return {
      ok: result.ok !== false,
      status: result.status || (result.ok === false ? 500 : 200),
      json: async () => result.body ?? null,
      text: async () => JSON.stringify(result.body ?? null),
    };
  };
  return { calls, restore() { globalThis.fetch = original; } };
}

const { serveSharedReport } = await import("../lib/server/report-store.js");

await asyncTest("a normal read never builds: it serves the shared snapshot or reports it is missing", async () => {
  let buildCount = 0;
  const stub = installFetchStub((request) => {
    if (request.url.includes("/rest/v1/report_snapshots")) return { body: [] };
    throw new Error(`unexpected request ${request.method} ${request.url}`);
  });
  try {
    const res = makeRes();
    await serveSharedReport({
      res, refresh: false,
      reportKey: "brand-view", reportVersion: BRAND_VIEW_VERSION,
      accountId: brandViewScopeId(ACCOUNT_A, "Bebi Born"),
      params: { accountId: ACCOUNT_A, brand: "Bebi Born", asOf: "2026-07-28" },
      label: "Brand View",
      build: () => { buildCount += 1; return {}; },
    });
    assert.equal(buildCount, 0, "a read must never rebuild");
    assert.equal(res.body.snapshotMissing, true);
    assert.ok(!stub.calls.some((call) => call.url.includes("claim_report_refresh_lock")), "a read must not claim the refresh lock");
  } finally {
    stub.restore();
  }
});

await asyncTest("a refresh claims the cross-user lock, saves the shared snapshot and releases the lock", async () => {
  let buildCount = 0;
  const stub = installFetchStub((request) => {
    if (request.url.includes("claim_report_refresh_lock")) return { body: true };
    if (request.method === "POST" && request.url.includes("/rest/v1/report_snapshots")) {
      return { body: [{ id: "snap-1", source_refreshed_at: "2026-08-03T12:00:00.000Z", updated_at: "2026-08-03T12:00:00.000Z" }] };
    }
    if (request.url.includes("/rest/v1/dashboard_events")) return { body: null };
    if (request.method === "DELETE" && request.url.includes("report_refresh_locks")) return { body: null };
    if (request.url.includes("/rest/v1/report_snapshots")) return { body: [] };
    throw new Error(`unexpected request ${request.method} ${request.url}`);
  });
  try {
    const res = makeRes();
    await serveSharedReport({
      res, refresh: true,
      reportKey: "brand-view", reportVersion: BRAND_VIEW_VERSION,
      accountId: brandViewScopeId(ACCOUNT_A, "Bebi Born"),
      params: { accountId: ACCOUNT_A, brand: "Bebi Born", asOf: "2026-07-28" },
      label: "Brand View",
      build: () => { buildCount += 1; return SNAPSHOT; },
    });
    assert.equal(buildCount, 1);
    assert.equal(res.code, 200);
    assert.equal(res.body.brand, "Bebi Born");
    assert.equal(res.body.snapshot.shared, true);

    const order = stub.calls.map((call) => `${call.method} ${call.url.split("/rest/v1/")[1]?.split("?")[0]}`);
    assert.ok(order[0].includes("claim_report_refresh_lock"), "the lock must be claimed before anything else");
    assert.ok(order.some((entry) => entry === "POST report_snapshots"), "the result must be saved for every user");
    assert.ok(order[order.length - 1].includes("report_refresh_locks"), "the lock must be released at the end");

    // The saved row is keyed by the brand-scoped id, so another brand's refresh
    // cannot overwrite it.
    const saved = stub.calls.find((call) => call.method === "POST" && call.url.includes("report_snapshots"));
    assert.equal(saved.body.account_id, brandViewScopeId(ACCOUNT_A, "Bebi Born"));
    assert.equal(saved.body.params.brand, "Bebi Born");
  } finally {
    stub.restore();
  }
});

await asyncTest("a second simultaneous refresh is refused by the lock instead of duplicating the work", async () => {
  let buildCount = 0;
  const stub = installFetchStub((request) => {
    if (request.url.includes("claim_report_refresh_lock")) return { body: false };
    if (request.method === "DELETE" && request.url.includes("report_refresh_locks")) return { body: null };
    throw new Error(`unexpected request ${request.method} ${request.url}`);
  });
  try {
    const res = makeRes();
    await serveSharedReport({
      res, refresh: true,
      reportKey: "brand-view", reportVersion: BRAND_VIEW_VERSION,
      accountId: brandViewScopeId(ACCOUNT_A, "Bebi Born"),
      params: { accountId: ACCOUNT_A, brand: "Bebi Born", asOf: "2026-07-28" },
      label: "Brand View",
      build: () => { buildCount += 1; return SNAPSHOT; },
    });
    assert.equal(res.code, 409);
    assert.equal(buildCount, 0, "the second refresher must not rebuild");
  } finally {
    stub.restore();
  }
});

await asyncTest("a Brand Sales build that throws (unusable Catalog) writes ZERO snapshots and preserves the seeded last-known-good", async () => {
  // A prior valid Brand Sales snapshot is seeded; any POST would overwrite it.
  const lkgPayload = { asinBrand: { A1: "Bebi Born" }, catalogBrands: ["Bebi Born"], rows: [{ product_brand: "Bebi Born", total_sales: 500 }] };
  let seeded = {
    id: "lkg-1", report_key: "brand-sales", account_id: ACCOUNT_A, params_hash: "ph",
    params: { reportVersion: "brand-sales-shared-v1", from: "2025-05-01", to: "2026-07-27" },
    payload: lkgPayload, source_refreshed_at: "2026-07-28T00:00:00.000Z", updated_at: "2026-07-28T00:00:00.000Z",
  };
  let snapshotPosts = 0;
  const stub = installFetchStub((request) => {
    if (request.url.includes("claim_report_refresh_lock")) return { body: true };
    if (request.method === "POST" && request.url.includes("/rest/v1/report_snapshots")) {
      snapshotPosts += 1;
      seeded = { ...seeded, payload: request.body.payload }; // an overwrite, if it ever happened
      return { body: [seeded] };
    }
    if (request.method === "GET" && request.url.includes("/rest/v1/report_snapshots")) return { body: [seeded] };
    if (request.method === "DELETE" && request.url.includes("report_refresh_locks")) return { body: null };
    if (request.url.includes("/rest/v1/dashboard_events")) return { body: null };
    throw new Error(`unexpected request ${request.method} ${request.url}`);
  });
  try {
    const res = makeRes();
    // The same typed, admin-safe error buildBrandSalesPayload throws when the Product
    // Catalog has no usable brand mappings. serveSharedReport saves ONLY on build success.
    await assert.rejects(
      () => serveSharedReport({
        res, refresh: true,
        reportKey: "brand-sales", reportVersion: "brand-sales-shared-v1",
        accountId: ACCOUNT_A, params: { from: "2025-05-01", to: "2026-08-01" },
        label: "Dashboard",
        build: () => {
          const error = new Error("Product Catalog has no usable brand mappings yet. Previous saved Brand Sales data was preserved.");
          error.brandSalesUnavailable = true;
          throw error;
        },
      }),
      /no usable brand mappings/,
    );
    assert.equal(snapshotPosts, 0, "a rejected build performs ZERO snapshot writes");
    assert.deepEqual(seeded.payload, lkgPayload, "the seeded last-known-good Brand Sales snapshot is unchanged (asinBrand/catalogBrands preserved)");
    assert.ok(stub.calls.some((c) => c.method === "DELETE" && c.url.includes("report_refresh_locks")), "the refresh lock is still released for a later valid refresh");
  } finally {
    stub.restore();
  }
});

const { getFxRates } = await import("../lib/server/fx.js");

const CACHED_FX_ROW = {
  base_currency: "USD",
  rate_date: "2026-08-01",
  provider: "exchangerate-api-open",
  rates: { USD: 1, EUR: 0.8667, GBP: 0.7417, INR: 95.48, CAD: 1.4013, AUD: 1.4203, JPY: 158.02, AED: 3.6725 },
  provider_updated_at: "2026-08-01T00:02:32.000Z",
  provider_next_update_at: "2026-08-02T00:26:22.000Z",
  fetched_at: "2026-08-01T00:30:00.000Z",
};

await asyncTest("a normal FX read inside the provider cycle never contacts the provider", async () => {
  const stub = installFetchStub((request) => {
    if (request.url.includes("fx_rate_snapshots")) {
      return { body: [{ ...CACHED_FX_ROW, fetched_at: new Date(Date.now() - 3600000).toISOString(), provider_next_update_at: new Date(Date.now() + 3600000).toISOString() }] };
    }
    throw new Error(`the provider must not be called: ${request.url}`);
  });
  try {
    const rates = await getFxRates();
    assert.equal(rates.source, "cache");
    assert.equal(rates.unavailable, undefined);
    assert.equal(rates.rates.AED, 3.6725);
    assert.ok(!stub.calls.some((call) => call.url.includes("er-api.com")));
  } finally {
    stub.restore();
  }
});

await asyncTest("when the provider is unreachable the cached rates are served and flagged as a fallback", async () => {
  const stub = installFetchStub((request) => {
    if (request.url.includes("fx_rate_snapshots")) return { body: [CACHED_FX_ROW] };
    if (request.url.includes("claim_report_refresh_lock")) return { body: true };
    if (request.url.includes("er-api.com")) return { ok: false, status: 503, body: null };
    if (request.method === "DELETE" && request.url.includes("report_refresh_locks")) return { body: null };
    throw new Error(`unexpected request ${request.method} ${request.url}`);
  });
  try {
    const rates = await getFxRates({ nowIso: "2026-08-03T12:00:00.000Z" });
    assert.equal(rates.fallback, true);
    assert.equal(rates.source, "cache");
    assert.equal(rates.stale, true, "rates older than a provider cycle must be labelled stale");
    assert.match(rates.message, /could not be fetched/i);
    // The cached table is still usable, which is the point of the fallback.
    assert.equal(convertMoney(100, "EUR", "USD", rates.rates).toFixed(4), (100 / 0.8667).toFixed(4));
  } finally {
    stub.restore();
  }
});

await asyncTest("with no cached rates and an unreachable provider the answer is unavailable, not a guess", async () => {
  const stub = installFetchStub((request) => {
    if (request.url.includes("fx_rate_snapshots")) return { body: [] };
    if (request.url.includes("claim_report_refresh_lock")) return { body: true };
    if (request.url.includes("er-api.com")) return { ok: false, status: 503, body: null };
    if (request.method === "DELETE" && request.url.includes("report_refresh_locks")) return { body: null };
    throw new Error(`unexpected request ${request.method} ${request.url}`);
  });
  try {
    const rates = await getFxRates({ nowIso: "2026-08-03T12:00:00.000Z" });
    assert.equal(rates.unavailable, true);
    assert.equal(rates.rates, undefined, "no rate table may be invented");
    assert.match(rates.message, /Original marketplace currency/i);
  } finally {
    stub.restore();
  }
});

await asyncTest("a concurrent FX refresh serves the cache rather than a second provider call", async () => {
  const stub = installFetchStub((request) => {
    if (request.url.includes("fx_rate_snapshots")) return { body: [CACHED_FX_ROW] };
    if (request.url.includes("claim_report_refresh_lock")) return { body: false };
    if (request.method === "DELETE" && request.url.includes("report_refresh_locks")) return { body: null };
    throw new Error(`unexpected request ${request.method} ${request.url}`);
  });
  try {
    const rates = await getFxRates({ nowIso: "2026-08-03T12:00:00.000Z" });
    assert.equal(rates.source, "cache");
    assert.ok(!stub.calls.some((call) => call.url.includes("er-api.com")));
  } finally {
    stub.restore();
  }
});

/* ============================ 7b. the cross-account portfolio merge ========= */
//
// The portfolio report is the same three tables over more than one account. It
// must add the same marketplace together, refuse a partial ad sum, and still
// never let one account's brand appear under another.

const { brandViewPortfolioScopeId } = await import("../lib/server/reports/brand-view.js");
const { buildBrandTables } = await import("../src/lib/brand-view-tables.js");

// A second account selling the SAME brand in India, plus its own marketplace.
const ACCOUNT_C = "in-seller-2";
SNAPSHOTS[`brand-sales|${ACCOUNT_C}`] = {
  source_refreshed_at: "2026-07-28T04:00:00.000Z",
  params: { from: "2025-09-01", to: "2026-07-27" },
  payload: {
    catalogBrands: ["Bebi Born"],
    rows: [
      { date: "2026-07-27", marketplace_country_code: "IT", currency: "EUR", product_brand: "Bebi Born", total_sales: 90, total_units_sold: 9, seller_or_vendor_name: "Bebi Reseller" },
      { date: "2026-07-27", marketplace_country_code: "DE", currency: "EUR", product_brand: "Bebi Born", total_sales: 20, total_units_sold: 2 },
    ],
  },
};

const PORTFOLIO = await buildBrandViewPortfolioSnapshot({
  accountIds: [ACCOUNT_A, ACCOUNT_B, ACCOUNT_C],
  brand: "Bebi Born",
  asOf: "2026-07-28",
  accountsById: {
    [ACCOUNT_A]: { name: "Bebi EU", country: "IT" },
    [ACCOUNT_C]: { name: "Bebi Reseller", country: "IT" },
  },
  getSnapshot: fakeGetSnapshot,
  getAdsRows: fakeGetAdsRows,
});

test("the portfolio adds the same marketplace across accounts into one row", () => {
  assert.equal(PORTFOLIO.scope, "portfolio");
  const italy = PORTFOLIO.series.find((row) => row.c === "IT" && row.d === "2026-07-27");
  // 210 from Bebi EU + 90 from Bebi Reseller. Neither account's other brands.
  assert.equal(italy.s, 300);
  assert.equal(italy.u, 30);
  const italyMeta = PORTFOLIO.countries.find((entry) => entry.country === "IT");
  assert.deepEqual(italyMeta.accounts, ["Bebi EU", "Bebi Reseller"]);
  // The second account brings a marketplace of its own.
  assert.ok(PORTFOLIO.countries.some((entry) => entry.country === "DE"));
});

test("an account that does not sell the brand contributes nothing and is not an error", () => {
  // ACCOUNT_B sells only "Beeline" and was passed in scope on purpose.
  assert.ok(!PORTFOLIO.series.some((row) => row.c === "IN"), "another account's unrelated marketplace leaked in");
  assert.ok(!PORTFOLIO.accounts.some((entry) => entry.id === ACCOUNT_B));
  assert.equal(PORTFOLIO.accounts.length, 2);
  assert.ok(PORTFOLIO.notes.some((note) => /contributed nothing/i.test(note)));
});

test("no brand leakage: the portfolio never mixes in another brand's value", () => {
  // Nordfell sells 900 in IT and Beeline 41,000 in IN within the same snapshots.
  assert.ok(!PORTFOLIO.series.some((row) => row.s === 900 || row.s === 41000));
  assert.equal(PORTFOLIO.brand, "Bebi Born");
});

test("portfolio ad spend is refused when only some contributing accounts have Ads coverage", () => {
  // Italy is now sold by two accounts. Only Bebi EU has saved Ads rows there, so
  // a summed figure would be partial and would understate TACoS.
  const italy = PORTFOLIO.countries.find((entry) => entry.country === "IT");
  assert.equal(italy.adsAvailable, false);
  // The UK is sold by one account, which does have coverage, so it survives.
  const uk = PORTFOLIO.countries.find((entry) => entry.country === "UK");
  assert.equal(uk.adsAvailable, true);
  assert.ok(PORTFOLIO.notes.some((note) => /partial sum/i.test(note)));
});

test("portfolio sales coverage is the intersection, so last year is only offered when every account can answer", () => {
  // Bebi EU covers from 2025-05-01, Bebi Reseller only from 2025-09-01.
  assert.equal(PORTFOLIO.coverage.salesFrom, "2025-09-01");
  const model = brandViewModel(PORTFOLIO);
  // 2026-07-27 would need 2025-07-27, which the reseller cannot answer for.
  assert.equal(lastYearWindow(model, "2026-07-27", "2026-07-27"), null);
  const rows = dailySnapshotRows(model, { from: "2026-07-27", to: "2026-07-27" }).rows;
  assert.ok(rows.every((row) => row.lySales === null));
});

test("a lagging account is named rather than quietly dragging the latest day down", () => {
  assert.equal(PORTFOLIO.coverage.salesLatestDate, "2026-07-27");
  assert.equal(PORTFOLIO.coverage.accountCount, 2);
});

test("the portfolio snapshot key is the account set plus the brand", () => {
  const key = brandViewPortfolioScopeId([ACCOUNT_C, ACCOUNT_A], "Bebi Born");
  // Order-independent, so the same scope always hits the same saved row.
  assert.equal(key, brandViewPortfolioScopeId([ACCOUNT_A, ACCOUNT_C], "Bebi Born"));
  assert.notEqual(key, brandViewPortfolioScopeId([ACCOUNT_A], "Bebi Born"));
  assert.notEqual(key, brandViewPortfolioScopeId([ACCOUNT_A, ACCOUNT_C], "Nordfell"));
});

/* ===================== 7c. the shared tables both pages render ============== */

test("both reports build the same three tables from the same payload shape", () => {
  for (const [label, payload] of [["account", SNAPSHOT], ["portfolio", PORTFOLIO]]) {
    const model = brandViewModel(payload);
    const tables = buildBrandTables(model, {
      rangeFrom: model.latestDate,
      rangeTo: model.latestDate,
      displayCurrency: ORIGINAL_CURRENCY,
      rates: null,
    });
    assert.ok(tables.dailyTable, `${label}: no daily table`);
    assert.ok(tables.monthlyTable, `${label}: no monthly table`);
    assert.ok(tables.weeklyTable, `${label}: no weekly table`);
    assert.deepEqual(
      tables.dailyTable.headers.map((header) => header.label),
      ["Country", "Total Sales", "LY Sales", "FBA Inv.", "FBA Cover (days)", "Units"],
      `${label}: unexpected Daily Snapshot columns`
    );
    assert.ok(tables.monthlyTable.headers.some((header) => header.label === "Ad Spend"));
    assert.ok(tables.monthlyTable.headers.some((header) => header.label === "TACoS%"));
    assert.ok(tables.weeklyTable.rows.some((row) => row.label === "Ad Spend"));
    assert.ok(tables.weeklyTable.rows.some((row) => row.label === "TACoS%"));
    // A group gets an All Markets row when it actually aggregates more than one
    // marketplace, or when it is the only group and the report needs its top
    // line. A lone marketplace in its own currency is not printed twice.
    const totals = tables.dailyTable.rows.filter((row) => row.kind === "total");
    const expectedTotals = tables.dailyGroups
      .filter((group) => group.rows.length > 1 || tables.dailyGroups.length === 1).length;
    assert.equal(totals.length, expectedTotals, `${label}: unexpected number of All Markets rows`);
    assert.ok(totals.every((row) => row.label === "All Markets"));
    // The 7-Day report keeps its Units by country section.
    assert.ok(tables.weeklyTable.rows.some((row) => row.kind === "section" && row.cells[0].t === "Units by country"));
  }
});

test("the portfolio table names the accounts behind a shared marketplace", () => {
  const model = brandViewModel(PORTFOLIO);
  const tables = buildBrandTables(model, {
    rangeFrom: "2026-07-27", rangeTo: "2026-07-27",
    displayCurrency: ORIGINAL_CURRENCY, rates: null,
  });
  const italy = tables.dailyTable.rows.find((row) => row.label?.includes("Italy"));
  assert.ok(italy.labelTitle.includes("Bebi EU"), "the contributing accounts must be discoverable");
  assert.ok(italy.labelTitle.includes("Bebi Reseller"));
  assert.match(italy.labelTitle, /Combined from 2 accounts/);
  // Advertising metrics are intentionally absent until coverage is complete.
  assert.equal(italy.cells.length, 6);
  assert.equal(italy.cells[3].t, "883");
  // More than one currency, so every group is introduced by a currency band.
  const bands = tables.dailyTable.rows.filter((row) => row.kind === "band");
  assert.equal(bands.length, tables.dailyGroups.length);
  // The EUR group aggregates Italy and Germany, so it gets an All Markets row.
  // The GBP group is the UK alone and is not printed twice.
  const totals = tables.dailyTable.rows.filter((row) => row.kind === "total");
  assert.equal(totals.length, 1);
  const eur = tables.dailyGroups.find((group) => group.currency === "EUR");
  assert.equal(eur.rows.length, 2, "Italy and Germany share the EUR group");
});

test("a single-currency report has no currency bands and exactly one All Markets row", () => {
  // This is the shape the reference report has, and the shape every converted
  // view has: one plain table, one total row at the top.
  const model = brandViewModel(PORTFOLIO);
  const tables = buildBrandTables(model, {
    rangeFrom: "2026-07-27", rangeTo: "2026-07-27",
    displayCurrency: "USD", rates: RATES,
  });
  assert.equal(tables.dailyGroups.length, 1);
  assert.equal(tables.dailyTable.rows.filter((row) => row.kind === "band").length, 0, "a single currency needs no divider");
  assert.equal(tables.dailyTable.rows.filter((row) => row.kind === "total").length, 1);
  assert.equal(tables.dailyTable.rows[0].label, "All Markets");
  // The 7-Day report likewise collapses to one block plus the units section.
  assert.equal(tables.weeklyTable.rows.filter((row) => row.kind === "band").length, 0);
  assert.equal(tables.weeklyTable.rows.filter((row) => row.kind === "total").length, 1);
});

test("inventory cover reads in selected-range days and a marketplace with no FBA record says n/a", () => {
  const model = brandViewModel(SNAPSHOT);
  const tables = buildBrandTables(model, {
    rangeFrom: model.latestDate, rangeTo: model.latestDate,
    displayCurrency: ORIGINAL_CURRENCY, rates: null,
  });
  const italy = tables.dailyTable.rows.find((row) => row.label?.includes("Italy"));
  assert.match(italy.cells[4].t, /^\d+ days?$/, `expected days, got ${italy.cells[4].t}`);
  assert.match(italy.hints[4], /days of cover/, "the exact day count stays available in the tooltip");
  // Poland holds stock but never sold, so it carries the reference's "(FC only)".
  const poland = tables.dailyTable.rows.find((row) => row.label?.includes("Poland"));
  assert.match(poland.label, /\(FC only\)/);
});

test("an unavailable value reaches the table as an em dash, never a zero", () => {
  const model = brandViewModel(PORTFOLIO);
  const tables = buildBrandTables(model, {
    rangeFrom: "2026-07-27", rangeTo: "2026-07-27",
    displayCurrency: ORIGINAL_CURRENCY, rates: null,
  });
  const germany = tables.dailyTable.rows.find((row) => row.label?.includes("Germany"));
  assert.equal(germany.cells[2].t, "—", "no complete last-year window");
  // A real measured value is still a number.
  assert.ok(germany.cells[5].t !== "—");
});

/* ========================================================== 8. exports */

const EXPORT_MODEL = {
  meta: {
    accountId: ACCOUNT_A,
    accountName: "Bebi EU",
    brand: "Bebi Born",
    rangeLabel: "Jul 27, 2026",
    asOf: "2026-07-27",
    currencyLabel: "Original marketplace currency",
    currencyCode: "original",
    fxLine: "Not applicable",
    freshnessLine: "Sales snapshot saved 28 Jul 2026",
    generatedAt: "2026-08-03T12:00:00.000Z",
    limitations: ["FBA inventory is account-wide only."],
    footer: "Upriver Brand View.",
  },
  reports: [
    {
      id: "daily", title: "Daily Snapshot", subtitle: "Jul 27, 2026", sheetName: "Daily Snapshot",
      headers: ["Country", "Sales", "Units"],
      rows: [
        { kind: "total", cells: [{ t: "All Markets — EUR" }, { t: "€210", n: 210 }, { t: "21", n: 21 }] },
        { kind: "row", cells: [{ t: "=Italy" }, { t: "€210", n: 210 }, { t: "21", n: 21 }] },
        { kind: "row", cells: [{ t: "Poland" }, { t: "—" }, { t: "—" }] },
      ],
    },
    { id: "monthly", title: "Monthly Snapshot", sheetName: "Monthly Snapshot", headers: ["Country", "Jun '26"], rows: [] },
    {
      id: "weekly", title: "7-Day Performance", sheetName: "7-Day Performance", headers: ["Metric", "27 Jul"],
      rows: [{ kind: "section", cells: [{ t: "Units by country" }] }],
    },
  ],
};

test("every export carries the account, brand, range, currency mode and FX status", () => {
  const labels = metaLines(EXPORT_MODEL.meta).map(([label]) => label);
  for (const required of ["Account", "Brand", "Report range", "Currency display", "Exchange rates", "Source freshness"]) {
    assert.ok(labels.includes(required), `export provenance is missing "${required}"`);
  }
  const csv = brandViewCsv(EXPORT_MODEL);
  assert.equal(csv.charCodeAt(0), 0xfeff, "the CSV must start with a UTF-8 BOM so Excel reads € and ₹");
  assert.ok(csv.includes("Bebi Born"));
  assert.ok(csv.includes("€210"), "the CSV must keep the currency symbol");
  for (const report of EXPORT_MODEL.reports) assert.ok(csv.includes(`REPORT: ${report.title}`), `${report.title} is missing from the CSV`);
  assert.ok(csv.includes("Units by country"), "the 7-day section label must survive the export");
});

test("exports neutralise spreadsheet formula injection in both CSV and XLSX", () => {
  const csv = brandViewCsv(EXPORT_MODEL);
  assert.ok(csv.includes(`"'=Italy"`), "a leading = must be escaped in CSV");
  const sheets = brandViewXlsxSheets(EXPORT_MODEL);
  const bytes = buildXlsx(sheets, { modified: new Date(Date.UTC(2026, 7, 3)) });
  const text = Buffer.from(bytes).toString("latin1");
  assert.ok(text.includes("&apos;=Italy"), "a leading = must be escaped in the worksheet XML");
  assert.equal(sanitizeCell("=cmd|'/c calc'!A1"), "'=cmd|'/c calc'!A1");
  assert.equal(sanitizeCell("+1"), "'+1");
  assert.equal(sanitizeCell("-1"), "'-1");
  assert.equal(sanitizeCell("@x"), "'@x");
  assert.equal(sanitizeCell("Bebi Born"), "Bebi Born");
});

test("the workbook has one sheet per report plus the provenance sheet", () => {
  const sheets = brandViewXlsxSheets(EXPORT_MODEL);
  assert.deepEqual(sheets.map((sheet) => sheet.name), ["Report info", "Daily Snapshot", "Monthly Snapshot", "7-Day Performance"]);
  // Money is a real number in Excel so it can be summed, while an unavailable
  // value stays an em dash rather than becoming a misleading zero.
  const daily = sheets[1];
  const italyRow = daily.rows.find((row) => String(row[0]).includes("Italy"));
  assert.equal(italyRow[1], 210);
  const polandRow = daily.rows.find((row) => String(row[0]).includes("Poland"));
  assert.equal(polandRow[1], "—");
});

test("the generated workbook is a valid, deterministic ZIP container", () => {
  const options = { modified: new Date(Date.UTC(2026, 7, 3)) };
  const first = buildXlsx(brandViewXlsxSheets(EXPORT_MODEL), options);
  const second = buildXlsx(brandViewXlsxSheets(EXPORT_MODEL), options);
  assert.deepEqual(Buffer.from(first), Buffer.from(second), "the same model must produce identical bytes");
  // Local file header, and the end-of-central-directory record at the tail.
  assert.deepEqual([...first.slice(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
  const tail = Buffer.from(first.slice(-22));
  assert.equal(tail.readUInt32LE(0), 0x06054b50);
  assert.equal(tail.readUInt16LE(10), 8, "four package parts, the provenance sheet and three report sheets");
  const text = Buffer.from(first).toString("latin1");
  assert.ok(text.includes("[Content_Types].xml") && text.includes("xl/worksheets/sheet3.xml"));
});

test("CRC-32 matches the reference value, so the ZIP checksums are trustworthy", () => {
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
  assert.equal(crc32(new TextEncoder().encode("")), 0);
});

test("sheet names and column references stay inside Excel's limits", () => {
  assert.equal(safeSheetName("Daily Snapshot"), "Daily Snapshot");
  assert.equal(safeSheetName("a/b:c*d?e[f]g"), "a b c d e f g");
  assert.ok(safeSheetName("x".repeat(60)).length <= 31);
  assert.equal(columnLetter(0), "A");
  assert.equal(columnLetter(26), "AA");
});

test("an export filename records the account, brand, currency mode and as-of date", () => {
  assert.equal(
    exportFilename(EXPORT_MODEL.meta, "xlsx"),
    "brand-view-bebi-eu-bebi-born-original-2026-07-27.xlsx"
  );
});

// ---- Portfolio MEMBERSHIP follows brand-sales only; the catalog supplies the selector list (Bebi Born fix) ----
const {
  buildBrandAccountMembership, membershipBrandsForAccount, selectorBrandsForAccount, accountsForBrand,
  normalizeBrandName, brandKey, brandDisplay, serialiseBrandAccountMembership, membershipFingerprint,
} = await import("../lib/server/reports/brand-membership.js");

const keysOf = (entries) => entries.map((e) => e.key).sort();
const displaysOf = (entries) => entries.map((e) => e.display).sort();

test("membership is brand-sales ONLY (a catalog-only brand pins no account); the SELECTOR unions a complete catalog + brand-sales", () => {
  // MEMBERSHIP: only brand-sales counts. A complete catalog listing 'Catalog Only' does NOT make the account a member.
  assert.deepEqual(keysOf(membershipBrandsForAccount(["Bebi Born", "Sibling Brand"])), ["bebi born", "sibling brand"]);
  assert.deepEqual(displaysOf(membershipBrandsForAccount(["Bebi Born", "Sibling Brand"])), ["Bebi Born", "Sibling Brand"]);
  assert.deepEqual(membershipBrandsForAccount([]), [], "no brand-sales -> no membership (a catalog-only US-style account is excluded)");
  // SELECTOR: a complete catalog contributes its zero-sale brands, unioned with brand-sales; never replaces.
  const sel = keysOf(selectorBrandsForAccount({ catalogStatus: "complete", catalogBrands: ["Catalog Only", "Bebi Born"], salesBrands: ["Bebi Born"] }));
  assert.ok(sel.includes("catalog only") && sel.includes("bebi born"), "selector = catalog UNION sales");
  // A non-complete catalog contributes nothing to the selector beyond brand-sales.
  assert.deepEqual(displaysOf(selectorBrandsForAccount({ catalogStatus: "unavailable", catalogBrands: ["Ignore"], salesBrands: ["Bebi Born"] })), ["Bebi Born"]);
  // Display normalization trims + collapses interior whitespace, ORIGINAL case preserved.
  assert.equal(normalizeBrandName("  Bebi   Born "), "Bebi Born");
  assert.equal(normalizeBrandName("   "), null);
});

test("(regression 11) canonical brandKey merges case/whitespace variants but keeps punctuation-distinct brands separate", () => {
  // Case + interior-whitespace variants map to ONE canonical key (same brand).
  assert.equal(brandKey("Bebi Born"), "bebi born");
  assert.equal(brandKey("  bebi   BORN "), "bebi born");
  assert.equal(brandKey("BEBI BORN"), brandKey("Bebi Born"));
  // Punctuation is PRESERVED -> punctuation-distinct brands are DIFFERENT (no fuzzy merge).
  assert.notEqual(brandKey("Bebi-Born"), brandKey("Bebi Born"));
  assert.notEqual(brandKey("Bebi Born"), brandKey("Bebi Bornn"));
  // A stable human-readable display is preserved and is deterministic (lexicographically-smallest variant).
  const merged = buildBrandAccountMembership([
    { accountId: "a1", salesBrands: ["Bebi Born"] },
    { accountId: "a2", salesBrands: ["bebi born"] },   // same brand, different case
    { accountId: "a3", salesBrands: ["Bebi-Born"] },   // DIFFERENT brand (punctuation)
  ]);
  assert.deepEqual(accountsForBrand(merged, "BEBI  BORN"), ["a1", "a2"], "case/whitespace variants aggregate to ONE brand");
  assert.deepEqual(accountsForBrand(merged, "Bebi-Born"), ["a3"], "the punctuation-distinct brand stays separate");
  assert.equal(merged.get("bebi born").display, "Bebi Born", "stable display preserved (not lowercased)");
});

test("(regression 8) storage-authoritative + directory serialisation: brandAccounts is keyed by canonical key with a display map", () => {
  const membership = buildBrandAccountMembership([
    { accountId: "acct-DE", salesBrands: ["Bebi Born"] },
    { accountId: "acct-IT", salesBrands: ["bebi born", "Nordfell"] },
  ]);
  const dir = serialiseBrandAccountMembership(membership, [{ key: "catalog only", display: "Catalog Only" }]);
  assert.deepEqual(dir.brandAccounts["bebi born"], ["acct-DE", "acct-IT"], "canonical-key membership aggregates the case variant");
  assert.deepEqual(dir.brandAccounts["catalog only"], [], "selector-only brand is selectable with an EMPTY account set");
  assert.equal(dir.brandDisplay["bebi born"], "Bebi Born");
  assert.ok(dir.brands.includes("Bebi Born") && dir.brands.includes("Catalog Only"), "the dropdown list carries display labels");
});

test("(regression 5/6) membership fingerprint flips iff the latest brand-sales identity changes", () => {
  const base = [{ accountId: "a1", updatedAt: "2026-08-24T00:00:00Z" }, { accountId: "a2", updatedAt: "2026-08-24T00:00:00Z" }];
  assert.equal(membershipFingerprint(base), membershipFingerprint([...base].reverse()), "order-independent (deterministic)");
  const changed = [{ accountId: "a1", updatedAt: "2026-08-25T00:00:00Z" }, { accountId: "a2", updatedAt: "2026-08-24T00:00:00Z" }];
  assert.notEqual(membershipFingerprint(base), membershipFingerprint(changed), "a new brand-sales publication flips the fingerprint");
  const added = [...base, { accountId: "a3", updatedAt: "2026-08-24T00:00:00Z" }];
  assert.notEqual(membershipFingerprint(base), membershipFingerprint(added), "an account gaining brand-sales flips the fingerprint");
});

test("REGRESSION: Bebi Born resolves to EXACTLY the 8 expected countries from brand-sales -- includes IT/ES/UK (sales, stale/absent catalog), EXCLUDES US (catalog-only, no sales)", () => {
  const EXPECTED = ["BE", "DE", "ES", "FR", "IT", "NL", "PL", "UK"];
  // Production-shaped: every expected country has Bebi Born in its latest brand-sales. IT/ES have an UNAVAILABLE
  // catalog; UK a COMPLETE catalog that omits Bebi Born; the rest complete-with-it -- all still members via sales.
  const perAccount = [
    { accountId: "acct-BE", salesBrands: ["Bebi Born", "Sibling Brand"] },
    { accountId: "acct-DE", salesBrands: ["Bebi Born"] },
    { accountId: "acct-ES", salesBrands: ["Bebi Born"] },
    { accountId: "acct-FR", salesBrands: ["Bebi Born"] },
    { accountId: "acct-IT", salesBrands: ["Bebi Born"] },
    { accountId: "acct-NL", salesBrands: ["Bebi Born"] },
    { accountId: "acct-PL", salesBrands: ["Bebi Born"] },
    { accountId: "acct-UK", salesBrands: ["Bebi Born"] },
    // US: its (org-wide, complete) catalog lists Bebi Born but it has NO Bebi Born SALES -> NOT a member.
    { accountId: "acct-US", salesBrands: ["Sibling Brand"] },
    // A never-sells-Bebi-Born account -> no leakage.
    { accountId: "acct-ZZ", salesBrands: ["Sibling Brand"] },
  ];
  const membership = buildBrandAccountMembership(perAccount);
  const bebiAccounts = accountsForBrand(membership, "Bebi Born");
  const countries = bebiAccounts.map((a) => a.replace(/^acct-/, "")).sort();
  assert.deepEqual(countries, EXPECTED, "Bebi Born resolves to EXACTLY BE,DE,ES,FR,IT,NL,PL,UK");
  assert.ok(!bebiAccounts.includes("acct-US"), "US (catalog-only, no Bebi Born sales) is EXCLUDED");
  assert.ok(!bebiAccounts.includes("acct-ZZ"), "an account that never sold Bebi Born is not a member (no leakage)");
});

await asyncTest("(regression 8) storage-first hydration recovers an out-of-line brand-sales payload; usable inline is served without a wasted fetch", async () => {
  const { getLatestReportSnapshotHydrated, inlinePayloadUsable } = await import("../lib/server/supabase.js");
  // (a) inline null + a storage path -> hydrate; the recovered payload is usable so the account is NOT dropped.
  let reads1 = 0;
  const recovered = await getLatestReportSnapshotHydrated({ reportKey: "brand-sales", accountId: "acct-IT" }, {
    readLatest: async () => ({ payload: null, payload_storage_path: "cache/it.json", updated_at: "t" }),
    readStorage: async () => { reads1 += 1; return { catalogBrands: ["Bebi Born"], rows: [{ product_brand: "Bebi Born" }] }; },
  });
  assert.equal(reads1, 1, "out-of-line payload hydrated from storage");
  assert.ok(inlinePayloadUsable(recovered.payload), "recovered payload is usable -> account NOT dropped");
  // (b) an EMPTY inline stub also hydrates (never served as a dropout).
  let reads2 = 0;
  await getLatestReportSnapshotHydrated({ reportKey: "brand-sales", accountId: "acct-ES" }, {
    readLatest: async () => ({ payload: { catalogBrands: [], rows: [] }, payload_storage_path: "cache/es.json" }),
    readStorage: async () => { reads2 += 1; return { rows: [{ product_brand: "Bebi Born" }] }; },
  });
  assert.equal(reads2, 1, "an empty inline stub hydrates from storage");
  // (c) a USABLE inline payload is authoritative -> NO storage read.
  let reads3 = 0;
  await getLatestReportSnapshotHydrated({ reportKey: "brand-sales", accountId: "acct-DE" }, {
    readLatest: async () => ({ payload: { rows: [{ product_brand: "Bebi Born" }] }, payload_storage_path: "cache/de.json" }),
    readStorage: async () => { reads3 += 1; return { rows: [] }; },
  });
  assert.equal(reads3, 0, "a usable inline payload is served without hydrating storage");
});

console.log(`\n${passed} assertions passed${process.exitCode ? " (with failures above)" : ""}`);
