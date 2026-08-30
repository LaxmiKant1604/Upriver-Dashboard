// Scheduler v2 -- FBA strict-cap source-worker integration test (SHADOW MODE).
//
// One small, independently-readable ESM artifact (the content scanner reads it directly). Proves the
// Scheduler-v2 `strict:true` flag on the fba-plan contracts reaches the real source worker guard: a
// resolved fba-plan source whose result reaches the row cap (rows.length === job.limit) is recorded
// as TRUNCATED, persists NO source payload, does not block an unrelated source in the same batch, and
// is NOT attempted again on a repeated worker run. Self-contained: a lean in-memory store + DataDoe
// double drive the real runSourceJobs; no DataDoe/Supabase/network calls, no process.exit, no timers.
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

group("fba-plan strict-cap source worker");

test("a cap-sized FBA source records TRUNCATED, persists nothing, unrelated source succeeds, and is not re-attempted", async () => {
  const store = makeStore();
  // Resolve a REAL fba-plan job so the CONTRACT strict flag + real row limit flow onto the planned job. OLI +
  // Product Catalog are now durable DERIVED deps (not owned exports), so fba-plan's ONLY owned per-cycle sources
  // are the FBA Inventory Health snapshot (all markets) + the US-only AWD listing. A CA (non-US) account owns
  // ONLY inventory-health; one capped inventory-health fetch is enough to drive the strict-cap guard.
  const fbaWin = {
    "fba-plan:inventory-health": [{ from: "2025-07-27", to: "2025-08-06" }],
  };
  const resolved = reportSourceRequestHashes({ reportKey: "fba-plan", apiKey: "k", ids: ["A1"], windowsByRequestKey: fbaWin, marketplaceCountry: "CA" });
  const fbaSrc = resolved.find((r) => r.requestKey === "fba-plan:inventory-health");
  assert.equal(fbaSrc.strict, true, "the fba-plan:inventory-health contract is strict:true");
  const capped = plannedSourceJob("fba-plan", fbaSrc, "us", "primary");

  // The capped source returns EXACTLY job.limit rows (rows.length === limit) -- indistinguishable from
  // truncation, so the strict guard must reject it. Use the contract's real limit (no in-test shrink).
  const cappedRows = Array.from({ length: capped.limit }, () => ({}));
  // An UNRELATED healthy source (a different report) in the same batch.
  const bs = reportSourceRequestHashes({ reportKey: "brand-sales", apiKey: "k", ids: ["A1"], windowsByRequestKey: { "brand-sales:order-lines": [{ from: "2025-01-01", to: "2025-06-30" }], "brand-sales:catalog": [{ from: "2025-01-01", to: "2025-06-30" }] } });
  const other = plannedSourceJob("brand-sales", bs.find((r) => r.requestKey === "brand-sales:catalog"), "us", "primary");

  const dd = makeDataDoe((job) => (job.requestHash === fbaSrc.requestHash ? cappedRows : [{ ok: 1 }]));
  const res = await runSourceJobs(runOpts({ store, dataDoe: dd, plannedJobs: [capped, other] }));

  // Capped FBA source: recorded TRUNCATED at the validate stage, terminal, and NOTHING persisted.
  const cappedJob = store._rawJob(res.cycleId, fbaSrc.requestHash);
  assert.equal(cappedJob.error_code, "TRUNCATED");
  assert.equal(cappedJob.error_stage, "validate");
  assert.equal(cappedJob.terminal, true);
  assert.equal(cappedJob.row_count, capped.limit, "the cap count is recorded (rows.length === limit)");
  assert.equal(store._cache.has(fbaSrc.requestHash), false, "no source payload persisted for the capped FBA source");
  // The unrelated source completes and persists (one source failing never blocks another).
  assert.equal(store._cache.has(other.requestHash), true, "the unrelated source persisted its payload");
  assert.equal(store._rawJob(res.cycleId, other.requestHash).fetch_status, "succeeded");
  assert.equal(res.failed, 1);
  assert.equal(res.succeeded, 1);

  // A repeated worker run must NOT attempt the truncated export again (terminal failure is skipped).
  const downloadsBefore = dd.downloadCount(fbaSrc.requestHash);
  const res2 = await runSourceJobs(runOpts({ store, dataDoe: dd, plannedJobs: [capped, other] }));
  assert.equal(dd.downloadCount(fbaSrc.requestHash), downloadsBefore, "the truncated FBA export is not downloaded again");
  assert.equal(dd.createCount(fbaSrc.requestHash), 1, "exactly one create-export ever issued for the truncated source");
  assert.equal(res2.processed, 0, "no pending/attempted jobs remain to process on the repeat run");
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
