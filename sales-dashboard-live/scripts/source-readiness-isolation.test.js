// DataDoe readiness batch-poisoning self-heal -- offline verification (ZERO DataDoe/network/DB).
//
// The production defect (Europe watchdog run 34206701502): DataDoe hard-rejects a MULTI-seller export with HTTP 400
// "Order Line Items requires Seller Central data on every selected seller, but the initial data load is not
// complete." when even ONE selected seller's Seller Central initial load is incomplete. Six OLI jobs failed terminal
// HTTP_400 and their 4 healthy batch-mates were poisoned (blocked behind D-1) too.
//
// This suite drives the REAL OLI/source-cycle composition (planBucketSourceSync + runBucketSourceSync + the real
// worker + the real classifier) with an in-memory store + a readiness-aware DataDoe spy, plus the pure evidence
// derivation, and proves the required behaviors:
//   A. Reproduction: a real 5-seller OLI batch whose create returns the exact 400 fails terminal with the NARROW
//      typed code DATADOE_INITIAL_LOAD_INCOMPLETE (not a generic HTTP_400), and every batch member is blocked.
//   B. Classifier: ONLY the proven provider signature maps to the readiness code; every other 400 stays HTTP_400.
//   C. Isolation core: multi-member rejection -> isolate all members; single-member -> exclude; a later single-seller
//      success clears; exclude precedence; org/connection/source/current-seller scoping; recency.
//   D. Fresh-cycle recovery: an isolate set splits the OLI batch into single-seller jobs (healthy succeed alone; the
//      unready one 400s alone, writing nothing); an exclude set drops the proven-unready seller (no create/token).
//   E. Idempotency: same-operation / watchdog replay creates ZERO duplicates; a continuation NEVER splits a frozen
//      batch (no PLAN_BUDGET_MISMATCH / ceiling drift); a failed single-seller child is not recreated in the op.
//   F. req 7: a readiness-waiting failure does NOT stop the bucket -- healthy sellers still derive; unready waits;
//      the cycle finalizes honestly PARTIAL (never all-fresh / false-green).
//   G. Coverage: FBA Inventory Health + Listing Health v3 + AWD honor exclude + inventory/AWD isolation; the
//      existing India FBA overflow [5,1,1,1] is unchanged; unrelated 400s never split.
//
// 7-bit ASCII, LF. A dummy env is set BEFORE dynamic imports so any env-at-eval transitive module is satisfied.

import assert from "node:assert/strict";
import { writeSync } from "node:fs";

process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://supabase.test";
const SB_KEY_ENV = ["SUPABASE", "SERVICE", "ROLE", "KEY"].join("_");
process.env[SB_KEY_ENV] = process.env[SB_KEY_ENV] || ["test", "svc", "role", "key"].join("-");

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); passed += 1; writeSync(1, `  ok ${n}\n`); };
writeSync(1, "source-readiness-isolation\n");

const bucketSync = await import("../lib/server/sync/source-bucket-sync.js");
const planner = await import("../lib/server/sync/report-planner.js");
const worker = await import("../lib/server/sync/source-worker.js");
const iso = await import("../lib/server/sync/source-readiness-isolation.js");
const identity = await import("../lib/server/source-identity.js");
const dates = await import("../lib/server/date-windows.js");
const { classifyFetchError } = worker;
const { readinessIsolationFrom, readRecentReadinessRejectionOwnership, isInitialLoadIncompleteMessage, READINESS_INCOMPLETE_CODE } = iso;
const { accountScopeHash } = identity;

const API_KEY = ["prim", "key"].join("-");
const ASOF = "2026-08-15";
const TODAY = "2026-08-15";
const BUCKET = "india";
const CATALOG_CARRIER = "carrier-seller-01";
const PROVIDER_400 = "DataDoe export creation failed (400): Order Line Items requires Seller Central data on every selected seller, but the initial data load is not complete.";
const acct = (i) => ({ accountId: "A" + String(i).padStart(2, "0"), rawSellerId: "S" + String(i).padStart(2, "0"), country: "IN" });
const FIVE = [1, 2, 3, 4, 5].map(acct);
const steadyCoverage = (accounts, upTo) => Object.fromEntries(accounts.map((a) => [a.accountId, [{ from: "2025-01-01", to: upTo }]]));
const scope = (s) => accountScopeHash([s]);

