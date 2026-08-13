// Gate 5 canary-package — deterministic OFFLINE executable self-check of the SCHEDULER_V2_ROLLOUT.md Appendix L
// canary guards. It runs the REAL (pure, offline) planBrandSales() to obtain the exact two brand-sales source
// request identities, then asserts every canary guard PASSES on the correct shape and THROWS on each documented
// failure: wrong hashes, wrong windows, duplicate/missing sources, stale/absent catalog cache, pre-existing
// shadow rows, extra report jobs/snapshots, and the final-slice deadline boundary. NO network, DataDoe, or
// Supabase I/O -- planBrandSales and sourceJobOwnerId are pure hashing.
//
// 7-bit ASCII, LF. Run: node scripts/gate5-canary-package.test.js

import assert from "node:assert/strict";
import { writeSync } from "node:fs";

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };

let planBrandSales, sourceJobOwnerId;

// ---- the Appendix L canary guards (pure; mirror the L.5/L.6 inline logic) ----
const norm = (s) => String(s ?? "").trim();

function checkPlanSources(plan) {
  if (!plan || plan.reportKey !== "brand-sales") throw new Error("plan: not brand-sales");
  const src = plan.sources || [];
  if (src.length !== 2) throw new Error(`plan: expected 2 sources, got ${src.length}`);
  const byKey = new Map(src.map((s) => [s.requestKey, s]));
  if (byKey.size !== 2) throw new Error("plan: duplicate requestKey");
  const EXPECT = {
    "brand-sales:order-lines": { sourceKey: "order-line-items", limit: 50000 },
    "brand-sales:catalog": { sourceKey: "product-catalog", sourceId: "68d2de238e", limit: 10000 },
  };
  for (const [rk, exp] of Object.entries(EXPECT)) {
    const s = byKey.get(rk);
    if (!s) throw new Error(`plan: missing source ${rk}`);
    if (s.sourceKey !== exp.sourceKey) throw new Error(`plan: ${rk} sourceKey ${s.sourceKey} != ${exp.sourceKey}`);
    if (exp.sourceId && s.sourceId !== exp.sourceId) throw new Error(`plan: ${rk} sourceId ${s.sourceId} != ${exp.sourceId}`);
    if (s.limit !== exp.limit) throw new Error(`plan: ${rk} limit ${s.limit} != ${exp.limit}`);
    if (s.connectionId !== "primary") throw new Error(`plan: ${rk} connectionId ${s.connectionId} != primary`);
    if (s.bucket !== plan.bucket) throw new Error(`plan: ${rk} bucket mismatch`);
    if (!norm(s.requestHash)) throw new Error(`plan: ${rk} missing requestHash`);
    if (!norm(s.organizationFingerprint) || !norm(s.accountScopeHash)) throw new Error(`plan: ${rk} missing org/scope`);
    if (!norm(s.from) || !norm(s.to) || s.from > s.to) throw new Error(`plan: ${rk} invalid window ${s.from}..${s.to}`);
    if (!(Array.isArray(s.sellerOrVendorIds) && s.sellerOrVendorIds.length === 1)) throw new Error(`plan: ${rk} seller scope not single`);
  }
  const [a, b] = src;
  if (a.from !== b.from || a.to !== b.to) throw new Error("plan: sources have different windows");
  if (a.organizationFingerprint !== b.organizationFingerprint || a.accountScopeHash !== b.accountScopeHash) throw new Error("plan: sources have different org/scope");
  if (a.requestHash === b.requestHash) throw new Error("plan: the two sources share a request_hash");
  return { orderLines: byKey.get("brand-sales:order-lines"), catalog: byKey.get("brand-sales:catalog") };
}

function checkCatalogCache(cache, catalogSource) {
  if (!cache) throw new Error("catalog: no current source_export_cache entry for the exact request (stale/absent)");
  if (cache.source_id !== "68d2de238e") throw new Error(`catalog: source_id ${cache.source_id} != 68d2de238e`);
  const rows = cache.rows;
  if (!Array.isArray(rows)) throw new Error("catalog: no rows");
  if (rows.length !== cache.row_count) throw new Error(`catalog: rows.length ${rows.length} != row_count ${cache.row_count}`);
  if (!(rows.length > 0 && rows.length < catalogSource.limit)) throw new Error(`catalog: rows.length ${rows.length} not in (0, ${catalogSource.limit})`);
  const usable = rows.some((r) => r && norm(r.child_asin) !== "" && norm(r.product_brand) !== "");
  if (!usable) throw new Error("catalog: no non-blank child_asin/product_brand mapping");
  return true;
}

