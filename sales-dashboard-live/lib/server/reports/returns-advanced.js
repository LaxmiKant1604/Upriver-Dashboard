// Returns & Refund Leakage -- ADVANCED durable payload (returns-leakage-v3).
//
// This is the PURE builder for the dedicated, durable Returns pipeline. It reads the day-grain durable Returns +
// Settlement aggregates (source_returns_history / source_settlement_history), the reused durable Order Line Items
// ordered evidence, and the Product Catalog, and produces a SUPERSET of the proven returns-leakage-v2 payload:
//
//   * the SAME base fields (accountId, asOf, window, source labels, returnRecordCount, pendingReturnRequests,
//     fbmOnly, reasonTotals, currencies, rows[], catalogBrands) -- built through the SHARED assembleReturnsLeakageRows
//     authority so the aggregate is byte-identical to buildReturnsLeakage() for the same underlying returns/money
//     (except fbmOnly, which sums FBM rows only since schema 2 -- see SCHEMA 2 below); and
//   * ADDITIVE advanced fields the redesigned page needs, all recomputable in the browser with ZERO refetch:
//     a shared dayAxis, account-level returns/money/breakdown daily series, per-row compact daily sub-series, a
//     confirmed-vs-provisional split driven by a documented settlement grace period, and freshness/coverage evidence.
//
// CORRECTNESS: money is the settlement authority and never crosses currencies; the return-fee component is summed
// from its RAW abs parts (commission + FBA per-unit fee - restocking) and clamped at ZERO once over the window (per
// row it ships the raw parts so any sub-window re-clamps honestly); a returned item is one Returns row (COUNT, never
// an invented quantity); recent returns inside the grace period stay PROVISIONAL, not leakage; nulls stay null.
//
// SCHEMA 2 (returnsSchema = 2; DESIGN-v2 5.2 -- the daily, region-wise Returns (FBA & FBM) event source). ADDITIVE:
// every pre-existing field keeps its value and its key position (new keys are APPENDED to the payload, the row and
// the daily cell), except the two INTENTIONAL changes marked (*):
//   rows[i].returnQuantity  RETURNED UNITS = sum(returned_units) over the history rows behind the row's returns when
//                           EVERY one of them carries units, else null (a legacy row -- returned_units null / absent --
//                           or an event-source group whose events lacked a quantity voids the whole row: never a partial
//                           sum). It rides the return-holder row like returnCount (0 on a row with no returns).
//                           `returnedUnits` is NOT redefined: it stays the return-RATE numerator = return EVENTS.
//   rows[i].daily[j]        rq  (units that day, only when > 0 and every history row that day carries units);
//                           rqx (1 when some history row that day lacks units -- rq is then omitted);
//                           frf / flc (FBM refunded amount / FBM seller-borne label cost that day, FBM rows ONLY).
//   rollingDays = 14        the daily source re-reads only the last 14 days: older returns keep the status / FBM
//                           refund / disposition they had when last fetched (the UI freshness label; OD1).
//   moneyAvailableThrough   the max settlement_date of a nonblank-ASIN Settlement row the builder received (null when
//                           none) -- Settlements are a separate MANUAL source the daily Returns source never refreshes.
//   returnsCoveredThrough   the contiguous 'returns' event-source coverage end <= asOf (returnsCoverageEnd below), from
//                           the OPTIONAL coverage input; null when it is absent / unreadable / holds no window. KEPT for
//                           compatibility only: the client gates per day from the two fields below whenever they exist.
//   returnsCoverageWindows  THE PER-DAY COVERAGE EVIDENCE (returnsCoverageEvidence below): the account's 'returns'
//                           event-source windows, merged (overlapping / touching) and clipped to [window.from, asOf] --
//                           [] when the read is ok but proves no day of the window, null when the read is absent /
//                           unreadable / malformed (the client then keeps today's ungated counts). Only these days carry
//                           event-source RETURNED UNITS and the 14-day freshness label.
//   returnsLegacyCoveredThrough  the LEGACY MANUAL pipeline's horizon counted as covered from window.from (counts only,
//                           never units): min(asOf, RETURNS_LEGACY_SAVED_THROUGH, the day before the first event-source
//                           day) when the coverage read is ok AND the account has a history row dated inside that span;
//                           else null. So an account the event source has not loaded shows its saved legacy counts through
//                           2026-08-31 and NOTHING after (unavailable, never 0); with no saved row at all nothing is
//                           covered (a zero-row legacy account cannot be told apart from a never-loaded one).
//   (*) fbmOnly             sums ONLY fulfillment_channel 'FBM' rows (an FBA row's refund is never an FBM figure).
//   (*) freshness.latestReconciliation = min(asOf - grace, moneyAvailableThrough); null when there is no money.
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
// The schema-2 marker + the daily event source's rolling re-read window. RETURNS_PAYLOAD_ROLLING_DAYS mirrors
// RETURNS_ROLLING_DAYS of lib/server/sync/returns-event-source.js (owner decision OD1 = 14), inlined so this pure builder
// never imports the event-source runner graph; scripts/report-returns-advanced.test.js pins the two equal.
export const RETURNS_PAYLOAD_SCHEMA = 2;
export const RETURNS_PAYLOAD_ROLLING_DAYS = 14;
// The last day the LEGACY MANUAL Returns pipeline saved (source_returns_history 07-03..08-31; it wrote no 'returns'
// coverage). A day after it is proven ONLY by the event source's coverage (returnsCoverageEvidence).
export const RETURNS_LEGACY_SAVED_THROUGH = "2026-08-31";

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