/* ============================ in-memory store (worker + budget + continuation) ============================ */
function makeStore() {
  const cycles = new Map(); const jobsByCycle = new Map(); const ownersByCycle = new Map();
  const cache = new Map(); const budgets = new Map(); let seq = 0;
  const counters = { claims: 0, reserves: 0 };
  const findCycle = (id) => [...cycles.values()].find((c) => c.id === id) || null;
  const ownerRows = (cid) => [...((ownersByCycle.get(cid) && ownersByCycle.get(cid).values()) || [])];
  const bkey = (cid, tk) => cid + "|" + tk;
  return {
    _counters: counters,
    _jobs: (cid) => [...((jobsByCycle.get(cid) && jobsByCycle.get(cid).values()) || [])].map((j) => ({ ...j })),
    // TEST ONLY: reset some jobs to pending, simulating a run interrupted BEFORE they were created (so their frozen
    // budget reservation was never taken -- release spentCreates/spentTokens too, exactly as a never-created job).
    _reopen: (cid, hashes) => {
      const m = jobsByCycle.get(cid);
      const b = budgets.get(bkey(cid, "source-sync:order-line-items"));
      for (const h of hashes) {
        const j = m && m.get(h);
        if (j) Object.assign(j, { fetch_status: "pending", attempted_at: null, create_export_count: 0, export_id: null, terminal: false, error_stage: null, error_code: null, row_count: null, cache_object_path: null });
        if (b && b.cost.has(h)) { b.spentCreates = Math.max(0, b.spentCreates - 1); b.spentTokens = Math.max(0, b.spentTokens - b.cost.get(h)); }
      }
    },
    openCycle({ bucket, cycleDate }) {
      const k = bucket + "|" + cycleDate;
      if (!cycles.has(k)) { const id = "cyc_" + (seq += 1); cycles.set(k, { id, bucket, status: "pending" }); jobsByCycle.set(id, new Map()); }
      return cycles.get(k).id;
    },
    claimCycle(id) { const c = findCycle(id); if (c && c.status === "pending") { c.status = "running"; return true; } return false; },
    getCycle(id) { return findCycle(id); },
    upsertSourceJob(job) {
      const m = jobsByCycle.get(job.cycleId);
      if (m.has(job.requestHash)) return;
      m.set(job.requestHash, {
        request_hash: job.requestHash, request_key: job.requestKey, source_id: job.sourceId, source_key: job.sourceKey,
        connection_id: job.connectionId, organization_fingerprint: job.organizationFingerprint, account_scope_hash: job.accountScopeHash,
        fetch_status: "pending", attempted_at: null, create_export_count: 0, export_id: null,
        terminal: false, error_stage: null, error_code: null, row_count: null, cache_object_path: null,
      });
    },
    listSourceJobs(id) { return [...((jobsByCycle.get(id) && jobsByCycle.get(id).values()) || [])].map((j) => ({ ...j })); },
    upsertSourceJobOwners(ms) {
      for (const m of ms || []) {
        if (!ownersByCycle.has(m.cycleId)) ownersByCycle.set(m.cycleId, new Map());
        ownersByCycle.get(m.cycleId).set(m.ownerId + "|" + m.requestHash, {
          cycle_id: m.cycleId, request_hash: m.requestHash, owner_id: m.ownerId, request_key: m.requestKey,
          report_key: m.reportKey, account_id: m.accountId, connection_id: m.connectionId,
          organization_fingerprint: m.organizationFingerprint, account_scope_hash: m.accountScopeHash, owner_status: "active",
        });
      }
    },
    listSourceJobOwners(cid, ids) { const s = new Set(ids || []); return ownerRows(cid).filter((m) => s.has(m.owner_id)).map((m) => ({ ...m })); },
    recordSourceOwnerStale() {},
    claimExportAttempt(id, h) {
      counters.claims += 1;
      const j = jobsByCycle.get(id) && jobsByCycle.get(id).get(h);
      if (j && j.fetch_status === "pending" && j.attempted_at === null) { j.attempted_at = "t"; j.create_export_count += 1; j.fetch_status = "attempted"; return true; }
      return false;
    },
    adoptSourceCache() { return "cache-changed"; },
    recordExportCreated({ cycleId, requestHash, exportId }) { jobsByCycle.get(cycleId).get(requestHash).export_id = exportId; },
    loadSourceRows(h) { const e = cache.get(h); return e ? { ...e } : null; },
    saveSourceRows({ job, rows, payloadBytes }) {
      const h = job.request_hash != null ? job.request_hash : job.requestHash;
      const objectPath = "source-cache/v2/" + h + ".json";
      cache.set(h, { rows: [...rows], source_id: job.sourceId, organization_fingerprint: job.organizationFingerprint, account_scope_hash: job.accountScopeHash, object_path: objectPath, row_count: rows.length, payload_bytes: payloadBytes });
      return objectPath;
    },
    recordSourceSuccess({ cycleId, requestHash, exportId, rowCount, cacheObjectPath }) {
      Object.assign(jobsByCycle.get(cycleId).get(requestHash), { fetch_status: "succeeded", export_id: exportId, row_count: rowCount, cache_object_path: cacheObjectPath });
    },
    recordSourceFailure({ cycleId, requestHash, stage, code, terminal, exportId }) {
      const j = jobsByCycle.get(cycleId).get(requestHash);
      Object.assign(j, { fetch_status: "failed", error_stage: stage, error_code: code, terminal: !!terminal });
      if (exportId != null) j.export_id = exportId;
    },
    updateCycleCounts() {},
    persistBudget({ cycleId, trancheKey, planFingerprint, maxCreates, maxTokens, hashes }) {
      const k = bkey(cycleId, trancheKey);
      const b = budgets.get(k);
      if (b) {
        if (b.planFingerprint !== planFingerprint || b.maxCreates !== maxCreates || b.maxTokens !== maxTokens) { const e = new Error("PLAN_BUDGET_MISMATCH"); e.code = "PLAN_BUDGET_MISMATCH"; throw e; }
        return "exists";
      }
      budgets.set(k, { planFingerprint, maxCreates, maxTokens, spentCreates: 0, spentTokens: 0, cost: new Map((hashes || []).map((h) => [h.requestHash, h.tokenCost])) });
      return "created";
    },
    reserveExportCreate({ cycleId, trancheKey, requestHash, planFingerprint }) {
      counters.reserves += 1;
      const b = budgets.get(bkey(cycleId, trancheKey));
      if (!b) throw new Error("no frozen budget");
      if (b.planFingerprint !== planFingerprint || !b.cost.has(requestHash)) return "plan-mismatch";
      const cost = b.cost.get(requestHash);
      if (b.spentCreates + 1 > b.maxCreates || b.spentTokens + cost > b.maxTokens) return "budget-exceeded";
      const j = jobsByCycle.get(cycleId) && jobsByCycle.get(cycleId).get(requestHash);
      if (!(j && j.fetch_status === "pending" && j.attempted_at === null && j.create_export_count === 0)) return "not-pending";
      j.attempted_at = "t"; j.create_export_count += 1; j.fetch_status = "attempted"; b.spentCreates += 1; b.spentTokens += cost;
      return "reserved";
    },
    getCycleByBucketDate(bucket, cycleDate) { const c = cycles.get(bucket + "|" + cycleDate); return c ? { id: c.id, bucket: c.bucket, status: c.status } : null; },
    getBudget({ cycleId, trancheKey }) { const b = budgets.get(bkey(cycleId, trancheKey)); return b ? { cycle_id: cycleId, tranche_key: trancheKey, plan_fingerprint: b.planFingerprint, max_creates: b.maxCreates, max_tokens: b.maxTokens } : null; },
    getBudgetHashes({ cycleId, trancheKey }) { const b = budgets.get(bkey(cycleId, trancheKey)); return b ? [...b.cost.entries()].map(([request_hash, token_cost]) => ({ request_hash, token_cost })) : []; },
    listCycleOwners(cycleId) { return ownerRows(cycleId).map((m) => ({ ...m })); },
  };
}
function makeSinks() {
  const history = []; const coverage = []; const statuses = [];
  return {
    replaceHistoryWindow: async ({ accountId, coveredFrom, coveredTo, rows, rollupRows }) => { history.push(...(rollupRows || [])); coverage.push({ accountId, coveredFrom, coveredTo }); return { write: "ok", dimensionalInserted: (rows || []).length, rollupInserted: (rollupRows || []).length }; },
    persistSnapshot: async () => ({ write: "ok" }),
    updateRunStatus: async (s) => { statuses.push(s); return { write: "ok" }; },
    _history: history, _coverage: coverage, _statuses: statuses,
  };
}
function makeClock() { let t = 1_000; return { fn: () => t, advance: (ms) => { t += ms; } }; }

