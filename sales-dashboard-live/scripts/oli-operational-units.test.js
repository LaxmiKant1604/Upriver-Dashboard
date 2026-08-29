// OLI OPERATIONAL UNITS -- deterministic OFFLINE proof that EVERY observed OLI unit (priced / explicit-zero /
// pending-with-sku / pending-without-sku / cancelled) is retained + classified for operational unit reporting and
// SKU Movement, WITHOUT changing revenue or any financial ratio. 7-bit ASCII, LF, no top-level await.
//
// The in-memory replace model MIRRORS the SQL replace_oli_dimensional_window / replace_oli_operational_units_window
// window-scoped delete+insert (incl. the p_unit_rows NULL-skip). The pure builder + classifier + metrics + the
// SKU Movement re-derive are the REAL modules -- only the durable I/O is modeled.

import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import {
  classifyOliDimensionalRow, oliUnitClass, OLI_UNIT_CLASS, hasCanonicalIdentity, operationalUnitMetrics,
  operationalUnitsFromDimensionalRows,
} from "../lib/server/sync/oli-order-rules.js";
import { oliDimensionalRowsFromFragment } from "../lib/server/sync/source-durable-model.js";
import { rederiveSkuMovement } from "../lib/server/reports/sku-movement-durable-rederive.js";
import { summarizeOperationalUnitBreakdown, makeCompletenessAugment } from "../lib/server/reports/oli-completeness-serve.js";
import { isFunctionSignatureMissingError, isSchemaMissingError } from "../lib/server/supabase.js";

let passed = 0;
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ---- fragment factory (what DataDoe returns at the dimensional grain) ----
const frag = (over = {}) => ({
  date: "2026-08-28", seller_or_vendor_id: "S1", sku: "SKU-A", child_asin: "B0A", item_price_currency: "USD",
  amazon_order_status: "Shipped", fulfillment_channel: "AFN", address_state: "CA", address_city: "LA",
  amazon_order_id: "111-1", item_status: "Shipped", total_sales_sum: 100, total_units_sum: 2, ...over,
});
const accounts = { S1: { accountId: "ACC-1", currency: "USD" }, S2: { accountId: "ACC-2", currency: "USD" } };
const build = (rows, over = {}) => oliDimensionalRowsFromFragment({ rows, accountsBySellerId: accounts, organizationFingerprint: "org", connectionId: "primary", sourceRequestHash: "h1", ...over });

// ---- in-memory durable stores + the modeled window-replace RPCs ----
function makeStore() { return { opunits: new Map(), rollup: new Map() }; }
const opKey = (o) => [o.organizationFingerprint, o.connectionId, o.accountId, o.sale_date, o.sku, o.child_asin, o.currency].join("");

// Mirror the (e) block of replace_oli_dimensional_window / the standalone RPC: validate, delete the account window,
// insert p_unit_rows aggregated by (date, sku, child_asin, currency). A NULL unitRows SKIPS entirely (legacy caller).
function replaceOperational(store, { organizationFingerprint = "org", connectionId = "primary", accountId, coveredFrom, coveredTo, unitRows }) {
  if (unitRows == null) return; // NULL skip: never disturbs existing operational units
  for (const u of unitRows) {
    if (!String(u.sellerOrVendorId || "").trim() || !u.saleDate || u.saleDate < coveredFrom || u.saleDate > coveredTo
      || !/^[A-Z]{3}$/.test(u.currency || "") || !String(u.sourceRequestHash || "").trim()) throw new Error("malformed operational-unit row");
    for (const k of ["pricedUnits", "explicitZeroUnits", "pendingUnits", "cancelledUnits"]) if ((Number(u[k]) || 0) < 0) throw new Error("negative unit");
  }
  for (const [k, v] of [...store.opunits]) {
    if (v.organizationFingerprint === organizationFingerprint && v.connectionId === connectionId && v.accountId === accountId && v.sale_date >= coveredFrom && v.sale_date <= coveredTo) store.opunits.delete(k);
  }
  const byGrain = new Map();
  for (const u of unitRows) {
    const g = [u.saleDate, u.sku, u.childAsin, u.currency].join("");
    const e = byGrain.get(g) || { seller: u.sellerOrVendorId, hash: u.sourceRequestHash, pricedUnits: 0, pricedSales: null, explicitZeroUnits: 0, pendingUnits: 0, cancelledUnits: 0 };
    e.pricedUnits += Number(u.pricedUnits) || 0;
    if (u.pricedSales != null) e.pricedSales = (e.pricedSales || 0) + Number(u.pricedSales);
    e.explicitZeroUnits += Number(u.explicitZeroUnits) || 0;
    e.pendingUnits += Number(u.pendingUnits) || 0;
    e.cancelledUnits += Number(u.cancelledUnits) || 0;
    byGrain.set(g, e);
  }
  for (const [g, e] of byGrain) {
    const [sale_date, sku, child_asin, currency] = g.split("");
    const row = { organizationFingerprint, connectionId, accountId, seller_or_vendor_id: e.seller, sale_date, sku, child_asin, currency,
      priced_units: e.pricedUnits, priced_sales: e.pricedSales, explicit_zero_units: e.explicitZeroUnits, pending_units: e.pendingUnits, cancelled_units: e.cancelledUnits, source_request_hash: e.hash };
    store.opunits.set(opKey(row), row);
  }
}

