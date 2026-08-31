// SKU MOVEMENT core (v2) -- deterministic OFFLINE proof of: the default-7 / user-selectable N daily window (with
// client-side recompute over the shared daily history), ASIN-grain aggregation (multiple SKUs -> one row, summed
// once), the representative SKU (amzn... excluded, deterministic), brand isolation (canonical brandKey, Unmapped
// excluded from a named brand, no All-Brands fallback), and the durable ORDERED-unit policy (covered=0 vs
// uncovered=null, never fabricated). ZERO DataDoe. 7-bit ASCII.
import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import {
  skuMovementPayload, skuMovementRows, skuMovementDateWindows, movementStatus, movementPercent, catalogAsinMap,
  representativeSku, isLegitimateSku, MOVEMENT_THRESHOLDS, DEFAULT_RECENT_DAYS, MAX_RECENT_DAYS,
} from "../lib/server/reports/sku-movement-core.js";
import { computeRowWindow, recentPrevDates, clampRecentDays, DAILY_HISTORY_DAYS, dailyUnitAt } from "../lib/sku-movement-window.js";

let passed = 0;
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };
const test = (name, fn) => { try { fn(); passed += 1; out("  ok  " + name); } catch (e) { out("FAIL  " + name); out(String(e && e.stack ? e.stack : e)); process.exitCode = 1; } };

const CAT = [
  { child_asin: "B0A", product_brand: "Caruso Italy", product_name: "Widget A" },
  { child_asin: "B0B", product_brand: "Bolt", product_name: "Bolt B" },
  { child_asin: "B0C", product_brand: "Caruso-Italy", product_name: "Hyphen C" }, // distinct brand (punctuation)
];
const oli = (o) => ({ currency: "USD", units: 1, ...o });
const D = "2026-08-15";
const rowFor = (rows, asin) => rows.find((r) => r.asin === asin);

/* ===== 1-6: DAILY WINDOW (default 7, adjacent, client N) ===== */
test("1. default window is 7: recentDates = the last 7 dates, prevDates = the 7 immediately-preceding (adjacent)", () => {
  const w = skuMovementDateWindows(D);
  assert.equal(w.recentDays, DEFAULT_RECENT_DAYS);
  assert.equal(DEFAULT_RECENT_DAYS, 7);
  assert.deepEqual(w.recentDates, ["2026-08-09", "2026-08-10", "2026-08-11", "2026-08-12", "2026-08-13", "2026-08-14", "2026-08-15"]);
  assert.deepEqual(w.prevDates, ["2026-08-02", "2026-08-03", "2026-08-04", "2026-08-05", "2026-08-06", "2026-08-07", "2026-08-08"]);
});
test("dailyDates carries DAILY_HISTORY_DAYS (60) dates ending at effectiveAsOf (ascending)", () => {
  const w = skuMovementDateWindows(D);
  assert.equal(w.dailyDates.length, DAILY_HISTORY_DAYS);
  assert.equal(w.dailyDates[w.dailyDates.length - 1], D);
  assert.equal(w.dailyDates[0], "2026-06-17"); // 59 days before Aug 15
});
test("2. N=1, N=6, N=7, N=30 (max) all use exact adjacent Last-N / Previous-N windows", () => {
  const dates = skuMovementDateWindows(D).dailyDates;
  const chk = (n, lastEnd, prevEnd) => { const { recentDates, prevDates } = recentPrevDates(dates, n); assert.equal(recentDates.length, n); assert.equal(recentDates[recentDates.length - 1], D); assert.equal(prevDates[prevDates.length - 1], prevEnd); assert.equal(recentDates[0], lastEnd); };
  chk(1, D, "2026-08-14");
  chk(6, "2026-08-10", "2026-08-09");
  chk(7, "2026-08-09", "2026-08-08");
  chk(30, "2026-07-17", "2026-07-16");
  assert.equal(clampRecentDays(30), 30); assert.equal(clampRecentDays(31), MAX_RECENT_DAYS); assert.equal(clampRecentDays(0), 1); assert.equal(clampRecentDays("x"), DEFAULT_RECENT_DAYS);
});
test("3. covered date with no sale = honest 0; 4. uncovered (before coverage) = unavailable (null)", () => {
  const du = { "2026-08-15": 4 };
  assert.equal(dailyUnitAt(du, "2026-08-15", "2026-05-01"), 4);
  assert.equal(dailyUnitAt(du, "2026-08-12", "2026-05-01"), 0, "covered, no sale -> 0");
  assert.equal(dailyUnitAt(du, "2026-04-30", "2026-05-01"), null, "before coverage -> unavailable, never 0");
});
test("5. Previous N = 0 never returns Infinity/NaN (null percentage; status still classifies)", () => {
  assert.equal(movementPercent(9, 0), null);
  assert.equal(movementPercent(0, 0), null);
  assert.equal(Number.isFinite(movementPercent(9, 0) ?? 0), true);
  assert.equal(movementStatus({ lastUnits: 9, prevUnits: 0, monthsTotalUnits: 40 }), "Rising");
});
test("6. CLIENT recompute (computeRowWindow) for a different N matches server aggregation exactly", () => {
  const oliRows = [];
  for (let i = 0; i < 14; i += 1) oliRows.push(oli({ sale_date: skuMovementDateWindows(D).dailyDates[DAILY_HISTORY_DAYS - 1 - i], child_asin: "B0A", sku: "S1", units: i + 1 }));
  const p = skuMovementPayload({ oliRows, catalogRows: CAT, effectiveAsOf: D, brand: "ALL", coverageFrom: "2026-05-01" });
  const r = p.rows[0];
  // server default N=7
  const w7 = computeRowWindow({ dailyUnits: r.dailyUnits, monthsTotalUnits: r.monthsTotalUnits, mtdUnits: r.mtdUnits }, p.dailyDates, 7);
  assert.equal(w7.lastTotal, r.recentTotal, "client Last 7 == server default recentTotal");
  assert.equal(w7.prevTotal, r.prevTotal);
  assert.equal(w7.status, r.status);
  // a different N recomputes from the same daily history (no re-derive)
  const w3 = computeRowWindow({ dailyUnits: r.dailyUnits, monthsTotalUnits: r.monthsTotalUnits, mtdUnits: r.mtdUnits }, p.dailyDates, 3);
  const { recentDates, prevDates } = recentPrevDates(p.dailyDates, 3);
  const expLast = recentDates.reduce((s, d) => s + (r.dailyUnits[d] || 0), 0);
  assert.equal(w3.lastTotal, expLast, "Last 3 recomputed from daily history");
  assert.notEqual(w3.lastTotal, w7.lastTotal, "N changes the totals");
});

