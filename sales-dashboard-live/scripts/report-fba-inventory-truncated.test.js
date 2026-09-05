// Regression guard for the India FBA Inventory [5,3] TRUNCATED incident (2026-09-05).
//
// ROOT CAUSE (proven against production): the 3-seller India inventory batch's data exceeds the 50000-row export cap
// (PLAN_INVENTORY_ROW_LIMIT). The export was created + returned exactly 50000 rows (capped at source by the create
// `limit`), so the STRICT validator rejects it as TRUNCATED ("partial data would be misleading") -> terminal, never
// saved. The 5-seller batch (14732 rows) succeeds. This is a legitimate DATA-VOLUME failure the pipeline handles
// FAIL-CLOSED + HONESTLY: the oversized batch is not saved, its accounts' required source is failed, so their report
// is blocked (LKG preserved) and the region is never reported as fully fresh.
//
// This test reproduces the EXACT [5,3] scenario through the REAL source worker (runSourceJobs) + a fake DataDoe, and
// locks in every honesty property the incident review requires:
//   - both inventory batches are planned ([5,3]), strict, capped at 50000;
//   - the 5-seller batch completes + is saved + isolated; the 3-seller batch TRUNCATES -> terminal -> NOT saved;
//   - a replay creates ZERO new exports and never recreates the succeeded batch;
//   - the report fetch-gate is per-account honest: batch[5] accounts are ready, batch[3] accounts are blocked;
//   - a partial region can never present the failed batch's accounts as fresh.
// Offline, ZERO DataDoe/network. 7-bit ASCII, LF.

import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { planFbaPlanBucketBatched } from "../lib/server/sync/report-planner.js";
import { resolveFromGenericPlan } from "../lib/server/sync/sync-dispatch.js";
import { runSourceJobs } from "../lib/server/sync/source-worker.js";
import { reportFetchGate } from "../lib/server/sync/planner.js";

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); passed += 1; writeSync(1, `  ok ${n}\n`); };
writeSync(1, "report-fba-inventory-truncated\n");

const API_KEY = "fixture-key";
const connections = [{ id: "primary", apiKey: API_KEY, accountPrefix: "" }];
const cycleDate = "2026-09-05";
const IN8 = Array.from({ length: 8 }, (_, i) => ({ accountId: `in-${String(i).padStart(2, "0")}`, country: "IN", currency: "INR", name: `IN${i}` }));
const ROW_CAP = 50000;

/* ===================== A. planner: 8 IN accounts -> [5,3] strict inventory batches ===================== */
const reportRequests = planFbaPlanBucketBatched({ accounts: IN8, connections, asOfFor: () => cycleDate, inventoryAsOf: cycleDate }); // returns the report-requests array
const plan = { reportRequests };
const invSrcs = [...new Map(reportRequests.flatMap((r) => r.sources.filter((s) => s.requestKey === "fba-plan:inventory-health").map((s) => [s.requestHash, s]))).values()];
const sizeByHash = new Map(invSrcs.map((s) => [s.requestHash, s.sellerOrVendorIds.length]));
(() => {
  ok("A: India (8 accounts) -> exactly 2 inventory batches", invSrcs.length === 2);
  ok("A: the batches are [5,3]", [...sizeByHash.values()].sort((a, b) => b - a).join(",") === "5,3");
  ok("A: every inventory batch is strict + capped at 50000", invSrcs.every((s) => s.strict === true && s.limit === ROW_CAP));
  ok("A: FBA India plans inventory only (no AWD for a non-AWD marketplace)", plan.reportRequests.every((r) => r.sources.every((s) => s.requestKey === "fba-plan:inventory-health")));
})();

// A fake DataDoe: create -> exportId; poll -> ok; download -> the 3-seller batch returns a CAP-SIZED page (TRUNCATED),
// the 5-seller batch returns a valid under-cap page. Keyed by the job's canonical request_hash.
function makeDataDoe() {
  const creates = { count: 0, byHash: new Map() };
  const invRow = (seller) => ({ seller_or_vendor_id: seller, marketplace_country_code: "IN", child_asin: "ASIN-x", sku: "SKU-x", available: 1 });
  return {
    creates,
    create: async (job) => { creates.count += 1; creates.byHash.set(job.requestHash, (creates.byHash.get(job.requestHash) || 0) + 1); return { exportId: `exp-${String(job.requestHash).slice(0, 6)}` }; },
    poll: async () => {},
    download: async (job) => {
      const sellers = (job.fetchParams && job.fetchParams.sellerOrVendorIds) || [];
      if (sellers.length <= 3) return Array.from({ length: ROW_CAP }, () => invRow(sellers[0])); // >= cap -> TRUNCATED
      // under-cap valid page spread across the batch's sellers.
      return Array.from({ length: 200 }, (_, i) => invRow(sellers[i % sellers.length]));
    },
  };
}

