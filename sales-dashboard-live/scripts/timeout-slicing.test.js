// Gate-6 timeout remediation -- TIMEOUT-SAFE SLICING parity + Ads-sync account-allowlist tests (offline).
//
// Proves, for every SAFE_TO_SLICE source that Gate-6 Cycle-1 DataDoe TIMEOUTs affected (the per-day-grouped
// daily-reporting superset, reconciliation order-lines + settlements, and the raw dated returns range):
//   1. the planner + derive slice constants are EQUAL (they cannot import each other -- import cycle);
//   2. the slice generators preserve the ORIGINAL coverage exactly: ordered, contiguous, no gap/overlap,
//      exact from/to, <=7 days each, month-bounded where month-scoped, NEWEST-FIRST where the source is DESC;
//   3. the SLICED derive deep-equals the FORMER UNSPLIT calculation (the pure payload builder over the same
//      concatenated rows) for every affected report;
//   4. the INTENTIONAL request-hash changes are golden-pinned for a fixed synthetic input;
//   5. malformed / missing / reordered / duplicate / wrong-window / out-of-slice-row fragments fail closed
//      (invalid/unavailable => zero writes => last-known-good preserved);
//   6. resumable slicing spends at most ONE create-export per request_hash across resumed invocations;
//   7. one failed slice blocks ONLY its own report -- an unrelated report still derives;
//   (the Ads-sync account-bounded canary + requiredCoverage findings are proven in ads-sync-canary.test.js).
//
// 7-bit ASCII, LF, no top-level await. Zero network (no fetch use; ads-sync is tested via its PURE resolver +
// structural source checks).

import assert from "node:assert/strict";
import { writeSync } from "node:fs";

process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://supabase.test";
const SB_KEY_ENV = ["SUPABASE", "SERVICE", "ROLE", "KEY"].join("_");
process.env[SB_KEY_ENV] = process.env[SB_KEY_ENV] || ["test", "svc", "role", "key"].join("-");

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };

let TIMEOUT_SAFE_SLICE_DAYS, planDailyReporting, planReconciliation, planReturnsLeakage, buildShadowReportPlan;
let DERIVE_TIMEOUT_SAFE_SLICE_DAYS, deriveReportSnapshot;
let assembleSources, runReportJobs;
let reportSourceRequestHashes;
let dailyReportingPayload, reconciliationPayload, returnsLeakagePayload, resolveDailyAdsAvailability;
let splitDateRangeByDays, splitDateRangeByMonth, addDaysStr, canonicalOliSlices;
let plannedSourceJob, runStagedSourceCycle;

const CONNS = [{ id: "primary", apiKey: ["prim", "key"].join("-"), accountPrefix: "" }];
const ID = "A1";
const ASOF = "2025-08-10";

let hashSeq = 0;
const frag = (requestKey, from, to, ids = [ID]) => ({ requestKey, requestHash: "hx" + (hashSeq += 1), from, to, sellerOrVendorIds: ids });
function buildSources(planned, rowsByHash, statusOverride = {}) {
  const statusByHash = {}; const loaded = new Map();
  for (const p of planned) {
    const st = statusOverride[p.requestHash] || "succeeded";
    statusByHash[p.requestHash] = st;
    if (st === "succeeded") loaded.set(p.requestHash, { rows: rowsByHash.get(p.requestHash) || [] });
  }
  return assembleSources(planned, statusByHash, loaded).sources;
}
// Partition dated rows into the given slice sequence (each row into ITS slice).
function slicedPlanned(requestKey, slices, rows, ids = [ID]) {
  const planned = []; const byHash = new Map();
  for (const w of slices) {
    const f = frag(requestKey, w.from, w.to, ids);
    planned.push(f);
    byHash.set(f.requestHash, rows.filter((r) => typeof r.date === "string" && r.date >= w.from && r.date <= w.to));
  }
  return { planned, byHash };
}

/* ============================= 1 + 2: constants + window invariants ============================= */

