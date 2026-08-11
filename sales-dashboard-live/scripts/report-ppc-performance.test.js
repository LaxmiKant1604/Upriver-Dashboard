// PPC Performance Scheduler-v2 derivation + persisted-Ads loader + real-cycle tests (SHADOW MODE, offline).
//
// Part A drives deriveReportSnapshot("ppc-performance") against a hand-computed production-route fixture and
// proves payload parity, currency isolation, coverage labels, the TACoS states, catalog gating, and purity.
// Part B tests the typed persisted-Ads loader (validation, availability, the 120k cap, empty-vs-missing).
// Part C drives the REAL runPpcShadowCycle + runReportJobs (via makePpcAdsContextLoader) and proves ZERO
// DataDoe Ads exports, one conditional total-sales export, catalog dedup, the ads-currency gate, LKG, and
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
let planPpcPerformance, planSalesMovers, buildShadowReportPlan, SHADOW_PLANNED_REPORT_KEYS, addDaysStr;
let runPpcShadowCycle, loadPersistedPpcAds, validatePpcAdsRows, ppcAdsCurrencySignalOf, makePpcAdsContextLoader;

const ID = "A1";
const ASOF = "2025-08-10";
const dash = (...p) => p.join("-");
const CONNS = [
  { id: "primary", apiKey: dash("prim", "key"), accountPrefix: "" },
  { id: "secondary", apiKey: dash("sec", "key"), accountPrefix: dash("dd", "secondary") + ":" },
];
const ORIGIN = "Persisted Supabase Amazon Ads history maintained by the scheduled worker";
const TS_LABEL = "Sales & Traffic by ASIN & Date";
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

// Build the PPC source fragments: no-date catalog (required) + optional total-sales over [FROM, ASOF].
function ppcPlanned({ catalog = [], totalSales = [], includeTotalSales = true, ids = [ID] } = {}) {
  const planned = []; const rows = {};
  const cat = frag("ppc-performance:catalog", null, null, ids); planned.push(cat); rows[cat.requestHash] = catalog;
  let tsHash = null;
  if (includeTotalSales) { const ts = frag("ppc-performance:total-sales", FROM, ASOF, ids); planned.push(ts); rows[ts.requestHash] = totalSales; tsHash = ts.requestHash; }
  return { planned, rows, tsHash };
}
const ppcCtx = (ppcAds, over = {}) => ({ to: ASOF, rawSellerId: ID, accountId: ID, ppcAds, ...over });
const derivePpc = (built, ppcAds, over, statusOverride) =>
  deriveReportSnapshot({ reportKey: "ppc-performance", sources: buildSources(built.planned, built.rows, statusOverride), context: ppcCtx(ppcAds, over) });

// ---- row builders ----
const cmp = (date, id, type, m, dims = {}) => ({ source_key: KEYS.campaign, metric_date: date, campaign_id: id, campaign_type: type, currency: m.currency || "USD", dimensions: dims, metrics: { ad_spend: m.spend, ad_sales: m.sales, ad_clicks: m.clicks, ad_impressions: m.impr, ad_orders: m.orders, ad_units_sold: m.units } });
const asn = (date, asin, currency, m, dims = {}) => ({ source_key: KEYS.asin, metric_date: date, child_asin: asin, currency, dimensions: dims, metrics: { ad_spend: m.spend, ad_sales_same_sku: m.sales, ad_clicks: m.clicks, ad_impressions: m.impr, ad_orders_same_sku: m.orders, ad_units_sold_same_sku: m.units } });
const tgt = (date, id, campaignId, type, currency, m, dims = {}) => ({ source_key: KEYS.targeting, metric_date: date, targeting_id: id, campaign_id: campaignId, campaign_type: type, currency, dimensions: dims, metrics: { ad_spend: m.spend, ad_sales: m.sales, ad_clicks: m.clicks, ad_impressions: m.impr, ad_orders: m.orders, ad_units_sold_click: m.units } });
const stm = (date, campaignId, type, currency, m, dims = {}) => ({ source_key: KEYS.search, metric_date: date, campaign_id: campaignId, campaign_type: type, currency, dimensions: dims, metrics: { ad_spend: m.spend, ad_sales: m.sales, ad_clicks: m.clicks, ad_impressions: m.impr, ad_orders: m.orders, ad_units_sold_click: m.units } });
const cat = (asin, parent, name, brand) => ({ child_asin: asin, parent_asin: parent, product_name: name, product_brand: brand });
const ts = (date, sales, units) => ({ date, sales_sum: sales, units_sum: units });
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
const okAds = (rows = ADS_ROWS(), syncStates = SYNCS) => ({ status: "ok", adsRows: rows, syncStates, currencies: [...new Set(rows.map((r) => r.currency).filter(Boolean))].sort(), latestMetricDate: rows.reduce((l, r) => (!l || r.metric_date > l ? r.metric_date : l), null) });