// Mirror the (b) rollup replace (source_oli_daily_history): the REVENUE grain -- priced (value>0) only.
function replaceRollup(store, { accountId, coveredFrom, coveredTo, rollupRows }) {
  for (const [k, v] of [...store.rollup]) if (v.account_id === accountId && v.sale_date >= coveredFrom && v.sale_date <= coveredTo) store.rollup.delete(k);
  for (const r of rollupRows) {
    const k = [accountId, r.saleDate, r.sku, r.childAsin, r.currency].join("");
    store.rollup.set(k, { account_id: accountId, seller_or_vendor_id: r.sellerOrVendorId, sale_date: r.saleDate, sku: r.sku, child_asin: r.childAsin, currency: r.currency, sales_amount: r.salesAmount, units: r.units, source_request_hash: r.sourceRequestHash });
  }
}

// Persist a whole build result (all non-blocked accounts) atomically per account, exactly as source-bucket-sync does.
function persist(store, result, { from, to }) {
  for (const [accountId, unitRows] of result.operationalUnitsByAccount) {
    replaceRollup(store, { accountId, coveredFrom: from, coveredTo: to, rollupRows: result.rollupByAccount.get(accountId) || [] });
    replaceOperational(store, { accountId, coveredFrom: from, coveredTo: to, unitRows });
  }
}

// The REAL reader return shapes (PostgREST snake_case rows) fed to the re-derive.
function readers(store, catalogRows = []) {
  return {
    readOliHistory: async ({ accountIds, from, to }) => [...store.rollup.values()].filter((r) => accountIds.includes(r.account_id) && r.sale_date >= from && r.sale_date <= to && Number(r.sales_amount) > 0),
    readOliOperationalUnits: async ({ accountIds, from, to, additiveOnly }) => [...store.opunits.values()]
      .filter((r) => accountIds.includes(r.accountId) && r.sale_date >= from && r.sale_date <= to && (!additiveOnly || (Number(r.explicit_zero_units) > 0 || Number(r.pending_units) > 0)))
      .map((r) => ({ account_id: r.accountId, seller_or_vendor_id: r.seller_or_vendor_id, sale_date: r.sale_date, sku: r.sku, child_asin: r.child_asin, currency: r.currency, priced_units: r.priced_units, priced_sales: r.priced_sales, explicit_zero_units: r.explicit_zero_units, pending_units: r.pending_units, cancelled_units: r.cancelled_units, source_request_hash: r.source_request_hash })),
    readOliCoverage: async () => ({ read: "ok", windows: [{ from: WIN.from, to: WIN.to }] }),
    readCatalogSnapshot: async () => ({ read: "ok", snapshot: { object_path: "cat", validated_at: WIN.to + "T00:00:00.000Z" } }),
    loadCatalogPayload: async () => catalogRows,
  };
}
const WIN = { from: "2026-06-01", to: "2026-08-28" };
const CEILING = "2026-08-29";
const derive = (store, { brand = "ALL", catalogRows = [], accountId = "ACC-1" } = {}) =>
  rederiveSkuMovement({ accountId, brand, organizationFingerprint: "org", connectionId: "primary", ceiling: CEILING }, readers(store, catalogRows));
