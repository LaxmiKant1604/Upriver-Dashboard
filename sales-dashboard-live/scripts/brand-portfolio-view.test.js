// Brand Portfolio view-helper regressions (offline, pure).
//
// Covers the three review corrections:
//   1. portfolioKpis: FBA Inventory + FBA Cover available in Original multi-currency
//      from the real overall inventory total; money stays combined-unavailable;
//      missing inventory evidence is an em dash (null), never zero.
//   2. orderStatusItems: deterministic severity order (error > warning > success >
//      info/busy), stable within a tier, nothing dropped.
//
// 7-bit ASCII, LF, no top-level await.

import assert from "node:assert/strict";
import { writeSync } from "node:fs";

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const group = (label) => tests.push({ marker: label });
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };

let VIEW;

// A single converted (or single-currency) group.
const singleCountry = () => ({
  dailyGroups: [{ currency: "USD", fbaAvailable: 15852, units: 210, totals: { sales: 9724, lySales: 11286, adSpend: 85.67 }, rows: [{ coverUnits: 150 }, { coverUnits: 60 }] }],
  daily: { inventoryScope: "country", inventoryAccountTotal: null, selectedRangeDays: 30 },
  totalUnits: 210,
});
// Two currency groups (Original multi-currency) with per-country inventory.
const multiCountry = () => ({
  dailyGroups: [
    { currency: "EUR", fbaAvailable: 12000, units: 180, totals: { sales: 8000, lySales: 9000, adSpend: 50 }, rows: [{ coverUnits: 120 }, { coverUnits: 60 }] },
    { currency: "GBP", fbaAvailable: 3852, units: 30, totals: { sales: 800, lySales: 700, adSpend: 5 }, rows: [{ coverUnits: 30 }] },
  ],
  daily: { inventoryScope: "country", inventoryAccountTotal: null, selectedRangeDays: 30 },
  totalUnits: 210,
});

async function main() {
  VIEW = await import("../src/lib/brand-portfolio-view.js");
  let failures = 0;
  for (const t of tests) {
    if (t.marker) { out("-- " + t.marker); continue; }
    try { await t.fn(); passed += 1; out("  ok  " + t.name); }
    catch (err) { failures += 1; out("FAIL  " + t.name); out(String(err && err.stack ? err.stack : err)); }
  }
  out("\nbrand-portfolio-view: " + passed + " assertions passed");
  return failures;
}

/* ---------------------------------------------------------------- portfolioKpis */
group("portfolioKpis: FBA available across currencies; money combined only in one group");

test("converted / single group is unchanged (all six KPIs present)", () => {
  const k = VIEW.portfolioKpis(singleCountry());
  assert.equal(k.single, true);
  assert.equal(k.currency, "USD");
  assert.equal(k.sales, 9724);
  assert.equal(k.ly, 11286);
  assert.equal(k.adSpend, 85.67);
  assert.equal(k.units, 210);
  assert.equal(k.fba, 15852);
  assert.equal(Math.round(k.cover), 2265); // 15852 / (210/30)
  assert.notEqual(k.tacos, null);
  assert.ok(Math.abs(k.lyDelta - (9724 - 11286) / 11286) < 1e-9);
});

test("single group with account-level inventory uses the overall total (unchanged)", () => {
  const t = singleCountry();
  t.dailyGroups[0].fbaAvailable = null;
  t.daily = { inventoryScope: "account", inventoryAccountTotal: 15852, selectedRangeDays: 30 };
  const k = VIEW.portfolioKpis(t);
  assert.equal(k.fba, 15852);
  assert.equal(k.sales, 9724);
});

test("Original multi-currency: combined money (sales/LY/ads/TACoS) is unavailable", () => {
  const k = VIEW.portfolioKpis(multiCountry());
  assert.equal(k.single, false);
  assert.equal(k.currency, null);
  assert.equal(k.sales, null);
  assert.equal(k.ly, null);
  assert.equal(k.lyDelta, null);
  assert.equal(k.adSpend, null);
  assert.equal(k.tacos, null);
});

test("Original multi-currency: Units, FBA Inventory and FBA Cover stay available", () => {
  const k = VIEW.portfolioKpis(multiCountry());
  assert.equal(k.units, 210);
  assert.equal(k.fba, 15852, "overall FBA = 12000 + 3852 across currency groups");
  assert.equal(Math.round(k.cover), 2265, "cover from overall inventory + combined units");
});

test("Original multi-currency with account-level inventory: overall total is used", () => {
  const t = multiCountry();
  t.dailyGroups.forEach((g) => { g.fbaAvailable = null; });
  t.daily = { inventoryScope: "account", inventoryAccountTotal: 9999, selectedRangeDays: 30 };
  const k = VIEW.portfolioKpis(t);
  assert.equal(k.fba, 9999);
  assert.equal(k.units, 210);
  assert.equal(k.sales, null);
  assert.ok(k.cover > 0);
});

