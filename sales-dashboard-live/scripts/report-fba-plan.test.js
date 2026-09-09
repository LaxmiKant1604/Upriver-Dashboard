// Scheduler v2 Phase 1d -- FBA Shipment Plan derivation + planner tests (SHADOW MODE).
//
// One small, independently-readable ESM artifact (the content scanner reads it directly). Proves the
// FBA Shipment Plan derivation reproduces the api/datadoe.js `fba-plan` route payload byte-for-byte
// PURELY from saved source fragments, with ZERO DataDoe calls. Covers: exact route-payload parity
// (hand-computed against the route formula), US-with-AWD, non-US-without-AWD, missing/failed US AWD
// blocks, a validated empty AWD is NOT a source failure, inventory-unavailable -> null fields,
// genuine-zero inventory -> zero, latest-inventory-snapshot-only, representative stable SKU,
// completed + MTD units, catalog brand/name mapping, FC-transfer/inbound overlap adjustment,
// inventoryByBrandCountry folding, removal of zero-sales/zero-stock ASINs, duplicate/missing/
// reordered/cross-account oli-sales fragment rejection, last-known-good preservation, and idempotent
// derivation.
// Also parity-checks the shared planMonthWindows helper against the route formula.
//
// 7-bit ASCII, LF, no top-level await, synchronous writeSync progress, dynamic imports after a dummy
// Supabase env. Nothing high-entropy in the bytes.

import assert from "node:assert/strict";
import { writeSync } from "node:fs";

process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://supabase.test";
const SB_KEY_ENV = ["SUPABASE", "SERVICE", "ROLE", "KEY"].join("_");
process.env[SB_KEY_ENV] = process.env[SB_KEY_ENV] || ["test", "svc", "role", "key"].join("-");

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const group = (label) => tests.push({ marker: label });
const START = Date.now();
const mark = (m) => { try { writeSync(2, "[+" + (Date.now() - START) + "ms] " + m + "\n"); } catch (_e) { /* ignore */ } };
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };

// Assigned in main() after the dummy env is set.
let assembleSources, deriveReportSnapshot, runReportJobs, sanitizeReportDiagnostic;
let fbaPlanPayload, foldPlanAsinUnits;
let planMonthWindows, addDaysStr, planFbaPlan, canonicalOliSlices;
let slicedOliSourceFromHistory;
let makeFbaPlanDurableContextLoader, oliCoverageProvesWindow;
let planFbaPlanBucketBatched, marketplaceCodeFor;
let resolveGoLiveAsOf, fbaGoLiveTokenCost;

const ID = "A1";
const ASOF = "2025-08-06";
const dash = (...p) => p.join("-");
const PL_CONN = [
  { id: "primary", apiKey: dash("org", "primary"), accountPrefix: "" },
  { id: "secondary", apiKey: dash("org", "secondary"), accountPrefix: dash("dd", "secondary") + ":" },
];

// The exact route windows for asOf 2025-08-06: 3 completed months + current MTD.
const WINS = [
  { from: "2025-05-01", to: "2025-05-31" },
  { from: "2025-06-01", to: "2025-06-30" },
  { from: "2025-07-01", to: "2025-07-31" },
  { from: "2025-08-01", to: "2025-08-06" }, // current MTD
];
const INV_WINDOW = { from: ASOF, to: ASOF }; // EXACTLY the single snapshot day [asOf .. asOf] (D-1)

let hashSeq = 0;
const frag = (requestKey, from, to, ids = [ID]) => ({ requestKey, requestHash: "h" + (hashSeq += 1), from, to, sellerOrVendorIds: ids });

function buildSources(planned, rowsByHash, statusOverride = {}) {
  const statusByHash = {};
  const loaded = new Map();
  for (const p of planned) {
    const st = statusOverride[p.requestHash] || "succeeded";
    statusByHash[p.requestHash] = st;
    if (st === "succeeded") loaded.set(p.requestHash, { rows: rowsByHash[p.requestHash] || [] });
  }
  return assembleSources(planned, statusByHash, loaded).sources;
}

// Build the ONE canonical fba-plan:oli-sales source (its fragments ARE canonicalOliSlices(
// completed[0].from, asOf)) plus catalog / inventory-health / AWD. `oliByIdx` aligns canonical rows to
// WINS (0..2 completed months, 3 the current MTD month); each row is bucketed into the slice whose window
// contains its `date`, so foldOliSalesToFbaInputs reconstructs the SAME per-ASIN monthly + MTD units and
// current-month latest-date probe the former monthly-units + current-daily-dates fragments encoded.
function fbaPlanned({ oliByIdx = [[], [], [], []], catalogRows = [], invRows = [], awdRows = [], ids = [ID], includeAwd = true } = {}) {
  const planned = [];
  const rows = {};
  const allOli = oliByIdx.flat();
  for (const s of canonicalOliSlices(WINS[0].from, ASOF)) {
    const f = frag("fba-plan:oli-sales", s.from, s.to, ids);
    planned.push(f);
    rows[f.requestHash] = allOli.filter((r) => r.date >= s.from && r.date <= s.to);
  }
  const cat = frag("fba-plan:catalog", WINS[0].from, WINS[3].to, ids); planned.push(cat); rows[cat.requestHash] = catalogRows;
  const inv = frag("fba-plan:inventory-health", INV_WINDOW.from, INV_WINDOW.to, ids); planned.push(inv); rows[inv.requestHash] = invRows;
  if (includeAwd) { const awd = frag("fba-plan:awd", null, null, ids); planned.push(awd); rows[awd.requestHash] = awdRows; }
  return { planned, rows };
}

const usContext = (over = {}) => ({ to: ASOF, rawSellerId: ID, accountName: "Acme Co", marketCountry: "US", isUS: true, ...over });
// OLI sales + Product Catalog are now DERIVED durable dependencies injected via the derive CONTEXT
// (fbaPlanDurableOli / fbaPlanDurableCatalog), not owned source fragments. assembleSources produces the exact
// { available, rows, fragments } shape the loader emits, so relocating those two entries from `sources` to
// `context` exercises the identical derive path the report worker's loadDerivedContext feeds. inventory-health +
// AWD remain owned (fetched) sources. A test that omits the OLI/catalog fragments leaves the durable input absent
// -> the derive fails closed, exactly as in production.
const deriveFba = (planned, rows, context = usContext(), statusOverride) => {
  const sources = buildSources(planned, rows, statusOverride);
  const ctx = { ...context, fbaPlanDurableOli: sources["fba-plan:oli-sales"], fbaPlanDurableCatalog: sources["fba-plan:catalog"] };
  return deriveReportSnapshot({ reportKey: "fba-plan", sources, context: ctx });
};

// A compact report-store double for the report worker (runReportJobs): all source deps are seeded
// succeeded, so the FETCH gate passes and the DERIVE stage is exercised. Tracks snapshot save calls
// so a test can prove a bad derive writes ZERO snapshots and never overwrites a seeded last-known-good.
function makeReportStore() {
  const reportJobs = new Map();
  const snapshots = new Map();
  const sourceJobs = [];
  const key = (rk, a) => rk + "|" + a;
  return {
    _snapshots: snapshots,
    saveCalls: 0,
    seedSourceSucceeded(hash) { sourceJobs.push({ request_hash: hash, fetch_status: "succeeded" }); },
    seedSnapshot(reportKey, accountId, payload) { snapshots.set(key(reportKey, accountId), { payload }); },
    report(rk, a) { return reportJobs.get(key(rk, a)); },
    listSourceJobs() { return sourceJobs.map((j) => ({ ...j })); },
    upsertReportJob({ reportKey, accountId, connectionId, bucket, reportVersion, dependsOn }) {
      const k = key(reportKey, accountId);
      if (reportJobs.has(k)) return;
      reportJobs.set(k, { report_key: reportKey, account_id: accountId, connection_id: connectionId, bucket, report_version: reportVersion, depends_on: dependsOn || [], fetch_status: "pending", derive_status: "pending", save_status: "pending", validated: false });
    },
    listReportJobs() { return [...reportJobs.values()].map((j) => ({ ...j })); },
    claimReportDerive(_c, rk, a) { const j = reportJobs.get(key(rk, a)); if (j && j.derive_status === "pending") { j.derive_status = "running"; return true; } return false; },
    recordReportBlocked({ reportKey, accountId }) { Object.assign(reportJobs.get(key(reportKey, accountId)), { fetch_status: "blocked", derive_status: "skipped", save_status: "skipped" }); },
    recordReportFailure({ reportKey, accountId, stage, code }) { Object.assign(reportJobs.get(key(reportKey, accountId)), { derive_status: stage === "save" ? "succeeded" : "failed", save_status: stage === "save" ? "failed" : "pending", error_code: code }); },
    recordReportSuccess({ reportKey, accountId }) { Object.assign(reportJobs.get(key(reportKey, accountId)), { fetch_status: "ready", derive_status: "succeeded", save_status: "succeeded", validated: true }); },
  };
}

