// Scheduler v2 -- reconcile-and-adopt for AMBIGUOUS OLI create-exports. Deterministic OFFLINE tests.
//
// Proves the network-behavior rule 4 contract ("after an ambiguous create, list/reconcile exact exports and
// adopt only an exact identity -- never a blind retry") for lib/server/sync/source-create-reconcile.js:
//   - matchExportForFailedCreate adopts ONLY an exactly-one COMPLETED exact-identity match (source, date-only
//     window, order-independent seller set); zero matches -> none; multiple -> ambiguous; fail closed on any
//     missing identity input;
//   - reconcileEligibility gates the exact ambiguous-create shape (typed failed, non-terminal, create-export
//     stage, exactly one attempted create, NO saved export id); each disqualifier refuses;
//   - reconcileFailedCreates NEVER creates an export (zero create POSTs on success AND failure paths), adopts
//     via the precondition-guarded write exactly once, refuses typed on no-planned-identity / window mismatch /
//     none / ambiguous / adopt-write-refused, and a completed reconciliation is IDEMPOTENT (re-run finds zero
//     eligible jobs);
//   - the RE-PLANNED canonical jobs (the REAL planner) supply the seller identity -- never a request body.
//
// 7-bit ASCII, LF, no top-level await, synchronous writeSync progress, dynamic imports after a dummy env.

import assert from "node:assert/strict";
import { writeSync } from "node:fs";

// Set BEFORE importing supabase.js (module reads these at load).
process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://supabase.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ["test", "svc", "role", "key"].join("-");
process.env.DATADOE_API_KEY = process.env.DATADOE_API_KEY || "dd_api_test";

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const group = (label) => tests.push({ marker: label });
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };

let worker; // source-worker.js (recoveryEligibility for the store CAS double)
let rec; // source-create-reconcile.js (the module under test)
let bucketSync; // source-bucket-sync.js (the REAL planner)

const EXPORT_ID = "exp-adopt-1"; // only used to drive the fakes; the code under test never prints it

// The REAL production shape, built by the canonical planBucketSourceSync: a five-seller, seller-scoped OLI
// batch. Computed once (after imports) for the EXACT fixed target window 2025-08-10..2026-03-17. NO synthetic
// meta: the matcher + reconciliation drive off this real plan (the same re-plan the operator performs).
const NU_ACCOUNTS = ["S1", "S2", "S3", "S4", "S5"].map((s, i) => ({ accountId: "NU-ACC-" + i, rawSellerId: s, country: "GB" }));
let REAL = null;
function realPlan() {
  if (REAL) return REAL;
  const plan = bucketSync.planBucketSourceSync({
    apiKey: "op-test-key", bucket: "non-us", accounts: NU_ACCOUNTS, coverageByAccountId: {},
    catalogSnapshot: { validated_at: "2026-08-21T01:00:00Z" }, fbaSnapshotsByAccount: {},
    asOf: "2026-08-21", today: "2026-08-21",
  });
  const oli = plan.families.find((f) => f.sourceKey === "order-line-items");
  const unit = oli.units.find((u) => u.slice.from === "2025-08-10" && u.slice.to === "2026-03-17");
  if (!unit) throw new Error("real-plan fixture: expected an OLI unit over 2025-08-10..2026-03-17");
  const plannedForHash = oli.plannedJobs.filter((p) => p.requestHash === unit.requestHash);
  REAL = { oli, unit, targetHash: unit.requestHash, plannedOliJobs: oli.plannedJobs, meta: plannedForHash[0], sellers: [...unit.sellerOrVendorIds], sourceId: plannedForHash[0].sourceId };
  return REAL;
}
const okRow = (sid) => ({ date: "2026-01-01", seller_or_vendor_id: sid, sku: "SKU-A", child_asin: "B0A", item_price_currency: "USD", total_sales_sum: 10, total_units_sum: 1 });
const okPayload5 = () => realPlan().sellers.map(okRow);

