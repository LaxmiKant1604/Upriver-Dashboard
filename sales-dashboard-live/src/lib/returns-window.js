// Returns & Refund Leakage -- the ONE canonical, PURE (zero-I/O, zero-dependency) window/period recompute math for
// the returns-leakage-v3 snapshot. Given the durable per-row daily history (`row.daily[]`) and the shared `dayAxis`,
// a user-chosen window (7 / 14 / 30 / 60) is recomputed CLIENT-SIDE with EXACTLY the same arithmetic the server used
// for the full window -- never a DataDoe fetch, never a divergent formula. It also slices the index-aligned account
// `series` for the trend charts and breakdowns, and splits confirmed vs provisional returns at the grace cutoff.
//
// THE FOUR CORRECTNESS INVARIANTS (mirrored from the report contract; every consumer relies on these):
//   1. returnFees(window) = max(0, sum(com) + sum(ufe) - sum(rst)) over the window slice. The clamp happens ONCE on
//      the summed components, NEVER per day (a single restock-heavy day must not be floored on its own).
//   2. totalLeakage(window) = refundedAmount(window) + returnFees(window). COGS on refunded units is carried but is
//      NEVER part of leakage (the source cannot say whether returned stock came back sellable).
//   3. returnRate(window) = sum(rc) / sum(ord) * 100, WITHHELD (null) when the row's rate is withheld, when there are
//      no ordered units in the window, or when sum(rc) > sum(ord) (a lag artefact -- returns of orders placed before
//      the window). Rates are recomputed from summed numerators/denominators; a percentage is NEVER averaged.
//   4. A null (unavailable) input stays null -- ordered units / sales for a row with no order evidence render as an
//      em dash, never a fabricated 0.
//
// 7-bit ASCII, no imports.

export const RETURNS_WINDOW_OPTIONS = [7, 14, 30, 60];
export const DEFAULT_RETURNS_WINDOW = 60;

const isDate = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const num = (v) => (Number(v) || 0);

// The per-day cell keys (only NONZERO keys are present on a cell). Grouped by how they aggregate.
const MONEY_KEYS = ["rfd", "rtx", "rrf", "com", "ufe", "rst", "cog", "rus", "rev", "ssl", "sun", "sal"];
const COUNT_KEYS = ["rc", "fba", "fbm", "pend"];
const ORDER_KEY = "ord";

/**
 * Clamp a requested window to the supported options AND to the axis length. A blank/non-finite request falls back to
 * the default; a request longer than the proven axis is capped at the largest option the axis can serve.
 */
export function clampReturnsWindow(n, axisLength, options = RETURNS_WINDOW_OPTIONS) {
  const opts = (Array.isArray(options) && options.length ? options : RETURNS_WINDOW_OPTIONS).slice().sort((a, b) => a - b);
  const len = Number.isFinite(axisLength) && axisLength > 0 ? Math.floor(axisLength) : opts[opts.length - 1];
  const usable = opts.filter((o) => o <= len);
  const available = usable.length ? usable : [Math.min(opts[0], len)];
  const want = Math.floor(Number(n));
  if (!Number.isFinite(want)) {
    return available.includes(DEFAULT_RETURNS_WINDOW) ? DEFAULT_RETURNS_WINDOW : available[available.length - 1];
  }
  // Snap an out-of-set request to the nearest available option (never larger than the axis can serve).
  if (available.includes(want)) return want;
  let best = available[0];
  for (const o of available) if (Math.abs(o - want) < Math.abs(best - want)) best = o;
  return best;
}

/** The window options that the proven axis can actually serve (always at least the smallest option). */
export function availableWindowOptions(axisLength, options = RETURNS_WINDOW_OPTIONS) {
  const opts = (Array.isArray(options) && options.length ? options : RETURNS_WINDOW_OPTIONS).slice().sort((a, b) => a - b);
  const len = Number.isFinite(axisLength) && axisLength > 0 ? Math.floor(axisLength) : opts[opts.length - 1];
  const usable = opts.filter((o) => o <= len);
  return usable.length ? usable : [Math.min(opts[0], len)];
}

/**
 * The last-N dates and the immediately-preceding N dates from an ASCENDING dayAxis (dayAxis[last] === latest day).
 * When the axis is shorter than 2N the previous slice simply carries fewer dates (never fabricated). Also returns the
 * matching index ranges so an index-aligned `series` array can be sliced identically.
 */
export function windowSlices(dayAxis, n) {
  const dates = Array.isArray(dayAxis) ? dayAxis.filter(isDate) : [];
  const L = dates.length;
  const N = Math.max(1, Math.min(Math.floor(Number(n) || 0) || L, L || 1));
  const wStart = Math.max(0, L - N);
  const pStart = Math.max(0, L - 2 * N);
  const windowDates = dates.slice(wStart);
  const prevDates = dates.slice(pStart, wStart);
  const range = (from, to) => { const r = []; for (let i = from; i < to; i += 1) r.push(i); return r; };
  return {
    N,
    windowDates,
    prevDates,
    windowSet: new Set(windowDates),
    prevSet: new Set(prevDates),
    windowIdx: range(wStart, L),
    prevIdx: range(pStart, wStart),
  };
}

