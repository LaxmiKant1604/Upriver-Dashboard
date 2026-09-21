// PURE client-side OLI coverage classifier (src/lib/coverage-windows.js). Offline, deterministic. Proves the
// covered/partial/unavailable/unknown contract that BOTH the Sales Dashboard and Daily Reporting render from, over the
// exact scenarios the owner enumerated: 90D-requested-but-17-covered, custom-before-first-row, fully-uncovered month,
// partially-covered month, INTERNAL coverage gap, coverage ending before the requested end, a genuine covered zero,
// real rows earlier than a lagging coverage boundary, and a coverage-read failure. 7-bit ASCII, LF.

import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { classifyInterval, normalizeWindows, positiveRowDates, coverageActive, COVERAGE_STATUS } from "../src/lib/coverage-windows.js";

let passed = 0;
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };
const test = (name, fn) => { try { fn(); passed += 1; out("  ok  " + name); } catch (e) { out("FAIL  " + name); out(String(e && e.stack ? e.stack : e)); process.exitCode = 1; } };
const W = (from, to) => ({ from, to });
const ok = (windows) => ({ coverageWindows: windows, coverageRead: "ok" });

out("coverage-windows classifier");

/* ---- normalizeWindows ---- */
test("normalizeWindows merges overlapping/adjacent windows and DROPS malformed ones (never throws)", () => {
  assert.deepEqual(normalizeWindows([W("2026-01-10", "2026-01-20"), W("2026-01-01", "2026-01-11")]), [W("2026-01-01", "2026-01-20")], "overlap merges");
  assert.deepEqual(normalizeWindows([W("2026-01-01", "2026-01-10"), W("2026-01-11", "2026-01-20")]), [W("2026-01-01", "2026-01-20")], "1-day-adjacent merges");
  assert.deepEqual(normalizeWindows([W("2026-01-01", "2026-01-10"), W("2026-01-20", "2026-01-30")]), [W("2026-01-01", "2026-01-10"), W("2026-01-20", "2026-01-30")], "a real gap is PRESERVED");
  assert.deepEqual(normalizeWindows([W("bad", "2026-01-10"), W("2026-02-02", "2026-02-01"), null]), [], "malformed/inverted/null skipped, no throw");
});

/* ---- the 9 owner scenarios ---- */
test("S1. 90D requested but only 17 days covered -> PARTIAL (never a silent 'covered' over a shrunk window)", () => {
  const rowDates = []; for (let d = 3; d <= 19; d++) rowDates.push(`2026-09-${String(d).padStart(2, "0")}`);
  const r = classifyInterval({ ...ok([W("2026-09-03", "2026-09-19")]), rowDates, from: "2026-06-21", to: "2026-09-19" });
  assert.equal(r.status, COVERAGE_STATUS.PARTIAL);
  assert.equal(r.coveredFrom, "2026-09-03");
  assert.equal(r.coveredTo, "2026-09-19");
  assert.equal(r.provenDays, 17);
  assert.equal(r.totalDays, 91);
});

test("S2. Custom range entirely BEFORE any coverage/rows -> UNAVAILABLE (allowed to request it; classified honestly)", () => {
  const r = classifyInterval({ ...ok([W("2025-01-01", "2026-09-19")]), rowDates: [], from: "2024-01-01", to: "2024-12-31" });
  assert.equal(r.status, COVERAGE_STATUS.UNAVAILABLE);
  assert.equal(r.provenDays, 0);
});

test("S3. fully uncovered month (coverage known, elsewhere) -> UNAVAILABLE", () => {
  const r = classifyInterval({ ...ok([W("2026-09-03", "2026-09-30")]), rowDates: [], from: "2026-06-01", to: "2026-06-30" });
  assert.equal(r.status, COVERAGE_STATUS.UNAVAILABLE);
});

