// PRODUCTION-SHAPED integration test for the FBA zero-export durable backstop -- proves the REAL {plan, cost} caller
// contract end-to-end, NOT a fabricated cost.plan or a source-text "collaborator was wired" grep.
//
// It builds the plan with the REAL planFbaBucketCost (over fixture DataDoe connections + accounts), drives the REAL
// advanceFbaPlanBucket with the plan passed separately from the token cost, runs the REAL
// persistDurableFbaSnapshotsFromPlan against a fixture source-export cache, and proves that:
//   - the token `cost` has NO `.plan` (exactly why the historical `cost.plan` read silently persisted nothing);
//   - the persist LOADS the cache under the plan's batch inventory request hash (cache loading matches the plan);
//   - each account's rows are ISOLATED to its seller + marketplace (a cross-warehouse EU row is never double-counted);
//   - the durable snapshot is recorded under resolvedFbaSnapshot(account).requestHash -- the EXACT identity the
//     reconciler recomputes (resolveExpectedRequestHash) -- and computeFbaAccountRevision then accepts it as ELIGIBLE;
//   - the typed durableFba disposition is emitted for terminal-resume, zero-included, cache-miss, and one-account-fail.
// Offline; zero network; zero export. 7-bit ASCII, LF.

import assert from "node:assert/strict";
import { writeSync } from "node:fs";

process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://supabase.test";
const SB_KEY_ENV = ["SUPABASE", "SERVICE", "ROLE", "KEY"].join("_");
process.env[SB_KEY_ENV] = process.env[SB_KEY_ENV] || ["test", "svc", "role", "key"].join("-");
process.env.POSTGRES_URL = process.env.POSTGRES_URL || "postgres://u:p@localhost:5432/db";

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const ok = (n, c) => { assert.ok(c, n); passed += 1; writeSync(1, "  ok  " + n + "\n"); };

let OP, PERSIST, SBS, REV, MODEL;

// Fixture DataDoe connection: a single PRIMARY connection. For a primary account the public id IS the raw seller id
// (resolveDataDoeAccountIds maps 1:1), so accountId "sA"/"sB" resolve to rawSellerId "sA"/"sB".
const CONNECTIONS = [{ id: "primary", apiKey: "fixture-key" }];
const ACCOUNTS = [
  { accountId: "sA", country: "GB", currency: "GBP", name: "Alpha" },
  { accountId: "sB", country: "DE", currency: "EUR", name: "Beta" },
];
const ASOF = "2026-09-22";
const BUCKET = "europe-au";

// A shared EU batch payload: sA has 2 GB rows + 1 cross-warehouse DE row (must NOT attribute to the GB account),
// sB has 1 DE row, and a FOREIGN seller sX (excluded from both).
const BATCH_ROWS = [
  { seller_or_vendor_id: "sA", marketplace_country_code: "GB", sku: "a1", available_units: 10 },
  { seller_or_vendor_id: "sA", marketplace_country_code: "GB", sku: "a2", available_units: 5 },
  { seller_or_vendor_id: "sA", marketplace_country_code: "DE", sku: "aX", available_units: 99 },
  { seller_or_vendor_id: "sB", marketplace_country_code: "DE", sku: "b1", available_units: 7 },
  { seller_or_vendor_id: "sX", marketplace_country_code: "GB", sku: "x1", available_units: 1 },
];

// A terminal-cycle runtime double so advanceFbaPlanBucket skips the fetch and reaches persist + publish deterministically.
function terminalRuntime() {
  const cur = { id: "cyc-" + BUCKET + "-fba", status: "succeeded" };
  return { run: async () => ({ cycleId: cur.id, drained: true }), store: { getCycleByBucketDate: async () => cur, finalizeCycle: async () => ({ disposition: "already-terminal", cycle: { status: "succeeded" } }) } };
}
function publisher() {
  return { preflight: async () => ({}), publish: async (rk, acc) => ({ disposition: "published", reportKey: rk, accountId: acc, liveReportKey: "fba-plan", paramsHash: "ph-" + acc }) };
}
function controls() { return { apply: async () => {}, close: async () => {} }; }
const okReadback = async () => ({ ok: true });