/** Sum an index-aligned series array over a list of indices. Missing/NaN cells contribute 0. */
export function sumSeriesAt(arr, indices) {
  if (!Array.isArray(arr) || !Array.isArray(indices)) return 0;
  let t = 0;
  for (const i of indices) t += num(arr[i]);
  return t;
}

/**
 * Recompute one row's window figures over an explicit set of dates (a Set of ISO strings). Pure. `cutoff` is the
 * provisional grace cutoff (ISO): return counts on/after it are provisional (awaiting settlement) and are reported
 * separately -- they never become leakage money (they have no settlement rows, so the money keys are already 0).
 *
 * Returns ONLY the fields that a window overrides; the caller merges them onto the base row so the full-history reason
 * mix (dominantBucket / topReasons / actionableShare) is preserved.
 */
export function computeRowOverDates(row, dateSet, cutoff) {
  const daily = Array.isArray(row && row.daily) ? row.daily : [];
  const set = dateSet instanceof Set ? dateSet : new Set(Array.isArray(dateSet) ? dateSet : []);
  const money = {};
  for (const k of MONEY_KEYS) money[k] = 0;
  const counts = {};
  for (const k of COUNT_KEYS) counts[k] = 0;
  let ord = 0;
  let provisionalReturnCount = 0;
  let confirmedReturnCount = 0;
  let sawOrderCell = false;

  for (const cell of daily) {
    if (!cell || !set.has(cell.date)) continue;
    for (const k of MONEY_KEYS) if (cell[k] != null) money[k] += num(cell[k]);
    for (const k of COUNT_KEYS) if (cell[k] != null) counts[k] += num(cell[k]);
    if (cell[ORDER_KEY] != null) { ord += num(cell[ORDER_KEY]); sawOrderCell = true; }
    const rc = num(cell.rc);
    if (rc) {
      if (isDate(cutoff) && cell.date >= cutoff) provisionalReturnCount += rc;
      else confirmedReturnCount += rc;
    }
  }

  // Invariant 1: clamp the fee ONCE on the summed components.
  const returnFees = Math.max(0, money.com + money.ufe - money.rst);
  const refundedAmount = money.rfd;
  const totalLeakage = refundedAmount + returnFees; // invariant 2

  // Invariant 4: ordered units stay null (unavailable) for a row with no order evidence.
  const hasOrdered = row && row.hasOrdered === false ? false : sawOrderCell || (row && row.hasOrdered === true);
  const orderedUnits = hasOrdered ? ord : null;

  // Invariant 3: rate from summed counts, withheld on the three documented conditions.
  const rateWithheld = Boolean(row && row.rateWithheld);
  const returnCount = counts.rc;
  const lagInflated = orderedUnits !== null && orderedUnits > 0 && returnCount > orderedUnits;
  let returnRate = null;
  if (!rateWithheld && orderedUnits !== null && orderedUnits > 0 && !lagInflated) {
    returnRate = (returnCount / orderedUnits) * 100;
  }
  // The rate numerator the portfolio recompute reads: withheld -> null, otherwise the window return count.
  const returnedUnits = rateWithheld ? null : returnCount;

  return {
    // counts
    returnCount,
    fbaReturns: counts.fba,
    fbmReturns: counts.fbm,
    pendingReturnRequests: counts.pend,
    provisionalReturnCount,
    confirmedReturnCount,
    // money (per the row's own currency)
    refundedAmount,
    refundTax: money.rtx,
    refundedReferralFeeCredit: money.rrf,
    returnFees,
    commissionAbs: money.com,
    fbaUnitFeeAbs: money.ufe,
    restockAbs: money.rst,
    cogsOnRefundedUnits: money.cog,
    refundedUnitsSettled: money.rus,
    refundEvents: money.rev,
    settledSales: money.ssl,
    settledUnits: money.sun,
    orderedSales: hasOrdered ? money.sal : null,
    totalLeakage,
    // net of the referral fee Amazon credits back on a refund (never below the fees/refunds it cannot recover).
    netImpact: totalLeakage - money.rrf,
    // rate
    orderedUnits,
    returnedUnits,
    returnRate,
    lagInflated,
    rateWithheld,
    hasOrdered: Boolean(hasOrdered),
    windowDayCount: set.size,
  };
}

/** Merge a window recompute onto a base row, PRESERVING the full-history reason mix. */
export function applyRowWindow(row, dateSet, cutoff) {
  return { ...row, ...computeRowOverDates(row, dateSet, cutoff) };
}

/**
 * Aggregate a set of already-windowed rows into the KPI figures. Money is summed within the caller's currency scope
 * (the caller decides whether to render an em dash for a mixed-currency account); counts are currency-agnostic.
 */
