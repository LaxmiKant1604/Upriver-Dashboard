// SKU MOVEMENT -- the ONE canonical, PURE (zero-I/O, zero-dependency) daily-window + movement math, shared by BOTH
// the server derivation (sku-movement-core.js) and the frontend view (src/views/SkuMovement.jsx) so a user-chosen
// N is recomputed CLIENT-SIDE from the saved daily history with EXACTLY the same math the server used for the
// default -- never a DataDoe fetch, never a divergent formula. 7-bit ASCII, no imports.

// The default recent/comparison window is 7 calendar dates (was 5). Users may choose 1..30; the derived snapshot
// carries DAILY_HISTORY_DAYS (= 2 * MAX_RECENT_DAYS) of proven daily units so Last N and Previous N are always
// recomputable for any supported N with NO re-derivation. (30 keeps the payload bounded well under the snapshot
// size cap while covering a full month of daily columns; a larger max would bloat every row's daily history.)
export const DEFAULT_RECENT_DAYS = 7;
export const MAX_RECENT_DAYS = 30;
export const MIN_RECENT_DAYS = 1;
export const DAILY_HISTORY_DAYS = MAX_RECENT_DAYS * 2; // Last MAX vs Previous MAX -> 60 proven daily dates

// Movement-status thresholds (the ONLY place status logic lives, shared server + client).
export const MOVEMENT_THRESHOLDS = Object.freeze({ RISING_PCT: 20, DECLINING_PCT: -20 });
export const MOVEMENT_STATUSES = Object.freeze(["New", "Rising", "Stable", "Declining", "Dormant", "No Data"]);

const isDate = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

// Clamp/validate a requested recent-window N to [MIN_RECENT_DAYS, MAX_RECENT_DAYS]; a non-finite/blank -> default.
export function clampRecentDays(n) {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v)) return DEFAULT_RECENT_DAYS;
  if (v < MIN_RECENT_DAYS) return MIN_RECENT_DAYS;
  if (v > MAX_RECENT_DAYS) return MAX_RECENT_DAYS;
  return v;
}

// A movement percentage: ((last - prev) / prev) * 100. Returns null (em dash) when the denominator is 0 (no prior
// baseline -- a percentage is undefined then; the STATUS still classifies it). NEVER Infinity/NaN.
export function movementPercent(lastUnits, prevUnits) {
  const a = Number(lastUnits) || 0;
  const b = Number(prevUnits) || 0;
  if (!(b > 0)) return null;
  return Math.round(((a - b) / b) * 1000) / 10;
}

// The central status decision (identical semantics to the prior 5-day version, now over the selected N window):
// No Data (never sold) -> New (no prior history, only recent) -> Dormant (had history, zero recent) ->
// Rising/Stable/Declining from the Last-N vs Previous-N momentum. Pure + exhaustive.
export function movementStatus({ lastUnits = 0, prevUnits = 0, monthsTotalUnits = 0, mtdUnits = 0 } = {}) {
  const last = Number(lastUnits) || 0;
  const prev = Number(prevUnits) || 0;
  const months = Number(monthsTotalUnits) || 0;
  const mtd = Number(mtdUnits) || 0;
  const priorHistory = months > 0 || prev > 0;
  const recent = last > 0 || mtd > 0;
  if (!priorHistory && !recent) return "No Data";
  if (!priorHistory && recent) return "New";
  if (priorHistory && last === 0) return "Dormant";
  if (!(prev > 0)) return last > 0 ? "Rising" : "Stable"; // months history but no N-day baseline -> re-emerging
  const pct = ((last - prev) / prev) * 100;
  if (pct > MOVEMENT_THRESHOLDS.RISING_PCT) return "Rising";
  if (pct < MOVEMENT_THRESHOLDS.DECLINING_PCT) return "Declining";
  return "Stable";
}

// The N most-recent dates and the N immediately-preceding dates, from an ASCENDING list of daily dates
// (dailyDates[last] === effectiveAsOf). recentDates ends at effectiveAsOf; prevDates ends the day before recentDates.
// Both are ascending. When the history is shorter than 2N, prevDates simply carries fewer dates (never fabricated).
export function recentPrevDates(dailyDates, n) {
  const dates = Array.isArray(dailyDates) ? dailyDates.filter(isDate) : [];
  const N = clampRecentDays(n);
  const L = dates.length;
  const recentDates = dates.slice(Math.max(0, L - N));
  const prevDates = dates.slice(Math.max(0, L - 2 * N), Math.max(0, L - N));
  return { recentDates, prevDates };
}

// Sum a row's daily units over a set of dates. `dailyUnits` is a SPARSE map { "YYYY-MM-DD": units } (dates with
// units only). A date not in the map contributes 0 (an honest covered-zero -- coverage is proven by the caller's
// dailyDates axis, which never extends beyond effectiveAsOf). NEVER coerces an unavailable/out-of-coverage date to
// a sale; callers pass only in-coverage dates.
export function sumDailyUnits(dailyUnits, dates) {
  const map = dailyUnits && typeof dailyUnits === "object" ? dailyUnits : {};
  let t = 0;
  for (const d of Array.isArray(dates) ? dates : []) t += Number(map[d]) || 0;
  return t;
}

// The unit value for ONE date on a row: null when the date is BEFORE the account's proven coverage (unavailable,
// em dash -- NEVER a fabricated 0); otherwise the mapped units, or 0 for a covered date with no sale.
export function dailyUnitAt(dailyUnits, date, coverageFrom) {
  if (isDate(coverageFrom) && isDate(date) && date < coverageFrom) return null; // out of coverage -> unavailable
  const map = dailyUnits && typeof dailyUnits === "object" ? dailyUnits : {};
  return Number(map[date]) || 0;
}

// Recompute a row's Last-N / Previous-N totals, movement %, and status for the chosen N -- the CLIENT calls this on
// an N change (and the server for the default). `row` carries dailyUnits (sparse) + monthUnitsTotal + mtdUnits.
export function computeRowWindow(row, dailyDates, n) {
  const { recentDates, prevDates } = recentPrevDates(dailyDates, n);
  const du = row && row.dailyUnits;
  const lastTotal = sumDailyUnits(du, recentDates);
  const prevTotal = sumDailyUnits(du, prevDates);
  return {
    recentDates, prevDates, lastTotal, prevTotal,
    movementPercent: movementPercent(lastTotal, prevTotal),
    status: movementStatus({ lastUnits: lastTotal, prevUnits: prevTotal, monthsTotalUnits: row && row.monthsTotalUnits, mtdUnits: row && row.mtdUnits }),
  };
}
