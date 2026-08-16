// PPC Performance Scheduler-v2 derivation + persisted-Ads loader + real-cycle tests (SHADOW MODE, offline).
//
// Part A drives deriveReportSnapshot("ppc-performance") against a hand-computed production-route fixture and
// proves payload parity, currency isolation, coverage labels, the TACoS states, catalog gating, and purity.
// Part B tests the typed persisted-Ads loader (validation, availability, the 120k cap, empty-vs-missing).
// Part C drives the REAL runPpcShadowCycle + runReportJobs (via makePpcAdsContextLoader) and proves ZERO
// DataDoe Ads exports, the conditional canonical OLI total-sales slices, catalog dedup, the ads-currency gate, LKG, and
// resume.

import assert from "node:assert/strict";
import { writeSync } from "node:fs";

process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://supabase.test";
const SB_KEY_ENV = ["SUPABASE", "SERVICE", "ROLE", "KEY"].join("_");
process.env[SB_KEY_ENV] = process.env[SB_KEY_ENV] || ["test", "svc", "role", "key"].join("-");

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const group = (label) => tests.push({ marker: label });
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };

let assembleSources, deriveReportSnapshot, runReportJobs, runSourceJobs, plannedSourceJob, sourceJobOwnerId;
let planPpcPerformance, planSalesMovers, buildShadowReportPlan, SHADOW_PLANNED_REPORT_KEYS, addDaysStr, canonicalOliSlices;
let runPpcShadowCycle, loadPersistedPpcAds, validatePpcAdsRows, ppcAdsCurrencySignalOf, makePpcAdsContextLoader;
let validatePpcSourceCoverage, evaluateSourceCoverage;
let ppcPerformancePayload, normalizePpcCoverageReason, PPC_COVERAGE_REASON_CODES;

const ID = "A1";
const ASOF = "2025-08-10";
const dash = (...p) => p.join("-");
const CONNS = [
  { id: "primary", apiKey: dash("prim", "key"), accountPrefix: "" },
  { id: "secondary", apiKey: dash("sec", "key"), accountPrefix: dash("dd", "secondary") + ":" },
];
const ORIGIN = "Persisted Supabase Amazon Ads history maintained by the scheduled worker";
const TS_LABEL = "Order Line Items";
const MULTI_CCY = "TACoS is unavailable because this account's saved Ads rows use multiple currencies. A combined total-sales denominator would be meaningless.";
const DEGRADED = "TACoS is unavailable because the account total-sales export for the denominator did not complete this cycle; every other PPC figure is still current.";
const DRIVER_CONNECTION_ID = { primary: "primary", secondary: "dd-secondary" };
const KEYS = { campaign: "campaign-performance-v1", asin: "asin-performance-v1", targeting: "keyword-targeting-performance-v1", search: "search-terms-performance-v1" };

let FROM; // asOf-29d

let hashSeq = 0;
const frag = (requestKey, from, to, ids = [ID]) => ({ requestKey, requestHash: "h" + (hashSeq += 1), from, to, sellerOrVendorIds: ids });

function buildSources(planned, rowsByHash, statusOverride = {}) {
  const statusByHash = {}; const loaded = new Map();
  for (const p of planned) {
    const st = statusOverride[p.requestHash] || "succeeded";
    statusByHash[p.requestHash] = st;
    if (st === "succeeded") loaded.set(p.requestHash, { rows: Object.prototype.hasOwnProperty.call(rowsByHash, p.requestHash) ? rowsByHash[p.requestHash] : [] });
  }
  return assembleSources(planned, statusByHash, loaded).sources;
}

// Build the PPC source fragments: no-date catalog (required) + the OPTIONAL canonical Order Line Items
// total-sales denominator (ppc-performance:oli-sales), sliced by canonicalOliSlices(FROM, ASOF) into one
// ordered single-account fragment per calendar-anchored slice, with every row bound to its own slice window
// (exactly as the derive re-validates via slicedFragmentRows). A row outside every slice is appended to the
// LAST fragment so the derive's window guard rejects it (degrading ONLY TACoS, never the report). `tsHash`
// is the FIRST oli-sales fragment hash: failing it makes the whole sliced source unavailable => TACoS degrades.
function ppcPlanned({ catalog = [], totalSales = [], includeTotalSales = true, ids = [ID] } = {}) {
  const planned = []; const rows = {};
  const cat = frag("ppc-performance:catalog", null, null, ids); planned.push(cat); rows[cat.requestHash] = catalog;
  let tsHash = null;
  if (includeTotalSales) {
    const slices = canonicalOliSlices(FROM, ASOF);
    const perSlice = slices.map(() => []);
    for (const row of totalSales) {
      let idx = slices.findIndex((s) => row.date >= s.from && row.date <= s.to);
      if (idx === -1) idx = slices.length - 1; // out-of-window row => last slice => derive window guard rejects it
      perSlice[idx].push(row);
    }
    slices.forEach((slice, i) => {
      const f = frag("ppc-performance:oli-sales", slice.from, slice.to, ids);
      planned.push(f); rows[f.requestHash] = perSlice[i];
      if (i === 0) tsHash = f.requestHash;
    });
  }
  return { planned, rows, tsHash };
}
const ppcCtx = (ppcAds, over = {}) => ({ to: ASOF, rawSellerId: ID, accountId: ID, ppcAds, ...over });
const derivePpc = (built, ppcAds, over, statusOverride) =>
  deriveReportSnapshot({ reportKey: "ppc-performance", sources: buildSources(built.planned, built.rows, statusOverride), context: ppcCtx(ppcAds, over) });

// ---- row builders ---- (every persisted row carries the AUTHORITATIVE public account_id, exactly as the
// scheduled worker stamps it via publicAccountId(); the PPC loader proves row-level account isolation on it)
const cmp = (date, id, type, m, dims = {}) => ({ account_id: ID, source_key: KEYS.campaign, metric_date: date, campaign_id: id, campaign_type: type, currency: m.currency || "USD", dimensions: dims, metrics: { ad_spend: m.spend, ad_sales: m.sales, ad_clicks: m.clicks, ad_impressions: m.impr, ad_orders: m.orders, ad_units_sold: m.units } });
const asn = (date, asin, currency, m, dims = {}) => ({ account_id: ID, source_key: KEYS.asin, metric_date: date, child_asin: asin, currency, dimensions: dims, metrics: { ad_spend: m.spend, ad_sales_same_sku: m.sales, ad_clicks: m.clicks, ad_impressions: m.impr, ad_orders_same_sku: m.orders, ad_units_sold_same_sku: m.units } });
const tgt = (date, id, campaignId, type, currency, m, dims = {}) => ({ account_id: ID, source_key: KEYS.targeting, metric_date: date, targeting_id: id, campaign_id: campaignId, campaign_type: type, currency, dimensions: dims, metrics: { ad_spend: m.spend, ad_sales: m.sales, ad_clicks: m.clicks, ad_impressions: m.impr, ad_orders: m.orders, ad_units_sold_click: m.units } });
const stm = (date, campaignId, type, currency, m, dims = {}) => ({ account_id: ID, source_key: KEYS.search, metric_date: date, campaign_id: campaignId, campaign_type: type, currency, dimensions: dims, metrics: { ad_spend: m.spend, ad_sales: m.sales, ad_clicks: m.clicks, ad_impressions: m.impr, ad_orders: m.orders, ad_units_sold_click: m.units } });
const cat = (asin, parent, name, brand) => ({ child_asin: asin, parent_asin: parent, product_name: name, product_brand: brand });
// One canonical Order Line Items total-sales row: grouped by [date, seller_or_vendor_id, sku, child_asin,
// item_price_currency] with the item_price_value->total_sales_sum / quantity->total_units_sum aggregations.
// The currency is UPPERCASE-canonical and (by default) equal to the single USD Ads currency so the TACoS
// gate sums it; pass a different/blank currency to exercise the mismatch path.
const ts = (date, sales, units, currency = "USD") => ({ date, seller_or_vendor_id: ID, sku: "SKU-1", child_asin: "ASIN-1", item_price_currency: currency, total_sales_sum: sales, total_units_sum: units });
const sync = (key, o = {}) => ({ account_id: ID, source_key: key, initial_seeded_at: o.seeded ?? "2025-07-01T00:00:00Z", last_daily_sync_at: o.daily ?? "2025-08-10T00:00:00Z", last_monthly_sync_at: null, latest_metric_date: o.latest ?? "2025-08-02", last_status: o.status ?? "ok", last_error: o.error ?? null });

// ---- hand-computed fixture ----
const SYNCS = [sync(KEYS.campaign), sync(KEYS.asin), sync(KEYS.targeting, { seeded: "2025-07-05T00:00:00Z" }), sync(KEYS.search, { seeded: null, status: "missing", latest: null })];
const ADS_ROWS = () => [
  cmp("2025-08-01", "C1", "SP", { spend: 10, sales: 40, clicks: 100, impr: 1000, orders: 5, units: 6 }, { ad_campaign_name: "Camp 1", ad_campaign_status: "ENABLED", ad_portfolio_name: "Port A", ad_campaign_budget_amount: 50, ad_campaign_budget_type: "DAILY" }),
  cmp("2025-08-02", "C1", "SP", { spend: 5, sales: 20, clicks: 50, impr: 500, orders: 2, units: 3 }, { ad_campaign_name: "Camp 1", ad_campaign_status: "ENABLED", ad_portfolio_name: "Port A", ad_campaign_budget_amount: 50, ad_campaign_budget_type: "DAILY" }),
  cmp("2025-08-01", "C2", "SB", { spend: 8, sales: 0, clicks: 20, impr: 200, orders: 0, units: 0 }, { ad_campaign_name: "Camp 2", ad_campaign_status: "PAUSED" }),
  asn("2025-08-01", "ASIN-1", "USD", { spend: 6, sales: 30, clicks: 40, impr: 400, orders: 3, units: 4 }, { sku: "SKU-1", product_name: "Ads Product 1" }),
  asn("2025-08-02", "ASIN-2", "USD", { spend: 3, sales: 10, clicks: 15, impr: 150, orders: 1, units: 1 }, { sku: "SKU-2" }),
  tgt("2025-08-01", "T1", "C1", "SP", "USD", { spend: 4, sales: 12, clicks: 20, impr: 250, orders: 1, units: 1 }, { ad_targeting_text: "running shoes", ad_match_type: "BROAD", ad_keyword_status: "ENABLED", ad_campaign_name: "Camp 1", ad_group_name: "AG1", ad_group_id: "G1" }),
  stm("2025-08-01", "C1", "SP", "USD", { spend: 2, sales: 6, clicks: 10, impr: 120, orders: 1, units: 1 }, { ad_search_term: "buy running shoes", ad_keyword: "running shoes", ad_match_type: "BROAD", ad_campaign_name: "Camp 1", ad_group_name: "AG1", ad_group_id: "G1" }),
];
const CATALOG = () => [cat("ASIN-1", "P1", "Catalog 1", "Acme"), cat("ASIN-2", "P2", "Catalog 2", "Beta")];
const TOTAL_SALES = () => [ts("2025-08-01", 500, 50), ts("2025-08-02", 300, 30)];
// The typed sourceCoverage a VALIDATED context carries (the derive re-enforces validatePpcSourceCoverage on
// it): four unique keys, campaign+ASIN required+proven+folded, targeting+search optional with folded===proven.
const provenCoverage = () => [
  { sourceKey: KEYS.campaign, required: true, proven: true, reason: null, folded: true },
  { sourceKey: KEYS.asin, required: true, proven: true, reason: null, folded: true },
  { sourceKey: KEYS.targeting, required: false, proven: true, reason: null, folded: true },
  { sourceKey: KEYS.search, required: false, proven: true, reason: null, folded: true },
];
const okAds = (rows = ADS_ROWS(), syncStates = SYNCS, sourceCoverage = provenCoverage()) => ({ status: "ok", adsRows: rows, syncStates, sourceCoverage, currencies: [...new Set(rows.map((r) => r.currency).filter(Boolean))].sort(), latestMetricDate: rows.reduce((l, r) => (!l || r.metric_date > l ? r.metric_date : l), null) });

