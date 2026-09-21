// Daily Reporting -- PURE view-model derivations for the redesigned page. These read ONLY the already-computed daily
// report ({ latest, columns, cells }) that App.jsx builds from the saved payload, so the redesign adds NO new data
// path and cannot change any metric or aggregation. Money is returned RAW (the view formats it, currency-aware);
// ratios use the LOCKED business formulas from daily-metrics.js (em dash when a denominator/coverage is unavailable
// -- never Infinity, NaN, or a fabricated zero). Advertising that a period does not cover is `null` (an honest gap),
// never 0. 7-bit ASCII.

import { formatDailyRoi, formatDailyAcos, formatDailyTacos, oliCovMissing, oliRatioBlocked, EM_DASH } from "./daily-metrics.js";

// Index of the MTD column in a daily report; -1 when there is none. The column set is dynamic (built from the
// account's latest proven date), so the MTD position is found by group, never hard-coded.
export function mtdColumnIndex(report) {
  const cols = (report && report.columns) || [];
  return cols.findIndex((c) => c && c.group === "mtd");
}

// The SIX MTD KPI values, sourced ENTIRELY from the report's MTD column cell. Returns null when there is no MTD
// column (nothing to summarise). totalSales HONOURS OLI coverage exactly as the table cell does: null (-> em dash) when
// the MTD column's coverage is UNAVAILABLE / UNKNOWN (never a fabricated or silently-understated total), and a
// `salesPartial` flag marks a PARTIAL MTD so the card labels its covered-only total (matching the table's Partial
// badge). adSales/adSpend are null when advertising is unavailable; roi/tacos (sales-derived) em dash unless the MTD is
// fully covered; acos (ad-only) is unchanged. label is the dynamic MTD column label (e.g. "Aug '26 MTD").
export function dailyMtdKpis(report) {
  const idx = mtdColumnIndex(report);
  if (idx < 0) return null;
  const cell = ((report && report.cells) || [])[idx];
  if (!cell) return null;
  const covMissing = oliCovMissing(cell);      // unavailable / unknown -> the OLI total is NOT shown (em dash)
  const ratioBlocked = oliRatioBlocked(cell);  // partial / unavailable / unknown -> a period ratio is not meaningful
  return {
    label: report.columns[idx].label,
    totalSales: covMissing ? null : (Number(cell.sales) || 0),
    salesPartial: cell.status === "partial",
    adSales: cell.hasAd ? Number(cell.adSales) || 0 : null,
    adSpend: cell.hasAd ? Number(cell.adSpend) || 0 : null,
    roi: ratioBlocked ? EM_DASH : formatDailyRoi(cell.sales, cell.adSpend, cell.hasAd),
    acos: formatDailyAcos(cell.adSpend, cell.adSales, cell.hasAd),
    tacos: ratioBlocked ? EM_DASH : formatDailyTacos(cell.adSpend, cell.sales, cell.hasAd),
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
    // A day whose OLI coverage is UNAVAILABLE / UNKNOWN is an honest GAP (null) the sparkline drops -- never a plotted
    // 0 that lastFinite could headline as a real zero. A covered (incl. genuine-zero) or partial day plots its total.
    sales: days.map((d) => (oliCovMissing(d.cell) ? null : (Number(d.cell.sales) || 0))),
    adSales: days.map((d) => (d.cell.hasAd ? Number(d.cell.adSales) || 0 : null)),
    roi: days.map((d) => (!oliRatioBlocked(d.cell) && d.cell.hasAd && Number(d.cell.adSpend) > 0 ? Number(d.cell.sales) / Number(d.cell.adSpend) : null)),
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
