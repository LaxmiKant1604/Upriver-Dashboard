// PRODUCTION-SHAPED integration test for the FBA zero-export durable backstop -- proves the REAL {plan, cost} caller
// contract end-to-end, NOT a fabricated cost.plan or a source-text "collaborator was wired" grep.
//
// Since the Listings inventory cutover the fba job's ONLY owned export is the canonical Listings (fba-plan:awd; FBA
// Inventory Health is retired), and the backstop lands the account's SAVED LISTINGS pointer (source_listings_snapshot).
// It builds the plan with the REAL planFbaBucketCost (over fixture DataDoe connections + accounts), drives the REAL
// advanceFbaPlanBucket with the plan passed separately from the token cost, runs the REAL
// persistDurableListingsSnapshotsFromPlan against a fixture source-export cache, and proves that:
//   - the token `cost` has NO `.plan` (exactly why the historical `cost.plan` read silently persisted nothing);
//   - the plan carries ONLY the canonical Listings source (no fba-plan:inventory-health anywhere);
//   - the persist LOADS the cache under the plan's (date-free) Listings batch request hash;
//   - each account's rows are ISOLATED to its seller + marketplace (a cross-warehouse EU row is never double-counted);
//   - the pointer is recorded with as_of = inventoryAsOf (never the sales asOf), validated_at = the batch fetched_at,
//     source_request_hash = the batch hash -- and computeFbaAccountRevision then accepts it as ELIGIBLE;
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

let OP, PERSIST, REV;

// Fixture DataDoe connection: a single PRIMARY connection. For a primary account the public id IS the raw seller id
// (resolveDataDoeAccountIds maps 1:1), so accountId "sA"/"sB" resolve to rawSellerId "sA"/"sB".
const CONNECTIONS = [{ id: "primary", apiKey: "fixture-key" }];
const ACCOUNTS = [
  { accountId: "sA", country: "GB", currency: "GBP", name: "Alpha" },
  { accountId: "sB", country: "DE", currency: "EUR", name: "Beta" },
];
const ASOF = "2026-09-22";
const BUCKET = "europe-au";
const FETCHED_AT = "2026-09-23T03:41:00.000Z"; // the Listings batch fetch time (the pointer's validated_at)

