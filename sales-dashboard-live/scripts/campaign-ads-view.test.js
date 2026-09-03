// Campaign Ads consolidated workspace -- client view logic (src/lib/campaign-ads-view.js) + the consolidation seams.
//
// Proves the M8 contract: the browser re-windows the durable per-campaign `daily` breakdown to 7D/14D/30D/custom with
// NO refetch and NO DataDoe, and its per-range totals EQUAL the server's own buildCampaignAdsView totals for that same
// [from,to]; formulas emit an em dash (null) on a zero denominator (never Infinity/NaN); currencies never combine;
// windows anchor on the latest proven date and clamp to coverage; wasted-spend classification is deterministic and
// reuses the PPC MIN_CLICKS threshold. Also asserts the PPC->Campaign Ads consolidation seams in App.jsx + shell.jsx.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  resolveWindow, windowCampaigns, summarizeWindow, classifyWaste, campaignKpisFromMetrics,
  CAMPAIGN_WASTE_THRESHOLDS, CAMPAIGN_DATE_PRESETS,
} from "../src/lib/campaign-ads-view.js";
import { buildCampaignAdsView, campaignKpis } from "../lib/server/reports/campaign-ads.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);
let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log(`  ok  ${name}`); }

// ---- Synthetic durable rows (the shape ads_daily_source_rows / campaign-performance-v1 yields) ----
const row = (campaignId, mkt, date, currency, spend, sales, orders, units, impr, clicks, extra = {}) => ({
  campaign_id: campaignId, marketplace_country_code: mkt, metric_date: date, currency, campaign_type: extra.type || "SPONSORED_PRODUCTS",
  dimensions: { ad_campaign_id: campaignId, ad_campaign_name: extra.name || `Campaign ${campaignId}`, amazon_ads_profile_id: extra.profile || "P1", ad_campaign_status: extra.status || "ENABLED", ad_campaign_type: extra.type || "SPONSORED_PRODUCTS" },
  metrics: { ad_spend: spend, ad_sales: sales, ad_orders: orders, ad_units_sold: units, ad_impressions: impr, ad_clicks: clicks },
});

// A: US/USD converting campaign over three days. B: US/USD spend-with-zero-sales (waste) + clicks-no-orders.
// C: DE/EUR (currency isolation). D: US/USD high-ACoS + low-ROAS (review, not definite waste).
const DUR = [
  row("A", "US", "2026-09-01", "USD", 10, 40, 4, 4, 1000, 50),
  row("A", "US", "2026-09-02", "USD", 12, 60, 6, 6, 1200, 60),
  row("A", "US", "2026-09-03", "USD", 8, 20, 2, 2, 800, 40),
  row("B", "US", "2026-09-02", "USD", 15, 0, 0, 0, 900, 30),   // spend, zero sales -> wasted; 30 clicks, 0 orders
  row("B", "US", "2026-09-03", "USD", 9, 0, 0, 0, 400, 12),
  row("C", "DE", "2026-09-02", "EUR", 20, 100, 5, 5, 2000, 80, { profile: "P2" }),
  row("C", "DE", "2026-09-03", "EUR", 5, 25, 1, 1, 500, 20, { profile: "P2" }),
  row("D", "US", "2026-09-03", "USD", 30, 40, 2, 2, 1500, 70), // ACoS 0.75 > 0.5, ROAS 1.33 < 2 -> review
];
const MAP = [
  { ad_campaign_id: "A", marketplace: "US", ads_profile_id: "P1", canonical_brand_key: "acme", brand_display_name: "Acme" },
  { ad_campaign_id: "D", marketplace: "US", ads_profile_id: "P1", canonical_brand_key: "acme", brand_display_name: "Acme" },
];

const serverView = buildCampaignAdsView({ durableRows: DUR, mappingRows: MAP, from: null, to: null });

// ---------------------------------------------------------------------------
test("resolveWindow: 7D is the default preset and anchors on the latest proven date", () => {
  assert.equal(CAMPAIGN_DATE_PRESETS[0].key, "7D");
  const w = resolveWindow({ preset: "7D", latestProvenDate: "2026-09-20", minDate: "2026-01-01" });
  assert.deepEqual(w, { from: "2026-09-14", to: "2026-09-20", clamped: false }); // 7 inclusive days ending latest
});

test("resolveWindow: 14D / 30D widths are inclusive and end on the latest proven date", () => {
  assert.deepEqual(resolveWindow({ preset: "14D", latestProvenDate: "2026-09-20", minDate: "2026-01-01" }), { from: "2026-09-07", to: "2026-09-20", clamped: false });
  assert.deepEqual(resolveWindow({ preset: "30D", latestProvenDate: "2026-09-20", minDate: "2026-01-01" }), { from: "2026-08-22", to: "2026-09-20", clamped: false });
});

