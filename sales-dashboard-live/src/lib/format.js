// Shared display helpers.
//
// These were lifted out of App.jsx unchanged so the report views can format
// money, dates and units exactly the way the existing dashboard does. Currency
// is always passed in explicitly: nothing here ever converts between
// currencies, because no report is allowed to combine them.

import { marketplaceProfile } from "../../lib/marketplaces.js";

/* ============================== CONSTANTS ============================== */
// Approximate FX rates for combining accounts that use different currencies.
// These are static and will drift over time — update periodically, or
// replace with a live FX API call for better accuracy.
export const FX = { INR: 1, USD: 94.6, AUD: 65.2, CAD: 66.6, GBP: 118, EUR: 101 };
export const FX_AS_OF = "2026-07-01";

export const FLAGS = { IN: "🇮🇳", US: "🇺🇸", AU: "🇦🇺", CA: "🇨🇦", UK: "🇬🇧", GB: "🇬🇧", DE: "🇩🇪", FR: "🇫🇷", JP: "🇯🇵", MX: "🇲🇽" };
export const SYMBOL = { INR: "₹", USD: "$", AUD: "A$", CAD: "C$", GBP: "£", EUR: "€" };
export const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

Object.assign(FLAGS, {
  IT: "\u{1F1EE}\u{1F1F9}", ES: "\u{1F1EA}\u{1F1F8}", NL: "\u{1F1F3}\u{1F1F1}", BE: "\u{1F1E7}\u{1F1EA}",
  IE: "\u{1F1EE}\u{1F1EA}", PL: "\u{1F1F5}\u{1F1F1}", SE: "\u{1F1F8}\u{1F1EA}", TR: "\u{1F1F9}\u{1F1F7}",
  AE: "\u{1F1E6}\u{1F1EA}", SA: "\u{1F1F8}\u{1F1E6}", BR: "\u{1F1E7}\u{1F1F7}", SG: "\u{1F1F8}\u{1F1EC}", EG: "\u{1F1EA}\u{1F1EC}",
});
Object.assign(SYMBOL, {
  PLN: "z\u0142", SEK: "kr", TRY: "\u20BA", AED: "AED ", SAR: "SAR ", JPY: "\u00A5",
  MXN: "MX$", BRL: "R$", SGD: "S$", EGP: "EGP ",
});