// A FAILED source-job row in the exact AMBIGUOUS-CREATE shape (typed create-stage failure, NO export id) for
// the real planned hash. Override fields to make it ineligible.
const failedCreateRow = (over = {}) => ({
  request_hash: realPlan().targetHash, request_key: realPlan().meta.requestKey,
  source_id: realPlan().sourceId, source_key: "order-line-items",
  connection_id: "primary", organization_fingerprint: realPlan().meta.organizationFingerprint,
  account_scope_hash: realPlan().meta.accountScopeHash,
  fetch_status: "failed", terminal: false, error_stage: "create-export", error_code: "HTTP_503",
  create_export_count: 1, export_id: null, attempted_at: "t", row_count: null, cache_object_path: null,
  request_meta: { from: "2025-08-10", to: "2026-03-17" },
  ...over,
});

// A COMPLETED DataDoe export record with the EXACT identity of the planned batch (override to mismatch).
const exportRec = (over = {}) => ({
  id: EXPORT_ID, status: "COMPLETED", sourceId: realPlan().sourceId,
  from: "2025-08-10", to: "2026-03-17", sellerOrVendorIds: [...realPlan().sellers],
  ...over,
});

// ---- in-memory source store (the same model as the download-recovery suite: atomic CAS + save/success) ----
function makeStore() {
  const cycles = new Map();
  const jobsByCycle = new Map();
  const cache = new Map();
  let seq = 0;
  const jmap = (cid) => jobsByCycle.get(cid);
  const raw = (cid, hash) => jmap(cid) && jmap(cid).get(hash);
  const ensureCycle = (cid) => { if (!jobsByCycle.has(cid)) { cycles.set("seed|" + cid, { id: cid, bucket: "non-us", status: "running" }); jobsByCycle.set(cid, new Map()); } };
  return {
    _cache: cache,
    _raw: raw,
    _seedJob: (cid, hash, row) => { ensureCycle(cid); jmap(cid).set(hash, { ...row, request_hash: hash }); },
    openCycle({ bucket, cycleDate }) {
      const key = bucket + "|" + cycleDate;
      if (!cycles.has(key)) { const id = "cyc_" + (seq += 1); cycles.set(key, { id, bucket, cycle_date: cycleDate, status: "running" }); jobsByCycle.set(id, new Map()); }
      return cycles.get(key).id;
    },
    listSourceJobsWithMeta(id) { return [...((jmap(id) && jmap(id).values()) || [])].map((j) => ({ ...j })); },
    async claimSourceExportRecovery({ cycleId, requestHash, expectedExportId }) {
      if (typeof expectedExportId !== "string" || expectedExportId === "" || expectedExportId !== expectedExportId.trim()) return null;
      const j = raw(cycleId, requestHash);
      if (!j) return "not-eligible";
      const e = worker.recoveryEligibility(j);
      if (!e.eligible) return "not-eligible";
      if (e.exportId !== expectedExportId) return "not-eligible";
      j.fetch_status = "attempted";
      return "claimed";
    },
    loadSourceRows(hash) { const e = cache.get(hash); return e ? { rows: e.rows, object_path: e.object_path } : null; },
    saveSourceRows({ job, rows, version }) {
      const hash = job.request_hash != null ? job.request_hash : job.requestHash;
      const path = "source-cache/v2/" + hash + "/" + version + ".json";
      cache.set(hash, { rows: [...rows], object_path: path });
      return path;
    },
    recordSourceSuccess({ cycleId, requestHash, exportId, rowCount, cacheObjectPath }) {
      Object.assign(raw(cycleId, requestHash), { fetch_status: "succeeded", export_id: exportId, row_count: rowCount, cache_object_path: cacheObjectPath, terminal: false, error_stage: null, error_code: null });
    },
    recordSourceFailure({ cycleId, requestHash, stage, code, message, terminal, rowCount, exportId }) {
      const j = raw(cycleId, requestHash);
      Object.assign(j, { fetch_status: "failed", error_stage: stage, error_code: code, error_message: message, terminal: !!terminal });
      if (rowCount != null) j.row_count = rowCount;
      if (exportId != null) j.export_id = exportId;
    },
    updateCycleCounts() { /* not asserted */ },
  };
}

