// CLIENT-side OLI coverage classification (flexii UK follow-up). PURE + deterministic. It decides, for a requested
// interval (a Sales Dashboard range OR a Daily Reporting column), whether the source PROVES every date, only part, no
// date, or whether the coverage evidence itself could not be read -- so the UI can render a genuine covered zero as
// GBP 0 while an uncovered / unknown / unproven-empty stretch renders as an em dash, and a partial stretch is labelled
// partial (never a silent full-availability claim over a shrunk window).
//
// PROOF MODEL (matches the server's mergeCoverageWindows semantics, but TOLERANT -- a malformed window is skipped, not
// thrown, so a UI hiccup can never crash a page): a date is PROVEN when it lies in the NORMALIZED UNION of the coverage
// windows OR has an actual positive data row. A row is positive evidence for its OWN date ONLY -- it never proves an
// adjacent date and never fills an internal coverage gap. `coverageTo` and internal gaps are honoured (availability is
// NOT decided from coverageFrom alone). 7-bit ASCII, LF.

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (v) => typeof v === "string" && DATE.test(v);

function addDayStr(d, n) {
  return new Date(Date.parse(d + "T00:00:00.000Z") + n * 86400000).toISOString().slice(0, 10);
}

// Normalize any coverage-window list into a sorted, disjoint, gap-preserving union. Adjacent/overlapping windows merge
// (a 1-day touch counts as adjacent); a malformed window (bad date / inverted) is SKIPPED (never throws in the UI).
export function normalizeWindows(windows) {
  const list = [];
  for (const w of Array.isArray(windows) ? windows : []) {
    const from = w && String(w.from);
    const to = w && String(w.to);
    if (isDate(from) && isDate(to) && from <= to) list.push({ from, to });
  }
  list.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  const merged = [];
  for (const w of list) {
    const last = merged[merged.length - 1];
    if (last && w.from <= addDayStr(last.to, 1)) { if (w.to > last.to) last.to = w.to; }
    else merged.push({ from: w.from, to: w.to });
  }
  return merged;
}

function inWindows(merged, d) {
  for (const w of merged) if (w.from <= d && d <= w.to) return true;
  return false;
}

// The set of dates in [from, to] (inclusive). Bounded by the caller's window; a Dashboard YTD is ~365 iterations.
function eachDate(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDayStr(d, 1)) out.push(d);
  return out;
}

export const COVERAGE_STATUS = Object.freeze({ COVERED: "covered", PARTIAL: "partial", UNAVAILABLE: "unavailable", UNKNOWN: "unknown" });

/**
 * Classify a requested interval [from, to] against coverage evidence + the dates that carry a positive data row.
 *   coverageWindows : array of { from, to } | null      (the normalized-union input)
 *   coverageRead    : "ok" | "read-failed" | "schema-missing" | undefined
 *                     - "ok"        => windows are authoritative;
 *                     - read-failed / schema-missing => evidence unreadable -> UNKNOWN for any unproven date;
 *                     - undefined   => the payload predates the coverage feature; the CALLER decides the legacy
 *                                      fallback (this fn still returns UNKNOWN so callers never mistake it for covered).
 *   rowDates        : Set|array of YYYY-MM-DD strings that have a POSITIVE data row (positive = real OLI evidence).
 *   dataFloor       : optional YYYY-MM-DD. When set, a COVERAGE WINDOW only proves dates ON/AFTER it -- so a date that
 *                     is coverage-proven but earlier than the caller's FETCHED-DATA horizon (the view never loaded its
 *                     rows) is NOT counted proven-for-display (it would otherwise read as a covered date the KPI cannot
 *                     sum -> a silently understated or false-empty total). A POSITIVE ROW always proves its own date
 *                     regardless (a row that exists was, by definition, fetched).
 * Returns { status, coveredFrom, coveredTo, provenDays, totalDays } where status is a COVERAGE_STATUS. coveredFrom/To
 * are the first/last PROVEN date (a partial with an internal gap still reports its proven span; provenDays<span signals
 * the gap). A guard (bad/inverted interval) returns UNKNOWN with zero days.
 */
