// Buy Box Loss Scheduler-v2 derivation + generic-cycle parity tests (SHADOW MODE, fully offline).
//
// Part A drives deriveReportSnapshot("buy-box-loss") against hand-built saved fragments and proves the
// pure payload deep-equals a hand-computed production-route fixture, plus the weighted/unweighted branches,
// null-observation exclusion, currency+SKU isolation, price/stock evidence, inventory null-vs-genuine-zero,
// exact four-slice window validation, wrong/missing/dup/reordered/partial/extra/cross-account fail-closed,
// public-vs-raw identity, zero network, and idempotency. Part B drives the REAL planBuyBoxLoss + the generic
// owner-scoped runSourceJobs + runReportJobs and proves shared-hash dedup, coexistence, strict-cap fail,
// resume, LKG, and public/raw identity end to end.
//
// 7-bit ASCII, LF, no top-level await, synchronous writeSync progress, dynamic imports after a dummy env.

import assert from "node:assert/strict";
import { writeSync } from "node:fs";

process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://supabase.test";
const SB_KEY_ENV = ["SUPABASE", "SERVICE", "ROLE", "KEY"].join("_");
process.env[SB_KEY_ENV] = process.env[SB_KEY_ENV] || ["test", "svc", "role", "key"].join("-");

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const group = (label) => tests.push({ marker: label });
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };

let assembleSources, deriveReportSnapshot, runReportJobs, runSourceJobs, plannedSourceJob, sourceJobOwnerId;
let planBuyBoxLoss, planSalesMovers, addDaysStr, splitDateRangeByDays, canonicalOliSlices;
let buildShadowReportPlan, runStagedSourceCycle, SHADOW_PLANNED_REPORT_KEYS;

const ID = "A1";
const ASOF = "2025-08-10";
const dash = (...p) => p.join("-");
const CONNS = [
  { id: "primary", apiKey: dash("prim", "key"), accountPrefix: "" },
  { id: "secondary", apiKey: dash("sec", "key"), accountPrefix: dash("dd", "secondary") + ":" },
];
const SOURCE_LABEL = "Profit by SKU & Date";
const PRICE_LABEL = "FBA Inventory Health";
const DRIVER_CONNECTION_ID = { primary: "primary", secondary: "dd-secondary" };

// Windows (computed once main() has imported the helpers). SLICES = the four 7-day daily buy-box slices;
// OLI_SLICES = the canonicalOliSlices calendar-anchored bins for the ONE canonical Order Line Items sales
// fragment (Blocker 1) -- no longer the same windows as the daily slices.
let FROM, INV_FROM, SLICES, OLI_SLICES;

let hashSeq = 0;
const frag = (requestKey, from, to, ids = [ID]) => ({ requestKey, requestHash: "h" + (hashSeq += 1), from, to, sellerOrVendorIds: ids });

function buildSources(planned, rowsByHash, statusOverride = {}) {
  const statusByHash = {};
  const loaded = new Map();
  for (const p of planned) {
    const st = statusOverride[p.requestHash] || "succeeded";
    statusByHash[p.requestHash] = st;
    if (st === "succeeded") loaded.set(p.requestHash, { rows: Object.prototype.hasOwnProperty.call(rowsByHash, p.requestHash) ? rowsByHash[p.requestHash] : [] });
  }
  return assembleSources(planned, statusByHash, loaded).sources;
}

// Build the ONE CANONICAL Order Line Items ordered fragments (Blocker 1) from a Profit-by-SKU daily
// fixture. Each daily row with a sku becomes a canonical ordered row
//   { date, seller_or_vendor_id, sku, child_asin, item_price_currency, total_sales_sum, total_units_sum }
// binned into the canonicalOliSlices slice whose window CONTAINS its date, so the joined ordered sales/units
// re-aggregate (currency|sku) to the SAME totals as the former daily sales/units and every ordered row is
// bound to its own validated slice window. A row whose date falls outside every canonical slice (a bad /
// out-of-range date under test) is skipped from the ordered evidence -- the separate daily row-date guard is
// what rejects it. Returns an array of row arrays aligned to OLI_SLICES (empty slices kept). Sales/units now
// come from buy-box-loss:oli-sales; the daily source supplies only buybox_percentage + page_views.
const canonicalOrderedFromDaily = (dailySlices, ids = [ID]) => {
  const seller = ids[0];
  const bins = OLI_SLICES.map(() => []);
  for (const sliceRows of dailySlices || []) {
    for (const r of sliceRows || []) {
      const sku = String(r.sku || "").trim();
      if (!sku) continue;
      const date = String(r.date || "");
      const idx = OLI_SLICES.findIndex((w) => date >= w.from && date <= w.to);
      if (idx < 0) continue; // date outside every canonical slice window -> not ordered evidence
      bins[idx].push({
        date,
        seller_or_vendor_id: seller,
        sku,
        child_asin: r.child_asin,
        item_price_currency: r.currency ?? null,
        total_sales_sum: Number(r.total_sales || 0),
        total_units_sum: Number(r.total_units_sold || 0),
      });
    }
  }
  return bins;
};

// Build Buy Box planned fragments + rows: four ordered 7-day daily buy-box slices + the SIX canonicalOliSlices
// ordered OLI slices (each under ONE request key, buy-box-loss:oli-sales), inventory, catalog. The ordered
// slices default to being derived + re-binned from the daily slices (so the re-aggregated per-SKU sales/units
// resolve to the same totals) but may be supplied explicitly (already aligned to OLI_SLICES).
function bbPlanned({ slices = [[], [], [], []], ordered = null, inventory = [], catalog = [], ids = [ID] } = {}) {
  const planned = []; const rows = {};
  const orderedSlices = ordered || canonicalOrderedFromDaily(slices, ids);
  SLICES.forEach((w, i) => { const f = frag("buy-box-loss:daily", w.from, w.to, ids); planned.push(f); rows[f.requestHash] = slices[i] || []; });
  OLI_SLICES.forEach((w, i) => { const f = frag("buy-box-loss:oli-sales", w.from, w.to, ids); planned.push(f); rows[f.requestHash] = orderedSlices[i] || []; });
  const inv = frag("buy-box-loss:inventory", INV_FROM, ASOF, ids); planned.push(inv); rows[inv.requestHash] = inventory;
  const cat = frag("buy-box-loss:catalog", null, null, ids); planned.push(cat); rows[cat.requestHash] = catalog;
  return { planned, rows };
}
const ctx = (over = {}) => ({ to: ASOF, rawSellerId: ID, accountId: ID, ...over });
const deriveBB = (built, context = ctx(), statusOverride) =>
  deriveReportSnapshot({ reportKey: "buy-box-loss", sources: buildSources(built.planned, built.rows, statusOverride), context });

const daily = (date, sku, asin, brand, currency, bb, sales, units, pv, name) => ({
  date, sku, child_asin: asin, product_name: name || `Prod ${sku}`, product_brand: brand, currency,
  buybox_percentage: bb, total_sales: sales, total_units_sold: units, page_views: pv,
});
const invRow = (date, sku, asin, currency, available, prices, unitsShippedT30, dos) => ({
  date, sku, child_asin: asin, product_name: `Prod ${sku}`, currency, available,
  unfulfillable_quantity: 0, inbound_shipped: 0, inbound_received: 0, days_of_supply: dos ?? null,
  units_shipped_t30: unitsShippedT30,
  your_price: prices ? prices.yourPrice : null, sales_price: prices ? prices.salesPrice : null,
  featuredoffer_price: prices ? prices.featuredOfferPrice : null,
  lowest_price_new_plus_shipping: prices ? prices.lowestPriceNewPlusShipping : null, alert: null,
});

