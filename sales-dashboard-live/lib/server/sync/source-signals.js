// Scheduler v2 Phase 1c — typed dependency signals.
//
// Every signal here is derived ONLY from an authoritative, VALIDATED source-job
// result (a fresh success this cycle) or from persisted, server-owned rows. None of
// these values may ever come from the browser/UI: the worker computes them from the
// rows it fetched and validated, and feeds them back into the Phase 1b resolver
// (reportSourceRequestHashes) to gate staged/fallback downstream jobs.
//
// A "job outcome" is what source-worker.js returns for one processed source job:
//   { requestKey, status: "success"|"failed"|"terminal", validated: boolean,
//     rows?: Array }   (rows present only on a validated success)
// Anything that is not a fresh validated success yields a non-activating signal, so a
// failed/terminal/timed-out primary preserves the prior report and spends no new
// downstream export (matching the approved staged policy).

function toNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

// Map a worker job outcome to the coarse signal status the resolver understands.
// Only a fresh validated success is a legitimate basis for activating downstream.
function baseStatus(outcome) {
  if (outcome && outcome.status === "success" && outcome.validated === true) {
    return { status: "success", validated: true };
  }
  if (outcome && outcome.status === "terminal") return { status: "terminal", validated: false };
  return { status: "failed", validated: false };
}

// The latest date on which the probe actually reported units, mirroring
// fetchSalesTrafficLatestDate: the max `date` among rows with units > 0. A successful
// probe that reported nothing yields null (an honest "data unavailable" snapshot, no
// downstream), never a guessed calendar date.
export function latestReportedDateFromProbeRows(rows) {
  let latest = null;
  for (const row of Array.isArray(rows) ? rows : []) {
    const date = row && (row.date ?? row.metric_date);
    if (date && toNum(row.units_sum ?? row.total_units) > 0 && (!latest || date > latest)) latest = date;
  }
  return latest;
}

// Sales Movers latest-date probe -> { status, validated, latestReportedDate }.
export function salesMoversProbeSignal(outcome) {
  const base = baseStatus(outcome);
  if (base.status !== "success") return { status: base.status, validated: false, latestReportedDate: null };
  return { status: "success", validated: true, latestReportedDate: latestReportedDateFromProbeRows(outcome.rows) };
}

// Keyword Rank weekly SQP -> { status, validated, distinctPeriods }. distinctPeriods is
// the count of distinct reporting dates actually returned (the resolver's monthly
// fallback fires only for a validated weekly with < N distinct periods).
export function keywordWeeklySignal(outcome) {
  const base = baseStatus(outcome);
  if (base.status !== "success") return { status: base.status, validated: false, distinctPeriods: null };
  const periods = new Set();
  for (const row of Array.isArray(outcome.rows) ? outcome.rows : []) {
    const date = row && (row.date ?? row.metric_date);
    if (date) periods.add(date);
  }
  return { status: "success", validated: true, distinctPeriods: periods.size };
}

// Listing Optimizer SQP -> { status, validated }. A validated SQP success (even with
// ZERO rows) activates the catalog; a disabled/failed/unvalidated SQP does not.
export function optimizerSqpSignal(outcome) {
  const base = baseStatus(outcome);
  return { status: base.status, validated: base.status === "success" };
}

// PPC Ads currency -> { status, validated, currencyCount }, derived from persisted
// ads_daily_source_rows (never a live Ads export). currencyCount is the number of
// distinct non-empty currencies across the saved rows.
export function adsCurrencySignal(adsRows) {
  if (!Array.isArray(adsRows)) return { status: "failed", validated: false, currencyCount: 0 };
  const currencies = new Set();
  for (const row of adsRows) {
    const currency = String((row && row.currency) || "").trim();
    if (currency) currencies.add(currency);
  }
  return { status: "success", validated: true, currencyCount: currencies.size };
}

// The three source-job request keys that PRODUCE a staged/fallback signal, mapped to
// their deriver. A shared source (catalog/inventory) produces no signal.
export const SIGNAL_PRODUCERS = Object.freeze({
  "sales-movers:sales-latest-probe": salesMoversProbeSignal,
  "keyword-rank:sqp-weekly": keywordWeeklySignal,
  "listing-optimizer:sqp-weekly": optimizerSqpSignal,
});

// Fold a batch of processed job outcomes into the typed signal map the resolver reads.
// Only signal-producing request keys contribute; everything else is ignored.
export function deriveSignalsFromOutcomes(outcomes) {
  const signals = {};
  for (const outcome of Array.isArray(outcomes) ? outcomes : []) {
    // A deferred (deadline-resumable) or skipped job is still in progress — it produces NO
    // signal this round (not a failed one); the next invocation reconstructs it from the
    // persisted success once it completes.
    if (!outcome || outcome.status === "deferred" || outcome.status === "skipped") continue;
    const deriver = SIGNAL_PRODUCERS[outcome.requestKey];
    if (deriver) signals[outcome.requestKey] = deriver(outcome);
  }
  return signals;
}
