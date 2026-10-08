// FBA Shipment Plan PLANNING helpers -- pure, offline regressions for the configurable planner. Proves horizons,
// calendar-aware windows, the unchanged current-month MTD projection, every forecast method + weight validation, the
// LISTINGS inventory model (Supply = FBA Available + FBA Inbound; Reserved (Total) + FC Transfer display only; AWD only
// when validated), "missing is never a fabricated 0", and the shortage/ship/production/stockout outputs. 7-bit ASCII, LF.

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

/* ===== 11/12/13. the Listings inventory model (Listings inventory cutover) ===== */
test("11/12. Supply = FBA Available + FBA Inbound; FBA Reserved (Total) + FC Transfer are DISPLAY ONLY (never counted)", () => {
  const r = computePlanRow({
    isUS: false, effectiveAsOf: "2026-08-28", daysInCurrentMonth: 31, inventoryAvailable: true,
    available: 100, fbaInbound: 40, fbaReservedTotal: 25, fbaFcTransfer: 15,
    monthlyValues: [300, 300, 300], mtdUnits: 280, elapsedCompletedDays: 28,
    horizon: { kind: "months", months: 2 }, safetyDays: 14, forecastMethod: "three-month",
  });
  assert.equal(r.immediatelyAvailable, 100);
  assert.equal(r.fbaInbound, 40);
  assert.equal(r.fbaReservedTotal, 25, "reserved is surfaced for display");
  assert.equal(r.fbaFcTransfer, 15, "FC transfer is surfaced for display");
  assert.equal(r.fbaSupply, 140, "supply = available + inbound only");
  assert.equal(r.totalAmazonAwdStock, 140, "no AWD (non-AWD marketplace); reserved + FC transfer never added");
  assert.notEqual(r.totalAmazonAwdStock, 140 + 25, "reserved is never supply");
  assert.notEqual(r.totalAmazonAwdStock, 140 + 15, "FC transfer is never supply (non-overlap not proven beyond the canary)");
  for (const k of ["customerOrderReserved", "reservedFcTotal", "inboundPipeline", "amazonPipeline", "totalFbaInventory"]) assert.ok(!(k in r), `retired Health field ${k} is gone`);
});

test("an UNKNOWN FBA Inbound (or Available) makes supply / network / shortage null and priority Unknown -- never 0 / never OK", () => {
  const r = computePlanRow({ isUS: false, effectiveAsOf: "2026-08-28", daysInCurrentMonth: 31, inventoryAvailable: true, available: 50, fbaInbound: null, monthlyValues: [30, 30, 30], mtdUnits: 28, elapsedCompletedDays: 28, horizon: { kind: "months", months: 1 } });
  assert.equal(r.immediatelyAvailable, 50, "the known Available still shows");
  assert.equal(r.fbaSupply, null);
  assert.equal(r.amazonNetworkPosition, null);
  assert.equal(r.shortageBeforeWarehouse, null);
  assert.equal(r.productionRequirement, null);
  assert.equal(r.planningPriority, "Unknown", "an unknown shortage is never reported as OK");
  assert.ok(r.estimatedStockoutDate !== null, "the stockout date only needs Available + demand");
});

