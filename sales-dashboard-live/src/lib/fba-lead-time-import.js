// FBA per-ASIN lead-time template + import -- PURE, dependency-light, offline-testable. Mirrors the proven
// campaign-mapping-import / warehouse-import shape: the RFC4180 parser (parseDelimited) feeds the SAME validator the
// XLSX path uses (readXlsxFirstSheet -> string[][]). Child ASINs are treated STRICTLY as text (never coerced). This
// module writes NO data and calls NO API -- it parses, validates and builds the download matrix; the server remains the
// authorization + ASIN-ownership + write authority. BLANK-as-CLEAR is intentional: a blank day/eta cell clears that
// field (writes null = "Not configured"), so a downloaded template can be edited and re-uploaded losslessly.
import { parseDelimited } from "./warehouse-import.js";

// The template columns, in order. The FIRST exported row is exactly this header. product_name/brand are DISPLAY-only
// references for the editor (ignored on import); the identity is child_asin. inbound_eta is an explicit ETA (YYYY-MM-DD).
export const FBA_LEAD_TIME_COLUMNS = Object.freeze([
  "account", "child_asin", "product_name", "brand",
  "production_days", "shipping_days", "awd_transfer_days", "safety_stock_days", "inbound_eta", "note",
]);
const DAY_FIELDS = Object.freeze([
  ["production_days", "production"], ["shipping_days", "shipping"], ["awd_transfer_days", "awd"], ["safety_stock_days", "safety"],
]);

const norm = (v) => String(v == null ? "" : v).replace(/^﻿/, "").trim();
const normKey = (v) => norm(v).toLowerCase();
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v);

// Build the download matrix (array of arrays, header first). EVERY cell is a STRING so the XLSX writer emits inline
// (text) cells. Blank day/eta cells are written as "" so the round-trip is lossless (a blank means Not configured).
export function buildFbaLeadTimeMatrix({ accountId = "", rows = [] } = {}) {
  const out = [[...FBA_LEAD_TIME_COLUMNS]];
  const cell = (v) => (v == null || v === "" ? "" : String(v));
  for (const r of Array.isArray(rows) ? rows : []) {
    out.push([
      String(accountId ?? ""), String(r.asin ?? r.childAsin ?? ""), String(r.productName ?? ""), String(r.brand ?? ""),
      cell(r.production), cell(r.shipping), cell(r.awd), cell(r.safety), cell(r.inboundEta), String(r.note ?? ""),
    ]);
  }
  return out;
}

// Detect the REAL header row: the first of the first few rows that contains child_asin (case-insensitive, BOM-trimmed).
export function detectHeader(matrix) {
  const rows = Array.isArray(matrix) ? matrix : [];
  const limit = Math.min(rows.length, 6);
  for (let i = 0; i < limit; i += 1) {
    const keys = (rows[i] || []).map(normKey);
    if (keys.includes("child_asin")) {
      const map = {};
      keys.forEach((k, idx) => { if (k && !(k in map)) map[k] = idx; });
      return { headerIndex: i, map };
    }
  }
  return { headerIndex: -1, map: null };
}

// Parse a whole-day integer field. "" -> null (blank-as-clear). Returns { value, error } where value is null|int.
function parseDay(raw) {
  const v = norm(raw);
  if (v === "") return { value: null, error: null };
  if (!/^\d+$/.test(v)) return { value: null, error: "must be a whole number of days (0 or more), or blank" };
  const n = Number(v);
  if (n > 3650) return { value: null, error: "day value exceeds 3650" };
  return { value: n, error: null };
}

// Validate ALREADY-PARSED rows (string[][]). Pure, all-or-nothing: any invalid row -> zero apply rows. `applyRows`
// carry { childAsin, production, shipping, awd, safety, inboundEta, note } with blanks as null (clear). Server still
// validates ASIN ownership before writing.
export function validateFbaLeadTimeRows(matrix) {
  const rows = Array.isArray(matrix) ? matrix : [];
  const { headerIndex, map } = detectHeader(rows);
  const preview = { total: 0, apply: 0, ignored: 0, invalid: 0 };
  if (headerIndex < 0) {
    return { ok: false, missingHeader: true, errors: [{ line: 0, reason: "The file must include a header row with a child_asin column." }], applyRows: [], preview, message: "The file must include a child_asin column." };
  }
  const iAsin = map.child_asin;
  const iNote = "note" in map ? map.note : -1;
  const iEta = "inbound_eta" in map ? map.inbound_eta : -1;
  const errors = [];
  const applyRows = [];
  const seen = new Set();
  for (let d = headerIndex + 1; d < rows.length; d += 1) {
    const r = rows[d] || [];
    if (!r.some((c) => norm(c) !== "")) continue; // skip wholly-blank rows
    const line = d + 1;
    preview.total += 1;
    const childAsin = norm(r[iAsin]).toUpperCase();
    if (!childAsin) { errors.push({ line, reason: "blank child_asin" }); preview.invalid += 1; continue; }
    if (seen.has(childAsin)) { errors.push({ line, reason: `child_asin ${childAsin} appears more than once` }); preview.invalid += 1; continue; }
    const parsed = {};
    let bad = null;
    for (const [col, key] of DAY_FIELDS) {
      const res = parseDay(map[col] != null ? r[map[col]] : "");
      if (res.error) { bad = `${col} ${res.error}`; break; }
      parsed[key] = res.value;
    }
    if (bad) { errors.push({ line, reason: bad }); preview.invalid += 1; continue; }
    let inboundEta = null;
    if (iEta >= 0) { const e = norm(r[iEta]); if (e !== "") { if (!isDate(e)) { errors.push({ line, reason: "inbound_eta must be YYYY-MM-DD or blank" }); preview.invalid += 1; continue; } inboundEta = e; } }
    seen.add(childAsin);
    preview.apply += 1;
    applyRows.push({ childAsin, production: parsed.production, shipping: parsed.shipping, awd: parsed.awd, safety: parsed.safety, inboundEta, note: iNote >= 0 ? norm(r[iNote]) : "", line });
  }
  const nothingToApply = errors.length === 0 && applyRows.length === 0;
  const ok = errors.length === 0 && applyRows.length > 0;
  const message = errors.length
    ? `${errors.length} row(s) are invalid; nothing was written. First: line ${errors[0].line} — ${errors[0].reason}.`
    : nothingToApply ? "No ASIN rows to apply." : null;
  return { ok, missingHeader: false, errors, applyRows: ok ? applyRows : [], preview, nothingToApply, message };
}

// Full validate from raw CSV/TSV text using the shared RFC4180 parser -- the SAME validator the XLSX path uses.
export function validateFbaLeadTimeText(text) {
  return validateFbaLeadTimeRows(parseDelimited(text));
}
