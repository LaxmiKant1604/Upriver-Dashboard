// Returns & Refund Leakage -- ADVANCED durable payload (returns-leakage-v3).
//
// This is the PURE builder for the dedicated, durable Returns pipeline. It reads the day-grain durable Returns +
// Settlement aggregates (source_returns_history / source_settlement_history), the reused durable Order Line Items
// ordered evidence, and the Product Catalog, and produces a SUPERSET of the proven returns-leakage-v2 payload:
//
//   * the SAME base fields (accountId, asOf, window, source labels, returnRecordCount, pendingReturnRequests,
//     fbmOnly, reasonTotals, currencies, rows[], catalogBrands) -- built through the SHARED assembleReturnsLeakageRows
//     authority so the aggregate is byte-identical to buildReturnsLeakage() for the same underlying returns/money; and
//   * ADDITIVE advanced fields the redesigned page needs, all recomputable in the browser with ZERO refetch:
//     a shared dayAxis, account-level returns/money/breakdown daily series, per-row compact daily sub-series, a
//     confirmed-vs-provisional split driven by a documented settlement grace period, and freshness/coverage evidence.
//
// CORRECTNESS: money is the settlement authority and never crosses currencies; the return-fee component is summed
// from its RAW abs parts (commission + FBA per-unit fee - restocking) and clamped at ZERO once over the window (per
// row it ships the raw parts so any sub-window re-clamps honestly); a returned item is one Returns row (COUNT, never
// an invented quantity); recent returns inside the grace period stay PROVISIONAL, not leakage; nulls stay null.
//
// Zero transport imports -- pure. The operator feeds it already-fetched durable rows.

import {
  num,
  classifyReturnReason,
  RETURNS_REASON_BUCKETS,
  salesMoversBrandLabel,
  salesMoversCatalogFold,
  returnsLeakageOrderedFold,
  assembleReturnsLeakageRows,
} from "./derivation-core.js";
import { addDaysStr, isDateStr } from "../datadoe.js";

export const RETURNS_ADVANCED_VERSION = "returns-leakage-v3";
export const RETURNS_WINDOW_DAY_OPTIONS = [7, 14, 30, 60];
// Grace period for "recent unmatched" returns: consistent with the 21-day settlement correction window. A return on
// or after (asOf - GRACE_DAYS + 1) is PROVISIONAL -- Amazon may not have settled its refund yet -- so it is shown as
// pending, never immediately labelled leakage.
export const RETURNS_GRACE_DAYS = 21;

const norm = (v) => String(v ?? "").trim();
const upper = (v) => norm(v).toUpperCase();
const abs = (v) => Math.abs(num(v));
const channelOf = (raw) => { const c = upper(raw); return c === "FBA" || c === "FBM" ? c : "UNKNOWN"; };
const isPending = (status) => /pending/i.test(String(status || ""));
const payerBucket = (raw) => { const p = String(raw || "").toLowerCase(); if (/seller/.test(p)) return "seller"; if (/amazon/.test(p)) return "amazon"; return "other"; };

// Inclusive list of ISO dates from `from` to `to`.
function dateAxis(from, to) {
  const out = [];
  if (!isDateStr(from) || !isDateStr(to) || from > to) return out;
  for (let d = from; d <= to; d = addDaysStr(d, 1)) { out.push(d); if (out.length > 800) break; }
  return out;
}

/**
 * Fold durable Returns aggregates into the SAME structures returnsLeakageReturnsFold produces (returnsByAsin +
 * account totals), weighting by return_count instead of counting rows one at a time. Also collects the account-level
 * daily returns series + dimension breakdown series (currency-less counts) and the per-asin daily return counts for
 * the per-row sub-series. Blank-ASIN rows are skipped from the fold (as in the raw path) but still counted in
 * returnRecordCount + freshness.
 */
