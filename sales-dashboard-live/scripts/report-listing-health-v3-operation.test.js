// Phase 4B1 -- Advanced Listing Health v3 DEDICATED INGESTION OPERATOR (safe-closed).
//
// Proves the operator's gate design, freshness-aware pre-POST cost, budget/ceiling/balance fail-closed gates,
// dry-run zero-I/O, inventory reuse-only + missing-inventory deferral (LKG), and per-region create ceilings. All
// collaborators are injected; ZERO DataDoe/network. 7-bit ASCII, LF.

import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import {
  runListingHealthV3Ingestion,
  planListingHealthV3IngestionCost,
  buildListingHealthV3Plan,
  listingHealthV3OperationId,
  V3_INGESTION_REGIONS,
} from "../lib/server/sync/listing-health-v3-operation.js";

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); passed += 1; writeSync(1, `  ok ${n}\n`); };
writeSync(1, "report-listing-health-v3-operation\n");

const API_KEY = "fixture-key";
const connections = [{ id: "primary", apiKey: API_KEY, accountPrefix: "" }];
const cycleDate = "2026-09-04";
const usAccounts = ["acct-00", "acct-01"].map((id, i) => ({ accountId: id, country: "US", currency: "USD", name: `A${i}` }));

// A fake DataDoe adapter should NEVER be reached in these tests (dry-run + injected runners). A network spy guards it.
function withNoNetwork(fn) {
  const realFetch = globalThis.fetch; let hits = 0; globalThis.fetch = () => { hits += 1; throw new Error("no network"); };
  return Promise.resolve(fn()).finally(() => { globalThis.fetch = realFetch; }).then((r) => ({ r, hits }));
}

// Injected collaborator spies. A LIVE happy path drains sources (inventory reuse-only, never created), materializes
// with zero rejections, derives snapshots, and finalizes the dedicated cycle to a terminal "succeeded" status -- the
// ONLY full success. `sourceOut`, `matOut`, `reportOut`, `finalize` are overridable to reproduce non-success paths.
function spies({
  accounts = usAccounts, cost = null, balance = { usable: 1000 }, inventoryAdoptable = true,
  sourceOut = { drained: true, creates: 2, tokens: 4, inventoryCreated: false },
  matOut = { accounts: 2, aliasesWritten: 2, emptyAliases: 0, rejected: 0, skippedStale: 0 },
  reportOut = { succeeded: 2, blocked: 0, failed: 0, drained: true },
  finalize = { disposition: "finalized", status: "succeeded", cycleId: "cyc-1" },
} = {}) {
  const calls = { discover: 0, buildPlan: 0, resolveCost: 0, checkBalance: 0, runSources: 0, materialize: 0, runReports: 0, finalizeCycle: 0 };
  return {
    calls,
    discoverAccounts: async () => { calls.discover += 1; return accounts; },
    buildPlan: (args) => { calls.buildPlan += 1; return buildListingHealthV3Plan(args); },
    resolveCost: async () => { calls.resolveCost += 1; return cost || { newExports: 2, reusedExports: 1, creates: 2, estimatedTokens: 4, inventoryAdoptable }; },
    checkBalance: async () => { calls.checkBalance += 1; return balance; },
    runSources: async () => { calls.runSources += 1; return sourceOut; },
    materialize: async () => { calls.materialize += 1; return matOut; },
    runReports: async () => { calls.runReports += 1; return reportOut; },
    finalizeCycle: async () => { calls.finalizeCycle += 1; return finalize; },
  };
}
const base = (over = {}) => ({ region: "us-ca", cycleDate, connections, ...over });

/* ===================== A. authorization + gate ===================== */
await (async () => {
  const s = spies();
  const r1 = await runListingHealthV3Ingestion(base({ authorized: false, mode: "dry-run", ...s }));
  ok("A: an unauthorized invocation fails closed at auth", r1.ok === false && r1.phase === "auth");
  const r2 = await runListingHealthV3Ingestion(base({ authorized: true, mode: "live", gate: { enabled: false }, ...s }));
  ok("A: LIVE mode refuses while the ingestion gate is disabled (default)", r2.ok === false && r2.phase === "gate");
  ok("A: a refused live run performed ZERO source/materialize/report work", s.calls.runSources === 0 && s.calls.materialize === 0 && s.calls.runReports === 0);
})();