function checkSliceSourceJobs(jobs, plan) {
  const expectByHash = new Map(plan.sources.map((s) => [s.requestHash, s]));
  const list = jobs || [];
  if (list.length > 2) throw new Error(`slice: >2 canonical source jobs (${list.length})`);
  let total = 0; const seen = new Set();
  for (const j of list) {
    const exp = expectByHash.get(j.request_hash);
    if (!exp) throw new Error(`slice: unexpected request_hash ${String(j.request_hash).slice(0, 12)}`);
    if (seen.has(j.request_hash)) throw new Error("slice: duplicate source row for a request_hash");
    seen.add(j.request_hash);
    if (j.source_key !== exp.sourceKey) throw new Error(`slice: source_key ${j.source_key} != ${exp.sourceKey}`);
    if (j.source_id !== exp.sourceId) throw new Error(`slice: source_id mismatch for ${exp.requestKey}`);
    if (j.connection_id !== "primary") throw new Error(`slice: connection_id ${j.connection_id} != primary`);
    if (j.organization_fingerprint !== exp.organizationFingerprint) throw new Error("slice: organization_fingerprint mismatch");
    if (j.account_scope_hash !== exp.accountScopeHash) throw new Error("slice: account_scope_hash mismatch");
    const n = j.create_export_count ?? 0;
    if (n !== 0 && n !== 1) throw new Error(`slice: create_export_count ${n} not in {0,1}`);
    total += n;
  }
  if (total > 2) throw new Error(`slice: total create-exports ${total} > 2`);
  return { total, count: list.length };
}

function requireBothSourcesPresent(jobs, plan) {
  const hashes = new Set((jobs || []).map((j) => j.request_hash));
  for (const s of plan.sources) if (!hashes.has(s.requestHash)) throw new Error(`final: missing source row for ${s.requestKey}`);
  return true;
}

function checkOwnerRows(owners, plan, selectedAccountId) {
  const list = owners || [];
  if (list.length !== 2) throw new Error(`owners: expected 2, got ${list.length}`);
  const expect = new Map(plan.sources.map((s) => [s.requestKey, s.requestHash]));
  for (const o of list) {
    if (o.owner_status !== "active") throw new Error(`owners: ${o.request_key} not active`);
    if (o.report_key !== "brand-sales") throw new Error(`owners: report_key ${o.report_key}`);
    if (o.account_id !== selectedAccountId) throw new Error(`owners: account_id ${o.account_id}`);
    if (o.connection_id !== "primary") throw new Error(`owners: connection_id ${o.connection_id}`);
    const exph = expect.get(o.request_key);
    if (!exph) throw new Error(`owners: unexpected request_key ${o.request_key}`);
    if (o.request_hash !== exph) throw new Error(`owners: request_key/hash mapping mismatch for ${o.request_key}`);
    expect.delete(o.request_key);
  }
  if (expect.size !== 0) throw new Error("owners: missing a request_key mapping");
  return true;
}