// ---- The hand-computed production-route fixture ----
const FIXTURE = () => ({
  slices: [
    // slice 1 [FROM..FROM+6]
    [
      daily("2025-07-15", "SKU-W", "ASIN-W", "Acme", "USD", 80, 100, 10, 50, "Widget W"),
      daily("2025-07-16", "SKU-N", "ASIN-N", "Acme", "USD", null, 40, 4, 20, "NullBB N"),
      daily("2025-07-17", "SKU-Z", "ASIN-Z", "Acme", "USD", 50, 0, 0, 10, "Zero Z"),   // no sales -> excluded
      daily("2025-07-18", "SKU-O", "ASIN-O", "Acme", "USD", null, 70, 7, 15, "NoBB O"),  // no observed bb -> excluded
    ],
    // slice 2 [FROM+7..FROM+13]
    [
      daily("2025-07-22", "SKU-U", "ASIN-U", "Beta", "USD", 60, 50, 5, 0, "Unweighted U"),
      daily("2025-07-23", "SKU-N", "ASIN-N", "Acme", "USD", 75, 60, 6, 30, "NullBB N"),
    ],
    // slice 3 [FROM+14..FROM+20]
    [
      daily("2025-07-29", "SKU-U", "ASIN-U", "Beta", "USD", 40, 30, 3, 0, "Unweighted U"),
      daily("2025-07-30", "SKU-W", "ASIN-W", "Acme", "CAD", 70, 500, 50, 100, "Widget W"), // currency isolation
    ],
    // slice 4 [FROM+21..ASOF]
    [
      daily("2025-08-05", "SKU-W", "ASIN-W", "Acme", "USD", 90, 200, 20, 150, "Widget W"),
    ],
  ],
  inventory: [
    invRow("2025-08-08", "SKU-W", "ASIN-W", "USD", 5, { yourPrice: 19.99, salesPrice: 18.99, featuredOfferPrice: 17.99, lowestPriceNewPlusShipping: 20.5 }, 30, 10), // older snapshot -> dropped
    invRow("2025-08-09", "SKU-W", "ASIN-W", "USD", 8, { yourPrice: 21.99, salesPrice: 20.99, featuredOfferPrice: 19.99, lowestPriceNewPlusShipping: 22.0 }, 40, 12), // latest
    invRow("2025-08-09", "SKU-U", "ASIN-U", "USD", 0, null, 0, null), // genuine zero stock, null prices
  ],
  catalog: [
    { child_asin: "ASIN-W", parent_asin: "P1", product_name: "Catalog W", product_brand: "AcmeCat" },
    { child_asin: "ASIN-N", parent_asin: "P2", product_name: "Catalog N", product_brand: "BetaCat" },
  ],
});
const wPrice = { yourPrice: 21.99, salesPrice: 20.99, featuredOfferPrice: 19.99, lowestPriceNewPlusShipping: 22.0, currency: "USD" };
const expectedFixturePayload = () => ({
  accountId: "A1", asOf: "2025-08-10",
  window: { from: "2025-07-14", to: "2025-08-10", days: 28, sliceDays: 7 },
  observedWindow: { from: "2025-07-15", to: "2025-08-05" },
  sourceLabel: SOURCE_LABEL, priceSourceLabel: PRICE_LABEL,
  inventoryAvailable: true, inventorySnapshotDate: "2025-08-09",
  currencies: ["CAD", "USD"],
  rows: [
    { sku: "SKU-W", asin: "ASIN-W", productName: "Widget W", brand: "Acme", currency: "USD", buyBoxPct: 87.5, buyBoxBasis: "page-view weighted", buyBoxDays: 2, windowDays: 28, sales: 300, units: 30, pageViews: 200, price: { ...wPrice }, available: 8, unitsShippedT30: 40, inventoryKnown: true },
    { sku: "SKU-N", asin: "ASIN-N", productName: "NullBB N", brand: "Acme", currency: "USD", buyBoxPct: 75, buyBoxBasis: "page-view weighted", buyBoxDays: 1, windowDays: 28, sales: 100, units: 10, pageViews: 50, price: null, available: null, unitsShippedT30: null, inventoryKnown: false },
    { sku: "SKU-U", asin: "ASIN-U", productName: "Unweighted U", brand: "Beta", currency: "USD", buyBoxPct: 50, buyBoxBasis: "unweighted mean of observed days", buyBoxDays: 2, windowDays: 28, sales: 80, units: 8, pageViews: 0, price: { yourPrice: null, salesPrice: null, featuredOfferPrice: null, lowestPriceNewPlusShipping: null, currency: "USD" }, available: 0, unitsShippedT30: 0, inventoryKnown: true },
    { sku: "SKU-W", asin: "ASIN-W", productName: "Widget W", brand: "Acme", currency: "CAD", buyBoxPct: 70, buyBoxBasis: "page-view weighted", buyBoxDays: 1, windowDays: 28, sales: 500, units: 50, pageViews: 100, price: { ...wPrice }, available: 8, unitsShippedT30: 40, inventoryKnown: true },
  ],
  catalogBrands: ["AcmeCat", "BetaCat"],
});

/* ============================= Part A: pure derivation parity ============================= */

group("buy-box derive: exact production-route payload parity");

test("1. pure payload deep-equals the hand-computed production-route fixture", () => {
  const r = deriveBB(bbPlanned(FIXTURE()));
  assert.equal(r.status, "derived");
  assert.deepEqual(r.payload, expectedFixturePayload());
});

test("2. weighted branch: page-view-weighted share over observed days (not a naive mean)", () => {
  const p = deriveBB(bbPlanned(FIXTURE())).payload;
  const w = p.rows.find((r) => r.sku === "SKU-W" && r.currency === "USD");
  assert.equal(w.buyBoxPct, 87.5); // (80*50 + 90*150) / (50+150)
  assert.equal(w.buyBoxBasis, "page-view weighted");
  assert.notEqual(w.buyBoxPct, 85); // the naive (80+90)/2 mean is explicitly NOT used
});

test("3. unweighted branch: mean over observed days ONLY when observed days had zero page views", () => {
  const p = deriveBB(bbPlanned(FIXTURE())).payload;
  const u = p.rows.find((r) => r.sku === "SKU-U");
  assert.equal(u.buyBoxPct, 50); // (60 + 40) / 2 observed days, no page views
  assert.equal(u.buyBoxBasis, "unweighted mean of observed days");
});

test("4. null buy-box observations are EXCLUDED (not counted as 0%)", () => {
  const p = deriveBB(bbPlanned(FIXTURE())).payload;
  const n = p.rows.find((r) => r.sku === "SKU-N");
  assert.equal(n.buyBoxDays, 1, "only the one observed (non-null) day counts");
  assert.equal(n.buyBoxPct, 75, "the null day is not folded in as 0% (which would drag it to 37.5)");
  assert.equal(n.pageViews, 50, "page views still accumulate across all days");
});

test("5. SKUs with no sales/units and SKUs with no observed buy-box data are excluded", () => {
  const p = deriveBB(bbPlanned(FIXTURE())).payload;
  assert.ok(!p.rows.some((r) => r.sku === "SKU-Z"), "no-sales SKU excluded");
  assert.ok(!p.rows.some((r) => r.sku === "SKU-O"), "no-observed-buy-box SKU excluded");
});

test("6. currency + SKU is the aggregation identity; two currencies for one SKU never merge", () => {
  const p = deriveBB(bbPlanned(FIXTURE())).payload;
  const wRows = p.rows.filter((r) => r.sku === "SKU-W");
  assert.equal(wRows.length, 2, "SKU-W appears once per currency");
  assert.deepEqual(wRows.map((r) => r.currency).sort(), ["CAD", "USD"]);
  assert.deepEqual(p.currencies, ["CAD", "USD"], "account currencies reported, never combined");
});

test("7. price/stock cause evidence is preserved from the latest snapshot", () => {
  const p = deriveBB(bbPlanned(FIXTURE())).payload;
  const w = p.rows.find((r) => r.sku === "SKU-W" && r.currency === "USD");
  assert.deepEqual(w.price, wPrice, "competitive prices + currency from the latest snapshot");
  assert.equal(w.available, 8);
  assert.equal(w.unitsShippedT30, 40);
  assert.equal(w.inventoryKnown, true);
});

test("8. inventory: genuine zero when the SKU is in the snapshot; null (never zero) when it is missing", () => {
  const p = deriveBB(bbPlanned(FIXTURE())).payload;
  const u = p.rows.find((r) => r.sku === "SKU-U");
  assert.equal(u.available, 0, "genuine zero stock is preserved (SKU present in snapshot)");
  assert.equal(u.inventoryKnown, true);
  const n = p.rows.find((r) => r.sku === "SKU-N");
  assert.equal(n.available, null, "a SKU absent from the snapshot is null, never fabricated zero");
  assert.equal(n.price, null);
  assert.equal(n.inventoryKnown, false);
});

