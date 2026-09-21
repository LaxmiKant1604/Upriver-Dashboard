// CLIENT coverage-aware rendering guard (flexii UK repair). App.jsx is not unit-tested, so this is a source-level
// regression guard -- the SAME pattern the lineage-preflight suites use for their .mjs operators -- proving the Daily
// Reporting + Sales Dashboard render an UNCOVERED OLI period as Unavailable / em dash, NEVER a fabricated 0 / GBP 0,
// while a covered date with no sales stays a genuine zero. It asserts the wiring is present (removing it fails here),
// complementing the server-side behavioural tests (oli-completeness-serve coverage plumbing + the readiness gate).
// 7-bit ASCII, LF.
import assert from "node:assert/strict";
import { writeSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

let passed = 0;
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };
const test = (name, fn) => { try { fn(); passed += 1; out("  ok  " + name); } catch (e) { out("FAIL  " + name); out(String(e && e.stack ? e.stack : e)); process.exitCode = 1; } };

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const APP = readFileSync(path.join(ROOT, "src/App.jsx"), "utf8");

out("dashboard-coverage-display guard");

test("Daily cells derive `available` from the served OLI coverageFrom (a column entirely before coverage is Unavailable)", () => {
  assert.match(APP, /dailyCompleteness\.coverageFrom/, "coverageFrom is read from the daily completeness/coverage augment");
  assert.match(APP, /firstRowDate\s*&&\s*firstRowDate\s*<\s*rawCoverageFrom\s*\?\s*firstRowDate\s*:\s*rawCoverageFrom/, "coverageFrom is clamped to the earliest actual row (a durable row is proof; coverage-lags-rows never marks a row-bearing column unavailable)");
  assert.match(APP, /const available\s*=\s*!\(\s*coverageFrom\s*&&\s*col\.to\s*<\s*coverageFrom\s*\)/, "a column whose whole span is before coverageFrom is marked unavailable (mirrors SKU Movement's monthAvailable)");
  assert.match(APP, /return \{ sales, units, adSales, adSpend, clicks, hasAd, available \}/, "the availability flag rides on each daily cell");
});

test("DAILY_METRICS render Total Sales + Units as em dash when the column is Unavailable (never a fabricated 0)", () => {
  const i = APP.indexOf("const DAILY_METRICS");
  assert.ok(i > 0, "DAILY_METRICS exists");
  const block = APP.slice(i, i + 900);
  assert.match(block, /key: "sales"[\s\S]{0,120}c\.available === false \? "—" : fmtMoney\(c\.sales/, "Total Sales -> em dash when unavailable");
  assert.match(block, /key: "units"[\s\S]{0,120}c\.available === false \? "—" : c\.units\.toLocaleString/, "Units -> em dash when unavailable");
});

test("Sales Dashboard computes a salesWindowStatus (covered / partial / unavailable) from coverageFrom", () => {
  assert.match(APP, /const salesWindowStatus\s*=\s*useMemo/, "the dashboard derives an explicit coverage verdict");
  assert.match(APP, /scopeMin\s*&&\s*scopeMin\s*<\s*raw\s*\?\s*scopeMin\s*:\s*raw/, "coverageFrom is clamped to scopeMin (earliest sales row is proof; guards coverage-lags-rows)");
  assert.match(APP, /if \(rangeTo\s*<\s*cf\) return "unavailable"/, "a range entirely before coverage -> unavailable");
  assert.match(APP, /if \(rangeFrom\s*<\s*cf\) return "partial"/, "a range that starts before coverage -> partial");
});

test("Sales Dashboard shows Unavailable (not a genuine-zero 'no sales') for a fully-uncovered range, and a partial disclosure", () => {
  assert.match(APP, /salesWindowStatus === "unavailable" \?/, "the fully-uncovered branch is keyed on the coverage verdict");
  assert.match(APP, /Sales unavailable for this range/, "an uncovered range renders an 'unavailable' title, distinct from the genuine 'No sales in this range'");
  assert.match(APP, /this is not a zero/i, "the copy explicitly states the absence is Unavailable, not zero");
  assert.match(APP, /No sales in this range/, "the genuine-zero empty state is preserved for a covered range with no sales");
  assert.match(APP, /salesWindowStatus === "partial"/, "the partial-coverage disclosure is keyed on the coverage verdict");
  assert.match(APP, /Source coverage begins/, "a partially-covered range discloses that earlier dates are unavailable, not zero");
});

out("\n" + passed + " assertions passed");