function checkShadowBefore(globalShadowCount) {
  if (globalShadowCount !== 0) throw new Error(`pre: expected 0 scheduler-v2/* snapshots, got ${globalShadowCount}`);
  return true;
}
function checkShadowAfter(globalShadowRows, selectedAccountId) {
  const list = globalShadowRows || [];
  if (list.length !== 1) throw new Error(`post: expected exactly 1 scheduler-v2/* snapshot globally, got ${list.length}`);
  const r = list[0];
  if (r.report_key !== "scheduler-v2/brand-sales") throw new Error(`post: snapshot report_key ${r.report_key}`);
  if (r.account_id !== selectedAccountId) throw new Error(`post: snapshot account_id ${r.account_id}`);
  return true;
}
function checkReportJob(reportRows, plan, selectedAccountId) {
  const list = reportRows || [];
  if (list.length !== 1) throw new Error(`report: expected exactly 1 report job, got ${list.length}`);
  const r = list[0];
  if (r.report_key !== "brand-sales") throw new Error(`report: report_key ${r.report_key}`);
  if (r.account_id !== selectedAccountId) throw new Error(`report: account_id ${r.account_id}`);
  if (r.connection_id !== "primary") throw new Error(`report: connection_id ${r.connection_id}`);
  const dep = Array.isArray(r.depends_on) ? [...r.depends_on].sort() : null;
  const want = plan.sources.map((s) => s.requestHash).sort();
  if (!dep || dep.length !== want.length || dep.some((h, i) => h !== want[i])) throw new Error("report: depends_on != the two expected hashes");
  return true;
}
// per-slice deadline clamped to the overall deadline; stop before a slice when < reserveMs remains
function sliceDeadline(now, overallDeadlineMs) { return Math.min(now + 90_000, overallDeadlineMs); }
function shouldStopBeforeSlice(now, overallDeadlineMs, reserveMs) { return (overallDeadlineMs - now) < reserveMs; }

// ---- fixtures built from the REAL plan ----
const ACCT = "A1";
const mkPlan = () => planBrandSales({ accountId: ACCT, country: "US", currency: "USD", connections: [{ id: "primary", apiKey: "canary-test-key" }], asOf: "2026-08-01" });
const goodSourceJob = (s, exp = 1) => ({ id: "j-" + s.requestHash.slice(0, 6), request_hash: s.requestHash, source_id: s.sourceId, source_key: s.sourceKey, connection_id: "primary", organization_fingerprint: s.organizationFingerprint, account_scope_hash: s.accountScopeHash, fetch_status: "succeeded", create_export_count: exp, terminal: false, error_code: null });
const goodOwner = (s) => ({ owner_id: "o1", request_hash: s.requestHash, request_key: s.requestKey, report_key: "brand-sales", account_id: ACCT, connection_id: "primary", organization_fingerprint: s.organizationFingerprint, account_scope_hash: s.accountScopeHash, owner_status: "active" });
const goodCatalogCache = (cat, rowCount = 3) => ({ request_hash: cat.requestHash, source_id: "68d2de238e", object_path: "x", row_count: rowCount, payload_bytes: 10, fetched_at: "t", expires_at: "t", rows: Array.from({ length: rowCount }, (_, i) => ({ child_asin: "B00" + i, product_brand: "Brand" + i })) });

// ================= tests =================

test("(good) the real plan + correct DB rows pass every guard", () => {
  const plan = mkPlan();
  const { orderLines, catalog } = checkPlanSources(plan);
  assert.equal(catalog.sourceId, "68d2de238e");
  assert.equal(orderLines.sourceKey, "order-line-items");
  assert.ok(checkCatalogCache(goodCatalogCache(catalog), catalog));
  const jobs = plan.sources.map((s) => goodSourceJob(s, 1));
  assert.deepEqual(checkSliceSourceJobs(jobs, plan), { total: 2, count: 2 });
  assert.ok(requireBothSourcesPresent(jobs, plan));
  assert.ok(checkOwnerRows(plan.sources.map(goodOwner), plan, ACCT));
  assert.ok(checkShadowBefore(0));
  assert.ok(checkShadowAfter([{ report_key: "scheduler-v2/brand-sales", account_id: ACCT }], ACCT));
  assert.ok(checkReportJob([{ report_key: "brand-sales", account_id: ACCT, connection_id: "primary", depends_on: plan.sources.map((s) => s.requestHash) }], plan, ACCT));
});