/* ===== 7-14: ASIN AGGREGATION + ISOLATION ===== */
test("7/8. two SKUs under one ASIN combine into ONE row; units sum exactly once", () => {
  const rows = skuMovementRows({ oliRows: [
    oli({ sale_date: D, child_asin: "B0A", sku: "SKU-1", units: 3 }),
    oli({ sale_date: D, child_asin: "B0A", sku: "SKU-2", units: 4 }),
    oli({ sale_date: "2026-08-01", child_asin: "B0A", sku: "SKU-2", units: 5 }),
  ], catalogRows: CAT, effectiveAsOf: D, brand: "ALL", coverageFrom: "2026-05-01" });
  assert.equal(rows.length, 1, "ONE ASIN row (SKUs aggregated)");
  assert.equal(rows[0].recentTotal, 7, "3 + 4 on the day, summed once");
  assert.equal(rows[0].mtdUnits, 12, "3 + 4 + 5 in Aug");
  assert.equal(rows[0].skuCount, 2, "two distinct SKUs combined");
});
test("9. same ASIN across two accounts NEVER combines (core is per-account; two separate calls stay separate)", () => {
  const a1 = skuMovementRows({ oliRows: [oli({ sale_date: D, child_asin: "B0A", sku: "S1", units: 5 })], catalogRows: CAT, effectiveAsOf: D, brand: "ALL" });
  const a2 = skuMovementRows({ oliRows: [oli({ sale_date: D, child_asin: "B0A", sku: "S1", units: 9 })], catalogRows: CAT, effectiveAsOf: D, brand: "ALL" });
  assert.equal(a1[0].recentTotal, 5); assert.equal(a2[0].recentTotal, 9, "each account's rows are independent");
});
test("10. same ASIN in two currencies never merges (currency-isolated rows)", () => {
  const rows = skuMovementRows({ oliRows: [oli({ sale_date: D, child_asin: "B0A", sku: "S1", currency: "USD", units: 2 }), oli({ sale_date: D, child_asin: "B0A", sku: "S1", currency: "EUR", units: 3 })], catalogRows: CAT, effectiveAsOf: D, brand: "ALL" });
  assert.equal(rows.length, 2, "USD and EUR are separate rows");
  assert.deepEqual(rows.map((r) => r.currency).sort(), ["EUR", "USD"]);
});
test("11/12. named brand includes ONLY catalog-proven ASINs; unmatched brand = valid EMPTY (never All-Brands)", () => {
  const oliRows = [oli({ sale_date: D, child_asin: "B0A", sku: "S1" }), oli({ sale_date: D, child_asin: "B0B", sku: "S2" }), oli({ sale_date: D, child_asin: "B0Z", sku: "S9" })];
  const caruso = skuMovementRows({ oliRows, catalogRows: CAT, effectiveAsOf: D, brand: "Caruso Italy" });
  assert.equal(caruso.length, 1); assert.equal(caruso[0].asin, "B0A");
  assert.ok(!caruso.some((r) => r.brand === "Unmapped"), "Unmapped never in a named brand");
  const none = skuMovementPayload({ oliRows, catalogRows: CAT, effectiveAsOf: D, brand: "Nope" });
  assert.equal(none.rows.length, 0); assert.equal(none.brandFiltered, true);
});
test("7b. canonical brandKey matches case/whitespace; punctuation stays DISTINCT", () => {
  assert.equal(skuMovementRows({ oliRows: [oli({ sale_date: D, child_asin: "B0A", sku: "S1" })], catalogRows: CAT, effectiveAsOf: D, brand: "  caruso   ITALY " }).length, 1);
  const hy = skuMovementRows({ oliRows: [oli({ sale_date: D, child_asin: "B0A", sku: "S1" }), oli({ sale_date: D, child_asin: "B0C", sku: "S3" })], catalogRows: CAT, effectiveAsOf: D, brand: "Caruso-Italy" });
  assert.equal(hy.length, 1); assert.equal(hy[0].asin, "B0C", "hyphen brand is DISTINCT");
});
test("14. an ordered-unit row with a SKU but NO resolvable ASIN stays Unmapped per-SKU (never attached to an ASIN)", () => {
  const rows = skuMovementRows({ oliRows: [
    oli({ sale_date: D, child_asin: "B0A", sku: "S1", units: 5 }),
    oli({ sale_date: D, child_asin: "", sku: "ORPHAN-1", units: 2 }),
    oli({ sale_date: D, child_asin: "", sku: "ORPHAN-2", units: 3 }),
  ], catalogRows: CAT, effectiveAsOf: D, brand: "ALL" });
  assert.equal(rows.length, 3, "B0A + two distinct Unmapped per-SKU rows (never collapsed onto B0A)");
  const unmapped = rows.filter((r) => r.unmapped);
  assert.equal(unmapped.length, 2);
  assert.ok(unmapped.every((r) => r.brand === "Unmapped" && !r.asin));
  assert.equal(rowFor(rows, "B0A").recentTotal, 5, "Unmapped units never leak into B0A");
});