test("no overall inventory evidence -> em dash (null), never zero; units still shown", () => {
  const t = multiCountry();
  t.dailyGroups.forEach((g) => { g.fbaAvailable = null; });
  const k = VIEW.portfolioKpis(t); // country scope, no per-group inventory, no account total
  assert.equal(k.fba, null);
  assert.equal(k.cover, null);
  assert.equal(k.units, 210);
});

test("inventory is never currency-converted (raw unit counts sum directly)", () => {
  const t = multiCountry(); // EUR 12000 + GBP 3852 = 15852 with NO rate applied
  const k = VIEW.portfolioKpis(t);
  assert.equal(k.fba, 12000 + 3852);
});

test("FAIL CLOSED: known group + missing group + no overall total -> FBA null, Cover null", () => {
  const t = multiCountry();
  t.dailyGroups[1].fbaAvailable = null; // one group unknown; no account total
  const k = VIEW.portfolioKpis(t);
  assert.equal(k.fba, null, "the partial sum of only the known groups is never exposed");
  assert.equal(k.cover, null);
  assert.equal(k.units, 210, "units stay available");
});

test("partial groups but an authoritative overall total present -> use the overall total", () => {
  const t = multiCountry();
  t.dailyGroups[1].fbaAvailable = null;
  t.daily.inventoryAccountTotal = 15852; // authoritative overall, even in country scope
  const k = VIEW.portfolioKpis(t);
  assert.equal(k.fba, 15852);
  assert.equal(Math.round(k.cover), 2265);
});

test("every group known -> sum correctly", () => {
  assert.equal(VIEW.portfolioKpis(multiCountry()).fba, 12000 + 3852);
});

test("explicit zero inventory is retained as valid evidence, not null", () => {
  const zeroGroups = multiCountry();
  zeroGroups.dailyGroups.forEach((g) => { g.fbaAvailable = 0; });
  assert.equal(VIEW.portfolioKpis(zeroGroups).fba, 0);
  const zeroTotal = multiCountry();
  zeroTotal.dailyGroups.forEach((g) => { g.fbaAvailable = null; });
  zeroTotal.daily = { inventoryScope: "account", inventoryAccountTotal: 0, selectedRangeDays: 30 };
  assert.equal(VIEW.portfolioKpis(zeroTotal).fba, 0);
});

test("NaN / Infinity / numeric string / negative / non-number group inventory fails closed", () => {
  for (const bad of [NaN, Infinity, -Infinity, "12000", "0", -5, {}, true, null, undefined]) {
    const t = multiCountry();
    t.dailyGroups[1].fbaAvailable = bad; // one malformed group; no overall total
    const k = VIEW.portfolioKpis(t);
    assert.equal(k.fba, null, `group fbaAvailable=${String(bad)} must fail closed`);
    assert.equal(k.cover, null);
  }
});

test("a valid authoritative overall total overrides a malformed group", () => {
  const t = multiCountry();
  t.dailyGroups[1].fbaAvailable = NaN;
  t.daily.inventoryAccountTotal = 15852;
  assert.equal(VIEW.portfolioKpis(t).fba, 15852);
});

test("a malformed authoritative total is ignored; complete country groups still sum", () => {
  const strTotal = multiCountry(); // both groups valid
  strTotal.daily.inventoryAccountTotal = "15852"; // numeric string -> not authoritative
  assert.equal(VIEW.portfolioKpis(strTotal).fba, 12000 + 3852, "falls back to the complete country sum");
  const negTotalPartial = multiCountry();
  negTotalPartial.dailyGroups[1].fbaAvailable = null; // partial groups
  negTotalPartial.daily.inventoryAccountTotal = -1; // negative -> not authoritative
  assert.equal(VIEW.portfolioKpis(negTotalPartial).fba, null, "invalid total + partial groups -> null");
});

/* -------------------------------------------------------------- orderStatusItems */
group("orderStatusItems: deterministic severity, stable, nothing dropped");

test("error stays primary even with a fetch in progress", () => {
  const ordered = VIEW.orderStatusItems([
    { tone: "info", busy: true, title: "Fetching" },
    { tone: "error", title: "Currency conversion unavailable" },
  ]);
  assert.equal(ordered[0].tone, "error");
  assert.equal(ordered.length, 2);
});

test("warning outranks an in-progress fetch", () => {
  const ordered = VIEW.orderStatusItems([
    { tone: "info", busy: true, title: "Fetching" },
    { tone: "warning", title: "Rebuild in progress" },
  ]);
  assert.equal(ordered[0].tone, "warning");
  assert.equal(ordered[1].tone, "info");
});

test("information-only keeps insertion order (stable)", () => {
  const ordered = VIEW.orderStatusItems([
    { tone: "info", title: "A" },
    { tone: "info", title: "B" },
    { tone: "info", busy: true, title: "C" },
  ]);
  assert.deepEqual(ordered.map((i) => i.title), ["A", "B", "C"]);
});