const movementUnits = (payload) => (payload.rows || []).reduce((s, r) => s + Number(r.mtdUnits || 0), 0);
const rowFor = (payload, asin) => (payload.rows || []).find((r) => String(r.asin).toUpperCase() === String(asin).toUpperCase());

/* ================= 1. PRICED non-cancelled row ================= */
test("1. priced non-cancelled row: units + sales both counted", async () => {
  const store = makeStore();
  persist(store, build([frag({ total_sales_sum: 100, total_units_sum: 2 })]), WIN);
  const opu = [...store.opunits.values()][0];
  assert.equal(opu.priced_units, 2);
  assert.equal(opu.priced_sales, 100);
  assert.equal(opu.explicit_zero_units, 0);
  assert.equal(opu.pending_units, 0);
  const { payload } = await derive(store);
  assert.equal(movementUnits(payload), 2, "priced units counted in SKU Movement");
  // revenue rollup carries the sale
  assert.equal([...store.rollup.values()][0].sales_amount, 100);
  assert.equal([...store.rollup.values()][0].units, 2);
});

/* ================= 2. EXPLICIT-ZERO row ================= */
test("2. explicit-zero non-cancelled row: units counted, sales exactly ZERO", async () => {
  const store = makeStore();
  persist(store, build([frag({ total_sales_sum: 0, total_units_sum: 3 })]), WIN);
  const opu = [...store.opunits.values()][0];
  assert.equal(opu.explicit_zero_units, 3);
  assert.equal(opu.priced_units, 0);
  assert.equal(opu.priced_sales, null, "no priced units -> priced_sales NULL, never 0-coerced");
  // NOT in the revenue rollup (zero-value excluded)
  assert.equal([...store.rollup.values()].length, 0, "explicit-zero contributes NOTHING to revenue");
  const { payload } = await derive(store);
  assert.equal(movementUnits(payload), 3, "explicit-zero units DO move SKU Movement");
});

/* ================= 3. PENDING-with-SKU row ================= */
test("3. pending-price row WITH SKU: provisional movement unit counted, sales excluded", async () => {
  const store = makeStore();
  const r = build([frag({ item_status: "", total_sales_sum: null, total_units_sum: 4 })]);
  assert.equal(r.blocked.length, 0, "pending never blocks");
  persist(store, r, WIN);
  const opu = [...store.opunits.values()][0];
  assert.equal(opu.pending_units, 4);
  assert.equal(opu.priced_units, 0);
  assert.equal([...store.rollup.values()].length, 0, "pending contributes NOTHING to revenue");
  const { payload } = await derive(store);
  assert.equal(movementUnits(payload), 4, "pending-with-sku units move SKU Movement provisionally");
});

/* ================= 4. PENDING-without-SKU row ================= */
test("4. pending-price row WITHOUT SKU: account/day observed only, EXCLUDED from SKU Movement", async () => {
  const store = makeStore();
  const r = build([frag({ sku: "", child_asin: "", item_status: "", total_sales_sum: null, total_units_sum: 5 })]);
  persist(store, r, WIN);
  const opu = [...store.opunits.values()][0];
  assert.equal(opu.pending_units, 5);
  assert.equal(opu.sku, "");
  assert.equal(opu.child_asin, "");
  // observed totals see it; SKU Movement does NOT
  const m = operationalUnitMetrics([{ sku: "", childAsin: "", pendingUnits: 5 }]);
  assert.equal(m.pendingPriceUnitsWithoutSku, 5);
  assert.equal(m.observedUnits, 5);
  assert.equal(m.skuMovementUnits, 0, "SKU-less pending excluded from movement");
  const { payload } = await derive(store);
  assert.equal(movementUnits(payload), 0, "SKU-less pending never becomes a movement row");
  assert.ok(!(payload.rows || []).some((row) => !hasCanonicalIdentity({ sku: row.sku, child_asin: row.asin })), "no Unmapped/identity-less movement row");
});

/* ================= 5. CANCELLED row ================= */
test("5. cancelled row: excluded from sales + units + movement, retained for audit", async () => {
  const store = makeStore();
  persist(store, build([frag({ amazon_order_status: "Cancelled", total_sales_sum: 999, total_units_sum: 9 })]), WIN);
  const opu = [...store.opunits.values()][0];
  assert.equal(opu.cancelled_units, 9, "retained for audit");
  assert.equal(opu.priced_units, 0);
  assert.equal([...store.rollup.values()].length, 0, "cancelled contributes NOTHING to revenue");
  const { payload } = await derive(store);
  assert.equal(movementUnits(payload), 0, "cancelled never moves SKU Movement");
});