// ---- durable ads_sync_coverage states the loader gates Ads validity on ----
// A source is PROVEN only when its successful windows FULLY span [FROM, ASOF]; the loader NEVER infers
// coverage from metric-row min/max or latest_metric_date. These helpers build the injected reader's states.
const covFull = () => ({ windows: [{ from: FROM, to: ASOF }], status: "succeeded", read: "ok" });
const covState = (over = {}) => ({ windows: over.windows !== undefined ? over.windows : [{ from: FROM, to: ASOF }], status: over.status || "succeeded", read: over.read || "ok", ...(over.latestMetricDate !== undefined ? { latestMetricDate: over.latestMetricDate } : {}) });
// coverageReader(map): map[account][sourceKey] (or map[account]["*"]) -> a coverage state; no map => every
// source fully covered. An account/source absent from a provided map reads as an UNSEEDED source (no windows).
const coverageReader = (mapByAccountSource) => async (accountId, sourceKey) => {
  if (mapByAccountSource == null) return covFull();
  const perAccount = mapByAccountSource[accountId] || {};
  const state = perAccount[sourceKey] !== undefined ? perAccount[sourceKey] : perAccount["*"];
  return state !== undefined ? state : { windows: [], status: "missing", read: "ok" };
};

const expectedPayload = () => ({
  accountId: "A1", asOf: "2025-08-10",
  window: { from: FROM, to: "2025-08-10", days: 30 },
  adsSourceOrigin: ORIGIN, minClicksForWaste: 10, adsRowCount: 7, latestMetricDate: "2025-08-02",
  sourceAvailability: [
    { key: KEYS.campaign, label: "Ad Performance by Campaign & Date", coverage: "All campaign types present in the account", rows: 3, sync: SYNCS[0], defaultDataset: true, coverageProven: true, coverageFolded: true, coverageStatus: "validated", coverageUnavailableReason: null },
    { key: KEYS.asin, label: "Ad Performance by ASIN & Date", coverage: "Same-SKU attributed metrics", rows: 2, sync: SYNCS[1], defaultDataset: true, coverageProven: true, coverageFolded: true, coverageStatus: "validated", coverageUnavailableReason: null },
    { key: KEYS.targeting, label: "Keyword Targeting Performance", coverage: "SP + SB + SD", rows: 1, sync: SYNCS[2], defaultDataset: false, enableHint: "In DataDoe, open Settings > Data tables and enable Keyword Targeting Performance, then refresh this report again.", coverageProven: true, coverageFolded: true, coverageStatus: "validated", coverageUnavailableReason: null },
    { key: KEYS.search, label: "Search Term Performance (Ads)", coverage: "SP + SB only (no Sponsored Display)", rows: 1, sync: SYNCS[3], defaultDataset: false, enableHint: "In DataDoe, open Settings > Data tables and enable Search Term Performance (Ads), then refresh this report again.", coverageProven: true, coverageFolded: true, coverageStatus: "validated", coverageUnavailableReason: null },
  ],
  totalSales: 800, totalSalesUnavailable: null, totalSalesSourceLabel: TS_LABEL, totalSalesLagDays: 0,
  currencies: ["USD"],
  daily: [
    { date: "2025-08-01", currency: "USD", spend: 18, sales: 40, clicks: 120, impressions: 1200, orders: 5, units: 6 },
    { date: "2025-08-02", currency: "USD", spend: 5, sales: 20, clicks: 50, impressions: 500, orders: 2, units: 3 },
  ],
  campaigns: [
    { key: "USD|C1|SP", campaignId: "C1", campaignName: "Camp 1", campaignType: "SP", campaignStatus: "ENABLED", portfolioName: "Port A", budgetAmount: 50, budgetType: "DAILY", spend: 15, sales: 60, clicks: 150, impressions: 1500, orders: 7, units: 9, currencies: ["USD"], campaignTypes: ["SP"], activeDays: 2 },
    { key: "USD|C2|SB", campaignId: "C2", campaignName: "Camp 2", campaignType: "SB", campaignStatus: "PAUSED", portfolioName: null, budgetAmount: null, budgetType: null, spend: 8, sales: 0, clicks: 20, impressions: 200, orders: 0, units: 0, currencies: ["USD"], campaignTypes: ["SB"], activeDays: 1 },
  ],
  asins: [
    { key: "USD|ASIN-1", asin: "ASIN-1", sku: "SKU-1", productName: "Ads Product 1", spend: 6, sales: 30, clicks: 40, impressions: 400, orders: 3, units: 4, currencies: ["USD"], campaignTypes: [], activeDays: 1, brand: "Acme" },
    { key: "USD|ASIN-2", asin: "ASIN-2", sku: "SKU-2", productName: "Catalog 2", spend: 3, sales: 10, clicks: 15, impressions: 150, orders: 1, units: 1, currencies: ["USD"], campaignTypes: [], activeDays: 1, brand: "Beta" },
  ],
  targets: [
    { key: "USD|T1|C1|G1", targetText: "running shoes", matchType: "BROAD", keywordStatus: "ENABLED", campaignId: "C1", campaignName: "Camp 1", campaignType: "SP", adGroupName: "AG1", spend: 4, sales: 12, clicks: 20, impressions: 250, orders: 1, units: 1, currencies: ["USD"], campaignTypes: ["SP"], activeDays: 1 },
  ],
  searchTerms: [
    { key: "USD|buy running shoes|C1|G1", searchTerm: "buy running shoes", matchedKeyword: "running shoes", matchType: "BROAD", campaignId: "C1", campaignName: "Camp 1", campaignType: "SP", adGroupName: "AG1", spend: 2, sales: 6, clicks: 10, impressions: 120, orders: 1, units: 1, currencies: ["USD"], campaignTypes: ["SP"], activeDays: 1 },
  ],
  catalogBrands: ["Acme", "Beta"],
});

/* ============================= Part A: pure derivation parity ============================= */

group("ppc derive: exact production-route payload parity");

test("1. pure payload deep-equals the hand-computed production-route fixture", () => {
  const r = derivePpc(ppcPlanned({ catalog: CATALOG(), totalSales: TOTAL_SALES() }), okAds());
  assert.equal(r.status, "derived");
  assert.deepEqual(r.payload, expectedPayload());
});

test("2. campaigns/ASINs/targets/search terms fold with campaignTypes + activeDays coverage", () => {
  const p = derivePpc(ppcPlanned({ catalog: CATALOG(), totalSales: TOTAL_SALES() }), okAds()).payload;
  assert.deepEqual(p.campaigns.find((c) => c.campaignId === "C1").campaignTypes, ["SP"]);
  assert.equal(p.campaigns.find((c) => c.campaignId === "C1").activeDays, 2);
  assert.equal(p.targets[0].targetText, "running shoes");
  assert.equal(p.searchTerms[0].searchTerm, "buy running shoes");
});

test("3. SP/SB/SD coverage labels are exact; search terms NEVER claim Sponsored Display", () => {
  const p = derivePpc(ppcPlanned({ catalog: CATALOG(), totalSales: TOTAL_SALES() }), okAds()).payload;
  const byKey = (k) => p.sourceAvailability.find((s) => s.key === k);
  assert.equal(byKey(KEYS.targeting).coverage, "SP + SB + SD");
  assert.equal(byKey(KEYS.search).coverage, "SP + SB only (no Sponsored Display)");
  assert.ok(!byKey(KEYS.search).coverage.includes("SD"), "search-term coverage never mentions Sponsored Display (SD)");
  assert.deepEqual([byKey(KEYS.campaign).coverage, byKey(KEYS.asin).coverage], ["All campaign types present in the account", "Same-SKU attributed metrics"]);
});

test("4. campaign/ASIN/target/search-term money is currency-ISOLATED (never combined across currencies)", () => {
  const rows = ADS_ROWS();
  // A second CAD campaign row for the SAME campaign id/type must NOT merge into the USD bucket.
  rows.push(cmp("2025-08-03", "C1", "SP", { spend: 99, sales: 99, clicks: 9, impr: 9, orders: 9, units: 9, currency: "CAD" }, { ad_campaign_name: "Camp 1" }));
  const p = derivePpc(ppcPlanned({ catalog: CATALOG(), totalSales: TOTAL_SALES() }), okAds(rows)).payload;
  const c1 = p.campaigns.filter((c) => c.campaignId === "C1");
  assert.equal(c1.length, 2, "C1 keeps a separate row per currency");
  assert.deepEqual(c1.map((c) => c.currencies[0]).sort(), ["CAD", "USD"]);
  assert.equal(c1.find((c) => c.currencies[0] === "USD").sales, 60, "USD total is NOT polluted by the CAD row");
});

group("ppc derive: TACoS / total-sales states");

test("5. <=1 currency + total-sales succeeded => summed denominator", () => {
  const p = derivePpc(ppcPlanned({ catalog: CATALOG(), totalSales: TOTAL_SALES() }), okAds()).payload;
  assert.equal(p.totalSales, 800);
  assert.equal(p.totalSalesUnavailable, null);
});

test("6. MULTI-currency Ads => total-sales skipped by design; exact multi-currency reason; rest of PPC intact", () => {
  const rows = ADS_ROWS();
  rows.push(cmp("2025-08-03", "C3", "SP", { spend: 1, sales: 1, clicks: 1, impr: 1, orders: 1, units: 1, currency: "CAD" }, { ad_campaign_name: "Camp 3" }));
  // Even if a total-sales fragment were present, a >1-currency account reports it unavailable.
  const p = derivePpc(ppcPlanned({ catalog: CATALOG(), totalSales: TOTAL_SALES() }), okAds(rows)).payload;
  assert.equal(p.totalSales, null);
  assert.equal(p.totalSalesUnavailable, MULTI_CCY);
  assert.ok(p.campaigns.length >= 3, "campaigns still derived across currencies");
  assert.deepEqual(p.currencies, ["CAD", "USD"]);
});

test("6b. Blocker 2: an Ads row with a BLANK currency => TACoS unavailable (never sums a currencyless Ads row); rest of PPC intact", () => {
  // A single nonblank Ads currency (USD) PLUS an included Ads row whose currency is blank must NOT read as
  // a clean single currency: the TACoS denominator is withheld and NOTHING is summed, even though every
  // OLI total-sales row is USD. This is the adversarial case the ads-currency gate + payload guard close.
  const blankRow = { ...cmp("2025-08-03", "C4", "SP", { spend: 2, sales: 2, clicks: 2, impr: 2, orders: 1, units: 1 }, { ad_campaign_name: "Camp 4" }), currency: "" };
  const p = derivePpc(ppcPlanned({ catalog: CATALOG(), totalSales: TOTAL_SALES() }), okAds([...ADS_ROWS(), blankRow])).payload;
  assert.equal(p.totalSales, null, "a blank Ads currency blocks the TACoS denominator (never sums)");
  assert.ok(/different currency/i.test(p.totalSalesUnavailable), "typed currency-ambiguity reason");
  assert.ok(p.campaigns.length >= 2, "campaigns/rest of PPC unaffected by the TACoS withhold");
  assert.equal(p.adsRowCount, ADS_ROWS().length + 1, "the blank-currency Ads row is still counted in the report");
});

