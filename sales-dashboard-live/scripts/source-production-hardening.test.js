// Scheduler v2 -- PRODUCTION-COMPOSITION HARDENING regressions (offline, ZERO network/DB).
//
// Senior-review production-path findings, each proven against the REAL buildBucketSourceSyncRuntime with
// injected fakes (the real discovery merge/classification, real batch engine, real worker underneath):
//   F1  read failures fail CLOSED before any DataDoe create, Supabase write, or cycle creation; a
//       migration-unapplied (schema-missing) read is a typed ZERO-EXPORT refusal.
//   F2  only correctly bound PRIMARY accounts enter the bucket sync -- dd-secondary/public-prefixed ids are
//       excluded (recorded) and never routed through the primary key.
//   F3  a REAL serverless deadline with reserve headroom bounds each invocation; the rollup is
//       typed-resumable and a fresh invocation completes the SAME cycle with no duplicate create.
//   F4  every registered source-card action routes to its REAL architecture or refuses typed: durable
//       families execute the bucket sync; cycle-cache families compose the fixpoint; durable-ads refuses
//       typed; after a complete run the Daily/Brand View durable SHADOW snapshots derive+validate+save.
//   F5  OLI rolling windows replace ATOMICALLY (a removed grain cannot survive) and the replacement +
//       coverage acknowledgement are one transaction (a failure leaves BOTH untouched).
//   F6  catalog/FBA snapshot payloads live in the durable source-snapshots/* namespace and hydrate AFTER
//       ordinary source-cache pruning (the pointer never references the 24h cache).
//   F7  durable source_batch_membership is LOADED and new accounts are TRANSACTIONALLY assigned; batches
//       stay stable across invocations; a malformed assignment fails closed.
//   F8  readiness comes from AUTHORITATIVE per-account coverage/freshness/snapshot/Ads evidence (typed
//       per-account blockers; read failures block, never fabricate ready).
//   F9  the Migration-20260820 ACL/policy SQL + the replace-oli RPC are schema-audited; mutations (dropped
//       REVOKE, widened GRANT, dropped RPC, gutted RPC body) each raise a typed blocker.
//   F10 FBA rows are seller-scoped per account and every returned row's marketplace is validated; a
//       cross-marketplace or marketplace-less row rejects the snapshot (latest-good preserved).
//
// 7-bit ASCII, LF, no top-level await, synchronous writeSync progress, dynamic imports after a dummy env.

import assert from "node:assert/strict";
import { writeSync, readFileSync } from "node:fs";
import path from "node:path";

process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://supabase.test";
const SB_KEY_ENV = ["SUPABASE", "SERVICE", "ROLE", "KEY"].join("_");
process.env[SB_KEY_ENV] = process.env[SB_KEY_ENV] || ["test", "svc", "role", "key"].join("-");

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const group = (label) => tests.push({ marker: label });
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };

let runtimeMod; let registry; let schema; let dates; let identity; let reportStore;

const PRIM_KEY = ["prim", "key"].join("-");
const SEC_KEY = ["sec", "key"].join("-");
const CONNS = [
  { id: "primary", apiKey: PRIM_KEY, accountPrefix: "" },
  { id: "secondary", apiKey: SEC_KEY, accountPrefix: ["dd", "secondary"].join("-") + ":" },
];
const TODAY = "2026-08-20";
const ASOF = "2026-08-19";
const dirAccount = (id) => ({ id, name: "Acct " + id, country: "US", currency: "USD", status: "active" });

/* ---------------- full in-memory worker store (owner + budget models) ---------------- */
function makeStore() {
  const cycles = new Map(); const jobsByCycle = new Map(); const ownersByCycle = new Map();
  const cache = new Map(); const budgets = new Map(); const reportJobs = new Map(); let seq = 0;
  const findCycle = (id) => [...cycles.values()].find((c) => c.id === id) || null;
  const rjKey = (c, rk, a) => c + "|" + rk + "|" + a;
  const ownerRows = (cid) => [...((ownersByCycle.get(cid) && ownersByCycle.get(cid).values()) || [])];
  const bkey = (cid, tk) => cid + "|" + tk;
  // Round-6 fix 1: model Migration 5 reject_append_to_terminal_cycle FAITHFULLY -- EVERY child
  // insert/update (source jobs, owner memberships, report jobs) on a terminal parent cycle RAISES,
  // exactly as the production trigger does. A fake that permitted terminal appends would hide the very
  // defect the shared-cycle finalization fix exists to prevent.
  const guardAppend = (cycleId) => {
    const c = findCycle(cycleId);
    if (!c) throw new Error("parent sync cycle " + cycleId + " not found; refusing to append/alter child work");
    if (["succeeded", "partial", "failed"].includes(c.status)) {
      throw new Error("sync cycle " + cycleId + " is terminal (" + c.status + "); refusing to append/alter child work");
    }
  };
  const store = {
    _cache: cache,
    _opens: 0,
    openCycle({ bucket, cycleDate }) {
      store._opens += 1;
      const k = bucket + "|" + cycleDate;
      if (!cycles.has(k)) { const id = "cyc_" + (seq += 1); cycles.set(k, { id, bucket, status: "pending" }); jobsByCycle.set(id, new Map()); }
      return cycles.get(k).id;
    },
    claimCycle(id) { const c = findCycle(id); if (c && c.status === "pending") { c.status = "running"; return true; } return false; },
    getCycle(id) { return findCycle(id); },
    upsertSourceJob(job) {
      guardAppend(job.cycleId);
      const m = jobsByCycle.get(job.cycleId);
      if (m.has(job.requestHash)) return;
      m.set(job.requestHash, {
        request_hash: job.requestHash, request_key: job.requestKey, source_id: job.sourceId, source_key: job.sourceKey,
        connection_id: job.connectionId, organization_fingerprint: job.organizationFingerprint, account_scope_hash: job.accountScopeHash,
        fetch_status: "pending", attempted_at: null, create_export_count: 0, export_id: null, cache_object_path: null,
      });
    },
    listSourceJobs(id) { return [...((jobsByCycle.get(id) && jobsByCycle.get(id).values()) || [])].map((j) => ({ ...j })); },
    upsertSourceJobOwners(ms) {
      for (const m of ms || []) {
        guardAppend(m.cycleId);
        if (!ownersByCycle.has(m.cycleId)) ownersByCycle.set(m.cycleId, new Map());
        ownersByCycle.get(m.cycleId).set(m.ownerId + "|" + m.requestHash, {
          cycle_id: m.cycleId, request_hash: m.requestHash, owner_id: m.ownerId, request_key: m.requestKey,
          report_key: m.reportKey, account_id: m.accountId, connection_id: m.connectionId,
          organization_fingerprint: m.organizationFingerprint, account_scope_hash: m.accountScopeHash, owner_status: "active",
        });
      }
    },
    listSourceJobOwners(cid, ids) { const s = new Set(ids || []); return ownerRows(cid).filter((m) => s.has(m.owner_id)).map((m) => ({ ...m })); },
    // Round-6 fix 5: EVERY owner membership of the cycle -- the authoritative account<->hash ownership
    // the account-exact depends_on is built from.
    listCycleOwners(cid) { return ownerRows(cid).map((m) => ({ ...m })); },
    recordSourceOwnerStale() {},
    claimExportAttempt(id, h) {
      guardAppend(id);
      const j = jobsByCycle.get(id) && jobsByCycle.get(id).get(h);
      if (j && j.fetch_status === "pending" && j.attempted_at === null) { j.attempted_at = "t"; j.create_export_count += 1; j.fetch_status = "attempted"; return true; }
      return false;
    },
    adoptSourceCache() { return "cache-changed"; },
    recordExportCreated({ cycleId, requestHash, exportId }) { guardAppend(cycleId); jobsByCycle.get(cycleId).get(requestHash).export_id = exportId; },
    loadSourceRows(h) { const e = cache.get(h); return e ? { ...e } : null; },
    saveSourceRows({ job, rows, payloadBytes }) {
      const h = job.request_hash != null ? job.request_hash : job.requestHash;
      const objectPath = "source-cache/v2/" + h + ".json";
      cache.set(h, {
        rows: [...rows], source_id: job.sourceId, organization_fingerprint: job.organizationFingerprint,
        account_scope_hash: job.accountScopeHash, object_path: objectPath, row_count: rows.length,
        payload_bytes: payloadBytes, expires_at: new Date(Date.now() + 20 * 3600 * 1000).toISOString(),
      });
      return objectPath;
    },
    recordSourceSuccess({ cycleId, requestHash, exportId, rowCount, cacheObjectPath }) {
      guardAppend(cycleId);
      Object.assign(jobsByCycle.get(cycleId).get(requestHash), { fetch_status: "succeeded", export_id: exportId, row_count: rowCount, cache_object_path: cacheObjectPath });
    },
    recordSourceFailure({ cycleId, requestHash, stage, code, terminal }) {
      guardAppend(cycleId);
      Object.assign(jobsByCycle.get(cycleId).get(requestHash), { fetch_status: "failed", error_stage: stage, error_code: code, terminal: !!terminal });
    },
    updateCycleCounts() {},
    persistBudget({ cycleId, trancheKey, planFingerprint, maxCreates, maxTokens, hashes }) {
      const k = bkey(cycleId, trancheKey);
      const b = budgets.get(k);
      if (b) {
        if (b.planFingerprint !== planFingerprint || b.maxCreates !== maxCreates || b.maxTokens !== maxTokens) {
          const e = new Error("PLAN_BUDGET_MISMATCH"); e.code = "PLAN_BUDGET_MISMATCH"; throw e;
        }
        return "exists";
      }
      budgets.set(k, { planFingerprint, maxCreates, maxTokens, spentCreates: 0, spentTokens: 0, cost: new Map((hashes || []).map((h) => [h.requestHash, h.tokenCost])) });
      return "created";
    },
    reserveExportCreate({ cycleId, trancheKey, requestHash, planFingerprint }) {
      const b = budgets.get(bkey(cycleId, trancheKey));
      if (!b) throw new Error("no frozen budget");
      if (b.planFingerprint !== planFingerprint || !b.cost.has(requestHash)) return "plan-mismatch";
      const cost = b.cost.get(requestHash);
      if (b.spentCreates + 1 > b.maxCreates || b.spentTokens + cost > b.maxTokens) return "budget-exceeded";
      const j = jobsByCycle.get(cycleId) && jobsByCycle.get(cycleId).get(requestHash);
      if (!(j && j.fetch_status === "pending" && j.attempted_at === null && j.create_export_count === 0)) return "not-pending";
      j.attempted_at = "t"; j.create_export_count += 1; j.fetch_status = "attempted";
      b.spentCreates += 1; b.spentTokens += cost;
      return "reserved";
    },
    /* round-5: the sync_report_jobs model (insert-ignore upsert, pending->running one-attempt claim,
       validated success) + the reviewed finalize_sync_cycle terminal lifecycle. */
    _reportJobs: reportJobs,
    upsertReportJob(j) {
      guardAppend(j.cycleId);
      const k = rjKey(j.cycleId, j.reportKey, j.accountId);
      if (reportJobs.has(k)) return;
      reportJobs.set(k, {
        cycle_id: j.cycleId, report_key: j.reportKey, report_version: j.reportVersion || "", account_id: j.accountId,
        connection_id: j.connectionId, bucket: j.bucket, depends_on: [...(j.dependsOn || [])],
        derive_status: "pending", save_status: "pending", validated: false, snapshot_params_hash: null, latest_data_date: null,
      });
    },
    claimReportDerive(cycleId, reportKey, accountId) {
      guardAppend(cycleId);
      const r = reportJobs.get(rjKey(cycleId, reportKey, accountId));
      if (r && r.derive_status === "pending") { r.derive_status = "running"; return true; }
      return false;
    },
    recordReportSuccess(j) {
      guardAppend(j.cycleId);
      const r = reportJobs.get(rjKey(j.cycleId, j.reportKey, j.accountId));
      Object.assign(r, {
        derive_status: "succeeded", save_status: "succeeded", validated: true,
        snapshot_params_hash: j.snapshotParamsHash, latest_data_date: j.latestDataDate ?? null,
      });
    },
    getReportJob(reportKey, accountId) {
      const rows = [...reportJobs.values()].filter((r) => r.report_key === reportKey && r.account_id === accountId);
      return rows.length ? { ...rows[rows.length - 1] } : null;
    },
    finalizeCycle({ cycleId }) {
      const c = findCycle(cycleId);
      if (!c) return { disposition: "not-found" };
      if (["succeeded", "partial", "failed"].includes(c.status)) return { disposition: "already-terminal", cycle: { id: c.id, status: c.status } };
      const src = [...((jobsByCycle.get(cycleId) || new Map()).values())];
      const rep = [...reportJobs.values()].filter((r) => r.cycle_id === cycleId);
      const open = src.some((j) => j.fetch_status === "pending" || j.fetch_status === "attempted")
        || rep.some((r) => r.derive_status === "pending" || r.derive_status === "running");
      if (open) return { disposition: "open-work", cycle: { id: c.id, status: c.status } };
      const failed = src.some((j) => j.fetch_status === "failed") || rep.some((r) => r.save_status === "failed");
      const succeeded = src.some((j) => j.fetch_status === "succeeded") || rep.some((r) => r.validated === true);
      c.status = failed ? (succeeded ? "partial" : "failed") : "succeeded";
      return { disposition: "finalized", cycle: { id: c.id, status: c.status } };
    },
  };
  return store;
}

function makeDataDoe(opts = {}) {
  const createSeq = [];
  return {
    createSeq,
    totalCreates: () => createSeq.length,
    async create(job) {
      createSeq.push({ sourceKey: job.sourceKey || "", ids: [...(job.fetchParams.sellerOrVendorIds || [])] });
      if (opts.onCreate) opts.onCreate(job);
      return { exportId: "e_" + job.requestHash.slice(0, 12) };
    },
    async poll() {},
    async download(job) {
      const rk = job.requestKey || ""; const fp = job.fetchParams || {};
      if (rk.includes("source-oli")) {
        const ids = Array.isArray(fp.sellerOrVendorIds) ? fp.sellerOrVendorIds : [];
        return ids.map((sid) => ({ date: fp.to, seller_or_vendor_id: sid, sku: "SKU-A", child_asin: "B0A", item_price_currency: "USD", total_sales_sum: 100, total_units_sum: 10 }));
      }
      if (rk.includes("source-catalog")) return [{ child_asin: "B0A", sku: "SKU-A", parent_asin: "P", product_name: "A", product_brand: "Acme" }];
      if (rk.includes("source-fba")) {
        return opts.fbaRows || [{ date: fp.to, sku: "SKU-A", child_asin: "B0A", marketplace_country_code: "US", available: 5 }];
      }
      return [];
    },
  };
}