function durableReturnsFold(rows, dateIndex) {
  const returnsByAsin = new Map();
  const reasonTotals = new Map();
  let pendingReturnRequests = 0;
  let fbmRefundedAmount = 0;
  let fbmLabelCostBorneBySeller = 0;
  let returnRecordCount = 0;
  let latestReturnDate = null;
  const N = dateIndex.size;
  const zeros = () => new Array(N).fill(0);
  const returnsDaily = { returnCount: zeros(), fba: zeros(), fbm: zeros(), pending: zeros() };
  const channelSeries = { FBA: zeros(), FBM: zeros(), UNKNOWN: zeros() };
  const statusSeries = { pending: zeros(), settled: zeros() };
  const labelPayerSeries = { seller: zeros(), amazon: zeros(), other: zeros() };
  const bucketSeries = {};
  for (const b of RETURNS_REASON_BUCKETS) bucketSeries[b.key] = zeros();
  bucketSeries.other = zeros();
  // Per-asin daily return counts (currency-less), attached later to the return-holder currency row.
  const returnDailyByAsin = new Map();

  for (const row of Array.isArray(rows) ? rows : []) {
    const count = Math.max(0, Math.trunc(num(row.return_count)));
    if (count <= 0) continue;
    const date = norm(row.return_date);
    returnRecordCount += count;
    if (isDateStr(date) && (!latestReturnDate || date > latestReturnDate)) latestReturnDate = date;
    const di = dateIndex.has(date) ? dateIndex.get(date) : -1;
    const channel = channelOf(row.fulfillment_channel);
    const status = norm(row.request_status);
    const pending = isPending(status);
    const reason = norm(row.amazon_return_reason) || "NO_REASON_GIVEN";
    const bucket = classifyReturnReason(reason);
    const payer = payerBucket(row.label_payer);

    // account-level daily + breakdown series (currency-less)
    if (di >= 0) {
      returnsDaily.returnCount[di] += count;
      if (channel === "FBA") returnsDaily.fba[di] += count; else if (channel === "FBM") returnsDaily.fbm[di] += count;
      if (pending) returnsDaily.pending[di] += count;
      channelSeries[channel][di] += count;
      (pending ? statusSeries.pending : statusSeries.settled)[di] += count;
      labelPayerSeries[payer][di] += count;
      (bucketSeries[bucket] || bucketSeries.other)[di] += count;
    }

    const asin = norm(row.child_asin);
    if (!asin) continue; // blank-ASIN: counted above, skipped from the per-asin fold (raw-path parity)

    const entry = returnsByAsin.get(asin) || { returnCount: 0, fba: 0, fbm: 0, pending: 0, byBucket: {}, byReason: {}, skus: new Set() };
    entry.returnCount += count;
    if (channel === "FBA") entry.fba += count; else if (channel === "FBM") entry.fbm += count;
    if (pending) { entry.pending += count; pendingReturnRequests += count; }
    entry.byBucket[bucket] = (entry.byBucket[bucket] || 0) + count;
    entry.byReason[reason] = (entry.byReason[reason] || 0) + count;
    const sku = norm(row.sku);
    if (sku) entry.skus.add(sku);
    returnsByAsin.set(asin, entry);
    reasonTotals.set(reason, (reasonTotals.get(reason) || 0) + count);
    fbmRefundedAmount += abs(row.fbm_refunded_amount);
    fbmLabelCostBorneBySeller += abs(row.fbm_seller_label_cost);

    // per-asin daily return counts
    if (di >= 0) {
      let m = returnDailyByAsin.get(asin);
      if (!m) { m = new Map(); returnDailyByAsin.set(asin, m); }
      const d = m.get(date) || { rc: 0, fba: 0, fbm: 0, pend: 0 };
      d.rc += count; if (channel === "FBA") d.fba += count; else if (channel === "FBM") d.fbm += count; if (pending) d.pend += count;
      m.set(date, d);
    }
  }
  return {
    returnsByAsin, reasonTotals, pendingReturnRequests, fbmRefundedAmount, fbmLabelCostBorneBySeller,
    returnRecordCount, latestReturnDate, returnsDaily, channelSeries, statusSeries, labelPayerSeries, bucketSeries, returnDailyByAsin,
  };
}

/**
 * Fold durable Settlement aggregates into the SAME moneyByKey structure returnsLeakageSettlementFold produces, using
 * refund_event_count (not a per-row +1) and summing the RAW fee parts so the zero-clamp is applied ONCE over the whole
 * window (byte-identical to the raw grouped export, which is one row per sku/asin/type/currency over the window). Also
 * collects the per-(currency,asin) daily money sub-series + the account money-by-currency daily series.
 */
