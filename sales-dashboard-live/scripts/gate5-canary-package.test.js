// Gate 5 canary-package — deterministic OFFLINE executable self-check of the SCHEDULER_V2_ROLLOUT.md Appendix L
// canary guards. It runs the REAL (pure, offline) planBrandSales() to obtain the exact two brand-sales source
// request identities, then asserts every canary guard PASSES on the correct shape and THROWS on each documented
// failure: wrong account/seller scope, shifted or wrong windows, strict:false, wrong source ids, wrong hashes,
// duplicate/missing sources, wrong/missing owner ids, pre-existing shadow rows, extra report jobs/snapshots, a
// final drain without exactly one create-export per hash, and the final-slice deadline boundary. NO network,
// DataDoe, or Supabase I/O -- planBrandSales and sourceJobOwnerId are pure hashing.
//
// Catalog-cache semantics (Codex correction to L.1/L.4): the pre-existing product-catalog source_export_cache
// entry is ADVISORY USABILITY EVIDENCE ONLY -- it is NEVER a source-worker create-export shortcut and NEVER a
// Gate 5 START GATE. A MISSING or EXPIRED catalog cache does NOT block starting the canary (the source worker
// always creates its own fresh catalog export). Export-count semantics (L.3): create_export_count = 0 is a
// mid-drain partial/failed-slice state (a job not yet attempted), never "cache reuse"; a SUCCESSFUL fresh
// drained canary ends with EXACTLY two succeeded source rows (the two plan hashes), each create_export_count
// === 1 -- the authoritative integrity guarantee that a fresh, valid catalog export actually happened.
//
// 7-bit ASCII, LF. Run: node scripts/gate5-canary-package.test.js

import assert from "node:assert/strict";
import { writeSync } from "node:fs";

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };

let planBrandSales, sourceJobOwnerId, addDaysStr, monthStartStr;

// ---- the Appendix L canary guards (pure; mirror the L.5/L.6 inline logic) ----
const norm = (s) => String(s ?? "").trim();

// Exact live source ids (lib/server/source-contracts.js SOURCE_CONTRACTS ids[0]).
const OLI_SOURCE_ID = "89b27535d27c2a94db5ae39af4717f542624ff4df7802fd633e16c78674a1778"; // order-line-items
const CATALOG_SOURCE_ID = "68d2de238e"; // product-catalog (live short id; long id is the obsolete 404 alias)