test("13. fields that are not Listings inputs (Health aggregates, supply_at_fba) are never referenced by the helper", () => {
  const r = computePlanRow({ isUS: false, effectiveAsOf: "2026-08-28", daysInCurrentMonth: 31, inventoryAvailable: true, available: 50, fbaInbound: 0, total_reserved_quantity: 999, inbound_quantity: 999, fba_inventory_supply_at_fba: 999, reservedFcTransfer: 999, inboundShipped: 999, monthlyValues: [30, 30, 30], mtdUnits: 28, elapsedCompletedDays: 28, horizon: { kind: "months", months: 1 } });
  assert.equal(r.totalAmazonAwdStock, 50, "non-input fields are ignored; only Available + Inbound count");
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

/* ===== 14/15/16. AWD US-only ===== */
test("14/15. AWD counts for ANY validated marketplace (US + EU5); an UNVALIDATED account contributes nothing (null, never 0)", () => {
  const us = computePlanRow({ isUS: true, awdValidated: true, awdAvailable: 30, awdInbound: 15, effectiveAsOf: "2026-08-28", daysInCurrentMonth: 31, inventoryAvailable: true, available: 100, fbaInbound: 0, monthlyValues: [300, 300, 300], mtdUnits: 280, elapsedCompletedDays: 28, horizon: { kind: "months", months: 2 } });
  assert.equal(us.awdAvailable, 30);
  assert.equal(us.awdInbound, 15);
  // ONLY distributable AWD (awd_available) is usable supply; awd_inbound (inbound TO the AWD warehouse) is NOT yet
  // distributable and is EXCLUDED from every usable/network total (display-only).
  assert.equal(us.fbaSupply, 100, "FBA Supply is FBA-only, never includes AWD");
  assert.equal(us.amazonNetworkPosition, 100 + 30, "network position adds distributable AWD only");
  assert.equal(us.totalAmazonAwdStock, 100 + 30, "awd_inbound (15) is NOT added to usable stock");
  // A VALIDATED European account (isUS false, awdValidated true) counts AWD IDENTICALLY -- the caller encodes the
  // marketplace eligibility (US + EU5) in awdValidated, so European AWD flows through the SAME (unchanged) formulas.
  const eu = computePlanRow({ isUS: false, awdValidated: true, awdAvailable: 30, awdInbound: 15, effectiveAsOf: "2026-08-28", daysInCurrentMonth: 31, inventoryAvailable: true, available: 100, fbaInbound: 0, monthlyValues: [300, 300, 300], mtdUnits: 280, elapsedCompletedDays: 28, horizon: { kind: "months", months: 2 } });
  assert.equal(eu.awdAvailable, 30, "European (validated) AWD is counted, exactly like US");
  assert.equal(eu.fbaSupply, 100, "European FBA Supply still excludes AWD (no double count)");
  assert.equal(eu.amazonNetworkPosition, 130);
  assert.equal(eu.totalAmazonAwdStock, 130);
  // An UNVALIDATED account (a non-AWD marketplace, or a missing/failed source) contributes nothing: null, never 0.
  const unval = computePlanRow({ isUS: false, awdValidated: false, awdAvailable: null, awdInbound: null, effectiveAsOf: "2026-08-28", daysInCurrentMonth: 31, inventoryAvailable: true, available: 100, fbaInbound: 0, monthlyValues: [300, 300, 300], mtdUnits: 280, elapsedCompletedDays: 28, horizon: { kind: "months", months: 2 } });
  assert.equal(unval.awdAvailable, null, "unvalidated AWD is Unavailable (null), never 0");
  assert.equal(unval.awdInbound, null);
  assert.equal(unval.totalAmazonAwdStock, 100, "unvalidated AWD never contributes to stock");
  assert.equal(unval.amazonNetworkPosition, 100);
  // VALIDATED AWD but THIS ASIN's AWD unknown -> the network position is unknown (null), never FBA-only presented as complete.
  const awdUnknown = computePlanRow({ isUS: true, awdValidated: true, awdAvailable: null, effectiveAsOf: "2026-08-28", daysInCurrentMonth: 31, inventoryAvailable: true, available: 100, fbaInbound: 0, monthlyValues: [300, 300, 300], mtdUnits: 280, elapsedCompletedDays: 28, horizon: { kind: "months", months: 2 } });
  assert.equal(awdUnknown.fbaSupply, 100);
  assert.equal(awdUnknown.amazonNetworkPosition, null, "validated AWD + unknown ASIN AWD -> network Unavailable");
});

test("canonical model: Supply = Available + Inbound; network = Supply + AWD Available; AWD inbound / reserved / FC transfer excluded", () => {
  const r = computePlanRow({
    isUS: true, awdValidated: true, awdAvailable: 7, awdInbound: 99, effectiveAsOf: "2026-08-28", daysInCurrentMonth: 31,
    inventoryAvailable: true, available: 100, fbaInbound: 40, fbaReservedTotal: 30, fbaFcTransfer: 10, sellerWarehouseQty: 25,
    monthlyValues: [300, 300, 300], mtdUnits: 280, elapsedCompletedDays: 28, horizon: { kind: "months", months: 2 },
  });
  assert.equal(r.fbaSupply, 100 + 40, "FBA Supply = sellable + inbound (no AWD, no reserved, no FC transfer)");
  assert.equal(r.amazonNetworkPosition, r.fbaSupply + 7, "+ distributable AWD only (awd_inbound 99 excluded)");
  assert.equal(r.totalNetworkPosition, r.amazonNetworkPosition + 25, "+ seller warehouse");
  assert.equal(r.amazonNetworkPosition, r.totalAmazonAwdStock, "alias parity");
});

test("16. missing US AWD evidence is Unavailable (null), never a fabricated 0", () => {
  const r = computePlanRow({ isUS: true, awdValidated: false, awdAvailable: null, effectiveAsOf: "2026-08-28", daysInCurrentMonth: 31, inventoryAvailable: true, available: 100, monthlyValues: [300, 300, 300], mtdUnits: 280, elapsedCompletedDays: 28, horizon: { kind: "months", months: 2 } });
  assert.equal(r.awdAvailable, null, "unvalidated US AWD is null, not 0");
});

/* ===== missing inventory => Unavailable, never zero ===== */
test("missing inventory snapshot => every FBA figure is null (Unavailable), never 0; no NaN/Infinity", () => {
  const r = computePlanRow({ isUS: false, effectiveAsOf: "2026-08-28", daysInCurrentMonth: 31, inventoryAvailable: false, available: 5, fbaInbound: 5, monthlyValues: [300, 300, 300], mtdUnits: 280, elapsedCompletedDays: 28, horizon: { kind: "months", months: 2 } });
  assert.equal(r.immediatelyAvailable, null);
  assert.equal(r.fbaInbound, null);
  assert.equal(r.fbaSupply, null);
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
    available: 50, fbaInbound: 0, fbaReservedTotal: 0, fbaFcTransfer: 0,
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
  const shortage = Math.max(0, target - 50); // amazon network = 50 (available 50 + inbound 0), no AWD
  assert.equal(r.shortageBeforeWarehouse, shortage);
  assert.equal(r.shipFromSellerWarehouse, Math.min(200, shortage));
  assert.equal(r.productionRequirement, Math.max(0, shortage - 200));
  // estimated stockout = asOf + floor(available / dailyRunRate)
  assert.equal(r.estimatedStockoutDate, addDaysStr("2026-08-28", Math.floor(50 / dailyRunRate)));
});

test("stockout/priority: no demand -> no stockout date + reason; sufficient stock -> OK priority", () => {
  const noDemand = computePlanRow({ isUS: false, effectiveAsOf: "2026-08-28", daysInCurrentMonth: 31, inventoryAvailable: true, available: 100, fbaInbound: 0, monthlyValues: [0, 0, 0], mtdUnits: 0, elapsedCompletedDays: 28, horizon: { kind: "months", months: 1 } });
  assert.equal(noDemand.estimatedStockoutDate, null);
  assert.equal(noDemand.stockoutReason, "no recent demand");
  assert.equal(noDemand.dailyRunRate, 0);
  const covered = computePlanRow({ isUS: false, effectiveAsOf: "2026-08-28", daysInCurrentMonth: 31, inventoryAvailable: true, available: 100000, fbaInbound: 0, monthlyValues: [300, 300, 300], mtdUnits: 280, elapsedCompletedDays: 28, horizon: { kind: "months", months: 1 }, safetyDays: 14 });
  assert.equal(covered.shortageBeforeWarehouse, 0);
  assert.equal(covered.planningPriority, "OK");
});

test("display: threeMonthAverage requires all three completed months; one missing -> null (never a coerced 0)", () => {
  const full = computePlanRow({ isUS: false, effectiveAsOf: "2026-08-28", daysInCurrentMonth: 31, inventoryAvailable: true, available: 10, monthlyValues: [30, 60, 90], mtdUnits: 10, elapsedCompletedDays: 28, horizon: { kind: "months", months: 1 } });
  assert.equal(full.threeMonthAverage, 60);
  const missing = computePlanRow({ isUS: false, effectiveAsOf: "2026-08-28", daysInCurrentMonth: 31, inventoryAvailable: true, available: 10, monthlyValues: [30, null, 90], mtdUnits: 10, elapsedCompletedDays: 28, horizon: { kind: "months", months: 1 } });
  assert.equal(missing.threeMonthAverage, null);
});

test("merchant-fulfilled-only product (fbaContext mfn-only): no FBA figures, no stockout date, an explicit reason", () => {
  const r = computePlanRow({ isUS: false, effectiveAsOf: "2026-08-28", daysInCurrentMonth: 31, inventoryAvailable: true, available: null, fbaInbound: null, fbaContext: "mfn-only", monthlyValues: [30, 30, 30], mtdUnits: 10, elapsedCompletedDays: 28, horizon: { kind: "months", months: 1 } });
  assert.equal(r.fbaContext, "mfn-only");
  assert.equal(r.immediatelyAvailable, null);
  assert.equal(r.estimatedStockoutDate, null, "an MFN-only product is never an FBA stockout");
  assert.match(r.stockoutReason, /merchant-fulfilled/);
  assert.equal(r.planningPriority, "Unknown");
});

test("AWD inbound is folded US-only when validated; Non-US and unvalidated stay null (never a fake 0)", () => {
  const us = computePlanRow({ isUS: true, awdValidated: true, effectiveAsOf: "2026-08-28", daysInCurrentMonth: 31, inventoryAvailable: true, available: 10, awdAvailable: 42, awdInbound: 15, monthlyValues: [30, 30, 30], mtdUnits: 10, elapsedCompletedDays: 28, horizon: { kind: "months", months: 1 } });
  assert.equal(us.awdInbound, 15);
  const nonUs = computePlanRow({ isUS: false, awdValidated: false, effectiveAsOf: "2026-08-28", daysInCurrentMonth: 31, inventoryAvailable: true, available: 10, awdAvailable: 42, awdInbound: 15, monthlyValues: [30, 30, 30], mtdUnits: 10, elapsedCompletedDays: 28, horizon: { kind: "months", months: 1 } });
  assert.equal(nonUs.awdInbound, null);
  assert.equal(nonUs.awdAvailable, null);
});

test("seller warehouse is counted EXACTLY ONCE (ship-from-WH + production) and never in FBA/AWD/Amazon totals", () => {
  const r = computePlanRow({ isUS: true, awdValidated: true, awdAvailable: 5, awdInbound: 40, effectiveAsOf: "2026-08-28", daysInCurrentMonth: 31, inventoryAvailable: true, available: 10, fbaInbound: 5, fbaReservedTotal: 3, sellerWarehouseQty: 100, monthlyValues: [300, 300, 300], mtdUnits: 280, elapsedCompletedDays: 28, horizon: { kind: "months", months: 2 }, safetyDays: 0 });
  // Seller WH is NOT part of the Amazon-side inventory/network figures.
  assert.equal(r.fbaSupply, 10 + 5, "FBA Supply excludes seller WH (and AWD, reserved)");
  assert.equal(r.amazonNetworkPosition, 10 + 5 + 5, "Amazon network = FBA Supply + AWD available; no seller WH");
  // It appears ONCE in the total NETWORK position (Amazon network + seller WH).
  assert.equal(r.totalNetworkPosition, r.amazonNetworkPosition + 100);
  // The shortage after the Amazon network is covered by WH first, then production -- WH counted once across the split.
  assert.equal(r.shipFromSellerWarehouse + r.productionRequirement, r.shortageBeforeWarehouse, "ship-from-WH + production == shortage");
  assert.ok(r.shipFromSellerWarehouse <= 100, "cannot ship more than the warehouse holds");
});

test("changing ONLY the seller warehouse quantity never changes any FBA/AWD/Amazon inventory figure", () => {
  const base = { isUS: true, awdValidated: true, awdAvailable: 5, awdInbound: 40, effectiveAsOf: "2026-08-28", daysInCurrentMonth: 31, inventoryAvailable: true, available: 10, fbaInbound: 5, fbaReservedTotal: 3, monthlyValues: [300, 300, 300], mtdUnits: 280, elapsedCompletedDays: 28, horizon: { kind: "months", months: 2 }, safetyDays: 0 };
  const a = computePlanRow({ ...base, sellerWarehouseQty: 0 });
  const b = computePlanRow({ ...base, sellerWarehouseQty: 999 });
  for (const k of ["immediatelyAvailable", "fbaInbound", "fbaSupply", "awdAvailable", "awdInbound", "amazonNetworkPosition"]) {
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
