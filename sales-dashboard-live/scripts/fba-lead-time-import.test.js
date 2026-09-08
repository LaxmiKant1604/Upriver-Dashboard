// FBA per-ASIN lead-time IMPORT parser tests (audit 2026-09-08). Drives the REAL parser + the REAL dependency-free
// XLSX writer (buildXlsx) -> reader (readXlsxFirstSheet) round-trip (actual .xlsx bytes, shared strings + inflate), not
// static source checks. Proves: the "Child ASIN" / "ASIN" header aliases (the reported upload failure), ambiguous +
// parent-only rejection, omitted-writable-column rejection (no silent clear), account binding (match/mismatch/mixed/
// absent), note preservation, omitted-vs-blank semantics, real-calendar-date rejection, duplicates, invalid rows
// (atomic: zero apply), and the changed/cleared preview diff. 7-bit ASCII, LF.
import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import {
  FBA_LEAD_TIME_COLUMNS, buildFbaLeadTimeMatrix, validateFbaLeadTimeRows, validateFbaLeadTimeText, isRealCalendarDate,
} from "../src/lib/fba-lead-time-import.js";
import { buildXlsx } from "../src/lib/xlsx.js";
import { readXlsxFirstSheet } from "../src/lib/xlsx-read.js";

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed += 1; writeSync(1, `  ok ${name}\n`); };
writeSync(1, "fba-lead-time-import\n");

const FULL = [...FBA_LEAD_TIME_COLUMNS]; // account, child_asin, product_name, brand, prod, ship, awd, safety, eta, note
const rowFor = (asin, { acct = "A1", prod = "5", ship = "10", awd = "3", safety = "7", eta = "2026-01-15", note = "hi", name = "n", brand = "b" } = {}) =>
  [acct, asin, name, brand, prod, ship, awd, safety, eta, note];

/* ===================== A. HEADER ALIASES -- the reported "Child ASIN" upload failure ===================== */
{
  // Human-readable headers (spaces + capitals) -- exactly what a user's own spreadsheet uses.
  const human = ["Account", "Child ASIN", "Product Name", "Brand", "Production Days", "Shipping Days", "AWD Transfer Days", "Safety Stock Days", "Inbound ETA", "Note"];
  const r = validateFbaLeadTimeRows([human, rowFor("B0CHILD001", { acct: "A1" })], { expectedAccountId: "A1" });
  ok("A1: 'Child ASIN' + human day headers parse (the reported failure is fixed)", r.ok === true && r.preview.apply === 1 && r.applyRows[0].childAsin === "B0CHILD001");
  ok("A1b: values + note captured from the human headers", r.applyRows[0].production === 5 && r.applyRows[0].shipping === 10 && r.applyRows[0].awd === 3 && r.applyRows[0].safety === 7 && r.applyRows[0].inboundEta === "2026-01-15" && r.applyRows[0].note === "hi");

  // A bare "ASIN" column (documented alias) with the writable columns present.
  const asinHdr = ["ASIN", "production_days", "shipping_days", "awd_transfer_days", "safety_stock_days", "inbound_eta", "note"];
  const r2 = validateFbaLeadTimeRows([asinHdr, ["B0CHILD001", "5", "10", "3", "7", "", ""]]);
  ok("A2: a bare 'ASIN' header resolves to child_asin", r2.ok === true && r2.applyRows[0].childAsin === "B0CHILD001");

  // The exact template header still works (snake_case).
  const r3 = validateFbaLeadTimeRows([FULL, rowFor("B0CHILD001")], { expectedAccountId: "A1" });
  ok("A3: the canonical snake_case template header still parses", r3.ok === true && r3.applyRows.length === 1);
}

/* ===================== B. AMBIGUOUS + PARENT-ONLY rejection ===================== */
{
  const ambHdr = ["ASIN", "Child ASIN", "production_days", "shipping_days", "awd_transfer_days", "safety_stock_days", "inbound_eta", "note"];
  const r = validateFbaLeadTimeRows([ambHdr, ["x", "B0CHILD001", "5", "10", "3", "7", "", ""]]);
  ok("B1: two columns that both map to child_asin (ASIN + Child ASIN) are REJECTED as ambiguous, zero apply", r.ok === false && r.applyRows.length === 0 && (r.ambiguous || []).includes("child_asin") && /Ambiguous/.test(r.message));

  const parentHdr = ["Parent ASIN", "production_days", "shipping_days", "awd_transfer_days", "safety_stock_days", "inbound_eta", "note"];
  const r2 = validateFbaLeadTimeRows([parentHdr, ["P0PARENT", "5", "10", "3", "7", "", ""]]);
  ok("B2: a PARENT-ASIN-only file is rejected with a clear child-ASIN message (never treated as the identity)", r2.ok === false && r2.parentAsinOnly === true && /Parent ASIN/.test(r2.message) && /CHILD ASIN/.test(r2.message));

  const missingHdr = validateFbaLeadTimeRows([["foo", "bar"], ["1", "2"]]);
  ok("B3: no ASIN column at all -> missing-header error that shows the headers found", missingHdr.ok === false && missingHdr.missingHeader === true && /Found headers: foo, bar/.test(missingHdr.message));
}