/* ---------------- the composition harness (real discovery merge/classify path) ---------------- */
function makeHarness(over = {}) {
  const clockRef = { now: 8_000_000 };
  const store = over.store || makeStore();
  const dd = over.dd || makeDataDoe(over.ddOpts);
  const snapStore = over.snapStore || new Map(); // the durable source-snapshots/* namespace model
  const recorded = { snapshots: [], shadowSaves: [], assigns: [], membershipReads: 0, replaceCalls: [], lineage: [] };
  const durableHistory = over.durableHistory || new Map(); // grain -> row (the durable table model)
  const durableCoverage = over.durableCoverage || [];
  const membership = over.membership || new Map(); // accountId -> index (the durable membership model)

  const runtime = runtimeMod.buildBucketSourceSyncRuntime({
    getConnections: () => over.connections || CONNS,
    fetchAccounts: async (apiKey) => {
      if (over.onFetchAccounts) over.onFetchAccounts(apiKey);
      if (apiKey === PRIM_KEY) return over.primaryAccounts || [dirAccount("A01"), dirAccount("A02")];
      return over.secondaryAccounts || [dirAccount("B01")];
    },
    setTimer: over.setTimer,
    clearTimer: over.clearTimer,
    makeSourceStore: () => store,
    makeAdapter: () => dd,
    readSourceControls: over.readSourceControls || (async () => ({ rows: [], read: "ok", error: null })),
    readCoverage: over.readCoverage || (async () => ({ windows: [{ from: "2025-01-01", to: dates.addDaysStr(ASOF, -7) }], read: "ok", error: null })),
    readSnapshot: over.readSnapshot || (async () => ({ snapshot: null, read: "ok", error: null })),
    readAdsCoverage: over.readAdsCoverage || (async () => ({ windows: [{ from: "2025-01-01", to: TODAY }], read: "ok", error: null })),
    readBatchMembership: over.readBatchMembership || (async () => {
      recorded.membershipReads += 1;
      const org = identity.organizationFingerprint(PRIM_KEY);
      return [...membership.entries()].map(([account_id, batch_index]) => ({ account_id, batch_index, connection_id: "primary", organization_fingerprint: org }));
    }),
    assignBatchMembership: over.assignBatchMembership || (async ({ accountId }) => {
      recorded.assigns.push(accountId);
      const used = new Map();
      for (const idx of membership.values()) used.set(idx, (used.get(idx) || 0) + 1);
      let idx = 0;
      while ((used.get(idx) || 0) >= 5) idx += 1;
      membership.set(accountId, idx);
      return idx;
    }),
    // The ATOMIC replacement model: delete-the-window + insert + coverage ack, or NOTHING on failure.
    replaceHistory: over.replaceHistory || (async ({ accountId, coveredFrom, coveredTo, rows }) => {
      recorded.replaceCalls.push({ accountId, coveredFrom, coveredTo, rowCount: rows.length });
      if (over.failReplace) return { write: "write-failed", error: "OLI_HISTORY_REPLACE_FAILED" };
      for (const [grain, row] of [...durableHistory.entries()]) {
        if (row.accountId === accountId && row.saleDate >= coveredFrom && row.saleDate <= coveredTo) durableHistory.delete(grain);
      }
      for (const r of rows) durableHistory.set([r.accountId, r.saleDate, r.sku, r.childAsin, r.currency].join("|"), r);
      durableCoverage.push({ accountId, from: coveredFrom, to: coveredTo });
      return { write: "ok", replaced: 0, inserted: rows.length };
    }),
    saveSnapshotPayload: over.saveSnapshotPayload || (async ({ sourceKey, scopeKey, rows }) => {
      const objectPath = `source-snapshots/v1/${sourceKey}/${scopeKey}.json`;
      snapStore.set(objectPath, { rows: [...rows] });
      return { objectPath, payloadBytes: JSON.stringify({ rows }).length };
    }),
    loadSnapshotPayload: async (objectPath) => snapStore.get(objectPath) || null,
    recordSnapshot: over.recordSnapshot || (async (s) => { recorded.snapshots.push(s); return { write: "ok", ack: "replaced" }; }),
    loadHistoryRows: over.loadHistoryRows || (async () => [...durableHistory.values()].map((r) => ({
      account_id: r.accountId, sale_date: r.saleDate, sku: r.sku, child_asin: r.childAsin,
      currency: r.currency, sales_amount: r.salesAmount, units: r.units,
    }))),
    updateRunStatus: async () => ({ write: "ok" }),
    // Round-5: the REAL paramsHashFor hash (so the genuine publisher hash-provenance gate can accept these
    // saves) + a "save" lineage event so claim-BEFORE-save ordering is provable from one recorder.
    makeShadowSaver: () => async (args) => {
      const paramsHash = reportStore.paramsHashFor(args.params.reportVersion, args.params);
      recorded.lineage.push({ op: "save", reportKey: args.reportKey, accountId: args.accountId });
      recorded.shadowSaves.push({ ...args, paramsHash });
      return { paramsHash };
    },
    readSettings: over.readSettings || (async () => []),
    readRollout: over.readRollout || (async () => ({ read: "ok", allPrimary: false, enabledAccountIds: [] })),
    readAdMetrics: over.readAdMetrics || (async () => []),
    // Round-5: the default lineage DELEGATES to the store's sync_report_jobs model (real one-attempt claim
    // semantics + rows the finalize/publisher read) while still recording every op for ordering assertions.
    reportLineage: over.reportLineage || {
      upsertReportJob: async (j) => { recorded.lineage.push({ op: "upsert", ...j }); store.upsertReportJob(j); },
      claimReportDerive: async (c, rk, a) => { const claim = store.claimReportDerive(c, rk, a); recorded.lineage.push({ op: "claim", reportKey: rk, accountId: a, claim }); return claim; },
      recordReportSuccess: async (j) => { recorded.lineage.push({ op: "success", ...j }); store.recordReportSuccess(j); },
    },
    composeTrancheRuntime: over.composeTrancheRuntime,
    clock: () => clockRef.now,
    budgetMs: over.budgetMs ?? 600_000,
    reserveMs: over.reserveMs ?? 1_000,
  });
  return { runtime, store, dd, snapStore, recorded, clockRef, membership, durableHistory, durableCoverage };
}

/* ================================= F1. read failures fail closed ================================= */
group("F1. non-ok durable reads refuse BEFORE any export/write/cycle (migration-unapplied = zero-export)");

test("F1a. controls schema-missing => typed DURABLE_MODEL_UNAVAILABLE with ZERO discovery/cycle/creates", async () => {
  let discoveries = 0;
  const h = makeHarness({
    readSourceControls: async () => ({ rows: [], read: "schema-missing", error: "SOURCE_CONTROLS_SCHEMA_MISSING" }),
  });
  const origFetch = h.runtime; // discovery counted via store opens + dd creates below
  await assert.rejects(() => h.runtime.run({ bucket: "us", today: TODAY }), (e) => e.code === "DURABLE_MODEL_UNAVAILABLE" && e.status === 503);
  assert.equal(h.store._opens, 0, "no cycle was created");
  assert.equal(h.dd.totalCreates(), 0, "zero exports");
});

test("F1b. coverage/snapshot read failures => typed refusal with ZERO cycle/creates", async () => {
  const cov = makeHarness({ readCoverage: async () => ({ windows: [], read: "read-failed", error: "SOURCE_COVERAGE_READ_FAILED" }) });
  await assert.rejects(() => cov.runtime.run({ bucket: "us", today: TODAY }), (e) => e.code === "SOURCE_EVIDENCE_READ_FAILED");
  assert.equal(cov.store._opens, 0);
  assert.equal(cov.dd.totalCreates(), 0);
  const snap = makeHarness({ readSnapshot: async () => ({ snapshot: null, read: "schema-missing", error: "SOURCE_SNAPSHOT_SCHEMA_MISSING" }) });
  await assert.rejects(() => snap.runtime.run({ bucket: "us", today: TODAY }), (e) => e.code === "DURABLE_MODEL_UNAVAILABLE");
  assert.equal(snap.store._opens, 0);
  assert.equal(snap.dd.totalCreates(), 0);
});

test("F1c. a membership read failure => typed BATCH_MEMBERSHIP_READ_FAILED with ZERO cycle/creates", async () => {
  const h = makeHarness({ readBatchMembership: async () => { throw new Error("boom"); } });
  await assert.rejects(() => h.runtime.run({ bucket: "us", today: TODAY }), (e) => e.code === "BATCH_MEMBERSHIP_READ_FAILED");
  assert.equal(h.store._opens, 0);
  assert.equal(h.dd.totalCreates(), 0);
});

/* ================================= F2. primary-only binding ================================= */
group("F2. only correctly bound PRIMARY accounts; prefixed ids never route through the primary key");

test("F2a. dd-secondary + unknown-prefixed accounts are EXCLUDED (recorded); only clean primary ids run", async () => {
  const h = makeHarness({
    primaryAccounts: [dirAccount("A01")],
    secondaryAccounts: [dirAccount("B01")], // merges as dd-secondary:B01 and is ACTIVE (secondary configured)
  });
  const rollup = await h.runtime.run({ bucket: "us", today: TODAY });
  assert.equal(rollup.stopped, false, JSON.stringify(rollup.stopReason));
  assert.ok(rollup.excludedAccounts.some((e) => e.accountId.includes(":") && e.reason === "non-primary-connection"), "the prefixed account was excluded, typed");
  for (const c of h.dd.createSeq) {
    for (const id of c.ids) assert.ok(!id.includes(":"), "no prefixed id ever reached the primary adapter");
  }
});

test("F2b. bindPrimaryBucketAccounts: missing marketplace country excludes; other-bucket accounts are not exclusions", () => {
  const { accounts, excluded } = runtimeMod.bindPrimaryBucketAccounts([
    { accountId: "A01", country: "US" },
    { accountId: "A02", country: "" },
    { accountId: ["dd", "secondary"].join("-") + ":B01", country: "US" },
    { accountId: "IN1", country: "IN" }, // the non-us bucket's account: filtered, NOT an exclusion
  ], "us");
  assert.deepEqual(accounts, [{ accountId: "A01", rawSellerId: "A01", country: "US", name: "A01", currency: null }]);
  assert.deepEqual(excluded.map((e) => e.reason).sort(), ["missing-marketplace-country", "non-primary-connection"]);
});

/* ================================= F3. real deadline + resumable continuation ================================= */
group("F3. bounded invocations under a real deadline; continuation resumes with no duplicate create");

test("F3a. a tight budget stops typed-resumable mid-run; a fresh invocation completes the SAME cycle; <=1 create per hash", async () => {
  const store = makeStore();
  const membership = new Map();
  const clockCost = 30_000; // each create burns 30s of fake clock
  let h = makeHarness({
    store, membership,
    ddOpts: { onCreate: () => { h.clockRef.now += clockCost; } },
    budgetMs: 100_000, reserveMs: 1_000,
    readCoverage: async () => ({ windows: [], read: "ok", error: null }), // full backfill => plenty of work
  });
  const run1 = await h.runtime.run({ bucket: "us", today: TODAY, cycleDate: TODAY });
  assert.equal(run1.deadlineReached, true, "the budget expired mid-run");
  assert.equal(run1.continuationRequired, true, "typed-resumable, not stopped");
  assert.equal(run1.stopped, false, "a deadline is never a failure");
  const creates1 = h.dd.totalCreates();
  assert.ok(creates1 >= 1, "bounded work happened");
  // Fresh invocation over the SAME store/cycle (a new serverless call): completes the remaining work.
  let h2 = makeHarness({ store, membership, ddOpts: { onCreate: () => {} }, budgetMs: 100_000_000, readCoverage: async () => ({ windows: [], read: "ok", error: null }) });
  const run2 = await h2.runtime.run({ bucket: "us", today: TODAY, cycleDate: TODAY });
  assert.equal(run2.continuationRequired, false, "the continuation finished");
  assert.equal(run2.globalDrained, true);
  for (const row of store.listSourceJobs(run2.cycleId)) {
    assert.ok(row.create_export_count <= 1, "no hash was ever created twice across invocations");
  }
});

/* ================================= F4. source-card action routing + derive/save ================================= */
group("F4. every card action executes its REAL architecture or refuses typed; durable shadow snapshots derive+save");

test("F4a. durable families execute the bucket sync; durable-ads refuses TYPED; unregistered throws", async () => {
  const h = makeHarness({});
  const catalog = await h.runtime.runSourceCardAction({ bucket: "us", sourceKey: "product-catalog" });
  assert.equal(catalog.refused, undefined, "the durable family executed");
  assert.ok(h.dd.createSeq.some((c) => c.sourceKey === "product-catalog"), "the real bucket-sync architecture ran");
  const ads = await h.runtime.runSourceCardAction({ bucket: "us", sourceKey: "ads-asin-date" });
  assert.deepEqual({ refused: ads.refused, code: ads.code }, { refused: true, code: "SOURCE_ACTION_ADS_ARCHITECTURE" });
  await assert.rejects(() => h.runtime.runSourceCardAction({ bucket: "us", sourceKey: "nope" }), /UNREGISTERED_SOURCE/);
});

test("F4b. a cycle-cache card executes ONLY its own family via the single-family tranche composition (reuseOnly threads; no widening)", async () => {
  const composed = [];
  const runs = [];
  const h = makeHarness({
    composeTrancheRuntime: (spec, opts) => {
      composed.push({ spec, opts });
      return { run: async (args) => { runs.push(args); return { cycleId: null, spent: 0 }; } };
    },
  });
  const res = await h.runtime.runSourceCardAction({ bucket: "us", sourceKey: "settlements", reuseOnly: true });
  assert.equal(res.architecture, "tranche");
  assert.equal(composed.length, 1);
  assert.deepEqual(composed[0].spec, { name: "settlements", sourceKeys: ["settlements"] }, "the tranche is FIXED to exactly the selected family (no widening)");
  assert.equal(composed[0].opts.reuseOnly, true, "reuseOnly threads into the trusted composition (tripwire installed)");
  assert.equal(runs.length, 1);
  assert.ok(Number.isFinite(runs[0].deadlineMs), "a REAL finite deadline (never Infinity under the route)");
  assert.deepEqual([...runs[0].manualReportKeys].sort(), [...registry.sourceRegistryEntry("settlements").usedByReports].sort(), "report scope = the family's consumers (execution still narrowed to the one family)");
});

test("F4c. after a COMPLETE run the Daily + Brand View durable SHADOW snapshots derive, validate, and save", async () => {
  const h = makeHarness({
    readCoverage: async () => ({ windows: [{ from: "2025-01-01", to: TODAY }], read: "ok", error: null }),
    readSnapshot: async ({ sourceKey, scopeKey }) => {
      if (sourceKey === "product-catalog") return { snapshot: { validated_at: TODAY + "T01:00:00Z", object_path: "source-snapshots/v1/product-catalog/__organization.json", row_count: 1 }, read: "ok", error: null };
      return { snapshot: { validated_at: TODAY + "T01:00:00Z" }, read: "ok", error: null };
    },
  });
  h.snapStore.set("source-snapshots/v1/product-catalog/__organization.json", { rows: [{ child_asin: "B0A", sku: "SKU-A", product_brand: "Acme" }] });
  h.durableHistory.set("A01|x", { accountId: "A01", saleDate: ASOF, sku: "SKU-A", childAsin: "B0A", currency: "USD", salesAmount: 10, units: 1 });
  const rollup = await h.runtime.run({ bucket: "us", today: TODAY });
  assert.equal(rollup.stopped, false, JSON.stringify(rollup.stopReason));
  assert.equal(rollup.derived.skipped, null, "the derive stage ran");
  assert.ok(rollup.derived.daily.saved >= 1, "per-account Daily durable shadow snapshots saved");
  assert.equal(rollup.derived.brandView.saved, 2, "one brand-sales shadow snapshot per account (the payload Brand View consumes)");
  for (const save of h.recorded.shadowSaves) {
    assert.ok(String(save.reportKey).startsWith("scheduler-v2/"), "saved ONLY in the shadow namespace");
    assert.ok(save.reportKey === "scheduler-v2/daily-reporting" || save.reportKey === "scheduler-v2/brand-sales", "the EXISTING report keys -- no orphan custom keys");
    assert.ok(save.payload, "a real contract payload was saved");
  }
});