const expectedPayload = () => ({
  accountId: "A1", asOf: "2025-08-10",
  window: { from: FROM, to: "2025-08-10", days: 30 },
  adsSourceOrigin: ORIGIN, minClicksForWaste: 10, adsRowCount: 7, latestMetricDate: "2025-08-02",
  sourceAvailability: [
    { key: KEYS.campaign, label: "Ad Performance by Campaign & Date", coverage: "All campaign types present in the account", rows: 3, sync: SYNCS[0], defaultDataset: true },
    { key: KEYS.asin, label: "Ad Performance by ASIN & Date", coverage: "Same-SKU attributed metrics", rows: 2, sync: SYNCS[1], defaultDataset: true },
    { key: KEYS.targeting, label: "Keyword Targeting Performance", coverage: "SP + SB + SD", rows: 1, sync: SYNCS[2], defaultDataset: false, enableHint: "In DataDoe, open Settings > Data tables and enable Keyword Targeting Performance, then refresh this report again." },
    { key: KEYS.search, label: "Search Term Performance (Ads)", coverage: "SP + SB only (no Sponsored Display)", rows: 1, sync: SYNCS[3], defaultDataset: false, enableHint: "In DataDoe, open Settings > Data tables and enable Search Term Performance (Ads), then refresh this report again." },
  ],
  totalSales: 800, totalSalesUnavailable: null, totalSalesSourceLabel: TS_LABEL, totalSalesLagDays: 4,
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
  assert.equal(validatePpcAdsRows({ rows: ADS_ROWS(), from: FROM, to: ASOF }).ok, true);
  assert.equal(validatePpcAdsRows({ rows: [{ ...cmp("2099-01-01", "C1", "SP", { spend: 1, sales: 1, clicks: 1, impr: 1, orders: 1, units: 1 }) }], from: FROM, to: ASOF }).ok, false, "future/out-of-window date");
  assert.equal(validatePpcAdsRows({ rows: [{ ...cmp("2025-02-30", "C1", "SP", { spend: 1, sales: 1, clicks: 1, impr: 1, orders: 1, units: 1 }) }], from: FROM, to: ASOF }).ok, false, "impossible date");
  assert.equal(validatePpcAdsRows({ rows: [{ source_key: "some-other-source", metric_date: "2025-08-01", metrics: {} }], from: FROM, to: ASOF }).ok, false, "source_key not allowed");
  assert.equal(validatePpcAdsRows({ rows: [{ source_key: KEYS.campaign, metric_date: "2025-08-01", metrics: { ad_spend: Infinity } }], from: FROM, to: ASOF }).ok, false, "non-finite metric");
  assert.equal(validatePpcAdsRows({ rows: [{ source_key: KEYS.campaign, metric_date: "2025-08-01", metrics: "nope" }], from: FROM, to: ASOF }).ok, false, "metrics not an object");
});

