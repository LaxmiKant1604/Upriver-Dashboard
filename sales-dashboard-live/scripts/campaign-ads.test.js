// Campaign Ads DORMANT-FEATURE regressions (offline; ZERO network/DB/DataDoe). Covers: region routing + future-account
// auto-assignment + deterministic 5-seller batching + zero-create dry-run planner; the pure view model (KPIs,
// currency isolation, mapped/Unmapped conservation, brand projection); and the VIEWING API (account+brand authz, NOT
// capability; no leak for a restricted viewer). 7-bit ASCII, LF.
import assert from "node:assert/strict";
import { writeSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { assertAccountAccess } from "../lib/server/supabase.js";
import { handler } from "../api/campaign-ads.js";
import {
  regionForMarketplace, routeAccounts, batchAccounts, planCampaignRun, REGIONS, REGION_SCHEDULE, CAMPAIGN_WINDOWS,
} from "../lib/server/sync/campaign-region-routing.js";
import { buildCampaignAdsView, summarizeCampaignAds, projectCampaignsForScope, campaignKpis } from "../lib/server/reports/campaign-ads.js";

let passed = 0;
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const fakeRes = () => ({ statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } });

/* ================= region routing + batching + planner ================= */

test("RR1. marketplace -> region (IN / Europe+AU / US+CA / unassigned)", () => {
  assert.equal(regionForMarketplace("IN"), REGIONS.INDIA);
  for (const m of ["GB", "UK", "DE", "FR", "IT", "ES", "NL", "BE", "SE", "PL", "IE", "AT", "AU"]) assert.equal(regionForMarketplace(m), REGIONS.EUROPE_AU, m);
  assert.equal(regionForMarketplace("US"), REGIONS.US_CA); assert.equal(regionForMarketplace("CA"), REGIONS.US_CA);
  assert.equal(regionForMarketplace("JP"), REGIONS.UNASSIGNED); assert.equal(regionForMarketplace(""), REGIONS.UNASSIGNED);
  passed += 1;
});

test("RR2. routeAccounts groups + isolates UNASSIGNED; future account auto-routes on recompute", () => {
  const accounts = [{ accountId: "a3", marketplace: "US" }, { accountId: "a1", marketplace: "IN" }, { accountId: "a2", marketplace: "DE" }, { accountId: "a4", marketplace: "JP" }];
  const { byRegion, unassigned } = routeAccounts(accounts);
  assert.deepEqual(byRegion[REGIONS.INDIA].map((a) => a.accountId), ["a1"]);
  assert.deepEqual(byRegion[REGIONS.EUROPE_AU].map((a) => a.accountId), ["a2"]);
  assert.deepEqual(byRegion[REGIONS.US_CA].map((a) => a.accountId), ["a3"]);
  assert.deepEqual(unassigned.map((a) => a.accountId), ["a4"]);
  // a newly connected AU seller auto-routes when the list is re-passed (routing is recomputed every run).
  const later = routeAccounts([...accounts, { accountId: "a5", marketplace: "AU" }]);
  assert.deepEqual(later.byRegion[REGIONS.EUROPE_AU].map((a) => a.accountId), ["a2", "a5"]);
  passed += 1;
});

test("RR3. deterministic <=5-seller batching regardless of marketplace", () => {
  const accts = ["s5", "s1", "s3", "s2", "s4", "s6", "s7"].map((id, i) => ({ accountId: id, marketplace: i % 2 ? "DE" : "GB" }));
  const batches = batchAccounts(accts, 5);
  assert.equal(batches.length, 2);
  assert.deepEqual(batches[0].allowlist, ["s1", "s2", "s3", "s4", "s5"]); // sorted, first 5
  assert.deepEqual(batches[1].allowlist, ["s6", "s7"]);
  assert.ok(batches.every((b) => b.accounts.length <= 5));
  passed += 1;
});

