// FBA Shipment Plan PLANNING helpers -- pure, offline regressions for the configurable planner. Proves horizons,
// calendar-aware windows, the unchanged current-month MTD projection, every forecast method + weight validation, the
// non-overlapping inventory equation (no double count), US-only AWD, "missing is never a fabricated 0", and the
// shortage/ship/production/stockout outputs. 7-bit ASCII, LF.

import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import {
  resolveHorizon, normalizeHorizon, horizonWindow, addMonthsStr, addDaysStr, daysBetween, daysInMonthOf,
  baseMonthlyForecast, validateWeights, mtdProjectedUnits, computePlanRow, planningPriorityAction,
  SYSTEM_DEFAULT_HORIZON, DEFAULT_FORECAST_METHOD,
} from "../src/lib/fba-planning.js";

let passed = 0;
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/* ===== 1. horizon presets + custom days ===== */
test("1. 1/2/3-month presets and custom days normalize; invalid falls back", () => {
  assert.deepEqual(normalizeHorizon({ kind: "months", months: 1 }), { kind: "months", months: 1 });
  assert.deepEqual(normalizeHorizon({ kind: "months", months: 3 }), { kind: "months", months: 3 });
  assert.equal(normalizeHorizon({ kind: "months", months: 4 }), null, "only 1/2/3 month presets");
  assert.deepEqual(normalizeHorizon({ kind: "days", days: 45 }), { kind: "days", days: 45 });
  assert.equal(normalizeHorizon({ kind: "days", days: 0 }), null, "custom days must be >= 1");
  assert.equal(normalizeHorizon({ kind: "days", days: 366 }), null, "custom days must be <= 365");
  assert.equal(normalizeHorizon({ kind: "days", days: 30.5 }), null, "custom days must be a whole number");
});

test("7/8. resolution order: SKU override > account default > system default (2 months)", () => {
  assert.deepEqual(resolveHorizon({ skuOverride: { kind: "days", days: 20 }, accountDefault: { kind: "months", months: 3 } }), { horizon: { kind: "days", days: 20 }, source: "sku" });
  assert.deepEqual(resolveHorizon({ skuOverride: null, accountDefault: { kind: "months", months: 3 } }), { horizon: { kind: "months", months: 3 }, source: "account" });
  assert.deepEqual(resolveHorizon({}), { horizon: { ...SYSTEM_DEFAULT_HORIZON }, source: "system" }, "system default is 2 months");
  assert.deepEqual(resolveHorizon({ skuOverride: { kind: "months", months: 9 } }), { horizon: { ...SYSTEM_DEFAULT_HORIZON }, source: "system" }, "an invalid SKU override falls through to system");
});

/* ===== 2. calendar-aware horizon ===== */
test("2. calendar-aware horizon uses REAL month boundaries, not 30-day months", () => {
  // Feb is short; 1 month from 2026-01-31 lands on 2026-02-28 (28 days), not +30.
  assert.equal(addMonthsStr("2026-01-31", 1), "2026-02-28");
  assert.equal(addMonthsStr("2026-02-15", 3), "2026-05-15");
  const w1 = horizonWindow("2026-01-31", { kind: "months", months: 1 });
  assert.equal(w1.start, "2026-02-01");
  assert.equal(w1.end, "2026-02-28");
  assert.equal(w1.effectiveHorizonDays, daysBetween("2026-01-31", "2026-02-28"));
  // custom days uses the EXACT count.
  const w2 = horizonWindow("2026-08-28", { kind: "days", days: 45 });
  assert.equal(w2.end, addDaysStr("2026-08-28", 45));
  assert.equal(w2.effectiveHorizonDays, 45);
  assert.equal(daysInMonthOf("2026-02-01"), 28);
  assert.equal(daysInMonthOf("2024-02-01"), 29, "leap year");
});

/* ===== 3. MTD projection stays current-month-only ===== */
test("3. mtdProjectedUnits = (mtdUnits/elapsed)*daysInMonth, current-month only, D-1 based; never a multi-month forecast", () => {
  assert.equal(mtdProjectedUnits({ mtdUnits: 280, elapsedCompletedDays: 28, daysInCurrentMonth: 31 }), Math.round((280 / 28) * 31 * 100) / 100);
  assert.equal(mtdProjectedUnits({ mtdUnits: 280, elapsedCompletedDays: 28, daysInCurrentMonth: 31 }), 310);
  assert.equal(mtdProjectedUnits({ mtdUnits: 100, elapsedCompletedDays: 0, daysInCurrentMonth: 31 }), null, "no elapsed days -> unavailable, not 0");
  assert.equal(mtdProjectedUnits({ mtdUnits: null, elapsedCompletedDays: 28, daysInCurrentMonth: 31 }), null);
});

