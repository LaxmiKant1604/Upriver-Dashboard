// Brand View exports: Excel (.xlsx), CSV and PDF.
//
// ONE TABLE MODEL, THREE RENDERERS
//   The Brand View screen builds a neutral table model (see `exportModel` in
//   src/views/BrandView.jsx) and this module renders it. That is deliberate: an
//   export that recomputed its own numbers would eventually disagree with the
//   screen, and a report that disagrees with its own export is worse than no
//   export. Each cell carries `t` (the display text, including the currency
//   symbol) and optionally `n` (the raw number), so Excel gets real numbers
//   while CSV and PDF keep the symbols.
//
// SECURITY
//   CSV cells go through `csvCell` and Excel cells through `sanitizeCell`; both
//   neutralise a leading = + - @ so a brand or product value can never execute
//   as a formula. Nothing here can widen data scope: it only formats the model
//   the already-authorised, already-account-scoped screen produced.
//
// This module is imported lazily (see BrandView's `runExport`) so the .xlsx
// writer is not part of the initial bundle.

import { csvCell } from "./csv.js";
import { buildXlsx, sanitizeCell } from "./xlsx.js";

/* ------------------------------------------------------------------ helpers */

function cellText(cell) {
  if (cell === null || cell === undefined) return "";
  if (typeof cell === "object") return cell.t === null || cell.t === undefined ? "" : String(cell.t);
  return String(cell);
}

function cellNumber(cell) {
  if (cell && typeof cell === "object" && Object.prototype.hasOwnProperty.call(cell, "n")) {
    const value = cell.n;
    return value === null || value === undefined || !Number.isFinite(Number(value)) ? null : Number(value);
  }
  return null;
}

/** The provenance block every export repeats, so a saved file stays traceable. */
export function metaLines(meta) {
  const lines = [
    ["Report", "Upriver Brand View"],
    ["Account", meta.accountName || meta.accountId || "—"],
    ["Brand", meta.brand || "—"],
    ["Report range", meta.rangeLabel || "—"],
    ["Report as of", meta.asOf || "—"],
    ["Currency display", meta.currencyLabel || "—"],
  ];
  if (meta.fxLine) lines.push(["Exchange rates", meta.fxLine]);
  if (meta.fxAttribution) lines.push(["Exchange-rate provider", meta.fxAttribution]);
  lines.push(["Source freshness", meta.freshnessLine || "—"]);
  lines.push(["Generated", meta.generatedAt || new Date().toISOString()]);
  if (meta.limitations?.length) {
    meta.limitations.forEach((note, index) => lines.push([index === 0 ? "Data limitations" : "", note]));
  }
  return lines;
}

export function exportFilename(meta, extension) {
  const slug = (value, fallback) => {
    const text = String(value || "").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();
    return text || fallback;
  };
  return [
    "brand-view",
    slug(meta.accountName || meta.accountId, "account"),
    slug(meta.brand, "brand"),
    slug(meta.currencyCode || meta.currencyLabel, "original"),
    meta.asOf || new Date().toISOString().slice(0, 10),
  ].join("-") + "." + extension;
}

/* --------------------------------------------------------------------- CSV */

/**
 * One CSV file with the three reports as clearly separated, labelled sections.
 *
 * A single file is intentional: three downloads for one click is worse, and the
 * section labels keep each report unambiguous when the file is opened.
 */
export function brandViewCsv(model) {
  const lines = [];
  const push = (cells) => lines.push(cells.map(csvCell).join(","));

  push(["UPRIVER BRAND VIEW EXPORT"]);
  metaLines(model.meta).forEach(([label, value]) => push([label, value]));
  push([]);

  for (const report of model.reports) {
    push([`REPORT: ${report.title}`]);
    if (report.subtitle) push([report.subtitle]);
    push(report.headers);
    for (const row of report.rows) {
      if (row.kind === "section") {
        push([]);
        push([cellText(row.cells[0])]);
        continue;
      }
      push(row.cells.map(cellText));
    }
    push([]);
  }

  // The UTF-8 BOM is what makes Excel read €, ₹ and ¥ correctly.
  return "﻿" + lines.join("\r\n");
}

/* -------------------------------------------------------------------- XLSX */

/** One worksheet per report, with the provenance block on its own first sheet. */
export function brandViewXlsxSheets(model) {
  const sheets = [{
    name: "Report info",
    rows: [["Upriver Brand View"], [], ...metaLines(model.meta)],
    columnWidths: [26, 78],
  }];

  for (const report of model.reports) {
    const rows = [[report.title]];
    if (report.subtitle) rows.push([report.subtitle]);
    rows.push([]);
    rows.push(report.headers.map((header) => sanitizeCell(header)));
    for (const row of report.rows) {
      if (row.kind === "section") {
        rows.push([]);
        rows.push([cellText(row.cells[0])]);
        continue;
      }
      // A number where one exists, so Excel can sum and sort; otherwise the
      // display text, which preserves an em dash for an unavailable value.
      rows.push(row.cells.map((cell) => {
        const numeric = cellNumber(cell);
        return numeric === null ? cellText(cell) : numeric;
      }));
    }
    sheets.push({
      name: report.sheetName || report.title,
      rows,
      freezeHeaderRows: 4,
      columnWidths: [26, ...report.headers.slice(1).map(() => 15)],
    });
  }

  return sheets;
}

export function brandViewXlsx(model, { modified } = {}) {
  return buildXlsx(brandViewXlsxSheets(model), { modified });
}

/* --------------------------------------------------------------------- PDF */