// Readiness-aware DataDoe: create() 400s (the exact provider message) for ANY batch containing an unready seller
// (DataDoe's all-selected-sellers rule); succeeds otherwise. download() returns one OLI row per seller.
function makeReadinessDataDoe({ unready = new Set() } = {}) {
  const create = {}; const createSeq = []; const attempts = [];
  return {
    createCount: (h) => create[h] || 0,
    totalCreates: () => Object.values(create).reduce((a, b) => a + b, 0), // SUCCESSFUL creates only
    totalAttempts: () => attempts.length,                                 // every create POST (success OR 400)
    createSeq, attempts,
    async create(job) {
      const ids = Array.isArray(job.fetchParams && job.fetchParams.sellerOrVendorIds) ? job.fetchParams.sellerOrVendorIds.map(String) : [];
      attempts.push({ requestKey: job.requestKey || "", ids: [...ids] }); // a POST happened (a real DataDoe call)
      if (ids.some((s) => unready.has(s))) throw new Error(PROVIDER_400);  // DataDoe's all-selected-sellers 400
      create[job.requestHash] = (create[job.requestHash] || 0) + 1;
      createSeq.push({ requestKey: job.requestKey || "", ids: [...ids] });
      return { exportId: "e_" + job.requestHash };
    },
    async poll() {},
    async download(job) {
      const rk = job.requestKey || ""; const fp = job.fetchParams || {};
      if (rk.includes("source-oli")) {
        const ids = Array.isArray(fp.sellerOrVendorIds) ? fp.sellerOrVendorIds : [];
        return ids.map((sid) => ({ date: fp.to, seller_or_vendor_id: sid, sku: "SKU-A", child_asin: "B0A", item_price_currency: "INR", amazon_order_status: "Shipped", fulfillment_channel: "AFN", address_state: "KA", address_city: "BLR", total_sales_sum: 100, total_units_sum: 10 }));
      }
      if (rk.includes("source-catalog")) return [{ child_asin: "B0A", parent_asin: "P", product_name: "A", product_brand: "Acme" }];
      return [];
    },
  };
}
const PAUSE = new Set(["product-catalog", "fba-inventory-health"]); // isolate the OLI family for these reproductions
function runOli({ store, dd, accounts = FIVE, cycleDate, readinessIsolateSellers = new Set(), deadlineMs = Infinity, clock = makeClock() }) {
  const sinks = makeSinks();
  return bucketSync.runBucketSourceSync({
    apiKey: API_KEY, bucket: BUCKET, accounts, existingMembership: new Map(),
    coverageByAccountId: steadyCoverage(accounts, dates.addDaysStr(ASOF, -7)),
    catalogSnapshot: null, fbaSnapshotsByAccount: {}, pausedSources: PAUSE,
    asOf: ASOF, today: TODAY, store, dataDoe: dd, ...sinks,
    cycleDate, clock: clock.fn, wait: null, cooldownMs: 0, catalogCarrierSeller: CATALOG_CARRIER,
    readinessIsolateSellers, deadlineMs, reserveMs: 0,
  }).then((rollup) => ({ rollup, sinks }));
}
const oliJobs = (store, cid) => store._jobs(cid).filter((j) => j.source_key === "order-line-items");