/* ===== 4/5. forecast methods + weighted-100% ===== */
test("4. every forecast method computes the documented base monthly figure", () => {
  const months = [300, 360, 420]; const mtdProjected = 500;
  assert.equal(baseMonthlyForecast({ method: "three-month", monthlyValues: months }), 360);
  assert.equal(baseMonthlyForecast({ method: "mtd", monthlyValues: months, mtdProjected }), 500);
  assert.equal(baseMonthlyForecast({ method: "higher", monthlyValues: months, mtdProjected }), 500, "higher = max(3mo avg, mtd)");
  assert.equal(baseMonthlyForecast({ method: "higher", monthlyValues: months, mtdProjected: 100 }), 360);
  assert.equal(DEFAULT_FORECAST_METHOD, "higher", "recommended default is the higher method");
  // weighted
  const w = baseMonthlyForecast({ method: "weighted", monthlyValues: months, mtdProjected, weights: [10, 20, 30, 40] });
  assert.equal(w, Math.round((0.1 * 300 + 0.2 * 360 + 0.3 * 420 + 0.4 * 500) * 100) / 100);
});

test("5. weighted weights must total EXACTLY 100; otherwise invalid + no forecast", () => {
  assert.equal(validateWeights([25, 25, 25, 25]).valid, true);
  assert.equal(validateWeights([10, 20, 30, 39]).valid, false, "99 != 100");
  assert.equal(validateWeights([10, 20, 30, 41]).valid, false, "101 != 100");
  assert.equal(validateWeights([50, 50, 0, 0]).valid, true);
  assert.equal(validateWeights([50, 50, 0]).valid, false, "must have 4 weights");
  assert.equal(validateWeights([-10, 40, 30, 40]).valid, false, "no negative weights");
  assert.equal(baseMonthlyForecast({ method: "weighted", monthlyValues: [1, 2, 3], mtdProjected: 4, weights: [10, 20, 30, 39] }), null, "invalid weights -> null (Unavailable), never a wrong number");
});

/* ===== 11/12/13. non-overlapping inventory equation ===== */
test("11/12. Customer Order Reserved is displayed but EXCLUDED from usable stock; no quantity is double-counted", () => {
  const r = computePlanRow({
    isUS: false, effectiveAsOf: "2026-08-28", daysInCurrentMonth: 31, inventoryAvailable: true,
    available: 100, customerOrderReserved: 40, reservedFcTransfer: 10, reservedFcProcessing: 5,
    inboundWorking: 20, inboundShipped: 8, inboundReceived: 12,
    monthlyValues: [300, 300, 300], mtdUnits: 280, elapsedCompletedDays: 28,
    horizon: { kind: "months", months: 2 }, safetyDays: 14, forecastMethod: "three-month",
  });
  // immediatelyAvailable = available; customer-order-reserved is separate + NOT in any usable total.
  assert.equal(r.immediatelyAvailable, 100);
  assert.equal(r.customerOrderReserved, 40);
  // amazonPipeline = working + shipped + received + fcProcessing + reserved_fc_transfer (RAW, no subtraction) = 20+8+12+5+10
  assert.equal(r.amazonPipeline, 20 + 8 + 12 + 5 + 10);
  assert.equal(r.reservedFcTransfer, 10, "reserved_fc_transfer is RAW -- no inbound-shipped subtraction");
  // totalAmazonAwdStock = 100 + 55 + 0(no AWD, non-US) ; customer reserved NOT added.
  assert.equal(r.totalAmazonAwdStock, 100 + 55);
  // Prove no double count: the sum of the distinct display components equals totalAmazonAwdStock, and adding
  // customerOrderReserved would OVER-count (guard).
  const distinct = r.immediatelyAvailable + r.inboundWorking + r.inboundShipped + r.inboundReceived + r.reservedFcProcessing + r.reservedFcTransfer;
  assert.equal(distinct, r.totalAmazonAwdStock, "every distinct inventory component is counted exactly once");
  assert.notEqual(r.totalAmazonAwdStock, distinct + r.customerOrderReserved, "customer-order-reserved is never added into usable stock");
});

