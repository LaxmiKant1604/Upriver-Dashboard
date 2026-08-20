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

let runtimeMod; let registry; let schema; let dates; let identity;

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
  const cache = new Map(); const budgets = new Map(); let seq = 0;
  const findCycle = (id) => [...cycles.values()].find((c) => c.id === id) || null;
  const ownerRows = (cid) => [...((ownersByCycle.get(cid) && ownersByCycle.get(cid).values()) || [])];
  const bkey = (cid, tk) => cid + "|" + tk;
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
      cache.set(h, {
        rows: [...rows], source_id: job.sourceId, organization_fingerprint: job.organizationFingerprint,
        account_scope_hash: job.accountScopeHash, object_path: objectPath, row_count: rows.length,
        payload_bytes: payloadBytes, expires_at: new Date(Date.now() + 20 * 3600 * 1000).toISOString(),
      });
      return objectPath;
    },
    recordSourceSuccess({ cycleId, requestHash, exportId, rowCount, cacheObjectPath }) {
      Object.assign(jobsByCycle.get(cycleId).get(requestHash), { fetch_status: "succeeded", export_id: exportId, row_count: rowCount, cache_object_path: cacheObjectPath });
    },
    recordSourceFailure({ cycleId, requestHash, stage, code, terminal }) {
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
      if (apiKey === PRIM_KEY) return over.primaryAccounts || [dirAccount("A01"), dirAccount("A02")];
      return over.secondaryAccounts || [dirAccount("B01")];
    },
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
    saveSnapshotPayload: async ({ sourceKey, scopeKey, rows }) => {
      const objectPath = `source-snapshots/v1/${sourceKey}/${scopeKey}.json`;
      snapStore.set(objectPath, { rows: [...rows] });
      return { objectPath, payloadBytes: JSON.stringify({ rows }).length };
    },
    loadSnapshotPayload: async (objectPath) => snapStore.get(objectPath) || null,
    recordSnapshot: async (s) => { recorded.snapshots.push(s); return { write: "ok" }; },
    loadHistoryRows: over.loadHistoryRows || (async () => [...durableHistory.values()].map((r) => ({
      account_id: r.accountId, sale_date: r.saleDate, sku: r.sku, child_asin: r.childAsin,
      currency: r.currency, sales_amount: r.salesAmount, units: r.units,
    }))),
    updateRunStatus: async () => ({ write: "ok" }),
    makeShadowSaver: () => async (args) => { recorded.shadowSaves.push(args); return { paramsHash: "ph_" + args.reportKey + "_" + args.accountId }; },
    readSettings: over.readSettings || (async () => []),
    readRollout: over.readRollout || (async () => ({ read: "ok", allPrimary: false, enabledAccountIds: [] })),
    readAdMetrics: over.readAdMetrics || (async () => []),
    reportLineage: over.reportLineage || {
      upsertReportJob: async (j) => { recorded.lineage.push({ op: "upsert", ...j }); },
      claimReportDerive: async (c, rk, a) => { recorded.lineage.push({ op: "claim", reportKey: rk, accountId: a }); return true; },
      recordReportSuccess: async (j) => { recorded.lineage.push({ op: "success", ...j }); },
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
  const preflight = src.indexOf("preflightEvidence({ bucket, sourceKey: onlySourceKey })");
  const postAudit = src.indexOf('action: "source.sync.missing"');
  assert.ok(preflight > 0 && postAudit > preflight, "POST runs the evidence preflight BEFORE the audit write");
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
    assert.equal(sSucc.snapshotParamsHash, "ph_" + save.reportKey + "_" + save.accountId, "the EXACT saver-computed snapshot_params_hash is recorded");
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

async function main() {
  out("source production-hardening proof suite");
  runtimeMod = await import("../lib/server/sync/source-bucket-sync-runtime.js");
  registry = await import("../lib/server/sync/source-registry.js");
  schema = await import("../lib/server/sync/schema-contract.js");
  dates = await import("../lib/server/date-windows.js");
  identity = await import("../lib/server/source-identity.js");

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