test("slice constants: planner TIMEOUT_SAFE_SLICE_DAYS === derive DERIVE_TIMEOUT_SAFE_SLICE_DAYS === 7", () => {
  assert.equal(TIMEOUT_SAFE_SLICE_DAYS, 7);
  assert.equal(DERIVE_TIMEOUT_SAFE_SLICE_DAYS, 7);
  assert.equal(TIMEOUT_SAFE_SLICE_DAYS, DERIVE_TIMEOUT_SAFE_SLICE_DAYS, "planner and derive must slice identically");
});

function assertExactCoverage(slices, from, to, { monthBounded = false, desc = false } = {}) {
  const seq = desc ? [...slices].reverse() : slices;
  assert.ok(seq.length > 0);
  assert.equal(seq[0].from, from, "exact original start");
  assert.equal(seq[seq.length - 1].to, to, "exact original end");
  for (let i = 0; i < seq.length; i += 1) {
    const s = seq[i];
    assert.ok(s.from <= s.to, "valid window");
    const days = (Date.parse(s.to) - Date.parse(s.from)) / 86400000 + 1;
    assert.ok(days <= 7, "each slice <= 7 days");
    if (monthBounded) assert.equal(s.from.slice(0, 7), s.to.slice(0, 7), "slice inside ONE calendar month");
    if (i > 0) assert.equal(s.from, addDaysStr(seq[i - 1].to, 1), "contiguous: no gap, no overlap");
  }
}

test("daily superset slices: ordered ASC, month-bounded, exact coverage (incl. leap February)", () => {
  for (const asOf of ["2025-08-10", "2024-03-05", "2026-01-31", "2024-07-31"]) {
    const req = planDailyReporting({ accountId: ID, country: "US", currency: "USD", connections: CONNS, asOf });
    const slices = req.sources.filter((s) => s.requestKey === "daily-reporting:oli-sales").map((s) => ({ from: s.from, to: s.to }));
    assertExactCoverage(slices, req.context.from, req.context.to, { monthBounded: true });
  }
});

test("reconciliation slices: ordered ASC, month-bounded, exact six-month coverage", () => {
  for (const asOf of ["2025-08-10", "2024-03-05"]) {
    const req = planReconciliation({ accountId: ID, country: "US", currency: "USD", connections: CONNS, asOf });
    for (const key of ["reconciliation:order-lines", "reconciliation:settlements"]) {
      const slices = req.sources.filter((s) => s.requestKey === key).map((s) => ({ from: s.from, to: s.to }));
      assertExactCoverage(slices, req.context.from, req.context.to, { monthBounded: true });
    }
  }
});

test("returns slices: NEWEST-FIRST (source is date DESC), exact 60-day coverage", () => {
  const req = planReturnsLeakage({ accountId: ID, country: "US", currency: "USD", connections: CONNS, asOf: ASOF });
  const slices = req.sources.filter((s) => s.requestKey === "returns-leakage:returns").map((s) => ({ from: s.from, to: s.to }));
  assert.equal(slices[0].to, ASOF, "newest slice first");
  assertExactCoverage(slices, addDaysStr(ASOF, -59), ASOF, { desc: true });
});