function durableSettlementFold(rows, dateIndex) {
  const moneyByKey = new Map();
  const raw = new Map(); // key -> { commission, unitFee, restock } running abs sums, clamped at finalize
  let latestSettlementDate = null;
  const dailyByKey = new Map(); // "currency|asin" -> Map(date -> money bucket)

  for (const row of Array.isArray(rows) ? rows : []) {
    const asin = norm(row.child_asin);
    if (!asin) continue;
    const currency = norm(row.currency) || null;
    const type = upper(row.settlement_type);
    const date = norm(row.settlement_date);
    if (isDateStr(date) && (!latestSettlementDate || date > latestSettlementDate)) latestSettlementDate = date;
    const key = `${currency || "?"}|${asin}`;
    const entry = moneyByKey.get(key) || {
      asin, currency, skus: new Set(),
      settledSales: 0, settledUnits: 0, refundedAmount: 0, refundTax: 0, refundedReferralFeeCredit: 0,
      returnFees: 0, cogsOnRefundedUnits: 0, refundedUnitsSettled: 0, refundEvents: 0,
    };
    const parts = raw.get(key) || { commission: 0, unitFee: 0, restock: 0 };
    const sku = norm(row.sku);
    if (sku) entry.skus.add(sku);
    const di = dateIndex.has(date) ? dateIndex.get(date) : -1;

    if (type === "ORDER") {
      entry.settledSales += num(row.item_price);
      entry.settledUnits += num(row.quantity);
    } else if (type === "REFUND") {
      entry.refundEvents += Math.max(0, Math.trunc(num(row.refund_event_count)));
      entry.refundedAmount += abs(row.refunded_amount);
      entry.refundTax += abs(row.refund_tax);
      entry.refundedReferralFeeCredit += abs(row.refunded_referral_fee);
      parts.commission += abs(row.refund_commission);
      parts.unitFee += abs(row.fba_customer_return_per_unit_fee);
      parts.restock += abs(row.refund_restocking_fee);
      entry.cogsOnRefundedUnits += abs(row.cogs_total_value);
      entry.refundedUnitsSettled += abs(row.quantity);
    }
    raw.set(key, parts);
    moneyByKey.set(key, entry);

    // daily money sub-series (per currency|asin)
    if (di >= 0) {
      let m = dailyByKey.get(key);
      if (!m) { m = new Map(); dailyByKey.set(key, m); }
      const d = m.get(date) || { rfd: 0, rtx: 0, rrf: 0, com: 0, ufe: 0, rst: 0, cog: 0, rus: 0, rev: 0, settledSales: 0, settledUnits: 0 };
      if (type === "ORDER") { d.settledSales += num(row.item_price); d.settledUnits += num(row.quantity); }
      else if (type === "REFUND") {
        d.rfd += abs(row.refunded_amount); d.rtx += abs(row.refund_tax); d.rrf += abs(row.refunded_referral_fee);
        d.com += abs(row.refund_commission); d.ufe += abs(row.fba_customer_return_per_unit_fee); d.rst += abs(row.refund_restocking_fee);
        d.cog += abs(row.cogs_total_value); d.rus += abs(row.quantity); d.rev += Math.max(0, Math.trunc(num(row.refund_event_count)));
      }
      m.set(date, d);
    }
  }
  // finalize the zero-clamped return fee ONCE over the window per key
  for (const [key, entry] of moneyByKey) {
    const p = raw.get(key) || { commission: 0, unitFee: 0, restock: 0 };
    entry.returnFees = Math.max(0, p.commission + p.unitFee - p.restock);
  }
  return { moneyByKey, latestSettlementDate, dailyByKey };
}

// Ordered daily per (currency, asin): { "currency|asin" -> Map(date -> { ord, sal }) }.
function orderedDaily(orderedRows, dateIndex) {
  const byKey = new Map();
  for (const row of Array.isArray(orderedRows) ? orderedRows : []) {
    const asin = norm(row.child_asin);
    if (!asin) continue;
    const currency = norm(row.item_price_currency) || null;
    const date = norm(row.date);
    if (!dateIndex.has(date)) continue;
    const key = `${currency || "?"}|${asin}`;
    let m = byKey.get(key);
    if (!m) { m = new Map(); byKey.set(key, m); }
    const d = m.get(date) || { ord: 0, sal: 0 };
    d.ord += num(row.total_units_sum ?? row.quantity);
    d.sal += num(row.total_sales_sum ?? row.item_price_value);
    m.set(date, d);
  }
  return byKey;
}

/**
 * Build the full advanced payload. Pure.
 */
