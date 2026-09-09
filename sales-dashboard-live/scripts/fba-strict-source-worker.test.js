// Scheduler v2 -- FBA strict-cap + latest-snapshot source-worker integration test (SHADOW MODE).
//
// One small, independently-readable ESM artifact (the content scanner reads it directly). Proves how the
// Scheduler-v2 `strict:true` flag on the source contracts reaches the real source worker guard:
//   * A NON-latest-snapshot strict source (product-catalog) whose result reaches the row cap is recorded as
//     TRUNCATED, persists NO source payload -- the GENERIC validator is UNCHANGED.
//   * A SINGLE-seller fba-inventory-health payload is normalized to its LATEST snapshot date: a cap-sized
//     payload with a complete leading latest date is COMPACTED to that date and persisted (only latest-date
//     rows); a cap-sized payload whose latest date itself fills the cap is a HARD STOP recorded as
//     LATEST_SNAPSHOT_INCOMPLETE, persisting nothing. Neither blocks an unrelated source in the same batch,
//     and a terminal one is not attempted again on a repeated worker run.
// Self-contained: a lean in-memory store + DataDoe double drive the real runSourceJobs; no DataDoe/Supabase/
// network calls, no process.exit, no timers.
//
// 7-bit ASCII, LF, no top-level await, synchronous writeSync progress, dynamic imports after a dummy
// Supabase env. No secret-shaped literals.

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
let runSourceJobs, reportSourceRequestHashes, plannedSourceJob;

// A lean in-memory source store implementing exactly the interface runSourceJobs calls. `_cache`
// holds persisted source payloads (a TRUNCATED source must never appear here); `_rawJob` exposes the
// recorded job row for status/error assertions.
function makeStore() {
  const cycles = new Map();
  const jobsByCycle = new Map();
  const cache = new Map();
  let seq = 0;
  const findCycle = (id) => [...cycles.values()].find((c) => c.id === id) || null;
  return {
    _cache: cache,
    _rawJob(cycleId, hash) { return jobsByCycle.get(cycleId) && jobsByCycle.get(cycleId).get(hash); },
    openCycle({ bucket, cycleDate }) {
      const key = bucket + "|" + cycleDate;
      if (!cycles.has(key)) { const id = "cyc_" + (seq += 1); cycles.set(key, { id, bucket, cycle_date: cycleDate, status: "pending" }); jobsByCycle.set(id, new Map()); }
      return cycles.get(key).id;
    },
    claimCycle(id) { const c = findCycle(id); if (c && c.status === "pending") { c.status = "running"; return true; } return false; },
    getCycle(id) { return findCycle(id); },
    upsertSourceJob(job) {
      const m = jobsByCycle.get(job.cycleId);
      if (m.has(job.requestHash)) return;
      m.set(job.requestHash, {
        request_hash: job.requestHash, request_key: job.requestKey, source_id: job.sourceId, source_key: job.sourceKey,
        connection_id: job.connectionId, fetch_status: "pending", attempted_at: null, create_export_count: 0,
        export_id: null, terminal: false, error_stage: null, error_code: null, error_message: null, row_count: null, cache_object_path: null,
      });
    },
    listSourceJobs(id) { return [...((jobsByCycle.get(id) && jobsByCycle.get(id).values()) || [])].map((j) => ({ ...j })); },
    claimExportAttempt(id, hash) {
      const j = jobsByCycle.get(id) && jobsByCycle.get(id).get(hash);
      if (j && j.attempted_at === null) { j.attempted_at = "t"; j.create_export_count += 1; j.fetch_status = "attempted"; return true; }
      return false;
    },
    recordExportCreated({ cycleId, requestHash, exportId }) { jobsByCycle.get(cycleId).get(requestHash).export_id = exportId; },
    loadSourceRows(hash) { const e = cache.get(hash); return e ? { rows: e.rows } : null; },
    saveSourceRows({ job, rows, version }) {
      const hash = job.request_hash != null ? job.request_hash : job.requestHash;
      const path = "source-cache/v2/" + hash + "/" + version + ".json";
      cache.set(hash, { rows: [...rows], object_path: path });
      return path;
    },
    recordSourceSuccess({ cycleId, requestHash, exportId, rowCount, cacheObjectPath }) {
      Object.assign(jobsByCycle.get(cycleId).get(requestHash), { fetch_status: "succeeded", export_id: exportId, row_count: rowCount, cache_object_path: cacheObjectPath, error_stage: null, error_code: null });
    },
    recordSourceFailure({ cycleId, requestHash, stage, code, message, terminal, rowCount, exportId }) {
      const j = jobsByCycle.get(cycleId).get(requestHash);
      Object.assign(j, { fetch_status: "failed", error_stage: stage, error_code: code, error_message: message, terminal: !!terminal });
      if (rowCount != null) j.row_count = rowCount;
      if (exportId != null) j.export_id = exportId;
    },
    updateCycleCounts() { /* counts not asserted here */ },
  };
}