test("RR4. planCampaignRun: export count = batch count; max spend = exports x price; unproven price -> refuse", () => {
  const accounts = [];
  for (let i = 0; i < 7; i += 1) accounts.push({ accountId: `us${i}`, marketplace: "US" });      // 2 US batches
  for (let i = 0; i < 3; i += 1) accounts.push({ accountId: `in${i}`, marketplace: "IN" });        // 1 IN batch
  accounts.push({ accountId: "zz", marketplace: "JP" });                                            // unassigned (no export)
  const priced = planCampaignRun({ accounts, runKind: "initial", tokenPrice: 2 });
  assert.equal(priced.exportCount, 3, "2 US + 1 IN batches");
  assert.equal(priced.windowDays, CAMPAIGN_WINDOWS.initialDays);
  assert.equal(priced.maxTokenSpend, 6, "3 exports x 2 tokens");
  assert.equal(priced.unassigned.length, 1);
  assert.equal(priced.createReady, true);
  const unpriced = planCampaignRun({ accounts, runKind: "initial", tokenPrice: null });
  assert.equal(unpriced.maxTokenSpend, null); assert.equal(unpriced.createReady, false, "unproven price -> not create-ready");
  passed += 1;
});

test("RR5. schedule times match the spec (UTC + watchdog +20m)", () => {
  assert.equal(REGION_SCHEDULE[REGIONS.INDIA].primaryUtc, "03:00"); assert.equal(REGION_SCHEDULE[REGIONS.INDIA].watchdogUtc, "03:20");
  assert.equal(REGION_SCHEDULE[REGIONS.EUROPE_AU].primaryUtc, "08:30"); assert.equal(REGION_SCHEDULE[REGIONS.EUROPE_AU].watchdogUtc, "08:50");
  assert.equal(REGION_SCHEDULE[REGIONS.US_CA].primaryUtc, "16:30"); assert.equal(REGION_SCHEDULE[REGIONS.US_CA].watchdogUtc, "16:50");
  passed += 1;
});

/* ================= view model ================= */

const rowsA = () => [
  { marketplace_country_code: "US", campaign_id: "C1", campaign_type: "SP", currency: "USD", metric_date: "2026-08-10", dimensions: { amazon_ads_profile_id: "P1", ad_campaign_name: "Old", ad_campaign_status: "enabled" }, metrics: { ad_spend: 100, ad_sales: 400, ad_orders: 10, ad_units_sold: 12, ad_impressions: 1000, ad_clicks: 50 } },
  { marketplace_country_code: "US", campaign_id: "C1", campaign_type: "SP", currency: "USD", metric_date: "2026-08-11", dimensions: { amazon_ads_profile_id: "P1", ad_campaign_name: "Renamed", ad_campaign_status: "paused" }, metrics: { ad_spend: 50, ad_sales: 100, ad_orders: 5, ad_units_sold: 6, ad_impressions: 500, ad_clicks: 25 } },
  { marketplace_country_code: "US", campaign_id: "C2", campaign_type: "SB", currency: "USD", metric_date: "2026-08-10", dimensions: { amazon_ads_profile_id: "P1", ad_campaign_name: "Bravo" }, metrics: { ad_spend: 200, ad_sales: 600, ad_orders: 20, ad_units_sold: 24, ad_impressions: 2000, ad_clicks: 100 } },
  { marketplace_country_code: "US", campaign_id: "C3", campaign_type: "SP", currency: "USD", metric_date: "2026-08-10", dimensions: { amazon_ads_profile_id: "P1", ad_campaign_name: "Unmapped" }, metrics: { ad_spend: 80, ad_sales: 160, ad_orders: 8, ad_units_sold: 9, ad_impressions: 800, ad_clicks: 40 } },
  { marketplace_country_code: "GB", campaign_id: "C4", campaign_type: "SP", currency: "GBP", metric_date: "2026-08-10", dimensions: { amazon_ads_profile_id: "P9", ad_campaign_name: "UK" }, metrics: { ad_spend: 300, ad_sales: 900, ad_orders: 30, ad_units_sold: 36, ad_impressions: 3000, ad_clicks: 150 } },
];
const mapsA = () => [
  { marketplace: "US", ads_profile_id: "P1", ad_campaign_id: "C1", canonical_brand_key: "acme", brand_display_name: "Acme", mapping_source: "MANUAL", updated_at: "t" },
  { marketplace: "US", ads_profile_id: "P1", ad_campaign_id: "C2", canonical_brand_key: "bravo", brand_display_name: "Bravo", mapping_source: "MANUAL", updated_at: "t" },
];