test("7. planned total-sales FAILED / MISSING => degrade ONLY TACoS; campaigns/ASINs/targets/search terms intact", () => {
  // total-sales fragment failed.
  const built = ppcPlanned({ catalog: CATALOG(), totalSales: TOTAL_SALES() });
  const r = derivePpc(built, okAds(), {}, { [built.tsHash]: "failed" });
  assert.equal(r.status, "derived", "the report still derives + saves");
  assert.equal(r.payload.totalSales, null);
  assert.equal(r.payload.totalSalesUnavailable, DEGRADED);
  assert.equal(r.payload.campaigns.length, 2, "campaigns unaffected by the TACoS degrade");
  // total-sales entirely absent from the plan (never staged) => also degraded.
  const noTs = derivePpc(ppcPlanned({ catalog: CATALOG(), includeTotalSales: false }), okAds()).payload;
  assert.equal(noTs.totalSalesUnavailable, DEGRADED);
});

test("8. a malformed / wrong-window total-sales fragment degrades ONLY TACoS (never invalid/blocked)", () => {
  const built = ppcPlanned({ catalog: CATALOG(), totalSales: [ts(addDaysStr(ASOF, 1), 10, 1)] }); // out-of-window date
  const r = derivePpc(built, okAds());
  assert.equal(r.status, "derived");
  assert.equal(r.payload.totalSalesUnavailable, DEGRADED, "out-of-window total-sales degrades TACoS, not the report");
});

group("ppc derive: Ads context + catalog gating");

test("9. Ads context unavailable (read failed/unseeded/cap) => typed unavailable, LKG preserved", () => {
  assert.equal(derivePpc(ppcPlanned({ catalog: CATALOG() }), { status: "unavailable", adsRows: [], syncStates: [] }).status, "unavailable");
  assert.equal(derivePpc(ppcPlanned({ catalog: CATALOG() }), null).status, "unavailable");
});

test("10. validated EMPTY Ads window => a valid, honestly-empty report (DISTINCT from unavailable)", () => {
  const r = derivePpc(ppcPlanned({ catalog: CATALOG(), totalSales: TOTAL_SALES() }), okAds([]));
  assert.equal(r.status, "derived", "empty Ads is a valid report, not unavailable");
  assert.deepEqual([r.payload.campaigns, r.payload.asins, r.payload.targets, r.payload.searchTerms, r.payload.daily], [[], [], [], [], []]);
  assert.equal(r.payload.adsRowCount, 0);
  assert.equal(r.payload.latestMetricDate, null, "empty Ads => latestMetricDate null");
  assert.equal(r.latestDataDate, null, "latestDataDate null for a validated empty Ads window");
  // sourceAvailability still lists the four sources (rows 0) with their sync -- empty stays distinct from missing.
  assert.equal(r.payload.sourceAvailability.length, 4);
});

test("11. catalog is REQUIRED: missing/failed catalog => unavailable, LKG preserved", () => {
  const built = ppcPlanned({ catalog: CATALOG(), totalSales: TOTAL_SALES() });
  const catHash = built.planned.find((p) => p.requestKey === "ppc-performance:catalog").requestHash;
  assert.equal(derivePpc(built, okAds(), {}, { [catHash]: "failed" }).status, "unavailable");
});

test("12. cross-account / dated catalog fragments fail closed (invalid)", () => {
  const dated = ppcPlanned({ catalog: CATALOG(), totalSales: TOTAL_SALES() });
  const ci = dated.planned.findIndex((p) => p.requestKey === "ppc-performance:catalog");
  dated.planned[ci] = { ...dated.planned[ci], from: FROM, to: ASOF };
  assert.equal(derivePpc(dated, okAds()).status, "invalid", "dated catalog => invalid");
  const cross = ppcPlanned({ catalog: CATALOG(), totalSales: TOTAL_SALES() });
  const cj = cross.planned.findIndex((p) => p.requestKey === "ppc-performance:catalog");
  cross.planned[cj] = { ...cross.planned[cj], sellerOrVendorIds: ["OTHER"] };
  assert.equal(derivePpc(cross, okAds()).status, "invalid", "cross-account catalog => invalid");
});

test("13. latestDataDate = max validated Ads metric_date (source evidence), never asOf", () => {
  const r = derivePpc(ppcPlanned({ catalog: CATALOG(), totalSales: TOTAL_SALES() }), okAds());
  assert.equal(r.latestDataDate, "2025-08-02");
  assert.notEqual(r.latestDataDate, ASOF);
});

test("14. public/raw identity: payload.accountId is the public id; catalog fragment requires the raw id", () => {
  const RAW1 = "RAW1"; const PUB1 = dash("dd", "secondary") + ":RAW1";
  const p = derivePpc(ppcPlanned({ catalog: CATALOG(), totalSales: TOTAL_SALES(), ids: [RAW1] }), okAds(), { accountId: PUB1, rawSellerId: RAW1 }).payload;
  assert.equal(p.accountId, PUB1);
  assert.notEqual(p.accountId, RAW1);
  const crossRaw = derivePpc(ppcPlanned({ catalog: CATALOG(), totalSales: TOTAL_SALES(), ids: [PUB1] }), okAds(), { accountId: PUB1, rawSellerId: RAW1 });
  assert.equal(crossRaw.status, "invalid", "a public-id-scoped catalog fragment is cross-account");
});

test("15. derivation makes ZERO network calls; 16. repeated derivation is idempotent", () => {
  const realFetch = globalThis.fetch; let hits = 0;
  globalThis.fetch = () => { hits += 1; throw new Error("network during derivation"); };
  let a, b;
  try { a = derivePpc(ppcPlanned({ catalog: CATALOG(), totalSales: TOTAL_SALES() }), okAds()).payload; b = derivePpc(ppcPlanned({ catalog: CATALOG(), totalSales: TOTAL_SALES() }), okAds()).payload; } finally { globalThis.fetch = realFetch; }
  assert.equal(hits, 0, "zero DataDoe/network calls during derivation");
  assert.deepEqual(a, b);
  assert.deepEqual(a, expectedPayload());
});

/* ============================= Part B: typed persisted-Ads loader ============================= */

group("ppc loader: typed validation + availability (empty vs missing)");

test("17. validatePpcAdsRows accepts canonical rows; rejects malformed/out-of-window/non-finite/bad-source-key", () => {
  assert.equal(validatePpcAdsRows({ rows: ADS_ROWS(), from: FROM, to: ASOF, accountId: ID }).ok, true);
  assert.equal(validatePpcAdsRows({ rows: [{ ...cmp("2099-01-01", "C1", "SP", { spend: 1, sales: 1, clicks: 1, impr: 1, orders: 1, units: 1 }) }], from: FROM, to: ASOF, accountId: ID }).ok, false, "future/out-of-window date");
  assert.equal(validatePpcAdsRows({ rows: [{ ...cmp("2025-02-30", "C1", "SP", { spend: 1, sales: 1, clicks: 1, impr: 1, orders: 1, units: 1 }) }], from: FROM, to: ASOF, accountId: ID }).ok, false, "impossible date");
  assert.equal(validatePpcAdsRows({ rows: [{ account_id: ID, source_key: "some-other-source", metric_date: "2025-08-01", metrics: {} }], from: FROM, to: ASOF, accountId: ID }).ok, false, "source_key not allowed");
  assert.equal(validatePpcAdsRows({ rows: [{ account_id: ID, source_key: KEYS.campaign, metric_date: "2025-08-01", metrics: { ad_spend: Infinity } }], from: FROM, to: ASOF, accountId: ID }).ok, false, "non-finite metric");
  assert.equal(validatePpcAdsRows({ rows: [{ account_id: ID, source_key: KEYS.campaign, metric_date: "2025-08-01", metrics: "nope" }], from: FROM, to: ASOF, accountId: ID }).ok, false, "metrics not an object");
});

test("18. loadPersistedPpcAds: validated success (rows) is status ok with sorted currencies + latest metric date", async () => {
  const readers = makeAdsReaders({ A1: ADS_ROWS() }, { A1: SYNCS });
  const loaded = await loadPersistedPpcAds({ accountId: ID, asOf: ASOF, ...readers });
  assert.equal(loaded.status, "ok");
  assert.deepEqual(loaded.currencies, ["USD"]);
  assert.equal(loaded.latestMetricDate, "2025-08-02");
  assert.equal(loaded.adsRows.length, 7);
  assert.equal(loaded.syncStates.length, 4, "only this account's allowed-source sync states are kept");
  assert.ok(loaded.sourceCoverage.every((c) => c.proven && c.folded), "every source proven + folded when fully covered");
  assert.deepEqual(loaded.sourceCoverage.filter((c) => c.required).map((c) => c.sourceKey), [KEYS.campaign, KEYS.asin], "campaign + ASIN are the required defaults");
});

test("19. loadPersistedPpcAds: validated EMPTY window is status ok (distinct from a read failure => unavailable)", async () => {
  const okEmpty = await loadPersistedPpcAds({ accountId: ID, asOf: ASOF, ...makeAdsReaders({ A1: [] }, { A1: SYNCS }) });
  assert.equal(okEmpty.status, "ok", "empty-but-validated Ads is ok");
  assert.deepEqual(okEmpty.adsRows, []);
  const failed = await loadPersistedPpcAds({ accountId: ID, asOf: ASOF, getAdsSyncStates: async () => SYNCS, getAdsDailySourceRows: async () => { throw new Error("read failed"); } });
  assert.equal(failed.status, "unavailable", "a read failure is unavailable, NOT an empty success");
});

test("20. loadPersistedPpcAds: the 120,000 Ads row cap rejects partial data => unavailable", async () => {
  const capReader = { getAdsSyncStates: async () => SYNCS, getAdsDailySourceRows: async () => { throw new Error("more than 120,000 saved Amazon Ads rows"); } };
  assert.equal((await loadPersistedPpcAds({ accountId: ID, asOf: ASOF, ...capReader })).status, "unavailable");
});

test("21. loadPersistedPpcAds: an out-of-window / bad-source-key row fails closed => unavailable (never filtered)", async () => {
  // A DEFENSIVE reader that does NOT pre-filter (unlike the real windowed query) so the loader's own
  // validation is exercised: one out-of-window row must invalidate the whole load, never be silently dropped.
  const outOfWindow = [...ADS_ROWS(), cmp(addDaysStr(FROM, -1), "CX", "SP", { spend: 1, sales: 1, clicks: 1, impr: 1, orders: 1, units: 1 })];
  const r1 = await loadPersistedPpcAds({ accountId: ID, asOf: ASOF, getAdsSyncStates: async () => SYNCS, getAdsDailySourceRows: async () => outOfWindow });
  assert.equal(r1.status, "unavailable", "one out-of-window row invalidates the whole load");
  const badSource = [...ADS_ROWS(), { account_id: ID, source_key: "amazon-orders-v1", metric_date: "2025-08-01", currency: "USD", dimensions: {}, metrics: {} }];
  const r2 = await loadPersistedPpcAds({ accountId: ID, asOf: ASOF, getAdsSyncStates: async () => SYNCS, getAdsDailySourceRows: async () => badSource, getAdsSyncCoverage: coverageReader(null) });
  assert.equal(r2.status, "unavailable", "a disallowed source_key invalidates the whole load");
});