// DataDoe double: `rowsFor(job)` supplies the downloaded rows; create/download call counts are tracked
// so a repeated run can prove the truncated export is never attempted again.
function makeDataDoe(rowsFor) {
  const counts = { create: {}, download: {} };
  const bump = (m, h) => { counts[m][h] = (counts[m][h] || 0) + 1; };
  return {
    createCount: (h) => counts.create[h] || 0,
    downloadCount: (h) => counts.download[h] || 0,
    async create(job) { bump("create", job.requestHash); return { exportId: "exp_" + job.requestHash }; },
    async poll() { /* completes immediately */ },
    async download(job) { bump("download", job.requestHash); return rowsFor(job); },
  };
}

const runOpts = (over) => ({ bucket: "us", cycleDate: "2026-08-07", ...over });

// A single-seller fba-plan inventory source (CA, non-US -> owns ONLY inventory-health). marketplaceConstraint "CA"
// so the worker's latest-snapshot compaction validates each block row against the trusted seller + marketplace.
function invJob(ids = ["A1"], marketplace = "CA") {
  const resolved = reportSourceRequestHashes({ reportKey: "fba-plan", apiKey: "k", ids, windowsByRequestKey: { "fba-plan:inventory-health": [{ from: "2025-07-27", to: "2025-08-06" }] }, marketplaceCountry: marketplace });
  const src = resolved.find((r) => r.requestKey === "fba-plan:inventory-health");
  assert.equal(src.strict, true, "the fba-plan:inventory-health contract is strict:true");
  assert.equal(src.sourceKey, "fba-inventory-health", "the inventory contract's sourceKey is the latest-snapshot key");
  // plannedSourceJob(reportKey, resolved, bucket, connectionId, accountId, ownerRawSellerId, marketplaceConstraint)
  return { src, job: plannedSourceJob("fba-plan", src, "us", "primary", "acct-A1", "A1", marketplace) };
}
// An UNRELATED healthy source (brand-sales:catalog) in the same batch -- returns one row and must always succeed.
function healthyOther() {
  const bs = reportSourceRequestHashes({ reportKey: "brand-sales", apiKey: "k", ids: ["A1"], windowsByRequestKey: { "brand-sales:order-lines": [{ from: "2025-01-01", to: "2025-06-30" }], "brand-sales:catalog": [{ from: "2025-01-01", to: "2025-06-30" }] } });
  return plannedSourceJob("brand-sales", bs.find((r) => r.requestKey === "brand-sales:catalog"), "us", "primary");
}
const invRow = (date, seller = "A1", mkt = "CA", extra = {}) => ({ date, seller_or_vendor_id: seller, marketplace_country_code: mkt, ...extra });

group("source worker: generic strict cap + FBA latest-snapshot compaction");

test("GENERIC strict validator UNCHANGED: a cap-sized NON-inventory source (product-catalog) records TRUNCATED, persists nothing", async () => {
  const store = makeStore();
  // brand-sales:catalog is strict:true, sourceKey product-catalog (NOT a latest-snapshot source), limit 10000.
  const bs = reportSourceRequestHashes({ reportKey: "brand-sales", apiKey: "k", ids: ["A1"], windowsByRequestKey: { "brand-sales:order-lines": [{ from: "2025-01-01", to: "2025-06-30" }], "brand-sales:catalog": [{ from: "2025-01-01", to: "2025-06-30" }] } });
  const catSrc = bs.find((r) => r.requestKey === "brand-sales:catalog");
  assert.equal(catSrc.strict, true);
  assert.notEqual(catSrc.sourceKey, "fba-inventory-health");
  const cat = plannedSourceJob("brand-sales", catSrc, "us", "primary");
  const cappedRows = Array.from({ length: cat.limit }, () => ({})); // rows.length === limit => truncation, rejected
  const dd = makeDataDoe(() => cappedRows);
  const res = await runSourceJobs(runOpts({ store, dataDoe: dd, plannedJobs: [cat] }));
  const j = store._rawJob(res.cycleId, catSrc.requestHash);
  assert.equal(j.error_code, "TRUNCATED", "a non-latest-snapshot cap-sized source is still generic TRUNCATED");
  assert.equal(j.error_stage, "validate");
  assert.equal(j.terminal, true);
  assert.equal(store._cache.has(catSrc.requestHash), false, "nothing persisted for the truncated catalog");
  assert.equal(res.failed, 1);
});

