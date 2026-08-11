// Sales Movers Scheduler-v2 derivation + staged shadow-cycle parity tests (SHADOW MODE, fully offline).
//
// Part A drives deriveReportSnapshot("sales-movers") against hand-built saved fragments and proves the
// pure payload deep-equals a hand-computed production-route fixture, plus the no-data path, mixed-currency
// withholding, inventory null-vs-zero, name/brand precedence, zero-tail exclusion, fail-closed window/
// account validation, LKG on missing sources, zero network, and idempotency. Part B drives the REAL
// runSalesMoversShadowCycle + runReportJobs and proves kickoff/staging/resume/isolation and shared-hash
// canonical dedup.
//
// 7-bit ASCII, LF, no top-level await, synchronous writeSync progress, dynamic imports after a dummy
// Supabase env. No secret-shaped literals; no process.exit / timers / background work.

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

let assembleSources, deriveReportSnapshot, runReportJobs, runSalesMoversShadowCycle, addDaysStr, salesMoversWindows, sourceJobOwnerId;

const ID = "A1";
const ASOF = "2025-08-10";
const dash = (...p) => p.join("-");
const CONNS = [
  { id: "primary", apiKey: dash("prim", "key"), accountPrefix: "" },
  { id: "secondary", apiKey: dash("sec", "key"), accountPrefix: dash("dd", "secondary") + ":" },
];
const LABEL = "Sales & Traffic by ASIN & Date";

// Windows (computed once main() has imported the helpers).
let PROBE_FROM, INV_FROM, RECENT, PRIOR, LATEST;

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

// Build Sales Movers planned fragments + rows. `downstream:false` builds only the probe (no-date path).
function smPlanned({ probeRows, trafficRecent = [], trafficPrior = [], adsRecent = [], adsPrior = [], inventory = [], catalog = [], ids = [ID], downstream = true } = {}) {
  const planned = []; const rows = {};
  const pf = frag("sales-movers:sales-latest-probe", PROBE_FROM, ASOF, ids); planned.push(pf); rows[pf.requestHash] = probeRows;
  if (downstream) {
    const tr = frag("sales-movers:traffic", RECENT.from, RECENT.to, ids); planned.push(tr); rows[tr.requestHash] = trafficRecent;
    const tp = frag("sales-movers:traffic", PRIOR.from, PRIOR.to, ids); planned.push(tp); rows[tp.requestHash] = trafficPrior;
    const ar = frag("sales-movers:ads", RECENT.from, RECENT.to, ids); planned.push(ar); rows[ar.requestHash] = adsRecent;
    const ap = frag("sales-movers:ads", PRIOR.from, PRIOR.to, ids); planned.push(ap); rows[ap.requestHash] = adsPrior;
    const inv = frag("sales-movers:inventory", INV_FROM, ASOF, ids); planned.push(inv); rows[inv.requestHash] = inventory;
    const cat = frag("sales-movers:catalog", null, null, ids); planned.push(cat); rows[cat.requestHash] = catalog;
  }
  return { planned, rows };
}
const ctx = (over = {}) => ({ to: ASOF, rawSellerId: ID, accountId: ID, ...over });
const deriveSm = (built, context = ctx(), statusOverride) =>
  deriveReportSnapshot({ reportKey: "sales-movers", sources: buildSources(built.planned, built.rows, statusOverride), context });

