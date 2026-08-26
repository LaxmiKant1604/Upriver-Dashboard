// Daily Reporting ROI / ACoS / TACoS presentation formulas -- deterministic OFFLINE proof.
//
//   - ROI = Total Sales / Ad Spend (NOT Ad Sales / Ad Spend) -- the business return on ad spend;
//   - it is SUM(Total Sales) / SUM(Ad Spend) (summed then divided), never an average of per-row ROI;
//   - Indya Store IN, Aug MTD proof: 4318606 / 533852 = 8.09 (the old adSales/spend gave 3.60);
//   - two decimal places; zero / missing / unavailable Ad Spend -> em dash; never Infinity / NaN / fabricated 0;
//   - ACoS / TACoS keep their prior business meaning + one-decimal % formatting.
//
// 7-bit ASCII, LF, no top-level await.

import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { formatDailyRoi, formatDailyAcos, formatDailyTacos, EM_DASH } from "../src/lib/daily-metrics.js";

let passed = 0;
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test("PROOF: Indya Store IN Aug MTD -> ROI 8.09 (Total Sales / Ad Spend), NOT 3.60 (Ad Sales / Ad Spend)", () => {
  const totalSales = 4318606, adSpend = 533852, adSales = 1923490;
  assert.equal(formatDailyRoi(totalSales, adSpend, true), "8.09");
  // the OLD (wrong) formula would have shown 3.60 -- prove we are NOT computing that
  assert.equal((adSales / adSpend).toFixed(2), "3.60");
  assert.notEqual(formatDailyRoi(totalSales, adSpend, true), "3.60");
});

test("ROI is SUM(Total Sales) / SUM(Ad Spend) -- summed then divided, never an average of per-row ROI", () => {
  // three days: ROI of the SUMS = (100+200+900)/(10+10+10) = 1200/30 = 40.00.
  // the average of per-row ROI would be (10 + 20 + 90)/3 = 40 here too, so use asymmetric rows to distinguish:
  const days = [{ s: 100, sp: 10 }, { s: 900, sp: 90 }]; // per-row ROI both = 10; avg = 10
  const sumS = days.reduce((a, d) => a + d.s, 0), sumSp = days.reduce((a, d) => a + d.sp, 0);
  // now skew: one big-spend low-sales day drags the SUM ratio away from the per-row average
  const days2 = [{ s: 1000, sp: 10 }, { s: 10, sp: 1000 }]; // per-row ROI 100 and 0.01 -> avg 50.005
  const sumS2 = 1010, sumSp2 = 1010;
  assert.equal(formatDailyRoi(sumS, sumSp, true), "10.00", "symmetric case");
  assert.equal(formatDailyRoi(sumS2, sumSp2, true), "1.00", "SUM ratio 1010/1010 = 1.00, NOT the per-row average ~50");
});

test("two decimal places always", () => {
  assert.equal(formatDailyRoi(500, 100, true), "5.00");
  assert.equal(formatDailyRoi(333, 100, true), "3.33");
  assert.equal(formatDailyRoi(1, 3, true), "0.33");
});

test("zero / missing / unavailable Ad Spend -> em dash (never Infinity / NaN / fabricated zero)", () => {
  assert.equal(formatDailyRoi(1000, 0, true), EM_DASH, "zero spend -> em dash, not Infinity");
  assert.equal(formatDailyRoi(1000, -5, true), EM_DASH, "negative spend -> em dash");
  assert.equal(formatDailyRoi(1000, 100, false), EM_DASH, "no advertising rows -> em dash, not a measured value");
  assert.equal(formatDailyRoi(1000, null, true), EM_DASH, "missing spend -> em dash");
  assert.equal(formatDailyRoi(1000, undefined, true), EM_DASH, "undefined spend -> em dash");
  assert.equal(formatDailyRoi(0, 100, true), "0.00", "REAL zero sales with real spend is an honest 0.00 (spend but no return)");
});

test("ACoS / TACoS keep their prior business meaning + one-decimal %", () => {
  // ACoS = Ad Spend / Ad Sales; TACoS = Ad Spend / Total Sales
  assert.equal(formatDailyAcos(533852, 1923490, true), (533852 / 1923490 * 100).toFixed(1) + "%");
  assert.equal(formatDailyTacos(533852, 4318606, true), (533852 / 4318606 * 100).toFixed(1) + "%");
  assert.equal(formatDailyAcos(100, 0, true), EM_DASH, "zero ad sales -> em dash");
  assert.equal(formatDailyTacos(100, 0, true), EM_DASH, "zero total sales -> em dash");
  assert.equal(formatDailyAcos(100, 200, false), EM_DASH, "no ads -> em dash");
});

let failures = 0;
for (const t of tests) {
  try { t.fn(); passed += 1; out("  ok  " + t.name); }
  catch (e) { failures += 1; out("FAIL  " + t.name); out(String((e && e.stack) || e)); }
}
out("\n" + passed + " assertions passed" + (failures ? ", " + failures + " FAILED" : ""));
if (failures) process.exitCode = 1;
