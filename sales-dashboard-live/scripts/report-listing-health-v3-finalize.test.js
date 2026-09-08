// Listing Health v3 HONEST-COMPLETION (finalize) semantics -- Phase 2.
//
// The dedicated v3 operator must NEVER report success merely because runReports returned. A LIVE scheduled operation
// succeeds ONLY when the dedicated cycle finalizes to a DURABLE terminal status "succeeded" (finalize_sync_cycle =>
// zero source AND report failures). This test FIRST reproduces the false-green shapes (blocked / failed / undrained
// report jobs, inventory create, materialization rejection) and proves they now return ok:false; then proves the
// succeeded / partial / failed / open-work and idempotent-replay finalizations. All collaborators injected; ZERO
// DataDoe/network. 7-bit ASCII, LF.

import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { runListingHealthV3Ingestion, buildListingHealthV3Plan } from "../lib/server/sync/listing-health-v3-operation.js";

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); passed += 1; writeSync(1, `  ok ${n}\n`); };
writeSync(1, "report-listing-health-v3-finalize\n");

const connections = [{ id: "primary", apiKey: "fixture-key", accountPrefix: "" }];
const cycleDate = "2026-09-05";
const usAccounts = ["acct-00", "acct-01"].map((id, i) => ({ accountId: id, country: "US", currency: "USD", name: `A${i}` }));

// LIVE collaborators; every non-success dimension is overridable. Defaults = a clean succeeded run.
function live({
  sourceOut = { drained: true, creates: 2, tokens: 4, inventoryCreated: false },
  matOut = { accounts: 2, aliasesWritten: 6, emptyAliases: 0, rejected: 0, skippedStale: 0 },
  reportOut = { succeeded: 2, blocked: 0, failed: 0, drained: true },
  finalize = { disposition: "finalized", status: "succeeded", cycleId: "cyc-1" },
  inventoryAdoptable = true,
} = {}) {
  const calls = { runSources: 0, materialize: 0, runReports: 0, finalizeCycle: 0 };
  const collab = {
    calls,
    discoverAccounts: async () => usAccounts,
    buildPlan: (args) => buildListingHealthV3Plan(args),
    resolveCost: async () => ({ newExports: 2, reusedExports: 1, creates: 2, estimatedTokens: 4, inventoryAdoptable }),
    checkBalance: async () => ({ usable: 1000 }),
    freezeBudget: async () => ({ planFingerprint: "fp-test", maxCreates: 2, maxTokens: 4, hashes: [{ requestHash: "h1", tokenCost: 2 }, { requestHash: "h2", tokenCost: 2 }] }), readFrozenBudget: async () => null,
    runSources: async () => { calls.runSources += 1; return sourceOut; },
    materialize: async () => { calls.materialize += 1; return matOut; },
    runReports: async () => { calls.runReports += 1; return reportOut; },
    finalizeCycle: async () => { calls.finalizeCycle += 1; return finalize; },
  };
  return collab;
}
const run = (c) => runListingHealthV3Ingestion({ region: "us-ca", cycleDate, connections, authorized: true, mode: "live", gate: { enabled: true }, ...c });

/* ===================== A. SUCCESS requires a terminal "succeeded" finalize ===================== */
(async () => {
  const r = await run(live());
  ok("A: a terminal succeeded finalize => ok:true, phase complete, cycleStatus succeeded", r.ok === true && r.phase === "complete" && r.cycleStatus === "succeeded");
})();