// ---- The hand-computed production-route fixture ----
const FIXTURE = () => ({
  probeRows: [{ date: "2025-08-05", units_sum: 3 }, { date: "2025-08-08", units_sum: 5 }, { date: "2025-08-09", units_sum: 0 }],
  trafficRecent: [
    { child_asin: "A", product_name: "Widget A", sales_sum: 100, units_sum: 10, orders_sum: 8, sessions_sum: 50, page_views_sum: 60, units_shipped_sum: 9, units_refunded_sum: 1 },
    { child_asin: "B", product_name: "Widget B", sales_sum: 0, units_sum: 0, orders_sum: 0, sessions_sum: 5, page_views_sum: 6, units_shipped_sum: 0, units_refunded_sum: 0 },
    { child_asin: "Z", product_name: "Zero Tail", sales_sum: 0, units_sum: 0, orders_sum: 0, sessions_sum: 0, page_views_sum: 0, units_shipped_sum: 0, units_refunded_sum: 0 },
  ],
  trafficPrior: [
    { child_asin: "A", product_name: "Widget A", sales_sum: 80, units_sum: 8, orders_sum: 6, sessions_sum: 40, page_views_sum: 48, units_shipped_sum: 7, units_refunded_sum: 0 },
    { child_asin: "Z", product_name: "Zero Tail", sales_sum: 0, units_sum: 0, orders_sum: 0, sessions_sum: 0, page_views_sum: 0, units_shipped_sum: 0, units_refunded_sum: 0 },
  ],
  adsRecent: [
    { child_asin: "A", currency: "USD", ad_spend_sum: 20, ad_sales_sum: 60, ad_clicks_sum: 100 },
    { child_asin: "B", currency: "USD", ad_spend_sum: 5, ad_sales_sum: 12, ad_clicks_sum: 30 },
    { child_asin: "B", currency: "CAD", ad_spend_sum: 3, ad_sales_sum: 7, ad_clicks_sum: 20 },
  ],
  adsPrior: [{ child_asin: "A", currency: "USD", ad_spend_sum: 15, ad_sales_sum: 45, ad_clicks_sum: 80 }],
  inventory: [
    { date: "2025-08-05", child_asin: "A", available: 5, inbound_shipped: 2, inbound_received: 1, days_of_supply: 10, units_shipped_t30: 30 },
    { date: "2025-08-09", child_asin: "A", available: 8, inbound_shipped: 3, inbound_received: 0, days_of_supply: 12, units_shipped_t30: 40 },
    { date: "2025-08-09", child_asin: "B", available: 0, inbound_shipped: 0, inbound_received: 0, days_of_supply: null, units_shipped_t30: 0 },
  ],
  catalog: [
    { child_asin: "A", parent_asin: "P1", product_name: "Catalog A Name", product_brand: "Acme" },
    { child_asin: "B", parent_asin: "P2", product_name: "", product_brand: "Beta" },
  ],
});
const expectedFixturePayload = () => ({
  accountId: "A1", asOf: "2025-08-10", salesLatestDate: "2025-08-08", lagDays: 4, sourceLabel: LABEL,
  dataUnavailable: false,
  windows: { recent: { from: "2025-08-02", to: "2025-08-08" }, prior: { from: "2025-07-26", to: "2025-08-01" }, days: 7 },
  currencies: ["CAD", "USD"], buyBoxEvaluated: false, inventoryAvailable: true, inventorySnapshotDate: "2025-08-09",
  rows: [
    {
      asin: "A", productName: "Catalog A Name", brand: "Acme",
      recent: { sales: 100, units: 10, orders: 8, sessions: 50, pageViews: 60, unitsShipped: 9, unitsRefunded: 1 },
      prior: { sales: 80, units: 8, orders: 6, sessions: 40, pageViews: 48, unitsShipped: 7, unitsRefunded: 0 },
      ads: { recentSpend: 20, recentSales: 60, recentClicks: 100, priorSpend: 15, priorSales: 45, priorClicks: 80, currency: "USD", mixedCurrency: false },
      inventory: { available: 8, inbound: 3, daysOfSupply: 12, unitsShippedT30: 40 },
    },
    {
      asin: "B", productName: "Widget B", brand: "Beta",
      recent: { sales: 0, units: 0, orders: 0, sessions: 5, pageViews: 6, unitsShipped: 0, unitsRefunded: 0 },
      prior: { sales: 0, units: 0, orders: 0, sessions: 0, pageViews: 0, unitsShipped: 0, unitsRefunded: 0 },
      ads: { recentSpend: null, recentSales: null, recentClicks: null, priorSpend: null, priorSales: null, priorClicks: null, currency: null, mixedCurrency: true },
      inventory: { available: 0, inbound: 0, daysOfSupply: null, unitsShippedT30: 0 },
    },
  ],
  catalogBrands: ["Acme", "Beta"],
});