/* ===================== B. region + cycle validation ===================== */
await (async () => {
  const s = spies();
  ok("B: the region allowlist is exactly india|europe-au|us-ca", JSON.stringify([...V3_INGESTION_REGIONS]) === JSON.stringify(["india", "europe-au", "us-ca"]));
  const r1 = await runListingHealthV3Ingestion(base({ region: "us", authorized: true, mode: "dry-run", ...s }));
  ok("B: a non-allowlisted region (legacy 'us') fails closed", r1.ok === false && r1.phase === "region");
  const r2 = await runListingHealthV3Ingestion(base({ cycleDate: "not-a-date", authorized: true, mode: "dry-run", ...s }));
  ok("B: a malformed cycleDate fails closed", r2.ok === false && r2.phase === "cycle");
  ok("B: the operation id is stable per region+cycle", listingHealthV3OperationId("us-ca", cycleDate) === "listing-health-v3/us-ca/2026-09-04");
})();

/* ===================== C. dry-run performs ZERO creates/writes/tokens ===================== */
await (async () => {
  const s = spies();
  const { r, hits } = await withNoNetwork(() => runListingHealthV3Ingestion(base({ authorized: true, mode: "dry-run", gate: { enabled: false }, ...s })));
  ok("C: dry-run succeeds even with the gate disabled (planning only)", r.ok === true && r.phase === "planned" && r.dryRun === true);
  ok("C: dry-run reports zero creates and zero tokens", r.creates === 0 && r.tokens === 0);
  ok("C: dry-run NEVER runs sources, materialization, report jobs, or a balance check", s.calls.runSources === 0 && s.calls.materialize === 0 && s.calls.runReports === 0 && s.calls.checkBalance === 0);
  ok("C: dry-run DOES read (discover + plan + cost) and touches no network", s.calls.discover === 1 && s.calls.buildPlan === 1 && s.calls.resolveCost === 1 && hits === 0);
  ok("C: dry-run surfaces the freshness-aware planned create count + estimated tokens (an estimate, not a max)", r.plannedCreates === 2 && r.estimatedTokens === 4);
})();

/* ===================== D. no accounts in region -> zero-work success ===================== */
await (async () => {
  const s = spies({ accounts: [{ accountId: "de-1", country: "DE", currency: "EUR", name: "D" }] }); // not in us-ca
  const r = await runListingHealthV3Ingestion(base({ authorized: true, mode: "live", gate: { enabled: true }, ...s }));
  ok("D: an empty regional account set is a zero-create success (no plan, no exports)", r.ok === true && r.accounts === 0 && r.creates === 0 && s.calls.runSources === 0);
})();