// DataDoe double: counts create/poll/download. A create call is the HARD failure signal (reconciliation must
// NEVER create -- the module additionally guards create off before handing the adapter to the recovery).
function makeDataDoe(downloadFor) {
  const counts = { create: 0, poll: 0, download: 0 };
  return {
    counts,
    async create() { counts.create += 1; throw new Error("RECONCILE MUST NOT CREATE"); },
    async poll() { counts.poll += 1; },
    async download(job) { counts.download += 1; return downloadFor(job); },
  };
}

// The PRODUCTION adoption-write double: the same preconditions as the guarded UPDATE (failed + non-terminal +
// create-stage + export_id NULL for this exact cycle/hash), flipping the row into the download-recovery shape.
const makeAdopt = (store, spy = { calls: 0 }) => Object.assign(async ({ cycleId, requestHash, exportId }) => {
  spy.calls += 1;
  const j = store._raw(cycleId, requestHash);
  if (!j || j.fetch_status !== "failed" || j.terminal === true || j.error_stage !== "create-export" || j.export_id != null) return false;
  Object.assign(j, { export_id: exportId, error_stage: "download", error_code: "CREATE_RECONCILED" });
  return true;
}, { spy });

const noDeadline = (fn) => fn();
const seededCycle = (store) => store.openCycle({ bucket: "non-us", cycleDate: "2026-08-25" });
const runReconcile = ({ store, cid, dataDoe, exportsList, adopt, planned }) => rec.reconcileFailedCreates({
  cycleId: cid, store, dataDoe,
  plannedOliJobs: planned || realPlan().plannedOliJobs,
  listExports: async () => exportsList,
  adoptExportId: adopt,
  oliSourceId: realPlan().sourceId,
  runWithDeadline: noDeadline, clock: () => 1000,
});

/* ================================= A. matchExportForFailedCreate (pure) ================================= */
group("A. matchExportForFailedCreate -- exactly-one EXACT identity or nothing");

test("A1. exactly one COMPLETED exact-identity match -> adopt with its export id", () => {
  const m = rec.matchExportForFailedCreate({ windowFrom: "2025-08-10", windowTo: "2026-03-17", sellerIds: realPlan().sellers, exports: [exportRec()], oliSourceId: realPlan().sourceId });
  assert.deepEqual(m, { disposition: "adopt", exportId: EXPORT_ID });
});

test("A2. every identity mismatch -> none (status, source, window, seller set)", () => {
  const base = { windowFrom: "2025-08-10", windowTo: "2026-03-17", sellerIds: realPlan().sellers, oliSourceId: realPlan().sourceId };
  assert.equal(rec.matchExportForFailedCreate({ ...base, exports: [exportRec({ status: "ENQUEUED" })] }).disposition, "none", "a non-COMPLETED export never adopts");
  assert.equal(rec.matchExportForFailedCreate({ ...base, exports: [exportRec({ sourceId: "some-other-source" })] }).disposition, "none", "another source never adopts");
  assert.equal(rec.matchExportForFailedCreate({ ...base, exports: [exportRec({ to: "2026-03-16" })] }).disposition, "none", "a different window never adopts");
  assert.equal(rec.matchExportForFailedCreate({ ...base, exports: [exportRec({ sellerOrVendorIds: realPlan().sellers.slice(0, 4) })] }).disposition, "none", "a seller SUBSET never adopts");
  assert.equal(rec.matchExportForFailedCreate({ ...base, exports: [exportRec({ sellerOrVendorIds: [...realPlan().sellers, "S9"] })] }).disposition, "none", "a seller SUPERSET never adopts");
  assert.equal(rec.matchExportForFailedCreate({ ...base, exports: [] }).disposition, "none", "an empty exports list never adopts");
});

