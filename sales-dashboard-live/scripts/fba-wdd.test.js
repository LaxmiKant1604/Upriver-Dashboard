// FBA WDD / lead-time / reorder model -- pure client logic (src/lib/fba-wdd.js) + the lead-time import validator
// (src/lib/fba-lead-time-import.js). Proves the mission formulas: WDD from the shared SKU Movement v2 ordered-unit
// evidence, 7/30/60 boundaries, incomplete coverage (uncovered day is missing evidence, never a fabricated 0), weight
// validation (over/under 100), the 50/30/20 default, account-default vs per-brand resolution (never cross-brand),
// Total Lead Time, Inbound ETA (Safety excluded), Days to Inbound (marketplace-local), the non-double-counting cover
// model (Total FBA Inventory excluded), rounding, and the "Unavailable, never a false Sufficient" rule.
import assert from "node:assert/strict";
import {
  trailingDailyAverage, dailyAverages, validateWddWeights, weightedDailyDemand, resolveWddWeights,
  totalLeadTime, computeInboundEta, daysToInbound, coverModel, marketplaceLocalDate, computeAsinWdd, WDD_DEFAULT_WEIGHTS,
} from "../src/lib/fba-wdd.js";
import { buildFbaLeadTimeMatrix, validateFbaLeadTimeRows, validateFbaLeadTimeText, FBA_LEAD_TIME_COLUMNS } from "../src/lib/fba-lead-time-import.js";

let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log(`  ok  ${name}`); }

// A dense 60-day dailyUnits map ending 2026-06-30 with `perDay` units each covered day.
function denseDaily(endDate, days, perDay) {
  const map = {};
  const d0 = new Date(endDate + "T00:00:00Z");
  for (let i = 0; i < days; i += 1) { const d = new Date(d0); d.setUTCDate(d.getUTCDate() - i); map[d.toISOString().slice(0, 10)] = perDay; }
  return map;
}

console.log("fba-wdd");

test("trailingDailyAverage: full coverage divides by N (covered units / 7)", () => {
  const daily = denseDaily("2026-06-30", 60, 3); // 3 units every day
  const a = trailingDailyAverage(daily, "2026-06-30", "2026-01-01", 7);
  assert.equal(a.coveredDays, 7);
  assert.equal(a.units, 21);
  assert.equal(a.avg, 3); // 21/7
});

test("trailingDailyAverage: a covered zero-sales day counts in the denominator (real 0)", () => {
  const daily = { "2026-06-30": 7 }; // only one covered day has a unit; the other 6 are covered zeros
  const a = trailingDailyAverage(daily, "2026-06-30", "2026-01-01", 7);
  assert.equal(a.coveredDays, 7);
  assert.equal(a.units, 7);
  assert.equal(a.avg, 1); // 7 units / 7 covered days
});

test("trailingDailyAverage: an UNCOVERED day is excluded from BOTH numerator and denominator (no fabricated 0)", () => {
  // coverageFrom pulls the window start forward: only 3 covered days in the trailing 7.
  const daily = { "2026-06-30": 2, "2026-06-29": 2, "2026-06-28": 2 };
  const a = trailingDailyAverage(daily, "2026-06-30", "2026-06-28", 7);
  assert.equal(a.coveredDays, 3);   // NOT 7 -- the 4 pre-coverage days are missing evidence
  assert.equal(a.units, 6);
  assert.equal(a.avg, 2);           // 6/3, not 6/7 -- uncovered days never dilute the rate
});

test("trailingDailyAverage: zero covered days -> null (Unavailable, never 0)", () => {
  const a = trailingDailyAverage({}, "2026-06-30", "2026-07-01", 7); // coverageFrom AFTER asOf
  assert.equal(a.avg, null);
  assert.equal(a.coveredDays, 0);
});

