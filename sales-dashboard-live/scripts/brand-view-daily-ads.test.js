// Brand View DAILY SNAPSHOT -- Ad Spend + TACoS% columns (added between "LY Sales" and "FBA Inv.").
//
// Proves, against the REAL canonical view model (brand-view.js -> brand-view-tables.js), for the account-scoped and
// cross-account Daily Snapshot (they share buildDailyTable): column ORDER + labels; EXACT per-brand-marketplace Ad
// Spend + TACoS from the saved Ads series; All Markets = AGGREGATED spend / AGGREGATED sales (never an average of
// per-country percentages); multi-currency groups stay separate; a COVERED zero shows 0 while UNAVAILABLE Ads show an
// em dash; a PARTIAL All Markets (any marketplace unavailable) is WITHHELD (em dash + tooltip), never shown complete;
// ZERO sales -> TACoS em dash; the tooltip names the ACTIVE attribution (Campaign Ads); and screen<->Excel/CSV export
// PARITY (buildExportModel maps the same dailyTable). Zero network. LF.
import assert from "node:assert/strict";
import { writeSync, mkdtempSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { build } from "esbuild";
import { brandViewModel } from "../src/lib/brand-view.js";
import { buildBrandTables, DASH } from "../src/lib/brand-view-tables.js";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let passed = 0;
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const ok = (n, c) => { assert.ok(c, n); };

const ANCHOR = "2026-08-28";
const DATES = ["2026-08-26", "2026-08-27", "2026-08-28"]; // the 3-day selected range
const RANGE = { rangeFrom: DATES[0], rangeTo: DATES[2], displayCurrency: "ORIGINAL", rates: null };

// Build a Brand View model with Ads coverage. `spec` maps country -> { cur, s (sales/day), a (spend/day or null), ads }.
// a===null (or ads:false) => that marketplace's Ads is UNAVAILABLE for the window. ads defaults true.
function modelOf(spec) {
  const series = [];
  const countries = [];
  for (const [c, def] of Object.entries(spec)) {
    countries.push({ country: c, currency: def.cur, hasSales: true, adsAvailable: def.ads !== false });
    for (const d of DATES) {
      const row = { c, cur: def.cur, d, s: def.s, u: 1 };
      if (def.a !== null && def.a !== undefined && def.ads !== false) row.a = def.a;
      series.push(row);
    }
  }
  return brandViewModel({
    brand: "Bebi Born", scope: "portfolio", accountId: "portfolio", asOf: ANCHOR, countries, series,
    coverage: {
      accountCount: 3, salesFrom: "2025-01-01", salesTo: ANCHOR, salesLatestDate: ANCHOR,
      adsFrom: "2025-01-01", adsTo: ANCHOR, inventoryDate: null,
    },
    notes: [],
  });
}
const dailyOf = (spec) => buildBrandTables(modelOf(spec), RANGE).dailyTable;
// Rows carry deterministic keys: "<CUR>-<COUNTRY>" for a marketplace, "total-<CUR>" for an All Markets total.
const R = (t, key) => t.rows.find((r) => r.key === key);
const totalRow = (t) => t.rows.find((r) => r.kind === "total");

// The canonical fixture: DE+FR in EUR (both covered) + GB in GBP (covered). Known values:
//   DE sales 300, spend 30 -> 10%   FR sales 600, spend 90 -> 15%   GB sales 150 GBP, spend 15 -> 10%
//   EUR All Markets: sales 900, spend 120 -> 13.3% (AGGREGATED; the average of 10% and 15% would be 12.5%)
const BASE = { DE: { cur: "EUR", s: 100, a: 10 }, FR: { cur: "EUR", s: 200, a: 30 }, GB: { cur: "GBP", s: 50, a: 5 } };

test("column ORDER: Ad Spend then TACoS% sit exactly between LY Sales and FBA Inv.", () => {
  const t = dailyOf(BASE);
  const keys = t.headers.map((h) => h.key);
  assert.deepEqual(keys, ["country", "sales", "ly", "spend", "tacos", "fba", "cover", "units"], "headers in canonical order");
  const iLy = keys.indexOf("ly"), iSpend = keys.indexOf("spend"), iTacos = keys.indexOf("tacos"), iFba = keys.indexOf("fba");
  ok("Ad Spend immediately after LY Sales", iSpend === iLy + 1);
  ok("TACoS% immediately after Ad Spend", iTacos === iSpend + 1);
  ok("FBA Inv. immediately after TACoS%", iFba === iTacos + 1);
  ok("labels are 'Ad Spend' and 'TACoS%'", /^Ad Spend/.test(t.headers[iSpend].label) && t.headers[iTacos].label === "TACoS%");
});

test("attribution TOOLTIP names the ACTIVE method (Campaign Ads), not the retired same-ASIN wording", () => {
  const t = dailyOf(BASE);
  const spendHint = t.headers.find((h) => h.key === "spend").hint;
  ok("Ad Spend tooltip says Campaign Ads", /Campaign Ads/.test(spendHint));
  ok("Ad Spend tooltip no longer says 'same-ASIN'", !/same-ASIN/i.test(spendHint));
  ok("dash tooltip is honest (dash != zero)", /(not|never) zero spend/i.test(spendHint));
  ok("Ad Spend tooltip names unmapped/unknown attribution as a dash reason", /unmapped|attribution/i.test(spendHint));
});

test("EXACT per-brand-marketplace spend + TACoS from saved Ads (each brand only its own mapped spend, own currency)", () => {
  const t = dailyOf(BASE);
  const de = R(t, "EUR-DE"), fr = R(t, "EUR-FR"), gb = R(t, "GBP-GB");
  ok("DE spend = 30 EUR", de.cells[3].n === 30 && /€|EUR/.test(de.cells[3].t));
  ok("DE TACoS = 10.0%", de.cells[4].t === "10.0%" && Math.abs(de.cells[4].n - 10) < 1e-9);
  ok("FR spend = 90 EUR", fr.cells[3].n === 90);
  ok("FR TACoS = 15.0%", fr.cells[4].t === "15.0%");
  ok("GB spend = 15 GBP (own currency, not mixed)", gb.cells[3].n === 15 && /£|GBP/.test(gb.cells[3].t));
  ok("GB TACoS = 10.0%", gb.cells[4].t === "10.0%");
});

test("ALL MARKETS = aggregated spend / aggregated sales, NEVER an average of country percentages", () => {
  const t = dailyOf(BASE);
  const eurTotal = totalRow(t); // the EUR group's All Markets (GBP is a single marketplace -> no total row)
  ok("All Markets spend = 120 EUR (30+90)", eurTotal.cells[3].n === 120);
  ok("All Markets TACoS = 13.3% (120/900), not 12.5% (avg of 10% & 15%)", eurTotal.cells[4].t === "13.3%" && Math.abs(eurTotal.cells[4].n - (120 / 900) * 100) < 1e-6);
  ok("All Markets TACoS is NOT the averaged 12.5%", eurTotal.cells[4].t !== "12.5%");
});

test("MULTI-CURRENCY: EUR total stays in EUR, GBP marketplace stays in GBP; no cross-currency spend total", () => {
  const t = dailyOf(BASE);
  const eurTotal = totalRow(t);
  ok("EUR All Markets spend is a € amount", /€|EUR/.test(eurTotal.cells[3].t) && !/£/.test(eurTotal.cells[3].t));
  const gb = R(t, "GBP-GB");
  ok("GB keeps £, never folded into the EUR spend total", /£|GBP/.test(gb.cells[3].t) && !/€/.test(gb.cells[3].t));
});

test("COVERED ZERO shows a real 0 (not em dash): Ads available + coverage proves zero spend", () => {
  const t = dailyOf({ DE: { cur: "EUR", s: 100, a: 0 }, FR: { cur: "EUR", s: 200, a: 0 } });
  const de = R(t, "EUR-DE");
  ok("DE spend is a genuine 0 (covered), not a dash", de.cells[3].n === 0 && de.cells[3].t !== DASH);
  ok("DE TACoS is 0.0% (0/300), a genuine covered zero", de.cells[4].t === "0.0%");
  const total = totalRow(t);
  ok("All Markets spend 0 (both covered), TACoS 0.0%", total.cells[3].n === 0 && total.cells[4].t === "0.0%");
});

test("UNAVAILABLE Ads for a marketplace shows an em dash (never a fabricated zero)", () => {
  const t = dailyOf({ DE: { cur: "EUR", s: 100, a: 10 }, FR: { cur: "EUR", s: 200, ads: false } });
  const fr = R(t, "EUR-FR");
  ok("FR (no Ads) spend is an em dash", fr.cells[3].t === DASH && fr.cells[3].n === undefined);
  ok("FR TACoS is an em dash", fr.cells[4].t === DASH);
});

test("PARTIAL All Markets is WITHHELD (em dash + tooltip), never shown as a complete partial total", () => {
  const t = dailyOf({ DE: { cur: "EUR", s: 100, a: 10 }, FR: { cur: "EUR", s: 200, ads: false } });
  const total = totalRow(t);
  ok("All Markets spend em dash when one marketplace is unavailable (not the partial 30)", total.cells[3].t === DASH);
  ok("All Markets TACoS em dash too", total.cells[4].t === DASH);
  ok("the withheld spend cell carries an accurate 'not shown partial' tooltip", /partial/i.test(String(total.hints?.[3] || "")) && /coverage|exchange rate/i.test(String(total.hints?.[3] || "")));
});

test("ZERO sales -> TACoS em dash (cannot divide by zero), spend still shown", () => {
  const t = dailyOf({ DE: { cur: "EUR", s: 0, a: 10 }, FR: { cur: "EUR", s: 0, a: 20 } });
  const de = R(t, "EUR-DE");
  ok("DE spend still shows (30 = 10/day x3)", de.cells[3].n === 30);
  ok("DE TACoS em dash (0 sales denominator)", de.cells[4].t === DASH);
  const total = totalRow(t);
  ok("All Markets spend 90 (30+60) but TACoS em dash (0 sales)", total.cells[3].n === 90 && total.cells[4].t === DASH);
});

test("MULTIPLE ACCOUNTS (portfolio scope): a marketplace summed across accounts still shows only this brand's spend", () => {
  // Two accounts contribute to the SAME country DE (the model already sums the series by (country,date)); the brand's
  // DE spend is the sum of the brand's mapped campaigns, never whole-account spend. Model as two series rows/day for DE.
  const series = [];
  for (const d of DATES) {
    series.push({ c: "DE", cur: "EUR", d, s: 100, u: 1, a: 10 }); // account 1
    series.push({ c: "DE", cur: "EUR", d, s: 50, u: 1, a: 5 });   // account 2
  }
  const model = brandViewModel({
    brand: "Bebi Born", scope: "portfolio", accountId: "portfolio", asOf: ANCHOR,
    countries: [{ country: "DE", currency: "EUR", hasSales: true, adsAvailable: true, accounts: ["a1", "a2"] }],
    series, coverage: { accountCount: 2, salesFrom: "2025-01-01", salesTo: ANCHOR, salesLatestDate: ANCHOR, adsFrom: "2025-01-01", adsTo: ANCHOR },
    notes: [],
  });
  const t = buildBrandTables(model, RANGE).dailyTable;
  const de = R(t, "EUR-DE");
  ok("DE spend = 45 (30+15, both accounts' brand-mapped spend)", de.cells[3].n === 45);
  ok("DE TACoS = 10.0% (45/450)", de.cells[4].t === "10.0%");
});

// ===== UNMAPPED / UNATTRIBUTED campaign spend: unknown attribution -> em dash, NEVER a fabricated 0 =====
// A `au:true` series day means the marketplace has campaign spend NOT mapped to any brand. That spend could be this
// brand's, so a 0 for the brand is NOT proven -> show an em dash unless the source proves the brand's zero. (Mirrors
// the server aggregateBrandCampaignAdsSpend/assembleBrandViewPayload unattributed path.)
function dailyRaw(series, countries) {
  const model = brandViewModel({
    brand: "X", scope: "account", accountId: "a", asOf: ANCHOR, countries, series,
    coverage: { accountCount: 1, salesFrom: "2025-01-01", salesTo: ANCHOR, salesLatestDate: ANCHOR, adsFrom: "2025-01-01", adsTo: ANCHOR },
  });
  return buildBrandTables(model, RANGE).dailyTable;
}
const IN_ONLY = [{ country: "IN", currency: "INR", hasSales: true, adsAvailable: true }];
test("UNATTRIBUTED (unmapped) spend + no mapped brand spend -> Ad Spend em dash, NOT a fabricated 0", () => {
  const series = DATES.map((d) => ({ c: "IN", cur: "INR", d, s: 1000, u: 10, au: true })); // au flag, no `a`
  const t = dailyRaw(series, IN_ONLY);
  const inRow = R(t, "INR-IN");
  ok("IN Ad Spend is an em dash (unknown attribution), never a fabricated 0", inRow.cells[3].t === DASH && inRow.cells[3].n === undefined);
  ok("IN TACoS is an em dash too", inRow.cells[4].t === DASH);
  ok("All Markets also withheld (em dash), never a partial/fabricated 0", totalRow(t).cells[3].t === DASH && totalRow(t).cells[4].t === DASH);
});
test("UNATTRIBUTED spend but the brand HAS mapped spend > 0 -> the known mapped value is still shown", () => {
  const series = DATES.map((d) => ({ c: "IN", cur: "INR", d, s: 1000, u: 10, a: 50, au: true }));
  const inRow = R(dailyRaw(series, IN_ONLY), "INR-IN");
  ok("IN Ad Spend = 150 (50/day x3) shown despite coexisting unmapped spend", inRow.cells[3].n === 150 && inRow.cells[3].t !== DASH);
});
test("NO unattributed spend + brand mapped 0 -> a genuine PROVEN 0 (fully attributed)", () => {
  const series = DATES.map((d) => ({ c: "IN", cur: "INR", d, s: 1000, u: 10, a: 0 }));
  const inRow = R(dailyRaw(series, IN_ONLY), "INR-IN");
  ok("IN Ad Spend genuine 0 (no unmapped spend -> proven zero)", inRow.cells[3].n === 0 && inRow.cells[3].t !== DASH);
});

// SCREEN <-> EXPORT parity: buildExportModel (BrandReports.jsx) maps the SAME dailyTable into the Excel/CSV report.
test("screen<->export PARITY: the export's Daily Snapshot carries Ad Spend + TACoS% with the same values", async () => {
  const entry = `
import { brandViewModel } from ${JSON.stringify(path.join(appRoot, "src/lib/brand-view.js"))};
import { buildBrandTables } from ${JSON.stringify(path.join(appRoot, "src/lib/brand-view-tables.js"))};
import { buildExportModel } from ${JSON.stringify(path.join(appRoot, "src/views/BrandReports.jsx"))};
const DATES=["2026-08-26","2026-08-27","2026-08-28"]; const series=[];
for(const d of DATES){series.push({c:"DE",cur:"EUR",d,s:100,u:1,a:10});series.push({c:"FR",cur:"EUR",d,s:200,u:1,a:30});}
const model=brandViewModel({brand:"Bebi Born",scope:"portfolio",accountId:"p",asOf:"2026-08-28",countries:[{country:"DE",currency:"EUR",hasSales:true,adsAvailable:true},{country:"FR",currency:"EUR",hasSales:true,adsAvailable:true}],series,coverage:{accountCount:2,salesFrom:"2025-01-01",salesTo:"2026-08-28",salesLatestDate:"2026-08-28",adsFrom:"2025-01-01",adsTo:"2026-08-28"},notes:[]});
const tables=buildBrandTables(model,{rangeFrom:"2026-08-26",rangeTo:"2026-08-28",displayCurrency:"ORIGINAL",rates:null});
const ex=buildExportModel({tables,model,meta:{rangeLabel:"r",currencyLabel:"EUR"}});
const daily=ex.reports.find((r)=>r.id==="daily");
process.stdout.write(JSON.stringify({ headers: daily.headers, screenHeaders: tables.dailyTable.headers.map((h)=>h.label), rowCount: daily.rows.length, screenRowCount: tables.dailyTable.rows.length, dailyCells: daily.rows.map((r)=>r.cells.map((c)=>c.t)) }));
`;
  const dir = mkdtempSync(path.join(tmpdir(), "bvexport-"));
  const outfile = path.join(dir, "bundle.cjs");
  await build({ stdin: { contents: entry, resolveDir: appRoot, loader: "js" }, bundle: true, format: "cjs", platform: "node", outfile, logLevel: "silent", jsx: "transform" });
  const R = JSON.parse(execFileSync(process.execPath, [outfile], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }));
  ok("export daily headers include Ad Spend + TACoS%", R.headers.some((h) => /^Ad Spend/.test(h)) && R.headers.includes("TACoS%"));
  ok("export headers EQUAL the screen dailyTable headers (no divergence)", JSON.stringify(R.headers) === JSON.stringify(R.screenHeaders));
  ok("export row count equals the screen row count", R.rowCount === R.screenRowCount);
  const flat = R.dailyCells.flat().join(" | ");
  ok("the exported Daily Snapshot contains the 120 All Markets spend + 13.3% TACoS (same as screen)", /120/.test(flat) && /13\.3%/.test(flat));
});

let failures = 0;
(async () => {
  for (const t of tests) {
    try { await t.fn(); passed += 1; out("  ok  " + t.name); }
    catch (e) { failures += 1; out("FAIL  " + t.name); out(String((e && e.stack) || e)); }
  }
  out("\nbrand-view-daily-ads: " + passed + " tests passed" + (failures ? ", " + failures + " FAILED" : ""));
  if (failures) process.exitCode = 1;
})();
