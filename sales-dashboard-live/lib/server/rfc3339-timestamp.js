// A strict RFC3339 / Postgres timestamptz validator: STRING only, a REAL calendar date (leap-aware) + a valid time,
// Z or a numeric +-HH:MM timezone offset, optional fractional seconds, and a finite parsed instant. This is the
// dependency-safe (PURE -- no env read, no supabase import, no side effects) equivalent of the proven isValidTimestamp
// in supabase.js, extracted so the durable loader + dependency bundle can share ONE strict validator without a loose
// Date.parse (Node's Date.parse otherwise accepts "2026-02-30T00:00:00Z", "1", and the date-only "2026-09-04").
// Kept byte-for-byte in step with supabase.js:isValidTimestamp. 7-bit ASCII, LF.
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export function isValidRfc3339Timestamp(v) {
  if (typeof v !== "string") return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:[Zz]|([+-])(\d{2}):(\d{2}))$/.exec(v);
  if (!m) return false;
  const year = +m[1], month = +m[2], day = +m[3], hour = +m[4], min = +m[5], sec = +m[6];
  if (month < 1 || month > 12) return false;
  const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const dim = month === 2 && isLeap ? 29 : DAYS_IN_MONTH[month - 1];
  if (day < 1 || day > dim) return false;                   // real calendar date (rejects 2026-02-30)
  if (hour > 23 || min > 59 || sec > 59) return false;      // valid time components
  if (m[7]) { if (+m[8] > 23 || +m[9] > 59) return false; } // valid +HH:MM / -HH:MM offset
  return Number.isFinite(Date.parse(v));                    // finite parsed instant
}
