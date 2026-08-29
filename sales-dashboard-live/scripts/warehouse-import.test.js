// Seller-warehouse BULK import -- pure validation regressions. Proves the CSV/TSV parser, header mapping, the
// valid/error preview split, duplicate detection, malformed-quantity rejection, account/SKU isolation (an unknown or
// cross-account SKU is an error, never applied), the marketplace default, and the downloadable template shape.
// 7-bit ASCII, LF.

import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import {
  parseDelimited, mapHeader, validateWarehouseImport, validateWarehouseRows, buildImportTemplateCsv, IMPORT_COLUMNS,
} from "../src/lib/warehouse-import.js";

// A small account SKU DIRECTORY + catalog ASIN set for the directory-based tests.
const DIR = [
  { sku: "EXIST-1", childAsin: "ASIN1", brand: "Acme", marketplace: "US" },
  { sku: "EXIST-2", childAsin: "ASIN2", brand: "Beta", marketplace: "US" },
];
const CAT_ASINS = new Set(["ASIN1", "ASIN2", "ASIN3"]); // ASIN3 is a catalog ASIN with no current account SKU

let passed = 0;
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/* ===== parser ===== */
test("parseDelimited: CSV with quotes, embedded commas + newlines, doubled quotes", () => {
  const rows = parseDelimited('SKU,Note\r\n"A-1","hello, world"\n"B-2","line1\nline2"\n"C-3","she said ""hi"""');
  assert.deepEqual(rows[0], ["SKU", "Note"]);
  assert.deepEqual(rows[1], ["A-1", "hello, world"]);
  assert.deepEqual(rows[2], ["B-2", "line1\nline2"]);
  assert.deepEqual(rows[3], ["C-3", 'she said "hi"']);
});

test("parseDelimited: TSV auto-detected from a tab in the header (Excel paste)", () => {
  const rows = parseDelimited("SKU\tWarehouse Units\nA-1\t5");
  assert.deepEqual(rows[0], ["SKU", "Warehouse Units"]);
  assert.deepEqual(rows[1], ["A-1", "5"]);
});

test("parseDelimited: BOM stripped + blank rows dropped", () => {
  const rows = parseDelimited("﻿SKU,Units\nA-1,5\n\n , \n");
  assert.equal(rows.length, 2);
});

/* ===== header mapping ===== */
test("mapHeader: flexible aliases (case-insensitive); missing required reported", () => {
  const ok = mapHeader(["Seller SKU", "MARKET", "Qty", "ASIN", "comment"]);
  assert.equal(ok.missingRequired.length, 0);
  assert.deepEqual(ok.map, { sku: 0, marketplace: 1, qty: 2, childAsin: 3, note: 4 });
  const bad = mapHeader(["Marketplace", "Note"]);
  assert.deepEqual(bad.missingRequired.sort(), ["SKU", "Warehouse Units"]);
});

/* ===== validate: preview split ===== */
test("preview: valid rows and error rows are separated; qty parses (commas ok)", () => {
  const csv = "SKU,Marketplace,Warehouse Units\nA-1,US,\"1,200\"\nB-2,US,0";
  const r = validateWarehouseImport(csv, {});
  assert.equal(r.valid.length, 2);
  assert.equal(r.errors.length, 0);
  assert.equal(r.valid[0].qty, 1200);
  assert.equal(r.valid[1].qty, 0, "a genuine 0 warehouse count is valid, not missing");
});

test("marketplace default: a blank marketplace inherits the account marketplace", () => {
  const r = validateWarehouseImport("SKU,Warehouse Units\nA-1,5", { defaultMarketplace: "DE" });
  assert.equal(r.valid.length, 1);
  assert.equal(r.valid[0].marketplace, "DE");
  // ...but with NO default and no column, it's an error, never silently blank.
  const r2 = validateWarehouseImport("SKU,Warehouse Units\nA-1,5", {});
  assert.equal(r2.valid.length, 0);
  assert.equal(r2.errors[0].problems[0], "missing Marketplace (and no account default)");
});

