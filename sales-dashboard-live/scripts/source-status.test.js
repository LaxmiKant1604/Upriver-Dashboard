// Scheduler v2 -- DATA SYNC CENTER source cards + readiness summary + runtime composition proof suite
// (offline, ZERO network/DB).
//
// Proves:
//   A. shapeSourceCards -- one card per registered source family with EXACTLY the reviewed field set
//      (label, last attempt, last success, status + safe error, covered_from/to, completed/failed/total
//      accounts, stable batch count, creates/tokens vs ceiling, "Used by" dashboards, paused/schedule);
//      paused comes from source_controls; a source with no durable rows reads "never".
//   B. dashboardReadinessSummary -- READ-ONLY: a failed/paused/never REQUIRED source blocks Daily Reporting /
//      Brand View with a typed reason; an unhealthy Ads/inventory source only DEGRADES its half.
//   C. buildBucketSourceSyncRuntime -- ZERO I/O at construction; run() wires discovery -> coverage-driven
//      plan -> worker; `onlySourceKey` scopes a per-card "Sync missing data" to ONE family; a PAUSED source
//      cannot be force-synced (typed SOURCE_PAUSED); a missing primary connection fails closed.
//   D. the api/admin/sources.js endpoint file structurally requires admin auth, audits every mutation, and
//      rate-limits the manual run (text-level pins).
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

let status; // source-status
let runtimeMod; // source-bucket-sync-runtime
let registry; // source-registry

const runRow = (sourceKey, bucket, over = {}) => ({
  source_key: sourceKey, bucket, last_status: "succeeded",
  last_attempt_at: "2026-08-20T02:10:00Z", last_success_at: "2026-08-20T02:15:00Z",
  safe_error_code: null, safe_error_stage: null,
  covered_from: "2025-06-01", covered_to: "2026-08-19",
  accounts_completed: 5, accounts_failed: 0, accounts_total: 5,
  batch_count: 1, creates_spent: 2, tokens_spent: 4, creates_ceiling: 2, tokens_ceiling: 4,
  ...over,
});

group("A. source cards");

test("A1. one card per registered family with the exact reviewed field set; unknown-durable sources read 'never'", () => {
  const cards = status.shapeSourceCards({
    bucket: "us",
    controls: [{ source_key: "order-line-items", paused: false, schedule_enabled: false }],
    runStatuses: [runRow("order-line-items", "us")],
  });
  assert.equal(cards.length, registry.SOURCE_REGISTRY.length, "one card per registered source family");
  const oli = cards.find((c) => c.sourceKey === "order-line-items");
  assert.equal(oli.label, "Order Line Items", "the human label comes from the canonical contract");
  assert.deepEqual([...oli.usedBy], [...registry.dashboardsUsingSource("order-line-items")], "the Used-by dashboard list");
  assert.equal(oli.status.lastAttemptAt, "2026-08-20T02:10:00Z");
  assert.equal(oli.status.lastSuccessAt, "2026-08-20T02:15:00Z");
  assert.equal(oli.status.coveredFrom, "2025-06-01");
  assert.equal(oli.status.coveredTo, "2026-08-19");
  assert.equal(oli.status.accountsCompleted, 5);
  assert.equal(oli.status.batchCount, 1);
  assert.equal(oli.status.createsSpent, 2);
  assert.equal(oli.status.tokensCeiling, 4);
  assert.equal(oli.paused, false);
  const untouched = cards.find((c) => c.sourceKey === "sqp-monthly");
  assert.equal(untouched.status.lastStatus, "never", "no durable rows => an honest 'never'");
  assert.throws(() => status.shapeSourceCards({ bucket: "eu" }), /'us'\|'non-us'/);
});

test("A2. pause comes from source_controls and surfaces on the card", () => {
  const cards = status.shapeSourceCards({
    bucket: "non-us",
    controls: [{ source_key: "product-catalog", paused: true, schedule_enabled: false }],
    runStatuses: [],
  });
  const cat = cards.find((c) => c.sourceKey === "product-catalog");
  assert.equal(cat.paused, true);
  assert.equal(cat.status.lastStatus, "paused");
});