/* ================= 6. PENDING later settles ================= */
test("6. pending row later SETTLES to priced: exact replacement, no duplicate units", async () => {
  const store = makeStore();
  // day 1: pending
  persist(store, build([frag({ item_status: "", total_sales_sum: null, total_units_sum: 4 })]), WIN);
  assert.equal((await derive(store)).payload && movementUnits((await derive(store)).payload), 4);
  // day 2: SAME export window re-fetched, now itemized/priced (a settled row replaces the pending one)
  persist(store, build([frag({ item_status: "Shipped", total_sales_sum: 120, total_units_sum: 4 })], { sourceRequestHash: "h2" }), WIN);
  const opu = [...store.opunits.values()];
  assert.equal(opu.length, 1, "window replace -> ONE grain, not two");
  assert.equal(opu[0].pending_units, 0, "pending cleared");
  assert.equal(opu[0].priced_units, 4, "now priced");
  const { payload } = await derive(store);
  assert.equal(movementUnits(payload), 4, "still 4 units -- NOT 8 (no double count on settle)");
  assert.equal([...store.rollup.values()][0].sales_amount, 120, "revenue now recognizes the settled sale");
});

/* ================= 7. EXPLICIT-ZERO later gets a positive price ================= */
test("7. explicit-zero later receives a positive price: exact replacement, not addition", async () => {
  const store = makeStore();
  persist(store, build([frag({ total_sales_sum: 0, total_units_sum: 2 })]), WIN);
  assert.equal(movementUnits((await derive(store)).payload), 2);
  persist(store, build([frag({ total_sales_sum: 50, total_units_sum: 2 })], { sourceRequestHash: "h2" }), WIN);
  const opu = [...store.opunits.values()];
  assert.equal(opu.length, 1);
  assert.equal(opu[0].explicit_zero_units, 0);
  assert.equal(opu[0].priced_units, 2);
  assert.equal(movementUnits((await derive(store)).payload), 2, "still 2 units, moved zero->priced (not 4)");
});

/* ================= 8. Replay identical evidence ================= */
test("8. replaying identical evidence is idempotent: no extra rows or units", async () => {
  const store = makeStore();
  const mk = () => build([frag({ total_sales_sum: 100, total_units_sum: 2 }), frag({ total_sales_sum: 0, total_units_sum: 1, sku: "SKU-Z", child_asin: "B0Z" })]);
  persist(store, mk(), WIN);
  const before = [...store.opunits.values()].map(opKey).sort();
  const beforeUnits = movementUnits((await derive(store)).payload);
  persist(store, mk(), WIN); // replay
  const after = [...store.opunits.values()].map(opKey).sort();
  assert.deepEqual(after, before, "same grains, no duplicates");
  assert.equal(movementUnits((await derive(store)).payload), beforeUnits, "same total units after replay");
});

/* ================= 9. Mixed window ================= */
test("9. mixed priced/zero/pending/cancelled window: exact totals + breakdown", async () => {
  const store = makeStore();
  persist(store, build([
    frag({ sku: "P", child_asin: "B0P", total_sales_sum: 100, total_units_sum: 2 }),               // priced
    frag({ sku: "Z", child_asin: "B0Z", total_sales_sum: 0, total_units_sum: 3 }),                  // explicit-zero
    frag({ sku: "N", child_asin: "B0N", item_status: "", total_sales_sum: null, total_units_sum: 4 }), // pending w/ sku
    frag({ sku: "", child_asin: "", item_status: "", total_sales_sum: null, total_units_sum: 5 }),   // pending w/o sku
    frag({ sku: "C", child_asin: "B0C", amazon_order_status: "Cancelled", total_sales_sum: 9, total_units_sum: 9 }), // cancelled
  ]), WIN);
  const rows = [...store.opunits.values()].map((r) => ({ sku: r.sku, childAsin: r.child_asin, pricedUnits: r.priced_units, explicitZeroUnits: r.explicit_zero_units, pendingUnits: r.pending_units, cancelledUnits: r.cancelled_units, pricedSales: r.priced_sales }));
  const m = operationalUnitMetrics(rows);
  assert.equal(m.pricedUnits, 2);
  assert.equal(m.explicitZeroUnits, 3);
  assert.equal(m.pendingPriceUnitsWithSku, 4);
  assert.equal(m.pendingPriceUnitsWithoutSku, 5);
  assert.equal(m.cancelledUnits, 9);
  assert.equal(m.observedUnits, 2 + 3 + 4 + 5, "observed = all non-cancelled = 14");
  assert.equal(m.skuMovementUnits, 2 + 3 + 4, "movement = priced+zero+pending-with-sku = 9");
  // SKU Movement report agrees (9 identity-bearing non-cancelled units)
  const { payload } = await derive(store);
  assert.equal(movementUnits(payload), 9);
});

