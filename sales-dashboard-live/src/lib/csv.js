// Excel-compatible CSV export shared by every report.
//
// Two rules matter here and both are security/correctness rules, not cosmetics:
//  1. A leading = + - @ is escaped so a product title or a search term can
//     never be evaluated as a spreadsheet formula.
//  2. The file starts with a UTF-8 BOM so Excel opens ₹ and non-ASCII product
//     names correctly instead of mangling them.

export function csvCell(value) {
  let text = value === null || value === undefined ? "" : String(value);
  // Prevent spreadsheet programs from evaluating a product value as a formula.
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function csvText(exportRows) {
  if (!exportRows.length) return "";
  const headers = Object.keys(exportRows[0]);
  return "﻿" + [headers, ...exportRows.map((row) => headers.map((header) => row[header]))]
    .map((line) => line.map(csvCell).join(","))
    .join("\r\n");
}

/**
 * Serialize a MATRIX (array of arrays -- rows of cells, the FIRST row being the header exactly once) to an
 * Excel-compatible CSV. Same BOM + formula-injection protection as csvText, but the caller controls the exact header
 * row, so no object-key inference can ever emit a 0,1,2... numeric-index header. Use this for a fixed-schema template.
 */
export function csvMatrixText(matrix) {
  const rows = Array.isArray(matrix) ? matrix : [];
  if (!rows.length) return "";
  return "﻿" + rows.map((row) => (Array.isArray(row) ? row : [row]).map(csvCell).join(",")).join("\r\n");
}

/** Download a MATRIX (array of arrays) as an Excel-compatible CSV. Returns false when empty. */
export function downloadCsvMatrix(matrix, filename) {
  const rows = Array.isArray(matrix) ? matrix : [];
  if (!rows.length) return false;
  const url = URL.createObjectURL(new Blob([csvMatrixText(matrix)], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
  return true;
}

export function slug(value, fallback = "account") {
  const text = String(value || "")
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
  return text || fallback;
}

/**
 * Download `exportRows` (an array of flat objects, all with the same keys) as
 * an Excel-compatible CSV. Returns false when there is nothing to export so a
 * caller can keep its button disabled honestly.
 */
export function downloadCsv(exportRows, filename) {
  if (!exportRows.length) return false;
  const url = URL.createObjectURL(new Blob([csvText(exportRows)], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
  return true;
}

/**
 * Build a report filename that always records the account and as-of date, so a
 * downloaded file can still be traced back to its scope and freshness.
 */
export function reportFilename(reportSlug, accountName, asOf, extra) {
  const parts = [reportSlug, slug(accountName)];
  if (extra) parts.push(slug(extra, ""));
  parts.push(asOf || new Date().toISOString().slice(0, 10));
  return `${parts.filter(Boolean).join("-")}.csv`;
}