// Blocker 1a: the canonical cross-report OLI slicer. Calendar-anchored bins, not anchored to `from`, so
// different window STARTS with the SAME asOf share every interior slice (=> shared request_hashes).
test("canonicalOliSlices: full / partial-start / cross-month / asOf-mid-bin; different starts + same asOf share every interior slice", () => {
  // Full calendar month -> the fixed [1-7],[8-14],[15-21],[22-28],[29-end] bins.
  assert.deepEqual(canonicalOliSlices("2025-07-01", "2025-07-31"), [
    { from: "2025-07-01", to: "2025-07-07" }, { from: "2025-07-08", to: "2025-07-14" },
    { from: "2025-07-15", to: "2025-07-21" }, { from: "2025-07-22", to: "2025-07-28" },
    { from: "2025-07-29", to: "2025-07-31" },
  ]);
  // Partial-start month: the first bin stays CALENDAR-anchored (clamped to `from`), NOT re-anchored to `from`.
  assert.deepEqual(canonicalOliSlices("2025-07-10", "2025-07-31")[0], { from: "2025-07-10", to: "2025-07-14" });
  // A 28-day February has NO [29-..] bin.
  assert.equal(canonicalOliSlices("2025-02-01", "2025-02-28").length, 4);
  // Cross-month: contiguous, month-bounded bins across the boundary.
  const xm = canonicalOliSlices("2025-07-18", "2025-08-14");
  assert.deepEqual(xm[0], { from: "2025-07-18", to: "2025-07-21" });
  assert.deepEqual(xm[xm.length - 1], { from: "2025-08-08", to: "2025-08-14" });
  // asOf mid-bin: the final (current-month) bin is clamped to asOf.
  assert.deepEqual(canonicalOliSlices("2025-08-01", "2025-08-14"), [
    { from: "2025-08-01", to: "2025-08-07" }, { from: "2025-08-08", to: "2025-08-14" },
  ]);
  // Different window STARTS but the SAME asOf share EVERY interior slice.
  const asOf = "2025-08-14";
  const shortW = canonicalOliSlices(addDaysStr(asOf, -29), asOf); // ppc-like 30d window
  const longW = canonicalOliSlices(addDaysStr(asOf, -59), asOf);  // returns-like 60d window
  const key = (s) => s.from + ".." + s.to;
  const longKeys = new Set(longW.map(key));
  const interior = shortW.slice(1).map(key); // every slice except the clamped (partial) first one
  assert.ok(interior.length > 0);
  for (const k of interior) assert.ok(longKeys.has(k), "interior slice " + k + " is shared across both windows");
  // The clamped first slice of the shorter window is NOT shared (its `from` differs).
  assert.ok(!longKeys.has(key(shortW[0])), "the partial first slice is window-specific, never falsely shared");
});

/* ============================= 3: split == former-unsplit deep equality ============================= */

test("daily-reporting: SLICED derive deep-equals the former UNSPLIT calculation (same concatenated rows)", () => {
  const from = "2025-03-01", to = ASOF;
  const rows = [
    { date: "2025-03-02", seller_or_vendor_id: "S1", child_asin: "A1", total_sales_sum: 10, total_units_sum: 1 },
    { date: "2025-04-15", seller_or_vendor_id: "S1", child_asin: "A2", total_sales_sum: 20, total_units_sum: 2 },
    { date: "2025-05-31", seller_or_vendor_id: "S2", child_asin: "A1", total_sales_sum: 30, total_units_sum: 3 },
    { date: "2025-08-01", seller_or_vendor_id: "S1", child_asin: "A1", total_sales_sum: 40, total_units_sum: 4 },
  ];
  const catalog = [{ child_asin: "A1", product_brand: "Acme" }];
  const slices = splitDateRangeByMonth(from, to).flatMap((m) => splitDateRangeByDays(m.from, m.to, DERIVE_TIMEOUT_SAFE_SLICE_DAYS));
  const { planned, byHash } = slicedPlanned("daily-reporting:oli-sales", slices, rows, ["S1"]);
  const cat = frag("daily-reporting:catalog", from, to, ["S1"]);
  planned.push(cat); byHash.set(cat.requestHash, catalog);
  const context = { brand: "ALL", from, to, rawSellerId: "S1", currency: "USD", accountId: ID };
  const res = deriveReportSnapshot({ reportKey: "daily-reporting", sources: buildSources(planned, byHash), context });
  assert.equal(res.status, "derived");
  // FORMER calculation: the pure payload builder over the UNSPLIT concatenated rows, with the identical
  // no-coverage Ads availability the derive resolves (transcribed from the pre-slicing derive body).
  let availability, coveredAdRows;
  try {
    const resolved = resolveDailyAdsAvailability(undefined, { accountId: ID, rawSellerId: "S1", currency: "USD", from, to });
    availability = resolved.availability; coveredAdRows = resolved.adRows;
  } catch (_e) {
    availability = { status: "failed", coveredFrom: null, coveredTo: null, requestedFrom: from, requestedTo: to, currency: "USD", latestMetricDate: null, reason: "ads-availability-error" };
    coveredAdRows = [];
  }
  const former = dailyReportingPayload({ supersetRows: rows, catalogRows: catalog, adRows: coveredAdRows, brand: "ALL", adsAvailability: availability });
  assert.deepEqual(res.payload, former, "sliced fragments reproduce the former unsplit payload EXACTLY");
});