export function classifyInterval({ coverageWindows = null, coverageRead = undefined, rowDates = null, from, to, dataFloor = null } = {}) {
  if (!isDate(from) || !isDate(to) || from > to) {
    return { status: COVERAGE_STATUS.UNKNOWN, coveredFrom: null, coveredTo: null, provenDays: 0, totalDays: 0 };
  }
  const rows = rowDates instanceof Set ? rowDates : new Set(Array.isArray(rowDates) ? rowDates.map(String) : []);
  const known = coverageRead === "ok" && Array.isArray(coverageWindows);
  const merged = known ? normalizeWindows(coverageWindows) : [];
  const floor = isDate(String(dataFloor)) ? String(dataFloor) : null;
  const dates = eachDate(from, to);
  const proven = dates.filter((d) => rows.has(d) || (known && (!floor || d >= floor) && inWindows(merged, d)));
  const totalDays = dates.length;
  const provenDays = proven.length;
  const coveredFrom = provenDays ? proven[0] : null;
  const coveredTo = provenDays ? proven[provenDays - 1] : null;
  if (provenDays === totalDays) return { status: COVERAGE_STATUS.COVERED, coveredFrom: from, coveredTo: to, provenDays, totalDays };
  // Not fully proven. If coverage evidence is not authoritative (unreadable OR the legacy no-feature case), we cannot
  // classify the unproven remainder as genuinely-empty vs uncovered -> UNKNOWN (never a silent covered/partial claim).
  if (!known) return { status: COVERAGE_STATUS.UNKNOWN, coveredFrom, coveredTo, provenDays, totalDays };
  if (provenDays === 0) return { status: COVERAGE_STATUS.UNAVAILABLE, coveredFrom: null, coveredTo: null, provenDays, totalDays };
  return { status: COVERAGE_STATUS.PARTIAL, coveredFrom, coveredTo, provenDays, totalDays };
}

// True when the completeness payload actually carries OLI coverage evidence (the feature is active for this response).
// When false the caller keeps its exact legacy rendering (byte-identical for payloads that predate the augment).
export function coverageActive(completeness) {
  return !!(completeness && completeness.coverageRead != null);
}

// The set of dates that carry POSITIVE OLI evidence (real sales or units). A zero/ads-only row is NOT positive
// evidence -- a genuinely covered zero is proven by the coverage WINDOW, not by a row. rowKey/valueKeys are injectable
// so the same helper serves the Daily payload (total_sales/total_units_sold) and any other row shape.
export function positiveRowDates(rows, { dateKey = "date", valueKeys = ["total_sales", "total_units_sold"] } = {}) {
  const set = new Set();
  for (const r of Array.isArray(rows) ? rows : []) {
    const d = r && String(r[dateKey] || "");
    if (!isDate(d)) continue;
    if (valueKeys.some((k) => Number(r[k]) > 0)) set.add(d);
  }
  return set;
}

/**
 * Enrich each Daily report column cell with a coverage `status` (+ proven span). PURE: it never changes any metric
 * value (the cell's summed sales/units are the source-backed totals -- uncovered dates simply carry no row, so they
 * contribute nothing). It only LABELS each cell so the renderer can show GBP 0 for a fully proven-empty column, a
 * source-backed total with a Partial marker for a partially-proven column, and an em dash for unavailable/unknown.
 *   report  : { columns:[{from,to,...}], cells:[{sales,units,...}] }
 *   completeness : the serve augment (carries coverageWindows + coverageRead); when coverage is inactive every cell
 *                  keeps status "unknown-legacy" and the renderer falls back to its exact prior behaviour.
 *   rows    : the Daily payload rows (for positive-row evidence).
 * Returns a NEW cells array (same values) with { status, coveredFrom, coveredTo, provenDays, totalDays } added.
 */
export function applyDailyCoverage({ report, completeness, rows }) {
  const columns = (report && Array.isArray(report.columns)) ? report.columns : [];
  const cells = (report && Array.isArray(report.cells)) ? report.cells : [];
  const active = coverageActive(completeness);
  const coverageWindows = active ? (completeness.coverageWindows || []) : null;
  const coverageRead = active ? completeness.coverageRead : undefined;
  const rowDates = positiveRowDates(rows);
  return cells.map((cell, i) => {
    const col = columns[i];
    if (!active || !col || !isDate(String(col.from)) || !isDate(String(col.to))) {
      // Legacy / malformed: no coverage claim -> the renderer keeps its exact prior rendering (byte-identical).
      return { ...cell, status: "unknown-legacy", coveredFrom: null, coveredTo: null, provenDays: 0, totalDays: 0 };
    }
    const c = classifyInterval({ coverageWindows, coverageRead, rowDates, from: String(col.from), to: String(col.to) });
    return { ...cell, status: c.status, coveredFrom: c.coveredFrom, coveredTo: c.coveredTo, provenDays: c.provenDays, totalDays: c.totalDays };
  });
}
