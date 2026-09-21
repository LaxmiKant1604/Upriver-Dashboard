// Daily Reporting REDESIGN regressions -- the REAL DailyReporting component is bundled with esbuild and rendered with
// react-dom/server, proving the approved flat Amazon layout renders WITHOUT changing any data behaviour:
//   * the table row + KPI say "Ad Spend" (never "Ad Spends");
//   * dynamic values from the mock MTD/day cells render (ROI 5.92, ACoS 25.4%, TACoS 16.9%, coverage 97.8%);
//   * the status states are truthfully represented (provisional=warning, final=info, error alert) and no message is lost;
//   * the MTD column carries dr-td-mtd/dr-th-mtd and the latest completed day dr-td-latest/dr-th-latest;
//   * advertising a period does not cover stays an em dash (dr-dash), never a fabricated zero;
//   * the retired Royal Violet classes (dr-band, dr-row-highlight, dr-note, dr-ic) and gradients are gone;
//   * the mock's fabricated verdicts ("Healthy"/"Controlled"/"Benchmark:") and its wrong ROI formula are NOT copied;
//   * the Refresh control keeps its saved-data-only handler + honest title (no export).
// Also a STATIC guard on App.jsx's DAILY_METRICS label. LF, no top-level await.

import assert from "node:assert/strict";
import { writeSync, mkdtempSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { build } from "esbuild";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let passed = 0;
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const textOf = (html) => String(html).replace(/<[^>]*>/g, " ").replace(/&[a-z]+;/g, " ");

const RENDER_ENTRY = `
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import DailyReporting from ${JSON.stringify(path.join(appRoot, "src/views/DailyReporting.jsx"))};
import { fmtMoney } from ${JSON.stringify(path.join(appRoot, "src/lib/format.js"))};
import { formatDailyRoi, formatDailyAcos, formatDailyTacos } from ${JSON.stringify(path.join(appRoot, "src/lib/daily-metrics.js"))};
const DASH="\\u2014";
// A metrics array with the SAME shape + formulas as App.jsx's DAILY_METRICS (label "Ad Spend").
const METRICS=[
  {key:"sales",label:"Total Sales",fmt:(c,cur)=>fmtMoney(c.sales,cur)},
  {key:"adSales",label:"Ad Sales",fmt:(c,cur)=>(c.hasAd?fmtMoney(c.adSales,cur):DASH)},
  {key:"adSpend",label:"Ad Spend",fmt:(c,cur)=>(c.hasAd?fmtMoney(c.adSpend,cur):DASH)},
  {key:"clicks",label:"Clicks",fmt:(c)=>(c.hasAd?c.clicks.toLocaleString("en-US"):DASH)},
  {key:"units",label:"Units",fmt:(c)=>c.units.toLocaleString("en-US")},
  {key:"roi",label:"ROI",highlight:true,fmt:(c)=>formatDailyRoi(c.sales,c.adSpend,c.hasAd)},
  {key:"acos",label:"ACoS %",fmt:(c)=>formatDailyAcos(c.adSpend,c.adSales,c.hasAd)},
  {key:"tacos",label:"TACoS %",fmt:(c)=>formatDailyTacos(c.adSpend,c.sales,c.hasAd)},
];
const columns=[
  {key:"m1",group:"month",label:"Jun '26"},
  {key:"m2",group:"month",label:"Jul '26"},
  {key:"m3",group:"month",label:"Aug '26"},
  {key:"mtd",group:"mtd",label:"Sep '26 MTD"},
  {key:"d1",group:"day",label:"12-Sep"},
  {key:"d2",group:"day",label:"13-Sep"},
  {key:"d3",group:"day",label:"14-Sep"},
  {key:"d4",group:"day",label:"15-Sep"},
  {key:"d5",group:"day",label:"16-Sep"},
];
// The first month (Jun) has NO advertising -> its Ad Sales/Ad Spend/ROI/ACoS/TACoS cells must be em dashes.
const cells=[
  {sales:4382285,units:10653,adSales:0,adSpend:0,clicks:0,hasAd:false},
  {sales:5588251,units:11817,adSales:2585941,adSpend:603945,clicks:70635,hasAd:true},
  {sales:5169402,units:12532,adSales:3445991,adSpend:800114,clicks:92820,hasAd:true},
  {sales:2280694,units:5597,adSales:1517702,adSpend:385131,clicks:40614,hasAd:true},
  {sales:146965,units:372,adSales:77052,adSpend:26663,clicks:2642,hasAd:true},
  {sales:151166,units:362,adSales:86582,adSpend:26847,clicks:2632,hasAd:true},
  {sales:128613,units:311,adSales:99385,adSpend:23828,clicks:2344,hasAd:true},
  {sales:125918,units:317,adSales:89751,adSpend:23310,clicks:2222,hasAd:true},
  {sales:127219,units:321,adSales:90795,adSpend:23564,clicks:2165,hasAd:true},
];
const unitBreakdown={onDate:"2026-09-16",pricedUnits:314,explicitZeroUnits:0,pendingWithSkuUnits:7,pendingWithoutSkuUnits:0,cancelledUnits:0,observedUnits:321,skuMovementUnits:321};
const reportProv={latest:"2026-09-16",columns,cells,adsAvailability:{provisionalFrom:"2026-09-12",recordedFrom:"2026-09-12",recordedThrough:"2026-09-16",recordedDayCount:5,coveredDayCount:5}};
const provComplete={provisional:true,sourceDefect:false,itemizationPercent:0,pendingOrderCount:295,pendingUnitCount:321,latestDate:"2026-09-16",finalizedThrough:"2026-09-13",notice:"Sales shown are through the latest itemized date; pending orders reconcile automatically.",unitBreakdown};
// FINAL variant: MTD carries NO advertising (KPI money -> em dash) and advertising is not yet recorded for the window.
const cellsFinal=cells.map((c,i)=>i===3?{...c,adSales:0,adSpend:0,clicks:0,hasAd:false}:c);
const reportFinal={latest:"2026-09-16",columns,cells:cellsFinal,adsAvailability:{provisionalFrom:"2026-09-12",recordedFrom:null,recordedThrough:null}};
const finalComplete={provisional:false,sourceDefect:false,itemizationPercent:100,latestDate:"2026-09-16",finalizedThrough:"2026-09-15",notice:"",unitBreakdown};
const base={selectedBrand:"ALL",currency:"INR",metrics:METRICS,accountId:"acct",onReload:()=>{},loading:false,accountName:"Indya Store IN"};
const el=React.createElement;
const R={
  prov: renderToStaticMarkup(el(DailyReporting,{...base,report:reportProv,rows:[{}],completeness:provComplete,error:null,missing:false})),
  final: renderToStaticMarkup(el(DailyReporting,{...base,report:reportFinal,rows:[{}],completeness:finalComplete,error:null,missing:false})),
  error: renderToStaticMarkup(el(DailyReporting,{...base,report:null,rows:[],completeness:null,error:"This report is not available yet.",missing:true})),
};
process.stdout.write(JSON.stringify(R));
`;

let RENDER = null;
async function rendered() {
  if (RENDER) return RENDER;
  const dir = mkdtempSync(path.join(tmpdir(), "drrender-"));
  const outfile = path.join(dir, "bundle.cjs");
  await build({ stdin: { contents: RENDER_ENTRY, resolveDir: appRoot, loader: "js" }, bundle: true, format: "cjs", platform: "node", outfile, logLevel: "silent", jsx: "transform" });
  RENDER = JSON.parse(execFileSync(process.execPath, [outfile], { encoding: "utf8", maxBuffer: 48 * 1024 * 1024 }));
  return RENDER;
}

/* --------------------------------------------------------------- static label guard */
test("DAILY_METRICS uses 'Ad Spend' (never 'Ad Spends')", () => {
  // DAILY_METRICS now lives in the shared lib (moved out of App.jsx so the coverage suite can drive the real render).
  const src = readFileSync(path.join(appRoot, "src/lib/daily-metrics.js"), "utf8");
  assert.ok(/label:\s*"Ad Spend"/.test(src), "the adSpend metric row is labelled 'Ad Spend'");
  assert.ok(!/Ad Spends/.test(src), "'Ad Spends' must not appear anywhere in the daily metrics");
});

/* ------------------------------------------------------------------- rendered guards */
test("wording: 'Ad Spend' renders in the KPI + table; 'Ad Spends' never does", async () => {
  const r = await rendered();
  const t = textOf(r.prov);
  assert.ok(/Ad Spend MTD/.test(t), "the Ad Spend KPI label renders");
  assert.ok(/Ad Spend\b/.test(t), "the Ad Spend table row renders");
  assert.ok(!/Ad Spends/.test(r.prov), "'Ad Spends' is never rendered");
});

test("dynamic values render from the mock cells (ROI 5.92, ACoS 25.4%, TACoS 16.9%, coverage 97.8%)", async () => {
  const r = await rendered();
  const t = textOf(r.prov);
  assert.ok(/5\.92/.test(t), "ROI = 2280694/385131 = 5.92 renders (dynamic, not hard-coded)");
  assert.ok(/25\.4%/.test(t), "ACoS = 385131/1517702 = 25.4% renders");
  assert.ok(/16\.9%/.test(t), "TACoS = 385131/2280694 = 16.9% renders");
  assert.ok(/97\.8% coverage/.test(t), "priced coverage = 314/321 = 97.8% renders");
  assert.ok(/321 units/.test(t), "the observed-unit total renders");
});

test("status states are truthful: provisional=warning panel + badge; final=info; error=alert; nothing suppressed", async () => {
  const r = await rendered();
  assert.ok(/dr-status--warning/.test(r.prov), "provisional shows the warning-tone status panel");
  assert.ok(/Provisional D-1/.test(textOf(r.prov)), "the Provisional D-1 badge/title renders");
  assert.ok(/dr-status--info/.test(r.prov), "the advertising-coverage info panel renders");
  assert.ok(/never a measured zero/.test(textOf(r.prov)), "the honest never-a-zero advertising message is preserved");
  // FINAL: not a warning; advertising not yet recorded is surfaced honestly.
  assert.ok(/Final D-1/.test(textOf(r.final)), "the final state is labelled Final D-1");
  assert.ok(/Advertising not yet recorded/.test(textOf(r.final)), "the not-yet-recorded advertising status is preserved");
  // ERROR: the not-available alert renders (missing state).
  assert.ok(/not available yet/i.test(textOf(r.error)), "the not-available error alert is preserved");
});

test("MTD + latest-day column classes are correctly assigned", async () => {
  const r = await rendered();
  assert.ok(/dr-th-mtd/.test(r.prov) && /dr-td-mtd/.test(r.prov), "the MTD column header + cells carry the mtd class");
  assert.ok(/dr-th-latest/.test(r.prov) && /dr-td-latest/.test(r.prov), "the latest completed day header + cells carry the latest class");
  // The MTD emphasis is blue; the latest is amber (restrained), per the design system.
  assert.ok(/dr-tr-ratio/.test(r.prov), "ratio rows carry the neutral ratio-section class");
  assert.ok(/Operational ratios/i.test(textOf(r.prov)), "the Operational ratios & margins divider renders before ROI/ACoS/TACoS");
});

test("missing advertising stays an em dash (dr-dash), never a fabricated zero", async () => {
  const r = await rendered();
  assert.ok(/dr-dash/.test(r.prov), "the no-ad month cells render an em-dash span");
  // FINAL: the MTD cell has no advertising -> the Ad Sales / Ad Spend / ROI KPIs are em dashes (never 0).
  const tf = textOf(r.final);
  assert.ok(/Ad Sales MTD/.test(tf) && /Ad Spend MTD/.test(tf), "the KPI labels still render when advertising is unavailable");
  assert.ok(tf.includes("—"), "an unavailable KPI shows an em dash, not a fabricated zero");
});

test("retired Royal Violet classes + gradients are gone from the rendered output", async () => {
  const r = await rendered();
  assert.ok(!/dr-band/.test(r.prov), "the violet .dr-band information band is gone");
  assert.ok(!/dr-row-highlight/.test(r.prov), "the coral .dr-row-highlight is gone");
  assert.ok(!/\bdr-note\b/.test(r.prov), "the old .dr-note panel is gone (replaced by the methodology disclosure)");
  assert.ok(!/linear-gradient/.test(r.prov), "no gradient is rendered inline");
  assert.ok(!/#6366F1|#4338CA|#1E1245|#FF6B6B/.test(r.prov), "no retired violet/coral hex is rendered inline");
});

test("methodology keeps the REAL formulas and does NOT copy the mock's verdicts or wrong ROI formula", async () => {
  const r = await rendered();
  assert.ok(/Data methodology and metric definitions/.test(textOf(r.prov)), "the methodology disclosure renders");
  assert.ok(/ROI<\/strong>[\s\S]{0,40}Total Sales[\s\S]{0,20}Ad Spend/.test(r.prov), "ROI = Total Sales / Ad Spend is preserved (division, not the mock's subtraction)");
  assert.ok(!/Total Sales\s*[-−]\s*Ad Spend/.test(textOf(r.prov)), "the mock's wrong 'Total Sales - Ad Spend' ROI is NOT copied");
  assert.ok(!/Sales\s*[-−]\s*Spend/.test(textOf(r.prov)), "the mock's '(Sales - Spend) / Spend' is NOT copied");
  assert.ok(!/\bHealthy\b|\bControlled\b|Benchmark:/.test(textOf(r.prov)), "the mock's fabricated verdicts/benchmarks are NOT copied");
  assert.ok(/never a measured zero/.test(textOf(r.prov)), "the unavailable-advertising-is-not-a-zero explanation is preserved");
});

test("the Refresh control keeps its saved-data-only handler + honest no-export title (accessible name matches visible label)", async () => {
  const r = await rendered();
  assert.ok(/aria-label="Refresh Data"/.test(r.prov), "the button's accessible name contains its visible label (WCAG 2.5.3 Label in Name)");
  assert.ok(/Refresh Data/.test(textOf(r.prov)), "the refresh button shows its visible label");
  assert.ok(/no DataDoe export/.test(r.prov), "the refresh title honestly states it triggers no export");
});

test("a11y: no nested live region -- the observed-units block is a group, and the live region is the status message only", async () => {
  const r = await rendered();
  assert.ok(/class="dr-obs" role="group"/.test(r.prov), "the observed-units breakdown is a labelled group, not a nested live region");
  assert.ok(!/dr-obs"[^>]*role="status"/.test(r.prov), "the observed-units container is never role=status (would nest inside the status live region)");
  assert.ok(/class="dr-status-main" role="status"/.test(r.prov), "the polite live region is the status MESSAGE container (so toggling the disclosure never re-announces the whole panel)");
  assert.ok(/<section class="dr-status dr-status--warning">/.test(r.prov), "the outer status section itself carries no role (the message container does)");
});

async function main() {
  let failures = 0;
  for (const t of tests) {
    try { await t.fn(); passed += 1; out("  ok  " + t.name); }
    catch (e) { failures += 1; out("FAIL  " + t.name); out(String(e && e.stack ? e.stack : e)); }
  }
  out(`\ndaily-reporting-render: ${passed}/${tests.length} assertions passed`);
  return failures;
}
main().then((f) => { if (f) process.exitCode = 1; }).catch((e) => { out("FATAL " + String(e && e.stack ? e.stack : e)); process.exitCode = 1; });