group("B. read-only dashboard readiness summary");

const healthyCards = () => status.shapeSourceCards({
  bucket: "us",
  controls: [],
  runStatuses: registry.SOURCE_REGISTRY.map((r) => runRow(r.sourceKey, "us")),
});

test("B1. healthy sources => both priority dashboards ready with nothing degraded", () => {
  const summary = status.dashboardReadinessSummary(healthyCards());
  const daily = summary.find((r) => r.dashboard === "daily-reporting");
  const bv = summary.find((r) => r.dashboard === "brand-view");
  assert.equal(daily.ready, true); assert.deepEqual([...daily.blockedBy], []); assert.deepEqual([...daily.degradedBy], []);
  assert.equal(bv.ready, true);
});

test("B2. a failed REQUIRED source blocks BOTH dashboards typed; a paused one blocks with 'paused'", () => {
  const failed = status.shapeSourceCards({
    bucket: "us", controls: [],
    runStatuses: registry.SOURCE_REGISTRY.map((r) => runRow(r.sourceKey, "us", r.sourceKey === "order-line-items" ? { last_status: "failed", safe_error_code: "TIMEOUT" } : {})),
  });
  const summary = status.dashboardReadinessSummary(failed);
  for (const dash of summary) {
    assert.equal(dash.ready, false, dash.dashboard + " blocked by the failed OLI source");
    assert.deepEqual([...dash.blockedBy], [{ sourceKey: "order-line-items", reason: "last-run-failed" }]);
  }
  const paused = status.shapeSourceCards({
    bucket: "us",
    controls: [{ source_key: "product-catalog", paused: true, schedule_enabled: false }],
    runStatuses: registry.SOURCE_REGISTRY.map((r) => runRow(r.sourceKey, "us")),
  });
  const pausedSummary = status.dashboardReadinessSummary(paused);
  for (const dash of pausedSummary) {
    assert.deepEqual([...dash.blockedBy], [{ sourceKey: "product-catalog", reason: "paused" }]);
  }
});

test("B3. an unhealthy Ads/inventory source DEGRADES its dashboard half without blocking sales", () => {
  const cards = status.shapeSourceCards({
    bucket: "us", controls: [],
    runStatuses: registry.SOURCE_REGISTRY.map((r) => runRow(r.sourceKey, "us",
      (r.sourceKey === "ads-campaign-date" || r.sourceKey === "ads-asin-date") ? { last_status: "failed" } : {})),
  });
  const summary = status.dashboardReadinessSummary(cards);
  const daily = summary.find((r) => r.dashboard === "daily-reporting");
  assert.equal(daily.ready, true, "an Ads gap never blocks Daily sales");
  assert.deepEqual([...daily.degradedBy], [{ sourceKey: "ads-campaign-date", reason: "last-run-failed" }], "Daily degrades on the CAMPAIGN grain only");
  const bv = summary.find((r) => r.dashboard === "brand-view");
  assert.equal(bv.ready, true);
  assert.deepEqual([...bv.degradedBy], [{ sourceKey: "ads-asin-date", reason: "last-run-failed" }], "Brand View degrades on the ASIN grain only");
});

group("C. production composition (offline, injected fakes)");