test("no transfer/shipped subtraction: reserved_fc_transfer + inbound_shipped are both counted in full (distinct states)", () => {
  // A SKU with fc_transfer=30 and inbound_shipped=25 -- the OLD code would have subtracted to fc_transfer=5. The
  // authoritative source metadata (inbound_quantity = sum of inbound states; fc_transfer separate) proves no overlap,
  // so BOTH are counted in full.
  const r = computePlanRow({ isUS: false, effectiveAsOf: "2026-08-28", daysInCurrentMonth: 31, inventoryAvailable: true, available: 0, reservedFcTransfer: 30, inboundShipped: 25, monthlyValues: [30, 30, 30], mtdUnits: 28, elapsedCompletedDays: 28, horizon: { kind: "months", months: 1 } });
  assert.equal(r.reservedFcTransfer, 30, "no subtraction: full reserved_fc_transfer");
  assert.equal(r.amazonPipeline, 25 + 30, "inbound_shipped + reserved_fc_transfer both counted in full");
});

/* ===== forecast engine: a missing month/MTD is Unavailable, never treated as 0 ===== */
test("forecast requires proven inputs: missing month -> three-month Unavailable; higher uses the available side; MTD covered-zero is 0", () => {
  // Only two of three months present -> three-month average is Unavailable (null), NOT an average of a fabricated 0.
  assert.equal(baseMonthlyForecast({ method: "three-month", monthlyValues: [300, null, 420] }), null);
  assert.equal(baseMonthlyForecast({ method: "three-month", monthlyValues: [300, 0, 420] }), Math.round((300 + 0 + 420) / 3 * 100) / 100, "a covered-zero month IS counted");
  // higher uses only the available side; a missing side is never 0.
  assert.equal(baseMonthlyForecast({ method: "higher", monthlyValues: [300, null, 420], mtdProjected: 500 }), 500, "3mo unavailable -> higher = MTD");
  assert.equal(baseMonthlyForecast({ method: "higher", monthlyValues: [300, 360, 420], mtdProjected: null }), 360, "MTD unavailable -> higher = 3mo avg");
  assert.equal(baseMonthlyForecast({ method: "higher", monthlyValues: [null, null, null], mtdProjected: null }), null, "both sides unavailable -> Unavailable");
  // weighted: a positive-weight input that is missing -> Unavailable (never treated as 0).
  assert.equal(baseMonthlyForecast({ method: "weighted", monthlyValues: [300, null, 420], mtdProjected: 500, weights: [25, 25, 25, 25] }), null, "positive weight on a missing month -> Unavailable");
  assert.equal(baseMonthlyForecast({ method: "weighted", monthlyValues: [300, null, 420], mtdProjected: 500, weights: [50, 0, 25, 25] }), Math.round((0.5 * 300 + 0.25 * 420 + 0.25 * 500) * 100) / 100, "a zero-weight missing month is fine");
});

test("13. aggregate fields (total_reserved_quantity / inbound_quantity) are never referenced by the helper", () => {
  // The helper's inputs are the individual components only; passing aggregate-named fields has no effect.
  const r = computePlanRow({ isUS: false, effectiveAsOf: "2026-08-28", daysInCurrentMonth: 31, inventoryAvailable: true, available: 50, total_reserved_quantity: 999, inbound_quantity: 999, monthlyValues: [30, 30, 30], mtdUnits: 28, elapsedCompletedDays: 28, horizon: { kind: "months", months: 1 } });
  assert.equal(r.totalAmazonAwdStock, 50, "aggregate fields are ignored; only components count");
});

/* ===== 14/15/16. AWD US-only ===== */
test("14/15. AWD counts ONLY for a US account with validated evidence; Non-US contributes nothing + shows no columns", () => {
  const us = computePlanRow({ isUS: true, awdValidated: true, awdAvailable: 30, awdInbound: 15, effectiveAsOf: "2026-08-28", daysInCurrentMonth: 31, inventoryAvailable: true, available: 100, monthlyValues: [300, 300, 300], mtdUnits: 280, elapsedCompletedDays: 28, horizon: { kind: "months", months: 2 } });
  assert.equal(us.awdAvailable, 30);
  assert.equal(us.awdInbound, 15);
  // ONLY distributable AWD (awd_available) is usable supply; awd_inbound (inbound TO the AWD warehouse) is NOT yet
  // distributable and is EXCLUDED from every usable/network total (display-only).
  assert.equal(us.totalFbaInventory, 100, "Total FBA Inventory is FBA-only, never includes AWD");
  assert.equal(us.amazonNetworkPosition, 100 + 30, "network position adds distributable AWD only");
  assert.equal(us.totalAmazonAwdStock, 100 + 30, "awd_inbound (15) is NOT added to usable stock");
  const nonUs = computePlanRow({ isUS: false, awdValidated: true, awdAvailable: 30, awdInbound: 15, effectiveAsOf: "2026-08-28", daysInCurrentMonth: 31, inventoryAvailable: true, available: 100, monthlyValues: [300, 300, 300], mtdUnits: 280, elapsedCompletedDays: 28, horizon: { kind: "months", months: 2 } });
  assert.equal(nonUs.awdAvailable, null, "Non-US AWD is Unavailable (null), never 0");
  assert.equal(nonUs.awdInbound, null);
  assert.equal(nonUs.totalAmazonAwdStock, 100, "Non-US AWD never contributes to stock");
  assert.equal(nonUs.amazonNetworkPosition, 100);
});