// The REAL persist wired exactly as the release seam wires it, over a fixture cache + recorder.
function persistWiring(cache, recorded = []) {
  return async ({ reportRequests, includedIds, inventoryAsOf, bucket, accountsById }) =>
    PERSIST.persistDurableFbaSnapshotsFromPlan({
      reportRequests, includedIds, inventoryAsOf, bucket, accountsById,
      apiKey: "fixture-key", connectionId: "primary",
      loadSourceExportCache: async (h) => (cache.has(h) ? { rows: cache.get(h) } : null),
      saveSnapshotPayload: async (a) => ({ objectPath: "snap/" + a.scopeKey, payloadSha: "sha-" + a.scopeKey + "-" + a.rows.length, payloadBytes: JSON.stringify(a.rows).length }),
      recordSnapshot: async (a) => { recorded.push(a); return { write: "ok", ack: "replaced" }; },
    });
}

async function realPlanCost() {
  return OP.planFbaBucketCost({ bucketAccounts: ACCOUNTS, connections: CONNECTIONS, asOf: ASOF, inventoryAsOf: ASOF, getSourceExportCache: async () => null });
}
const invHashOf = (plan, accountId) => {
  const req = plan.reportRequests.find((r) => r.accountId === accountId);
  const s = (req.sources || []).find((x) => x.requestKey === "fba-plan:inventory-health");
  return s && s.requestHash;
};
const expectedHash = (rawSellerId, country) => String(SBS.resolvedFbaSnapshot({ apiKey: "fixture-key", account: { rawSellerId, country }, asOf: ASOF, bucket: BUCKET }).requestHash);

test("REAL contract: planFbaBucketCost returns {plan, cost} where cost has NO .plan (the exact reason cost.plan silently persisted nothing)", async () => {
  const { plan, cost } = await realPlanCost();
  ok("cost carries the token fields only", typeof cost.creates === "number" && typeof cost.tokens === "number" && typeof cost.byFamily === "object");
  ok("cost has NO .plan (so the old advanceFbaPlanBucket read undefined -> empty reportRequests)", cost.plan === undefined);
  ok("the PLAN carries a per-account report request for every account", plan.reportRequests.length === 2 && plan.reportRequests.every((r) => r.accountId && r.owner && r.owner.rawSellerId));
  ok("each report request carries an fba-plan:inventory-health source with a request hash", plan.reportRequests.every((r) => (r.sources || []).some((s) => s.requestKey === "fba-plan:inventory-health" && s.requestHash)));
});

