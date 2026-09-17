// SKU Movement REDESIGN regressions -- the REAL SkuMovement component is bundled with esbuild and rendered with
// react-dom/server, proving the approved flat Amazon layout renders WITHOUT changing any data behaviour:
//   * every existing column + the six grouped bands (Identity & Catalog / Monthly Unit History / Daily Observed
//     Movement / Window Comparison / Forecast / Status) render -- no column is dropped;
//   * a month before coverage stays an em dash, and an unavailable comparison (prev window 0) is a neutral em dash
//     movement -- never a fabricated zero;
//   * movement is evidence-based: green positive, red negative;
//   * the flat KPIs (with date-range subs), the 5-cell Observed Units, the scope metadata + status badge, and the
//     collapsible methodology all render;
//   * the toolbar keeps Search / Movement / Window / Columns / Identifiers / Refresh / Download Excel, with the idle
//     button showing "Refresh" and "Reloading..." ONLY while updating;
//   * the retired deep-navy header + coral/violet accents are gone from the rendered output.
// LF, no top-level await.

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
const textOf = (html) => String(html).replace(/<[^>]*>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/&[a-z]+;/g, " ");
const theadHtml = (h) => (String(h).split("</thead>")[0].split("<thead>")[1] || "");
const tfootHtml = (h) => (String(h).split("</tfoot>")[0].split("<tfoot>")[1] || "");
const headerThCount = (h) => { const trs = theadHtml(h).match(/<tr[\s\S]*?<\/tr>/g) || []; return ((trs[trs.length - 1] || "").match(/<th/g) || []).length; };
const footTdCount = (h) => (tfootHtml(h).match(/<td/g) || []).length;

const RENDER_ENTRY = `
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import SkuMovement from ${JSON.stringify(path.join(appRoot, "src/views/SkuMovement.jsx"))};
function addDays(d,n){const dt=new Date(d+"T00:00:00Z");dt.setUTCDate(dt.getUTCDate()+n);return dt.toISOString().slice(0,10);}
const A="2026-09-16";
const dailyDates=[]; for(let i=59;i>=0;i--) dailyDates.push(addDays(A,-i));
function daily(rec,prv){ const m={}; const recent=dailyDates.slice(-7), prev=dailyDates.slice(-14,-7);
  recent.forEach((d,i)=>{ m[d]=rec[i%rec.length]; }); prev.forEach((d,i)=>{ m[d]=prv[i%prv.length]; }); return m; }
function mrow(asin,name,brand,months,mtd,rec,prv){
  const marr=months.map((u,i)=>({key:"2026-0"+(6+i),label:["Jun '26","Jul '26","Aug '26"][i],units:u}));
  const total=months.reduce((s,x)=>s+(x||0),0);
  return {asin,currency:"EUR",unmapped:false,sku:"SKU-"+asin,skuCount:1,legitSkuCount:1,hasSellerSku:true,productName:name,brand,months:marr,mtdUnits:mtd,monthsTotalUnits:total,dailyUnits:daily(rec,prv),avgMonthlyUnits:Math.round(total/3),mtdRunRate:1,projectedUnits:mtd,status:"Stable"};
}
const rows=[
  mrow("B0RISE","Rising pillow","DREAM HAVEN",[100,120,140],90,[10,10,10,10,10,10,10],[3,3,3,3,3,3,3]), // up -> green
  mrow("B0FALL","Falling pillow","DREAM HAVEN",[200,180,160],40,[2,2,2,2,2,2,2],[9,9,9,9,9,9,9]),        // down -> red
  mrow("B0NULLM","Gap month pillow","Bebi Born",[null,50,60],20,[1,1,1,1,1,1,1],[1,1,1,1,1,1,1]),         // month null -> em dash
  mrow("B0NOPREV","No-prev pillow","Bebi Born",[0,0,5],7,[1,1,1,1,1,1,1],[0,0,0,0,0,0,0]),                // prev 0 -> movement em dash
];
function makeData(prov){ return {rows,monthLabels:["Jun '26","Jul '26","Aug '26"],mtdLabel:"Sep '26 MTD",dailyDates,coverageFrom:dailyDates[0],defaultRecentDays:7,maxRecentDays:30,minRecentDays:1,thresholds:{risingPct:20,decliningPct:-20},effectiveAsOf:A,brand:"ALL",brandFiltered:false,catalogBrands:[],accountId:"acct",snapshotMissing:false,
  completeness:{status:prov?"provisional":"final",provisional:prov,sourceDefect:false,latestDate:A,itemizationPercent:prov?44:100,pendingOrderCount:prov?49:0,pendingUnitCount:prov?62:0,finalizedThrough:A,onDate:A,unitBreakdown:{onDate:A,pricedUnits:37,explicitZeroUnits:0,pendingWithSkuUnits:prov?7:0,pendingWithoutSkuUnits:0,cancelledUnits:0,observedUnits:prov?44:37,skuMovementUnits:prov?44:37}}}; }
const base={loading:false,error:null,accountName:"Premium-Avenue IT",selectedBrand:"ALL",onReload:()=>{},cachedAt:new Date("2026-09-17T00:00:00Z"),recentDays:7,onRecentDaysChange:()=>{},hiddenColumns:[],onColumnsChange:()=>{},onSaveIdentifier:()=>{},onBulkIdentifiers:()=>{},canEdit:true};
const el=React.createElement;
const R={
  final: renderToStaticMarkup(el(SkuMovement,{...base,data:makeData(false),updating:false})),
  prov: renderToStaticMarkup(el(SkuMovement,{...base,data:makeData(true),updating:false})),
  reloading: renderToStaticMarkup(el(SkuMovement,{...base,data:makeData(false),updating:true})),
  hidden: renderToStaticMarkup(el(SkuMovement,{...base,data:makeData(false),updating:false,hiddenColumns:["months","prev","avg","runRate","projected","status"]})),
};
process.stdout.write(JSON.stringify(R));
`;