test("9. a missing/unavailable inventory snapshot leaves every row unavailable/null (never zero)", () => {
  const p = deriveBB(bbPlanned({ ...FIXTURE(), inventory: [] })).payload;
  assert.equal(p.inventoryAvailable, false);
  assert.equal(p.inventorySnapshotDate, null);
  assert.ok(p.rows.every((r) => r.price === null && r.available === null && r.unitsShippedT30 === null && r.inventoryKnown === false));
});

test("10. product-name/brand precedence: entry (daily) wins; catalog fills a blank", () => {
  const base = FIXTURE();
  // A SKU with genuinely blank daily name/brand falls back to the catalog meta by ASIN.
  base.slices[0].push({ date: "2025-07-19", sku: "SKU-C", child_asin: "ASIN-N", product_name: "", product_brand: "", currency: "USD", buybox_percentage: 55, total_sales: 25, total_units_sold: 2, page_views: 8 });
  const p = deriveBB(bbPlanned(base)).payload;
  const c = p.rows.find((r) => r.sku === "SKU-C");
  assert.equal(c.productName, "Catalog N", "blank daily name -> catalog name by ASIN");
  assert.equal(c.brand, "BetaCat", "blank daily brand -> catalog brand by ASIN");
  // And a SKU with its own daily name keeps it (entry precedence).
  assert.equal(p.rows.find((r) => r.sku === "SKU-U").productName, "Unweighted U");
});

group("buy-box derive: window + account validation fail closed");

test("11. exactly four ordered non-overlapping 7-day slices are required (correct fixture derives)", () => {
  assert.equal(deriveBB(bbPlanned(FIXTURE())).status, "derived");
  assert.deepEqual(SLICES.map((s) => `${s.from}..${s.to}`), [
    "2025-07-14..2025-07-20", "2025-07-21..2025-07-27", "2025-07-28..2025-08-03", "2025-08-04..2025-08-10",
  ], "the four canonical 7-day slices cover asOf-27d..asOf exactly");
});

test("12. wrong / missing / duplicate / reordered / partial / extra daily windows fail closed (invalid)", () => {
  const good = FIXTURE();
  // Reordered slices [2,1,3,4].
  const reordered = bbPlanned(good);
  const di = reordered.planned.findIndex((p) => p.requestKey === "buy-box-loss:daily");
  const a = reordered.planned[di]; const b = reordered.planned[di + 1];
  reordered.planned[di] = { ...a, from: SLICES[1].from, to: SLICES[1].to };
  reordered.planned[di + 1] = { ...b, from: SLICES[0].from, to: SLICES[0].to };
  assert.equal(deriveBB(reordered).status, "invalid", "reordered slices => invalid");
  // Missing one slice (only three).
  const missing = bbPlanned(good); const mi = missing.planned.findIndex((p) => p.requestKey === "buy-box-loss:daily");
  missing.planned.splice(mi, 1);
  assert.equal(deriveBB(missing).status, "invalid", "three slices => invalid");
  // Extra fifth slice.
  const extra = bbPlanned(good);
  extra.planned.splice(4, 0, (() => { const f = frag("buy-box-loss:daily", addDaysStr(ASOF, 1), addDaysStr(ASOF, 7)); extra.rows[f.requestHash] = []; return f; })());
  assert.equal(deriveBB(extra).status, "invalid", "five slices => invalid");
  // Partial / wrong window (shifted first slice by a day).
  const wrong = bbPlanned(good); const wi = wrong.planned.findIndex((p) => p.requestKey === "buy-box-loss:daily");
  wrong.planned[wi] = { ...wrong.planned[wi], from: addDaysStr(SLICES[0].from, -1) };
  assert.equal(deriveBB(wrong).status, "invalid", "shifted slice window => invalid");
  // Duplicate slice (slice 1 twice, slice 2 dropped) -> positional mismatch.
  const dup = bbPlanned(good); const dupi = dup.planned.findIndex((p) => p.requestKey === "buy-box-loss:daily");
  dup.planned[dupi + 1] = { ...dup.planned[dupi + 1], from: SLICES[0].from, to: SLICES[0].to };
  assert.equal(deriveBB(dup).status, "invalid", "duplicate slice window => invalid");
});

test("13. wrong inventory / dated-or-missing catalog windows fail closed (invalid)", () => {
  const good = FIXTURE();
  const badInv = bbPlanned(good); const ii = badInv.planned.findIndex((p) => p.requestKey === "buy-box-loss:inventory");
  badInv.planned[ii] = { ...badInv.planned[ii], from: addDaysStr(INV_FROM, -1) };
  assert.equal(deriveBB(badInv).status, "invalid", "shifted inventory window => invalid");
  const datedCat = bbPlanned(good); const ci = datedCat.planned.findIndex((p) => p.requestKey === "buy-box-loss:catalog");
  datedCat.planned[ci] = { ...datedCat.planned[ci], from: SLICES[0].from, to: SLICES[0].to };
  assert.equal(deriveBB(datedCat).status, "invalid", "dated catalog fragment => invalid");
});

test("14. cross-account fragments fail closed (invalid)", () => {
  const good = FIXTURE();
  const cross = bbPlanned(good); const di = cross.planned.findIndex((p) => p.requestKey === "buy-box-loss:daily");
  cross.planned[di] = { ...cross.planned[di], sellerOrVendorIds: ["OTHER"] };
  assert.equal(deriveBB(cross).status, "invalid", "cross-account daily slice => invalid");
  const crossInv = bbPlanned(good); const ii = crossInv.planned.findIndex((p) => p.requestKey === "buy-box-loss:inventory");
  crossInv.planned[ii] = { ...crossInv.planned[ii], sellerOrVendorIds: ["OTHER"] };
  assert.equal(deriveBB(crossInv).status, "invalid", "cross-account inventory => invalid");
});

test("15. a missing/failed required source => unavailable, ZERO writes, last-known-good preserved", () => {
  const good = FIXTURE();
  // One daily slice FAILED => the daily source is unavailable => derive is unavailable (never a zero payload).
  const built = bbPlanned(good);
  const firstDailyHash = built.planned.find((p) => p.requestKey === "buy-box-loss:daily").requestHash;
  assert.equal(deriveBB(built, ctx(), { [firstDailyHash]: "failed" }).status, "unavailable", "failed daily slice => unavailable (LKG kept)");
  // Failed inventory (all-required) => unavailable.
  const built2 = bbPlanned(good);
  const invHash = built2.planned.find((p) => p.requestKey === "buy-box-loss:inventory").requestHash;
  assert.equal(deriveBB(built2, ctx(), { [invHash]: "failed" }).status, "unavailable", "failed inventory => unavailable (LKG kept)");
});

group("buy-box derive: every source ROW date is bound to its validated window (Blocker 1)");

// A daily row's date must be a REAL calendar date inside ITS OWN 7-day slice window; an inventory row's
// date must be a real date inside [asOf-10d, asOf]. A bad row is NEVER silently filtered -- it makes the
// whole report invalid. `dailyIn(sliceIdx, ...)` builds a daily row for a given slice; overriding its date
// exercises the guard. The catalog stays no-date.
const dailyRow = (date, over = {}) => ({ date, sku: "SKU-W", child_asin: "ASIN-W", product_name: "Widget W", product_brand: "Acme", currency: "USD", buybox_percentage: 80, total_sales: 100, total_units_sold: 10, page_views: 50, ...over });
// A fixture whose slice `sliceIdx` carries exactly the one row `row` (other slices minimal-but-valid).
const withDailyRow = (sliceIdx, row) => {
  const base = FIXTURE();
  const slices = [
    [dailyRow(SLICES[0].from)], [dailyRow(SLICES[1].from)], [dailyRow(SLICES[2].from)], [dailyRow(SLICES[3].from)],
  ];
  slices[sliceIdx] = [row];
  return { ...base, slices };
};

test("15b. impossible calendar date (2025-02-30) in a daily row => invalid (never silently filtered)", () => {
  assert.equal(deriveBB(bbPlanned(withDailyRow(0, dailyRow("2025-02-30")))).status, "invalid");
});

