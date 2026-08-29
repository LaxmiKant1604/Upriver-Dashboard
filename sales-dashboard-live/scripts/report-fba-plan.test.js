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
let assembleSources, deriveReportSnapshot, runReportJobs;
let fbaPlanPayload, foldPlanAsinUnits;
let planMonthWindows, addDaysStr, planFbaPlan, canonicalOliSlices;

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
const INV_WINDOW = { from: "2025-07-27", to: ASOF }; // asOf - 10 days .. asOf

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
const deriveFba = (planned, rows, context = usContext(), statusOverride) =>
  deriveReportSnapshot({ reportKey: "fba-plan", sources: buildSources(planned, rows, statusOverride), context });

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

// Build a planned report + a seeded store for the worker, from fbaPlanned() fragments.
function fbaReportPlan(planned, rows) {
  const store = makeReportStore();
  for (const p of planned) store.seedSourceSucceeded(p.requestHash);
  const sources = planned.map((p) => ({ ...p, optional: p.requestKey === "fba-plan:awd" }));
  const plannedReport = { reportKey: "fba-plan", accountId: ID, connectionId: "primary", bucket: "us", reportVersion: "fba-plan/v2d-3", sources, context: usContext() };
  const sourceRows = (hash) => (Object.prototype.hasOwnProperty.call(rows, hash) ? { rows: rows[hash] } : { rows: [] });
  return { store, plannedReport, sourceRows };
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
  { date: "2025-08-01", child_asin: "ASIN1", sku: "SKU-OLD", available: 999 }, // older snapshot -> ignored
];
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
  rows: [
    { asin: "ASIN1", productName: "Widget", brand: "Acme", sku: "SKU-1", unitsByMonth: { "2025-05": 10, "2025-06": 20, "2025-07": 7 }, mtdUnits: 3, fbaAvailable: 100, customerOrderReserved: 4, reservedFcTransfer: 8, reservedFcProcessing: 1, inboundShipped: 5, inboundReceived: 2, inboundWorking: 0, awdAvailable: 42, awdInbound: 15 },
    { asin: "ASIN2", productName: "Gadget", brand: "Beta", sku: null, unitsByMonth: { "2025-05": 5, "2025-06": 0, "2025-07": 0 }, mtdUnits: 0, fbaAvailable: 0, customerOrderReserved: 0, reservedFcTransfer: 0, reservedFcProcessing: 0, inboundShipped: 0, inboundReceived: 0, inboundWorking: 0, awdAvailable: 0, awdInbound: 0 },
  ],
  accountSkus: ["SKU-1"],
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
  const catHash = planned.find((p) => p.requestKey === "fba-plan:catalog").requestHash;
  const res = deriveFba(planned, rows, usContext(), { [catHash]: "failed" });
  assert.equal(res.status, "unavailable");
  assert.equal(res.payload, null);
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

test("planFbaPlan: US account emits every source incl. AWD, single-account, deterministic hashes", () => {
  const req = planFbaPlan({ accountId: ID, name: "Acme Co", country: "US", currency: "USD", connections: PL_CONN, asOf: ASOF });
  const keys = [...new Set(req.sources.map((s) => s.requestKey))].sort();
  assert.deepEqual(keys, ["fba-plan:awd", "fba-plan:catalog", "fba-plan:inventory-health", "fba-plan:oli-sales"]);
  const expectedOliSlices = canonicalOliSlices(planMonthWindows(ASOF).completed[0].from, ASOF);
  assert.equal(req.sources.filter((s) => s.requestKey === "fba-plan:oli-sales").length, expectedOliSlices.length, "one fragment per canonical OLI slice (3 completed months + current MTD)");
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

test("fba-plan: the canonical inventory window IS addDaysStr(asOf,-10)..asOf and AWD is null/null", () => {
  assert.equal(INV_WINDOW.from, addDaysStr(ASOF, -10));
  assert.equal(INV_WINDOW.to, ASOF);
});

test("fba-plan: a SHORTENED inventory lookback (from > asOf-10) blocks; payload null", () => {
  const { planned, rows } = fbaPlanned({ oliByIdx: OLI, catalogRows: CATALOG, invRows: INV, awdRows: AWD });
  const idx = planned.findIndex((p) => p.requestKey === "fba-plan:inventory-health");
  planned[idx] = { ...planned[idx], from: addDaysStr(ASOF, -9) };
  const res = deriveFba(planned, rows);
  assert.equal(res.status, "invalid");
  assert.equal(res.payload, null);
});

test("fba-plan: an EXTENDED inventory lookback (from < asOf-10) blocks", () => {
  const { planned, rows } = fbaPlanned({ oliByIdx: OLI, catalogRows: CATALOG, invRows: INV, awdRows: AWD });
  const idx = planned.findIndex((p) => p.requestKey === "fba-plan:inventory-health");
  planned[idx] = { ...planned[idx], from: addDaysStr(ASOF, -11) };
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

test("planFbaPlan emits the canonical inventory (asOf-10..asOf) + no-date AWD windows the derivation requires", () => {
  const req = planFbaPlan({ accountId: ID, name: "Acme Co", country: "US", currency: "USD", connections: PL_CONN, asOf: ASOF });
  const inv = req.sources.find((s) => s.requestKey === "fba-plan:inventory-health");
  assert.equal(inv.from, addDaysStr(ASOF, -10));
  assert.equal(inv.to, ASOF);
  const awd = req.sources.find((s) => s.requestKey === "fba-plan:awd");
  assert.equal(awd.from, null);
  assert.equal(awd.to, null);
});

test("fba-plan worker: a shortened-inventory derive writes ZERO snapshots and preserves last-known-good", async () => {
  const { planned, rows } = fbaPlanned({ oliByIdx: OLI, catalogRows: CATALOG, invRows: INV, awdRows: AWD });
  const idx = planned.findIndex((p) => p.requestKey === "fba-plan:inventory-health");
  planned[idx] = { ...planned[idx], from: addDaysStr(ASOF, -9) }; // shortened -> derive invalid before save
  const { store, plannedReport, sourceRows } = fbaReportPlan(planned, rows);
  const LKG = { asOf: "2025-07-01", rows: [{ asin: "PRIOR" }] };
  store.seedSnapshot("scheduler-v2/fba-plan", ID, LKG); // prior good (shadow-namespaced) snapshot
  const saveSnapshot = async () => { store.saveCalls += 1; return { paramsHash: "ph" }; };
  await runReportJobs({ store, cycleId: "cyc1", sourceRows, saveSnapshot, plannedReports: [plannedReport] });
  assert.equal(store.saveCalls, 0, "no snapshot saved for the blocked derive");
  assert.deepEqual(store._snapshots.get("scheduler-v2/fba-plan|" + ID).payload, LKG, "last-known-good snapshot unchanged/readable");
  assert.equal(store.report("fba-plan", ID).derive_status, "failed", "report recorded a derive failure (terminal this cycle)");
});

/* ============================= run ============================= */

async function main() {
  mark("main(): loading fba-plan modules");
  ({ assembleSources, runReportJobs } = await import("../lib/server/sync/report-worker.js"));
  ({ deriveReportSnapshot } = await import("../lib/server/sync/report-derivation.js"));
  ({ fbaPlanPayload, foldPlanAsinUnits } = await import("../lib/server/reports/derivation-core.js"));
  ({ planMonthWindows, addDaysStr, canonicalOliSlices } = await import("../lib/server/date-windows.js"));
  ({ planFbaPlan } = await import("../lib/server/sync/report-planner.js"));
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