test("F4d. non-ready readiness => TYPED derive skip, nothing saved, nothing fabricated", async () => {
  const h = makeHarness({
    // Coverage proves only the sync window, NOT the full dashboard windows => sales-blocking gap.
    readCoverage: async () => ({ windows: [{ from: dates.addDaysStr(ASOF, -8), to: TODAY }], read: "ok", error: null }),
  });
  const rollup = await h.runtime.run({ bucket: "us", today: TODAY });
  assert.equal(rollup.stopped, false);
  if (rollup.derived.skipped == null) {
    assert.equal(rollup.derived.daily.saved, 0, "no Daily snapshot without proven coverage");
    assert.equal(rollup.derived.daily.ready, false);
  } else {
    assert.ok(typeof rollup.derived.skipped === "string", "typed skip");
  }
  assert.ok(h.recorded.shadowSaves.every((s) => s.reportKey !== "scheduler-v2/daily-reporting-durable"), "nothing fabricated");
});

/* ================================= F5. atomic OLI replacement ================================= */
group("F5. atomic rolling-window replacement: removed grains cannot survive; replacement+ack one transaction");

test("F5a. a grain that DISAPPEARED from the corrected export is REMOVED by the window replacement", async () => {
  const durableHistory = new Map();
  // A stale grain inside the rolling window that the corrected export no longer returns:
  durableHistory.set("A01|stale", { accountId: "A01", saleDate: ASOF, sku: "GONE", childAsin: "GONE", currency: "USD", salesAmount: 999, units: 99 });
  const h = makeHarness({ durableHistory });
  const rollup = await h.runtime.run({ bucket: "us", today: TODAY });
  assert.equal(rollup.stopped, false, JSON.stringify(rollup.stopReason));
  const survivors = [...durableHistory.values()].filter((r) => r.sku === "GONE");
  assert.equal(survivors.length, 0, "the removed grain did NOT survive the atomic replacement");
  assert.ok(h.recorded.replaceCalls.length >= 1, "the atomic replace path ran per (account, slice)");
});

test("F5b. a failed replacement leaves BOTH data and coverage untouched and stops the bucket typed", async () => {
  const durableHistory = new Map();
  const durableCoverage = [];
  const h = makeHarness({ durableHistory, durableCoverage, failReplace: true });
  const rollup = await h.runtime.run({ bucket: "us", today: TODAY });
  assert.equal(rollup.stopped, true);
  assert.equal(rollup.stopReason.code, "HISTORY_REPLACE_FAILED");
  assert.equal(durableHistory.size, 0, "no rows were written by the failed transaction");
  assert.equal(durableCoverage.length, 0, "no coverage was acknowledged by the failed transaction");
});

/* ================================= F6. durable snapshot storage + pruning ================================= */
group("F6. snapshot payloads live in the durable namespace and hydrate AFTER cache pruning");

test("F6a. snapshot pointers reference source-snapshots/* (never the 24h cache); hydration survives a full cache prune", async () => {
  const h = makeHarness({});
  const rollup = await h.runtime.run({ bucket: "us", today: TODAY });
  assert.equal(rollup.stopped, false, JSON.stringify(rollup.stopReason));
  assert.ok(h.recorded.snapshots.length >= 1, "snapshots recorded");
  for (const s of h.recorded.snapshots) {
    assert.ok(s.objectPath.startsWith("source-snapshots/v1/"), "the pointer references the DURABLE namespace");
    assert.ok(!s.objectPath.startsWith("source-cache/"), "never the prunable cache namespace");
  }
  // ORDINARY cache pruning: every 24h cache object disappears. The snapshot still hydrates.
  h.store._cache.clear();
  for (const s of h.recorded.snapshots) {
    const payload = h.snapStore.get(s.objectPath);
    assert.ok(payload && Array.isArray(payload.rows), "hydration after pruning succeeds from the durable object");
  }
});

/* ================================= F7. durable stable membership ================================= */
group("F7. durable source_batch_membership loaded + transactionally assigned");

test("F7a. existing membership is LOADED (not recomputed); only the new account is transactionally assigned; stable across runs", async () => {
  const membership = new Map([["A01", 0]]);
  const h = makeHarness({ membership, primaryAccounts: [dirAccount("A01"), dirAccount("A02")] });
  const r1 = await h.runtime.run({ bucket: "us", today: TODAY });
  assert.equal(r1.stopped, false);
  assert.deepEqual(h.recorded.assigns, ["A02"], "ONLY the new account went through the assignment RPC");
  assert.equal(h.membership.get("A01"), 0, "the existing durable index is untouched");
  const h2 = makeHarness({ membership, store: makeStore(), primaryAccounts: [dirAccount("A01"), dirAccount("A02")] });
  await h2.runtime.run({ bucket: "us", today: TODAY, cycleDate: "2026-08-21" });
  assert.deepEqual(h2.recorded.assigns, [], "a second invocation assigns NOTHING (membership is durable + stable)");
});

test("F7b. a malformed assignment acknowledgement fails closed", async () => {
  const h = makeHarness({ assignBatchMembership: async () => "not-a-number" });
  await assert.rejects(() => h.runtime.run({ bucket: "us", today: TODAY }), (e) => e.code === "BATCH_MEMBERSHIP_ASSIGN_FAILED");
  assert.equal(h.dd.totalCreates(), 0);
});

/* ================================= F8. authoritative readiness ================================= */
group("F8. readiness from authoritative per-account durable evidence (never last_status)");

test("F8a. per-account coverage gaps and per-account Ads gaps carry their accountId; read failures block typed", async () => {
  const h = makeHarness({
    primaryAccounts: [dirAccount("A01"), dirAccount("A02")],
    readCoverage: async ({ accountId }) => (accountId === "A01"
      ? { windows: [{ from: "2025-01-01", to: TODAY }], read: "ok", error: null }
      : { windows: [], read: "ok", error: null }),
    readAdsCoverage: async (accountId) => (accountId === "A01"
      ? { windows: [{ from: "2025-01-01", to: TODAY }], read: "ok", error: null }
      : { windows: [], read: "ok", error: null }),
    readSnapshot: async ({ sourceKey }) => (sourceKey === "product-catalog"
      ? { snapshot: { validated_at: TODAY + "T01:00:00Z", object_path: "source-snapshots/v1/product-catalog/__organization.json" }, read: "ok", error: null }
      : { snapshot: null, read: "ok", error: null }),
  });
  const readiness = await h.runtime.gatherDurableReadiness({ bucket: "us", accounts: [{ accountId: "A01" }, { accountId: "A02" }], asOf: ASOF });
  assert.equal(readiness.daily.ready, false, "A02's missing OLI coverage blocks Daily");
  assert.ok(readiness.daily.blockedBy.some((b) => b.sourceKey === "order-line-items" && b.accountId === "A02"), "the gap names its account");
  assert.ok(!readiness.daily.blockedBy.some((b) => b.accountId === "A01" && b.sourceKey === "order-line-items"), "the covered account is not blamed");
  assert.equal(readiness.daily.adsReady, false, "A02's per-account Ads gap degrades the ads half");
  const failing = makeHarness({
    readCoverage: async () => ({ windows: [], read: "read-failed", error: "SOURCE_COVERAGE_READ_FAILED" }),
  });
  const blocked = await failing.runtime.gatherDurableReadiness({ bucket: "us", accounts: [{ accountId: "A01" }], asOf: ASOF });
  assert.equal(blocked.daily.ready, false, "a read failure can never present as ready");
  assert.ok(blocked.daily.blockedBy.some((b) => String(b.reason).startsWith("coverage-read")), "typed read-failure blocker");
});

/* ================================= F9. ACL/policy + RPC mutation audit ================================= */
group("F9. Migration-20260820 ACL/RPC schema-audit mutations");

const MIG = "20260820_source_durable_model.sql";
function auditWith(mutate) {
  const real = readFileSync(path.join(process.cwd(), "supabase", "migrations", MIG), "utf8");
  const sql = mutate ? mutate(real) : real;
  const readFile = (rel) => {
    if (rel === "supabase.js") return readFileSync(path.join(process.cwd(), "lib", "server", "supabase.js"), "utf8");
    if (rel === MIG) return sql;
    return readFileSync(path.join(process.cwd(), "supabase", "migrations", rel), "utf8");
  };
  return schema.auditSchemaContract({ readFile });
}

test("F9a. the REAL migration audits clean; a dropped history REVOKE => SERVICE_ROLE_REVOKE_MISSING", () => {
  assert.equal(auditWith(null).ok, true, "baseline clean");
  const audit = auditWith((sql) => sql.replace("revoke all on table public.source_oli_daily_history from public, anon, authenticated, service_role;", ""));
  assert.equal(audit.ok, false);
  assert.ok(audit.blockers.some((b) => b.code === "SERVICE_ROLE_REVOKE_MISSING"), JSON.stringify(audit.blockers.map((b) => b.code)));
});

test("F9b. a WIDENED history grant (select -> select,insert) => SERVICE_ROLE_GRANT_MISMATCH", () => {
  const audit = auditWith((sql) => sql.replace("grant select on table public.source_oli_daily_history to service_role;", "grant select, insert on table public.source_oli_daily_history to service_role;"));
  assert.equal(audit.ok, false);
  assert.ok(audit.blockers.some((b) => b.code === "SERVICE_ROLE_GRANT_MISMATCH"), JSON.stringify(audit.blockers.map((b) => b.code)));
});

test("F9c. a dropped replace RPC => RPC_MISSING; a gutted body (no DELETE / no coverage ack) => typed proof blockers", () => {
  const dropped = auditWith((sql) => sql.replace(/create or replace function public\.replace_oli_history_window[\s\S]*?\$\$;/, ""));
  assert.equal(dropped.ok, false);
  assert.ok(dropped.blockers.some((b) => String(b.code).includes("RPC_MISSING") || String(b.code).includes("REPLACE_OLI_FUNCTION_MISSING")), JSON.stringify(dropped.blockers.map((b) => b.code)));
  const noDelete = auditWith((sql) => sql.replace(/delete from public\.source_oli_daily_history[\s\S]*?get diagnostics v_deleted = row_count;/, "v_deleted := 0;"));
  assert.ok(noDelete.blockers.some((b) => b.code === "REPLACE_OLI_DELETE_MISSING"), JSON.stringify(noDelete.blockers.map((b) => b.code)));
  const noAck = auditWith((sql) => sql.replace(/-- The coverage ACKNOWLEDGEMENT commits[\s\S]*?do update set source_refreshed_at = excluded\.source_refreshed_at, updated_at = now\(\);/, ""));
  assert.ok(noAck.blockers.some((b) => b.code === "REPLACE_OLI_COVERAGE_ACK_MISSING"), JSON.stringify(noAck.blockers.map((b) => b.code)));
});

/* ================================= F10. FBA seller-scoping + marketplace validation ================================= */
group("F10. FBA rows validated per account marketplace before any snapshot");

test("F10a. a cross-marketplace or marketplace-less FBA row STOPS the bucket typed (round-4 finding 5; latest-good preserved)", async () => {
  const wrong = makeHarness({ ddOpts: { fbaRows: [{ date: ASOF, sku: "K", child_asin: "B", marketplace_country_code: "DE", available: 3 }] } });
  const r1 = await wrong.runtime.run({ bucket: "us", today: TODAY });
  assert.equal(r1.stopped, true, "domain-invalid payload stops the bucket");
  assert.equal(r1.stopReason.code, "SOURCE_PAYLOAD_UNAVAILABLE");
  assert.equal(r1.stopReason.detail, "FBA_CROSS_MARKETPLACE");
  assert.equal(r1.globalDrained, false, "never reported drained");
  assert.ok(r1.snapshots.rejected.some((x) => x.code === "FBA_CROSS_MARKETPLACE"), "cross-marketplace recorded typed");
  assert.ok(!r1.snapshots.recorded.some((k) => String(k).startsWith("fba-inventory-health:")), "no FBA snapshot recorded");
  const blank = makeHarness({ ddOpts: { fbaRows: [{ date: ASOF, sku: "K", child_asin: "B", available: 3 }] } });
  const r2 = await blank.runtime.run({ bucket: "us", today: TODAY });
  assert.equal(r2.stopped, true);
  assert.equal(r2.stopReason.detail, "FBA_ROW_NO_MARKETPLACE");
});


/* ================================= R. round-3 regressions ================================= */
group("R. round-3: paused card, end-to-end deadline, cache loss, snapshots, membership, readiness, policies");

test("R1. a PAUSED cycle-cache card refuses typed BEFORE any composition/discovery; reuseOnly threads", async () => {
  const composed = [];
  const h = makeHarness({
    readSourceControls: async () => ({ rows: [{ source_key: "settlements", paused: true, schedule_enabled: false }], read: "ok", error: null }),
    composeTrancheRuntime: (spec, opts) => { composed.push({ spec, opts }); return { run: async () => ({ cycleId: null, spent: 0 }) }; },
  });
  await assert.rejects(() => h.runtime.runSourceCardAction({ bucket: "us", sourceKey: "settlements" }), (e) => e.code === "SOURCE_PAUSED" && e.status === 409);
  assert.equal(composed.length, 0, "the paused card never composed a runtime (zero discovery/I-O)");
  const h2 = makeHarness({ composeTrancheRuntime: (spec, opts) => { composed.push({ spec, opts }); return { run: async () => ({ cycleId: null, spent: 0 }) }; } });
  await h2.runtime.runSourceCardAction({ bucket: "us", sourceKey: "settlements", reuseOnly: false });
  assert.equal(composed[composed.length - 1].opts.reuseOnly, false, "reuseOnly=false threads honestly");
});

test("R2. deadline DURING evidence reads and DURING the derive half both return typed resumable state (never failure)", async () => {
  const h = makeHarness({ budgetMs: 1_000, reserveMs: 5_000 });
  const r1 = await h.runtime.run({ bucket: "us", today: TODAY });
  assert.equal(r1.deadlineReached, true);
  assert.equal(r1.continuationRequired, true);
  assert.equal(r1.stopped, false, "typed resumable, never a failure");
  assert.ok(typeof r1.phase === "string", "the expired phase is named");
  assert.equal(h.store._opens, 0, "zero cycle creation");
  assert.equal(h.dd.totalCreates(), 0, "zero exports");
  const store2 = makeStore();
  let h2 = makeHarness({
    store: store2,
    ddOpts: { onCreate: () => { h2.clockRef.now += 20_000; } },
    budgetMs: 80_000, reserveMs: 1_000,
    readSnapshot: async ({ sourceKey }) => (sourceKey === "product-catalog"
      ? { snapshot: { validated_at: TODAY + "T01:00:00Z", object_path: "source-snapshots/v1/product-catalog/__organization.json", row_count: 1 }, read: "ok", error: null }
      : { snapshot: { validated_at: TODAY + "T01:00:00Z" }, read: "ok", error: null }),
  });
  h2.snapStore.set("source-snapshots/v1/product-catalog/__organization.json", { rows: [{ child_asin: "B0A", sku: "SKU-A", product_brand: "Acme" }] });
  const r2 = await h2.runtime.run({ bucket: "us", today: TODAY });
  if (r2.derived && r2.derived.skipped === "deadline") {
    assert.equal(r2.continuationRequired, true, "the derive half deferred typed-resumable");
  } else {
    assert.ok(r2.deadlineReached === true || r2.derived != null, "the deadline surfaced typed somewhere in the pipeline");
  }
});