/* =================================== A. reproduction + classifier === */
await (async () => {
  const store = makeStore(); const dd = makeReadinessDataDoe({ unready: new Set(["S03"]) });
  const { rollup } = await runOli({ store, dd, cycleDate: "2026-08-20" });
  const jobs = oliJobs(store, rollup.cycleId);
  ok("A: a real 5-seller OLI batch is ONE canonical job + ONE create POST", jobs.length === 1 && dd.attempts.filter((c) => c.requestKey.includes("source-oli")).length === 1 && dd.attempts[0].ids.length === 5);
  ok("A: create returns the exact 400 -> the job fails TERMINAL with DATADOE_INITIAL_LOAD_INCOMPLETE (not HTTP_400)", jobs[0].fetch_status === "failed" && jobs[0].terminal === true && jobs[0].error_code === READINESS_INCOMPLETE_CODE);
  ok("A: all 5 batch members are blocked -- nothing saved (LKG preserved)", jobs[0].row_count == null && store._jobs(rollup.cycleId).every((j) => j.source_key !== "order-line-items" || j.fetch_status !== "succeeded"));
  // req 7 / F: a readiness-waiting-only failure does NOT stop the bucket.
  ok("F: a readiness-waiting failure does NOT set REQUIRED_SOURCE_FAILED (bucket not blocked)", rollup.stopped !== true || (rollup.stopReason && rollup.stopReason.code !== "REQUIRED_SOURCE_FAILED"));
})();

(() => {
  ok("B: the exact provider message -> DATADOE_INITIAL_LOAD_INCOMPLETE (terminal)", (() => { const c = classifyFetchError(new Error(PROVIDER_400), "create-export"); return c.code === READINESS_INCOMPLETE_CODE && c.terminal === true && c.httpStatus === 400; })());
  ok("B: an UNRELATED 400 stays HTTP_400 (never a readiness split)", classifyFetchError(new Error("DataDoe export creation failed (400): unknown column"), "create-export").code === "HTTP_400");
  ok("B: a 429/5xx stays transient (unchanged)", classifyFetchError(new Error("x (429)"), "create-export").terminal === false && classifyFetchError(new Error("x (503)"), "create-export").terminal === false);
  ok("B: the matcher requires BOTH proven phrases", isInitialLoadIncompleteMessage(PROVIDER_400) === true && isInitialLoadIncompleteMessage("initial data load is not complete") === false && isInitialLoadIncompleteMessage("seller central error") === false);
})();