test("A3. multiple exact matches -> ambiguous (never a guess between twins)", () => {
  const m = rec.matchExportForFailedCreate({ windowFrom: "2025-08-10", windowTo: "2026-03-17", sellerIds: realPlan().sellers, exports: [exportRec(), exportRec({ id: "exp-adopt-2" })], oliSourceId: realPlan().sourceId });
  assert.equal(m.disposition, "ambiguous");
  assert.equal(m.matches, 2);
});

test("A4. seller ORDER independence + DATE-ONLY window equality (timestamps normalize)", () => {
  const m = rec.matchExportForFailedCreate({
    windowFrom: "2025-08-10T00:00:00.000Z", windowTo: "2026-03-17T23:59:59Z",
    sellerIds: [...realPlan().sellers].reverse(),
    exports: [exportRec({ from: "2025-08-10", to: "2026-03-17", sellerOrVendorIds: [...realPlan().sellers].sort() })],
    oliSourceId: realPlan().sourceId,
  });
  assert.equal(m.disposition, "adopt");
});

test("A5. fail closed on ANY missing identity input (sellers, window, source id)", () => {
  const base = { windowFrom: "2025-08-10", windowTo: "2026-03-17", sellerIds: realPlan().sellers, exports: [exportRec()], oliSourceId: realPlan().sourceId };
  assert.equal(rec.matchExportForFailedCreate({ ...base, sellerIds: [] }).disposition, "none", "no canonical seller set => never adopts");
  assert.equal(rec.matchExportForFailedCreate({ ...base, windowFrom: null }).disposition, "none");
  assert.equal(rec.matchExportForFailedCreate({ ...base, windowTo: "" }).disposition, "none");
  assert.equal(rec.matchExportForFailedCreate({ ...base, oliSourceId: null }).disposition, "none");
  assert.equal(rec.matchExportForFailedCreate({}).disposition, "none", "no inputs at all => none");
});

test("A6. source-id PREFIX equality both directions; a non-prefix id never matches", () => {
  const long = realPlan().sourceId + "-suffixed-long-form";
  const okShort = rec.matchExportForFailedCreate({ windowFrom: "2025-08-10", windowTo: "2026-03-17", sellerIds: realPlan().sellers, exports: [exportRec({ sourceId: long })], oliSourceId: realPlan().sourceId });
  assert.equal(okShort.disposition, "adopt", "export carries the LONG id, canonical is its prefix");
  const okLong = rec.matchExportForFailedCreate({ windowFrom: "2025-08-10", windowTo: "2026-03-17", sellerIds: realPlan().sellers, exports: [exportRec()], oliSourceId: long });
  assert.equal(okLong.disposition, "adopt", "canonical is the LONG id, export carries its prefix");
  const no = rec.matchExportForFailedCreate({ windowFrom: "2025-08-10", windowTo: "2026-03-17", sellerIds: realPlan().sellers, exports: [exportRec({ sourceId: "zz" + realPlan().sourceId })], oliSourceId: realPlan().sourceId });
  assert.equal(no.disposition, "none", "a non-prefix source id never matches");
});

/* ================================= B. reconcileEligibility ================================= */
group("B. reconcileEligibility -- the exact ambiguous-create shape only");