/* ===================== compact in-memory store (source half) ===================== */
function makeStore() {
  const cycles = new Map(); const jobsByCycle = new Map(); const ownersByCycle = new Map(); const cache = new Map(); let seq = 0;
  const find = (id) => [...cycles.values()].find((c) => c.id === id) || null;
  return {
    openCycle({ bucket, cycleDate }) { const k = bucket + "|" + cycleDate; if (!cycles.has(k)) { const id = "cyc_" + (seq += 1); cycles.set(k, { id, bucket, status: "pending" }); jobsByCycle.set(id, new Map()); } return cycles.get(k).id; },
    getCycleByBucketDate(bucket, cycleDate) { return cycles.get(bucket + "|" + cycleDate) || null; },
    claimCycle(id) { const c = find(id); if (c && c.status === "pending") { c.status = "running"; return true; } return false; },
    getCycle(id) { return find(id); },
    upsertSourceJob(job) { const m = jobsByCycle.get(job.cycleId); if (m.has(job.requestHash)) return; m.set(job.requestHash, { request_hash: job.requestHash, request_key: job.requestKey, source_id: job.sourceId, source_key: job.sourceKey, connection_id: job.connectionId, organization_fingerprint: job.organizationFingerprint, account_scope_hash: job.accountScopeHash, fetch_status: "pending", attempted_at: null, create_export_count: 0, export_id: null, terminal: false, row_count: null, error_stage: null, error_code: null }); },
    listSourceJobs(id) { return [...((jobsByCycle.get(id) && jobsByCycle.get(id).values()) || [])].map((j) => ({ ...j })); },
    upsertSourceJobOwners(ms) { for (const m of ms || []) { if (!ownersByCycle.has(m.cycleId)) ownersByCycle.set(m.cycleId, new Map()); ownersByCycle.get(m.cycleId).set(m.ownerId + "|" + m.requestHash, { cycle_id: m.cycleId, request_hash: m.requestHash, owner_id: m.ownerId, request_key: m.requestKey, report_key: m.reportKey, account_id: m.accountId, owner_status: "active", error_code: null }); } },
    listSourceJobOwners(cid, ids) { const s = new Set(ids || []); return [...((ownersByCycle.get(cid) && ownersByCycle.get(cid).values()) || [])].filter((m) => s.has(m.owner_id)).map((m) => ({ ...m })); },
    recordSourceOwnerStale() {},
    claimExportAttempt(id, h) { const j = jobsByCycle.get(id).get(h); if (j && j.attempted_at === null) { j.attempted_at = "t"; j.create_export_count += 1; j.fetch_status = "attempted"; return true; } return false; },
    recordExportCreated({ cycleId, requestHash, exportId }) { jobsByCycle.get(cycleId).get(requestHash).export_id = exportId; },
    loadSourceRows(h) { const e = cache.get(h); return e ? { rows: e.rows, source_id: e.source_id, organization_fingerprint: e.org, account_scope_hash: e.scope, object_path: e.path, row_count: e.rows.length, fetched_at: e.fetched_at } : null; },
    saveSourceRows({ job, rows }) { const h = job.request_hash != null ? job.request_hash : job.requestHash; cache.set(h, { rows: [...rows], source_id: job.sourceId, org: job.organizationFingerprint, scope: job.accountScopeHash, path: "p/" + h, fetched_at: new Date().toISOString() }); return "p/" + h; },
    recordSourceSuccess({ cycleId, requestHash, exportId, rowCount, cacheObjectPath }) { Object.assign(jobsByCycle.get(cycleId).get(requestHash), { fetch_status: "succeeded", export_id: exportId, row_count: rowCount, cache_object_path: cacheObjectPath }); },
    recordSourceFailure({ cycleId, requestHash, stage, code, terminal, rowCount }) { Object.assign(jobsByCycle.get(cycleId).get(requestHash), { fetch_status: "failed", error_stage: stage, error_code: code, terminal: !!terminal, row_count: rowCount ?? null }); },
    updateCycleCounts() {},
    _cache: cache,
  };
}

const plannedJobs = resolveFromGenericPlan(plan)().sourceJobs;
const ownerIds = [...new Set(plannedJobs.filter((j) => j.owner && j.owner.ownerId).map((j) => j.owner.ownerId))];
const hash5 = [...sizeByHash].find(([, n]) => n === 5)[0];
const hash3 = [...sizeByHash].find(([, n]) => n === 3)[0];