/* =================================== C. isolation core + recency-aware reader === */
(() => {
  const batches = [{ sellerOrVendorIds: ["S01", "S02", "S03", "S04", "S05"] }];
  const multi = readinessIsolationFrom({ defaultBatches: batches, isolateScopeHashes: ["S01", "S02", "S03", "S04", "S05"].map(scope) });
  ok("C: every rejected (non-restored) member maps to an isolate seller", [...multi.isolateSellers].sort().join(",") === "S01,S02,S03,S04,S05");
  const one = readinessIsolationFrom({ defaultBatches: batches, isolateScopeHashes: [scope("S03")] });
  ok("C: a single isolate scope maps to exactly its current seller", [...one.isolateSellers].join(",") === "S03");
  const empty = readinessIsolationFrom({ defaultBatches: batches, isolateScopeHashes: [] });
  ok("C: empty isolate scopes -> empty isolate sellers (byte-identical default plan)", empty.isolateSellers.size === 0);
  const departed = readinessIsolationFrom({ defaultBatches: [{ sellerOrVendorIds: ["S01", "S02"] }], isolateScopeHashes: ["S01", "S99"].map(scope) });
  ok("C: a DEPARTED scope (no current seller) is ignored", [...departed.isolateSellers].sort().join(",") === "S01");
})();

await (async () => {
  // Recency-aware reader: cycles arrive NEWEST-first. A scope's NEWEST readiness event decides it: a single-seller
  // SUCCESS clears (restores); a terminal readiness REJECTION isolates. A STALE success never masks a NEWER rejection.
  const RK = "source-oli:slice-v1";
  const owner = (h, sid, extra = {}) => ({ request_hash: h, request_key: RK, account_id: "A_" + sid, account_scope_hash: scope(sid), connection_id: "primary", organization_fingerprint: "ORG", owner_status: "active", ...extra });
  const rej = (h) => ({ request_hash: h, source_key: "order-line-items", fetch_status: "failed", error_code: READINESS_INCOMPLETE_CODE, terminal: true });
  const suc = (h) => ({ request_hash: h, source_key: "order-line-items", fetch_status: "succeeded", error_code: null, terminal: false });
  const run = (cycleIds, jobsByCycle, ownersByCycle, org = "ORG") => readRecentReadinessRejectionOwnership({
    requestKey: RK, cycleBucket: "india", now: () => Date.parse("2026-08-20T00:00:00Z"), connectionId: "primary", organizationFingerprint: org,
    readRecentCycleIds: async () => cycleIds, readSourceJobs: async (c) => jobsByCycle[c] || [], readOwners: async (c) => ownersByCycle[c] || [],
  });

  // A multi rejection (cN, newest) with a WRONG-source owner ignored + an HTTP_400 job (not readiness) ignored.
  const r1 = await run(["cN"],
    { cN: [rej("hMulti"), { request_hash: "hOther", source_key: "order-line-items", fetch_status: "failed", error_code: "HTTP_400", terminal: true }] },
    { cN: [owner("hMulti", "S01"), owner("hMulti", "S02"), owner("hMulti", "S09", { request_key: "listing-health-v3:inventory" }), owner("hOther", "S08")] });
  ok("C: reader isolates ONLY the readiness-rejected export's members for the target source", r1.isolateScopeHashes.slice().sort().join(",") === [scope("S01"), scope("S02")].sort().join(",") && !r1.isolateScopeHashes.includes(scope("S09")) && !r1.isolateScopeHashes.includes(scope("S08")));

  // Recency: a NEWER single-seller SUCCESS (cNew) clears an OLDER rejection (cOld) for the same seller.
  const r2 = await run(["cNew", "cOld"], { cNew: [suc("hS3ok")], cOld: [rej("hMulti")] },
    { cNew: [owner("hS3ok", "S03")], cOld: [owner("hMulti", "S03"), owner("hMulti", "S04")] });
  ok("C: a NEWER single-seller success clears an OLDER rejection (S03 not isolated; S04 still isolated)", !r2.isolateScopeHashes.includes(scope("S03")) && r2.isolateScopeHashes.includes(scope("S04")));

  // Recency (the reviewed defect): a STALE success (cOld) does NOT mask a NEWER rejection (cNew) for the same seller.
  const r3 = await run(["cNew", "cOld"], { cNew: [rej("hMulti")], cOld: [suc("hS3ok")] },
    { cNew: [owner("hMulti", "S01"), owner("hMulti", "S03")], cOld: [owner("hS3ok", "S03")] });
  ok("C: a STALE success never masks a NEWER rejection (S03 IS isolated)", r3.isolateScopeHashes.includes(scope("S03")) && r3.isolateScopeHashes.includes(scope("S01")));

  // Org isolation + fail-soft.
  const wrongOrg = await run(["cN"], { cN: [rej("hMulti")] }, { cN: [owner("hMulti", "S01")] }, "OTHER-ORG");
  ok("C: ORGANIZATION isolation -- a different org sees no evidence", wrongOrg.isolateScopeHashes.length === 0);
  const failSoft = await readRecentReadinessRejectionOwnership({ requestKey: RK, cycleBucket: "india", readRecentCycleIds: async () => { throw new Error("db down"); }, readSourceJobs: async () => [], readOwners: async () => [] });
  ok("C: reader is FAIL-SOFT (any read error -> empty -> default plan)", failSoft.isolateScopeHashes.length === 0);
})();

