// Campaign Brand Mapping template + import tests (pure, offline). Proves the exporter emits the REAL header exactly
// once (never a 0,1,2... index row), CSV + XLSX round-trips keep long identifiers byte-for-byte, the legacy
// numeric-index file is parsed by finding the real header beneath it, Excel-damaged (scientific-notation) IDs are
// rejected with zero writes, and CSV/TSV/XLSX all feed ONE validator. 7-bit ASCII source, LF, sync progress.
import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { buildCampaignMappingMatrix, validateCampaignMappingRows, validateCampaignMappingText, detectHeader, idCorruption, CAMPAIGN_MAPPING_COLUMNS } from "../src/lib/campaign-mapping-import.js";
import { csvMatrixText } from "../src/lib/csv.js";
import { parseDelimited } from "../src/lib/warehouse-import.js";
import { buildXlsx } from "../src/lib/xlsx.js";
import { readXlsxFirstSheet } from "../src/lib/xlsx-read.js";

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };

// A realistic account with a 15-digit campaign_id and a 12-digit ads_profile_id + a name with a comma/quote/unicode.
const CAMPAIGNS = [
  { marketplace: "US", adsProfileId: "712260000000", campaignId: "106167000000000", campaignName: 'Summer, "Big" Sale — café', campaignType: "SP", campaignStatus: "enabled", brandDisplay: "Acme", lastObservedDate: "2026-09-01" },
  { marketplace: "GB", adsProfileId: "", campaignId: "999888777666555", campaignName: "UK Camp", campaignType: "SB", campaignStatus: "paused", brandDisplay: "", lastObservedDate: "2026-09-02" },
];
const matrix = buildCampaignMappingMatrix({ accountId: "acc-1", campaigns: CAMPAIGNS });

test("1/4. exported matrix's FIRST row is the real header exactly (never 0,1,2...)", () => {
  assert.deepEqual(matrix[0], [...CAMPAIGN_MAPPING_COLUMNS]);
  assert.notEqual(matrix[0][0], "0");
  assert.equal(matrix[0].indexOf("campaign_id"), 3);
});

test("2. header appears EXACTLY once in the CSV; no numeric-index row", () => {
  const csv = csvMatrixText(matrix);
  const lines = csv.replace(/^﻿/, "").split("\r\n");
  assert.equal(lines[0], CAMPAIGN_MAPPING_COLUMNS.map((c) => `"${c}"`).join(","), "first CSV line is the real header");
  const headerHits = lines.filter((l) => /(^|,)"campaign_id"(,|$)/.test(l)).length;
  assert.equal(headerHits, 1, "campaign_id header token appears once");
  assert.ok(!/^"0","1","2"/.test(lines[0]), "no 0,1,2 index header");
});

test("3/5/6. CSV download -> parseDelimited round-trip keeps long IDs + comma/quote/unicode names exact", () => {
  const parsed = parseDelimited(csvMatrixText(matrix));
  assert.deepEqual(parsed[0], [...CAMPAIGN_MAPPING_COLUMNS]);
  assert.equal(parsed[1][3], "106167000000000", "15-digit campaign_id exact");
  assert.equal(parsed[1][2], "712260000000", "12-digit ads_profile_id exact");
  assert.equal(parsed[1][4], 'Summer, "Big" Sale — café', "comma/quote/unicode name survives");
  assert.equal(parsed[2][3], "999888777666555", "15-digit id row 2 exact");
});

test("4/5. XLSX download -> readXlsxFirstSheet round-trip keeps long IDs exact (text cells, no scientific notation)", async () => {
  const bytes = buildXlsx([{ name: "Campaign Mapping", rows: matrix }]);
  const back = await readXlsxFirstSheet(bytes.buffer);
  assert.deepEqual(back[0], [...CAMPAIGN_MAPPING_COLUMNS], "header survives");
  assert.equal(back[1][3], "106167000000000", "campaign_id exact string (not 1.06167E+14)");
  assert.equal(back[1][2], "712260000000", "ads_profile_id exact");
  assert.equal(back[2][3], "999888777666555", "row 2 id exact");
  assert.ok(!/[eE][+-]?\d/.test(back[1][3] + back[1][2] + back[2][3]), "no scientific notation anywhere in the IDs");
});

test("7. the LEGACY numeric-index file (0,1,2... then real header) finds row 2 as the header", () => {
  const legacy = [
    ["0","1","2","3","4","5","6","7","8","9","10","11"],
    [...CAMPAIGN_MAPPING_COLUMNS],
    ["acc-1","US","712260000000","106167000000000","Camp","SP","enabled","","Acme","","",""],
  ];
  const det = detectHeader(legacy);
  assert.equal(det.headerIndex, 1, "real header detected beneath the numeric-index row");
  const r = validateCampaignMappingRows(legacy);
  assert.equal(r.ok, true, "validates after skipping the index row");
  assert.equal(r.applyRows.length, 1);
  assert.equal(r.applyRows[0].campaignId, "106167000000000");
  assert.equal(r.applyRows[0].brand, "Acme");
});