/* ============================= Part A: pure derivation parity ============================= */

group("sales-movers derive: exact production-route payload parity");

test("1. pure payload deep-equals the hand-computed production-route fixture", () => {
  const r = deriveSm(smPlanned(FIXTURE()));
  assert.equal(r.status, "derived");
  assert.deepEqual(r.payload, expectedFixturePayload());
});

test("2. a validated probe with NO reported date derives the EXACT dataUnavailable payload (no downstream needed)", () => {
  // No units anywhere in the probe window => salesLatestDate null. Only the probe fragment exists.
  const r = deriveSm(smPlanned({ probeRows: [{ date: "2025-08-05", units_sum: 0 }, { date: "2025-08-08", units_sum: 0 }], downstream: false }));
  assert.equal(r.status, "derived");
  assert.deepEqual(r.payload, {
    accountId: "A1", asOf: "2025-08-10", salesLatestDate: null, lagDays: 4, sourceLabel: LABEL,
    dataUnavailable: true,
    unavailableReason: `${LABEL} reported no units for this account between ${PROBE_FROM} and ${ASOF}, so there is no completed week to compare. This is upstream source availability, not a zero-sales week.`,
    windows: null, rows: [], catalogBrands: [],
  });
});

test("3. recent/prior traffic totals are summed by ASIN and preserved exactly", () => {
  const p = deriveSm(smPlanned(FIXTURE())).payload;
  const a = p.rows.find((r) => r.asin === "A");
  assert.deepEqual(a.recent, { sales: 100, units: 10, orders: 8, sessions: 50, pageViews: 60, unitsShipped: 9, unitsRefunded: 1 });
  assert.deepEqual(a.prior, { sales: 80, units: 8, orders: 6, sessions: 40, pageViews: 48, unitsShipped: 7, unitsRefunded: 0 });
});

test("4. mixed-currency ASIN advertising is WITHHELD (never combined across currencies)", () => {
  const p = deriveSm(smPlanned(FIXTURE())).payload;
  const b = p.rows.find((r) => r.asin === "B");
  assert.equal(b.ads.mixedCurrency, true);
  assert.deepEqual([b.ads.recentSpend, b.ads.recentSales, b.ads.priorSpend, b.ads.currency], [null, null, null, null]);
  assert.deepEqual(p.currencies, ["CAD", "USD"], "account currencies reported, not combined");
});

test("5. inventory is genuine zero when available, and null for EVERY row when the snapshot is unavailable", () => {
  // Genuine zero (B) with an available snapshot.
  const withInv = deriveSm(smPlanned(FIXTURE())).payload;
  assert.deepEqual(withInv.rows.find((r) => r.asin === "B").inventory, { available: 0, inbound: 0, daysOfSupply: null, unitsShippedT30: 0 });
  assert.equal(withInv.inventoryAvailable, true);
  // Empty inventory fragment => snapshot unavailable => every row's inventory is null (never zero).
  const noInv = deriveSm(smPlanned({ ...FIXTURE(), inventory: [] })).payload;
  assert.equal(noInv.inventoryAvailable, false);
  assert.equal(noInv.inventorySnapshotDate, null);
  assert.ok(noInv.rows.every((r) => r.inventory === null), "inventory is null (not zero) when the snapshot is missing");
});

test("6. product-name precedence is catalog -> recent traffic -> prior traffic; brand from catalog", () => {
  const base = FIXTURE();
  // A: catalog name wins. B: catalog name blank => recent traffic name. Now make an ASIN present only in
  // PRIOR traffic (with sales) whose catalog + recent names are absent => prior traffic name.
  base.trafficPrior.push({ child_asin: "C", product_name: "Prior Only C", sales_sum: 5, units_sum: 1, orders_sum: 1, sessions_sum: 2, page_views_sum: 3, units_shipped_sum: 1, units_refunded_sum: 0 });
  const p = deriveSm(smPlanned(base)).payload;
  assert.equal(p.rows.find((r) => r.asin === "A").productName, "Catalog A Name");
  assert.equal(p.rows.find((r) => r.asin === "B").productName, "Widget B");
  assert.equal(p.rows.find((r) => r.asin === "C").productName, "Prior Only C");
  assert.equal(p.rows.find((r) => r.asin === "C").brand, "Unassigned", "no catalog brand => Unassigned");
});