/* ===== malformed quantity ===== */
test("malformed: non-numeric, negative, and fractional units are rejected with a reason", () => {
  const csv = "SKU,Marketplace,Warehouse Units\nA-1,US,abc\nB-2,US,-3\nC-3,US,2.5\nD-4,US,";
  const r = validateWarehouseImport(csv, {});
  assert.equal(r.valid.length, 0);
  assert.equal(r.errors.length, 4);
  assert.match(r.errors[0].problems[0], /not a number/);
  assert.match(r.errors[1].problems[0], /negative/);
  assert.match(r.errors[2].problems[0], /whole number/);
  assert.match(r.errors[3].problems[0], /missing Warehouse Units/);
});

/* ===== duplicate detection ===== */
test("duplicates: a repeated (marketplace, sku) is an error on the 2nd line; the 1st stays valid", () => {
  const csv = "SKU,Marketplace,Warehouse Units\nA-1,US,5\nA-1,US,9\nA-1,DE,3";
  const r = validateWarehouseImport(csv, {});
  assert.equal(r.valid.length, 2, "line 2 (A-1/US) valid + line 4 (A-1/DE) valid -- different marketplace");
  assert.equal(r.duplicates.length, 1);
  assert.match(r.duplicates[0].problems[0], /duplicate of line 2/);
});

/* ===== account/SKU isolation ===== */
test("isolation: a SKU not in this account is an error (never applied); known SKUs pass", () => {
  const known = new Set(["A-1", "B-2"]);
  const csv = "SKU,Marketplace,Warehouse Units\nA-1,US,5\nZZZ-9,US,5";
  const r = validateWarehouseImport(csv, { knownSkus: known });
  assert.equal(r.valid.length, 1);
  assert.equal(r.valid[0].sku, "A-1");
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].sku, "ZZZ-9");
  assert.match(r.errors[0].problems[0], /not in this account/);
});

test("isolation: with no knownSkus supplied, SKU membership is NOT enforced (any SKU allowed)", () => {
  const r = validateWarehouseImport("SKU,Marketplace,Warehouse Units\nANY,US,5", {});
  assert.equal(r.valid.length, 1);
});

test("Phase 3: a WAREHOUSE-ONLY / zero-activity account SKU (in the durable SKU universe) imports; a cross-account SKU fails closed", () => {
  // The authorized set is the durable account SKU universe (every SKU in any source, incl. SKUs the per-ASIN plan
  // drops) UNION already-saved warehouse SKUs -- NOT just the visible plan rows. So a warehouse-only catalog SKU with
  // zero sales + zero Amazon inventory is importable, while a SKU from another account is rejected.
  const authorized = new Set(["ACTIVE-1", "WH-ONLY-2", "ZERO-ACTIVITY-3"]); // account universe incl. dropped-row SKUs
  const csv = "SKU,Marketplace,Warehouse Units\nWH-ONLY-2,US,120\nZERO-ACTIVITY-3,US,0\nOTHER-ACCT-9,US,50";
  const r = validateWarehouseImport(csv, { knownSkus: authorized });
  assert.equal(r.valid.length, 2, "warehouse-only + zero-activity account SKUs import");
  assert.deepEqual(r.valid.map((v) => v.sku).sort(), ["WH-ONLY-2", "ZERO-ACTIVITY-3"]);
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].sku, "OTHER-ACCT-9");
  assert.match(r.errors[0].problems[0], /not in this account/);
});

/* ===== pre-parsed rows path (shared by the XLSX reader) ===== */
test("validateWarehouseRows: XLSX-shaped string[][] validates identically to CSV", () => {
  const rows = [["SKU", "Marketplace", "Warehouse Units"], ["A-1", "US", "7"], ["A-1", "US", "8"]];
  const r = validateWarehouseRows(rows, {});
  assert.equal(r.valid.length, 1);
  assert.equal(r.duplicates.length, 1);
});

test("missing required column short-circuits with no valid rows", () => {
  const r = validateWarehouseImport("Marketplace,Note\nUS,hi", {});
  assert.deepEqual(r.missingRequired.sort(), ["SKU", "Warehouse Units"]);
  assert.equal(r.valid.length, 0);
});

test("empty input is flagged, not an error", () => {
  const r = validateWarehouseImport("", {});
  assert.equal(r.empty, true);
  assert.equal(r.valid.length, 0);
});