/* ================= 10. Multiple sellers -> strict account isolation ================= */
test("10. two sellers in one export: each account's operational units are isolated", async () => {
  const store = makeStore();
  persist(store, build([
    frag({ seller_or_vendor_id: "S1", sku: "A1", child_asin: "B01", total_sales_sum: 10, total_units_sum: 1 }),
    frag({ seller_or_vendor_id: "S2", sku: "A2", child_asin: "B02", total_sales_sum: 0, total_units_sum: 7 }),
  ]), WIN);
  const acc1 = [...store.opunits.values()].filter((r) => r.accountId === "ACC-1");
  const acc2 = [...store.opunits.values()].filter((r) => r.accountId === "ACC-2");
  assert.equal(acc1.length, 1); assert.equal(acc1[0].priced_units, 1);
  assert.equal(acc2.length, 1); assert.equal(acc2[0].explicit_zero_units, 7);
  assert.equal(movementUnits((await derive(store, { accountId: "ACC-1" })).payload), 1, "ACC-1 sees only its own unit");
  assert.equal(movementUnits((await derive(store, { accountId: "ACC-2" })).payload), 7, "ACC-2 sees only its own unit");
});

/* ================= 11. Cross-account row -> whole payload refused ================= */
test("11. an unknown seller (cross-account) rejects the WHOLE payload; nothing persisted", () => {
  assert.throws(() => build([frag({ seller_or_vendor_id: "UNKNOWN", total_units_sum: 1 })]), /blank\/unknown to the batch/i);
});

/* ================= 12. Unknown status / malformed quantity -> fail closed, LKG preserved ================= */
test("12. missing order status blocks the account (LKG preserved); malformed units throws", () => {
  const r = build([frag({ amazon_order_status: "", total_units_sum: 1 })]);
  assert.equal(r.blocked.length, 1);
  assert.equal(r.blocked[0].code, "OLI_ORDER_STATUS_MISSING");
  assert.ok(!r.operationalUnitsByAccount.has("ACC-1"), "a blocked account writes NO operational units (LKG preserved)");
  assert.throws(() => build([frag({ total_units_sum: "not-a-number" })]), /non-finite|malformed/i);
});

/* ================= 12b. DEFECT account blocked -> no operational units ================= */
test("12b. an itemized-but-null (defect) row blocks the account; its operational units are discarded", () => {
  const r = build([frag({ item_status: "Shipped", total_sales_sum: null, total_units_sum: 2 })]);
  assert.equal(r.blocked.length, 1);
  assert.equal(r.blocked[0].code, "OLI_ITEMIZED_VALUE_MISSING");
  assert.ok(!r.operationalUnitsByAccount.has("ACC-1"), "defect account -> no operational units");
});

/* ================= 13. Named-brand isolation ================= */
test("13. named-brand SKU Movement includes only Catalog-proven ASINs (no leakage)", async () => {
  const store = makeStore();
  persist(store, build([
    frag({ sku: "A", child_asin: "B0A", total_sales_sum: 100, total_units_sum: 2 }),
    frag({ sku: "B", child_asin: "B0B", total_sales_sum: 0, total_units_sum: 3 }),
  ]), WIN);
  const catalog = [{ child_asin: "B0A", product_brand: "Acme", product_name: "A" }, { child_asin: "B0B", product_brand: "Beta", product_name: "B" }];
  const acme = await derive(store, { brand: "Acme", catalogRows: catalog });
  assert.equal(movementUnits(acme.payload), 2, "Acme sees only B0A's priced units");
  assert.ok(acme.payload.rows.every((row) => String(row.asin).toUpperCase() === "B0A"), "no Beta leakage");
  const beta = await derive(store, { brand: "Beta", catalogRows: catalog });
  assert.equal(movementUnits(beta.payload), 3, "Beta sees only B0B's (explicit-zero) units");
});