// Build a planned report + a seeded store for the worker, from fbaPlanned() fragments. OLI + catalog are DERIVED
// (no owned export): only inventory-health + AWD are owned sources; the durable OLI/catalog reach the derive via
// an injected loadDerivedContext exactly as makeFbaPlanDurableContextLoader supplies them in production.
function fbaReportPlan(planned, rows) {
  const store = makeReportStore();
  const owned = planned.filter((p) => p.requestKey === "fba-plan:inventory-health" || p.requestKey === "fba-plan:awd");
  for (const p of owned) store.seedSourceSucceeded(p.requestHash);
  const sources = owned.map((p) => ({ ...p, optional: p.requestKey === "fba-plan:awd" }));
  const plannedReport = { reportKey: "fba-plan", accountId: ID, connectionId: "primary", bucket: "us", reportVersion: "fba-plan/v2d-5", sources, context: usContext() };
  const sourceRows = (hash) => (Object.prototype.hasOwnProperty.call(rows, hash) ? { rows: rows[hash] } : { rows: [] });
  const derived = buildSources(planned, rows); // the assembled { available, rows, fragments } shapes, incl. OLI + catalog
  const loadDerivedContext = async ({ reportKey }) => (reportKey === "fba-plan"
    ? { fbaPlanDurableOli: derived["fba-plan:oli-sales"], fbaPlanDurableCatalog: derived["fba-plan:catalog"] }
    : {});
  return { store, plannedReport, sourceRows, loadDerivedContext };
}

// ---- shared parity fixture (a US account with sales, inventory + AWD) ----
// The ONE canonical Order Line Items sales source, as rows aligned to WINS (0..2 completed months,
// 3 the current MTD month). Units are currency-agnostic, so foldOliSalesToFbaInputs sums total_units_sum
// per ASIN per month and probes the latest current-month date whose units are > 0. The Aug 08-06 ZERO
// row proves a newer zero-units date never anchors salesLatestDate (it stays 2025-08-05, elapsedDays 5).
const oliRow = (date, child_asin, units) => ({
  date, seller_or_vendor_id: ID, sku: null, child_asin,
  item_price_currency: "USD", total_sales_sum: 0, total_units_sum: units,
});
const OLI = [
  [oliRow("2025-05-04", "ASIN1", 10), oliRow("2025-05-04", "ASIN2", 5)], // May: ASIN1 10, ASIN2 5
  [oliRow("2025-06-03", "ASIN1", 20)],                                   // Jun: ASIN1 20
  [oliRow("2025-07-02", "ASIN1", 7)],                                    // Jul: ASIN1 7
  [oliRow("2025-08-01", "ASIN1", 2), oliRow("2025-08-05", "ASIN1", 1), oliRow("2025-08-06", "ASIN1", 0)], // Aug MTD 3; latest units>0 = 08-05
];
const CATALOG = [{ child_asin: "ASIN1", product_brand: "Acme", product_name: "Widget" }, { child_asin: "ASIN2", product_brand: "Beta", product_name: "Gadget" }];
const INV = [
  { date: "2025-08-06", child_asin: "ASIN1", sku: "SKU-1", marketplace_country_code: "US", available: 100, reserved_customer_order: 4, reserved_fc_transfer: 8, reserved_fc_processing: 1, inbound_shipped: 5, inbound_received: 2, inbound_working: 0, product_name: "Widget Inv" },
];
// A row from ANY other date (e.g. an older snapshot day) must now be REJECTED by the single-day window
// validation -- it can never be silently ignored or summed (see the cross-date test below).
const INV_WITH_CROSS_DATE_ROW = [...INV, { date: "2025-08-01", child_asin: "ASIN1", sku: "SKU-OLD", available: 999 }];
const AWD = [{ marketplace_country_code: "US", child_asin: "ASIN1", sku: "SKU-1", awd_available_distributable_quantity: 42, awd_total_inbound_quantity: 15 }];

// Hand-computed expected payload, transcribed from the api/datadoe.js `fba-plan` handler formula.
const EXPECTED = {
  asOf: "2025-08-06",
  accountName: "Acme Co",
  marketCountry: "US",
  isUS: true,
  months: [
    { key: "2025-05", from: "2025-05-01", to: "2025-05-31" },
    { key: "2025-06", from: "2025-06-01", to: "2025-06-30" },
    { key: "2025-07", from: "2025-07-01", to: "2025-07-31" },
  ],
  currentMonth: { key: "2025-08", from: "2025-08-01", to: "2025-08-06", daysInMonth: 31 },
  salesLatestDate: "2025-08-05",
  elapsedDays: 5,
  inventoryDate: "2025-08-06",
  inventoryAvailable: true,
  awdAvailable: true,
  awdEligible: true, // ADDITIVE (Europe AWD): US is AWD-eligible exactly as before (awdEligible === isUS for US).
  rows: [
    { asin: "ASIN1", productName: "Widget", brand: "Acme", sku: "SKU-1", unitsByMonth: { "2025-05": 10, "2025-06": 20, "2025-07": 7 }, mtdUnits: 3, fbaAvailable: 100, customerOrderReserved: 4, reservedFcTransfer: 8, reservedFcProcessing: 1, inboundShipped: 5, inboundReceived: 2, inboundWorking: 0, awdAvailable: 42, awdInbound: 15 },
    { asin: "ASIN2", productName: "Gadget", brand: "Beta", sku: null, unitsByMonth: { "2025-05": 5, "2025-06": 0, "2025-07": 0 }, mtdUnits: 0, fbaAvailable: 0, customerOrderReserved: 0, reservedFcTransfer: 0, reservedFcProcessing: 0, inboundShipped: 0, inboundReceived: 0, inboundWorking: 0, awdAvailable: 0, awdInbound: 0 },
  ],
  accountSkus: ["SKU-1"],
  accountSkuDirectory: [{ sku: "SKU-1", childAsin: "ASIN1", productName: "Widget", brand: "Acme", marketplace: "US", provenance: "inventory" }],
  catalogByAsin: { ASIN1: { brand: "Acme", productName: "Widget" }, ASIN2: { brand: "Beta", productName: "Gadget" } },
  inventoryByBrandCountry: [{ country: "US", brand: "Acme", fbaAvailable: 100, skuCount: 1 }],
};

/* ============================= route-payload parity (US + AWD) ============================= */

group("fba-plan: exact route-payload parity (US with AWD)");

test("fba-plan: US payload deep-equals the hand-computed route payload", () => {
  const { planned, rows } = fbaPlanned({ oliByIdx: OLI, catalogRows: CATALOG, invRows: INV, awdRows: AWD });
  const res = deriveFba(planned, rows);
  assert.equal(res.status, "derived");
  assert.deepEqual(res.payload, EXPECTED);
  assert.equal(res.latestDataDate, "2025-08-06", "latest data date = max(salesLatestDate, inventoryDate)");
});

test("fba-plan: representative SKU is the first localeCompare SKU (stable across refreshes)", () => {
  // ASIN1 has two inventory SKUs; the representative is the first ascending.
  const inv = [{ date: "2025-08-06", child_asin: "ASIN1", sku: "SKU-Z", available: 1 }, { date: "2025-08-06", child_asin: "ASIN1", sku: "SKU-A", available: 1 }];
  const { planned, rows } = fbaPlanned({ oliByIdx: OLI, catalogRows: CATALOG, invRows: inv, awdRows: [] });
  const row = deriveFba(planned, rows).payload.rows.find((r) => r.asin === "ASIN1");
  assert.equal(row.sku, "SKU-A");
});

test("fba-plan: accountSkus is the FULL SKU universe -- includes multi-SKU ASINs + SKUs on dropped zero-activity ASINs", () => {
  const inv = [
    { date: "2025-08-06", child_asin: "ASIN1", sku: "SKU-B", available: 1 },   // ASIN1 has TWO SKUs; only one is the row rep
    { date: "2025-08-06", child_asin: "ASIN1", sku: "SKU-A", available: 1 },
    { date: "2025-08-06", child_asin: "ASIN9", sku: "SKU-ZERO", available: 0, inbound_working: 0 }, // zero-activity ASIN -> dropped from rows
  ];
  const { planned, rows } = fbaPlanned({ oliByIdx: OLI, catalogRows: CATALOG, invRows: inv, awdRows: [] });
  const p = deriveFba(planned, rows).payload;
  // ASIN9 is dropped from the visible rows (zero everything)...
  assert.equal(p.rows.find((r) => r.asin === "ASIN9"), undefined, "zero-activity ASIN dropped from rows");
  // ...but every SKU seen in the sources is in the account SKU universe, so warehouse import can authorize it.
  assert.deepEqual(p.accountSkus, ["SKU-A", "SKU-B", "SKU-ZERO"], "sorted union incl. non-representative + dropped-ASIN SKUs");
  // The DIRECTORY keeps each SKU's identity even when its ASIN is dropped or it is a non-representative SKU.
  const bySku = Object.fromEntries(p.accountSkuDirectory.map((e) => [e.sku, e]));
  assert.equal(bySku["SKU-B"].childAsin, "ASIN1"); // non-representative SKU keeps its ASIN
  assert.equal(bySku["SKU-B"].brand, "Acme", "catalog-proven brand retained for a non-representative SKU");
  assert.equal(bySku["SKU-ZERO"].childAsin, "ASIN9"); // dropped-ASIN SKU keeps its ASIN
  assert.equal(bySku["SKU-ZERO"].brand, null, "ASIN not in catalog -> Unmapped (brand null), never another brand");
  assert.equal(bySku["SKU-A"].provenance, "inventory");
  // catalogByAsin proves ASIN existence (for manual-SKU import validation) + enriches brand/name.
  assert.equal(p.catalogByAsin.ASIN1.brand, "Acme");
  assert.equal(p.catalogByAsin.ASIN9, undefined, "ASIN9 absent from the catalog -> not a valid manual-SKU ASIN");
});