/* ===== template ===== */
test("template: header matches the canonical columns + carries the account marketplace + sample SKUs", () => {
  const csv = buildImportTemplateCsv({ defaultMarketplace: "US", sampleSkus: [{ sku: "A-1", childAsin: "ASIN1" }] });
  const rows = parseDelimited(csv);
  assert.deepEqual(rows[0], IMPORT_COLUMNS.map((c) => c.label));
  assert.equal(rows[1][0], "A-1");
  assert.equal(rows[1][1], "US");
  // The template round-trips cleanly back through the validator (against its own sample SKU).
  const r = validateWarehouseImport(csv, { knownSkus: new Set(["A-1"]) });
  assert.equal(r.errors.length, 0);
  assert.equal(r.valid[0].qty, 0);
});

/* ===== directory-based identity + isolation (Phase 3) ===== */
test("directory: a KNOWN SKU may omit Child ASIN (resolved from the directory); provenance=existing", () => {
  const r = validateWarehouseRows([["SKU", "Marketplace", "Warehouse Units"], ["EXIST-1", "US", "10"]], { directory: DIR, catalogAsins: CAT_ASINS });
  assert.equal(r.valid.length, 1);
  assert.equal(r.valid[0].childAsin, "ASIN1", "resolved from directory");
  assert.equal(r.valid[0].provenance, "existing");
});

test("directory: a NEW MANUAL SKU requires a Child ASIN, which must exist in the catalog; provenance=manual", () => {
  // No child ASIN -> rejected.
  const noAsin = validateWarehouseRows([["SKU", "Marketplace", "Warehouse Units"], ["NEW-9", "US", "5"]], { directory: DIR, catalogAsins: CAT_ASINS });
  assert.equal(noAsin.valid.length, 0);
  assert.match(noAsin.errors[0].problems[0], /new SKU requires a Child ASIN/);
  // Child ASIN present + in catalog -> valid, manual provenance.
  const ok = validateWarehouseRows([["SKU", "Marketplace", "Warehouse Units", "Child ASIN"], ["NEW-9", "US", "5", "ASIN3"]], { directory: DIR, catalogAsins: CAT_ASINS });
  assert.equal(ok.valid.length, 1);
  assert.equal(ok.valid[0].childAsin, "ASIN3");
  assert.equal(ok.valid[0].provenance, "manual");
  // Child ASIN present but NOT in catalog -> rejected (zero writes).
  const bad = validateWarehouseRows([["SKU", "Marketplace", "Warehouse Units", "Child ASIN"], ["NEW-9", "US", "5", "ASIN-NOPE"]], { directory: DIR, catalogAsins: CAT_ASINS });
  assert.equal(bad.valid.length, 0);
  assert.match(bad.errors[0].problems[0], /not in this account's catalog/);
});

test("directory: a CONFLICTING SKU -> ASIN mapping is rejected", () => {
  const r = validateWarehouseRows([["SKU", "Marketplace", "Warehouse Units", "Child ASIN"], ["EXIST-1", "US", "5", "ASIN2"]], { directory: DIR, catalogAsins: CAT_ASINS });
  assert.equal(r.valid.length, 0);
  assert.match(r.errors[0].problems[0], /SKU maps to ASIN1, not ASIN2/);
});

test("directory: a cross-account SKU (not in directory) with a non-catalog ASIN fails closed", () => {
  const r = validateWarehouseRows([["SKU", "Marketplace", "Warehouse Units", "Child ASIN"], ["OTHER-ACCT", "US", "5", "ASIN-OTHER"]], { directory: DIR, catalogAsins: CAT_ASINS });
  assert.equal(r.valid.length, 0);
  assert.match(r.errors[0].problems[0], /not in this account's catalog/);
});

test("directory: existing SKU with the CORRECT explicit ASIN is fine; duplicates still caught", () => {
  const r = validateWarehouseRows([["SKU", "Marketplace", "Warehouse Units", "Child ASIN"], ["EXIST-2", "US", "3", "ASIN2"], ["EXIST-2", "US", "9", "ASIN2"]], { directory: DIR, catalogAsins: CAT_ASINS });
  assert.equal(r.valid.length, 1, "first ok, second is a duplicate");
  assert.equal(r.duplicates.length, 1);
});

let failures = 0;
for (const t of tests) {
  try { t.fn(); passed += 1; out("  ok  " + t.name); }
  catch (e) { failures += 1; out("FAIL  " + t.name); out(String((e && e.stack) || e)); }
}
out("\n" + passed + " assertions passed" + (failures ? ", " + failures + " FAILED" : ""));
if (failures) process.exitCode = 1;