test("(plan) wrong/duplicate/missing sources and wrong window fail closed", () => {
  const plan = mkPlan();
  // wrong catalog hash (a tampered request identity)
  const badHash = { ...plan, sources: plan.sources.map((s) => s.requestKey === "brand-sales:catalog" ? { ...s, requestHash: "deadbeef" } : s) };
  // checkPlanSources itself still passes (hash present); but the slice guard must reject a DB row carrying a
  // request_hash that is NOT one of the plan-derived hashes:
  assert.throws(() => checkSliceSourceJobs([goodSourceJob({ ...plan.sources[1], requestHash: "deadbeef" }, 1)], plan), /unexpected request_hash/);
  // duplicate source (two order-lines, no catalog)
  const dup = { ...plan, sources: [plan.sources[0], { ...plan.sources[0] }] };
  assert.throws(() => checkPlanSources(dup), /duplicate requestKey|missing source brand-sales:catalog/);
  // missing a source (only one)
  assert.throws(() => checkPlanSources({ ...plan, sources: [plan.sources[0]] }), /expected 2 sources/);
  // wrong window (from > to)
  const badWin = { ...plan, sources: plan.sources.map((s) => ({ ...s, from: "2027-01-01", to: "2026-01-01" })) };
  assert.throws(() => checkPlanSources(badWin), /invalid window/);
  // divergent windows across the two sources
  const splitWin = { ...plan, sources: [plan.sources[0], { ...plan.sources[1], to: "2026-07-31" }] };
  assert.throws(() => checkPlanSources(splitWin), /different windows/);
  void badHash;
});

