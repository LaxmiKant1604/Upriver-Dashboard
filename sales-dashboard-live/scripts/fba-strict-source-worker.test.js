// Scheduler v2 -- FBA strict-cap source-worker integration test (SHADOW MODE).
//
// One small, independently-readable ESM artifact (the content scanner reads it directly). Proves how the
// Scheduler-v2 `strict:true` flag on the source contracts reaches the real source worker guard:
//   * A strict source (product-catalog) whose result reaches the row cap is recorded as TRUNCATED and persists NO
//     source payload -- the GENERIC validator.
//   * Listings inventory cutover (2026-10): FBA Inventory Health is RETIRED, so the former single-seller
//     "latest-snapshot" compaction exception is gone. The fba-plan contract owns ONLY the canonical Listings request
//     (fba-plan:awd), and a cap-sized canonical Listings payload is the SAME generic TRUNCATED failure (persists
//     nothing; never compacted, never partially saved); an unrelated source in the same batch still succeeds and the
//     truncated export is not attempted again.
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

// A single-seller canonical Listings source (fba-plan:awd -- FBA inventory + AWD since the Listings inventory cutover).
function listingsJob(ids = ["A1"], marketplace = "CA") {
  const resolved = reportSourceRequestHashes({ reportKey: "fba-plan", apiKey: "k", ids, windowsByRequestKey: { "fba-plan:awd": [{ from: null, to: null }] }, marketplaceCountry: marketplace });
  const src = resolved.find((r) => r.requestKey === "fba-plan:awd");
  assert.equal(src.strict, true, "the canonical Listings contract is strict:true");
  assert.equal(src.sourceKey, "listings", "fba-plan's only owned source is the canonical Listings");
  // plannedSourceJob(reportKey, resolved, bucket, connectionId, accountId, ownerRawSellerId, marketplaceConstraint)
  return { src, job: plannedSourceJob("fba-plan", src, "us", "primary", "acct-A1", "A1", marketplace) };
}
// An UNRELATED healthy source (brand-sales:catalog) in the same batch -- returns one row and must always succeed.
function healthyOther() {
  const bs = reportSourceRequestHashes({ reportKey: "brand-sales", apiKey: "k", ids: ["A1"], windowsByRequestKey: { "brand-sales:order-lines": [{ from: "2025-01-01", to: "2025-06-30" }], "brand-sales:catalog": [{ from: "2025-01-01", to: "2025-06-30" }] } });
  return plannedSourceJob("brand-sales", bs.find((r) => r.requestKey === "brand-sales:catalog"), "us", "primary");
}
const listingRow = (sku, seller = "A1", mkt = "CA") => ({ seller_or_vendor_id: seller, marketplace_country_code: mkt, sku, fba_quantity_available: 1, fba_quantity_inbound: 0, fba_quantity_reserved: 0, fba_quantity_fc_transfer: 0 });

group("source worker: generic strict cap (no Health latest-snapshot exception)");

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
  assert.equal(j.error_code, "TRUNCATED", "a cap-sized strict source is generic TRUNCATED");
  assert.equal(j.error_stage, "validate");
  assert.equal(j.terminal, true);
  assert.equal(store._cache.has(catSrc.requestHash), false, "nothing persisted for the truncated catalog");
  assert.equal(res.failed, 1);
});

test("Listings inventory cutover: the fba-plan contract declares NO fba-plan:inventory-health request (resolving one throws; no Health identity can be planned)", async () => {
  assert.throws(() => reportSourceRequestHashes({ reportKey: "fba-plan", apiKey: "k", ids: ["A1"], windowsByRequestKey: { "fba-plan:inventory-health": [{ from: "2026-09-08", to: "2026-09-08" }], "fba-plan:awd": [{ from: null, to: null }] }, marketplaceCountry: "CA" }), /Unknown request key "fba-plan:inventory-health"/);
  const resolved = reportSourceRequestHashes({ reportKey: "fba-plan", apiKey: "k", ids: ["A1"], windowsByRequestKey: { "fba-plan:awd": [{ from: null, to: null }] }, marketplaceCountry: "CA" });
  assert.deepEqual(resolved.map((r) => r.sourceKey), ["listings"], "fba-plan owns ONLY the canonical Listings source");
});

test("a cap-sized single-seller canonical Listings payload is generic TRUNCATED (never compacted, persists nothing), an unrelated source succeeds, and it is not re-attempted", async () => {
  const store = makeStore();
  const { src, job } = listingsJob();
  const other = healthyOther();
  const dd = makeDataDoe((j) => (j.requestHash === src.requestHash ? Array.from({ length: job.limit }, (_, i) => listingRow("S" + i)) : [{ child_asin: "B0A", product_brand: "Acme" }]));
  const res = await runSourceJobs(runOpts({ store, dataDoe: dd, plannedJobs: [job, other] }));
  const j = store._rawJob(res.cycleId, src.requestHash);
  assert.equal(j.error_code, "TRUNCATED", "the canonical Listings cap is the generic TRUNCATED failure");
  assert.equal(j.error_stage, "validate");
  assert.equal(j.terminal, true);
  assert.equal(store._cache.has(src.requestHash), false, "nothing persisted for the truncated Listings export");
  assert.notEqual(j.error_code, "LATEST_SNAPSHOT_INCOMPLETE", "the retired Health latest-snapshot path never runs");
  const o = store._rawJob(res.cycleId, other.requestHash);
  assert.equal(o.fetch_status, "succeeded", "an unrelated source in the same batch still succeeds");
  const createsBefore = dd.createCount(src.requestHash);
  await runSourceJobs(runOpts({ store, dataDoe: dd, plannedJobs: [job, other] }));
  assert.equal(dd.createCount(src.requestHash), createsBefore, "a terminal TRUNCATED export is never created again in the same cycle");
});

test("a below-cap single-seller canonical Listings payload is persisted as-is (row-for-row, no date compaction)", async () => {
  const store = makeStore();
  const { src, job } = listingsJob();
  const rows = [listingRow("S1"), listingRow("S2"), listingRow("S3")];
  const dd = makeDataDoe(() => rows);
  const res = await runSourceJobs(runOpts({ store, dataDoe: dd, plannedJobs: [job] }));
  const j = store._rawJob(res.cycleId, src.requestHash);
  assert.equal(j.fetch_status, "succeeded");
  assert.equal(j.row_count, 3);
  assert.equal(store._cache.get(src.requestHash).rows.length, 3, "every Listings row persisted");
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