// Pin every critical plan property INDEPENDENTLY before any run: account, seller scope, exact windows,
// strict, exact source ids, limits, connection, bucket, hashes, org/scope. The primary public account id
// IS the raw seller id (publicAccountId), so sellerOrVendorIds must be exactly [selectedAccountId].
function checkPlanSources(plan, selectedAccountId, asOf) {
  if (!plan || plan.reportKey !== "brand-sales") throw new Error("plan: not brand-sales");
  if (plan.accountId !== selectedAccountId) throw new Error(`plan: accountId ${plan.accountId} != ${selectedAccountId}`);
  const src = plan.sources || [];
  if (src.length !== 2) throw new Error(`plan: expected 2 sources, got ${src.length}`);
  const byKey = new Map(src.map((s) => [s.requestKey, s]));
  if (byKey.size !== 2) throw new Error("plan: duplicate requestKey");
  // BOTH windows must be exactly [addDaysStr(monthStartStr(asOf), -420), asOf] -- the live route window.
  const expFrom = addDaysStr(monthStartStr(asOf), -420);
  const EXPECT = {
    "brand-sales:order-lines": { sourceKey: "order-line-items", sourceId: OLI_SOURCE_ID, limit: 50000 },
    "brand-sales:catalog": { sourceKey: "product-catalog", sourceId: CATALOG_SOURCE_ID, limit: 10000 },
  };
  for (const [rk, exp] of Object.entries(EXPECT)) {
    const s = byKey.get(rk);
    if (!s) throw new Error(`plan: missing source ${rk}`);
    if (s.sourceKey !== exp.sourceKey) throw new Error(`plan: ${rk} sourceKey ${s.sourceKey} != ${exp.sourceKey}`);
    if (s.sourceId !== exp.sourceId) throw new Error(`plan: ${rk} sourceId ${s.sourceId} != ${exp.sourceId}`);
    if (s.limit !== exp.limit) throw new Error(`plan: ${rk} limit ${s.limit} != ${exp.limit}`);
    if (s.connectionId !== "primary") throw new Error(`plan: ${rk} connectionId ${s.connectionId} != primary`);
    if (s.bucket !== plan.bucket) throw new Error(`plan: ${rk} bucket mismatch`);
    if (s.strict !== true) throw new Error(`plan: ${rk} strict ${s.strict} != true`);
    if (!norm(s.requestHash)) throw new Error(`plan: ${rk} missing requestHash`);
    if (!norm(s.organizationFingerprint) || !norm(s.accountScopeHash)) throw new Error(`plan: ${rk} missing org/scope`);
    if (!norm(s.from) || !norm(s.to) || s.from > s.to) throw new Error(`plan: ${rk} invalid window ${s.from}..${s.to}`);
    if (s.from !== expFrom || s.to !== asOf) throw new Error(`plan: ${rk} window ${s.from}..${s.to} != expected ${expFrom}..${asOf}`);
    if (!(Array.isArray(s.sellerOrVendorIds) && s.sellerOrVendorIds.length === 1 && s.sellerOrVendorIds[0] === selectedAccountId)) {
      throw new Error(`plan: ${rk} seller scope != [${selectedAccountId}]`);
    }
  }
  const [a, b] = src;
  if (a.from !== b.from || a.to !== b.to) throw new Error("plan: sources have different windows");
  if (a.organizationFingerprint !== b.organizationFingerprint || a.accountScopeHash !== b.accountScopeHash) throw new Error("plan: sources have different org/scope");
  if (a.requestHash === b.requestHash) throw new Error("plan: the two sources share a request_hash");
  return { orderLines: byKey.get("brand-sales:order-lines"), catalog: byKey.get("brand-sales:catalog") };
}

// Plan-derived owner ids (mirrors L.5 OWNER_IDS): both sources share connection/org/scope, so exactly
// ONE nonblank deterministic owner id must survive the dedupe (sourceJobOwnerId returns null on any
// blank input, so a blank org/scope fails closed here rather than silently widening the owner query).
function ownerIdsOf(plan) {
  return [...new Set((plan.sources || []).map((s) => sourceJobOwnerId({ reportKey: "brand-sales", connectionId: s.connectionId, organizationFingerprint: s.organizationFingerprint, accountScopeHash: s.accountScopeHash })).filter(Boolean))];
}
function checkOwnerIds(ownerIds) {
  if (!Array.isArray(ownerIds) || ownerIds.length !== 1 || !norm(ownerIds[0])) {
    throw new Error(`owner-ids: expected exactly one nonblank plan-derived owner id, got ${JSON.stringify(ownerIds)}`);
  }
  return ownerIds[0];
}

// ADVISORY catalog evidence (Codex correction to L.1/L.4): the pre-existing product-catalog
// source_export_cache entry is USABILITY EVIDENCE ONLY -- never a source-worker shortcut and never a Gate 5
// START GATE. A MISSING or EXPIRED cache (rt.sourceRowLoader returns null for an expired entry, because
// getSourceExportCache filters expires_at > now) must NOT block starting the canary: the source worker ALWAYS
// creates its own fresh catalog export (never skips create-export because a cache exists). This classifies the
// evidence for the record WITHOUT throwing on absent/expired, and NEVER changes what the source worker does.
// Returns "absent" (missing OR expired) | "current-usable" | "current-unusable". The real integrity guarantee
// is the FINAL-DRAIN guard: the fresh catalog export must succeed with create_export_count === 1 and
// non-cap-sized rows, else the run fails closed with no shadow snapshot (checkFinalSourceJobs).
function assessCatalogEvidence(cache, catalogSource) {
  if (!cache) return "absent"; // missing OR expired -- advisory, NON-BLOCKING (Gate 5 starts anyway)
  const rows = cache.rows;
  const usable = cache.source_id === CATALOG_SOURCE_ID
    && Array.isArray(rows) && rows.length === cache.row_count
    && rows.length > 0 && rows.length < catalogSource.limit
    && rows.some((r) => r && norm(r.child_asin) !== "" && norm(r.product_brand) !== "");
  return usable ? "current-usable" : "current-unusable";
}