test("reconciliation: SLICED derive deep-equals the former UNSPLIT calculation (same concatenated rows)", () => {
  const req = planReconciliation({ accountId: ID, country: "US", currency: "USD", connections: CONNS, asOf: ASOF });
  const from = req.context.from, to = req.context.to;
  const months = splitDateRangeByMonth(from, to);
  const orderRows = [
    { amazon_order_id: "O1", order_date: months[0].from, date: months[0].from, amazon_order_status: "Shipped", fulfillment_channel: "AFN", order_is_business: false, item_price_currency: "USD", child_asin: "A1", quantity_sum: 2, item_price_sum: 40, item_tax_sum: 4 },
    { amazon_order_id: "O2", order_date: months[3].from, date: months[3].from, amazon_order_status: "Shipped", fulfillment_channel: "MFN", order_is_business: true, item_price_currency: "EUR", child_asin: "A2", quantity_sum: 1, item_price_sum: 20, item_tax_sum: 2 },
  ];
  const settleRows = [
    { date: months[1].from, amazon_order_id: "O1", settlement_type: "order", currency: "USD", item_price_sum: 50, item_tax_sum: 5, referral_fee_sum: -7, fba_fee_sum: -4, refunded_amount_sum: 0, total_sum: 44 },
  ];
  const catalog = [{ child_asin: "A1", product_brand: "Acme" }];
  const slices = months.flatMap((m) => splitDateRangeByDays(m.from, m.to, DERIVE_TIMEOUT_SAFE_SLICE_DAYS));
  const o = slicedPlanned("reconciliation:order-lines", slices, orderRows);
  const s = slicedPlanned("reconciliation:settlements", slices, settleRows);
  const cat = frag("reconciliation:catalog", from, to);
  const planned = [...o.planned, ...s.planned, cat];
  const byHash = new Map([...o.byHash, ...s.byHash, [cat.requestHash, catalog]]);
  const res = deriveReportSnapshot({ reportKey: "reconciliation", sources: buildSources(planned, byHash), context: { from, to, rawSellerId: ID } });
  assert.equal(res.status, "derived");
  const former = reconciliationPayload({ from, to, months: months.map((m) => m.from.slice(0, 7)), orderRows, settlementRows: settleRows, catalogRows: catalog });
  assert.deepEqual(res.payload, former, "sliced fragments reproduce the former unsplit payload EXACTLY");
});