export function aggregateReturns(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const agg = {
    returned: 0, fba: 0, fbm: 0, pending: 0,
    provisional: 0, confirmed: 0,
    refunds: 0, refundTax: 0, referralCredit: 0, fees: 0, cogs: 0,
    refundedUnits: 0, refundEvents: 0, settledSales: 0, settledUnits: 0,
    leakage: 0, netImpact: 0,
    products: list.length,
  };
  for (const r of list) {
    agg.returned += num(r.returnCount);
    agg.fba += num(r.fbaReturns);
    agg.fbm += num(r.fbmReturns);
    agg.pending += num(r.pendingReturnRequests);
    agg.provisional += num(r.provisionalReturnCount);
    agg.confirmed += num(r.confirmedReturnCount);
    agg.refunds += num(r.refundedAmount);
    agg.refundTax += num(r.refundTax);
    agg.referralCredit += num(r.refundedReferralFeeCredit);
    agg.fees += num(r.returnFees);
    agg.cogs += num(r.cogsOnRefundedUnits);
    agg.refundedUnits += num(r.refundedUnitsSettled);
    agg.refundEvents += num(r.refundEvents);
    agg.settledSales += num(r.settledSales);
    agg.settledUnits += num(r.settledUnits);
    agg.leakage += num(r.totalLeakage);
    agg.netImpact += num(r.netImpact);
  }
  return agg;
}

/**
 * A signed change between a recent and a prior aggregate for one KPI key. Returns { delta, pct } with pct null when
 * the prior base is 0 (a change from nothing is "new", not an infinite percent).
 */
export function kpiDelta(recentValue, priorValue) {
  const r = num(recentValue);
  const p = num(priorValue);
  const delta = r - p;
  return { delta, pct: p > 0 ? (delta / p) * 100 : null };
}

/**
 * Build the per-day trend points for the selected window, scoped to one currency for the money/rate lines so a
 * multi-currency account never adds currencies. Returns are attributed to their holder-currency row, so counts here
 * are the selected currency's returns (equal to all returns for a single-currency account). Rates are per-day
 * numerator/denominator (never averaged across days).
 */
export function buildReturnsTrend(rows, windowDates, currency, cutoff) {
  const dates = Array.isArray(windowDates) ? windowDates : [];
  const scoped = (Array.isArray(rows) ? rows : []).filter((r) => !currency || r.currency === currency);
  return dates.map((date) => {
    let rc = 0, fba = 0, fbm = 0, pend = 0, rfd = 0, com = 0, ufe = 0, rst = 0, rrf = 0, ord = 0, prov = 0;
    for (const r of scoped) {
      const cell = (r.daily || []).find((c) => c && c.date === date);
      if (!cell) continue;
      rc += num(cell.rc); fba += num(cell.fba); fbm += num(cell.fbm); pend += num(cell.pend);
      rfd += num(cell.rfd); com += num(cell.com); ufe += num(cell.ufe); rst += num(cell.rst); rrf += num(cell.rrf);
      ord += num(cell.ord);
      if (num(cell.rc) && isDate(cutoff) && date >= cutoff) prov += num(cell.rc);
    }
    // Per-day fee is informational (unclamped); the window leakage TOTAL applies the single clamp in aggregate.
    const feeDay = com + ufe - rst;
    const leakageDay = rfd + Math.max(0, feeDay);
    return {
      date,
      label: date.slice(5),
      returnCount: rc,
      fba,
      fbm,
      pending: pend,
      provisional: prov,
      refund: rfd,
      fees: feeDay,
      leakage: leakageDay,
      netImpact: leakageDay - rrf,
      orderedUnits: ord,
      returnRate: ord > 0 ? (rc / ord) * 100 : null,
    };
  });
}

/**
 * Sum an account-level `series.<group>` (an object of index-aligned arrays) over the window index range into a flat
 * { key: total } object. Used for the reason-bucket / channel / status / label-payer breakdowns, which respect the
 * selected window because the indices are sliced from the same axis.
 */
export function sumSeriesGroup(group, windowIdx) {
  const out = {};
  if (!group || typeof group !== "object") return out;
  for (const [key, arr] of Object.entries(group)) out[key] = sumSeriesAt(arr, windowIdx);
  return out;
}

/**
 * Choose the currency to drive the money charts: the one with the largest refunded amount over the whole axis, else
 * the first reported currency. Deterministic, so the default is stable across renders.
 */
export function pickPrimaryCurrency(data) {
  const currencies = Array.isArray(data && data.currencies) ? data.currencies.filter(Boolean) : [];
  if (currencies.length <= 1) return currencies[0] || null;
  const money = data && data.series && data.series.money;
  if (money && typeof money === "object") {
    let best = null; let bestSum = -1;
    for (const cur of currencies) {
      const arr = money[cur] && money[cur].refundedAmount;
      const sum = Array.isArray(arr) ? arr.reduce((t, v) => t + num(v), 0) : 0;
      if (sum > bestSum) { bestSum = sum; best = cur; }
    }
    if (best) return best;
  }
  return currencies[0];
}

/** True when the payload carries the advanced returns-leakage-v3 trend surface (dayAxis + series). */
export function hasReturnsSeries(data) {
  return Boolean(
    data &&
    data.version === "returns-leakage-v3" &&
    Array.isArray(data.dayAxis) &&
    data.dayAxis.length > 0 &&
    data.series &&
    typeof data.series === "object"
  );
}