test("(catalog cache) stale/absent, wrong id, count/limit, and blank-mapping all fail closed", () => {
  const { catalog } = checkPlanSources(mkPlan());
  assert.throws(() => checkCatalogCache(null, catalog), /stale\/absent|no current/);            // stale/absent
  assert.throws(() => checkCatalogCache({ ...goodCatalogCache(catalog), source_id: "68d2de238e8d1a47bc56a981a99d54558507b0bafb1e09f1b3e95fb7750a17a8" }, catalog), /source_id/);  // obsolete long id
  assert.throws(() => checkCatalogCache({ ...goodCatalogCache(catalog, 3), row_count: 4 }, catalog), /row_count/);   // rows != row_count
  assert.throws(() => checkCatalogCache({ ...goodCatalogCache(catalog, 0), rows: [] }, catalog), /not in \(0/);      // empty
  const atLimit = goodCatalogCache(catalog, catalog.limit); atLimit.row_count = catalog.limit; // rows.length == limit
  assert.throws(() => checkCatalogCache(atLimit, catalog), /not in \(0/);
  const blank = goodCatalogCache(catalog, 2); blank.rows = [{ child_asin: "", product_brand: "" }, { child_asin: "  ", product_brand: null }];
  assert.throws(() => checkCatalogCache(blank, catalog), /non-blank/);
});

test("(slice) wrong hash/key/id/connection/org/scope, dup, >2 rows, and export>1 fail closed", () => {
  const plan = mkPlan();
  const [ol, cat] = plan.sources;
  assert.throws(() => checkSliceSourceJobs([{ ...goodSourceJob(ol), source_key: "product-catalog" }], plan), /source_key/);
  assert.throws(() => checkSliceSourceJobs([{ ...goodSourceJob(ol), source_id: "wrong" }], plan), /source_id mismatch/);
  assert.throws(() => checkSliceSourceJobs([{ ...goodSourceJob(ol), connection_id: "dd-secondary" }], plan), /connection_id/);
  assert.throws(() => checkSliceSourceJobs([{ ...goodSourceJob(ol), organization_fingerprint: "x" }], plan), /organization_fingerprint/);
  assert.throws(() => checkSliceSourceJobs([{ ...goodSourceJob(ol), account_scope_hash: "x" }], plan), /account_scope_hash/);
  assert.throws(() => checkSliceSourceJobs([goodSourceJob(ol, 2)], plan), /not in \{0,1\}/);               // export > 1
  assert.throws(() => checkSliceSourceJobs([goodSourceJob(ol), goodSourceJob(ol)], plan), /duplicate source row/);
  assert.throws(() => checkSliceSourceJobs([goodSourceJob(ol), goodSourceJob(cat), goodSourceJob(cat)], plan), />2 canonical source jobs/);
  // final-drain completeness: only one source present
  assert.throws(() => requireBothSourcesPresent([goodSourceJob(ol)], plan), /missing source row for brand-sales:catalog/);
  // cached source (export 0) is allowed (< 2 total)
  assert.deepEqual(checkSliceSourceJobs([goodSourceJob(ol, 1), goodSourceJob(cat, 0)], plan), { total: 1, count: 2 });
});

test("(owners) count, mapping, status, account, connection fail closed", () => {
  const plan = mkPlan();
  const [ol, cat] = plan.sources;
  assert.throws(() => checkOwnerRows([goodOwner(ol)], plan, ACCT), /expected 2/);
  // swapped request_key -> request_hash mapping
  const swapped = [{ ...goodOwner(ol), request_hash: cat.requestHash }, { ...goodOwner(cat), request_hash: ol.requestHash }];
  assert.throws(() => checkOwnerRows(swapped, plan, ACCT), /mapping mismatch/);
  assert.throws(() => checkOwnerRows([{ ...goodOwner(ol), owner_status: "stale" }, goodOwner(cat)], plan, ACCT), /not active/);
  assert.throws(() => checkOwnerRows([{ ...goodOwner(ol), account_id: "B2" }, goodOwner(cat)], plan, ACCT), /account_id/);
  assert.throws(() => checkOwnerRows([{ ...goodOwner(ol), connection_id: "dd-secondary" }, goodOwner(cat)], plan, ACCT), /connection_id/);
});

test("(shadow + report job) pre-existing shadow, extra/missing snapshot, extra/mis-scoped report job fail closed", () => {
  const plan = mkPlan();
  assert.throws(() => checkShadowBefore(1), /expected 0 scheduler-v2/);                                    // pre-existing shadow rows
  assert.throws(() => checkShadowAfter([], ACCT), /exactly 1/);                                             // missing shadow snapshot
  assert.throws(() => checkShadowAfter([{ report_key: "scheduler-v2/brand-sales", account_id: ACCT }, { report_key: "scheduler-v2/brand-sales", account_id: "B2" }], ACCT), /exactly 1/);  // extra snapshot
  assert.throws(() => checkShadowAfter([{ report_key: "brand-sales", account_id: ACCT }], ACCT), /report_key/);  // not the shadow key
  const dep = plan.sources.map((s) => s.requestHash);
  assert.throws(() => checkReportJob([{ report_key: "brand-sales", account_id: ACCT, connection_id: "primary", depends_on: dep }, { report_key: "brand-sales", account_id: ACCT, connection_id: "primary", depends_on: dep }], plan, ACCT), /exactly 1 report job/);  // extra report job
  assert.throws(() => checkReportJob([{ report_key: "brand-sales", account_id: ACCT, connection_id: "primary", depends_on: [dep[0]] }], plan, ACCT), /depends_on/);          // missing a dep hash
  assert.throws(() => checkReportJob([{ report_key: "brand-sales", account_id: ACCT, connection_id: "primary", depends_on: [...dep, "extra"] }], plan, ACCT), /depends_on/); // extra dep hash
  assert.throws(() => checkReportJob([{ report_key: "brand-sales", account_id: ACCT, connection_id: "dd-secondary", depends_on: dep }], plan, ACCT), /connection_id/);       // wrong connection
});

test("(deadline boundary) slice deadline clamps to overall; stop before slice under reserve", () => {
  const now = 1_000_000;
  const reserveMs = 5_000;
  // plenty of overall budget -> slice deadline is the 90s window (not clamped)
  assert.equal(sliceDeadline(now, now + 15 * 60_000), now + 90_000);
  // little overall budget -> slice deadline is CLAMPED to the overall deadline
  assert.equal(sliceDeadline(now, now + 30_000), now + 30_000);
  // exactly reserveMs remaining -> stop (not enough to start a slice)
  assert.equal(shouldStopBeforeSlice(now, now + reserveMs - 1, reserveMs), true);
  assert.equal(shouldStopBeforeSlice(now, now + reserveMs, reserveMs), false);
  assert.equal(shouldStopBeforeSlice(now, now + reserveMs + 1, reserveMs), false);
  // overall already exhausted -> stop
  assert.equal(shouldStopBeforeSlice(now, now - 1, reserveMs), true);
});

async function main() {
  ({ planBrandSales } = await import("../lib/server/sync/report-planner.js"));
  ({ sourceJobOwnerId } = await import("../lib/server/source-identity.js"));
  void sourceJobOwnerId;
  for (const t of tests) {
    try { await t.fn(); passed += 1; out("  ok  " + t.name); }
    catch (e) { out("FAIL  " + t.name); out(String(e && e.stack ? e.stack : e)); process.exitCode = 1; return; }
  }
  out("\n" + passed + " assertions passed");
}

main();