test("15c. a daily row dated BEFORE or AFTER its slice window => invalid", () => {
  assert.equal(deriveBB(bbPlanned(withDailyRow(1, dailyRow(addDaysStr(SLICES[1].from, -1))))).status, "invalid", "before slice window => invalid");
  assert.equal(deriveBB(bbPlanned(withDailyRow(1, dailyRow(addDaysStr(SLICES[1].to, 1))))).status, "invalid", "after slice window => invalid");
});

test("15d. a daily row placed in the WRONG seven-day slice (valid overall-range date, wrong slice) => invalid", () => {
  // A date that is valid inside slice 2 but placed in slice 0's fragment: inside the 28-day range, wrong slice.
  assert.equal(deriveBB(bbPlanned(withDailyRow(0, dailyRow(SLICES[2].from)))).status, "invalid", "in-range but wrong slice => invalid");
});

test("15e. a FUTURE daily date (2099-01-01) => invalid", () => {
  assert.equal(deriveBB(bbPlanned(withDailyRow(3, dailyRow("2099-01-01")))).status, "invalid");
});

test("15f. inventory row dated before asOf-10d or after asOf => invalid", () => {
  const before = bbPlanned({ ...FIXTURE(), inventory: [invRow(addDaysStr(INV_FROM, -1), "SKU-W", "ASIN-W", "USD", 8, null, 40, 12)] });
  assert.equal(deriveBB(before).status, "invalid", "inventory before asOf-10d => invalid");
  const after = bbPlanned({ ...FIXTURE(), inventory: [invRow(addDaysStr(ASOF, 1), "SKU-W", "ASIN-W", "USD", 8, null, 40, 12)] });
  assert.equal(deriveBB(after).status, "invalid", "inventory after asOf => invalid");
});

test("15g. the exact Codex repro: daily 2099-01-01 + inventory 2099-01-02 no longer derives (=> invalid)", () => {
  const built = bbPlanned({ ...withDailyRow(0, dailyRow("2099-01-01")), inventory: [invRow("2099-01-02", "SKU-W", "ASIN-W", "USD", 8, null, 40, 12)] });
  assert.equal(deriveBB(built).status, "invalid", "future daily + future inventory dates are rejected");
});

test("15h. canonical valid rows still produce the identical payload; observedWindow + snapshot date are the REAL dates", () => {
  const p = deriveBB(bbPlanned(FIXTURE())).payload;
  assert.deepEqual(p, expectedFixturePayload(), "row-date validation does not change the canonical payload");
  assert.deepEqual(p.observedWindow, { from: "2025-07-15", to: "2025-08-05" });
  assert.equal(p.inventorySnapshotDate, "2025-08-09");
});

test("15i. worker-level: a bad daily row date => report NOT saved, prior snapshot (last-known-good) preserved, zero writes", async () => {
  const store = makeStore();
  const cid = store.openCycle({ bucket: "us", cycleDate: "2026-08-11" });
  const built = bbPlanned(withDailyRow(0, dailyRow("2099-01-01"))); // a future daily date
  for (const p of built.planned) {
    store.upsertSourceJob({ cycleId: cid, requestHash: p.requestHash, requestKey: p.requestKey, sourceId: "s", sourceKey: "k", connectionId: "primary", organizationFingerprint: "org", accountScopeHash: "sch" });
    store.saveSourceRows({ job: { request_hash: p.requestHash }, rows: built.rows[p.requestHash] || [] });
    store.recordSourceSuccess({ cycleId: cid, requestHash: p.requestHash, exportId: "e", rowCount: 1, cacheObjectPath: "p/" + p.requestHash });
  }
  // A prior good snapshot exists (last-known-good).
  const lkg = { accountId: ID, prior: true };
  store.seedSnapshot("scheduler-v2/buy-box-loss", ID, lkg);
  const plannedReports = [{
    reportKey: "buy-box-loss", accountId: ID, connectionId: "primary", bucket: "us",
    sources: built.planned.map((p) => ({ requestKey: p.requestKey, requestHash: p.requestHash, from: p.from, to: p.to, sellerOrVendorIds: p.sellerOrVendorIds, optional: false })),
    context: { to: ASOF, rawSellerId: ID },
  }];
  let saveCalls = 0;
  const saveSnapshot = async () => { saveCalls += 1; return { paramsHash: "ph" }; };
  const res = await runReportJobs({ store, cycleId: cid, sourceRows: (h) => store.loadSourceRows(h), saveSnapshot, plannedReports });
  assert.equal(res.succeeded, 0, "the report does not derive/save on a bad source-row date");
  assert.equal(saveCalls, 0, "zero snapshot writes");
  assert.deepEqual(store._snapshots.get("scheduler-v2/buy-box-loss|" + ID).payload, lkg, "prior last-known-good snapshot preserved unchanged");
});

group("buy-box derive: public-vs-raw identity + purity");

const RAW1 = "RAW1";
const PUB1 = dash("dd", "secondary") + ":RAW1";
const idCtx = (publicId, rawId) => ctx({ accountId: publicId, rawSellerId: rawId });

test("16. primary (public==raw==A1): payload.accountId is the public id A1 (route parity)", () => {
  assert.equal(deriveBB(bbPlanned({ ...FIXTURE(), ids: [ID] }), idCtx(ID, ID)).payload.accountId, "A1");
});

test("17. dormant secondary: payload.accountId is the PUBLIC prefixed id, never the raw seller id", () => {
  const p = deriveBB(bbPlanned({ ...FIXTURE(), ids: [RAW1] }), idCtx(PUB1, RAW1)).payload;
  assert.equal(p.accountId, PUB1, "payload accountId is the public/prefixed id (matches snapshot key)");
  assert.notEqual(p.accountId, RAW1);
  assert.deepEqual(p.rows, expectedFixturePayload().rows, "row calculations unchanged by the identity fix");
  assert.deepEqual(p.catalogBrands, ["AcmeCat", "BetaCat"], "catalogBrands travel with the PUBLIC payload accountId");
});

test("18. fragments still require the RAW seller id; a public-id-scoped fragment is cross-account", () => {
  assert.equal(deriveBB(bbPlanned({ ...FIXTURE(), ids: [RAW1] }), idCtx(PUB1, RAW1)).status, "derived");
  assert.equal(deriveBB(bbPlanned({ ...FIXTURE(), ids: [PUB1] }), idCtx(PUB1, RAW1)).status, "invalid", "public-id fragments never satisfy raw-id scope");
});

test("19. derivation makes ZERO network calls; 20. repeated derivation is idempotent", () => {
  const realFetch = globalThis.fetch; let hits = 0;
  globalThis.fetch = () => { hits += 1; throw new Error("network during derivation"); };
  let a, b;
  try { a = deriveBB(bbPlanned(FIXTURE())).payload; b = deriveBB(bbPlanned(FIXTURE())).payload; } finally { globalThis.fetch = realFetch; }
  assert.equal(hits, 0, "zero DataDoe/network calls during derivation");
  assert.deepEqual(a, b, "repeated derivation is idempotent");
  assert.deepEqual(a, expectedFixturePayload());
});

/* ============================= Part B: generic owner-scoped source cycle ============================= */

group("buy-box generic cycle: shared-hash dedup / coexistence / strict-cap / resume / identity");

