// Daily Reporting RENDERED behavioural tests (flexii UK follow-up). The REAL DailyReporting.jsx is bundled with esbuild
// and rendered with react-dom/server, driving the REAL coverage classifier (applyDailyCoverage) + the REAL DAILY_METRICS
// through the actual table render -- NOT a source-text guard. It proves, for the owner's enumerated scenarios, that a
// column renders a source-backed total, a GBP 0 for a genuine covered zero, or an em dash for unavailable/unknown, and
// carries the correct coverage badge (Partial / Unavailable / Unknown). LF, no top-level await.

import assert from "node:assert/strict";
import { writeSync, mkdtempSync } from "node:fs";
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

const RENDER_ENTRY = `
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import DailyReporting from ${JSON.stringify(path.join(appRoot, "src/views/DailyReporting.jsx"))};
import { DAILY_METRICS } from ${JSON.stringify(path.join(appRoot, "src/lib/daily-metrics.js"))};
import { applyDailyCoverage } from ${JSON.stringify(path.join(appRoot, "src/lib/coverage-windows.js"))};

const el = React.createElement;
function addDay(d,n){const dt=new Date(d+"T00:00:00Z");dt.setUTCDate(dt.getUTCDate()+n);return dt.toISOString().slice(0,10);}
function col(label,from,to){return {key:"c",label,from,to,group:"month"};}
function rowsOn(from,to,per){const o=[];for(let d=from;d<=to;d=addDay(d,1))o.push({date:d,total_sales:per,total_units_sold:1});return o;}
const okCov=(windows)=>({status:"final",latestDate:"2026-09-19",coverageRead:"ok",coverageWindows:windows});

// A zero dummy row on a far date guarantees hasData (so the table renders, not the empty state) WITHOUT being positive
// evidence for any column (a zero row is not positive proof) and WITHOUT falling inside any tested column range.
const DUMMY = {date:"2020-01-01",total_sales:0,total_units_sold:0};

function htmlCols(columns, rows, completeness){
  const baseCells=columns.map((c)=>{let sales=0,units=0;rows.forEach((r)=>{if(r.date>=c.from&&r.date<=c.to){sales+=r.total_sales||0;units+=r.total_units_sold||0;}});return {sales,units,adSales:0,adSpend:0,clicks:0,hasAd:false};});
  const cells=applyDailyCoverage({report:{columns,cells:baseCells},completeness,rows});
  const report={latest:columns[columns.length-1].to,columns,cells};
  return renderToStaticMarkup(el(DailyReporting,{accountName:"flexii UK",selectedBrand:"ALL",currency:"GBP",report,rows,completeness,loading:false,error:null,missing:false,accountId:"acct",onReload(){},metrics:DAILY_METRICS}));
}
function html(column, inRangeRows, completeness){ return htmlCols([column],[DUMMY,...inRangeRows],completeness); }

const R={
  s1_partial90: html(col("Last 90 days","2026-06-21","2026-09-19"), rowsOn("2026-09-03","2026-09-19",10), okCov([{from:"2026-09-03",to:"2026-09-19"}])),
  s2_customBefore: html(col("2024","2024-01-01","2024-12-31"), [], okCov([{from:"2025-01-01",to:"2026-09-19"}])),
  s3_uncoveredMonth: html(col("Jun '26","2026-06-01","2026-06-30"), [], okCov([{from:"2026-09-03",to:"2026-09-30"}])),
  s4_partialMonth: html(col("Sep '26","2026-09-01","2026-09-30"), rowsOn("2026-09-15","2026-09-30",10), okCov([{from:"2026-09-15",to:"2026-09-30"}])),
  s5_internalGap: html(col("Aug '26","2026-08-01","2026-08-31"), [], okCov([{from:"2026-08-01",to:"2026-08-10"},{from:"2026-08-20",to:"2026-08-31"}])),
  s6_covEndsBefore: html(col("Sep 1-19","2026-09-01","2026-09-19"), rowsOn("2026-09-01","2026-09-15",10), okCov([{from:"2026-09-01",to:"2026-09-15"}])),
  s7_coveredZero: html(col("Sep '26","2026-09-01","2026-09-30"), [], okCov([{from:"2026-09-01",to:"2026-09-30"}])),
  s8_rowsBeforeCov: html(col("Sep 1-19","2026-09-01","2026-09-19"), rowsOn("2026-09-01","2026-09-19",10), okCov([{from:"2026-09-10",to:"2026-09-19"}])),
  s9_readFail: html(col("Sep 1-19","2026-09-01","2026-09-19"), rowsOn("2026-09-03","2026-09-19",10), {status:"final",latestDate:"2026-09-19",coverageRead:"read-failed",coverageWindows:[]}),
  legacy: html(col("Sep '26","2026-09-01","2026-09-30"), rowsOn("2026-09-01","2026-09-30",10), {status:"final",latestDate:"2026-09-30"}),
  // KPI CARD coverage (Fix 3): an MTD column that is PARTIAL -> the Total Sales KPI card shows a Partial marker (not a
  // silent full-availability total). Requires a group:"mtd" column so dailyMtdKpis fires + the KPI cards render.
  kpiPartialMtd: htmlCols([
    {key:"mtd",group:"mtd",label:"Sep '26 MTD",from:"2026-09-01",to:"2026-09-19"},
    {key:"d0",group:"day",label:"19-Sep",from:"2026-09-19",to:"2026-09-19"},
  ], [DUMMY,...rowsOn("2026-09-10","2026-09-19",10)], okCov([{from:"2026-09-10",to:"2026-09-19"}])),
  // an UNAVAILABLE MTD (coverage elsewhere, no rows) -> the KPI Total Sales card must NOT show a fabricated total.
  kpiUnavailMtd: htmlCols([
    {key:"mtd",group:"mtd",label:"Sep '26 MTD",from:"2026-09-01",to:"2026-09-19"},
    {key:"d0",group:"day",label:"19-Sep",from:"2026-09-19",to:"2026-09-19"},
  ], [DUMMY], okCov([{from:"2026-07-01",to:"2026-07-31"}])),
};
process.stdout.write(JSON.stringify(R));
`;