/* ===================== E. budget/ceiling/balance/pricing/reservation fail-closed (LIVE) ===================== */
await (async () => {
  // ceiling exceeded (freshness-aware create count > ceiling)
  const sCeil = spies({ cost: { newExports: 2, reusedExports: 1, creates: 99, estimatedTokens: 198, inventoryAdoptable: true } });
  const rCeil = await runListingHealthV3Ingestion(base({ authorized: true, mode: "live", gate: { enabled: true }, ...sCeil }));
  ok("E: a freshness-aware create count above the region ceiling fails closed BEFORE any source run", rCeil.ok === false && rCeil.phase === "ceiling" && sCeil.calls.runSources === 0);
  // P1-3: the THREE spend concepts are SEPARATE. authorizedTokens is the durable AUTHORIZATION ceiling (reviewed
  // region config, NOT the balance); affordableTokens is the live balance minus the emergency reserve. Even WITH
  // authorization (us-ca is authorized for up to 20 accounts here), an unaffordable balance => TYPED awaiting-budget
  // (reason insufficient-balance), ZERO creates, BEFORE any source run/reservation/POST.
  const sBal = spies({ balance: { usable: 10, reserve: 50 } });
  const rBal = await runListingHealthV3Ingestion(base({ authorized: true, mode: "live", gate: { enabled: true }, ...sBal }));
  ok("E(P1-3): required tokens above the usable balance minus reserve returns TYPED awaiting-budget (insufficient-balance, deferred, zero creates) before any source run",
    rBal.ok === false && rBal.phase === "awaiting-budget" && rBal.awaitingBudget === true && rBal.deferred === true
    && rBal.creates === 0 && rBal.tokens === 0 && sBal.calls.runSources === 0
    && rBal.authorizationReason === "insufficient-balance"
    && rBal.requiredTokens === 4 && rBal.affordableTokens === -40 && rBal.authorizedTokens === 16);
  // P1-3: required WITHIN both the authorization AND the affordability balance proceeds using the exact frozen plan.
  const sOk = spies({ balance: { usable: 500, reserve: 50 } });
  const rOk = await runListingHealthV3Ingestion(base({ authorized: true, mode: "live", gate: { enabled: true }, ...sOk }));
  ok("E(P1-3): required spend WITHIN authorization AND affordability proceeds (runs sources; not deferred)",
    rOk.awaitingBudget !== true && sOk.calls.runSources >= 1 && rOk.affordableTokens === 450 && rOk.authorizedTokens === 16);
  // unknown pricing
  const sPrice = spies();
  const rPrice = await runListingHealthV3Ingestion(base({ authorized: true, mode: "live", gate: { enabled: true }, pricingKnown: false, ...sPrice }));
  ok("E: an unknown pricing state fails closed before any source run", rPrice.ok === false && rPrice.phase === "budget" && sPrice.calls.runSources === 0);
  // missing reservation support
  const sRes = spies();
  const rRes = await runListingHealthV3Ingestion(base({ authorized: true, mode: "live", gate: { enabled: true }, reservationSupported: false, ...sRes }));
  ok("E: missing atomic create-reservation support fails closed before any source run", rRes.ok === false && rRes.phase === "budget" && sRes.calls.runSources === 0);
})();

/* ===================== F. LIVE happy path (gate enabled) ===================== */
await (async () => {
  const s = spies();
  const r = await runListingHealthV3Ingestion(base({ authorized: true, mode: "live", gate: { enabled: true }, ...s }));
  ok("F: an authorized + gate-enabled live run executes sources -> materialize -> report -> finalize in order", s.calls.runSources === 1 && s.calls.materialize === 1 && s.calls.runReports === 1 && s.calls.finalizeCycle === 1);
  ok("F: it saves the v3 shadow snapshot(s) and reports complete ONLY on a terminal succeeded finalize", r.ok === true && r.phase === "complete" && r.snapshots === 2 && r.dryRun === false && r.cycleStatus === "succeeded");
})();

/* ===================== G. inventory reuse-only: missing fresh inventory DEFERS the derive (LKG preserved) ===================== */
await (async () => {
  const s = spies({ cost: { newExports: 2, reusedExports: 1, creates: 2, estimatedTokens: 4, inventoryAdoptable: false } });
  const r = await runListingHealthV3Ingestion(base({ authorized: true, mode: "live", gate: { enabled: true }, ...s }));
  ok("G: with no fresh FBA Plan inventory, the deferral happens BEFORE any source/materialize work (no paid export)", s.calls.runSources === 0 && s.calls.materialize === 0 && s.calls.checkBalance === 0);
  ok("G: the derive is DEFERRED (never publishes stale inventory as current); no report, no finalize; LKG preserved", r.phase === "deferred-inventory" && r.deferred === true && s.calls.runReports === 0 && r.snapshots === 0 && s.calls.finalizeCycle === 0);
  ok("G: a deferral is ok:false with zero creates/tokens (scheduled CLI exits nonzero; NO v3 cycle opened)", r.ok === false && r.creates === 0 && r.tokens === 0);
})();

