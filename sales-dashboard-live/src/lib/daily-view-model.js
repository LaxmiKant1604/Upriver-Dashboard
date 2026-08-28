// Daily Reporting -- PURE view-model derivations for the redesigned page. These read ONLY the already-computed daily
// report ({ latest, columns, cells }) that App.jsx builds from the saved payload, so the redesign adds NO new data
// path and cannot change any metric or aggregation. Money is returned RAW (the view formats it, currency-aware);
// ratios use the LOCKED business formulas from daily-metrics.js (em dash when a denominator/coverage is unavailable
// -- never Infinity, NaN, or a fabricated zero). Advertising that a period does not cover is `null` (an honest gap),
// never 0. 7-bit ASCII.

import { formatDailyRoi, formatDailyAcos, formatDailyTacos } from "./daily-metrics.js";

// Index of the MTD column in a daily report; -1 when there is none. The column set is dynamic (built from the
// account's latest proven date), so the MTD position is found by group, never hard-coded.
export function mtdColumnIndex(report) {
  const cols = (report && report.columns) || [];
  return cols.findIndex((c) => c && c.group === "mtd");
}

// The SIX MTD KPI values, sourced ENTIRELY from the report's MTD column cell. Returns null when there is no MTD
// column (nothing to summarise). totalSales is always the summed sales; adSales/adSpend are null when advertising is
// UNAVAILABLE for the period (never a fabricated zero); roi/acos/tacos are the locked business formulas as display
// strings ("--" when unavailable). label is the dynamic MTD column label (e.g. "Aug '26 MTD").
export function dailyMtdKpis(report) {
  const idx = mtdColumnIndex(report);
  if (idx < 0) return null;
  const cell = ((report && report.cells) || [])[idx];
  if (!cell) return null;
  return {
    label: report.columns[idx].label,
    totalSales: Number(cell.sales) || 0,
    adSales: cell.hasAd ? Number(cell.adSales) || 0 : null,
    adSpend: cell.hasAd ? Number(cell.adSpend) || 0 : null,
    roi: formatDailyRoi(cell.sales, cell.adSpend, cell.hasAd),
    acos: formatDailyAcos(cell.adSpend, cell.adSales, cell.hasAd),
    tacos: formatDailyTacos(cell.adSpend, cell.sales, cell.hasAd),
  };
}

// The four 5-day TREND series, sourced from the report's DAY columns in order (the exact latest-five daily entries
// the table shows). A value the coverage does not support is `null` -- an honest gap the sparkline drops, never a
// fabricated 0. roi/acos are the per-day business ratios (Total Sales / Ad Spend and Ad Spend / Ad Sales x 100).
export function dailyTrendSeries(report) {
  const cols = (report && report.columns) || [];
  const cells = (report && report.cells) || [];
  const days = [];
  cols.forEach((c, i) => { if (c && c.group === "day") days.push({ label: c.label, cell: cells[i] || {} }); });
  return {
    labels: days.map((d) => d.label),
    sales: days.map((d) => Number(d.cell.sales) || 0),
    adSales: days.map((d) => (d.cell.hasAd ? Number(d.cell.adSales) || 0 : null)),
    roi: days.map((d) => (d.cell.hasAd && Number(d.cell.adSpend) > 0 ? Number(d.cell.sales) / Number(d.cell.adSpend) : null)),
    acos: days.map((d) => (d.cell.hasAd && Number(d.cell.adSales) > 0 ? (Number(d.cell.adSpend) / Number(d.cell.adSales)) * 100 : null)),
  };
}

// The last finite value of a trend series (the trend card's headline number), or null when the series has no finite
// point. Never invents a value for an all-unavailable series.
export function lastFinite(series) {
  const arr = Array.isArray(series) ? series : [];
  for (let i = arr.length - 1; i >= 0; i--) { if (Number.isFinite(arr[i])) return arr[i]; }
  return null;
}

// The completeness badge model (label + tone) for the two-layer PROVISIONAL/FINAL/source-defect state. Preserves the
// existing precedence: provisional wins, then source-defect, else final. Returns null when there is no completeness.
export function dailyCompletenessLabel(completeness) {
  if (!completeness) return null;
  if (completeness.provisional) return { label: "Provisional D-1", tone: "provisional" };
  if (completeness.sourceDefect) return { label: "Source issue", tone: "defect" };
  return { label: "Final D-1", tone: "final" };
}