test("FBA latest-snapshot HARD STOP: a single-seller inventory payload whose latest date fills the cap records LATEST_SNAPSHOT_INCOMPLETE, persists nothing, unrelated source succeeds, and is not re-attempted", async () => {
  const store = makeStore();
  const { src: fbaSrc, job: capped } = invJob(["A1"], "CA");
  const other = healthyOther();

  // The cap-sized payload is ENTIRELY the latest date -> the latest-date block itself fills the row cap (no older
  // date can prove it was not truncated mid-latest-date): a genuine single-seller latest-date overflow = hard stop.
  const cappedRows = Array.from({ length: capped.limit }, () => invRow("2026-09-05"));
  const dd = makeDataDoe((job) => (job.requestHash === fbaSrc.requestHash ? cappedRows : [{ ok: 1 }]));
  const res = await runSourceJobs(runOpts({ store, dataDoe: dd, plannedJobs: [capped, other] }));

  const cappedJob = store._rawJob(res.cycleId, fbaSrc.requestHash);
  assert.equal(cappedJob.error_code, "LATEST_SNAPSHOT_INCOMPLETE", "an unprovable single-seller latest date is a terminal hard stop");
  assert.equal(cappedJob.error_stage, "validate");
  assert.equal(cappedJob.terminal, true);
  assert.equal(cappedJob.row_count, capped.limit, "the raw cap count is recorded");
  assert.equal(store._cache.has(fbaSrc.requestHash), false, "no source payload persisted for the hard-stopped inventory");
  // The unrelated source completes and persists (one source failing never blocks another).
  assert.equal(store._cache.has(other.requestHash), true, "the unrelated source persisted its payload");
  assert.equal(store._rawJob(res.cycleId, other.requestHash).fetch_status, "succeeded");
  assert.equal(res.failed, 1);
  assert.equal(res.succeeded, 1);

  // A repeated worker run must NOT attempt the terminal export again.
  const downloadsBefore = dd.downloadCount(fbaSrc.requestHash);
  const res2 = await runSourceJobs(runOpts({ store, dataDoe: dd, plannedJobs: [capped, other] }));
  assert.equal(dd.downloadCount(fbaSrc.requestHash), downloadsBefore, "the terminal inventory export is not downloaded again");
  assert.equal(dd.createCount(fbaSrc.requestHash), 1, "exactly one create-export ever issued for the terminal source");
  assert.equal(res2.processed, 0, "no pending/attempted jobs remain to process on the repeat run");
});

test("FBA latest-snapshot COMPACTION: a cap-sized single-seller inventory payload with a complete leading latest date is compacted to that date and persisted (only latest-date rows)", async () => {
  const store = makeStore();
  const { src: fbaSrc, job } = invJob(["A1"], "CA");

  // A cap-sized payload (rows.length === limit) whose latest date is a small COMPLETE leading block, followed by a
  // strictly-older date (which proves the latest block was not itself truncated). DataDoe returns date-DESC.
  const LATEST_N = 3;
  const rows = [
    ...Array.from({ length: LATEST_N }, (_, i) => invRow("2026-09-05", "A1", "CA", { sku: `S${i}`, units: i === 0 ? 0 : i })),
    ...Array.from({ length: job.limit - LATEST_N }, () => invRow("2026-09-04")),
  ];
  assert.equal(rows.length, job.limit, "the payload is cap-sized (indistinguishable from truncation without the proof)");
  const dd = makeDataDoe(() => rows);
  const res = await runSourceJobs(runOpts({ store, dataDoe: dd, plannedJobs: [job] }));

  const j = store._rawJob(res.cycleId, fbaSrc.requestHash);
  assert.equal(j.fetch_status, "succeeded", "the latest date was provably complete -> success");
  assert.equal(j.row_count, LATEST_N, "only the latest-date rows were persisted (compacted), not the cap-sized raw");
  const cached = store.loadSourceRows(fbaSrc.requestHash);
  assert.ok(cached && Array.isArray(cached.rows), "the compacted payload is cached");
  assert.equal(cached.rows.length, LATEST_N, "the cache holds only the latest-date block");
  assert.ok(cached.rows.every((r) => r.date === "2026-09-05"), "every cached row is the latest date (no summing across dates)");
  assert.equal(cached.rows.find((r) => r.sku === "S0").units, 0, "a zero inventory value is preserved verbatim");
  assert.equal(res.succeeded, 1);
  assert.equal(res.failed, 0);
});

group("source worker: FBA latest-snapshot EMPTY = valid-empty inventory-unavailable (single/multi-seller parity, defect 2)");

