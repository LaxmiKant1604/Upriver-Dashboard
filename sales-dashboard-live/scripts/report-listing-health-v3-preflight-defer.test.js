// Listing Health v3 P1 ordering fix -- inventory adoptability is a PRE-CREATE gate.
//
// Reproduces the defect scenario (the FBA job reports success while one regional account lacks adoptable inventory ->
// cost.inventoryAdoptable=false) and proves the LIVE operator DEFERS before opening a cycle or creating any paid
// Listings/Listings-Raw export: runSources / openCycle / persistBudget / reserveExportCreate / create /
// materialize / runReports / finalizeCycle are all called 0 times, creates=tokens=snapshots=0, no running cycle is
// left behind. Then proves that once inventory becomes adoptable the SAME operation proceeds normally, and that the
// already-terminal succeeded replay is unchanged. Injected collaborators; ZERO DataDoe/network. 7-bit ASCII, LF.

import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { runListingHealthV3Ingestion, buildListingHealthV3Plan } from "../lib/server/sync/listing-health-v3-operation.js";

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); passed += 1; writeSync(1, `  ok ${n}\n`); };
writeSync(1, "report-listing-health-v3-preflight-defer\n");

const connections = [{ id: "primary", apiKey: "fixture-key", accountPrefix: "" }];
const cycleDate = "2026-09-05";
const usAccounts = ["acct-00", "acct-01"].map((id, i) => ({ accountId: id, country: "US", currency: "USD", name: `A${i}` }));

// `runSources` is the ONLY path that opens the cycle / persists budget / reserves + POSTs a create; the spy records
// each of those sub-steps so a deferral (which must never call runSources) proves all of them stayed at zero.
function scenario({ inventoryAdoptable = false, finalize = { disposition: "finalized", status: "succeeded" }, sourceCreates = 2 } = {}) {
  const store = { openCycle: 0, persistBudget: 0, reserveExportCreate: 0, create: 0 };
  const calls = { checkBalance: 0, runSources: 0, materialize: 0, runReports: 0, finalizeCycle: 0 };
  const collab = {
    discoverAccounts: async () => usAccounts,
    buildPlan: (args) => buildListingHealthV3Plan(args),
    resolveCost: async () => ({ newExports: 2, reusedExports: 1, creates: 2, estimatedTokens: 4, inventoryAdoptable }),
    checkBalance: async () => { calls.checkBalance += 1; return { usable: 1000 }; },
    freezeBudget: async () => ({ planFingerprint: "fp-test", maxCreates: 2, maxTokens: 4, hashes: [{ requestHash: "h1", tokenCost: 2 }, { requestHash: "h2", tokenCost: 2 }] }), readFrozenBudget: async () => null,
    runSources: async () => { calls.runSources += 1; store.openCycle += 1; store.persistBudget += 1; store.reserveExportCreate += 1; store.create += 1; return { drained: true, creates: sourceCreates, tokens: sourceCreates * 2, inventoryCreated: false }; },
    materialize: async () => { calls.materialize += 1; return { rejected: 0, aliasesWritten: 6 }; },
    runReports: async () => { calls.runReports += 1; return { succeeded: 2, blocked: 0, failed: 0, drained: true }; },
    finalizeCycle: async () => { calls.finalizeCycle += 1; return finalize; },
  };
  return { store, calls, collab };
}
const runLive = (collab) => runListingHealthV3Ingestion({ region: "us-ca", cycleDate, connections, authorized: true, mode: "live", gate: { enabled: true }, ...collab });

/* ===================== A. FBA success + one account without adoptable inventory -> PRE-CREATE deferral ===================== */
await (async () => {
  // The workflow gate already passed (needs.fba.result == 'success'); the FBA cycle was merely PARTIAL, so one
  // account's inventory hash is not adoptable -> cost.inventoryAdoptable=false. The operator must defer with zero work.
  const s = scenario({ inventoryAdoptable: false });
  const r = await runLive(s.collab);
  ok("A: live v3 returns deferred-inventory, ok:false", r.phase === "deferred-inventory" && r.ok === false && r.deferred === true);
  ok("A: creates=0, tokens=0, snapshots=0", r.creates === 0 && r.tokens === 0 && r.snapshots === 0);
  ok("A: runSources called 0 times", s.calls.runSources === 0);
  ok("A: openCycle / persistBudget / reserveExportCreate / create called 0 times (no paid export)", s.store.openCycle === 0 && s.store.persistBudget === 0 && s.store.reserveExportCreate === 0 && s.store.create === 0);
  ok("A: materialize / runReports / finalizeCycle called 0 times", s.calls.materialize === 0 && s.calls.runReports === 0 && s.calls.finalizeCycle === 0);
  ok("A: no running v3 cycle is left behind (openCycle never ran)", s.store.openCycle === 0);
  ok("A: the balance check is also skipped (deferral precedes it)", s.calls.checkBalance === 0);
})();

/* ===================== B. once inventory is adoptable, the SAME operation proceeds normally ===================== */
await (async () => {
  const s = scenario({ inventoryAdoptable: true });
  const r = await runLive(s.collab);
  ok("B: with adoptable inventory the operation runs sources -> materialize -> report -> finalize", s.calls.runSources === 1 && s.calls.materialize === 1 && s.calls.runReports === 1 && s.calls.finalizeCycle === 1);
  ok("B: it opens exactly one cycle + one budget + creates within it", s.store.openCycle === 1 && s.store.persistBudget === 1 && s.store.create === 1);
  ok("B: and completes successfully (terminal succeeded finalize)", r.ok === true && r.phase === "complete" && r.cycleStatus === "succeeded");
})();

/* ===================== C. idempotent replay: already-terminal succeeded, zero creates, unchanged ===================== */
await (async () => {
  const s = scenario({ inventoryAdoptable: true, finalize: { disposition: "already-terminal", status: "succeeded" }, sourceCreates: 0 });
  const r = await runLive(s.collab);
  ok("C: an already-terminal succeeded replay stays a zero-create success (ok:true, complete, creates 0)", r.ok === true && r.phase === "complete" && r.cycleStatus === "succeeded" && r.creates === 0);
})();

/* ===================== D. dry-run preserved: reports adoptability + planned cost, zero writes/creates ===================== */
await (async () => {
  const s = scenario({ inventoryAdoptable: false });
  const r = await runListingHealthV3Ingestion({ region: "us-ca", cycleDate, connections, authorized: true, mode: "dry-run", gate: { enabled: false }, ...s.collab });
  ok("D: dry-run with non-adoptable inventory still PLANS (ok:true, phase planned) and reports inventoryAdoptable=false", r.ok === true && r.phase === "planned" && r.dryRun === true && r.inventoryAdoptable === false);
  ok("D: dry-run reports the planned create/token cost and writes/creates nothing", r.plannedCreates === 2 && r.estimatedTokens === 4 && r.creates === 0 && s.calls.runSources === 0 && s.store.openCycle === 0);
})();

writeSync(1, `\nreport-listing-health-v3-preflight-defer: ${passed} assertions passed\n`);
