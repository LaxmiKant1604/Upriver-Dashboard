// Daily Reporting advertising ratios -- the PRESENTATION-BOUNDARY formulas, extracted pure so they are testable
// and locked (they consume the column-SUMMED cell fields, never row-level ratios, so every metric is
// SUM(numerator) / SUM(denominator) for the period).
//
// The daily cell carries, per column (a whole month / MTD / a single day) and per scope (All brands or one
// selected brand, since the rows are already brand-scoped upstream):
//   sales   = SUM(Total Sales)   -- Order Line Items item_price_value
//   adSpend = SUM(Ad Spend)      -- durable ASIN Ads (asin-performance-v1)
//   adSales = SUM(Ad Sales)      -- durable ASIN Ads ad_sales_same_sku
//   hasAd   = any advertising row was present for the period (else advertising is UNAVAILABLE -> em dash)

import { fmtMoney } from "./format.js";

export const EM_DASH = "—";

// OLI coverage rendering rules (flexii UK follow-up). A cell's `status` comes from the coverage classifier
// (applyDailyCoverage): covered | partial | unavailable | unknown | "unknown-legacy" (a payload with no coverage
// evidence -> exact prior rendering). UNAVAILABLE / UNKNOWN OLI coverage renders an em dash for the OLI metrics
// (Total Sales / Units) -- NEVER a fabricated 0. COVERED shows the source-backed total (a genuine covered zero is a
// real 0). PARTIAL shows the source-backed total for its covered dates (the column header carries the Partial marker
// + covered range). A period-total RATIO (ROI / TACoS) is meaningful only over a FULLY covered period, so partial /
// unavailable / unknown coverage renders the ratio as an em dash too (a partial-window total must not mint a ratio).
export const oliCovMissing = (c) => !!(c && (c.status === "unavailable" || c.status === "unknown"));
export const oliRatioBlocked = (c) => !!(c && (c.status === "unavailable" || c.status === "unknown" || c.status === "partial"));

// ADVERTISING period completeness (India 2026-10-07 follow-up). A completed Ads export proves only that the window was
// REQUESTED; the provider sends no row for a day it has not reported yet and gives no separate empty-day proof. So a
// period's ad totals are COMPLETE only when every day in it is KNOWN: the account's rows for that day arrived
// (payload.adsDeliveredDates, account-level) -- or, for an older payload without it, the scope itself has an ad row
// that day. A period with an unknown day keeps the ad sums of its known days, is labelled "Ads partial", and its
// TACoS / ROI are withheld (spend from fewer days over a full period's sales would understate them). ACoS stays: its
// spend and ad sales come from the same reported days.
const DAY_MS = 86400000;
function eachDay(from, to) {
  const out = [];
  const a = Date.parse(String(from) + "T00:00:00.000Z");
  const b = Date.parse(String(to) + "T00:00:00.000Z");
  if (!Number.isFinite(a) || !Number.isFinite(b) || a > b) return out;
  for (let t = a; t <= b; t += DAY_MS) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}
/**
 * PURE: { adKnownDays, adTotalDays, adPartial } for one report column [from,to]. knownAdDates = a Set of YYYY-MM-DD days
 * whose advertising is known (delivered). hasAd = the column has at least one ad value. adPartial only when the column
 * HAS ad values but at least one of its days is not known (a column with no ad value already renders as unavailable).
 */
export function adPeriodCompleteness({ from, to, knownAdDates, hasAd }) {
  const days = eachDay(from, to);
  const known = knownAdDates instanceof Set ? knownAdDates : new Set();
  const adKnownDays = days.filter((d) => known.has(d)).length;
  return { adKnownDays, adTotalDays: days.length, adPartial: !!hasAd && days.length > 0 && adKnownDays < days.length };
}
export const adRatioBlocked = (c) => !!(c && c.adPartial);

/**
 * PURE: the advertising banner state the page shows, judged on the SAME evidence as the "Ads partial" markers. With the
 * account-level delivered days, the recorded extent is recounted over the covered window (a brand's no-activity day on
 * which the account's rows arrived is not "missing"); the banner is dropped when every covered day was delivered.
 * Without the list (older payload / brand-limited user) the server's own availability is returned unchanged.
 */