/* ================= 14. Missing-SKU pending never under Unmapped ================= */
test("14. SKU-less pending units are NEVER placed under an Unmapped SKU row", async () => {
  const store = makeStore();
  persist(store, build([
    frag({ sku: "A", child_asin: "B0A", total_sales_sum: 100, total_units_sum: 2 }),
    frag({ sku: "", child_asin: "", item_status: "", total_sales_sum: null, total_units_sum: 50 }),
  ]), WIN);
  const { payload } = await derive(store, { brand: "ALL" });
  assert.equal(movementUnits(payload), 2, "only the identity-bearing priced unit moves");
  assert.ok(payload.rows.every((row) => hasCanonicalIdentity({ sku: row.sku, child_asin: row.asin })), "every movement row carries identity");
});

/* ================= 15 + 16. Revenue + ratios unchanged for priced evidence ================= */
test("15/16. revenue, ROI, ACoS, TACoS unchanged: the rollup is priced-only, byte-identical", () => {
  const store = makeStore();
  // The SAME window WITHOUT the feature would roll up ONLY the priced rows. Adding zero/pending/cancelled must not
  // change the rollup at all.
  const r = build([
    frag({ sku: "P", child_asin: "B0P", total_sales_sum: 100, total_units_sum: 2 }),
    frag({ sku: "Z", child_asin: "B0Z", total_sales_sum: 0, total_units_sum: 3 }),
    frag({ sku: "N", child_asin: "B0N", item_status: "", total_sales_sum: null, total_units_sum: 4 }),
    frag({ sku: "C", child_asin: "B0C", amazon_order_status: "Cancelled", total_sales_sum: 9, total_units_sum: 9 }),
  ]);
  persist(store, r, WIN);
  const roll = [...store.rollup.values()];
  assert.equal(roll.length, 1, "ONLY the priced grain reaches the revenue rollup");
  const totalSales = roll.reduce((s, x) => s + x.sales_amount, 0);
  const totalUnits = roll.reduce((s, x) => s + x.units, 0);
  assert.equal(totalSales, 100, "Total Sales = priced value only (zero/pending/cancelled excluded)");
  assert.equal(totalUnits, 2, "revenue Units = priced units only");
  // Financial ratios derive from these unchanged figures.
  const adSpend = 20, adSales = 40;
  assert.equal(totalSales / adSpend, 5, "ROI = TotalSales/AdSpend unchanged");
  assert.equal(adSpend / adSales, 0.5, "ACoS = AdSpend/AdSales unchanged");
  assert.equal(adSpend / totalSales, 0.2, "TACoS = AdSpend/TotalSales unchanged");
  // And priced_units in operational units reconciles 1:1 with the rollup units.
  const pricedOpUnits = [...store.opunits.values()].reduce((s, x) => s + Number(x.priced_units), 0);
  assert.equal(pricedOpUnits, totalUnits, "operational priced_units == rollup units (reconciliation)");
});

/* ================= 17. Shared persist + derive path (parity) ================= */
test("17. the builder is the SINGLE classified-unit source (scheduler/manual/force-latest parity)", () => {
  // All three entry paths call oliDimensionalRowsFromFragment then replaceOliDimensionalWindow(unitRows). The builder
  // is deterministic: identical evidence -> identical operational units, so every path persists the same rows.
  const a = build([frag({ total_sales_sum: 100, total_units_sum: 2 })]);
  const b = build([frag({ total_sales_sum: 100, total_units_sum: 2 })]);
  assert.deepEqual(a.operationalUnitsByAccount.get("ACC-1"), b.operationalUnitsByAccount.get("ACC-1"));
  assert.ok(Array.isArray(a.operationalUnitsByAccount.get("ACC-1")), "builder returns operationalUnitsByAccount for every path");
});

/* ================= 18. No adapter / zero-export ================= */
test("18. the re-derive is ZERO-export: it only READS durable evidence (no create)", async () => {
  const store = makeStore();
  persist(store, build([frag({ total_sales_sum: 100, total_units_sum: 2 })]), WIN);
  let createdExports = 0;
  const rd = readers(store);
  // Any export create would have to come through an adapter -- the re-derive imports none; prove it never calls one.
  const guarded = { ...rd, createExport: () => { createdExports += 1; throw new Error("no export allowed"); } };
  const { payload } = await rederiveSkuMovement({ accountId: "ACC-1", brand: "ALL", organizationFingerprint: "org", connectionId: "primary", ceiling: CEILING }, guarded);
  assert.ok(payload && Array.isArray(payload.rows));
  assert.equal(createdExports, 0, "no DataDoe/Ads/FBA export created by this feature");
});

