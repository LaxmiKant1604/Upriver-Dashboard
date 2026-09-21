// Daily Reporting redesign -- PURE view-model regressions. Proves the KPI strip, the 5-day trend series, and the
// completeness badge are derived HONESTLY from the same daily report the table renders, with the business formulas
// unchanged: ROI = Total Sales / Ad Spend (NOT Ad Sales / Ad Spend); ACoS = Ad Spend / Ad Sales; TACoS = Ad Spend /
// Total Sales; a zero/missing/unavailable denominator renders "--" (never Infinity/NaN/fabricated 0); advertising a
// period does not cover is an honest null gap; the MTD + day columns are found DYNAMICALLY (never hard-coded).
// 7-bit ASCII, LF, no top-level await.
import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { EM_DASH } from "../src/lib/daily-metrics.js";
import { mtdColumnIndex, dailyMtdKpis, dailyTrendSeries, lastFinite, dailyCompletenessLabel } from "../src/lib/daily-view-model.js";

let passed = 0;
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// A representative daily report: 3 months + MTD + 5 days, with real advertising on the MTD + day columns and NO
// advertising on the completed months (the durable ASIN Ads have no monthly history -> hasAd:false there).
function makeReport() {
  const cell = (sales, units, adSales, adSpend, clicks, hasAd) => ({ sales, units, adSales, adSpend, clicks, hasAd });
  return {
    latest: "2026-08-24",
    columns: [
      { key: "m1", group: "month", label: "May '26" },
      { key: "m2", group: "month", label: "Jun '26" },
      { key: "m3", group: "month", label: "Jul '26" },
      { key: "mtd", group: "mtd", label: "Aug '26 MTD" },
      { key: "d0", group: "day", label: "20-Aug" },
      { key: "d1", group: "day", label: "21-Aug" },
      { key: "d2", group: "day", label: "22-Aug" },
      { key: "d3", group: "day", label: "23-Aug" },
      { key: "d4", group: "day", label: "24-Aug" },
    ],
    cells: [
      cell(3450673, 9147, 0, 0, 0, false),
      cell(3574883, 8840, 0, 0, 0, false),
      cell(3994264, 10166, 0, 0, 0, false),
      cell(3406980, 8688, 1690921, 487505, 43089, true),
      cell(120947, 291, 71415, 19696, 1850, true),
      cell(98527, 242, 60787, 16361, 1466, true),
      cell(102551, 253, 54585, 18483, 1650, true),
      cell(144551, 359, 78702, 22909, 2124, true),
      cell(116696, 295, 66868, 19899, 1846, true),
    ],
  };
}

test("MTD column is found DYNAMICALLY by group, not a fixed index", () => {
  assert.equal(mtdColumnIndex(makeReport()), 3);
  // Shift the layout: fewer months -> the MTD index moves, and the finder tracks it.
  const shifted = { columns: [{ group: "month" }, { group: "mtd", label: "x" }, { group: "day" }], cells: [{}, { sales: 5, hasAd: false }, {}] };
  assert.equal(mtdColumnIndex(shifted), 1);
  assert.equal(mtdColumnIndex({ columns: [{ group: "day" }] }), -1);
});

test("the six KPIs are sourced ENTIRELY from the MTD column cell", () => {
  const k = dailyMtdKpis(makeReport());
  assert.equal(k.label, "Aug '26 MTD");
  assert.equal(k.totalSales, 3406980);
  assert.equal(k.adSales, 1690921);
  assert.equal(k.adSpend, 487505);
  // ROI = Total Sales / Ad Spend = 3406980 / 487505 = 6.99 (NOT adSales/spend = 3.47).
  assert.equal(k.roi, "6.99");
  assert.notEqual(k.roi, (1690921 / 487505).toFixed(2));
  // ACoS = Ad Spend / Ad Sales = 487505 / 1690921 = 28.8%.
  assert.equal(k.acos, "28.8%");
  // TACoS = Ad Spend / Total Sales = 487505 / 3406980 = 14.3%.
  assert.equal(k.tacos, "14.3%");
});

test("ROI uses Total Sales / Ad Spend on the summed MTD cell (business return), never Ad Sales / Ad Spend", () => {
  const k = dailyMtdKpis(makeReport());
  const wrong = (1690921 / 487505).toFixed(2); // the ad-efficiency ratio -- must NOT be what ROI shows
  assert.equal(k.roi, "6.99");
  assert.notEqual(k.roi, wrong);
});

test("a zero / missing / unavailable denominator renders em dash -- never Infinity / NaN / fabricated 0", () => {
  const report = makeReport();
  // MTD with advertising present but Ad Spend 0 and Ad Sales 0.
  report.cells[3] = { sales: 3406980, units: 8688, adSales: 0, adSpend: 0, clicks: 0, hasAd: true };
  const k = dailyMtdKpis(report);
  assert.equal(k.roi, EM_DASH);   // /0 spend
  assert.equal(k.acos, EM_DASH);  // /0 ad sales
  assert.equal(k.tacos, "0.0%");  // spend 0 / sales -> honest 0.0%, finite
  assert.ok(!String(k.roi).includes("Infinity") && !String(k.roi).includes("NaN"));
});

test("advertising UNAVAILABLE for the period yields null KPI money (an honest gap), not 0", () => {
  const report = makeReport();
  report.cells[3] = { sales: 3406980, units: 8688, adSales: 0, adSpend: 0, clicks: 0, hasAd: false };
  const k = dailyMtdKpis(report);
  assert.equal(k.adSales, null);
  assert.equal(k.adSpend, null);
  assert.equal(k.roi, EM_DASH);
  assert.equal(k.acos, EM_DASH);
  assert.equal(k.tacos, EM_DASH);
  assert.equal(k.totalSales, 3406980); // sales still real
});