test("8. scientific-notation IDs are REJECTED with zero apply rows + the specific message", () => {
  const rows = [[...CAMPAIGN_MAPPING_COLUMNS], ["acc-1","US","7.1226E+11","1.06167E+14","Camp","SP","enabled","","Acme","","",""]];
  const r = validateCampaignMappingRows(rows);
  assert.equal(r.ok, false);
  assert.equal(r.scientificDetected, true);
  assert.equal(r.applyRows.length, 0, "zero writes");
  assert.match(r.message, /scientific notation/i);
  assert.match(r.message, /XLSX mapping template/i);
});

test("8b. idCorruption flags scientific / decimal / NaN / Infinity; a clean digit string passes", () => {
  assert.equal(idCorruption("1.06167E+14"), "scientific-notation");
  assert.equal(idCorruption("106167000000000.0"), "decimal-form");
  assert.equal(idCorruption("NaN"), "not-a-number");
  assert.equal(idCorruption("Infinity"), "not-a-number");
  assert.equal(idCorruption("106167000000000"), null, "exact digit string is fine");
  assert.equal(idCorruption(""), null, "blank is not corrupt (blank profile allowed)");
});

test("9. a file without campaign_id/marketplace headers is rejected clearly (missingHeader)", () => {
  const r = validateCampaignMappingRows([["foo","bar"],["1","2"]]);
  assert.equal(r.ok, false);
  assert.equal(r.missingHeader, true);
  assert.match(r.message, /campaign_id and marketplace/i);
});

test("10. duplicate campaign identity with conflicting brands rejects the ENTIRE file (zero writes)", () => {
  const rows = [[...CAMPAIGN_MAPPING_COLUMNS],
    ["acc-1","US","P1","C1","Camp","SP","enabled","","Acme","","",""],
    ["acc-1","US","P1","C1","Camp","SP","enabled","","Bravo","","",""]];
  const r = validateCampaignMappingRows(rows);
  assert.equal(r.ok, false);
  assert.equal(r.applyRows.length, 0);
  assert.match(r.errors[0].reason, /conflicting brands/i);
});

test("13. CLEAR and assignment rows both parse; blank new_brand without CLEAR is IGNORED, not written", () => {
  const rows = [[...CAMPAIGN_MAPPING_COLUMNS],
    ["acc-1","US","P1","C1","Camp","SP","enabled","Old","New Brand","","",""],       // assign
    ["acc-1","US","P2","C2","Camp","SP","enabled","Old","","CLEAR","",""],            // clear
    ["acc-1","US","P3","C3","Camp","SP","enabled","Old","","","",""]];                 // unchanged -> ignored
  const r = validateCampaignMappingRows(rows);
  assert.equal(r.ok, true);
  assert.equal(r.preview.assign, 1);
  assert.equal(r.preview.clear, 1);
  assert.equal(r.preview.ignored, 1);
  assert.deepEqual(r.applyRows.map((x) => [x.campaignId, x.action, x.brand]), [["C1","ASSIGN","New Brand"],["C2","CLEAR",""]]);
});

test("14. formula-injection values stay harmless in the CSV (leading = + - @ quoted with ')", () => {
  const m = buildCampaignMappingMatrix({ accountId: "acc-1", campaigns: [{ marketplace: "US", adsProfileId: "P1", campaignId: "C1", campaignName: "=cmd()|calc", campaignType: "SP", campaignStatus: "enabled", brandDisplay: "@evil" }] });
  const csv = csvMatrixText(m);
  assert.ok(csv.includes(`"'=cmd()|calc"`), "leading = neutralised with a leading quote");
  assert.ok(csv.includes(`"'@evil"`), "leading @ neutralised");
  assert.ok(!/="[^"]/.test(csv), "no unsafe executable =\"...\" formula form is emitted");
});

test("15. CSV, TSV and XLSX feed the SAME validator -> identical apply set", async () => {
  const rows = [[...CAMPAIGN_MAPPING_COLUMNS], ["acc-1","US","712260000000","106167000000000","Camp","SP","enabled","","Acme","","",""]];
  const csv = csvMatrixText(rows);
  const tsv = "﻿" + rows.map((r) => r.join("\t")).join("\r\n");
  const fromCsv = validateCampaignMappingText(csv);
  const fromTsv = validateCampaignMappingText(tsv);
  const fromXlsx = validateCampaignMappingRows(await readXlsxFirstSheet(buildXlsx([{ name: "m", rows }]).buffer));
  const key = (r) => JSON.stringify(r.applyRows.map((x) => [x.campaignId, x.marketplace, x.adsProfileId, x.brand]));
  assert.equal(key(fromCsv), key(fromTsv), "CSV == TSV");
  assert.equal(key(fromCsv), key(fromXlsx), "CSV == XLSX");
  assert.equal(fromCsv.applyRows[0].campaignId, "106167000000000", "id exact through every path");
});

async function main() {
  out("campaign-mapping-import (export/import)");
  let failures = 0;
  for (const t of tests) {
    try { await t.fn(); passed += 1; out("  ok  " + t.name); }
    catch (e) { failures += 1; out("FAIL  " + t.name); out(String((e && e.stack) || e)); }
  }
  out("\n" + passed + " assertions passed" + (failures ? ", " + failures + " FAILED" : ""));
  if (failures) process.exitCode = 1;
}
main();