test("canonical model: one non-overlapping equation; each raw state counted exactly once; AWD-inbound + customer-reserve excluded", () => {
  const r = computePlanRow({
    isUS: true, awdValidated: true, awdAvailable: 7, awdInbound: 99, effectiveAsOf: "2026-08-28", daysInCurrentMonth: 31,
    inventoryAvailable: true, available: 100, customerOrderReserved: 40, reservedFcTransfer: 10, reservedFcProcessing: 5,
    inboundWorking: 20, inboundShipped: 8, inboundReceived: 12, sellerWarehouseQty: 25,
    monthlyValues: [300, 300, 300], mtdUnits: 280, elapsedCompletedDays: 28, horizon: { kind: "months", months: 2 },
  });
  // Buckets are the raw states, each summed once.
  assert.equal(r.reservedFcTotal, 10 + 5);
  assert.equal(r.inboundPipeline, 20 + 8 + 12);
  assert.equal(r.amazonPipeline, r.reservedFcTotal + r.inboundPipeline, "pipeline = reservedFc + inbound, no aggregate reused");
  assert.equal(r.totalFbaInventory, 100 + (10 + 5) + (20 + 8 + 12), "Total FBA Inv = sellable + reservedFc + inbound (no AWD)");
  assert.equal(r.amazonNetworkPosition, r.totalFbaInventory + 7, "+ distributable AWD only (awd_inbound 99 excluded)");
  assert.equal(r.totalNetworkPosition, r.amazonNetworkPosition + 25, "+ seller warehouse");
  // No double count: the disjoint raw components sum to exactly totalFbaInventory; adding customer reserve would over-count.
  const disjoint = r.immediatelyAvailable + r.reservedFcTransfer + r.reservedFcProcessing + r.inboundWorking + r.inboundShipped + r.inboundReceived;
  assert.equal(disjoint, r.totalFbaInventory, "each distinct FBA state counted exactly once");
  assert.notEqual(r.totalFbaInventory, disjoint + r.customerOrderReserved, "customer-order reserve never in the usable total");
  assert.equal(r.amazonNetworkPosition, r.totalAmazonAwdStock, "alias parity");
});

test("16. missing US AWD evidence is Unavailable (null), never a fabricated 0", () => {
  const r = computePlanRow({ isUS: true, awdValidated: false, awdAvailable: null, effectiveAsOf: "2026-08-28", daysInCurrentMonth: 31, inventoryAvailable: true, available: 100, monthlyValues: [300, 300, 300], mtdUnits: 280, elapsedCompletedDays: 28, horizon: { kind: "months", months: 2 } });
  assert.equal(r.awdAvailable, null, "unvalidated US AWD is null, not 0");
});

/* ===== missing inventory => Unavailable, never zero ===== */
test("missing inventory snapshot => every FBA figure is null (Unavailable), never 0; no NaN/Infinity", () => {
  const r = computePlanRow({ isUS: false, effectiveAsOf: "2026-08-28", daysInCurrentMonth: 31, inventoryAvailable: false, monthlyValues: [300, 300, 300], mtdUnits: 280, elapsedCompletedDays: 28, horizon: { kind: "months", months: 2 } });
  assert.equal(r.immediatelyAvailable, null);
  assert.equal(r.amazonPipeline, null);
  assert.equal(r.totalAmazonAwdStock, null);
  assert.equal(r.shortageBeforeWarehouse, null, "no shortage computed without inventory evidence");
  assert.equal(r.estimatedStockoutDate, null);
  assert.equal(r.stockoutReason, "inventory unavailable");
  for (const v of Object.values(r)) assert.ok(v !== Infinity && !(typeof v === "number" && Number.isNaN(v)), "no Infinity/NaN");
});