test("22. ppcAdsCurrencySignalOf: validated => success signal; unavailable => fail-closed (never success)", () => {
  assert.deepEqual(ppcAdsCurrencySignalOf(okAds()), { status: "success", validated: true, currencyCount: 1, state: "single-valid" });
  assert.deepEqual(ppcAdsCurrencySignalOf(okAds([])), { status: "success", validated: true, currencyCount: 0, state: "empty" });
  assert.deepEqual(ppcAdsCurrencySignalOf({ status: "unavailable" }), { status: "failed", validated: false, currencyCount: null });
});

/* ============================= Part C: real cycle + report worker ============================= */

group("ppc real cycle: runPpcShadowCycle -> runReportJobs (zero Ads exports / gate / dedup / LKG / resume)");

function makeAdsReaders(rowsByAccount, syncByAccount, coverageMap = null) {
  return {
    async getAdsDailySourceRows({ accountId, sourceKeys, from, to, maxRows }) {
      // The production reader filters account_id = eq.<accountId>; mirror that so rows are account-scoped.
      const all = (rowsByAccount[accountId] || []).filter((r) => sourceKeys.includes(r.source_key) && r.metric_date >= from && r.metric_date <= to);
      if (maxRows && all.length >= maxRows) throw new Error(`more than ${maxRows} saved Amazon Ads rows`);
      return all;
    },
    async getAdsSyncStates(accountIds) { return accountIds.flatMap((a) => syncByAccount[a] || []); },
    getAdsSyncCoverage: coverageReader(coverageMap),
  };
}

function makeStore() {
  const cycles = new Map(); const jobsByCycle = new Map(); const ownersByCycle = new Map();
  const cache = new Map(); const reportJobs = new Map(); const snapshots = new Map(); let seq = 0;
  const findCycle = (id) => [...cycles.values()].find((c) => c.id === id) || null;
  const ownerRows = (cid) => [...((ownersByCycle.get(cid) && ownersByCycle.get(cid).values()) || [])];
  const rkey = (rk, a) => rk + "|" + a;
  return {
    _owners: (cid) => ownerRows(cid).map((m) => ({ ...m })), _snapshots: snapshots, saveCalls: 0,
    openCycle({ bucket, cycleDate }) { const k = bucket + "|" + cycleDate; if (!cycles.has(k)) { const id = "cyc_" + (seq += 1); cycles.set(k, { id, bucket, status: "pending" }); jobsByCycle.set(id, new Map()); } return cycles.get(k).id; },
    claimCycle(id) { const c = findCycle(id); if (c && c.status === "pending") { c.status = "running"; return true; } return false; },
    getCycle(id) { return findCycle(id); },
    upsertSourceJob(job) { const m = jobsByCycle.get(job.cycleId); if (m.has(job.requestHash)) return; m.set(job.requestHash, { request_hash: job.requestHash, request_key: job.requestKey, source_id: job.sourceId, source_key: job.sourceKey, connection_id: job.connectionId, organization_fingerprint: job.organizationFingerprint, account_scope_hash: job.accountScopeHash, fetch_status: "pending", attempted_at: null, create_export_count: 0, export_id: null, terminal: false, row_count: null }); },
    listSourceJobs(id) { return [...((jobsByCycle.get(id) && jobsByCycle.get(id).values()) || [])].map((j) => ({ ...j })); },
    upsertSourceJobOwners(ms) { for (const m of ms || []) { if (!ownersByCycle.has(m.cycleId)) ownersByCycle.set(m.cycleId, new Map()); ownersByCycle.get(m.cycleId).set(m.ownerId + "|" + m.requestHash, { cycle_id: m.cycleId, request_hash: m.requestHash, owner_id: m.ownerId, request_key: m.requestKey, report_key: m.reportKey, account_id: m.accountId, connection_id: m.connectionId, organization_fingerprint: m.organizationFingerprint, account_scope_hash: m.accountScopeHash, owner_status: "active", error_code: null }); } },
    listSourceJobOwners(cid, ids) { const s = new Set(ids || []); return ownerRows(cid).filter((m) => s.has(m.owner_id)).map((m) => ({ ...m })); },
    recordSourceOwnerStale({ cycleId, requestHash, ownerId, code }) { const m = ownersByCycle.get(cycleId) && ownersByCycle.get(cycleId).get(ownerId + "|" + requestHash); if (m) { m.owner_status = "stale"; m.error_code = code || "STALE_PLAN"; } },
    claimExportAttempt(id, h) { const j = jobsByCycle.get(id) && jobsByCycle.get(id).get(h); if (j && j.attempted_at === null) { j.attempted_at = "t"; j.create_export_count += 1; j.fetch_status = "attempted"; return true; } return false; },
    recordExportCreated({ cycleId, requestHash, exportId }) { jobsByCycle.get(cycleId).get(requestHash).export_id = exportId; },
    loadSourceRows(h) { const e = cache.get(h); return e ? { rows: e.rows } : null; },
    saveSourceRows({ job, rows }) { const h = job.request_hash != null ? job.request_hash : job.requestHash; cache.set(h, { rows: [...rows] }); return "p/" + h; },
    recordSourceSuccess({ cycleId, requestHash, exportId, rowCount, cacheObjectPath }) { Object.assign(jobsByCycle.get(cycleId).get(requestHash), { fetch_status: "succeeded", export_id: exportId, row_count: rowCount, cache_object_path: cacheObjectPath }); },
    recordSourceFailure({ cycleId, requestHash, stage, code, terminal }) { Object.assign(jobsByCycle.get(cycleId).get(requestHash), { fetch_status: "failed", error_stage: stage, error_code: code, terminal: !!terminal }); },
    updateCycleCounts() {},
    seedSnapshot(rk, a, payload) { snapshots.set(rkey(rk, a), { payload }); },
    report(rk, a) { return reportJobs.get(rkey(rk, a)); },
    listReportJobs() { return [...reportJobs.values()].map((j) => ({ ...j })); },
    upsertReportJob({ reportKey, accountId, connectionId, bucket, reportVersion, dependsOn }) { const k = rkey(reportKey, accountId); if (reportJobs.has(k)) return; reportJobs.set(k, { report_key: reportKey, account_id: accountId, connection_id: connectionId, bucket, report_version: reportVersion, depends_on: dependsOn || [], fetch_status: "pending", derive_status: "pending", save_status: "pending", validated: false }); },
    claimReportDerive(_c, rk, a) { const j = reportJobs.get(rkey(rk, a)); if (j && j.derive_status === "pending") { j.derive_status = "running"; return true; } return false; },
    recordReportBlocked({ reportKey, accountId }) { Object.assign(reportJobs.get(rkey(reportKey, accountId)), { fetch_status: "blocked", derive_status: "skipped", save_status: "skipped" }); },
    recordReportFailure({ reportKey, accountId, stage, code }) { Object.assign(reportJobs.get(rkey(reportKey, accountId)), { derive_status: stage === "save" ? "succeeded" : "failed", save_status: stage === "save" ? "failed" : "pending", error_code: code }); },
    recordReportSuccess({ reportKey, accountId, latestDataDate }) { Object.assign(reportJobs.get(rkey(reportKey, accountId)), { fetch_status: "ready", derive_status: "succeeded", save_status: "succeeded", validated: true, latest_data_date: latestDataDate ?? null }); },
  };
}

function makeDataDoe(opts = {}) {
  const create = {}; let hits = 0;
  const deadlineErr = () => Object.assign(new Error("deferred"), { code: "DATADOE_DEADLINE" });
  const rowsFor = (job) => {
    const rk = job.requestKey || ""; const fp = job.fetchParams || {};
    if (rk.includes("catalog")) return CATALOG();
    // The canonical OLI total-sales fragment is sliced by canonicalOliSlices; each slice returns ONLY the rows
    // whose date falls in its window, so the fragments concatenate to the exact hand-computed denominator (800).
    if (rk.includes("oli-sales")) return TOTAL_SALES().filter((r) => r.date >= (fp.from || FROM) && r.date <= (fp.to || ASOF));
    return [{ x: 1 }];
  };
  return {
    createdKeys: [], createCount: (h) => create[h] || 0, totalCreates: () => Object.values(create).reduce((a, b) => a + b, 0),
    async create(job) { create[job.requestHash] = (create[job.requestHash] || 0) + 1; this.createdKeys.push(job.requestKey); return { exportId: "e_" + job.requestHash }; },
    async poll(job) { if (opts.deferKey && (job.requestKey || "").includes(opts.deferKey)) { hits += 1; if (hits === 1) throw deadlineErr(); } },
    async download(job) { if (opts.capKey && (job.requestKey || "").includes(opts.capKey)) return new Array(Number(job.limit)).fill(0).map(() => ({ x: 1 })); return rowsFor(job); },
  };
}

const ACCTS = [{ accountId: ID, country: "US", currency: "USD" }];
const runCycle = (store, dd, readers, accounts = ACCTS, opts = {}) => runPpcShadowCycle({ accounts, connections: CONNS, asOf: ASOF, store, dataDoe: dd, getAdsDailySourceRows: readers.getAdsDailySourceRows, getAdsSyncStates: readers.getAdsSyncStates, getAdsSyncCoverage: readers.getAdsSyncCoverage, bucket: "us", cycleDate: "2026-08-11", ...opts });
const keyOf = (store, cid) => [...new Set(store.listSourceJobs(cid).map((j) => j.request_key))].sort();

test("23. staged, not generic: ppc-performance is a STAGED_CYCLE key; buildShadowReportPlan rejects it fail-closed", () => {
  assert.ok(!SHADOW_PLANNED_REPORT_KEYS.includes("ppc-performance"), "PPC is never a generic default key");
  assert.throws(() => buildShadowReportPlan({ accounts: ACCTS, reportKeys: ["ppc-performance"], connections: CONNS, asOfFor: () => ASOF }), /staged-cycle/i);
});

test("24. validated <=1 currency: plans EXACTLY catalog + oli-sales; ZERO DataDoe Ads exports", async () => {
  const store = makeStore(); const dd = makeDataDoe();
  const r = await runCycle(store, dd, makeAdsReaders({ A1: ADS_ROWS() }, { A1: SYNCS }));
  assert.deepEqual(keyOf(store, r.cycleId), ["ppc-performance:catalog", "ppc-performance:oli-sales"], "only catalog + oli-sales");
  // 7 exports = 1 shared no-date catalog + the 6 canonicalOliSlices(FROM, ASOF) total-sales slices.
  assert.equal(dd.totalCreates(), 7, "exactly seven DataDoe exports (catalog + six canonical OLI slices)");
  assert.ok(dd.createdKeys.every((k) => k === "ppc-performance:catalog" || k === "ppc-performance:oli-sales"), "NO Ads-source export was ever created");
  assert.ok(!dd.createdKeys.some((k) => /campaign-performance|asin-performance|targeting-performance|search-terms-performance|ads-/.test(k)), "zero Ads exports");
});

test("25. MULTI-currency Ads: gate SKIPS oli-sales -> plans catalog ONLY (one export, still zero Ads exports)", async () => {
  const store = makeStore(); const dd = makeDataDoe();
  const rows = [...ADS_ROWS(), cmp("2025-08-03", "C9", "SP", { spend: 1, sales: 1, clicks: 1, impr: 1, orders: 1, units: 1, currency: "CAD" })];
  const r = await runCycle(store, dd, makeAdsReaders({ A1: rows }, { A1: SYNCS }));
  assert.deepEqual(keyOf(store, r.cycleId), ["ppc-performance:catalog"], "catalog only");
  assert.equal(dd.totalCreates(), 1);
});

