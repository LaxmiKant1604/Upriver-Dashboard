// SKU MOVEMENT core -- deterministic OFFLINE proof of the dynamic date/month windows, the central movement-status
// thresholds, the per-(account,ASIN,SKU) aggregation, brand isolation (canonical brandKey, Unmapped excluded from a
// named brand, no All-Brands fallback), and the durable OLI units policy (rollup units, no double count, no
// fabrication, covered=0 vs uncovered=null). ZERO DataDoe. 7-bit ASCII.
import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { skuMovementPayload, skuMovementRows, skuMovementDateWindows, movementStatus, movementPercent, catalogAsinMap, MOVEMENT_THRESHOLDS } from "../lib/server/reports/sku-movement-core.js";

let passed = 0;
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };
const test = (name, fn) => { try { fn(); passed += 1; out("  ok  " + name); } catch (e) { out("FAIL  " + name); out(String(e && e.stack ? e.stack : e)); process.exitCode = 1; } };

const CAT = [
  { child_asin: "B0A", product_brand: "Caruso Italy", product_name: "Widget A" },
  { child_asin: "B0B", product_brand: "Bolt", product_name: "Bolt B" },
  { child_asin: "B0C", product_brand: "Caruso-Italy", product_name: "Hyphen C" }, // distinct brand (punctuation)
];
const oli = (o) => ({ currency: "USD", units: 1, ...o });

/* ===== DATE / MONTH WINDOWS (dynamic, UTC, rollover, leap) ===== */
test("10/6. three completed months + MTD label are derived from effectiveAsOf (never hard-coded)", () => {
  const w = skuMovementDateWindows("2026-08-15");
  assert.deepEqual(w.completedMonths.map((m) => m.label), ["May '26", "Jun '26", "Jul '26"]);
  assert.deepEqual([w.completedMonths[0].from, w.completedMonths[0].to], ["2026-05-01", "2026-05-31"]);
  assert.deepEqual([w.completedMonths[2].from, w.completedMonths[2].to], ["2026-07-01", "2026-07-31"]);
  assert.equal(w.mtd.label, "Aug '26 MTD");
  assert.deepEqual([w.mtd.from, w.mtd.to, w.mtd.daysElapsed, w.mtd.daysInMonth], ["2026-08-01", "2026-08-15", 15, 31]);
});
test("12. latest five individual dates + previous five are exact + contiguous (ascending, ending at D-1)", () => {
  const w = skuMovementDateWindows("2026-08-15");
  assert.deepEqual(w.last5Dates, ["2026-08-11", "2026-08-12", "2026-08-13", "2026-08-14", "2026-08-15"]);
  assert.deepEqual(w.prev5Dates, ["2026-08-06", "2026-08-07", "2026-08-08", "2026-08-09", "2026-08-10"]);
});
test("15. month-end rollover: the first day of a new month rolls the completed-month set forward", () => {
  const aug31 = skuMovementDateWindows("2026-08-31");
  assert.deepEqual(aug31.completedMonths.map((m) => m.label), ["May '26", "Jun '26", "Jul '26"]);
  assert.equal(aug31.mtd.daysElapsed, 31);
  const sep1 = skuMovementDateWindows("2026-09-01");
  assert.deepEqual(sep1.completedMonths.map((m) => m.label), ["Jun '26", "Jul '26", "Aug '26"], "Aug becomes the newest completed month; May drops off");
  assert.equal(sep1.mtd.label, "Sep '26 MTD");
  assert.equal(sep1.mtd.daysElapsed, 1);
});
test("16. December -> January rollover crosses the year correctly", () => {
  const jan10 = skuMovementDateWindows("2027-01-10");
  assert.deepEqual(jan10.completedMonths.map((m) => m.label), ["Oct '26", "Nov '26", "Dec '26"]);
  assert.equal(jan10.mtd.label, "Jan '27 MTD");
  assert.deepEqual([jan10.completedMonths[2].from, jan10.completedMonths[2].to], ["2026-12-01", "2026-12-31"]);
});
test("17. leap-year February (2028) has 29 days; a MTD in Feb reports 29 days-in-month", () => {
  const feb = skuMovementDateWindows("2028-02-10");
  const febMonth = skuMovementDateWindows("2028-03-05").completedMonths.find((m) => m.key === "2028-02");
  assert.equal(febMonth.to, "2028-02-29", "leap Feb ends on the 29th");
  assert.equal(feb.mtd.daysInMonth, 29);
  const nonLeap = skuMovementDateWindows("2026-03-05").completedMonths.find((m) => m.key === "2026-02");
  assert.equal(nonLeap.to, "2026-02-28", "non-leap Feb ends on the 28th");
});
test("18. a LAGGING effectiveAsOf (earlier than D-1) computes honest windows through that date", () => {
  const w = skuMovementDateWindows("2026-08-09");
  assert.equal(w.mtd.to, "2026-08-09");
  assert.equal(w.mtd.daysElapsed, 9);
  assert.deepEqual(w.last5Dates, ["2026-08-05", "2026-08-06", "2026-08-07", "2026-08-08", "2026-08-09"]);
});

