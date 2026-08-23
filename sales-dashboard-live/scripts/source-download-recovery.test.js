// Scheduler v2 Phase 2 -- DOWNLOAD-ONLY recovery of an already-created export. Deterministic OFFLINE tests.
//
// Proves the smallest production-safe recovery for a FAILED (recorded) source job whose failure is the exact
// recoverable shape: non-terminal, error_stage in (poll,download), create_export_count=1, a saved export_id.
//   - recoveryEligibility gates the exact shape (each disqualifier refuses);
//   - recoverFailedDownloadJob NEVER creates an export: it atomically claims the recovery (failed -> attempted),
//     then resumes poll/download of the SAME export_id ONCE through the existing validate/CAS/success path;
//   - terminal / TRUNCATED / create-stage / missing-export_id failures are never recovered;
//   - concurrency yields exactly ONE recovery winner and ONE download/write; ambiguous acks fail closed;
//   - a validation failure preserves last-known-good (never overwrites the prior good cache);
//   - the one-create-per-hash invariant holds (zero create POSTs during recovery);
//   - the production claimSourceExportRecovery wrapper issues the exact conditional PATCH and interprets acks.
//
// 7-bit ASCII, LF, no top-level await, synchronous writeSync progress, dynamic imports after a dummy env.

import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { spawnSync } from "node:child_process";

// Set BEFORE importing supabase.js (module reads these at load) so the wrapper's request() builds a URL.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://supabase.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ["test", "svc", "role", "key"].join("-");
process.env.DATADOE_API_KEY = process.env.DATADOE_API_KEY || "dd_api_test";

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const group = (label) => tests.push({ marker: label });
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };

let worker; // source-worker.js
let sb; // supabase.js
let opmod; // source-oli-recovery-operation.js
let C; // the frozen operator target constants
let bucketSync; // source-bucket-sync.js (the REAL planner)
let datadoe; // datadoe.js (the real deadline/sleep mechanism)

const HASH = "hash_oli_batch_1";
const OTHER = "hash_oli_batch_2";
const EXPORT_ID = "exp-recover-1"; // never printed by the code under test; only used to drive the fakes

// The canonical plan entry (meta) for a single-seller OLI-like job: single seller => the batch validator is
// skipped, so the download-only resume exercises the array + truncation checks. strict + a real cap.
const metaFor = (hash) => ({
  requestKey: "source-oli:slice-v1", requestHash: hash,
  sourceId: "src-oli", sourceKey: "order-line-items", connectionId: "primary",
  organizationFingerprint: "org1", accountScopeHash: "scopeA",
  strict: true, limit: 50000,
  fetchParams: { sellerOrVendorIds: ["S1"], from: "2025-01-01", to: "2026-03-17", columns: ["date"], options: {} },
});

// A FAILED source-job row in the exact recoverable shape (override fields to make it ineligible).
const failedRow = (over = {}) => ({
  request_hash: HASH, request_key: "source-oli:slice-v1", source_id: "src-oli", source_key: "order-line-items",
  connection_id: "primary", organization_fingerprint: "org1", account_scope_hash: "scopeA",
  fetch_status: "failed", terminal: false, error_stage: "download", error_code: "EXPORT_ERROR",
  create_export_count: 1, export_id: EXPORT_ID, attempted_at: "t", row_count: null, cache_object_path: null,
  request_meta: { from: "2025-08-10", to: "2026-03-17" }, // the canonical window (operator verifies this)
  ...over,
});

// The REAL production shape, built by the canonical planBucketSourceSync: a five-seller, seller-scoped OLI batch
// with marketplaceScoped=FALSE (OLI carries no marketplace column). Computed once (at run time, after imports)
// for the EXACT fixed target window 2025-08-10..2026-03-17 (the 2nd 221-day multi-seller chunk of the go-live
// backfill). NO synthetic meta: the operator + validation tests drive off this real plan.
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
  REAL = { plan, oli, unit, targetHash: unit.requestHash, plannedForHash, meta: plannedForHash[0], sellers: [...unit.sellerOrVendorIds] };
  return REAL;
}
// One canonical OLI row (validated columns: seller_or_vendor_id; no marketplace column exists for OLI).
const okRow = (sid) => ({ date: "2026-01-01", seller_or_vendor_id: sid, sku: "SKU-A", child_asin: "B0A", item_price_currency: "USD", total_sales_sum: 10, total_units_sum: 1 });
const okPayload5 = () => realPlan().sellers.map(okRow);
const durableOwnersFromPlan = (hash = realPlan().targetHash) => realPlan().plannedForHash.map((p, i) => ({ request_hash: hash, owner_id: p.owner.ownerId || ("owner-" + i), account_id: p.owner.accountId, connection_id: "primary", owner_status: "active" }));