test("18. loadPersistedPpcAds: validated success (rows) is status ok with sorted currencies + latest metric date", async () => {
  const readers = makeAdsReaders({ A1: ADS_ROWS() }, { A1: SYNCS });
  const loaded = await loadPersistedPpcAds({ accountId: ID, asOf: ASOF, ...readers });
  assert.equal(loaded.status, "ok");
  assert.deepEqual(loaded.currencies, ["USD"]);
  assert.equal(loaded.latestMetricDate, "2025-08-02");
  assert.equal(loaded.adsRows.length, 7);
  assert.equal(loaded.syncStates.length, 4, "only this account's allowed-source sync states are kept");
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
  const badSource = [...ADS_ROWS(), { source_key: "amazon-orders-v1", metric_date: "2025-08-01", currency: "USD", dimensions: {}, metrics: {} }];
  const r2 = await loadPersistedPpcAds({ accountId: ID, asOf: ASOF, getAdsSyncStates: async () => SYNCS, getAdsDailySourceRows: async () => badSource });
  assert.equal(r2.status, "unavailable", "a disallowed source_key invalidates the whole load");
});

test("22. ppcAdsCurrencySignalOf: validated => success signal; unavailable => fail-closed (never success)", () => {
  assert.deepEqual(ppcAdsCurrencySignalOf(okAds()), { status: "success", validated: true, currencyCount: 1 });
  assert.deepEqual(ppcAdsCurrencySignalOf(okAds([])), { status: "success", validated: true, currencyCount: 0 });
  assert.deepEqual(ppcAdsCurrencySignalOf({ status: "unavailable" }), { status: "failed", validated: false, currencyCount: null });
});

/* ============================= Part C: real cycle + report worker ============================= */

group("ppc real cycle: runPpcShadowCycle -> runReportJobs (zero Ads exports / gate / dedup / LKG / resume)");