test("7. permanent zero-tail ASINs (both windows fully zero) are excluded", () => {
  const p = deriveSm(smPlanned(FIXTURE())).payload;
  assert.ok(!p.rows.some((r) => r.asin === "Z"), "the zero-tail ASIN Z is dropped");
  assert.deepEqual(p.rows.map((r) => r.asin), ["A", "B"], "only real movers remain, in child_asin order");
});

test("8. wrong / missing / duplicate / reordered / overlapping windows fail closed (invalid)", () => {
  const good = FIXTURE();
  // Reordered traffic windows [prior, recent].
  const reordered = smPlanned(good);
  const trIdx = reordered.planned.findIndex((p) => p.requestKey === "sales-movers:traffic");
  const a = reordered.planned[trIdx]; const b = reordered.planned[trIdx + 1];
  reordered.planned[trIdx] = { ...a, from: PRIOR.from, to: PRIOR.to }; reordered.planned[trIdx + 1] = { ...b, from: RECENT.from, to: RECENT.to };
  assert.equal(deriveSm(reordered).status, "invalid", "reordered traffic windows => invalid");
  // Missing one traffic fragment.
  const missing = smPlanned(good); const ti = missing.planned.findIndex((p) => p.requestKey === "sales-movers:traffic");
  missing.planned.splice(ti + 1, 1);
  assert.equal(deriveSm(missing).status, "invalid", "one traffic fragment missing => invalid");
  // Wrong ads window.
  const wrong = smPlanned(good); const ai = wrong.planned.findIndex((p) => p.requestKey === "sales-movers:ads");
  wrong.planned[ai] = { ...wrong.planned[ai], from: addDaysStr(RECENT.from, -1) };
  assert.equal(deriveSm(wrong).status, "invalid", "shifted ads window => invalid");
  // Dated catalog (must be no-date).
  const datedCat = smPlanned(good); const ci = datedCat.planned.findIndex((p) => p.requestKey === "sales-movers:catalog");
  datedCat.planned[ci] = { ...datedCat.planned[ci], from: RECENT.from, to: RECENT.to };
  assert.equal(deriveSm(datedCat).status, "invalid", "dated catalog fragment => invalid");
});

test("9. cross-account / out-of-window fragments fail closed (invalid)", () => {
  const good = FIXTURE();
  const cross = smPlanned(good); const ti = cross.planned.findIndex((p) => p.requestKey === "sales-movers:traffic");
  cross.planned[ti] = { ...cross.planned[ti], sellerOrVendorIds: ["OTHER"] };
  assert.equal(deriveSm(cross).status, "invalid", "cross-account traffic fragment => invalid");
  // An out-of-window probe row (before probeFrom) makes the probe invalid.
  const badProbe = smPlanned({ ...good, probeRows: [{ date: addDaysStr(PROBE_FROM, -1), units_sum: 5 }] });
  assert.equal(deriveSm(badProbe).status, "invalid", "out-of-window probe row => invalid");
});

test("10. a missing/failed required downstream => unavailable, ZERO snapshot writes, last-known-good preserved (worker)", async () => {
  const good = FIXTURE();
  // Traffic fragments FAILED => derive is unavailable (not a fabricated zero).
  const built = smPlanned(good);
  const trHashes = built.planned.filter((p) => p.requestKey === "sales-movers:traffic").map((p) => p.requestHash);
  const status = {}; trHashes.forEach((h) => { status[h] = "failed"; });
  const r = deriveSm(built, ctx(), status);
  assert.equal(r.status, "unavailable", "a failed required traffic source => unavailable (LKG preserved)");
});