test("S4. partially covered month (coverage starts mid-month) -> PARTIAL", () => {
  const r = classifyInterval({ ...ok([W("2026-09-15", "2026-09-30")]), rowDates: [], from: "2026-09-01", to: "2026-09-30" });
  assert.equal(r.status, COVERAGE_STATUS.PARTIAL);
  assert.equal(r.coveredFrom, "2026-09-15");
  assert.equal(r.provenDays, 16);
  assert.equal(r.totalDays, 30);
});

test("S5. INTERNAL coverage gap -> PARTIAL; a row proves its own date only and NEVER fills the gap", () => {
  // coverage [1-10] + [20-31]; the internal gap 11-19 is uncovered. A row on the 15th proves ONLY the 15th.
  const r = classifyInterval({ ...ok([W("2026-08-01", "2026-08-10"), W("2026-08-20", "2026-08-31")]), rowDates: ["2026-08-15"], from: "2026-08-01", to: "2026-08-31" });
  assert.equal(r.status, COVERAGE_STATUS.PARTIAL);
  assert.equal(r.provenDays, 10 + 12 + 1, "10 (1-10) + 12 (20-31) + the single row on the 15th"); // = 23
  assert.equal(r.totalDays, 31);
  // the 14th and 16th (adjacent to the proven 15th, still in the gap) are NOT proven by that row.
  const r2 = classifyInterval({ ...ok([]), rowDates: ["2026-08-15"], from: "2026-08-14", to: "2026-08-16" });
  assert.equal(r2.provenDays, 1, "the row proves the 15th ONLY, not the 14th or 16th");
});

test("S6. coverage ENDING before the requested end (coverageTo honoured, not coverageFrom alone) -> PARTIAL", () => {
  const r = classifyInterval({ ...ok([W("2026-09-01", "2026-09-15")]), rowDates: [], from: "2026-09-01", to: "2026-09-19" });
  assert.equal(r.status, COVERAGE_STATUS.PARTIAL);
  assert.equal(r.coveredTo, "2026-09-15", "availability stops at coverageTo, even though coverageFrom == the range start");
});

test("S7. genuine COVERED ZERO (whole range proven by the window, no rows) -> COVERED (renders GBP 0, not em dash)", () => {
  const r = classifyInterval({ ...ok([W("2026-09-01", "2026-09-30")]), rowDates: [], from: "2026-09-01", to: "2026-09-30" });
  assert.equal(r.status, COVERAGE_STATUS.COVERED);
  assert.equal(r.provenDays, 30);
  assert.equal(r.totalDays, 30);
});

test("S8. real rows EARLIER than a lagging coverage boundary -> COVERED (a row is proof of its own date)", () => {
  // coverage starts 2026-09-10 but positive rows exist 2026-09-01..09; every date in [01,19] is proven (rows or window).
  const rowDates = []; for (let d = 1; d <= 19; d++) rowDates.push(`2026-09-${String(d).padStart(2, "0")}`);
  const r = classifyInterval({ ...ok([W("2026-09-10", "2026-09-19")]), rowDates, from: "2026-09-01", to: "2026-09-19" });
  assert.equal(r.status, COVERAGE_STATUS.COVERED, "rows cover 01-09, the window covers 10-19 -> fully proven");
});

test("S9. coverage READ FAILURE -> UNKNOWN (never covered/partial/unavailable when the evidence is unreadable)", () => {
  const rowDates = ["2026-09-03", "2026-09-04"];
  const r = classifyInterval({ coverageWindows: [], coverageRead: "read-failed", rowDates, from: "2026-06-21", to: "2026-09-19" });
  assert.equal(r.status, COVERAGE_STATUS.UNKNOWN);
});

/* ---- boundary/legacy contract ---- */
test("no coverage FEATURE (coverageRead undefined) + not-all-row-proven -> UNKNOWN (caller applies legacy fallback)", () => {
  const r = classifyInterval({ coverageWindows: null, coverageRead: undefined, rowDates: ["2026-09-03"], from: "2026-06-21", to: "2026-09-19" });
  assert.equal(r.status, COVERAGE_STATUS.UNKNOWN);
});