// One history row's RETURNED UNITS (schema 2): a positive integer (the event source stores sum(quantity) only when every
// event of the group had a quantity >= 1), else null = units UNAVAILABLE -- a legacy row (returned_units null, or the
// column absent on a pre-migration read) and any malformed / zero / negative value alike (fail closed, never a guess).
const rowUnits = (raw) => {
  const n = typeof raw === "number" ? raw : (typeof raw === "string" && /^\s*\d+\s*$/.test(raw) ? Number(raw) : NaN);
  return Number.isInteger(n) && n >= 1 ? n : null;
};

// The OPTIONAL coverage input is evidence ONLY as a read:'ok' result carrying a windows array (the
// getSourceCoverageWindows shape); absent / schema-missing / read-failed / malformed -> null.
const coverageWindowsOf = (cov) => (cov && typeof cov === "object" && cov.read === "ok" && Array.isArray(cov.windows) ? cov.windows : null);

/**
 * The CONTIGUOUS Returns event-source coverage end (PURE) for a report window [from, asOf]: the last day X <= asOf such
 * that EVERY day of [ref, X] lies inside a succeeded 'returns' coverage window (windows merged when they overlap or
 * touch), where ref = max(from, the first covered day) -- days before the source's first covered day predate it (their
 * rows, if any, are legacy evidence and stay as they are). When ref itself falls in a HOLE after an earlier run (a
 * reported RETURNS_COVERAGE_GAP at the window start) X is that earlier run's end (< from): every window day then reads
 * unavailable -- an uncovered day is never shown as "zero returns". Days after X are unavailable to the client.
 * -> "YYYY-MM-DD" | null (null: no windows array, or no valid window starting on/before asOf).
 */
export function returnsCoverageEnd(windows, { from, asOf } = {}) {
  if (!Array.isArray(windows) || !isDateStr(asOf)) return null;
  const spans = windows
    .map((w) => ({ from: norm(w && w.from), to: norm(w && w.to) }))
    .filter((w) => isDateStr(w.from) && isDateStr(w.to) && w.from <= w.to && w.from <= asOf)
    .map((w) => ({ from: w.from, to: w.to > asOf ? asOf : w.to }))
    .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  if (!spans.length) return null;
  const runs = [];
  for (const s of spans) {
    const last = runs[runs.length - 1];
    if (last && s.from <= addDaysStr(last.to, 1)) { if (s.to > last.to) last.to = s.to; } else runs.push({ ...s });
  }
  const ref = isDateStr(from) && from > runs[0].from ? from : runs[0].from;
  const covering = runs.find((r) => r.from <= ref && ref <= r.to);
  if (covering) return covering.to;
  const before = runs.filter((r) => r.to < ref);
  return before.length ? before[before.length - 1].to : null;
}

/**
 * The PER-DAY coverage evidence of a report window [from, asOf] (PURE) -> { windows, legacyThrough }:
 *   windows       the valid 'returns' event-source windows merged (overlapping / touching) and CLIPPED to [from, asOf],
 *                 ascending; [] when the read is ok but proves no day of the window; null when `windows` is null (the
 *                 coverage read is absent / unreadable / malformed -- the caller keeps today's ungated behaviour).
 *   legacyThrough the LEGACY horizon counted as covered from `from` (counts only): the last day of
 *                 [from, min(asOf, RETURNS_LEGACY_SAVED_THROUGH, firstEventDay - 1)] when that span is non-empty AND
 *                 `rows` holds a history row dated inside it; else null (always null when windows is null). The days
 *                 BEFORE the event source's first covered day were never replaced by it, so a saved row there is the
 *                 legacy pipeline's own evidence -- trusted through its last saved day and never after it.
 * A gap between event windows stays a gap: a later covered day is covered on its own (never cut at the first hole).
 */