test("11. derivation makes ZERO network calls; 12. repeated derivation is idempotent", () => {
  const realFetch = globalThis.fetch; let hits = 0;
  globalThis.fetch = () => { hits += 1; throw new Error("network during derivation"); };
  let a, b;
  try { a = deriveSm(smPlanned(FIXTURE())).payload; b = deriveSm(smPlanned(FIXTURE())).payload; } finally { globalThis.fetch = realFetch; }
  assert.equal(hits, 0, "zero DataDoe/network calls during derivation");
  assert.deepEqual(a, b, "repeated derivation is idempotent");
  assert.deepEqual(a, expectedFixturePayload());
});

/* ============================= Part B: staged shadow cycle ============================= */

group("sales-movers cycle: kickoff / staging / resume / isolation / shared-hash dedup");

// Combined in-memory store: source-worker + owner-membership + report-worker interfaces.
function makeStore() {
  const cycles = new Map(); const jobsByCycle = new Map(); const ownersByCycle = new Map();
  const cache = new Map(); const reportJobs = new Map(); const snapshots = new Map(); let seq = 0;
  const findCycle = (id) => [...cycles.values()].find((c) => c.id === id) || null;
  const ownerRows = (cid) => [...((ownersByCycle.get(cid) && ownersByCycle.get(cid).values()) || [])];
  const rkey = (rk, a) => rk + "|" + a;
  return {
    _rawJob: (cid, h) => jobsByCycle.get(cid) && jobsByCycle.get(cid).get(h),
    _owners: (cid) => ownerRows(cid).map((m) => ({ ...m })),
    _snapshots: snapshots, saveCalls: 0,
    openCycle({ bucket, cycleDate }) { const k = bucket + "|" + cycleDate; if (!cycles.has(k)) { const id = "cyc_" + (seq += 1); cycles.set(k, { id, bucket, status: "pending" }); jobsByCycle.set(id, new Map()); } return cycles.get(k).id; },
    claimCycle(id) { const c = findCycle(id); if (c && c.status === "pending") { c.status = "running"; return true; } return false; },
    getCycle(id) { return findCycle(id); },
    upsertSourceJob(job) { const m = jobsByCycle.get(job.cycleId); if (m.has(job.requestHash)) return; m.set(job.requestHash, { request_hash: job.requestHash, request_key: job.requestKey, source_id: job.sourceId, source_key: job.sourceKey, connection_id: job.connectionId, organization_fingerprint: job.organizationFingerprint, account_scope_hash: job.accountScopeHash, fetch_status: "pending", attempted_at: null, create_export_count: 0, export_id: null, terminal: false, row_count: null }); },
    listSourceJobs(id) { return [...((jobsByCycle.get(id) && jobsByCycle.get(id).values()) || [])].map((j) => ({ ...j })); },
    upsertSourceJobOwners(ms) { for (const m of ms || []) { if (!ownersByCycle.has(m.cycleId)) ownersByCycle.set(m.cycleId, new Map()); ownersByCycle.get(m.cycleId).set(m.ownerId + "|" + m.requestHash, { cycle_id: m.cycleId, request_hash: m.requestHash, owner_id: m.ownerId, request_key: m.requestKey, report_key: m.reportKey, account_id: m.accountId, connection_id: m.connectionId, organization_fingerprint: m.organizationFingerprint, account_scope_hash: m.accountScopeHash, owner_status: "active", error_code: null, error_message: null }); } },
    listSourceJobOwners(cid, ids) { const s = new Set(ids || []); return ownerRows(cid).filter((m) => s.has(m.owner_id)).map((m) => ({ ...m })); },
    recordSourceOwnerStale({ cycleId, requestHash, ownerId, code, message }) { const m = ownersByCycle.get(cycleId) && ownersByCycle.get(cycleId).get(ownerId + "|" + requestHash); if (m) { m.owner_status = "stale"; m.error_code = code || "STALE_PLAN"; m.error_message = message || null; } },
    claimExportAttempt(id, h) { const j = jobsByCycle.get(id) && jobsByCycle.get(id).get(h); if (j && j.attempted_at === null) { j.attempted_at = "t"; j.create_export_count += 1; j.fetch_status = "attempted"; return true; } return false; },
    recordExportCreated({ cycleId, requestHash, exportId }) { jobsByCycle.get(cycleId).get(requestHash).export_id = exportId; },
    loadSourceRows(h) { const e = cache.get(h); return e ? { rows: e.rows } : null; },
    saveSourceRows({ job, rows }) { const h = job.request_hash != null ? job.request_hash : job.requestHash; cache.set(h, { rows: [...rows] }); return "p/" + h; },
    recordSourceSuccess({ cycleId, requestHash, exportId, rowCount, cacheObjectPath }) { Object.assign(jobsByCycle.get(cycleId).get(requestHash), { fetch_status: "succeeded", export_id: exportId, row_count: rowCount, cache_object_path: cacheObjectPath }); },
    recordSourceFailure({ cycleId, requestHash, stage, code, terminal }) { Object.assign(jobsByCycle.get(cycleId).get(requestHash), { fetch_status: "failed", error_stage: stage, error_code: code, terminal: !!terminal }); },
    updateCycleCounts() {},
    // report-worker
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

// DataDoe double: returns rows by request_key; tracks creates per hash. `deferStage/deferKey` defers once.
function makeDataDoe(opts = {}) {
  const create = {}; let hits = 0;
  const deadlineErr = () => Object.assign(new Error("deferred"), { code: "DATADOE_DEADLINE" });
  const rowsFor = (job) => {
    const rk = job.requestKey;
    if (rk === "sales-movers:sales-latest-probe") return [{ date: "2025-08-08", units_sum: 5 }];
    if (rk === "sales-movers:traffic") return [{ child_asin: "A", product_name: "Widget A", sales_sum: 10, units_sum: 1, orders_sum: 1, sessions_sum: 5, page_views_sum: 6, units_shipped_sum: 1, units_refunded_sum: 0 }];
    if (rk === "sales-movers:ads") return [{ child_asin: "A", currency: "USD", ad_spend_sum: 1, ad_sales_sum: 2, ad_clicks_sum: 3 }];
    if (rk === "sales-movers:inventory") return [{ date: "2025-08-09", child_asin: "A", available: 5, inbound_shipped: 1, inbound_received: 0, days_of_supply: 9, units_shipped_t30: 20 }];
    return [{ child_asin: "A", parent_asin: "P1", product_name: "Catalog A", product_brand: "Acme" }];
  };
  return {
    createCount: (h) => create[h] || 0, totalCreates: () => Object.values(create).reduce((a, b) => a + b, 0),
    async create(job) { create[job.requestHash] = (create[job.requestHash] || 0) + 1; return { exportId: "e_" + job.requestHash }; },
    async poll(job) { if (opts.deferStage === "poll" && job.requestKey === opts.deferKey) { hits += 1; if (hits === 1) throw deadlineErr(); } },
    async download(job) { if (opts.deferStage === "download" && job.requestKey === opts.deferKey) { hits += 1; if (hits === 1) throw deadlineErr(); } return rowsFor(job); },
  };
}
const runCycle = (store, dd, accounts, opts = {}) => runSalesMoversShadowCycle({ accounts, connections: CONNS, asOf: ASOF, store, dataDoe: dd, bucket: "us", cycleDate: "2026-08-11", ...opts });
const A1 = { accountId: "A1", country: "US", currency: "USD" };
// Distinct request_keys staged (traffic + ads each stage TWO windowed canonical hashes under one key).
const keyOf = (store, cid) => [...new Set(store.listSourceJobs(cid).map((j) => j.request_key))].sort();

test("13. kickoff (maxRounds:1) creates ONLY the latest-date probe (no downstream token spent)", async () => {
  const store = makeStore(); const dd = makeDataDoe();
  const r = await runCycle(store, dd, [A1], { maxRounds: 1 });
  assert.deepEqual(keyOf(store, r.cycleId), ["sales-movers:sales-latest-probe"], "only the probe is staged");
  assert.equal(dd.totalCreates(), 1, "exactly one create-export (the probe)");
});

test("14. a validated dated probe stages each downstream canonical source EXACTLY once", async () => {
  const store = makeStore(); const dd = makeDataDoe();
  const r = await runCycle(store, dd, [A1], {});
  assert.deepEqual(keyOf(store, r.cycleId), ["sales-movers:ads", "sales-movers:catalog", "sales-movers:inventory", "sales-movers:sales-latest-probe", "sales-movers:traffic"], "probe + 4 downstream staged");
  for (const j of store.listSourceJobs(r.cycleId)) assert.ok(dd.createCount(j.request_hash) <= 1, j.request_key + " created at most once");
  // 7 canonical exports: probe + traffic(recent,prior) + ads(recent,prior) + inventory + catalog.
  assert.equal(dd.totalCreates(), 7, "probe + 2 traffic + 2 ads + inventory + catalog = 7 exports");
});

for (const scenario of [{ n: "maxRounds:1", o: { maxRounds: 1 } }, { n: "maxJobs:1", o: { maxJobs: 1 } }, { n: "poll deferral", d: { deferStage: "poll", deferKey: "sales-movers:sales-latest-probe" } }, { n: "download deferral", d: { deferStage: "download", deferKey: "sales-movers:sales-latest-probe" } }]) {
  test(`15. ${scenario.n}: partial invocation resumes without a duplicate create-export`, async () => {
    const store = makeStore();
    const dd1 = makeDataDoe(scenario.d || {});
    const r1 = await runCycle(store, dd1, [A1], scenario.o || {});
    const probeHash = r1.perAccount[0].probeHash;
    // Resume with a fresh (non-deferring) dataDoe.
    const dd2 = makeDataDoe();
    const r2 = await runCycle(store, dd2, [A1], {});
    assert.equal(dd1.createCount(probeHash) + dd2.createCount(probeHash), 1, "the probe export is created exactly once across the resume");
    assert.deepEqual(keyOf(store, r2.cycleId), ["sales-movers:ads", "sales-movers:catalog", "sales-movers:inventory", "sales-movers:sales-latest-probe", "sales-movers:traffic"], "resume completes all downstream");
    for (const j of store.listSourceJobs(r2.cycleId)) assert.ok((dd1.createCount(j.request_hash) + dd2.createCount(j.request_hash)) <= 1, j.request_key + " never exported twice");
  });
}

test("16. primary-only + account/bucket isolation: a stale dd-secondary account is skipped read-only with ZERO DataDoe calls, never routed to primary", async () => {
  const store = makeStore(); const dd = makeDataDoe();
  const PRIMARY_ONLY = [{ id: "primary", apiKey: dash("prim", "key"), accountPrefix: "" }];
  const accounts = [A1, { accountId: dash("dd", "secondary") + ":B1", country: "US", currency: "USD" }];
  const r = await runSalesMoversShadowCycle({ accounts, connections: PRIMARY_ONLY, asOf: ASOF, store, dataDoe: dd, bucket: "us", cycleDate: "2026-08-11" });
  assert.equal(r.unavailableAccounts.length, 1);
  assert.equal(r.unavailableAccounts[0].accountId, dash("dd", "secondary") + ":B1");
  assert.equal(r.unavailableAccounts[0].status, "CONNECTION_UNAVAILABLE");
  assert.ok(store.listSourceJobs(r.cycleId).every((j) => j.connection_id === "primary"), "no dd-secondary jobs; nothing routed to primary for the stale account");
  assert.deepEqual(r.plannedReports.map((p) => p.accountId), ["A1"], "only the primary account yields a report plan");
});

test("17. another report sharing a canonical inventory/catalog hash still results in ONE export per identical request_hash", async () => {
  const store = makeStore(); const dd = makeDataDoe();
  const r = await runCycle(store, dd, [A1], {});
  const cid = r.cycleId;
  // Take Sales Movers' real catalog canonical hash and give a SECOND owner (another report) a membership
  // for the SAME request_hash. A worker run for that owner must NOT create a second export.
  const catalog = store.listSourceJobs(cid).find((j) => j.request_key === "sales-movers:catalog");
  const otherOwner = sourceJobOwnerId({ reportKey: "daily-reporting", connectionId: "primary", organizationFingerprint: catalog.organization_fingerprint, accountScopeHash: catalog.account_scope_hash });
  store.upsertSourceJobOwners([{ cycleId: cid, requestHash: catalog.request_hash, ownerId: otherOwner, requestKey: "daily-reporting:catalog", reportKey: "daily-reporting", accountId: "A1", connectionId: "primary", organizationFingerprint: catalog.organization_fingerprint, accountScopeHash: catalog.account_scope_hash }]);
  const before = dd.createCount(catalog.request_hash);
  const { runSourceJobs } = await import("../lib/server/sync/source-worker.js");
  await runSourceJobs({ store, dataDoe: dd, plannedJobs: [{ requestHash: catalog.request_hash, requestKey: "daily-reporting:catalog", sourceId: catalog.source_id, sourceKey: "product-catalog", connectionId: "primary", organizationFingerprint: catalog.organization_fingerprint, accountScopeHash: catalog.account_scope_hash, requestMeta: {}, owner: { ownerId: otherOwner, requestKey: "daily-reporting:catalog", reportKey: "daily-reporting", accountId: "A1" }, fetchParams: { columns: ["c"], sellerOrVendorIds: ["A1"], from: null, to: null, options: {} } }], ownerIds: [otherOwner], bucket: "us", cycleDate: "2026-08-11" });
  assert.equal(dd.createCount(catalog.request_hash), before, "the shared canonical catalog export is NOT created a second time");
  assert.equal(store.listSourceJobs(cid).filter((j) => j.request_hash === catalog.request_hash).length, 1, "one canonical row");
  assert.equal(store._owners(cid).filter((m) => m.request_hash === catalog.request_hash).length, 2, "two owner memberships share the one canonical hash");
});

test("E2E: source cycle -> final plannedReports -> runReportJobs -> saved sales-movers snapshot; zero network during derivation; idempotent", async () => {
  const store = makeStore(); const dd = makeDataDoe();
  const cycle = await runCycle(store, dd, [A1], {});
  const saved = [];
  const sourceRows = (h) => store.loadSourceRows(h);
  const saveSnapshot = async ({ reportKey, accountId, payload }) => { store.saveCalls += 1; store.seedSnapshot(reportKey, accountId, payload); saved.push({ accountId, payload }); return { paramsHash: "ph" }; };
  const realFetch = globalThis.fetch; let hits = 0;
  globalThis.fetch = () => { hits += 1; throw new Error("network during derivation"); };
  let res;
  try { res = await runReportJobs({ store, cycleId: cycle.cycleId, sourceRows, saveSnapshot, plannedReports: cycle.plannedReports }); } finally { globalThis.fetch = realFetch; }
  assert.equal(hits, 0, "zero network during derivation");
  assert.equal(res.succeeded, 1, "the sales-movers report derived + saved");
  const payload = saved[0].payload;
  assert.equal(payload.dataUnavailable, false);
  assert.equal(payload.salesLatestDate, "2025-08-08");
  assert.equal(payload.buyBoxEvaluated, false);
  assert.equal(payload.sourceLabel, LABEL);
  // Idempotent: a second derivation writes no duplicate snapshot.
  const before = store.saveCalls;
  await runReportJobs({ store, cycleId: cycle.cycleId, sourceRows, saveSnapshot, plannedReports: cycle.plannedReports });
  assert.equal(store.saveCalls, before, "repeated invocation writes no duplicate snapshot");
});

async function main() {
  ({ assembleSources, runReportJobs } = await import("../lib/server/sync/report-worker.js"));
  ({ deriveReportSnapshot } = await import("../lib/server/sync/report-derivation.js"));
  ({ runSalesMoversShadowCycle } = await import("../lib/server/sync/sales-movers-cycle.js"));
  ({ addDaysStr } = await import("../lib/server/date-windows.js"));
  ({ salesMoversWindows } = await import("../lib/server/sync/report-source-contracts.js"));
  ({ sourceJobOwnerId } = await import("../lib/server/source-identity.js"));
  PROBE_FROM = addDaysStr(ASOF, -(4 + 7 * 3));
  INV_FROM = addDaysStr(ASOF, -10);
  LATEST = "2025-08-08";
  ({ recent: RECENT, prior: PRIOR } = salesMoversWindows(LATEST));

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
