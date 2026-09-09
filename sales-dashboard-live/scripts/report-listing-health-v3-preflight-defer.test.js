// Listing Health v3 OPTIONAL-INVENTORY (per-account partial publication) -- the region-wide FBA-inventory
// prerequisite has been REMOVED. The operator now PROCEEDS even when some (or all) accounts lack adoptable FBA
// inventory: listings + durable OLI publish for every eligible account, inventory is adopted PER ACCOUNT where the
// reuse-only cache is fresh, and inventory-dependent fields stay unavailable for the rest. This suite proves the
// operator no longer defers the whole region on !anyInventoryAdoptable, that a fully-adoptable region still proceeds,
// that the already-terminal replay is unchanged, and that dry-run reports the new per-account adoptability fields.
// Injected collaborators; ZERO DataDoe/network. 7-bit ASCII, LF.

import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { runListingHealthV3Ingestion, buildListingHealthV3Plan } from "../lib/server/sync/listing-health-v3-operation.js";

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); passed += 1; writeSync(1, `  ok ${n}\n`); };
writeSync(1, "report-listing-health-v3-preflight-defer (optional-inventory)\n");

const connections = [{ id: "primary", apiKey: "fixture-key", accountPrefix: "" }];
const cycleDate = "2026-09-05";
const usAccounts = ["acct-00", "acct-01"].map((id, i) => ({ accountId: id, country: "US", currency: "USD", name: `A${i}` }));

// `runSources` is the ONLY path that opens the cycle / persists budget / reserves + POSTs a create; the spy records
// each sub-step. `anyInventoryAdoptable` no longer gates the run -- it is surfaced for evidence only.
function scenario({ anyInventoryAdoptable = false, inventoryAdoptableCount = 0, finalize = { disposition: "finalized", status: "succeeded" }, sourceCreates = 2 } = {}) {
  const store = { openCycle: 0, persistBudget: 0, reserveExportCreate: 0, create: 0 };
  const calls = { checkBalance: 0, runSources: 0, materialize: 0, runReports: 0, finalizeCycle: 0 };
  const collab = {
    discoverAccounts: async () => usAccounts,
    buildPlan: (args) => buildListingHealthV3Plan(args),
    resolveCost: async () => ({
      newExports: 2, reusedExports: 1, creates: 2, estimatedTokens: 4,
      // Per-account adoptability (the new cost shape). inventoryAdoptable is kept for back-compat = anyInventoryAdoptable.
      anyInventoryAdoptable, inventoryAdoptable: anyInventoryAdoptable, inventoryAdoptableCount,
      inventoryAdoptableByHash: { invA: inventoryAdoptableCount > 0, invB: inventoryAdoptableCount > 1 },
    }),
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

/* ===================== A. FBA partial (NO account has adoptable inventory) -> the run PROCEEDS, never defers ===================== */
await (async () => {
  const s = scenario({ anyInventoryAdoptable: false, inventoryAdoptableCount: 0 });
  const r = await runLive(s.collab);
  ok("A: NO 'deferred-inventory' phase -- the region-wide inventory prerequisite is removed", r.phase !== "deferred-inventory" && r.deferred !== true);
  ok("A: the operator PROCEEDS through sources -> materialize -> report -> finalize (listings/OLI publish regardless)",
    s.calls.runSources === 1 && s.calls.materialize === 1 && s.calls.runReports === 1 && s.calls.finalizeCycle === 1);
  ok("A: it opens exactly one cycle + one budget within it", s.store.openCycle === 1 && s.store.persistBudget === 1);
  ok("A: and completes successfully (terminal succeeded finalize) with inventory adopted for zero accounts", r.ok === true && r.phase === "complete" && r.cycleStatus === "succeeded" && r.inventoryAdoptableCount === 0);
})();

/* ===================== B. fully-adoptable region proceeds normally (unchanged) ===================== */
await (async () => {
  const s = scenario({ anyInventoryAdoptable: true, inventoryAdoptableCount: 2 });
  const r = await runLive(s.collab);
  ok("B: with adoptable inventory the operation runs sources -> materialize -> report -> finalize", s.calls.runSources === 1 && s.calls.materialize === 1 && s.calls.runReports === 1 && s.calls.finalizeCycle === 1);
  ok("B: it opens exactly one cycle + one budget + creates within it", s.store.openCycle === 1 && s.store.persistBudget === 1 && s.store.create === 1);
  ok("B: and completes successfully (terminal succeeded finalize)", r.ok === true && r.phase === "complete" && r.cycleStatus === "succeeded");
})();

/* ===================== C. idempotent replay: already-terminal succeeded, zero creates, unchanged ===================== */
await (async () => {
  const s = scenario({ anyInventoryAdoptable: true, inventoryAdoptableCount: 2, finalize: { disposition: "already-terminal", status: "succeeded" }, sourceCreates: 0 });
  const r = await runLive(s.collab);
  ok("C: an already-terminal succeeded replay stays a zero-create success (ok:true, complete, creates 0)", r.ok === true && r.phase === "complete" && r.cycleStatus === "succeeded" && r.creates === 0);
})();

/* ===================== D. dry-run reports the per-account adoptability fields, zero writes/creates ===================== */
await (async () => {
  const s = scenario({ anyInventoryAdoptable: false, inventoryAdoptableCount: 0 });
  const r = await runListingHealthV3Ingestion({ region: "us-ca", cycleDate, connections, authorized: true, mode: "dry-run", gate: { enabled: false }, ...s.collab });
  ok("D: dry-run PLANS (ok:true, phase planned) and reports the new per-account adoptability fields",
    r.ok === true && r.phase === "planned" && r.dryRun === true && r.anyInventoryAdoptable === false && r.inventoryAdoptableCount === 0 && typeof r.inventoryAdoptableByHash === "object");
  ok("D: dry-run reports the planned create/token cost and writes/creates nothing", r.plannedCreates === 2 && r.estimatedTokens === 4 && r.creates === 0 && s.calls.runSources === 0 && s.store.openCycle === 0);
})();

writeSync(1, `\nreport-listing-health-v3-preflight-defer: ${passed} assertions passed\n`);