/* ===== MOVEMENT STATUS (central thresholds) ===== */
test("14. every status: New / Rising / Stable / Declining / Dormant / No Data via the central thresholds", () => {
  assert.equal(movementStatus({ last5Units: 5, prev5Units: 0, monthsTotalUnits: 0, mtdUnits: 5 }), "New");
  assert.equal(movementStatus({ last5Units: 15, prev5Units: 10, monthsTotalUnits: 50 }), "Rising"); // +50% > +20
  assert.equal(movementStatus({ last5Units: 12, prev5Units: 10, monthsTotalUnits: 50 }), "Stable"); // +20% not strictly >20
  assert.equal(movementStatus({ last5Units: 7, prev5Units: 10, monthsTotalUnits: 50 }), "Declining"); // -30% < -20
  assert.equal(movementStatus({ last5Units: 0, prev5Units: 0, monthsTotalUnits: 50 }), "Dormant"); // history, no recent
  assert.equal(movementStatus({ last5Units: 0, prev5Units: 0, monthsTotalUnits: 0, mtdUnits: 0 }), "No Data");
  assert.equal(MOVEMENT_THRESHOLDS.RISING_PCT, 20);
  assert.equal(MOVEMENT_THRESHOLDS.DECLINING_PCT, -20);
});
test("13. movement% = ((last5 - prev5)/prev5)*100; null when there is no prior baseline (em dash)", () => {
  assert.equal(movementPercent(15, 10), 50);
  assert.equal(movementPercent(5, 10), -50);
  assert.equal(movementPercent(9, 0), null, "no baseline -> undefined percentage");
  assert.equal(movementPercent(0, 0), null);
  // status still classifies a no-baseline active SKU with history as Rising
  assert.equal(movementStatus({ last5Units: 9, prev5Units: 0, monthsTotalUnits: 40 }), "Rising");
});

