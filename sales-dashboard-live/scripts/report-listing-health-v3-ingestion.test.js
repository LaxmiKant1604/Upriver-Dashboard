// Phase 4B2 -- Listing Health v3 ingestion COMPOSITION (production wiring) integration test.
import { computeListingHealthV3AuthorizationBinding, readListingHealthV3Authorization, LISTING_HEALTH_V3_PRICING_REVISION } from "../lib/server/sync/listing-health-v3-authorization.js";
//
// De-risks the paid source wiring OFFLINE (fake store/adapter/runners; ZERO DataDoe/network): the frozen per-region
// create budget over listings + listings-raw ONLY, the ceiling fail-closed gate, the ONE runStagedSourceCycle pass (FBA
// Inventory Health is retired -- no inventory reuse pass, no overflow/readiness evidence reads), the honest
// actual-create count + the unplanned-create guard, and the report-job wiring to the shadow saver + derived-context
// loader. Also proves the full operator dry-run over the real collaborators does ZERO source work. 7-bit ASCII, LF.

import assert from "node:assert/strict";
import { writeSync, readFileSync } from "node:fs";
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
function makeFakeRelease({ ceiling = 4, jobsAfter = null } = {}) {
  const evidenceReads = { cycles: 0, jobs: 0, owners: 0 };
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
    runSourceCycle: async (args) => { calls.sourceCycle.push({ tranche: args.sourceTranche && args.sourceTranche.name, reuseOnly: args.reuseOnly, completeUnavailableOnMissingReuse: !!args.completeUnavailableOnMissingReuse, hasBudget: !!args.budget, cycleBucket: args.cycleBucket, bucket: args.bucket }); return { cycleId: "cyc-1", drained: true, succeeded: 2, failed: 0, skipped: 0 }; },
    runReportsFn: async (a) => { calls.reports += 1; calls.reportPlanned = (a.plannedReports || []).length; calls.hasSaver = typeof a.saveSnapshot === "function"; calls.hasDerived = typeof a.loadDerivedContext === "function"; return { succeeded: (a.plannedReports || []).length, drained: true }; },
    materializeFn: async (a) => { calls.materialize += 1; calls.materializePlans = (a.plans || []).length; return { accounts: 8, aliasesWritten: 16, emptyAliases: 0, rejected: 0, batchMissing: 0, skippedStale: 0 }; },
    regionCeilings: { india: ceiling, "europe-au": 8, "us-ca": 4 },
    // RETIRED overflow / readiness evidence readers (FBA Inventory Health). A stale caller may still pass them; the
    // composition must never call them (planning is pure -- no durable reads).
    getRecentCycleIds: async () => { evidenceReads.cycles += 1; return ["cyc-x"]; },
    getSourceJobsWithMeta: async () => { evidenceReads.jobs += 1; return []; },
    getSourceJobOwners: async () => { evidenceReads.owners += 1; return []; },
  });
  return { release, calls, evidenceReads };
}