test("VM1. KPIs from summed metrics; identity stable across rename", () => {
  const v = buildCampaignAdsView({ durableRows: rowsA(), mappingRows: mapsA() });
  const c1 = v.campaigns.find((c) => c.campaignId === "C1");
  assert.equal(c1.campaignName, "Renamed", "latest name"); assert.equal(c1.spend, 150); assert.equal(c1.sales, 500);
  assert.equal(c1.roas, 500 / 150); assert.equal(c1.acos, 150 / 500); assert.equal(c1.ctr, 75 / 1500); assert.equal(c1.cpc, 150 / 75); assert.equal(c1.cvr, 15 / 75);
  assert.equal(c1.brandKey, "acme"); assert.equal(c1.mapped, true);
  passed += 1;
});

test("VM2. div-by-zero KPIs are null (never fabricated)", () => {
  const k = campaignKpis({ ad_spend: 0, ad_sales: 0, ad_orders: 0, ad_units_sold: 0, ad_impressions: 0, ad_clicks: 0 });
  assert.equal(k.ctr, null); assert.equal(k.cpc, null); assert.equal(k.cvr, null); assert.equal(k.roas, null); assert.equal(k.acos, null);
  passed += 1;
});

test("VM3. currency isolation + mapped/Unmapped conservation (per currency)", () => {
  const s = summarizeCampaignAds(buildCampaignAdsView({ durableRows: rowsA(), mappingRows: mapsA() }));
  const usd = s.byCurrency.USD, gbp = s.byCurrency.GBP;
  assert.equal(usd.account.spend, 430); assert.equal(usd.account.sales, 1260);
  assert.equal(usd.unmapped.spend, 80); assert.equal(usd.unmapped.sales, 160);
  const acme = usd.brands.find((b) => b.brandKey === "acme"), bravo = usd.brands.find((b) => b.brandKey === "bravo");
  assert.equal(acme.spend, 150); assert.equal(bravo.spend, 200);
  assert.equal(usd.conservationOk, true, "account == mapped + unmapped (USD)");
  assert.equal(gbp.account.spend, 300, "GBP isolated, never combined with USD");
  assert.ok(!("USDGBP" in s.byCurrency), "currencies never merged");
  passed += 1;
});

test("VM4. projectCampaignsForScope: NAMED / ALL_PERMITTED exclude Unmapped + other brands", () => {
  const v = buildCampaignAdsView({ durableRows: rowsA(), mappingRows: mapsA() });
  assert.deepEqual(projectCampaignsForScope(v.campaigns, { mode: "NAMED", requestedKey: "acme" }).map((c) => c.campaignId), ["C1"]);
  assert.deepEqual(projectCampaignsForScope(v.campaigns, { mode: "ALL_PERMITTED", permittedKeys: ["acme"] }).map((c) => c.campaignId).sort(), ["C1"]);
  assert.equal(projectCampaignsForScope(v.campaigns, { mode: "ALL" }).length, 4);
  passed += 1;
});

test("VM5. empty durable history -> empty view (no fabrication)", () => {
  const v = buildCampaignAdsView({ durableRows: [], mappingRows: [] });
  assert.deepEqual(v.campaigns, []);
  assert.deepEqual(summarizeCampaignAds(v).byCurrency, {});
  passed += 1;
});

/* ================= serving API (account + brand authz; NOT capability) ================= */

function apiDeps(over = {}) {
  return {
    getDashboardAccess: async () => over.access || { userId: "u1", email: "u@x.com", role: "member", accountIds: ["A"], accountGrants: { A: { mode: "ALL_BRANDS" } } },
    assertAccountAccess,
    orgFingerprint: () => "org-fp",
    getCampaignPerformanceRows: async () => (over.durable !== undefined ? over.durable : rowsA()),
    getCampaignBrandMappings: async () => (over.maps !== undefined ? over.maps : mapsA()),
    getTrustedAccountBrands: async () => over.trusted || [{ key: "acme", display: "Acme" }, { key: "bravo", display: "Bravo" }],
  };
}

test("API1. no account access -> 403", async () => {
  const res = fakeRes();
  await handler({ method: "GET", query: { accountId: "B" } }, res, apiDeps({ access: { userId: "u1", role: "member", accountIds: ["A"], accountGrants: {} } }));
  assert.equal(res.statusCode, 403);
  passed += 1;
});

test("API2. viewing needs NO mapping capability: an account+brand user (no capability) sees the account view", async () => {
  const res = fakeRes();
  await handler({ method: "GET", query: { accountId: "A" } }, res, apiDeps());
  assert.equal(res.statusCode, 200); assert.equal(res.body.restricted, false);
  assert.equal(res.body.campaigns.length, 4); assert.equal(res.body.summary.byCurrency.USD.account.spend, 430);
  assert.equal(res.body.summary.byCurrency.USD.conservationOk, true);
  passed += 1;
});