test("trend series use the EXACT latest-five daily entries, in order", () => {
  const t = dailyTrendSeries(makeReport());
  assert.deepEqual(t.labels, ["20-Aug", "21-Aug", "22-Aug", "23-Aug", "24-Aug"]);
  assert.deepEqual(t.sales, [120947, 98527, 102551, 144551, 116696]);
  assert.deepEqual(t.adSales, [71415, 60787, 54585, 78702, 66868]);
  // ROI per day = sales / adSpend.
  assert.equal(t.roi[0].toFixed(2), (120947 / 19696).toFixed(2));
  assert.equal(t.roi.length, 5);
  // ACoS per day = adSpend / adSales * 100.
  assert.equal(t.acos[0].toFixed(1), ((19696 / 71415) * 100).toFixed(1));
});

test("trend series drop advertising gaps as null (honest), never as 0", () => {
  const report = makeReport();
  // One day has NO advertising coverage.
  report.cells[6] = { sales: 102551, units: 253, adSales: 0, adSpend: 0, clicks: 0, hasAd: false };
  const t = dailyTrendSeries(report);
  assert.equal(t.adSales[2], null);
  assert.equal(t.roi[2], null);
  assert.equal(t.acos[2], null);
  assert.equal(t.sales[2], 102551); // sales still real on that day
  // lastFinite skips trailing nulls but keeps real trailing values.
  assert.equal(lastFinite(t.roi), t.roi[4]);
  assert.equal(lastFinite([1, 2, null]), 2);
  assert.equal(lastFinite([null, null]), null);
});

test("MTD KPI honours OLI coverage (flexii UK follow-up): unavailable/unknown -> totalSales null (em dash) + ratios em dash; NOT a fabricated/understated total", () => {
  for (const status of ["unavailable", "unknown"]) {
    const report = makeReport();
    report.cells[3] = { ...report.cells[3], status };
    const k = dailyMtdKpis(report);
    assert.equal(k.totalSales, null, status + " MTD -> no OLI total shown");
    assert.equal(k.salesPartial, false);
    assert.equal(k.roi, EM_DASH, status + " -> ROI em dash (sales not fully covered)");
    assert.equal(k.tacos, EM_DASH);
  }
});

test("MTD KPI: a PARTIAL MTD shows the source-backed covered-only total + a salesPartial marker; ratios em dash", () => {
  const report = makeReport();
  report.cells[3] = { ...report.cells[3], status: "partial" };
  const k = dailyMtdKpis(report);
  assert.equal(k.totalSales, 3406980, "the covered-only total is still shown (matches the table's Partial column)");
  assert.equal(k.salesPartial, true, "the card is flagged partial (no silent full-availability claim)");
  assert.equal(k.roi, EM_DASH, "a partial-window total must not mint a ratio");
  assert.equal(k.tacos, EM_DASH);
});

test("MTD KPI: a COVERED MTD (incl. a genuine covered zero) shows the total + no partial marker + real ratios", () => {
  const report = makeReport();
  report.cells[3] = { ...report.cells[3], status: "covered" };
  const k = dailyMtdKpis(report);
  assert.equal(k.totalSales, 3406980);
  assert.equal(k.salesPartial, false);
  assert.equal(k.roi, "6.99", "a fully covered period keeps its real ratio");
});

test("trend series honour OLI coverage: an unavailable/unknown day is a null GAP (never a plotted 0); covered/partial plot the total", () => {
  const report = makeReport();
  report.cells[6] = { ...report.cells[6], status: "unavailable" }; // day index 2 of the 5-day series
  report.cells[7] = { ...report.cells[7], status: "partial" };
  report.cells[8] = { ...report.cells[8], status: "covered" };
  const t = dailyTrendSeries(report);
  assert.equal(t.sales[2], null, "an unavailable day is a gap, never a plotted 0 lastFinite could headline");
  assert.equal(t.roi[2], null, "a sales-derived ratio is dropped for an unavailable day");
  assert.equal(t.sales[3], 144551, "a partial day plots its source-backed total");
  assert.equal(t.sales[4], 116696, "a covered day plots its total");
});

test("completeness badge preserves the provisional > source-defect > final precedence", () => {
  assert.equal(dailyCompletenessLabel(null), null);
  assert.deepEqual(dailyCompletenessLabel({ provisional: true }), { label: "Provisional D-1", tone: "provisional" });
  assert.deepEqual(dailyCompletenessLabel({ provisional: false, sourceDefect: true }), { label: "Source issue", tone: "defect" });
  assert.deepEqual(dailyCompletenessLabel({ provisional: false, sourceDefect: false }), { label: "Final D-1", tone: "final" });
  // provisional wins even if a defect flag is also set.
  assert.equal(dailyCompletenessLabel({ provisional: true, sourceDefect: true }).tone, "provisional");
});

test("KPI/trend derivations are pure reads: the same brand-scoped cells flow through unchanged", () => {
  // The report's cells are already brand-scoped upstream; the view-model must not re-aggregate or fall back.
  const report = makeReport();
  const brandScoped = { ...report, cells: report.cells.map((c) => ({ ...c, sales: c.sales * 0 + (c.hasAd ? 111 : 222) })) };
  const k = dailyMtdKpis(brandScoped);
  assert.equal(k.totalSales, 111); // exactly the brand-scoped MTD cell value, no All-Brands blend
});

let ran = 0;
for (const t of tests) {
  try { t.fn(); passed += 1; ran += 1; out("  ok  " + t.name); }
  catch (e) { ran += 1; out("FAIL  " + t.name); out(String(e && e.stack ? e.stack : e)); process.exitCode = 1; }
}
out(`\n${passed}/${ran} assertions passed`);
