// Phase 4B2 -- Listing Health v3 ingestion COMPOSITION (production wiring) integration test.
//
// De-risks the paid two-pass source wiring OFFLINE (fake store/adapter/runners; ZERO DataDoe/network): the frozen
// per-region create budget over listings + listings-raw ONLY, the ceiling fail-closed gate, the two runStagedSourceCycle
// passes (create then inventory REUSE-ONLY), the honest actual-create count, and the report-job wiring to the shadow
// saver + derived-context loader. Also proves the full operator dry-run over the real collaborators does ZERO source
// work. 7-bit ASCII, LF.

import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { buildListingHealthV3IngestionRelease, listingHealthV3CycleBucket } from "../lib/server/sync/listing-health-v3-ingestion-composition.js";
import { runListingHealthV3Ingestion } from "../lib/server/sync/listing-health-v3-operation.js";

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); passed += 1; writeSync(1, `  ok ${n}\n`); };
const throwsAsync = async (n, fn) => { let t = false; try { await fn(); } catch { t = true; } ok(n, t); };
writeSync(1, "report-listing-health-v3-ingestion\n");

const API_KEY = "fixture-key";
const connections = [{ id: "primary", apiKey: API_KEY, accountPrefix: "" }];
const cycleDate = "2026-09-05";
const IN8 = Array.from({ length: 8 }, (_, i) => ({ accountId: `in-${String(i).padStart(2, "0")}`, country: "IN", currency: "INR", name: `IN${i}` }));

// A fake runtime whose store records the budget + returns fabricated post-run job rows so runSources can count
// "actual creates" without any real I/O. runSourceCycle / runReportsFn / materializeFn are spies.
function makeFakeRelease({ ceiling = 4, jobsAfter = null, recentCycleIds = [], truncatedJobs = [] } = {}) {
  const calls = { openCycle: 0, persistBudget: [], sourceCycle: [], reports: 0, materialize: 0, saveSnapshot: 0 };
  const store = {
    openCycle: async ({ bucket }) => { calls.openCycle += 1; calls.lastCycleBucket = bucket; return "cyc-1"; },
    persistBudget: async (b) => { calls.persistBudget.push(b); return "created"; },
    reserveExportCreate: async () => "reserved",
    getCycleByBucketDate: async () => ({ id: "cyc-1", status: "running" }),
    loadSourceRows: async () => ({ rows: [] }),
    listSourceJobs: async () => jobsAfter || [],
  };
  const runtime = { store, dataDoe: {}, saveSnapshot: async () => { calls.saveSnapshot += 1; return { paramsHash: "ph" }; }, loadDerivedContext: async () => ({}) };
  const release = buildListingHealthV3IngestionRelease({
    operator: "laxmikant@superboring.in",
    makeRuntime: () => runtime,
    getConnections: () => connections,
    discoverAccountIds: async () => IN8.map((a) => a.accountId),
    readDirectoryAccounts: async () => IN8,
    getExportCache: async () => null, // nothing cached -> everything would be a create in the cost helper
    getTokenBalance: async () => ({ read: "ok", usable: 3288 }),
    budgetPlanner: { isPremiumOf: () => false, trancheBudgetMode: () => "frozen" }, // listings/raw are STANDARD
    runSourceCycle: async (args) => { calls.sourceCycle.push({ tranche: args.sourceTranche && args.sourceTranche.name, reuseOnly: args.reuseOnly, hasBudget: !!args.budget, cycleBucket: args.cycleBucket, bucket: args.bucket }); return { cycleId: "cyc-1", drained: true, succeeded: 2, failed: 0, skipped: 0 }; },
    runReportsFn: async (a) => { calls.reports += 1; calls.reportPlanned = (a.plannedReports || []).length; calls.hasSaver = typeof a.saveSnapshot === "function"; calls.hasDerived = typeof a.loadDerivedContext === "function"; return { succeeded: (a.plannedReports || []).length, drained: true }; },
    materializeFn: async (a) => { calls.materialize += 1; calls.materializePlans = (a.plans || []).length; return { accounts: 8, aliasesWritten: 16, emptyAliases: 0, rejected: 0, batchMissing: 0, skippedStale: 0 }; },
    regionCeilings: { india: ceiling, "europe-au": 8, "us-ca": 4 },
    // Injected offline evidence readers for the inventory-only overflow derivation (default: no evidence => no split).
    getRecentCycleIds: async () => recentCycleIds,
    getSourceJobsWithMeta: async () => truncatedJobs,
  });
  return { release, calls };
}