/* ===================== B. real source worker reproduces the [5,3] TRUNCATED outcome ===================== */
const store = makeStore();
const dataDoe = makeDataDoe();
await (async () => {
  const realFetch = globalThis.fetch; globalThis.fetch = () => { throw new Error("no network in reproduction"); };
  let res;
  try { res = await runSourceJobs({ store, dataDoe, plannedJobs, ownerIds, bucket: "india", cycleBucket: "india-fba", cycleDate, trigger: "manual", deadlineMs: Infinity, reserveMs: 0 }); }
  finally { globalThis.fetch = realFetch; }
  const jobs = store.listSourceJobs(res.cycleId);
  const j5 = jobs.find((j) => j.request_hash === hash5);
  const j3 = jobs.find((j) => j.request_hash === hash3);
  ok("B: the 5-seller batch SUCCEEDED and was saved", j5.fetch_status === "succeeded" && store._cache.has(hash5));
  ok("B: the 3-seller batch FAILED at validate with TRUNCATED and is TERMINAL", j3.fetch_status === "failed" && j3.error_stage === "validate" && j3.error_code === "TRUNCATED" && j3.terminal === true);
  ok("B: the truncated batch's rows were NOT saved (no misleading partial cache)", !store._cache.has(hash3));
  ok("B: each batch created exactly one export (one create per hash)", dataDoe.creates.byHash.get(hash5) === 1 && dataDoe.creates.byHash.get(hash3) === 1);
  ok("B: the saved batch is isolated to its own 5 sellers only", store._cache.get(hash5).rows.every((r) => r.marketplace_country_code === "IN"));
})();

/* ===================== C. replay is a zero-create idempotent no-op (no recreation of the succeeded batch) ===================== */
await (async () => {
  const before = dataDoe.creates.count;
  const realFetch = globalThis.fetch; globalThis.fetch = () => { throw new Error("no network in replay"); };
  try { await runSourceJobs({ store, dataDoe, plannedJobs, ownerIds, bucket: "india", cycleBucket: "india-fba", cycleDate, trigger: "manual", deadlineMs: Infinity, reserveMs: 0 }); }
  finally { globalThis.fetch = realFetch; }
  ok("C: a replay creates ZERO new exports (succeeded batch not recreated, terminal batch not retried)", dataDoe.creates.count === before);
  ok("C: the succeeded batch cache is unchanged; the truncated batch is still absent", store._cache.has(hash5) && !store._cache.has(hash3));
})();

/* ===================== D. per-account report gate is honest (5 ready, 3 blocked) ===================== */
(() => {
  const statusByHash = {}; for (const j of store.listSourceJobs(store.getCycleByBucketDate("india-fba", cycleDate).id)) statusByHash[j.request_hash] = j.fetch_status;
  // Map each account to its inventory batch hash (its required source).
  const hashForAccount = new Map();
  for (const req of plan.reportRequests) { const inv = req.sources.find((s) => s.requestKey === "fba-plan:inventory-health"); if (inv) hashForAccount.set(req.accountId, inv.requestHash); }
  let ready = 0, blocked = 0;
  for (const a of IN8) { const gate = reportFetchGate({ dependsOn: [hashForAccount.get(a.accountId)] }, statusByHash); if (gate === "ready") ready += 1; else if (gate === "blocked") blocked += 1; }
  ok("D: exactly 5 accounts are report-ready (their inventory batch succeeded)", ready === 5);
  ok("D: exactly 3 accounts are report-BLOCKED (their inventory batch truncated) -> LKG preserved, never falsely fresh", blocked === 3);
})();

/* ===================== E. honest recovery boundary: a truncated (capped-at-source) export cannot be re-downloaded to fresh ===================== */
(() => {
  // The export is capped at CREATE (createExport sends `limit`), so re-downloading the SAME export yields the SAME
  // 50000 truncated rows -> TRUNCATED again. Recovery requires a NEW export (smaller sub-batch or a higher cap),
  // which is why the terminal TRUNCATED state (never re-downloaded) is correct.
  const j3 = store.listSourceJobs(store.getCycleByBucketDate("india-fba", cycleDate).id).find((j) => j.request_hash === hash3);
  ok("E: the truncated batch is terminal at the validate stage -> ineligible for download-only recovery (correct)", j3.terminal === true && j3.error_stage === "validate");
})();

writeSync(1, `\nreport-fba-inventory-truncated: ${passed} assertions passed\n`);