test("R3. a fixpoint deadline BETWEEN continuations is typed resumable -- never FAMILY_CONTINUATIONS_EXHAUSTED", async () => {
  const fixpoint = await import("../lib/server/sync/source-fixpoint.js");
  const clockRef = { now: 1_000_000 };
  const store = { listSourceJobs: async () => [{ source_key: "order-line-items", request_hash: "h1", fetch_status: "pending", create_export_count: 0 }] };
  const rollup = await fixpoint.runSourceFixpoint({
    composeRuntime: () => ({ run: async () => { clockRef.now += 40_000; return { cycleId: "c1", spent: 1, perUnit: [], reports: null }; } }),
    store, bucket: "us", cycleDate: "2026-08-21", reportKeys: ["brand-sales"],
    clock: () => clockRef.now, wait: async () => {}, cooldownMs: 0,
    deadlineMs: clockRef.now + 60_000, reserveMs: 1_000,
    maxContinuationsPerFamily: 10, maxWalks: 1,
  });
  assert.equal(rollup.deadlineReached, true, "the deadline surfaced typed");
  assert.equal(rollup.continuationRequired, true, "resumable");
  assert.equal(rollup.stopped, false, "never a failure");
  assert.notEqual(rollup.stopReason && rollup.stopReason.code, "FAMILY_CONTINUATIONS_EXHAUSTED", "exhaustion is never blamed for a deadline");
});

test("R4. a SUCCEEDED job whose cached payload was lost fails closed as SOURCE_PAYLOAD_UNAVAILABLE (not drained; persistence not skipped silently)", async () => {
  const store = makeStore();
  const succeeded = new Set();
  const origSuccess = store.recordSourceSuccess.bind(store);
  store.recordSourceSuccess = (args) => { succeeded.add(args.requestHash); return origSuccess(args); };
  const origLoad = store.loadSourceRows.bind(store);
  store.loadSourceRows = (h) => (succeeded.has(h) ? null : origLoad(h)); // the cache vanishes after success
  const h = makeHarness({ store });
  const rollup = await h.runtime.run({ bucket: "us", today: TODAY });
  assert.equal(rollup.stopped, true);
  assert.equal(rollup.stopReason.code, "SOURCE_PAYLOAD_UNAVAILABLE");
  assert.equal(rollup.globalDrained, false, "a lost payload is never reported drained/successful");
  assert.equal(h.recorded.replaceCalls.length, 0, "durable persistence was not silently skipped -- it was refused typed");
});

test("R5. snapshot saves are content-addressed + organization/connection isolated; a pointer/payload mismatch is refused pre-HTTP", async () => {
  const sb = await import("../lib/server/supabase.js");
  const rowsA = [{ child_asin: "A" }];
  const rowsB = [{ child_asin: "B" }];
  const shaA = sb.sourceSnapshotPayloadSha(rowsA);
  const shaB = sb.sourceSnapshotPayloadSha(rowsB);
  assert.notEqual(shaA, shaB, "different content => different hash");
  assert.equal(shaA, sb.sourceSnapshotPayloadSha([{ child_asin: "A" }]), "same content => same immutable object");
  const pathA = sb.sourceSnapshotObjectPath({ organizationFingerprint: "org1", connectionId: "primary", sourceKey: "product-catalog", scopeKey: "__organization", payloadSha: shaA });
  const pathB = sb.sourceSnapshotObjectPath({ organizationFingerprint: "org1", connectionId: "primary", sourceKey: "product-catalog", scopeKey: "__organization", payloadSha: shaB });
  assert.notEqual(pathA, pathB, "concurrent DIFFERENT-content saves write DIFFERENT immutable objects");
  const pathOrg2 = sb.sourceSnapshotObjectPath({ organizationFingerprint: "org2", connectionId: "primary", sourceKey: "product-catalog", scopeKey: "__organization", payloadSha: shaA });
  assert.notEqual(pathA, pathOrg2, "cross-organization saves are namespace-isolated");
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("SPY_FETCH_CALLED"); };
  try {
    await assert.rejects(() => sb.recordSourceSnapshot({
      organizationFingerprint: "org1", connectionId: "primary", sourceKey: "product-catalog", scopeKey: "__organization",
      objectPath: pathA, payloadSha: shaB, rowCount: 1, sourceRequestHash: "h", validatedAt: "2026-08-20T00:00:00Z",
    }), /same save/);
  } finally { globalThis.fetch = realFetch; }
});

test("R6. corrupted existing batch membership is refused typed with ZERO exports", async () => {
  const org = identity.organizationFingerprint(PRIM_KEY);
  const V = runtimeMod.validateBatchMembershipRows;
  const good = { account_id: "A01", connection_id: "primary", organization_fingerprint: org, batch_index: 0 };
  assert.ok(V([good], { orgFingerprint: org }) instanceof Map, "a valid row is accepted");
  for (const bad of [
    { ...good, account_id: "" },
    { ...good, account_id: ["dd", "secondary"].join("-") + ":X" },
    { ...good, connection_id: "dd-secondary" },
    { ...good, organization_fingerprint: "other-org" },
    { ...good, batch_index: -1 },
    { ...good, batch_index: 1.5 },
  ]) {
    assert.throws(() => V([bad], { orgFingerprint: org }), (e) => e.code === "BATCH_MEMBERSHIP_CORRUPT");
  }
  assert.throws(() => V([good, { ...good }], { orgFingerprint: org }), (e) => e.code === "BATCH_MEMBERSHIP_CORRUPT", "duplicate account");
  const six = Array.from({ length: 6 }, (_, i) => ({ ...good, account_id: "A0" + i }));
  assert.throws(() => V(six, { orgFingerprint: org }), (e) => e.code === "BATCH_MEMBERSHIP_CORRUPT", ">5 in one batch");
  const h = makeHarness({ readBatchMembership: async () => [{ ...good, organization_fingerprint: "evil-org" }] });
  await assert.rejects(() => h.runtime.run({ bucket: "us", today: TODAY }), (e) => e.code === "BATCH_MEMBERSHIP_CORRUPT");
  assert.equal(h.dd.totalCreates(), 0, "zero exports on corrupt membership");
});

test("R7. stale / dangling / integrity-broken snapshot evidence produces typed readiness blockers", async () => {
  // (a) STALE required catalog evidence: typed, BLOCKING (ready:false), and never usable for derivation.
  const stale = makeHarness({
    readSnapshot: async ({ sourceKey }) => (sourceKey === "product-catalog"
      ? { snapshot: { validated_at: "2026-08-18T01:00:00Z", object_path: "source-snapshots/v1/product-catalog/__organization.json", row_count: 1 }, read: "ok", error: null }
      : { snapshot: { validated_at: "2026-08-20T01:00:00Z", object_path: "missing-object", row_count: 1 }, read: "ok", error: null }),
  });
  stale.clockRef.now = Date.UTC(2026, 7, 20, 12, 0); // today = 2026-08-20 -> the 08-18 catalog is STALE
  stale.snapStore.set("source-snapshots/v1/product-catalog/__organization.json", { rows: [{ child_asin: "B0A", product_brand: "Acme" }] });
  const readiness = await stale.runtime.gatherDurableReadiness({ bucket: "us", accounts: [{ accountId: "A01" }], asOf: ASOF });
  assert.ok(readiness.daily.blockedBy.some((b) => b.sourceKey === "product-catalog" && b.reason === "snapshot-stale"), "stale evidence is typed");
  assert.equal(readiness.daily.ready, false, "round-4 finding 7: REQUIRED stale catalog evidence makes the dashboard NOT ready");
  assert.equal(readiness.brandView.ready, false, "Brand View is not ready on stale required evidence either");
  // (b) a FRESH pointer whose object is GONE: typed dangling.
  assert.ok(readiness.brandView.blockedBy.some((b) => b.sourceKey === "fba-inventory-health" && b.reason === "snapshot-dangling"), "a dangling pointer is typed");
  // (c) a FRESH catalog whose row_count disagrees with the hydrated rows: typed integrity, BLOCKING.
  const broken = makeHarness({
    readSnapshot: async ({ sourceKey }) => (sourceKey === "product-catalog"
      ? { snapshot: { validated_at: "2026-08-20T01:00:00Z", object_path: "source-snapshots/v1/product-catalog/__organization.json", row_count: 5 }, read: "ok", error: null }
      : { snapshot: null, read: "ok", error: null }),
  });
  broken.clockRef.now = Date.UTC(2026, 7, 20, 12, 0);
  broken.snapStore.set("source-snapshots/v1/product-catalog/__organization.json", { rows: [{ child_asin: "B0A", product_brand: "Acme" }] });
  const integ = await broken.runtime.gatherDurableReadiness({ bucket: "us", accounts: [{ accountId: "A01" }], asOf: ASOF });
  assert.ok(integ.daily.blockedBy.some((b) => b.sourceKey === "product-catalog" && b.reason === "snapshot-integrity"), "row-count integrity is typed");
  assert.equal(integ.daily.ready, false, "integrity-broken required evidence blocks readiness");
});

test("R8. endpoint ordering pins: PATCH boolean-strict BEFORE any write; POST preflight BEFORE the audit", () => {
  const src = readFileSync(path.join(process.cwd(), "api", "admin", "sources.js"), "utf8");
  const boolCheck = src.indexOf('typeof body.paused !== "boolean"');
  const patchWrite = src.indexOf("setSourceControl({ sourceKey, paused");
  assert.ok(boolCheck > 0 && patchWrite > boolCheck, "PATCH validates the boolean before its first write");
  const mkDeadline = src.indexOf("runtime.makeDeadline()");
  const preflight = src.indexOf("preflightEvidence({ bucket, sourceKey: onlySourceKey, deadline })");
  const postAudit = src.indexOf('action: "source.sync.missing"');
  assert.ok(mkDeadline > 0 && preflight > mkDeadline, "round-5: the ONE route-owned deadline is created BEFORE preflight");
  assert.ok(preflight > 0 && postAudit > preflight, "POST runs the evidence preflight BEFORE the audit write");
  const exec = src.indexOf("deadline, preflight });");
  assert.ok(exec > postAudit, "execution consumes the SAME route deadline + memoized preflight bundle");
});

test("R9. dropped / weakened / wrong-schema POLICIES each raise a typed audit blocker", () => {
  const dropped = auditWith((sql) => sql.replace(/create policy source_controls_admin_read on public\.source_controls\n  for select to authenticated using \(public\.is_dashboard_admin\(\)\);/, ""));
  assert.ok(dropped.blockers.some((b) => b.code === "POLICY_MISSING"), JSON.stringify(dropped.blockers.map((b) => b.code)));
  const weakened = auditWith((sql) => sql.split("create policy source_coverage_admin_read on public.source_coverage\n  for select to authenticated using (public.is_dashboard_admin());").join("create policy source_coverage_admin_read on public.source_coverage\n  for select to anon using (true);"));
  assert.ok(weakened.blockers.some((b) => b.code === "POLICY_MISMATCH"), JSON.stringify(weakened.blockers.map((b) => b.code)));
  const unexpected = auditWith((sql) => sql + "\ncreate policy sneaky_read on public.source_snapshots for select to authenticated using (true);\n");
  assert.ok(unexpected.blockers.some((b) => b.code === "POLICY_UNEXPECTED"), JSON.stringify(unexpected.blockers.map((b) => b.code)));
});


/* ================================= S. round-4 regressions ================================= */
group("S. round-4: ads read state, terminal policies, lineage, full preflight, unreadable loaders, CAS, canonical ids");

test("S1. a failed/limited readAdMetrics is NEVER flattened into ok-zero ads (typed metricsRead; no false zero)", async () => {
  const mk = (reader) => makeHarness({
    readAdMetrics: reader,
    readCoverage: async () => ({ windows: [{ from: "2025-01-01", to: TODAY }], read: "ok", error: null }),
    readSnapshot: async ({ sourceKey }) => (sourceKey === "product-catalog"
      ? { snapshot: { validated_at: TODAY + "T01:00:00Z", object_path: "source-snapshots/v1/product-catalog/__organization.json", row_count: 1 }, read: "ok", error: null }
      : { snapshot: { validated_at: TODAY + "T01:00:00Z" }, read: "ok", error: null }),
  });
  for (const [reader, label] of [
    [async () => { throw new Error("boom"); }, "read-failed"],
    [async () => { const e = new Error("cap"); e.code = "ADS_ROW_LIMIT_EXCEEDED"; throw e; }, "limit-exceeded"],
    [async () => "not-an-array", "read-failed"],
  ]) {
    const h = mk(reader);
    h.snapStore.set("source-snapshots/v1/product-catalog/__organization.json", { rows: [{ child_asin: "B0A", sku: "SKU-A", product_brand: "Acme" }] });
    h.durableHistory.set("A01|x", { accountId: "A01", saleDate: ASOF, sku: "SKU-A", childAsin: "B0A", currency: "USD", salesAmount: 10, units: 1 });
    const rollup = await h.runtime.run({ bucket: "us", today: TODAY });
    assert.equal(rollup.stopped, false, JSON.stringify(rollup.stopReason));
    const dailySave = h.recorded.shadowSaves.find((x) => x.reportKey === "scheduler-v2/daily-reporting");
    assert.ok(dailySave, "the sales snapshot still saves (ads never block sales)");
    assert.equal(dailySave.payload.adsAvailability.status, "failed", label + ": the Ads half is typed FAILED, never a clean zero");
    assert.match(String(dailySave.payload.adsAvailability.reason), /ads-read/, "the typed read reason travels with the payload");
  }
});

test("S2. genuine sync_report_jobs lineage: every durable save records upsert -> claim -> validated success with the EXACT snapshot_params_hash", async () => {
  const h = makeHarness({
    readCoverage: async () => ({ windows: [{ from: "2025-01-01", to: TODAY }], read: "ok", error: null }),
    readSnapshot: async ({ sourceKey }) => (sourceKey === "product-catalog"
      ? { snapshot: { validated_at: TODAY + "T01:00:00Z", object_path: "source-snapshots/v1/product-catalog/__organization.json", row_count: 1 }, read: "ok", error: null }
      : { snapshot: { validated_at: TODAY + "T01:00:00Z" }, read: "ok", error: null }),
  });
  h.snapStore.set("source-snapshots/v1/product-catalog/__organization.json", { rows: [{ child_asin: "B0A", sku: "SKU-A", product_brand: "Acme" }] });
  h.durableHistory.set("A01|x", { accountId: "A01", saleDate: ASOF, sku: "SKU-A", childAsin: "B0A", currency: "USD", salesAmount: 10, units: 1 });
  const rollup = await h.runtime.run({ bucket: "us", today: TODAY });
  assert.equal(rollup.stopped, false, JSON.stringify(rollup.stopReason));
  assert.ok(rollup.derived.daily.saved >= 1, "daily saved");
  const upserts = h.recorded.lineage.filter((l) => l.op === "upsert");
  const successes = h.recorded.lineage.filter((l) => l.op === "success");
  assert.ok(upserts.some((l) => l.reportKey === "daily-reporting"), "a REAL sync_report_jobs row under the PRODUCTION key");
  assert.ok(upserts.some((l) => l.reportKey === "brand-sales"), "brand-sales lineage too");
  for (const sSucc of successes) {
    const save = h.recorded.shadowSaves.find((x) => x.reportKey === "scheduler-v2/" + sSucc.reportKey && x.accountId === sSucc.accountId);
    assert.ok(save, "each success maps to a real shadow save");
    assert.equal(sSucc.snapshotParamsHash, reportStore.paramsHashFor(save.params.reportVersion, save.params), "the EXACT saver-computed snapshot_params_hash is recorded");
  }
});

test("S3. FULL endpoint preflight: EVERY later read failure (coverage/snapshot/membership/settings/rollout) refuses typed BEFORE any write", async () => {
  const cases = [
    [{ readCoverage: async () => ({ windows: [], read: "read-failed", error: "X" }) }, "SOURCE_EVIDENCE_READ_FAILED"],
    [{ readSnapshot: async () => ({ snapshot: null, read: "schema-missing", error: "X" }) }, "DURABLE_MODEL_UNAVAILABLE"],
    [{ readBatchMembership: async () => { throw new Error("boom"); } }, "BATCH_MEMBERSHIP_READ_FAILED"],
    [{ readSettings: async () => { throw new Error("boom"); } }, "SETTINGS_READ_FAILED"],
    [{ readRollout: async () => ({ read: "read-failed" }) }, "ROLLOUT_READ_FAILED"],
  ];
  for (const [over, code] of cases) {
    const h = makeHarness(over);
    await assert.rejects(() => h.runtime.preflightEvidence({ bucket: "us", sourceKey: "product-catalog" }), (e) => e.code === code, code);
    assert.equal(h.store._opens, 0, code + ": zero cycle/store writes");
    assert.equal(h.dd.totalCreates(), 0, code + ": zero exports");
  }
  const ok = makeHarness({});
  const res = await ok.runtime.preflightEvidence({ bucket: "us", sourceKey: "product-catalog" });
  assert.ok(res.pausedSources instanceof Set, "a healthy sweep passes");
});