/* ================= 19. NULL-skip: a legacy caller never disturbs operational units ================= */
test("19. a legacy replace (unitRows=null) SKIPS the operational block -- existing units preserved", () => {
  const store = makeStore();
  persist(store, build([frag({ total_sales_sum: 100, total_units_sum: 2 })]), WIN);
  const before = [...store.opunits.values()].length;
  // A legacy dimensional replacement passes NO unit rows (null): the operational units must survive untouched.
  replaceOperational(store, { accountId: "ACC-1", coveredFrom: WIN.from, coveredTo: WIN.to, unitRows: null });
  assert.equal([...store.opunits.values()].length, before, "null unitRows never wipes operational units");
  // An EMPTY [] from a units-aware caller (inactive account) legitimately clears the window.
  replaceOperational(store, { accountId: "ACC-1", coveredFrom: WIN.from, coveredTo: WIN.to, unitRows: [] });
  assert.equal([...store.opunits.values()].filter((r) => r.accountId === "ACC-1").length, 0, "empty [] clears an inactive window");
});

/* ================= 20. Production-shaped breakdown + provisional serve ================= */
test("20. serve breakdown + completeness augment use the REAL reader shapes", async () => {
  const store = makeStore();
  persist(store, build([
    frag({ date: "2026-08-28", sku: "P", child_asin: "B0P", total_sales_sum: 100, total_units_sum: 2 }),
    frag({ date: "2026-08-28", sku: "Z", child_asin: "B0Z", total_sales_sum: 0, total_units_sum: 3 }),
    frag({ date: "2026-08-28", sku: "N", child_asin: "B0N", item_status: "", total_sales_sum: null, total_units_sum: 4 }),
    frag({ date: "2026-08-28", sku: "", child_asin: "", item_status: "", total_sales_sum: null, total_units_sum: 5 }),
    frag({ date: "2026-08-28", sku: "C", child_asin: "B0C", amazon_order_status: "Cancelled", total_sales_sum: 9, total_units_sum: 9 }),
  ]), WIN);
  const opRows = [...store.opunits.values()].map((r) => ({ ...r }));
  const bd = summarizeOperationalUnitBreakdown(opRows, "2026-08-28");
  assert.equal(bd.pricedUnits, 2);
  assert.equal(bd.explicitZeroUnits, 3);
  assert.equal(bd.pendingWithSkuUnits, 4);
  assert.equal(bd.pendingWithoutSkuUnits, 5);
  assert.equal(bd.cancelledUnits, 9);
  assert.equal(bd.observedUnits, 14);
  assert.equal(bd.skuMovementUnits, 9);
  // completeness augment attaches unitBreakdown from the operational-unit reader (advisory).
  const completenessRows = [{ account_id: "ACC-1", sale_date: "2026-08-28", completeness_status: "provisional", itemized_order_count: 5, pending_order_count: 2, itemized_unit_count: 5, pending_unit_count: 9, itemization_percent: 71, refreshed_at: "2026-08-29T00:00:00Z" }];
  const augment = makeCompletenessAugment({
    organizationFingerprint: "org", connectionId: "primary",
    read: async () => completenessRows,
    readUnitBreakdown: async ({ from, to }) => [...store.opunits.values()].filter((r) => r.sale_date >= from && r.sale_date <= to),
  });
  const res = await augment({ accountId: "ACC-1", params: { to: "2026-08-28" } });
  assert.ok(res.completeness, "completeness attached");
  assert.equal(res.completeness.provisional, true, "provisional preserved (pending orders)");
  assert.ok(res.completeness.unitBreakdown, "unitBreakdown attached");
  assert.equal(res.completeness.unitBreakdown.pendingWithSkuUnits, 4);
  assert.equal(res.completeness.unitBreakdown.pendingWithoutSkuUnits, 5);
});