test("END-TO-END: the real plan drives the persist -> cache loaded by the plan's batch hash -> per-account isolation -> reconciler-identity match", async () => {
  const { plan, cost } = await realPlanCost();
  const invHash = invHashOf(plan, "sA");
  ok("sA and sB share one EU batch inventory hash (packed together)", invHash && invHash === invHashOf(plan, "sB"));
  const cache = new Map([[invHash, BATCH_ROWS]]);
  const recorded = [];
  const r = await OP.advanceFbaPlanBucket({
    bucket: BUCKET, asOf: ASOF, inventoryAsOf: ASOF, includedIds: ["sA", "sB"], bucketAccounts: ACCOUNTS,
    plan, cost, maxTokens: 80, runtime: terminalRuntime(), publisher: publisher(), controls: controls(), readbackLive: okReadback,
    persistDurableFbaSnapshots: persistWiring(cache, recorded),
  });
  ok("publication complete + backstop ok", r.phase === "complete" && r.durableFba && r.durableFba.ok === true && r.durableFba.persisted === 2);
  const recA = recorded.find((c) => c.scopeKey === "sA");
  const recB = recorded.find((c) => c.scopeKey === "sB");
  ok("A recorded under the reconciler's expected per-seller identity", recA && recA.sourceRequestHash === expectedHash("sA", "GB"));
  ok("B recorded under the reconciler's expected per-seller identity", recB && recB.sourceRequestHash === expectedHash("sB", "DE"));
  ok("A + B have DISTINCT identities (no cross-account collision) and land in source_snapshots(fba-inventory-health)", recA.sourceRequestHash !== recB.sourceRequestHash && recA.sourceKey === MODEL.FBA_INVENTORY_SOURCE_KEY && recB.sourceKey === MODEL.FBA_INVENTORY_SOURCE_KEY);
  ok("A isolated to ONLY its GB rows (the cross-warehouse DE row aX + foreign sX excluded -> no double-count)", recA.rowCount === 2);
  ok("B isolated to ONLY its DE row", recB.rowCount === 1);
  // The persisted identity is accepted by the reconciler's revision as an ELIGIBLE, D-1-proven snapshot.
  const revA = REV.computeFbaAccountRevision({ organizationFingerprint: recA.organizationFingerprint, connectionId: "primary", accountId: "sA", requestedAsOf: ASOF, snapshot: { source_request_hash: recA.sourceRequestHash, payload_sha: recA.payloadSha, row_count: recA.rowCount, validated_at: recA.validatedAt }, expectedRequestHash: expectedHash("sA", "GB") });
  ok("the reconciler ACCEPTS the persisted snapshot (eligible, AVAILABLE, content token bound) -- persist output == reconciler input", revA.eligible === true && revA.status === REV.FBA_REVISION_STATUS.AVAILABLE && revA.contentDeps[0].includes(recA.sourceRequestHash) && revA.contentDeps[0].includes(recA.payloadSha));
});

test("D-1 INVARIANT: the durable identity binds inventoryAsOf (D-1), NOT the sales asOf -- so the reconciler (recomputed at D-1) matches", async () => {
  // Production resolves these INDEPENDENTLY (sales asOf = OLI coverage; inventoryAsOf = FBA D-1) and they genuinely
  // differ. The durable identity + the plan's inventory window must bind inventoryAsOf; a regression binding asOf
  // would record a hash the reconciler (which recomputes at D-1) rejects as snapshot-not-d1 -> defer forever.
  const salesAsOf = "2026-09-20";
  const invAsOf = "2026-09-22";
  const { plan, cost } = await OP.planFbaBucketCost({ bucketAccounts: ACCOUNTS, connections: CONNECTIONS, asOf: salesAsOf, inventoryAsOf: invAsOf, getSourceExportCache: async () => null });
  const recorded = [];
  const r = await OP.advanceFbaPlanBucket({
    bucket: BUCKET, asOf: salesAsOf, inventoryAsOf: invAsOf, includedIds: ["sA", "sB"], bucketAccounts: ACCOUNTS,
    plan, cost, maxTokens: 80, runtime: terminalRuntime(), publisher: publisher(), controls: controls(), readbackLive: okReadback,
    persistDurableFbaSnapshots: persistWiring(new Map([[invHashOf(plan, "sA"), BATCH_ROWS]]), recorded),
  });
  ok("backstop ok (2 persisted) with asOf != inventoryAsOf", r.durableFba.ok === true && r.durableFba.persisted === 2);
  const recA = recorded.find((c) => c.scopeKey === "sA");
  const dOneHash = String(SBS.resolvedFbaSnapshot({ apiKey: "fixture-key", account: { rawSellerId: "sA", country: "GB" }, asOf: invAsOf, bucket: BUCKET }).requestHash);
  const salesHash = String(SBS.resolvedFbaSnapshot({ apiKey: "fixture-key", account: { rawSellerId: "sA", country: "GB" }, asOf: salesAsOf, bucket: BUCKET }).requestHash);
  ok("the D-1 and sales-asOf identities genuinely DIFFER (the invariant is testable, not vacuous)", dOneHash !== salesHash);
  ok("persisted under the D-1 (inventoryAsOf) identity -- the EXACT hash the reconciler recomputes", recA.sourceRequestHash === dOneHash);
  ok("NOT under the sales-asOf identity (a regression binding asOf would defer forever as snapshot-not-d1)", recA.sourceRequestHash !== salesHash);
  const snap = { source_request_hash: recA.sourceRequestHash, payload_sha: recA.payloadSha, row_count: recA.rowCount, validated_at: recA.validatedAt };
  const revD1 = REV.computeFbaAccountRevision({ organizationFingerprint: recA.organizationFingerprint, accountId: "sA", requestedAsOf: invAsOf, snapshot: snap, expectedRequestHash: dOneHash });
  const revSales = REV.computeFbaAccountRevision({ organizationFingerprint: recA.organizationFingerprint, accountId: "sA", requestedAsOf: salesAsOf, snapshot: snap, expectedRequestHash: salesHash });
  ok("reconciler ACCEPTS the persisted snapshot at D-1 (eligible)", revD1.eligible === true);
  ok("reconciler DEFERS it at the sales-asOf (snapshot-not-d1) -- confirms the identity is D-1-bound, never asOf-bound", revSales.eligible === false && revSales.reason === "snapshot-not-d1");
});