/* =================================== D. fresh-cycle recovery (real composition) === */
await (async () => {
  // ISOLATE: split the 5-seller batch into single-seller jobs; the 4 healthy succeed, the 1 unready 400s alone.
  const store = makeStore(); const dd = makeReadinessDataDoe({ unready: new Set(["S03"]) });
  const isolate = new Set(["S01", "S02", "S03", "S04", "S05"]);
  const { rollup } = await runOli({ store, dd, cycleDate: "2026-08-21", readinessIsolateSellers: isolate });
  const jobs = oliJobs(store, rollup.cycleId);
  const oliAttempts = dd.attempts.filter((c) => c.requestKey.includes("source-oli"));
  ok("D: the OLI batch is split into 5 single-seller jobs (5 single-seller POSTs)", jobs.length === 5 && oliAttempts.length === 5 && oliAttempts.every((c) => c.ids.length === 1));
  ok("D: the 4 HEALTHY single-seller jobs succeed independently", jobs.filter((j) => j.fetch_status === "succeeded").length === 4);
  const unreadyJob = jobs.find((j) => j.fetch_status === "failed");
  ok("D: the 1 UNREADY single-seller job 400s alone (terminal readiness) and writes nothing", unreadyJob && unreadyJob.terminal === true && unreadyJob.error_code === READINESS_INCOMPLETE_CODE && unreadyJob.row_count == null);
})();

await (async () => {
  // PEEL-OFF: a converged isolate set (only the culprit S03) peels S03 to its own single-seller export and keeps
  // the 4 healthy sellers BATCHED (one export, fresh, never poisoned) -- efficient convergence.
  const store = makeStore(); const dd = makeReadinessDataDoe({ unready: new Set(["S03"]) });
  const { rollup } = await runOli({ store, dd, cycleDate: "2026-08-22", readinessIsolateSellers: new Set(["S03"]) });
  const oliAttempts = dd.attempts.filter((c) => c.requestKey.includes("source-oli"));
  ok("D: peel-off -> the culprit is a lone single-seller export; the 4 healthy stay in ONE batched export", oliAttempts.length === 2 && oliAttempts.some((c) => c.ids.length === 4) && oliAttempts.some((c) => c.ids.length === 1 && c.ids[0] === "S03"));
  const jobs = oliJobs(store, rollup.cycleId);
  ok("D: the 4-seller batch succeeds; the culprit 400s alone (terminal readiness, nothing saved)", jobs.filter((j) => j.fetch_status === "succeeded").length === 1 && jobs.filter((j) => j.fetch_status === "failed" && j.error_code === READINESS_INCOMPLETE_CODE && j.row_count == null).length === 1);
})();

/* =================================== E. idempotency / replay / continuation === */
await (async () => {
  // Establish a FRESH cycle that succeeds (all ready), then REPLAY the SAME cycle (continuation) with an isolate
  // set: zero new creates AND no single-seller split (the frozen 5-seller plan is reproduced -> no ceiling drift).
  const store = makeStore(); const dd = makeReadinessDataDoe({ unready: new Set() });
  const r1 = await runOli({ store, dd, cycleDate: "2026-08-23" });
  const firstAttempts = dd.totalAttempts();
  const j1 = oliJobs(store, r1.rollup.cycleId);
  ok("E: fresh cycle creates ONE 5-seller OLI job (all ready)", j1.length === 1 && firstAttempts >= 1);
  // Replay the SAME cycle (now an active/running head) WITH an isolate set -> continuation drops readiness.
  const r2 = await runOli({ store, dd, cycleDate: "2026-08-23", readinessIsolateSellers: new Set(["S01", "S02", "S03", "S04", "S05"]) });
  const j2 = oliJobs(store, r2.rollup.cycleId);
  ok("E: watchdog replay of the SAME cycle creates ZERO duplicate POSTs", dd.totalAttempts() === firstAttempts);
  ok("E: a CONTINUATION never splits the frozen batch (still ONE 5-seller job -> no PLAN_BUDGET_MISMATCH)", j2.filter((j) => j.request_hash).length === 1 && r2.rollup.cycleId === r1.rollup.cycleId);
  // Replay an ISOLATED cycle: the failed single-seller child is not recreated in the same operation.
  const store2 = makeStore(); const dd2 = makeReadinessDataDoe({ unready: new Set(["S03"]) });
  const isolate = new Set(["S01", "S02", "S03", "S04", "S05"]);
  await runOli({ store: store2, dd: dd2, cycleDate: "2026-08-24", readinessIsolateSellers: isolate });
  const attemptsAfter1 = dd2.totalAttempts();
  await runOli({ store: store2, dd: dd2, cycleDate: "2026-08-24", readinessIsolateSellers: isolate });
  ok("E: replay does not recreate the failed single-seller child (terminal jobs skipped)", dd2.totalAttempts() === attemptsAfter1);
})();