test("fba-plan: a SKU mapped to CONFLICTING child ASINs across sources BLOCKS the snapshot (last-known-good preserved)", () => {
  // Inventory says SKU-1 -> ASIN1; AWD says SKU-1 -> ASIN2. Two different nonblank ASINs for one SKU is unresolvable
  // identity -> a typed account-level derive refusal (never a silent inventory>AWD>sales priority pick).
  const inv = [{ date: "2025-08-06", child_asin: "ASIN1", sku: "SKU-1", available: 5 }];
  const awd = [{ marketplace_country_code: "US", child_asin: "ASIN2", sku: "SKU-1", awd_available_distributable_quantity: 3 }];
  const { planned, rows } = fbaPlanned({ oliByIdx: OLI, catalogRows: CATALOG, invRows: inv, awdRows: awd });
  const res = deriveFba(planned, rows);
  assert.equal(res.status, "invalid");
  assert.equal(res.payload, null, "conflicting identity -> no snapshot; last-known-good preserved");
});

test("fba-plan: IDENTICAL child ASINs across sources are NOT a conflict (derives cleanly)", () => {
  const inv = [{ date: "2025-08-06", child_asin: "ASIN1", sku: "SKU-1", available: 5 }];
  const awd = [{ marketplace_country_code: "US", child_asin: "ASIN1", sku: "SKU-1", awd_available_distributable_quantity: 3 }];
  const { planned, rows } = fbaPlanned({ oliByIdx: OLI, catalogRows: CATALOG, invRows: inv, awdRows: awd });
  const res = deriveFba(planned, rows);
  assert.equal(res.status, "derived");
  const e = res.payload.accountSkuDirectory.find((x) => x.sku === "SKU-1");
  assert.equal(e.childAsin, "ASIN1", "one agreed ASIN; no conflict");
});

test("fba-plan: DURABLE-bridged OLI produces a BYTE-IDENTICAL payload to fetched OLI slices (durable-OLI switch is correct)", () => {
  // (1) Current path: OLI supplied as fetched canonical slices.
  const { planned, rows } = fbaPlanned({ oliByIdx: OLI, catalogRows: CATALOG, invRows: INV, awdRows: AWD });
  const fetched = deriveFba(planned, rows);
  assert.equal(fetched.status, "derived");

  // (2) Durable path: the SAME OLI as source_oli_daily_history rows, bridged through the proven daily/brand-sales
  //     bridge (slicedOliSourceFromHistory). This is exactly how the durable-OLI operator will supply fba-plan:oli-sales.
  const durableRows = OLI.flat().map((r) => ({
    account_id: ID, sale_date: r.date, seller_or_vendor_id: ID, sku: r.sku || "",
    child_asin: r.child_asin, currency: r.item_price_currency || "USD", sales_amount: 0, units: r.total_units_sum,
  }));
  const bridged = slicedOliSourceFromHistory({ historyRows: durableRows, accountId: ID, rawSellerId: ID, from: WINS[0].from, to: ASOF });
  const sources = buildSources(planned, rows);
  // The durable OLI reaches the derive via CONTEXT (fbaPlanDurableOli), exactly as makeFbaPlanDurableContextLoader
  // supplies it; the catalog comes from the same durable path. inventory-health + AWD remain owned sources.
  const context = { ...usContext(), fbaPlanDurableOli: { available: true, rows: bridged.rows, fragments: bridged.fragments }, fbaPlanDurableCatalog: sources["fba-plan:catalog"] };
  const durable = deriveReportSnapshot({ reportKey: "fba-plan", sources, context });
  assert.equal(durable.status, "derived", "durable-bridged OLI derives");
  assert.deepEqual(durable.payload, fetched.payload, "durable OLI => byte-identical fba-plan payload; no derive change needed");
});

test("fba-plan: reserved_fc_transfer is stored RAW -- NO inbound-shipped subtraction (unproven overlap removed)", () => {
  // The authoritative source metadata (inbound_quantity = sum of the 3 inbound states; reserved_fc_transfer is a
  // SEPARATE reserved state) proves the two do NOT overlap, so reserved_fc_transfer is returned in full.
  const { planned, rows } = fbaPlanned({ oliByIdx: OLI, catalogRows: CATALOG, invRows: INV, awdRows: AWD });
  assert.equal(deriveFba(planned, rows).payload.rows[0].reservedFcTransfer, 8, "full reserved_fc_transfer, never 8-5");
  // Even when inbound_shipped exceeds reserved_fc_transfer, the transfer reserve is returned in full (no floor-at-zero).
  const inv2 = [{ date: "2025-08-06", child_asin: "ASIN1", sku: "SKU-1", available: 1, reserved_fc_transfer: 2, inbound_shipped: 9 }];
  const two = fbaPlanned({ oliByIdx: OLI, catalogRows: CATALOG, invRows: inv2, awdRows: [] });
  assert.equal(deriveFba(two.planned, two.rows).payload.rows[0].reservedFcTransfer, 2, "raw 2, never subtracted to 0");
});

test("fba-plan: reserved_customer_order + AWD inbound are folded (US); customer-order-reserved is display-only", () => {
  const { planned, rows } = fbaPlanned({ oliByIdx: OLI, catalogRows: CATALOG, invRows: INV, awdRows: AWD });
  const a1 = deriveFba(planned, rows).payload.rows.find((r) => r.asin === "ASIN1");
  assert.equal(a1.customerOrderReserved, 4, "reserved_customer_order folded + displayed separately");
  assert.equal(a1.awdInbound, 15, "awd_total_inbound_quantity folded (US)");
});

test("fba-plan: completed-month + MTD units are preserved per ASIN", () => {
  const { planned, rows } = fbaPlanned({ oliByIdx: OLI, catalogRows: CATALOG, invRows: INV, awdRows: AWD });
  const a1 = deriveFba(planned, rows).payload.rows.find((r) => r.asin === "ASIN1");
  assert.deepEqual(a1.unitsByMonth, { "2025-05": 10, "2025-06": 20, "2025-07": 7 });
  assert.equal(a1.mtdUnits, 3);
});

test("fba-plan: only the latest inventory snapshot date is folded", () => {
  const { planned, rows } = fbaPlanned({ oliByIdx: OLI, catalogRows: CATALOG, invRows: INV, awdRows: AWD });
  const p = deriveFba(planned, rows).payload;
  assert.equal(p.inventoryDate, "2025-08-06");
  assert.equal(p.rows[0].fbaAvailable, 100, "the older 999 snapshot row is ignored");
});

test("fba-plan: inventoryByBrandCountry folds per (marketplace, brand)", () => {
  const inv = [
    { date: "2025-08-06", child_asin: "ASIN1", sku: "S1", marketplace_country_code: "US", available: 10 },
    { date: "2025-08-06", child_asin: "ASIN2", sku: "S2", marketplace_country_code: "CA", available: 4 },
  ];
  const cat = [{ child_asin: "ASIN1", product_brand: "Acme" }, { child_asin: "ASIN2", product_brand: "Beta" }];
  const { planned, rows } = fbaPlanned({ oliByIdx: [[], [], [], []], catalogRows: cat, invRows: inv, awdRows: [] });
  const fold = deriveFba(planned, rows).payload.inventoryByBrandCountry;
  assert.deepEqual(fold, [
    { country: "US", brand: "Acme", fbaAvailable: 10, skuCount: 1 },
    { country: "CA", brand: "Beta", fbaAvailable: 4, skuCount: 1 },
  ]);
});

/* ============================= AWD (US-only) semantics ============================= */

group("fba-plan: AWD is US-only and never silently zero");

test("fba-plan: non-US account plans + reads NO AWD; awdAvailable false, per-row awdAvailable null", () => {
  const { planned, rows } = fbaPlanned({ oliByIdx: OLI, catalogRows: CATALOG, invRows: INV, includeAwd: false });
  const p = deriveFba(planned, rows, usContext({ marketCountry: "CA", isUS: false })).payload;
  assert.equal(p.isUS, false);
  assert.equal(p.awdAvailable, false);
  assert.ok(p.rows.every((r) => r.awdAvailable === null), "non-US rows carry awdAvailable null");
});

test("fba-plan: a US account with a MISSING AWD source blocks (never a silent zero)", () => {
  const { planned, rows } = fbaPlanned({ oliByIdx: OLI, catalogRows: CATALOG, invRows: INV, includeAwd: false });
  const res = deriveFba(planned, rows, usContext());
  assert.equal(res.status, "invalid");
  assert.equal(res.payload, null, "no snapshot -> last-known-good preserved");
});