let RENDER = null;
async function rendered() {
  if (RENDER) return RENDER;
  const dir = mkdtempSync(path.join(tmpdir(), "dailyrender-"));
  const outfile = path.join(dir, "bundle.cjs");
  await build({ stdin: { contents: RENDER_ENTRY, resolveDir: appRoot, loader: "js" }, bundle: true, format: "cjs", platform: "node", outfile, logLevel: "silent", jsx: "transform" });
  RENDER = JSON.parse(execFileSync(process.execPath, [outfile], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
  return RENDER;
}
const hasBadge = (h) => /dr-th-cov/.test(h);

test("S1. 90D requested but only 17 covered -> PARTIAL: source-backed total shown + Partial badge + covered range", async () => {
  const r = await rendered();
  assert.ok(r.s1_partial90.includes("£170"), "the source-backed total for the covered dates is shown (17 x GBP 10)");
  assert.ok(/>Partial</.test(r.s1_partial90), "a Partial badge labels the column");
  assert.ok(r.s1_partial90.includes("17 of 91 days"), "the covered fraction is disclosed in the badge title (accurate for any gap position)");
});

test("S2. Custom range entirely before coverage -> UNAVAILABLE: em dash (never a GBP 0) + Unavailable badge", async () => {
  const r = await rendered();
  assert.ok(/>Unavailable</.test(r.s2_customBefore), "an Unavailable badge labels the column");
  assert.ok(!r.s2_customBefore.includes("£0"), "Total Sales renders an em dash, NOT a fabricated GBP 0");
});

test("S3. fully uncovered month -> UNAVAILABLE (em dash, no GBP 0)", async () => {
  const r = await rendered();
  assert.ok(/>Unavailable</.test(r.s3_uncoveredMonth));
  assert.ok(!r.s3_uncoveredMonth.includes("£0"), "no fabricated GBP 0 for an uncovered month");
});

test("S4. partially covered month -> PARTIAL: source-backed total + Partial badge", async () => {
  const r = await rendered();
  assert.ok(r.s4_partialMonth.includes("£160"), "16 covered days x GBP 10");
  assert.ok(/>Partial</.test(r.s4_partialMonth));
});

test("S5. INTERNAL coverage gap -> PARTIAL (a row never fills the gap); covered-but-empty parts show GBP 0 under the Partial badge", async () => {
  const r = await rendered();
  assert.ok(/>Partial</.test(r.s5_internalGap), "an internal gap makes the column Partial, never fully covered");
  assert.ok(r.s5_internalGap.includes("£0"), "the covered dates genuinely had no sales -> GBP 0 (source-backed), under the Partial badge");
});

test("S6. coverage ending before the requested end -> PARTIAL (coverageTo honoured, not coverageFrom alone)", async () => {
  const r = await rendered();
  assert.ok(r.s6_covEndsBefore.includes("£150"), "15 covered days x GBP 10");
  assert.ok(/>Partial</.test(r.s6_covEndsBefore));
});

test("S7. genuine COVERED ZERO -> GBP 0 (a real zero, NOT an em dash) and NO coverage badge", async () => {
  const r = await rendered();
  assert.ok(r.s7_coveredZero.includes("£0"), "a fully covered empty month renders a genuine GBP 0");
  assert.ok(!hasBadge(r.s7_coveredZero), "a fully covered column carries NO Partial/Unavailable/Unknown badge");
});

test("S8. real rows EARLIER than a lagging coverage boundary -> COVERED (a row proves its own date); total shown, no badge", async () => {
  const r = await rendered();
  assert.ok(r.s8_rowsBeforeCov.includes("£190"), "19 days x GBP 10 -- rows 01-09 (pre-coverage) prove themselves, window proves 10-19");
  assert.ok(!hasBadge(r.s8_rowsBeforeCov), "fully proven (rows + window) -> no coverage badge");
});

test("S9. coverage READ FAILURE -> UNKNOWN: em dash (the partial-window total is withheld) + Unknown badge", async () => {
  const r = await rendered();
  assert.ok(/>Unknown</.test(r.s9_readFail), "an Unknown badge labels a column whose coverage evidence could not be read");
  assert.ok(!r.s9_readFail.includes("£170"), "the total is WITHHELD (em dash) when coverage is unknown -- never presented as available");
});

test("LEGACY: a payload with NO coverage evidence keeps the exact prior rendering (total shown, no coverage badge)", async () => {
  const r = await rendered();
  assert.ok(r.legacy.includes("£300"), "byte-identical: the total is shown");
  assert.ok(!hasBadge(r.legacy), "no coverage feature -> no coverage badge");
});

test("KPI CARD: a PARTIAL MTD renders a Partial marker on the Total Sales card (not a silent full-availability total)", async () => {
  const r = await rendered();
  assert.ok(/dr-kpis/.test(r.kpiPartialMtd), "the MTD KPI cards render");
  assert.ok(r.kpiPartialMtd.includes("OLI coverage is partial"), "the Total Sales KPI card carries the Partial marker (matches the table's Partial column)");
});

test("KPI CARD: an UNAVAILABLE MTD renders the coverage as Unavailable and does NOT show the partial marker (the total is withheld, not fabricated)", async () => {
  const r = await rendered();
  assert.ok(/dr-kpis/.test(r.kpiUnavailMtd), "the KPI cards render");
  assert.ok(/>Unavailable</.test(r.kpiUnavailMtd), "the MTD column is flagged Unavailable in the table");
  assert.ok(!r.kpiUnavailMtd.includes("OLI coverage is partial"), "an unavailable MTD is not mislabeled partial");
});

async function main() {
  writeSync(1, "daily-reporting-render\n");
  let failures = 0;
  for (const t of tests) {
    try { await t.fn(); passed += 1; out("  ok  " + t.name); }
    catch (e) { failures += 1; out("FAIL  " + t.name); out(String((e && e.stack) || e)); }
  }
  out("\n" + passed + " assertions passed" + (failures ? ", " + failures + " FAILED" : ""));
  if (failures) process.exitCode = 1;
}
main();