/* ============================== DATE HELPERS ============================== */
export function pad2(n) { return String(n).padStart(2, "0"); }
export function todayStr() { const d = new Date(); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
export function parts(s) { const [y, m, d] = s.split("-").map(Number); return { y, m, d }; }
export function toUTC(s) { const p = parts(s); return Date.UTC(p.y, p.m - 1, p.d); }
export function fromUTC(t) { const d = new Date(t); return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`; }
export function addDays(s, n) { return fromUTC(toUTC(s) + n * 86400000); }
export function daysInMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
export function monthStart(s) { const p = parts(s); return `${p.y}-${pad2(p.m)}-01`; }
export function yearStart(s) { const p = parts(s); return `${p.y}-01-01`; }
export function weekStart(s) { const t = toUTC(s); const dow = new Date(t).getUTCDay(); const diff = dow === 0 ? 6 : dow - 1; return fromUTC(t - diff * 86400000); }
export function fmtDateHuman(s) { if (!s) return "—"; const p = parts(s); return `${MONTH_ABBR[p.m - 1]} ${p.d}, ${p.y}`; }
export function fmtRangeLabel(from, to) { return from === to ? fmtDateHuman(from) : `${fmtDateHuman(from)} – ${fmtDateHuman(to)}`; }

export function shiftMonthRange(s, deltaYears, deltaMonths) {
  const p = parts(s);
  const total = p.y * 12 + (p.m - 1) + deltaMonths + deltaYears * 12;
  const y = Math.floor(total / 12), m = (((total % 12) + 12) % 12) + 1;
  const day = Math.min(p.d, daysInMonth(y, m));
  return { start: `${y}-${pad2(m)}-01`, end: `${y}-${pad2(m)}-${pad2(day)}` };
}

// Full calendar month `n` months before the month containing `s` (n=0 -> that month).
export function monthBack(s, n) {
  const p = parts(s);
  const total = p.y * 12 + (p.m - 1) - n;
  const y = Math.floor(total / 12), m = (((total % 12) + 12) % 12) + 1;
  return { y, m, from: `${y}-${pad2(m)}-01`, to: `${y}-${pad2(m)}-${pad2(daysInMonth(y, m))}` };
}

// "2026-04" -> "Apr '26"
export function monthKeyLabel(key) {
  if (!key) return "";
  const [y, m] = key.split("-").map(Number);
  return `${MONTH_ABBR[m - 1]} '${String(y).slice(2)}`;
}

// "2026-04" -> "Apr 2026"
export function monthLongLabel(key) {
  if (!key) return "";
  const [y, m] = key.split("-").map(Number);
  return `${MONTH_ABBR[m - 1]} ${y}`;
}

/* ============================== NUMBER / MONEY HELPERS ============================== */
export function pct(curr, prev) {
  if (prev === 0) return curr === 0 ? 0 : null;
  return ((curr - prev) / prev) * 100;
}

export function fmtPct(v) {
  if (v === null || v === undefined || !isFinite(v)) return "—";
  const s = v >= 0 ? "+" : "";
  return `${s}${v.toFixed(1)}%`;
}

// A plain (unsigned) percentage, for shares and rates rather than changes.
export function fmtRate(v, decimals = 1) {
  if (v === null || v === undefined || !isFinite(v)) return "—";
  return `${Number(v).toFixed(decimals)}%`;
}

// Percentage-point delta, for comparing two rates.
export function fmtPoints(v, decimals = 1) {
  if (v === null || v === undefined || !isFinite(v)) return "—";
  return `${v >= 0 ? "+" : ""}${Number(v).toFixed(decimals)}pp`;
}

export function fmtMoney(value, currency, decimals, country) {
  if (value === null || value === undefined || !isFinite(value)) return "—";
  const d = decimals === undefined ? 0 : decimals;
  const profile = marketplaceProfile(country, currency);
  const symbol = SYMBOL[profile.currency] || (profile.currency ? profile.currency + " " : "");
  const n = Number(value || 0);
  return symbol + n.toLocaleString(profile.locale, { minimumFractionDigits: d, maximumFractionDigits: d });
}

export function compactNumber(v, currency) {
  const sign = v < 0 ? "-" : "";
  v = Math.abs(v);
  if (currency === "INR") {
    if (v >= 1e7) return sign + (v / 1e7).toFixed(1) + "Cr";
    if (v >= 1e5) return sign + (v / 1e5).toFixed(1) + "L";
    if (v >= 1e3) return sign + (v / 1e3).toFixed(1) + "k";
    return sign + v.toFixed(0);
  }
  if (v >= 1e6) return sign + (v / 1e6).toFixed(1) + "M";
  if (v >= 1e3) return sign + (v / 1e3).toFixed(1) + "k";
  return sign + v.toFixed(0);
}

export function fmtMoneyCompact(value, currency) {
  if (value === null || value === undefined || !isFinite(value)) return "—";
  const symbol = SYMBOL[currency] || (currency ? currency + " " : "");
  return symbol + compactNumber(value, currency);
}

// Integer formatter; unknown values render as an em dash rather than 0.
export const nInt = (v) => (v === null || v === undefined || !isFinite(v) ? "—" : Math.round(Number(v)).toLocaleString("en-US"));

// One-decimal formatter for rates that are counts, e.g. days of cover.
export const nDec = (v, d = 1) => (v === null || v === undefined || !isFinite(v) ? "—" : Number(v).toFixed(d));

/** Safe ratio: returns null instead of Infinity/NaN so callers show "—". */
export function ratio(numerator, denominator) {
  const n = Number(numerator), d = Number(denominator);
  if (!isFinite(n) || !isFinite(d) || d === 0) return null;
  return n / d;
}