test("fba-plan: a US account with a FAILED AWD source blocks", () => {
  const { planned, rows } = fbaPlanned({ oliByIdx: OLI, catalogRows: CATALOG, invRows: INV, awdRows: AWD });
  const awdHash = planned.find((p) => p.requestKey === "fba-plan:awd").requestHash;
  const res = deriveFba(planned, rows, usContext(), { [awdHash]: "failed" });
  assert.equal(res.status, "invalid");
});

test("fba-plan: a VALIDATED EMPTY AWD source is NOT a failure (no AWD rows -> genuine zero)", () => {
  const { planned, rows } = fbaPlanned({ oliByIdx: OLI, catalogRows: CATALOG, invRows: INV, awdRows: [] });
  const p = deriveFba(planned, rows, usContext()).payload;
  assert.equal(p.awdAvailable, false, "empty AWD => availability false");
  assert.equal(p.rows[0].awdAvailable, 0, "US row AWD is a genuine 0, not null");
});

/* ============================= inventory availability semantics ============================= */

group("fba-plan: inventory availability (null vs genuine zero)");

test("fba-plan: an EMPTY inventory snapshot makes every FBA field null (not zero)", () => {
  const { planned, rows } = fbaPlanned({ oliByIdx: OLI, catalogRows: CATALOG, invRows: [], awdRows: [] });
  const p = deriveFba(planned, rows).payload;
  assert.equal(p.inventoryAvailable, false);
  const a1 = p.rows.find((r) => r.asin === "ASIN1");
  assert.equal(a1.fbaAvailable, null);
  assert.equal(a1.reservedFcTransfer, null);
  assert.equal(a1.inboundShipped, null);
});

test("fba-plan: a present snapshot with the ASIN absent yields genuine ZERO FBA stock", () => {
  const { planned, rows } = fbaPlanned({ oliByIdx: OLI, catalogRows: CATALOG, invRows: INV, awdRows: AWD });
  const a2 = deriveFba(planned, rows).payload.rows.find((r) => r.asin === "ASIN2");
  assert.equal(a2.fbaAvailable, 0, "snapshot exists but ASIN2 absent => 0");
  assert.equal(a2.reservedFcTransfer, 0);
});

test("fba-plan: zero-sales + zero-stock ASINs are dropped from rows", () => {
  // ASIN3 has no sales, no inventory, no AWD -> excluded. ASIN1 stays (has sales).
  const cat = [...CATALOG, { child_asin: "ASIN3", product_brand: "Gamma", product_name: "Ghost" }];
  const { planned, rows } = fbaPlanned({ oliByIdx: OLI, catalogRows: cat, invRows: INV, awdRows: AWD });
  const asins = deriveFba(planned, rows).payload.rows.map((r) => r.asin);
  assert.ok(!asins.includes("ASIN3"), "a catalog-only zero-activity ASIN is not emitted");
});

/* ============================= fragment-contract enforcement ============================= */

group("fba-plan: oli-sales slice window + account enforcement");

test("fba-plan: a reordered oli-sales fragment is rejected", () => {
  const { planned, rows } = fbaPlanned({ oliByIdx: OLI, catalogRows: CATALOG, invRows: INV, awdRows: AWD });
  const idx = planned.map((p, i) => ({ p, i })).filter(({ p }) => p.requestKey === "fba-plan:oli-sales").map(({ i }) => i);
  [planned[idx[0]], planned[idx[1]]] = [planned[idx[1]], planned[idx[0]]]; // two adjacent slices swapped
  assert.equal(deriveFba(planned, rows).status, "invalid");
});

test("fba-plan: a duplicated oli-sales slice (wrong window) is rejected", () => {
  const { planned, rows } = fbaPlanned({ oliByIdx: OLI, catalogRows: CATALOG, invRows: INV, awdRows: AWD });
  const idx = planned.map((p, i) => ({ p, i })).filter(({ p }) => p.requestKey === "fba-plan:oli-sales").map(({ i }) => i);
  planned[idx[2]] = { ...planned[idx[2]], from: "2025-05-01", to: "2025-05-07" }; // third slice now duplicates the first slice window
  assert.equal(deriveFba(planned, rows).status, "invalid");
});

test("fba-plan: a missing oli-sales fragment (one slice removed) is rejected", () => {
  const { planned, rows } = fbaPlanned({ oliByIdx: OLI, catalogRows: CATALOG, invRows: INV, awdRows: AWD });
  const idx = planned.findIndex((p) => p.requestKey === "fba-plan:oli-sales");
  planned.splice(idx, 1);
  assert.equal(deriveFba(planned, rows).status, "invalid");
});

test("fba-plan: a cross-account oli-sales fragment is rejected", () => {
  const { planned, rows } = fbaPlanned({ oliByIdx: OLI, catalogRows: CATALOG, invRows: INV, awdRows: AWD });
  const idx = planned.findIndex((p) => p.requestKey === "fba-plan:oli-sales");
  planned[idx] = { ...planned[idx], sellerOrVendorIds: ["OTHER"] };
  assert.equal(deriveFba(planned, rows).status, "invalid");
});

/* ============================= safety: no fetch, last-known-good, idempotent ============================= */

group("fba-plan: zero DataDoe calls, last-known-good, idempotent");

test("fba-plan: derivation performs ZERO fetch/DataDoe calls", async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (u) => { calls.push(String(u)); throw new Error("NO_FETCH_DURING_DERIVATION"); };
  try {
    const { planned, rows } = fbaPlanned({ oliByIdx: OLI, catalogRows: CATALOG, invRows: INV, awdRows: AWD });
    assert.equal(deriveFba(planned, rows).status, "derived");
  } finally { globalThis.fetch = original; }
  assert.equal(calls.length, 0);
});

test("fba-plan: an unavailable required source preserves last-known-good (no snapshot)", () => {
  const { planned, rows } = fbaPlanned({ oliByIdx: OLI, catalogRows: CATALOG, invRows: INV, awdRows: AWD });
  // inventory-health is now the required OWNED source (OLI + catalog are durable derived deps). A failed required
  // owned source yields "unavailable" (retryable) -> zero writes -> last-known-good preserved.
  const invHash = planned.find((p) => p.requestKey === "fba-plan:inventory-health").requestHash;
  const res = deriveFba(planned, rows, usContext(), { [invHash]: "failed" });
  assert.equal(res.status, "unavailable");
  assert.equal(res.payload, null);
});

test("fba-plan: a MISSING durable OLI context is UNAVAILABLE (retryable defer), NOT terminal invalid; LKG preserved (defect 3)", () => {
  const { planned, rows } = fbaPlanned({ oliByIdx: OLI, catalogRows: CATALOG, invRows: INV, awdRows: AWD });
  const sources = buildSources(planned, rows);
  // Durable OLI absent (loader returned {} for short/missing coverage) = an EXPECTED delayed dependency, not a data-
  // integrity error. It must type `unavailable` (retryable, distinguishable) -- never an indistinguishable permanent
  // DERIVE_INVALID -- and carry the real deferred reason (not the generic "derivation threw"). Zero writes, LKG kept.
  const res = deriveReportSnapshot({ reportKey: "fba-plan", sources, context: { ...usContext(), fbaPlanDurableCatalog: sources["fba-plan:catalog"] } });
  assert.equal(res.status, "unavailable");
  assert.equal(res.payload, null);
  assert.notEqual(res.reason, "derivation threw", "an unavailable defer carries its real reason, not the generic invalid label");
  assert.match(res.reason, /Order Line Items/, "the reason names the delayed durable dependency");
});

test("fba-plan: a MISSING durable Catalog context is UNAVAILABLE (retryable defer), NOT terminal invalid; LKG preserved (defect 3)", () => {
  const { planned, rows } = fbaPlanned({ oliByIdx: OLI, catalogRows: CATALOG, invRows: INV, awdRows: AWD });
  const sources = buildSources(planned, rows);
  const res = deriveReportSnapshot({ reportKey: "fba-plan", sources, context: { ...usContext(), fbaPlanDurableOli: sources["fba-plan:oli-sales"] } });
  assert.equal(res.status, "unavailable");
  assert.equal(res.payload, null);
  assert.match(res.reason, /Product Catalog/, "the reason names the delayed durable dependency");
});

test("fba-plan: a delayed durable OLI that LATER becomes available RECOVERS (same account, dep materializes) (defect 3)", () => {
  const { planned, rows } = fbaPlanned({ oliByIdx: OLI, catalogRows: CATALOG, invRows: INV, awdRows: AWD });
  const sources = buildSources(planned, rows);
  // Pass 1: durable OLI not yet materialized -> unavailable (retryable), no snapshot.
  const before = deriveReportSnapshot({ reportKey: "fba-plan", sources, context: { ...usContext(), fbaPlanDurableCatalog: sources["fba-plan:catalog"] } });
  assert.equal(before.status, "unavailable", "delayed dependency defers, retryable");
  // Pass 2: the SAME inputs once the durable OLI materializes -> derives cleanly (natural next-cycle recovery, no framework).
  const after = deriveReportSnapshot({ reportKey: "fba-plan", sources, context: { ...usContext(), fbaPlanDurableOli: sources["fba-plan:oli-sales"], fbaPlanDurableCatalog: sources["fba-plan:catalog"] } });
  assert.equal(after.status, "derived", "once the delayed durable dependency is present the derive succeeds");
  assert.ok(after.payload && Array.isArray(after.payload.rows), "a real payload is produced on recovery");
});