export function returnsCoverageEvidence(windows, { from, asOf, rows = [] } = {}) {
  if (!Array.isArray(windows) || !isDateStr(asOf)) return { windows: null, legacyThrough: null };
  const lo = isDateStr(from) && from <= asOf ? from : asOf;
  const spans = windows
    .map((w) => ({ from: norm(w && w.from), to: norm(w && w.to) }))
    .filter((w) => isDateStr(w.from) && isDateStr(w.to) && w.from <= w.to)
    .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  const merged = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s.from <= addDaysStr(last.to, 1)) { if (s.to > last.to) last.to = s.to; } else merged.push({ ...s });
  }
  const clipped = merged
    .map((w) => ({ from: w.from < lo ? lo : w.from, to: w.to > asOf ? asOf : w.to }))
    .filter((w) => w.from <= w.to);
  // The legacy span: from the window start up to the earliest of asOf, the legacy pipeline's last saved day and the day
  // before the event source's first covered day (ANY window, also one outside this report window).
  let legacyEnd = asOf < RETURNS_LEGACY_SAVED_THROUGH ? asOf : RETURNS_LEGACY_SAVED_THROUGH;
  if (merged.length) { const pre = addDaysStr(merged[0].from, -1); if (pre < legacyEnd) legacyEnd = pre; }
  let legacyThrough = null;
  if (legacyEnd >= lo) {
    const saved = (Array.isArray(rows) ? rows : []).some((r) => { const d = norm(r && r.return_date); return isDateStr(d) && d >= lo && d <= legacyEnd; });
    if (saved) legacyThrough = legacyEnd;
  }
  return { windows: clipped, legacyThrough };
}

/**
 * Fold durable Returns aggregates into the SAME structures returnsLeakageReturnsFold produces (returnsByAsin +
 * account totals), weighting by return_count instead of counting rows one at a time. Also collects the account-level
 * daily returns series + dimension breakdown series (currency-less counts) and the per-asin daily return counts for
 * the per-row sub-series. Blank-ASIN rows are skipped from the fold (as in the raw path) but still counted in
 * returnRecordCount + freshness. Schema 2: per-asin returned units (unitsByAsin: { units, missing } -- `missing` counts
 * the contributing rows WITHOUT units), per-asin-day units / missing-units flag, and the FBM-only money (FBM rows only).
 */