/* ===================== B. FALSE-GREEN reproductions -> now ok:false ===================== */
await (async () => {
  // B1: report jobs BLOCKED (some accounts missing required sources) -> the cycle finalizes partial, not succeeded.
  const rBlocked = await run(live({ reportOut: { succeeded: 1, blocked: 1, failed: 0, drained: true }, finalize: { disposition: "finalized", status: "partial", cycleId: "cyc-1" } }));
  ok("B1: BLOCKED report jobs are NOT a success (old code returned ok:true) -> ok:false, phase partial", rBlocked.ok === false && rBlocked.phase === "partial" && rBlocked.reportBlocked === 1);

  // B2: report jobs FAILED -> partial/failed finalize.
  const rFailed = await run(live({ reportOut: { succeeded: 0, blocked: 0, failed: 2, drained: true }, finalize: { disposition: "finalized", status: "failed", cycleId: "cyc-1" } }));
  ok("B2: FAILED report jobs -> ok:false, phase failed", rFailed.ok === false && rFailed.phase === "failed" && rFailed.reportFailed === 2);

  // B3: UNDRAINED (open-work) -> ok:false, incomplete.
  const rOpen = await run(live({ sourceOut: { drained: false, creates: 1, tokens: 2, inventoryCreated: false }, finalize: { disposition: "open-work", status: "running", cycleId: "cyc-1" } }));
  ok("B3: UNDRAINED cycle (open-work) -> ok:false, phase incomplete", rOpen.ok === false && rOpen.phase === "incomplete");
})();

/* ===================== C. contract violations caught BEFORE trusting the cycle ===================== */
await (async () => {
  // C1: inventory CREATED (reuse-only violated) -> fail closed at source, no report/finalize.
  const cInv = live({ sourceOut: { drained: true, creates: 2, tokens: 4, inventoryCreated: true } });
  const rInv = await run(cInv);
  ok("C1: a v3 inventory CREATE (reuse-only violation) -> ok:false, phase source, no report/finalize", rInv.ok === false && rInv.phase === "source" && cInv.calls.runReports === 0 && cInv.calls.finalizeCycle === 0);

  // C2: materialization REJECTED a fragment -> fail closed at materialize, no report/finalize.
  const cMat = live({ matOut: { accounts: 2, aliasesWritten: 4, emptyAliases: 0, rejected: 1, skippedStale: 0 } });
  const rMat = await run(cMat);
  ok("C2: a materialization rejection -> ok:false, phase materialize, no report/finalize", rMat.ok === false && rMat.phase === "materialize" && cMat.calls.runReports === 0 && cMat.calls.finalizeCycle === 0);
})();

/* ===================== D. finalize disposition edge cases ===================== */
await (async () => {
  const rNF = await run(live({ finalize: { disposition: "not-found", status: null, cycleId: null } }));
  ok("D: a not-found finalize is ok:false (never a silent success)", rNF.ok === false && rNF.phase === "not-found");
  const rInvalid = await run(live({ finalize: { disposition: "invalid-status", status: null } }));
  ok("D: an invalid-status finalize is ok:false", rInvalid.ok === false && rInvalid.phase === "invalid-status");
})();

/* ===================== E. idempotent replay: already-terminal succeeded, zero creates ===================== */
await (async () => {
  // A watchdog replay resumes the same cycle: sources adopt cache (0 creates), finalize returns already-terminal succeeded.
  const r = await run(live({ sourceOut: { drained: true, creates: 0, tokens: 0, inventoryCreated: false }, reportOut: { succeeded: 2, blocked: 0, failed: 0, drained: true }, finalize: { disposition: "already-terminal", status: "succeeded", cycleId: "cyc-1" } }));
  ok("E: an already-terminal succeeded replay is a zero-create success (ok:true, complete, creates 0)", r.ok === true && r.phase === "complete" && r.cycleStatus === "succeeded" && r.creates === 0);
})();

/* ===================== F. deferral (inventory not adoptable) never finalizes; ok:false; cycle left open ===================== */
await (async () => {
  const c = live({ inventoryAdoptable: false });
  const r = await run(c);
  ok("F: inventory-not-adoptable defers BEFORE any work -> ok:false, phase deferred-inventory, zero creates/tokens/snapshots", r.ok === false && r.phase === "deferred-inventory" && r.deferred === true && r.creates === 0 && r.tokens === 0 && r.snapshots === 0);
  ok("F: the deferral runs NO source/materialize/report/finalize (no v3 cycle opened; retry-safe)", c.calls.runSources === 0 && c.calls.materialize === 0 && c.calls.runReports === 0 && c.calls.finalizeCycle === 0);
})();

writeSync(1, `\nreport-listing-health-v3-finalize: ${passed} assertions passed\n`);
