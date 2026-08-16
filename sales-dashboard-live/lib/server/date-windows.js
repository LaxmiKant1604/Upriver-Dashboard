// Pure UTC string-based calendar-date/window helpers -- a DEPENDENCY-FREE leaf (imports nothing).
//
// These were previously defined in lib/server/datadoe.js, which imports supabase.js (a
// transport/storage module). That made every module importing a date helper transitively depend
// on transport/storage -- including report-source-contracts.js, and therefore the "pure" report
// derivation graph. Extracting the helpers here (behavior-preserving, byte-for-byte identical)
// lets the derivation boundary (report-worker/report-derivation/derivation-core/
// report-source-contracts) reach these helpers WITHOUT reaching datadoe.js or supabase.js.
//
// lib/server/datadoe.js now imports these from here and RE-EXPORTS them, so every existing
// `import { addDaysStr, splitDateRangeByMonth, isFullCalendarMonthWindow, ... } from "../datadoe.js"`
// caller keeps working unchanged and no date algorithm is duplicated. request_hash values are
// unaffected (the window math is identical).

export const pad2s = (n) => String(n).padStart(2, "0");

export function daysInMonthUTC(y, m /* 1..12 */) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function addDaysStr(s, n) {
  const [y, m, d] = s.split("-").map(Number);
  const t = Date.UTC(y, m - 1, d) + n * 86400000;
  const dt = new Date(t);
  return `${dt.getUTCFullYear()}-${pad2s(dt.getUTCMonth() + 1)}-${pad2s(dt.getUTCDate())}`;
}

export function splitDateRangeByMonth(from, to) {
  const windows = [];
  let cursor = from;
  while (cursor <= to) {
    const [y, m] = cursor.split("-").map(Number);
    const monthEnd = `${y}-${pad2s(m)}-${pad2s(daysInMonthUTC(y, m))}`;
    const end = monthEnd < to ? monthEnd : to;
    windows.push({ from: cursor, to: end });
    cursor = addDaysStr(end, 1);
  }
  return windows;
}

// Split [from, to] into consecutive <=`days`-long windows (the final one capped at `to`). Byte-identical
// to the lib/server/datadoe.js copy the live builder uses, kept here TRANSPORT-FREE so the Scheduler v2
// planner and the pure derivation share ONE slicing implementation -- the planner stages exactly the
// windows the derivation later validates (e.g. Buy Box's 28-day range as four ordered 7-day slices).
export function splitDateRangeByDays(from, to, days) {
  const windows = [];
  let cursor = from;
  while (cursor <= to) {
    const end = addDaysStr(cursor, days - 1);
    windows.push({ from: cursor, to: end < to ? end : to });
    cursor = addDaysStr(end, 1);
  }
  return windows;
}

// Calendar-anchored intra-month slicer for the ONE canonical Order Line Items sales fragment shared by
// daily-reporting, fba-plan, buy-box-loss, returns-leakage and ppc-performance. For each calendar month
// overlapping [from, to] (splitDateRangeByMonth), emit the FIXED calendar bins [1-7],[8-14],[15-21],
// [22-28],[29-monthEnd], each CLAMPED to [max(from, binStart), min(to, binEnd)] and SKIPPED when empty.
// Pure/UTC. The bins are anchored to the CALENDAR (day 1,8,15,22,29), NOT to `from`, so two reports with
// DIFFERENT window starts but the SAME `to` (asOf) produce byte-identical interior + asOf-boundary slices:
// identical (from, to) => identical request_hash => ONE DataDoe export reused by MULTIPLE report owners.
// For a FULL calendar month this yields exactly [1-7,8-14,15-21,22-28,29-end] (the former daily scheme);
// for a partial first month it stays calendar-anchored (e.g. from day 10 clamps the [8-14] bin to [10-14]).
export function canonicalOliSlices(from, to) {
  const slices = [];
  for (const month of splitDateRangeByMonth(from, to)) {
    const [y, m] = month.from.slice(0, 7).split("-").map(Number);
    const monthEnd = daysInMonthUTC(y, m);
    const bins = [[1, 7], [8, 14], [15, 21], [22, 28], [29, monthEnd]];
    for (const [binStartDay, binEndDay] of bins) {
      if (binStartDay > monthEnd) continue; // e.g. a 28-day February has no [29-..] bin
      const binStart = `${y}-${pad2s(m)}-${pad2s(binStartDay)}`;
      const binEnd = `${y}-${pad2s(m)}-${pad2s(binEndDay)}`;
      const sliceFrom = binStart < from ? from : binStart;
      const sliceTo = binEnd > to ? to : binEnd;
      if (sliceFrom > sliceTo) continue; // empty after clamping to [from, to]
      slices.push({ from: sliceFrom, to: sliceTo });
    }
  }
  return slices;
}