export function buildReturnsAdvancedPayload({
  accountId, asOf, from, windowDays, graceDays = RETURNS_GRACE_DAYS,
  returnsSourceLabel, moneySourceLabel, rateSourceLabel, rateSourceLagDays, returnHistoryDays,
  durableReturnRows = [], durableSettlementRows = [], orderedRows = [], catalogRows = [],
  returnsRefreshedAt = null, settlementsRefreshedAt = null,
  returnsCoveredFrom = null, returnsCoveredTo = null, settlementsCoveredFrom = null, settlementsCoveredTo = null,
}) {
  const axis = dateAxis(from, asOf);
  const dateIndex = new Map(axis.map((d, i) => [d, i]));

  const ret = durableReturnsFold(durableReturnRows, dateIndex);
  const settle = durableSettlementFold(durableSettlementRows, dateIndex);
  const { orderedByKey } = returnsLeakageOrderedFold(orderedRows);
  const catalog = salesMoversCatalogFold(catalogRows);
  const ordDaily = orderedDaily(orderedRows, dateIndex);

  // Base rows via the SHARED assembly authority (byte-identical aggregate to the raw path).
  const rows = assembleReturnsLeakageRows({
    returnsByAsin: ret.returnsByAsin, moneyByKey: settle.moneyByKey, orderedByKey, catalog,
  });

  // Grace period -> confirmed vs provisional (recency of the RETURN, currency-less counts).
  const grace = Math.max(1, Math.trunc(graceDays) || RETURNS_GRACE_DAYS);
  const provisionalCutoff = addDaysStr(asOf, -(grace - 1)); // returns on/after this date are provisional
  const provisionalIdx = dateIndex.has(provisionalCutoff) ? dateIndex.get(provisionalCutoff) : axis.length;
  let provisionalReturnCount = 0;
  let confirmedReturnCount = 0;
  for (let i = 0; i < axis.length; i += 1) {
    const c = ret.returnsDaily.returnCount[i] || 0;
    if (i >= provisionalIdx) provisionalReturnCount += c; else confirmedReturnCount += c;
  }

  // Attach compact per-row daily sub-series (only days with activity). Return counts ride the RETURN-HOLDER row only
  // (returnCount>0). Money/ordered ride the row's own currency|asin key.
  for (const r of rows) {
    const key = `${r.currency || "?"}|${r.asin}`;
    const money = settle.dailyByKey.get(key);
    const ord = ordDaily.get(key);
    const retDaily = r.returnCount > 0 ? ret.returnDailyByAsin.get(r.asin) : null;
    const days = new Set();
    if (money) for (const d of money.keys()) days.add(d);
    if (ord) for (const d of ord.keys()) days.add(d);
    if (retDaily) for (const d of retDaily.keys()) days.add(d);
    const daily = [...days].filter((d) => dateIndex.has(d)).sort().map((d) => {
      const m = money?.get(d) || {};
      const o = ord?.get(d) || {};
      const rc = retDaily?.get(d) || {};
      const cell = { date: d };
      if (rc.rc) { cell.rc = rc.rc; if (rc.fba) cell.fba = rc.fba; if (rc.fbm) cell.fbm = rc.fbm; if (rc.pend) cell.pend = rc.pend; }
      if (m.rfd) cell.rfd = m.rfd; if (m.rtx) cell.rtx = m.rtx; if (m.rrf) cell.rrf = m.rrf;
      if (m.com) cell.com = m.com; if (m.ufe) cell.ufe = m.ufe; if (m.rst) cell.rst = m.rst;
      if (m.cog) cell.cog = m.cog; if (m.rus) cell.rus = m.rus; if (m.rev) cell.rev = m.rev;
      if (m.settledSales) cell.ssl = m.settledSales; if (m.settledUnits) cell.sun = m.settledUnits;
      if (o.ord) cell.ord = o.ord; if (o.sal) cell.sal = o.sal;
      return cell;
    });
    r.daily = daily;
    // per-row provisional (recent) return count + whether the return rate is currency-withheld (multi-currency ASIN)
    r.rateWithheld = r.returnCount > 0 && r.returnedUnits === null;
    let recent = 0;
    if (retDaily) for (const [d, v] of retDaily) { if (dateIndex.has(d) && dateIndex.get(d) >= provisionalIdx) recent += v.rc; }
    r.provisionalReturnCount = recent;
    r.confirmedReturnCount = Math.max(0, r.returnCount - recent);
  }

  // Account money-by-currency daily series (sum the per-key daily across asins).
  const N = axis.length;
  const moneySeries = {};
  const ensureCur = (cur) => {
    if (!moneySeries[cur]) {
      moneySeries[cur] = {
        refundedAmount: new Array(N).fill(0), refundTax: new Array(N).fill(0), refundedReferralFeeCredit: new Array(N).fill(0),
        commissionAbs: new Array(N).fill(0), unitFeeAbs: new Array(N).fill(0), restockAbs: new Array(N).fill(0),
        cogsOnRefundedUnits: new Array(N).fill(0), refundedUnitsSettled: new Array(N).fill(0), refundEvents: new Array(N).fill(0),
        settledSales: new Array(N).fill(0), settledUnits: new Array(N).fill(0), orderedUnits: new Array(N).fill(0), orderedSales: new Array(N).fill(0),
      };
    }
    return moneySeries[cur];
  };
  for (const [key, m] of settle.dailyByKey) {
    const cur = key.split("|")[0];
    if (cur === "?") continue;
    const s = ensureCur(cur);
    for (const [d, v] of m) {
      const i = dateIndex.get(d); if (i == null) continue;
      s.refundedAmount[i] += v.rfd; s.refundTax[i] += v.rtx; s.refundedReferralFeeCredit[i] += v.rrf;
      s.commissionAbs[i] += v.com; s.unitFeeAbs[i] += v.ufe; s.restockAbs[i] += v.rst;
      s.cogsOnRefundedUnits[i] += v.cog; s.refundedUnitsSettled[i] += v.rus; s.refundEvents[i] += v.rev;
      s.settledSales[i] += v.settledSales; s.settledUnits[i] += v.settledUnits;
    }
  }
  for (const [key, m] of ordDaily) {
    const cur = key.split("|")[0];
    if (cur === "?") continue;
    const s = ensureCur(cur);
    for (const [d, v] of m) { const i = dateIndex.get(d); if (i == null) continue; s.orderedUnits[i] += v.ord; s.orderedSales[i] += v.sal; }
  }

  const currencies = [...new Set(rows.map((r) => r.currency).filter(Boolean))].sort();
  const latestDataDate = [ret.latestReturnDate, settle.latestSettlementDate].filter(Boolean).sort().slice(-1)[0] || null;
  // A day is fully reconciled once it is older than the grace window (settlement corrections have landed).
  const latestReconciliation = axis.length ? addDaysStr(asOf, -grace) : null;

  return {
    version: RETURNS_ADVANCED_VERSION,
    accountId,
    asOf,
    window: { from, to: asOf, days: windowDays },
    windowDayOptions: RETURNS_WINDOW_DAY_OPTIONS,
    historyDays: returnHistoryDays,
    graceDays: grace,
    returnsSourceLabel,
    moneySourceLabel,
    rateSourceLabel,
    rateSourceLagDays,
    returnHistoryDays,
    returnRecordCount: ret.returnRecordCount,
    pendingReturnRequests: ret.pendingReturnRequests,
    fbmOnly: { refundedAmount: ret.fbmRefundedAmount, sellerBorneLabelCost: ret.fbmLabelCostBorneBySeller },
    reasonTotals: [...ret.reasonTotals.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([reason, count]) => ({ reason, count, bucket: classifyReturnReason(reason) })),
    currencies,
    rows,
    catalogBrands: catalog.catalogBrands,
    // ---- advanced additive fields (recomputed in-browser for any of windowDayOptions, ZERO refetch) ----
    dayAxis: axis,
    series: {
      returns: ret.returnsDaily,
      money: moneySeries,
      channel: ret.channelSeries,
      status: ret.statusSeries,
      labelPayer: ret.labelPayerSeries,
      reasonBucket: ret.bucketSeries,
    },
    provisional: {
      graceDays: grace,
      cutoff: provisionalCutoff,
      returnCount: provisionalReturnCount,
      confirmedReturnCount,
    },
    freshness: {
      returnsRefreshedAt, settlementsRefreshedAt,
      returnsCoveredFrom, returnsCoveredTo, settlementsCoveredFrom, settlementsCoveredTo,
      latestReturnDate: ret.latestReturnDate, latestSettlementDate: settle.latestSettlementDate,
      latestDataDate, latestReconciliation, provisionalFrom: provisionalCutoff, graceDays: grace,
    },
    latestDataDate,
  };
}