test("returns-leakage: SLICED derive deep-equals the former UNSPLIT calculation (DESC concatenation preserved)", () => {
  const from = addDaysStr(ASOF, -59);
  const returns = [
    { date: "2025-08-01", sku: "S", child_asin: "R1", amazon_order_id: "O", amazon_return_reason: "DEFECTIVE", amazon_fulfillment_channel: "FBA", amazon_return_request_status: "Approved", amazon_return_refunded_amount: -10, amazon_return_label_cost: -2, amazon_return_label_to_be_paid_by: "Seller" },
    { date: "2025-07-15", sku: "S", child_asin: "R1", amazon_order_id: "O", amazon_return_reason: "TOO_SMALL", amazon_fulfillment_channel: "FBM", amazon_return_request_status: "PendingApproval", amazon_return_refunded_amount: -5, amazon_return_label_cost: -1, amazon_return_label_to_be_paid_by: "Amazon" },
  ];
  const settlements = [{ sku: "S", child_asin: "R1", settlement_type: "ORDER", currency: "USD", item_price_sum: 200, quantity_sum: 20 }];
  const ordered = [{ date: "2025-08-01", seller_or_vendor_id: ID, sku: "S", child_asin: "R1", item_price_currency: "USD", product_name: "W", total_sales_sum: 500, total_units_sum: 50 }];
  const catalog = [{ child_asin: "R1", parent_asin: "P", product_name: "W", product_brand: "Acme" }];
  const returnSlices = splitDateRangeByDays(from, ASOF, DERIVE_TIMEOUT_SAFE_SLICE_DAYS).reverse();
  const r = slicedPlanned("returns-leakage:returns", returnSlices, returns);
  // Blocker 1: the canonical OLI sales fragment is sliced by canonicalOliSlices (per-row date binding).
  const oli = slicedPlanned("returns-leakage:oli-sales", canonicalOliSlices(from, ASOF), ordered);
  const se = frag("returns-leakage:settlements", from, ASOF);
  const ca = frag("returns-leakage:catalog", null, null);
  const planned = [...r.planned, ...oli.planned, se, ca];
  const byHash = new Map([...r.byHash, ...oli.byHash, [se.requestHash, settlements], [ca.requestHash, catalog]]);
  const res = deriveReportSnapshot({ reportKey: "returns-leakage", sources: buildSources(planned, byHash), context: { to: ASOF, rawSellerId: ID, accountId: ID } });
  assert.equal(res.status, "derived");
  // FORMER calculation: the pure builder over the unsplit DESC-ordered rows with the identical route labels
  // (mirrors the derive's own constant wiring; the derive itself pins those constants).
  const RET_WINDOW_DAYS = 60;
  const former = returnsLeakagePayload({
    accountId: ID, asOf: ASOF, from, windowDays: RET_WINDOW_DAYS,
    returnsSourceLabel: "Returns (FBA & FBM)", moneySourceLabel: "Settlements & P&L Components",
    rateSourceLabel: "Order Line Items", rateSourceLagDays: 0, returnHistoryDays: RET_WINDOW_DAYS,
    returnRows: returns, settlementRows: settlements, orderedRows: ordered, catalogRows: catalog,
  });
  assert.deepEqual(res.payload, former, "sliced fragments reproduce the former unsplit payload EXACTLY");
});

/* ============================= 4: GOLDEN request hashes (intentional change) ============================= */

test("GOLDEN: the sliced request windows produce the pinned request_hashes for a fixed synthetic input", () => {
  // Fixed input (PIN_KEY / A1 / asOf 2025-08-10). These hashes CHANGED intentionally with the CANONICAL OLI
  // fragment now carrying the four order dimensions (columns [date, seller_or_vendor_id, sku, child_asin,
  // item_price_currency, amazon_order_status, fulfillment_channel, address_state, address_city], sliced by
  // canonicalOliSlices with DataDoe's verified 5,000-row OLI ceiling) -- pinning the first+last slice locks the
  // corrected identities against silent drift.
  const daily = reportSourceRequestHashes({
    reportKey: "daily-reporting", apiKey: ["PIN", "KEY"].join("_"), ids: ["A1"],
    windowsByRequestKey: {
      "daily-reporting:oli-sales": canonicalOliSlices("2025-03-01", "2025-08-10"),
      "daily-reporting:catalog": [{ from: "2025-03-01", to: "2025-08-10" }],
    }, marketplaceCountry: "US",
  }).filter((s) => s.requestKey === "daily-reporting:oli-sales");
  assert.equal(daily.length, 27, "6 calendar months (Mar..Aug-partial) -> 27 slices");
  assert.deepEqual([daily[0].from, daily[0].to], ["2025-03-01", "2025-03-07"]);
  assert.deepEqual([daily[daily.length - 1].from, daily[daily.length - 1].to], ["2025-08-08", "2025-08-10"]);
  assert.equal(daily[0].requestHash, "c04cc096a47e24b021b6f4fc7ebf0b6fbc2a4e371e42a82cb0617c168a05b045");
  assert.equal(daily[daily.length - 1].requestHash, "37277942f1588f9a572b407206f8a221d07deb30beda164ae9e1c5d76aedf508");
});