test("26. UNSEEDED Ads (successful [] rows + [] sync + [] coverage): plans NOTHING -> ZERO tokens; LKG kept", async () => {
  const store = makeStore(); const dd = makeDataDoe();
  const lkg = { accountId: ID, prior: true };
  // The account is genuinely unseeded: the row read SUCCEEDS returning [], there are no sync states, and NO
  // durable coverage windows exist ({} => every source reads as missing coverage). This is the exact case the
  // earlier loader mis-classified as a validated-EMPTY window; it MUST be unavailable so zero tokens are spent.
  const unseeded = makeAdsReaders({ A1: [] }, { A1: [] }, { A1: {} });
  const loaded = await loadPersistedPpcAds({ accountId: ID, asOf: ASOF, ...unseeded });
  assert.equal(loaded.status, "unavailable", "unseeded account is NOT a validated-empty window");
  assert.match(loaded.reason, /required-source/, "unavailable because a required default lacks proven coverage");
  assert.deepEqual(ppcAdsCurrencySignalOf(loaded), { status: "failed", validated: false, currencyCount: null }, "fail-closed currency signal");
  // Through the REAL cycle: zero source jobs, zero DataDoe exports, an empty-sources report plan.
  const r = await runCycle(store, dd, unseeded);
  assert.equal(dd.totalCreates(), 0, "unseeded Ads => zero DataDoe exports");
  assert.equal(store.listSourceJobs(r.cycleId).length, 0, "no source jobs staged");
  assert.deepEqual(r.plannedReports.map((p) => p.sources.length), [0], "the report plan emits zero sources");
  assert.equal(r.perAccount[0].adsStatus, "unavailable");
  // The report derive (via the Ads loader) is unavailable => a prior snapshot survives untouched.
  store.seedSnapshot("scheduler-v2/ppc-performance", ID, lkg);
  const saved = [];
  const saveSnapshot = async ({ reportKey, accountId, payload }) => { store.seedSnapshot(reportKey, accountId, payload); saved.push(payload); return { paramsHash: "ph" }; };
  const res = await runReportJobs({ store, cycleId: r.cycleId, sourceRows: (h) => store.loadSourceRows(h), saveSnapshot, plannedReports: r.plannedReports, loadDerivedContext: makePpcAdsContextLoader(unseeded) });
  assert.equal(res.succeeded, 0, "unavailable Ads => report not saved");
  assert.equal(saved.length, 0, "no report snapshot written");
  assert.deepEqual(store._snapshots.get("scheduler-v2/ppc-performance|" + ID).payload, lkg, "last-known-good preserved");
});

test("27. shared catalog canonical hash matches Sales Movers; one export per shared hash across owners", async () => {
  const store = makeStore(); const dd = makeDataDoe();
  const ppcPlan = planPpcPerformance({ accountId: ID, country: "US", currency: "USD", connections: CONNS, asOf: ASOF, adsCurrencySignal: { status: "success", validated: true, currencyCount: 1, state: "single-valid" } });
  const sm = planSalesMovers({ accountId: ID, country: "US", currency: "USD", connections: CONNS, asOf: ASOF, probeSignal: { status: "success", validated: true, latestReportedDate: "2025-08-08" } });
  const ppcCat = ppcPlan.sources.find((s) => s.requestKey === "ppc-performance:catalog");
  assert.equal(ppcCat.requestHash, sm.sources.find((s) => s.requestKey === "sales-movers:catalog").requestHash, "shared catalog identity with Sales Movers");
  // One export across the PPC + a second (Sales Movers) owner on the same catalog hash.
  const ppcJobs = ppcPlan.sources.map((s) => plannedSourceJob("ppc-performance", s, "us", "primary", ID));
  const catJob = ppcJobs.find((j) => j.requestKey === "ppc-performance:catalog");
  const smOwnerId = sourceJobOwnerId({ reportKey: "sales-movers", connectionId: "primary", organizationFingerprint: catJob.organizationFingerprint, accountScopeHash: catJob.accountScopeHash });
  const smCatJob = { ...catJob, requestKey: "sales-movers:catalog", owner: { ownerId: smOwnerId, requestKey: "sales-movers:catalog", reportKey: "sales-movers", accountId: ID } };
  const plannedJobs = [...ppcJobs, smCatJob];
  const r = await runSourceJobs({ store, dataDoe: dd, plannedJobs, ownerIds: [...new Set(plannedJobs.map((j) => j.owner.ownerId))], bucket: "us", cycleDate: "2026-08-11" });
  assert.equal(dd.createCount(catJob.requestHash), 1, "shared catalog export created exactly once");
  assert.equal(store._owners(r.cycleId).filter((m) => m.request_hash === catJob.requestHash).length, 2, "two owner memberships share the one hash");
});

test("28. E2E: cycle -> runReportJobs -> saved snapshot; zero network in derive; report saved once; idempotent", async () => {
  const store = makeStore(); const dd = makeDataDoe();
  const readers = makeAdsReaders({ A1: ADS_ROWS() }, { A1: SYNCS });
  const cycle = await runCycle(store, dd, readers);
  const saved = [];
  const saveSnapshot = async ({ reportKey, accountId, payload }) => { store.saveCalls += 1; store.seedSnapshot(reportKey, accountId, payload); saved.push(payload); return { paramsHash: "ph" }; };
  const realFetch = globalThis.fetch; let hits = 0;
  globalThis.fetch = () => { hits += 1; throw new Error("network during derivation"); };
  let res;
  try { res = await runReportJobs({ store, cycleId: cycle.cycleId, sourceRows: (h) => store.loadSourceRows(h), saveSnapshot, plannedReports: cycle.plannedReports, loadDerivedContext: makePpcAdsContextLoader(readers) }); } finally { globalThis.fetch = realFetch; }
  assert.equal(hits, 0, "zero network during derivation");
  assert.equal(res.succeeded, 1, "PPC derived + saved");
  assert.equal(saved[0].accountId, ID);
  assert.equal(saved[0].totalSales, 800, "TACoS denominator summed from the canonical OLI total-sales slices");
  assert.equal(saved[0].adsRowCount, 7);
  const before = store.saveCalls;
  await runReportJobs({ store, cycleId: cycle.cycleId, sourceRows: (h) => store.loadSourceRows(h), saveSnapshot, plannedReports: cycle.plannedReports, loadDerivedContext: makePpcAdsContextLoader(readers) });
  assert.equal(store.saveCalls, before, "no duplicate snapshot on re-run");
});

test("29. oli-sales strict-cap TRUNCATED degrades ONLY TACoS; the report still saves (catalog succeeded)", async () => {
  const store = makeStore(); const dd = makeDataDoe({ capKey: "oli-sales" });
  const readers = makeAdsReaders({ A1: ADS_ROWS() }, { A1: SYNCS });
  const cycle = await runCycle(store, dd, readers);
  const tsJob = store.listSourceJobs(cycle.cycleId).find((j) => j.request_key === "ppc-performance:oli-sales");
  assert.ok(tsJob.fetch_status === "failed" && tsJob.error_code === "TRUNCATED", "capped oli-sales fails TRUNCATED");
  const saved = [];
  const saveSnapshot = async ({ reportKey, accountId, payload }) => { store.seedSnapshot(reportKey, accountId, payload); saved.push(payload); return { paramsHash: "ph" }; };
  const res = await runReportJobs({ store, cycleId: cycle.cycleId, sourceRows: (h) => store.loadSourceRows(h), saveSnapshot, plannedReports: cycle.plannedReports, loadDerivedContext: makePpcAdsContextLoader(readers) });
  assert.equal(res.succeeded, 1, "the report still derives + saves");
  assert.equal(saved[0].totalSales, null);
  assert.equal(saved[0].totalSalesUnavailable, DEGRADED, "TACoS degraded, rest of PPC intact");
  assert.equal(saved[0].campaigns.length, 2);
});

test("30. maxJobs partial + poll-deferral resume through the real cycle with ONE create-export per hash", async () => {
  const s1 = makeStore(); const d1 = makeDataDoe();
  const readers = makeAdsReaders({ A1: ADS_ROWS() }, { A1: SYNCS });
  await runCycle(s1, d1, readers, ACCTS, { maxJobs: 1 });
  const r = await runCycle(s1, d1, readers);
  assert.ok(s1.listSourceJobs(r.cycleId).every((j) => j.fetch_status === "succeeded"), "all sources complete after maxJobs resume");
  for (const j of s1.listSourceJobs(r.cycleId)) assert.ok(d1.createCount(j.request_hash) <= 1, j.request_key + " exported at most once");
  const s2 = makeStore();
  const dDefer = makeDataDoe({ deferKey: "oli-sales" });
  const r1 = await runCycle(s2, dDefer, readers);
  assert.ok((r1.deferred || 0) > 0, "the driver surfaces the resumable deferral");
  const tsHash = store2Hash(s2, r1.cycleId, "ppc-performance:oli-sales");
  const dOk = makeDataDoe();
  const r2 = await runCycle(s2, dOk, readers);
  assert.equal(dDefer.createCount(tsHash) + dOk.createCount(tsHash), 1, "oli-sales slice exported exactly once across deferral + resume");
  assert.ok(s2.listSourceJobs(r2.cycleId).every((j) => j.fetch_status === "succeeded"));
});
function store2Hash(store, cid, key) { return store.listSourceJobs(cid).find((j) => j.request_key === key).request_hash; }

test("31. primary-only: a stale dd-secondary account is skipped read-only with ZERO DataDoe calls and never routed to primary", async () => {
  const store = makeStore(); const dd = makeDataDoe();
  const PRIMARY_ONLY = [{ id: "primary", apiKey: dash("prim", "key"), accountPrefix: "" }];
  const accounts = [{ accountId: ID, country: "US", currency: "USD" }, { accountId: dash("dd", "secondary") + ":B1", country: "US", currency: "USD" }];
  const readers = makeAdsReaders({ A1: ADS_ROWS() }, { A1: SYNCS }); // A1 fully covered; the dd-secondary is skipped before any read
  const r = await runPpcShadowCycle({ accounts, connections: PRIMARY_ONLY, asOf: ASOF, store, dataDoe: dd, getAdsDailySourceRows: readers.getAdsDailySourceRows, getAdsSyncStates: readers.getAdsSyncStates, getAdsSyncCoverage: readers.getAdsSyncCoverage, bucket: "us", cycleDate: "2026-08-11" });
  assert.equal(r.unavailableAccounts.length, 1, "the dd-secondary account is unavailable");
  assert.ok(store.listSourceJobs(r.cycleId).length > 0, "the primary account DID plan real jobs (routing proof is meaningful)");
  assert.ok(store.listSourceJobs(r.cycleId).every((j) => j.connection_id === "primary"), "no dd-secondary jobs; nothing routed to primary");
  assert.deepEqual(r.plannedReports.map((p) => p.accountId), ["A1"], "only the primary account yields a report plan");
});

/* ========== Part D: durable-coverage gate + row-level account isolation (PPC review blockers) ========== */

group("ppc loader: durable ads_sync_coverage gate (validated-empty vs unavailable) + account isolation");

test("32. full campaign+ASIN coverage + [] rows => GENUINE VALIDATED EMPTY (distinct from unavailable)", async () => {
  const readers = makeAdsReaders({ A1: [] }, { A1: SYNCS }); // full coverage default, but zero saved rows
  const loaded = await loadPersistedPpcAds({ accountId: ID, asOf: ASOF, ...readers });
  assert.equal(loaded.status, "ok", "a fully-covered zero-activity window is a genuine validated-empty window");
  assert.deepEqual(loaded.adsRows, []);
  assert.equal(loaded.latestMetricDate, null, "empty window => latestMetricDate null (never inferred)");
  assert.deepEqual(loaded.currencies, []);
  assert.ok(loaded.sourceCoverage.filter((c) => c.required).every((c) => c.proven), "required defaults proven");
  // Through the derive: an honestly-empty report (derived), NOT unavailable.
  const r = derivePpc(ppcPlanned({ catalog: CATALOG() }), loaded);
  assert.equal(r.status, "derived", "validated-empty derives a real, honestly-empty report");
  assert.equal(r.payload.adsRowCount, 0);
  assert.equal(r.latestDataDate, null);
});