/* ===== 9. warehouse + shortage + production ===== */
test("9. shortage/ship/production: warehouse covers part of the network shortfall, production is the rest", () => {
  // dailyRunRate = 300/31 ~= 9.677; horizon 2 months from 2026-08-28 -> end 2026-10-28, ~61 days; safety 14 days.
  const r = computePlanRow({
    isUS: false, effectiveAsOf: "2026-08-28", daysInCurrentMonth: 31, inventoryAvailable: true,
    available: 50, reservedFcProcessing: 0, inboundWorking: 0, inboundShipped: 0, inboundReceived: 0, reservedFcTransfer: 0,
    sellerWarehouseQty: 200, monthlyValues: [300, 300, 300], mtdUnits: 0, elapsedCompletedDays: 28,
    horizon: { kind: "months", months: 2 }, safetyDays: 14, forecastMethod: "three-month",
  });
  const dailyRunRate = Math.round((300 / 31) * 1000) / 1000;
  const horizonDays = daysBetween("2026-08-28", addMonthsStr("2026-08-28", 2));
  const horizonDemand = Math.round(dailyRunRate * horizonDays);
  const safety = Math.round(dailyRunRate * 14);
  const target = Math.ceil(horizonDemand + safety);
  assert.equal(r.dailyRunRate, dailyRunRate);
  assert.equal(r.horizonDemand, horizonDemand);
  assert.equal(r.safetyStockUnits, safety);
  assert.equal(r.targetInventory, target);
  const shortage = Math.max(0, target - 50); // amazon network = 50, no pipeline/awd
  assert.equal(r.shortageBeforeWarehouse, shortage);
  assert.equal(r.shipFromSellerWarehouse, Math.min(200, shortage));
  assert.equal(r.productionRequirement, Math.max(0, shortage - 200));
  // estimated stockout = asOf + floor(available / dailyRunRate)
  assert.equal(r.estimatedStockoutDate, addDaysStr("2026-08-28", Math.floor(50 / dailyRunRate)));
});

test("stockout/priority: no demand -> no stockout date + reason; sufficient stock -> OK priority", () => {
  const noDemand = computePlanRow({ isUS: false, effectiveAsOf: "2026-08-28", daysInCurrentMonth: 31, inventoryAvailable: true, available: 100, monthlyValues: [0, 0, 0], mtdUnits: 0, elapsedCompletedDays: 28, horizon: { kind: "months", months: 1 } });
  assert.equal(noDemand.estimatedStockoutDate, null);
  assert.equal(noDemand.stockoutReason, "no recent demand");
  assert.equal(noDemand.dailyRunRate, 0);
  const covered = computePlanRow({ isUS: false, effectiveAsOf: "2026-08-28", daysInCurrentMonth: 31, inventoryAvailable: true, available: 100000, monthlyValues: [300, 300, 300], mtdUnits: 280, elapsedCompletedDays: 28, horizon: { kind: "months", months: 1 }, safetyDays: 14 });
  assert.equal(covered.shortageBeforeWarehouse, 0);
  assert.equal(covered.planningPriority, "OK");
});

test("display: threeMonthAverage requires all three completed months; one missing -> null (never a coerced 0)", () => {
  const full = computePlanRow({ isUS: false, effectiveAsOf: "2026-08-28", daysInCurrentMonth: 31, inventoryAvailable: true, available: 10, monthlyValues: [30, 60, 90], mtdUnits: 10, elapsedCompletedDays: 28, horizon: { kind: "months", months: 1 } });
  assert.equal(full.threeMonthAverage, 60);
  const missing = computePlanRow({ isUS: false, effectiveAsOf: "2026-08-28", daysInCurrentMonth: 31, inventoryAvailable: true, available: 10, monthlyValues: [30, null, 90], mtdUnits: 10, elapsedCompletedDays: 28, horizon: { kind: "months", months: 1 } });
  assert.equal(missing.threeMonthAverage, null);
});

