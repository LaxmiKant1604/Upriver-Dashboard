// FBA per-ASIN lead-time template + import -- PURE, dependency-light, offline-testable. Mirrors the proven
// campaign-mapping-import / warehouse-import shape: the RFC4180 parser (parseDelimited) feeds the SAME validator the
// XLSX path uses (readXlsxFirstSheet -> string[][]). Child ASINs are treated STRICTLY as text (never coerced). This
// module writes NO data and calls NO API -- it parses, validates and builds the download/preview matrix; the server
// remains the authorization + ASIN-ownership + write authority.
//
// SAFE IMPORT SEMANTICS (audit 2026-09-08):
//   * HEADER ALIASES: a conservative, documented set -- "Child ASIN" / "child_asin" / "ASIN" all resolve to the child
//     ASIN; the day/eta/note columns accept their human labels too. Two columns that resolve to the SAME field, or a
//     file whose only ASIN column is a PARENT ASIN, are REJECTED (ambiguous / wrong identity) with a clear message.
//   * OMITTED-COLUMN SAFETY: a re-uploaded template must carry EVERY writable column (the four day fields + inbound_eta
//     + note). A missing writable column is REJECTED, never silently treated as "blank" (which would clear that field
//     for every ASIN -- the data-loss bug this audit fixes). A PRESENT-but-blank cell still explicitly clears (the
//     documented, lossless round-trip). Rejecting an incomplete template is deliberate (patch/preserve semantics would
//     need per-field DB support); the template download always provides the full column set.
//   * ACCOUNT BINDING: when an `account` column is present it must match the account being configured; a mismatched or
//     mixed-account template is REJECTED before anything is applied (the server also binds the write to its account +
//     validates ASIN ownership, so this is an early, friendly guard -- never the only boundary).
//   * NOTES are parsed and carried through to the apply rows (the API + RPC persist them).
//   * DATES are validated as REAL calendar dates (2026-02-30 is rejected), consistently with the server.
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
// The WRITABLE columns a re-uploaded template MUST contain (their omission would silently clear that field).
const REQUIRED_WRITABLE = Object.freeze(["production_days", "shipping_days", "awd_transfer_days", "safety_stock_days", "inbound_eta", "note"]);

// Canonical field -> accepted header aliases (each alias ALREADY in normalized form: lowercased, BOM-stripped, with
// underscores/hyphens collapsed to single spaces). Conservative + documented; no fuzzy matching.
const FIELD_ALIASES = Object.freeze({
  account: ["account", "account id", "accountid"],
  child_asin: ["child asin", "childasin", "asin"],
  product_name: ["product name", "productname", "title"],
  brand: ["brand"],
  production_days: ["production days", "production", "prod days"],
  shipping_days: ["shipping days", "shipping", "ship days"],
  awd_transfer_days: ["awd transfer days", "awd transfer", "awd days", "awd"],
  safety_stock_days: ["safety stock days", "safety stock", "safety days", "safety"],
  inbound_eta: ["inbound eta", "eta"],
  note: ["note", "notes"],
});
const PARENT_ASIN_ALIASES = Object.freeze(["parent asin", "parentasin"]);
// The reverse map alias -> canonical field (built once; no alias may belong to two fields).
const ALIAS_TO_FIELD = (() => {
  const m = new Map();
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) for (const a of aliases) m.set(a, field);
  return m;
})();

const norm = (v) => String(v == null ? "" : v).replace(/^﻿/, "").trim();
// Header normalization: BOM-strip, trim, lowercase, collapse [_-] and whitespace runs to single spaces.
const normHeader = (v) => norm(v).toLowerCase().replace(/[_\-]+/g, " ").replace(/\s+/g, " ").trim();