/* ===== 15-17: REPRESENTATIVE SKU ===== */
test("15. representative SKU EXCLUDES case-insensitive amzn... return SKUs while a legit SKU exists", () => {
  const rep = representativeSku(["amzn.gr.OASC068N-CA_uB", "amzn.gr.OASC068N-XquL", "OASC068N"]);
  assert.equal(rep.sku, "OASC068N", "the legitimate seller SKU, not an amzn return SKU");
  assert.equal(rep.skuCount, 3, "all 3 SKUs counted as combined");
  assert.equal(rep.legitCount, 1);
  assert.equal(isLegitimateSku("AMZN.gr.x"), false); assert.equal(isLegitimateSku("amznAbc"), false); assert.equal(isLegitimateSku("OASC068N"), true);
});
test("16. representative SKU is deterministic: catalog primary wins; else lexicographically smallest legit", () => {
  assert.equal(representativeSku(["Zeta", "Alpha", "Mango"]).sku, "Alpha", "lexicographically smallest");
  assert.equal(representativeSku(["Zeta", "Alpha"], "Zeta").sku, "Zeta", "proven catalog primary wins");
  assert.equal(representativeSku(["Zeta", "Alpha"], "NotPresent").sku, "Alpha", "a primary not among the SKUs falls back to smallest");
  assert.equal(representativeSku(["Zeta", "Alpha"], "amzn.x").sku, "Alpha", "an amzn primary is never chosen");
});
test("17. every-SKU-amzn case exposes NO seller SKU (empty) but still aggregates the units", () => {
  const rep = representativeSku(["amzn.gr.A", "amzn.gr.B"]);
  assert.equal(rep.sku, "", "no legitimate seller SKU -> empty (UI shows em dash / No seller SKU)");
  const rows = skuMovementRows({ oliRows: [oli({ sale_date: D, child_asin: "B0A", sku: "amzn.gr.A", units: 4 }), oli({ sale_date: D, child_asin: "B0A", sku: "amzn.gr.B", units: 6 })], catalogRows: CAT, effectiveAsOf: D, brand: "ALL" });
  assert.equal(rows.length, 1); assert.equal(rows[0].sku, "", "no seller SKU displayed");
  assert.equal(rows[0].recentTotal, 10, "amzn SKUs' units are NOT discarded from the aggregate");
  assert.equal(rows[0].hasSellerSku, false);
});