function makeStore() {
  const cycles = new Map(); const jobsByCycle = new Map(); const ownersByCycle = new Map();
  const cache = new Map(); const reportJobs = new Map(); const snapshots = new Map(); let seq = 0;
  const findCycle = (id) => [...cycles.values()].find((c) => c.id === id) || null;
  const ownerRows = (cid) => [...((ownersByCycle.get(cid) && ownersByCycle.get(cid).values()) || [])];
  const rkey = (rk, a) => rk + "|" + a;
  return {
    _owners: (cid) => ownerRows(cid).map((m) => ({ ...m })),
    _snapshots: snapshots, saveCalls: 0,
    openCycle({ bucket, cycleDate }) { const k = bucket + "|" + cycleDate; if (!cycles.has(k)) { const id = "cyc_" + (seq += 1); cycles.set(k, { id, bucket, status: "pending" }); jobsByCycle.set(id, new Map()); } return cycles.get(k).id; },
    claimCycle(id) { const c = findCycle(id); if (c && c.status === "pending") { c.status = "running"; return true; } return false; },
    getCycle(id) { return findCycle(id); },
    upsertSourceJob(job) { const m = jobsByCycle.get(job.cycleId); if (m.has(job.requestHash)) return; m.set(job.requestHash, { request_hash: job.requestHash, request_key: job.requestKey, source_id: job.sourceId, source_key: job.sourceKey, connection_id: job.connectionId, organization_fingerprint: job.organizationFingerprint, account_scope_hash: job.accountScopeHash, fetch_status: "pending", attempted_at: null, create_export_count: 0, export_id: null, terminal: false, row_count: null }); },
    listSourceJobs(id) { return [...((jobsByCycle.get(id) && jobsByCycle.get(id).values()) || [])].map((j) => ({ ...j })); },
    upsertSourceJobOwners(ms) { for (const m of ms || []) { if (!ownersByCycle.has(m.cycleId)) ownersByCycle.set(m.cycleId, new Map()); ownersByCycle.get(m.cycleId).set(m.ownerId + "|" + m.requestHash, { cycle_id: m.cycleId, request_hash: m.requestHash, owner_id: m.ownerId, request_key: m.requestKey, report_key: m.reportKey, account_id: m.accountId, connection_id: m.connectionId, organization_fingerprint: m.organizationFingerprint, account_scope_hash: m.accountScopeHash, owner_status: "active", error_code: null }); } },
    listSourceJobOwners(cid, ids) { const s = new Set(ids || []); return ownerRows(cid).filter((m) => s.has(m.owner_id)).map((m) => ({ ...m })); },
    recordSourceOwnerStale({ cycleId, requestHash, ownerId, code }) { const m = ownersByCycle.get(cycleId) && ownersByCycle.get(cycleId).get(ownerId + "|" + requestHash); if (m) { m.owner_status = "stale"; m.error_code = code || "STALE_PLAN"; } },
    claimExportAttempt(id, h) { const j = jobsByCycle.get(id) && jobsByCycle.get(id).get(h); if (j && j.attempted_at === null) { j.attempted_at = "t"; j.create_export_count += 1; j.fetch_status = "attempted"; return true; } return false; },
    recordExportCreated({ cycleId, requestHash, exportId }) { jobsByCycle.get(cycleId).get(requestHash).export_id = exportId; },
    loadSourceRows(h) { const e = cache.get(h); return e ? { rows: e.rows } : null; },
    saveSourceRows({ job, rows }) { const h = job.request_hash != null ? job.request_hash : job.requestHash; cache.set(h, { rows: [...rows] }); return "p/" + h; },
    recordSourceSuccess({ cycleId, requestHash, exportId, rowCount, cacheObjectPath }) { Object.assign(jobsByCycle.get(cycleId).get(requestHash), { fetch_status: "succeeded", export_id: exportId, row_count: rowCount, cache_object_path: cacheObjectPath }); },
    recordSourceFailure({ cycleId, requestHash, stage, code, terminal }) { Object.assign(jobsByCycle.get(cycleId).get(requestHash), { fetch_status: "failed", error_stage: stage, error_code: code, terminal: !!terminal }); },
    updateCycleCounts() {},
    seedSnapshot(rk, a, payload) { snapshots.set(rkey(rk, a), { payload }); },
    report(rk, a) { return reportJobs.get(rkey(rk, a)); },
    listReportJobs() { return [...reportJobs.values()].map((j) => ({ ...j })); },
    upsertReportJob({ reportKey, accountId, connectionId, bucket, reportVersion, dependsOn }) { const k = rkey(reportKey, accountId); if (reportJobs.has(k)) return; reportJobs.set(k, { report_key: reportKey, account_id: accountId, connection_id: connectionId, bucket, report_version: reportVersion, depends_on: dependsOn || [], fetch_status: "pending", derive_status: "pending", save_status: "pending", validated: false }); },
    claimReportDerive(_c, rk, a) { const j = reportJobs.get(rkey(rk, a)); if (j && j.derive_status === "pending") { j.derive_status = "running"; return true; } return false; },
    recordReportBlocked({ reportKey, accountId }) { Object.assign(reportJobs.get(rkey(reportKey, accountId)), { fetch_status: "blocked", derive_status: "skipped", save_status: "skipped" }); },
    recordReportFailure({ reportKey, accountId, stage, code }) { Object.assign(reportJobs.get(rkey(reportKey, accountId)), { derive_status: stage === "save" ? "succeeded" : "failed", save_status: stage === "save" ? "failed" : "pending", error_code: code }); },
    recordReportSuccess({ reportKey, accountId }) { Object.assign(reportJobs.get(rkey(reportKey, accountId)), { fetch_status: "ready", derive_status: "succeeded", save_status: "succeeded", validated: true }); },
  };
}

function makeDataDoe(opts = {}) {
  const create = {}; let hits = 0;
  const deadlineErr = () => Object.assign(new Error("deferred"), { code: "DATADOE_DEADLINE" });
  const rowsFor = (job) => {
    const rk = job.requestKey || "";
    const fp = job.fetchParams || {};
    // Date each row INSIDE its own validated fragment window (each daily row in its 7-day slice via the
    // slice `from`; each canonical OLI ordered row on its canonicalOliSlices `from`; each inventory row on
    // `to` = asOf, inside [asOf-10d, asOf]) so post-Blocker-1 row-date validation accepts canonical rows.
    if (rk.includes("oli-sales")) return [{ date: fp.from || "2025-08-05", seller_or_vendor_id: ID, sku: "SKU-W", child_asin: "ASIN-W", item_price_currency: "USD", total_sales_sum: 200, total_units_sum: 20 }];
    if (rk.includes("daily")) return [daily(fp.from || "2025-08-05", "SKU-W", "ASIN-W", "Acme", "USD", 90, 200, 20, 150, "Widget W")];
    if (rk.includes("inventory")) return [invRow(fp.to || "2025-08-09", "SKU-W", "ASIN-W", "USD", 8, { yourPrice: 21.99, salesPrice: 20.99, featuredOfferPrice: 19.99, lowestPriceNewPlusShipping: 22.0 }, 40, 12)];
    if (rk.includes("catalog")) return [{ child_asin: "ASIN-W", parent_asin: "P1", product_name: "Catalog W", product_brand: "AcmeCat" }];
    return [{ child_asin: "ASIN-W" }];
  };
  return {
    createCount: (h) => create[h] || 0, totalCreates: () => Object.values(create).reduce((a, b) => a + b, 0),
    async create(job) { create[job.requestHash] = (create[job.requestHash] || 0) + 1; return { exportId: "e_" + job.requestHash }; },
    async poll(job) { if (opts.deferKey && (job.requestKey || "").includes(opts.deferKey)) { hits += 1; if (hits === 1) throw deadlineErr(); } },
    async download(job) { if (opts.capKey && (job.requestKey || "").includes(opts.capKey)) return new Array(Number(job.limit)).fill(0).map(() => ({ x: 1 })); return rowsFor(job); },
  };
}

const bbPlan = (accountId = ID, connections = CONNS) => planBuyBoxLoss({ accountId, country: "US", currency: "USD", connections, asOf: ASOF });
const smPlanWithInventory = (accountId = ID) => planSalesMovers({ accountId, country: "US", currency: "USD", connections: CONNS, asOf: ASOF, probeSignal: { status: "success", validated: true, latestReportedDate: "2025-08-08" } });
const jobsFromPlan = (plan) => plan.sources.map((s) => plannedSourceJob(plan.reportKey, s, plan.bucket, DRIVER_CONNECTION_ID[plan.connectionId] || plan.connectionId, plan.accountId));
const ownerIdsOf = (jobs) => [...new Set(jobs.map((j) => j.owner.ownerId))];
const runSrc = (store, dd, plannedJobs, extra = {}) => runSourceJobs({ store, dataDoe: dd, plannedJobs, ownerIds: ownerIdsOf(plannedJobs), bucket: "us", cycleDate: "2026-08-11", ...extra });
const srcOf = (plan, key) => plan.sources.find((s) => s.requestKey === key);