/* ===================== C. OMITTED WRITABLE COLUMN -> reject (never silent clear) ===================== */
{
  // shipping_days omitted from the header: the OLD parser turned it into null and CLEARED it for every ASIN.
  const noShip = ["child_asin", "production_days", "awd_transfer_days", "safety_stock_days", "inbound_eta", "note"];
  const r = validateFbaLeadTimeRows([noShip, ["B0CHILD001", "5", "3", "7", "", ""]]);
  ok("C1: an omitted writable column (shipping_days) is REJECTED, zero apply (no silent clear = the data-loss fix)", r.ok === false && (r.missingRequired || []).includes("shipping_days") && r.applyRows.length === 0);
  const noNote = ["child_asin", "production_days", "shipping_days", "awd_transfer_days", "safety_stock_days", "inbound_eta"];
  const r2 = validateFbaLeadTimeRows([noNote, ["B0CHILD001", "5", "10", "3", "7", ""]]);
  ok("C2: an omitted note column is also rejected (its omission would clear notes)", r2.ok === false && (r2.missingRequired || []).includes("note"));
  // A PRESENT-but-blank cell still clears (documented, lossless round-trip).
  const rBlank = validateFbaLeadTimeRows([FULL, ["A1", "B0CHILD001", "n", "b", "", "10", "3", "7", "", ""]], { expectedAccountId: "A1" });
  ok("C3: a PRESENT-but-blank production cell clears (value=null), distinct from an omitted column", rBlank.ok === true && rBlank.applyRows[0].production === null && rBlank.applyRows[0].shipping === 10);
}

/* ===================== D. ACCOUNT BINDING ===================== */
{
  const rMatch = validateFbaLeadTimeRows([FULL, rowFor("B0CHILD001", { acct: "A1" })], { expectedAccountId: "A1" });
  ok("D1: an account column matching the configured account is accepted", rMatch.ok === true);
  const rMismatch = validateFbaLeadTimeRows([FULL, rowFor("B0CHILD001", { acct: "OTHER" })], { expectedAccountId: "A1" });
  ok("D2: a template for a DIFFERENT account is rejected (wrong-account write prevented client-side)", rMismatch.ok === false && rMismatch.accountMismatch === true && /OTHER/.test(rMismatch.message) && /A1/.test(rMismatch.message));
  const rMixed = validateFbaLeadTimeRows([FULL, rowFor("B0CHILD001", { acct: "A1" }), rowFor("B0CHILD002", { acct: "A2" })], { expectedAccountId: "A1" });
  ok("D3: a MIXED-account template is rejected", rMixed.ok === false && rMixed.accountMismatch === true && /mixes multiple accounts/.test(rMixed.message));
  // No account column: allowed (the server binds to its account + validates ASIN ownership).
  const noAcct = ["child_asin", "production_days", "shipping_days", "awd_transfer_days", "safety_stock_days", "inbound_eta", "note"];
  const rNoAcct = validateFbaLeadTimeRows([noAcct, ["B0CHILD001", "5", "10", "3", "7", "", ""]], { expectedAccountId: "A1" });
  ok("D4: a file with NO account column is accepted (server binds + checks ASIN ownership)", rNoAcct.ok === true && rNoAcct.applyRows.length === 1);
}

/* ===================== E. REAL CALENDAR DATE + day validation + duplicates + atomicity ===================== */
{
  ok("E0: isRealCalendarDate rejects impossible dates", isRealCalendarDate("2026-01-15") === true && isRealCalendarDate("2026-02-30") === false && isRealCalendarDate("2026-13-01") === false && isRealCalendarDate("2026-1-5") === false);
  const rBadDate = validateFbaLeadTimeRows([FULL, rowFor("B0CHILD001", { eta: "2026-02-30" })], { expectedAccountId: "A1" });
  ok("E1: an impossible inbound_eta (2026-02-30) is rejected; zero apply (atomic)", rBadDate.ok === false && rBadDate.applyRows.length === 0 && /real date/.test(rBadDate.message));
  const rBadDay = validateFbaLeadTimeRows([FULL, rowFor("B0CHILD001", { prod: "-2" })], { expectedAccountId: "A1" });
  ok("E2: a negative day is rejected; zero apply", rBadDay.ok === false && rBadDay.applyRows.length === 0);
  const rDup = validateFbaLeadTimeRows([FULL, rowFor("B0CHILD001"), rowFor("B0CHILD001")], { expectedAccountId: "A1" });
  ok("E3: a duplicate child_asin is rejected; zero apply", rDup.ok === false && /more than once/.test(rDup.message) && rDup.applyRows.length === 0);
  const rOneBad = validateFbaLeadTimeRows([FULL, rowFor("B0CHILD001"), rowFor("B0CHILD002", { prod: "abc" }), rowFor("B0CHILD003")], { expectedAccountId: "A1" });
  ok("E4: ANY invalid row makes the WHOLE import fail (all-or-nothing: zero apply though 2 rows were valid)", rOneBad.ok === false && rOneBad.applyRows.length === 0 && rOneBad.errors.length >= 1);
}