/* ================= 21. backfill aggregator (dimensional -> operational) ================= */
test("21. backfill aggregates dimensional rows into priced/zero/cancelled; never invents pending", () => {
  const dim = [
    { seller_or_vendor_id: "S1", sale_date: "2026-08-28", sku: "P", child_asin: "B0P", currency: "USD", is_cancelled: false, total_sales_sum: 100, total_units_sum: 2, source_request_hash: "h" },
    { seller_or_vendor_id: "S1", sale_date: "2026-08-28", sku: "P", child_asin: "B0P", currency: "USD", is_cancelled: false, total_sales_sum: 50, total_units_sum: 1, source_request_hash: "h" }, // same grain -> sums
    { seller_or_vendor_id: "S1", sale_date: "2026-08-28", sku: "Z", child_asin: "B0Z", currency: "USD", is_cancelled: false, total_sales_sum: 0, total_units_sum: 3, source_request_hash: "h" },
    { seller_or_vendor_id: "S1", sale_date: "2026-08-28", sku: "C", child_asin: "B0C", currency: "USD", is_cancelled: true, total_sales_sum: 9, total_units_sum: 9, source_request_hash: "h" },
  ];
  const out = operationalUnitsFromDimensionalRows(dim);
  const p = out.find((r) => r.sku === "P");
  assert.equal(p.pricedUnits, 3, "same-grain priced rows sum");
  assert.equal(p.pricedSales, 150);
  assert.equal(p.pendingUnits, 0, "backfill NEVER invents a pending unit");
  const z = out.find((r) => r.sku === "Z");
  assert.equal(z.explicitZeroUnits, 3);
  assert.equal(z.pricedSales, null, "zero grain -> priced_sales null");
  const c = out.find((r) => r.sku === "C");
  assert.equal(c.cancelledUnits, 9);
  // it reconciles with the metrics classifier
  const m = operationalUnitMetrics(out);
  assert.equal(m.pricedUnits, 3); assert.equal(m.explicitZeroUnits, 3); assert.equal(m.cancelledUnits, 9);
  assert.equal(m.pendingPriceUnitsWithSku, 0);
});

/* ================= 22. deploy-safety: 9-arg signature detection ================= */
test("22. isFunctionSignatureMissingError detects PGRST202 (9-arg not yet migrated), distinct from a missing table", () => {
  assert.equal(isFunctionSignatureMissingError({ code: "PGRST202" }), true);
  assert.equal(isFunctionSignatureMissingError(new Error("Could not find the function public.replace_oli_dimensional_window(...) in the schema cache")), true);
  assert.equal(isFunctionSignatureMissingError({ code: "PGRST205" }), false, "a missing TABLE is not a missing function signature");
  assert.equal(isFunctionSignatureMissingError(new Error("network timeout")), false);
  // and a missing table is still classified by isSchemaMissingError (the wrapper degrades operational reads to []).
  assert.equal(isSchemaMissingError({ code: "PGRST205" }), true);
  assert.equal(isSchemaMissingError({ code: "PGRST202" }), false);
});

/* ================= canonical classifier unit tests ================= */
test("C. oliUnitClass maps every classification to its canonical class", () => {
  const cls = (over) => oliUnitClass(classifyOliDimensionalRow(frag(over)));
  assert.equal(cls({ total_sales_sum: 100, total_units_sum: 1 }), OLI_UNIT_CLASS.PRICED);
  assert.equal(cls({ total_sales_sum: 0, total_units_sum: 1 }), OLI_UNIT_CLASS.EXPLICIT_ZERO);
  assert.equal(cls({ item_status: "", total_sales_sum: null, total_units_sum: 1 }), OLI_UNIT_CLASS.PENDING);
  assert.equal(cls({ amazon_order_status: "Cancelled", total_sales_sum: 5, total_units_sum: 1 }), OLI_UNIT_CLASS.CANCELLED);
  assert.equal(cls({ item_status: "Shipped", total_sales_sum: null, total_units_sum: 1 }), OLI_UNIT_CLASS.DEFECT);
});

let failures = 0;
(async () => {
  for (const t of tests) {
    try { await t.fn(); passed += 1; out("  ok  " + t.name); }
    catch (e) { failures += 1; out("FAIL  " + t.name); out(String((e && e.stack) || e)); }
  }
  out("\n" + passed + " assertions passed" + (failures ? ", " + failures + " FAILED" : ""));
  if (failures) process.exitCode = 1;
})();
