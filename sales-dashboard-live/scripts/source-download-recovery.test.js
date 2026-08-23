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
  ...over,
});

// ---- in-memory source store (models the atomic recovery CAS + the save/success/failure + LKG cache) ----
function makeStore() {
  const cycles = new Map();
  const jobsByCycle = new Map();
  const cache = new Map(); // requestHash -> { rows, object_path } (durable LKG)
  let seq = 0;
  const findCycle = (id) => [...cycles.values()].find((c) => c.id === id) || null;
  const jmap = (cid) => jobsByCycle.get(cid);
  const raw = (cid, hash) => jmap(cid) && jmap(cid).get(hash);
  return {
    _cache: cache,
    _raw: raw,
    _snapshot: (cid, hash) => ({ ...raw(cid, hash) }),
    _seedCache: (hash, rows) => { cache.set(hash, { rows: [...rows], object_path: "source-cache/v2/" + hash + "/good.json" }); },
    _seedJob: (cid, hash, row) => { jmap(cid).set(hash, { ...row, request_hash: hash }); },
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
    // The atomic recovery CAS (models the conditional PATCH): flips a still-eligible-failed row to 'attempted'
    // (preserving export_id + create_export_count). check+flip is synchronous => atomic (one winner).
    async claimSourceExportRecovery({ cycleId, requestHash }) {
      const j = raw(cycleId, requestHash);
      if (!j) return "not-eligible";
      const e = worker.recoveryEligibility(j);
      if (!e.eligible) return "not-eligible"; // includes "already attempted by a concurrent winner"
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

test("D1. issues a conditional PATCH on sync_source_jobs with the EXACT eligibility filters + attempted body", async () => {
  installFetch();
  nextResponse = { status: 200, body: [{ request_hash: HASH }] }; // one row updated
  const ack = await sb.claimSourceExportRecovery("cid-1", HASH);
  assert.equal(ack, "claimed");
  assert.equal(capture.method, "PATCH");
  assert.ok(capture.url.includes("/rest/v1/sync_source_jobs?"), "targets sync_source_jobs");
  assert.ok(capture.url.includes("cycle_id=eq.cid-1"), "scoped to the cycle");
  assert.ok(capture.url.includes("request_hash=eq." + HASH), "scoped to the request hash");
  assert.ok(capture.url.includes("fetch_status=eq.failed"), "only a FAILED row");
  assert.ok(/terminal=not\.is\.true/.test(capture.url), "only a NON-terminal row");
  assert.ok(/error_stage=in\.%28poll%2Cdownload%29|error_stage=in\.\(poll,download\)/.test(capture.url), "only poll/download stage");
  assert.ok(capture.url.includes("create_export_count=eq.1"), "only a single created export");
  assert.ok(/export_id=not\.is\.null/.test(capture.url), "only a job with a saved export_id");
  assert.deepEqual(capture.body, { fetch_status: "attempted" }, "sets ONLY fetch_status -> attempted (export_id + count preserved)");
  assert.equal(String(capture.headers.Prefer || ""), "return=representation", "asks for the updated representation to count winners");
});

test("D2. exactly one updated row => 'claimed'; zero rows => 'not-eligible'; non-array => null (fail closed)", async () => {
  installFetch();
  nextResponse = { status: 200, body: [{ request_hash: HASH }] };
  assert.equal(await sb.claimSourceExportRecovery("c", HASH), "claimed");
  nextResponse = { status: 200, body: [] };
  assert.equal(await sb.claimSourceExportRecovery("c", HASH), "not-eligible", "zero rows updated (never matched / lost the race)");
  nextResponse = { status: 200, body: { not: "an array" } };
  assert.equal(await sb.claimSourceExportRecovery("c", HASH), null, "a non-array response is null so the caller fails closed");
});

async function main() {
  out("source download-only recovery proof suite");
  worker = await import("../lib/server/sync/source-worker.js");
  sb = await import("../lib/server/supabase.js");
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