test("dailyAverages: 7/30/60 boundaries from one ASIN's dailyUnits", () => {
  const daily = denseDaily("2026-06-30", 60, 5);
  const avgs = dailyAverages(daily, "2026-06-30", "2026-01-01");
  assert.equal(avgs.avg7, 5); assert.equal(avgs.avg30, 5); assert.equal(avgs.avg60, 5);
  assert.deepEqual([avgs.covered7, avgs.covered30, avgs.covered60], [7, 30, 60]);
});

test("validateWddWeights: 50/30/20 valid; over-100 and under-100 each rejected with the right message", () => {
  assert.equal(validateWddWeights({ w7: 50, w30: 30, w60: 20 }).valid, true);
  const over = validateWddWeights({ w7: 60, w30: 30, w60: 20 });
  assert.equal(over.valid, false); assert.equal(over.total, 110); assert.match(over.reason, /must total exactly 100/);
  const under = validateWddWeights({ w7: 50, w30: 20, w60: 20 });
  assert.equal(under.valid, false); assert.equal(under.total, 90); assert.equal(under.reason, "Weights must total 100%.");
  assert.equal(validateWddWeights({ w7: 120, w30: 0, w60: 0 }).valid, false); // out of range
  assert.equal(validateWddWeights({ w7: "x", w30: 30, w60: 20 }).valid, false); // non-numeric
  assert.equal(WDD_DEFAULT_WEIGHTS.w7 + WDD_DEFAULT_WEIGHTS.w30 + WDD_DEFAULT_WEIGHTS.w60, 100); // recommended default totals 100
});

test("weightedDailyDemand: correct blend; a positive-weighted missing average -> null (never treated as 0)", () => {
  const wdd = weightedDailyDemand({ avg7: 10, avg30: 5, avg60: 2 }, { w7: 50, w30: 30, w60: 20 });
  assert.equal(wdd, 10 * 0.5 + 5 * 0.3 + 2 * 0.2); // 6.9
  assert.equal(weightedDailyDemand({ avg7: 10, avg30: null, avg60: 2 }, { w7: 50, w30: 30, w60: 20 }), null); // 30D missing but weighted
  assert.equal(weightedDailyDemand({ avg7: 10, avg30: null, avg60: 2 }, { w7: 60, w30: 0, w60: 40 }), 10 * 0.6 + 2 * 0.4); // 30D missing but ZERO weight -> fine
  assert.equal(weightedDailyDemand({ avg7: 10, avg30: 5, avg60: 2 }, { w7: 60, w30: 30, w60: 20 }), null); // invalid weights (110)
});

test("resolveWddWeights: brand's own weights; unmapped -> account default; missing -> 50/30/20; never cross-brand", () => {
  const saved = new Map([["acme", { w7: 70, w30: 20, w60: 10 }], ["", { w7: 40, w30: 40, w60: 20 }]]);
  assert.deepEqual(resolveWddWeights(saved, "acme").weights, { w7: 70, w30: 20, w60: 10 });
  assert.equal(resolveWddWeights(saved, "acme").source, "brand");
  assert.deepEqual(resolveWddWeights(saved, "").weights, { w7: 40, w30: 40, w60: 20 }); // unmapped -> account default
  assert.equal(resolveWddWeights(saved, "").source, "account-default");
  // A brand with NO saved record falls to the 50/30/20 default -- NEVER to another brand's ('acme') weights.
  const r = resolveWddWeights(saved, "bravo");
  assert.deepEqual(r.weights, WDD_DEFAULT_WEIGHTS); assert.equal(r.source, "default");
});

test("totalLeadTime: Production+Shipping+AWD+Safety; any missing -> null (Not configured)", () => {
  assert.equal(totalLeadTime({ production: 30, shipping: 10, awd: 5, safety: 14 }), 59);
  assert.equal(totalLeadTime({ production: 30, shipping: 10, awd: 5, safety: null }), null);
});

test("computeInboundEta: start + Production + Shipping + AWD (Safety EXCLUDED)", () => {
  assert.equal(computeInboundEta("2026-06-01", { production: 30, shipping: 10, awd: 5 }), "2026-07-16"); // +45 days, safety irrelevant
  assert.equal(computeInboundEta("2026-06-01", { production: null, shipping: 10, awd: 5 }), null);
});