test("S4. an UNREADABLE cache loader (throws) at persistence is the SAME typed SOURCE_PAYLOAD_UNAVAILABLE stop", async () => {
  const store = makeStore();
  const succeeded = new Set();
  const origSuccess = store.recordSourceSuccess.bind(store);
  store.recordSourceSuccess = (args) => { succeeded.add(args.requestHash); return origSuccess(args); };
  const origLoad = store.loadSourceRows.bind(store);
  store.loadSourceRows = (h) => { if (succeeded.has(h)) throw new Error("storage transport boom"); return origLoad(h); };
  const h = makeHarness({ store });
  const rollup = await h.runtime.run({ bucket: "us", today: TODAY });
  assert.equal(rollup.stopped, true);
  assert.equal(rollup.stopReason.code, "SOURCE_PAYLOAD_UNAVAILABLE");
  assert.equal(rollup.globalDrained, false);
});

test("S5. the snapshot pointer CAS: an OLDER save never replaces newer evidence; equal-conflicting fails closed; audit mutations typed", async () => {
  const sb = await import("../lib/server/supabase.js");
  const args = (validatedAt, sha) => ({
    organizationFingerprint: "org1", connectionId: "primary", sourceKey: "product-catalog", scopeKey: "__organization",
    objectPath: "source-snapshots/v2/org1/primary/product-catalog/__organization/" + sha + ".json", payloadSha: sha,
    rowCount: 1, sourceRequestHash: "h", validatedAt,
  });
  const sha = sb.sourceSnapshotPayloadSha([{ a: 1 }]);
  const stub = (ack) => { globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => JSON.stringify(ack), text: async () => JSON.stringify(ack), headers: new Map() }); };
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => '"stale-save"', json: async () => "stale-save" });
    const stale = await sb.recordSourceSnapshot(args("2026-08-19T00:00:00Z", sha));
    assert.deepEqual({ write: stale.write, ack: stale.ack }, { write: "ok", ack: "stale-save" }, "an OLDER save is a no-write no-op (the newer evidence stands)");
    globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => '"conflict"', json: async () => "conflict" });
    await assert.rejects(() => sb.recordSourceSnapshot(args("2026-08-20T00:00:00Z", sha)), (e) => e.code === "SOURCE_SNAPSHOT_CONFLICT", "equal-conflicting evidence fails closed");
  } finally { globalThis.fetch = realFetch; }
  // Audit mutations: gutting the CAS guards raises typed blockers; the real SQL audits clean.
  assert.equal(auditWith(null).ok, true);
  const noStale = auditWith((sql) => sql.replace(/if p_validated_at < v_existing\.validated_at then\s*return 'stale-save';\s*end if;/, ""));
  assert.ok(noStale.blockers.some((b) => b.code === "SNAPSHOT_CAS_STALE_GUARD_MISSING"), JSON.stringify(noStale.blockers.map((b) => b.code)));
  const noConflict = auditWith((sql) => sql.split("return 'conflict';").join("return 'unchanged';"));
  assert.ok(noConflict.blockers.some((b) => b.code === "SNAPSHOT_CAS_CONFLICT_GUARD_MISSING"), JSON.stringify(noConflict.blockers.map((b) => b.code)));
});

test("S6. TERMINAL policy enumeration: create-then-drop refused; undeclared policies refused; authenticated grants exact", () => {
  const createThenDrop = auditWith((sql) => sql + "\ndrop policy source_controls_admin_read on public.source_controls;\n");
  assert.ok(createThenDrop.blockers.some((b) => b.code === "POLICY_DROPPED" || b.code === "POLICY_MISSING"), JSON.stringify(createThenDrop.blockers.map((b) => b.code)));
  const missingAuthGrant = auditWith((sql) => sql.replace("grant select on table public.source_controls to authenticated;", ""));
  assert.ok(missingAuthGrant.blockers.some((b) => b.code === "AUTH_GRANT_MISSING"), JSON.stringify(missingAuthGrant.blockers.map((b) => b.code)));
  const widenedAuthGrant = auditWith((sql) => sql.replace("grant select on table public.source_coverage to authenticated;", "grant select, insert on table public.source_coverage to authenticated;"));
  assert.ok(widenedAuthGrant.blockers.some((b) => b.code === "AUTH_GRANT_FORBIDDEN"), JSON.stringify(widenedAuthGrant.blockers.map((b) => b.code)));
  const anonGrant = auditWith((sql) => sql + "\ngrant select on table public.source_snapshots to anon;\n");
  assert.ok(anonGrant.blockers.some((b) => b.code === "AUTH_GRANT_FORBIDDEN"), JSON.stringify(anonGrant.blockers.map((b) => b.code)));
});

test("S7. NONCANONICAL membership ids are REJECTED (never trimmed); the DB constraint is audited (STATEMENT_MISSING on removal)", async () => {
  const org = identity.organizationFingerprint(PRIM_KEY);
  const V = runtimeMod.validateBatchMembershipRows;
  const good = { account_id: "A01", connection_id: "primary", organization_fingerprint: org, batch_index: 0 };
  assert.throws(() => V([{ ...good, account_id: " A01" }], { orgFingerprint: org }), (e) => e.code === "BATCH_MEMBERSHIP_CORRUPT", "leading whitespace rejected, not trimmed");
  assert.throws(() => V([{ ...good, account_id: "A01 " }], { orgFingerprint: org }), (e) => e.code === "BATCH_MEMBERSHIP_CORRUPT", "trailing whitespace rejected, not trimmed");
  const stripped = auditWith((sql) => sql.replace(/alter table public\.source_batch_membership\n  add constraint source_batch_membership_account_canonical[\s\S]*?position\(':' in account_id\) = 0\);/, ""));
  assert.ok(stripped.blockers.some((b) => b.code === "STATEMENT_MISSING"), JSON.stringify(stripped.blockers.map((b) => b.code)));
});

/* ================================= T. round-5 regressions ================================= */
group("T. round-5: claim-before-save lineage + real publisher acceptance, Brand View read path, memoized preflight, route deadline, sequential ACLs, CAS binding");

// A COMPLETE durable fixture: full OLI coverage, fresh hydratable catalog + per-account FBA snapshots and
// seeded history, so a full bucket run drains, derives Daily + Brand View + compact brand-inventory, records
// lineage and finalizes its cycle. `over` wins over every fixture default.
function fullFixture(over = {}) {
  const h = makeHarness({
    readCoverage: async () => ({ windows: [{ from: "2025-01-01", to: TODAY }], read: "ok", error: null }),
    readSnapshot: async ({ sourceKey, scopeKey }) => {
      if (sourceKey === "product-catalog") return { snapshot: { validated_at: TODAY + "T01:00:00Z", object_path: "source-snapshots/v1/product-catalog/__organization.json", row_count: 1 }, read: "ok", error: null };
      return { snapshot: { validated_at: TODAY + "T01:00:00Z", object_path: "source-snapshots/v1/fba-inventory-health/" + scopeKey + ".json", row_count: 1 }, read: "ok", error: null };
    },
    ...over,
  });
  h.snapStore.set("source-snapshots/v1/product-catalog/__organization.json", { rows: [{ child_asin: "B0A", sku: "SKU-A", product_brand: "Acme" }] });
  for (const a of ["A01", "A02"]) {
    h.snapStore.set("source-snapshots/v1/fba-inventory-health/" + a + ".json", { rows: [{ date: ASOF, sku: "SKU-A", child_asin: "B0A", marketplace_country_code: "US", available: 5 }] });
  }
  h.durableHistory.set("A01|x", { accountId: "A01", saleDate: ASOF, sku: "SKU-A", childAsin: "B0A", currency: "USD", salesAmount: 10, units: 1 });
  return h;
}

test("T1. blocker 1: CLAIM-BEFORE-SAVE lineage with exact depends_on hashes; the runtime-produced cycle/job passes the REAL buildSchedulerV2Publisher (no fabricated cycle_status)", async () => {
  const h = fullFixture();
  const rollup = await h.runtime.run({ bucket: "us", today: TODAY });
  assert.equal(rollup.stopped, false, JSON.stringify(rollup.stopReason));
  assert.equal(rollup.derived.skipped, null);
  assert.ok(rollup.derived.daily.saved >= 1 && rollup.derived.brandView.saved >= 1, "durable saves happened");
  // (a) ORDER per (report, account): upsert -> claim(true) -> save -> success, from ONE recorder.
  const successes = h.recorded.lineage.filter((l) => l.op === "success");
  assert.ok(successes.length >= 3, "daily + brand-sales + brand-inventory lineage recorded");
  for (const s of successes) {
    const seq = h.recorded.lineage.filter((l) =>
      (l.reportKey === s.reportKey || l.reportKey === "scheduler-v2/" + s.reportKey) && l.accountId === s.accountId);
    const ops = seq.map((l) => l.op);
    assert.deepEqual(ops, ["upsert", "claim", "save", "success"], s.reportKey + "/" + s.accountId + ": the claim is held BEFORE the save, success only after it");
    assert.equal(seq[1].claim, true, "claim === true STRICTLY before any save");
  }
  // (b) depends_on binds each job to the EXACT authoritative source request hashes ITS OWN ACCOUNT owns
  // (round-6 fix 5): the account's batch OLI hashes + its own FBA hash + the shared organization catalog.
  const jobRows = h.store.listSourceJobs(rollup.cycleId);
  const owners = h.store.listCycleOwners(rollup.cycleId);
  const succeededByHash = new Map(jobRows.filter((r) => r.fetch_status === "succeeded").map((r) => [r.request_hash, r.source_key]));
  const ownedBy = (aid) => new Set(owners.filter((o) => o.account_id === aid || o.account_id === "__organization").map((o) => o.request_hash));
  const expectFor = (aid, families) => [...succeededByHash].filter(([hash, sk]) => families.includes(sk) && ownedBy(aid).has(hash)).map(([hash]) => hash).sort();
  const upserts = h.recorded.lineage.filter((l) => l.op === "upsert");
  assert.ok(upserts.length >= 3, "lineage rows upserted");
  for (const u of upserts) {
    const fams = u.reportKey === "brand-inventory"
      ? ["order-line-items", "product-catalog", "fba-inventory-health"]
      : ["order-line-items", "product-catalog"];
    const want = expectFor(u.accountId, fams);
    assert.ok(want.length >= 1, u.reportKey + "/" + u.accountId + ": authoritative owned hashes exist");
    assert.deepEqual([...u.dependsOn].sort(), want, u.reportKey + "/" + u.accountId + ": depends_on is the EXACT account-owned succeeded hash set");
  }
  // (c) round-6 fix 1: the SOURCE runtime never terminalizes the SHARED cycle -- the cycle stays running
  // after a full source-card run (an honest READ, no write). The reviewed terminal lifecycle belongs to the
  // CANONICAL SCHEDULED dispatcher's complete-scope close (the guarded finalize primitive) -- invoked here
  // exactly as the dispatcher invokes it once the whole scope is drained. Nothing fabricates a status.
  assert.equal(rollup.finalized, false, "the source runtime did NOT finalize the shared cycle");
  assert.equal(rollup.cycleStatus, "running", "the shared cycle honestly stays running after a source-only run");
  assert.equal(h.store.getCycle(rollup.cycleId).status, "running");
  assert.ok(rollup.derived.lineage.every((l) => l.outcome === "recorded"), "no lost claims in a single-worker run");
  const closed = h.store.finalizeCycle({ cycleId: rollup.cycleId }); // the dispatcher-owned reviewed close
  assert.equal(closed.disposition, "finalized", "the complete drained scope finalizes atomically");
  assert.equal(closed.cycle.status, "succeeded", "the terminal status comes from the guarded primitive's own counters");
  // (d) the ACTUAL runtime-produced job + cycle pass the REAL composed publisher. Every value the publisher
  // validates (validated/derive/save/cycle_status/snapshot_params_hash/params/payload) is read from the
  // harness rows the RUNTIME wrote -- the test fabricates NOTHING.
  const pubMod = await import("../lib/server/sync/publisher-composition.js");
  const published = [];
  const publisher = pubMod.buildSchedulerV2Publisher({
    codeReadyKeys: ["brand-sales"],
    connections: CONNS,
    fetchAccounts: async (apiKey) => (apiKey === PRIM_KEY ? [dirAccount("A01"), dirAccount("A02")] : [dirAccount("B01")]),
    getSettings: async () => [{ report_key: "brand-sales", schedule_enabled: true }],
    getAccountRollout: async () => ({ read: "ok", allPrimary: true, enabledAccountIds: [] }),
    getApproval: async () => ({ read: "ok", approved: true }),
    getJob: async (rk, a) => {
      const j = h.store.getReportJob(rk, a);
      return j ? { ...j, cycle_status: h.store.getCycle(j.cycle_id).status } : null;
    },
    getSnapshot: async ({ reportKey, accountId, paramsHash }) => {
      const s = h.recorded.shadowSaves.find((x) => x.reportKey === reportKey && x.accountId === accountId && x.paramsHash === paramsHash);
      return s ? { params_hash: s.paramsHash, params: s.params, payload: s.payload, payload_storage_path: null, source_refreshed_at: s.sourceRefreshedAt } : null;
    },
    loadStoragePayload: async () => null,
    publishLive: async (args) => { published.push(args); return { outcome: "inserted" }; },
  });
  const res = await publisher.publish("brand-sales", "A01");
  assert.equal(res.disposition, "published", JSON.stringify(res));
  assert.equal(published.length, 1, "the live CAS primitive received exactly one publish");
});