// A REAL calendar date (YYYY-MM-DD AND an actual day, so 2026-02-30 / 2026-13-01 are rejected). Kept in lockstep with
// the server's inbound-eta / started-date checks.
export function isRealCalendarDate(v) {
  const s = norm(v);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

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

// Analyze a candidate header row: return { fieldToIndices: Map(field -> [idx...]), hasParentAsin, raw }. Multiple
// indices for one field means an ambiguous duplicate column.
function analyzeHeaderRow(cells) {
  const fieldToIndices = new Map();
  let hasParentAsin = false;
  (cells || []).forEach((c, idx) => {
    const key = normHeader(c);
    if (!key) return;
    if (PARENT_ASIN_ALIASES.includes(key)) { hasParentAsin = true; return; }
    const field = ALIAS_TO_FIELD.get(key);
    if (!field) return;
    if (!fieldToIndices.has(field)) fieldToIndices.set(field, []);
    fieldToIndices.get(field).push(idx);
  });
  return { fieldToIndices, hasParentAsin, raw: cells || [] };
}

// Detect the REAL header row: the first of the first few rows whose columns resolve to a child_asin field. Also reports
// whether a parent-ASIN-only header was seen (for a helpful message) and the raw header cells found (for correction).
export function detectHeader(matrix) {
  const rows = Array.isArray(matrix) ? matrix : [];
  const limit = Math.min(rows.length, 8);
  let parentOnly = null;
  for (let i = 0; i < limit; i += 1) {
    const info = analyzeHeaderRow(rows[i]);
    if (info.fieldToIndices.has("child_asin")) return { headerIndex: i, info };
    if (info.hasParentAsin && !parentOnly) parentOnly = { headerIndex: i, info };
  }
  return { headerIndex: -1, info: null, parentOnly };
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

const foundHeaderList = (raw) => (raw || []).map((c) => norm(c)).filter(Boolean).join(", ") || "(no header cells)";

// Compute the per-row diff against the account's CURRENT lead-time values (for the confirm-before-apply preview).
// current: { production, shipping, awd, safety, inboundEta, note } | undefined. Returns { changes:[{field,from,to}],
// clears:[field] } -- `clears` is the subset of changes where a present-blank cell will null out an existing value.
function diffRow(applyRow, current) {
  const cur = current || {};
  const fields = [
    ["production", applyRow.production, cur.production],
    ["shipping", applyRow.shipping, cur.shipping],
    ["awd", applyRow.awd, cur.awd],
    ["safety", applyRow.safety, cur.safety],
    ["inboundEta", applyRow.inboundEta, cur.inboundEta || null],
    ["note", applyRow.note || "", cur.note || ""],
  ];
  const changes = [];
  const clears = [];
  for (const [field, to, fromRaw] of fields) {
    const from = fromRaw == null ? null : fromRaw;
    const a = to == null ? null : to;
    const b = from == null ? null : from;
    if (String(a ?? "") === String(b ?? "")) continue;
    changes.push({ field, from: b, to: a });
    if ((a == null || a === "") && b != null && b !== "") clears.push(field);
  }
  return { changes, clears };
}

// Validate ALREADY-PARSED rows (string[][]). Pure, all-or-nothing: any invalid row -> zero apply rows. Options:
//   expectedAccountId : when set AND the file has an `account` column, every row's account must match it (a mismatched
//                       or mixed-account template is rejected). When the file has no account column, the server still
//                       binds the write to its account + validates ASIN ownership.
//   currentByAsin     : Map|object (uppercased child ASIN -> current lead-time record) to compute the preview diff.
// `applyRows` carry { childAsin, production, shipping, awd, safety, inboundEta, note, line, diff } with blanks as null
// (clear). Server still validates ASIN ownership before writing.
export function validateFbaLeadTimeRows(matrix, { expectedAccountId = null, currentByAsin = null } = {}) {
  const rows = Array.isArray(matrix) ? matrix : [];
  const preview = { total: 0, apply: 0, ignored: 0, invalid: 0, changed: 0, cleared: 0 };
  const fail = (message, extra = {}) => ({ ok: false, missingHeader: false, errors: [{ line: 0, reason: message }], applyRows: [], preview, message, ...extra });

  const { headerIndex, info, parentOnly } = detectHeader(rows);
  if (headerIndex < 0) {
    if (parentOnly) {
      const msg = `This file has a Parent ASIN column but no Child ASIN column. The identity is the CHILD ASIN. Found headers: ${foundHeaderList(parentOnly.info.raw)}. Download the template for the exact columns.`;
      return fail(msg, { missingHeader: true, parentAsinOnly: true });
    }
    const firstRow = rows.find((r) => (r || []).some((c) => norm(c) !== ""));
    const msg = `The file must include a header row with a Child ASIN column (accepted: "Child ASIN", "child_asin" or "ASIN"). Found headers: ${foundHeaderList(firstRow)}. Download the template for the exact columns.`;
    return fail(msg, { missingHeader: true });
  }

  const fieldToIndices = info.fieldToIndices;
  // Ambiguous duplicate columns: any field mapped by more than one column (e.g. both "ASIN" and "Child ASIN").
  const ambiguous = [...fieldToIndices.entries()].filter(([, idxs]) => idxs.length > 1).map(([field]) => field);
  if (ambiguous.length) {
    return fail(`Ambiguous columns: more than one column maps to ${ambiguous.join(", ")} (for example both "ASIN" and "Child ASIN"). Keep exactly one column per field. Found headers: ${foundHeaderList(info.raw)}.`, { ambiguous });
  }
  // Missing WRITABLE columns -> reject (never silently clear an omitted field).
  const missingRequired = REQUIRED_WRITABLE.filter((f) => !fieldToIndices.has(f));
  if (missingRequired.length) {
    return fail(`The file is missing required column(s): ${missingRequired.join(", ")}. Download the template for the full column set. (A blank cell clears a value; an omitted column is not allowed so a partial file can never accidentally clear data.)`, { missingRequired });
  }

  const idx = (f) => (fieldToIndices.has(f) ? fieldToIndices.get(f)[0] : -1);
  const iAsin = idx("child_asin");
  const iNote = idx("note");
  const iEta = idx("inbound_eta");
  const iAccount = idx("account");
  const curMap = currentByAsin instanceof Map ? currentByAsin : (currentByAsin && typeof currentByAsin === "object" ? new Map(Object.entries(currentByAsin)) : null);

  const errors = [];
  const applyRows = [];
  const seen = new Set();
  const accountsInFile = new Set();

  for (let d = headerIndex + 1; d < rows.length; d += 1) {
    const r = rows[d] || [];
    if (!r.some((c) => norm(c) !== "")) continue; // skip wholly-blank rows
    const line = d + 1;
    preview.total += 1;

    if (iAccount >= 0) { const a = norm(r[iAccount]); if (a) accountsInFile.add(a); }

    const childAsin = norm(r[iAsin]).toUpperCase();
    if (!childAsin) { errors.push({ line, reason: "blank child_asin" }); preview.invalid += 1; continue; }
    if (seen.has(childAsin)) { errors.push({ line, reason: `child_asin ${childAsin} appears more than once` }); preview.invalid += 1; continue; }

    const parsed = {};
    let bad = null;
    for (const [col, key] of DAY_FIELDS) {
      const res = parseDay(r[idx(col)]);
      if (res.error) { bad = `${col} ${res.error}`; break; }
      parsed[key] = res.value;
    }
    if (bad) { errors.push({ line, reason: bad }); preview.invalid += 1; continue; }

    let inboundEta = null;
    if (iEta >= 0) { const e = norm(r[iEta]); if (e !== "") { if (!isRealCalendarDate(e)) { errors.push({ line, reason: "inbound_eta must be a real date (YYYY-MM-DD) or blank" }); preview.invalid += 1; continue; } inboundEta = e; } }

    seen.add(childAsin);
    const applyRow = { childAsin, production: parsed.production, shipping: parsed.shipping, awd: parsed.awd, safety: parsed.safety, inboundEta, note: iNote >= 0 ? norm(r[iNote]) : "", line };
    if (curMap) {
      const diff = diffRow(applyRow, curMap.get(childAsin));
      applyRow.diff = diff;
      if (diff.changes.length) preview.changed += 1;
      if (diff.clears.length) preview.cleared += 1;
    }
    applyRows.push(applyRow);
    preview.apply += 1;
  }

  // Account binding: a present account column must match the account being configured; mixed accounts are rejected too.
  if (iAccount >= 0 && accountsInFile.size > 0) {
    const expected = norm(expectedAccountId);
    if (accountsInFile.size > 1) {
      return fail(`This file mixes multiple accounts (${[...accountsInFile].slice(0, 3).join(", ")}${accountsInFile.size > 3 ? ", ..." : ""}). Import one account at a time.`, { accountMismatch: true, accountsInFile: [...accountsInFile] });
    }
    const only = [...accountsInFile][0];
    if (expected && only !== expected) {
      return fail(`This template is for account "${only}" but you are configuring account "${expected}". Download the template for THIS account before importing.`, { accountMismatch: true, accountsInFile: [only] });
    }
  }

  const nothingToApply = errors.length === 0 && applyRows.length === 0;
  const ok = errors.length === 0 && applyRows.length > 0;
  const message = errors.length
    ? `${errors.length} row(s) are invalid; nothing was written. First: line ${errors[0].line} — ${errors[0].reason}.`
    : nothingToApply ? "No ASIN rows to apply." : null;
  return { ok, missingHeader: false, errors, applyRows: ok ? applyRows : [], preview, nothingToApply, message };
}

// Full validate from raw CSV/TSV text using the shared RFC4180 parser -- the SAME validator the XLSX path uses.
export function validateFbaLeadTimeText(text, opts) {
  return validateFbaLeadTimeRows(parseDelimited(text), opts);
}