test("TERMINAL RESUME: a publish-only pass (cost=null) still persists from the rebuilt plan (buildFbaBucketPlan)", async () => {
  const plan = OP.buildFbaBucketPlan({ bucketAccounts: ACCOUNTS, connections: CONNECTIONS, asOf: ASOF, inventoryAsOf: ASOF });
  const invHash = invHashOf(plan, "sA");
  const recorded = [];
  const r = await OP.advanceFbaPlanBucket({
    bucket: BUCKET, asOf: ASOF, inventoryAsOf: ASOF, includedIds: ["sA", "sB"], bucketAccounts: ACCOUNTS,
    plan, cost: null, maxTokens: 80, runtime: terminalRuntime(), publisher: publisher(), controls: controls(), readbackLive: okReadback,
    persistDurableFbaSnapshots: persistWiring(new Map([[invHash, BATCH_ROWS]]), recorded),
  });
  ok("cost=null (no token gate) but the plan still drives a full persist", r.durableFba.ok === true && r.durableFba.persisted === 2 && recorded.length === 2);
  ok("buildFbaBucketPlan reproduces the SAME per-seller identities the reconciler expects", recorded.find((c) => c.scopeKey === "sA").sourceRequestHash === expectedHash("sA", "GB"));
});

test("CACHE MISS: no cached evidence -> reported needs-next-cycle (never fabricated), publication still completes", async () => {
  const { plan, cost } = await realPlanCost();
  const recorded = [];
  const r = await OP.advanceFbaPlanBucket({
    bucket: BUCKET, asOf: ASOF, inventoryAsOf: ASOF, includedIds: ["sA", "sB"], bucketAccounts: ACCOUNTS,
    plan, cost, maxTokens: 80, runtime: terminalRuntime(), publisher: publisher(), controls: controls(), readbackLive: okReadback,
    persistDurableFbaSnapshots: persistWiring(new Map(), recorded), // empty cache
  });
  ok("publication complete; backstop UNRESOLVED (incomplete-evidence)", r.phase === "complete" && r.durableFba.ok === false && r.durableFba.reason === "incomplete-evidence");
  ok("both accounts reported as needing the next natural cycle; nothing recorded (no fabrication)", r.durableFba.needsNextCycle.sort().join(",") === "sA,sB" && recorded.length === 0);
});

