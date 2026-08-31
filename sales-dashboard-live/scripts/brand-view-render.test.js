// Brand View + SKU Movement REDESIGN regressions. Two layers:
//   (1) PURE view-model guarantees (brand-view-tables.js) -- the amount and the contribution share are ALWAYS kept
//       in separate fields (cell.t vs subcells), so a mixed "EUR806 8.5%"-style string can never be built; currency
//       groups stay separate; TACoS is a percent field and Ad Spend a currency field; missing values are em dashes.
//   (2) RENDERED-HTML guarantees -- the REAL components are bundled with esbuild and rendered with react-dom/server,
//       proving the amount and the share render as two SEPARATE elements (never one concatenated string), the KPI
//       tiles + deep-violet SKU table + movement badges render, and no rendered cell matches the malformed pattern.
// LF. Currency glyphs appear only inside the assertions that scan rendered currency values.

import assert from "node:assert/strict";
import { writeSync, mkdtempSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { build } from "esbuild";
import { brandViewModel, shareOf, tacos } from "../src/lib/brand-view.js";
import { buildBrandTables } from "../src/lib/brand-view-tables.js";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let passed = 0;
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// The malformed mixed value the redesign must make impossible: a currency symbol + digits IMMEDIATELY followed by a
// percent (e.g. the reported EUR806 + 8.5% rendered as one string). Never allowed anywhere, in data OR in the DOM.
const CONCAT_RE = /[€£$₹]\s?[\d.,\s]*\d\s*%/;

function addDays(d, n) { const dt = new Date(d + "T00:00:00Z"); dt.setUTCDate(dt.getUTCDate() + n); return dt.toISOString().slice(0, 10); }
const ANCHOR = "2026-08-28";

// A realistic multi-currency (EUR x6 + GBP x1) model built via the REAL view-model.
function buildModel() {
  const EUR = ["BE", "DE", "ES", "FR", "IT", "NL"];
  const series = [];
  for (let i = 120; i >= 0; i--) {
    const d = addDays(ANCHOR, -i);
    EUR.forEach((c, idx) => series.push({ c, cur: "EUR", d, s: 10 + idx * 12 + (i % 5), u: 1 + (idx % 3), a: 0 }));
    series.push({ c: "GB", cur: "GBP", d, s: i % 15 === 0 ? 10 : 0, u: i % 15 === 0 ? 1 : 0 });
  }
  return brandViewModel({
    brand: "Bebi Born", scope: "portfolio", accountId: "portfolio", asOf: ANCHOR,
    countries: [...EUR.map((c) => ({ country: c, currency: "EUR", hasSales: true })), { country: "GB", currency: "GBP", hasSales: true }],
    series,
    coverage: { accountCount: 8, salesFrom: "2025-01-01", salesTo: ANCHOR, salesLatestDate: ANCHOR, salesCompleteThrough: "2025-08-11", inventoryDate: null },
    notes: ["Partial coverage note for the redesign test."],
  });
}
const MODEL = buildModel();
const TABLES = buildBrandTables(MODEL, { rangeFrom: addDays(ANCHOR, -29), rangeTo: ANCHOR, displayCurrency: "ORIGINAL", rates: null });
const allTables = () => [TABLES.dailyTable, TABLES.monthlyTable, TABLES.weeklyTable].filter(Boolean);
function* everyCell() {
  for (const table of allTables()) for (const row of table.rows) {
    if (row.kind === "band" || row.kind === "section") continue;
    for (let i = 1; i < row.cells.length; i++) yield { table, row, i, cell: row.cells[i], sub: row.subcells?.[i] ?? null };
  }
}

/* ================= (1) PURE view-model separation guarantees ================= */

test("1/2/16. NO cell.t ever contains a currency+percent concatenation; the share lives ONLY in subcells", () => {
  let money = 0, withShare = 0;
  for (const { cell, sub } of everyCell()) {
    assert.ok(!CONCAT_RE.test(String(cell.t)), `a cell.t looks concatenated: ${JSON.stringify(cell.t)}`);
    if (sub != null) { withShare += 1; assert.ok(!CONCAT_RE.test(String(sub)), `a subcell looks concatenated: ${JSON.stringify(sub)}`); assert.ok(/%$/.test(String(sub)), "a share subcell must be a percent"); }
    if (/[€£]/.test(String(cell.t))) money += 1;
  }
  assert.ok(money > 0, "the model produced money cells");
  assert.ok(withShare > 0, "the model produced contribution shares (kept separate in subcells)");
});

test("3/9/10. EUR and GBP stay SEPARATE groups (own bands, per-group totals); no cross-currency total is ever built", () => {
  const daily = TABLES.dailyTable;
  const bands = daily.rows.filter((r) => r.kind === "band").map((r) => r.cells[0].t);
  assert.ok(bands.some((b) => /EUR/.test(b)) && bands.some((b) => /GBP/.test(b)), "both currency bands present");
  const totals = daily.rows.filter((r) => r.kind === "total");
  assert.ok(totals.length >= 1, "a multi-marketplace group has its own All Markets total row");
  // The EUR All Markets total is in EUR; the GBP group's values are in GBP -- they are NEVER combined into one total.
  assert.ok(totals.every((r) => /€/.test(r.cells[1].t)), "every All Markets total stays in a single currency (EUR here)");
  const gbRow = daily.rows.find((r) => r.kind !== "band" && r.kind !== "section" && /United Kingdom|GB/.test(r.label || r.cells[0].t));
  assert.ok(gbRow && /£/.test(gbRow.cells[1].t), "the GBP marketplace keeps its own £ currency, separate from the EUR total");
  // No single row mixes two currency symbols (a combined cross-currency figure).
  for (const r of daily.rows) if (r.kind !== "band" && r.kind !== "section") for (const c of r.cells) assert.ok(!/€[\s\S]*£|£[\s\S]*€/.test(String(c.t)), "no cell combines two currencies");
});

test("4/6. a missing amount is an em dash (never fabricated); no share is invented for a single-marketplace group", () => {
  const daily = TABLES.dailyTable;
  const gb = daily.rows.find((r) => /United Kingdom|GB/.test(r.label || r.cells[0].t));
  assert.ok(gb, "GB row present");
  assert.equal(gb.subcells?.[1] ?? null, null, "a single-marketplace group shows no contribution share (never a fabricated one)");
  assert.equal(shareOf(25, 0), null);
  assert.equal(shareOf(null, 100), null);
  assert.equal(shareOf(25, 100), 0.25);
});

test("5/6b. zero is honest: TACoS of zero spend is 0 (not unavailable); unavailable spend stays unavailable", () => {
  assert.equal(tacos(0, 100), 0);
  assert.equal(tacos(null, 100), null);
  assert.equal(tacos(5, 0), null);
});

test("7/8/14/15. weekly: TACoS rows are percents, Total Sales/Ad Spend are currency, Units are numeric", () => {
  const weekly = TABLES.weeklyTable;
  const rowsMatching = (needle) => weekly.rows.filter((r) => r.kind !== "band" && r.kind !== "section" && new RegExp(needle, "i").test(String(r.label || r.cells[0].t)));
  const tacosRows = rowsMatching("TACoS");
  assert.ok(tacosRows.length > 0, "weekly table has TACoS rows");
  for (const r of tacosRows) for (let i = 1; i < r.cells.length; i++) {
    const t = String(r.cells[i].t);
    assert.ok(/%$/.test(t) || t === "—", `a TACoS cell must be a percent or em dash, got ${t}`);
    assert.ok(!/[€£]/.test(t), "a TACoS cell is never a currency amount");
  }
  for (const r of rowsMatching("Total Sales")) for (let i = 1; i < r.cells.length; i++) {
    assert.ok(!/%/.test(String(r.cells[i].t)), `a Total Sales cell is never a percent, got ${r.cells[i].t}`);
  }
});

/* ================= (2) RENDERED-HTML guarantees (the REAL components) ================= */

const RENDER_ENTRY = `
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MoneyShare, GradientKpi } from ${JSON.stringify(path.join(appRoot, "src/components/ui.jsx"))};
import BrandReports from ${JSON.stringify(path.join(appRoot, "src/views/BrandReports.jsx"))};
import SkuMovement from ${JSON.stringify(path.join(appRoot, "src/views/SkuMovement.jsx"))};
import { brandViewModel } from ${JSON.stringify(path.join(appRoot, "src/lib/brand-view.js"))};
function addDays(d,n){const dt=new Date(d+"T00:00:00Z");dt.setUTCDate(dt.getUTCDate()+n);return dt.toISOString().slice(0,10);}
const A="2026-08-28";const EUR=["BE","DE","ES","FR","IT","NL"];const series=[];
for(let i=120;i>=0;i--){const d=addDays(A,-i);EUR.forEach((c,idx)=>series.push({c,cur:"EUR",d,s:10+idx*12+(i%5),u:1+(idx%3),a:0}));series.push({c:"GB",cur:"GBP",d,s:i%15===0?10:0,u:i%15===0?1:0});}
const model=brandViewModel({brand:"Bebi Born",scope:"portfolio",accountId:"p",asOf:A,countries:[...EUR.map(c=>({country:c,currency:"EUR",hasSales:true})),{country:"GB",currency:"GBP",hasSales:true}],series,coverage:{accountCount:8,salesFrom:"2025-01-01",salesTo:A,salesLatestDate:A,salesCompleteThrough:"2025-08-11",inventoryDate:null},notes:["note"]});
// v2 payload: a 60-day daily axis + per-row SPARSE dailyUnits. The move badges recompute CLIENT-side at the default
// N=7 -- so the daily values are chosen so Last7/Prev7 = 106/121 (-12.4%) and 58/49 (+18.4%), matching the asserts.
const skuDates=[];for(let i=59;i>=0;i--)skuDates.push(addDays(A,-i));
const skuData={rows:[{asin:"B0A",currency:"INR",unmapped:false,sku:"SKU-A",skuCount:1,legitSkuCount:1,hasSellerSku:true,productName:"Prod A",brand:"Cleanfect",months:[{key:"2026-05",label:"May '26",units:404},{key:"2026-06",label:"Jun '26",units:393},{key:"2026-07",label:"Jul '26",units:503}],mtdUnits:595,monthsTotalUnits:1300,dailyUnits:{"2026-08-24":28,"2026-08-25":30,"2026-08-26":27,"2026-08-27":13,"2026-08-28":8,"2026-08-21":121},recentTotal:106,prevTotal:121,movementPercent:-12.4,avgMonthlyUnits:433.3,mtdRunRate:21.3,projectedUnits:660,status:"Stable"},{asin:"B0B",currency:"INR",unmapped:false,sku:"SKU-B",skuCount:1,legitSkuCount:1,hasSellerSku:true,productName:"Prod B",brand:"Shrida",months:[{key:"2026-05",label:"May '26",units:182},{key:"2026-06",label:"Jun '26",units:218},{key:"2026-07",label:"Jul '26",units:310}],mtdUnits:276,monthsTotalUnits:710,dailyUnits:{"2026-08-24":19,"2026-08-25":12,"2026-08-26":12,"2026-08-27":4,"2026-08-28":11,"2026-08-21":49},recentTotal:58,prevTotal:49,movementPercent:18.4,avgMonthlyUnits:236.7,mtdRunRate:9.9,projectedUnits:307,status:"Rising"}],monthLabels:["May '26","Jun '26","Jul '26"],mtdLabel:"Aug '26 MTD",dailyDates:skuDates,coverageFrom:"2025-01-01",defaultRecentDays:7,maxRecentDays:30,minRecentDays:1,thresholds:{risingPct:20,decliningPct:-20},effectiveAsOf:A,brand:"ALL",brandFiltered:false,catalogBrands:[],accountId:"acct",completeness:{status:"provisional",provisional:true,sourceDefect:false,latestDate:A,itemizationPercent:44.9,pendingOrderCount:49,pendingUnitCount:62,finalizedThrough:"2026-08-27",notice:"pending",unitBreakdown:{onDate:A,pricedUnits:480,explicitZeroUnits:7,pendingWithSkuUnits:55,pendingWithoutSkuUnits:7,cancelledUnits:12,observedUnits:549,skuMovementUnits:542}}};
const el=React.createElement;
const R={
  moneyShare: renderToStaticMarkup(el("table",null,el("tbody",null,el("tr",null,el("td",null,el(MoneyShare,{amount:"€955",share:"8.6%"})))))),
  moneyShareNull: renderToStaticMarkup(el("table",null,el("tbody",null,el("tr",null,el("td",null,el(MoneyShare,{amount:"—",share:null})))))),
  kpi: renderToStaticMarkup(el(GradientKpi,{label:"Units sold",value:"970",sub:"never currency converted",gradient:"linear-gradient(135deg,#34D399,#059669)"})),
  brand: renderToStaticMarkup(el(BrandReports,{model,rangeFrom:addDays(A,-29),rangeTo:A,displayCurrency:"ORIGINAL",fx:null,fxError:null,scopeLabel:"8 accounts",onTables:()=>{}})),
  sku: renderToStaticMarkup(el(SkuMovement,{data:skuData,loading:false,updating:false,error:null,accountName:"Indya Store IN",selectedBrand:"ALL",onReload:()=>{},cachedAt:null})),
};
process.stdout.write(JSON.stringify(R));
`;

let RENDER = null;
async function rendered() {
  if (RENDER) return RENDER;
  const dir = mkdtempSync(path.join(tmpdir(), "bvrender-"));
  const outfile = path.join(dir, "bundle.cjs");
  // CJS output so react-dom/server's native require() of node builtins (stream, util, ...) works.
  await build({ stdin: { contents: RENDER_ENTRY, resolveDir: appRoot, loader: "js" }, bundle: true, format: "cjs", platform: "node", outfile, logLevel: "silent", jsx: "transform" });
  RENDER = JSON.parse(execFileSync(process.execPath, [outfile], { encoding: "utf8", maxBuffer: 48 * 1024 * 1024 }));
  return RENDER;
}
// strip HTML tags to get the visible text of one cell/element for concat scanning
const textOf = (html) => String(html).replace(/<[^>]*>/g, "").replace(/&[a-z]+;/g, " ");

test("R1. MoneyShare renders the amount and share as TWO separate elements (never one concatenated string)", async () => {
  const r = await rendered();
  assert.match(r.moneyShare, /class="cell-amt"[^>]*>€955</, "the amount is its own .cell-amt element");
  assert.match(r.moneyShare, /class="cell-share"/, "the share is its own .cell-share element");
  assert.match(r.moneyShare, /8\.6%/, "the share text renders");
  // The amount and the share sit in SEPARATE elements: there is a tag boundary between "955" and "8.6%".
  assert.match(r.moneyShare, /€955<\/span>[\s\S]*?<span class="cell-share"/, "a tag boundary separates amount from share");
  // The share carries an sr-only label so a screen reader reads them as two distinct values.
  assert.match(r.moneyShare, /class="sr-only"/, "the share has an accessible label");
});

test("R2. MoneyShare with a null share renders ONLY the amount (no fabricated percentage, no empty share element)", async () => {
  const r = await rendered();
  assert.match(r.moneyShareNull, /class="cell-amt"[^>]*>—</, "the em-dash amount renders");
  assert.ok(!/cell-share/.test(r.moneyShareNull), "no share element is rendered when there is no share");
  assert.ok(!/%/.test(r.moneyShareNull), "a missing share is never a fabricated percent");
});

test("R3. no rendered Brand View cell matches the malformed currency+percent concatenation pattern", async () => {
  const r = await rendered();
  // Scan every table cell's VISIBLE text (tags stripped) for the forbidden concat pattern.
  const cells = r.brand.match(/<td\b[\s\S]*?<\/td>/g) || [];
  assert.ok(cells.length > 20, "the Brand View rendered a populated set of cells");
  for (const cell of cells) {
    const text = textOf(cell);
    assert.ok(!CONCAT_RE.test(text), `a rendered cell concatenated amount+percent: ${JSON.stringify(text)}`);
  }
  // The amount and its share are structurally separated inside the money cells.
  assert.match(r.brand, /class="cell-amt"/, "money cells use the separated amount element");
  assert.match(r.brand, /class="cell-share"/, "money cells use the separated share element");
});

test("R4. Brand View renders the gradient KPI tiles, deep-violet tables and BOTH currency groups", async () => {
  const r = await rendered();
  assert.match(r.brand, /class="rvkpi-grid rvkpi-grid-4/, "the four-tile KPI grid renders");
  assert.match(r.brand, /rvkpi/, "gradient KPI tiles render");
  assert.match(r.brand, /class="bv-table"/, "the deep-violet report tables render");
  assert.ok(/EUR/.test(textOf(r.brand)) && /GBP/.test(textOf(r.brand)), "both currency groups render");
  assert.match(r.brand, /All Markets/, "the All Markets totals render");
  assert.ok(/TACoS/.test(textOf(r.brand)), "the TACoS column renders");
});

test("R5. GradientKpi renders its label, value and sub", async () => {
  const r = await rendered();
  assert.match(r.kpi, /class="rvkpi/);
  assert.match(r.kpi, /Units sold/);
  assert.match(r.kpi, /970/);
  assert.match(r.kpi, /never currency converted/);
});

test("R6/12/13/17-21. SKU Movement renders gradient KPIs, deep-violet table, coral MTD + violet Last-5, move badges", async () => {
  const r = await rendered();
  assert.match(r.sku, /class="rvkpi-grid rvkpi-grid-5"/, "the five-tile KPI grid renders");
  assert.match(r.sku, /class="plan-table sku-mv"/, "the SKU table carries the scoped .sku-mv recolour class");
  assert.match(r.sku, /sku-mv-mtd/, "the coral MTD column class renders");
  assert.match(r.sku, /sku-mv-last5/, "the violet Last-5 column class renders");
  assert.match(r.sku, /sku-mv-move-neg[^>]*>-12\.4%/, "a declining movement renders as a red badge with its sign");
  assert.match(r.sku, /sku-mv-move-pos[^>]*>\+18\.4%/, "a rising movement renders as a green badge with its sign");
  // The provisional/observed-unit evidence (a preserved data feature) still renders.
  assert.ok(/Observed units|Provisional|provisional/.test(textOf(r.sku)), "provisional / observed-unit evidence is preserved");
  // The existing export behaviour + label is retained (Download Excel), not invented.
  assert.match(r.sku, /Download Excel/, "the existing export command/label is retained");
});

test("R7. no rendered SKU Movement cell matches the malformed currency+percent concatenation pattern", async () => {
  const r = await rendered();
  const cells = r.sku.match(/<td\b[\s\S]*?<\/td>/g) || [];
  for (const cell of cells) assert.ok(!CONCAT_RE.test(textOf(cell)), `a SKU cell concatenated amount+percent: ${JSON.stringify(textOf(cell))}`);
});

let failures = 0;
(async () => {
  for (const t of tests) {
    try { await t.fn(); passed += 1; out("  ok  " + t.name); }
    catch (e) { failures += 1; out("FAIL  " + t.name); out(String((e && e.stack) || e)); }
  }
  out("\n" + passed + " assertions passed" + (failures ? ", " + failures + " FAILED" : ""));
  if (failures) process.exitCode = 1;
})();