/* ============================= 5: malformed-fragment fail-closed matrix ============================= */

test("malformed sliced fragments fail closed (LKG): reordered / duplicate / missing / extra / wrong-window / out-of-slice row / cross-account", () => {
  const from = "2025-03-01", to = ASOF;
  const rows = [{ date: "2025-03-02", seller_or_vendor_id: "S1", child_asin: "A1", total_sales_sum: 1, total_units_sum: 1 }];
  const catalog = [{ child_asin: "A1", product_brand: "Acme" }];
  const context = { brand: "ALL", from, to, rawSellerId: "S1", currency: "USD", accountId: ID };
  const slices = splitDateRangeByMonth(from, to).flatMap((m) => splitDateRangeByDays(m.from, m.to, DERIVE_TIMEOUT_SAFE_SLICE_DAYS));
  const build = (mutate) => {
    const { planned, byHash } = slicedPlanned("daily-reporting:oli-sales", slices, rows, ["S1"]);
    const cat = frag("daily-reporting:catalog", from, to, ["S1"]);
    planned.push(cat); byHash.set(cat.requestHash, catalog);
    mutate(planned, byHash);
    return deriveReportSnapshot({ reportKey: "daily-reporting", sources: buildSources(planned, byHash), context });
  };
  const supersetOf = (planned) => planned.filter((p) => p.requestKey === "daily-reporting:oli-sales");
  // control: untouched sliced plan derives.
  assert.equal(build(() => {}).status, "derived");
  // reordered slices
  let r = build((planned) => { const s = supersetOf(planned); const t = s[0].from; s[0].from = s[1].from; s[1].from = t; });
  assert.equal(r.status, "invalid", "reordered slice sequence rejected");
  // duplicate slice (replace the second with a copy of the first)
  r = build((planned) => { const s = supersetOf(planned); s[1].from = s[0].from; s[1].to = s[0].to; });
  assert.equal(r.status, "invalid", "duplicate slice rejected");
  // missing slice
  r = build((planned) => { const i = planned.findIndex((p) => p.requestKey === "daily-reporting:oli-sales"); planned.splice(i, 1); });
  assert.equal(r.status, "invalid", "missing slice rejected");
  // extra slice
  r = build((planned, byHash) => { const x = frag("daily-reporting:oli-sales", "2025-08-11", "2025-08-11", ["S1"]); planned.push(x); byHash.set(x.requestHash, []); });
  assert.equal(r.status, "invalid", "extra slice rejected");
  // wrong window (first slice shifted)
  r = build((planned) => { supersetOf(planned)[0].to = "2025-03-08"; });
  assert.equal(r.status, "invalid", "wrong slice window rejected");
  // a row OUTSIDE its own slice (even though inside the overall range)
  r = build((planned, byHash) => { const s = supersetOf(planned)[1]; byHash.set(s.requestHash, [{ date: "2025-03-02", seller_or_vendor_id: "S1", child_asin: "A1", total_sales_sum: 9, total_units_sum: 9 }]); });
  assert.equal(r.status, "invalid", "row outside its own fragment window rejected");
  // cross-account fragment
  r = build((planned) => { supersetOf(planned)[0].sellerOrVendorIds = ["S2"]; });
  assert.equal(r.status, "invalid", "cross-account fragment rejected");
});

/* ============================= 6 + 7: resume without duplicates; failure isolation ============================= */