// ---- in-memory source store (models the atomic recovery CAS + the save/success/failure + LKG cache) ----
function makeStore() {
  const cycles = new Map();
  const jobsByCycle = new Map();
  const ownersByCycle = new Map(); // cycleId -> [ownership rows]
  const cache = new Map(); // requestHash -> { rows, object_path } (durable LKG)
  let seq = 0;
  const findCycle = (id) => [...cycles.values()].find((c) => c.id === id) || null;
  const jmap = (cid) => jobsByCycle.get(cid);
  const raw = (cid, hash) => jmap(cid) && jmap(cid).get(hash);
  const ensureCycle = (cid) => { if (!jobsByCycle.has(cid)) { cycles.set("seed|" + cid, { id: cid, bucket: "non-us", status: "running" }); jobsByCycle.set(cid, new Map()); ownersByCycle.set(cid, []); } };
  return {
    _cache: cache,
    _raw: raw,
    _snapshot: (cid, hash) => ({ ...raw(cid, hash) }),
    _seedCache: (hash, rows) => { cache.set(hash, { rows: [...rows], object_path: "source-cache/v2/" + hash + "/good.json" }); },
    _seedJob: (cid, hash, row) => { ensureCycle(cid); jmap(cid).set(hash, { ...row, request_hash: hash }); },
    _seedOwners: (cid, list) => { ensureCycle(cid); ownersByCycle.set(cid, list.map((o) => ({ ...o }))); },
    // The operator's reads: source jobs WITH request_meta (the seeded rows already carry it) + cycle owners.
    listSourceJobsWithMeta(id) { return [...((jmap(id) && jmap(id).values()) || [])].map((j) => ({ ...j })); },
    listCycleOwners(id) { return [...(ownersByCycle.get(id) || [])].map((o) => ({ ...o })); },
    openCycle({ bucket, cycleDate }) {
      const key = bucket + "|" + cycleDate;
      if (!cycles.has(key)) { const id = "cyc_" + (seq += 1); cycles.set(key, { id, bucket, cycle_date: cycleDate, status: "running" }); jobsByCycle.set(id, new Map()); }
      return cycles.get(key).id;
    },
    claimCycle() { return false; }, // already running
    getCycle(id) { return findCycle(id); },
    upsertSourceJob(job) {
      const m = jmap(job.cycleId);
      if (m.has(job.requestHash)) return; // insert-if-absent: never resets a seeded failed row
      m.set(job.requestHash, {
        request_hash: job.requestHash, request_key: job.requestKey, source_id: job.sourceId, source_key: job.sourceKey,
        connection_id: job.connectionId, organization_fingerprint: job.organizationFingerprint, account_scope_hash: job.accountScopeHash,
        fetch_status: "pending", attempted_at: null, create_export_count: 0, export_id: null,
        terminal: false, error_stage: null, error_code: null, error_message: null, row_count: null, cache_object_path: null,
      });
    },
    listSourceJobs(id) { return [...((jmap(id) && jmap(id).values()) || [])].map((j) => ({ ...j })); },
    claimExportAttempt(id, hash) {
      const j = raw(id, hash);
      if (j && j.attempted_at === null) { j.attempted_at = "t"; j.create_export_count += 1; j.fetch_status = "attempted"; return true; }
      return false;
    },
    // The atomic recovery CAS (models the conditional PATCH BOUND to expectedExportId): flips a still-eligible-
    // failed row whose canonical export_id EXACTLY equals expectedExportId to 'attempted' (preserving export_id +
    // create_export_count). check+flip is synchronous => atomic (one winner). A noncanonical expected id fails
    // closed (null); an export_id that no longer matches yields zero rows ('not-eligible').
    async claimSourceExportRecovery({ cycleId, requestHash, expectedExportId }) {
      if (typeof expectedExportId !== "string" || expectedExportId === "" || expectedExportId !== expectedExportId.trim()) return null;
      const j = raw(cycleId, requestHash);
      if (!j) return "not-eligible";
      const e = worker.recoveryEligibility(j);
      if (!e.eligible) return "not-eligible"; // includes "already attempted by a concurrent winner"
      if (e.exportId !== expectedExportId) return "not-eligible"; // the export_id=eq.<expected> filter matched 0 rows
      j.fetch_status = "attempted"; // export_id + create_export_count untouched
      return "claimed";
    },
    recordExportCreated({ cycleId, requestHash, exportId }) { raw(cycleId, requestHash).export_id = exportId; },
    loadSourceRows(hash) { const e = cache.get(hash); return e ? { rows: e.rows, object_path: e.object_path } : null; },
    saveSourceRows({ job, rows, version }) {
      const hash = job.request_hash != null ? job.request_hash : job.requestHash;
      const path = "source-cache/v2/" + hash + "/" + version + ".json";
      cache.set(hash, { rows: [...rows], object_path: path }); // overwrites LKG only on a REAL save
      return path;
    },
    recordSourceSuccess({ cycleId, requestHash, exportId, rowCount, cacheObjectPath }) {
      Object.assign(raw(cycleId, requestHash), { fetch_status: "succeeded", export_id: exportId, row_count: rowCount, cache_object_path: cacheObjectPath, terminal: false, error_stage: null, error_code: null });
    },
    recordSourceFailure({ cycleId, requestHash, stage, code, message, terminal, rowCount, exportId }) {
      const j = raw(cycleId, requestHash);
      Object.assign(j, { fetch_status: "failed", error_stage: stage, error_code: code, error_message: message, terminal: !!terminal });
      if (rowCount != null) j.row_count = rowCount;
      if (exportId != null) j.export_id = exportId; // NEVER clears cache_object_path -> LKG survives
    },
    updateCycleCounts() { /* not asserted */ },
  };
}

// DataDoe double: counts create/poll/download; download supplies rows or throws. A create call is a HARD test
// failure signal (recovery must NEVER create).
function makeDataDoe(downloadFor) {
  const counts = { create: 0, poll: 0, download: 0 };
  return {
    counts,
    async create() { counts.create += 1; throw new Error("RECOVERY MUST NOT CREATE"); },
    async poll() { counts.poll += 1; },
    async download(job) { counts.download += 1; return downloadFor(job); },
  };
}

const noDeadline = (fn) => fn();
const seededCycle = (store) => store.openCycle({ bucket: "non-us", cycleDate: "2026-08-30" });

/* ================================= A. eligibility ================================= */
group("A. recoveryEligibility -- the exact recoverable shape only");

test("A1. the exact shape is eligible; each disqualifier refuses (never eligible)", () => {
  assert.equal(worker.recoveryEligibility(failedRow()).eligible, true, "failed + non-terminal + download + count=1 + export_id => eligible");
  assert.equal(worker.recoveryEligibility(failedRow({ error_stage: "poll" })).eligible, true, "poll stage is also recoverable");
  assert.deepEqual(worker.recoveryEligibility(failedRow({ fetch_status: "succeeded" })), { eligible: false, reason: "not-failed" });
  assert.deepEqual(worker.recoveryEligibility(failedRow({ fetch_status: "attempted" })), { eligible: false, reason: "not-failed" });
  assert.deepEqual(worker.recoveryEligibility(failedRow({ terminal: true })), { eligible: false, reason: "terminal" });
  assert.deepEqual(worker.recoveryEligibility(failedRow({ error_stage: "validate" })), { eligible: false, reason: "stage-not-recoverable" });
  assert.deepEqual(worker.recoveryEligibility(failedRow({ error_stage: "create-export" })), { eligible: false, reason: "stage-not-recoverable" });
  assert.deepEqual(worker.recoveryEligibility(failedRow({ error_stage: "persist" })), { eligible: false, reason: "stage-not-recoverable" });
  assert.deepEqual(worker.recoveryEligibility(failedRow({ create_export_count: 0 })), { eligible: false, reason: "create-count-not-one" });
  assert.deepEqual(worker.recoveryEligibility(failedRow({ create_export_count: 2 })), { eligible: false, reason: "create-count-not-one" });
  assert.deepEqual(worker.recoveryEligibility(failedRow({ export_id: null })), { eligible: false, reason: "missing-export-id" });
  assert.deepEqual(worker.recoveryEligibility(failedRow({ export_id: "   " })), { eligible: false, reason: "missing-export-id" });
  assert.deepEqual(worker.recoveryEligibility(failedRow({ export_id: " " + EXPORT_ID + " " })), { eligible: false, reason: "noncanonical-export-id" }, "a whitespace-padded export id is NONCANONICAL (never trimmed)");
  assert.equal(worker.recoveryEligibility(failedRow()).exportId, EXPORT_ID, "the canonical (untrimmed) export id is returned verbatim");
});