/* ===== AGGREGATION + ISOLATION ===== */
const D = "2026-08-15";
test("3. ALL brands includes EVERY eligible ASIN/SKU incl. honestly-unmapped, never assigned to another brand", () => {
  const rows = skuMovementRows({ oliRows: [oli({ sale_date: D, child_asin: "B0A", sku: "S1" }), oli({ sale_date: D, child_asin: "B0Z", sku: "S9" })], catalogRows: CAT, effectiveAsOf: D, brand: "ALL" });
  assert.equal(rows.length, 2);
  assert.equal(rows.find((r) => r.asin === "B0A").brand, "Caruso Italy");
  assert.equal(rows.find((r) => r.asin === "B0Z").brand, "Unmapped", "an ASIN absent from Catalog is Unmapped, never another brand");
});
test("4/6. a specific brand includes ONLY Catalog-proven matching ASINs; Unmapped is excluded", () => {
  const rows = skuMovementRows({ oliRows: [oli({ sale_date: D, child_asin: "B0A", sku: "S1" }), oli({ sale_date: D, child_asin: "B0Z", sku: "S9" }), oli({ sale_date: D, child_asin: "B0B", sku: "S2" })], catalogRows: CAT, effectiveAsOf: D, brand: "Caruso Italy" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].asin, "B0A");
  assert.ok(!rows.some((r) => r.brand === "Unmapped"), "Unmapped never appears in a named-brand result");
  assert.ok(!rows.some((r) => r.asin === "B0B"), "another brand's ASIN never appears");
});
test("7. canonical brandKey matches case/whitespace variants; punctuation stays DISTINCT", () => {
  const rowsA = skuMovementRows({ oliRows: [oli({ sale_date: D, child_asin: "B0A", sku: "S1" })], catalogRows: CAT, effectiveAsOf: D, brand: "  caruso   ITALY " });
  assert.equal(rowsA.length, 1, "'  caruso   ITALY ' matches 'Caruso Italy'");
  const rowsHyphen = skuMovementRows({ oliRows: [oli({ sale_date: D, child_asin: "B0A", sku: "S1" }), oli({ sale_date: D, child_asin: "B0C", sku: "S3" })], catalogRows: CAT, effectiveAsOf: D, brand: "Caruso-Italy" });
  assert.equal(rowsHyphen.length, 1);
  assert.equal(rowsHyphen[0].asin, "B0C", "'Caruso-Italy' (hyphen) is a DISTINCT brand from 'Caruso Italy'");
});
test("5/8. a named brand with no matching sales is a VALID EMPTY report, never an All-Brands fallback", () => {
  const oliRows = [oli({ sale_date: D, child_asin: "B0A", sku: "S1" }), oli({ sale_date: D, child_asin: "B0Z", sku: "S9" })];
  const p = skuMovementPayload({ oliRows, catalogRows: CAT, effectiveAsOf: D, brand: "Bolt" });
  assert.equal(p.rows.length, 0, "empty, not the All-Brands rows");
  assert.equal(p.brandFiltered, true);
  assert.equal(p.brand, "Bolt");
});
test("11. MTD sums ONLY dates in [first-of-month, effectiveAsOf]; earlier-month dates never leak into MTD", () => {
  const rows = skuMovementRows({ oliRows: [oli({ sale_date: "2026-08-15", child_asin: "B0A", sku: "S1", units: 3 }), oli({ sale_date: "2026-08-01", child_asin: "B0A", sku: "S1", units: 2 }), oli({ sale_date: "2026-07-31", child_asin: "B0A", sku: "S1", units: 99 })], catalogRows: CAT, effectiveAsOf: D, brand: "ALL", coverageFrom: "2026-05-01" });
  assert.equal(rows[0].mtdUnits, 5, "3 + 2 in Aug; the Jul 31 unit is NOT MTD");
  assert.equal(rows[0].months.find((m) => m.key === "2026-07").units, 99, "the Jul 31 unit lands in the Jul completed month");
});
test("23. no double count: multiple currency / dimensional rows for the same (asin,sku,date) SUM once", () => {
  const rows = skuMovementRows({ oliRows: [oli({ sale_date: D, child_asin: "B0A", sku: "S1", currency: "USD", units: 2 }), oli({ sale_date: D, child_asin: "B0A", sku: "S1", currency: "EUR", units: 3 })], catalogRows: CAT, effectiveAsOf: D, brand: "ALL" });
  assert.equal(rows.length, 1, "one (asin,sku) row");
  assert.equal(rows[0].last5Total, 5, "2 + 3 summed, not duplicated into two rows");
});
test("13b. Last-5 vs Previous-5 totals + per-date columns are exact", () => {
  const oliRows = [
    oli({ sale_date: "2026-08-15", child_asin: "B0A", sku: "S1", units: 4 }),
    oli({ sale_date: "2026-08-11", child_asin: "B0A", sku: "S1", units: 6 }),
    oli({ sale_date: "2026-08-08", child_asin: "B0A", sku: "S1", units: 5 }), // in prev5
    oli({ sale_date: "2026-08-06", child_asin: "B0A", sku: "S1", units: 5 }), // in prev5
  ];
  const r = skuMovementRows({ oliRows, catalogRows: CAT, effectiveAsOf: D, brand: "ALL" })[0];
  assert.equal(r.last5Total, 10); assert.equal(r.prev5Total, 10);
  assert.equal(r.movementPercent, 0);
  assert.equal(r.last5Dates.find((d) => d.date === "2026-08-15").units, 4);
  assert.equal(r.last5Dates.find((d) => d.date === "2026-08-12").units, 0, "a covered date with no sale is an honest 0");
});
test("22. a completed month ENTIRELY before coverage is UNAVAILABLE (null), never a fabricated 0", () => {
  const rows = skuMovementRows({ oliRows: [oli({ sale_date: "2026-07-10", child_asin: "B0A", sku: "S1", units: 8 })], catalogRows: CAT, effectiveAsOf: D, brand: "ALL", coverageFrom: "2026-07-01" });
  const r = rows[0];
  assert.equal(r.months.find((m) => m.key === "2026-05").units, null, "May is before coverage -> unavailable");
  assert.equal(r.months.find((m) => m.key === "2026-06").units, null, "Jun is before coverage -> unavailable");
  assert.equal(r.months.find((m) => m.key === "2026-07").units, 8, "Jul is covered -> real units");
  assert.equal(r.avgMonthlyUnits, 8, "average is over AVAILABLE months only (never divides by unavailable months)");
});
test("14b/15b/16b (derived): run rate + projection from MTD; avg over available months", () => {
  const oliRows = [oli({ sale_date: "2026-08-15", child_asin: "B0A", sku: "S1", units: 30 })]; // 30 units over 15 days
  const r = skuMovementRows({ oliRows, catalogRows: CAT, effectiveAsOf: D, brand: "ALL", coverageFrom: "2026-05-01" })[0];
  assert.equal(r.mtdRunRate, 2, "30 units / 15 days elapsed");
  assert.equal(r.projectedUnits, 62, "2/day * 31 days in Aug");
});
test("19/20/21. units come from the durable rollup (cancelled/explicit-zero/pending already excluded); never fabricated", () => {
  // The daily rollup passed in already reflects the OLI contribution rules -- the core sums rollup.units verbatim and
  // invents nothing. A date present with 0 rollup units contributes 0; an absent (uncovered) date is null, not 0.
  const rows = skuMovementRows({ oliRows: [oli({ sale_date: D, child_asin: "B0A", sku: "S1", units: 0 })], catalogRows: CAT, effectiveAsOf: D, brand: "ALL" });
  assert.equal(rows[0].last5Total, 0, "an explicit-zero rollup row contributes 0, never a fabricated positive");
  const noRows = skuMovementRows({ oliRows: [], catalogRows: CAT, effectiveAsOf: D, brand: "ALL" });
  assert.equal(noRows.length, 0, "no OLI evidence -> no fabricated rows");
});
test("1. account isolation: the core aggregates ONLY the rows it is given (the reader supplies one account's rows)", () => {
  // The serve/reader layer supplies exactly one account's durable rows; the core never reaches back for more.
  const rows = skuMovementRows({ oliRows: [oli({ sale_date: D, child_asin: "B0A", sku: "S1", units: 7 })], catalogRows: CAT, effectiveAsOf: D, brand: "ALL" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].last5Total, 7);
});
test("26. the payload is brand-scoped end to end (what CSV/export serialize): brand + brandFiltered + dynamic labels", () => {
  const p = skuMovementPayload({ oliRows: [oli({ sale_date: D, child_asin: "B0A", sku: "S1" })], catalogRows: CAT, effectiveAsOf: D, brand: "Caruso Italy" });
  assert.equal(p.brand, "Caruso Italy"); assert.equal(p.brandFiltered, true);
  assert.deepEqual(p.monthLabels, ["May '26", "Jun '26", "Jul '26"]);
  assert.equal(p.mtdLabel, "Aug '26 MTD");
  assert.equal(p.rows.length, 1);
});
test("catalogAsinMap: first catalog row per ASIN wins; blank brand -> Unmapped (null key)", () => {
  const m = catalogAsinMap([{ child_asin: "b0a", product_brand: "  Foo  Bar ", product_name: "P" }, { child_asin: "B0A", product_brand: "Other" }, { child_asin: "B0X", product_brand: "  " }]);
  assert.equal(m.get("B0A").brandKey, "foo bar");
  assert.equal(m.get("B0A").brandDisplay, "Foo Bar");
  assert.equal(m.get("B0X").brandKey, null, "blank brand -> unmapped");
});

out("\n" + passed + " assertions passed");
