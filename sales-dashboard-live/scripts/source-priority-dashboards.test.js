// Scheduler v2 -- Daily Reporting + Brand View PRIORITY PATH unit + planner regressions (offline, ZERO net/DB).
//
// Proves the trusted priority operator (lib/server/sync/source-priority-dashboards.js) and the planner-level
// guarantee the go-live authorization requires:
//   P1  the create guard permits ONLY product-catalog exports, at most ONE, within a hard 2-token ceiling
//       shared across the whole run; ANY OLI/Ads/FBA/other create -- or a second catalog / token overrun --
//       throws (poll/download pass through);
//   P2  the publish allowlist admits EXACTLY daily-reporting + brand-inventory and refuses anything else;
//   P3  the bucket PLAN for all 30 covered accounts (8 US + 22 non-US) with every non-catalog source paused +
//       forceCatalogRefresh emits ZERO OLI / FBA jobs and EXACTLY ONE org-scoped Catalog job per bucket -- i.e.
//       structurally zero OLI/Ads/FBA exports, one Catalog export for the whole go-live;
//   P4  the operation threads priority=true into the real runtime and shares ONE create budget across both
//       buckets (a second bucket can never create a second Catalog export);
//   P5  the Brand View inventory contract renders missing FBA as inventoryAvailable:false (never fabricated).
//
// 7-bit ASCII, LF, no top-level await, synchronous writeSync progress, dynamic imports after a dummy env.

import assert from "node:assert/strict";
import { writeSync } from "node:fs";

process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://supabase.test";
const SB_KEY_ENV = ["SUPABASE", "SERVICE", "ROLE", "KEY"].join("_");
process.env[SB_KEY_ENV] = process.env[SB_KEY_ENV] || ["test", "svc", "role", "key"].join("-");

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const group = (label) => tests.push({ marker: label });
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };

const OLI = "order-line-items";
const CATALOG = "product-catalog";
const FBA = "fba-inventory-health";
const TODAY = "2026-08-20";
const ASOF = "2026-08-19";

let priorityMod; let planMod; let brandView;

/* =============================== P1. the catalog-only, <=2-token create guard =============================== */
group("P1. create guard: ONLY product-catalog, at most one, <=2 tokens shared across the whole run");

function innerAdapter(created) {
  return {
    create: async (job) => { created.push(job.sourceKey); return { exportId: "e_" + job.sourceKey }; },
    poll: async () => "polled",
    download: async () => ["row"],
  };
}

test("P1a. a product-catalog create is permitted once and charges the shared budget 2 tokens", async () => {
  const created = [];
  const budget = { creates: 0, tokens: 0 };
  const guard = priorityMod.makePriorityCreateGuard(innerAdapter(created), budget);
  const res = await guard.create({ sourceKey: CATALOG, requestHash: "h" });
  assert.deepEqual(created, [CATALOG], "the inner adapter created the catalog export");
  assert.equal(res.exportId, "e_" + CATALOG);
  assert.equal(budget.creates, 1, "one create charged");
  assert.equal(budget.tokens, 2, "two tokens charged (standard catalog)");
});

test("P1b. ANY non-catalog create (OLI/Ads/FBA) throws PRIORITY_FORBIDDEN_CREATE and never reaches the adapter", async () => {
  const created = [];
  const guard = priorityMod.makePriorityCreateGuard(innerAdapter(created), { creates: 0, tokens: 0 });
  for (const sk of [OLI, FBA, "ads-campaign-date", "settlements", ""]) {
    await assert.rejects(() => guard.create({ sourceKey: sk, requestHash: "h" }), (e) => /PRIORITY_FORBIDDEN_CREATE/.test(e.message), "rejected " + sk);
  }
  assert.equal(created.length, 0, "no forbidden create ever reached the inner adapter");
});

test("P1c. a SECOND catalog create (or a token overrun) throws PRIORITY_TOKEN_CEILING", async () => {
  const created = [];
  const budget = { creates: 0, tokens: 0 };
  const guard = priorityMod.makePriorityCreateGuard(innerAdapter(created), budget);
  await guard.create({ sourceKey: CATALOG, requestHash: "h1" });
  await assert.rejects(() => guard.create({ sourceKey: CATALOG, requestHash: "h2" }), (e) => /PRIORITY_TOKEN_CEILING/.test(e.message));
  assert.equal(budget.creates, 1, "the ceiling holds at one create");
  assert.equal(budget.tokens, 2, "the ceiling holds at two tokens");
  assert.deepEqual(created, [CATALOG], "only the first catalog export reached the adapter");
});