test("API3. SELECTED_BRANDS viewer sees ONLY permitted-brand campaigns; no Unmapped/other-brand leak", async () => {
  const res = fakeRes();
  await handler({ method: "GET", query: { accountId: "A" } }, res, apiDeps({ access: { userId: "u2", role: "member", accountIds: ["A"], accountGrants: { A: { mode: "SELECTED_BRANDS", brandKeys: ["acme"] } } } }));
  assert.equal(res.statusCode, 200); assert.equal(res.body.restricted, true);
  assert.deepEqual(res.body.campaigns.map((c) => c.campaignId), ["C1"]);
  assert.equal(res.body.summary.byCurrency.USD.account.spend, 150, "scoped account total = permitted only (no leak)");
  assert.ok(!res.body.summary.byCurrency.GBP, "no access to the GBP unmapped campaign");
  passed += 1;
});

test("API4. empty history -> hasData false, empty campaigns (no fabrication)", async () => {
  const res = fakeRes();
  await handler({ method: "GET", query: { accountId: "A" } }, res, apiDeps({ durable: [], maps: [] }));
  assert.equal(res.statusCode, 200); assert.equal(res.body.hasData, false); assert.deepEqual(res.body.campaigns, []);
  passed += 1;
});

/* ================= frontend dormancy + no-blink + cutover-safety invariants ================= */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FLAGS = readFileSync(join(ROOT, "src/lib/feature-flags.js"), "utf8");
const VIEW = readFileSync(join(ROOT, "src/views/CampaignAds.jsx"), "utf8");
const SHELL = readFileSync(join(ROOT, "src/components/shell.jsx"), "utf8");
const APP = readFileSync(join(ROOT, "src/App.jsx"), "utf8");
const APIVIEW = readFileSync(join(ROOT, "api/campaign-ads.js"), "utf8");
const SRC = readFileSync(join(ROOT, "src/lib/daily-metrics.js"), "utf8");

test("FE1. the tab is DORMANT: flag defaults false; nav + render both gate on it", () => {
  assert.ok(/CAMPAIGN_ADS_TAB = false/.test(FLAGS), "flag default false");
  assert.ok(/CAMPAIGN_ADS_TAB \? \[\{ view: "campaign-ads"/.test(SHELL), "nav item flag-gated");
  assert.ok(/view === "campaign-ads" && CAMPAIGN_ADS_TAB &&/.test(APP), "render flag-gated");
  passed += 1;
});

test("FE2. campaign rows keyed by STABLE identity + stale-response guard (no blink)", () => {
  assert.ok(/key=\{`\$\{c\.campaignId\}\|\$\{c\.marketplace\}\|\$\{c\.adsProfileId\}`\}/.test(VIEW), "row key is the campaign identity, not a filter/date");
  assert.ok(/reqRef/.test(VIEW), "stale-response guard present");
  passed += 1;
});

test("FE3. viewing serving path does NOT require the mapping capability + never calls DataDoe", () => {
  assert.ok(!/getCampaignMappingCapability/.test(APIVIEW), "viewing is not capability-gated");
  assert.ok(/assertAccountAccess/.test(APIVIEW), "viewing requires account access");
  const code = APIVIEW.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(!/from "\.\.\/lib\/server\/datadoe\.js"|createExport|runExport|runAdsSync/.test(code), "no DataDoe export path");
  passed += 1;
});

test("FE4. ASIN Ads is UNTOUCHED (cutover deferred): existing reports still read asin-performance-v1", () => {
  // This DORMANT phase must NOT remove ASIN consumers. The Daily formula note still documents ASIN Ads.
  assert.ok(/asin-performance-v1/.test(SRC), "Daily still documents ASIN Ads (no cutover this phase)");
  passed += 1;
});

/* ================= run ================= */
let failures = 0;
(async () => {
  out("campaign-ads");
  for (const t of tests) { try { await t.fn(); out("  ok  " + t.name); } catch (e) { failures += 1; out("FAIL  " + t.name); out(String((e && e.stack) || e)); } }
  out("\n" + passed + " groups passed" + (failures ? ", " + failures + " FAILED" : ""));
  if (failures) process.exitCode = 1;
})();