test("daysToInbound: max(0, ETA - marketplace-local today); past ETA -> 0; no ETA -> null", () => {
  assert.equal(daysToInbound("2026-07-10", "2026-06-30"), 10);
  assert.equal(daysToInbound("2026-06-20", "2026-06-30"), 0); // ETA in the past -> 0, never negative
  assert.equal(daysToInbound(null, "2026-06-30"), null);
});

test("coverModel: Ideal/Existing/Reorder/Suggested; excludes Total FBA Inventory; full-precision compare; whole units", () => {
  // WDD 6.9, TLT 59 -> Ideal 407.1 -> 407. dti 10 -> WDD*dti 69. supply = 100 fba + 20 awd + 30 inbound = 150.
  // Existing raw = 150 - 69 = 81. Existing 81 < Ideal 407.1 -> Reorder. Suggested = ceil(407.1 - 81) = 327.
  const c = coverModel({ wdd: 6.9, totalLeadTime: 59, daysToInbound: 10, fbaAvailable: 100, awdAvailable: 20, inboundPipeline: 30 });
  assert.equal(c.idealCover, 407);
  assert.equal(c.existingCover, 81);
  assert.equal(c.reorderStatus, "Reorder");
  assert.equal(c.suggestedReorder, 327);
});

test("coverModel: Existing Cover clamps at 0; Sufficient when existing >= ideal", () => {
  const c = coverModel({ wdd: 1, totalLeadTime: 10, daysToInbound: 5, fbaAvailable: 100, awdAvailable: 0, inboundPipeline: 0 });
  // Ideal = 10; Existing = max(0, 100 - 5) = 95 >= 10 -> Sufficient, suggested 0.
  assert.equal(c.reorderStatus, "Sufficient"); assert.equal(c.suggestedReorder, 0);
  const neg = coverModel({ wdd: 100, totalLeadTime: 10, daysToInbound: 30, fbaAvailable: 5, awdAvailable: 0, inboundPipeline: 0 });
  assert.equal(neg.existingCover, 0); // 5 - 3000 clamped to 0, never negative
});

test("coverModel: unavailable demand/inventory/settings -> Unavailable, NEVER a false Sufficient", () => {
  assert.equal(coverModel({ wdd: null, totalLeadTime: 59, daysToInbound: 10, fbaAvailable: 100 }).reorderStatus, "Unavailable"); // no demand
  assert.equal(coverModel({ wdd: 6.9, totalLeadTime: null, daysToInbound: 10, fbaAvailable: 100 }).reorderStatus, "Unavailable"); // no lead time
  assert.equal(coverModel({ wdd: 6.9, totalLeadTime: 59, daysToInbound: null, fbaAvailable: 100 }).reorderStatus, "Unavailable"); // no countdown
  assert.equal(coverModel({ wdd: 6.9, totalLeadTime: 59, daysToInbound: 10, fbaAvailable: null }).reorderStatus, "Unavailable"); // no inventory
});

test("marketplaceLocalDate: resolves the marketplace-LOCAL calendar date across a timezone boundary", () => {
  const instant = new Date("2026-03-15T02:00:00Z"); // 02:00 UTC
  assert.equal(marketplaceLocalDate("America/New_York", instant), "2026-03-14"); // still the 14th in New York
  assert.equal(marketplaceLocalDate("Asia/Kolkata", instant), "2026-03-15");     // already the 15th in India
});

