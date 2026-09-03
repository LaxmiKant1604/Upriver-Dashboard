// PURE, offline-testable Campaign Ads client view logic -- the ONE source of the browser-side date-windowing, KPI
// formulas, conservation summary and wasted-spend classification shared by the Performance and Wasted Spend tabs.
// It consumes ONLY the /api/campaign-brand-mapping?action=view payload (durable campaign rows already account- +
// brand-authorized SERVER-side; the browser never widens scope). It re-windows the per-campaign `daily` breakdown to
// any [from,to] with ZERO refetch + ZERO DataDoe tokens. Formulas emit null (an em dash) for a zero denominator --
// never Infinity or NaN. Currency + marketplace isolation is preserved (a campaign identity is one currency). Source
// date strings are compared verbatim (no UTC shifting). No campaign is ever fabricated: a campaign with no rows in the
// window is dropped, never shown as a zero row.

// The compact per-campaign daily row layout buildCampaignAdsView emits: [date, spend, sales, orders, units, impressions, clicks].
const D = { date: 0, spend: 1, sales: 2, orders: 3, units: 4, impressions: 5, clicks: 6 };
const METRIC_KEYS = ["spend", "sales", "orders", "units", "impressions", "clicks"];

// Reused verbatim from lib/server/reports/ppc.js MIN_CLICKS_FOR_WASTE (verified): below this, a zero-order campaign is
// not yet evidence of waste. The ACoS/ROAS review lines are deterministic defaults (this source carries no per-campaign
// target to prove otherwise), so they only ever raise a "Needs review" flag, never "definite wasted".
export const CAMPAIGN_WASTE_THRESHOLDS = Object.freeze({ minClicksForReview: 10, highAcos: 0.5, lowRoas: 2 });

// The named date windows. 7D is the default. Each is inclusive and anchored on the account's LATEST PROVEN date.
export const CAMPAIGN_DATE_PRESETS = Object.freeze([
  { key: "7D", days: 7, label: "7D" }, { key: "14D", days: 14, label: "14D" }, { key: "30D", days: 30, label: "30D" },
]);