test("resolveWindow: clamps to coverage and never anchors on the browser clock", () => {
  // A 30D preset on only 3 days of history clamps `from` up to minDate (honest, not fabricated).
  const w = resolveWindow({ preset: "30D", latestProvenDate: "2026-09-03", minDate: "2026-09-01" });
  assert.equal(w.from, "2026-09-01"); assert.equal(w.to, "2026-09-03"); assert.equal(w.clamped, true);
  // Custom beyond the proven latest is pulled back to it; earlier than minDate is pulled up.
  const c = resolveWindow({ preset: "CUSTOM", customFrom: "2020-01-01", customTo: "2099-01-01", latestProvenDate: "2026-09-03", minDate: "2026-09-01" });
  assert.deepEqual(c, { from: "2026-09-01", to: "2026-09-03", clamped: true });
  // No proven date -> no window (nothing loaded yet).
  assert.deepEqual(resolveWindow({ preset: "7D", latestProvenDate: null }), { from: null, to: null, clamped: false });
});

test("windowCampaigns per-range totals EQUAL the server buildCampaignAdsView totals (zero refetch parity)", () => {
  for (const [from, to] of [["2026-09-01", "2026-09-03"], ["2026-09-02", "2026-09-03"], ["2026-09-03", "2026-09-03"], ["2026-09-01", "2026-09-01"]]) {
    const clientWin = windowCampaigns(serverView.campaigns, from, to);
    const serverWin = buildCampaignAdsView({ durableRows: DUR, mappingRows: MAP, from, to });
    const byId = new Map(clientWin.map((c) => [`${c.campaignId}|${c.marketplace}|${c.adsProfileId}`, c]));
    for (const s of serverWin.campaigns) {
      const c = byId.get(`${s.campaignId}|${s.marketplace}|${s.adsProfileId}`);
      assert.ok(c, `client window ${from}..${to} has campaign ${s.campaignId}`);
      for (const k of ["spend", "sales", "orders", "units", "impressions", "clicks"]) assert.equal(c[k], s[k], `${s.campaignId} ${k} matches server for ${from}..${to}`);
      // KPIs match too (same formulas, both null on zero denominator).
      for (const k of ["ctr", "cpc", "cvr", "roas", "acos"]) assert.equal(c[k], s[k], `${s.campaignId} ${k} KPI matches`);
    }
    assert.equal(clientWin.length, serverWin.campaigns.length, `same campaign count for ${from}..${to}`);
  }
});

test("windowCampaigns drops campaigns with no rows in the window (never a fabricated zero)", () => {
  // D only has a 2026-09-03 row; a 09-01..09-01 window must NOT include it.
  const w = windowCampaigns(serverView.campaigns, "2026-09-01", "2026-09-01");
  assert.ok(!w.some((c) => c.campaignId === "D"), "D absent from a window where it had no activity");
  assert.ok(!w.some((c) => c.campaignId === "B"), "B absent (its first row is 09-02)");
});

test("KPI formulas: em dash (null) on a zero denominator, never Infinity/NaN", () => {
  const k = campaignKpisFromMetrics({ spend: 0, sales: 0, orders: 0, units: 0, impressions: 0, clicks: 0 });
  for (const key of ["ctr", "cpc", "cvr", "roas", "acos"]) assert.equal(k[key], null, `${key} is null when denominator is 0`);
  // ROAS is defined (spend>0) but ACoS null (sales==0) for a wasted campaign.
  const wasted = campaignKpisFromMetrics({ spend: 24, sales: 0, orders: 0, units: 0, impressions: 1300, clicks: 42 });
  assert.equal(wasted.acos, null); assert.equal(wasted.roas, 0); assert.equal(wasted.cvr, 0);
  // Parity with the server KPI helper.
  const srv = campaignKpis({ ad_spend: 24, ad_sales: 0, ad_orders: 0, ad_units_sold: 0, ad_impressions: 1300, ad_clicks: 42 });
  assert.equal(srv.acos, wasted.acos); assert.equal(srv.roas, wasted.roas);
});

test("summarizeWindow: account == mapped + Unmapped per currency (conservation), currencies never combined", () => {
  const w = windowCampaigns(serverView.campaigns, "2026-09-01", "2026-09-03");
  const sum = summarizeWindow(w);
  assert.deepEqual(Object.keys(sum.byCurrency).sort(), ["EUR", "USD"], "two isolated currencies");
  const usd = sum.byCurrency.USD;
  assert.equal(usd.conservationOk, true);
  // USD account spend = A(30)+B(24)+D(30)=84; mapped (A+D)=60; unmapped (B)=24.
  assert.equal(usd.account.spend, 84);
  assert.equal(usd.unmapped.spend, 24);
  const mappedSpend = usd.brands.reduce((s, b) => s + b.spend, 0);
  assert.equal(mappedSpend + usd.unmapped.spend, usd.account.spend, "mapped + unmapped == account");
  // EUR is a separate universe: its account spend (25) never bleeds into USD.
  assert.equal(sum.byCurrency.EUR.account.spend, 25);
});