test("computeAsinWdd: end-to-end composition (demand -> WDD -> cover) shares ONE path", () => {
  const daily = denseDaily("2026-06-30", 60, 4); // 4 units/day -> every avg = 4
  const out = computeAsinWdd({
    dailyUnits: daily, effectiveAsOf: "2026-06-30", coverageFrom: "2026-01-01",
    weights: { w7: 50, w30: 30, w60: 20 }, leadTime: { production: 30, shipping: 10, awd: 5, safety: 14, inboundEta: "2026-07-10" },
    marketplaceToday: "2026-06-30", fbaAvailable: 100, awdAvailable: 0, inboundPipeline: 0,
  });
  assert.equal(out.avg7, 4); assert.equal(out.wdd, 4); // all averages 4, any weights -> 4
  assert.equal(out.totalLeadTime, 59); assert.equal(out.daysToInbound, 10);
  assert.equal(out.idealCover, Math.round(4 * 59)); // 236
  assert.equal(out.existingCover, Math.max(0, 100 - 4 * 10)); // 60
  assert.equal(out.reorderStatus, "Reorder");
});

/* ---- lead-time import validator ---- */
console.log("fba-lead-time-import");

test("buildFbaLeadTimeMatrix: header first; ASIN + blanks preserved as strings (lossless round-trip)", () => {
  const m = buildFbaLeadTimeMatrix({ accountId: "A", rows: [{ asin: "B0ABC", productName: "P", brand: "Acme", production: 30, shipping: null, awd: 5, safety: null, inboundEta: "2026-07-01" }] });
  assert.deepEqual(m[0], [...FBA_LEAD_TIME_COLUMNS]);
  assert.equal(m[1][1], "B0ABC"); assert.equal(m[1][4], "30"); assert.equal(m[1][5], ""); assert.equal(m[1][8], "2026-07-01");
});

test("validateFbaLeadTimeRows: valid rows; blank-as-clear (blank day -> null)", () => {
  const rows = [FBA_LEAD_TIME_COLUMNS, ["A", "B0ABC", "P", "Acme", "30", "", "5", "14", "", ""]];
  const res = validateFbaLeadTimeRows(rows);
  assert.equal(res.ok, true);
  assert.deepEqual(res.applyRows[0], { childAsin: "B0ABC", production: 30, shipping: null, awd: 5, safety: 14, inboundEta: null, note: "", line: 2 });
});

test("validateFbaLeadTimeRows: duplicate ASIN / bad day / bad ETA -> all-or-nothing, zero apply rows", () => {
  const dup = validateFbaLeadTimeRows([FBA_LEAD_TIME_COLUMNS, ["A", "B0X", "", "", "1", "", "", "", "", ""], ["A", "B0X", "", "", "2", "", "", "", "", ""]]);
  assert.equal(dup.ok, false); assert.equal(dup.applyRows.length, 0); assert.match(dup.errors[0].reason, /more than once/);
  const badDay = validateFbaLeadTimeRows([FBA_LEAD_TIME_COLUMNS, ["A", "B0Y", "", "", "-3", "", "", "", "", ""]]);
  assert.equal(badDay.ok, false); assert.match(badDay.errors[0].reason, /whole number/);
  const badEta = validateFbaLeadTimeRows([FBA_LEAD_TIME_COLUMNS, ["A", "B0Z", "", "", "1", "", "", "", "07/01/2026", ""]]);
  assert.equal(badEta.ok, false); assert.match(badEta.errors[0].reason, /YYYY-MM-DD/);
});

test("validateFbaLeadTimeRows: missing header -> rejected", () => {
  const res = validateFbaLeadTimeRows([["account", "sku", "qty"], ["A", "S", "1"]]);
  assert.equal(res.ok, false); assert.equal(res.missingHeader, true);
});

test("validateFbaLeadTimeText: RFC4180 text path yields the same result as the row path", () => {
  const text = FBA_LEAD_TIME_COLUMNS.join(",") + "\nA,B0ABC,P,Acme,30,10,5,14,2026-07-01,note";
  const res = validateFbaLeadTimeText(text);
  assert.equal(res.ok, true); assert.equal(res.applyRows[0].childAsin, "B0ABC"); assert.equal(res.applyRows[0].inboundEta, "2026-07-01");
});

console.log(`\nfba-wdd: ${passed} assertions passed`);
