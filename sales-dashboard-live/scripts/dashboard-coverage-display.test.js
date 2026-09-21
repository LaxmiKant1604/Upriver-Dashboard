// Sales Dashboard coverage WIRING guard (flexii UK follow-up). The Daily table is proved end-to-end by the RENDERED
// suite (daily-reporting-render.test.js) and the classifier by coverage-windows.test.js; this lean source guard covers
// the Dashboard-only wiring that is not otherwise unit/render-tested: the REQUESTED range is preserved separately from
// the effective/aggregation range (a 90D request is never silently rewritten into the covered days), coverage is judged
// against the requested interval via the shared classifier, the date-control minimum is NOT the first saved row, and an
// uncovered range renders "unavailable" (never a fabricated zero). 7-bit ASCII, LF.
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

test("the REQUESTED range is preserved separately from the effective/aggregation range (90D is never silently shrunk)", () => {
  assert.match(APP, /const \[requestedFrom, requestedTo, rangeFrom, rangeTo\] = useMemo/, "requested + effective ranges are distinct");
  assert.match(APP, /const reqFrom = f, reqTo = t;/, "the requested interval is captured BEFORE the scopeMin clamp");
  assert.match(APP, /if \(scopeMin && effFrom < scopeMin\) effFrom = scopeMin;/, "only the EFFECTIVE (aggregation) start is clamped to the earliest data row");
});

test("coverage is classified against the REQUESTED interval via the shared full-windows classifier (not coverageFrom alone), bounded to the fetched-data horizon", () => {
  assert.match(APP, /const salesCoverage = useMemo/, "the dashboard derives a coverage classification");
  assert.match(APP, /classifyInterval\(\{[\s\S]{0,260}coverageWindows: salesCompleteness\.coverageWindows/, "uses the full normalized coverage windows");
  assert.match(APP, /coverageRead: salesCompleteness\.coverageRead/, "honours the coverage read status (-> Unknown on read failure)");
  assert.match(APP, /from: requestedFrom, to: requestedTo, dataFloor: dashboardFetchFloor/, "classifies the REQUESTED interval, bounding window-proof to what the view fetched");
  assert.match(APP, /const dashboardFetchFloor = useMemo\(\(\) => addDays\(monthStart\(TODAY\), -420\)/, "the fetch floor mirrors the brand-sales fetch `from` (coverage earlier than the fetch horizon is not proven-for-display)");
  assert.match(APP, /positiveRowDates\(brandRows/, "a positive row is proof of its own date");
});

test("an unavailable range renders Unavailable BEFORE the has-data branch (a non-positive row never mints a GBP 0 KPI); a covered empty range keeps the genuine 'no sales'", () => {
  // The unavailable arm must precede !hasDashboardData so a zero/returns-only row in the window cannot reach the KPI grid.
  const iUnavail = APP.indexOf('salesWindowStatus === "unavailable" ?');
  const iHasData = APP.indexOf(") : !hasDashboardData ? (");
  assert.ok(iUnavail > 0 && iHasData > 0 && iUnavail < iHasData, "the unavailable branch is checked before hasDashboardData");
  assert.match(APP, /Sales unavailable for this range/, "an unavailable range is Unavailable, not a zero");
  assert.match(APP, /this is not a zero/i, "the copy states the absence is Unavailable, not zero");
  assert.match(APP, /salesWindowStatus === "partial"/, "a partial range is disclosed");
  assert.match(APP, /\{salesCoverage\.provenDays\} of \{salesCoverage\.totalDays\} days is source-covered/, "the partial disclosure quotes covered days (accurate for internal gaps), not a covered span");
});

test("the KPI period labels + date-control show the REQUESTED period; the date-control minimum is the OLI floor, not the first saved row", () => {
  assert.match(APP, /period=\{fmtRangeLabel\(requestedFrom, requestedTo\)\}/, "KPI cards label the requested period");
  assert.match(APP, /rangeLabel=\{fmtRangeLabel\(requestedFrom, requestedTo\)\}/, "the date control shows the requested period");
  assert.match(APP, /const OLI_HISTORY_FLOOR = "2025-01-01";/, "the OLI history floor constant exists");
  assert.match(APP, /minDate=\{OLI_HISTORY_FLOOR\}/, "the date-control minimum is the OLI floor (a Custom range may start before the first saved row)");
  assert.doesNotMatch(APP, /minDate=\{scopeMin\}/, "the date-control minimum is NOT clamped to the first saved row");
});

out("\n" + passed + " assertions passed");