test("21. shared inventory + catalog canonical hashes MATCH Sales Movers; primary vs dd-secondary are isolated", () => {
  const bb = bbPlan();
  const sm = smPlanWithInventory();
  assert.equal(srcOf(bb, "buy-box-loss:inventory").requestHash, srcOf(sm, "sales-movers:inventory").requestHash, "shared FBA inventory canonical identity");
  assert.equal(srcOf(bb, "buy-box-loss:catalog").requestHash, srcOf(sm, "sales-movers:catalog").requestHash, "shared no-date catalog canonical identity");
  // Primary vs dormant secondary: different org scope => different hashes; secondary never routed to primary.
  const bbSec = planBuyBoxLoss({ accountId: PUB1, country: "US", currency: "USD", connections: CONNS, asOf: ASOF });
  assert.equal(bb.connectionId, "primary"); assert.equal(bbSec.connectionId, "secondary");
  assert.notEqual(srcOf(bb, "buy-box-loss:daily").requestHash, srcOf(bbSec, "buy-box-loss:daily").requestHash, "primary/dd-secondary daily hashes isolated");
  assert.notEqual(srcOf(bb, "buy-box-loss:inventory").requestHash, srcOf(bbSec, "buy-box-loss:inventory").requestHash, "primary/dd-secondary inventory hashes isolated");
});

test("22. one canonical export per shared request_hash across TWO report owners (Buy Box + Sales Movers)", async () => {
  const store = makeStore(); const dd = makeDataDoe();
  const bbJobs = jobsFromPlan(bbPlan());
  const invJob = bbJobs.find((j) => j.requestKey === "buy-box-loss:inventory");
  // A SECOND owner (Sales Movers) for the SAME canonical inventory hash: identical org/account scope, so
  // the recomputed owner_id differs only by report family; the canonical job dedups on request_hash.
  const smOwnerId = sourceJobOwnerId({ reportKey: "sales-movers", connectionId: invJob.connectionId, organizationFingerprint: invJob.organizationFingerprint, accountScopeHash: invJob.accountScopeHash });
  const smInvJob = { ...invJob, requestKey: "sales-movers:inventory", owner: { ownerId: smOwnerId, requestKey: "sales-movers:inventory", reportKey: "sales-movers", accountId: ID } };
  const plannedJobs = [...bbJobs, smInvJob];
  const r = await runSrc(store, dd, plannedJobs);
  assert.equal(dd.createCount(invJob.requestHash), 1, "the shared inventory export is created exactly once");
  assert.equal(store.listSourceJobs(r.cycleId).filter((j) => j.request_hash === invJob.requestHash).length, 1, "one canonical inventory row");
  assert.equal(store._owners(r.cycleId).filter((m) => m.request_hash === invJob.requestHash).length, 2, "two owner memberships share the one canonical hash");
});

test("23. generic-cycle coexistence: a second owner sharing catalog/inventory neither stales nor fails Buy Box", async () => {
  const store = makeStore(); const dd = makeDataDoe();
  const bbJobs = jobsFromPlan(bbPlan());
  const catJob = bbJobs.find((j) => j.requestKey === "buy-box-loss:catalog");
  const smOwnerId = sourceJobOwnerId({ reportKey: "sales-movers", connectionId: catJob.connectionId, organizationFingerprint: catJob.organizationFingerprint, accountScopeHash: catJob.accountScopeHash });
  const smCatJob = { ...catJob, requestKey: "sales-movers:catalog", owner: { ownerId: smOwnerId, requestKey: "sales-movers:catalog", reportKey: "sales-movers", accountId: ID } };
  const r = await runSrc(store, dd, [...bbJobs, smCatJob]);
  // Every Buy Box source succeeded; no owner membership went stale.
  assert.ok(store.listSourceJobs(r.cycleId).every((j) => j.fetch_status === "succeeded"), "all canonical jobs succeeded");
  assert.ok(store._owners(r.cycleId).every((m) => m.owner_status === "active"), "no owner membership staled or failed by coexistence");
  assert.equal(r.failed, 0);
});

test("24. strict-cap: a daily slice at the row cap fails TRUNCATED, saves no source, and the report never derives (LKG)", async () => {
  const store = makeStore();
  const dd = makeDataDoe({ capKey: "daily" }); // download returns exactly `limit` rows for the daily slices
  const plan = bbPlan();
  const bbJobs = jobsFromPlan(plan);
  const r = await runSrc(store, dd, bbJobs);
  const dailyJobs = store.listSourceJobs(r.cycleId).filter((j) => j.request_key === "buy-box-loss:daily");
  assert.ok(dailyJobs.every((j) => j.fetch_status === "failed" && j.error_code === "TRUNCATED"), "capped daily slices fail TRUNCATED");
  assert.ok(!store.loadSourceRows(dailyJobs[0].request_hash), "no truncated source payload is saved");
  // Report half: the required daily source is not ready => report is blocked, no snapshot saved (LKG).
  const saved = [];
  const saveSnapshot = async ({ reportKey, accountId, payload }) => { saved.push({ accountId, payload }); return { paramsHash: "ph" }; };
  const res = await runReportJobs({ store, cycleId: r.cycleId, sourceRows: (h) => store.loadSourceRows(h), saveSnapshot, plannedReports: [plan] });
  assert.equal(res.succeeded, 0, "the report does not derive/save on a truncated required source");
  assert.equal(saved.length, 0, "zero snapshot writes (last-known-good preserved)");
});

test("25. E2E: generic cycle -> runReportJobs -> saved snapshot keyed by the account; zero network in derive; idempotent (source + report)", async () => {
  const store = makeStore(); const dd = makeDataDoe();
  const plan = bbPlan();
  const r1 = await runSrc(store, dd, jobsFromPlan(plan));
  assert.equal(r1.failed, 0);
  const totalAfterFirst = dd.totalCreates();
  // Re-run the source cycle: idempotent, NO duplicate create-export.
  await runSrc(store, dd, jobsFromPlan(plan));
  assert.equal(dd.totalCreates(), totalAfterFirst, "source execution is idempotent (no duplicate export)");

  const saved = [];
  const saveSnapshot = async ({ reportKey, accountId, payload }) => { store.saveCalls += 1; store.seedSnapshot(reportKey, accountId, payload); saved.push({ reportKey, accountId, payload }); return { paramsHash: "ph" }; };
  const realFetch = globalThis.fetch; let hits = 0;
  globalThis.fetch = () => { hits += 1; throw new Error("network during derivation"); };
  let res;
  try { res = await runReportJobs({ store, cycleId: r1.cycleId, sourceRows: (h) => store.loadSourceRows(h), saveSnapshot, plannedReports: [plan] }); } finally { globalThis.fetch = realFetch; }
  assert.equal(hits, 0, "zero network during derivation");
  assert.equal(res.succeeded, 1, "buy-box-loss derived + saved");
  assert.equal(saved[0].accountId, "A1", "report + snapshot keyed by the account id");
  assert.equal(saved[0].payload.accountId, "A1", "payload accountId matches the snapshot key");
  assert.equal(saved[0].payload.sourceLabel, SOURCE_LABEL);
  assert.equal(saved[0].payload.priceSourceLabel, PRICE_LABEL);
  // Report idempotency: a second invocation writes no duplicate snapshot.
  const before = store.saveCalls;
  await runReportJobs({ store, cycleId: r1.cycleId, sourceRows: (h) => store.loadSourceRows(h), saveSnapshot, plannedReports: [plan] });
  assert.equal(store.saveCalls, before, "repeated report invocation writes no duplicate snapshot");
});

test("26. partial invocation (maxJobs) resumes without a duplicate create-export", async () => {
  const store = makeStore(); const dd = makeDataDoe();
  const plan = bbPlan();
  const jobs = jobsFromPlan(plan);
  const r1 = await runSrc(store, dd, jobs, { maxJobs: 2 }); // only 2 of the 12 canonical jobs this invocation
  assert.ok(r1.processed <= 2);
  const r2 = await runSrc(store, dd, jobs); // resume the rest
  assert.ok(store.listSourceJobs(r2.cycleId).every((j) => j.fetch_status === "succeeded"), "all sources complete after resume");
  for (const j of store.listSourceJobs(r2.cycleId)) assert.ok(dd.createCount(j.request_hash) <= 1, j.request_key + " exported at most once across the resume");
});