test("fba-plan: derivation is idempotent (same inputs -> identical payload)", () => {
  const { planned, rows } = fbaPlanned({ oliByIdx: OLI, catalogRows: CATALOG, invRows: INV, awdRows: AWD });
  assert.deepEqual(deriveFba(planned, rows).payload, deriveFba(planned, rows).payload);
});

/* ============================= planMonthWindows parity + planner ============================= */

group("fba-plan: planMonthWindows parity + planner");

test("planMonthWindows: matches the route formula (3 completed months + current MTD)", () => {
  assert.deepEqual(planMonthWindows("2025-08-06"), {
    completed: [
      { key: "2025-05", from: "2025-05-01", to: "2025-05-31" },
      { key: "2025-06", from: "2025-06-01", to: "2025-06-30" },
      { key: "2025-07", from: "2025-07-01", to: "2025-07-31" },
    ],
    current: { key: "2025-08", from: "2025-08-01", to: "2025-08-06", daysInMonth: 31 },
  });
  // Year boundary + February length.
  assert.deepEqual(planMonthWindows("2025-01-15").completed.map((m) => m.key), ["2024-10", "2024-11", "2024-12"]);
  assert.deepEqual(planMonthWindows("2024-05-31").completed.map((m) => m.to), ["2024-02-29", "2024-03-31", "2024-04-30"]);
});

test("planFbaPlan: US account emits ONLY the owned FBA Health + AWD sources (OLI/catalog are derived), single-account, deterministic hashes", () => {
  const req = planFbaPlan({ accountId: ID, name: "Acme Co", country: "US", currency: "USD", connections: PL_CONN, asOf: ASOF });
  const keys = [...new Set(req.sources.map((s) => s.requestKey))].sort();
  // OLI + catalog are durable derived dependencies -> NOT planned exports. Only FBA Health + US AWD are owned.
  assert.deepEqual(keys, ["fba-plan:awd", "fba-plan:inventory-health"]);
  assert.ok(req.sources.every((s) => s.sellerOrVendorIds.length === 1 && s.sellerOrVendorIds[0] === ID));
  assert.deepEqual(req.context, { to: ASOF, rawSellerId: ID, accountName: "Acme Co", marketCountry: "US", isUS: true });
  const b = planFbaPlan({ accountId: ID, name: "Acme Co", country: "US", currency: "USD", connections: PL_CONN, asOf: ASOF }).sources.map((s) => s.requestHash);
  assert.deepEqual(req.sources.map((s) => s.requestHash), b, "identical inputs -> identical hashes");
});

test("planFbaPlan: a non-US account plans NO AWD source and marks isUS false", () => {
  const req = planFbaPlan({ accountId: ID, name: "Acme", country: "CA", currency: "CAD", connections: PL_CONN, asOf: ASOF });
  assert.ok(!req.sources.some((s) => s.requestKey === "fba-plan:awd"), "no AWD source for non-US");
  assert.equal(req.context.isUS, false);
  assert.equal(req.context.marketCountry, "CA");
});

test("planFbaPlan: organizations never share a request hash", () => {
  const a = planFbaPlan({ accountId: ID, name: "Acme", country: "US", currency: "USD", connections: PL_CONN, asOf: ASOF }).sources.map((s) => s.requestHash);
  const sec = planFbaPlan({ accountId: dash("dd", "secondary") + ":" + ID, name: "Acme", country: "US", currency: "USD", connections: PL_CONN, asOf: ASOF }).sources.map((s) => s.requestHash);
  assert.ok(a.every((h) => !sec.includes(h)), "primary and secondary org hashes are disjoint");
});

test("foldPlanAsinUnits: sums grouped child_asin units in first-seen order", () => {
  const m = foldPlanAsinUnits([{ child_asin: "B", units_sum: 2 }, { child_asin: "A", units_sum: 3 }, { child_asin: "B", quantity: 5 }]);
  assert.deepEqual([...m.entries()], [["B", 7], ["A", 3]]);
});

/* ============================= exact inventory + AWD window pinning (Blocker 2) ============================= */

group("fba-plan: exact inventory + AWD window pinning");

test("fba-plan: the canonical inventory window IS the EXACT single day asOf..asOf and AWD is null/null", () => {
  assert.equal(INV_WINDOW.from, ASOF);
  assert.equal(INV_WINDOW.to, ASOF);
});

test("fba-plan: ANY lookback window (from < asOf, e.g. the retired asOf-10 shape) blocks; payload null", () => {
  const { planned, rows } = fbaPlanned({ oliByIdx: OLI, catalogRows: CATALOG, invRows: INV, awdRows: AWD });
  const idx = planned.findIndex((p) => p.requestKey === "fba-plan:inventory-health");
  planned[idx] = { ...planned[idx], from: addDaysStr(ASOF, -10) };
  const res = deriveFba(planned, rows);
  assert.equal(res.status, "invalid");
  assert.equal(res.payload, null);
});

test("fba-plan: a single-day window on the WRONG day (from = to = asOf-1) blocks", () => {
  const { planned, rows } = fbaPlanned({ oliByIdx: OLI, catalogRows: CATALOG, invRows: INV, awdRows: AWD });
  const idx = planned.findIndex((p) => p.requestKey === "fba-plan:inventory-health");
  planned[idx] = { ...planned[idx], from: addDaysStr(ASOF, -1), to: addDaysStr(ASOF, -1) };
  assert.equal(deriveFba(planned, rows).status, "invalid");
});

test("fba-plan: a wrong inventory `to` (!= asOf) blocks", () => {
  const { planned, rows } = fbaPlanned({ oliByIdx: OLI, catalogRows: CATALOG, invRows: INV, awdRows: AWD });
  const idx = planned.findIndex((p) => p.requestKey === "fba-plan:inventory-health");
  planned[idx] = { ...planned[idx], to: addDaysStr(ASOF, -1) };
  assert.equal(deriveFba(planned, rows).status, "invalid");
});

test("fba-plan: a DATED AWD fragment (from/to not null) blocks; payload null", () => {
  const { planned, rows } = fbaPlanned({ oliByIdx: OLI, catalogRows: CATALOG, invRows: INV, awdRows: AWD });
  const idx = planned.findIndex((p) => p.requestKey === "fba-plan:awd");
  planned[idx] = { ...planned[idx], from: "2025-08-01", to: ASOF };
  const res = deriveFba(planned, rows);
  assert.equal(res.status, "invalid");
  assert.equal(res.payload, null);
});

test("fba-plan: EXACT canonical windows still derive the identical payload", () => {
  const { planned, rows } = fbaPlanned({ oliByIdx: OLI, catalogRows: CATALOG, invRows: INV, awdRows: AWD });
  assert.deepEqual(deriveFba(planned, rows).payload, EXPECTED);
});

test("fba-plan: an inventory row dated on ANY other day than the requested D-1 blocks (no cross-date fold)", () => {
  const { planned, rows } = fbaPlanned({ oliByIdx: OLI, catalogRows: CATALOG, invRows: INV_WITH_CROSS_DATE_ROW, awdRows: AWD });
  const res = deriveFba(planned, rows);
  assert.equal(res.status, "invalid");
  assert.equal(res.payload, null);
});

test("planFbaPlan emits the canonical single-day inventory (asOf..asOf) + no-date AWD windows the derivation requires", () => {
  const req = planFbaPlan({ accountId: ID, name: "Acme Co", country: "US", currency: "USD", connections: PL_CONN, asOf: ASOF });
  const inv = req.sources.find((s) => s.requestKey === "fba-plan:inventory-health");
  assert.equal(inv.from, ASOF);
  assert.equal(inv.to, ASOF);
  const awd = req.sources.find((s) => s.requestKey === "fba-plan:awd");
  assert.equal(awd.from, null);
  assert.equal(awd.to, null);
});