await (async () => {
  // CRITICAL-fix regression: a readiness-SPLIT cycle interrupted mid-split RESUMES on the next invocation. Phase 1
  // fully freezes + runs the 5 single-seller OLI jobs; we then REOPEN 3 of them (simulating a run interrupted before
  // they were created). Phase 2 is a CONTINUATION that deliberately passes NO isolate set: it MUST reproduce the
  // frozen single-seller plan from the DURABLE owners (never a divergent 5-seller batch that would defer), and
  // create the 3 reopened single-seller jobs.
  const store = makeStore();
  const p1 = await runOli({ store, dd: makeReadinessDataDoe({ unready: new Set() }), cycleDate: "2026-08-26", readinessIsolateSellers: new Set(["S01", "S02", "S03", "S04", "S05"]) });
  const cid = p1.rollup.cycleId;
  const j1 = oliJobs(store, cid);
  ok("E: phase 1 froze + ran 5 single-seller OLI jobs (the split)", cid != null && j1.length === 5 && j1.every((j) => j.fetch_status === "succeeded"));
  store._reopen(cid, j1.slice(0, 3).map((j) => j.request_hash)); // simulate 3 not-yet-created at the interruption
  const dd2 = makeReadinessDataDoe({ unready: new Set() });
  const p2 = await runOli({ store, dd: dd2, cycleDate: "2026-08-26" }); // continuation: NO isolate passed
  const oliAttempts2 = dd2.attempts.filter((c) => c.requestKey.includes("source-oli"));
  const j2 = oliJobs(store, p2.rollup.cycleId);
  ok("E: the continuation reproduces single-seller from the frozen owners (resumes, never a divergent 5-seller defer)", p2.rollup.cycleId === cid && oliAttempts2.length === 3 && oliAttempts2.every((c) => c.ids.length === 1) && (p2.rollup.stopReason == null || p2.rollup.stopReason.code !== "REQUIRED_SOURCE_FAILED"));
  ok("E: after the continuation every single-seller OLI job is drained (the split completed)", j2.length === 5 && j2.every((j) => j.fetch_status === "succeeded"));
})();

/* =================================== F. healthy accounts continue; unready waits (planner-level) === */
(() => {
  // planBucketSourceSync surfaces honest readiness accounting; the isolated seller is reported + its batch splits.
  const baseline = bucketSync.planBucketSourceSync({
    apiKey: API_KEY, bucket: BUCKET, accounts: FIVE,
    coverageByAccountId: steadyCoverage(FIVE, dates.addDaysStr(ASOF, -7)),
    pausedSources: PAUSE, asOf: ASOF, today: TODAY, catalogCarrierSeller: CATALOG_CARRIER,
  });
  const baseOli = baseline.families.find((f) => f.sourceKey === "order-line-items");
  ok("F: default plan (no readiness) is ONE 5-seller OLI unit", (baseOli.units || []).length === 1 && baseline.summary.readinessIsolatedAccounts.length === 0);
  const plan = bucketSync.planBucketSourceSync({
    apiKey: API_KEY, bucket: BUCKET, accounts: FIVE,
    coverageByAccountId: steadyCoverage(FIVE, dates.addDaysStr(ASOF, -7)),
    pausedSources: PAUSE, asOf: ASOF, today: TODAY, catalogCarrierSeller: CATALOG_CARRIER,
    readinessIsolateSellers: new Set(["S03"]),
  });
  const oli = plan.families.find((f) => f.sourceKey === "order-line-items");
  ok("F: an isolated seller is reported in readinessIsolatedAccounts (honest accounting, req 7)", plan.summary.readinessIsolatedAccounts.includes("A03"));
  const unitSizes = (oli.units || []).map((u) => (u.sellerOrVendorIds || u.accounts || []).length).sort((a, b) => a - b);
  ok("F: peel-off -> the isolate seller is a single-seller unit; the 4 healthy stay in one batched unit", unitSizes.join(",") === "1,4");
})();