/* ================================= B. recoverFailedDownloadJob ================================= */
group("B. recoverFailedDownloadJob -- download-only resume, zero creates, fail-closed");

test("B1. success: an eligible failed job resumes download-only (one poll+download), validates, saves via CAS, records success -- ZERO creates", async () => {
  const store = makeStore();
  const cid = seededCycle(store);
  store._seedJob(cid, HASH, failedRow());
  const dd = makeDataDoe(() => [{ date: "2026-03-10", v: 1 }, { date: "2026-03-11", v: 2 }]);
  const outcome = await worker.recoverFailedDownloadJob({ store, dataDoe: dd, clock: () => 1000, cycleId: cid, meta: metaFor(HASH), jobRow: store._snapshot(cid, HASH), runWithDeadline: noDeadline });
  assert.equal(outcome.status, "success", JSON.stringify(outcome));
  assert.equal(outcome.validated, true);
  assert.equal(dd.counts.create, 0, "ZERO create POSTs during recovery (one-create-per-hash preserved)");
  assert.equal(dd.counts.poll, 1, "polled at most once");
  assert.equal(dd.counts.download, 1, "downloaded at most once");
  const j = store._raw(cid, HASH);
  assert.equal(j.fetch_status, "succeeded");
  assert.equal(j.create_export_count, 1, "create_export_count still exactly 1");
  assert.equal(j.export_id, EXPORT_ID, "the SAME saved export_id was reused");
  assert.equal(store._cache.get(HASH).rows.length, 2, "the recovered payload was saved through the source-cache CAS");
});

test("B2. terminal refusal: a terminal failure is NEVER recovered (no claim, no download, no create)", async () => {
  const store = makeStore();
  const cid = seededCycle(store);
  store._seedJob(cid, HASH, failedRow({ terminal: true }));
  const dd = makeDataDoe(() => [{ v: 1 }]);
  const outcome = await worker.recoverFailedDownloadJob({ store, dataDoe: dd, clock: () => 1, cycleId: cid, meta: metaFor(HASH), jobRow: store._snapshot(cid, HASH), runWithDeadline: noDeadline });
  assert.equal(outcome.status, "recovery-skipped");
  assert.equal(outcome.reason, "terminal");
  assert.equal(dd.counts.download, 0, "no download for a terminal failure");
  assert.equal(dd.counts.create, 0, "no create");
  assert.equal(store._raw(cid, HASH).fetch_status, "failed", "the terminal failure stays failed (LKG untouched)");
});

test("B3. missing export_id: never recovered (no download, no create)", async () => {
  const store = makeStore();
  const cid = seededCycle(store);
  store._seedJob(cid, HASH, failedRow({ export_id: null }));
  const dd = makeDataDoe(() => [{ v: 1 }]);
  const outcome = await worker.recoverFailedDownloadJob({ store, dataDoe: dd, clock: () => 1, cycleId: cid, meta: metaFor(HASH), jobRow: store._snapshot(cid, HASH), runWithDeadline: noDeadline });
  assert.equal(outcome.reason, "missing-export-id");
  assert.equal(dd.counts.download + dd.counts.create, 0, "no download, no create without a saved export_id");
});

test("B4. a create-stage failure is never recovered (never resumes, never re-creates)", async () => {
  const store = makeStore();
  const cid = seededCycle(store);
  store._seedJob(cid, HASH, failedRow({ error_stage: "create-export", export_id: null, create_export_count: 0 }));
  const dd = makeDataDoe(() => [{ v: 1 }]);
  const outcome = await worker.recoverFailedDownloadJob({ store, dataDoe: dd, clock: () => 1, cycleId: cid, meta: metaFor(HASH), jobRow: store._snapshot(cid, HASH), runWithDeadline: noDeadline });
  assert.equal(outcome.status, "recovery-skipped");
  assert.equal(dd.counts.create, 0);
  assert.equal(dd.counts.download, 0);
});

test("B5. validation failure (TRUNCATED): claim + one download, records a terminal validate failure, persists nothing, LKG preserved", async () => {
  const store = makeStore();
  const cid = seededCycle(store);
  store._seedCache(HASH, [{ good: 1 }]); // prior last-known-good
  store._seedJob(cid, HASH, failedRow());
  const meta = metaFor(HASH); // strict:true, limit 50000
  const dd = makeDataDoe(() => Array.from({ length: meta.limit }, () => ({}))); // rows.length === limit => TRUNCATED
  const outcome = await worker.recoverFailedDownloadJob({ store, dataDoe: dd, clock: () => 1, cycleId: cid, meta, jobRow: store._snapshot(cid, HASH), runWithDeadline: noDeadline });
  assert.equal(outcome.status, "terminal", JSON.stringify(outcome).slice(0, 80)); // TRUNCATED is terminal
  assert.equal(outcome.code, "TRUNCATED");
  assert.equal(dd.counts.create, 0, "still zero creates");
  assert.equal(dd.counts.download, 1, "downloaded once");
  const j = store._raw(cid, HASH);
  assert.equal(j.error_code, "TRUNCATED");
  assert.equal(j.error_stage, "validate");
  assert.equal(j.terminal, true, "a truncated recovery is terminal -> never retried again");
  assert.deepEqual(store._cache.get(HASH).rows, [{ good: 1 }], "the prior last-known-good cache is UNCHANGED (nothing overwritten)");
});

test("B6. malformed download payload (non-array) fails closed as MALFORMED_PAYLOAD; nothing persisted", async () => {
  const store = makeStore();
  const cid = seededCycle(store);
  store._seedCache(HASH, [{ good: 1 }]);
  store._seedJob(cid, HASH, failedRow());
  const dd = makeDataDoe(() => ({ not: "an array" }));
  const outcome = await worker.recoverFailedDownloadJob({ store, dataDoe: dd, clock: () => 1, cycleId: cid, meta: metaFor(HASH), jobRow: store._snapshot(cid, HASH), runWithDeadline: noDeadline });
  assert.equal(outcome.code, "MALFORMED_PAYLOAD");
  assert.equal(store._raw(cid, HASH).terminal, true);
  assert.deepEqual(store._cache.get(HASH).rows, [{ good: 1 }], "LKG preserved on a malformed payload");
});