test("classifyWaste: zero-sales spend is DEFINITE waste; high-ACoS/low-ROAS/clicks-no-orders are REVIEW", () => {
  const usd = windowCampaigns(serverView.campaigns, "2026-09-01", "2026-09-03").filter((c) => c.currency === "USD");
  const res = classifyWaste(usd);
  const B = res.findings.find((f) => f.campaignId === "B");
  const D = res.findings.find((f) => f.campaignId === "D");
  const A = res.findings.find((f) => f.campaignId === "A");
  assert.equal(B.severity, "wasted", "B (spend, 0 sales) is definite waste");
  assert.ok(B.reasons.some((r) => r.type === "zero-sales"));
  assert.ok(B.reasons.some((r) => r.type === "clicks-no-orders"), "B has 42 clicks, 0 orders >= threshold");
  assert.equal(D.severity, "review", "D (ACoS 0.75, ROAS 1.33) needs review, not definite waste");
  assert.ok(D.reasons.some((r) => r.type === "high-acos") && D.reasons.some((r) => r.type === "low-roas"));
  assert.equal(A, undefined, "A (ROAS 3.5, converting) is not flagged");
  // Wasted sorts before review.
  assert.equal(res.findings[0].severity, "wasted");
  // Reused PPC threshold.
  assert.equal(CAMPAIGN_WASTE_THRESHOLDS.minClicksForReview, 10);
});

test("classifyWaste: MIN_CLICKS threshold gates the clicks-no-orders review (below it is not evidence)", () => {
  const few = windowCampaigns([{ campaignId: "X", marketplace: "US", adsProfileId: "P1", currency: "USD", daily: [["2026-09-03", 5, 3, 0, 0, 100, 9]] }], "2026-09-01", "2026-09-03");
  const res = classifyWaste(few);
  // 9 clicks < 10 -> no clicks-no-orders reason; sales>0 so not wasted; ROAS 0.6<2 -> review by ROAS only.
  const x = res.findings.find((f) => f.campaignId === "X");
  assert.ok(!x || !x.reasons.some((r) => r.type === "clicks-no-orders"), "9 clicks does not trip the review line");
});

// ---- Consolidation seams (source scan; mirrors the repo's migration-source test style) ----
test("SEAM: shell.jsx retires the standalone PPC item and keeps ONE Campaign Ads destination", () => {
  const shell = readFileSync(join(root, "src/components/shell.jsx"), "utf8");
  assert.ok(/CAMPAIGN_ADS_TAB\s*\n?\s*\?\s*\[\{\s*view:\s*"campaign-ads"/.test(shell), "campaign-ads is the flag-ON destination");
  assert.ok(/:\s*\[\{\s*view:\s*"ppc"/.test(shell), "legacy ppc only in the flag-OFF branch");
  // The old always-present standalone ppc nav line must be gone (it lived OUTSIDE the ternary).
  assert.ok(!/\n\s*\{\s*view:\s*"ppc",\s*label:\s*"PPC Performance",\s*title:\s*"PPC Performance & Wasted Spend"[^}]*\},\s*\n\s*\/\//.test(shell), "no unconditional ppc sidebar item");
});

test("SEAM: App.jsx redirects the old ppc view to campaign-ads and gates legacy PPC render on flag-OFF", () => {
  const app = readFileSync(join(root, "src/App.jsx"), "utf8");
  assert.ok(/next === "ppc" && CAMPAIGN_ADS_TAB \? "campaign-ads"/.test(app), "onNavigate redirects ppc->campaign-ads");
  assert.ok(/\(view === "campaign-ads" \|\| view === "ppc"\) && CAMPAIGN_ADS_TAB/.test(app), "campaign-ads render also serves a redirected ppc");
  assert.ok(/view === "ppc" && !CAMPAIGN_ADS_TAB/.test(app), "legacy PPC renders only when the flag is OFF");
});

test("SEAM: the view API + client never import a DataDoe export/token path (zero tokens on date changes)", () => {
  const clientView = readFileSync(join(root, "src/lib/campaign-ads-view.js"), "utf8");
  // Pure logic: no network call and no imports at all (comment mentions of "DataDoe"/"refetch" are fine).
  assert.ok(!/\bfetch\s*\(/.test(clientView), "no fetch() in the client view logic");
  assert.ok(!/^\s*import\s/m.test(clientView), "the client view module imports nothing (fully self-contained)");
});

console.log(`\ncampaign-ads-view: ${passed} assertions passed`);