test("33. required-source coverage partial/gapped/stale/schema-missing/read-failed/missing => unavailable (LKG)", async () => {
  const asOfM = (n) => addDaysStr(ASOF, n); const fromP = (n) => addDaysStr(FROM, n);
  const cases = {
    "partial suffix (starts after FROM)": { [KEYS.campaign]: covState({ windows: [{ from: fromP(5), to: ASOF }] }), "*": covFull() },
    "interior gap": { [KEYS.campaign]: covState({ windows: [{ from: FROM, to: asOfM(-10) }, { from: asOfM(-4), to: ASOF }] }), "*": covFull() },
    "stale (does not reach asOf)": { [KEYS.campaign]: covState({ windows: [{ from: FROM, to: asOfM(-3) }] }), "*": covFull() },
    "schema-missing table": { [KEYS.campaign]: { windows: [], read: "schema-missing" }, "*": covFull() },
    "read-failed": { [KEYS.campaign]: { windows: [{ from: FROM, to: ASOF }], read: "read-failed" }, "*": covFull() },
    "required ASIN missing while campaign covered": { [KEYS.asin]: { windows: [], read: "ok" }, "*": covFull() },
  };
  for (const [label, map] of Object.entries(cases)) {
    const readers = makeAdsReaders({ A1: ADS_ROWS() }, { A1: SYNCS }, { A1: map });
    const loaded = await loadPersistedPpcAds({ accountId: ID, asOf: ASOF, ...readers });
    assert.equal(loaded.status, "unavailable", label + " => unavailable");
    assert.match(loaded.reason, /required-source/, label + " => reason names the required source");
    assert.deepEqual(ppcAdsCurrencySignalOf(loaded), { status: "failed", validated: false, currencyCount: null }, label + " => fail-closed signal (plans nothing)");
  }
});

test("34. optional targeting/search policy: covered folds; an unproven optional is unavailable + its rows are NEVER folded", async () => {
  // Required defaults + targeting fully covered; search-terms STALE (does not reach asOf) => unproven optional.
  const map = { A1: {
    [KEYS.campaign]: covFull(), [KEYS.asin]: covFull(), [KEYS.targeting]: covFull(),
    [KEYS.search]: covState({ windows: [{ from: FROM, to: addDaysStr(ASOF, -3) }] }),
  } };
  const readers = makeAdsReaders({ A1: ADS_ROWS() }, { A1: SYNCS }, map);
  const loaded = await loadPersistedPpcAds({ accountId: ID, asOf: ASOF, ...readers });
  assert.equal(loaded.status, "ok", "required defaults covered => Ads validated");
  const byKey = Object.fromEntries(loaded.sourceCoverage.map((c) => [c.sourceKey, c]));
  // Availability state table:
  assert.deepEqual([byKey[KEYS.campaign].proven, byKey[KEYS.asin].proven, byKey[KEYS.targeting].proven], [true, true, true]);
  assert.deepEqual([byKey[KEYS.campaign].folded, byKey[KEYS.asin].folded, byKey[KEYS.targeting].folded], [true, true, true]);
  assert.equal(byKey[KEYS.search].proven, false, "stale search-terms is not proven");
  assert.equal(byKey[KEYS.search].folded, false, "unproven optional rows are NOT folded");
  assert.ok(!loaded.adsRows.some((r) => r.source_key === KEYS.search), "no stale search-term row survives the fold");
  assert.ok(loaded.adsRows.some((r) => r.source_key === KEYS.targeting), "covered targeting rows DO survive");
  // Derived report shows targeting but an empty search-terms list -- stale data is never presented as current.
  const r = derivePpc(ppcPlanned({ catalog: CATALOG() }), loaded);
  assert.equal(r.status, "derived");
  assert.equal(r.payload.targets.length, 1, "covered targeting is shown");
  assert.deepEqual(r.payload.searchTerms, [], "stale search-term data is dropped, not shown as current");
  // Blocker 2: the SAVED payload's sourceAvailability explicitly marks the stale search source unavailable
  // even though SYNCS[3] would otherwise be shown; the covered sources stay validated.
  const sa = Object.fromEntries(r.payload.sourceAvailability.map((s) => [s.key, s]));
  assert.deepEqual([sa[KEYS.campaign].coverageStatus, sa[KEYS.asin].coverageStatus, sa[KEYS.targeting].coverageStatus], ["validated", "validated", "validated"]);
  assert.equal(sa[KEYS.search].coverageStatus, "unavailable", "stale optional search is explicitly unavailable in the payload");
  assert.equal(sa[KEYS.search].coverageProven, false);
  assert.equal(sa[KEYS.search].coverageFolded, false);
  assert.equal(sa[KEYS.search].coverageUnavailableReason, "coverage-incomplete", "typed reason, not a raw DB error");
  assert.equal(sa[KEYS.search].rows, 0, "its dropped rows read as zero");
});

test("35. cross-account / missing-account rows fail closed => unavailable, zero jobs/exports, LKG (blocker 2)", async () => {
  // (a) A leaked row carrying a DIFFERENT account_id than requested invalidates the whole load (never filtered).
  const cross = [...ADS_ROWS(), { ...cmp("2025-08-02", "CX", "SP", { spend: 1, sales: 1, clicks: 1, impr: 1, orders: 1, units: 1 }), account_id: "OTHER" }];
  const crossReaders = { getAdsSyncStates: async () => SYNCS, getAdsDailySourceRows: async () => cross, getAdsSyncCoverage: coverageReader(null) };
  const l1 = await loadPersistedPpcAds({ accountId: ID, asOf: ASOF, ...crossReaders });
  assert.equal(l1.status, "unavailable", "one cross-account row fails the whole load closed");
  assert.equal(l1.reason, "ads-row-account-mismatch");
  // (b) A row missing account_id entirely is rejected BEFORE any currency gating / folding.
  const missing = [...ADS_ROWS(), { source_key: KEYS.campaign, metric_date: "2025-08-02", currency: "USD", dimensions: {}, metrics: { ad_spend: 1 } }];
  const l2 = await loadPersistedPpcAds({ accountId: ID, asOf: ASOF, getAdsSyncStates: async () => SYNCS, getAdsDailySourceRows: async () => missing, getAdsSyncCoverage: coverageReader(null) });
  assert.equal(l2.status, "unavailable");
  assert.equal(l2.reason, "ads-row-account-missing");
  // (c) Through the REAL cycle + report worker: zero DataDoe jobs/exports, no snapshot, LKG preserved.
  const store = makeStore(); const dd = makeDataDoe(); const lkg = { accountId: ID, prior: true };
  const r = await runCycle(store, dd, crossReaders);
  assert.equal(dd.totalCreates(), 0, "cross-account leak => zero DataDoe exports");
  assert.equal(store.listSourceJobs(r.cycleId).length, 0, "no source jobs staged");
  store.seedSnapshot("scheduler-v2/ppc-performance", ID, lkg);
  const saved = [];
  const saveSnapshot = async ({ reportKey, accountId, payload }) => { store.seedSnapshot(reportKey, accountId, payload); saved.push(payload); return { paramsHash: "ph" }; };
  const res = await runReportJobs({ store, cycleId: r.cycleId, sourceRows: (h) => store.loadSourceRows(h), saveSnapshot, plannedReports: r.plannedReports, loadDerivedContext: makePpcAdsContextLoader(crossReaders) });
  assert.equal(res.succeeded, 0, "cross-account Ads => report not saved");
  assert.equal(saved.length, 0, "no snapshot written");
  assert.deepEqual(store._snapshots.get("scheduler-v2/ppc-performance|" + ID).payload, lkg, "last-known-good preserved");
});

test("36. dd-secondary public-id namespacing: only rows tagged with the EXACT public id validate; primary/secondary never cross", async () => {
  const SEC = dash("dd", "secondary") + ":B1";
  const secRow = (over = {}) => ({ account_id: SEC, source_key: KEYS.campaign, metric_date: "2025-08-02", currency: "USD", dimensions: { ad_campaign_name: "S" }, metrics: { ad_spend: 1, ad_sales: 2, ad_clicks: 1 }, ...over });
  // Rows correctly tagged with the dd-secondary public id validate under that account.
  const good = { getAdsSyncStates: async () => [], getAdsDailySourceRows: async () => [secRow()], getAdsSyncCoverage: coverageReader({ [SEC]: { "*": covFull() } }) };
  const okSec = await loadPersistedPpcAds({ accountId: SEC, asOf: ASOF, ...good });
  assert.equal(okSec.status, "ok", "dd-secondary rows validate under the dd-secondary public id");
  assert.equal(okSec.adsRows.length, 1);
  // A row carrying the PRIMARY public id must NOT validate under the dd-secondary account (no cross-namespace leak).
  const leakPrimary = { getAdsSyncStates: async () => [], getAdsDailySourceRows: async () => [secRow({ account_id: ID })], getAdsSyncCoverage: coverageReader({ [SEC]: { "*": covFull() } }) };
  assert.equal((await loadPersistedPpcAds({ accountId: SEC, asOf: ASOF, ...leakPrimary })).status, "unavailable", "a primary-id row never routes into the secondary account");
  // Symmetrically, a dd-secondary-id row must NOT validate under the primary account.
  const leakSecondary = { getAdsSyncStates: async () => [], getAdsDailySourceRows: async () => [secRow()], getAdsSyncCoverage: coverageReader({ A1: { "*": covFull() } }) };
  assert.equal((await loadPersistedPpcAds({ accountId: ID, asOf: ASOF, ...leakSecondary })).status, "unavailable", "a dd-secondary-id row never routes into the primary account");
});

/* ===== Part E: durable-coverage CONTRACT enforced in the derive + coverage propagated to the payload ===== */

group("ppc coverage contract: evaluateSourceCoverage hardening + validatePpcSourceCoverage + derive/payload wiring");

test("37. evaluateSourceCoverage is fail-closed: explicit read + structurally-valid full windows required", () => {
  const F = FROM, T = ASOF;
  assert.deepEqual(evaluateSourceCoverage({ read: "ok", windows: [{ from: F, to: T }] }, F, T), { proven: true, reason: null }, "explicit read ok + full window => proven");
  // A missing / non-literal `read` must NEVER default to success.
  assert.equal(evaluateSourceCoverage({ windows: [{ from: F, to: T }] }, F, T).proven, false, "missing read => not proven");
  assert.equal(evaluateSourceCoverage({ read: "OK", windows: [{ from: F, to: T }] }, F, T).proven, false, "only the literal 'ok' counts");
  // One malformed window must invalidate the evidence even when a valid full window is present.
  assert.equal(evaluateSourceCoverage({ read: "ok", windows: [{ from: "2025-13-40", to: T }, { from: F, to: T }] }, F, T).reason, "coverage-window-malformed", "bad-date window + full => not proven");
  assert.equal(evaluateSourceCoverage({ read: "ok", windows: [{ from: T, to: F }, { from: F, to: T }] }, F, T).reason, "coverage-window-malformed", "from>to window + full => not proven");
  assert.equal(evaluateSourceCoverage({ read: "ok", windows: [null, { from: F, to: T }] }, F, T).reason, "coverage-window-malformed", "non-object window + full => not proven");
  // windows must be a real array.
  assert.equal(evaluateSourceCoverage({ read: "ok", windows: "nope" }, F, T).reason, "coverage-windows-not-array");
  assert.equal(evaluateSourceCoverage({ read: "ok" }, F, T).reason, "coverage-windows-not-array", "missing windows => not proven");
  // schema-missing / read-failed / partial / stale remain unavailable with typed reasons.
  assert.equal(evaluateSourceCoverage({ read: "schema-missing", windows: [] }, F, T).reason, "coverage-schema-missing");
  assert.equal(evaluateSourceCoverage({ read: "read-failed", windows: [{ from: F, to: T }] }, F, T).reason, "coverage-read-failed");
  assert.equal(evaluateSourceCoverage({ read: "ok", windows: [{ from: addDaysStr(F, 5), to: T }] }, F, T).reason, "coverage-incomplete", "partial suffix");
  assert.equal(evaluateSourceCoverage({ read: "ok", windows: [{ from: F, to: addDaysStr(T, -3) }] }, F, T).reason, "coverage-incomplete", "stale");
  // a non-plain-object state is malformed, never proven.
  assert.equal(evaluateSourceCoverage(null, F, T).reason, "coverage-state-malformed");
  assert.equal(evaluateSourceCoverage([], F, T).reason, "coverage-state-malformed");
});