// Minimal in-memory store implementing the exact surface runStagedSourceCycle/runSourceJobs use (the same
// shape the report-returns suite drives the REAL driver with).
function makeMemStore() {
  const cycles = new Map(); const jobsByCycle = new Map(); const ownersByCycle = new Map(); const cache = new Map(); let seq = 0;
  const findCycle = (id) => [...cycles.values()].find((c) => c.id === id) || null;
  return {
    openCycle({ bucket, cycleDate }) { const k = bucket + "|" + cycleDate; if (!cycles.has(k)) { const id = "cyc_" + (seq += 1); cycles.set(k, { id, bucket, status: "pending" }); jobsByCycle.set(id, new Map()); } return cycles.get(k).id; },
    claimCycle(id) { const c = findCycle(id); if (c && c.status === "pending") { c.status = "running"; return true; } return false; },
    getCycle(id) { return findCycle(id); },
    upsertSourceJob(job) { const m = jobsByCycle.get(job.cycleId); if (m.has(job.requestHash)) return; m.set(job.requestHash, { request_hash: job.requestHash, request_key: job.requestKey, source_id: job.sourceId, source_key: job.sourceKey, connection_id: job.connectionId, organization_fingerprint: job.organizationFingerprint, account_scope_hash: job.accountScopeHash, fetch_status: "pending", attempted_at: null, create_export_count: 0, export_id: null, terminal: false, row_count: null }); },
    listSourceJobs(id) { return [...((jobsByCycle.get(id) && jobsByCycle.get(id).values()) || [])].map((j) => ({ ...j })); },
    upsertSourceJobOwners(ms) { for (const m of ms || []) { if (!ownersByCycle.has(m.cycleId)) ownersByCycle.set(m.cycleId, new Map()); ownersByCycle.get(m.cycleId).set(m.ownerId + "|" + m.requestHash, { owner_id: m.ownerId, owner_status: "active" }); } },
    listSourceJobOwners() { return []; },
    recordSourceOwnerStale() {},
    claimExportAttempt(id, h) { const j = jobsByCycle.get(id) && jobsByCycle.get(id).get(h); if (j && j.attempted_at === null) { j.attempted_at = "t"; j.create_export_count += 1; j.fetch_status = "attempted"; return true; } return false; },
    recordExportCreated({ cycleId, requestHash, exportId }) { jobsByCycle.get(cycleId).get(requestHash).export_id = exportId; },
    loadSourceRows(h) { const e = cache.get(h); return e ? { rows: e.rows } : null; },
    saveSourceRows({ job, rows }) { const h = job.request_hash != null ? job.request_hash : job.requestHash; cache.set(h, { rows: [...rows] }); return "p/" + h; },
    recordSourceSuccess({ cycleId, requestHash, exportId, rowCount, cacheObjectPath }) { Object.assign(jobsByCycle.get(cycleId).get(requestHash), { fetch_status: "succeeded", export_id: exportId, row_count: rowCount, cache_object_path: cacheObjectPath }); },
    recordSourceFailure({ cycleId, requestHash, stage, code, terminal }) { Object.assign(jobsByCycle.get(cycleId).get(requestHash), { fetch_status: "failed", error_stage: stage, error_code: code, terminal: !!terminal }); },
    updateCycleCounts() {},
    _jobs: (id) => jobsByCycle.get(id),
  };
}

test("sliced sources resume across bounded invocations with at most ONE create-export per request_hash", async () => {
  const plan = buildShadowReportPlan({ accounts: [{ accountId: ID, country: "US", currency: "USD" }], reportKeys: ["returns-leakage"], connections: CONNS, asOfFor: () => ASOF });
  const sourceJobs = plan.reportRequests.flatMap((req) => req.sources.map((s) => plannedSourceJob(req.reportKey, s, "us", "primary", req.accountId)));
  const store = makeMemStore();
  const dataDoe = { create: async () => ({ exportId: "e", completed: true }), poll: async () => {}, download: async () => [] };
  let res, rounds = 0;
  do {
    res = await runStagedSourceCycle({ store, dataDoe, resolvePlan: () => ({ sourceJobs }), bucket: "us", cycleDate: "2026-01-01", maxJobs: 3 });
    rounds += 1;
    if (rounds > 30) throw new Error("did not drain");
  } while (!res.drained);
  const all = [...store._jobs(res.cycleId).values()];
  assert.equal(all.length, sourceJobs.length, "every planned slice job exists exactly once");
  assert.ok(all.every((j) => j.fetch_status === "succeeded"), "all drained");
  assert.ok(all.every((j) => (j.create_export_count || 0) === 1), "EXACTLY one create-export per request_hash across resumed invocations");
  assert.ok(rounds > 1, "the drain genuinely spanned multiple bounded invocations");
});