test("every date row-proven -> COVERED even with no coverage windows (rows alone are sufficient proof)", () => {
  const r = classifyInterval({ coverageWindows: null, coverageRead: undefined, rowDates: ["2026-09-01", "2026-09-02"], from: "2026-09-01", to: "2026-09-02" });
  assert.equal(r.status, COVERAGE_STATUS.COVERED);
});

test("a bad/inverted requested interval -> UNKNOWN with zero days (never throws)", () => {
  assert.equal(classifyInterval({ ...ok([]), from: "2026-09-19", to: "2026-09-01" }).status, COVERAGE_STATUS.UNKNOWN);
  assert.equal(classifyInterval({ ...ok([]), from: "bad", to: "2026-09-01" }).status, COVERAGE_STATUS.UNKNOWN);
});

/* ---- positiveRowDates + coverageActive ---- */
test("positiveRowDates counts ONLY positive OLI evidence (a zero / ads-only row is NOT positive proof of its date)", () => {
  const set = positiveRowDates([
    { date: "2026-09-03", total_sales: 100, total_units_sold: 5 },     // positive -> counts
    { date: "2026-08-20", total_sales: 0, total_units_sold: 0, ad_spend: 12 }, // ads-only zero -> NOT counted
    { date: "bad", total_sales: 9 },                                    // malformed date -> skipped
  ]);
  assert.deepEqual([...set], ["2026-09-03"]);
});

test("coverageActive is true ONLY when the payload carries coverageRead (feature active), false otherwise", () => {
  assert.equal(coverageActive({ coverageRead: "ok" }), true);
  assert.equal(coverageActive({ coverageRead: "read-failed" }), true);
  assert.equal(coverageActive({ latestDate: "2026-09-09" }), false, "a legacy payload without coverageRead is inactive");
  assert.equal(coverageActive(null), false);
});

/* ---- dataFloor: coverage windows only prove dates the view actually FETCHED (the fetched-data horizon) ---- */
test("dataFloor: a covered-but-UNFETCHED range (window proves it, but earlier than the fetch floor) -> UNAVAILABLE, not a false 'covered'", () => {
  // Coverage spans 2025-01..2026-09, but the dashboard only fetched rows from 2026-07-01. A requested Feb-2025 range is
  // covered by the window yet the KPI cannot sum it -> must NOT read as 'covered' (that would understate / falsely 'no sales').
  const feb = classifyInterval({ ...ok([W("2025-01-01", "2026-09-19")]), rowDates: [], from: "2025-02-01", to: "2025-02-28", dataFloor: "2026-07-01" });
  assert.equal(feb.status, COVERAGE_STATUS.UNAVAILABLE);
});

test("dataFloor: a range STRADDLING the fetch floor -> PARTIAL, with proof beginning at the floor", () => {
  const straddle = classifyInterval({ ...ok([W("2025-01-01", "2026-09-19")]), rowDates: [], from: "2026-06-20", to: "2026-07-10", dataFloor: "2026-07-01" });
  assert.equal(straddle.status, COVERAGE_STATUS.PARTIAL);
  assert.equal(straddle.coveredFrom, "2026-07-01", "window proof starts at the fetch floor; the pre-floor dates are unavailable");
});

test("dataFloor: a POSITIVE ROW earlier than the floor STILL proves its own date (a fetched row is displayable regardless)", () => {
  const rowBelow = classifyInterval({ ...ok([W("2025-01-01", "2026-09-19")]), rowDates: ["2026-06-25"], from: "2026-06-25", to: "2026-06-25", dataFloor: "2026-07-01" });
  assert.equal(rowBelow.status, COVERAGE_STATUS.COVERED, "a real row is proof of its own date even below the fetch floor");
});

test("dataFloor: absent floor (undefined) -> unchanged (windows prove wherever they cover)", () => {
  const r = classifyInterval({ ...ok([W("2025-01-01", "2026-09-19")]), rowDates: [], from: "2025-02-01", to: "2025-02-28" });
  assert.equal(r.status, COVERAGE_STATUS.COVERED, "no floor -> the window proves the range (byte-identical to before)");
});

out("\n" + passed + " assertions passed");