// A minimal worker store: enough for runBucketSourceSync's catalog-only scoped run.
function makeMiniStore() {
  const jobs = new Map(); const cache = new Map(); let cycle = null;
  return {
    openCycle() { if (!cycle) cycle = { id: "cyc_1", status: "pending" }; return cycle.id; },
    claimCycle(id) { if (cycle && cycle.id === id && cycle.status === "pending") { cycle.status = "running"; return true; } return false; },
    getCycle() { return cycle; },
    upsertSourceJob(job) { if (!jobs.has(job.requestHash)) jobs.set(job.requestHash, { request_hash: job.requestHash, request_key: job.requestKey, source_key: job.sourceKey, source_id: job.sourceId, connection_id: job.connectionId, organization_fingerprint: job.organizationFingerprint, account_scope_hash: job.accountScopeHash, fetch_status: "pending", attempted_at: null, create_export_count: 0, export_id: null, cache_object_path: null }); },
    listSourceJobs() { return [...jobs.values()].map((j) => ({ ...j })); },
    upsertSourceJobOwners() {},
    listSourceJobOwners() { return []; },
    recordSourceOwnerStale() {},
    claimExportAttempt(_c, h) { const j = jobs.get(h); if (j && j.fetch_status === "pending" && j.attempted_at === null) { j.attempted_at = "t"; j.create_export_count += 1; j.fetch_status = "attempted"; return true; } return false; },
    adoptSourceCache() { return "cache-changed"; },
    recordExportCreated({ requestHash, exportId }) { jobs.get(requestHash).export_id = exportId; },
    loadSourceRows(h) { return cache.get(h) || null; },
    saveSourceRows({ job, rows, payloadBytes }) { const h = job.request_hash ?? job.requestHash; const p = "p/" + h; cache.set(h, { rows: [...rows], source_id: job.sourceId, organization_fingerprint: job.organizationFingerprint, account_scope_hash: job.accountScopeHash, object_path: p, row_count: rows.length, payload_bytes: payloadBytes }); return p; },
    recordSourceSuccess({ requestHash, exportId, rowCount, cacheObjectPath }) { Object.assign(jobs.get(requestHash), { fetch_status: "succeeded", export_id: exportId, row_count: rowCount, cache_object_path: cacheObjectPath }); },
    recordSourceFailure({ requestHash, stage, code }) { Object.assign(jobs.get(requestHash), { fetch_status: "failed", error_stage: stage, error_code: code }); },
    updateCycleCounts() {},
    persistBudget() { return "created"; },
    reserveExportCreate({ requestHash }) { const j = jobs.get(requestHash); if (j && j.fetch_status === "pending" && j.attempted_at === null) { j.attempted_at = "t"; j.create_export_count += 1; j.fetch_status = "attempted"; return "reserved"; } return "not-pending"; },
  };
}

const CONNS = [{ id: "primary", apiKey: ["prim", "key"].join("-"), accountPrefix: "" }];

function makeComposition({ paused = [], calls } = {}) {
  const record = calls || { discovery: 0, creates: [] };
  const runtime = runtimeMod.buildBucketSourceSyncRuntime({
    getConnections: () => { record.getConnections = (record.getConnections || 0) + 1; return CONNS; },
    fetchAccounts: async () => { record.discovery += 1; return [{ id: "A01", name: "Acct", country: "US", currency: "USD", status: "active" }]; },
    makeSourceStore: () => makeMiniStore(),
    makeAdapter: () => ({
      async create(job) { record.creates.push({ sourceKey: job.sourceKey, requestKey: job.requestKey }); return { exportId: "e1" }; },
      async poll() {},
      async download(job) {
        if ((job.requestKey || "").includes("catalog")) return [{ child_asin: "B0A", sku: "K", parent_asin: "P", product_name: "N", product_brand: "Acme" }];
        return [];
      },
    }),
    readSourceControls: async () => ({ rows: paused.map((k) => ({ source_key: k, paused: true, schedule_enabled: false })), read: "ok", error: null }),
    readCoverage: async () => ({ windows: [{ from: "2025-01-01", to: "2026-08-19" }], read: "ok", error: null }),
    readSnapshot: async () => ({ snapshot: null, read: "ok", error: null }),
    readAdsCoverage: async () => ({ windows: [], read: "ok", error: null }),
    readBatchMembership: async () => [],
    assignBatchMembership: async () => { record.assigns = (record.assigns || 0) + 1; return record.assigns - 1 >= 0 ? 0 : 0; },
    replaceHistory: async ({ rows }) => ({ write: "ok", replaced: 0, inserted: rows.length }),
    saveSnapshotPayload: async ({ sourceKey, scopeKey }) => ({ objectPath: "source-snapshots/v1/" + sourceKey + "/" + scopeKey + ".json", payloadBytes: 2 }),
    recordSnapshot: async () => ({ write: "ok" }),
    loadSnapshotPayload: async () => ({ rows: [] }),
    loadHistoryRows: async () => [],
    makeShadowSaver: () => async () => ({ paramsHash: "ph" }),
    updateRunStatus: async () => ({ write: "ok" }),
    clock: () => 1_700_000_000_000,
  });
  return { runtime, record };
}