/* ===================== H. freshness-aware cost (stale rejected / fresh reusable / next-cycle refresh / inventory) ===================== */
await (async () => {
  const plan = buildListingHealthV3Plan({ accounts: usAccounts, connections, cycleDate });
  const v3 = plan.reportRequests.filter((r) => r.reportKey === "listing-health-v3");
  const fresh = "2026-09-04T06:00:00.000Z"; // >= freshnessNotBefore (cycleDate T00:00)
  const stale = "2026-09-03T12:00:00.000Z"; // <  freshnessNotBefore
  const mkCache = (fetchedAt) => async (_h) => ({ fetched_at: fetchedAt, rows: [] });

  const costStale = await planListingHealthV3IngestionCost({ plan, getSourceExportCache: mkCache(stale) });
  ok("H: a STALE date-free cache (fetched_at < freshnessNotBefore) is NOT adoptable -> counted as a create", costStale.creates === costStale.newExports && costStale.newExports === 2);
  ok("H: stale inventory is NOT adoptable (reuse-only precondition fails)", costStale.inventoryAdoptable === false);

  const costFresh = await planListingHealthV3IngestionCost({ plan, getSourceExportCache: mkCache(fresh) });
  ok("H: a CURRENT-cycle cache (fetched_at >= freshnessNotBefore) is adoptable -> zero creates (reuse, zero tokens)", costFresh.creates === 0 && costFresh.estimatedTokens === 0);
  ok("H: fresh inventory is adoptable (reuse-only satisfied)", costFresh.inventoryAdoptable === true);
  ok("H: inventory is never counted as a new export (reused only)", costFresh.reusedExports === 1 && costFresh.newExports === 2);

  // Replay of the SAME cycle after a successful fetch: the cache is now fresh -> zero new creates (no duplicates).
  ok("H: same-cycle replay against the now-fresh cache creates nothing", (await planListingHealthV3IngestionCost({ plan, getSourceExportCache: mkCache(fresh) })).creates === 0);

  // NEXT cycle: the same cache (fetched at cycleDate) is now stale vs the NEXT cycle's freshnessNotBefore -> refresh.
  const nextPlan = buildListingHealthV3Plan({ accounts: usAccounts, connections, cycleDate: "2026-09-05" });
  const costNext = await planListingHealthV3IngestionCost({ plan: nextPlan, getSourceExportCache: mkCache("2026-09-04T06:00:00.000Z") });
  ok("H: the NEXT cycle treats the prior cache as stale -> refreshes exactly the new exports (once)", costNext.creates === costNext.newExports && costNext.newExports === 2);

  // token estimate is described as an estimate (observed 2/export), never a guaranteed maximum.
  ok("H: estimated tokens = creates x observed per-export price (an estimate, not a guaranteed max)", costStale.estimatedTokens === 2 * costStale.creates && costStale.tokenPerExport === 2);
})();

/* ===================== I. an UNDRAINED source pass is NOT a false success -- finalize reports open-work (ok:false) === */
await (async () => {
  // Old behaviour returned ok:true merely because runReports returned; the honest fix requires a terminal succeeded
  // finalize. An undrained cycle finalizes to open-work -> ok:false, phase incomplete (a retry resumes; LKG preserved).
  const s = spies({ sourceOut: { drained: false, creates: 1, tokens: 2, inventoryCreated: false }, finalize: { disposition: "open-work", status: "running", cycleId: "cyc-1" } });
  const r = await runListingHealthV3Ingestion(base({ authorized: true, mode: "live", gate: { enabled: true }, ...s }));
  ok("I: an undrained source pass still materializes + attempts the derive, then finalizes honestly", s.calls.materialize === 1 && s.calls.runReports === 1 && s.calls.finalizeCycle === 1);
  ok("I: open-work finalize is NOT a false success -- ok:false, phase incomplete (retry resumes; LKG preserved)", r.ok === false && r.phase === "incomplete" && r.drained === false);
})();

/* ===================== J. a thrown collaborator fails closed (LKG), never crashes ===================== */
await (async () => {
  const s = spies();
  s.runSources = async () => { throw new Error("datadoe boom"); };
  const r = await runListingHealthV3Ingestion(base({ authorized: true, mode: "live", gate: { enabled: true }, ...s }));
  ok("J: a source-run throw is caught and fails closed at the source phase (LKG preserved, no crash)", r.ok === false && r.phase === "source" && s.calls.materialize === 0);
})();

writeSync(1, `\nreport-listing-health-v3-operation: ${passed} assertions passed\n`);