test("27. deferral (poll deadline) resumes without a duplicate create-export", async () => {
  const store = makeStore();
  const dd1 = makeDataDoe({ deferKey: "inventory" });
  const plan = bbPlan();
  const jobs = jobsFromPlan(plan);
  const invHash = jobs.find((j) => j.requestKey === "buy-box-loss:inventory").requestHash;
  await runSrc(store, dd1, jobs);
  const dd2 = makeDataDoe();
  const r2 = await runSrc(store, dd2, jobs);
  assert.equal(dd1.createCount(invHash) + dd2.createCount(invHash), 1, "the inventory export is created exactly once across the deferral+resume");
  assert.ok(store.listSourceJobs(r2.cycleId).every((j) => j.fetch_status === "succeeded"), "all sources complete after the deferral resume");
});

test("28. dormant secondary via runReportJobs: report job + snapshot + payload keyed by the PUBLIC id; fragments use the RAW id", async () => {
  const store = makeStore();
  const cid = store.openCycle({ bucket: "us", cycleDate: "2026-08-11" });
  const built = bbPlanned({ ...FIXTURE(), ids: [RAW1] });
  for (const p of built.planned) {
    store.upsertSourceJob({ cycleId: cid, requestHash: p.requestHash, requestKey: p.requestKey, sourceId: "s", sourceKey: "k", connectionId: "dd-secondary", organizationFingerprint: "org", accountScopeHash: "sch" });
    store.saveSourceRows({ job: { request_hash: p.requestHash }, rows: built.rows[p.requestHash] || [] });
    store.recordSourceSuccess({ cycleId: cid, requestHash: p.requestHash, exportId: "e", rowCount: (built.rows[p.requestHash] || []).length, cacheObjectPath: "p/" + p.requestHash });
  }
  const plannedReports = [{
    reportKey: "buy-box-loss", accountId: PUB1, connectionId: "dd-secondary", bucket: "us",
    sources: built.planned.map((p) => ({ requestKey: p.requestKey, requestHash: p.requestHash, from: p.from, to: p.to, sellerOrVendorIds: p.sellerOrVendorIds, optional: false })),
    context: { to: ASOF, rawSellerId: RAW1 },
  }];
  const saved = [];
  const saveSnapshot = async ({ reportKey, accountId, payload }) => { store.seedSnapshot(reportKey, accountId, payload); saved.push({ accountId, payload }); return { paramsHash: "ph" }; };
  const res = await runReportJobs({ store, cycleId: cid, sourceRows: (h) => store.loadSourceRows(h), saveSnapshot, plannedReports });
  assert.equal(res.succeeded, 1);
  assert.ok(store.report("buy-box-loss", PUB1), "report job keyed by dd-secondary:RAW1");
  assert.equal(store.report("buy-box-loss", RAW1), undefined, "no report job keyed by the raw seller id");
  assert.equal(saved[0].accountId, PUB1);
  assert.equal(saved[0].payload.accountId, PUB1, "payload accountId is the public id (frontend scopes brands to it)");
  assert.deepEqual(saved[0].payload.catalogBrands, ["AcmeCat", "BetaCat"]);
});

/* ===== Part C: the REAL production-shadow path -- buildShadowReportPlan -> runStagedSourceCycle -> runReportJobs ===== */

group("buy-box REAL generic path: buildShadowReportPlan -> runStagedSourceCycle -> runReportJobs (Blocker 2)");

const ACCTS = [{ accountId: ID, country: "US", currency: "USD" }];
const asOfForUS = () => ASOF;
const shadowPlan = (accounts, keys, connections = CONNS) => buildShadowReportPlan({ accounts, reportKeys: keys, connections, asOfFor: asOfForUS });
// The generic driver's resolvePlan: build owner-scoped plannedSourceJobs from the REAL plan's report
// requests (exactly how a production caller feeds runStagedSourceCycle). No test-only job construction.
const resolveFromPlan = (plan) => () => ({
  sourceJobs: plan.reportRequests.flatMap((req) => req.sources.map((s) => plannedSourceJob(req.reportKey, s, req.bucket, DRIVER_CONNECTION_ID[req.connectionId] || req.connectionId, req.accountId))),
});
const runGeneric = (store, dd, plan, opts = {}) => runStagedSourceCycle({ store, dataDoe: dd, resolvePlan: resolveFromPlan(plan), bucket: "us", cycleDate: "2026-08-11", ...opts });

test("C1. default AND explicit planning include buy-box-loss; the plan holds exactly twelve canonical jobs with exact windows/deps/owner/context", () => {
  assert.ok(SHADOW_PLANNED_REPORT_KEYS.includes("buy-box-loss"), "buy-box-loss is a default generic report key");
  assert.ok(shadowPlan(ACCTS).reportRequests.some((r) => r.reportKey === "buy-box-loss"), "DEFAULT plan includes buy-box-loss");
  const plan = shadowPlan(ACCTS, ["buy-box-loss"]);
  const bb = plan.reportRequests.find((r) => r.reportKey === "buy-box-loss");
  // Exactly twelve canonical source jobs: four 7-day daily buy-box slices + six canonicalOliSlices ordered
  // OLI slices + one inventory + one no-date catalog.
  assert.equal(plan.sourceJobs.length, 12, "exactly twelve deduplicated canonical source jobs");
  const dailies = bb.sources.filter((s) => s.requestKey === "buy-box-loss:daily");
  assert.deepEqual(dailies.map((s) => `${s.from}..${s.to}`), SLICES.map((s) => `${s.from}..${s.to}`), "four ordered 7-day daily slice windows");
  const ordered = bb.sources.filter((s) => s.requestKey === "buy-box-loss:oli-sales");
  assert.deepEqual(ordered.map((s) => `${s.from}..${s.to}`), OLI_SLICES.map((s) => `${s.from}..${s.to}`), "six canonicalOliSlices ordered OLI slice windows");
  const inv = bb.sources.find((s) => s.requestKey === "buy-box-loss:inventory");
  assert.deepEqual([inv.from, inv.to], [INV_FROM, ASOF], "inventory window asOf-10d..asOf");
  const cat = bb.sources.find((s) => s.requestKey === "buy-box-loss:catalog");
  assert.deepEqual([cat.from, cat.to], [null, null], "no-date catalog");
  // Report dependency map = all twelve canonical hashes; context carries the raw seller id + asOf.
  const rj = plan.reportJobs.find((j) => j.reportKey === "buy-box-loss");
  assert.equal(rj.dependsOn.length, 12, "report depends on all twelve canonical sources");
  assert.deepEqual([...rj.dependsOn].sort(), plan.sourceJobs.map((j) => j.requestHash).sort(), "report deps == the twelve canonical hashes");
  assert.deepEqual(bb.context, { to: ASOF, rawSellerId: ID }, "context carries asOf + raw seller id");
  // Owner metadata: every planned source job is owned by the buy-box-loss owner, recomputed + validated.
  const jobs = resolveFromPlan(plan)().sourceJobs;
  assert.equal(jobs.length, 12);
  assert.ok(jobs.every((j) => j.owner && j.owner.reportKey === "buy-box-loss" && j.owner.accountId === ID && j.owner.ownerId), "each job carries buy-box-loss owner metadata");
  assert.equal(new Set(jobs.map((j) => j.owner.ownerId)).size, 1, "one owner for the single account/org");
});