/* ===================== A. two-pass source wiring: create then inventory reuse-only ===================== */
await (async () => {
  const NEW = ["lhv3:listings", "lhv3:raw"]; // batch hashes with create_export_count>0 filled below
  const plan = await makeFakeRelease().release.buildPlan({ accounts: IN8, connections, cycleDate, region: "india" });
  const v3 = plan.reportRequests.filter((r) => r.reportKey === "listing-health-v3");
  const newHashes = [...new Set(v3.flatMap((r) => r.sources.filter((s) => s.requestKey !== "listing-health-v3:inventory").map((s) => s.requestHash)))];
  const invHashes = [...new Set(v3.flatMap((r) => r.sources.filter((s) => s.requestKey === "listing-health-v3:inventory").map((s) => s.requestHash)))];
  ok("A: an 8-account India plan yields exactly 4 new-export batch hashes (2 listings + 2 listings-raw)", newHashes.length === 4);
  ok("A: inventory is a distinct reused hash set (2 batches), never in the new-export set", invHashes.length === 2 && !newHashes.some((h) => invHashes.includes(h)));

  // Fabricate post-run jobs: the 4 new hashes created (create_export_count=1), inventory adopted (0).
  const jobsAfter = [
    ...newHashes.map((h) => ({ request_hash: h, source_key: h.includes("raw") ? "listings-raw" : "listings", create_export_count: 1 })),
    ...invHashes.map((h) => ({ request_hash: h, source_key: "fba-inventory-health", create_export_count: 0 })),
  ];
  const { release, calls } = makeFakeRelease({ ceiling: 4, jobsAfter });
  const res = await release.runSources({ plan, region: "india", cycleDate });
  ok("A: runSources opened the DEDICATED namespaced cycle (listing-health-v3-india)", calls.lastCycleBucket === listingHealthV3CycleBucket("india"));
  ok("A: it froze + persisted the create budget once, with maxCreates=4 (listings+raw only)", calls.persistBudget.length === 1 && calls.persistBudget[0].maxCreates === 4);
  ok("A: it ran TWO source passes", calls.sourceCycle.length === 2);
  ok("A: pass 1 = the NEW tranche, create mode, WITH the frozen budget", calls.sourceCycle[0].reuseOnly === false && calls.sourceCycle[0].hasBudget === true && /lhv3-new/.test(calls.sourceCycle[0].tranche));
  ok("A: pass 2 = the INVENTORY tranche, REUSE-ONLY, NO budget (never creates)", calls.sourceCycle[1].reuseOnly === true && calls.sourceCycle[1].hasBudget === false && /lhv3-inv/.test(calls.sourceCycle[1].tranche));
  ok("A: both passes scope the account bucket to the real region (india), not the namespaced cycle key", calls.sourceCycle.every((c) => c.bucket === "india" && c.cycleBucket === "listing-health-v3-india"));
  ok("A: actual creates counted honestly = 4; inventory never created", res.creates === 4 && res.inventoryCreated === false && res.maxCreates === 4);
  ok("A: observed token estimate = 4 creates x 2 (an estimate, not a guaranteed max)", res.tokens === 8);
})();

/* ===================== B. ceiling fail-closed BEFORE any pass ===================== */
await (async () => {
  const plan = await makeFakeRelease().release.buildPlan({ accounts: IN8, connections, cycleDate, region: "india" });
  const { release, calls } = makeFakeRelease({ ceiling: 1 }); // artificially below the 4 planned creates
  await throwsAsync("B: a frozen create count above the region ceiling throws BEFORE any source pass", () => release.runSources({ plan, region: "india", cycleDate }));
  ok("B: no source pass ran when the ceiling gate failed", calls.sourceCycle.length === 0);
})();