function escapeHtml(text) {
  return String(text === null || text === undefined ? "" : text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * A self-contained, print-optimised HTML document for the PDF export.
 *
 * WHY PRINT-TO-PDF RATHER THAN A PDF LIBRARY
 *   This report is full of currency symbols (₹ € £ ¥ AED) and country flags. The
 *   base-14 fonts a small PDF library ships with are WinAnsi-encoded and cannot
 *   render ₹ or a flag at all; producing a correct binary PDF would mean
 *   embedding and subsetting a Unicode font, which is a large dependency for one
 *   export. The browser's own print pipeline already produces a correct,
 *   selectable, Unicode-safe PDF, so the export opens this document and asks the
 *   browser to print it. This is stated in the export menu, not hidden.
 */
export function brandViewPrintableHtml(model) {
  const meta = metaLines(model.meta)
    .map(([label, value]) => `<div class="m"><span>${escapeHtml(label)}</span><b>${escapeHtml(value)}</b></div>`)
    .join("");

  const reports = model.reports.map((report) => {
    const body = report.rows.map((row) => {
      if (row.kind === "section") {
        return `<tr class="section"><td colspan="${report.headers.length}">${escapeHtml(cellText(row.cells[0]))}</td></tr>`;
      }
      const cells = row.cells
        .map((cell, index) => `<td class="${index === 0 ? "first" : "num"}">${escapeHtml(cellText(cell))}</td>`)
        .join("");
      return `<tr class="${row.kind === "total" ? "total" : ""}">${cells}</tr>`;
    }).join("");
    return `<section>
      <h2>${escapeHtml(report.title)}</h2>
      ${report.subtitle ? `<p class="sub">${escapeHtml(report.subtitle)}</p>` : ""}
      <table><thead><tr>${report.headers.map((header, index) => `<th class="${index === 0 ? "first" : "num"}">${escapeHtml(header)}</th>`).join("")}</tr></thead><tbody>${body}</tbody></table>
    </section>`;
  }).join("");

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>${escapeHtml(`Upriver Brand View — ${model.meta.brand || ""} — ${model.meta.accountName || ""}`)}</title>
<style>
  @page { size: A4 landscape; margin: 12mm; }
  * { box-sizing: border-box; }
  body { margin:0; font: 11px/1.45 "Segoe UI", system-ui, -apple-system, Arial, sans-serif; color:#111A2E; }
  h1 { font-size:17px; margin:0 0 2px; letter-spacing:-.01em; }
  .lead { color:#6B7488; font-size:11px; margin:0 0 12px; }
  .metablock { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:2px 20px; border:1px solid #D5DBE7; border-radius:8px; padding:9px 12px; margin-bottom:14px; }
  .m { display:flex; justify-content:space-between; gap:12px; font-size:10px; border-bottom:1px solid #EDF0F6; padding:2px 0; }
  .m span { color:#6B7488; }
  .m b { font-weight:700; text-align:right; }
  section { margin-bottom:16px; break-inside:auto; }
  h2 { font-size:12.5px; margin:0 0 2px; }
  .sub { color:#6B7488; font-size:9.5px; margin:0 0 6px; }
  table { width:100%; border-collapse:collapse; font-variant-numeric:tabular-nums; }
  thead { display:table-header-group; }
  th, td { padding:4px 6px; border-bottom:1px solid #EDF0F6; font-size:9.5px; }
  th { background:#F7F9FC; color:#4E5769; font-size:8.5px; text-transform:uppercase; letter-spacing:.05em; border-bottom:1px solid #D5DBE7; }
  th.num, td.num { text-align:right; white-space:nowrap; }
  th.first, td.first { text-align:left; }
  tr { break-inside:avoid; }
  tr.total td { background:#F7F9FC; font-weight:750; }
  tr.section td { background:#EEF1F7; font-weight:800; font-size:8.5px; text-transform:uppercase; letter-spacing:.06em; }
  footer { margin-top:10px; color:#6B7488; font-size:9px; }
  @media print { .noprint { display:none !important; } }
  .noprint { margin-bottom:12px; }
  .noprint button { font:inherit; padding:7px 13px; border:1px solid #2C5FD6; background:#2C5FD6; color:#fff; border-radius:8px; cursor:pointer; }
</style></head><body>
<div class="noprint"><button type="button" onclick="window.print()">Print / Save as PDF</button></div>
<h1>Upriver Brand View</h1>
<p class="lead">${escapeHtml(`${model.meta.brand || ""} · ${model.meta.accountName || model.meta.accountId || ""}`)}</p>
<div class="metablock">${meta}</div>
${reports}
<footer>${escapeHtml(model.meta.footer || "")}</footer>
</body></html>`;
}

/* ---------------------------------------------------------------- downloads */

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoked on the next tick so Safari has started the download first.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function downloadBrandViewCsv(model) {
  triggerDownload(
    new Blob([brandViewCsv(model)], { type: "text/csv;charset=utf-8" }),
    exportFilename(model.meta, "csv")
  );
}

export function downloadBrandViewXlsx(model) {
  const bytes = brandViewXlsx(model, { modified: new Date() });
  triggerDownload(
    new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
    exportFilename(model.meta, "xlsx")
  );
}

/**
 * Opens the printable document and asks the browser to print it.
 * Returns false when a popup blocker prevented the window, so the caller can say
 * so rather than silently doing nothing.
 */
export function printBrandViewPdf(model) {
  const target = window.open("", "_blank", "noopener,noreferrer,width=1200,height=900");
  if (!target) return false;
  target.document.open();
  target.document.write(brandViewPrintableHtml(model));
  target.document.close();
  target.focus();
  // The document must be laid out before print(), otherwise Chrome prints a
  // blank first page.
  setTimeout(() => { try { target.print(); } catch (error) { /* the user can still use the button */ } }, 350);
  return true;
}