/* ===================== A. ONE source pass: listings + listings-raw only (no inventory pass) ===================== */
await (async () => {
  const fake0 = makeFakeRelease();
  const plan = await fake0.release.buildPlan({ accounts: IN8, connections, cycleDate, region: "india" });
  const v3 = plan.reportRequests.filter((r) => r.reportKey === "listing-health-v3");
  const keys = new Set(v3.flatMap((r) => r.sources.map((s) => s.requestKey)));
  const newHashes = [...new Set(v3.flatMap((r) => r.sources.map((s) => s.requestHash)))];
  ok("A: the plan carries ONLY listings + listings-raw (no inventory source)", [...keys].sort().join(",") === "listing-health-v3:listings,listing-health-v3:listings-raw");
  ok("A: an 8-account India plan yields exactly 4 new-export batch hashes (2 listings + 2 listings-raw)", newHashes.length === 4);
  ok("A: planning made ZERO durable evidence reads (no overflow / readiness / Health evidence)", fake0.evidenceReads.cycles === 0 && fake0.evidenceReads.jobs === 0 && fake0.evidenceReads.owners === 0);

  // Fabricate post-run jobs: the 4 new hashes created (create_export_count=1).
  const jobsAfter = newHashes.map((h, i) => ({ request_hash: h, source_key: i % 2 ? "listings-raw" : "listings", create_export_count: 1 }));
  const { release, calls } = makeFakeRelease({ ceiling: 4, jobsAfter });
  const res = await release.runSources({ plan, region: "india", cycleDate, authorizationBinding: bindFor(release, plan, "india") });
  ok("A: runSources opened the DEDICATED namespaced cycle (listing-health-v3-india)", calls.lastCycleBucket === listingHealthV3CycleBucket("india"));
  ok("A: it froze + persisted the create budget once, with maxCreates=4 (listings+raw only)", calls.persistBudget.length === 1 && calls.persistBudget[0].maxCreates === 4);
  ok("A: it ran exactly ONE source pass (no inventory reuse pass)", calls.sourceCycle.length === 1);
  ok("A: the pass = the NEW tranche, create mode, WITH the frozen budget, fail-closed on a missing source", calls.sourceCycle[0].reuseOnly === false && calls.sourceCycle[0].hasBudget === true && /lhv3-new/.test(calls.sourceCycle[0].tranche) && calls.sourceCycle[0].completeUnavailableOnMissingReuse === false);
  ok("A: the pass scopes the account bucket to the real region (india), not the namespaced cycle key", calls.sourceCycle.every((c) => c.bucket === "india" && c.cycleBucket === "listing-health-v3-india"));
  ok("A: actual creates counted honestly = 4; nothing unplanned created", res.creates === 4 && res.unplannedCreated === false && res.maxCreates === 4 && res.inventoryCreated === false && res.inventoryPass.retired === true);
  ok("A: observed token estimate = 4 creates x 2 (an estimate, not a guaranteed max)", res.tokens === 8);
  // A created job of ANY other source family (e.g. the retired FBA Inventory Health) is surfaced for the operator to fail closed.
  const bad = makeFakeRelease({ ceiling: 4, jobsAfter: [...jobsAfter, { request_hash: "h-health", source_key: "fba-inventory-health", create_export_count: 1 }] });
  const resBad = await bad.release.runSources({ plan, region: "india", cycleDate, authorizationBinding: bindFor(bad.release, plan, "india") });
  ok("A: a created non-Listings job -> unplannedCreated:true (the operator fails closed on it); creates still counts only the frozen hashes", resBad.unplannedCreated === true && resBad.inventoryCreated === true && resBad.creates === 4);
  // A pre-existing (adopted, zero-create) job of another family is NOT a violation.
  const adopted = makeFakeRelease({ ceiling: 4, jobsAfter: [...jobsAfter, { request_hash: "h-old", source_key: "fba-inventory-health", create_export_count: 0 }] });
  const resAdopted = await adopted.release.runSources({ plan, region: "india", cycleDate, authorizationBinding: bindFor(adopted.release, plan, "india") });
  ok("A: a zero-create job of another family is not counted as a create", resAdopted.unplannedCreated === false);
})();