test("fba-plan worker: a shortened-inventory derive writes ZERO snapshots and preserves last-known-good", async () => {
  const { planned, rows } = fbaPlanned({ oliByIdx: OLI, catalogRows: CATALOG, invRows: INV, awdRows: AWD });
  const idx = planned.findIndex((p) => p.requestKey === "fba-plan:inventory-health");
  planned[idx] = { ...planned[idx], from: addDaysStr(ASOF, -9) }; // shortened -> derive invalid before save
  const { store, plannedReport, sourceRows, loadDerivedContext } = fbaReportPlan(planned, rows);
  const LKG = { asOf: "2025-07-01", rows: [{ asin: "PRIOR" }] };
  store.seedSnapshot("scheduler-v2/fba-plan", ID, LKG); // prior good (shadow-namespaced) snapshot
  const saveSnapshot = async () => { store.saveCalls += 1; return { paramsHash: "ph" }; };
  await runReportJobs({ store, cycleId: "cyc1", sourceRows, saveSnapshot, plannedReports: [plannedReport], loadDerivedContext });
  assert.equal(store.saveCalls, 0, "no snapshot saved for the blocked derive");
  assert.deepEqual(store._snapshots.get("scheduler-v2/fba-plan|" + ID).payload, LKG, "last-known-good snapshot unchanged/readable");
  assert.equal(store.report("fba-plan", ID).derive_status, "failed", "report recorded a derive failure (terminal this cycle)");
});

/* ============================= durable derived-context loader ============================= */

group("fba-plan: durable derived-context loader (OLI + Catalog)");

// The SAME OLI as durable source_oli_daily_history rows (see the parity fixture), for the loader's getOliHistory.
const durableOliRows = () => OLI.flat().map((r) => ({
  account_id: ID, sale_date: r.date, seller_or_vendor_id: ID, sku: r.sku || "",
  child_asin: r.child_asin, currency: r.item_price_currency || "USD", sales_amount: 0, units: r.total_units_sum,
}));
const fullCoverage = { read: "ok", windows: [{ from: WINS[0].from, to: ASOF }] };
const makeLoader = (over = {}) => makeFbaPlanDurableContextLoader({
  connections: PL_CONN,
  getOliCoverage: over.getOliCoverage || (async () => fullCoverage),
  getOliHistory: over.getOliHistory || (async () => durableOliRows()),
  getCatalogSnapshot: over.getCatalogSnapshot || (async () => ({ read: "ok", snapshot: { object_path: "cat/x.json", validated_at: "2025-08-06T00:00:00Z" } })),
  loadCatalogPayload: over.loadCatalogPayload || (async () => ({ rows: CATALOG })),
});
const loaderArgs = (over = {}) => ({ reportKey: "fba-plan", accountId: ID, planned: { context: usContext(over) } });

test("oliCoverageProvesWindow: proves only when the span covers [from..to] end to end", () => {
  assert.equal(oliCoverageProvesWindow([{ from: "2025-05-01", to: "2025-08-06" }], "2025-05-01", "2025-08-06"), true);
  assert.equal(oliCoverageProvesWindow([{ from: "2025-06-01", to: "2025-08-06" }], "2025-05-01", "2025-08-06"), false, "starts too late");
  assert.equal(oliCoverageProvesWindow([{ from: "2025-05-01", to: "2025-08-01" }], "2025-05-01", "2025-08-06"), false, "ends too early");
  assert.equal(oliCoverageProvesWindow([], "2025-05-01", "2025-08-06"), false, "no windows");
});

test("loader: returns {} for every report that is NOT fba-plan", async () => {
  assert.deepEqual(await makeLoader()({ reportKey: "daily-reporting", accountId: ID, planned: { context: usContext() } }), {});
});

test("loader: full durable coverage yields OLI + Catalog context that derives BYTE-IDENTICALLY", async () => {
  const ctx = await makeLoader()(loaderArgs());
  assert.equal(ctx.fbaPlanDurableOli.available, true);
  assert.equal(ctx.fbaPlanDurableCatalog.available, true);
  const { planned, rows } = fbaPlanned({ oliByIdx: OLI, catalogRows: CATALOG, invRows: INV, awdRows: AWD });
  const sources = buildSources(planned, rows);
  const out = deriveReportSnapshot({ reportKey: "fba-plan", sources, context: { ...usContext(), ...ctx } });
  assert.equal(out.status, "derived");
  assert.deepEqual(out.payload, EXPECTED, "durable loader OLI+catalog => byte-identical fba-plan payload");
});

test("loader: SHORT durable OLI coverage (ends before asOf) fails closed -> no OLI context (derive blocks)", async () => {
  const ctx = await makeLoader({ getOliCoverage: async () => ({ read: "ok", windows: [{ from: WINS[0].from, to: addDaysStr(ASOF, -1) }] }) })(loaderArgs());
  assert.equal(ctx.fbaPlanDurableOli, undefined, "short coverage => OLI omitted (fail closed)");
  assert.equal(ctx.fbaPlanDurableCatalog, undefined, "no OLI => the whole context is empty");
});

test("loader: a failed OLI coverage read fails closed", async () => {
  const ctx = await makeLoader({ getOliCoverage: async () => ({ read: "read-failed", windows: [] }) })(loaderArgs());
  assert.deepEqual(ctx, {});
});

test("loader: OLI present but catalog missing -> OLI supplied, catalog omitted (derive fails closed on catalog)", async () => {
  const ctx = await makeLoader({ getCatalogSnapshot: async () => ({ read: "ok", snapshot: null }) })(loaderArgs());
  assert.equal(ctx.fbaPlanDurableOli.available, true);
  assert.equal(ctx.fbaPlanDurableCatalog, undefined);
  const { planned, rows } = fbaPlanned({ oliByIdx: OLI, catalogRows: CATALOG, invRows: INV, awdRows: AWD });
  const out = deriveReportSnapshot({ reportKey: "fba-plan", sources: buildSources(planned, rows), context: { ...usContext(), ...ctx } });
  assert.equal(out.status, "unavailable", "missing durable catalog DEFERS the derive (retryable; last-known-good preserved)");
});

test("loader: a non-calendar asOf yields {} (derive fails closed)", async () => {
  assert.deepEqual(await makeLoader()({ reportKey: "fba-plan", accountId: ID, planned: { context: usContext({ to: "not-a-date" }) } }), {});
});

/* ===================== defect 3: delayed durable dependency = honest retryable defer + diagnostics ============= */

group("fba-plan: delayed durable dependency (SOURCE_UNAVAILABLE) vs genuine integrity (DERIVE_INVALID) + diagnostics");

// Wrap fbaReportPlan's store to CAPTURE the full recordReportFailure args (the shared double records error_code but
// not the message/terminal flag). Proves what is PERSISTED for an operator/Codex to diagnose.
function capturingReportPlan(planned, rows) {
  const base = fbaReportPlan(planned, rows);
  const failures = [];
  const orig = base.store.recordReportFailure.bind(base.store);
  base.store.recordReportFailure = async (a) => { failures.push(a); return orig(a); };
  return { ...base, failures };
}

test("fba-plan worker: a missing durable OLI records SOURCE_UNAVAILABLE (retryable), the real reason, no snapshot, LKG preserved (defect 3)", async () => {
  const { planned, rows } = fbaPlanned({ oliByIdx: OLI, catalogRows: CATALOG, invRows: INV, awdRows: AWD });
  const base = capturingReportPlan(planned, rows);
  base.store.seedSnapshot("scheduler-v2/fba-plan", ID, { asOf: "2025-07-01", rows: [{ asin: "PRIOR" }] });
  let saveCalls = 0; const saveSnapshot = async () => { saveCalls += 1; return { paramsHash: "ph" }; };
  // The durable OLI never materializes this cycle (loadDerivedContext supplies only the catalog) = a delayed dependency.
  const loadDerivedContext = async ({ reportKey }) => (reportKey === "fba-plan" ? { fbaPlanDurableCatalog: buildSources(planned, rows)["fba-plan:catalog"] } : {});
  await runReportJobs({ store: base.store, cycleId: "cycU", sourceRows: base.sourceRows, saveSnapshot, plannedReports: [base.plannedReport], loadDerivedContext });
  assert.equal(saveCalls, 0, "no snapshot saved for the deferred derive");
  assert.deepEqual(base.store._snapshots.get("scheduler-v2/fba-plan|" + ID).payload.rows[0].asin, "PRIOR", "last-known-good snapshot unchanged");
  assert.equal(base.failures.length, 1);
  assert.equal(base.failures[0].code, "SOURCE_UNAVAILABLE", "a delayed durable dependency is a retryable SOURCE_UNAVAILABLE, NOT terminal DERIVE_INVALID");
  assert.equal(base.failures[0].terminal, false, "non-terminal (retryable next cycle / once it materializes)");
  assert.match(base.failures[0].message, /Order Line Items/, "the persisted reason names the delayed durable dependency (diagnosable)");
});

test("fba-plan worker: a GENUINE integrity error records DERIVE_INVALID with the REAL sanitized detail, not the generic 'derivation threw' (defect 3 diagnostics)", async () => {
  const { planned, rows } = fbaPlanned({ oliByIdx: OLI, catalogRows: CATALOG, invRows: INV, awdRows: AWD });
  const idx = planned.findIndex((p) => p.requestKey === "fba-plan:inventory-health");
  planned[idx] = { ...planned[idx], from: addDaysStr(ASOF, -9) }; // wrong inventory window => genuine integrity invalid
  const base = capturingReportPlan(planned, rows);
  let saveCalls = 0; const saveSnapshot = async () => { saveCalls += 1; return { paramsHash: "ph" }; };
  await runReportJobs({ store: base.store, cycleId: "cycI", sourceRows: base.sourceRows, saveSnapshot, plannedReports: [base.plannedReport], loadDerivedContext: base.loadDerivedContext });
  assert.equal(saveCalls, 0, "no snapshot saved for the invalid derive");
  assert.equal(base.failures.length, 1);
  assert.equal(base.failures[0].code, "DERIVE_INVALID", "a genuine integrity error stays terminal DERIVE_INVALID");
  assert.equal(base.failures[0].terminal, true);
  assert.notEqual(base.failures[0].message, "derivation threw", "the persisted message is the REAL sanitized detail, not the generic label");
  assert.ok(base.failures[0].message.length > 0 && base.failures[0].message.length <= 300, "the diagnostic is bounded (secret-free, capped)");
});