test("38. validatePpcSourceCoverage enforces the four-key contract (count/dup/unknown/flags/required/proven/folded)", () => {
  const base = () => provenCoverage();
  assert.equal(validatePpcSourceCoverage(base()).ok, true, "canonical fully-proven+folded coverage is valid");
  const optUnproven = base().map((c) => c.sourceKey === KEYS.search ? { ...c, proven: false, folded: false, reason: "coverage-incomplete" } : c);
  assert.equal(validatePpcSourceCoverage(optUnproven).ok, true, "an optional with folded===proven (both false) is valid");
  assert.equal(validatePpcSourceCoverage(null).reason, "source-coverage-not-array");
  assert.equal(validatePpcSourceCoverage(base().slice(0, 3)).reason, "source-coverage-wrong-count", "a missing key");
  assert.equal(validatePpcSourceCoverage([base()[0], { ...base()[0] }, base()[2], base()[3]]).reason, "source-coverage-duplicate-key");
  assert.equal(validatePpcSourceCoverage(base().map((c, i) => (i === 3 ? { ...c, sourceKey: "totally-unknown" } : c))).reason, "source-coverage-unknown-key");
  assert.equal(validatePpcSourceCoverage(base().map((c) => (c.sourceKey === KEYS.campaign ? { ...c, required: false } : c))).reason, "source-coverage-required-flag-mismatch");
  assert.equal(validatePpcSourceCoverage(base().map((c) => (c.sourceKey === KEYS.asin ? { ...c, proven: false } : c))).reason, "source-coverage-required-not-proven-folded", "required ASIN not proven");
  assert.equal(validatePpcSourceCoverage(base().map((c) => (c.sourceKey === KEYS.asin ? { ...c, folded: false } : c))).reason, "source-coverage-required-not-proven-folded", "required ASIN not folded");
  assert.equal(validatePpcSourceCoverage(base().map((c) => (c.sourceKey === KEYS.targeting ? { ...c, proven: false, folded: true } : c))).reason, "source-coverage-optional-folded-not-equal-proven", "optional folded!=proven");
  assert.equal(validatePpcSourceCoverage(base().map((c) => (c.sourceKey === KEYS.search ? { ...c, proven: "yes" } : c))).reason, "source-coverage-flags-not-boolean");
  assert.equal(validatePpcSourceCoverage([null, base()[1], base()[2], base()[3]]).reason, "source-coverage-entry-malformed");
});

test("39. derive RE-ENFORCES the coverage contract on the injected context => unavailable, no snapshot, LKG", async () => {
  // A status:"ok" context WITHOUT sourceCoverage (the exact bypass the re-review flagged) must fail closed.
  const noCov = { status: "ok", adsRows: ADS_ROWS(), syncStates: SYNCS };
  assert.equal(derivePpc(ppcPlanned({ catalog: CATALOG() }), noCov).status, "unavailable", "missing sourceCoverage => unavailable");
  // Contradictory contract (required campaign not proven) and a duplicate key also fail closed.
  const badReq = okAds(ADS_ROWS(), SYNCS, provenCoverage().map((c) => (c.sourceKey === KEYS.campaign ? { ...c, proven: false, folded: false } : c)));
  assert.equal(derivePpc(ppcPlanned({ catalog: CATALOG() }), badReq).status, "unavailable", "required unproven in contract => unavailable");
  const dupCov = okAds(ADS_ROWS(), SYNCS, [provenCoverage()[0], { ...provenCoverage()[0] }, provenCoverage()[2], provenCoverage()[3]]);
  assert.equal(derivePpc(ppcPlanned({ catalog: CATALOG() }), dupCov).status, "unavailable", "duplicate key => unavailable");
  // Worker-level: even a fully-planned cycle writes NO snapshot and keeps LKG if the injected context loader
  // strips sourceCoverage -- proving the ADAPTER (not just the loader) is the gate.
  const store = makeStore(); const dd = makeDataDoe(); const lkg = { accountId: ID, prior: true };
  const readers = makeAdsReaders({ A1: ADS_ROWS() }, { A1: SYNCS });
  const cycle = await runCycle(store, dd, readers);
  store.seedSnapshot("scheduler-v2/ppc-performance", ID, lkg);
  const saved = [];
  const saveSnapshot = async ({ reportKey, accountId, payload }) => { store.seedSnapshot(reportKey, accountId, payload); saved.push(payload); return { paramsHash: "ph" }; };
  const brokenLoader = async ({ reportKey, accountId, planned }) => {
    if (reportKey !== "ppc-performance") return {};
    const full = await makePpcAdsContextLoader(readers)({ reportKey, accountId, planned });
    return { ppcAds: { ...full.ppcAds, sourceCoverage: undefined } }; // strip the contract evidence
  };
  const res = await runReportJobs({ store, cycleId: cycle.cycleId, sourceRows: (h) => store.loadSourceRows(h), saveSnapshot, plannedReports: cycle.plannedReports, loadDerivedContext: brokenLoader });
  assert.equal(res.succeeded, 0, "a stripped-coverage context saves nothing");
  assert.equal(saved.length, 0, "no snapshot written");
  assert.deepEqual(store._snapshots.get("scheduler-v2/ppc-performance|" + ID).payload, lkg, "last-known-good preserved");
});

test("40. E2E worker snapshot: stale optional (succeeded sync state) saved sourceAvailability-unavailable; rows absent", async () => {
  const store = makeStore(); const dd = makeDataDoe();
  // search-terms has a PREVIOUSLY SUCCEEDED ads_sync_state, but its durable coverage is stale (does not reach
  // asOf). It must NOT look current: coverage overrides the succeeded sync state.
  const syncs = [sync(KEYS.campaign), sync(KEYS.asin), sync(KEYS.targeting), sync(KEYS.search, { status: "succeeded", latest: "2025-08-02" })];
  const map = { A1: {
    [KEYS.campaign]: covFull(), [KEYS.asin]: covFull(), [KEYS.targeting]: covFull(),
    [KEYS.search]: covState({ windows: [{ from: FROM, to: addDaysStr(ASOF, -3) }] }),
  } };
  const readers = makeAdsReaders({ A1: ADS_ROWS() }, { A1: syncs }, map);
  const cycle = await runCycle(store, dd, readers);
  const saved = [];
  const saveSnapshot = async ({ reportKey, accountId, payload }) => { store.seedSnapshot(reportKey, accountId, payload); saved.push(payload); return { paramsHash: "ph" }; };
  const res = await runReportJobs({ store, cycleId: cycle.cycleId, sourceRows: (h) => store.loadSourceRows(h), saveSnapshot, plannedReports: cycle.plannedReports, loadDerivedContext: makePpcAdsContextLoader(readers) });
  assert.equal(res.succeeded, 1, "the report still derives from the covered defaults");
  const payload = saved[0];
  const sa = Object.fromEntries(payload.sourceAvailability.map((s) => [s.key, s]));
  assert.equal(sa[KEYS.search].sync.last_status, "succeeded", "the search sync state DID previously succeed");
  assert.equal(sa[KEYS.search].coverageStatus, "unavailable", "yet stale coverage makes it explicitly unavailable in the saved payload");
  assert.equal(sa[KEYS.search].coverageProven, false);
  assert.equal(sa[KEYS.search].coverageUnavailableReason, "coverage-incomplete", "typed reason, no raw DB error");
  assert.equal(sa[KEYS.search].rows, 0, "the stale search rows are absent from the saved payload");
  assert.deepEqual(payload.searchTerms, [], "no stale search-term rows folded");
  assert.equal(sa[KEYS.targeting].coverageStatus, "validated", "covered targeting stays validated");
  assert.ok(payload.targets.length >= 1, "covered targeting rows are present");
  // Currency gating used only folded rows (search dropped): TACoS denominator still summed from total-sales.
  assert.equal(payload.totalSales, 800);
});

/* ===== Part F: admin-safe coverage reason codes (a raw DB/HTTP/credential string is NEVER persisted) ===== */

group("ppc coverage reason safety: closed allowlist enforced at the derive boundary AND the saved payload");

// Minimal four-source descriptors for DIRECT ppcPerformancePayload calls (campaign, asin, targeting, search).
const PPC_DESCRIPTORS = [
  { syncKey: KEYS.campaign, label: "Campaign", coverage: "c", defaultDataset: true },
  { syncKey: KEYS.asin, label: "ASIN", coverage: "a", defaultDataset: true },
  { syncKey: KEYS.targeting, label: "Targeting", coverage: "t", defaultDataset: false },
  { syncKey: KEYS.search, label: "Search", coverage: "s", defaultDataset: false },
];
const directPpcPayload = (sourceCoverage, over = {}) => ppcPerformancePayload({
  accountId: ID, asOf: ASOF, from: FROM, windowDays: 30, adsSourceDescriptors: PPC_DESCRIPTORS,
  totalSalesSourceLabel: "TS", totalSalesLagDays: 4, adsRows: [], syncStates: [], catalogRows: [], ...over, sourceCoverage,
});
// A structurally-valid four-key contract; `searchOver` mutates the unproven-optional search entry under test.
const covContract = (searchOver = {}) => [
  { sourceKey: KEYS.campaign, required: true, proven: true, folded: true, reason: null },
  { sourceKey: KEYS.asin, required: true, proven: true, folded: true, reason: null },
  { sourceKey: KEYS.targeting, required: false, proven: true, folded: true, reason: null },
  { sourceKey: KEYS.search, required: false, proven: false, folded: false, reason: "coverage-incomplete", ...searchOver },
];
const UNSAFE_REASONS = [
  "raw-db-error apikey=LEAK",
  "authorization: Bearer sk-live-abcdef0123456789",
  "https://xyz.supabase.co/rest/v1/ads_sync_coverage?apikey=SECRET",
  "PGRST205: relation \"ads_sync_coverage\" does not exist",
  "Error: connect ETIMEDOUT 10.0.0.5:5432",
  "SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
];