/* ===================== F. PREVIEW DIFF (changed / cleared) ===================== */
{
  const current = new Map([["B0CHILD001", { production: 5, shipping: 99, awd: 3, safety: 7, inboundEta: "2026-01-15", note: "old" }]]);
  const r = validateFbaLeadTimeRows([FULL, ["A1", "B0CHILD001", "n", "b", "5", "", "3", "7", "2026-01-15", "new note"]], { expectedAccountId: "A1", currentByAsin: current });
  ok("F1: the diff reports a CLEAR (shipping 99 -> blank) and a note change; preview counts them", r.ok === true && r.preview.cleared === 1 && r.preview.changed === 1);
  const diff = r.applyRows[0].diff;
  ok("F2: shipping is in clears; note change is a change but not a clear", diff.clears.includes("shipping") && diff.changes.some((c) => c.field === "shipping" && c.to === null) && diff.changes.some((c) => c.field === "note" && c.to === "new note") && !diff.clears.includes("note"));
  const rNoChange = validateFbaLeadTimeRows([FULL, ["A1", "B0CHILD001", "n", "b", "5", "99", "3", "7", "2026-01-15", "old"]], { expectedAccountId: "A1", currentByAsin: current });
  ok("F3: an identical row shows zero changes/clears", rNoChange.ok === true && rNoChange.preview.changed === 0 && rNoChange.preview.cleared === 0 && rNoChange.applyRows[0].diff.changes.length === 0);
}

/* ===================== G. REAL .xlsx ROUND-TRIP (writer -> reader -> validator), incl. notes ===================== */
async function roundTrip(matrix) {
  const bytes = buildXlsx([{ name: "ASIN Lead Times", rows: matrix, freezeHeaderRows: 1 }]);
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return readXlsxFirstSheet(ab);
}
{
  const matrix = buildFbaLeadTimeMatrix({ accountId: "A1", rows: [
    { asin: "B0CHILD001", productName: "Widget", brand: "Acme", production: 5, shipping: 10, awd: 3, safety: 7, inboundEta: "2026-01-15", note: "keep, this note" },
    { asin: "B0CHILD002", productName: "Gadget", brand: "Bolt", production: 4, shipping: 8, awd: null, safety: 5, inboundEta: "", note: "" },
  ] });
  const sheet = await roundTrip(matrix);
  const r = validateFbaLeadTimeRows(sheet, { expectedAccountId: "A1" });
  ok("G1: a generated .xlsx (real bytes: zip + shared strings + inflate) round-trips through the parser", r.ok === true && r.preview.apply === 2);
  const byAsin = new Map(r.applyRows.map((x) => [x.childAsin, x]));
  ok("G2: the NOTE survives the XLSX write+read+parse (was silently dropped before)", byAsin.get("B0CHILD001").note === "keep, this note");
  ok("G3: a blank AWD cell round-trips as a clear (null), a blank ETA as null", byAsin.get("B0CHILD002").awd === null && byAsin.get("B0CHILD002").inboundEta === null && byAsin.get("B0CHILD002").note === "");
  ok("G4: the child ASIN is preserved exactly as text (never coerced)", byAsin.get("B0CHILD001").childAsin === "B0CHILD001");
}

/* ===================== H. CSV/TSV parity via validateFbaLeadTimeText ===================== */
{
  const csv = [FBA_LEAD_TIME_COLUMNS.join(","), "A1,B0CHILD001,Widget,Acme,5,10,3,7,2026-01-15,a note", "A1,B0CHILD002,Gadget,Bolt,,,,,,"].join("\n");
  const r = validateFbaLeadTimeText(csv, { expectedAccountId: "A1" });
  ok("H1: CSV text parses via the SAME validator (2 rows; the second all-blank writable cells = clears)", r.ok === true && r.preview.apply === 2 && r.applyRows[1].production === null && r.applyRows[1].note === "");
  const tsv = [FBA_LEAD_TIME_COLUMNS.join("\t"), ["A1", "B0CHILD001", "Widget", "Acme", "5", "10", "3", "7", "2026-01-15", "tab note"].join("\t")].join("\n");
  const r2 = validateFbaLeadTimeText(tsv, { expectedAccountId: "A1" });
  ok("H2: TSV text parses too, note preserved", r2.ok === true && r2.applyRows[0].note === "tab note");
}

writeSync(1, `\nfba-lead-time-import: ${passed} checks passed\n`);