/* ===================== C. report wiring -> shadow saver + derived-context loader ===================== */
await (async () => {
  const plan = await makeFakeRelease().release.buildPlan({ accounts: IN8, connections, cycleDate, region: "india" });
  const { release, calls } = makeFakeRelease({ ceiling: 4 });
  const rep = await release.runReports({ plan, region: "india", cycleDate });
  ok("C: runReports derives ONLY the v3 report requests (8 accounts) through the report worker", calls.reports === 1 && calls.reportPlanned === 8);
  ok("C: it passes the shadow snapshot saver + the derived-context loader", calls.hasSaver === true && calls.hasDerived === true);
  ok("C: it returns the succeeded count", rep.succeeded === 8);
})();

/* ===================== D. the full operator over the real collaborators: dry-run does ZERO source work ===================== */
await (async () => {
  const { release, calls } = makeFakeRelease({ ceiling: 4 });
  const ev = await runListingHealthV3Ingestion({
    region: "india", cycleDate, mode: "dry-run",
    authorized: true, gate: { enabled: false }, connections,
    discoverAccounts: release.discoverAccounts, buildPlan: release.buildPlan, resolveCost: release.resolveCost,
    checkBalance: release.checkBalance, runSources: release.runSources, materialize: release.materialize, runReports: release.runReports,
    reservationSupported: release.reservationSupported, pricingKnown: release.pricingKnown,
  });
  ok("D: dry-run over the real composition succeeds (planned) with the gate disabled", ev.ok === true && ev.phase === "planned");
  ok("D: dry-run discovered exactly 8 India accounts", ev.accounts === 8);
  ok("D: dry-run ran NO source/report/materialize work", calls.sourceCycle.length === 0 && calls.reports === 0 && calls.materialize === 0);
  ok("D: the release reports reservation support + known pricing", release.reservationSupported === true && release.pricingKnown === true);
})();

/* ===================== E. INVENTORY-ONLY overflow split from terminal-TRUNCATED evidence ===================== */
await (async () => {
  // Default (no evidence): inventory batched [5,3].
  const basePlan = await makeFakeRelease().release.buildPlan({ accounts: IN8, connections, cycleDate, region: "india" });
  const invOf = (plan) => [...new Map(plan.reportRequests.flatMap((r) => r.sources.filter((s) => s.requestKey === "listing-health-v3:inventory").map((s) => [s.requestHash, s]))).values()];
  const newHashesOf = (plan) => [...new Set(plan.reportRequests.flatMap((r) => r.sources.filter((s) => s.requestKey !== "listing-health-v3:inventory").map((s) => s.requestHash)))];
  const baseInv = invOf(basePlan);
  ok("E: default inventory batching is [5,3]", baseInv.map((s) => s.sellerOrVendorIds.length).sort().join(",") === "3,5");
  const threeBatch = baseInv.find((s) => s.sellerOrVendorIds.length === 3);
  const fiveBatchHash = baseInv.find((s) => s.sellerOrVendorIds.length === 5).requestHash;

  // Terminal TRUNCATED evidence for that 3-seller inventory batch => its 3 sellers become proven overflow.
  const truncatedJobs = [{ request_hash: threeBatch.requestHash, source_key: "fba-inventory-health", fetch_status: "failed", error_code: "TRUNCATED", terminal: true }];
  const splitPlan = await makeFakeRelease({ recentCycleIds: ["cyc-x"], truncatedJobs }).release.buildPlan({ accounts: IN8, connections, cycleDate, region: "india" });
  const inv = invOf(splitPlan);
  ok("E: with overflow evidence, INVENTORY splits to [5,1,1,1] (the whale batch isolated to single sellers)", inv.map((s) => s.sellerOrVendorIds.length).sort().join(",") === "1,1,1,5");
  ok("E: the 5-seller inventory batch hash is unchanged (byte-identical to default)", inv.some((s) => s.requestHash === fiveBatchHash));
  ok("E: Listings + Listings-Raw STAY batched [5,3] => still exactly 4 new-export hashes (create budget unchanged)", newHashesOf(splitPlan).length === 4);
  ok("E: the new-export (listings/raw) hash set is IDENTICAL with and without the inventory overflow split", JSON.stringify(newHashesOf(basePlan).sort()) === JSON.stringify(newHashesOf(splitPlan).sort()));
})();

writeSync(1, `\nreport-listing-health-v3-ingestion: ${passed} assertions passed\n`);