test("B1. the exact shape is eligible; each disqualifier refuses", () => {
  assert.equal(rec.reconcileEligibility(failedCreateRow()).eligible, true, "failed + non-terminal + create-export + count=1 + NO export id => eligible");
  assert.deepEqual(rec.reconcileEligibility(failedCreateRow({ source_key: "product-catalog" })), { eligible: false, reason: "not-oli" });
  assert.deepEqual(rec.reconcileEligibility(failedCreateRow({ fetch_status: "succeeded" })), { eligible: false, reason: "not-failed" });
  assert.deepEqual(rec.reconcileEligibility(failedCreateRow({ fetch_status: "attempted" })), { eligible: false, reason: "not-failed" });
  assert.deepEqual(rec.reconcileEligibility(failedCreateRow({ terminal: true })), { eligible: false, reason: "terminal" });
  assert.deepEqual(rec.reconcileEligibility(failedCreateRow({ error_stage: "download" })), { eligible: false, reason: "stage-not-create" }, "a download failure belongs to the download-recovery path, never here");
  assert.deepEqual(rec.reconcileEligibility(failedCreateRow({ error_stage: "poll" })), { eligible: false, reason: "stage-not-create" });
  assert.deepEqual(rec.reconcileEligibility(failedCreateRow({ create_export_count: 0 })), { eligible: false, reason: "create-count-not-one" }, "zero attempted creates => nothing ambiguous to reconcile");
  assert.deepEqual(rec.reconcileEligibility(failedCreateRow({ create_export_count: 2 })), { eligible: false, reason: "create-count-not-one" });
  assert.deepEqual(rec.reconcileEligibility(failedCreateRow({ export_id: EXPORT_ID })), { eligible: false, reason: "export-id-already-saved" }, "a saved export id is NOT ambiguous -- that is the plain download-recovery shape");
});

/* ================================= C. reconcileFailedCreates ================================= */
group("C. reconcileFailedCreates -- adopt exactly once, recover download-only, ZERO creates");

test("C1. E2E happy path: match -> adopt (one guarded write) -> download-only recovery -> success; ZERO creates", async () => {
  const store = makeStore();
  const cid = seededCycle(store);
  store._seedJob(cid, realPlan().targetHash, failedCreateRow());
  const dd = makeDataDoe(() => okPayload5());
  const adopt = makeAdopt(store);
  const res = await runReconcile({ store, cid, dataDoe: dd, exportsList: [exportRec()], adopt });
  assert.equal(res.attempted, 1);
  assert.equal(res.adopted, 1);
  assert.equal(res.recovered, 1);
  assert.deepEqual(res.results, [{ requestHash: realPlan().targetHash.slice(0, 12), disposition: "recovered" }]);
  assert.equal(dd.counts.create, 0, "ZERO create POSTs (the one-create-per-hash invariant survives reconciliation)");
  assert.equal(dd.counts.download, 1, "exactly one download of the adopted export");
  assert.equal(adopt.spy.calls, 1, "exactly ONE adoption write");
  const j = store._raw(cid, realPlan().targetHash);
  assert.equal(j.fetch_status, "succeeded");
  assert.equal(j.export_id, EXPORT_ID, "the ADOPTED export id is the one saved");
  assert.equal(j.create_export_count, 1, "create_export_count untouched");
  assert.equal(store._cache.get(realPlan().targetHash).rows.length, 5, "the recovered payload persisted via the source-cache CAS");
});

test("C2. IDEMPOTENT: a second run after success finds ZERO eligible jobs (adoption-once)", async () => {
  const store = makeStore();
  const cid = seededCycle(store);
  store._seedJob(cid, realPlan().targetHash, failedCreateRow());
  const dd = makeDataDoe(() => okPayload5());
  await runReconcile({ store, cid, dataDoe: dd, exportsList: [exportRec()], adopt: makeAdopt(store) });
  let listed = 0;
  const res2 = await rec.reconcileFailedCreates({
    cycleId: cid, store, dataDoe: dd, plannedOliJobs: realPlan().plannedOliJobs,
    listExports: async () => { listed += 1; return [exportRec()]; },
    adoptExportId: makeAdopt(store), oliSourceId: realPlan().sourceId, runWithDeadline: noDeadline,
  });
  assert.deepEqual({ attempted: res2.attempted, adopted: res2.adopted, recovered: res2.recovered }, { attempted: 0, adopted: 0, recovered: 0 });
  assert.equal(listed, 0, "zero eligible jobs => the exports list is never even fetched");
  assert.equal(dd.counts.download, 1, "no second download");
});

