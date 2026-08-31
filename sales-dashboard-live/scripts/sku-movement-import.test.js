// SKU MOVEMENT identifier bulk import LIB tests (client-side parse + preview-validate + template). Proves: ASIN is the
// immutable match key (SKU/product/brand are informational and never remap it); an absent Identifier column is a HARD
// error (never "clear everything"); a blank identifier VALUE is a legitimate clear; over-long / control-char / conflicting
// duplicate rows are flagged; the CSV/XLSX-grid path share one validator; and the template is formula-injection-safe.
import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import {
  validateIdentifierRows, validateIdentifierImport, buildIdentifierTemplateCsv, MAX_IDENTIFIER_LEN, IDENTIFIER_COLUMNS,
} from "../src/lib/sku-movement-import.js";
import { csvCell } from "../src/lib/csv.js";

let passed = 0;
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };
const test = (name, fn) => { try { fn(); passed += 1; out("  ok  " + name); } catch (e) { out("FAIL  " + name); out(String(e && e.stack ? e.stack : e)); process.exitCode = 1; } };

const HEADER = "Account,Marketplace,ASIN,SKU,Product,Brand,Identifier";

test("a clean CSV parses; ASIN upper-cased, identifier trimmed", () => {
  const r = validateIdentifierImport(`${HEADER}\nAcme,US,b09abc1234,SKU-1,Widget,Acme,  gift-set  `);
  assert.equal(r.errors.length, 0);
  assert.equal(r.valid.length, 1);
  assert.deepEqual(r.valid[0], { line: 2, asin: "B09ABC1234", identifier: "gift-set" });
});

test("ASIN is the match key -- SKU/Product/Brand are informational and never remap it", () => {
  // Two rows, SAME ASIN but different SKU/Product -> a conflict is judged on IDENTIFIER only, not SKU.
  const same = validateIdentifierImport(`${HEADER}\nA,US,B0AAA,SKU-X,P1,Br,ID-1\nA,US,B0AAA,SKU-Y,P2,Br,ID-1`);
  assert.equal(same.errors.length, 0, "same identifier under one ASIN with different SKUs is fine");
  assert.equal(same.valid.length, 2);
});

test("missing Identifier column is a HARD error -- never 'clear everything'", () => {
  const r = validateIdentifierImport("Account,Marketplace,ASIN,SKU,Product,Brand\nA,US,B0AAA,S,P,Br");
  assert.equal(r.missingIdentifierColumn, true);
  assert.equal(r.valid.length, 0, "nothing is applied when the Identifier column is absent");
});

test("missing ASIN column is a HARD error", () => {
  const r = validateIdentifierImport("Account,Marketplace,SKU,Product,Brand,Identifier\nA,US,S,P,Br,ID");
  assert.equal(r.missingAsinColumn, true);
  assert.equal(r.valid.length, 0);
});

test("a blank identifier VALUE is a legitimate clear (valid, not an error)", () => {
  const r = validateIdentifierImport(`${HEADER}\nA,US,B0AAA,S,P,Br,`);
  assert.equal(r.errors.length, 0);
  assert.equal(r.valid.length, 1);
  assert.equal(r.valid[0].identifier, "", "blank == clear");
});

test("a row with a blank ASIN is rejected", () => {
  const r = validateIdentifierImport(`${HEADER}\nA,US,,S,P,Br,ID`);
  assert.equal(r.valid.length, 0);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0].problems.join(";"), /missing ASIN/);
});

test("an over-long identifier is rejected", () => {
  const r = validateIdentifierImport(`${HEADER}\nA,US,B0AAA,S,P,Br,${"x".repeat(MAX_IDENTIFIER_LEN + 1)}`);
  assert.equal(r.valid.length, 0);
  assert.match(r.errors[0].problems.join(";"), new RegExp(`over ${MAX_IDENTIFIER_LEN} chars`));
});

test("a control character in the identifier is rejected", () => {
  const grid = [["ASIN", "Identifier"], ["B0AAA", "badbell"]];
  const r = validateIdentifierRows(grid);
  assert.equal(r.valid.length, 0);
  assert.match(r.errors[0].problems.join(";"), /control character/);
});

test("a duplicate ASIN with CONFLICTING identifiers is rejected (later line flagged)", () => {
  const r = validateIdentifierImport(`${HEADER}\nA,US,B0AAA,S,P,Br,ID-1\nA,US,B0AAA,S,P,Br,ID-2`);
  const conflict = r.errors.find((e) => /conflicts with line 2/.test(e.problems.join(";")));
  assert.ok(conflict, "the second row conflicts with the first");
  assert.equal(r.valid.length, 1, "only the first (line 2) is accepted; the conflicting one is rejected");
});

test("the CSV grid path and the raw-text path share one validator (headers matched case-insensitively)", () => {
  const grid = [["asin", "identifier"], ["b0aaa", "grid-id"]];
  const rGrid = validateIdentifierRows(grid);
  assert.equal(rGrid.valid.length, 1);
  assert.deepEqual(rGrid.valid[0], { line: 2, asin: "B0AAA", identifier: "grid-id" });
});

test("the template is formula-injection-safe (a leading = is quote-guarded)", () => {
  const csv = buildIdentifierTemplateCsv({ accountName: "Acme", rows: [{ asin: "B0AAA", sku: "=cmd()", productName: "P", brand: "Br", identifier: "@x", marketplace: "US" }] });
  const lines = csv.split("\r\n");
  assert.equal(lines[0].replace(/^﻿/, ""), IDENTIFIER_COLUMNS.map((c) => csvCell(c.label)).join(","));
  // csvCell prefixes a leading = @ + - with a single quote so a spreadsheet does not execute it.
  assert.ok(/'=cmd\(\)/.test(lines[1]) || /"'=cmd\(\)"/.test(lines[1]), `SKU formula neutralised: ${lines[1]}`);
  assert.ok(/'@x/.test(lines[1]), `identifier formula neutralised: ${lines[1]}`);
});

test("the template round-trips through the validator (a downloaded scope re-imports cleanly)", () => {
  const csv = buildIdentifierTemplateCsv({ accountName: "Acme", rows: [{ asin: "B0AAA", sku: "S", productName: "P", brand: "Br", identifier: "keep", marketplace: "US" }] });
  const r = validateIdentifierImport(csv);
  assert.equal(r.errors.length, 0);
  assert.equal(r.valid.length, 1);
  assert.deepEqual(r.valid[0], { line: 2, asin: "B0AAA", identifier: "keep" });
});

out("\n" + passed + " assertions passed");