test("B7. ambiguous recovery acknowledgement fails closed: no download, no create, no fabrication", async () => {
  const store = makeStore();
  const cid = seededCycle(store);
  store._seedJob(cid, HASH, failedRow());
  store.claimSourceExportRecovery = async () => "weird-ack"; // not one of claimed|not-eligible|not-won
  const dd = makeDataDoe(() => [{ v: 1 }]);
  const outcome = await worker.recoverFailedDownloadJob({ store, dataDoe: dd, clock: () => 1, cycleId: cid, meta: metaFor(HASH), jobRow: store._snapshot(cid, HASH), runWithDeadline: noDeadline });
  assert.equal(outcome.status, "recovery-skipped");
  assert.equal(outcome.reason, "recovery-ack-ambiguous");
  assert.equal(dd.counts.download + dd.counts.create, 0, "an ambiguous ack downloads/creates nothing");
  assert.equal(store._raw(cid, HASH).fetch_status, "failed", "the job is left failed (not fabricated)");
});

test("B8. a claim error fails closed (no download, no create)", async () => {
  const store = makeStore();
  const cid = seededCycle(store);
  store._seedJob(cid, HASH, failedRow());
  store.claimSourceExportRecovery = async () => { throw new Error("db down"); };
  const dd = makeDataDoe(() => [{ v: 1 }]);
  const outcome = await worker.recoverFailedDownloadJob({ store, dataDoe: dd, clock: () => 1, cycleId: cid, meta: metaFor(HASH), jobRow: store._snapshot(cid, HASH), runWithDeadline: noDeadline });
  assert.equal(outcome.reason, "recovery-claim-error");
  assert.equal(dd.counts.download + dd.counts.create, 0);
});

test("B9. a missing recovery CAS on the store fails closed (never creates/fabricates)", async () => {
  const store = makeStore();
  const cid = seededCycle(store);
  store._seedJob(cid, HASH, failedRow());
  delete store.claimSourceExportRecovery;
  const dd = makeDataDoe(() => [{ v: 1 }]);
  const outcome = await worker.recoverFailedDownloadJob({ store, dataDoe: dd, clock: () => 1, cycleId: cid, meta: metaFor(HASH), jobRow: store._snapshot(cid, HASH), runWithDeadline: noDeadline });
  assert.equal(outcome.reason, "recovery-cas-unavailable");
  assert.equal(dd.counts.download + dd.counts.create, 0);
});

test("B10. CONCURRENCY: two recoveries of the SAME failed job => exactly ONE winner, ONE download/write, ZERO creates", async () => {
  const store = makeStore();
  const cid = seededCycle(store);
  store._seedJob(cid, HASH, failedRow());
  const dd = makeDataDoe(() => [{ date: "2026-03-10", v: 1 }]);
  // Real two-worker race: BOTH read the still-FAILED row first, THEN race the atomic claim. Exactly one wins.
  const snap1 = store._snapshot(cid, HASH);
  const snap2 = store._snapshot(cid, HASH);
  assert.equal(snap1.fetch_status, "failed");
  assert.equal(snap2.fetch_status, "failed");
  const run = (snap) => worker.recoverFailedDownloadJob({ store, dataDoe: dd, clock: () => 1, cycleId: cid, meta: metaFor(HASH), jobRow: snap, runWithDeadline: noDeadline });
  const [a, b] = await Promise.all([run(snap1), run(snap2)]);
  const results = [a, b];
  const winners = results.filter((r) => r.status === "success");
  const losers = results.filter((r) => r.status === "recovery-skipped");
  assert.equal(winners.length, 1, "exactly ONE recovery winner");
  assert.equal(losers.length, 1, "the other caller skips");
  assert.equal(losers[0].reason, "not-eligible", "the loser saw the row already claimed (not eligible)");
  assert.equal(dd.counts.download, 1, "exactly ONE download (no duplicate)");
  assert.equal(dd.counts.create, 0, "ZERO creates");
  assert.equal(store._raw(cid, HASH).fetch_status, "succeeded");
});

/* ================================= C. runSourceJobs integration ================================= */
group("C. runSourceJobs recoverFailedDownloads flag");

test("C1. flag ON: a seeded eligible failed job is recovered to success with ZERO new creates; an unrelated pending job runs normally", async () => {
  const store = makeStore();
  const cid = store.openCycle({ bucket: "non-us", cycleDate: "2026-08-30" });
  store._seedJob(cid, HASH, failedRow());              // the recoverable failed job
  const dd = makeDataDoe((job) => (job.requestHash === HASH ? [{ v: 1 }] : [{ v: 2 }]));
  // Drive the OTHER job through a normal create (a fresh pending job) to prove recovery does not disturb it.
  const ddCreates = { n: 0 };
  dd.create = async (job) => { ddCreates.n += 1; return { exportId: "exp-" + job.requestHash }; };
  const res = await worker.runSourceJobs({
    store, dataDoe: dd, bucket: "non-us", cycleDate: "2026-08-30",
    plannedJobs: [metaFor(HASH), { ...metaFor(OTHER), requestHash: OTHER, fetchParams: { sellerOrVendorIds: ["S2"], from: "2025-01-01", to: "2026-03-17", columns: ["date"], options: {} } }],
    recoverFailedDownloads: true,
  });
  assert.equal(store._raw(cid, HASH).fetch_status, "succeeded", "the failed job was recovered download-only");
  assert.equal(store._raw(cid, HASH).create_export_count, 1, "recovered job kept exactly one create");
  assert.equal(dd.counts.download >= 1, true);
  assert.equal(ddCreates.n, 1, "exactly ONE create -- for the fresh OTHER job, NOT the recovered one");
  assert.equal(store._raw(cid, OTHER).fetch_status, "succeeded");
  assert.ok(res.succeeded >= 2, "both jobs succeeded: " + res.succeeded);
});

test("C2. flag OFF (default): a failed job is left untouched (no download, no create) -- opt-in only", async () => {
  const store = makeStore();
  const cid = store.openCycle({ bucket: "non-us", cycleDate: "2026-08-30" });
  store._seedJob(cid, HASH, failedRow());
  const dd = makeDataDoe(() => [{ v: 1 }]);
  const res = await worker.runSourceJobs({ store, dataDoe: dd, bucket: "non-us", cycleDate: "2026-08-30", plannedJobs: [metaFor(HASH)] });
  assert.equal(store._raw(cid, HASH).fetch_status, "failed", "the failed job stays failed when recovery is off");
  assert.equal(dd.counts.download + dd.counts.create, 0, "no download, no create by default");
  assert.equal(res.processed, 0, "a failed job is not processed by default");
});