export function adsAvailabilityForView(availability, deliveredDates) {
  const av = availability && typeof availability === "object" ? availability : null;
  if (!av || !Array.isArray(deliveredDates)) return av;
  const isDay = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
  if (!isDay(av.coveredFrom) || !isDay(av.coveredTo)) return av;
  const covered = eachDay(av.coveredFrom, av.coveredTo);
  const got = new Set(deliveredDates);
  const delivered = covered.filter((d) => got.has(d));
  const missing = delivered.length < covered.length;
  return {
    ...av,
    recordedFrom: delivered.length ? delivered[0] : null,
    recordedThrough: delivered.length ? delivered[delivered.length - 1] : null,
    recordedDayCount: delivered.length,
    coveredDayCount: covered.length,
    provisionalFrom: missing ? av.coveredFrom : null,
    provisionalTo: missing ? av.coveredTo : null,
    provisionalState: missing ? "unknown-unverified" : null,
  };
}

// The Daily Reporting metric rows, in display order. Ad-derived rows fall back to em dash until advertising data is
// present on the fetched rows; the OLI rows (sales/units) + the sales-derived ratios (roi/tacos) honour the coverage
// status above. Exported (not inlined in App.jsx) so the rendered behavioural tests can drive the real render.
export const DAILY_METRICS = [
  { key: "sales", label: "Total Sales", fmt: (c, cur) => (oliCovMissing(c) ? EM_DASH : fmtMoney(c.sales, cur)) },
  { key: "adSales", label: "Ad Sales", fmt: (c, cur) => (c.hasAd ? fmtMoney(c.adSales, cur) : EM_DASH) },
  { key: "adSpend", label: "Ad Spend", fmt: (c, cur) => (c.hasAd ? fmtMoney(c.adSpend, cur) : EM_DASH) },
  { key: "clicks", label: "Clicks", fmt: (c) => (c.hasAd ? c.clicks.toLocaleString("en-US") : EM_DASH) },
  { key: "units", label: "Units", fmt: (c) => (oliCovMissing(c) ? EM_DASH : c.units.toLocaleString("en-US")) },
  { key: "roi", label: "ROI", highlight: true, fmt: (c) => (oliRatioBlocked(c) || adRatioBlocked(c) ? EM_DASH : formatDailyRoi(c.sales, c.adSpend, c.hasAd)) },
  { key: "acos", label: "ACoS %", fmt: (c) => formatDailyAcos(c.adSpend, c.adSales, c.hasAd) },
  { key: "tacos", label: "TACoS %", fmt: (c) => (oliRatioBlocked(c) || adRatioBlocked(c) ? EM_DASH : formatDailyTacos(c.adSpend, c.sales, c.hasAd)) },
];

const finite2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : EM_DASH);
const finite1pct = (v) => (Number.isFinite(v) ? v.toFixed(1) + "%" : EM_DASH);

/**
 * ROI = Total Sales / Ad Spend -- the BUSINESS return on ad spend (NOT Ad Sales / Ad Spend). Uses the summed
 * totals so it is SUM(Total Sales) / SUM(Ad Spend), never an average of per-row ROI. Ad Spend must be > 0;
 * zero / missing / unavailable Ad Spend yields an em dash (never Infinity, NaN, or a fabricated zero). Two dp.
 * Proof: Indya Store IN, Aug MTD -> 4318606 / 533852 = 8.09.
 */
export function formatDailyRoi(salesSum, adSpendSum, hasAd) {
  if (!hasAd || !(Number(adSpendSum) > 0)) return EM_DASH;
  return finite2(Number(salesSum) / Number(adSpendSum));
}

// ACoS % = Ad Spend / Ad Sales (UNCHANGED business meaning). Ad Sales must be > 0.
export function formatDailyAcos(adSpendSum, adSalesSum, hasAd) {
  if (!hasAd || !(Number(adSalesSum) > 0)) return EM_DASH;
  return finite1pct((Number(adSpendSum) / Number(adSalesSum)) * 100);
}

// TACoS % = Ad Spend / Total Sales (UNCHANGED business meaning). Total Sales must be > 0.
export function formatDailyTacos(adSpendSum, salesSum, hasAd) {
  if (!hasAd || !(Number(salesSum) > 0)) return EM_DASH;
  return finite1pct((Number(adSpendSum) / Number(salesSum)) * 100);
}