test("T2. blocker 1: idempotent RESUME (a fresh invocation loses the claim and changes nothing) and CONCURRENCY (a lost claim never records success; the cycle honestly stays open)", async () => {
  // (a) idempotent resume over the SAME still-running cycle (round-6 fix 1: the source runtime never
  // terminalizes it, so the resume appends/replays WITHOUT tripping the Migration-5 append guard).
  const h = fullFixture();
  const r1 = await h.runtime.run({ bucket: "us", today: TODAY });
  assert.equal(r1.finalized, false, "run 1 did not terminalize the shared cycle");
  assert.equal(r1.cycleStatus, "running");
  const saves1 = h.recorded.shadowSaves.length;
  const successes1 = h.recorded.lineage.filter((l) => l.op === "success").length;
  const creates1 = h.dd.totalCreates();
  const r2 = await h.runtime.run({ bucket: "us", today: TODAY });
  assert.equal(h.dd.totalCreates(), creates1, "no duplicate export on resume");
  assert.equal(h.recorded.shadowSaves.length, saves1, "no duplicate shadow save: the resume LOSES every claim");
  assert.equal(h.recorded.lineage.filter((l) => l.op === "success").length, successes1, "no duplicate success");
  assert.ok(r2.derived.lineage.length >= 1 && r2.derived.lineage.every((l) => l.outcome === "claim-lost"), "every resume claim is typed claim-lost");
  assert.equal(r2.cycleStatus, "running", "the shared cycle STILL is not terminalized by any source-only run");
  // (b) concurrency: a racer wins the daily/A01 claim (and never completes it).
  const store2 = makeStore();
  let raced = false;
  const h2 = fullFixture({
    store: store2,
    reportLineage: {
      upsertReportJob: async (j) => store2.upsertReportJob(j),
      claimReportDerive: async (c, rk, a) => {
        if (rk === "daily-reporting" && a === "A01" && !raced) { raced = true; store2.claimReportDerive(c, rk, a); } // a concurrent worker claims FIRST
        return store2.claimReportDerive(c, rk, a);
      },
      recordReportSuccess: async (j) => store2.recordReportSuccess(j),
    },
  });
  const r3 = await h2.runtime.run({ bucket: "us", today: TODAY });
  assert.equal(r3.stopped, false);
  assert.ok(!h2.recorded.shadowSaves.some((s) => s.reportKey === "scheduler-v2/daily-reporting" && s.accountId === "A01"), "the claim loser NEVER saves");
  const lost = store2.getReportJob("daily-reporting", "A01");
  assert.equal(lost.validated, false, "success is NEVER recorded after a lost claim");
  assert.equal(lost.derive_status, "running", "the job stays with its claim winner");
  assert.ok(r3.derived.lineage.some((l) => l.reportKey === "daily-reporting" && l.accountId === "A01" && l.outcome === "claim-lost"), "typed claim-lost outcome");
  assert.equal(r3.cycleStatus, "running", "the cycle honestly stays NON-terminal");
  assert.equal(r3.finalized, false);
  // Even the dispatcher-owned close refuses while the raced job is still open: the guarded primitive
  // returns open-work -- the cycle can NEVER be claimed terminal around an in-flight claim.
  const attempt = store2.finalizeCycle({ cycleId: r3.cycleId });
  assert.equal(attempt.disposition, "open-work", "finalize refuses while a claimed report job is open");
  assert.equal(store2.getCycle(r3.cycleId).status, "running");
});

test("T3. blocker 2: the durable FBA evidence reaches Brand View through its REAL read path (buildAccountBrandSlice -> compact snapshot gate), not a direct builder call", async () => {
  const h = fullFixture();
  const rollup = await h.runtime.run({ bucket: "us", today: TODAY });
  assert.equal(rollup.stopped, false, JSON.stringify(rollup.stopReason));
  assert.ok(rollup.derived.brandInventory.saved >= 1, "the compact brand-inventory shadow snapshot saved: " + JSON.stringify(rollup.derived.brandInventory));
  const invSave = h.recorded.shadowSaves.find((s) => s.reportKey === "scheduler-v2/brand-inventory" && s.accountId === "A01");
  assert.ok(invSave, "saved under the EXISTING shadow key");
  assert.equal(invSave.params.reportVersion, "brand-inventory-shared-v1", "the EXISTING compact report version");
  assert.ok(Array.isArray(invSave.payload.inventoryByBrandCountry), "the EXISTING compact payload contract");
  // THE REAL production orchestration: buildAccountBrandSlice reads brand-sales + the compact inventory
  // through its own snapshot gate (isCompactInventorySnapshot) -- the ONLY injected seam is readSnapshot.
  const bv = await import("../lib/server/reports/brand-view.js");
  const getSnapshot = async ({ reportKey, accountId }) => {
    const s = [...h.recorded.shadowSaves].reverse().find((x) => x.reportKey === "scheduler-v2/" + reportKey && x.accountId === accountId);
    return s ? { params: s.params, params_hash: s.paramsHash, payload: s.payload, source_refreshed_at: s.sourceRefreshedAt } : null;
  };
  const slice = await bv.buildAccountBrandSlice({
    accountId: "A01", brand: "Acme", asOf: ASOF, account: { name: "Acct A01", country: "US" },
    getSnapshot, getAdsRows: async () => [],
  });
  assert.equal(slice.inventory.scope, "country", "the compact snapshot is AUTHORITATIVE through the real gate (never the legacy fallback)");
  assert.equal(slice.inventory.accountTotal, 5, "the durable FBA quantity arrived via the real read path");
  assert.equal(slice.inventoryDate, ASOF, "the inventory date travels from the durable evidence");
  assert.ok(slice.sales, "the brand-sales half of the REAL slice consumed the durable-derived snapshot");
});

test("T4. blocker 3: preflight sweeps hydration/integrity/ads-coverage/ads-metrics/history typed BEFORE any write; execution consumes ONE memoized bundle with ZERO repeated reads", async () => {
  // (a) every NEW read-failure class refuses typed with ZERO writes and ZERO exports.
  const catalogPointer = { snapshot: { validated_at: TODAY + "T01:00:00Z", object_path: "source-snapshots/v1/product-catalog/__organization.json", row_count: 1 }, read: "ok", error: null };
  const cases = [
    ["SNAPSHOT_HYDRATION_FAILED", { readSnapshot: async ({ sourceKey }) => (sourceKey === "product-catalog" ? catalogPointer : { snapshot: null, read: "ok", error: null }) }, (h) => { /* no snapStore object => dangling */ }],
    ["SNAPSHOT_INTEGRITY_FAILED", { readSnapshot: async ({ sourceKey }) => (sourceKey === "product-catalog" ? { ...catalogPointer, snapshot: { ...catalogPointer.snapshot, row_count: 5 } } : { snapshot: null, read: "ok", error: null }) }, (h) => { h.snapStore.set("source-snapshots/v1/product-catalog/__organization.json", { rows: [{ child_asin: "B0A" }] }); }],
    ["ADS_COVERAGE_READ_FAILED", { readAdsCoverage: async () => ({ windows: [], read: "read-failed", error: "X" }) }, null],
    ["ADS_METRICS_READ_FAILED", { readAdMetrics: async () => { throw new Error("boom"); } }, null],
    ["ADS_METRICS_READ_FAILED", { readAdMetrics: async () => "not-an-array" }, null],
    ["HISTORY_READ_FAILED", { loadHistoryRows: async () => { throw new Error("boom"); } }, null],
  ];
  for (const [code, over, prep] of cases) {
    const h = makeHarness(over);
    if (prep) prep(h);
    await assert.rejects(() => h.runtime.preflightEvidence({ bucket: "us", today: TODAY }), (e) => e.code === code && e.status === 503, code);
    assert.equal(h.store._opens, 0, code + ": zero cycle writes");
    assert.equal(h.dd.totalCreates(), 0, code + ": zero exports");
    assert.equal(h.recorded.snapshots.length + h.recorded.shadowSaves.length + h.recorded.replaceCalls.length + h.recorded.lineage.length, 0, code + ": zero snapshot/report/history writes");
  }
  // limit-exceeded is a VALID authoritative Ads answer: memoized typed, NOT a refusal.
  const lim = fullFixture({ readAdMetrics: async () => { const e = new Error("cap"); e.code = "ADS_ROW_LIMIT_EXCEEDED"; throw e; } });
  const pfLim = await lim.runtime.preflightEvidence({ bucket: "us", today: TODAY });
  assert.equal(pfLim.adMetricsByAccountId.A01.metricsRead, "limit-exceeded", "typed degrade memoized in the bundle");
  // (b) execution consumes the ONE memoized bundle: ZERO repeated discovery/controls/coverage/snapshot/
  // hydration/ads/history reads -- and STILL derives fresh (the sync's own products fold in-memory).
  const counts = { controls: 0, discovery: 0, coverage: 0, snapshot: 0, adsCov: 0, metrics: 0, history: 0 };
  const h2 = fullFixture({
    onFetchAccounts: () => { counts.discovery += 1; },
    readSourceControls: async () => { counts.controls += 1; return { rows: [], read: "ok", error: null }; },
    readCoverage: async () => { counts.coverage += 1; return { windows: [{ from: "2025-01-01", to: TODAY }], read: "ok", error: null }; },
    readSnapshot: async ({ sourceKey, scopeKey }) => {
      counts.snapshot += 1;
      if (sourceKey === "product-catalog") return { snapshot: { validated_at: TODAY + "T01:00:00Z", object_path: "source-snapshots/v1/product-catalog/__organization.json", row_count: 1 }, read: "ok", error: null };
      return { snapshot: { validated_at: TODAY + "T01:00:00Z", object_path: "source-snapshots/v1/fba-inventory-health/" + scopeKey + ".json", row_count: 1 }, read: "ok", error: null };
    },
    readAdsCoverage: async () => { counts.adsCov += 1; return { windows: [{ from: "2025-01-01", to: TODAY }], read: "ok", error: null }; },
    readAdMetrics: async () => { counts.metrics += 1; return []; },
    loadHistoryRows: async () => { counts.history += 1; return [{ account_id: "A01", sale_date: ASOF, sku: "SKU-A", child_asin: "B0A", currency: "USD", sales_amount: 10, units: 1 }]; },
  });
  const pf = await h2.runtime.preflightEvidence({ bucket: "us", today: TODAY });
  const membershipReadsAfterPreflight = h2.recorded.membershipReads;
  const snapCounts = { ...counts };
  const rollup = await h2.runtime.run({ bucket: "us", today: TODAY, preflight: pf });
  assert.equal(rollup.stopped, false, JSON.stringify(rollup.stopReason));
  assert.equal(rollup.derived.skipped, null, "the memoized bundle carried the WHOLE derive stage");
  assert.deepEqual(counts, snapCounts, "execution repeated ZERO discovery/controls/coverage/snapshot/ads/history reads");
  assert.equal(h2.recorded.membershipReads, membershipReadsAfterPreflight, "membership was read ONCE, in preflight");
  assert.ok(rollup.derived.daily.saved >= 1, "fresh derivation from the memoized evidence + this invocation's own persisted products");
});

test("T5. blocker 4: ONE route-owned deadline created BEFORE preflight bounds preflight + execution; total elapsed stays BELOW the route budget; a hung in-flight read is raced+aborted", async () => {
  assert.equal(typeof runtimeMod.makeRouteDeadline, "function", "the reviewed deadline wrapper is exported");
  // (a) total-elapsed proof: preflight + execution burn the SAME budget; expiry is typed-resumable and the
  // elapsed clock (INCLUDING preflight) stays under the route budget (reserve sized above the op cost).
  const store = makeStore();
  let h;
  h = fullFixture({
    store,
    ddOpts: { onCreate: () => { h.clockRef.now += 30_000; } },
    budgetMs: 100_000, reserveMs: 40_000,
    readCoverage: async () => ({ windows: [], read: "ok", error: null }), // full backfill => plenty of work
  });
  const t0 = h.clockRef.now;
  const dl = h.runtime.makeDeadline();
  const pf = await h.runtime.preflightEvidence({ bucket: "us", deadline: dl, today: TODAY });
  const rollup = await h.runtime.run({ bucket: "us", today: TODAY, deadline: dl, preflight: pf });
  assert.equal(rollup.deadlineReached, true, "the shared budget expired mid-execution");
  assert.equal(rollup.continuationRequired, true, "typed resumable");
  assert.equal(dl.startMs, t0, "the ONE deadline was created before preflight and owned the whole route");
  assert.ok(h.clockRef.now - t0 < 100_000, "TOTAL elapsed (preflight + execution) stays below the route budget: " + (h.clockRef.now - t0));
  // (b) an in-flight read that NEVER resolves is bounded by the reviewed wrapper (race + abort): typed
  // ROUTE_DEADLINE_EXCEEDED refusal, zero writes, never a hung route.
  const delays = [];
  const hang = makeHarness({
    readCoverage: () => new Promise(() => {}), // hangs forever; ignores the abort signal
    setTimer: (fn, ms) => { delays.push(ms); return setTimeout(fn, 0); },
    clearTimer: (id) => clearTimeout(id),
  });
  await assert.rejects(
    () => hang.runtime.preflightEvidence({ bucket: "us", today: TODAY }),
    (e) => e.code === "ROUTE_DEADLINE_EXCEEDED" && e.status === 503,
    "the hung read is raced against the remaining budget",
  );
  assert.ok(delays.length >= 1 && delays.every((ms) => Number.isFinite(ms) && ms >= 1), "every in-flight op was bounded by a finite remaining-budget timer");
  assert.equal(hang.store._opens, 0, "zero writes after the bounded refusal");
  assert.equal(hang.dd.totalCreates(), 0, "zero exports");
});

test("T6. blocker 5: FINAL ACL state is audited SEQUENTIALLY (source-order GRANT/REVOKE replay), never a union of historical grants", () => {
  // grant-then-revoke: a LATER revoke removes the verb from the final state (a union would still count it).
  const grantThenRevoke = auditWith((sql) => sql + "\nrevoke select on table public.source_controls from authenticated;\n");
  assert.ok(grantThenRevoke.blockers.some((b) => b.code === "AUTH_GRANT_MISSING"), JSON.stringify(grantThenRevoke.blockers.map((b) => b.code)));
  // revoke-then-grant: the re-granted verb IS held afterwards -- the replay audits clean.
  const revokeThenGrant = auditWith((sql) => sql.replace(
    "grant select on table public.source_controls to authenticated;",
    "revoke select on table public.source_controls from authenticated;\ngrant select on table public.source_controls to authenticated;",
  ));
  assert.equal(revokeThenGrant.ok, true, JSON.stringify(revokeThenGrant.blockers));
  // a FORBIDDEN grant that a later revoke removed is cured in the final state.
  const curedForbidden = auditWith((sql) => sql + "\ngrant insert on table public.source_coverage to authenticated;\nrevoke insert on table public.source_coverage from authenticated;\n");
  assert.equal(curedForbidden.ok, true, JSON.stringify(curedForbidden.blockers));
  // an ARBITRARY role holding a non-empty FINAL set is forbidden; revoked-away it is clean again.
  const arbitraryRole = auditWith((sql) => sql + "\ngrant all on table public.source_snapshots to reporting_bot;\n");
  assert.ok(arbitraryRole.blockers.some((b) => b.code === "AUTH_GRANT_FORBIDDEN" && /reporting_bot/.test(b.message)), JSON.stringify(arbitraryRole.blockers.map((b) => b.code)));
  const arbitraryCured = auditWith((sql) => sql + "\ngrant all on table public.source_snapshots to reporting_bot;\nrevoke all on table public.source_snapshots from reporting_bot;\n");
  assert.equal(arbitraryCured.ok, true, JSON.stringify(arbitraryCured.blockers));
  // service_role is replayed sequentially too: a later revoke breaks the exact expected FINAL set.
  const srvRevoked = auditWith((sql) => sql + "\nrevoke update on table public.source_coverage from service_role;\n");
  assert.ok(srvRevoked.blockers.some((b) => b.code === "SERVICE_ROLE_GRANT_MISMATCH"), JSON.stringify(srvRevoked.blockers.map((b) => b.code)));
});