test("C3. flag ON but the failed job is TERMINAL: not recovered (no download, no create)", async () => {
  const store = makeStore();
  const cid = store.openCycle({ bucket: "non-us", cycleDate: "2026-08-30" });
  store._seedJob(cid, HASH, failedRow({ terminal: true, error_code: "TRUNCATED", error_stage: "validate" }));
  const dd = makeDataDoe(() => [{ v: 1 }]);
  await worker.runSourceJobs({ store, dataDoe: dd, bucket: "non-us", cycleDate: "2026-08-30", plannedJobs: [metaFor(HASH)], recoverFailedDownloads: true });
  assert.equal(store._raw(cid, HASH).fetch_status, "failed", "a terminal failure is never recovered");
  assert.equal(dd.counts.download + dd.counts.create, 0);
});

/* ================================= D. production wrapper shape ================================= */
group("D. claimSourceExportRecovery (production conditional PATCH)");

// Minimal fetch stub: capture the request + return a scripted response.
let capture = null;
let nextResponse = null;
const installFetch = () => {
  globalThis.fetch = async (url, options = {}) => {
    capture = { method: (options.method || "GET").toUpperCase(), url: String(url), headers: options.headers || {}, body: options.body ? JSON.parse(options.body) : null };
    const r = nextResponse || { status: 200, body: [] };
    return { ok: r.status >= 200 && r.status < 300, status: r.status, headers: { get: () => null }, json: async () => r.body, text: async () => JSON.stringify(r.body), clone() { return this; } };
  };
};

const matchRow = (over = {}) => ({ cycle_id: "cid-1", request_hash: HASH, fetch_status: "attempted", terminal: false, error_stage: "download", create_export_count: 1, export_id: EXPORT_ID, ...over });

test("D1. the PATCH binds the EXACT expected export_id in the filter + attempted body; a matching row => 'claimed'", async () => {
  installFetch();
  nextResponse = { status: 200, body: [matchRow()] };
  const ack = await sb.claimSourceExportRecovery("cid-1", HASH, EXPORT_ID);
  assert.equal(ack, "claimed");
  assert.equal(capture.method, "PATCH");
  assert.ok(capture.url.includes("/rest/v1/sync_source_jobs?"), "targets sync_source_jobs");
  assert.ok(capture.url.includes("cycle_id=eq.cid-1"), "scoped to the cycle");
  assert.ok(capture.url.includes("request_hash=eq." + HASH), "scoped to the request hash");
  assert.ok(capture.url.includes("fetch_status=eq.failed"), "only a FAILED row");
  assert.ok(/terminal=not\.is\.true/.test(capture.url), "only a NON-terminal row");
  assert.ok(/error_stage=in\.%28poll%2Cdownload%29|error_stage=in\.\(poll,download\)/.test(capture.url), "only poll/download stage");
  assert.ok(capture.url.includes("create_export_count=eq.1"), "only a single created export");
  assert.ok(capture.url.includes("export_id=eq." + EXPORT_ID), "the filter carries the EXACT expected export_id (a changed id can never be claimed)");
  assert.ok(!/export_id=not\.is\.null/.test(capture.url), "not the loose not-null filter");
  assert.deepEqual(capture.body, { fetch_status: "attempted" }, "sets ONLY fetch_status -> attempted (export_id + count preserved)");
  assert.equal(String(capture.headers.Prefer || ""), "return=representation", "asks for the updated representation to validate the winner");
});

test("D2. a NONCANONICAL expected id fails closed BEFORE any write; zero rows => 'not-eligible'; non-array => null", async () => {
  installFetch();
  capture = null;
  assert.equal(await sb.claimSourceExportRecovery("c", HASH, " " + EXPORT_ID + " "), null, "a whitespace-padded expected id is rejected without a request");
  assert.equal(capture, null, "no PATCH was issued for a noncanonical expected id");
  assert.equal(await sb.claimSourceExportRecovery("c", HASH, ""), null, "a blank expected id is rejected without a request");
  installFetch();
  nextResponse = { status: 200, body: [] };
  assert.equal(await sb.claimSourceExportRecovery("c", HASH, EXPORT_ID), "not-eligible", "zero rows updated (never matched / lost the race)");
  nextResponse = { status: 200, body: { not: "an array" } };
  assert.equal(await sb.claimSourceExportRecovery("c", HASH, EXPORT_ID), null, "a non-array response is null so the caller fails closed");
});

test("D3. the returned representation is validated EXACTLY: wrong-row / wrong-id / missing-field / multi-row => null", async () => {
  installFetch();
  nextResponse = { status: 200, body: [matchRow({ export_id: "exp-DIFFERENT" })] };
  assert.equal(await sb.claimSourceExportRecovery("cid-1", HASH, EXPORT_ID), null, "a returned export_id != expected fails closed (even one row)");
  nextResponse = { status: 200, body: [matchRow({ request_hash: "other-hash" })] };
  assert.equal(await sb.claimSourceExportRecovery("cid-1", HASH, EXPORT_ID), null, "a wrong-row request_hash fails closed");
  nextResponse = { status: 200, body: [matchRow({ fetch_status: "failed" })] };
  assert.equal(await sb.claimSourceExportRecovery("cid-1", HASH, EXPORT_ID), null, "a row not left 'attempted' fails closed");
  nextResponse = { status: 200, body: [matchRow({ terminal: true })] };
  assert.equal(await sb.claimSourceExportRecovery("cid-1", HASH, EXPORT_ID), null, "a terminal returned row fails closed");
  nextResponse = { status: 200, body: [matchRow({ create_export_count: 2 })] };
  assert.equal(await sb.claimSourceExportRecovery("cid-1", HASH, EXPORT_ID), null, "create_export_count != 1 fails closed");
  nextResponse = { status: 200, body: [matchRow(), matchRow()] };
  assert.equal(await sb.claimSourceExportRecovery("cid-1", HASH, EXPORT_ID), null, "a multi-row response fails closed");
});