/* ===== 18 + derived: units policy, months/MTD/run-rate/projection, payload envelope ===== */
test("18. covered=0 vs uncovered=null months; avg over available months; run rate + projection", () => {
  const r = skuMovementRows({ oliRows: [oli({ sale_date: "2026-07-10", child_asin: "B0A", sku: "S1", units: 8 }), oli({ sale_date: "2026-08-15", child_asin: "B0A", sku: "S1", units: 30 })], catalogRows: CAT, effectiveAsOf: D, brand: "ALL", coverageFrom: "2026-07-01" })[0];
  assert.equal(r.months.find((m) => m.key === "2026-05").units, null, "May before coverage -> unavailable");
  assert.equal(r.months.find((m) => m.key === "2026-07").units, 8);
  assert.equal(r.avgMonthlyUnits, 8, "average over AVAILABLE months only");
  assert.equal(r.mtdRunRate, 2, "30 units / 15 days elapsed");
  assert.equal(r.projectedUnits, 62, "2/day * 31 days in Aug");
});
test("units are summed verbatim (explicit-zero -> 0, no evidence -> no row, never fabricated)", () => {
  assert.equal(skuMovementRows({ oliRows: [oli({ sale_date: D, child_asin: "B0A", sku: "S1", units: 0 })], catalogRows: CAT, effectiveAsOf: D, brand: "ALL" })[0].recentTotal, 0);
  assert.equal(skuMovementRows({ oliRows: [], catalogRows: CAT, effectiveAsOf: D, brand: "ALL" }).length, 0);
});
test("payload envelope carries the daily axis + default/max N + dynamic labels (no hard-coded 5/7)", () => {
  const p = skuMovementPayload({ oliRows: [oli({ sale_date: D, child_asin: "B0A", sku: "S1" })], catalogRows: CAT, effectiveAsOf: D, brand: "Caruso Italy" });
  assert.equal(p.brand, "Caruso Italy"); assert.equal(p.brandFiltered, true);
  assert.equal(p.defaultRecentDays, 7); assert.equal(p.maxRecentDays, 30);
  assert.equal(p.dailyDates.length, DAILY_HISTORY_DAYS);
  assert.deepEqual(p.monthLabels, ["May '26", "Jun '26", "Jul '26"]);
  assert.equal(p.mtdLabel, "Aug '26 MTD");
  assert.equal(p.rows[0].sku, "S1");
});
test("month/leap rollovers still correct (Aug->Sep drops May; Dec->Jan crosses year; leap Feb 29)", () => {
  assert.deepEqual(skuMovementDateWindows("2026-09-01").completedMonths.map((m) => m.label), ["Jun '26", "Jul '26", "Aug '26"]);
  assert.deepEqual(skuMovementDateWindows("2027-01-10").completedMonths.map((m) => m.label), ["Oct '26", "Nov '26", "Dec '26"]);
  assert.equal(skuMovementDateWindows("2028-03-05").completedMonths.find((m) => m.key === "2028-02").to, "2028-02-29");
});
test("catalogAsinMap: first row per ASIN wins; blank brand -> Unmapped; carries primarySku when present", () => {
  const m = catalogAsinMap([{ child_asin: "b0a", product_brand: "  Foo  Bar ", product_name: "P", sku: "PRIMARY-1" }, { child_asin: "B0A", product_brand: "Other" }, { child_asin: "B0X", product_brand: "  " }]);
  assert.equal(m.get("B0A").brandKey, "foo bar");
  assert.equal(m.get("B0A").primarySku, "PRIMARY-1");
  assert.equal(m.get("B0X").brandKey, null);
});

out("\n" + passed + " assertions passed");