function shiftDate(dateStr, deltaDays) {
  const d = new Date(`${String(dateStr)}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

// Resolve a preset (or custom) to an inclusive [from,to] anchored on `latestProvenDate` and CLAMPED to [minDate,
// latestProvenDate] (never beyond durable coverage). Returns { from, to, clamped } (clamped=true when a custom range
// was pulled inside the available history).
export function resolveWindow({ preset = "7D", customFrom = null, customTo = null, latestProvenDate = null, minDate = null } = {}) {
  if (!latestProvenDate) return { from: null, to: null, clamped: false };
  if (preset === "CUSTOM" && customFrom && customTo) {
    let from = customFrom, to = customTo; let clamped = false;
    if (to > latestProvenDate) { to = latestProvenDate; clamped = true; }
    if (minDate && from < minDate) { from = minDate; clamped = true; }
    if (from > to) from = to;
    return { from, to, clamped };
  }
  const days = (CAMPAIGN_DATE_PRESETS.find((p) => p.key === preset) || CAMPAIGN_DATE_PRESETS[0]).days;
  let from = shiftDate(latestProvenDate, -(days - 1));
  let clamped = false;
  if (minDate && from < minDate) { from = minDate; clamped = true; }
  return { from, to: latestProvenDate, clamped };
}

// KPIs from summed metrics. An undefined ratio is null (em dash), NEVER Infinity/NaN. Mirrors campaign-ads.js#campaignKpis.
export function campaignKpisFromMetrics(m) {
  const { spend, sales, orders, impressions, clicks } = m;
  return {
    ...m,
    ctr: impressions > 0 ? clicks / impressions : null,
    cpc: clicks > 0 ? spend / clicks : null,
    cvr: clicks > 0 ? orders / clicks : null,
    roas: spend > 0 ? sales / spend : null,
    acos: sales > 0 ? spend / sales : null,
  };
}

function sumWindow(daily, from, to) {
  const m = { spend: 0, sales: 0, orders: 0, units: 0, impressions: 0, clicks: 0 };
  let count = 0;
  for (const row of Array.isArray(daily) ? daily : []) {
    const date = row[D.date];
    if (from && date < from) continue;
    if (to && date > to) continue;
    m.spend += Number(row[D.spend]) || 0; m.sales += Number(row[D.sales]) || 0; m.orders += Number(row[D.orders]) || 0;
    m.units += Number(row[D.units]) || 0; m.impressions += Number(row[D.impressions]) || 0; m.clicks += Number(row[D.clicks]) || 0;
    count += 1;
  }
  return { m, count };
}

// Re-window every campaign to the inclusive [from,to]; keep identity + mapping metadata. A campaign with NO rows in the
// window is dropped (never a fabricated zero). Returns the windowed campaign list with KPIs, sorted by spend desc.
export function windowCampaigns(campaigns, from, to) {
  const out = [];
  for (const c of Array.isArray(campaigns) ? campaigns : []) {
    const { m, count } = sumWindow(c.daily, from, to);
    if (count === 0) continue;
    const { daily, ...rest } = c;
    out.push({ ...rest, ...campaignKpisFromMetrics(m), _activeDays: count });
  }
  out.sort((a, b) => (b.spend || 0) - (a.spend || 0) || String(a.campaignId).localeCompare(String(b.campaignId)));
  return out;
}

function sumMetrics(rows) { const m = { spend: 0, sales: 0, orders: 0, units: 0, impressions: 0, clicks: 0 }; for (const r of rows) for (const k of METRIC_KEYS) m[k] += Number(r[k]) || 0; return m; }

// Per-currency conservation summary over the windowed campaigns: account total (ALL), Unmapped, and per-brand.
// Currencies are NEVER combined; account == sum(brands) + Unmapped (conservationOk asserts it).
export function summarizeWindow(windowed) {
  const byCurrency = {};
  for (const c of Array.isArray(windowed) ? windowed : []) {
    const cur = c.currency || "";
    const g = byCurrency[cur] || (byCurrency[cur] = { currency: cur, all: [], mapped: {}, unmapped: [] });
    g.all.push(c);
    if (c.mapped && c.brandKey) (g.mapped[c.brandKey] = g.mapped[c.brandKey] || { brandKey: c.brandKey, brandDisplay: c.brandDisplay, rows: [] }).rows.push(c);
    else g.unmapped.push(c);
  }
  const out = {};
  for (const cur of Object.keys(byCurrency)) {
    const g = byCurrency[cur];
    const acct = sumMetrics(g.all);
    const unmap = sumMetrics(g.unmapped);
    const brands = Object.values(g.mapped).map((b) => ({ brandKey: b.brandKey, brandDisplay: b.brandDisplay, campaignCount: b.rows.length, ...campaignKpisFromMetrics(sumMetrics(b.rows)) }));
    const mappedTotal = sumMetrics(Object.values(g.mapped).flatMap((b) => b.rows));
    const conservationOk = METRIC_KEYS.every((k) => Math.abs(acct[k] - (mappedTotal[k] + unmap[k])) < 1e-6);
    out[cur] = { currency: cur, account: { campaignCount: g.all.length, ...campaignKpisFromMetrics(acct) }, unmapped: { campaignCount: g.unmapped.length, ...campaignKpisFromMetrics(unmap) }, brands, conservationOk };
  }
  return { byCurrency: out };
}

const pct = (v) => (v == null ? "—" : `${(v * 100).toFixed(1)}%`);
const money = (v) => (Math.round((Number(v) || 0) * 100) / 100);

// Deterministic waste/review classification over the windowed campaigns. ONLY "spend with 0 sales" is DEFINITE wasted
// spend; clicks-without-orders / high-ACoS / low-ROAS are "Needs review". Every finding explains which threshold fired.
export function classifyWaste(windowed, thresholds = CAMPAIGN_WASTE_THRESHOLDS) {
  const th = { ...CAMPAIGN_WASTE_THRESHOLDS, ...(thresholds || {}) };
  const findings = [];
  for (const c of Array.isArray(windowed) ? windowed : []) {
    const reasons = [];
    let severity = null;
    if ((c.spend || 0) > 0 && (c.sales || 0) === 0) { severity = "wasted"; reasons.push({ type: "zero-sales", label: "Spend, 0 sales", detail: `spent ${money(c.spend)} with 0 ad sales` }); }
    if ((c.clicks || 0) >= th.minClicksForReview && (c.orders || 0) === 0) reasons.push({ type: "clicks-no-orders", label: "Clicks, 0 orders", detail: `${c.clicks} clicks (>= ${th.minClicksForReview}), 0 orders` });
    if ((c.sales || 0) > 0 && c.acos != null && c.acos > th.highAcos) reasons.push({ type: "high-acos", label: "High ACoS", detail: `ACoS ${pct(c.acos)} > ${pct(th.highAcos)} review line` });
    if ((c.sales || 0) > 0 && c.roas != null && c.roas < th.lowRoas) reasons.push({ type: "low-roas", label: "Low ROAS", detail: `ROAS ${c.roas.toFixed(2)} < ${th.lowRoas.toFixed(2)} review line` });
    if (!reasons.length) continue;
    if (!severity) severity = "review";
    findings.push({ campaignId: c.campaignId, campaignName: c.campaignName, campaignType: c.campaignType, campaignStatus: c.campaignStatus, marketplace: c.marketplace, adsProfileId: c.adsProfileId, currency: c.currency, mapped: c.mapped, brandKey: c.brandKey, brandDisplay: c.brandDisplay, spend: c.spend, sales: c.sales, orders: c.orders, clicks: c.clicks, acos: c.acos, roas: c.roas, severity, reasons });
  }
  findings.sort((a, b) => (a.severity === b.severity ? (b.spend || 0) - (a.spend || 0) : a.severity === "wasted" ? -1 : 1));
  // Per-(currency, brand) wasted + review spend rollups (Unmapped kept as its own bucket).
  const byCurrency = {};
  for (const f of findings) {
    const cur = f.currency || "";
    const g = byCurrency[cur] || (byCurrency[cur] = { currency: cur, wastedSpend: 0, reviewSpend: 0, brands: {} });
    const bucket = f.severity === "wasted" ? "wastedSpend" : "reviewSpend";
    g[bucket] += Number(f.spend) || 0;
    const bk = f.mapped && f.brandKey ? f.brandKey : "__unmapped";
    const bd = f.mapped && f.brandDisplay ? f.brandDisplay : "Unmapped";
    const b = g.brands[bk] || (g.brands[bk] = { brandKey: bk, brandDisplay: bd, wastedSpend: 0, reviewSpend: 0, count: 0 });
    b[bucket] += Number(f.spend) || 0; b.count += 1;
  }
  const counts = {
    total: findings.length,
    wasted: findings.filter((f) => f.severity === "wasted").length,
    review: findings.filter((f) => f.severity === "review").length,
    zeroSales: findings.filter((f) => f.reasons.some((r) => r.type === "zero-sales")).length,
    clicksNoOrders: findings.filter((f) => f.reasons.some((r) => r.type === "clicks-no-orders")).length,
    highAcos: findings.filter((f) => f.reasons.some((r) => r.type === "high-acos")).length,
    lowRoas: findings.filter((f) => f.reasons.some((r) => r.type === "low-roas")).length,
  };
  return { findings, byCurrency, counts, thresholds: th };
}