test("D4. a MISSING required returned field (each) fails closed -- terminal is STRICT (===false; missing/undefined fails)", async () => {
  installFetch();
  // terminal must be EXACTLY false: undefined (missing) is NOT coerced to false.
  nextResponse = { status: 200, body: [matchRow({ terminal: undefined })] };
  assert.equal(await sb.claimSourceExportRecovery("cid-1", HASH, EXPORT_ID), null, "a MISSING terminal field fails closed (strict === false)");
  nextResponse = { status: 200, body: [matchRow({ terminal: null })] };
  assert.equal(await sb.claimSourceExportRecovery("cid-1", HASH, EXPORT_ID), null, "a null terminal fails closed");
  nextResponse = { status: 200, body: [matchRow({ error_stage: "validate" })] };
  assert.equal(await sb.claimSourceExportRecovery("cid-1", HASH, EXPORT_ID), null, "a non-poll/download error_stage fails closed");
  // Every OTHER required field: omitting it must fail closed.
  for (const field of ["cycle_id", "request_hash", "fetch_status", "error_stage", "create_export_count", "export_id", "terminal"]) {
    const row = matchRow();
    delete row[field];
    nextResponse = { status: 200, body: [row] };
    assert.equal(await sb.claimSourceExportRecovery("cid-1", HASH, EXPORT_ID), null, "a missing " + field + " field fails closed");
  }
});

/* ================================= E. real five-seller batch validation ================================= */
group("E. real five-seller batch validation on the recovered download (real OLI plan: seller-scoped, no marketplace)");

async function recoverWithPayload(payload, { seedLkg = [{ good: 1 }] } = {}) {
  const R = realPlan();
  const store = makeStore();
  const cid = seededCycle(store);
  store._seedCache(R.targetHash, seedLkg);
  store._seedJob(cid, R.targetHash, failedRow({ request_hash: R.targetHash }));
  const dd = makeDataDoe(() => payload);
  const outcome = await worker.recoverFailedDownloadJob({ store, dataDoe: dd, clock: () => 1, cycleId: cid, meta: R.meta, jobRow: store._snapshot(cid, R.targetHash), runWithDeadline: noDeadline });
  return { store, cid, dd, outcome, hash: R.targetHash };
}

test("E1. a valid five-seller payload recovers to success (real seller validation passes); zero creates", async () => {
  const { store, cid, dd, outcome, hash } = await recoverWithPayload(okPayload5());
  assert.equal(outcome.status, "success", JSON.stringify(outcome).slice(0, 120));
  assert.equal(outcome.validated, true);
  assert.equal(dd.counts.create, 0);
  assert.equal(dd.counts.download, 1);
  assert.equal(store._raw(cid, hash).fetch_status, "succeeded");
  assert.equal(store._cache.get(hash).rows.length, 5, "the validated five-seller payload was saved");
});

const LKG = [{ good: 1 }];
for (const [name, payloadFn, code] of [
  ["E2 unknown/cross-account seller", () => [...okPayload5(), okRow("S99")], "BATCH_CROSS_ACCOUNT"],
  ["E3 blank seller", () => [okRow(""), ...okPayload5().slice(1)], "BATCH_ROW_NO_SELLER"],
  ["E4 a malformed (non-object) payload member", () => [...okPayload5(), 42], "MALFORMED_PAYLOAD"],
]) {
  test(name + " rejects the WHOLE recovered payload; LKG byte-identical; zero creates", async () => {
    const { store, cid, dd, outcome, hash } = await recoverWithPayload(payloadFn(), { seedLkg: LKG });
    assert.equal(outcome.validated, false, name + " must not validate");
    assert.equal(outcome.code, code, name + " code (got " + outcome.code + ")");
    assert.equal(dd.counts.create, 0, "zero creates on rejection");
    assert.deepEqual(store._cache.get(hash).rows, LKG, "LKG cache byte-identical after rejection");
    assert.equal(store._raw(cid, hash).fetch_status, "failed");
    assert.equal(store._raw(cid, hash).terminal, true, "a batch-invalid recovery is terminal");
  });
}

test("E5. a TRUNCATED five-seller payload rejects; LKG byte-identical; zero creates", async () => {
  const R = realPlan();
  const truncated = Array.from({ length: R.meta.limit }, (_v, i) => okRow(R.sellers[i % 5]));
  const { store, dd, outcome, hash } = await recoverWithPayload(truncated, { seedLkg: LKG });
  assert.equal(outcome.code, "TRUNCATED");
  assert.equal(dd.counts.create, 0);
  assert.deepEqual(store._cache.get(hash).rows, LKG, "LKG preserved on truncation");
});

/* ================================= F. trusted operator composition ================================= */
group("F. buildNonUsOliDownloadRecovery -- trusted operator over the REAL plan + exact five-owner binding");

function operatorFixture(over = {}) {
  const R = realPlan();
  const hash = over.hash || R.targetHash;
  const store = makeStore();
  store._seedCache(hash, over.lkg || [{ good: 1 }]);
  store._seedJob(C.cycleId, hash, failedRow({ request_hash: hash, request_meta: { from: C.windowFrom, to: C.windowTo }, ...(over.rowOver || {}) }));
  store._seedOwners(C.cycleId, over.owners || durableOwnersFromPlan(hash));
  const dd = makeDataDoe(over.download || okPayload5);
  const plannedOliJobs = over.plannedOliJobs !== undefined ? over.plannedOliJobs : R.oli.plannedJobs;
  const op = opmod.buildNonUsOliDownloadRecovery({ store, dataDoe: dd, plannedOliJobs, clock: () => 1 });
  return { store, dd, op, hash };
}

test("F1. the operator verifies the REAL target then reaches the real recovery code: success, zero creates", async () => {
  const { store, dd, op, hash } = operatorFixture();
  const res = await op.run();
  assert.equal(res.status, "ran", JSON.stringify(res).slice(0, 200));
  assert.equal(res.outcome.status, "success", "recovered via recoverFailedDownloadJob + validateBatchSourcePayload over the real plan");
  assert.equal(res.outcome.validated, true);
  assert.equal(dd.counts.create, 0, "the operator NEVER creates an export");
  assert.equal(dd.counts.download, 1, "exactly one download");
  assert.equal(store._raw(C.cycleId, hash).fetch_status, "succeeded");
});