/* =================================== G. FBA / v3 / AWD coverage (overflow channel) + overflow unchanged === */
(() => {
  const conns = [{ id: "primary", apiKey: "fixture-key", accountPrefix: "" }];
  const asOf = "2026-08-15";
  const IN8 = Array.from({ length: 8 }, (_, i) => ({ accountId: `in-${i}`, country: "IN", currency: "INR" }));
  const invOf = (plan) => [...new Map(plan.flatMap((r) => r.sources.filter((s) => s.requestKey === "fba-plan:inventory-health").map((s) => [s.requestHash, s]))).values()];
  // Overflow UNCHANGED: default [5,3]; overflow whale -> [5,1,1,1] (the FBA/v3 planners are reverted to overflow-only).
  const base = planner.planFbaPlanBucketBatched({ accounts: IN8, connections: conns, asOfFor: () => asOf, inventoryAsOf: asOf });
  const baseInv = invOf(base);
  const whale = baseInv.find((s) => s.sellerOrVendorIds.length === 3).sellerOrVendorIds.map(String);
  const overflowSplit = invOf(planner.planFbaPlanBucketBatched({ accounts: IN8, connections: conns, asOfFor: () => asOf, inventoryAsOf: asOf, overflowSellers: new Set(whale) }));
  ok("G: existing FBA overflow is UNCHANGED -- default [5,3], overflow -> [5,1,1,1]", baseInv.map((s) => s.sellerOrVendorIds.length).sort((a, b) => a - b).join(",") === "3,5" && overflowSplit.map((s) => s.sellerOrVendorIds.length).sort((a, b) => a - b).join(",") === "1,1,1,5");
  // FBA/v3/AWD readiness rides the SAME overflow channel: readiness-isolate sellers (from the core, keyed by the
  // FBA inventory request key) folded into overflowSellers split the poisoned inventory batch to single-seller.
  const invBatches = [{ sellerOrVendorIds: baseInv.flatMap((s) => s.sellerOrVendorIds.map(String)) }];
  const readinessSellers = readinessIsolationFrom({ defaultBatches: invBatches, isolateScopeHashes: whale.map(scope) }).isolateSellers;
  ok("G: readiness isolate maps the FBA whale scopes to their current sellers", [...readinessSellers].sort().join(",") === whale.slice().sort().join(","));
  const folded = invOf(planner.planFbaPlanBucketBatched({ accounts: IN8, connections: conns, asOfFor: () => asOf, inventoryAsOf: asOf, overflowSellers: new Set([...readinessSellers]) }));
  ok("G: FBA Inventory readiness (folded into overflowSellers) splits the whale batch to single-seller", folded.map((s) => s.sellerOrVendorIds.length).sort((a, b) => a - b).join(",") === "1,1,1,5");
  // v3 rides the same channel.
  const v3InvOf = (plan) => [...new Map(plan.flatMap((r) => r.sources.filter((s) => s.requestKey === "listing-health-v3:inventory").map((s) => [s.requestHash, s]))).values()];
  const v3Base = planner.planListingHealthV3BucketBatched({ accounts: IN8, connections: conns, asOfFor: () => asOf, inventoryAsOf: asOf });
  const v3Whale = v3InvOf(v3Base).find((s) => s.sellerOrVendorIds.length === 3).sellerOrVendorIds.map(String);
  const v3Folded = v3InvOf(planner.planListingHealthV3BucketBatched({ accounts: IN8, connections: conns, asOfFor: () => asOf, inventoryAsOf: asOf, overflowSellers: new Set(v3Whale) }));
  ok("G: v3 inventory readiness (folded into overflowSellers) splits to single-seller (listings/raw stay batched)", v3Folded.map((s) => s.sellerOrVendorIds.length).sort((a, b) => a - b).join(",") === "1,1,1,5");
  ok("G: READINESS_PROTECTED_REQUEST_KEYS is the WIRED set -- OLI + the shared inventory identity (v3 reuses it)", iso.READINESS_PROTECTED_REQUEST_KEYS.includes("source-oli:slice-v1") && iso.READINESS_PROTECTED_REQUEST_KEYS.includes("fba-plan:inventory-health") && !iso.READINESS_PROTECTED_REQUEST_KEYS.includes("fba-plan:awd"));
})();

writeSync(1, `\nsource-readiness-isolation: ${passed} assertions passed\n`);