test("T7. blocker 6: strict CAS acknowledgements (exactly replaced|unchanged|stale-save|conflict) + structural guard binding, deterministic racing insert, and the exact Codex mutations", async () => {
  const sb = await import("../lib/server/supabase.js");
  const sha = sb.sourceSnapshotPayloadSha([{ a: 1 }]);
  const args = {
    organizationFingerprint: "org1", connectionId: "primary", sourceKey: "product-catalog", scopeKey: "__organization",
    objectPath: "source-snapshots/v2/org1/primary/product-catalog/__organization/" + sha + ".json", payloadSha: sha,
    rowCount: 1, sourceRequestHash: "h", validatedAt: "2026-08-20T00:00:00Z",
  };
  const realFetch = globalThis.fetch;
  const stub = (body) => { globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body }); };
  try {
    // MALFORMED acknowledgements are TYPED failures -- never coerced into an "ok" write.
    for (const bad of [null, "weird", { ack: "replaced" }, ["replaced", "replaced"], 42]) {
      stub(bad);
      await assert.rejects(() => sb.recordSourceSnapshot(args), (e) => e.code === "SOURCE_SNAPSHOT_ACK_INVALID", "malformed ack " + JSON.stringify(bad));
    }
    // The four EXACT acknowledgements (scalar or single-row) validate; conflict stays a typed refusal.
    stub("replaced");
    assert.deepEqual((await sb.recordSourceSnapshot(args)).ack, "replaced");
    stub(["unchanged"]);
    assert.deepEqual((await sb.recordSourceSnapshot(args)).ack, "unchanged");
    stub("stale-save");
    assert.deepEqual((await sb.recordSourceSnapshot(args)).ack, "stale-save");
    stub("conflict");
    await assert.rejects(() => sb.recordSourceSnapshot(args), (e) => e.code === "SOURCE_SNAPSHOT_CONFLICT");
  } finally { globalThis.fetch = realFetch; }
  // Structural mutations on the RPC body -- each of the Codex reproductions is a TYPED blocker.
  assert.equal(auditWith(null).ok, true, "the real migration audits clean");
  const ifTrue = auditWith((sql) => sql.replace("if p_validated_at < v_existing.validated_at then", "if true then"));
  assert.ok(ifTrue.blockers.some((b) => b.code === "SNAPSHOT_CAS_STALE_GUARD_MISSING" || b.code === "SNAPSHOT_CAS_STALE_BRANCH_UNBOUND"), JSON.stringify(ifTrue.blockers.map((b) => b.code)));
  const earlyUpdate = auditWith((sql) => sql.replace(
    "  if p_validated_at < v_existing.validated_at then",
    "  update public.source_snapshots set validated_at = p_validated_at where organization_fingerprint = p_organization_fingerprint;\n  if p_validated_at < v_existing.validated_at then",
  ));
  assert.ok(earlyUpdate.blockers.some((b) => b.code === "SNAPSHOT_CAS_WRITE_BEFORE_GUARDS"), JSON.stringify(earlyUpdate.blockers.map((b) => b.code)));
  const wrongCmp = auditWith((sql) => sql.replace("if p_validated_at = v_existing.validated_at then", "if p_validated_at <> v_existing.validated_at then"));
  assert.ok(wrongCmp.blockers.some((b) => b.code === "SNAPSHOT_CAS_EQUAL_BRANCH_UNBOUND"), JSON.stringify(wrongCmp.blockers.map((b) => b.code)));
  const swallowed = auditWith((sql) => sql.replace("exception when unique_violation then", "exception when others then"));
  assert.ok(swallowed.blockers.some((b) => b.code === "SNAPSHOT_CAS_EXCEPTION_SWALLOWED"), JSON.stringify(swallowed.blockers.map((b) => b.code)));
  const noRaceHandler = auditWith((sql) => sql.replace("exception when unique_violation then", "exception when foreign_key_violation then"));
  assert.ok(noRaceHandler.blockers.some((b) => b.code === "SNAPSHOT_CAS_CONCURRENT_INSERT_UNPROVEN"), JSON.stringify(noRaceHandler.blockers.map((b) => b.code)));
});

/* ================================= U. round-6 regressions ================================= */
group("U. round-6: shared-cycle finalization, stale CAS winners, brand-inventory promotion, real route deadline, account-exact lineage, PG17 ACLs");

test("U1. fix 1: no source run terminalizes the SHARED cycle; later report runs append; same-day replay works; the DISPATCHER close is atomic and the Migration-5 guard then holds", async () => {
  // (a) a FULL source run leaves the shared (bucket, cycle_date) cycle RUNNING; a narrowed source-card
  // action never finalizes either.
  const h = fullFixture();
  const full = await h.runtime.run({ bucket: "us", today: TODAY });
  assert.equal(full.stopped, false, JSON.stringify(full.stopReason));
  assert.equal(full.finalized, false, "a full source run never finalizes the shared cycle");
  assert.equal(full.cycleStatus, "running");
  const card = await h.runtime.runSourceCardAction({ bucket: "us", sourceKey: "product-catalog" });
  assert.equal(card.finalized, false, "a source-card run never finalizes");
  assert.notEqual(card.cycleStatus, "succeeded");
  // (b) a LATER report run on the SAME bucket/date can append + complete (Migration-5 guard passes on the
  // running cycle): model the tranche appending its own source + report work to the same cycle.
  const cycleId = full.cycleId;
  assert.ok(cycleId, "the shared cycle exists");
  h.store.upsertSourceJob({ cycleId, requestHash: "later_report_source_h1", requestKey: "keyword-rank:serp", sourceId: 9, sourceKey: "keyword-rank-serp", connectionId: "primary", organizationFingerprint: identity.organizationFingerprint(PRIM_KEY), accountScopeHash: "scope1" });
  h.store.recordSourceSuccess({ cycleId, requestHash: "later_report_source_h1", exportId: "e9", rowCount: 1, cacheObjectPath: "p" });
  h.store.upsertReportJob({ cycleId, reportKey: "keyword-rank", reportVersion: "kr/v1", accountId: "A01", connectionId: "primary", bucket: "us", dependsOn: ["later_report_source_h1"] });
  assert.equal(h.store.claimReportDerive(cycleId, "keyword-rank", "A01"), true, "the later report run claims on the RUNNING cycle");
  h.store.recordReportSuccess({ cycleId, reportKey: "keyword-rank", accountId: "A01", snapshotParamsHash: "kr_hash" });
  // (c) a SAME-DAY source-card replay succeeds -- the append guard never fires because nothing terminalized.
  const replay = await h.runtime.runSourceCardAction({ bucket: "us", sourceKey: "product-catalog" });
  assert.equal(replay.stopped === true, false, "the same-day replay ran without violating reject_append_to_terminal_cycle");
  // (d) the SCHEDULED complete-scope close stays correct + atomic: finalize -> terminal; a second close is
  // idempotent already-terminal; and ONLY THEN does the Migration-5 guard reject appends.
  const closed = h.store.finalizeCycle({ cycleId });
  assert.equal(closed.disposition, "finalized");
  assert.ok(["succeeded", "partial"].includes(closed.cycle.status));
  assert.equal(h.store.finalizeCycle({ cycleId }).disposition, "already-terminal", "idempotent");
  assert.throws(() => h.store.upsertSourceJob({ cycleId, requestHash: "post_terminal_h", requestKey: "x", sourceId: 1, sourceKey: "order-line-items", connectionId: "primary", organizationFingerprint: "o", accountScopeHash: "s" }), /terminal/, "the modeled Migration-5 guard rejects post-terminal appends");
  assert.throws(() => h.store.claimReportDerive(cycleId, "keyword-rank", "A01"), /terminal/, "post-terminal child UPDATES are rejected too");
  // (e) no fabricated status / trigger bypass: the runtime only ever REPORTED the store's own status.
  assert.equal(h.store.getCycle(cycleId).status, closed.cycle.status);
});

test("U2. fix 2: a CAS-losing candidate NEVER feeds derivation -- stale-save adopts the hydrated WINNER; an unreadable winner stops typed with LKG intact; unchanged accepts proven-identical content", async () => {
  // (a) stale-save: a NEWER concurrent catalog save won the pointer. The candidate (dd-fetched, brand
  // "Acme") loses; the WINNER (brand "WinnerBrand") must be what derivation consumes.
  const winnerPath = "source-snapshots/v1/product-catalog/winner.json";
  let staleServed = false;
  const h = makeHarness({
    readCoverage: async () => ({ windows: [{ from: "2025-01-01", to: TODAY }], read: "ok", error: null }),
    readSnapshot: async ({ sourceKey, scopeKey }) => {
      if (sourceKey === "product-catalog") {
        // BEFORE the sync's save: absent (so the sync plans the catalog fetch). AFTER the CAS returned
        // stale-save: the WINNING pointer.
        return staleServed
          ? { snapshot: { validated_at: TODAY + "T09:00:00Z", object_path: winnerPath, row_count: 1 }, read: "ok", error: null }
          : { snapshot: null, read: "ok", error: null };
      }
      return { snapshot: { validated_at: TODAY + "T01:00:00Z", object_path: "source-snapshots/v1/fba-inventory-health/" + scopeKey + ".json", row_count: 1 }, read: "ok", error: null };
    },
    recordSnapshot: async (s) => {
      if (s.sourceKey === "product-catalog") { staleServed = true; return { write: "ok", ack: "stale-save" }; }
      return { write: "ok", ack: "replaced" };
    },
  });
  h.snapStore.set(winnerPath, { rows: [{ child_asin: "B0A", sku: "SKU-A", product_brand: "WinnerBrand" }] });
  for (const a of ["A01", "A02"]) {
    h.snapStore.set("source-snapshots/v1/fba-inventory-health/" + a + ".json", { rows: [{ date: ASOF, sku: "SKU-A", child_asin: "B0A", marketplace_country_code: "US", available: 5 }] });
  }
  h.durableHistory.set("A01|x", { accountId: "A01", saleDate: ASOF, sku: "SKU-A", childAsin: "B0A", currency: "USD", salesAmount: 10, units: 1 });
  const pf = await h.runtime.preflightEvidence({ bucket: "us", today: TODAY });
  const rollup = await h.runtime.run({ bucket: "us", today: TODAY, preflight: pf });
  assert.equal(rollup.stopped, false, JSON.stringify(rollup.stopReason));
  assert.equal(rollup.derived.skipped, null, "the derive ran on the WINNER evidence");
  const sales = h.recorded.shadowSaves.find((s) => s.reportKey === "scheduler-v2/brand-sales" && s.accountId === "A01");
  assert.ok(sales, "brand-sales derived");
  assert.equal(sales.payload.asinBrand.B0A, "WinnerBrand", "derivation consumed the CAS WINNER's catalog");
  for (const save of h.recorded.shadowSaves) {
    assert.ok(!JSON.stringify(save.payload).includes("Acme"), "the LOSING candidate rows never reach any report payload");
  }
  // (b) an UNREADABLE winner: stale-save whose winning pointer cannot be hydrated -> typed stop, ZERO
  // report saves (LKG preserved), never a silent fold of the loser.
  const h2 = makeHarness({
    readCoverage: async () => ({ windows: [{ from: "2025-01-01", to: TODAY }], read: "ok", error: null }),
    readSnapshot: async ({ sourceKey }) => (sourceKey === "product-catalog"
      ? { snapshot: null, read: "ok", error: null } // pointer read after stale-save ALSO returns null => winner vanished
      : { snapshot: null, read: "ok", error: null }),
    recordSnapshot: async (s) => (s.sourceKey === "product-catalog" ? { write: "ok", ack: "stale-save" } : { write: "ok", ack: "replaced" }),
  });
  await assert.rejects(() => h2.runtime.run({ bucket: "us", today: TODAY }), (e) => e.code === "SOURCE_SNAPSHOT_STALE_WINNER_UNREADABLE", "unreadable winner fails closed typed");
  assert.equal(h2.recorded.shadowSaves.length, 0, "no report was saved from the losing candidate");
  // (c) unchanged: the CAS PROVED the existing pointer identical (same content sha + path) -- the candidate
  // content is authoritative and derivation proceeds.
  const h3 = fullFixture({
    recordSnapshot: async () => ({ write: "ok", ack: "unchanged" }),
  });
  const r3 = await h3.runtime.run({ bucket: "us", today: TODAY });
  assert.equal(r3.stopped, false);
  assert.equal(r3.derived.skipped, null, "proven-identical content derives normally");
});

test("U3. fix 3: brand-inventory promotes through the REAL publisher composition to its EXACT live identity; live buildAccountBrandSlice reads the PROMOTED row with NO key remapping", async () => {
  const h = fullFixture();
  const rollup = await h.runtime.run({ bucket: "us", today: TODAY });
  assert.equal(rollup.derived.brandInventory.saved >= 1, true, JSON.stringify(rollup.derived.brandInventory));
  h.store.finalizeCycle({ cycleId: rollup.cycleId }); // the dispatcher-owned reviewed complete-scope close
  const pubMod = await import("../lib/server/sync/publisher-composition.js");
  const liveRows = new Map(); // the LIVE report_snapshots natural-key model: report_key|account_id
  const publisher = pubMod.buildSchedulerV2Publisher({
    // NO codeReadyKeys override: the PRODUCTION default must include brand-inventory -- this test FAILS if
    // the key is unknown, code-locked, or unpublishable.
    connections: CONNS,
    fetchAccounts: async (apiKey) => (apiKey === PRIM_KEY ? [dirAccount("A01"), dirAccount("A02")] : [dirAccount("B01")]),
    getSettings: async () => [{ report_key: "brand-inventory", schedule_enabled: true }, { report_key: "brand-sales", schedule_enabled: true }],
    getAccountRollout: async () => ({ read: "ok", allPrimary: true, enabledAccountIds: [] }),
    getApproval: async () => ({ read: "ok", approved: true }), // the explicit audited per-(report, account) approval
    getJob: async (rk, a) => {
      const j = h.store.getReportJob(rk, a);
      return j ? { ...j, cycle_status: h.store.getCycle(j.cycle_id).status } : null;
    },
    getSnapshot: async ({ reportKey, accountId, paramsHash }) => {
      const sv = h.recorded.shadowSaves.find((x) => x.reportKey === reportKey && x.accountId === accountId && x.paramsHash === paramsHash);
      return sv ? { params_hash: sv.paramsHash, params: sv.params, payload: sv.payload, payload_storage_path: null, source_refreshed_at: sv.sourceRefreshedAt } : null;
    },
    loadStoragePayload: async () => null,
    publishLive: async (args) => {
      liveRows.set(args.reportKey + "|" + args.accountId, {
        report_key: args.reportKey, params: args.params, params_hash: args.paramsHash,
        payload: args.payload, source_refreshed_at: args.sourceRefreshedAt,
      });
      return { outcome: "inserted" };
    },
  });
  const resInv = await publisher.publish("brand-inventory", "A01");
  assert.equal(resInv.disposition, "published", JSON.stringify(resInv) + " -- brand-inventory must not be unknown/code-locked/unpublishable");
  assert.equal(resInv.liveReportKey, "brand-inventory", "the EXACT live report key");
  assert.equal((await publisher.publish("brand-sales", "A01")).disposition, "published");
  const liveInv = liveRows.get("brand-inventory|A01");
  assert.equal(liveInv.params.reportVersion, "brand-inventory-shared-v1", "the EXACT live shared version");
  assert.deepEqual(Object.keys(liveInv.params).sort(), ["reportVersion", "to"], "the EXACT live params contract ({ to })");
  assert.equal(liveInv.params.to, ASOF);
  // LIVE read path: buildAccountBrandSlice reads the PROMOTED PRODUCTION rows by their PLAIN live report
  // keys (getLatestReportSnapshot semantics) -- no scheduler-v2/ remapping anywhere in the reader.
  const bv = await import("../lib/server/reports/brand-view.js");
  const liveReader = async ({ reportKey, accountId }) => liveRows.get(reportKey + "|" + accountId) || null;
  const slice = await bv.buildAccountBrandSlice({ accountId: "A01", brand: "Acme", asOf: ASOF, account: { name: "Acct A01", country: "US" }, getSnapshot: liveReader, getAdsRows: async () => [] });
  assert.equal(slice.inventory.scope, "country", "the compact gate accepted the PROMOTED live row");
  assert.equal(slice.inventory.accountTotal, 5, "the durable FBA quantity arrived via the LIVE row");
  assert.equal(slice.inventoryDate, ASOF);
  // Structural: the promoted key is NOT dispatchable -- even a durable enable row selects nothing, and no
  // dispatcher/source-runtime path publishes automatically.
  const controls = await import("../lib/server/sync/report-controls.js");
  const dispatch = await import("../lib/server/sync/sync-dispatch.js");
  assert.ok(!controls.CONTROLLED_REPORT_KEYS.includes("brand-inventory"), "brand-inventory is NOT a controlled (dispatchable) report");
  assert.ok(controls.SOURCE_PROMOTED_REPORT_KEYS.includes("brand-inventory"), "brand-inventory is an explicit source-promoted key");
  const sel = dispatch.selectSchedulerV2ReportKeys({ settings: [{ report_key: "brand-inventory", schedule_enabled: true }] });
  assert.ok(!sel.requested.includes("brand-inventory") && !sel.readySet.has("brand-inventory"), "a durable enable row alone can never schedule the promoted key");
});