const planMap = (fn) => realPlan().plannedForHash.map(fn);
// The `over` is a THUNK (built lazily inside the test) so the real planner is only called after imports.
for (const [name, overFn, expectReason] of [
  ["F2a two eligible failed jobs", () => ({ setup: (f) => { f.store._seedJob(C.cycleId, "OTHER-HASH", failedRow({ request_hash: "OTHER-HASH" })); } }), "expected-exactly-one-eligible"],
  ["F2b terminal target (zero eligible)", () => ({ rowOver: { terminal: true } }), "expected-exactly-one-eligible"],
  ["F2c wrong error_stage", () => ({ rowOver: { error_stage: "poll" } }), "row-field-mismatch:error_stage"],
  ["F2d wrong error_code", () => ({ rowOver: { error_code: "OTHER" } }), "row-field-mismatch:error_code"],
  ["F2e wrong window", () => ({ rowOver: { request_meta: { from: "2025-01-01", to: "2026-03-17" } } }), "row-field-mismatch:window"],
  ["F2f planned owner count != 5", () => ({ plannedOliJobs: realPlan().plannedForHash.slice(0, 4) }), "planned-owner-count"],
  ["F2g planned identity divergent", () => ({ plannedOliJobs: planMap((p, i) => (i === 0 ? { ...p, fetchParams: { ...p.fetchParams, columns: ["date"] } } : p)) }), "planned-identity-divergent"],
  ["F2h planned window mismatch", () => ({ plannedOliJobs: planMap((p) => ({ ...p, fetchParams: { ...p.fetchParams, from: "2025-01-01", to: "2026-03-17" } })) }), "planned-window"],
  ["F2i planned seller count != 5", () => ({ plannedOliJobs: planMap((p) => ({ ...p, fetchParams: { ...p.fetchParams, sellerOrVendorIds: p.fetchParams.sellerOrVendorIds.slice(0, 4) } })) }), "planned-seller-count"],
  ["F2j planned not seller-scoped", () => ({ plannedOliJobs: planMap((p) => ({ ...p, sourceScope: "organization" })) }), "planned-source-scope"],
  ["F2k planned marketplaceScoped=true (invented)", () => ({ plannedOliJobs: planMap((p) => ({ ...p, marketplaceScoped: true })) }), "planned-marketplace-scoped"],
  ["F2l planned owner seller mismatch", () => ({ plannedOliJobs: planMap((p, i) => (i === 0 ? { ...p, owner: { ...p.owner, rawSellerId: "ZZZ" } } : p)) }), "planned-owner-seller-mismatch"],
  ["F2m durable owner count != 5", () => ({ owners: durableOwnersFromPlan().slice(0, 4) }), "owner-count"],
  ["F2n durable owner stale", () => ({ owners: durableOwnersFromPlan().map((o, i) => (i === 0 ? { ...o, owner_status: "stale" } : o)) }), "owner-not-active"],
  ["F2o durable owner not primary", () => ({ owners: durableOwnersFromPlan().map((o, i) => (i === 0 ? { ...o, connection_id: "dd-secondary" } : o)) }), "owner-not-primary"],
  ["F2p durable owner_id not unique", () => ({ owners: durableOwnersFromPlan().map((o) => ({ ...o, owner_id: "dup" })) }), "owner-id-not-unique"],
  ["F2q durable owner account mismatch", () => ({ owners: durableOwnersFromPlan().map((o, i) => (i === 0 ? { ...o, account_id: "WRONG-ACC" } : o)) }), "owner-account-mismatch"],
]) {
  test("F2. refuses (" + name + ") without downloading/creating; job left failed", async () => {
    const over = overFn();
    const f = operatorFixture(over);
    if (over.setup) over.setup(f);
    const res = await f.op.run();
    assert.equal(res.status, "refused", name + " => refused (got " + JSON.stringify(res).slice(0, 140) + ")");
    assert.ok(String(res.reason).startsWith(expectReason), name + ": reason '" + res.reason + "' ~ '" + expectReason + "'");
    assert.equal(f.dd.counts.download, 0, name + ": no download on refusal");
    assert.equal(f.dd.counts.create, 0, name + ": no create on refusal");
    assert.equal(f.store._raw(C.cycleId, f.hash).fetch_status, "failed", name + ": the target is left failed (untouched)");
  });
}

/* ================================= G. resume / commit-unknown / loop / disabled ================================= */
group("G. resume, commit-unknown, no-loop, and disabled-is-byte-identical proofs");

test("G1. a commit-unknown claim is NOT reported as committed or success (fail closed, nothing fabricated)", async () => {
  const store = makeStore();
  const cid = seededCycle(store);
  store._seedJob(cid, HASH, failedRow());
  store.claimSourceExportRecovery = async () => { const e = new Error("route budget expired mid-write"); e.commitUnknown = true; throw e; };
  const dd = makeDataDoe(() => [{ v: 1 }]);
  const outcome = await worker.recoverFailedDownloadJob({ store, dataDoe: dd, clock: () => 1, cycleId: cid, meta: metaFor(HASH), jobRow: store._snapshot(cid, HASH), runWithDeadline: noDeadline });
  assert.equal(outcome.status, "recovery-skipped", "a commit-unknown claim is never reported as success");
  assert.notEqual(outcome.status, "success");
  assert.equal(outcome.validated, false, "never validated on claim uncertainty");
  assert.equal(dd.counts.download + dd.counts.create, 0, "no download/create after an uncertain claim");
});

test("G2. an 'attempted' row with a saved export_id resumes normally after claim uncertainty -> success (no create)", async () => {
  const store = makeStore();
  const cid = store.openCycle({ bucket: "non-us", cycleDate: "2026-08-30" });
  store._seedJob(cid, HASH, failedRow({ fetch_status: "attempted", error_stage: null, error_code: null }));
  const dd = makeDataDoe(() => [{ v: 1 }]);
  await worker.runSourceJobs({ store, dataDoe: dd, bucket: "non-us", cycleDate: "2026-08-30", plannedJobs: [metaFor(HASH)] });
  assert.equal(store._raw(cid, HASH).fetch_status, "succeeded", "the attempted row resumed download-only to success");
  assert.equal(dd.counts.create, 0, "resume never creates");
  assert.equal(dd.counts.download, 1);
});

test("G3. no repeated download loop: a second operator run finds zero eligible and refuses (zero extra downloads)", async () => {
  const { dd, op } = operatorFixture();
  await op.run(); // recovers to success
  const dlAfterFirst = dd.counts.download;
  const res2 = await op.run();
  assert.equal(res2.status, "refused");
  assert.equal(res2.reason, "expected-exactly-one-eligible");
  assert.equal(res2.eligibleCount, 0, "the recovered job is no longer eligible");
  assert.equal(dd.counts.download, dlAfterFirst, "no additional download on the second run");
});

