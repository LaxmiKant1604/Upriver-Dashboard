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

export const EM_DASH = "—";

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