// A single-seller EXACT D-1 (from===to) inventory job. BEFORE the fix an empty response was a terminal
// LATEST_SNAPSHOT_INCOMPLETE hard stop (blocking the whole report); AFTER the fix it is a valid-empty SUCCESS
// (rowCount 0) typed inventory-unavailable -- CONSISTENT with a multi-seller batch's zero-row valid-empty, so
// splitting a seller no longer flips a successful empty inventory export from valid-empty to blocked.
function invJobD1(ids, marketplace, day) {
  const resolved = reportSourceRequestHashes({ reportKey: "fba-plan", apiKey: "k", ids, windowsByRequestKey: { "fba-plan:inventory-health": [{ from: day, to: day }] }, marketplaceCountry: marketplace });
  const src = resolved.find((r) => r.requestKey === "fba-plan:inventory-health");
  return { src, job: plannedSourceJob("fba-plan", src, "us", "primary", "acct-" + ids[0], ids[0], marketplace) };
}

test("EMPTY single-seller D-1 inventory export is a valid-empty SUCCESS (rowCount 0), NOT a LATEST_SNAPSHOT_INCOMPLETE hard stop (defect 2 reproduction)", async () => {
  const store = makeStore();
  const { src, job } = invJobD1(["A1"], "CA", "2026-09-08");
  assert.deepEqual(job.fetchParams.sellerOrVendorIds, ["A1"], "single-seller job (drives the latest-snapshot compaction path)");
  const dd = makeDataDoe(() => []); // a successfully-completed export that returned zero rows
  const res = await runSourceJobs(runOpts({ store, dataDoe: dd, plannedJobs: [job] }));
  const j = store._rawJob(res.cycleId, src.requestHash);
  assert.equal(j.fetch_status, "succeeded", "an empty bounded D-1 export SUCCEEDS (valid-empty), not a terminal hard stop");
  assert.equal(j.error_code, null, "no LATEST_SNAPSHOT_INCOMPLETE failure recorded");
  assert.equal(j.row_count, 0, "zero rows persisted (inventory-unavailable for the day, never a fabricated zero)");
  const cached = store.loadSourceRows(src.requestHash);
  assert.ok(cached && Array.isArray(cached.rows) && cached.rows.length === 0, "the empty payload is persisted as valid-empty (so the report derives inventoryAvailable=false)");
  assert.equal(res.succeeded, 1);
  assert.equal(res.failed, 0);
});

test("EMPTY multi-seller D-1 inventory batch is ALSO a valid-empty SUCCESS -> single/multi-seller PARITY (defect 2)", async () => {
  const store = makeStore();
  const { src, job } = invJobD1(["A1", "A2"], "CA", "2026-09-08"); // 2-seller batch -> generic path (NOT compaction)
  assert.equal(job.fetchParams.sellerOrVendorIds.length, 2, "a >1-seller batch exercises the generic (non-compaction) empty path");
  const dd = makeDataDoe(() => []);
  const res = await runSourceJobs(runOpts({ store, dataDoe: dd, plannedJobs: [job] }));
  const j = store._rawJob(res.cycleId, src.requestHash);
  assert.equal(j.fetch_status, "succeeded", "a multi-seller empty batch is valid-empty (unchanged) -> AGREES with the single-seller outcome");
  assert.equal(j.row_count, 0);
  assert.equal(res.succeeded, 1);
  assert.equal(res.failed, 0);
});

test("an UNBOUNDED (multi-day) single-seller EMPTY inventory export is STILL a terminal hard stop (unbounded empty proves nothing)", async () => {
  const store = makeStore();
  const resolved = reportSourceRequestHashes({ reportKey: "fba-plan", apiKey: "k", ids: ["A1"], windowsByRequestKey: { "fba-plan:inventory-health": [{ from: "2026-08-30", to: "2026-09-08" }] }, marketplaceCountry: "CA" });
  const src = resolved.find((r) => r.requestKey === "fba-plan:inventory-health");
  const job = plannedSourceJob("fba-plan", src, "us", "primary", "acct-A1", "A1", "CA");
  const dd = makeDataDoe(() => []);
  const res = await runSourceJobs(runOpts({ store, dataDoe: dd, plannedJobs: [job] }));
  const j = store._rawJob(res.cycleId, src.requestHash);
  assert.equal(j.error_code, "LATEST_SNAPSHOT_INCOMPLETE", "an unbounded (multi-day) empty lookback is never inferred unavailable");
  assert.equal(j.terminal, true);
  assert.equal(store._cache.has(src.requestHash), false, "nothing persisted for the unprovable empty lookback");
  assert.equal(res.failed, 1);
});

async function main() {
  mark("main(): loading source-worker modules");
  ({ runSourceJobs } = await import("../lib/server/sync/source-worker.js"));
  ({ reportSourceRequestHashes } = await import("../lib/server/sync/report-source-contracts.js"));
  ({ plannedSourceJob } = await import("../lib/server/sync/source-sync-driver.js"));
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
