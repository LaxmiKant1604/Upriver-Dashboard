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

export function isFullCalendarMonthWindow(window) {
  const [year, month] = window.from.slice(0, 7).split("-").map(Number);
  return window.from === `${year}-${pad2s(month)}-01`
    && window.to === `${year}-${pad2s(month)}-${pad2s(daysInMonthUTC(year, month))}`;
}