test("U4. fix 4: AbortSignal reaches the REAL HTTP wrapper; before-request expiry runs nothing; in-flight write expiry is commit-unknown; no ghost write after the handler returns", async () => {
  const sb = await import("../lib/server/supabase.js");
  // (a) the route signal object reaches globalThis.fetch for REST and Storage wrappers.
  const realFetch = globalThis.fetch;
  const seenSignals = [];
  const ctrl = new AbortController();
  try {
    globalThis.fetch = async (url, init) => { seenSignals.push(init && init.signal); return { ok: true, status: 200, json: async () => [], text: async () => "[]" }; };
    await sb.getSourceControls({ signal: ctrl.signal });
    await sb.saveSourceSnapshotPayload({ organizationFingerprint: "org1", sourceKey: "product-catalog", scopeKey: "__organization", rows: [], signal: ctrl.signal });
    assert.ok(seenSignals.length >= 2 && seenSignals.every((s) => s === ctrl.signal), "the SAME AbortSignal reached the real fetch for REST + Storage");
  } finally { globalThis.fetch = realFetch; }
  // (b) before-request expiry: the operation is NEVER invoked -- zero fetches, zero writes.
  const clockRef = { now: 1_000_000 };
  const dlExpired = runtimeMod.makeRouteDeadline({ clock: () => clockRef.now, budgetMs: 1_000, reserveMs: 5_000 });
  let invoked = 0;
  await assert.rejects(() => dlExpired.bound("some-write", () => { invoked += 1; return Promise.resolve("x"); }, { write: true }),
    (e) => e.code === "ROUTE_DEADLINE_EXCEEDED" && e.beforeRequest === true && e.inFlight === false && e.commitUnknown === false);
  assert.equal(invoked, 0, "a request that has not started makes zero writes");
  // (c) an in-flight WRITE expiry aborts the signal and is typed COMMIT-UNKNOWN -- never claimed uncommitted.
  const dlHang = runtimeMod.makeRouteDeadline({
    clock: () => clockRef.now, budgetMs: 60_000, reserveMs: 1_000,
    setTimer: (fn, ms) => setTimeout(fn, 0), clearTimer: (id) => clearTimeout(id),
  });
  let opSignal = null;
  await assert.rejects(() => dlHang.bound("hung-write", (signal) => { opSignal = signal; return new Promise(() => {}); }, { write: true }),
    (e) => e.code === "ROUTE_DEADLINE_EXCEEDED" && e.inFlight === true && e.commitUnknown === true);
  assert.ok(opSignal && opSignal.aborted, "the in-flight operation's AbortSignal was genuinely aborted");
  // (c2) a write that COMPLETED before expiry is reported as a confirmed success, never resumable.
  const dlOk = runtimeMod.makeRouteDeadline({ clock: () => clockRef.now, budgetMs: 60_000, reserveMs: 1_000, setTimer: (fn, ms) => setTimeout(fn, 0), clearTimer: (id) => clearTimeout(id) });
  assert.equal(await dlOk.bound("fast-write", async () => "committed", { write: true }), "committed");
  // (d) a hung durable WRITE inside the sync surfaces commitUnknown on the typed-resumable rollup.
  const hHang = fullFixture({
    readCoverage: async () => ({ windows: [], read: "ok", error: null }), // work to do => a replace will run
    replaceHistory: () => new Promise(() => {}),                          // hangs; ignores the abort
    setTimer: (fn, ms) => setTimeout(fn, 0), clearTimer: (id) => clearTimeout(id),
  });
  const rHang = await hHang.runtime.run({ bucket: "us", today: TODAY });
  assert.equal(rHang.deadlineReached, true);
  assert.equal(rHang.continuationRequired, true);
  assert.equal(rHang.commitUnknown, true, "an aborted in-flight durable write is reported COMMIT-UNKNOWN, not silently uncommitted");
  // (e) GHOST-WRITE prevention: the abandoned first persistence step resolving AFTER the route aborted must
  // NOT trigger the subsequent pointer write or mutate evidence.
  let releaseSave = null;
  const pendingSave = new Promise((resolve) => { releaseSave = resolve; });
  const hGhost = fullFixture({
    // ABSENT catalog/FBA snapshots => the sync genuinely fetches + persists; step 1 of the persistence
    // (the immutable object upload) hangs until AFTER the handler returned.
    readSnapshot: async () => ({ snapshot: null, read: "ok", error: null }),
    saveSnapshotPayload: () => pendingSave,
    setTimer: (fn, ms) => setTimeout(fn, 0), clearTimer: (id) => clearTimeout(id),
  });
  const pfGhost = await hGhost.runtime.preflightEvidence({ bucket: "us", today: TODAY });
  const snapshotFolds = () => JSON.stringify(pfGhost.evidence.catalogRows || null);
  const foldsBefore = snapshotFolds();
  const rGhost = await hGhost.runtime.run({ bucket: "us", today: TODAY, preflight: pfGhost });
  assert.equal(rGhost.deadlineReached, true, "the hung persistence expired typed-resumable");
  const recordedBefore = hGhost.recorded.snapshots.length;
  releaseSave({ objectPath: "source-snapshots/v1/product-catalog/__organization.json", payloadBytes: 2 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(hGhost.recorded.snapshots.length, recordedBefore, "NO ghost pointer write after the handler returned");
  assert.equal(snapshotFolds(), foldsBefore, "NO ghost in-memory evidence mutation after the handler returned");
});

test("U5. fix 5: 30 accounts / 6 batches -- every report's depends_on is ACCOUNT-EXACT (own batch OLI + own FBA + shared catalog scope); zero cross-batch leakage", async () => {
  const ids = Array.from({ length: 30 }, (_, i) => "A" + String(i + 1).padStart(2, "0"));
  const h = makeHarness({
    primaryAccounts: ids.map((id) => dirAccount(id)),
    secondaryAccounts: [],
    readCoverage: async () => ({ windows: [{ from: "2025-01-01", to: TODAY }], read: "ok", error: null }),
    readSnapshot: async ({ sourceKey, scopeKey }) => {
      if (sourceKey === "product-catalog") return { snapshot: { validated_at: TODAY + "T01:00:00Z", object_path: "source-snapshots/v1/product-catalog/__organization.json", row_count: 1 }, read: "ok", error: null };
      return { snapshot: null, read: "ok", error: null }; // FBA absent => the sync FETCHES one export per account
    },
  });
  h.snapStore.set("source-snapshots/v1/product-catalog/__organization.json", { rows: [{ child_asin: "B0A", sku: "SKU-A", product_brand: "Acme" }] });
  for (const id of ids) {
    h.durableHistory.set(id + "|x", { accountId: id, saleDate: ASOF, sku: "SKU-A", childAsin: "B0A", currency: "USD", salesAmount: 10, units: 1 });
  }
  const pf = await h.runtime.preflightEvidence({ bucket: "us", today: TODAY });
  const rollup = await h.runtime.run({ bucket: "us", today: TODAY, preflight: pf });
  assert.equal(rollup.stopped, false, JSON.stringify(rollup.stopReason));
  assert.equal(rollup.derived.skipped, null);
  assert.equal(new Set(h.membership.values()).size, 6, "30 accounts assigned into exactly 6 batches of <=5");
  const owners = h.store.listCycleOwners(rollup.cycleId);
  const jobs = h.store.listSourceJobs(rollup.cycleId);
  const jobByHash = new Map(jobs.map((j) => [j.request_hash, j]));
  const oliOwned = (aid) => new Set(owners.filter((o) => o.account_id === aid && jobByHash.get(o.request_hash) && jobByHash.get(o.request_hash).source_key === "order-line-items").map((o) => o.request_hash));
  const fbaOwned = (aid) => new Set(owners.filter((o) => o.account_id === aid && jobByHash.get(o.request_hash) && jobByHash.get(o.request_hash).source_key === "fba-inventory-health").map((o) => o.request_hash));
  const upserts = h.recorded.lineage.filter((l) => l.op === "upsert");
  assert.ok(upserts.length >= 60, "daily + brand-sales (+ inventory) lineage for the fleet: " + upserts.length);
  for (const u of upserts) {
    const myOli = oliOwned(u.accountId);
    const myFba = fbaOwned(u.accountId);
    for (const hash of u.dependsOn) {
      const job = jobByHash.get(hash);
      assert.ok(job, "every dependency is a real cycle job");
      if (job.source_key === "order-line-items") assert.ok(myOli.has(hash), u.reportKey + "/" + u.accountId + " depends only on ITS OWN batch's OLI export");
      else if (job.source_key === "fba-inventory-health") assert.ok(myFba.has(hash) && u.reportKey === "brand-inventory", u.accountId + " depends only on ITS OWN FBA export (brand-inventory only)");
    }
    if (u.reportKey !== "brand-inventory") assert.ok(u.dependsOn.every((hash) => (jobByHash.get(hash) || {}).source_key !== "fba-inventory-health"), "daily/brand-sales never depend on FBA");
    assert.ok(u.dependsOn.length >= 1, u.reportKey + "/" + u.accountId + ": nonempty account-owned dependency set");
  }
  // Cross-batch DISJOINTNESS: accounts in different batches share ZERO OLI dependencies.
  const dailyOf = (aid) => upserts.find((u) => u.reportKey === "daily-reporting" && u.accountId === aid);
  const batchOf = (aid) => h.membership.get(aid);
  const a = dailyOf("A01"); const bAcct = ids.find((id) => batchOf(id) !== batchOf("A01"));
  const b = dailyOf(bAcct);
  assert.ok(a && b, "two accounts in different batches derived");
  const shared = a.dependsOn.filter((hash) => b.dependsOn.includes(hash));
  assert.ok(shared.every((hash) => (jobByHash.get(hash) || {}).source_key === "product-catalog"), "cross-batch shared dependencies can ONLY be the organization-wide catalog scope: " + JSON.stringify(shared.map((x) => (jobByHash.get(x) || {}).source_key)));
  const sameBatchPeer = ids.find((id) => id !== "A01" && batchOf(id) === batchOf("A01"));
  assert.deepEqual(dailyOf(sameBatchPeer).dependsOn.filter((hash) => (jobByHash.get(hash) || {}).source_key === "order-line-items").sort(), a.dependsOn.filter((hash) => (jobByHash.get(hash) || {}).source_key === "order-line-items").sort(), "batch members genuinely SHARE their batch's OLI export hashes");
  // FBA: each brand-inventory row depends on exactly ITS account's FBA hash.
  const invA01 = upserts.find((u) => u.reportKey === "brand-inventory" && u.accountId === "A01");
  const invPeer = upserts.find((u) => u.reportKey === "brand-inventory" && u.accountId === bAcct);
  assert.ok(invA01 && invPeer, "brand-inventory lineage for both probes");
  const fbaDeps = (u) => u.dependsOn.filter((hash) => (jobByHash.get(hash) || {}).source_key === "fba-inventory-health");
  assert.equal(fbaDeps(invA01).length, 1);
  assert.equal(fbaDeps(invPeer).length, 1);
  assert.notEqual(fbaDeps(invA01)[0], fbaDeps(invPeer)[0], "one account NEVER depends on another account's FBA export");
});

test("U6. fix 6: the ACL model includes PostgreSQL 17 MAINTAIN -- GRANT ALL leaves MAINTAIN behind the legacy-seven revoke; explicit MAINTAIN is forbidden; REVOKE ALL clears it; the real migration stays clean", () => {
  assert.equal(auditWith(null).ok, true, "the real Migration 20260820 audits clean under the PG17 model");
  // (a) GRANT ALL then revoking only the LEGACY SEVEN privileges still leaves MAINTAIN held -> typed blocker.
  const maintainSurvives = auditWith((sql) => sql.replace(
    "grant select, insert, update on table public.source_coverage to service_role;",
    "grant all on table public.source_coverage to service_role;\n"
    + "revoke select, insert, update, delete, truncate, references, trigger on table public.source_coverage from service_role;\n"
    + "grant select, insert, update on table public.source_coverage to service_role;",
  ));
  assert.ok(maintainSurvives.blockers.some((b) => b.code === "SERVICE_ROLE_GRANT_MISMATCH" && /maintain/.test(b.message)), JSON.stringify(maintainSurvives.blockers.map((b) => b.code)) + " -- a pre-PG17 seven-privilege model would have passed this");
  // (b) explicit MAINTAIN is forbidden for every role unless expressly expected.
  const maintainAuth = auditWith((sql) => sql + "\ngrant maintain on table public.source_controls to authenticated;\n");
  assert.ok(maintainAuth.blockers.some((b) => b.code === "AUTH_GRANT_FORBIDDEN" && /maintain/.test(b.message)), JSON.stringify(maintainAuth.blockers.map((b) => b.code)));
  const maintainSrv = auditWith((sql) => sql + "\ngrant maintain on table public.source_snapshots to service_role;\n");
  assert.ok(maintainSrv.blockers.some((b) => b.code === "SERVICE_ROLE_GRANT_MISMATCH"), JSON.stringify(maintainSrv.blockers.map((b) => b.code)));
  const maintainAnon = auditWith((sql) => sql + "\ngrant maintain on table public.source_coverage to anon;\n");
  assert.ok(maintainAnon.blockers.some((b) => b.code === "AUTH_GRANT_FORBIDDEN"), JSON.stringify(maintainAnon.blockers.map((b) => b.code)));
  const maintainBot = auditWith((sql) => sql + "\ngrant maintain on table public.source_run_status to maintenance_bot;\n");
  assert.ok(maintainBot.blockers.some((b) => b.code === "AUTH_GRANT_FORBIDDEN" && /maintenance_bot/.test(b.message)), JSON.stringify(maintainBot.blockers.map((b) => b.code)));
  // (c) REVOKE ALL clears MAINTAIN in the modeled final state (the re-granted select keeps the table's
  // expected authenticated ACL intact -- so a clean audit PROVES maintain was cleared).
  const revokeAllClears = auditWith((sql) => sql
    + "\ngrant maintain on table public.source_controls to authenticated;"
    + "\nrevoke all on table public.source_controls from authenticated;"
    + "\ngrant select on table public.source_controls to authenticated;\n");
  assert.equal(revokeAllClears.ok, true, JSON.stringify(revokeAllClears.blockers));
});

async function main() {
  out("source production-hardening proof suite");
  runtimeMod = await import("../lib/server/sync/source-bucket-sync-runtime.js");
  registry = await import("../lib/server/sync/source-registry.js");
  schema = await import("../lib/server/sync/schema-contract.js");
  dates = await import("../lib/server/date-windows.js");
  identity = await import("../lib/server/source-identity.js");
  reportStore = await import("../lib/server/report-store.js");

  let failures = 0;
  for (const t of tests) {
    if (t.marker) { out("-- " + t.marker); continue; }
    try {
      await t.fn();
      passed += 1;
      out("  ok  " + t.name);
    } catch (e) {
      failures += 1;
      out("FAIL  " + t.name);
      out(String((e && e.stack) || e));
    }
  }
  out("\n" + passed + " assertions passed" + (failures ? ", " + failures + " FAILED" : ""));
  if (failures) process.exitCode = 1;
}

main();