/* ===================== B. P1: obsolete fixed 4/8/4 removed; authorization = frozen budget + structural drift guard ===================== */
await (async () => {
  const plan = await makeFakeRelease().release.buildPlan({ accounts: IN8, connections, cycleDate, region: "india" });
  // The obsolete fixed regional ceiling is REMOVED: a low legacy `ceiling` no longer hard-fails a VALID plan.
  // The authorization is the frozen tranche budget's maxCreates (= the exact structural count) + the atomic
  // pre-POST reservation (never a fixed 4/8/4 assumption). An 8-account plan freezes maxCreates=4 and proceeds.
  const { release, calls } = makeFakeRelease({ ceiling: 1 }); // legacy ceiling param is now ignored
  await release.runSources({ plan, region: "india", cycleDate, authorizationBinding: bindFor(release, plan, "india") });
  let missingBinding = null; try { await release.runSources({ plan, region: "india", cycleDate }); } catch (e) { missingBinding = e; }
  ok("B(binding): runSources REFUSES without the exact authorization binding (AUTHORIZATION_BINDING_MISSING); nothing new persisted", /AUTHORIZATION_BINDING_MISSING/.test(String(missingBinding && missingBinding.message)) && calls.persistBudget.length === 1);
  let wrongBinding = null; try { await release.runSources({ plan, region: "india", cycleDate, authorizationBinding: { ...bindFor(release, plan, "india"), planFingerprint: "tampered" } }); } catch (e) { wrongBinding = e; }
  ok("B(binding): a binding whose plan fingerprint differs from the frozen plan is refused (AUTHORIZATION_BINDING_MISMATCH) before any persist/POST", /AUTHORIZATION_BINDING_MISMATCH.*planFingerprint/.test(String(wrongBinding && wrongBinding.message)) && calls.persistBudget.length === 1);
  ok("B(P1): the obsolete fixed regional ceiling is gone -- a valid 8-account plan proceeds and freezes the exact structural maxCreates=4 (authorization = frozen budget + reservation), the one source pass ran",
    calls.persistBudget.length === 1 && calls.persistBudget[0].maxCreates === 4 && calls.sourceCycle.length === 1);
  // The composition keeps a STRUCTURAL DRIFT guard (frozen.maxCreates > 2 x ceil(accounts/5) => fail closed).
  const comp = readFileSync(new URL("../lib/server/sync/listing-health-v3-ingestion-composition.js", import.meta.url), "utf8");
  ok("B(P1): a structural drift guard (expectedListingHealthV3NewExports) replaces the fixed ceiling and fails closed on over-fan-out; no fixed regionCeilings[region] throw remains",
    comp.includes("expectedListingHealthV3NewExports") && /frozen\.maxCreates > expectedNew/.test(comp)
    && !/frozen\.maxCreates > ceiling/.test(comp));
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

/* ===================== E. NO overflow split: the composition ignores any retired inventory evidence ===================== */
await (async () => {
  const fake = makeFakeRelease();
  const basePlan = await fake.release.buildPlan({ accounts: IN8, connections, cycleDate, region: "india" });
  const hashesOf = (plan) => [...new Set(plan.reportRequests.flatMap((r) => r.sources.map((s) => s.requestHash)))].sort();
  const batchSizes = (plan) => [...new Map(plan.reportRequests.flatMap((r) => r.sources.filter((s) => s.requestKey === "listing-health-v3:listings").map((s) => [s.requestHash, s.sellerOrVendorIds.length]))).values()].sort().join(",");
  ok("E: Listings stay batched [5,3] (never split by any overflow evidence)", batchSizes(basePlan) === "3,5");
  const again = await fake.release.buildPlan({ accounts: IN8, connections, cycleDate, region: "india" });
  ok("E: the frozen plan is deterministic (same hashes on rebuild) and made zero evidence reads", JSON.stringify(hashesOf(basePlan)) === JSON.stringify(hashesOf(again)) && fake.evidenceReads.cycles + fake.evidenceReads.jobs + fake.evidenceReads.owners === 0);
  const comp = readFileSync(new URL("../lib/server/sync/listing-health-v3-ingestion-composition.js", import.meta.url), "utf8");
  ok("E: the composition no longer names the retired Health source / overflow / readiness evidence",
    !/fba-inventory-health|fba-inventory-overflow|resolveInventoryOverflowSellers|readRecentReadinessRejectionOwnership|lhv3-inv/.test(comp));
})();

writeSync(1, `\nreport-listing-health-v3-ingestion: ${passed} assertions passed\n`);

// EXACT authorization binding for a test plan (mirrors the operation: standing authz bound to the frozen NEW tranche).
function bindFor(rel, plan, region) {
  return computeListingHealthV3AuthorizationBinding({ region, cycleDate, operationId: "op-test", trancheKey: `lhv3-new#${region}`, accountIds: IN8.map((a) => a.accountId), frozen: rel.freezeBudget({ plan, region }), pricingRevision: LISTING_HEALTH_V3_PRICING_REVISION, authorization: readListingHealthV3Authorization({ region }) }).binding;
}