// An EXPANDED (post-cutover) canonical Listings row.
const listingsRow = (seller, mkt, sku, available) => ({
  seller_or_vendor_id: seller, marketplace_country_code: mkt, sku, child_asin: "B0" + sku.toUpperCase(),
  listing_fulfillment_channel: "AMAZON_EU",
  fba_quantity_available: available, fba_quantity_inbound: 0, fba_quantity_reserved: 0, fba_quantity_fc_transfer: 0,
  awd_available_distributable_quantity: null, awd_total_inbound_quantity: null,
});
// A shared EU batch payload: sA has 2 GB rows + 1 cross-warehouse DE row (must NOT attribute to the GB account),
// sB has 1 DE row, and a FOREIGN seller sX (excluded from both).
const BATCH_ROWS = [
  listingsRow("sA", "GB", "a1", 10),
  listingsRow("sA", "GB", "a2", 5),
  listingsRow("sA", "DE", "aX", 99),
  listingsRow("sB", "DE", "b1", 7),
  listingsRow("sX", "GB", "x1", 1),
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

// The REAL persist wired exactly as the release seam wires it (fba-plan-release-composition.js persistDurableFbaSnapshots),
// over a fixture cache + recorder. The cache entry carries the batch's fetched_at like getSourceExportCache does.
function persistWiring(cache, recorded = [], saves = []) {
  return async ({ reportRequests, includedIds, inventoryAsOf, outOfTime, log }) =>
    PERSIST.persistDurableListingsSnapshotsFromPlan({
      reportRequests, includedIds, inventoryAsOf, connectionId: "primary", outOfTime, log,
      loadSourceExportCache: async (h) => (cache.has(h) ? { rows: cache.get(h), fetched_at: FETCHED_AT } : null),
      saveSnapshotPayload: async (a) => { saves.push(a); const sha = "sha-" + a.scopeKey + "-" + a.rows.length; return { objectPath: "source-snapshots/" + a.sourceKey + "/" + a.scopeKey + "/" + sha + ".json", payloadSha: sha, payloadBytes: JSON.stringify(a.rows).length }; },
      recordListingsSnapshot: async (a) => { recorded.push(a); return { write: "ok", ack: "replaced" }; },
    });
}
const pointerOf = (rec) => ({ as_of: rec.asOf, source_request_hash: rec.sourceRequestHash, payload_sha: rec.payloadSha, row_count: rec.rowCount, validated_at: rec.validatedAt, object_path: rec.objectPath });

async function realPlanCost(asOf = ASOF, inventoryAsOf = ASOF) {
  return OP.planFbaBucketCost({ bucketAccounts: ACCOUNTS, connections: CONNECTIONS, asOf, inventoryAsOf, getSourceExportCache: async () => null });
}
const listingsHashOf = (plan, accountId) => {
  const req = plan.reportRequests.find((r) => r.accountId === accountId);
  const s = (req.sources || []).find((x) => x.requestKey === "fba-plan:awd");
  return s && s.requestHash;
};

test("REAL contract: planFbaBucketCost returns {plan, cost} where cost has NO .plan, and the plan carries ONLY the canonical Listings source", async () => {
  const { plan, cost } = await realPlanCost();
  ok("cost carries the token fields only", typeof cost.creates === "number" && typeof cost.tokens === "number" && typeof cost.byFamily === "object");
  ok("cost has NO .plan (so the old advanceFbaPlanBucket read undefined -> empty reportRequests)", cost.plan === undefined);
  ok("the PLAN carries a per-account report request for every account", plan.reportRequests.length === 2 && plan.reportRequests.every((r) => r.accountId && r.owner && r.owner.rawSellerId));
  ok("each report request carries an fba-plan:awd (canonical Listings) source with a request hash", plan.reportRequests.every((r) => (r.sources || []).some((s) => s.requestKey === "fba-plan:awd" && s.requestHash)));
  ok("NO report request carries a retired fba-plan:inventory-health source", plan.reportRequests.every((r) => !(r.sources || []).some((s) => /inventory-health/.test(String(s.requestKey)))));
  ok("ONE shared Listings batch job for the bucket (one paid export per <=5-seller batch)", plan.sourceJobs.length === 1 && cost.creates === 1);
});

test("END-TO-END: the real plan drives the persist -> cache loaded by the plan's batch hash -> per-account isolation -> saved Listings pointer the reconciler accepts", async () => {
  const { plan, cost } = await realPlanCost();
  const hash = listingsHashOf(plan, "sA");
  ok("sA and sB share one EU Listings batch hash (packed together)", hash && hash === listingsHashOf(plan, "sB"));
  const cache = new Map([[hash, BATCH_ROWS]]);
  const recorded = [], saves = [];
  const r = await OP.advanceFbaPlanBucket({
    bucket: BUCKET, asOf: ASOF, inventoryAsOf: ASOF, includedIds: ["sA", "sB"], bucketAccounts: ACCOUNTS,
    plan, cost, maxTokens: 80, runtime: terminalRuntime(), publisher: publisher(), controls: controls(), readbackLive: okReadback,
    persistDurableFbaSnapshots: persistWiring(cache, recorded, saves),
  });
  ok("publication complete + backstop ok", r.phase === "complete" && r.durableFba && r.durableFba.ok === true && r.durableFba.persisted === 2);
  const recA = recorded.find((c) => c.accountId === "sA");
  const recB = recorded.find((c) => c.accountId === "sB");
  ok("A + B pointers carry the batch request hash (date-free, shared with listing-health-v3)", recA && recB && recA.sourceRequestHash === hash && recB.sourceRequestHash === hash);
  ok("as_of = inventoryAsOf and validated_at = the batch fetched_at", recA.asOf === ASOF && recB.asOf === ASOF && recA.validatedAt === FETCHED_AT && recB.validatedAt === FETCHED_AT);
  ok("each pointer carries the owner's immutable marketplace", recA.marketplace === "GB" && recB.marketplace === "DE");
  ok("payloads saved under sourceKey 'listings' (never fba-inventory-health)", saves.length === 2 && saves.every((s) => s.sourceKey === "listings"));
  ok("A isolated to ONLY its GB rows (the cross-warehouse DE row aX + foreign sX excluded -> no double-count)", recA.rowCount === 2 && saves.find((s) => s.scopeKey === "sA").rows.every((x) => x.seller_or_vendor_id === "sA" && x.marketplace_country_code === "GB"));
  ok("B isolated to ONLY its DE row", recB.rowCount === 1);
  const revA = REV.computeFbaAccountRevision({ organizationFingerprint: recA.organizationFingerprint, connectionId: "primary", accountId: "sA", requestedAsOf: ASOF, snapshot: pointerOf(recA) });
  ok("the reconciler ACCEPTS the persisted pointer (eligible, AVAILABLE, 'listings|...' content token) -- persist output == reconciler input",
    revA.eligible === true && revA.status === REV.FBA_REVISION_STATUS.AVAILABLE && revA.contentDeps[0] === ["listings", "sA", "primary", hash, recA.payloadSha].join("|"));
});

test("AS-OF INVARIANT: the pointer's as_of binds inventoryAsOf, NOT the sales asOf -- so the reconciler (requested at inventoryAsOf) accepts it", async () => {
  // Production resolves these INDEPENDENTLY (sales asOf = OLI coverage; inventoryAsOf = the inventory day) and they
  // genuinely differ. The Listings request hash is date-free, so the as_of is the ONLY day evidence: a regression
  // recording asOf would defer forever (listings-snapshot-not-requested-day).
  const salesAsOf = "2026-09-20";
  const invAsOf = "2026-09-22";
  const { plan, cost } = await realPlanCost(salesAsOf, invAsOf);
  const { plan: planSameDay } = await realPlanCost(invAsOf, invAsOf);
  ok("the Listings batch hash is DATE-FREE (identical whatever the as-of)", listingsHashOf(plan, "sA") === listingsHashOf(planSameDay, "sA"));
  const recorded = [];
  const r = await OP.advanceFbaPlanBucket({
    bucket: BUCKET, asOf: salesAsOf, inventoryAsOf: invAsOf, includedIds: ["sA", "sB"], bucketAccounts: ACCOUNTS,
    plan, cost, maxTokens: 80, runtime: terminalRuntime(), publisher: publisher(), controls: controls(), readbackLive: okReadback,
    persistDurableFbaSnapshots: persistWiring(new Map([[listingsHashOf(plan, "sA"), BATCH_ROWS]]), recorded),
  });
  ok("backstop ok (2 persisted) with asOf != inventoryAsOf", r.durableFba.ok === true && r.durableFba.persisted === 2);
  const recA = recorded.find((c) => c.accountId === "sA");
  ok("persisted with as_of = inventoryAsOf (2026-09-22)", recA.asOf === invAsOf);
  ok("NOT the sales asOf (2026-09-20)", recA.asOf !== salesAsOf);
  const revInv = REV.computeFbaAccountRevision({ organizationFingerprint: recA.organizationFingerprint, accountId: "sA", requestedAsOf: invAsOf, snapshot: pointerOf(recA) });
  const revSales = REV.computeFbaAccountRevision({ organizationFingerprint: recA.organizationFingerprint, accountId: "sA", requestedAsOf: salesAsOf, snapshot: pointerOf(recA) });
  ok("reconciler ACCEPTS the persisted pointer at inventoryAsOf (eligible)", revInv.eligible === true);
  ok("reconciler DEFERS it at the sales asOf (listings-snapshot-not-requested-day) -- the as_of is inventoryAsOf-bound", revSales.eligible === false && revSales.reason === "listings-snapshot-not-requested-day");
});

test("TERMINAL RESUME: a publish-only pass (cost=null) still persists from the rebuilt plan (buildFbaBucketPlan)", async () => {
  const plan = OP.buildFbaBucketPlan({ bucketAccounts: ACCOUNTS, connections: CONNECTIONS, asOf: ASOF, inventoryAsOf: ASOF });
  const hash = listingsHashOf(plan, "sA");
  const { plan: costPlan } = await realPlanCost();
  const recorded = [];
  const r = await OP.advanceFbaPlanBucket({
    bucket: BUCKET, asOf: ASOF, inventoryAsOf: ASOF, includedIds: ["sA", "sB"], bucketAccounts: ACCOUNTS,
    plan, cost: null, maxTokens: 80, runtime: terminalRuntime(), publisher: publisher(), controls: controls(), readbackLive: okReadback,
    persistDurableFbaSnapshots: persistWiring(new Map([[hash, BATCH_ROWS]]), recorded),
  });
  ok("cost=null (no token gate) but the plan still drives a full persist", r.durableFba.ok === true && r.durableFba.persisted === 2 && recorded.length === 2);
  ok("buildFbaBucketPlan reproduces the SAME Listings batch hash as the cost plan", hash === listingsHashOf(costPlan, "sA") && recorded.every((c) => c.sourceRequestHash === hash));
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

test("PRE-CUTOVER PAYLOAD: a cached 15-column Listings batch is never persisted (skipped listings-not-expanded); publication completes", async () => {
  const { plan, cost } = await realPlanCost();
  const old = BATCH_ROWS.map(({ fba_quantity_inbound, fba_quantity_reserved, fba_quantity_fc_transfer, ...rest }) => rest);
  const recorded = [];
  const r = await OP.advanceFbaPlanBucket({
    bucket: BUCKET, asOf: ASOF, inventoryAsOf: ASOF, includedIds: ["sA", "sB"], bucketAccounts: ACCOUNTS,
    plan, cost, maxTokens: 80, runtime: terminalRuntime(), publisher: publisher(), controls: controls(), readbackLive: okReadback,
    persistDurableFbaSnapshots: persistWiring(new Map([[listingsHashOf(plan, "sA"), old]]), recorded),
  });
  ok("publication complete; backstop UNRESOLVED (incomplete-evidence); zero pointers recorded", r.phase === "complete" && r.durableFba.ok === false && r.durableFba.reason === "incomplete-evidence" && recorded.length === 0);
  ok("both accounts skipped listings-not-expanded (LKG pointer preserved)", r.durableFba.skipped.filter((s) => s.reason === "listings-not-expanded").length === 2);
});

test("ZERO INCLUDED: all accounts blocked -> backstop expected 0, ok true (never a false failure)", async () => {
  const { plan, cost } = await realPlanCost();
  const r = await OP.advanceFbaPlanBucket({
    bucket: BUCKET, asOf: ASOF, inventoryAsOf: ASOF, includedIds: [], bucketAccounts: ACCOUNTS,
    plan, cost, maxTokens: 80, runtime: terminalRuntime(), publisher: publisher(), controls: controls(), readbackLive: okReadback,
    persistDurableFbaSnapshots: persistWiring(new Map([[listingsHashOf(plan, "sA"), BATCH_ROWS]])),
  });
  ok("no included accounts -> expected 0, ok true", r.durableFba.ok === true && r.durableFba.expected === 0 && r.durableFba.persisted === 0);
});

test("ONE-ACCOUNT FAILURE: a record-CAS throw for one account is isolated + typed; the other persists; publication completes", async () => {
  const { plan, cost } = await realPlanCost();
  const hash = listingsHashOf(plan, "sA");
  const persist = async ({ reportRequests, includedIds, inventoryAsOf }) =>
    PERSIST.persistDurableListingsSnapshotsFromPlan({
      reportRequests, includedIds, inventoryAsOf, connectionId: "primary",
      loadSourceExportCache: async (h) => (h === hash ? { rows: BATCH_ROWS, fetched_at: FETCHED_AT } : null),
      saveSnapshotPayload: async (a) => ({ objectPath: "s/" + a.scopeKey + "/sha.json", payloadSha: "sha", payloadBytes: 1 }),
      recordListingsSnapshot: async (a) => { if (a.accountId === "sB") throw new Error("cas-boom"); return { write: "ok", ack: "replaced" }; },
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
  REV = await import("../lib/server/sync/fba-inventory-revision.js");
  let failures = 0;
  for (const t of tests) { try { await t.fn(); } catch (e) { failures += 1; writeSync(1, "FAIL  " + t.name + "\n" + String((e && e.stack) || e) + "\n"); } }
  writeSync(1, "\nfba-durable-backstop-integration: " + passed + " assertions passed" + (failures ? ", " + failures + " FAILED" : "") + "\n");
  if (failures) process.exitCode = 1;
}
main();