test("C3. no-planned-identity: a hash the RE-PLAN no longer emits is refused (no adopt, no download)", async () => {
  const store = makeStore();
  const cid = seededCycle(store);
  store._seedJob(cid, realPlan().targetHash, failedCreateRow());
  const dd = makeDataDoe(() => okPayload5());
  const adopt = makeAdopt(store);
  const res = await runReconcile({ store, cid, dataDoe: dd, exportsList: [exportRec()], adopt, planned: [] });
  assert.deepEqual(res.results, [{ requestHash: realPlan().targetHash.slice(0, 12), disposition: "no-planned-identity" }]);
  assert.equal(res.adopted + res.recovered + adopt.spy.calls + dd.counts.download + dd.counts.create, 0, "nothing written, downloaded, or created");
});

test("C4. a planned seller set over the hard 5-seller cap is refused (no adopt)", async () => {
  const store = makeStore();
  const cid = seededCycle(store);
  store._seedJob(cid, realPlan().targetHash, failedCreateRow());
  const dd = makeDataDoe(() => okPayload5());
  const adopt = makeAdopt(store);
  const oversized = [{ ...realPlan().meta, fetchParams: { ...realPlan().meta.fetchParams, sellerOrVendorIds: ["S1", "S2", "S3", "S4", "S5", "S6"] } }];
  const res = await runReconcile({ store, cid, dataDoe: dd, exportsList: [exportRec()], adopt, planned: oversized });
  assert.deepEqual(res.results, [{ requestHash: realPlan().targetHash.slice(0, 12), disposition: "no-planned-identity" }]);
  assert.equal(adopt.spy.calls + dd.counts.download + dd.counts.create, 0);
});

test("C5. planned-window-mismatch: the durable meta window must equal the re-planned window (no adopt)", async () => {
  const store = makeStore();
  const cid = seededCycle(store);
  store._seedJob(cid, realPlan().targetHash, failedCreateRow({ request_meta: { from: "2025-08-10", to: "2026-03-16" } }));
  const dd = makeDataDoe(() => okPayload5());
  const adopt = makeAdopt(store);
  const res = await runReconcile({ store, cid, dataDoe: dd, exportsList: [exportRec()], adopt });
  assert.deepEqual(res.results, [{ requestHash: realPlan().targetHash.slice(0, 12), disposition: "planned-window-mismatch" }]);
  assert.equal(adopt.spy.calls + dd.counts.download + dd.counts.create, 0);
});

test("C6. no matching export -> typed none; the job stays failed create-stage (the rolling window recovers it later)", async () => {
  const store = makeStore();
  const cid = seededCycle(store);
  store._seedJob(cid, realPlan().targetHash, failedCreateRow());
  const dd = makeDataDoe(() => okPayload5());
  const adopt = makeAdopt(store);
  const res = await runReconcile({ store, cid, dataDoe: dd, exportsList: [exportRec({ to: "2026-03-16" })], adopt });
  assert.deepEqual(res.results, [{ requestHash: realPlan().targetHash.slice(0, 12), disposition: "none" }]);
  assert.equal(adopt.spy.calls + dd.counts.download + dd.counts.create, 0);
  const j = store._raw(cid, realPlan().targetHash);
  assert.equal(j.fetch_status, "failed");
  assert.equal(j.error_stage, "create-export");
  assert.equal(j.export_id, null, "no export id was guessed onto the row");
});

test("C7. ambiguous exports -> typed ambiguous; never adopts either twin", async () => {
  const store = makeStore();
  const cid = seededCycle(store);
  store._seedJob(cid, realPlan().targetHash, failedCreateRow());
  const dd = makeDataDoe(() => okPayload5());
  const adopt = makeAdopt(store);
  const res = await runReconcile({ store, cid, dataDoe: dd, exportsList: [exportRec(), exportRec({ id: "exp-adopt-2" })], adopt });
  assert.deepEqual(res.results, [{ requestHash: realPlan().targetHash.slice(0, 12), disposition: "ambiguous" }]);
  assert.equal(adopt.spy.calls + dd.counts.download + dd.counts.create, 0);
  assert.equal(store._raw(cid, realPlan().targetHash).export_id, null);
});