// Between-slice (mid-drain) guard: identity-pinned rows only; create_export_count 0 means the job has
// NOT been attempted yet in a partial/failed slice (the DB claim increments it to 1 on the one allowed
// attempt) -- it never means "cache reuse". The final-drain guard below requires exactly 1 per hash.
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

// FINAL-DRAIN guard (successful fresh canary + saved shadow snapshot): the pre-existing catalog cache is
// usability evidence only -- the worker never skips create-export because of it -- so the final state is
// EXACTLY two source rows (the two plan hashes), each fetch_status='succeeded' and create_export_count===1.
// A 0-export row here means the job never exported (partial/failed drain), NOT cache reuse: fail closed.
function checkFinalSourceJobs(jobs, plan) {
  checkSliceSourceJobs(jobs, plan);
  requireBothSourcesPresent(jobs, plan);
  const list = jobs || [];
  if (list.length !== 2) throw new Error(`final: expected exactly 2 source jobs, got ${list.length}`);
  for (const j of list) {
    if (j.fetch_status !== "succeeded") throw new Error(`final: fetch_status ${j.fetch_status} != succeeded`);
    const n = j.create_export_count ?? 0;
    if (n !== 1) throw new Error(`final: create_export_count ${n} != 1 for ${String(j.request_hash).slice(0, 12)} (a fresh drained canary creates exactly one export per hash)`);
  }
  return true;
}