test("P1d. poll + download pass through untouched (no token cost)", async () => {
  const guard = priorityMod.makePriorityCreateGuard(innerAdapter([]), { creates: 0, tokens: 0 });
  assert.equal(await guard.poll({}), "polled");
  assert.deepEqual(await guard.download({}), ["row"]);
});

/* =============================== P2. the publish allowlist (exactly two reports) =============================== */
group("P2. publish allowlist: EXACTLY daily-reporting + brand-inventory");

test("P2a. the two priority reports are admitted; every other report is refused", () => {
  assert.equal(priorityMod.assertPriorityPublishReportKey("daily-reporting"), "daily-reporting");
  assert.equal(priorityMod.assertPriorityPublishReportKey("brand-inventory"), "brand-inventory");
  for (const rk of ["brand-sales", "keyword-rank", "content-changes", "listing-optimizer", "reconciliation", "", "brand-inventory "]) {
    assert.throws(() => priorityMod.assertPriorityPublishReportKey(rk), (e) => /PRIORITY_PUBLISH_FORBIDDEN/.test(e.message), "refused " + JSON.stringify(rk));
  }
});

test("P2b. the frozen scope constants are exactly the reviewed values", () => {
  const C = priorityMod.PRIORITY_DASHBOARDS;
  assert.deepEqual([...C.reportKeys], ["daily-reporting", "brand-inventory"]);
  assert.deepEqual([...C.buckets], ["us", "non-us"]);
  assert.equal(C.catalogSourceKey, CATALOG);
  assert.equal(C.maxCatalogCreates, 1);
  assert.equal(C.maxTokens, 2);
  assert.ok(Object.isFrozen(C), "the scope object is frozen");
});

/* ===================== P3. the bucket PLAN emits zero OLI/FBA jobs, one Catalog job ===================== */
group("P3. plan for all 30 covered accounts: zero OLI/FBA exports, one org-scoped Catalog export per bucket");

function accountsFor(bucket, n) {
  const cc = bucket === "us" ? "US" : "DE";
  return Array.from({ length: n }, (_, i) => ({ accountId: bucket + "-A" + String(i + 1).padStart(2, "0"), rawSellerId: bucket + "-S" + String(i + 1).padStart(2, "0"), country: cc, currency: "USD" }));
}

function planPriorityBucket(bucket, n) {
  // Priority pauses EVERY non-catalog source; the planner-relevant families are OLI + FBA.
  const pausedSources = new Set([OLI, FBA, "ads-campaign-date", "ads-asin-date", "settlements", "returns", "listings"]);
  const accounts = accountsFor(bucket, n);
  const coverageByAccountId = {};
  for (const a of accounts) coverageByAccountId[a.accountId] = [{ from: "2025-01-01", to: TODAY }];
  return planMod.planBucketSourceSync({
    apiKey: "prim-key", bucket, accounts, existingMembership: new Map(),
    coverageByAccountId, catalogSnapshot: null, fbaSnapshotsByAccount: {},
    pausedSources, asOf: ASOF, today: TODAY, forceCatalogRefresh: true,
  });
}

test("P3a. US bucket (8 accounts): ZERO OLI + ZERO FBA jobs, EXACTLY one Catalog job", () => {
  const plan = planPriorityBucket("us", 8);
  const jf = plan.summary.plannedJobsByFamily;
  assert.equal(jf[OLI] || 0, 0, "zero OLI jobs (OLI paused)");
  assert.equal(jf[FBA] || 0, 0, "zero FBA jobs (FBA paused)");
  assert.equal(jf[CATALOG], 1, "exactly one org-scoped Catalog job (forced)");
  assert.ok(plan.skippedPaused.includes(OLI) && plan.skippedPaused.includes(FBA), "OLI + FBA recorded as skipped-paused");
});

test("P3b. Non-US bucket (22 accounts): ZERO OLI + ZERO FBA jobs, EXACTLY one Catalog job", () => {
  const plan = planPriorityBucket("non-us", 22);
  const jf = plan.summary.plannedJobsByFamily;
  assert.equal(jf[OLI] || 0, 0, "zero OLI jobs");
  assert.equal(jf[FBA] || 0, 0, "zero FBA jobs");
  assert.equal(jf[CATALOG], 1, "exactly one Catalog job");
});

