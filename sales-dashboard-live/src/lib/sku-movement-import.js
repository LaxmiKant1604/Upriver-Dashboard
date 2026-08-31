// SKU MOVEMENT identifier BULK import/export -- pure, dependency-light parse + preview-validate + template builder.
// The IMMUTABLE match key is ASIN; SKU/Account/Marketplace/Product/Brand are informational and can NEVER remap an
// ASIN. Validation is a PREVIEW (the server re-validates every row against the account's real evidence): it flags
// missing/blank ASIN, an absent Identifier column (which must NOT silently clear existing values), over-long /
// control-character identifiers, and a duplicate ASIN carrying conflicting identifiers. A blank identifier VALUE is
// an explicit CLEAR for that ASIN. The .xlsx binary reader feeds the same string[][] validator as CSV. 7-bit ASCII.

import { parseDelimited } from "./warehouse-import.js";
import { csvCell } from "./csv.js";

export const MAX_IDENTIFIER_LEN = 120;

// Template columns (order matters for the download). ASIN + Identifier are the only ones the importer reads.
export const IDENTIFIER_COLUMNS = [
  { key: "account", label: "Account", aliases: ["account", "account id", "account name", "seller"] },
  { key: "marketplace", label: "Marketplace", aliases: ["marketplace", "market", "country", "marketplace_country_code"] },
  { key: "asin", label: "ASIN", aliases: ["asin", "child asin", "child-asin", "child_asin"], matchKey: true },
  { key: "sku", label: "SKU", aliases: ["sku", "seller sku", "representative sku"] },
  { key: "product", label: "Product", aliases: ["product", "product name", "title"] },
  { key: "brand", label: "Brand", aliases: ["brand", "product brand"] },
  { key: "identifier", label: "Identifier", aliases: ["identifier", "id", "custom id", "tag", "label"] },
];

const norm = (s) => String(s == null ? "" : s).trim().toLowerCase();
function columnKeyFor(headerCell) {
  const n = norm(headerCell);
  for (const col of IDENTIFIER_COLUMNS) if (col.aliases.includes(n) || norm(col.label) === n) return col.key;
  return null;
}
function mapHeader(headerRow) {
  const map = {};
  (headerRow || []).forEach((cell, idx) => { const key = columnKeyFor(cell); if (key && !(key in map)) map[key] = idx; });
  return map;
}
function hasControlChar(s) { for (let i = 0; i < s.length; i += 1) { const c = s.charCodeAt(i); if (c < 32 || c === 127) return true; } return false; }

// Validate ALREADY-PARSED rows (string[][], header first). Returns { valid: [{asin, identifier, line}], errors, missingAsinColumn, missingIdentifierColumn, totalDataRows }.
export function validateIdentifierRows(parsed) {
  if (!Array.isArray(parsed) || parsed.length === 0) return { valid: [], errors: [], missingAsinColumn: true, missingIdentifierColumn: true, totalDataRows: 0, empty: true };
  const map = mapHeader(parsed[0]);
  const missingAsinColumn = map.asin == null;
  const missingIdentifierColumn = map.identifier == null;
  if (missingAsinColumn || missingIdentifierColumn) {
    // An absent Identifier column must NOT be treated as "clear everything" -- it is a hard error (nothing applied).
    return { valid: [], errors: [], missingAsinColumn, missingIdentifierColumn, totalDataRows: 0 };
  }
  const at = (row, key) => (map[key] == null ? "" : String(row[map[key]] == null ? "" : row[map[key]]).trim());
  const valid = []; const errors = [];
  const seen = new Map(); // ASIN -> { identifier, line }
  const dataRows = parsed.slice(1);
  dataRows.forEach((row, i) => {
    const line = i + 2;
    const asin = at(row, "asin").toUpperCase();
    const identifier = at(row, "identifier");
    const problems = [];
    if (!asin) problems.push("missing ASIN");
    if (identifier.length > MAX_IDENTIFIER_LEN) problems.push(`identifier over ${MAX_IDENTIFIER_LEN} chars`);
    if (hasControlChar(identifier)) problems.push("identifier has control characters");
    if (asin) {
      if (seen.has(asin)) { if (seen.get(asin).identifier !== identifier) problems.push(`conflicts with line ${seen.get(asin).line} (same ASIN, different identifier)`); }
      else seen.set(asin, { identifier, line });
    }
    const rec = { line, asin, identifier };
    if (problems.length) errors.push({ ...rec, problems }); else valid.push(rec);
  });
  return { valid, errors, missingAsinColumn: false, missingIdentifierColumn: false, totalDataRows: dataRows.length };
}

// Full parse + validate from raw CSV/TSV text (or a pasted grid).
export function validateIdentifierImport(text) {
  return validateIdentifierRows(parseDelimited(text));
}

// The downloadable template/export for the CURRENT filtered scope: every visible ASIN row with its context + its
// current identifier. Formula-injection-safe (csvCell prefixes a leading = + - @ with a quote). ASIN is the key.
export function buildIdentifierTemplateCsv({ accountName = "", rows = [] } = {}) {
  const header = IDENTIFIER_COLUMNS.map((c) => c.label);
  const lines = [header.map(csvCell).join(",")];
  for (const r of Array.isArray(rows) ? rows : []) {
    lines.push([
      csvCell(accountName), csvCell(r.marketplace || r.currency || ""), csvCell(r.asin || ""),
      csvCell(r.sku || ""), csvCell(r.productName || ""), csvCell(r.brand || ""), csvCell(r.identifier || ""),
    ].join(","));
  }
  return "﻿" + lines.join("\r\n") + "\r\n";
}