test("C1. construction performs ZERO I/O; run() discovers once and scopes onlySourceKey to ONE family", async () => {
  const { runtime, record } = makeComposition();
  assert.equal(record.discovery, 0, "no discovery at build time");
  assert.equal(record.getConnections || 0, 0, "no connection read at build time");
  const rollup = await runtime.run({ bucket: "us", today: "2026-08-20", onlySourceKey: "product-catalog" });
  assert.equal(record.discovery, 1, "exactly one accounts GET");
  assert.equal(rollup.stopped, false, JSON.stringify(rollup.stopReason));
  assert.deepEqual(record.creates.map((c) => c.sourceKey), ["product-catalog"], "ONLY the requested family exported");
  assert.deepEqual(rollup.skippedPaused.sort(), ["fba-inventory-health", "order-line-items"], "the other sync families were scope-paused for this run");
});

test("C2. a durably PAUSED source cannot be force-synced (typed 409); unknown source fails closed", async () => {
  const { runtime } = makeComposition({ paused: ["product-catalog"] });
  await assert.rejects(
    () => runtime.run({ bucket: "us", today: "2026-08-20", onlySourceKey: "product-catalog" }),
    (e) => e.code === "SOURCE_PAUSED" && e.status === 409,
  );
  const { runtime: r2 } = makeComposition();
  await assert.rejects(() => r2.run({ bucket: "us", onlySourceKey: "no-such-source" }), /UNREGISTERED_SOURCE/);
  await assert.rejects(() => r2.run({ bucket: "eu" }), /'us'\|'non-us'/);
});

test("C3. a missing primary connection fails closed BEFORE any discovery (controls are read first, fail-closed)", async () => {
  let discoveries = 0;
  const runtime = runtimeMod.buildBucketSourceSyncRuntime({
    getConnections: () => [],
    fetchAccounts: async () => { discoveries += 1; return []; },
    readSourceControls: async () => ({ rows: [], read: "ok", error: null }),
  });
  await assert.rejects(() => runtime.run({ bucket: "us" }), /primary DataDoe connection/);
  assert.equal(discoveries, 0);
});

group("D. endpoint structural pins");

test("D1. api/admin/sources.js requires admin, audits mutations, and rate-limits the manual run", () => {
  const src = readFileSync(path.join(process.cwd(), "api", "admin", "sources.js"), "utf8");
  assert.match(src, /assertAdmin\(access\)/, "admin auth on every method");
  assert.match(src, /source\.paused/, "pause audited");
  assert.match(src, /source\.resumed/, "resume audited");
  assert.match(src, /source\.sync\.missing/, "manual sync audited");
  assert.match(src, /allowManualRun\(access\.userId\)/, "manual runs rate-limited");
  assert.match(src, /never re-exported|never be re-exported/i, "the proven-coverage guarantee is documented at the endpoint");
  assert.doesNotMatch(src, /SUPABASE_SERVICE_ROLE_KEY|apiKey/, "no secret-shaped identifiers in the endpoint");
});

async function main() {
  out("source-status + bucket-sync-runtime proof suite");
  status = await import("../lib/server/sync/source-status.js");
  runtimeMod = await import("../lib/server/sync/source-bucket-sync-runtime.js");
  registry = await import("../lib/server/sync/source-registry.js");

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