test("C8. adopt-write-refused: a false adoption write stops the job cold (no recovery, no fabrication)", async () => {
  const store = makeStore();
  const cid = seededCycle(store);
  store._seedJob(cid, realPlan().targetHash, failedCreateRow());
  const dd = makeDataDoe(() => okPayload5());
  const refuse = Object.assign(async () => false, { spy: { calls: 0 } });
  const res = await runReconcile({ store, cid, dataDoe: dd, exportsList: [exportRec()], adopt: refuse });
  assert.deepEqual(res.results, [{ requestHash: realPlan().targetHash.slice(0, 12), disposition: "adopt-write-refused" }]);
  assert.equal(res.adopted + res.recovered, 0);
  assert.equal(dd.counts.download + dd.counts.create, 0, "a refused adoption never downloads or creates");
  assert.equal(store._raw(cid, realPlan().targetHash).fetch_status, "failed", "the row is untouched");
});

test("C9. a download failure AFTER adoption: adopted=1 recovered=0, typed non-success, STILL zero creates", async () => {
  const store = makeStore();
  const cid = seededCycle(store);
  store._seedJob(cid, realPlan().targetHash, failedCreateRow());
  const dd = makeDataDoe(() => { throw new Error("storage 503"); });
  const res = await runReconcile({ store, cid, dataDoe: dd, exportsList: [exportRec()], adopt: makeAdopt(store) });
  assert.equal(res.attempted, 1);
  assert.equal(res.adopted, 1);
  assert.equal(res.recovered, 0, "an unrecovered adoption is NEVER reported recovered");
  assert.equal(res.results[0].disposition.startsWith("recovery-"), true, "typed recovery outcome: " + res.results[0].disposition);
  assert.equal(dd.counts.create, 0, "zero creates on the failure path too");
  const j = store._raw(cid, realPlan().targetHash);
  assert.equal(j.fetch_status, "failed");
  assert.equal(j.export_id, EXPORT_ID, "the adopted export id SURVIVES -> the plain download-recovery path resumes it later");
  assert.notEqual(j.error_stage, "create-export", "the job is out of the ambiguous-create shape for good");
});

test("C10. fail-closed constructor: every missing collaborator throws before any work", async () => {
  const store = makeStore();
  const base = { cycleId: "c1", store, dataDoe: makeDataDoe(() => []), plannedOliJobs: [], listExports: async () => [], adoptExportId: async () => false, oliSourceId: "src-oli" };
  await assert.rejects(() => rec.reconcileFailedCreates({ ...base, oliSourceId: "" }), /canonical OLI DataDoe source id/);
  await assert.rejects(() => rec.reconcileFailedCreates({ ...base, cycleId: "" }), /cycleId/);
  await assert.rejects(() => rec.reconcileFailedCreates({ ...base, store: {} }), /recovery store/);
  await assert.rejects(() => rec.reconcileFailedCreates({ ...base, listExports: null }), /listExports \+ adoptExportId/);
  await assert.rejects(() => rec.reconcileFailedCreates({ ...base, adoptExportId: null }), /listExports \+ adoptExportId/);
});

async function main() {
  out("source create-reconcile (adopt-exact-identity) proof suite");
  worker = await import("../lib/server/sync/source-worker.js");
  rec = await import("../lib/server/sync/source-create-reconcile.js");
  bucketSync = await import("../lib/server/sync/source-bucket-sync.js");
  let failures = 0;
  for (const t of tests) {
    if (t.marker) { out("-- " + t.marker); continue; }
    try { await t.fn(); passed += 1; out("  ok  " + t.name); }
    catch (e) { failures += 1; out("FAIL  " + t.name); out(String((e && e.stack) || e)); }
  }
  out("\n" + passed + " assertions passed" + (failures ? ", " + failures + " FAILED" : ""));
  if (failures) process.exitCode = 1;
}

main();