test("one failed slice blocks ONLY its own report: the sibling report still derives (failure isolation)", async () => {
  const from = "2025-03-01", to = ASOF;
  const slices = splitDateRangeByMonth(from, to).flatMap((m) => splitDateRangeByDays(m.from, m.to, DERIVE_TIMEOUT_SAFE_SLICE_DAYS));
  const daily = slicedPlanned("daily-reporting:oli-sales", slices, [], ["S1"]);
  const dcat = frag("daily-reporting:catalog", from, to, ["S1"]);
  // brand-sales (sibling) with healthy sources.
  const bsOrders = frag("brand-sales:order-lines", "2024-06-01", to, ["S1"]);
  const bsCat = frag("brand-sales:catalog", "2024-06-01", to, ["S1"]);
  const statusOverride = { [daily.planned[0].requestHash]: "failed" }; // ONE daily slice TIMEOUTed
  const planned = [...daily.planned, dcat, bsOrders, bsCat];
  const byHash = new Map([...daily.byHash, [dcat.requestHash, []],
    [bsOrders.requestHash, [{ date: "2025-08-01", seller_or_vendor_id: "S1", seller_or_vendor_name: "N", marketplace_country_code: "US", item_price_currency: "USD", child_asin: "A1", total_sales_sum: 10, total_units_sold_sum: 1 }]],
    [bsCat.requestHash, [{ child_asin: "A1", product_brand: "Acme" }]]]);
  const sources = buildSources(planned, byHash, statusOverride);
  // Daily: its superset slice failed -> assembler marks the key unavailable -> report-level gate blocks Daily
  // (the fetch gate handles this in the worker; at derive level the missing fragment is invalid/unavailable).
  const dres = deriveReportSnapshot({ reportKey: "daily-reporting", sources, context: { brand: "ALL", from, to, rawSellerId: "S1", currency: "USD", accountId: ID } });
  assert.notEqual(dres.status, "derived", "daily cannot derive with a failed slice");
  assert.equal(dres.payload ?? null, null, "no fabricated daily payload (LKG preserved)");
  // brand-sales: UNAFFECTED -- derives from its own healthy sources.
  const bres = deriveReportSnapshot({ reportKey: "brand-sales", sources, context: { accountId: ID } });
  assert.equal(bres.status, "derived", "the unrelated report still derives after the sibling's slice failure");
});

/* ============================= run ============================= */

async function main() {
  ({ TIMEOUT_SAFE_SLICE_DAYS, planDailyReporting, planReconciliation, planReturnsLeakage, buildShadowReportPlan } = await import("../lib/server/sync/report-planner.js"));
  ({ DERIVE_TIMEOUT_SAFE_SLICE_DAYS, deriveReportSnapshot } = await import("../lib/server/sync/report-derivation.js"));
  ({ assembleSources, runReportJobs } = await import("../lib/server/sync/report-worker.js"));
  ({ reportSourceRequestHashes } = await import("../lib/server/sync/report-source-contracts.js"));
  ({ dailyReportingPayload, reconciliationPayload, returnsLeakagePayload } = await import("../lib/server/reports/derivation-core.js"));
  ({ resolveDailyAdsAvailability } = await import("../lib/server/sync/report-source-contracts.js"));
  ({ splitDateRangeByDays, splitDateRangeByMonth, addDaysStr, canonicalOliSlices } = await import("../lib/server/date-windows.js"));
  ({ plannedSourceJob, runStagedSourceCycle } = await import("../lib/server/sync/source-sync-driver.js"));
  for (const t of tests) {
    try { await t.fn(); passed += 1; out("  ok  " + t.name); }
    catch (e) { out("FAIL  " + t.name); out(String(e && e.stack ? e.stack : e)); process.exitCode = 1; return; }
  }
  out("\n" + passed + " assertions passed");
}
main();