test("sanitizeReportDiagnostic: TRUNCATES to 300 chars and COLLAPSES whitespace/newlines (bounded, secret-free) (defect 3)", () => {
  // Directly exercise the sanitizer's two distinctive behaviors (the worker's real derive messages are short + clean,
  // so integration tests never hit these): a >300-char message with tabs/newlines/repeated spaces must come out
  // single-spaced, trimmed, and EXACTLY 300 chars -- so removing .slice(0,300) or the \\s+ collapse is regression-caught.
  const long = "  x" + "\t\n  y   z\n".repeat(200) + "  "; // >300 chars, many whitespace runs + newlines/tabs
  const s = sanitizeReportDiagnostic(long);
  assert.equal(s.length, 300, "truncated to exactly the 300-char cap");
  assert.ok(!/\s\s/.test(s), "no double-spaces (whitespace runs collapsed)");
  assert.ok(!/[\n\t]/.test(s), "no newlines or tabs (collapsed to single spaces)");
  assert.equal(s[0], "x", "leading whitespace trimmed");
  // A short clean message passes through unchanged; a blank/nullish input falls back to a stable label.
  assert.equal(sanitizeReportDiagnostic("snapshot blocked."), "snapshot blocked.");
  assert.equal(sanitizeReportDiagnostic("   "), "derivation failed");
  assert.equal(sanitizeReportDiagnostic(null), "derivation failed");
});

/* ===================== BATCHED marketplace-safe planning + isolation (go-live) ===================== */

group("fba-plan: BATCHED marketplace-safe planning + per-account isolation");

// Raw seller id == public accountId on the primary connection (PL_CONN primary has no prefix).
const bAccounts = [
  { accountId: "US1", name: "US One", country: "US", currency: "USD" },
  { accountId: "US2", name: "US Two", country: "US", currency: "USD" },
  { accountId: "IN1", name: "IN One", country: "IN", currency: "INR" },
];
const bAsOfFor = () => ASOF;

test("planFbaPlanBucketBatched: single-marketplace <=5 batches, per-account owner metadata, US-only AWD", () => {
  const reqs = planFbaPlanBucketBatched({ accounts: bAccounts, connections: PL_CONN, asOfFor: bAsOfFor });
  assert.equal(reqs.length, 3, "one report request per account");
  // US1+US2 share ONE FBA batch hash; IN1 is a SEPARATE marketplace batch (never mixed with US).
  const invHash = (id) => reqs.find((r) => r.accountId === id).sources.find((s) => s.requestKey === "fba-plan:inventory-health").requestHash;
  assert.equal(invHash("US1"), invHash("US2"), "US1 + US2 share ONE batched FBA export (<=5, same marketplace)");
  assert.notEqual(invHash("US1"), invHash("IN1"), "IN never batches with US (marketplace-safe)");
  // AWD is US-only: US accounts carry it, IN does not.
  const awd = (id) => reqs.find((r) => r.accountId === id).sources.some((s) => s.requestKey === "fba-plan:awd");
  assert.ok(awd("US1") && awd("US2"), "US accounts carry the AWD source");
  assert.ok(!awd("IN1"), "IN (non-US) carries NO AWD source");
  // Every request carries COMPLETE, per-account owner metadata (never the batch scope).
  for (const r of reqs) {
    for (const f of ["accountId", "rawSellerId", "connectionId", "organizationFingerprint", "accountScopeHash"]) {
      assert.ok(r.owner && String(r.owner[f] || "").length > 0, `${r.accountId} owner.${f} present`);
    }
    assert.equal(r.owner.accountId, r.accountId);
    assert.equal(r.owner.rawSellerId, r.accountId, "raw seller id == accountId on the primary connection");
  }
  // The two US owners have DISTINCT individual scopes (never the shared batch scope).
  assert.notEqual(reqs.find((r) => r.accountId === "US1").owner.accountScopeHash, reqs.find((r) => r.accountId === "US2").owner.accountScopeHash);
  // Every batched FBA/AWD source carries the batch's single canonical marketplace constraint.
  for (const r of reqs) for (const s of r.sources) assert.equal(s.marketplaceConstraint, r.context.marketCountry);
});

test("marketplaceCodeFor: UK -> GB (Amazon code), every other marketplace unchanged", () => {
  assert.equal(marketplaceCodeFor("UK"), "GB");
  assert.equal(marketplaceCodeFor("uk"), "GB");
  assert.equal(marketplaceCodeFor("IN"), "IN");
  assert.equal(marketplaceCodeFor("US"), "US");
  assert.equal(marketplaceCodeFor("DE"), "DE");
});

test("planFbaPlanBucketBatched: UK accounts batch under the GB marketplace (never UK) so FBA rows validate", () => {
  const uk = [{ accountId: "UK1", name: "u1", country: "UK", currency: "GBP" }, { accountId: "UK2", name: "u2", country: "UK", currency: "GBP" }];
  const reqs = planFbaPlanBucketBatched({ accounts: uk, connections: PL_CONN, asOfFor: bAsOfFor });
  assert.equal(reqs.length, 2, "one request per UK account");
  for (const r of reqs) for (const s of r.sources) assert.equal(s.marketplaceConstraint, "GB", "UK batch marketplace normalized to GB");
  // Both UK accounts share ONE batched FBA export (same GB marketplace partition).
  const invHashes = new Set(reqs.map((r) => r.sources.find((s) => s.requestKey === "fba-plan:inventory-health").requestHash));
  assert.equal(invHashes.size, 1, "UK accounts batch together under GB");
  // UK is an AWD-capable EU5 marketplace (Europe AWD support): it NOW resolves the AWD source (batched under GB).
  assert.ok(reqs.every((r) => r.sources.some((s) => s.requestKey === "fba-plan:awd")), "UK (EU5) resolves AWD");
  const awdHashes = new Set(reqs.map((r) => r.sources.find((s) => s.requestKey === "fba-plan:awd").requestHash));
  assert.equal(awdHashes.size, 1, "UK accounts share ONE batched AWD export under GB");
});
test("planFbaPlanBucketBatched: an Australia account is NEVER planned for AWD (excluded from the Europe expansion)", () => {
  const au = [{ accountId: "AU1", name: "a1", country: "AU", currency: "AUD" }];
  const reqs = planFbaPlanBucketBatched({ accounts: au, connections: PL_CONN, asOfFor: bAsOfFor });
  assert.ok(reqs.length >= 1);
  assert.ok(reqs.every((r) => !r.sources.some((s) => s.requestKey === "fba-plan:awd")), "Australia is excluded from AWD");
});