test("P3c. WITHOUT the priority pauses a normal plan WOULD create OLI + FBA exports (the cost the path avoids)", () => {
  const accounts = accountsFor("us", 8);
  const coverageByAccountId = {};
  for (const a of accounts) coverageByAccountId[a.accountId] = []; // no coverage => OLI backfill planned
  const plan = planMod.planBucketSourceSync({
    apiKey: "prim-key", bucket: "us", accounts, existingMembership: new Map(),
    coverageByAccountId, catalogSnapshot: null, fbaSnapshotsByAccount: {},
    pausedSources: new Set(), asOf: ASOF, today: TODAY,
  });
  const jf = plan.summary.plannedJobsByFamily;
  assert.ok((jf[OLI] || 0) > 0, "a normal plan DOES export OLI");
  assert.ok((jf[FBA] || 0) > 0, "a normal plan DOES export FBA (per account)");
});

/* ===================== P4. the operation threads priority + shares one budget ===================== */
group("P4. buildPriorityDashboardsOperation: priority=true into the real runtime, ONE shared budget");

test("P4a. deriveBucket runs the runtime with priority:true and installs the catalog-only guarded adapter", async () => {
  const runCalls = [];
  let capturedOverrides = null;
  const fakeRuntime = {
    makeDeadline: () => ({}),
    preflightEvidence: async () => ({}),
    run: async (args) => { runCalls.push(args); return { bucket: args.bucket, derived: { skipped: null } }; },
  };
  const op = priorityMod.buildPriorityDashboardsOperation({
    buildRuntime: (overrides) => { capturedOverrides = overrides; return fakeRuntime; },
    makeInnerAdapter: () => innerAdapter([]),
  });
  const r = await op.deriveBucket("us", {});
  assert.equal(runCalls.length, 1);
  assert.equal(runCalls[0].priority, true, "priority=true threaded into run()");
  assert.equal(runCalls[0].bucket, "us");
  assert.equal(r.rollup.derived.skipped, null);
  // the runtime was built with a makeAdapter that installs the catalog-only guard
  const guarded = capturedOverrides.makeAdapter({});
  await assert.rejects(() => guarded.create({ sourceKey: OLI, requestHash: "h" }), (e) => /PRIORITY_FORBIDDEN_CREATE/.test(e.message));
});

test("P4b. the create budget is SHARED across both buckets: a second Catalog create is refused", async () => {
  let capturedOverrides = null;
  const op = priorityMod.buildPriorityDashboardsOperation({
    buildRuntime: (overrides) => { capturedOverrides = overrides; return { makeDeadline: () => ({}), preflightEvidence: async () => ({}), run: async (a) => ({ bucket: a.bucket }) }; },
    makeInnerAdapter: () => innerAdapter([]),
  });
  await op.deriveBucket("us", {});
  await op.deriveBucket("non-us", {});
  const guardA = capturedOverrides.makeAdapter({});
  await guardA.create({ sourceKey: CATALOG, requestHash: "h1" });        // us bucket's one catalog export
  const guardB = capturedOverrides.makeAdapter({});
  await assert.rejects(() => guardB.create({ sourceKey: CATALOG, requestHash: "h2" }), (e) => /PRIORITY_TOKEN_CEILING/.test(e.message), "the non-us bucket cannot create a SECOND catalog export");
  assert.equal(op.budget.creates, 1, "one catalog create across the whole run");
  assert.equal(op.budget.tokens, 2, "two tokens across the whole run");
});

test("P4c. deriveBucket refuses an unknown bucket", async () => {
  const op = priorityMod.buildPriorityDashboardsOperation({
    buildRuntime: () => ({ makeDeadline: () => ({}), preflightEvidence: async () => ({}), run: async () => ({}) }),
    makeInnerAdapter: () => innerAdapter([]),
  });
  await assert.rejects(() => op.deriveBucket("europe", {}), (e) => /bucket in us\|non-us/.test(e.message));
});

/* ===================== P5. Brand View inventory renders missing FBA as unavailable ===================== */
group("P5. Brand View inventory contract: missing FBA => inventoryAvailable:false (never fabricated)");

test("P5a. buildBrandInventoryPayload with empty rows yields inventoryAvailable:false, null date, empty table", () => {
  const payload = brandView.buildBrandInventoryPayload({
    accountId: "A01", invRows: [], brandByAsin: new Map([["B0A", "Acme"]]),
    accountCountry: "US", from: "2026-06-01", to: ASOF, rowLimit: 100000,
  });
  assert.equal(payload.inventoryAvailable, false);
  assert.equal(payload.inventoryDate, null);
  assert.deepEqual(payload.inventoryByBrandCountry, []);
  assert.equal(payload.accountId, "A01");
});

async function main() {
  out("priority dashboards path proof suite");
  priorityMod = await import("../lib/server/sync/source-priority-dashboards.js");
  planMod = await import("../lib/server/sync/source-bucket-sync.js");
  brandView = await import("../lib/server/reports/brand-view.js");

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