export function isFullCalendarMonthWindow(window) {
  const [year, month] = window.from.slice(0, 7).split("-").map(Number);
  return window.from === `${year}-${pad2s(month)}-01`
    && window.to === `${year}-${pad2s(month)}-${pad2s(daysInMonthUTC(year, month))}`;
}

// First day of the month a date falls in ("2026-08-10" -> "2026-08-01").
export function monthStartStr(dateStr) {
  return `${String(dateStr).slice(0, 7)}-01`;
}

// First day of the calendar month `months` before the month containing `dateStr` (UTC, string).
// Byte-identical to the live UI's monthBack(s, n).from (src/lib/format.js): monthBackStr(s,0) is
// this month's first day. Handles any month length and year boundaries.
// monthBackStr("2026-08-10", 5) === "2026-03-01"; monthBackStr("2026-02-10", 5) === "2025-09-01".
export function monthBackStr(dateStr, months) {
  const [y, m] = String(dateStr).slice(0, 7).split("-").map(Number);
  let ty = y, tm = m - months;
  while (tm <= 0) { tm += 12; ty -= 1; }
  while (tm > 12) { tm -= 12; ty += 1; }
  return `${ty}-${pad2s(tm)}-01`;
}

// Local strict UTC calendar-date check (kept private so this leaf exports no helper that could
// drift from report-source-contracts.isValidCalendarDate). An impossible/malformed date is rejected.
function isRealDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const dt = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(dt.getTime()) && dt.toISOString().slice(0, 10) === value;
}

/**
 * The six most recent COMPLETE calendar months as of `asOf` (a real YYYY-MM-DD), for the SKU P&L
 * scheduler window. "Complete" means the month's final day is on or before `asOf` (an in-progress
 * current month is excluded). Returns { from, to, months: [{from,to}] } where months are six
 * consecutive full calendar months, `from` = first day of month one, `to` = last day of month six.
 * Returns null for a malformed `asOf`. Pure/UTC; no I/O. The result satisfies
 * validateSkuPlMonthlyWindows by construction.
 */
// The 3 completed calendar months before the month containing `toStr`, plus the current (MTD)
// month window ending at `toStr`. Byte-identical to the api/datadoe.js `fba-plan` route helper of
// the same name (kept here as the shared dependency-free copy the Scheduler v2 FBA planner +
// derivation use; proven equal to the route copy by the FBA parity harness). Returns
// { completed: [{key,from,to}] x3, current: {key,from,to,daysInMonth} }.
export function planMonthWindows(toStr) {
  const [ty, tm] = toStr.split("-").map(Number);
  const completed = [];
  for (let i = 3; i >= 1; i--) {
    const total = ty * 12 + (tm - 1) - i;
    const y = Math.floor(total / 12), m = (((total % 12) + 12) % 12) + 1;
    completed.push({
      key: `${y}-${pad2s(m)}`,
      from: `${y}-${pad2s(m)}-01`,
      to: `${y}-${pad2s(m)}-${pad2s(daysInMonthUTC(y, m))}`,
    });
  }
  const current = {
    key: `${ty}-${pad2s(tm)}`,
    from: `${ty}-${pad2s(tm)}-01`,
    to: toStr,
    daysInMonth: daysInMonthUTC(ty, tm),
  };
  return { completed, current };
}

export function sixCompleteCalendarMonths(asOf) {
  if (!isRealDate(asOf)) return null;
  const [year, month] = asOf.slice(0, 7).split("-").map(Number);
  const monthEnd = `${year}-${pad2s(month)}-${pad2s(daysInMonthUTC(year, month))}`;
  // Last complete month = asOf's month when its end has passed, else the previous month.
  let ly = year, lm = month;
  if (monthEnd > asOf) { lm -= 1; if (lm === 0) { lm = 12; ly -= 1; } }
  // Walk back five months for the start, then emit six consecutive full months.
  let cy = ly, cm = lm - 5;
  while (cm <= 0) { cm += 12; cy -= 1; }
  const months = [];
  for (let i = 0; i < 6; i += 1) {
    months.push({ from: `${cy}-${pad2s(cm)}-01`, to: `${cy}-${pad2s(cm)}-${pad2s(daysInMonthUTC(cy, cm))}` });
    cm += 1; if (cm === 13) { cm = 1; cy += 1; }
  }
  return { from: months[0].from, to: months[5].to, months };
}