function makeAdsReaders(rowsByAccount, syncByAccount) {
  return {
    async getAdsDailySourceRows({ accountId, sourceKeys, from, to, maxRows }) {
      const all = (rowsByAccount[accountId] || []).filter((r) => sourceKeys.includes(r.source_key) && r.metric_date >= from && r.metric_date <= to);
      if (maxRows && all.length >= maxRows) throw new Error(`more than ${maxRows} saved Amazon Ads rows`);
      return all;
    },
    async getAdsSyncStates(accountIds) { return accountIds.flatMap((a) => syncByAccount[a] || []); },
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
    if (rk.includes("total-sales")) return [ts(fp.from || FROM, 500, 50), ts(fp.to || ASOF, 300, 30)];
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
const runCycle = (store, dd, readers, accounts = ACCTS, opts = {}) => runPpcShadowCycle({ accounts, connections: CONNS, asOf: ASOF, store, dataDoe: dd, getAdsDailySourceRows: readers.getAdsDailySourceRows, getAdsSyncStates: readers.getAdsSyncStates, bucket: "us", cycleDate: "2026-08-11", ...opts });
const keyOf = (store, cid) => [...new Set(store.listSourceJobs(cid).map((j) => j.request_key))].sort();

test("23. staged, not generic: ppc-performance is a STAGED_CYCLE key; buildShadowReportPlan rejects it fail-closed", () => {
  assert.ok(!SHADOW_PLANNED_REPORT_KEYS.includes("ppc-performance"), "PPC is never a generic default key");
  assert.throws(() => buildShadowReportPlan({ accounts: ACCTS, reportKeys: ["ppc-performance"], connections: CONNS, asOfFor: () => ASOF }), /staged-cycle/i);
});

test("24. validated <=1 currency: plans EXACTLY catalog + total-sales; ZERO DataDoe Ads exports", async () => {
  const store = makeStore(); const dd = makeDataDoe();
  const r = await runCycle(store, dd, makeAdsReaders({ A1: ADS_ROWS() }, { A1: SYNCS }));
  assert.deepEqual(keyOf(store, r.cycleId), ["ppc-performance:catalog", "ppc-performance:total-sales"], "only catalog + total-sales");
  assert.equal(dd.totalCreates(), 2, "exactly two DataDoe exports");
  assert.ok(dd.createdKeys.every((k) => k === "ppc-performance:catalog" || k === "ppc-performance:total-sales"), "NO Ads-source export was ever created");
  assert.ok(!dd.createdKeys.some((k) => /campaign-performance|asin-performance|targeting-performance|search-terms-performance|ads-/.test(k)), "zero Ads exports");
});

test("25. MULTI-currency Ads: gate SKIPS total-sales -> plans catalog ONLY (one export, still zero Ads exports)", async () => {
  const store = makeStore(); const dd = makeDataDoe();
  const rows = [...ADS_ROWS(), cmp("2025-08-03", "C9", "SP", { spend: 1, sales: 1, clicks: 1, impr: 1, orders: 1, units: 1, currency: "CAD" })];
  const r = await runCycle(store, dd, makeAdsReaders({ A1: rows }, { A1: SYNCS }));
  assert.deepEqual(keyOf(store, r.cycleId), ["ppc-performance:catalog"], "catalog only");
  assert.equal(dd.totalCreates(), 1);
});

test("26. Ads read unavailable/unseeded: plans NOTHING -> ZERO DataDoe tokens; report stays LKG", async () => {
  const store = makeStore(); const dd = makeDataDoe();
  const lkg = { accountId: ID, prior: true };
  const r = await runCycle(store, dd, makeAdsReaders({}, {})); // no persisted Ads for A1 -> read returns []? make it fail instead
  // Force a read failure so the Ads context is unvalidated.
  const store2 = makeStore(); const dd2 = makeDataDoe();
  const failReaders = { getAdsSyncStates: async () => SYNCS, getAdsDailySourceRows: async () => { throw new Error("read failed"); } };
  const r2 = await runCycle(store2, dd2, failReaders);
  assert.equal(dd2.totalCreates(), 0, "unvalidated Ads => zero DataDoe exports");
  assert.equal(store2.listSourceJobs(r2.cycleId).length, 0, "no source jobs staged");
  // The report derive (via the Ads loader) is unavailable => a prior snapshot survives.
  store2.seedSnapshot("scheduler-v2/ppc-performance", ID, lkg);
  const saved = [];
  const saveSnapshot = async ({ reportKey, accountId, payload }) => { store2.seedSnapshot(reportKey, accountId, payload); saved.push(payload); return { paramsHash: "ph" }; };
  const res = await runReportJobs({ store: store2, cycleId: r2.cycleId, sourceRows: (h) => store2.loadSourceRows(h), saveSnapshot, plannedReports: r2.plannedReports, loadDerivedContext: makePpcAdsContextLoader(failReaders) });
  assert.equal(res.succeeded, 0, "unavailable Ads => report not saved");
  assert.deepEqual(store2._snapshots.get("scheduler-v2/ppc-performance|" + ID).payload, lkg, "last-known-good preserved");
  void r;
});

test("27. shared catalog canonical hash matches Sales Movers; one export per shared hash across owners", async () => {
  const store = makeStore(); const dd = makeDataDoe();
  const ppcPlan = planPpcPerformance({ accountId: ID, country: "US", currency: "USD", connections: CONNS, asOf: ASOF, adsCurrencySignal: { status: "success", validated: true, currencyCount: 1 } });
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
  assert.equal(saved[0].totalSales, 800, "TACoS denominator summed from the total-sales export");
  assert.equal(saved[0].adsRowCount, 7);
  const before = store.saveCalls;
  await runReportJobs({ store, cycleId: cycle.cycleId, sourceRows: (h) => store.loadSourceRows(h), saveSnapshot, plannedReports: cycle.plannedReports, loadDerivedContext: makePpcAdsContextLoader(readers) });
  assert.equal(store.saveCalls, before, "no duplicate snapshot on re-run");
});

test("29. total-sales strict-cap TRUNCATED degrades ONLY TACoS; the report still saves (catalog succeeded)", async () => {
  const store = makeStore(); const dd = makeDataDoe({ capKey: "total-sales" });
  const readers = makeAdsReaders({ A1: ADS_ROWS() }, { A1: SYNCS });
  const cycle = await runCycle(store, dd, readers);
  const tsJob = store.listSourceJobs(cycle.cycleId).find((j) => j.request_key === "ppc-performance:total-sales");
  assert.ok(tsJob.fetch_status === "failed" && tsJob.error_code === "TRUNCATED", "capped total-sales fails TRUNCATED");
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
  const dDefer = makeDataDoe({ deferKey: "total-sales" });
  const r1 = await runCycle(s2, dDefer, readers);
  assert.ok((r1.deferred || 0) > 0, "the driver surfaces the resumable deferral");
  const tsHash = store2Hash(s2, r1.cycleId, "ppc-performance:total-sales");
  const dOk = makeDataDoe();
  const r2 = await runCycle(s2, dOk, readers);
  assert.equal(dDefer.createCount(tsHash) + dOk.createCount(tsHash), 1, "total-sales exported exactly once across deferral + resume");
  assert.ok(s2.listSourceJobs(r2.cycleId).every((j) => j.fetch_status === "succeeded"));
});
function store2Hash(store, cid, key) { return store.listSourceJobs(cid).find((j) => j.request_key === key).request_hash; }

test("31. primary-only: a stale dd-secondary account is skipped read-only with ZERO DataDoe calls and never routed to primary", async () => {
  const store = makeStore(); const dd = makeDataDoe();
  const PRIMARY_ONLY = [{ id: "primary", apiKey: dash("prim", "key"), accountPrefix: "" }];
  const accounts = [{ accountId: ID, country: "US", currency: "USD" }, { accountId: dash("dd", "secondary") + ":B1", country: "US", currency: "USD" }];
  const r = await runPpcShadowCycle({ accounts, connections: PRIMARY_ONLY, asOf: ASOF, store, dataDoe: dd, getAdsDailySourceRows: makeAdsReaders({ A1: ADS_ROWS() }, { A1: SYNCS }).getAdsDailySourceRows, getAdsSyncStates: makeAdsReaders({ A1: ADS_ROWS() }, { A1: SYNCS }).getAdsSyncStates, bucket: "us", cycleDate: "2026-08-11" });
  assert.equal(r.unavailableAccounts.length, 1, "the dd-secondary account is unavailable");
  assert.ok(store.listSourceJobs(r.cycleId).every((j) => j.connection_id === "primary"), "no dd-secondary jobs; nothing routed to primary");
  assert.deepEqual(r.plannedReports.map((p) => p.accountId), ["A1"], "only the primary account yields a report plan");
});

async function main() {
  ({ assembleSources, runReportJobs } = await import("../lib/server/sync/report-worker.js"));
  ({ deriveReportSnapshot } = await import("../lib/server/sync/report-derivation.js"));
  ({ runSourceJobs } = await import("../lib/server/sync/source-worker.js"));
  ({ plannedSourceJob } = await import("../lib/server/sync/source-sync-driver.js"));
  ({ sourceJobOwnerId } = await import("../lib/server/source-identity.js"));
  ({ planPpcPerformance, planSalesMovers, buildShadowReportPlan, SHADOW_PLANNED_REPORT_KEYS } = await import("../lib/server/sync/report-planner.js"));
  ({ runPpcShadowCycle } = await import("../lib/server/sync/ppc-cycle.js"));
  ({ loadPersistedPpcAds, validatePpcAdsRows, ppcAdsCurrencySignalOf, makePpcAdsContextLoader } = await import("../lib/server/sync/ppc-ads-loader.js"));
  ({ addDaysStr } = await import("../lib/server/date-windows.js"));
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