function checkOwnerRows(owners, plan, selectedAccountId, expectedOwnerId) {
  const list = owners || [];
  if (list.length !== 2) throw new Error(`owners: expected 2, got ${list.length}`);
  const expect = new Map(plan.sources.map((s) => [s.requestKey, s.requestHash]));
  for (const o of list) {
    if (!norm(o.owner_id) || o.owner_id !== expectedOwnerId) throw new Error(`owners: owner_id ${JSON.stringify(o.owner_id ?? null)} != expected for ${o.request_key}`);
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
const AS_OF = "2026-08-01";
const mkPlan = () => planBrandSales({ accountId: ACCT, country: "US", currency: "USD", connections: [{ id: "primary", apiKey: "canary-test-key" }], asOf: AS_OF });
const goodSourceJob = (s, exp = 1) => ({ id: "j-" + s.requestHash.slice(0, 6), request_hash: s.requestHash, source_id: s.sourceId, source_key: s.sourceKey, connection_id: "primary", organization_fingerprint: s.organizationFingerprint, account_scope_hash: s.accountScopeHash, fetch_status: "succeeded", create_export_count: exp, terminal: false, error_code: null });
const goodOwner = (s) => ({ owner_id: sourceJobOwnerId({ reportKey: "brand-sales", connectionId: "primary", organizationFingerprint: s.organizationFingerprint, accountScopeHash: s.accountScopeHash }), request_hash: s.requestHash, request_key: s.requestKey, report_key: "brand-sales", account_id: ACCT, connection_id: "primary", organization_fingerprint: s.organizationFingerprint, account_scope_hash: s.accountScopeHash, owner_status: "active" });
const goodCatalogCache = (cat, rowCount = 3) => ({ request_hash: cat.requestHash, source_id: CATALOG_SOURCE_ID, object_path: "x", row_count: rowCount, payload_bytes: 10, fetched_at: "t", expires_at: "t", rows: Array.from({ length: rowCount }, (_, i) => ({ child_asin: "B00" + i, product_brand: "Brand" + i })) });

// ================= tests =================

test("(good) the real plan + correct DB rows pass every guard", () => {
  const plan = mkPlan();
  const { orderLines, catalog } = checkPlanSources(plan, ACCT, AS_OF);
  assert.equal(catalog.sourceId, CATALOG_SOURCE_ID);
  assert.equal(orderLines.sourceId, OLI_SOURCE_ID);
  assert.equal(orderLines.sourceKey, "order-line-items");
  const ownerId = checkOwnerIds(ownerIdsOf(plan));
  assert.ok(norm(ownerId));
  assert.equal(assessCatalogEvidence(goodCatalogCache(catalog), catalog), "current-usable"); // advisory only
  const jobs = plan.sources.map((s) => goodSourceJob(s, 1));
  assert.deepEqual(checkSliceSourceJobs(jobs, plan), { total: 2, count: 2 });
  assert.ok(requireBothSourcesPresent(jobs, plan));
  assert.ok(checkFinalSourceJobs(jobs, plan));
  assert.ok(checkOwnerRows(plan.sources.map(goodOwner), plan, ACCT, ownerId));
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
  assert.throws(() => checkPlanSources(dup, ACCT, AS_OF), /duplicate requestKey|missing source brand-sales:catalog/);
  // missing a source (only one)
  assert.throws(() => checkPlanSources({ ...plan, sources: [plan.sources[0]] }, ACCT, AS_OF), /expected 2 sources/);
  // wrong window (from > to)
  const badWin = { ...plan, sources: plan.sources.map((s) => ({ ...s, from: "2027-01-01", to: "2026-01-01" })) };
  assert.throws(() => checkPlanSources(badWin, ACCT, AS_OF), /invalid window/);
  // divergent windows across the two sources
  const splitWin = { ...plan, sources: [plan.sources[0], { ...plan.sources[1], to: "2026-07-31" }] };
  assert.throws(() => checkPlanSources(splitWin, ACCT, AS_OF), /!= expected|different windows/);
  void badHash;
});

test("(plan pinning) wrong account, wrong seller scope, shifted window, strict:false, wrong OLI source id fail closed", () => {
  const plan = mkPlan();
  // the plan's public account id must be the reviewed selected account
  assert.throws(() => checkPlanSources(plan, "B2", AS_OF), /accountId/);
  assert.throws(() => checkPlanSources({ ...plan, accountId: "B2" }, ACCT, AS_OF), /accountId/);
  // wrong seller id (valid shape, wrong account) and a widened multi-id scope
  const wrongSeller = { ...plan, sources: plan.sources.map((s) => ({ ...s, sellerOrVendorIds: ["B2"] })) };
  assert.throws(() => checkPlanSources(wrongSeller, ACCT, AS_OF), /seller scope/);
  const twoSellers = { ...plan, sources: plan.sources.map((s) => ({ ...s, sellerOrVendorIds: [ACCT, "B2"] })) };
  assert.throws(() => checkPlanSources(twoSellers, ACCT, AS_OF), /seller scope/);
  // BOTH sources shifted to the SAME valid-but-wrong window (from<=to, identical across sources) must
  // still fail: the window is pinned to [addDaysStr(monthStartStr(AS_OF), -420), AS_OF] exactly.
  const shifted = { ...plan, sources: plan.sources.map((s) => ({ ...s, from: addDaysStr(s.from, -1), to: addDaysStr(s.to, -1) })) };
  assert.throws(() => checkPlanSources(shifted, ACCT, AS_OF), /!= expected/);
  // strict:false on either source (execution metadata a tampered plan could drop)
  const lax = { ...plan, sources: plan.sources.map((s) => s.requestKey === "brand-sales:order-lines" ? { ...s, strict: false } : s) };
  assert.throws(() => checkPlanSources(lax, ACCT, AS_OF), /strict/);
  // wrong Order Line Items source id (e.g. swapped with the catalog id)
  const badOli = { ...plan, sources: plan.sources.map((s) => s.requestKey === "brand-sales:order-lines" ? { ...s, sourceId: CATALOG_SOURCE_ID } : s) };
  assert.throws(() => checkPlanSources(badOli, ACCT, AS_OF), /sourceId/);
});

test("(catalog evidence is ADVISORY) absent/expired never blocks canary start; a current cache is classified but non-blocking", () => {
  const { catalog } = checkPlanSources(mkPlan(), ACCT, AS_OF);
  // MISSING or EXPIRED (rt.sourceRowLoader returns null for an expired entry) -> "absent"; NEVER throws, never
  // blocks starting Gate 5. The source worker creates its own fresh catalog export regardless.
  assert.equal(assessCatalogEvidence(null, catalog), "absent");
  assert.equal(assessCatalogEvidence(undefined, catalog), "absent");
  // A current, usable cache -> "current-usable" (advisory; does NOT license skipping the fresh export).
  assert.equal(assessCatalogEvidence(goodCatalogCache(catalog, 3), catalog), "current-usable");
  // A present-but-unusable cache is classified "current-unusable" -- recorded, but STILL non-blocking (the
  // canary starts and the fresh export is the authoritative source of the catalog rows).
  assert.equal(assessCatalogEvidence({ ...goodCatalogCache(catalog), source_id: "68d2de238e8d1a47bc56a981a99d54558507b0bafb1e09f1b3e95fb7750a17a8" }, catalog), "current-unusable"); // obsolete long id
  assert.equal(assessCatalogEvidence({ ...goodCatalogCache(catalog, 3), row_count: 4 }, catalog), "current-unusable");   // rows != row_count
  assert.equal(assessCatalogEvidence({ ...goodCatalogCache(catalog, 0), rows: [] }, catalog), "current-unusable");       // empty
  const atLimit = goodCatalogCache(catalog, catalog.limit); atLimit.row_count = catalog.limit;                          // cap-sized
  assert.equal(assessCatalogEvidence(atLimit, catalog), "current-unusable");
  const blank = goodCatalogCache(catalog, 2); blank.rows = [{ child_asin: "", product_brand: "" }, { child_asin: "  ", product_brand: null }];
  assert.equal(assessCatalogEvidence(blank, catalog), "current-unusable");                                              // blank mapping
});

test("(catalog advisory does NOT weaken the run) absent/expired/unusable evidence still requires a real fresh export at final drain", () => {
  const plan = mkPlan();
  const [ol, cat] = plan.sources;
  // Whatever the advisory catalog evidence says, the FINAL-DRAIN guard is unchanged: exactly two succeeded
  // source rows, create_export_count === 1 EACH (a real fresh catalog export), else fail closed.
  for (const evidence of [null, undefined, goodCatalogCache(cat, 3), { ...goodCatalogCache(cat), source_id: "wrong" }]) {
    void assessCatalogEvidence(evidence, cat); // advisory only -- never gates the run
  }
  // success: both hashes exported exactly once
  assert.ok(checkFinalSourceJobs([goodSourceJob(ol, 1), goodSourceJob(cat, 1)], plan));
  // a fresh catalog export that FAILED (not succeeded) -> fail closed, no snapshot
  assert.throws(() => checkFinalSourceJobs([goodSourceJob(ol, 1), { ...goodSourceJob(cat, 1), fetch_status: "failed" }], plan), /succeeded/);
  // a fresh catalog export that was TRUNCATED/cap-sized -> the strict worker marks it failed+terminal, so the
  // final row is not 'succeeded' -> fail closed
  assert.throws(() => checkFinalSourceJobs([goodSourceJob(ol, 1), { ...goodSourceJob(cat, 1), fetch_status: "failed", terminal: true, error_code: "TRUNCATED" }], plan), /succeeded/);
  // the catalog source row MISSING at final drain -> fail closed
  assert.throws(() => checkFinalSourceJobs([goodSourceJob(ol, 1)], plan), /missing source row for brand-sales:catalog/);
  // a catalog row that never exported (create_export_count 0) after a "successful" drain -> fail closed
  assert.throws(() => checkFinalSourceJobs([goodSourceJob(ol, 1), goodSourceJob(cat, 0)], plan), /!= 1/);
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
  // mid-drain PARTIAL slice: a not-yet-attempted job may still show create_export_count 0 (it has not
  // been claimed/exported yet). That is a between-slice state ONLY -- never "cache reuse" -- and the
  // final-drain guard still requires exactly 1 per hash after a successful drain.
  assert.deepEqual(checkSliceSourceJobs([goodSourceJob(ol, 1), goodSourceJob(cat, 0)], plan), { total: 1, count: 2 });
});

test("(final drain) success requires exactly 2 succeeded source jobs, create_export_count === 1 each", () => {
  const plan = mkPlan();
  const [ol, cat] = plan.sources;
  assert.ok(checkFinalSourceJobs([goodSourceJob(ol, 1), goodSourceJob(cat, 1)], plan));
  // only one source row after drain: the catalog job is missing entirely
  assert.throws(() => checkFinalSourceJobs([goodSourceJob(ol, 1)], plan), /missing source row for brand-sales:catalog/);
  // a 0-export row after a "successful" drain means that job never exported (the pre-existing catalog
  // cache is a usability prerequisite, NOT a pre-export shortcut) -- fail closed, never "cache reuse"
  assert.throws(() => checkFinalSourceJobs([goodSourceJob(ol, 1), goodSourceJob(cat, 0)], plan), /!= 1/);
  // a non-succeeded final row (failed/terminal drain) fails closed
  assert.throws(() => checkFinalSourceJobs([goodSourceJob(ol, 1), { ...goodSourceJob(cat, 1), fetch_status: "failed" }], plan), /succeeded/);
});

test("(owner ids) not exactly one nonblank plan-derived owner id fails closed", () => {
  const plan = mkPlan();
  const ownerId = checkOwnerIds(ownerIdsOf(plan));
  assert.ok(norm(ownerId));
  // blank org fingerprint -> sourceJobOwnerId returns null -> NO owner id survives -> fail closed
  assert.throws(() => checkOwnerIds(ownerIdsOf({ sources: plan.sources.map((s) => ({ ...s, organizationFingerprint: "" })) })), /exactly one nonblank/);
  // blank scope hash -> same fail-closed path
  assert.throws(() => checkOwnerIds(ownerIdsOf({ sources: plan.sources.map((s) => ({ ...s, accountScopeHash: "" })) })), /exactly one nonblank/);
  // divergent org across the two sources -> TWO distinct owner ids -> fail closed
  assert.throws(() => checkOwnerIds(ownerIdsOf({ sources: [plan.sources[0], { ...plan.sources[1], organizationFingerprint: "other" }] })), /exactly one nonblank/);
});

test("(owners) count, owner_id, mapping, status, account, connection fail closed", () => {
  const plan = mkPlan();
  const ownerId = checkOwnerIds(ownerIdsOf(plan));
  const [ol, cat] = plan.sources;
  assert.throws(() => checkOwnerRows([goodOwner(ol)], plan, ACCT, ownerId), /expected 2/);
  // wrong owner_id on a membership row (not the plan-derived deterministic owner)
  assert.throws(() => checkOwnerRows([{ ...goodOwner(ol), owner_id: "deadbeef" }, goodOwner(cat)], plan, ACCT, ownerId), /owner_id/);
  // missing/blank owner_id
  assert.throws(() => checkOwnerRows([{ ...goodOwner(ol), owner_id: "" }, goodOwner(cat)], plan, ACCT, ownerId), /owner_id/);
  assert.throws(() => checkOwnerRows([{ ...goodOwner(ol), owner_id: null }, goodOwner(cat)], plan, ACCT, ownerId), /owner_id/);
  // swapped request_key -> request_hash mapping
  const swapped = [{ ...goodOwner(ol), request_hash: cat.requestHash }, { ...goodOwner(cat), request_hash: ol.requestHash }];
  assert.throws(() => checkOwnerRows(swapped, plan, ACCT, ownerId), /mapping mismatch/);
  assert.throws(() => checkOwnerRows([{ ...goodOwner(ol), owner_status: "stale" }, goodOwner(cat)], plan, ACCT, ownerId), /not active/);
  assert.throws(() => checkOwnerRows([{ ...goodOwner(ol), account_id: "B2" }, goodOwner(cat)], plan, ACCT, ownerId), /account_id/);
  assert.throws(() => checkOwnerRows([{ ...goodOwner(ol), connection_id: "dd-secondary" }, goodOwner(cat)], plan, ACCT, ownerId), /connection_id/);
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
  ({ addDaysStr, monthStartStr } = await import("../lib/server/date-windows.js"));
  for (const t of tests) {
    try { await t.fn(); passed += 1; out("  ok  " + t.name); }
    catch (e) { out("FAIL  " + t.name); out(String(e && e.stack ? e.stack : e)); process.exitCode = 1; return; }
  }
  out("\n" + passed + " assertions passed");
}

main();