test("customer-order reserve is DISPLAY ONLY: it is surfaced but never in immediatelyAvailable/pipeline/network totals", () => {
  const r = computePlanRow({ isUS: false, effectiveAsOf: "2026-08-28", daysInCurrentMonth: 31, inventoryAvailable: true, available: 100, customerOrderReserved: 40, reservedFcProcessing: 5, inboundWorking: 3, monthlyValues: [30, 30, 30], mtdUnits: 10, elapsedCompletedDays: 28, horizon: { kind: "months", months: 1 } });
  assert.equal(r.customerOrderReserved, 40);
  assert.equal(r.immediatelyAvailable, 100, "sellable = available only");
  assert.equal(r.amazonPipeline, 8, "pipeline = fc_processing + inbound_working; customer reserve excluded");
  assert.equal(r.totalAmazonAwdStock, 108, "customer reserve never counted as usable stock");
});

test("AWD inbound is folded US-only when validated; Non-US and unvalidated stay null (never a fake 0)", () => {
  const us = computePlanRow({ isUS: true, awdValidated: true, effectiveAsOf: "2026-08-28", daysInCurrentMonth: 31, inventoryAvailable: true, available: 10, awdAvailable: 42, awdInbound: 15, monthlyValues: [30, 30, 30], mtdUnits: 10, elapsedCompletedDays: 28, horizon: { kind: "months", months: 1 } });
  assert.equal(us.awdInbound, 15);
  const nonUs = computePlanRow({ isUS: false, awdValidated: false, effectiveAsOf: "2026-08-28", daysInCurrentMonth: 31, inventoryAvailable: true, available: 10, awdAvailable: 42, awdInbound: 15, monthlyValues: [30, 30, 30], mtdUnits: 10, elapsedCompletedDays: 28, horizon: { kind: "months", months: 1 } });
  assert.equal(nonUs.awdInbound, null);
  assert.equal(nonUs.awdAvailable, null);
});

test("seller warehouse is counted EXACTLY ONCE (ship-from-WH + production) and never in FBA/AWD/Amazon totals", () => {
  const r = computePlanRow({ isUS: true, awdValidated: true, awdAvailable: 5, awdInbound: 40, effectiveAsOf: "2026-08-28", daysInCurrentMonth: 31, inventoryAvailable: true, available: 10, reservedFcProcessing: 3, inboundShipped: 2, sellerWarehouseQty: 100, monthlyValues: [300, 300, 300], mtdUnits: 280, elapsedCompletedDays: 28, horizon: { kind: "months", months: 2 }, safetyDays: 0 });
  // Seller WH is NOT part of the Amazon-side inventory/network figures.
  assert.equal(r.totalFbaInventory, 10 + 3 + 2, "FBA inventory excludes seller WH (and AWD)");
  assert.equal(r.amazonNetworkPosition, 10 + 3 + 2 + 5, "Amazon network = FBA + AWD available; no seller WH");
  // It appears ONCE in the total NETWORK position (Amazon network + seller WH).
  assert.equal(r.totalNetworkPosition, r.amazonNetworkPosition + 100);
  // The shortage after the Amazon network is covered by WH first, then production -- WH counted once across the split.
  assert.equal(r.shipFromSellerWarehouse + r.productionRequirement, r.shortageBeforeWarehouse, "ship-from-WH + production == shortage");
  assert.ok(r.shipFromSellerWarehouse <= 100, "cannot ship more than the warehouse holds");
});

test("changing ONLY the seller warehouse quantity never changes any FBA/AWD/Amazon inventory figure", () => {
  const base = { isUS: true, awdValidated: true, awdAvailable: 5, awdInbound: 40, effectiveAsOf: "2026-08-28", daysInCurrentMonth: 31, inventoryAvailable: true, available: 10, reservedFcProcessing: 3, inboundShipped: 2, monthlyValues: [300, 300, 300], mtdUnits: 280, elapsedCompletedDays: 28, horizon: { kind: "months", months: 2 }, safetyDays: 0 };
  const a = computePlanRow({ ...base, sellerWarehouseQty: 0 });
  const b = computePlanRow({ ...base, sellerWarehouseQty: 999 });
  for (const k of ["immediatelyAvailable", "amazonPipeline", "totalFbaInventory", "awdAvailable", "awdInbound", "amazonNetworkPosition"]) {
    assert.equal(a[k], b[k], `seller WH must not change ${k}`);
  }
  assert.notEqual(a.totalNetworkPosition, b.totalNetworkPosition, "only the network position (which includes WH) moves");
});

let failures = 0;
for (const t of tests) {
  try { t.fn(); passed += 1; out("  ok  " + t.name); }
  catch (e) { failures += 1; out("FAIL  " + t.name); out(String((e && e.stack) || e)); }
}
out("\n" + passed + " assertions passed" + (failures ? ", " + failures + " FAILED" : ""));
if (failures) process.exitCode = 1;