function durableReturnsFold(rows, dateIndex) {
  const returnsByAsin = new Map();
  const unitsByAsin = new Map();
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
    // schema 2: returned units (ONE row without units voids the asin's sum) + FBM-only money (FBM rows only: an FBA
    // row's refunded amount / label cost is never an FBM figure).
    const units = rowUnits(row.returned_units);
    const u = unitsByAsin.get(asin) || { units: 0, missing: 0 };
    if (units == null) u.missing += 1; else u.units += units;
    unitsByAsin.set(asin, u);
    const fbm = channel === "FBM";
    if (fbm) {
      fbmRefundedAmount += abs(row.fbm_refunded_amount);
      fbmLabelCostBorneBySeller += abs(row.fbm_seller_label_cost);
    }

    // per-asin daily return counts (+ schema 2: units, the missing-units flag, FBM-only money)
    if (di >= 0) {
      let m = returnDailyByAsin.get(asin);
      if (!m) { m = new Map(); returnDailyByAsin.set(asin, m); }
      const d = m.get(date) || { rc: 0, fba: 0, fbm: 0, pend: 0, rq: 0, rqx: false, frf: 0, flc: 0 };
      d.rc += count; if (channel === "FBA") d.fba += count; else if (channel === "FBM") d.fbm += count; if (pending) d.pend += count;
      if (units == null) d.rqx = true; else d.rq += units;
      if (fbm) { d.frf += abs(row.fbm_refunded_amount); d.flc += abs(row.fbm_seller_label_cost); }
      m.set(date, d);
    }
  }
  return {
    returnsByAsin, reasonTotals, pendingReturnRequests, fbmRefundedAmount, fbmLabelCostBorneBySeller,
    returnRecordCount, latestReturnDate, returnsDaily, channelSeries, statusSeries, labelPayerSeries, bucketSeries, returnDailyByAsin,
    unitsByAsin,
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
 * Build the full advanced payload. Pure. `returnsCoverage` (optional) = the account's 'returns' event-source coverage
 * read in the getSourceCoverageWindows shape ({ read:'ok', windows:[{ from, to }] }); anything else -> the payload's
 * returnsCoveredThrough, returnsCoverageWindows and returnsLegacyCoveredThrough are null (never a failure). A read:'ok'
 * with no window in [from, asOf] is NOT "no information": returnsCoverageWindows is [] and only the legacy horizon (if
 * any saved row proves it) is covered.
 */
export function buildReturnsAdvancedPayload({
  accountId, asOf, from, windowDays, graceDays = RETURNS_GRACE_DAYS,
  returnsSourceLabel, moneySourceLabel, rateSourceLabel, rateSourceLagDays, returnHistoryDays,
  durableReturnRows = [], durableSettlementRows = [], orderedRows = [], catalogRows = [],
  returnsRefreshedAt = null, settlementsRefreshedAt = null,
  returnsCoveredFrom = null, returnsCoveredTo = null, settlementsCoveredFrom = null, settlementsCoveredTo = null,
  returnsCoverage = null,
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
      // schema 2 (APPENDED after every pre-existing key): the return-holder day's units / missing-units flag and its
      // FBM-only money. rq only when every history row that day carries units; rqx replaces it otherwise.
      if (rc.rc) {
        if (rc.rqx) cell.rqx = 1; else if (rc.rq > 0) cell.rq = rc.rq;
        if (rc.frf) cell.frf = rc.frf; if (rc.flc) cell.flc = rc.flc;
      }
      return cell;
    });
    r.daily = daily;
    // per-row provisional (recent) return count + whether the return rate is currency-withheld (multi-currency ASIN)
    r.rateWithheld = r.returnCount > 0 && r.returnedUnits === null;
    let recent = 0;
    if (retDaily) for (const [d, v] of retDaily) { if (dateIndex.has(d) && dateIndex.get(d) >= provisionalIdx) recent += v.rc; }
    r.provisionalReturnCount = recent;
    r.confirmedReturnCount = Math.max(0, r.returnCount - recent);
    // schema 2: RETURNED UNITS ride the return-holder row (like returnCount): the asin's sum when EVERY contributing
    // history row carries units, else null; a row without returns has 0. Never feeds returnedUnits (the rate numerator).
    const u = r.returnCount > 0 ? ret.unitsByAsin.get(r.asin) : null;
    r.returnQuantity = r.returnCount > 0 ? (u && u.missing === 0 ? u.units : null) : 0;
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
  // Schema 2: the Settlement money is a separate MANUAL source -> it is available only through the latest nonblank-ASIN
  // settlement date the builder received (the settlement fold skips blank-ASIN rows), null when there is none.
  const moneyAvailableThrough = settle.latestSettlementDate;
  // A day is fully reconciled once it is older than the grace window (settlement corrections have landed) AND its money
  // is saved: min(asOf - grace, moneyAvailableThrough); no money -> nothing is reconciled (null).
  const graceCut = axis.length ? addDaysStr(asOf, -grace) : null;
  const latestReconciliation = graceCut && moneyAvailableThrough ? (moneyAvailableThrough < graceCut ? moneyAvailableThrough : graceCut) : null;
  const coverageWindows = coverageWindowsOf(returnsCoverage);
  const returnsCoveredThrough = returnsCoverageEnd(coverageWindows, { from, asOf });
  // The per-day coverage evidence (A1/A4): event-source windows in the window + the legacy horizon (counts only).
  const coverage = returnsCoverageEvidence(coverageWindows, { from, asOf, rows: durableReturnRows });

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
    // ---- schema 2 (APPENDED; DESIGN-v2 5.2) ----
    returnsSchema: RETURNS_PAYLOAD_SCHEMA,
    moneyAvailableThrough,
    returnsCoveredThrough,
    rollingDays: RETURNS_PAYLOAD_ROLLING_DAYS,
    // the per-day coverage evidence (APPENDED after rollingDays): see the SCHEMA 2 header.
    returnsCoverageWindows: coverage.windows,
    returnsLegacyCoveredThrough: coverage.legacyThrough,
  };
}