test("ZERO INCLUDED: all accounts blocked -> backstop expected 0, ok true (never a false failure)", async () => {
  const { plan, cost } = await realPlanCost();
  const r = await OP.advanceFbaPlanBucket({
    bucket: BUCKET, asOf: ASOF, inventoryAsOf: ASOF, includedIds: [], bucketAccounts: ACCOUNTS,
    plan, cost, maxTokens: 80, runtime: terminalRuntime(), publisher: publisher(), controls: controls(), readbackLive: okReadback,
    persistDurableFbaSnapshots: persistWiring(new Map([[invHashOf(plan, "sA"), BATCH_ROWS]])),
  });
  ok("no included accounts -> expected 0, ok true", r.durableFba.ok === true && r.durableFba.expected === 0 && r.durableFba.persisted === 0);
});

test("ONE-ACCOUNT FAILURE: a record-CAS throw for one account is isolated + typed; the other persists; publication completes", async () => {
  const { plan, cost } = await realPlanCost();
  const invHash = invHashOf(plan, "sA");
  const persist = async ({ reportRequests, includedIds, inventoryAsOf, bucket, accountsById }) =>
    PERSIST.persistDurableFbaSnapshotsFromPlan({
      reportRequests, includedIds, inventoryAsOf, bucket, accountsById, apiKey: "fixture-key", connectionId: "primary",
      loadSourceExportCache: async (h) => (h === invHash ? { rows: BATCH_ROWS } : null),
      saveSnapshotPayload: async (a) => ({ objectPath: "s/" + a.scopeKey, payloadSha: "sha", payloadBytes: 1 }),
      recordSnapshot: async (a) => { if (a.scopeKey === "sB") throw new Error("cas-boom"); return { write: "ok", ack: "replaced" }; },
    });
  const r = await OP.advanceFbaPlanBucket({
    bucket: BUCKET, asOf: ASOF, inventoryAsOf: ASOF, includedIds: ["sA", "sB"], bucketAccounts: ACCOUNTS,
    plan, cost, maxTokens: 80, runtime: terminalRuntime(), publisher: publisher(), controls: controls(), readbackLive: okReadback,
    persistDurableFbaSnapshots: persist,
  });
  ok("publication complete (backstop failure is non-fatal)", r.phase === "complete" && r.published === 2);
  ok("A persisted, B failed (isolated), backstop typed persist-failed", r.durableFba.persisted === 1 && r.durableFba.failed.length === 1 && r.durableFba.reason === "persist-failed");
});

test("WIRING: both the scheduled go-live AND the manual route pass `plan` (and the route builds it even when terminal)", async () => {
  const { readFileSync } = await import("node:fs");
  const cli = readFileSync(new URL("./release/fba-plan-golive.mjs", import.meta.url), "utf8");
  const route = readFileSync(new URL("../api/admin/sources.js", import.meta.url), "utf8");
  ok("the CLI destructures + passes the plan into advanceFbaPlanBucket", /const \{ bucketAccounts, plan, cost/.test(cli) && /includedIds, bucketAccounts, plan, cost, maxTokens/.test(cli));
  ok("the route builds the plan on EVERY pass (buildFbaBucketPlan when terminal) and passes it", /buildFbaBucketPlan\(/.test(route) && /includedIds, bucketAccounts, plan, cost, maxTokens/.test(route));
});

async function main() {
  writeSync(1, "fba-durable-backstop-integration\n");
  OP = await import("../lib/server/sync/fba-plan-operation.js");
  PERSIST = await import("../lib/server/sync/fba-durable-source-persist.js");
  SBS = await import("../lib/server/sync/source-bucket-sync.js");
  REV = await import("../lib/server/sync/fba-inventory-revision.js");
  MODEL = await import("../lib/server/sync/source-durable-model.js");
  let failures = 0;
  for (const t of tests) { try { await t.fn(); } catch (e) { failures += 1; writeSync(1, "FAIL  " + t.name + "\n" + String((e && e.stack) || e) + "\n"); } }
  writeSync(1, "\nfba-durable-backstop-integration: " + passed + " assertions passed" + (failures ? ", " + failures + " FAILED" : "") + "\n");
  if (failures) process.exitCode = 1;
}
main();