let RENDER = null;
async function rendered() {
  if (RENDER) return RENDER;
  const dir = mkdtempSync(path.join(tmpdir(), "skurender-"));
  const outfile = path.join(dir, "bundle.cjs");
  await build({ stdin: { contents: RENDER_ENTRY, resolveDir: appRoot, loader: "js" }, bundle: true, format: "cjs", platform: "node", outfile, logLevel: "silent", jsx: "transform" });
  RENDER = JSON.parse(execFileSync(process.execPath, [outfile], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
  return RENDER;
}

test("every grouped band + all existing columns render (no column dropped)", async () => {
  const r = await rendered();
  const t = textOf(r.final);
  for (const band of ["Identity & Catalog", "Monthly Unit History", "Daily Observed Movement", "Window Comparison", "Forecast", "Status"]) {
    assert.ok(t.includes(band), `group band "${band}" renders`);
  }
  for (const col of ["Product / ASIN", "Identifier", "SKU", "Brand", "Jun '26", "Aug '26", "Sep '26 MTD", "Last 7", "Prev 7", "Move %", "Avg / mo", "Run rate", "Projected", "Status"]) {
    assert.ok(t.includes(col), `column header "${col}" renders`);
  }
  // The daily-movement band carries its real date range (never a hard-coded one).
  assert.ok(/Daily Observed Movement \(/.test(t), "the daily band carries its dynamic date range");
});

test("missing month stays an em dash; an unavailable comparison is a neutral em dash movement (never a fabricated zero)", async () => {
  const r = await rendered();
  // The gap-month row (Jun null) renders an em-dash cell.
  assert.ok(r.final.includes("—"), "an em dash renders for unavailable data");
  // The no-prev row -> movement percent null -> the neutral (flat) move badge, not a green/red 0.
  assert.ok(/sku-mv-move-flat/.test(r.final), "an unavailable comparison uses the neutral movement style");
});

test("movement is evidence-based: green positive, red negative", async () => {
  const r = await rendered();
  assert.ok(/sku-mv-move-pos/.test(r.final), "a positive movement is green");
  assert.ok(/sku-mv-move-neg/.test(r.final), "a negative movement is red");
});

test("flat KPIs render with date-range subs, and the movement KPI is evidence-toned", async () => {
  const r = await rendered();
  const t = textOf(r.final);
  assert.ok(/class="rvkpi/.test(r.final), "the KPI cells render");
  for (const label of ["ASINs in scope", "Sep '26 MTD units", "Last 7-day units", "Previous 7-day units", "Movement"]) {
    assert.ok(t.includes(label), `KPI "${label}" renders`);
  }
  assert.ok(t.includes("Active in movement analysis"), "the ASINs KPI shows its sub");
  assert.ok(/vs previous 7 days/.test(t), "the movement KPI shows its comparison sub");
  assert.ok(/rvkpi-pos|rvkpi-neg/.test(r.final), "the movement KPI value carries an evidence tone");
});

test("the 5-cell Observed Units panel renders with all classifications + copy", async () => {
  const r = await rendered();
  const t = textOf(r.final);
  assert.ok(/sku-mv-obs/.test(r.final), "the flat observed-units panel renders");
  for (const c of ["Priced", "Explicit zero-price", "Pending", "Cancelled"]) assert.ok(t.includes(c), `classification "${c}" renders`);
  assert.ok(/Revenue counts priced units only/.test(t), "the explanatory copy is preserved");
});

test("scope metadata chips + the completeness status badge render (final vs provisional)", async () => {
  const r = await rendered();
  assert.ok(/sku-mv-meta/.test(r.final), "the scope metadata panel renders");
  assert.ok(/Premium-Avenue IT/.test(textOf(r.final)) && /EUR/.test(textOf(r.final)), "account + currency render dynamically");
  assert.ok(/sku-mv-status--good/.test(r.final) && /Final D-1/.test(textOf(r.final)), "a final snapshot shows the green Final D-1 badge");
  assert.ok(/sku-mv-status--warn/.test(r.prov) && /Provisional D-1/.test(textOf(r.prov)), "a provisional snapshot shows the amber Provisional D-1 badge");
});

test("toolbar keeps its controls; the idle button shows Refresh and Reloading... only while updating", async () => {
  const r = await rendered();
  const t = textOf(r.final);
  for (const c of ["Columns", "Identifiers", "Refresh", "Download Excel", "All movement states"]) assert.ok(t.includes(c), `toolbar control "${c}" renders`);
  assert.ok(!/Reloading/.test(r.final), "the idle toolbar never shows 'Reloading...'");
  assert.ok(/Reloading/.test(textOf(r.reloading)), "the button shows 'Reloading...' only while updating");
});

test("methodology is a collapsible disclosure that preserves its policy copy", async () => {
  const r = await rendered();
  assert.ok(/<details class="sku-mv-methodology">/.test(r.final), "methodology is a disclosure");
  assert.ok(/SKU Movement methodology, coverage, and identifier policy/.test(textOf(r.final)), "the summary label matches the approved");
  assert.ok(/No action here ever creates a DataDoe export/.test(textOf(r.final)), "the zero-export policy copy is preserved");
});

test("the totals row (tfoot) renders with the dynamic filtered ASIN count + representative existing aggregates", async () => {
  const r = await rendered();
  assert.ok(/<tfoot>/.test(r.final), "a semantic <tfoot> renders");
  const f = tfootHtml(r.final), ft = textOf(f);
  assert.ok(ft.includes("Totals") && ft.includes("4 ASINs"), "the footer shows Totals + the dynamic filtered ASIN count (4)");
  assert.ok(ft.includes("All mapped SKUs"), "the SKU total cell reads 'All mapped SKUs'");
  assert.ok(/2 brands/.test(ft), "the Brand total cell shows the dynamic brand count (2)");
  // Existing totals only (no new formula): MTD = 90+40+20+7 = 157; months = 300 / 350 / 365.
  assert.ok(ft.includes("157"), "totals.mtd (157) renders");
  assert.ok(ft.includes("300") && ft.includes("350") && ft.includes("365"), "totals.months (300 / 350 / 365) render");
  assert.ok(/sku-mv-mtd/.test(f) && /sku-mv-last5/.test(f), "the MTD + Last-N footer cells carry the blue-emphasis classes");
  // Last-N + Prev-N + movement totals are present (recentTotal/prevTotal sums + movementPercent).
  assert.ok(/sku-mv-foot/.test(r.final), "the totals row carries its footer class");
});

test("the footer respects shown() -- hidden columns drop from the footer too, and it stays aligned with the header", async () => {
  const r = await rendered();
  assert.equal(headerThCount(r.final), footTdCount(r.final), "default: footer cell count == header column count");
  assert.equal(headerThCount(r.hidden), footTdCount(r.hidden), "hidden config: footer cell count == header column count (no misalignment)");
  const ft = textOf(tfootHtml(r.hidden));
  // With months hidden, the month totals (300/365) are removed from the footer; Last-N (always shown) stays.
  assert.ok(!ft.includes("300") && !ft.includes("365"), "hidden month totals are removed from the footer");
});

test("non-additive columns without an authoritative aggregate stay em dashes in the totals row (no invented averages/projections/status)", async () => {
  const r = await rendered();
  const dashes = (textOf(tfootHtml(r.final)).match(/—/g) || []).length;
  // identifier + avg + run-rate + projected + status = at least five em dashes; no fabricated aggregate.
  assert.ok(dashes >= 5, `the footer keeps em dashes for the identifier + the four non-additive aggregates (found ${dashes})`);
});

test("the retired deep-navy header + coral/violet accents are gone from the rendered output", async () => {
  const r = await rendered();
  assert.ok(!/1E1245|2d1b69/.test(r.final), "no deep-violet header hex is rendered inline");
  assert.ok(!/#FF6B6B|#A78BFA|#7C3AED|#FF8E53/.test(r.final), "no coral/violet gradient hex is rendered inline");
  assert.ok(!/linear-gradient/.test(r.final), "no gradient is rendered inline");
  assert.ok(!/--op-navy/.test(r.final), "the sticky identity header no longer uses the deep-navy token");
});

async function main() {
  let failures = 0;
  for (const t of tests) {
    try { await t.fn(); passed += 1; out("  ok  " + t.name); }
    catch (e) { failures += 1; out("FAIL  " + t.name); out(String(e && e.stack ? e.stack : e)); }
  }
  out(`\nsku-movement-render: ${passed}/${tests.length} checks passed`);
  return failures;
}
main().then((f) => { if (f) process.exitCode = 1; }).catch((e) => { out("FATAL " + String(e && e.stack ? e.stack : e)); process.exitCode = 1; });