test("G4. recovery DISABLED (default) is byte-identical: a pending job creates+downloads+succeeds normally", async () => {
  const store = makeStore();
  const dd = makeDataDoe(() => [{ v: 1 }]);
  let creates = 0;
  dd.create = async (job) => { creates += 1; return { exportId: "exp-" + job.requestHash }; };
  const res = await worker.runSourceJobs({ store, dataDoe: dd, bucket: "non-us", cycleDate: "2026-08-30", plannedJobs: [metaFor(HASH)] });
  assert.equal(creates, 1, "the pending job created exactly one export (normal path unchanged)");
  assert.equal(res.succeeded, 1);
});

/* ================================= H. real bounded DataDoe deadline ================================= */
group("H. the operator threads a REAL bounded DataDoe deadline through poll + download");

// Build the operator with an ALREADY-EXPIRED deadline (clock far in the past => deadlineAt < real now), so the
// production sleep()/deadline mechanism inside a hung poll/download aborts typed-resumable. If the operator did
// NOT thread withDataDoeDeadline, sleep() would see no deadline and resolve (the assertion would then fail).
function expiredOperator(hangStage) {
  const R = realPlan();
  const store = makeStore();
  store._seedCache(R.targetHash, [{ good: 1 }]);
  store._seedJob(C.cycleId, R.targetHash, failedRow({ request_hash: R.targetHash, request_meta: { from: C.windowFrom, to: C.windowTo } }));
  store._seedOwners(C.cycleId, durableOwnersFromPlan(R.targetHash));
  const dd = makeDataDoe(okPayload5);
  if (hangStage === "poll") dd.poll = async () => { dd.counts.poll += 1; await datadoe.sleep(60_000); };
  if (hangStage === "download") dd.download = async () => { dd.counts.download += 1; await datadoe.sleep(60_000); };
  const op = opmod.buildNonUsOliDownloadRecovery({ store, dataDoe: dd, plannedOliJobs: R.oli.plannedJobs, clock: () => Date.now() - C.budgetMs });
  return { store, dd, op, hash: R.targetHash };
}

test("H1. a HUNG poll is bounded typed-resumable; zero creates; download never runs; no ghost cache/success write", async () => {
  const { store, dd, op, hash } = expiredOperator("poll");
  const res = await op.run();
  assert.equal(res.status, "ran");
  assert.equal(res.outcome.status, "deferred", "a hung poll returns bounded typed-resumable (not success/failed)");
  assert.equal(res.outcome.resumable, true);
  assert.equal(dd.counts.create, 0, "zero creates");
  assert.equal(dd.counts.download, 0, "download never reached after a bounded poll");
  assert.equal(store._cache.get(hash).rows.length, 1, "no ghost cache write (LKG intact)");
  assert.equal(store._raw(C.cycleId, hash).fetch_status, "attempted", "left resumable (claimed); no success/failure recorded");
});

test("H2. a HUNG download is bounded typed-resumable; zero creates; no ghost cache/success write", async () => {
  const { store, dd, op, hash } = expiredOperator("download");
  const res = await op.run();
  assert.equal(res.status, "ran");
  assert.equal(res.outcome.status, "deferred", "a hung download returns bounded typed-resumable");
  assert.equal(res.outcome.resumable, true);
  assert.equal(dd.counts.create, 0, "zero creates");
  assert.equal(store._cache.get(hash).rows.length, 1, "no ghost cache write (LKG intact)");
  assert.equal(store._raw(C.cycleId, hash).fetch_status, "attempted", "left resumable; no success recorded");
});

/* ================================= I. honest operator exit ================================= */
group("I. recoveryExitDecision -- release automation cannot continue past a non-success");

test("I1. exit 0 ONLY for ran+success+validated; every other class exits nonzero with redacted evidence", () => {
  assert.equal(opmod.recoveryExitDecision({ status: "ran", requestHash: "h", outcome: { status: "success", validated: true, rowCount: 5 } }).code, 0, "genuine success => 0");
  const nonSuccess = [
    { status: "refused", reason: "owner-account-mismatch" },
    { status: "ran", outcome: { status: "success", validated: false } },
    { status: "ran", outcome: { status: "deferred", validated: false, resumable: true } },
    { status: "ran", outcome: { status: "failed", validated: false, code: "SAVE_FAILED" } },
    { status: "ran", outcome: { status: "terminal", validated: false, code: "TRUNCATED" } },
    { status: "ran", outcome: { status: "recovery-skipped", validated: false, reason: "not-eligible" } },
    { status: "ran", outcome: null },
    { status: "ran" },
    {},
    null,
  ];
  for (const r of nonSuccess) {
    const d = opmod.recoveryExitDecision(r);
    assert.equal(d.code, 1, "non-success => nonzero: " + JSON.stringify(r).slice(0, 70));
    assert.equal(d.ok, false);
    assert.ok(!Object.keys(d.evidence).some((k) => /seller|export_?id|payload|apikey|secret|token/i.test(k)), "evidence carries no sensitive keys");
  }
});

test("I2. a subprocess entrypoint exits 0 on success and NONZERO on every non-success class", () => {
  const opUrl = new URL("../lib/server/sync/source-oli-recovery-operation.js", import.meta.url).href;
  const runExit = (res) => {
    const code = "import(process.env.OP).then(m=>{const d=m.recoveryExitDecision(JSON.parse(process.env.RES));process.stdout.write(JSON.stringify({ok:d.ok}));process.exit(d.code);}).catch(()=>process.exit(2));";
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { env: { ...process.env, OP: opUrl, RES: JSON.stringify(res) }, encoding: "utf8" });
    return r.status;
  };
  assert.equal(runExit({ status: "ran", requestHash: "h", outcome: { status: "success", validated: true } }), 0, "success entrypoint exits 0");
  assert.notEqual(runExit({ status: "refused", reason: "owner-count" }), 0, "refusal entrypoint exits nonzero");
  assert.notEqual(runExit({ status: "ran", outcome: { status: "deferred", validated: false } }), 0, "deferred entrypoint exits nonzero");
  assert.notEqual(runExit({ status: "ran", outcome: { status: "terminal", validated: false } }), 0, "terminal entrypoint exits nonzero");
  assert.notEqual(runExit({ status: "ran", outcome: null }), 0, "missing-outcome entrypoint exits nonzero");
});

async function main() {
  out("source download-only recovery proof suite");
  worker = await import("../lib/server/sync/source-worker.js");
  sb = await import("../lib/server/supabase.js");
  opmod = await import("../lib/server/sync/source-oli-recovery-operation.js");
  bucketSync = await import("../lib/server/sync/source-bucket-sync.js");
  datadoe = await import("../lib/server/datadoe.js");
  C = opmod.NONUS_OLI_DOWNLOAD_RECOVERY;
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