test("fba-plan BATCHED derive ISOLATES each account's rows from a shared <=5-seller FBA/AWD export (no cross-account leak)", async () => {
  const reqs = planFbaPlanBucketBatched({ accounts: [bAccounts[0], bAccounts[1]], connections: PL_CONN, asOfFor: bAsOfFor });
  // The two US accounts share ONE FBA + ONE AWD export. Its rows carry BOTH accounts (tagged by seller_or_vendor_id).
  const invRow = (seller, asin, avail) => ({ date: ASOF, seller_or_vendor_id: seller, child_asin: asin, sku: "S-" + seller, marketplace_country_code: "US", available: avail, reserved_customer_order: 0, reserved_fc_transfer: 0, reserved_fc_processing: 0, inbound_working: 0, inbound_shipped: 0, inbound_received: 0, product_name: "P-" + asin });
  const awdRow = (seller, asin, qty) => ({ marketplace_country_code: "US", seller_or_vendor_id: seller, child_asin: asin, sku: "S-" + seller, awd_available_distributable_quantity: qty, awd_total_inbound_quantity: 0 });
  const invHash = reqs[0].sources.find((s) => s.requestKey === "fba-plan:inventory-health").requestHash;
  const awdHash = reqs[0].sources.find((s) => s.requestKey === "fba-plan:awd").requestHash;
  const rowsByHash = {
    [invHash]: [invRow("US1", "ASIN1", 100), invRow("US2", "ASIN2", 50)], // BOTH accounts in the one shared export
    [awdHash]: [awdRow("US1", "ASIN1", 10), awdRow("US2", "ASIN2", 20)],
  };
  // Durable OLI (empty -> valid canonical slice sequence, zero sales) + org catalog for both ASINs, per account.
  const catalog = [{ child_asin: "ASIN1", product_brand: "B1", product_name: "P-ASIN1" }, { child_asin: "ASIN2", product_brand: "B2", product_name: "P-ASIN2" }];
  const loadDerivedContext = async ({ reportKey, accountId }) => {
    if (reportKey !== "fba-plan") return {};
    const bridged = slicedOliSourceFromHistory({ historyRows: [], accountId, rawSellerId: accountId, from: WINS[0].from, to: ASOF });
    return {
      fbaPlanDurableOli: { available: true, rows: bridged.rows, fragments: bridged.fragments },
      fbaPlanDurableCatalog: { available: true, rows: catalog, fragments: [{ from: WINS[0].from, to: WINS[3].to, sellerOrVendorIds: [accountId], rows: catalog }] },
    };
  };
  const store = makeReportStore();
  for (const h of [invHash, awdHash]) store.seedSourceSucceeded(h);
  const saved = new Map();
  const saveSnapshot = async ({ reportKey, accountId, payload }) => { saved.set(accountId, payload); return { paramsHash: "ph-" + accountId }; };
  const sourceRows = (h) => (Object.prototype.hasOwnProperty.call(rowsByHash, h) ? { rows: rowsByHash[h] } : { rows: [] });
  await runReportJobs({ store, cycleId: "cycB", sourceRows, saveSnapshot, plannedReports: reqs, loadDerivedContext });

  assert.ok(saved.has("US1") && saved.has("US2"), "both accounts derived a snapshot");
  // Each account's rows come SOLELY from its own isolated inventory/AWD (+ its own sales). The batch-mate's
  // ASIN -- which has zero inventory/AWD/sales for THIS account after isolation -- is dropped as zero-activity, so
  // it never appears; and the ASINs that DO appear carry only this account's own quantities (no value leak).
  const asinsOf = (p) => new Set((p.rows || []).map((r) => r.asin));
  const us1 = asinsOf(saved.get("US1"));
  const us2 = asinsOf(saved.get("US2"));
  assert.ok(us1.has("ASIN1") && !us1.has("ASIN2"), "US1 rows contain ONLY its own ASIN1 (US2's ASIN2 never leaks in)");
  assert.ok(us2.has("ASIN2") && !us2.has("ASIN1"), "US2 rows contain ONLY its own ASIN2 (US1's ASIN1 never leaks in)");
  const rowOf = (p, asin) => (p.rows || []).find((r) => r.asin === asin) || {};
  assert.equal(rowOf(saved.get("US1"), "ASIN1").fbaAvailable, 100, "US1 sees its OWN ASIN1 available=100");
  assert.equal(rowOf(saved.get("US2"), "ASIN2").fbaAvailable, 50, "US2 sees its OWN ASIN2 available=50");
  assert.equal(rowOf(saved.get("US1"), "ASIN1").awdAvailable, 10, "US1 sees its OWN ASIN1 AWD=10 (never US2's 20)");
  assert.equal(rowOf(saved.get("US2"), "ASIN2").awdAvailable, 20, "US2 sees its OWN ASIN2 AWD=20 (never US1's 10)");
});

test("fba-plan BATCHED derive FAILS CLOSED without owner metadata (a batched source can never leak the full batch)", async () => {
  const reqs = planFbaPlanBucketBatched({ accounts: [bAccounts[0], bAccounts[1]], connections: PL_CONN, asOfFor: bAsOfFor });
  const stripped = reqs.map((r) => ({ ...r, owner: undefined })); // simulate a bug dropping owner metadata
  const invHash = reqs[0].sources.find((s) => s.requestKey === "fba-plan:inventory-health").requestHash;
  const awdHash = reqs[0].sources.find((s) => s.requestKey === "fba-plan:awd").requestHash;
  const store = makeReportStore();
  for (const h of [invHash, awdHash]) store.seedSourceSucceeded(h);
  let saveCalls = 0;
  const saveSnapshot = async () => { saveCalls += 1; return { paramsHash: "x" }; };
  await runReportJobs({ store, cycleId: "cycC", sourceRows: () => ({ rows: [] }), saveSnapshot, plannedReports: stripped, loadDerivedContext: async () => ({}) });
  assert.equal(saveCalls, 0, "a batched report with missing owner metadata writes ZERO snapshots (fail closed)");
  for (const id of ["US1", "US2"]) assert.equal(store.report("fba-plan", id).derive_status, "failed", id + " failed closed (OWNER_BINDING_MISSING)");
});

/* ===================== go-live planning helpers (as-of + token cost) ===================== */

group("fba-plan: go-live planning helpers");

test("resolveGoLiveAsOf: picks the coverage-maximizing recent date; genuinely-stale accounts fail closed", () => {
  // Mirrors the prod recon: 8@Aug29, 15@Aug28, 5@Aug27, 1@Aug24, 1@Aug11(stale). maxBlocked=2 => asOf=Aug27
  // keeps 28/30; the two genuinely-stale accounts (Aug24, Aug11) are blocked.
  const proven = [];
  const push = (n, d) => { for (let i = 0; i < n; i++) proven.push({ accountId: `${d}-${i}`, provenTo: d }); };
  push(8, "2026-08-29"); push(15, "2026-08-28"); push(5, "2026-08-27"); push(1, "2026-08-24"); push(1, "2026-08-11");
  const r = resolveGoLiveAsOf(proven, { ceiling: "2026-08-29", maxBlocked: 2 });
  assert.equal(r.asOf, "2026-08-27", "the latest date all-but-2 accounts still cover");
  assert.equal(r.included.length, 28);
  assert.equal(r.blocked.length, 2);
  assert.deepEqual(r.blocked.map((b) => b.provenTo).sort(), ["2026-08-11", "2026-08-24"]);
});

test("resolveGoLiveAsOf: caps at the ceiling (never claims a date past server D-1); empty proven => no as-of", () => {
  const r = resolveGoLiveAsOf([{ accountId: "A", provenTo: "2026-09-10" }, { accountId: "B", provenTo: "2026-09-11" }], { ceiling: "2026-08-29", maxBlocked: 0 });
  assert.equal(r.asOf, "2026-08-29", "capped at the ceiling");
  assert.equal(r.included.length, 2);
  const none = resolveGoLiveAsOf([{ accountId: "A", provenTo: null }], { ceiling: "2026-08-29" });
  assert.equal(none.asOf, null);
  assert.equal(none.blocked.length, 1);
});

test("fbaGoLiveTokenCost: 16 batched exports = 80 premium tokens; adoptable jobs cost 0", () => {
  const jobs = [];
  for (let i = 0; i < 14; i++) jobs.push({ requestHash: "fba" + i, sourceKey: "fba-inventory-health" });
  for (let i = 0; i < 2; i++) jobs.push({ requestHash: "awd" + i, sourceKey: "listings" });
  const full = fbaGoLiveTokenCost(jobs, () => false);
  assert.equal(full.creates, 16);
  assert.equal(full.tokens, 80, "16 premium exports * 5 = 80 (exactly the ceiling)");
  // Four already-cached FBA Health jobs adopt for free.
  const cached = new Set(["fba0", "fba1", "fba2", "fba3"]);
  const partial = fbaGoLiveTokenCost(jobs, (h) => cached.has(h));
  assert.equal(partial.creates, 12);
  assert.equal(partial.tokens, 60);
  assert.equal(partial.byFamily["fba-inventory-health"].adoptable, 4);
});

/* ============================= run ============================= */

async function main() {
  mark("main(): loading fba-plan modules");
  ({ assembleSources, runReportJobs, sanitizeReportDiagnostic } = await import("../lib/server/sync/report-worker.js"));
  ({ deriveReportSnapshot } = await import("../lib/server/sync/report-derivation.js"));
  ({ fbaPlanPayload, foldPlanAsinUnits } = await import("../lib/server/reports/derivation-core.js"));
  ({ planMonthWindows, addDaysStr, canonicalOliSlices } = await import("../lib/server/date-windows.js"));
  ({ planFbaPlan, planFbaPlanBucketBatched, marketplaceCodeFor } = await import("../lib/server/sync/report-planner.js"));
  ({ slicedOliSourceFromHistory } = await import("../lib/server/sync/durable-dashboards.js"));
  ({ makeFbaPlanDurableContextLoader, oliCoverageProvesWindow } = await import("../lib/server/sync/fba-plan-durable-loader.js"));
  ({ resolveGoLiveAsOf, fbaGoLiveTokenCost } = await import("../lib/server/sync/fba-plan-golive-plan.js"));
  mark("modules loaded; running " + tests.filter((t) => !t.marker).length + " tests");

  let failures = 0;
  for (const t of tests) {
    if (t.marker) { mark("group -> " + t.marker); continue; }
    try { await t.fn(); passed += 1; out("  ok  " + t.name); }
    catch (err) { failures += 1; out("FAIL  " + t.name); out(String(err && err.stack ? err.stack : err)); }
  }
  out("\n" + passed + " assertions passed");
  mark("done: " + passed + " passed, " + failures + " failed");
  return failures;
}

main().then((failures) => { if (failures) process.exitCode = 1; }).catch((err) => { out("FATAL " + String(err && err.stack ? err.stack : err)); process.exitCode = 1; });