test("C2. Buy Box stays PENDING until every required source succeeds, then the snapshot is saved EXACTLY once; zero network during derivation", async () => {
  const store = makeStore(); const dd = makeDataDoe();
  const plan = shadowPlan(ACCTS, ["buy-box-loss"]);
  const saved = [];
  const saveSnapshot = async ({ reportKey, accountId, payload }) => { store.saveCalls += 1; store.seedSnapshot(reportKey, accountId, payload); saved.push({ reportKey, accountId, payload }); return { paramsHash: "ph" }; };
  // Bounded first invocation: only some of the twelve sources succeed => the report is still PENDING.
  const r1 = await runGeneric(store, dd, plan, { maxJobs: 3 });
  assert.ok(store.listSourceJobs(r1.cycleId).filter((j) => j.fetch_status === "succeeded").length < 12, "not all sources succeeded yet");
  let res = await runReportJobs({ store, cycleId: r1.cycleId, sourceRows: (h) => store.loadSourceRows(h), saveSnapshot, plannedReports: plan.reportRequests });
  assert.equal(res.succeeded, 0, "report is PENDING while a required source is missing (no save)");
  assert.equal(saved.length, 0, "zero snapshot writes while pending");
  // Resume the generic driver to completion.
  const r2 = await runGeneric(store, dd, plan);
  assert.ok(store.listSourceJobs(r2.cycleId).every((j) => j.fetch_status === "succeeded"), "all twelve sources succeeded after resume");
  const realFetch = globalThis.fetch; let hits = 0;
  globalThis.fetch = () => { hits += 1; throw new Error("network during derivation"); };
  try { res = await runReportJobs({ store, cycleId: r2.cycleId, sourceRows: (h) => store.loadSourceRows(h), saveSnapshot, plannedReports: plan.reportRequests }); } finally { globalThis.fetch = realFetch; }
  assert.equal(hits, 0, "zero DataDoe/network requests during derivation");
  assert.equal(res.succeeded, 1, "the report derives + saves once all sources are ready");
  assert.equal(saved.length, 1, "snapshot saved exactly once");
  assert.equal(saved[0].accountId, ID);
  // Idempotent: a second report invocation writes no duplicate snapshot.
  const before = store.saveCalls;
  await runReportJobs({ store, cycleId: r2.cycleId, sourceRows: (h) => store.loadSourceRows(h), saveSnapshot, plannedReports: plan.reportRequests });
  assert.equal(store.saveCalls, before, "no duplicate snapshot on re-run");
});

test("C3. maxJobs partial + poll/download deferral resume through the real driver with ONE create-export per request hash", async () => {
  // maxJobs partial resume.
  const s1 = makeStore(); const d1 = makeDataDoe();
  const plan = shadowPlan(ACCTS, ["buy-box-loss"]);
  await runGeneric(s1, d1, plan, { maxJobs: 2 });
  const r = await runGeneric(s1, d1, plan);
  assert.ok(s1.listSourceJobs(r.cycleId).every((j) => j.fetch_status === "succeeded"), "all sources complete after maxJobs resume");
  for (const j of s1.listSourceJobs(r.cycleId)) assert.ok(d1.createCount(j.request_hash) <= 1, j.request_key + " exported at most once (maxJobs resume)");
  // Poll-deferral resume: the first invocation defers inventory (no reconcile, memberships stay active).
  const s2 = makeStore();
  const dDefer = makeDataDoe({ deferKey: "inventory" });
  const r1 = await runGeneric(s2, dDefer, plan);
  assert.ok((r1.deferred || 0) > 0, "the driver surfaces the resumable deferral");
  const invReq = plan.reportRequests[0].sources.find((s) => s.requestKey === "buy-box-loss:inventory").requestHash;
  assert.ok(s2._owners(r1.cycleId).every((m) => m.owner_status === "active"), "no membership staled by a deferral (plan not yet at fixpoint)");
  const dOk = makeDataDoe();
  const r2 = await runGeneric(s2, dOk, plan);
  assert.equal(dDefer.createCount(invReq) + dOk.createCount(invReq), 1, "inventory export created exactly once across the deferral + resume");
  assert.ok(s2.listSourceJobs(r2.cycleId).every((j) => j.fetch_status === "succeeded"), "all sources complete after the deferral resume");
});

test("C4. Buy Box owner reconciliation is owner-scoped: a second owner sharing the inventory/catalog hash is neither staled nor failed", async () => {
  const store = makeStore(); const dd = makeDataDoe();
  const plan = shadowPlan(ACCTS, ["buy-box-loss"]);
  // Run the real generic driver to its fixpoint (this is when reconciliation of buy-box owners runs).
  const r = await runGeneric(store, dd, plan);
  const cid = r.cycleId;
  const invReq = plan.reportRequests[0].sources.find((s) => s.requestKey === "buy-box-loss:inventory");
  const catReq = plan.reportRequests[0].sources.find((s) => s.requestKey === "buy-box-loss:catalog");
  // A SECOND owner (Sales Movers) holds a membership on the SAME shared inventory + catalog canonical hashes.
  for (const [reqKey, src] of [["sales-movers:inventory", invReq], ["sales-movers:catalog", catReq]]) {
    const ownerId = sourceJobOwnerId({ reportKey: "sales-movers", connectionId: "primary", organizationFingerprint: src.organizationFingerprint, accountScopeHash: src.accountScopeHash });
    store.upsertSourceJobOwners([{ cycleId: cid, requestHash: src.requestHash, ownerId, requestKey: reqKey, reportKey: "sales-movers", accountId: ID, connectionId: "primary", organizationFingerprint: src.organizationFingerprint, accountScopeHash: src.accountScopeHash }]);
  }
  // Re-run the Buy Box generic driver to fixpoint: its reconciliation must touch ONLY buy-box owners.
  await runGeneric(store, dd, plan);
  const smMemberships = store._owners(cid).filter((m) => m.report_key === "sales-movers");
  assert.equal(smMemberships.length, 2, "the second owner's two shared memberships still exist");
  assert.ok(smMemberships.every((m) => m.owner_status === "active"), "buy-box reconciliation never stales/fails the second owner");
  assert.ok(store.listSourceJobs(cid).filter((j) => j.request_hash === invReq.requestHash).every((j) => j.fetch_status === "succeeded"), "the shared canonical inventory job stays succeeded");
});

test("C5. primary-only: a stale dd-secondary account is skipped read-only with ZERO DataDoe calls and is never routed through the primary key", async () => {
  const store = makeStore(); const dd = makeDataDoe();
  const PRIMARY_ONLY = [{ id: "primary", apiKey: dash("prim", "key"), accountPrefix: "" }];
  const accounts = [{ accountId: ID, country: "US", currency: "USD" }, { accountId: PUB1, country: "US", currency: "USD" }];
  const plan = shadowPlan(accounts, ["buy-box-loss"], PRIMARY_ONLY);
  assert.deepEqual(plan.unavailableAccounts.map((a) => a.accountId), [PUB1], "the dd-secondary account is classified unavailable");
  assert.deepEqual(plan.reportRequests.map((r) => r.accountId), [ID], "only the primary account is planned");
  const r = await runGeneric(store, dd, plan);
  const jobs = store.listSourceJobs(r.cycleId);
  assert.ok(jobs.every((j) => j.connection_id === "primary"), "no dd-secondary jobs; nothing routed to the primary key for the stale account");
  assert.ok(jobs.every((j) => !String(j.request_key).includes(dash("dd", "secondary"))), "no dd-secondary source was ever staged");
  // Zero DataDoe create-exports carry the secondary account (it spent no token).
  assert.equal(jobs.length, 12, "exactly the twelve primary-account canonical jobs ran");
});

async function main() {
  ({ assembleSources, runReportJobs } = await import("../lib/server/sync/report-worker.js"));
  ({ deriveReportSnapshot } = await import("../lib/server/sync/report-derivation.js"));
  ({ runSourceJobs } = await import("../lib/server/sync/source-worker.js"));
  ({ plannedSourceJob } = await import("../lib/server/sync/source-sync-driver.js"));
  ({ sourceJobOwnerId } = await import("../lib/server/source-identity.js"));
  ({ planBuyBoxLoss, planSalesMovers, buildShadowReportPlan, SHADOW_PLANNED_REPORT_KEYS } = await import("../lib/server/sync/report-planner.js"));
  ({ runStagedSourceCycle } = await import("../lib/server/sync/source-sync-driver.js"));
  ({ addDaysStr, splitDateRangeByDays, canonicalOliSlices } = await import("../lib/server/date-windows.js"));
  FROM = addDaysStr(ASOF, -27);
  INV_FROM = addDaysStr(ASOF, -10);
  SLICES = splitDateRangeByDays(FROM, ASOF, 7);
  OLI_SLICES = canonicalOliSlices(FROM, ASOF);

  let failures = 0;
  for (const t of tests) {
    if (t.marker) { out("\n# " + t.marker); continue; }
    try { await t.fn(); passed += 1; out("  ok  " + t.name); }
    catch (err) { failures += 1; out("FAIL  " + t.name); out(String(err && err.stack ? err.stack : err)); }
  }
  out("\n" + passed + " assertions passed");
  return failures;
}

main().then((failures) => { if (failures) process.exitCode = 1; }).catch((err) => { out("FATAL " + String(err && err.stack ? err.stack : err)); process.exitCode = 1; });