test("full severity order with stable within-tier order; no message dropped", () => {
  const ordered = VIEW.orderStatusItems([
    { tone: "info", title: "note1" },
    { tone: "warning", title: "warn1" },
    { tone: "error", title: "err1" },
    { tone: "success", title: "ok1" },
    { tone: "warning", title: "warn2" },
    { tone: "info", busy: true, title: "busy1" },
  ]);
  assert.deepEqual(ordered.map((i) => i.title), ["err1", "warn1", "warn2", "ok1", "note1", "busy1"]);
  assert.equal(ordered.length, 6);
});

test("'final' sorts in the success tier: before info/busy, stable relative to success", () => {
  const ordered = VIEW.orderStatusItems([
    { tone: "info", title: "note" },
    { tone: "final", title: "fin1" },
    { tone: "success", title: "ok1" },
    { tone: "info", busy: true, title: "busy" },
    { tone: "final", title: "fin2" },
  ]);
  // success + final share rank 2 (before the info tier); within the tier, insertion order.
  assert.deepEqual(ordered.map((i) => i.title), ["fin1", "ok1", "fin2", "note", "busy"]);
});

test("empty / non-array input is safe", () => {
  assert.deepEqual(VIEW.orderStatusItems([]), []);
  assert.deepEqual(VIEW.orderStatusItems(null), []);
  assert.deepEqual(VIEW.orderStatusItems(undefined), []);
});

/* ---------------------------------------------------------- adSpendKpiCopy */
group("adSpendKpiCopy: ACTIVE Campaign Ads attribution + honest unavailable reasons (never same-ASIN, never 'no Ads' when Ads exist)");

// The two retired/misleading strings must appear in NO state.
const noStale = (r) => {
  assert.ok(!/same[- ]ASIN/i.test(r.sub), "no retired same-ASIN wording: " + r.sub);
  assert.ok(!/no saved Ads history/i.test(r.sub), "never claims no saved Ads history: " + r.sub);
};

test("value shown, complete -> Campaign Ads attribution, no Partial badge", () => {
  const r = VIEW.adSpendKpiCopy({ hasValue: true, valuePartial: false, hasAdsCoverage: true, hasUnmapped: false, singleCurrency: true });
  assert.equal(r.badge, null);
  assert.match(r.sub, /Campaign Ads mapped to this brand/);
  noStale(r);
});
test("value shown but PARTIAL (uncovered or unmapped marketplace) -> Partial badge, names it", () => {
  const r = VIEW.adSpendKpiCopy({ hasValue: true, valuePartial: true, hasAdsCoverage: true, hasUnmapped: true, singleCurrency: true });
  assert.equal(r.badge, "Partial");
  assert.match(r.sub, /Campaign Ads/);
  assert.match(r.sub, /unavailable or unmapped/);
  noStale(r);
});
test("em dash, NO Ads coverage -> 'Ads data is unavailable' (real absence)", () => {
  const r = VIEW.adSpendKpiCopy({ hasValue: false, valuePartial: false, hasAdsCoverage: false, hasUnmapped: false, singleCurrency: true });
  assert.match(r.sub, /Ads data is unavailable/);
  noStale(r);
});
test("em dash, saved Ads exist but campaigns UNMAPPED -> attribution-incomplete message (never 'no Ads history')", () => {
  const r = VIEW.adSpendKpiCopy({ hasValue: false, valuePartial: false, hasAdsCoverage: true, hasUnmapped: true, singleCurrency: true });
  assert.equal(r.badge, "Unmapped");
  assert.match(r.sub, /can't be confirmed/);
  assert.match(r.sub, /aren't mapped|not mapped|unmapped/i);
  noStale(r);
});
test("em dash, coverage + multi-currency -> per-marketplace hint (Ads exist, just no single total)", () => {
  const r = VIEW.adSpendKpiCopy({ hasValue: false, valuePartial: false, hasAdsCoverage: true, hasUnmapped: false, singleCurrency: false });
  assert.match(r.sub, /per marketplace/);
  noStale(r);
});
test("em dash, coverage + single currency + no unmapped (other partial) -> 'Partial Ads coverage'", () => {
  const r = VIEW.adSpendKpiCopy({ hasValue: false, valuePartial: false, hasAdsCoverage: true, hasUnmapped: false, singleCurrency: true });
  assert.match(r.sub, /Partial Ads coverage/);
  noStale(r);
});
test("NO combination of states ever uses the retired same-ASIN or 'no saved Ads history' wording", () => {
  for (const hasValue of [true, false]) for (const valuePartial of [true, false]) for (const hasAdsCoverage of [true, false]) for (const hasUnmapped of [true, false]) for (const singleCurrency of [true, false]) {
    noStale(VIEW.adSpendKpiCopy({ hasValue, valuePartial, hasAdsCoverage, hasUnmapped, singleCurrency }));
  }
});

main().then((f) => { if (f) process.exitCode = 1; }).catch((e) => { out("FATAL " + String(e && e.stack ? e.stack : e)); process.exitCode = 1; });