test("41. validatePpcSourceCoverage reason safety: proven=>reason null; unproven optional=>allowlisted code only", () => {
  assert.equal(validatePpcSourceCoverage(covContract()).ok, true, "unproven optional with an approved typed reason is valid");
  assert.equal(validatePpcSourceCoverage(covContract({ reason: "coverage-schema-missing" })).ok, true, "any allowlisted safe code is accepted");
  // A proven source (required OR optional) MUST carry reason:null.
  assert.equal(validatePpcSourceCoverage(covContract().map((c) => (c.sourceKey === KEYS.campaign ? { ...c, reason: "coverage-incomplete" } : c))).reason, "source-coverage-proven-reason-not-null", "proven required + non-null reason fails");
  assert.equal(validatePpcSourceCoverage(covContract({ proven: true, folded: true, reason: "coverage-incomplete" })).reason, "source-coverage-proven-reason-not-null", "proven optional + non-null reason fails");
  // An unproven optional with an unsafe / unknown / missing / non-string reason fails closed.
  for (const bad of UNSAFE_REASONS) {
    assert.equal(validatePpcSourceCoverage(covContract({ reason: bad })).reason, "source-coverage-unproven-reason-unsafe", "unsafe reason rejected: " + bad.slice(0, 22));
  }
  assert.equal(validatePpcSourceCoverage(covContract({ reason: undefined })).reason, "source-coverage-unproven-reason-unsafe", "missing reason on unproven optional fails");
  assert.equal(validatePpcSourceCoverage(covContract({ reason: null })).reason, "source-coverage-unproven-reason-unsafe", "null reason on unproven optional fails");
  assert.equal(validatePpcSourceCoverage(covContract({ reason: 42 })).reason, "source-coverage-unproven-reason-unsafe", "non-string reason fails");
});

test("42. normalizePpcCoverageReason: allowlisted code passes; every raw/credential/url/db string => fixed fallback", () => {
  assert.equal(normalizePpcCoverageReason("coverage-incomplete"), "coverage-incomplete");
  assert.equal(normalizePpcCoverageReason("coverage-schema-missing"), "coverage-schema-missing");
  for (const bad of UNSAFE_REASONS) assert.equal(normalizePpcCoverageReason(bad), "coverage-unavailable", "normalized to fallback: " + bad.slice(0, 22));
  assert.equal(normalizePpcCoverageReason(null), "coverage-unavailable");
  assert.equal(normalizePpcCoverageReason(undefined), "coverage-unavailable");
  assert.equal(normalizePpcCoverageReason({ toString: () => "coverage-incomplete" }), "coverage-unavailable", "only a real allowlisted STRING passes, never a coercible object");
  // Drift guard: every reason evaluateSourceCoverage / proveSourceCoverage can emit IS in the allowlist.
  const F = FROM, T = ASOF;
  const produced = [
    evaluateSourceCoverage(null, F, T).reason,
    evaluateSourceCoverage({ read: "schema-missing", windows: [] }, F, T).reason,
    evaluateSourceCoverage({ read: "read-failed", windows: [] }, F, T).reason,
    evaluateSourceCoverage({ read: "weird", windows: [] }, F, T).reason,
    evaluateSourceCoverage({ read: "ok", windows: "x" }, F, T).reason,
    evaluateSourceCoverage({ read: "ok", windows: [null] }, F, T).reason,
    evaluateSourceCoverage({ read: "ok", windows: [{ from: F, to: addDaysStr(T, -3) }] }, F, T).reason,
    "coverage-reader-missing", // proveSourceCoverage(no reader) -- not exported, asserted as a literal
  ];
  for (const c of produced) assert.ok(c === null || PPC_COVERAGE_REASON_CODES.includes(c), "loader-produced reason allowlisted: " + c);
});

test("43. direct ppcPerformancePayload can NEVER persist an unsafe reason (normalizes to the fallback)", () => {
  for (const bad of UNSAFE_REASONS) {
    const p = directPpcPayload(covContract({ reason: bad }));
    const sa = Object.fromEntries(p.sourceAvailability.map((s) => [s.key, s]));
    assert.equal(sa[KEYS.search].coverageUnavailableReason, "coverage-unavailable", "unsafe reason normalized: " + bad.slice(0, 22));
    assert.ok(!JSON.stringify(p).includes(bad), "the raw string appears NOWHERE in the payload: " + bad.slice(0, 22));
  }
  // A proven source emits no reason; an approved code passes through unchanged.
  const ok = directPpcPayload(covContract({ reason: "coverage-incomplete" }));
  const okSa = Object.fromEntries(ok.sourceAvailability.map((s) => [s.key, s]));
  assert.equal(okSa[KEYS.search].coverageUnavailableReason, "coverage-incomplete");
  assert.equal(okSa[KEYS.campaign].coverageUnavailableReason, null, "proven required has no reason");
});

test("44. derive + real worker fail closed on an INJECTED unsafe reason => no snapshot, LKG, credential never stored", async () => {
  const LEAK = "raw-db-error apikey=LEAK";
  // Derive boundary: a four-key-valid contract whose search entry carries an unsafe reason is rejected.
  const badReason = okAds(ADS_ROWS(), SYNCS, covContract({ reason: LEAK }));
  assert.equal(derivePpc(ppcPlanned({ catalog: CATALOG() }), badReason).status, "unavailable", "unsafe coverage reason fails the contract at the derive boundary");
  // Worker level: a loader that injects the unsafe reason writes ZERO snapshots and preserves LKG.
  const store = makeStore(); const dd = makeDataDoe(); const lkg = { accountId: ID, prior: true };
  const readers = makeAdsReaders({ A1: ADS_ROWS() }, { A1: SYNCS });
  const cycle = await runCycle(store, dd, readers);
  store.seedSnapshot("scheduler-v2/ppc-performance", ID, lkg);
  const saved = [];
  const saveSnapshot = async ({ reportKey, accountId, payload }) => { store.seedSnapshot(reportKey, accountId, payload); saved.push(payload); return { paramsHash: "ph" }; };
  const injectingLoader = async ({ reportKey, accountId, planned }) => {
    if (reportKey !== "ppc-performance") return {};
    const full = await makePpcAdsContextLoader(readers)({ reportKey, accountId, planned });
    const sc = full.ppcAds.sourceCoverage.map((c) => (c.sourceKey === KEYS.search ? { ...c, proven: false, folded: false, reason: LEAK } : c));
    return { ppcAds: { ...full.ppcAds, sourceCoverage: sc } };
  };
  const rj = await runReportJobs({ store, cycleId: cycle.cycleId, sourceRows: (h) => store.loadSourceRows(h), saveSnapshot, plannedReports: cycle.plannedReports, loadDerivedContext: injectingLoader });
  assert.equal(rj.succeeded, 0, "an unsafe-reason context saves nothing");
  assert.equal(saved.length, 0, "no snapshot written");
  assert.deepEqual(store._snapshots.get("scheduler-v2/ppc-performance|" + ID).payload, lkg, "last-known-good preserved");
  assert.ok(!JSON.stringify(store._snapshots.get("scheduler-v2/ppc-performance|" + ID)).includes("LEAK"), "the credential-shaped string never reached the store");
});

test("45. live-route payload is unchanged when sourceCoverage is ABSENT (no coverage* fields added)", () => {
  const p = ppcPerformancePayload({ accountId: ID, asOf: ASOF, from: FROM, windowDays: 30, adsSourceDescriptors: PPC_DESCRIPTORS, totalSalesSourceLabel: "TS", totalSalesLagDays: 4, adsRows: [], syncStates: [], catalogRows: [] });
  for (const s of p.sourceAvailability) {
    assert.ok(!("coverageProven" in s) && !("coverageFolded" in s) && !("coverageStatus" in s) && !("coverageUnavailableReason" in s), s.key + " carries NO coverage fields without sourceCoverage");
  }
});

test("46. Blocker 1: the TACoS fold sums ONLY for a single valid Ads currency matched by every OLI row (canonicalized); else unavailable, never summed", () => {
  // Drives the PURE scheduler fold directly so the evidence classifier (not the scheduler's raw pre-count)
  // decides. adsRows carry only a currency (unmatched source_key => not folded, but still count for currency).
  const ads = (currency) => [{ currency, metric_date: "2025-08-01" }];
  const oli = (currency) => [{ item_price_currency: currency, total_sales_sum: 100 }];
  const tacos = (adsRows, totalSalesRows) => directPpcPayload([], { adsRows, totalSalesRows });

  // single valid Ads currency + every OLI row matching (canonicalized both sides) => summed.
  assert.equal(tacos(ads("USD"), oli("USD")).totalSales, 100, "USD Ads + USD OLI => summed");
  assert.equal(tacos(ads("usd"), oli("USD")).totalSales, 100, "lowercase Ads 'usd' normalizes to USD => summed");
  assert.equal(tacos(ads("USD"), oli("usd")).totalSales, 100, "lowercase OLI 'usd' normalizes to USD => summed");

  // Ads side fails closed: malformed (embedded space), empty rows => never summed.
  const p1 = tacos(ads("US D"), oli("USD"));
  assert.equal(p1.totalSales, null, "malformed 'US D' Ads currency => invalid => never summed");
  assert.ok(/different currency/i.test(p1.totalSalesUnavailable), "typed currency-ambiguity reason");
  assert.equal(tacos([], oli("USD")).totalSales, null, "empty Ads rows => no currency to match => unavailable");

  // OLI side fails closed: mismatch, malformed, or ANY blank row among valid ones => never summed.
  assert.equal(tacos(ads("USD"), oli("CAD")).totalSales, null, "USD Ads + CAD OLI => mismatch => unavailable");
  assert.equal(tacos(ads("USD"), oli("US D")).totalSales, null, "USD Ads + malformed OLI => unavailable");
  assert.equal(tacos(ads("USD"), [{ item_price_currency: "USD", total_sales_sum: 100 }, { item_price_currency: "", total_sales_sum: 50 }]).totalSales, null, "any blank OLI currency => never sums a currencyless row");

  // TACoS unavailable NEVER collapses the rest of the payload.
  assert.equal(p1.adsRowCount, 1, "the malformed-currency Ads row is still counted; rest of PPC intact");
});

async function main() {
  ({ assembleSources, runReportJobs } = await import("../lib/server/sync/report-worker.js"));
  ({ deriveReportSnapshot } = await import("../lib/server/sync/report-derivation.js"));
  ({ runSourceJobs } = await import("../lib/server/sync/source-worker.js"));
  ({ plannedSourceJob } = await import("../lib/server/sync/source-sync-driver.js"));
  ({ sourceJobOwnerId } = await import("../lib/server/source-identity.js"));
  ({ planPpcPerformance, planSalesMovers, buildShadowReportPlan, SHADOW_PLANNED_REPORT_KEYS } = await import("../lib/server/sync/report-planner.js"));
  ({ runPpcShadowCycle } = await import("../lib/server/sync/ppc-cycle.js"));
  ({ loadPersistedPpcAds, validatePpcAdsRows, ppcAdsCurrencySignalOf, makePpcAdsContextLoader, validatePpcSourceCoverage, evaluateSourceCoverage } = await import("../lib/server/sync/ppc-ads-loader.js"));
  ({ ppcPerformancePayload, normalizePpcCoverageReason, PPC_COVERAGE_REASON_CODES } = await import("../lib/server/reports/derivation-core.js"));
  ({ addDaysStr, canonicalOliSlices } = await import("../lib/server/date-windows.js"));
  FROM = addDaysStr(ASOF, -29);

  let failures = 0;
  for (const t of tests) {
    if (t.marker) { out("\n# " + t.marker); continue; }
    try { await t.fn(); passed += 1; out("  ok  " + t.name); }
    catch (err) { failures += 1; out("FAIL  " + t.name); out(String(err && err.stack ? err.stack : err)); }
  }
  out("\n" + passed + " assertions passed");
  return failures;
}

main().then((failures) => { if (failures) process.exitCode = 1; }).catch((err) => { out("FATAL " + String(err && err.stack ? err.stack : err)); process.exitCode = 1; });
